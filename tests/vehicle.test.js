import { suite, test, assert, equal, close, finite } from "./harness.js";
import { MockAssets } from "./mock-assets.js";
import { City } from "../src/city.js";
import { Vehicle } from "../src/vehicle.js";
import { makeRng, forwardX, forwardZ } from "../src/mathx.js";

const DT = 1 / 60;

function drive(v, controls, seconds) {
  const steps = Math.round(seconds / DT);
  for (let i = 0; i < steps; i++) v.update(DT, controls);
  return v;
}

suite("vehicle physics", () => {
  const assets = new MockAssets();
  const city = new City(assets, { size: 8, seed: 7 });
  city.generate();

  const spawn = () => {
    const p = city.randomRoadPoint();
    const v = new Vehicle(assets, city, "veh_sedan", {});
    v.setPosition(p.x, p.z, 0);
    return v;
  };

  test("accelerates from rest and moves along its heading", () => {
    const v = new Vehicle(assets, null, "veh_sedan", {});
    v.setPosition(0, 0, 0);
    drive(v, { throttle: 1 }, 3);
    assert(v.speed > 8, `only reached ${v.speed.toFixed(1)} m/s`);
    // Heading 0 means forward is -Z.
    assert(v.z < -5, `expected travel along -Z, got z=${v.z.toFixed(1)}`);
    close(v.x, 0, 1e-6, "drifted sideways with no steering");
  });

  test("never exceeds its class top speed", () => {
    const v = new Vehicle(assets, null, "veh_sports", {});
    v.setPosition(0, 0, 0);
    drive(v, { throttle: 1 }, 60);
    assert(v.speed <= v.spec.topSpeed + 0.5,
      `${v.speed.toFixed(1)} m/s exceeds top speed ${v.spec.topSpeed}`);
    assert(v.speed > v.spec.topSpeed * 0.85, "never got near top speed");
  });

  test("braking stops the car, then reverses", () => {
    const v = new Vehicle(assets, null, "veh_sedan", {});
    v.setPosition(0, 0, 0);
    drive(v, { throttle: 1 }, 4);
    assert(v.speed > 5);
    drive(v, { throttle: -1 }, 3);
    assert(v.speed < 0, `expected reverse, got ${v.speed.toFixed(2)}`);
    assert(v.speed > -v.spec.topSpeed * 0.5, "reverse is too fast");
  });

  test("coasts to a complete stop", () => {
    const v = new Vehicle(assets, null, "veh_sedan", {});
    v.setPosition(0, 0, 0);
    drive(v, { throttle: 1 }, 3);
    drive(v, { throttle: 0 }, 40);
    equal(v.speed, 0, "car never fully stopped");
  });

  test("steering does nothing at a standstill", () => {
    const v = new Vehicle(assets, null, "veh_sedan", {});
    v.setPosition(0, 0, 0);
    const h0 = v.heading;
    drive(v, { throttle: 0, steer: 1 }, 2);
    close(v.heading, h0, 1e-9, "car turned on the spot");
  });

  test("steering turns the car while moving", () => {
    const v = new Vehicle(assets, null, "veh_sedan", {});
    v.setPosition(0, 0, 0);
    drive(v, { throttle: 1 }, 3);
    const h0 = v.heading;
    drive(v, { throttle: 1, steer: 1 }, 2);
    assert(Math.abs(v.heading - h0) > 0.3,
      `heading barely changed: ${(v.heading - h0).toFixed(3)}`);
  });

  test("handbrake breaks traction and produces slip", () => {
    const a = new Vehicle(assets, null, "veh_sedan", {});
    a.setPosition(0, 0, 0);
    drive(a, { throttle: 1 }, 4);
    drive(a, { throttle: 1, steer: 1, handbrake: true }, 0.8);
    const slipping = a.slip;

    const b = new Vehicle(assets, null, "veh_sedan", {});
    b.setPosition(0, 0, 0);
    drive(b, { throttle: 1 }, 4);
    drive(b, { throttle: 1, steer: 1 }, 0.8);

    assert(slipping > b.slip,
      `handbrake slip ${slipping.toFixed(3)} should exceed grip slip ${b.slip.toFixed(3)}`);
  });

  test("survives random input without going non-finite", () => {
    const r = makeRng(31337);
    const v = spawn();
    for (let i = 0; i < 12000; i++) {
      v.update(DT, {
        throttle: r.range(-1, 1),
        steer: r.range(-1, 1),
        handbrake: r.chance(0.06),
      });
    }
    finite(v.x, "x"); finite(v.z, "z"); finite(v.y, "y");
    finite(v.speed, "speed"); finite(v.heading, "heading");
    finite(v.vx, "vx"); finite(v.vz, "vz");
    assert(Math.abs(v.heading) <= Math.PI + 1e-6, "heading left its range");
  });

  test("cannot be driven out of the world", () => {
    const r = makeRng(99);
    const v = spawn();
    for (let i = 0; i < 20000; i++) {
      v.update(DT, { throttle: 1, steer: r.chance(0.02) ? r.range(-1, 1) : 0 });
      assert(city.inBounds(v.x, v.z),
        `escaped the map at ${v.x.toFixed(1)},${v.z.toFixed(1)}`);
    }
  });

  test("does not tunnel through buildings at speed", () => {
    // Aim a fast car straight at a building and check it never ends a frame
    // inside the footprint.
    const target = city.colliders[4];
    const v = new Vehicle(assets, city, "veh_sports", {});
    const startX = target.x;
    const startZ = target.z + target.hd + 40;
    v.setPosition(startX, startZ, 0);   // heading 0 => travelling -Z
    for (let i = 0; i < 900; i++) {
      v.update(DT, { throttle: 1 });
      assert(!target.containsPoint(v.x, v.z, -0.05),
        `inside the building at step ${i}`);
    }
  });

  test("takes damage from a hard impact", () => {
    const target = city.colliders[8];
    const v = new Vehicle(assets, city, "veh_muscle", {});
    v.setPosition(target.x, target.z + target.hd + 35, 0);
    drive(v, { throttle: 1 }, 6);
    assert(v.hp < 100, "hitting a wall at speed did no damage");
  });

  test("two vehicles separate instead of overlapping", () => {
    const a = new Vehicle(assets, null, "veh_sedan", {});
    const b = new Vehicle(assets, null, "veh_sedan", {});
    a.setPosition(0, 0, 0);
    b.setPosition(0.4, 0.4, 0);
    Vehicle.collidePair(a, b);
    const d = Math.hypot(a.x - b.x, a.z - b.z);
    assert(d > 0.5, `still overlapping, separation only ${d.toFixed(2)}`);
    finite(a.x); finite(b.x);
  });

  test("heavier vehicle moves less in a collision", () => {
    const car = new Vehicle(assets, null, "veh_sports", {});
    const truck = new Vehicle(assets, null, "veh_truck", {});
    car.setPosition(0, 0, 0);
    truck.setPosition(1.0, 0, 0);
    const cx = car.x, tx = truck.x;
    Vehicle.collidePair(car, truck);
    assert(Math.abs(car.x - cx) > Math.abs(truck.x - tx),
      "the truck was shoved further than the sports car");
  });

  test("wheels spin in proportion to speed", () => {
    const v = new Vehicle(assets, null, "veh_sedan", {});
    v.setPosition(0, 0, 0);
    drive(v, { throttle: 1 }, 2);
    const before = v.wheelSpin;
    drive(v, { throttle: 1 }, 1);
    const delta = v.wheelSpin - before;
    // One second at v m/s should advance roughly v / r radians.
    close(delta, v.speed / v.wheelRadius, Math.abs(v.speed / v.wheelRadius) * 0.4,
      "wheel spin does not match road speed");
  });
});
