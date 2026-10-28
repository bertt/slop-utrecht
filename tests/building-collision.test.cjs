const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const { join } = require('node:path');
const test = require('node:test');
const { loadModule } = require('./helpers/module.cjs');

const { polygonContains, polygonBoxOverlaps, polygonContact, polygonSegmentFraction } = loadModule(
  readFileSync(join(__dirname, '../js/building-collision.js'), 'utf8'));
const ring = (points) => points.map(([x, z]) => ({ x, z }));
const courtyard = {
  outer: ring([[0, 0], [12, 0], [12, 12], [0, 12]]),
  holes: [ring([[3, 3], [9, 3], [9, 9], [3, 9]])]
};
const concave = { outer: ring([[0, 0], [8, 0], [8, 3], [3, 3], [3, 8], [0, 8]]), holes: [] };
const circle = { car: false, radius: 0.5 };
const car = (angle) => ({ car: true, hx: 0.86, hz: 2.18, cos: Math.cos(angle), sin: Math.sin(angle) });

test('concavities and courtyards stay open for points, people and car-sized boxes', () => {
  for (const [polygon, x, z] of [[concave, 6, 6], [courtyard, 6, 6]]) {
    assert.equal(polygonContains(polygon, x, z), false);
    assert.equal(polygonContact(polygon, x, z, circle), false);
    assert.equal(polygonBoxOverlaps(polygon, x, z, 0.86, 2.18), false);
  }
  assert.equal(polygonContains(courtyard, 1, 6), true);
  assert.equal(polygonContains(concave, 1, 6), true);
});

test('rectangle overlap detects crossing walls, enclosing outlines and rotated corners', () => {
  assert.equal(polygonBoxOverlaps(courtyard, 6, 6, 4, 4), true);
  assert.equal(polygonBoxOverlaps(courtyard, 6, 6, 20, 20), true);
  assert.equal(polygonBoxOverlaps(concave, 5, -2, 0.86, 2.18), true);
  assert.equal(polygonBoxOverlaps(concave, 5, -2.18, 0.86, 2.18), false, 'touching is not penetration');
  assert.equal(polygonBoxOverlaps(concave, 4, 4, 0.6, 1.6, Math.SQRT1_2, Math.SQRT1_2), true);
});

test('circles resolve against actual corners and courtyard walls', () => {
  for (const [polygon, x, z] of [[concave, 3.2, 3.2], [courtyard, 3.2, 6], [courtyard, 2.8, 6], [concave, 8, 1]]) {
    const contact = {};
    assert.equal(polygonContact(polygon, x, z, circle, contact), true);
    assert.ok(Math.abs(Math.hypot(contact.nx, contact.nz) - 1) < 1e-9);
    const distance = contact.depth + 1e-6;
    assert.equal(polygonContact(polygon, x + contact.nx * distance, z + contact.nz * distance, circle), false);
  }
  assert.equal(polygonContact(concave, 8.5, 0, circle), false);
});

test('a repeated closing point produces a finite circle contact at that vertex', () => {
  const polygon = { outer: [...concave.outer, concave.outer[0]], holes: [] };
  const contact = {};
  assert.equal(polygonContact(polygon, 0, 0, circle, contact), true);
  assert.ok(Number.isFinite(contact.nx + contact.nz + contact.depth));
  assert.equal(polygonContact(polygon, contact.nx * contact.depth, contact.nz * contact.depth, circle), false);
});

test('car contacts clear the whole outline without triangle seams at any heading', () => {
  let contacts = 0;
  for (const polygon of [courtyard, concave]) {
    for (let angle = 0; angle < Math.PI; angle += Math.PI / 7) {
      const body = car(angle);
      for (let x = -2; x <= 14; x += 1.4) {
        for (let z = -2; z <= 14; z += 1.6) {
          const contact = {};
          if (!polygonContact(polygon, x, z, body, contact)) continue;
          contacts++;
          assert.ok(Number.isFinite(contact.depth) && contact.depth > 0);
          assert.equal(polygonContact(polygon, x + contact.nx * contact.depth, z + contact.nz * contact.depth, body), false,
            `contact must escape at ${x}, ${z}, heading ${angle}`);
        }
      }
    }
  }
  assert.ok(contacts > 1000);
});

test('acoustic rays measure occupied wall thickness, leaving courtyards open', () => {
  const fraction = polygonSegmentFraction(courtyard, -2, 6, 16, 0, 0, 1);
  assert.equal(fraction * 16, 6);
  assert.equal(polygonSegmentFraction(courtyard, 4, 6, 4, 0, 0, 1), 0);
  assert.equal(polygonSegmentFraction(concave, 4, 4, 3, 3, 0, 1), 0);
  assert.equal(polygonSegmentFraction(courtyard, -2, 6, 16, 0, 0, 0.25) * 16, 2);
});

test('road queries preserve the open area inside concave and courtyard bounds', () => {
  const { buildRoadNetwork } = loadModule(readFileSync(join(__dirname, '../js/road-network.js'), 'utf8'), { imports: {
    './city-config.js': {
      ALL_AVENUES: [], ALL_STREETS: [], BLOCKS: [], ISLAND_BOUNDS: { minZ: -100, maxZ: 100 },
      getIslandBoundsAtZ: () => ({ westX: -200, eastX: 200 })
    },
    './nyc-geodata.js': { GEO: {} }, './building-collision.js': { polygonBoxOverlaps }
  } });
  for (const polygon of [concave, courtyard]) {
    const network = buildRoadNetwork([], [{ minX: 0, maxX: 12, minZ: 0, maxZ: 12, polygon }]);
    assert.equal(network.walkable(5, 7, 5, 7), true);
    assert.equal(network.walkable(0.5, 1.5, 5, 7), false);
    assert.equal(network.walkable(2, 4, 5, 7), false);
  }
});

test('listeners in a courtyard hear nearby voices but remain sheltered by its walls', () => {
  const { CityAcoustics } = loadModule(readFileSync(join(__dirname, '../js/audio-acoustics.js'), 'utf8'), {
    imports: { './building-collision.js': { polygonContains, polygonSegmentFraction } }
  });
  const acoustics = new CityAcoustics({});
  acoustics.buildings = [{ minX: 0, maxX: 12, minZ: 0, maxZ: 12, maxY: 30, polygon: courtyard }];
  const listener = { x: 4, y: 1.7, z: 6 };
  assert.equal(acoustics.obstruction({ x: 8, y: 1.7, z: 6 }, listener), 0);
  assert.ok(acoustics.obstruction({ x: 15, y: 1.7, z: 6 }, listener) > 0.7);
});
