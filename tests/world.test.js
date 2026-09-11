import { suite, test, assert, equal, close, finite } from "./harness.js";
import { MockAssets } from "./mock-assets.js";
import * as THREE from "three";

import { City } from "../src/city.js";
import { Character, State } from "../src/character.js";
import { Population, TrafficDriver } from "../src/ai.js";
import { Police, CRIME } from "../src/police.js";
import { Missions } from "../src/mission.js";
import { Combat, Loadout } from "../src/weapons.js";

const DT = 1 / 60;

function makeWorld(seed = 11) {
  const assets = new MockAssets();
  const city = new City(assets, { size: 9, seed });
  city.generate();
  const scene = new THREE.Scene();
  return { assets, city, scene };
}

suite("traffic AI", () => {
  const { assets, city, scene } = makeWorld(2024);
  const pop = new Population(assets, city, scene,
    { vehicles: 14, pedestrians: 16, seed: 5 });
  const start = city.randomRoadPoint();
  pop.populate(start);

  const player = new Character(assets, city, "char_player", {});
  player.setPosition(start.x, start.z, 0);

  test("populates to the requested counts", () => {
    equal(pop.vehicles.length, 14);
    equal(pop.pedestrians.length, 16);
    equal(pop.drivers.length, 14);
  });

  test("traffic keeps to the right-hand lane", () => {
    // The lane point must sit to the right of the centreline of travel.
    for (const d of pop.drivers) {
      const t = d.targetPoint();
      const dx = d.to.x - d.from.x, dz = d.to.z - d.from.z;
      const len = Math.hypot(dx, dz) || 1;
      const ux = dx / len, uz = dz / len;
      // Offset from the junction, projected onto the right vector (-uz, ux).
      const ox = t.x - d.to.x, oz = t.z - d.to.z;
      const right = ox * -uz + oz * ux;
      assert(right > 0.5, `lane offset is ${right.toFixed(2)}, expected right`);
    }
  });

  test("runs for a long stretch without breaking", () => {
    for (let i = 0; i < 5400; i++) {
      pop.update(DT, { player, center: player, time: i * DT });
    }
    for (const v of pop.vehicles) {
      finite(v.x, "vehicle x"); finite(v.z, "vehicle z");
      finite(v.heading, "vehicle heading"); finite(v.speed, "vehicle speed");
      assert(city.inBounds(v.x, v.z),
        `traffic escaped at ${v.x.toFixed(1)},${v.z.toFixed(1)}`);
    }
    for (const p of pop.pedestrians) {
      finite(p.x, "ped x"); finite(p.z, "ped z");
      assert(city.inBounds(p.x, p.z), "pedestrian escaped the map");
    }
  });

  test("population counts never drift", () => {
    equal(pop.vehicles.length, 14);
    equal(pop.pedestrians.length, 16);
    equal(pop.drivers.length, 14);
    equal(pop.brains.length, 16);
  });

  test("traffic actually goes somewhere", () => {
    const before = pop.vehicles.map((v) => ({ x: v.x, z: v.z }));
    for (let i = 0; i < 600; i++) {
      pop.update(DT, { player, center: player, time: i * DT });
    }
    let moved = 0;
    pop.vehicles.forEach((v, i) => {
      if (Math.hypot(v.x - before[i].x, v.z - before[i].z) > 8) moved++;
    });
    assert(moved > pop.vehicles.length * 0.6,
      `only ${moved}/${pop.vehicles.length} cars made progress`);
  });

  test("recycling keeps entities near the player", () => {
    // Teleport the player far away; the pools should migrate to them.
    const far = city.randomRoadPoint(player, 400);
    player.setPosition(far.x, far.z, 0);
    for (let i = 0; i < 1200; i++) {
      pop.update(DT, { player, center: player, time: i * DT });
    }
    const near = pop.vehicles.filter(
      (v) => Math.hypot(v.x - player.x, v.z - player.z) < pop.despawnRange
    ).length;
    assert(near > pop.vehicles.length * 0.5,
      `only ${near}/${pop.vehicles.length} cars followed the player`);
  });

  test("gunfire scares nearby pedestrians", () => {
    const ped = pop.pedestrians[0];
    pop.alarm(ped.x, ped.z, 30, player);
    const brain = pop.brains[0];
    assert(brain.panic > 0, "pedestrian ignored the alarm");
  });
});

