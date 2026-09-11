import { suite, test, assert, equal, close, finite } from "./harness.js";
import { MockAssets } from "./mock-assets.js";
import { City } from "../src/city.js";
import { Character, State, RADIUS, HEIGHT } from "../src/character.js";
import { Vehicle } from "../src/vehicle.js";
import { Combat, Loadout, WEAPONS } from "../src/weapons.js";
import * as THREE from "three";

const DT = 1 / 60;

suite("city raycast", () => {
  const assets = new MockAssets();
  const city = new City(assets, { size: 8, seed: 4242 });
  city.generate();

  test("hits a building dead on", () => {
    const b = city.colliders[2];
    const from = { x: b.x, y: 1.2, z: b.z + b.hd + 30 };
    const hit = city.raycast(from.x, from.y, from.z, 0, 0, -1, 100);
    assert(hit, "no hit at all");
    equal(hit.kind, "building");
    close(hit.t, 30, 0.5, "wrong distance to the wall");
    // Facing the ray, so the normal points back along +Z.
    close(hit.nz, 1, 1e-6, "wrong normal");
  });

  test("misses when aimed over the rooftops", () => {
    const b = city.colliders[2];
    const above = (b.height || 10) + 40;
    const hit = city.raycast(b.x, above, b.z + b.hd + 30, 0, 0, -1, 100);
    assert(!hit || hit.kind !== "building",
      "shot over the roof still hit the building");
  });

  test("short buildings do not block a high shot", () => {
    // Find the shortest building and aim just over it.
    let low = city.colliders[0];
    for (const c of city.colliders) {
      if ((c.height || 0) < (low.height || 0)) low = c;
    }
    const y = (low.height || 5) + 1.5;
    const hit = city.raycast(low.x, y, low.z + low.hd + 20, 0, 0, -1, 60);
    const blockedByThis = hit && hit.kind === "building" && hit.t < 21;
    assert(!blockedByThis, "a shot above the roofline was blocked");
  });

  test("finds the ground when aimed down", () => {
    const p = city.randomRoadPoint();
    const hit = city.raycast(p.x, 6, p.z, 0, -1, 0, 20);
    assert(hit, "no ground hit");
    equal(hit.kind, "ground");
    close(hit.t, 6, 0.2, "ground distance wrong");
    close(hit.ny, 1, 1e-6);
  });

  test("returns null into empty sky", () => {
    const p = city.randomRoadPoint();
    equal(city.raycast(p.x, 2, p.z, 0, 1, 0, 50), null);
  });

  test("nearest hit wins over a farther one", () => {
    const b = city.colliders[5];
    const hit = city.raycast(b.x, 1.0, b.z + b.hd + 80, 0, 0, -1, 300);
    assert(hit, "expected a hit");
    assert(hit.t <= 80.5, `hit at ${hit.t}, expected the near wall at ~80`);
  });
});

