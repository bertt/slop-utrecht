const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const { join } = require('node:path');
const test = require('node:test');
const vm = require('node:vm');
const { loadModule } = require('./helpers/module.cjs');

const pedestriansSource = readFileSync(join(__dirname, '../js/pedestrians.js'), 'utf8');
const controllersSource = readFileSync(join(__dirname, '../js/controllers.js'), 'utf8');
const pedestrianSystemSource = ['traffic.js', 'pedestrian-system.js']
  .map((file) => readFileSync(join(__dirname, '../js', file), 'utf8')).join('\n');
const polygonCollision = loadModule(readFileSync(join(__dirname, '../js/building-collision.js'), 'utf8'));

// Lightweight numeric TSL & THREE harness for testing PersonCrowd, createPersonMaterial, and PersonRig without a GPU.
const shaderState = {
  attrs: {
    position: [0, 1.3, 0.08],
    normal: [0, 0, 1],
    skin: [0, 0, 0, 0],
    extra: [0, 0, 0],
    femaleDelta: [0, 0, 0],
    hairDelta: [0, 0, 0]
  },
  instanceIndex: 0,
  stage: 'fragment',
  sinCallsInFragment: 0,
  ifCallsInFragment: 0,
  vertexStageEvaluations: 0,
  varyingSnapshots: new Map()
};

const arr = (v) => (v instanceof TNode ? v.eval() : typeof v === 'number' ? [v] : v);
const broadcast = (a, b, fn) => {
  const va = arr(a), vb = arr(b);
  const n = Math.max(va.length, vb.length);
  const out = new Array(n);
  for (let i = 0; i < n; i++) out[i] = fn(va[i % va.length], vb[i % vb.length]);
  return out;
};
const smoothstepScalar = (e0, e1, x) => {
  const t = Math.max(0, Math.min(1, (x - e0) / (e1 - e0)));
  return t * t * (3 - 2 * t);
};
const hexToLinear = (hex) => {
  const srgb = [((hex >> 16) & 255) / 255, ((hex >> 8) & 255) / 255, (hex & 255) / 255];
  return srgb.map((c) => (c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4));
};

class TNode {
  constructor(fn) {
    this._fn = typeof fn === 'function' ? fn : () => fn;
  }
  eval() { return this._fn(); }
  get x() { return new TNode(() => [this.eval()[0]]); }
  get y() { return new TNode(() => [this.eval()[1]]); }
  get z() { return new TNode(() => [this.eval()[2]]); }
  get w() { return new TNode(() => [this.eval()[3]]); }
  get xyz() { return new TNode(() => this.eval().slice(0, 3)); }
  add(b) { return new TNode(() => broadcast(this, b, (x, y) => x + y)); }
  sub(b) { return new TNode(() => broadcast(this, b, (x, y) => x - y)); }
  mul(b) { return new TNode(() => broadcast(this, b, (x, y) => x * y)); }
  div(b) { return new TNode(() => broadcast(this, b, (x, y) => x / y)); }
  lessThan(b) { return new TNode(() => broadcast(this, b, (x, y) => (x < y ? 1 : 0))); }
  greaterThan(b) { return new TNode(() => broadcast(this, b, (x, y) => (x > y ? 1 : 0))); }
  toVar() {
    let slot = null;
    const variable = new TNode(() => (slot ?? this.eval()));
    variable.assign = (rhs) => { slot = arr(rhs).slice(); };
    return variable;
  }
  assign() {}
}

const wrap = (v) => (v instanceof TNode ? v : new TNode(Array.isArray(v) ? v : [v]));

