// Weapons, ammunition and hitscan combat.
//
// Shots are instantaneous rays rather than travelling projectiles: at pistol
// and rifle ranges a bullet crosses the map inside a single frame anyway, and
// hitscan removes a whole class of tunnelling bugs. The visible tracer is
// cosmetic and drawn along the resolved path.
//
// Resolution order per shot: find the nearest wall along the ray, then test
// only the entities closer than that wall, so nothing can be shot through a
// building.

import * as THREE from "three";
import { clamp } from "./mathx.js";
import { RADIUS as CHAR_RADIUS, HEIGHT as CHAR_HEIGHT } from "./character.js";

export const WEAPONS = {
  wpn_pistol: {
    label: "Pistol", damage: 20, rpm: 380, range: 70, spread: 0.016,
    magazine: 12, reserve: 96, reload: 1.25, pellets: 1, auto: false,
    recoil: 0.028, shake: 0.10, flash: 0.9, noise: 22,
  },
  wpn_smg: {
    label: "SMG", damage: 13, rpm: 780, range: 60, spread: 0.038,
    magazine: 30, reserve: 210, reload: 1.7, pellets: 1, auto: true,
    recoil: 0.020, shake: 0.09, flash: 1.0, noise: 26,
  },
  wpn_rifle: {
    label: "Rifle", damage: 28, rpm: 620, range: 140, spread: 0.013,
    magazine: 30, reserve: 180, reload: 2.1, pellets: 1, auto: true,
    recoil: 0.034, shake: 0.14, flash: 1.2, noise: 34,
  },
  wpn_shotgun: {
    label: "Shotgun", damage: 11, rpm: 80, range: 34, spread: 0.085,
    magazine: 6, reserve: 48, reload: 2.6, pellets: 9, auto: false,
    recoil: 0.085, shake: 0.28, flash: 1.5, noise: 38,
  },
};

export const WEAPON_ORDER = ["wpn_pistol", "wpn_smg", "wpn_rifle", "wpn_shotgun"];

/** Per-character weapon inventory and firing state. */
export class Loadout {
  constructor(startWith = ["wpn_pistol"]) {
    this.owned = new Set(startWith);
    this.ammo = {};
    for (const key of Object.keys(WEAPONS)) {
      this.ammo[key] = { mag: 0, reserve: 0 };
    }
    for (const key of startWith) {
      const w = WEAPONS[key];
      if (w) this.ammo[key] = { mag: w.magazine, reserve: w.reserve };
    }
    this.current = startWith[0] || null;
    this.cooldown = 0;
    this.reloading = 0;
    this.recoil = 0;
  }

  get spec() { return this.current ? WEAPONS[this.current] : null; }
  get mag() { return this.current ? this.ammo[this.current].mag : 0; }
  get reserve() { return this.current ? this.ammo[this.current].reserve : 0; }

  give(key, magazines = 1) {
    const w = WEAPONS[key];
    if (!w) return false;
    const first = !this.owned.has(key);
    this.owned.add(key);
    const a = this.ammo[key];
    if (first) {
      a.mag = w.magazine;
      a.reserve = Math.min(w.reserve, w.magazine * magazines);
    } else {
      a.reserve = Math.min(w.reserve, a.reserve + w.magazine * magazines);
    }
    return true;
  }

  addAmmo(fraction = 0.5) {
    for (const key of this.owned) {
      const w = WEAPONS[key];
      const a = this.ammo[key];
      a.reserve = Math.min(w.reserve, a.reserve + Math.ceil(w.reserve * fraction));
    }
  }

  switchTo(key) {
    if (!this.owned.has(key) || this.current === key) return false;
    this.current = key;
    this.reloading = 0;
    this.cooldown = Math.max(this.cooldown, 0.25);   // swap time
    return true;
  }

  cycle(dir = 1) {
    const list = WEAPON_ORDER.filter((k) => this.owned.has(k));
    if (list.length < 2) return false;
    const i = list.indexOf(this.current);
    return this.switchTo(list[(i + dir + list.length) % list.length]);
  }

  startReload() {
    const w = this.spec;
    if (!w || this.reloading > 0) return false;
    const a = this.ammo[this.current];
    if (a.mag >= w.magazine || a.reserve <= 0) return false;
    this.reloading = w.reload;
    return true;
  }

