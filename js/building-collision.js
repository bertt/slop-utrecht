function polygonContains(polygon, x, z) {
  let inside = false;
  for (let r = -1; r < polygon.holes.length; r++) {
    const ring = r < 0 ? polygon.outer : polygon.holes[r];
    for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
      const a = ring[i], b = ring[j];
      if ((a.z > z) !== (b.z > z) && x < a.x + (b.x - a.x) * (z - a.z) / (b.z - a.z)) inside = !inside;
    }
  }
  return inside;
}

// Test the actual outline, including courtyards, after the caller's cheap bounds check.
function polygonBoxOverlaps(polygon, x, z, hx, hz, cs = 1, sn = 0) {
  if (polygonContains(polygon, x, z)) return true;
  for (let r = -1; r < polygon.holes.length; r++) {
    const ring = r < 0 ? polygon.outer : polygon.holes[r];
    for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
      const a = ring[j], b = ring[i];
      const ax = (a.x - x) * cs - (a.z - z) * sn, az = (a.x - x) * sn + (a.z - z) * cs;
      const dx = (b.x - a.x) * cs - (b.z - a.z) * sn, dz = (b.x - a.x) * sn + (b.z - a.z) * cs;
      let lo = 0, hi = 1;
      if (Math.abs(dx) < 1e-10) {
        if (Math.abs(ax) >= hx) continue;
      } else {
        const t0 = (-hx - ax) / dx, t1 = (hx - ax) / dx;
        lo = Math.max(lo, Math.min(t0, t1)); hi = Math.min(hi, Math.max(t0, t1));
      }
      if (Math.abs(dz) < 1e-10) {
        if (Math.abs(az) >= hz) continue;
      } else {
        const t0 = (-hz - az) / dz, t1 = (hz - az) / dz;
        lo = Math.max(lo, Math.min(t0, t1)); hi = Math.min(hi, Math.max(t0, t1));
      }
      if (hi - lo > 1e-10) return true;
    }
  }
  return false;
}

function polygonContact(polygon, x, z, body, contact) {
  if (body.car) {
    const { hx, hz, cos, sin } = body;
    if (!polygonBoxOverlaps(polygon, x, z, hx, hz, cos, sin)) return false;
    if (!contact) return true;
    let best = Infinity, vx = 0, vz = 0;
    const tryPush = (dx, dz) => {
      const length = Math.hypot(dx, dz);
      if (length < 1e-10 || length >= best) return;
      const scale = (length + 1e-6) / length;
      if (polygonBoxOverlaps(polygon, x + dx * scale, z + dz * scale, hx, hz, cos, sin)) return;
      best = length; vx = dx; vz = dz;
    };
    // Whole-outline escape candidates avoid the internal seams of triangulated colliders.
    for (let r = -1; r < polygon.holes.length; r++) {
      const ring = r < 0 ? polygon.outer : polygon.holes[r];
      for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
        const a = ring[j], b = ring[i];
        const dx = a.x - x, dz = a.z - z;
        const ex = b.x - a.x, ez = b.z - a.z, length = Math.hypot(ex, ez);
        if (length > 0) {
          const nx = -ez / length, nz = ex / length;
          const d = dx * nx + dz * nz;
          const support = Math.abs(nx * cos - nz * sin) * hx + Math.abs(nx * sin + nz * cos) * hz;
          tryPush(nx * (d + support), nz * (d + support));
          tryPush(nx * (d - support), nz * (d - support));
        }
        const u = dx * cos - dz * sin, v = dx * sin + dz * cos;
        tryPush((u + hx) * cos, -(u + hx) * sin);
        tryPush((u - hx) * cos, -(u - hx) * sin);
        tryPush((v + hz) * sin, (v + hz) * cos);
        tryPush((v - hz) * sin, (v - hz) * cos);
        const d = Math.hypot(dx, dz);
        if (d > 0) {
          const support = (Math.abs(u) * hx + Math.abs(v) * hz) / d;
          tryPush(dx * (1 + support / d), dz * (1 + support / d));
          tryPush(dx * (1 - support / d), dz * (1 - support / d));
        }
      }
    }
    contact.nx = vx / best; contact.nz = vz / best; contact.depth = best + 1e-6;
    return true;
  }

  if (!circleContact(polygon, x, z, body.radius, contact)) return false;
  if (contact) {
    let dx = contact.nx * (contact.depth + 1e-6), dz = contact.nz * (contact.depth + 1e-6);
    // A concave corner may touch two walls. Resolve both before returning one combined push.
    for (let i = 0; i < 4; i++) {
      if (!circleContact(polygon, x + dx, z + dz, body.radius, contact)) {
        contact.depth = Math.hypot(dx, dz); contact.nx = dx / contact.depth; contact.nz = dz / contact.depth;
        return true;
      }
      dx += contact.nx * (contact.depth + 1e-6); dz += contact.nz * (contact.depth + 1e-6);
    }
    // If dropped into a space narrower than the body, find an exit for its enclosing square.
    return polygonContact(polygon, x, z, { car: true, hx: body.radius, hz: body.radius, cos: 1, sin: 0 }, contact);
  }
  return true;
}