const tslStub = {
  Fn: (builder) => () => new TNode(() => arr(builder())),
  If: (cond, body) => {
    if (shaderState.stage === 'fragment') shaderState.ifCallsInFragment++;
    let matched = arr(cond)[0] > 0;
    if (matched) body();
    const api = {
      ElseIf(c, b) {
        if (shaderState.stage === 'fragment') shaderState.ifCallsInFragment++;
        if (!matched && arr(c)[0] > 0) {
          matched = true;
          b();
        }
        return api;
      },
      Else(b) {
        if (!matched) {
          matched = true;
          b();
        }
        return api;
      }
    };
    return api;
  },
  float: (v) => wrap(v),
  int: (v) => new TNode(() => arr(v).map((x) => x | 0)),
  vec2: (...args) => new TNode(() => {
    const flat = args.flatMap((a) => arr(a));
    return flat.length === 1 ? [flat[0], flat[0]] : flat.slice(0, 2);
  }),
  vec3: (...args) => new TNode(() => {
    const flat = args.flatMap((a) => arr(a));
    return flat.length === 1 ? [flat[0], flat[0], flat[0]] : flat.slice(0, 3);
  }),
  vec4: (...args) => new TNode(() => {
    const flat = args.flatMap((a) => arr(a));
    return flat.length === 1 ? [flat[0], flat[0], flat[0], flat[0]] : flat.slice(0, 4);
  }),
  color: (hex) => new TNode(hexToLinear(hex)),
  attribute: (name) => new TNode(() => shaderState.attrs[name]),
  instanceIndex: new TNode(() => [shaderState.instanceIndex]),
  attributeArray: (count) => {
    const array = new Float32Array(count * 4);
    let uploads = 0;
    let lastRange = [0, 0];
    const value = {
      array,
      get uploads() { return uploads; },
      get lastRange() { return lastRange; },
      clearUpdateRanges() { lastRange = [0, 0]; },
      addUpdateRange(offset, len) { lastRange = [offset, len]; },
      set needsUpdate(v) { if (v) uploads++; }
    };
    const storage = {
      value,
      toReadOnly() { return storage; },
      element(idxNode) {
        return new TNode(() => {
          const i = (arr(idxNode)[0] | 0) * 4;
          return [array[i], array[i + 1], array[i + 2], array[i + 3]];
        });
      }
    };
    return storage;
  },
  normalLocal: new TNode([0, 0, 1]),
  varying: (node, name) => {
    const key = name || Symbol('varying');
    return new TNode(() => {
      if (shaderState.varyingSnapshots.has(key)) return shaderState.varyingSnapshots.get(key);
      const prev = shaderState.stage;
      shaderState.stage = 'vertex';
      const val = arr(node).slice();
      shaderState.stage = prev;
      shaderState.varyingSnapshots.set(key, val);
      return val;
    });
  },
  vertexStage: (node) => new TNode(() => {
    shaderState.vertexStageEvaluations++;
    const prev = shaderState.stage;
    shaderState.stage = 'vertex';
    const val = arr(node).slice();
    shaderState.stage = prev;
    return val;
  }),
  cross: (a, b) => new TNode(() => {
    const u = arr(a), v = arr(b);
    return [u[1] * v[2] - u[2] * v[1], u[2] * v[0] - u[0] * v[2], u[0] * v[1] - u[1] * v[0]];
  }),
  normalize: (a) => new TNode(() => {
    const u = arr(a);
    const len = Math.hypot(...u) || 1;
    return u.map((x) => x / len);
  }),
  sin: (a) => new TNode(() => {
    if (shaderState.stage === 'fragment') shaderState.sinCallsInFragment++;
    return arr(a).map(Math.sin);
  }),
  abs: (a) => new TNode(() => arr(a).map(Math.abs)),
  fract: (a) => new TNode(() => arr(a).map((x) => x - Math.floor(x))),
  max: (a, b) => new TNode(() => broadcast(a, b, Math.max)),
  clamp: (x, lo, hi) => new TNode(() => {
    const vx = arr(x), vlo = arr(lo), vhi = arr(hi);
    return vx.map((val, i) => Math.max(vlo[i % vlo.length], Math.min(vhi[i % vhi.length], val)));
  }),
  mix: (a, b, t) => new TNode(() => {
    const va = arr(a), vb = arr(b), vt = arr(t);
    const n = Math.max(va.length, vb.length, vt.length);
    const out = new Array(n);
    for (let i = 0; i < n; i++) {
      const k = vt[i % vt.length];
      out[i] = va[i % va.length] * (1 - k) + vb[i % vb.length] * k;
    }
    return out;
  }),
  step: (edge, x) => new TNode(() => broadcast(edge, x, (e, v) => (v < e ? 0 : 1))),
  smoothstep: (e0, e1, x) => new TNode(() => {
    const v0 = arr(e0), v1 = arr(e1), vx = arr(x);
    const n = Math.max(v0.length, v1.length, vx.length);
    const out = new Array(n);
    for (let i = 0; i < n; i++) out[i] = smoothstepScalar(v0[i % v0.length], v1[i % v1.length], vx[i % vx.length]);
    return out;
  })
};

