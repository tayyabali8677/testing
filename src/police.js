// Wanted level and police response.
//
// Heat accumulates from crimes and decays only while the player is out of
// sight, so escaping is about breaking line of sight rather than waiting out a
// timer. Each star raises the number of pursuing units, how aggressively they
// drive, and whether they will shoot.

import * as THREE from "three";
import {
  clamp, dist2D, distSq2D, headingTo, angleDelta, makeRng,
} from "./mathx.js";
import { Vehicle } from "./vehicle.js";
import { Character, State, HEIGHT as CHAR_HEIGHT } from "./character.js";
import { Loadout } from "./weapons.js";

// Heat required to reach each star, and the response it buys.
const STARS = [
  { heat: 0, cars: 0, foot: 0, shoot: false, aggression: 0.0 },
  { heat: 20, cars: 1, foot: 0, shoot: false, aggression: 0.85 },
  { heat: 70, cars: 2, foot: 0, shoot: true, aggression: 0.92 },
  { heat: 160, cars: 3, foot: 2, shoot: true, aggression: 1.0 },
  { heat: 300, cars: 4, foot: 4, shoot: true, aggression: 1.06 },
  { heat: 520, cars: 6, foot: 6, shoot: true, aggression: 1.12 },
];

export const CRIME = {
  pedestrianKilled: 45,
  pedestrianHit: 16,
  copKilled: 130,
  copHit: 40,
  gunfire: 12,
  carStolen: 10,
  vehicleDestroyed: 30,
  reckless: 0.6,           // per second of dangerous driving
};

const SIGHT_RANGE = 105;
const DECAY_DELAY = 7.0;        // seconds out of sight before heat falls
const DECAY_RATE = 26;          // heat per second once decaying
const BUST_RANGE = 3.0;
const BUST_TIME = 1.4;

const _muzzle = new THREE.Vector3();
const _dir = new THREE.Vector3();

export class Police {
  constructor(assets, city, scene, combat, opts = {}) {
    this.assets = assets;
    this.city = city;
    this.scene = scene;
    this.combat = combat;
    this.rng = makeRng(opts.seed ?? 0x9111);

    this.heat = 0;
    this.stars = 0;
    this.unseenFor = 0;
    this.recentCrime = 0;
    this.bustProgress = 0;

    this.cars = [];        // { vehicle, driver: Character, shootTimer }
    this.foot = [];        // { character, loadout, shootTimer }

    this.onBusted = opts.onBusted || null;
    this.onStarsChanged = opts.onStarsChanged || null;
    this.maxCars = opts.maxCars ?? 6;
    this.maxFoot = opts.maxFoot ?? 6;
  }

  // ---- heat ------------------------------------------------------------

  addHeat(amount) {
    if (amount <= 0) return;
    this.heat += amount;
    // A fresh crime counts as being seen for a moment, even before any unit
    // arrives. This is tracked separately from unseenFor: folding it into the
    // sight test made the timer reset itself and heat could never decay.
    this.recentCrime = 1.0;
    this.unseenFor = 0;
    this._recomputeStars();
  }

  _recomputeStars() {
    let stars = 0;
    for (let i = STARS.length - 1; i >= 0; i--) {
      if (this.heat >= STARS[i].heat) { stars = i; break; }
    }
    if (stars !== this.stars) {
      const before = this.stars;
      this.stars = stars;
      if (this.onStarsChanged) this.onStarsChanged(stars, before);
    }
  }

  get config() { return STARS[clamp(this.stars, 0, STARS.length - 1)]; }

  clear() {
    this.heat = 0;
    this.stars = 0;
    this.unseenFor = 0;
    this.recentCrime = 0;
    this.bustProgress = 0;
    this._despawnAll();
    if (this.onStarsChanged) this.onStarsChanged(0, this.stars);
  }

  _despawnAll() {
    for (const unit of this.cars) {
      if (this.scene) this.scene.remove(unit.vehicle.root);
    }
    for (const unit of this.foot) {
      if (this.scene) this.scene.remove(unit.character.root);
    }
    this.cars.length = 0;
    this.foot.length = 0;
  }

  // ---- per-frame -------------------------------------------------------