function circleContact(polygon, x, z, radius, contact) {
  const inside = polygonContains(polygon, x, z);
  let distance = Infinity, nx = 0, nz = 0, edgeX = 0, edgeZ = 0;
  for (let r = -1; r < polygon.holes.length; r++) {
    const ring = r < 0 ? polygon.outer : polygon.holes[r];
    for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
      const a = ring[j], b = ring[i], dx = b.x - a.x, dz = b.z - a.z;
      if (dx === 0 && dz === 0) continue;
      const t = Math.max(0, Math.min(1, ((x - a.x) * dx + (z - a.z) * dz) / (dx * dx + dz * dz || 1)));
      const qx = x - a.x - dx * t, qz = z - a.z - dz * t, d = Math.hypot(qx, qz);
      if (d < distance) { distance = d; nx = qx; nz = qz; edgeX = dx; edgeZ = dz; }
    }
  }
  if (!inside && distance >= radius) return false;
  if (contact) {
    if (distance > 1e-10) {
      const sign = inside ? -1 : 1;
      nx *= sign / distance; nz *= sign / distance;
    } else {
      const length = Math.hypot(edgeX, edgeZ);
      nx = -edgeZ / length; nz = edgeX / length;
      if (polygonContains(polygon, x + nx * 1e-5, z + nz * 1e-5)) { nx = -nx; nz = -nz; }
    }
    contact.nx = nx; contact.nz = nz; contact.depth = radius + (inside ? distance : -distance);
  }
  return true;
}

// Fraction of a ray's clipped interval inside the footprint, used by the low-rate audio probes.
function polygonSegmentFraction(polygon, ax, az, dx, dz, enter, exit) {
  if (exit <= enter) return 0;
  const cuts = [enter, exit];
  for (let r = -1; r < polygon.holes.length; r++) {
    const ring = r < 0 ? polygon.outer : polygon.holes[r];
    for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
      const a = ring[j], b = ring[i], ex = b.x - a.x, ez = b.z - a.z;
      const cross = dx * ez - dz * ex;
      if (Math.abs(cross) < 1e-10) continue;
      const qx = a.x - ax, qz = a.z - az;
      const t = (qx * ez - qz * ex) / cross, u = (qx * dz - qz * dx) / cross;
      if (t > enter && t < exit && u >= 0 && u <= 1) cuts.push(t);
    }
  }
  cuts.sort((a, b) => a - b);
  let fraction = 0;
  for (let i = 1; i < cuts.length; i++) {
    const t = (cuts[i - 1] + cuts[i]) * 0.5;
    if (polygonContains(polygon, ax + dx * t, az + dz * t)) fraction += cuts[i] - cuts[i - 1];
  }
  return fraction;
}

export { polygonContains, polygonBoxOverlaps, polygonContact, polygonSegmentFraction };