class Vector3 {
  constructor(x = 0, y = 0, z = 0) { this.x = x; this.y = y; this.z = z; }
  set(x, y, z) { this.x = x; this.y = y; this.z = z; return this; }
  copy(v) { this.x = v.x; this.y = v.y; this.z = v.z; return this; }
  clone() { return new Vector3(this.x, this.y, this.z); }
  add(v) { this.x += v.x; this.y += v.y; this.z += v.z; return this; }
  sub(v) { this.x -= v.x; this.y -= v.y; this.z -= v.z; return this; }
  subVectors(a, b) { this.x = a.x - b.x; this.y = a.y - b.y; this.z = a.z - b.z; return this; }
  addScaledVector(v, s) { this.x += v.x * s; this.y += v.y * s; this.z += v.z * s; return this; }
  multiplyScalar(s) { this.x *= s; this.y *= s; this.z *= s; return this; }
  divideScalar(s) { return this.multiplyScalar(1 / s); }
  distanceTo(v) { return Math.hypot(this.x - v.x, this.y - v.y, this.z - v.z); }
  dot(v) { return this.x * v.x + this.y * v.y + this.z * v.z; }
  crossVectors(a, b) {
    const ax = a.x, ay = a.y, az = a.z, bx = b.x, by = b.y, bz = b.z;
    this.x = ay * bz - az * by;
    this.y = az * bx - ax * bz;
    this.z = ax * by - ay * bx;
    return this;
  }
  lengthSq() { return this.x * this.x + this.y * this.y + this.z * this.z; }
  length() { return Math.sqrt(this.lengthSq()); }
  normalize() { const l = this.length() || 1; return this.multiplyScalar(1 / l); }
  applyAxisAngle(axis, angle) {
    const q = new Quaternion().setFromAxisAngle(axis, angle);
    return this.applyQuaternion(q);
  }
  applyQuaternion(q) {
    const x = this.x, y = this.y, z = this.z;
    const qx = q.x, qy = q.y, qz = q.z, qw = q.w;
    const ix = qw * x + qy * z - qz * y;
    const iy = qw * y + qz * x - qx * z;
    const iz = qw * z + qx * y - qy * x;
    const iw = -qx * x - qy * y - qz * z;
    this.x = ix * qw + iw * -qx + iy * -qz - iz * -qy;
    this.y = iy * qw + iw * -qy + iz * -qx - ix * -qz;
    this.z = iz * qw + iw * -qz + ix * -qy - iy * -qx;
    return this;
  }
  applyMatrix4(m) {
    const e = m.elements;
    const x = this.x, y = this.y, z = this.z;
    this.x = e[0] * x + e[4] * y + e[8] * z + e[12];
    this.y = e[1] * x + e[5] * y + e[9] * z + e[13];
    this.z = e[2] * x + e[6] * y + e[10] * z + e[14];
    return this;
  }
}

