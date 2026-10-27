// Openings in building walls where a mapped footpath runs through a building (passages, arcades, gate houses),
// so walkers aren't stopped by a wall in the middle of a street.
import { UTRECHT_DATA } from './city-config.js';

const CELL = 32;
const WALKWAYS = new Set(['footway', 'pedestrian', 'path', 'steps', 'living_street']);
const MIN_CROSSING_SIN = 0.42; // ignore paths that only graze a wall
const HUG = 1.25; // a road centreline this close to a wall leaves no room for a cyclist beside it
const grid = new Map();
const roadGrid = new Map();

for (const road of UTRECHT_DATA?.roads || []) {
  if (!road.tunnel && !road.bridge && (road.layer || 0) >= 0) {
    const q = road.pts;
    for (let i = 0; i + 3 < q.length; i += 2) {
      const seg = [q[i], q[i + 1], q[i + 2], q[i + 3]];
      for (let ix = Math.floor(Math.min(seg[0], seg[2]) / CELL); ix <= Math.floor(Math.max(seg[0], seg[2]) / CELL); ix++) {
        for (let iz = Math.floor(Math.min(seg[1], seg[3]) / CELL); iz <= Math.floor(Math.max(seg[1], seg[3]) / CELL); iz++) {
          const k = ix * 100000 + iz;
          if (!roadGrid.has(k)) roadGrid.set(k, []);
          roadGrid.get(k).push(seg);
        }
      }
    }
  }
  if (!WALKWAYS.has(road.kind) || road.tunnel || road.bridge || (road.layer || 0) < 0) continue;
  const p = road.pts;
  for (let i = 0; i + 3 < p.length; i += 2) {
    const seg = [p[i], p[i + 1], p[i + 2], p[i + 3]];
    for (let ix = Math.floor(Math.min(seg[0], seg[2]) / CELL); ix <= Math.floor(Math.max(seg[0], seg[2]) / CELL); ix++) {
      for (let iz = Math.floor(Math.min(seg[1], seg[3]) / CELL); iz <= Math.floor(Math.max(seg[1], seg[3]) / CELL); iz++) {
        const k = ix * 100000 + iz;
        if (!grid.has(k)) grid.set(k, []);
        grid.get(k).push(seg);
      }
    }
  }
}

/** Positions (0..1 along a→b) where a walkway crosses the wall segment. */
export function wallCrossings(ax, az, bx, bz) {
  const out = [];
  const dx = bx - ax, dz = bz - az, len = Math.hypot(dx, dz);
  if (!len) return out;
  const seen = new Set();
  for (let ix = Math.floor(Math.min(ax, bx) / CELL); ix <= Math.floor(Math.max(ax, bx) / CELL); ix++) {
    for (let iz = Math.floor(Math.min(az, bz) / CELL); iz <= Math.floor(Math.max(az, bz) / CELL); iz++) {
      for (const s of grid.get(ix * 100000 + iz) || []) {
        if (seen.has(s)) continue;
        seen.add(s);
        const sx = s[2] - s[0], sz = s[3] - s[1], sl = Math.hypot(sx, sz);
        const den = dx * sz - dz * sx;
        if (!sl || Math.abs(den) / (len * sl) < MIN_CROSSING_SIN) continue;
        const t = ((s[0] - ax) * sz - (s[1] - az) * sx) / den;
        const u = ((s[0] - ax) * dz - (s[1] - az) * dx) / den;
        if (t >= 0 && t <= 1 && u >= 0 && u <= 1) out.push(t);
      }
    }
  }
  return out.sort((a, b) => a - b);
}

function roadHugs(x, z) {
  const cx = Math.floor(x / CELL), cz = Math.floor(z / CELL);
  for (let gx = cx - 1; gx <= cx + 1; gx++) for (let gz = cz - 1; gz <= cz + 1; gz++) for (const s of roadGrid.get(gx * 100000 + gz) || []) {
    const dx = s[2] - s[0], dz = s[3] - s[1];
    const u = Math.max(0, Math.min(1, ((x - s[0]) * dx + (z - s[1]) * dz) / (dx * dx + dz * dz || 1e-9)));
    if (Math.hypot(s[0] + dx * u - x, s[1] + dz * u - z) < HUG) return true;
  }
  return false;
}

/** Solid spans (0..1 along a→b) of a wall: gaps where walkways cross it or a road runs right along it are left out. */
export function solidWallSpans(ax, az, bx, bz, gapHalf) {
  const len = Math.hypot(bx - ax, bz - az);
  const open = wallCrossings(ax, az, bx, bz).map((t) => [t - gapHalf, t + gapHalf]);
  const steps = Math.max(1, Math.ceil(len / 0.75));
  let start = -1;
  for (let i = 0; i <= steps; i++) {
    const t = i / steps;
    const hug = roadHugs(ax + (bx - ax) * t, az + (bz - az) * t);
    if (hug && start < 0) start = Math.max(0, t - 0.5 / steps);
    if ((!hug || i === steps) && start >= 0) { open.push([start, Math.min(1, t + 0.5 / steps)]); start = -1; }
  }
  open.sort((p, q) => p[0] - q[0]);
  const spans = [];
  let from = 0;
  for (const [o0, o1] of open) {
    if (o0 > from) spans.push([from, o0]);
    from = Math.max(from, o1);
  }
  if (from < 1) spans.push([from, 1]);
  return spans;
}
