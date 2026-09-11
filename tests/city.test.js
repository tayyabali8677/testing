import { suite, test, assert, equal, close, finite } from "./harness.js";
import { MockAssets } from "./mock-assets.js";
import { City } from "../src/city.js";

suite("city generator", () => {
  const assets = new MockAssets();
  const city = new City(assets, { size: 8, seed: 1234 });
  const stats = city.generate();

  test("produces batched geometry", () => {
    assert(stats.instances > 500, `only ${stats.instances} instances`);
    assert(stats.instancedMeshes > 0, "no instanced meshes");
    // Batches are per (asset material, spatial chunk), so the count tracks
    // asset variety and map area, never the number of things placed.
    assert(stats.instancedMeshes < stats.instances / 3,
      `${stats.instancedMeshes} batches for ${stats.instances} instances`);
    assert(stats.chunks > 1, "instances were not chunked for culling");
  });

  test("road graph covers every intersection", () => {
    equal(city.roadNodes.length, 8 * 8);
    for (const n of city.roadNodes) {
      assert(n.links.length >= 2 && n.links.length <= 4,
        `node ${n.i},${n.j} has ${n.links.length} links`);
      // Links must be symmetric.
      for (const li of n.links) {
        const other = city.roadNodes[li];
        assert(other.links.includes(n.index),
          `link ${n.index}->${li} is one-way`);
      }
    }
  });

  test("intersections are road, block centres are not", () => {
    for (const n of city.roadNodes) {
      assert(city.isRoad(n.x, n.z), `node ${n.i},${n.j} is not road`);
    }
    for (const c of city.cells) {
      assert(!city.isRoad(c.x, c.z),
        `cell centre ${c.i},${c.j} reads as road`);
    }
  });

  test("ground height steps up onto blocks", () => {
    const n = city.roadNodes[10];
    equal(city.groundHeight(n.x, n.z), 0);
    const c = city.cells[5];
    close(city.groundHeight(c.x, c.z), city.curbH, 1e-9);
  });

  test("no building sits in the carriageway", () => {
    // Every collider must stay inside its own block footprint, otherwise
    // traffic would spawn inside a wall.
    const half = city.segLen / 2;
    for (const b of city.colliders) {
      const cell = city.cellAt(b.x, b.z);
      assert(cell, `collider at ${b.x},${b.z} is outside any cell`);
      const dx = Math.abs(b.x - cell.x) + b.hw;
      const dz = Math.abs(b.z - cell.z) + b.hd;
      assert(dx <= half + 0.01,
        `building overhangs its block on X by ${(dx - half).toFixed(2)}m`);
      assert(dz <= half + 0.01,
        `building overhangs its block on Z by ${(dz - half).toFixed(2)}m`);
    }
  });

  test("buildings never overlap each other", () => {
    const boxes = city.colliders;
    for (let i = 0; i < boxes.length; i++) {
      for (let j = i + 1; j < boxes.length; j++) {
        const a = boxes[i], b = boxes[j];
        const ox = (a.hw + b.hw) - Math.abs(a.x - b.x);
        const oz = (a.hd + b.hd) - Math.abs(a.z - b.z);
        assert(ox <= 0.01 || oz <= 0.01,
          `buildings overlap by ${ox.toFixed(2)} x ${oz.toFixed(2)}`);
      }
    }
  });

  test("random road points land on road and in bounds", () => {
    for (let i = 0; i < 400; i++) {
      const p = city.randomRoadPoint();
      finite(p.x, "road point x");
      finite(p.z, "road point z");
      assert(city.isRoad(p.x, p.z), `point ${p.x},${p.z} is not on road`);
      assert(city.inBounds(p.x, p.z), `point ${p.x},${p.z} is out of bounds`);
      assert(!city.blocked(p.x, p.z, 1.2),
        `spawn point ${p.x},${p.z} is inside a building`);
    }
  });

  test("randomRoadPoint honours a minimum distance", () => {
    const ref = { x: city.extent / 2, z: city.extent / 2 };
    for (let i = 0; i < 100; i++) {
      const p = city.randomRoadPoint(ref, 120);
      assert(Math.hypot(p.x - ref.x, p.z - ref.z) > 120 - 1e-6,
        "returned a point closer than the minimum");
    }
  });

  test("resolveCircle pushes a body out of a building", () => {
    const b = city.colliders[0];
    // Start dead centre inside the box, the degenerate case.
    const r = city.resolveCircle(b.x, b.z, 1.0);
    finite(r.x, "resolved x");
    finite(r.z, "resolved z");
    assert(r.hit, "expected a collision");
    assert(!b.overlapsCircle(r.x, r.z, 0.99),
      "still overlapping after resolution");
  });

  test("resolveCircle is stable when repeated", () => {
    // Running resolution twice must not keep moving a body that is already free.
    const b = city.colliders[3];
    let p = { x: b.x + b.hw + 0.4, z: b.z };
    const first = city.resolveCircle(p.x, p.z, 0.5);
    const second = city.resolveCircle(first.x, first.z, 0.5);
    close(second.x, first.x, 1e-6, "x drifted");
    close(second.z, first.z, 1e-6, "z drifted");
  });

  test("bodies cannot be pushed outside the map", () => {
    const far = city.extent + 500;
    for (const [x, z] of [[-far, 10], [far, 10], [10, -far], [10, far]]) {
      const r = city.resolveCircle(x, z, 1.0);
      assert(city.inBounds(r.x, r.z),
        `clamped position ${r.x},${r.z} is still out of bounds`);
    }
  });

  test("same seed rebuilds an identical city", () => {
    const a = new City(new MockAssets(), { size: 6, seed: 99 });
    a.generate();
    const b = new City(new MockAssets(), { size: 6, seed: 99 });
    b.generate();
    equal(a.colliders.length, b.colliders.length);
    for (let i = 0; i < a.colliders.length; i++) {
      close(a.colliders[i].x, b.colliders[i].x, 1e-9, "collider x differs");
      close(a.colliders[i].z, b.colliders[i].z, 1e-9, "collider z differs");
    }
  });

  test("different seeds build different cities", () => {
    const a = new City(new MockAssets(), { size: 6, seed: 1 });
    a.generate();
    const b = new City(new MockAssets(), { size: 6, seed: 2 });
    b.generate();
    const same = a.colliders.length === b.colliders.length &&
      a.colliders.every((c, i) => Math.abs(c.x - b.colliders[i].x) < 1e-9);
    assert(!same, "two seeds produced the same layout");
  });
});
