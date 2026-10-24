import * as THREE from 'three/webgpu';

// The engine's hand-built New York monuments are removed. Legacy exports keep the upstream controllers working.
export let bryantParkLawn = null;
export const LANDMARKS = [];
export const BERGHAIN_TREE_SITES = [];
export const LANDMARK_SOURCE_EXCLUSIONS = new Set();
export const LANDMARK_EXCLUSIONS = [];

export function buildLandmarks(scene) {
  const group = new THREE.Group();
  group.name = 'ManhattanLandmarks';
  scene.add(group);
  return { group, colliders: [], exclusions: LANDMARK_EXCLUSIONS, update() {} };
}
