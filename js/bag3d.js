import * as THREE from 'three/webgpu';
import { mx_noise_float, positionWorld, normalWorld, float, smoothstep, fract, step, vertexColor } from 'three/tsl';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { MeshoptDecoder } from 'three/addons/libs/meshopt_decoder.module.js';
import { GEO } from './nyc-geodata.js';

// 3D BAG (LoD 2.2) 3D Tiles: real building volumes with roof shapes for the Netherlands.
// https://3dbag.nl — tiles are glTF with node matrices in ECEF (glTF axes: x = X, y = Z, z = -Y).
const BAG_BASE = 'https://3dbag.fsn1.your-objectstorage.com/v20250903/cesium3dtiles/lod22/';
const AFF = GEO.utrecht.meta.lonLatAffine;
const [MIN_X, MIN_Z, MAX_X, MAX_Z] = GEO.utrecht.meta.bounds;

// Ellipsoidal height of street level at the Domtoren (NAP + geoid undulation), so that street level is y = 0.
const GROUND_ELLIPSOID_HEIGHT = 47.8;

const WGS84_A = 6378137, WGS84_E2 = 0.00669437999014;
const rad = (d) => d * Math.PI / 180;

function ecefFromLonLat(lon, lat, h = 0) {
  const sin = Math.sin(rad(lat)), cos = Math.cos(rad(lat));
  const n = WGS84_A / Math.sqrt(1 - WGS84_E2 * sin * sin);
  return new THREE.Vector3((n + h) * cos * Math.cos(rad(lon)), (n + h) * cos * Math.sin(rad(lon)), (n * (1 - WGS84_E2) + h) * sin);
}

// Matrix (double precision) from glTF-world ECEF coordinates to engine coordinates (x east, y up, z south, metres).
export function ecefToLocalMatrix(lon0 = AFF.lon0, lat0 = AFF.lat0) {
  const lon = rad(lon0), lat = rad(lat0);
  const e = new THREE.Vector3(-Math.sin(lon), Math.cos(lon), 0);
  const n = new THREE.Vector3(-Math.sin(lat) * Math.cos(lon), -Math.sin(lat) * Math.sin(lon), Math.cos(lat));
  const u = new THREE.Vector3(Math.cos(lat) * Math.cos(lon), Math.cos(lat) * Math.sin(lon), Math.sin(lat));
  const w = Math.sqrt(1 - WGS84_E2 * Math.sin(lat) ** 2);
  const prime = WGS84_A / w, meridian = WGS84_A * (1 - WGS84_E2) / (w * w * w);
  // Match the OSM data's equirectangular affine so that BAG and OSM layers coincide.
  const sx = AFF.x[1] / (rad(1) * prime * Math.cos(lat));
  const sz = -AFF.z[2] / (rad(1) * meridian);
  const origin = ecefFromLonLat(lon0, lat0, GROUND_ELLIPSOID_HEIGHT);
  // ECEF -> engine: x = sx * E, y = U, z = -sz * N
  const ecefToLocal = new THREE.Matrix4().set(
    sx * e.x, sx * e.y, sx * e.z, 0,
    u.x, u.y, u.z, 0,
    -sz * n.x, -sz * n.y, -sz * n.z, 0,
    0, 0, 0, 1
  );
  const shift = new THREE.Matrix4().makeTranslation(-origin.x, -origin.y, -origin.z);
  return new THREE.Matrix4().multiplyMatrices(ecefToLocal, shift);
}

// glTF world (y-up: X, Z, -Y of ECEF) -> engine coordinates.
export function gltfToLocalMatrix(ecefToLocal = ecefToLocalMatrix()) {
  const gltfToEcef = new THREE.Matrix4().set(
    1, 0, 0, 0,
    0, 0, -1, 0,
    0, 1, 0, 0,
    0, 0, 0, 1
  );
  return new THREE.Matrix4().multiplyMatrices(ecefToLocal, gltfToEcef);
}

const boxCorners = (box) => {
  const c = box.slice(0, 3), a = box.slice(3, 6), b = box.slice(6, 9), d = box.slice(9, 12);
  const out = [];
  for (const i of [-1, 1]) for (const j of [-1, 1]) for (const k of [-1, 1]) {
    out.push([0, 1, 2].map((m) => c[m] + i * a[m] + j * b[m] + k * d[m]));
  }
  return out;
};

// Local-space AABB of a 3D Tiles oriented box (given in glTF-world ECEF coordinates as used by the tileset).
export function boxLocalBounds(box, matrix) {
  const bounds = new THREE.Box3();
  const v = new THREE.Vector3();
  for (const [x, y, z] of boxCorners(box)) bounds.expandByPoint(v.set(x, y, z).applyMatrix4(matrix));
  return bounds;
}

// Collects the leaf tile URLs of the tileset hierarchy that overlap the given local bounds.
export async function selectTiles(matrix, { minX = MIN_X, maxX = MAX_X, minZ = MIN_Z, maxZ = MAX_Z, margin = 60, fetchJson } = {}) {
  const getJson = fetchJson || (async (url) => { const r = await fetch(url); if (!r.ok) throw new Error(`${url}: ${r.status}`); return r.json(); });
  const overlaps = (box) => {
    const b = boxLocalBounds(box, matrix);
    return b.max.x >= minX - margin && b.min.x <= maxX + margin && b.max.z >= minZ - margin && b.min.z <= maxZ + margin;
  };
  const urls = [];
  const visit = async (node) => {
    if (!node.boundingVolume?.box || !overlaps(node.boundingVolume.box)) return;
    if (node.children?.length) { await Promise.all(node.children.map(visit)); return; }
    const uri = node.content?.uri;
    if (!uri) return;
    if (uri.endsWith('.json')) { const sub = await getJson(BAG_BASE + uri); await visit(sub.root); } else urls.push(BAG_BASE + uri);
  };
  await visit((await getJson(BAG_BASE + 'tileset.json')).root);
  return urls;
}

