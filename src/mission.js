// Objectives, pickups and payouts.
//
// One active delivery at a time plus a scattering of persistent pickups. The
// delivery loop is deliberately simple: the interesting part is the driving
// and whatever heat the player picks up on the way.

import * as THREE from "three";
import { clamp, dist2D, makeRng } from "./mathx.js";

const PICKUP_RESPAWN = 28;
const MARKER_RADIUS = 5.0;
const PICKUP_RADIUS = 2.0;

const PICKUP_TYPES = {
  item_cash: { kind: "cash", value: 180, spin: 1.4 },
  item_health: { kind: "health", value: 35, spin: 1.0 },
  item_armour: { kind: "armour", value: 50, spin: 1.0 },
  item_ammo: { kind: "ammo", value: 0.5, spin: 1.2 },
};

export class Missions {
  constructor(assets, city, scene, opts = {}) {
    this.assets = assets;
    this.city = city;
    this.scene = scene;
    this.rng = makeRng(opts.seed ?? 0x5150);

    this.cash = opts.startingCash ?? 0;
    this.streak = 0;
    this.deliveries = 0;
    this.best = 0;

    this.marker = null;
    this.markerPos = { x: 0, z: 0 };
    this.timeLimit = 0;
    this.timeLeft = 0;

    this.pickups = [];
    this.onEvent = opts.onEvent || null;

    this._spawnMarker();
    this._spawnPickups(opts.pickups ?? 26);
  }

  _emit(type, data) {
    if (this.onEvent) this.onEvent(type, data);
  }

  // ---- delivery marker -------------------------------------------------

  _spawnMarker() {
    if (!this.marker && this.assets.has("item_marker")) {
      const inst = this.assets.instantiate("item_marker");
      this.marker = inst.root;
      this.marker.name = "MissionMarker";
      if (this.scene) this.scene.add(this.marker);
    }
    this.relocate();
  }

  relocate(from = null) {
    const p = this.city.randomRoadPoint(from, 140);
    this.markerPos.x = p.x;
    this.markerPos.z = p.z;
    if (this.marker) {
      this.marker.position.set(p.x, this.city.groundHeight(p.x, p.z), p.z);
    }

    // Allow roughly 14 m/s average, with a floor so short hops stay fair.
    if (from) {
      const d = dist2D(from.x, from.z, p.x, p.z);
      this.timeLimit = Math.max(22, d / 14);
    } else {
      this.timeLimit = 45;
    }
    this.timeLeft = this.timeLimit;
  }

  // ---- pickups ---------------------------------------------------------

  _spawnPickups(count) {
    const keys = Object.keys(PICKUP_TYPES).filter((k) => this.assets.has(k));
    if (!keys.length) return;

    for (let i = 0; i < count; i++) {
      const key = this.rng.pick(keys);
      const p = this.city.randomSidewalkPoint();
      const inst = this.assets.instantiate(key);
      inst.root.position.set(p.x, this.city.groundHeight(p.x, p.z) + 0.1, p.z);
      if (this.scene) this.scene.add(inst.root);

      this.pickups.push({
        key,
        type: PICKUP_TYPES[key],
        root: inst.root,
        x: p.x, z: p.z,
        cooldown: 0,
      });
    }
  }

  // ---- per-frame -------------------------------------------------------

  update(dt, player, loadout) {
    const subject = player.state === "driving" && player.vehicle
      ? player.vehicle : player;

    // Marker spin and bob.
    if (this.marker) {
      this.marker.rotation.y += dt * 0.8;
    }

    if (this.timeLeft > 0) {
      this.timeLeft -= dt;
      if (this.timeLeft <= 0) {
        this.timeLeft = 0;
        if (this.streak > 0) {
          this._emit("streakLost", { streak: this.streak });
          this.streak = 0;
        }
      }
    }

    if (dist2D(subject.x, subject.z, this.markerPos.x, this.markerPos.z)
        < MARKER_RADIUS) {
      this._completeDelivery(subject);
    }

    for (const pickup of this.pickups) {
      if (pickup.cooldown > 0) {
        pickup.cooldown -= dt;
        if (pickup.cooldown <= 0) pickup.root.visible = true;
        continue;
      }
      pickup.root.rotation.y += dt * pickup.type.spin;
      if (dist2D(subject.x, subject.z, pickup.x, pickup.z) < PICKUP_RADIUS) {
        this._collect(pickup, player, loadout);
      }
    }
  }

  _completeDelivery(subject) {
    const onTime = this.timeLeft > 0;
    this.streak = onTime ? this.streak + 1 : 1;
    this.deliveries++;
    this.best = Math.max(this.best, this.streak);

    const base = 260;
    const bonus = onTime ? Math.round(this.timeLeft * 9) : 0;
    const multiplier = 1 + clamp(this.streak - 1, 0, 9) * 0.22;
    const payout = Math.round((base + bonus) * multiplier);

    this.cash += payout;
    this._emit("delivery", {
      payout, streak: this.streak, onTime, bonus, multiplier,
    });
    this.relocate(subject);
  }

  _collect(pickup, player, loadout) {
    const t = pickup.type;
    let message = null;

    if (t.kind === "cash") {
      const amount = Math.round(t.value * (0.6 + this.rng.next() * 0.8));
      this.cash += amount;
      message = `+$${amount}`;
    } else if (t.kind === "health") {
      if (player.hp >= player.maxHp) return;
      player.heal(t.value);
      message = "Health";
    } else if (t.kind === "armour") {
      if (player.armour >= 100) return;
      player.armour = Math.min(100, player.armour + t.value);
      message = "Armour";
    } else if (t.kind === "ammo") {
      if (!loadout) return;
      loadout.addAmmo(t.value);
      message = "Ammo";
    }

    pickup.root.visible = false;
    pickup.cooldown = PICKUP_RESPAWN;
    this._emit("pickup", { kind: t.kind, message });
  }

  spend(amount) {
    this.cash = Math.max(0, this.cash - amount);
    return this.cash;
  }

  /** Distance and bearing to the current objective, for the HUD. */
  objective(from) {
    return {
      x: this.markerPos.x,
      z: this.markerPos.z,
      distance: dist2D(from.x, from.z, this.markerPos.x, this.markerPos.z),
      timeLeft: this.timeLeft,
      timeLimit: this.timeLimit,
    };
  }
}