suite("combat", () => {
  const assets = new MockAssets();
  const city = new City(assets, { size: 8, seed: 99 });
  city.generate();
  const combat = new Combat(city, null);

  const spawnChar = (x, z) => {
    const c = new Character(assets, city, "char_male", {});
    c.setPosition(x, z, 0);
    return c;
  };

  test("a clear shot hits the target", () => {
    const p = city.randomRoadPoint();
    const target = spawnChar(p.x, p.z - 10);
    const origin = new THREE.Vector3(p.x, 1.4, p.z);
    const dir = new THREE.Vector3(0, 0, -1);

    const before = target.hp;
    const lo = new Loadout(["wpn_rifle"]);
    assert(combat.fire(null, lo, origin, dir,
      { characters: [target], vehicles: [] }, 1000), "did not fire");
    assert(target.hp < before, "target took no damage");
  });

  test("a wall stops the bullet", () => {
    const b = city.colliders[6];
    // Target on the far side of a building from the shooter.
    const target = spawnChar(b.x, b.z - b.hd - 3);
    const origin = new THREE.Vector3(b.x, 1.4, b.z + b.hd + 3);
    const dir = new THREE.Vector3(0, 0, -1);

    const before = target.hp;
    const lo = new Loadout(["wpn_rifle"]);
    combat.fire(null, lo, origin, dir,
      { characters: [target], vehicles: [] }, 1000);
    equal(target.hp, before, "bullet passed through a building");
  });

  test("headshots do more damage than body shots", () => {
    const p = city.randomRoadPoint();
    const body = spawnChar(p.x, p.z - 8);
    const head = spawnChar(p.x + 40, p.z - 8);
    const lo = new Loadout(["wpn_pistol"]);

    combat.fire(null, lo, new THREE.Vector3(p.x, 1.0, p.z),
      new THREE.Vector3(0, 0, -1), { characters: [body], vehicles: [] }, 1000);
    lo.cooldown = 0;
    combat.fire(null, lo, new THREE.Vector3(p.x + 40, HEIGHT * 0.95, p.z),
      new THREE.Vector3(0, 0, -1), { characters: [head], vehicles: [] }, 1000);

    assert(head.hp < body.hp,
      `headshot left ${head.hp}, body shot left ${body.hp}`);
  });

  test("a vehicle in the way takes the round", () => {
    const p = city.randomRoadPoint();
    const car = new Vehicle(assets, city, "veh_sedan", {});
    car.setPosition(p.x, p.z - 6, 0);
    const behind = spawnChar(p.x, p.z - 12);

    const lo = new Loadout(["wpn_rifle"]);
    const hpBefore = behind.hp, carBefore = car.hp;
    combat.fire(null, lo, new THREE.Vector3(p.x, 0.9, p.z),
      new THREE.Vector3(0, 0, -1),
      { characters: [behind], vehicles: [car] }, 1000);

    assert(car.hp < carBefore, "the car took no damage");
    equal(behind.hp, hpBefore, "the round went through the car");
  });

  test("firing consumes ammunition and respects rate of fire", () => {
    const lo = new Loadout(["wpn_smg"]);
    const spec = WEAPONS.wpn_smg;
    const origin = new THREE.Vector3(0, 1.4, 0);
    const dir = new THREE.Vector3(0, 0, -1);
    const empty = { characters: [], vehicles: [] };

    assert(combat.fire(null, lo, origin, dir, empty), "first shot failed");
    equal(lo.mag, spec.magazine - 1);
    assert(!combat.fire(null, lo, origin, dir, empty),
      "fired again before the cooldown elapsed");

    lo.update(60 / spec.rpm + 1e-4);
    assert(combat.fire(null, lo, origin, dir, empty),
      "could not fire after the cooldown");
  });

  test("running dry triggers a reload that refills from reserve", () => {
    const lo = new Loadout(["wpn_pistol"]);
    const spec = WEAPONS.wpn_pistol;
    const origin = new THREE.Vector3(0, 1.4, 0);
    const dir = new THREE.Vector3(0, 0, -1);
    const empty = { characters: [], vehicles: [] };

    for (let i = 0; i < spec.magazine; i++) {
      lo.cooldown = 0;
      combat.fire(null, lo, origin, dir, empty);
    }
    equal(lo.mag, 0, "magazine should be empty");

    lo.cooldown = 0;
    combat.fire(null, lo, origin, dir, empty);   // dry fire starts a reload
    assert(lo.reloading > 0, "dry fire did not start a reload");

    for (let i = 0; i < 200; i++) lo.update(DT);
    equal(lo.mag, spec.magazine, "magazine not refilled");
    equal(lo.reserve, spec.reserve - spec.magazine, "reserve not debited");
  });

  test("reserve ammunition cannot go negative", () => {
    const lo = new Loadout(["wpn_shotgun"]);
    const spec = WEAPONS.wpn_shotgun;
    const origin = new THREE.Vector3(0, 1.4, 0);
    const dir = new THREE.Vector3(0, 0, -1);
    const empty = { characters: [], vehicles: [] };

    for (let i = 0; i < 400; i++) {
      lo.cooldown = 0;
      lo.reloading = 0;
      combat.fire(null, lo, origin, dir, empty);
      lo.startReload();
      for (let k = 0; k < 200; k++) lo.update(DT);
    }
    assert(lo.reserve >= 0, `reserve went to ${lo.reserve}`);
    assert(lo.mag >= 0, `magazine went to ${lo.mag}`);
    assert(lo.reserve <= spec.reserve, "reserve exceeded its cap");
  });

  test("weapon switching only works for owned weapons", () => {
    const lo = new Loadout(["wpn_pistol"]);
    assert(!lo.switchTo("wpn_rifle"), "switched to a weapon we do not own");
    lo.give("wpn_rifle");
    assert(lo.switchTo("wpn_rifle"), "could not switch after pickup");
    equal(lo.current, "wpn_rifle");
  });
});

