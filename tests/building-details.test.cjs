const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const { join } = require('node:path');
const test = require('node:test');
const { loadModule } = require('./helpers/module.cjs');

const collision = loadModule(readFileSync(join(__dirname, '../js/building-collision.js'), 'utf8'));
const { addBuildingDetails } = loadModule(readFileSync(join(__dirname, '../js/building-details.js'), 'utf8'), {
  imports: { './building-collision.js': collision }
});
const ring = points => points.map(([x, z]) => ({ x, z }));
const square = (x, z, size) => ring([[x, z], [x + size, z], [x + size, z + size], [x, z + size]]);
const building = (outer, holes = []) => ({ cx: 20, cz: 20, height: 24, storefronts: true, polygons: [{ outer, holes }] });
const random = seed => () => ((seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0) / 4294967296);
function details(b, seed = 1, neighbours = [b], rand = random(seed)) {
  const result = { cornices: [], waterTowers: [], hvacUnits: [], awnings: [], scaffoldSheds: [] };
  addBuildingDetails(b, result, { masonry: true, rand, neighbours });
  return result;
}
const overlaps = (polygon, item) => collision.polygonBoxOverlaps(polygon, item.x, item.z,
  item.w / 2, item.d / 2, Math.cos(item.ry), Math.sin(item.ry));

test('roof accessories remain supported on rotated, concave and courtyard footprints', () => {
  const rotated = square(0, 0, 40).map(({ x, z }) => ({ x: x * Math.cos(0.6) - z * Math.sin(0.6), z: x * Math.sin(0.6) + z * Math.cos(0.6) }));
  const fixtures = [building(rotated),
    building(ring([[0, 0], [40, 0], [40, 14], [14, 14], [14, 40], [0, 40]])),
    building(square(0, 0, 40), [square(12, 12, 16)])];
  for (const b of fixtures) {
    let checked = 0;
    for (let seed = 1; seed <= 40; seed++) {
      const d = details(b, seed * 104729);
      const roofs = [...d.hvacUnits, ...d.waterTowers.map(item => ({ ...item, w: 4, d: 4 }))];
      for (const item of roofs) {
        for (let i = 0; i <= 16; i++) for (let j = 0; j <= 16; j++) {
          const u = (i / 16 - 0.5) * item.w, v = (j / 16 - 0.5) * item.d;
          const x = item.x + u * Math.cos(item.ry) + v * Math.sin(item.ry);
          const z = item.z - u * Math.sin(item.ry) + v * Math.cos(item.ry);
          assert.ok(collision.polygonContains(b.polygons[0], x, z), 'the whole accessory must stand on the roof');
        }
        checked++;
      }
    }
    assert.ok(checked > 5, 'exercise actual placements on each footprint');
  }
});

test('a small courtyard enclosed by all four accessory corners still blocks placement', () => {
  const b = building(square(0, 0, 40), [square(19.9, 19.9, 0.2)]);
  let calls = 0;
  const d = details(b, 0, [b], () => calls++ === 0 ? 0 : 0.5);
  assert.equal(d.waterTowers.length, 0);
});

test('party walls block cornices and storefronts while exposed walls keep their details', () => {
  const b = building(square(0, 0, 40)), neighbour = building(square(40, 0, 40));
  neighbour.height = 40;
  let storefronts = 0;
  for (let seed = 1; seed <= 40; seed++) {
    const d = details(b, seed * 104729, [b, neighbour]);
    assert.equal(d.cornices.length, 3, 'only the shared wall loses its cornice');
    for (const item of [...d.cornices, ...d.awnings, ...d.scaffoldSheds]) {
      assert.equal(overlaps(neighbour.polygons[0], item), false);
    }
    storefronts += d.awnings.length + d.scaffoldSheds.length;
  }
  assert.ok(storefronts > 10, 'exposed storefronts must not all be discarded');
});

test('roof accessories avoid a taller overlapping building section', () => {
  const b = building(square(0, 0, 40)), taller = building(square(20, 0, 40));
  taller.height = 40;
  let checked = 0;
  for (let seed = 1; seed <= 40; seed++) {
    const d = details(b, seed * 104729, [b, taller]);
    for (const item of [...d.hvacUnits, ...d.waterTowers.map(item => ({ ...item, w: 4, d: 4 }))]) {
      assert.equal(overlaps(taller.polygons[0], item), false);
      checked++;
    }
  }
  assert.ok(checked > 5);
});

test('non-retail buildings lose shop awnings but retain rooftop details and construction sheds', () => {
  const b = building(square(0, 0, 40));
  let sheds = 0;
  for (let seed = 1; seed <= 40; seed++) {
    const retail = details(b, seed * 104729);
    const residential = details({ ...b, storefronts: false }, seed * 104729);
    assert.equal(residential.awnings.length, 0);
    for (const key of ['cornices', 'waterTowers', 'hvacUnits']) assert.deepEqual(residential[key], retail[key]);
    sheds += residential.scaffoldSheds.length;
  }
  assert.ok(sheds > 0);
});

test('seeded decoration is deterministic, bounded and leaves surveyed geometry untouched', () => {
  const b = building(square(0, 0, 200)), original = JSON.stringify(b);
  const d = details(b, 1234);
  assert.deepEqual(details(b, 1234), d);
  assert.equal(JSON.stringify(b), original);
  for (let seed = 1; seed <= 40; seed++) {
    const d = details(b, seed * 104729);
    assert.ok(d.waterTowers.length <= 1 && d.hvacUnits.length <= 1);
    assert.ok(d.awnings.length + d.scaffoldSheds.length <= 4);
    assert.ok(d.scaffoldSheds.length <= 1);
    for (const item of Object.values(d).flat()) assert.ok(Number.isFinite(item.x + item.y + item.z + item.ry));
  }
});
