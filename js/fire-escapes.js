import * as THREE from 'three/webgpu';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import {
  Fn, float, attribute, uv, positionGeometry, normalGeometry,
  abs, floor, fract, mod, step, fwidth, max, min, mix, clamp
} from 'three/tsl';
import { filteredPulse } from './tsl-materials.js';

const MAX_ESCAPES = 2400;
const MAX_NEAR_FLOORS = 256;
const NEAR_DISTANCE = 30;
const STOREY = 3.5;

// Pixel coverage, rather than a minimum one-pixel bar width, keeps distant ironwork open.
const filteredBar = Fn(([distance, halfWidth, footprint]) => {
  const w = max(footprint, 0.0001).toVar();
  return clamp(float(halfWidth).add(w.mul(0.5)).sub(abs(distance)).div(w), 0, min(1, float(halfWidth).mul(2).div(w)));
});
const repeatingBar = (coord, halfWidth, footprint = fwidth(coord)) => filteredPulse(
  fract(coord.add(0.5)), float(0.5).sub(halfWidth), float(0.5).add(halfWidth), footprint
);
const union = (a, b) => a.add(b).sub(a.mul(b));

// A shared floor module: open landings, thin horizontal treads and masked iron railings.
// Parts 0/1 are the landing/guard; 2/3 the flight/guard; 4 the raised drop ladder.
function floorGeometry() {
  const positions = [], uvs = [], parts = [], indices = [];
  function quad(a, b, c, d, part, width = 1) {
    const first = positions.length / 3;
    for (const p of [a, b, c, d]) positions.push(...p);
    uvs.push(0, 0, width, 0, width, 1, 0, 1);
    parts.push(part, part, part, part);
    indices.push(first, first + 1, first + 2, first, first + 2, first + 3);
  }
  function deck(x0, x1, z0, z1, y, part) {
    quad([x0, y, z0], [x0, y, z1], [x1, y, z1], [x1, y, z0], part);
  }
  function guard(x0, z0, x1, z1, y0 = 0, y1 = 0, part = 1) {
    const bays = Math.round(Math.hypot(x1 - x0, z1 - z0) / 0.17);
    quad([x0, y0, z0], [x1, y1, z1], [x1, y1 + 1, z1], [x0, y0 + 1, z0], part, bays);
  }
  deck(-1.7, 1.7, -0.55, -0.18, 0, 0);
  deck(-1.7, -1.2, -0.18, 0.55, 0, 0);
  deck(1.2, 1.7, -0.18, 0.55, 0, 0);
  guard(-1.7, 0.55, 1.7, 0.55);
  guard(-1.7, -0.55, -1.7, 0.55);
  guard(1.7, 0.55, 1.7, -0.55);
  const steps = 16;
  for (let i = 0; i < steps; i++) {
    deck(-1.2 + 2.4 * i / steps, -1.2 + 2.4 * (i + 1) / steps, -0.15, 0.50, STOREY * (i + 1) / steps, 2);
  }
  for (const z of [-0.17, 0.52]) {
    quad([-1.2, -0.08, z], [1.2, STOREY - 0.08, z], [1.2, STOREY + 0.03, z], [-1.2, 0.03, z], 2);
    guard(-1.2, z, 1.2, z, 0, STOREY, 3);
  }
  quad([-1.62, -2.2, 0.56], [-1.28, -2.2, 0.56], [-1.28, -0.05, 0.56], [-1.62, -0.05, 0.56], 4);
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
  geometry.setAttribute('uv', new THREE.Float32BufferAttribute(uvs, 2));
  geometry.setAttribute('escapePart', new THREE.Float32BufferAttribute(parts, 1));
  geometry.setIndex(indices);
  geometry.computeVertexNormals();
  return geometry;
}

// Six masked planes keep the guards, flights and ladder at the same depth as the detailed model.
function proxyGeometry() {
  return mergeGeometries([
    [3.4, 0, 0.55, 0, 1],
    [1.1, -1.7, 0, -Math.PI / 2, 1],
    [1.1, 1.7, 0, Math.PI / 2, 1],
    [2.4, 0, -0.17, 0, 3],
    [2.4, 0, 0.52, 0, 3],
    [0.34, -1.45, 0.56, 0, 4]
  ].map(([width, x, z, rotation, part]) => {
    const geometry = new THREE.PlaneGeometry(width, 1);
    geometry.translate(0, 0.5, 0);
    geometry.rotateY(rotation);
    geometry.translate(x, 0, z);
    geometry.setAttribute('escapePart', new THREE.Float32BufferAttribute([part, part, part, part], 1));
    return geometry;
  }));
}

function flagRange(attribute, count) {
  if (!count) return;
  attribute.clearUpdateRanges();
  attribute.addUpdateRange(0, count * attribute.itemSize);
  attribute.needsUpdate = true;
}

