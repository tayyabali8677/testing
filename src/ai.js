// Traffic and pedestrian behaviour.
//
// Traffic follows the city's road graph, keeping to the right-hand lane and
// braking for whatever is in front of it. Pedestrians wander the pavements and
// scatter from gunfire and speeding cars.
//
// Both populations are pooled and recycled: an entity that falls far behind
// the player is teleported to a fresh spot ahead rather than destroyed, so the
// world stays busy at a fixed cost.

import { clamp, dist2D, distSq2D, headingTo, angleDelta, makeRng } from "./mathx.js";
import { Character, State } from "./character.js";
import { Vehicle } from "./vehicle.js";

const LANE_FRACTION = 0.25;      // of road width, right of centre
const NODE_ARRIVE = 7.0;
// City traffic runs at a town speed, not a track speed. Left at a fraction of
// each car's top speed, traffic arrives at 60 m junctions far too fast to
// turn and simply drives into the buildings.
const CITY_SPEED = 13.5;         // m/s, about 50 km/h
const CORNER_SPEED = 6.5;        // m/s through a junction

/** Steers one AI vehicle along the road graph. */
export class TrafficDriver {
  constructor(vehicle, city, rng) {
    this.v = vehicle;
    this.city = city;
    this.rng = rng;
    this.from = null;
    this.to = null;
    this.stuck = 0;
    this.panic = 0;
    this.aggression = rng.range(0.75, 1.05);
    this.pickRoute(true);
  }

  pickRoute(fresh = false) {
    const nodes = this.city.roadNodes;
    if (fresh) {
      // Start from whichever junction is nearest the car's current position.
      let best = nodes[0], bestD = Infinity;
      for (const n of nodes) {
        const d = distSq2D(n.x, n.z, this.v.x, this.v.z);
        if (d < bestD) { bestD = d; best = n; }
      }
      this.from = best;
      this.to = nodes[this.rng.pick(best.links)];
      this._alignToRoute();
      return;
    }

    const options = this.to.links.filter((i) => i !== this.from.index);
    this.from = this.to;
    this.to = nodes[options.length ? this.rng.pick(options)
                                  : this.rng.pick(this.to.links)];
  }

  /** Face the car down its route. A car dropped in facing a wall never
   *  recovers gracefully; it just grinds along the building. */
  _alignToRoute() {
    const t = this.targetPoint();
    this.v.heading = headingTo(this.v.x, this.v.z, t.x, t.z);
  }

  /**
   * Pure pursuit along the right-hand lane line.
   *
   * Aiming straight at the next junction makes cars cut the corner and mount
   * the pavement. Instead, project the car onto the lane line of the segment
   * it is on and aim at a point a little further along that line, so it
   * tracks the lane and only turns once it actually reaches the junction.
   */
  targetPoint() {
    const ax = this.from.x, az = this.from.z;
    const dx = this.to.x - ax, dz = this.to.z - az;
    const len = Math.hypot(dx, dz) || 1;
    const ux = dx / len, uz = dz / len;

    // Right of travel is (-uz, ux) in this coordinate convention.
    const lane = this.city.roadW * LANE_FRACTION;
    const ox = ax - uz * lane, oz = az + ux * lane;

    const along = (this.v.x - ox) * ux + (this.v.z - oz) * uz;
    const look = clamp(5 + Math.abs(this.v.speed) * 0.6, 6, 16);
    const s = clamp(along + look, 0, len);

    return {
      x: ox + ux * s,
      z: oz + uz * s,
      along,
      length: len,
      remaining: len - along,
    };
  }

  update(dt, world) {
    const v = this.v;
    if (!v.alive) return;

    const target = this.targetPoint();
    if (target.remaining < NODE_ARRIVE) this.pickRoute();

    const want = headingTo(v.x, v.z, target.x, target.z);
    const err = angleDelta(v.heading, want);
    const steer = clamp(err * 1.8, -1, 1);

    const blocked = this._obstacleAhead(world);

    // Approach speed: town pace on the straight, slower into a junction.
    const base = Math.min(v.spec.topSpeed * 0.6, CITY_SPEED) * this.aggression;
    const nearJunction = clamp(target.remaining / 26, 0, 1);
    const straightness = clamp(1 - Math.abs(err) / 0.9, 0, 1);
    let cruise = CORNER_SPEED + (base - CORNER_SPEED) *
                 Math.min(nearJunction, straightness);
    if (this.panic > 0) cruise *= 1.35;

    let throttle;
    if (blocked > 0) {
      throttle = blocked > 0.7 ? -1 : -0.35;
    } else if (Math.abs(v.speed) < cruise) {
      throttle = 1;
    } else if (Math.abs(v.speed) > cruise * 1.2) {
      throttle = -0.5;
    } else {
      throttle = 0;
    }

    // Shunt out of a wall if the car has wedged itself.
    if (Math.abs(v.speed) < 0.6 && blocked <= 0) {
      this.stuck += dt;
      if (this.stuck > 1.6) {
        throttle = -1;
        if (this.stuck > 3.2) {
          this.stuck = 0;
          const p = this.city.randomRoadPoint({ x: v.x, z: v.z }, 60);
          v.setPosition(p.x, p.z, this.rng.range(-Math.PI, Math.PI));
          this.pickRoute(true);
        }
      }
    } else {
      this.stuck = 0;
    }

    if (this.panic > 0) this.panic -= dt;

    v.update(dt, { throttle, steer, handbrake: false });
  }

