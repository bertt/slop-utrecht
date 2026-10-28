import * as THREE from 'three/webgpu';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import {
  Fn, float, vec3, attribute, positionGeometry, positionLocal, normalGeometry,
  abs, floor, fract, mod, round, step, fwidth, max, min, mix, clamp
} from 'three/tsl';
import { filteredPulse } from './tsl-materials.js';

const MAX_ESCAPES = 2400;
const MAX_LANDINGS = 7; // (buildings.js addSurveyedFireEscapes)
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

// One instance per escape, all masked planes. Parts 0/1: the front & side guards and 2/3: the flight guards, vertical
// planes spanning the escape's height (y 0-1); 4: the raised drop ladder; 5: the landing decks and 6: the flights'
// treads, one per storey (escapeLevel) at their height for a STOREY-high storey, hidden above the escape's landings.
function escapeGeometry() {
  const planes = [
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
    geometry.setAttribute('escapeLevel', new THREE.Float32BufferAttribute([0, 0, 0, 0], 1));
    return geometry;
  });
  const quad = (corners, part, level) => {
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute('position', new THREE.Float32BufferAttribute(corners.flat(), 3));
    geometry.setAttribute('uv', new THREE.Float32BufferAttribute([0, 0, 1, 0, 1, 1, 0, 1], 2));
    geometry.setAttribute('escapePart', new THREE.Float32BufferAttribute([part, part, part, part], 1));
    geometry.setAttribute('escapeLevel', new THREE.Float32BufferAttribute([level, level, level, level], 1));
    geometry.setIndex([0, 1, 2, 0, 2, 3]);
    geometry.computeVertexNormals();
    return geometry;
  };
  const steps = 16;
  for (let level = 0; level < MAX_LANDINGS; level++) {
    const y = level * STOREY;
    planes.push(quad([[-1.7, y, -0.55], [-1.7, y, 0.55], [1.7, y, 0.55], [1.7, y, -0.55]], 5, level));
    if (level === MAX_LANDINGS - 1) continue;
    const s = level % 2 ? -1 : 1;
    for (let i = 0; i < steps; i++) {
      const x0 = s * (-1.2 + 2.4 * i / steps), x1 = s * (-1.2 + 2.4 * (i + 1) / steps);
      const stepY = y + STOREY * (i + 1) / steps;
      const minX = Math.min(x0, x1), maxX = Math.max(x0, x1);
      planes.push(quad([[minX, stepY, -0.15], [minX, stepY, 0.5], [maxX, stepY, 0.5], [maxX, stepY, -0.15]], 6, level));
    }
  }
  return mergeGeometries(planes);
}

function flagRange(attribute, count) {
  if (!count) return;
  attribute.clearUpdateRanges();
  attribute.addUpdateRange(0, count * attribute.itemSize);
  attribute.needsUpdate = true;
}

export function createFireEscapes(group) {
  const steel = { color: 0x25292c, roughness: 0.65, metalness: 0.6 };
  const geometry = escapeGeometry();
  const sizes = new THREE.InstancedBufferAttribute(new Float32Array(MAX_ESCAPES * 2), 2);
  geometry.setAttribute('escapeSize', sizes);
  const material = new THREE.MeshStandardNodeMaterial({ ...steel, side: THREE.DoubleSide, alphaToCoverage: true });
  const part = attribute('escapePart', 'float');
  const size = attribute('escapeSize', 'vec2'); // Storey and nominal escape height.
  const scale = size.x.div(STOREY);
  // From the bottom of the raised ladder (the instance origin) to the top of the last landing's guard
  const fullHeight = size.y.sub(1).add(scale.mul(3.2));
  // (after the instance transform, which only turns the escape about y and moves it: lift the vertices in place)
  material.positionNode = Fn(() => {
    const p = positionGeometry;
    const flat = step(4.5, part);
    // Decks on every landing, treads below all but the top one; the rest collapse to a point
    const landings = round(size.y.sub(1).div(size.x)).add(1);
    const shown = step(attribute('escapeLevel', 'float').add(step(5.5, part)).add(0.5), landings);
    const y = mix(p.y.mul(fullHeight), p.y.add(2.2).mul(scale), flat);
    return positionLocal.add(vec3(0, y.sub(p.y), 0)).mul(mix(1, shown, flat));
  })();
  material.opacityNode = Fn(() => {
    const across = positionGeometry.x.add(1.7);
    // Include the raised ladder below the first landing and the scaled top guard.
    const height = positionGeometry.y.mul(fullHeight).sub(scale.mul(2.2));
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
      const visible = step(0, index).mul(step(index.add(1), floor(size.y.div(size.x))));
      return union(pickets, rails).mul(visible);
    };
    // A flight's guard continues above the next landing, where the following flight reverses direction.
    const stairs = union(flight(floor(level)), flight(floor(level).sub(1)));
    const ladderX = across.sub(0.08).div(0.34);
    const ladderY = height.div(scale).add(2.2).div(2.15);
    const ladderRails = filteredBar(min(ladderX, float(1).sub(ladderX)), 0.065, fwidth(ladderX));
    const rungs = repeatingBar(ladderY.mul(8), 0.07);
    const ladder = union(ladderRails, rungs).mul(filteredBar(ladderY.sub(0.5), 0.5, fwidth(ladderY)));
    // Landing decks: 10 cm grating framed around the panels, open in front where the flights pass
    const d = positionGeometry.xz;
    const grating = union(repeatingBar(d.x.mul(10), 0.08), repeatingBar(d.y.mul(10), 0.08));
    const edge = min(abs(abs(d.x).sub(1.7)), abs(abs(d.x).sub(1.2)), abs(abs(d.y).sub(0.55)), abs(d.y.add(0.18)));
    const frame = filteredBar(edge, 0.025, max(fwidth(d.x), fwidth(d.y)));
    const opening = step(abs(d.x), 1.2).mul(step(-0.18, d.y));
    const landing = union(grating, frame).mul(float(1).sub(opening.mul(step(0.025, edge))));
    const vertical = mix(mix(union(deck, guards).mul(step(0, height)), stairs, step(1.5, part)), ladder, step(3.5, part));
    return mix(mix(vertical, landing, step(4.5, part)), 1, step(5.5, part));
  })().toVar();
  material.maskNode = material.opacityNode.greaterThan(0);
  material.maskShadowNode = material.opacityNode.greaterThan(0.5);
  const mesh = new THREE.InstancedMesh(geometry, material, MAX_ESCAPES);
  mesh.name = 'FireEscapes';
  mesh.count = 0;
  mesh.castShadow = mesh.receiveShadow = true;
  mesh.frustumCulled = false;
  mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
  group.add(mesh);

  const dummy = new THREE.Object3D();
  let count = 0;
  return {
    begin() {
      count = 0;
    },
    add(fe) {
      if (count >= MAX_ESCAPES) return;
      dummy.rotation.set(0, (fe.ry || 0) + fe.facing, 0);
      dummy.position.set(fe.x, fe.y - (fe.storey / STOREY) * 2.2, fe.z);
      dummy.updateMatrix();
      mesh.setMatrixAt(count, dummy.matrix);
      sizes.setXY(count++, fe.storey, fe.h);
    },
    end() {
      mesh.count = count;
      flagRange(mesh.instanceMatrix, count);
      flagRange(sizes, count);
    }
  };
}