class Quaternion {
  constructor(x = 0, y = 0, z = 0, w = 1) { this.x = x; this.y = y; this.z = z; this.w = w; }
  identity() { this.x = 0; this.y = 0; this.z = 0; this.w = 1; return this; }
  copy(q) { this.x = q.x; this.y = q.y; this.z = q.z; this.w = q.w; return this; }
  setFromAxisAngle(axis, angle) {
    const half = angle * 0.5, s = Math.sin(half);
    this.x = axis.x * s; this.y = axis.y * s; this.z = axis.z * s; this.w = Math.cos(half);
    return this;
  }
  setFromUnitVectors(vFrom, vTo) {
    let r = vFrom.dot(vTo) + 1;
    if (r < 1e-7) {
      if (Math.abs(vFrom.x) > Math.abs(vFrom.z)) { this.x = -vFrom.y; this.y = vFrom.x; this.z = 0; this.w = 0; }
      else { this.x = 0; this.y = -vFrom.z; this.z = vFrom.y; this.w = 0; }
    } else {
      this.x = vFrom.y * vTo.z - vFrom.z * vTo.y;
      this.y = vFrom.z * vTo.x - vFrom.x * vTo.z;
      this.z = vFrom.x * vTo.y - vFrom.y * vTo.x;
      this.w = r;
    }
    const l = Math.hypot(this.x, this.y, this.z, this.w) || 1;
    this.x /= l; this.y /= l; this.z /= l; this.w /= l;
    return this;
  }
  multiply(q) { return this.multiplyQuaternions(this, q); }
  premultiply(q) { return this.multiplyQuaternions(q, this); }
  multiplyQuaternions(a, b) {
    const qax = a.x, qay = a.y, qaz = a.z, qaw = a.w;
    const qbx = b.x, qby = b.y, qbz = b.z, qbw = b.w;
    this.x = qax * qbw + qaw * qbx + qay * qbz - qaz * qby;
    this.y = qay * qbw + qaw * qby + qaz * qbx - qax * qbz;
    this.z = qaz * qbw + qaw * qbz + qax * qby - qay * qbx;
    this.w = qaw * qbw - qax * qbx - qay * qby - qaz * qbz;
    return this;
  }
  setFromRotationMatrix(m) {
    const te = m.elements;
    const m11 = te[0], m12 = te[4], m13 = te[8];
    const m21 = te[1], m22 = te[5], m23 = te[9];
    const m31 = te[2], m32 = te[6], m33 = te[10];
    const trace = m11 + m22 + m33;
    if (trace > 0) {
      const s = 0.5 / Math.sqrt(trace + 1.0);
      this.w = 0.25 / s; this.x = (m32 - m23) * s; this.y = (m13 - m31) * s; this.z = (m21 - m12) * s;
    } else if (m11 > m22 && m11 > m33) {
      const s = 2.0 * Math.sqrt(1.0 + m11 - m22 - m33);
      this.w = (m32 - m23) / s; this.x = 0.25 * s; this.y = (m12 + m21) / s; this.z = (m13 + m31) / s;
    } else if (m22 > m33) {
      const s = 2.0 * Math.sqrt(1.0 + m22 - m11 - m33);
      this.w = (m13 - m31) / s; this.x = (m12 + m21) / s; this.y = 0.25 * s; this.z = (m23 + m32) / s;
    } else {
      const s = 2.0 * Math.sqrt(1.0 + m33 - m11 - m22);
      this.w = (m21 - m12) / s; this.x = (m13 + m31) / s; this.y = (m23 + m32) / s; this.z = 0.25 * s;
    }
    return this;
  }
}

class Matrix4 {
  constructor() { this.elements = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]; }
  makeBasis(xAxis, yAxis, zAxis) {
    this.elements = [
      xAxis.x, xAxis.y, xAxis.z, 0,
      yAxis.x, yAxis.y, yAxis.z, 0,
      zAxis.x, zAxis.y, zAxis.z, 0,
      0, 0, 0, 1
    ];
    return this;
  }
}

class BufferAttribute {
  constructor(array, itemSize) { this.array = array; this.itemSize = itemSize; this.count = array.length / itemSize; }
  getX(i) { return this.array[i * this.itemSize]; }
  getY(i) { return this.array[i * this.itemSize + 1]; }
  getZ(i) { return this.array[i * this.itemSize + 2]; }
  setXYZ(i, x, y, z) {
    const o = i * this.itemSize;
    this.array[o] = x; this.array[o + 1] = y; this.array[o + 2] = z;
    return this;
  }
}
class Float32BufferAttribute extends BufferAttribute {
  constructor(array, itemSize) { super(array instanceof Float32Array ? array : new Float32Array(array), itemSize); }
}
class BufferGeometry {
  constructor() { this.attributes = {}; this.index = null; }
  setAttribute(name, attr) { this.attributes[name] = attr; return this; }
  getAttribute(name) { return this.attributes[name]; }
  setIndex(indices) {
    this.index = indices instanceof BufferAttribute ? indices : new BufferAttribute(new Uint32Array(indices), 1);
    return this;
  }
  getIndex() { return this.index; }
  computeVertexNormals() {
    const pos = this.attributes.position;
    if (pos && !this.attributes.normal) this.attributes.normal = new Float32BufferAttribute(new Float32Array(pos.array.length), 3);
  }
  computeBoundingSphere() {
    this.boundingSphere = { center: new Vector3(), radius: 1 };
  }
}
class MeshStandardNodeMaterial {
  constructor(opts = {}) { Object.assign(this, opts); }
}
class Mesh {
  constructor(geometry, material) {
    this.geometry = geometry;
    this.material = material;
    this.visible = true;
    this.count = 1;
    this.frustumCulled = true;
    this.castShadow = false;
    this.receiveShadow = false;
    this.matrixAutoUpdate = true;
  }
}