  /** 0 = clear, 1 = something directly ahead and close. */
  _obstacleAhead(world) {
    const v = this.v;
    const f = v.forward, r = v.right;
    const look = clamp(4 + Math.abs(v.speed) * 0.9, 5, 26);
    let worst = 0;

    const consider = (x, z, halfWidth) => {
      const dx = x - v.x, dz = z - v.z;
      const ahead = dx * f.x + dz * f.z;
      if (ahead <= 0.5 || ahead > look) return;
      const side = Math.abs(dx * r.x + dz * r.z);
      if (side > v.halfWidth + halfWidth) return;
      worst = Math.max(worst, 1 - ahead / look);
    };

    for (const other of world.vehicles) {
      if (other === v) continue;
      consider(other.x, other.z, other.halfWidth);
    }
    for (const ped of world.pedestrians) {
      if (!ped.alive) continue;
      consider(ped.x, ped.z, 0.5);
    }
    if (world.player && world.player.state === State.ON_FOOT && world.player.alive) {
      consider(world.player.x, world.player.z, 0.5);
    }
    return worst;
  }
}

/** Wanders a pedestrian along the pavements, and makes them flee. */
export class PedBrain {
  constructor(character, city, rng) {
    this.c = character;
    this.city = city;
    this.rng = rng;
    this.target = city.randomSidewalkPoint();
    this.panic = 0;
    this.idle = 0;
    this.speedScale = rng.range(0.8, 1.15);
  }

  scare(duration = 4) {
    this.panic = Math.max(this.panic, duration);
  }

  update(dt, world) {
    const c = this.c;
    if (!c.alive) return;

    if (this.panic > 0) this.panic -= dt;

    let mx = 0, mz = 0;
    let run = false;

    if (this.panic > 0) {
      // Run directly away from whatever caused the fright.
      const threat = world.threat || world.player;
      if (threat) {
        const dx = c.x - threat.x, dz = c.z - threat.z;
        const len = Math.hypot(dx, dz) || 1;
        mx = dx / len; mz = dz / len;
        run = true;
      }
    } else {
      const d = dist2D(c.x, c.z, this.target.x, this.target.z);
      if (d < 1.4) {
        this.idle -= dt;
        if (this.idle <= 0) {
          this.target = this.city.randomSidewalkPoint({ x: c.x, z: c.z }, 90);
          this.idle = this.rng.range(0, 2.5);
        }
      } else {
        const dx = this.target.x - c.x, dz = this.target.z - c.z;
        mx = dx / d; mz = dz / d;
      }
    }

    // Step aside from a car bearing down on them.
    for (const v of world.vehicles) {
      if (Math.abs(v.speed) < 6) continue;
      const dx = c.x - v.x, dz = c.z - v.z;
      if (dx * dx + dz * dz > 180) continue;
      const f = v.forward;
      const ahead = -dx * f.x - dz * f.z;    // car approaching
      if (ahead > -1) {
        const r = v.right;
        const side = dx * r.x + dz * r.z;
        const s = side >= 0 ? 1 : -1;
        mx += r.x * s * 1.6;
        mz += r.z * s * 1.6;
        run = true;
        this.scare(1.5);
      }
    }

    const mag = Math.hypot(mx, mz);
    if (mag > 1) { mx /= mag; mz /= mag; }

    c.update(dt, {
      moveX: mx * this.speedScale,
      moveZ: mz * this.speedScale,
      run,
    });
  }
}

/**
 * Owns the pooled traffic and pedestrian populations and keeps them near the
 * player without ever changing how many exist.
 */
export class Population {
  constructor(assets, city, scene, opts = {}) {
    this.assets = assets;
    this.city = city;
    this.scene = scene;
    this.rng = makeRng(opts.seed ?? 0xBEEF);

    this.maxVehicles = opts.vehicles ?? 26;
    this.maxPeds = opts.pedestrians ?? 34;
    this.despawnRange = opts.despawnRange ?? 240;
    this.spawnMin = opts.spawnMin ?? 70;
    this.spawnMax = opts.spawnMax ?? 190;

    this.vehicles = [];
    this.drivers = [];
    this.pedestrians = [];
    this.brains = [];

    this.vehicleKeys = assets.keysIn("vehicles")
      .filter((k) => k !== "veh_police");
    this.pedKeys = assets.keysIn("characters")
      .filter((k) => k !== "char_player" && k !== "char_cop");
    if (!this.vehicleKeys.length) this.vehicleKeys = ["veh_sedan"];
    if (!this.pedKeys.length) this.pedKeys = ["char_male"];
  }