  update(dt) {
    this.cooldown = Math.max(0, this.cooldown - dt);
    this.recoil = Math.max(0, this.recoil - dt * 3.2);

    if (this.reloading > 0) {
      this.reloading -= dt;
      if (this.reloading <= 0) {
        this.reloading = 0;
        const w = this.spec;
        const a = this.ammo[this.current];
        const want = w.magazine - a.mag;
        const take = Math.min(want, a.reserve);
        a.mag += take;
        a.reserve -= take;
      }
    }
  }

  canFire() {
    return !!this.spec && this.cooldown <= 0 && this.reloading <= 0 &&
           this.ammo[this.current].mag > 0;
  }
}

// --------------------------------------------------------------------------

const _v = new THREE.Vector3();
const _hitPoint = new THREE.Vector3();
const _normal = new THREE.Vector3();

export class Combat {
  constructor(city, effects, opts = {}) {
    this.city = city;
    this.effects = effects;
    this.onNoise = opts.onNoise || null;    // (x, z, radius, source) => void
    this.onKill = opts.onKill || null;
    this.onHit = opts.onHit || null;
  }

  /**
   * Attempt a shot.
   *
   * @param shooter    owning character (may be null for turret-like sources)
   * @param loadout    Loadout to spend ammo from
   * @param origin     THREE.Vector3 muzzle position
   * @param dir        normalised THREE.Vector3 aim direction
   * @param targets    { characters: [], vehicles: [] }
   * @returns true when a round was actually fired
   */
  fire(shooter, loadout, origin, dir, targets, accuracy = 1) {
    if (!loadout.canFire()) {
      // Dry fire: start a reload rather than silently doing nothing.
      if (loadout.spec && loadout.mag === 0) loadout.startReload();
      return false;
    }

    const w = loadout.spec;
    loadout.ammo[loadout.current].mag -= 1;
    loadout.cooldown = 60 / w.rpm;
    loadout.recoil = Math.min(1, loadout.recoil + w.recoil * 8);

    const spread = w.spread / clamp(accuracy, 0.2, 2);

    for (let p = 0; p < w.pellets; p++) {
      _v.copy(dir);
      if (spread > 0) {
        _v.x += (Math.random() - 0.5) * spread * 2;
        _v.y += (Math.random() - 0.5) * spread * 2;
        _v.z += (Math.random() - 0.5) * spread * 2;
        _v.normalize();
      }
      this._trace(shooter, origin, _v, w, targets);
    }

    if (this.effects) {
      this.effects.muzzleFlash(origin, dir, w.flash);
    }
    if (this.onNoise) {
      this.onNoise(origin.x, origin.z, w.noise, shooter);
    }
    return true;
  }

  _trace(shooter, origin, dir, w, targets) {
    const range = w.range;

    // Walls first: nothing beyond this distance can be hit.
    const wall = this.city
      ? this.city.raycast(origin.x, origin.y, origin.z, dir.x, dir.y, dir.z, range)
      : null;
    let best = wall ? wall.t : range;
    let bestTarget = null;
    let bestKind = wall ? wall.kind : null;

    // Characters, as upright cylinders.
    for (const c of targets.characters || []) {
      if (c === shooter || !c.alive) continue;
      if (c.state === "driving") continue;      // hit the car instead
      const t = this._rayCylinder(origin, dir, c.x, c.y, c.z,
                                  CHAR_RADIUS * 1.25, CHAR_HEIGHT, best);
      if (t !== null && t < best) {
        best = t; bestTarget = c; bestKind = "character";
      }
    }

    // Vehicles, as boxes aligned to their heading.
    for (const v of targets.vehicles || []) {
      const t = this._rayVehicle(origin, dir, v, best);
      if (t !== null && t < best) {
        best = t; bestTarget = v; bestKind = "vehicle";
      }
    }

    _hitPoint.copy(origin).addScaledVector(dir, best);

    if (bestKind === "character") {
      // Headshots do considerably more.
      const headY = bestTarget.y + CHAR_HEIGHT * 0.86;
      const headshot = _hitPoint.y > headY;
      const dmg = w.damage * (headshot ? 2.4 : 1);
      _normal.copy(dir).negate();
      if (this.effects) this.effects.impact(_hitPoint, _normal, "blood");
      const wasAlive = bestTarget.alive;
      bestTarget.damage(dmg, shooter);
      if (this.onHit) this.onHit(bestTarget, dmg, shooter, headshot);
      if (wasAlive && !bestTarget.alive && this.onKill) {
        this.onKill(bestTarget, shooter, headshot);
      }
    } else if (bestKind === "vehicle") {
      _normal.copy(dir).negate();
      if (this.effects) this.effects.impact(_hitPoint, _normal, "metal");
      bestTarget.damage(w.damage * 0.55);
      if (this.onHit) this.onHit(bestTarget, w.damage * 0.55, shooter, false);
    } else if (wall && this.effects) {
      _normal.set(wall.nx, wall.ny, wall.nz);
      this.effects.impact(_hitPoint, _normal, "concrete");
    }

    if (this.effects) this.effects.tracer(origin, _hitPoint);
    return { distance: best, target: bestTarget, kind: bestKind };
  }