function mergeGeometries(geos) {
  let totalVerts = 0;
  let totalIndices = 0;
  const attrNames = Object.keys(geos[0].attributes);
  for (const g of geos) {
    totalVerts += g.attributes.position.count;
    totalIndices += g.index ? g.index.count : g.attributes.position.count;
  }
  const merged = new BufferGeometry();
  for (const name of attrNames) {
    const itemSize = geos[0].attributes[name].itemSize;
    const out = new Float32Array(totalVerts * itemSize);
    let offset = 0;
    for (const g of geos) {
      out.set(g.attributes[name].array, offset);
      offset += g.attributes[name].array.length;
    }
    merged.setAttribute(name, new Float32BufferAttribute(out, itemSize));
  }
  const idx = new Uint32Array(totalIndices);
  let iOff = 0, vOff = 0;
  for (const g of geos) {
    const count = g.attributes.position.count;
    if (g.index) {
      const src = g.index.array;
      for (let i = 0; i < src.length; i++) idx[iOff++] = src[i] + vOff;
    } else {
      for (let i = 0; i < count; i++) idx[iOff++] = i + vOff;
    }
    vOff += count;
  }
  merged.setIndex(new BufferAttribute(idx, 1));
  return merged;
}

const { PersonCrowd, PersonRig, buildPersonGeometry, createPersonMaterial } = loadModule(pedestriansSource, {
  imports: {
    'three/webgpu': { Vector3, Quaternion, Matrix4, BufferAttribute, BufferGeometry, Float32BufferAttribute, MeshStandardNodeMaterial, Mesh },
    'three/tsl': tslStub,
    'three/addons/utils/BufferGeometryUtils.js': { mergeGeometries }
  }
});
const STRIDE = 31;

test('PersonCrowd creates 2 LODs only when farDistance is finite and disables shadow casting on PeopleFar', () => {
  const streetCrowd = new PersonCrowd(16, { farDistance: 34, castShadow: true });
  assert.equal(streetCrowd.lods.length, 2);
  assert.equal(streetCrowd.meshes[0].name, 'PeopleNear');
  assert.equal(streetCrowd.meshes[1].name, 'PeopleFar');
  assert.equal(streetCrowd.meshes[0].castShadow, true);
  assert.equal(streetCrowd.meshes[1].castShadow, false);
  assert.equal(streetCrowd.meshes[0].matrixAutoUpdate, false);
  assert.equal(streetCrowd.meshes[1].matrixAutoUpdate, false);

  const playerCrowd = new PersonCrowd(1, { farDistance: Infinity, castShadow: true });
  assert.equal(playerCrowd.lods.length, 1);
  assert.equal(playerCrowd.meshes[0].name, 'PeopleNear');
  assert.equal(playerCrowd.meshes[0].castShadow, true);
});

test('PersonCrowd keeps 1 warm-up instance for 2 updates, then hides empty LODs with zero uploads', () => {
  const crowd = new PersonCrowd(8, { farDistance: 34 });
  const rig = new PersonRig({ seed: 2.5 });
  rig.reset(0, 0, 0, () => 0, null);

  for (const frame of [1, 2]) {
    crowd.begin();
    crowd.end();
    assert.equal(crowd.meshes[0].visible, true, `warm-up frame ${frame} near visible`);
    assert.equal(crowd.meshes[0].count, 1);
    assert.equal(crowd.meshes[1].visible, true, `warm-up frame ${frame} far visible`);
    assert.equal(crowd.meshes[1].count, 1);
  }

  const uploadsAfterWarmup = crowd.lods[0].pose.value.uploads;
  crowd.begin();
  crowd.end();
  assert.equal(crowd.meshes[0].visible, false);
  assert.equal(crowd.meshes[0].count, 0);
  assert.equal(crowd.meshes[1].visible, false);
  assert.equal(crowd.meshes[1].count, 0);
  assert.equal(crowd.lods[0].pose.value.uploads, uploadsAfterWarmup);

  crowd.begin();
  crowd.add(rig, 12);
  crowd.end();
  assert.equal(crowd.meshes[0].visible, true);
  assert.equal(crowd.meshes[0].count, 1);
  assert.equal(crowd.meshes[1].visible, false);
  assert.equal(crowd.meshes[1].count, 0);
});

test('buildPersonGeometry assigns constant partId across every triangle so flat/interpolated part varyings never bleed', () => {
  for (const detail of [1, 0]) {
    const geo = buildPersonGeometry(detail);
    const skin = geo.getAttribute('skin').array;
    const idx = geo.getIndex().array;
    for (let i = 0; i < idx.length; i += 3) {
      const p0 = skin[idx[i] * 4 + 3];
      const p1 = skin[idx[i + 1] * 4 + 3];
      const p2 = skin[idx[i + 2] * 4 + 3];
      assert.equal(p0, p1);
      assert.equal(p1, p2);
    }
  }
});