  populate(around) {
    for (let i = 0; i < this.maxVehicles; i++) {
      const key = this.rng.pick(this.vehicleKeys);
      const v = new Vehicle(this.assets, this.city, key, {});
      const p = this.city.randomRoadPoint(around, 40);
      v.setPosition(p.x, p.z, this.rng.range(-Math.PI, Math.PI));
      if (this.scene) this.scene.add(v.root);
      this.vehicles.push(v);
      this.drivers.push(new TrafficDriver(v, this.city, this.rng));
    }

    for (let i = 0; i < this.maxPeds; i++) {
      const key = this.rng.pick(this.pedKeys);
      const c = new Character(this.assets, this.city, key, {});
      const p = this.city.randomSidewalkPoint();
      c.setPosition(p.x, p.z, this.rng.range(-Math.PI, Math.PI));
      if (this.scene) this.scene.add(c.root);
      this.pedestrians.push(c);
      this.brains.push(new PedBrain(c, this.city, this.rng));
    }
  }

  /** Fright radius around a loud event. */
  alarm(x, z, radius, threat) {
    const r2 = radius * radius;
    for (const brain of this.brains) {
      if (distSq2D(brain.c.x, brain.c.z, x, z) < r2) brain.scare(6);
    }
    for (const driver of this.drivers) {
      if (distSq2D(driver.v.x, driver.v.z, x, z) < r2) driver.panic = 5;
    }
    this.lastThreat = threat || null;
  }

  update(dt, world) {
    const ctx = { ...world, vehicles: this.vehicles,
                  pedestrians: this.pedestrians,
                  threat: world.threat || this.lastThreat || world.player };

    for (const d of this.drivers) d.update(dt, ctx);
    for (const b of this.brains) b.update(dt, ctx);

    // Vehicle-vehicle separation.
    for (let i = 0; i < this.vehicles.length; i++) {
      for (let j = i + 1; j < this.vehicles.length; j++) {
        Vehicle.collidePair(this.vehicles[i], this.vehicles[j]);
      }
    }

    const center = world.center || world.player;
    this._updateLod(center);
    this._recycle(center);
  }

  /** Detail falls off with distance: full nearby, cheap animation mid-range,
   *  hidden beyond the point where a figure is a couple of pixels tall. */
  _updateLod(center) {
    if (!center) return;
    const near = this.lodNear ?? 60;
    const mid = this.lodMid ?? 150;

    for (const c of this.pedestrians) {
      const d = dist2D(c.x, c.z, center.x, center.z);
      c.setLod(d < near ? 0 : d < mid ? 1 : 2);
    }
    for (const v of this.vehicles) {
      if (v.driver) { v.setLod(0); continue; }
      const d = dist2D(v.x, v.z, center.x, center.z);
      v.setLod(d < near ? 0 : d < mid * 1.6 ? 1 : 2);
    }
  }

  _recycle(center) {
    if (!center) return;
    const far = this.despawnRange * this.despawnRange;

    for (let i = 0; i < this.vehicles.length; i++) {
      const v = this.vehicles[i];
      if (v.driver) continue;                       // the player is in it
      if (distSq2D(v.x, v.z, center.x, center.z) < far && v.alive) continue;
      const p = this.city.randomRoadPoint(center, this.spawnMin);
      if (dist2D(p.x, p.z, center.x, center.z) > this.spawnMax) continue;
      v.hp = 100;
      v.alive = true;
      v.setPosition(p.x, p.z, this.rng.range(-Math.PI, Math.PI));
      this.drivers[i].pickRoute(true);
    }

    for (let i = 0; i < this.pedestrians.length; i++) {
      const c = this.pedestrians[i];
      if (distSq2D(c.x, c.z, center.x, center.z) < far && c.alive) continue;
      const p = this.city.randomSidewalkPoint(center, 120);
      if (dist2D(p.x, p.z, center.x, center.z) > this.spawnMax) continue;
      c.revive(p.x, p.z);
      this.brains[i].panic = 0;
      this.brains[i].target = this.city.randomSidewalkPoint({ x: p.x, z: p.z }, 60);
    }
  }

  /** Nearest driveable car to a point, for the enter-vehicle prompt. */
  nearestVehicle(x, z, maxDist = 4.5) {
    let best = null, bestD = maxDist * maxDist;
    for (const v of this.vehicles) {
      if (v.driver) continue;
      const d = distSq2D(v.x, v.z, x, z) -
                (v.halfLength * v.halfLength * 0.5);
      if (d < bestD) { bestD = d; best = v; }
    }
    return best;
  }
}