suite("character controller", () => {
  const assets = new MockAssets();
  const city = new City(assets, { size: 8, seed: 5150 });
  city.generate();

  const spawn = () => {
    const p = city.randomRoadPoint();
    const c = new Character(assets, city, "char_player", {});
    c.setPosition(p.x, p.z, 0);
    return c;
  };

  test("walks in the intended direction", () => {
    const c = spawn();
    const x0 = c.x, z0 = c.z;
    for (let i = 0; i < 120; i++) {
      c.update(DT, { moveX: 1, moveZ: 0 });
    }
    assert(c.x > x0 + 1, `barely moved: ${(c.x - x0).toFixed(2)}m`);
    close(c.z, z0, 1.5, "drifted off-axis");
  });

  test("running is faster than walking", () => {
    const a = spawn(), b = spawn();
    b.setPosition(a.x, a.z, 0);
    for (let i = 0; i < 180; i++) {
      a.update(DT, { moveX: 0, moveZ: -1, run: false });
      b.update(DT, { moveX: 0, moveZ: -1, run: true });
    }
    assert(b.speed > a.speed * 1.5,
      `run ${b.speed.toFixed(2)} vs walk ${a.speed.toFixed(2)}`);
  });

  test("cannot walk through a building", () => {
    const b = city.colliders[1];
    const c = new Character(assets, city, "char_player", {});
    c.setPosition(b.x, b.z + b.hd + 4, 0);
    for (let i = 0; i < 600; i++) {
      c.update(DT, { moveX: 0, moveZ: -1, run: true });
      assert(!b.containsPoint(c.x, c.z, -0.05),
        `entered the building at step ${i}`);
    }
  });

  test("stays finite and in bounds under random intent", () => {
    const c = spawn();
    let seed = 5;
    const rnd = () => (seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff;
    for (let i = 0; i < 20000; i++) {
      c.update(DT, {
        moveX: rnd() * 2 - 1, moveZ: rnd() * 2 - 1,
        run: rnd() > 0.5, lookHeading: rnd() * 6 - 3,
      });
    }
    finite(c.x); finite(c.z); finite(c.y); finite(c.heading);
    assert(city.inBounds(c.x, c.z), "walked out of the world");
  });

  test("armour absorbs damage before health", () => {
    const c = spawn();
    c.armour = 50;
    const hp0 = c.hp;
    c.damage(30);
    assert(c.armour < 50, "armour was not used");
    assert(c.hp > hp0 - 30, "health took the full hit through armour");
    assert(c.hp < hp0, "health took nothing at all");
  });

  test("dying sets the dead state exactly once", () => {
    const c = spawn();
    c.damage(1000);
    assert(!c.alive);
    equal(c.state, State.DEAD);
    equal(c.hp, 0);
    c.damage(1000);
    equal(c.hp, 0, "kept taking damage after death");
  });

  test("enter and exit a vehicle leaves the character beside it", () => {
    const p = city.randomRoadPoint();
    const c = new Character(assets, city, "char_player", {});
    c.setPosition(p.x, p.z, 0);
    const v = new Vehicle(assets, city, "veh_sedan", {});
    v.setPosition(p.x, p.z, 0);

    assert(c.enterVehicle(v), "could not enter");
    equal(c.state, State.DRIVING);
    equal(v.driver, c);
    equal(c.root.visible, false);

    for (let i = 0; i < 60; i++) { v.update(DT, { throttle: 1 }); c.update(DT); }
    close(c.x, v.x, 1e-6, "character did not ride along");

    assert(c.exitVehicle(), "could not exit");
    equal(c.state, State.ON_FOOT);
    equal(v.driver, null);
    equal(c.root.visible, true);
    assert(!city.blocked(c.x, c.z, RADIUS), "stepped out inside geometry");
    assert(Math.hypot(c.x - v.x, c.z - v.z) < 4, "teleported away from the car");
  });
});