  update(dt, world) {
    const player = world.player;
    if (!player) return;

    const target = player.state === State.DRIVING && player.vehicle
      ? player.vehicle : player;

    this.recentCrime = Math.max(0, this.recentCrime - dt);

    if (this.stars > 0) {
      const seen = this._anyoneSees(target) || this.recentCrime > 0;
      if (seen) {
        this.unseenFor = 0;
      } else {
        this.unseenFor += dt;
        if (this.unseenFor > DECAY_DELAY) {
          this.heat = Math.max(0, this.heat - DECAY_RATE * dt);
          this._recomputeStars();
        }
      }
      this._maintainUnits(target, world);
    } else if (this.cars.length || this.foot.length) {
      this._despawnAll();
    }

    this._driveCars(dt, world, target, player);
    this._moveFoot(dt, world, target, player);
    this._checkBust(dt, player);
  }

  _anyoneSees(target) {
    for (const unit of this.cars) {
      if (dist2D(unit.vehicle.x, unit.vehicle.z, target.x, target.z) < SIGHT_RANGE) {
        return true;
      }
    }
    for (const unit of this.foot) {
      if (dist2D(unit.character.x, unit.character.z, target.x, target.z) < SIGHT_RANGE) {
        return true;
      }
    }
    return false;
  }

  _maintainUnits(target, world) {
    const cfg = this.config;

    while (this.cars.length < Math.min(cfg.cars, this.maxCars)) {
      this._spawnCar(target);
    }
    while (this.cars.length > cfg.cars) {
      const unit = this.cars.pop();
      if (this.scene) this.scene.remove(unit.vehicle.root);
    }

    while (this.foot.length < Math.min(cfg.foot, this.maxFoot)) {
      this._spawnFoot(target);
    }
    while (this.foot.length > cfg.foot) {
      const unit = this.foot.pop();
      if (this.scene) this.scene.remove(unit.character.root);
    }

    // Replace wrecks and casualties.
    for (let i = this.cars.length - 1; i >= 0; i--) {
      const v = this.cars[i].vehicle;
      if (!v.alive) {
        if (this.scene) this.scene.remove(v.root);
        this.cars.splice(i, 1);
      }
    }
    for (let i = this.foot.length - 1; i >= 0; i--) {
      if (!this.foot[i].character.alive) {
        const dead = this.foot[i];
        dead.deadFor = (dead.deadFor || 0) + 1;
        if (dead.deadFor > 240) {
          if (this.scene) this.scene.remove(dead.character.root);
          this.foot.splice(i, 1);
        }
      }
    }
  }

  _spawnCar(target) {
    const p = this.city.randomRoadPoint(target, 110);
    if (dist2D(p.x, p.z, target.x, target.z) > 320) return;

    const v = new Vehicle(this.assets, this.city, "veh_police", {});
    v.setPosition(p.x, p.z, this.rng.range(-Math.PI, Math.PI));
    if (this.scene) this.scene.add(v.root);
    this.cars.push({ vehicle: v, shootTimer: this.rng.range(0.5, 1.6), stuck: 0 });
  }

  _spawnFoot(target) {
    const p = this.city.randomSidewalkPoint(target, 90);
    const c = new Character(this.assets, this.city, "char_cop", { hp: 90 });
    c.setPosition(p.x, p.z, 0);
    if (this.scene) this.scene.add(c.root);
    this.foot.push({
      character: c,
      loadout: new Loadout([this.stars >= 4 ? "wpn_rifle" : "wpn_pistol"]),
      shootTimer: this.rng.range(0.4, 1.4),
    });
  }

  _driveCars(dt, world, target, player) {
    const cfg = this.config;

    for (const unit of this.cars) {
      const v = unit.vehicle;
      if (!v.alive) continue;

      const d = dist2D(v.x, v.z, target.x, target.z);
      const want = headingTo(v.x, v.z, target.x, target.z);
      const err = angleDelta(v.heading, want);
      const steer = clamp(err * 2.0, -1, 1);

      // Close in, then hang back so they do not simply shunt the player
      // into a wall and end the chase in two seconds.
      const standoff = player.state === State.DRIVING ? 7 : 10;
      let throttle;
      if (d > standoff) {
        throttle = Math.abs(err) > 1.4 ? 0.4 : 1;
      } else {
        throttle = -0.4;
      }

      // Reverse out when wedged.
      if (Math.abs(v.speed) < 0.7 && d > standoff) {
        unit.stuck += dt;
        if (unit.stuck > 1.5) throttle = -1;
        if (unit.stuck > 4) {
          unit.stuck = 0;
          const p = this.city.randomRoadPoint(target, 90);
          v.setPosition(p.x, p.z, this.rng.range(-Math.PI, Math.PI));
        }
      } else {
        unit.stuck = 0;
      }

      v.update(dt, {
        throttle: throttle * cfg.aggression,
        steer,
        handbrake: false,
      });
      v.updateSiren(world.time || 0, true);
      v.setLights(true);

      // Shooting from the car, once the player is on foot and close.
      if (cfg.shoot && this.combat && player.alive &&
          player.state === State.ON_FOOT && d < 45) {
        unit.shootTimer -= dt;
        if (unit.shootTimer <= 0) {
          unit.shootTimer = this.rng.range(0.8, 1.8);
          this._shootAt(v.x, v.y + 1.2, v.z, player, world, 0.55);
        }
      }
    }
  }

