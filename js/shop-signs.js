// Shop fascia signs at the real locations of Utrecht's named shops, cafés and restaurants (OpenStreetMap, see
// tools/build-utrecht-shops.mjs). Each sign is a quad on the nearest building wall, all sharing one name atlas.
import * as THREE from 'three/webgpu';
import { UTRECHT_SHOPS } from './utrecht-shops.js';

const CELL_W = 256, CELL_H = 40, COLS = 8, MAX_NAMES = 800;
const MAX_WALL_DISTANCE = 25, MIN_WALL_LENGTH = 3, SIGN_Y = 3.4, MIN_SPACING = 2.5;

// Known chains in their house colours (wordmarks only, no logos); other names get a muted colour from a hash.
const BRANDS = {
  'Albert Heijn': ['#00a0e2', '#ffffff'], 'Albert Heijn to go': ['#00a0e2', '#ffffff'], 'HEMA': ['#d5112b', '#ffffff'],
  'Etos': ['#00843d', '#ffffff'], 'Kruidvat': ['#e3001b', '#ffffff'], 'Jumbo': ['#f6c200', '#111111'],
  'Blokker': ['#c8102e', '#ffffff'], 'Bruna': ['#1f3c88', '#ffffff'], 'Rituals': ['#1b1b1b', '#e8d9b8'],
  'Starbucks': ['#00704a', '#ffffff'], "McDonald's": ['#da291c', '#ffc72c'], 'KFC': ['#e4002b', '#ffffff'],
  "Domino's": ['#006491', '#ffffff'], 'Gall & Gall': ['#7a1f2b', '#ffffff'], 'Foot Locker': ['#111111', '#ffffff'],
  'Søstrene Grene': ['#ffffff', '#1b1b1b'], 'Holland & Barrett': ['#006a4e', '#ffffff'], 'SPAR city': ['#007a3d', '#ffffff'],
  'Bever': ['#e2001a', '#ffffff'], 'Snipes': ['#111111', '#ffe600'], 'Manfield': ['#111111', '#ffffff']
};
const MUTED = [['#1c2b3a', '#f2e8cf'], ['#2d3a2e', '#f4f1de'], ['#3b2a2a', '#f6e8d0'], ['#26323f', '#ffffff'],
  ['#4a3b2a', '#fff3d6'], ['#222222', '#e8e8e8'], ['#33262e', '#ffe9ef'], ['#1f3d3d', '#e5fffa']];
const hashName = (s) => { let h = 7; for (let i = 0; i < s.length; i++) h = (Math.imul(h, 31) + s.charCodeAt(i)) | 0; return Math.abs(h); };

function nearestWall(rings, x, z) {
  let best = null;
  for (const r of rings) {
    if (x < r.minX - MAX_WALL_DISTANCE || x > r.maxX + MAX_WALL_DISTANCE || z < r.minZ - MAX_WALL_DISTANCE || z > r.maxZ + MAX_WALL_DISTANCE) continue;
    const p = r.pts;
    for (let i = 0; i < p.length; i += 2) {
      const j = (i + 2) % p.length;
      const ax = p[i], az = p[i + 1], dx = p[j] - ax, dz = p[j + 1] - az, len = Math.hypot(dx, dz);
      if (len < MIN_WALL_LENGTH) continue;
      const t = Math.max(0, Math.min(1, ((x - ax) * dx + (z - az) * dz) / (len * len)));
      const d = Math.hypot(x - (ax + dx * t), z - (az + dz * t));
      if (d < MAX_WALL_DISTANCE && (!best || d < best.d)) best = { d, ax, az, dx, dz, len, t, dir: r.dir };
    }
  }
  return best;
}