test('createPersonMaterial hoists palette hashes to vertex stage, keeps positionNode clean, and makes PeopleFar branch-free', () => {
  const pose = tslStub.attributeArray(2 * STRIDE);
  const infoOffset = (STRIDE - 1) * 4;
  pose.value.array.set([7.3, 1.0, 1.02, 0.65], infoOffset);

  const nearMat = createPersonMaterial(pose, 1);
  const farMat = createPersonMaterial(pose, 0);

  // Evaluating positionNode (used by shadow pass) must not trigger any clothing vertexStage varyings
  shaderState.vertexStageEvaluations = 0;
  shaderState.varyingSnapshots.clear();
  nearMat.positionNode.eval();
  assert.equal(shaderState.vertexStageEvaluations, 0, 'shadow positionNode evaluates zero clothing/palette nodes');

  // PeopleNear fragment stage runs zero palette/hash sin() calls except hair strand sin() on hair parts
  for (const [partId, pos, extra] of [
    [0, [0.02, 1.35, 0.09], [0, 0, 0.5]],
    [1, [0.09, 0.6, 0.04], [0, 0, 0.4]],
    [2, [0.09, 0.02, 0.05], [0, 0, 0.3]],
    [3, [0.18, 1.1, 0.0], [0, 0, 0.95]],
    [4, [0.22, 0.85, 0.0], [0, 0, 0.5]],
    [5, [0.02, 1.62, 0.09], [0, 0, 0.5]]
  ]) {
    shaderState.attrs.skin = [0, 0, 0, partId];
    shaderState.attrs.position = pos;
    shaderState.attrs.extra = extra;
    shaderState.varyingSnapshots.clear();
    shaderState.sinCallsInFragment = 0;
    shaderState.stage = 'fragment';
    const col = nearMat.colorNode.eval();
    const rough = nearMat.roughnessNode.eval();
    assert.equal(shaderState.sinCallsInFragment, 0, `part ${partId} executes zero fragment sin() hashes`);
    assert.equal(col.length, 3);
    assert.ok(col.every((c) => Number.isFinite(c) && c >= 0 && c <= 1.5));
    assert.ok(rough[0] >= 0.35 && rough[0] <= 0.9);
  }

  // PeopleFar fragment stage runs zero If/ElseIf branches and zero fragment sin() calls across all parts
  for (const partId of [0, 1, 2, 3, 4, 5, 6, 7]) {
    shaderState.attrs.skin = [0, 0, 0, partId];
    shaderState.varyingSnapshots.clear();
    shaderState.sinCallsInFragment = 0;
    shaderState.ifCallsInFragment = 0;
    shaderState.stage = 'fragment';
    const col = farMat.colorNode.eval();
    const rough = farMat.roughnessNode.eval();
    assert.equal(shaderState.ifCallsInFragment, 0, 'PeopleFar fragment shader has zero branches');
    assert.equal(shaderState.sinCallsInFragment, 0, 'PeopleFar fragment shader has zero sin() calls');
    assert.equal(col.length, 3);
    assert.ok(col.every((c) => Number.isFinite(c) && c >= 0 && c <= 1.5));
    assert.ok(rough[0] >= 0.35 && rough[0] <= 0.9);
  }
});