  _moveFoot(dt, world, target, player) {
    const cfg = this.config;

    for (const unit of this.foot) {
      const c = unit.character;
      unit.loadout.update(dt);
      if (!c.alive) { c.update(dt, {}); continue; }

      const d = dist2D(c.x, c.z, target.x, target.z);
      const want = headingTo(c.x, c.z, target.x, target.z);

      // Advance to a firing distance, then hold and shoot.
      const desired = 11;
      let mx = 0, mz = 0;
      if (d > desired) {
        mx = (target.x - c.x) / d;
        mz = (target.z - c.z) / d;
      } else if (d < desired * 0.6) {
        mx = -(target.x - c.x) / d;
        mz = -(target.z - c.z) / d;
      }

      c.update(dt, {
        moveX: mx, moveZ: mz,
        run: d > desired * 1.5,
        lookHeading: want,
        aiming: d < 30,
      });

      if (cfg.shoot && this.combat && player.alive && d < 34) {
        unit.shootTimer -= dt;
        if (unit.shootTimer <= 0) {
          unit.shootTimer = this.rng.range(0.5, 1.3);
          this._shootAt(c.x, c.y + CHAR_HEIGHT * 0.72, c.z, player, world,
                        0.7, unit.loadout);
        }
      }
    }
  }

  _shootAt(ox, oy, oz, player, world, accuracy, loadout) {
    const aimY = player.state === State.DRIVING && player.vehicle
      ? player.vehicle.y + 0.8 : player.y + CHAR_HEIGHT * 0.55;

    _muzzle.set(ox, oy, oz);
    _dir.set(player.x - ox, aimY - oy, player.z - oz);
    const len = _dir.length();
    if (len < 1e-4) return;
    _dir.divideScalar(len);

    const lo = loadout || (this._carLoadout ||= new Loadout(["wpn_pistol"]));
    lo.cooldown = 0;
    if (lo.mag <= 0) {
      lo.ammo[lo.current].mag = lo.spec.magazine;   // police never run dry
    }

    this.combat.fire(
      null, lo, _muzzle, _dir,
      {
        characters: [player, ...(world.pedestrians || [])],
        vehicles: world.vehicles || [],
      },
      accuracy
    );
  }

  _checkBust(dt, player) {
    if (this.stars === 0 || !player.alive || player.state === State.DRIVING) {
      this.bustProgress = 0;
      return;
    }

    let near = false;
    for (const unit of this.foot) {
      if (!unit.character.alive) continue;
      if (dist2D(unit.character.x, unit.character.z, player.x, player.z) < BUST_RANGE) {
        near = true; break;
      }
    }
    if (!near) {
      for (const unit of this.cars) {
        if (!unit.vehicle.alive) continue;
        const v = unit.vehicle;
        if (Math.abs(v.speed) > 3) continue;
        if (dist2D(v.x, v.z, player.x, player.z) < BUST_RANGE + 1.5) {
          near = true; break;
        }
      }
    }

    if (near) {
      this.bustProgress += dt;
      if (this.bustProgress >= BUST_TIME) {
        this.bustProgress = 0;
        if (this.onBusted) this.onBusted();
        this.clear();
      }
    } else {
      this.bustProgress = Math.max(0, this.bustProgress - dt * 2);
    }
  }

  /** Every police character, so bullets can hit them. */
  get characters() {
    return this.foot.map((u) => u.character);
  }

  get vehicles() {
    return this.cars.map((u) => u.vehicle);
  }
}
