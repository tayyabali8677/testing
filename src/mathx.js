// Small maths helpers shared across the engine.
//
// Heading convention: a heading of theta means the object's local -Z (which
// is the direction Blender's +Y became on export) points along
// (-sin theta, 0, -cos theta), and the object's rotation.y is theta. Every
// system uses this, so never call lookAt on gameplay objects.

export const TAU = Math.PI * 2;

export const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);
export const lerp = (a, b, t) => a + (b - a) * t;
export const smoothstep = (t) => t * t * (3 - 2 * t);

/** Frame-rate independent exponential approach. */
export const damp = (a, b, rate, dt) => lerp(a, b, 1 - Math.exp(-rate * dt));

export function wrapAngle(a) {
  a = (a + Math.PI) % TAU;
  if (a < 0) a += TAU;
  return a - Math.PI;
}

/** Shortest signed difference from `from` to `to`. */
export const angleDelta = (from, to) => wrapAngle(to - from);

export function dampAngle(a, b, rate, dt) {
  return a + angleDelta(a, b) * (1 - Math.exp(-rate * dt));
}

export const forwardX = (h) => -Math.sin(h);
export const forwardZ = (h) => -Math.cos(h);
export const rightX = (h) => Math.cos(h);
export const rightZ = (h) => -Math.sin(h);

/** Heading that points from (x0,z0) toward (x1,z1). */
export const headingTo = (x0, z0, x1, z1) =>
  Math.atan2(-(x1 - x0), -(z1 - z0));

export const dist2D = (ax, az, bx, bz) => Math.hypot(ax - bx, az - bz);
export const distSq2D = (ax, az, bx, bz) => {
  const dx = ax - bx, dz = az - bz;
  return dx * dx + dz * dz;
};

/** Deterministic PRNG. Same seed, same city, every run. */
export function mulberry32(seed) {
  let s = seed >>> 0;
  return function () {
    s = (s + 0x6D2B79F5) | 0;
    let t = Math.imul(s ^ (s >>> 15), 1 | s);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function makeRng(seed) {
  const r = mulberry32(seed);
  return {
    next: r,
    range: (a, b) => a + r() * (b - a),
    int: (a, b) => Math.floor(a + r() * (b - a + 1)),
    pick: (arr) => arr[Math.floor(r() * arr.length)],
    chance: (p) => r() < p,
  };
}

/** Axis-aligned box in the XZ plane. y is ignored; the city is effectively 2.5D. */
export class Box2 {
  constructor(x, z, halfW, halfD) {
    this.x = x; this.z = z; this.hw = halfW; this.hd = halfD;
  }
  containsPoint(px, pz, pad = 0) {
    return Math.abs(px - this.x) <= this.hw + pad &&
           Math.abs(pz - this.z) <= this.hd + pad;
  }
  /** Closest point on the box to (px,pz), used for circle collision. */
  closest(px, pz) {
    return {
      x: clamp(px, this.x - this.hw, this.x + this.hw),
      z: clamp(pz, this.z - this.hd, this.z + this.hd),
    };
  }
  overlapsCircle(px, pz, r) {
    const c = this.closest(px, pz);
    return distSq2D(px, pz, c.x, c.z) < r * r;
  }
}

/** Uniform grid bucketing for broad-phase queries against static geometry. */
export class SpatialHash {
  constructor(cellSize = 30) {
    this.cell = cellSize;
    this.map = new Map();
  }
  _key(cx, cz) { return cx * 73856093 ^ cz * 19349663; }

  insert(box) {
    const c = this.cell;
    const x0 = Math.floor((box.x - box.hw) / c);
    const x1 = Math.floor((box.x + box.hw) / c);
    const z0 = Math.floor((box.z - box.hd) / c);
    const z1 = Math.floor((box.z + box.hd) / c);
    for (let cx = x0; cx <= x1; cx++) {
      for (let cz = z0; cz <= z1; cz++) {
        const k = this._key(cx, cz);
        let list = this.map.get(k);
        if (!list) { list = []; this.map.set(k, list); }
        list.push(box);
      }
    }
  }

  /** Every box in the cells overlapping the query circle. May repeat. */
  query(px, pz, radius, out = []) {
    out.length = 0;
    const c = this.cell;
    const x0 = Math.floor((px - radius) / c);
    const x1 = Math.floor((px + radius) / c);
    const z0 = Math.floor((pz - radius) / c);
    const z1 = Math.floor((pz + radius) / c);
    for (let cx = x0; cx <= x1; cx++) {
      for (let cz = z0; cz <= z1; cz++) {
        const list = this.map.get(this._key(cx, cz));
        if (list) {
          for (let i = 0; i < list.length; i++) {
            if (!out.includes(list[i])) out.push(list[i]);
          }
        }
      }
    }
    return out;
  }
}

/** Fixed-size ring buffer, for pooled effects. */
export class Pool {
  constructor(size, factory) {
    this.items = new Array(size);
    for (let i = 0; i < size; i++) this.items[i] = factory(i);
    this.next = 0;
  }
  acquire() {
    const item = this.items[this.next];
    this.next = (this.next + 1) % this.items.length;
    return item;
  }
  forEach(fn) { this.items.forEach(fn); }
}