test('PeopleNear hoisted varyings produce identical fragment color and roughness across triangle interiors', () => {
  const geo = buildPersonGeometry(1);
  const posArr = geo.getAttribute('position').array;
  const skinArr = geo.getAttribute('skin').array;
  const extraArr = geo.getAttribute('extra').array;
  const idxArr = geo.getIndex().array;

  const pose = tslStub.attributeArray(STRIDE);
  const nearMat = createPersonMaterial(pose, 1);
  const infoOffset = (STRIDE - 1) * 4;
  const bary = [0.23, 0.41, 0.36];

  for (const [seed, female, girth, hair] of [
    [1.1, 0, 1.0, 0.2],
    [4.2, 1, 0.96, 0.85],
    [9.7, 0, 1.06, 0.05] // tests bald male branch too
  ]) {
    pose.value.array.set([seed, female, girth, hair], infoOffset);

    // Sample triangles across the entire mesh (every 11th triangle covers all 8 body parts & transitions)
    for (let t = 0; t < idxArr.length; t += 33) {
      const i0 = idxArr[t], i1 = idxArr[t + 1], i2 = idxArr[t + 2];
      const vVar = [new Map(), new Map(), new Map()];
      const vIdx = [i0, i1, i2];

      // Evaluate vertex-stage varyings at each of the 3 triangle vertices, then interpolate with barycentric weights
      for (let k = 0; k < 3; k++) {
        const vi = vIdx[k];
        shaderState.attrs.position = [posArr[vi * 3], posArr[vi * 3 + 1], posArr[vi * 3 + 2]];
        shaderState.attrs.skin = [skinArr[vi * 4], skinArr[vi * 4 + 1], skinArr[vi * 4 + 2], skinArr[vi * 4 + 3]];
        shaderState.attrs.extra = [extraArr[vi * 3], extraArr[vi * 3 + 1], extraArr[vi * 3 + 2]];
        shaderState.varyingSnapshots = vVar[k];
        nearMat.colorNode.eval();
        nearMat.roughnessNode.eval();
      }

      const interpVaryings = new Map();
      for (const [key, val0] of vVar[0].entries()) {
        const val1 = vVar[1].get(key);
        const val2 = vVar[2].get(key);
        interpVaryings.set(key, val0.map((_, c) => val0[c] * bary[0] + val1[c] * bary[1] + val2[c] * bary[2]));
      }
      shaderState.varyingSnapshots = interpVaryings;
      const interpCol = nearMat.colorNode.eval();
      const interpRough = nearMat.roughnessNode.eval();

      // Compare against direct evaluation at the interpolated attributes (no cross-vertex varying bleed)
      shaderState.attrs.position = [0, 1, 2].map((c) =>
        posArr[i0 * 3 + c] * bary[0] + posArr[i1 * 3 + c] * bary[1] + posArr[i2 * 3 + c] * bary[2]);
      shaderState.attrs.skin = [0, 0, 0, skinArr[i0 * 4 + 3]];
      shaderState.attrs.extra = [0, 1, 2].map((c) =>
        extraArr[i0 * 3 + c] * bary[0] + extraArr[i1 * 3 + c] * bary[1] + extraArr[i2 * 3 + c] * bary[2]);
      shaderState.varyingSnapshots = new Map();
      const directCol = nearMat.colorNode.eval();
      const directRough = nearMat.roughnessNode.eval();

      for (let c = 0; c < 3; c++) {
        assert.ok(Math.abs(interpCol[c] - directCol[c]) < 1e-12, `exact color match at tri ${t / 3}`);
      }
      assert.ok(Math.abs(interpRough[0] - directRough[0]) < 1e-12, `exact roughness match at tri ${t / 3}`);
    }
  }
});

test('renderPed skips hidden rig updates beyond 50m while preserving <=50m footstep audio gait and dives', () => {
  const match = pedestrianSystemSource.match(/  function renderPed\([^]*?\n  \}/);
  assert.ok(match, 'renderPed is present');

  const runRenderPed = ({ inView, x, z, diveStart = -Infinity, clock = 10 }) => {
    let calls = 0;
    let drawn = 0;
    const ped = {
      x, z, ux: 0, uz: 1, dir: 1, dodge: 0, dodgeTarget: 0, diveStart, diveHeading: 0.5,
      rig: { placed: true, update() { calls++; } }
    };
    const renderPed = vm.runInNewContext(`(${match[0].trim()})`, {
      hasView: true,
      visible: () => inView,
      pedGround: () => 0,
      focusX: 0,
      focusZ: 0,
      clock,
      PEDESTRIAN_DIVE_DURATION: 2.5,
      Math,
      pedCrowd: { add() { drawn++; } }
    });
    renderPed(ped, 1 / 60);
    return { calls, drawn, placed: ped.rig.placed };
  };

  // Hidden within 50 m (covers 45 m footstep audio radius): gait still updates
  const nearHidden = runRenderPed({ inView: false, x: 30, z: 30 });
  assert.equal(nearHidden.calls, 1);
  assert.equal(nearHidden.drawn, 0);
  assert.equal(nearHidden.placed, true);

  // Hidden beyond 50 m and not diving: rig.update is skipped and rig is marked unplaced for clean re-entry
  const farHidden = runRenderPed({ inView: false, x: 45, z: 45 });
  assert.equal(farHidden.calls, 0);
  assert.equal(farHidden.drawn, 0);
  assert.equal(farHidden.placed, false);

  // Hidden beyond 50 m while diving: dive still completes
  const farDiving = runRenderPed({ inView: false, x: 45, z: 45, diveStart: 9.0, clock: 10.0 });
  assert.equal(farDiving.calls, 1);
  assert.equal(farDiving.drawn, 0);

  // Visible beyond 50 m: poses and draws normally
  const farVisible = runRenderPed({ inView: true, x: 80, z: 80 });
  assert.equal(farVisible.calls, 1);
  assert.equal(farVisible.drawn, 1);
});