  /** Ray against an upright cylinder. Returns entry distance or null. */
  _rayCylinder(origin, dir, cx, cy, cz, radius, height, maxT) {
    const ox = origin.x - cx;
    const oz = origin.z - cz;
    const a = dir.x * dir.x + dir.z * dir.z;
    if (a < 1e-9) return null;

    const b = 2 * (ox * dir.x + oz * dir.z);
    const c = ox * ox + oz * oz - radius * radius;
    const disc = b * b - 4 * a * c;
    if (disc < 0) return null;

    const sq = Math.sqrt(disc);
    let t = (-b - sq) / (2 * a);
    if (t < 0) t = (-b + sq) / (2 * a);
    if (t < 0 || t > maxT) return null;

    const y = origin.y + dir.y * t;
    if (y < cy || y > cy + height) return null;
    return t;
  }

  /** Ray against a vehicle's oriented bounding box. */
  _rayVehicle(origin, dir, v, maxT) {
    // Work in the vehicle's local frame: rotate the ray, then do a slab test.
    const s = Math.sin(-v.heading), co = Math.cos(-v.heading);
    const ox = origin.x - v.x, oz = origin.z - v.z;
    const lx = ox * co + oz * s;
    const lz = -ox * s + oz * co;
    const ldx = dir.x * co + dir.z * s;
    const ldz = -dir.x * s + dir.z * co;

    let tmin = 0, tmax = maxT;
    const half = [v.halfWidth, v.height / 2, v.halfLength];
    const o = [lx, origin.y - (v.y + v.height / 2), lz];
    const d = [ldx, dir.y, ldz];

    for (let i = 0; i < 3; i++) {
      if (Math.abs(d[i]) < 1e-9) {
        if (Math.abs(o[i]) > half[i]) return null;
        continue;
      }
      let t1 = (-half[i] - o[i]) / d[i];
      let t2 = (half[i] - o[i]) / d[i];
      if (t1 > t2) { const tmp = t1; t1 = t2; t2 = tmp; }
      if (t1 > tmin) tmin = t1;
      if (t2 < tmax) tmax = t2;
      if (tmin > tmax) return null;
    }
    return tmin >= 0 && tmin <= maxT ? tmin : null;
  }
}

// --------------------------------------------------------------------------

/** Attaches weapon models to a character's hand and keeps one visible. */
export class WeaponRig {
  constructor(assets, character) {
    this.assets = assets;
    this.character = character;
    this.models = new Map();
    this.muzzles = new Map();
    this.current = null;

    this.anchor = new THREE.Object3D();
    this.anchor.name = "WeaponAnchor";
    // The hand node sits at the wrist with the arm hanging down, so the
    // weapon needs rotating up into a carry pose.
    this.anchor.position.set(0.02, -0.06, 0.02);
    this.anchor.rotation.set(-Math.PI / 2, 0, 0);

    const hand = character.handR;
    if (hand) hand.add(this.anchor);
  }

  _ensure(key) {
    if (this.models.has(key)) return this.models.get(key);
    if (!this.assets.has(key)) return null;

    const inst = this.assets.instantiate(key);
    inst.root.visible = false;
    this.anchor.add(inst.root);
    this.models.set(key, inst.root);
    this.muzzles.set(key, inst.nodes.get("Muzzle") || null);
    return inst.root;
  }

  show(key) {
    if (this.current === key) return;
    for (const [k, model] of this.models) model.visible = false;
    this.current = key;
    const model = this._ensure(key);
    if (model) model.visible = true;
  }

  hide() {
    for (const [, model] of this.models) model.visible = false;
    this.current = null;
  }

  /** World-space muzzle position of the equipped weapon. */
  muzzleWorld(out = new THREE.Vector3()) {
    const node = this.current ? this.muzzles.get(this.current) : null;
    if (node) {
      node.updateWorldMatrix(true, false);
      return out.setFromMatrixPosition(node.matrixWorld);
    }
    const c = this.character;
    return out.set(c.x, c.y + CHAR_HEIGHT * 0.72, c.z);
  }
}
