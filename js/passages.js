// Openings in building walls where a mapped footpath runs through a building (passages, arcades, gate houses),
// so walkers aren't stopped by a wall in the middle of a street.
import { UTRECHT_DATA } from './city-config.js';

const CELL = 32;
const WALKWAYS = new Set(['footway', 'pedestrian', 'path', 'steps', 'living_street']);
const MIN_CROSSING_SIN = 0.42; // ignore paths that only graze a wall
const grid = new Map();

for (const road of UTRECHT_DATA?.roads || []) {
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