suite("police", () => {
  const { assets, city, scene } = makeWorld(777);
  const combat = new Combat(city, null);
  let busted = 0;
  const police = new Police(assets, city, scene, combat, {
    onBusted: () => busted++,
    seed: 3,
  });

  const start = city.randomRoadPoint();
  const player = new Character(assets, city, "char_player", {});
  player.setPosition(start.x, start.z, 0);

  const world = () => ({
    player, time: 0, pedestrians: [], vehicles: [],
  });

  test("starts with no heat and no units", () => {
    equal(police.stars, 0);
    equal(police.cars.length, 0);
    equal(police.foot.length, 0);
  });

  test("heat raises the star level", () => {
    police.addHeat(CRIME.pedestrianKilled);
    assert(police.stars >= 1, "a killing did not raise a star");
    police.addHeat(CRIME.copKilled * 3);
    assert(police.stars >= 3, `expected 3+ stars, got ${police.stars}`);
  });

  test("units spawn to match the star level", () => {
    for (let i = 0; i < 120; i++) police.update(DT, world());
    assert(police.cars.length > 0, "no patrol cars responded");
    assert(police.cars.length <= police.config.cars,
      "spawned more cars than the star level allows");
  });

  test("heat does not decay while the player is in sight", () => {
    const before = police.heat;
    // A unit sits right on top of the player, so they are plainly seen.
    if (police.cars.length) police.cars[0].vehicle.setPosition(player.x, player.z, 0);
    for (let i = 0; i < 600; i++) police.update(DT, world());
    assert(police.heat >= before - 1,
      `heat fell from ${before} to ${police.heat} while in plain sight`);
  });

  test("heat decays once the player is long gone", () => {
    // Move every unit to the far corner so nobody can see the player.
    for (const unit of police.cars) {
      unit.vehicle.setPosition(city.extent - 5, city.extent - 5, 0);
    }
    for (const unit of police.foot) {
      unit.character.setPosition(city.extent - 5, city.extent - 5, 0);
    }
    player.setPosition(5, 5, 0);
    police.maxCars = 0;
    police.maxFoot = 0;

    const before = police.heat;
    for (let i = 0; i < 3600; i++) police.update(DT, world());
    assert(police.heat < before, `heat stayed at ${police.heat}`);
  });

  test("clearing removes every unit", () => {
    police.maxCars = 6; police.maxFoot = 6;
    police.addHeat(600);
    for (let i = 0; i < 120; i++) police.update(DT, world());
    police.clear();
    equal(police.stars, 0);
    equal(police.cars.length, 0);
    equal(police.foot.length, 0);
    equal(police.heat, 0);
  });

  test("stars never exceed five", () => {
    police.addHeat(100000);
    assert(police.stars <= 5, `star level reached ${police.stars}`);
    police.clear();
  });

  test("a long pursuit stays stable", () => {
    police.addHeat(400);
    for (let i = 0; i < 4000; i++) {
      police.update(DT, world());
      player.update(DT, { moveX: Math.sin(i / 90), moveZ: Math.cos(i / 70), run: true });
    }
    for (const unit of police.cars) {
      finite(unit.vehicle.x, "cop car x");
      assert(city.inBounds(unit.vehicle.x, unit.vehicle.z),
        "a cop car left the map");
    }
    for (const unit of police.foot) {
      finite(unit.character.x, "cop x");
    }
    police.clear();
  });
});

suite("missions", () => {
  const { assets, city, scene } = makeWorld(31);
  const events = [];
  const missions = new Missions(assets, city, scene, {
    seed: 12, pickups: 20,
    onEvent: (type, data) => events.push({ type, data }),
  });

  const player = new Character(assets, city, "char_player", {});
  const loadout = new Loadout(["wpn_pistol"]);

  test("starts with a reachable objective", () => {
    const obj = missions.objective({ x: 0, z: 0 });
    finite(obj.distance);
    assert(city.isRoad(obj.x, obj.z), "objective is not on a road");
    assert(missions.timeLeft > 0, "no time allowance set");
  });

  test("reaching the marker pays out and moves it", () => {
    const first = { x: missions.markerPos.x, z: missions.markerPos.z };
    player.setPosition(first.x, first.z, 0);
    missions.update(DT, player, loadout);

    const paid = events.find((e) => e.type === "delivery");
    assert(paid, "no delivery event fired");
    assert(missions.cash > 0, "no money paid");
    assert(dist(missions.markerPos, first) > 50, "marker did not move on");
  });

  test("a streak increases the payout", () => {
    const payouts = [];
    for (let i = 0; i < 4; i++) {
      player.setPosition(missions.markerPos.x, missions.markerPos.z, 0);
      const before = missions.cash;
      missions.update(DT, player, loadout);
      payouts.push(missions.cash - before);
    }
    assert(payouts[payouts.length - 1] > payouts[0],
      `payouts did not grow with the streak: ${payouts.join(", ")}`);
  });

  test("running out of time breaks the streak", () => {
    missions.streak = 5;
    missions.timeLeft = 0.01;
    missions.update(1.0, player, loadout);
    equal(missions.streak, 0, "streak survived a timeout");
  });

  test("pickups apply and then go on cooldown", () => {
    const health = missions.pickups.find((p) => p.type.kind === "health");
    assert(health, "no health pickup was placed");
    player.setPosition(health.x, health.z, 0);
    player.hp = 40;

    missions.update(DT, player, loadout);
    assert(player.hp > 40, "health pickup did nothing");
    equal(health.root.visible, false, "pickup stayed visible");
    assert(health.cooldown > 0, "pickup did not go on cooldown");

    const hp = player.hp;
    missions.update(DT, player, loadout);
    equal(player.hp, hp, "collected the same pickup twice");
  });

  test("cash cannot go negative", () => {
    missions.cash = 100;
    missions.spend(500);
    equal(missions.cash, 0);
  });
});

function dist(a, b) {
  return Math.hypot(a.x - b.x, a.z - b.z);
}
