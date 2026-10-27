import * as THREE from 'three/webgpu';
import { UTRECHT_DATA } from './city-config.js';

// Geometry adapters only: rendering stays in the upstream WebGPU/TSL systems.
export const UTRECHT_RENDER_CELL = 750;

export function utrechtSpatialGroups(items, position = item => item) {
  const cells = new Map();
  for (const item of items) {
    const { x, z } = position(item);
    const key = `${Math.floor(x / UTRECHT_RENDER_CELL)}/${Math.floor(z / UTRECHT_RENDER_CELL)}`;
    if (!cells.has(key)) cells.set(key, []);
    cells.get(key).push(item);
  }
  return cells.values();
}

export function utrechtGeometryGroups(geometries) {
  return utrechtSpatialGroups(geometries, geometry => {
    if (!geometry.boundingBox) geometry.computeBoundingBox();
    const { min, max } = geometry.boundingBox;
    return { x: (min.x + max.x) / 2, z: (min.z + max.z) / 2 };
  });
}

export function utrechtPoints(flat) {
  const points = [];
  for (let i = 0; i < flat.length; i += 2) points.push({ x: flat[i], z: flat[i + 1] });
  return points;
}

export function utrechtBounds(points) {
  const b = { minX: Infinity, maxX: -Infinity, minZ: Infinity, maxZ: -Infinity };
  for (const p of points) {
    b.minX = Math.min(b.minX, p.x); b.maxX = Math.max(b.maxX, p.x);
    b.minZ = Math.min(b.minZ, p.z); b.maxZ = Math.max(b.maxZ, p.z);
  }
  return b;
}

export function utrechtPolygonGeometry(ring, holes = [], y = 0) {
  const shape = new THREE.Shape(ring.map(p => new THREE.Vector2(p.x, -p.z)));
  for (const hole of holes) if (hole.length >= 3) shape.holes.push(new THREE.Path(hole.map(p => new THREE.Vector2(p.x, -p.z))));
  const geometry = new THREE.ShapeGeometry(shape, 1);
  geometry.rotateX(-Math.PI / 2);
  geometry.translate(0, y, 0);
  return geometry;
}

export function utrechtStrip(a, b, halfWidth, y, offset = 0) {
  const dx = b.x - a.x, dz = b.z - a.z, len = Math.hypot(dx, dz);
  if (len < 0.1) return null;
  const nx = -dz / len, nz = dx / len;
  return utrechtPolygonGeometry([
    { x: a.x + nx * (offset - halfWidth), z: a.z + nz * (offset - halfWidth) },
    { x: b.x + nx * (offset - halfWidth), z: b.z + nz * (offset - halfWidth) },
    { x: b.x + nx * (offset + halfWidth), z: b.z + nz * (offset + halfWidth) },
    { x: a.x + nx * (offset + halfWidth), z: a.z + nz * (offset + halfWidth) },
  ], [], y);
}

export const UTRECHT_PEDESTRIAN_WAYS = new Set(['footway', 'pedestrian', 'path', 'steps', 'cycleway', 'bridleway']);
let segments;
let roadIndex;
export function utrechtRoadSegments() {
  if (segments) return segments;
  segments = [];
  roadIndex = new Map();
  for (const road of UTRECHT_DATA.roads || []) {
    if (road.tunnel || !road.pts) continue;
    const points = utrechtPoints(road.pts);
    for (let i = 1; i < points.length; i++) {
      const a = points[i - 1], b = points[i], len = Math.hypot(b.x - a.x, b.z - a.z);
      if (len < 0.8) continue;
      const s = { a, b, len, road, width: road.width || 6, ux: (b.x - a.x) / len, uz: (b.z - a.z) / len,
        pedestrian: UTRECHT_PEDESTRIAN_WAYS.has(road.kind), bridge: !!road.bridge };
      segments.push(s);
      if (s.pedestrian) continue;
      for (let x = Math.floor(Math.min(a.x, b.x) / 64); x <= Math.floor(Math.max(a.x, b.x) / 64); x++) {
        for (let z = Math.floor(Math.min(a.z, b.z) / 64); z <= Math.floor(Math.max(a.z, b.z) / 64); z++) {
          const key = `${x}/${z}`;
          if (!roadIndex.has(key)) roadIndex.set(key, []);
          roadIndex.get(key).push(s);
        }
      }
    }
  }
  return segments;
}

export function nearestUtrechtRoad(x, z, reach = 40) {
  utrechtRoadSegments();
  let best = null, bestD = reach * reach;
  for (let gx = Math.floor((x - reach) / 64); gx <= Math.floor((x + reach) / 64); gx++) {
    for (let gz = Math.floor((z - reach) / 64); gz <= Math.floor((z + reach) / 64); gz++) {
      for (const s of roadIndex.get(`${gx}/${gz}`) || []) {
        const t = Math.max(0, Math.min(s.len, (x - s.a.x) * s.ux + (z - s.a.z) * s.uz));
        const px = s.a.x + s.ux * t, pz = s.a.z + s.uz * t;
        const d2 = (px - x) ** 2 + (pz - z) ** 2;
        if (d2 < bestD) { bestD = d2; best = { ...s, x: px, z: pz, distance: Math.sqrt(d2) }; }
      }
    }
  }
  return best;
}