function hash(n) {
  n = Math.imul(n ^ (n >>> 16), 0x45d9f3b); n = Math.imul(n ^ (n >>> 16), 0x45d9f3b);
  return ((n ^ (n >>> 16)) >>> 0) / 4294967296;
}

// Bakes a loaded tile into one engine-space mesh geometry with per-building colour variation.
export function bakeTile(gltf, matrix) {
  const geometries = [];
  gltf.scene.updateMatrixWorld(true);
  gltf.scene.traverse((o) => {
    if (!o.isMesh) return;
    const src = o.geometry;
    const full = new THREE.Matrix4().multiplyMatrices(matrix, o.matrixWorld);
    const normalMatrix = new THREE.Matrix3().getNormalMatrix(full);
    const pos = src.attributes.position, nor = src.attributes.normal, fid = src.attributes._feature_id_0;
    const count = pos.count;
    const positions = new Float32Array(count * 3), normals = new Float32Array(count * 3), colors = new Float32Array(count * 3);
    const v = new THREE.Vector3(), c = new THREE.Color();
    for (let i = 0; i < count; i++) {
      v.fromBufferAttribute(pos, i).applyMatrix4(full);
      positions[i * 3] = v.x; positions[i * 3 + 1] = v.y; positions[i * 3 + 2] = v.z;
      v.fromBufferAttribute(nor, i).applyMatrix3(normalMatrix).normalize();
      normals[i * 3] = v.x; normals[i * 3 + 1] = v.y; normals[i * 3 + 2] = v.z;
      const seed = fid ? Math.round(fid.getX(i)) : 0;
      const r = hash(seed + 1), s = hash(seed * 7 + 3);
      if (v.y > 0.35) c.setHSL(0.03 + s * 0.04, 0.12 + r * 0.12, 0.17 + r * 0.1); // roofs: dark tile / slate
      else if (r < 0.62) c.setHSL(0.045 + s * 0.03, 0.34 + r * 0.2, 0.30 + s * 0.12); // brick
      else if (r < 0.85) c.setHSL(0.11 + s * 0.04, 0.12 + s * 0.12, 0.52 + r * 0.14); // plaster / stone
      else c.setHSL(0.08 + s * 0.05, 0.08, 0.40 + s * 0.15);
      colors[i * 3] = c.r; colors[i * 3 + 1] = c.g; colors[i * 3 + 2] = c.b;
    }
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(positions, 3));
    g.setAttribute('normal', new THREE.BufferAttribute(normals, 3));
    g.setAttribute('color', new THREE.BufferAttribute(colors, 3));
    if (src.index) g.setIndex(src.index.array instanceof Uint32Array || count > 65535 ? new THREE.BufferAttribute(Uint32Array.from(src.index.array), 1) : new THREE.BufferAttribute(Uint16Array.from(src.index.array), 1));
    g.computeBoundingSphere(); g.computeBoundingBox();
    geometries.push(g);
  });
  return geometries;
}

function createMaterial() {
  const m = new THREE.MeshStandardNodeMaterial({ roughness: 0.92, metalness: 0 });
  // Vertex colour with a subtle brightness grain and a window grid on walls.
  const grain = mx_noise_float(positionWorld.mul(0.7)).mul(0.1).add(0.95);
  const wall = step(normalWorld.y.abs(), 0.35);
  const along = positionWorld.x.mul(normalWorld.z.abs()).add(positionWorld.z.mul(normalWorld.x.abs()));
  const u = fract(along.div(3.1)), v = fract(positionWorld.y.sub(0.0).div(3.2));
  const above = step(2.6, positionWorld.y);
  const win = smoothstep(0.18, 0.22, u).mul(smoothstep(0.82, 0.78, u)).mul(smoothstep(0.34, 0.38, v)).mul(smoothstep(0.82, 0.78, v));
  const glass = win.mul(wall).mul(above).mul(0.55);
  m.colorNode = vertexColor().mul(grain).mul(float(1).sub(glass));
  return m;
}

export async function loadBagBuildings(scene, { onProgress, concurrency = 4, fetchJson, loader } = {}) {
  const ecefMatrix = ecefToLocalMatrix();
  const matrix = gltfToLocalMatrix(ecefMatrix);
  const urls = await selectTiles(ecefMatrix, { fetchJson });
  if (!urls.length) throw new Error('no 3D BAG tiles overlap the city');
  const gltfLoader = loader || new GLTFLoader().setMeshoptDecoder(MeshoptDecoder);
  const group = new THREE.Group();
  group.name = 'bag3d-buildings';
  const material = createMaterial();
  let next = 0, done = 0;
  const worker = async () => {
    while (next < urls.length) {
      const url = urls[next++];
      const gltf = await gltfLoader.loadAsync(url);
      for (const g of bakeTile(gltf, matrix)) {
        const mesh = new THREE.Mesh(g, material);
        mesh.castShadow = mesh.receiveShadow = true;
        group.add(mesh);
      }
      onProgress?.(++done, urls.length);
    }
  };
  await Promise.all(Array.from({ length: Math.min(concurrency, urls.length) }, worker));
  scene.add(group);
  group.userData = { city: 'Utrecht', source: '3D BAG LoD 2.2', tiles: urls.length };
  return group;
}