export function createFireEscapes(group) {
  const steel = { color: 0x25292c, roughness: 0.65, metalness: 0.6 };
  const nearMaterial = new THREE.MeshStandardNodeMaterial({ ...steel, side: THREE.DoubleSide, alphaToCoverage: true });
  nearMaterial.opacityNode = Fn(() => {
    const part = attribute('escapePart', 'float');
    const flags = attribute('escapeFlags', 'vec2');
    const u = uv();
    const p = positionGeometry.xz;
    const grid = p.mul(10);
    const bars = union(repeatingBar(grid.x, 0.08), repeatingBar(grid.y, 0.08));
    // Frame the landing panels and their stair opening; grating settles to its average coverage.
    const edge = min(abs(abs(p.x).sub(1.7)), abs(abs(p.x).sub(1.2)), abs(abs(p.y).sub(0.55)), abs(p.y.add(0.18)));
    const frame = filteredBar(edge, 0.025, max(fwidth(p.x), fwidth(p.y)));
    const solid = mix(union(bars, frame), 1, step(0.5, part));
    const pickets = repeatingBar(u.x, 0.08);
    const rail = filteredBar(u.y.sub(0.97), 0.03, fwidth(u.y));
    const middleRail = filteredBar(u.y.sub(0.48), 0.018, fwidth(u.y));
    const guard = union(pickets, rail.add(middleRail));
    const ladderRails = filteredBar(min(u.x, float(1).sub(u.x)), 0.065, fwidth(u.x));
    const rungs = repeatingBar(u.y.mul(8), 0.07);
    const ladder = step(3.5, part);
    const flight = step(1.5, part).mul(float(1).sub(ladder));
    const visible = mix(1, flags.x, flight).mul(mix(1, flags.y, ladder));
    return mix(mix(solid, guard, mod(part, 2)), union(ladderRails, rungs), ladder).mul(visible);
  })().toVar();
  nearMaterial.maskNode = nearMaterial.opacityNode.greaterThan(0);
  nearMaterial.maskShadowNode = nearMaterial.opacityNode.greaterThan(0.5);

  const geometry = floorGeometry();
  const mirrored = geometry.clone();
  mirrored.scale(-1, 1, 1);
  const index = mirrored.index.array;
  for (let i = 0; i < index.length; i += 3) {
    const temp = index[i + 1];
    index[i + 1] = index[i + 2];
    index[i + 2] = temp;
  }
  const near = [geometry, mirrored].map((g, i) => {
    g.setAttribute('escapeFlags', new THREE.InstancedBufferAttribute(new Float32Array(MAX_NEAR_FLOORS * 2), 2));
    const mesh = new THREE.InstancedMesh(g, nearMaterial, MAX_NEAR_FLOORS);
    mesh.name = `FireEscapesNear${i}`;
    return mesh;
  });

  const farGeometry = proxyGeometry();
  const farData = new THREE.InstancedBufferAttribute(new Float32Array(MAX_ESCAPES * 2), 2);
  farGeometry.setAttribute('escapeSize', farData);
  const farMaterial = new THREE.MeshStandardNodeMaterial({ ...steel, side: THREE.DoubleSide, alphaToCoverage: true });
  farMaterial.opacityNode = Fn(() => {
    const part = attribute('escapePart', 'float');
    const size = attribute('escapeSize', 'vec2'); // Storey and nominal escape height.
    const scale = size.x.div(STOREY);
    const across = positionGeometry.x.add(1.7);
    // Include the raised ladder below the first landing and the scaled top guard.
    const height = positionGeometry.y.mul(size.y.sub(1).add(scale.mul(3.2))).sub(scale.mul(2.2));
    const level = height.div(size.x);
    const py = fwidth(height);
    const levelWidth = py.div(size.x);
    const front = abs(normalGeometry.z);
    const along = mix(positionGeometry.z.add(0.55), across, front);
    const bay = along.mul(mix(6 / 1.1, 20 / 3.4, front));
    const pickets = repeatingBar(bay, 0.08);
    const guardHeight = filteredPulse(fract(level), 0, 1 / STOREY, levelWidth);
    const rails = repeatingBar(level.sub(0.97 / STOREY), 0.03 / STOREY, levelWidth)
      .add(repeatingBar(level.sub(0.48 / STOREY), 0.018 / STOREY, levelWidth));
    const guards = union(pickets.mul(guardHeight), rails);
    const deck = repeatingBar(level.sub(float(0.04).div(size.x)), float(0.05).div(size.x), levelWidth);
    const flight = (index) => {
      const parity = mod(index, 2);
      const x = mix(across, float(3.4).sub(across), parity).sub(0.5);
      const y = height.sub(index.mul(size.x));
      const railY = y.sub(x.mul(size.x.div(2.4))).div(scale);
      // Differentiate the flight before floor selection reverses its slope at the next landing.
      const slope = mix(float(1), float(-1), parity).mul(size.x.div(2.4));
      const footprint = abs(height.dFdx().sub(across.dFdx().mul(slope)))
        .add(abs(height.dFdy().sub(across.dFdy().mul(slope)))).div(scale);
      const bay = x.mul(14 / 2.4);
      const pickets = repeatingBar(bay, 0.08, fwidth(across).mul(14 / 2.4)).mul(filteredBar(railY.sub(0.5), 0.5, footprint));
      const rails = filteredBar(railY.add(0.025), 0.055, footprint)
        .add(filteredBar(railY.sub(0.97), 0.03, footprint)).add(filteredBar(railY.sub(0.48), 0.018, footprint));
      const stepHeight = size.x.div(16);
      // Horizontal tread bands clipped to the diagonal flight avoid sampling a discontinuous staircase.
      const treads = repeatingBar(y.div(stepHeight), float(0.01).div(stepHeight), py.div(stepHeight))
        .mul(filteredBar(railY.sub(STOREY / 32), float(STOREY / 32).add(float(0.01).div(scale)), footprint));
      const visible = step(0, index).mul(step(index.add(1), floor(size.y.div(size.x))));
      return union(union(pickets, rails), treads).mul(visible);
    };
    // A flight's guard continues above the next landing, where the following flight reverses direction.
    const stairs = union(flight(floor(level)), flight(floor(level).sub(1)));
    const ladderX = across.sub(0.08).div(0.34);
    const ladderY = height.div(scale).add(2.2).div(2.15);
    const ladderRails = filteredBar(min(ladderX, float(1).sub(ladderX)), 0.065, fwidth(ladderX));
    const rungs = repeatingBar(ladderY.mul(8), 0.07);
    const ladder = union(ladderRails, rungs).mul(filteredBar(ladderY.sub(0.5), 0.5, fwidth(ladderY)));
    return mix(mix(union(deck, guards).mul(step(0, height)), stairs, step(1.5, part)), ladder, step(3.5, part));
  })().toVar();
  farMaterial.maskNode = farMaterial.opacityNode.greaterThan(0);
  farMaterial.maskShadowNode = farMaterial.opacityNode.greaterThan(0.5);
  const far = new THREE.InstancedMesh(farGeometry, farMaterial, MAX_ESCAPES);
  far.name = 'FireEscapesFar';
  for (const mesh of [...near, far]) {
    mesh.count = 0;
    mesh.castShadow = mesh.receiveShadow = true;
    mesh.frustumCulled = false;
    mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    group.add(mesh);
  }

  const dummy = new THREE.Object3D();
  const counts = [0, 0];
  let total = 0, nearFloors = 0, farCount = 0;
  return {
    begin() {
      total = nearFloors = farCount = counts[0] = counts[1] = 0;
    },
    add(fe, focusX, focusZ) {
      if (total >= MAX_ESCAPES) return;
      total++;
      const dx = fe.x - focusX, dz = fe.z - focusZ;
      dummy.rotation.set(0, (fe.ry || 0) + fe.facing, 0);
      if (dx * dx + dz * dz < NEAR_DISTANCE * NEAR_DISTANCE && nearFloors + fe.landings <= MAX_NEAR_FLOORS) {
        dummy.scale.set(1, fe.storey / STOREY, 1);
        for (let i = 0; i < fe.landings; i++) {
          const parity = i % 2, n = counts[parity]++;
          dummy.position.set(fe.x, fe.y + i * fe.storey, fe.z);
          dummy.updateMatrix();
          near[parity].setMatrixAt(n, dummy.matrix);
          near[parity].geometry.getAttribute('escapeFlags').setXY(n, i < fe.landings - 1 ? 1 : 0, i === 0 ? 1 : 0);
        }
        nearFloors += fe.landings;
      } else {
        const scale = fe.storey / STOREY;
        const height = fe.h - 1 + scale * 3.2;
        dummy.position.set(fe.x, fe.y - scale * 2.2, fe.z);
        dummy.scale.set(1, height, 1);
        dummy.updateMatrix();
        far.setMatrixAt(farCount, dummy.matrix);
        farData.setXY(farCount++, fe.storey, fe.h);
      }
    },
    end() {
      for (let i = 0; i < near.length; i++) {
        near[i].count = counts[i];
        flagRange(near[i].instanceMatrix, counts[i]);
        flagRange(near[i].geometry.getAttribute('escapeFlags'), counts[i]);
      }
      far.count = farCount;
      flagRange(far.instanceMatrix, farCount);
      flagRange(farData, farCount);
    }
  };
}