function drawAtlas(names) {
  const rows = Math.ceil(names.length / COLS);
  const canvas = document.createElement('canvas');
  canvas.width = COLS * CELL_W;
  canvas.height = rows * CELL_H;
  const ctx = canvas.getContext('2d');
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  names.forEach((name, i) => {
    const [bg, fg] = BRANDS[name] || MUTED[hashName(name) % MUTED.length];
    const x0 = (i % COLS) * CELL_W, y0 = Math.floor(i / COLS) * CELL_H;
    ctx.fillStyle = bg;
    ctx.fillRect(x0, y0, CELL_W, CELL_H);
    ctx.fillStyle = fg;
    let size = 26;
    ctx.font = `800 ${size}px Inter, Arial, sans-serif`;
    const width = ctx.measureText(name).width;
    if (width > CELL_W - 16) {
      size = Math.max(10, Math.floor(size * (CELL_W - 16) / width));
      ctx.font = `800 ${size}px Inter, Arial, sans-serif`;
    }
    ctx.fillText(name, x0 + CELL_W / 2, y0 + CELL_H / 2 + 1);
  });
  const tex = new THREE.CanvasTexture(canvas);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.anisotropy = 4;
  return { tex, rows };
}

export function createShopSigns(buildings) {
  const rings = [];
  for (const b of buildings) {
    if (!b.ring || b.ring.length < 6 || b.part) continue;
    const r = b.ring;
    let minX = Infinity, maxX = -Infinity, minZ = Infinity, maxZ = -Infinity, area = 0;
    for (let i = 0; i < r.length; i += 2) {
      const j = (i + 2) % r.length;
      area += r[i] * r[j + 1] - r[j] * r[i + 1];
      minX = Math.min(minX, r[i]); maxX = Math.max(maxX, r[i]);
      minZ = Math.min(minZ, r[i + 1]); maxZ = Math.max(maxZ, r[i + 1]);
    }
    rings.push({ pts: r, minX, maxX, minZ, maxZ, dir: Math.sign(area) || 1 });
  }

  // Names that occur most often get atlas cells first.
  const counts = new Map();
  for (const s of UTRECHT_SHOPS) counts.set(s[0], (counts.get(s[0]) || 0) + 1);
  const names = [...counts.keys()].sort((a, b) => counts.get(b) - counts.get(a)).slice(0, MAX_NAMES);
  const cellOf = new Map(names.map((n, i) => [n, i]));
  const { tex, rows } = drawAtlas(names);

  const positions = [], uvs = [], indices = [], placed = [];
  for (const [name, sx, sz] of UTRECHT_SHOPS) {
    const cell = cellOf.get(name);
    if (cell === undefined) continue;
    const wall = nearestWall(rings, sx, sz);
    if (!wall) continue;
    // Outward wall normal, same convention as the building walls in buildings.js.
    const nx = wall.dz / wall.len * wall.dir, nz = -wall.dx / wall.len * wall.dir;
    const w = Math.max(0.8, Math.min(5.5, wall.len - 0.8, 1.6 + name.length * 0.32));
    const h = w * CELL_H / CELL_W;
    const half = w / 2 / wall.len;
    const t = Math.max(half, Math.min(1 - half, wall.t));
    const cx = wall.ax + wall.dx * t + nx * 0.06, cz = wall.az + wall.dz * t + nz * 0.06;
    if (placed.some((p) => Math.hypot(p[0] - cx, p[1] - cz) < MIN_SPACING)) continue;
    placed.push([cx, cz]);
    const tx = nz, tz = -nx; // along the wall, so that tangent x up = outward normal
    const u0 = (cell % COLS) / COLS, u1 = u0 + 1 / COLS;
    const v1 = 1 - Math.floor(cell / COLS) / rows, v0 = v1 - 1 / rows;
    const base = positions.length / 3;
    for (const [s, up] of [[-1, -1], [1, -1], [1, 1], [-1, 1]]) {
      positions.push(cx + tx * s * w / 2, SIGN_Y + up * h / 2, cz + tz * s * w / 2);
    }
    uvs.push(u0, v0, u1, v0, u1, v1, u0, v1);
    indices.push(base, base + 1, base + 2, base, base + 2, base + 3);
  }
  if (!positions.length) return null;

  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
  geometry.setAttribute('uv', new THREE.Float32BufferAttribute(uvs, 2));
  geometry.setIndex(indices);
  geometry.computeBoundingSphere();
  const mesh = new THREE.Mesh(geometry, new THREE.MeshBasicNodeMaterial({ map: tex }));
  mesh.name = 'UtrechtShopSigns';
  mesh.userData.signCount = placed.length;
  return mesh;
}