test('poseCharacters skips stationary inactive cyclist IK/uploads and culls parked characters beyond 320m', () => {
  const noopTarget = { addEventListener() {} };
  const { ThirdPersonControllerManager } = loadModule(controllersSource, {
    globals: { window: noopTarget, document: { ...noopTarget, hidden: false } },
    imports: {
      'three/webgpu': {},
      './city-config.js': { streetZ: () => 0, isTypingInField: () => false },
      './tsl-materials.js': {},
      './cars.js': {},
      './helicopter.js': {},
      './pedestrians.js': {},
      './vehicle-lights.js': {},
      './landmarks.js': {},
      './building-collision.js': polygonCollision
    }
  });

  const makeMockCrowd = () => ({
    updates: 0,
    adds: 0,
    ends: 0,
    begin() {},
    add() { this.adds++; },
    end() { this.updates++; this.ends++; }
  });

  const controller = Object.create(ThirdPersonControllerManager.prototype);
  controller.activeMode = 'car';
  controller.getGroundHeight = () => 0.22;

  let personUpdates = 0;
  let bikeRides = 0;
  const person = {
    type: 'person',
    position: { x: -11.6, y: 0.22, z: 0 },
    heading: 0,
    mesh: { visible: true },
    rig: { placed: true, update() { personUpdates++; this.placed = true; } },
    crowd: makeMockCrowd()
  };
  const cyclist = {
    type: 'cyclist',
    position: { x: 8.15, y: 0, z: 0 },
    heading: 0,
    leanAngle: 0,
    pedalPhase: 0,
    mesh: { visible: true },
    leanPivot: {},
    bikeFrame: {},
    helmet: {
      visible: true,
      quaternion: { copy() {} },
      position: { set() { return this; }, applyQuaternion() { return this; }, add() { return this; } }
    },
    riderRig: { headQuaternion: {}, headPosition: {}, ride() { bikeRides++; } },
    riderCrowd: makeMockCrowd()
  };
  const car = { type: 'car', position: { x: 3.6, y: 0, z: 0 }, carState: { value: { x: 0, w: 0 } } };
  controller.entities = { person, cyclist, car };

  // Within 320m: person updates every frame, stationary inactive cyclist poses once then skips IK & uploads
  for (let i = 0; i < 5; i++) controller.poseCharacters(1 / 60, { x: 0, y: 2, z: 0 });
  assert.equal(personUpdates, 5);
  assert.equal(bikeRides, 1, 'stationary parked cyclist solves ride IK only once');
  assert.equal(cyclist.riderCrowd.adds, 1);

  // Move focus > 320m away (e.g. One WTC at z = 4000): warm-up finishes, then both stop updating & hide crowds
  for (let i = 0; i < 6; i++) controller.poseCharacters(1 / 60, { x: 0, y: 2, z: 4000 });
  assert.equal(person.mesh.visible, false);
  assert.equal(person.rig.placed, false);
  assert.equal(cyclist.helmet.visible, false);
  assert.equal(cyclist.mesh.visible, true, 'cyclist root stays visible so its child SpotLight stays in scene lights');

  const endsBeforeIdle = person.crowd.ends + cyclist.riderCrowd.ends;
  for (let i = 0; i < 10; i++) controller.poseCharacters(1 / 60, { x: 0, y: 2, z: 4000 });
  assert.equal(person.crowd.ends + cyclist.riderCrowd.ends, endsBeforeIdle, 'zero crowd calls while parked >320m away');
  assert.equal(personUpdates, 5);
  assert.equal(bikeRides, 1);

  // Switching mode to cyclist immediately restores visibility & poses even when camera has not caught up yet
  controller.setMode('cyclist');
  controller.poseCharacters(1 / 60, { x: 0, y: 2, z: 4000 });
  assert.equal(cyclist.helmet.visible, true);
  assert.equal(bikeRides, 2);

  // Returning within 320m restores the sidewalk pedestrian immediately
  controller.setMode('car');
  controller.poseCharacters(1 / 60, { x: 0, y: 2, z: 10 });
  assert.equal(person.mesh.visible, true);
  assert.equal(personUpdates, 6);
});
