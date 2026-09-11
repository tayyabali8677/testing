import { suite, test, assert, equal, close, finite } from "./harness.js";
import {
  clamp, lerp, damp, wrapAngle, angleDelta, dampAngle,
  forwardX, forwardZ, rightX, rightZ, headingTo,
  makeRng, Box2, SpatialHash, Pool, TAU,
} from "../src/mathx.js";

suite("mathx", () => {
  test("clamp and lerp", () => {
    equal(clamp(5, 0, 1), 1);
    equal(clamp(-5, 0, 1), 0);
    equal(clamp(0.5, 0, 1), 0.5);
    equal(lerp(0, 10, 0.25), 2.5);
  });

  test("wrapAngle terminates on extreme input", () => {
    // The 2D build hung here: a subtraction loop never returns for a huge
    // angle. The modulo form must stay bounded for anything finite.
    for (const a of [0, 1, -1, 1e3, -1e3, 1e12, -1e12, TAU * 1e6]) {
      const w = wrapAngle(a);
      finite(w, `wrapAngle(${a})`);
      assert(w >= -Math.PI - 1e-9 && w <= Math.PI + 1e-9,
        `wrapAngle(${a}) = ${w} is out of range`);
    }
    assert(Number.isNaN(wrapAngle(Infinity)), "infinity should give NaN, not hang");
  });

  test("angleDelta takes the short way round", () => {
    close(angleDelta(0.1, -0.1), -0.2, 1e-9);
    close(angleDelta(Math.PI - 0.1, -Math.PI + 0.1), 0.2, 1e-9);
    close(angleDelta(-Math.PI + 0.1, Math.PI - 0.1), -0.2, 1e-9);
  });

  test("dampAngle converges across the wrap seam", () => {
    let a = Math.PI - 0.05;
    const target = -Math.PI + 0.05;
    for (let i = 0; i < 200; i++) a = dampAngle(a, target, 10, 1 / 60);
    close(Math.abs(angleDelta(a, target)), 0, 1e-3, "did not converge");
  });

  test("damp is stable at any timestep", () => {
    for (const dt of [1 / 240, 1 / 60, 1 / 10, 0.5, 2]) {
      let v = 0;
      for (let i = 0; i < 100; i++) v = damp(v, 10, 6, dt);
      finite(v, `damp at dt=${dt}`);
      assert(v <= 10.0001 && v >= 0, `damp overshot to ${v} at dt=${dt}`);
    }
  });

  test("heading basis is orthonormal and matches -Z forward", () => {
    // Heading 0 must point along -Z, which is where Blender's +Y ended up.
    close(forwardX(0), 0, 1e-9);
    close(forwardZ(0), -1, 1e-9);
    for (const h of [0, 0.7, -2.2, 3.0]) {
      const fx = forwardX(h), fz = forwardZ(h);
      const rx = rightX(h), rz = rightZ(h);
      close(Math.hypot(fx, fz), 1, 1e-9, "forward not unit");
      close(Math.hypot(rx, rz), 1, 1e-9, "right not unit");
      close(fx * rx + fz * rz, 0, 1e-9, "basis not orthogonal");
    }
  });

  test("headingTo agrees with the forward basis", () => {
    for (const [dx, dz] of [[0, -1], [1, 0], [0, 1], [-1, 0], [3, -4]]) {
      const h = headingTo(0, 0, dx, dz);
      const len = Math.hypot(dx, dz);
      close(forwardX(h), dx / len, 1e-9, "x mismatch");
      close(forwardZ(h), dz / len, 1e-9, "z mismatch");
    }
  });

  test("rng is deterministic and bounded", () => {
    const a = makeRng(42), b = makeRng(42);
    for (let i = 0; i < 1000; i++) {
      const va = a.next();
      equal(va, b.next());
      assert(va >= 0 && va < 1, `value ${va} out of range`);
    }
    const r = makeRng(7);
    for (let i = 0; i < 500; i++) {
      const n = r.int(3, 9);
      assert(n >= 3 && n <= 9 && Number.isInteger(n), `int gave ${n}`);
    }
  });

  test("Box2 circle overlap and closest point", () => {
    const b = new Box2(10, 20, 2, 3);
    assert(b.containsPoint(10, 20));
    assert(!b.containsPoint(13, 20));
    assert(b.overlapsCircle(12.5, 20, 1));
    assert(!b.overlapsCircle(14, 20, 1));
    const c = b.closest(100, 20);
    equal(c.x, 12);
    equal(c.z, 20);
  });

  test("SpatialHash returns every overlapping box exactly once", () => {
    const hash = new SpatialHash(10);
    const boxes = [];
    for (let i = 0; i < 60; i++) {
      const b = new Box2(i * 7 % 200, (i * 13) % 200, 3, 3);
      boxes.push(b);
      hash.insert(b);
    }
    const hits = hash.query(50, 50, 25);
    equal(new Set(hits).size, hits.length, "duplicates returned");
    // Anything genuinely close must be present.
    for (const b of boxes) {
      if (Math.hypot(b.x - 50, b.z - 50) < 12) {
        assert(hits.includes(b), `missed a box at ${b.x},${b.z}`);
      }
    }
  });

  test("Pool cycles without growing", () => {
    const p = new Pool(4, (i) => ({ id: i }));
    const seen = new Set();
    for (let i = 0; i < 16; i++) seen.add(p.acquire().id);
    equal(seen.size, 4);
    equal(p.items.length, 4);
  });
});
