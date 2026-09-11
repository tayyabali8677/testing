// Character controller and locomotion blending.
//
// Drives both the player and every NPC. Callers push an intent each frame
// (a desired direction, whether to run, where to look) and the controller
// turns that into movement, collision and animation weights. Nothing here
// reads input directly, so the same class serves the player, pedestrians and
// police on foot.
//
// Locomotion is a continuous blend across Idle -> Walk -> Run driven by actual
// ground speed, with each clip's playback rate matched to the distance its
// stride covers. That is what stops the feet skating.

import * as THREE from "three";
import { clamp, damp, dampAngle, headingTo, wrapAngle } from "./mathx.js";

export const RADIUS = 0.36;
export const HEIGHT = 1.8;

const WALK_SPEED = 2.0;
const RUN_SPEED = 5.6;
const ACCEL = 22.0;
const FRICTION = 14.0;
const TURN_RATE = 12.0;

// Ground speed at which each clip's stride looks natural at rate 1.0.
const WALK_NATURAL = 1.25;
const RUN_NATURAL = 3.5;

export const State = {
  ON_FOOT: "on_foot",
  DRIVING: "driving",
  DEAD: "dead",
};

export class Character {
  constructor(assets, city, key, opts = {}) {
    this.city = city;
    this.key = key;

    const inst = assets.instantiate(key);
    this.inst = inst;
    this.root = inst.root;
    this.root.name = `character:${key}`;
    this.root.rotation.order = "YXZ";

    this.handR = inst.nodes.get("Hand_R") || null;
    this.head = inst.nodes.get("Head") || null;
    this.spine = inst.nodes.get("Spine") || null;

    this.x = opts.x || 0;
    this.z = opts.z || 0;
    this.y = city ? city.groundHeight(this.x, this.z) : 0;
    this.heading = opts.heading || 0;
    this.lookHeading = this.heading;

    this.vx = 0;
    this.vz = 0;
    this.speed = 0;

    this.state = State.ON_FOOT;
    this.vehicle = null;
    this.hp = opts.hp ?? 100;
    this.armour = 0;
    this.maxHp = this.hp;
    this.alive = true;
    this.aiming = false;
    this.hurtFlash = 0;

    // Level of detail: 0 full, 1 animate at a reduced rate, 2 hidden.
    this.lod = 0;
    this._animAccum = 0;

    this._initAnimation(inst);
    this.syncTransform();
  }

  _initAnimation(inst) {
    this.mixer = new THREE.AnimationMixer(this.root);
    this.actions = {};

    for (const clip of inst.clips) {
      const action = this.mixer.clipAction(clip);
      action.play();
      action.enabled = true;
      action.setEffectiveWeight(0);
      action.loop = THREE.LoopRepeat;
      this.actions[clip.name] = action;
    }

    // Start standing still.
    if (this.actions.Idle) this.actions.Idle.setEffectiveWeight(1);
    this.hasAnimation = Object.keys(this.actions).length > 0;
  }

  get forward() {
    return { x: -Math.sin(this.heading), z: -Math.cos(this.heading) };
  }

  setPosition(x, z, heading = this.heading) {
    this.x = x; this.z = z;
    this.heading = heading;
    this.lookHeading = heading;
    this.y = this.city ? this.city.groundHeight(x, z) : 0;
    this.vx = this.vz = 0;
    this.speed = 0;
    this.syncTransform();
  }

  /**
   * @param intent {
   *   moveX, moveZ   desired direction in world space, magnitude 0..1
   *   run            boolean
   *   lookHeading    where the character should face; defaults to movement
   *   aiming         boolean, locks facing to lookHeading while moving
   * }
   */
  update(dt, intent = {}) {
    if (dt <= 0) return;
    this.hurtFlash = Math.max(0, this.hurtFlash - dt);

    if (this.state === State.DRIVING) {
      this._followVehicle(dt);
      return;
    }
    if (this.state === State.DEAD) {
      if (this.mixer) this.mixer.update(dt);
      return;
    }

    const mx = intent.moveX || 0;
    const mz = intent.moveZ || 0;
    const mag = Math.min(Math.hypot(mx, mz), 1);
    this.aiming = !!intent.aiming;

    const target = (intent.run && !this.aiming ? RUN_SPEED : WALK_SPEED) * mag;

    if (mag > 1e-4) {
      const dx = mx / mag, dz = mz / mag;
      this.vx = damp(this.vx, dx * target, ACCEL / Math.max(target, 1), dt);
      this.vz = damp(this.vz, dz * target, ACCEL / Math.max(target, 1), dt);
    } else {
      this.vx = damp(this.vx, 0, FRICTION, dt);
      this.vz = damp(this.vz, 0, FRICTION, dt);
    }

    this.speed = Math.hypot(this.vx, this.vz);
    if (this.speed < 0.02) { this.vx = this.vz = 0; this.speed = 0; }

    // Facing: toward movement normally, locked to the look direction when aiming.
    const moving = this.speed > 0.05;
    if (this.aiming && intent.lookHeading !== undefined) {
      this.heading = dampAngle(this.heading, intent.lookHeading, TURN_RATE * 1.6, dt);
    } else if (moving) {
      const want = headingTo(0, 0, this.vx, this.vz);
      this.heading = dampAngle(this.heading, want, TURN_RATE, dt);
    } else if (intent.lookHeading !== undefined) {
      this.heading = dampAngle(this.heading, intent.lookHeading, TURN_RATE * 0.5, dt);
    }
    this.lookHeading = intent.lookHeading !== undefined
      ? intent.lookHeading : this.heading;

    this.x += this.vx * dt;
    this.z += this.vz * dt;

    if (this.city) {
      const res = this.city.resolveCircle(this.x, this.z, RADIUS);
      if (res.hit) {
        this.x = res.x; this.z = res.z;
        // Slide along the wall rather than sticking to it.
        const into = this.vx * res.nx + this.vz * res.nz;
        if (into < 0) {
          this.vx -= into * res.nx;
          this.vz -= into * res.nz;
        }
      }
      this.y = damp(this.y, this.city.groundHeight(this.x, this.z), 16, dt);
    }

    this._updateAnimation(dt);
    this.syncTransform();
  }

  /** 0 full detail, 1 reduced animation rate, 2 hidden entirely. */
  setLod(level) {
    if (this.lod === level) return;
    this.lod = level;
    this.root.visible = level < 2 && this.state !== State.DRIVING;
  }

  _updateAnimation(dt) {
    if (!this.mixer) return;

    // Skinning a crowd is the single biggest per-frame cost on foot, and a
    // pedestrian two streets away does not need 60 Hz limbs.
    if (this.lod >= 2) return;
    if (this.lod === 1) {
      this._animAccum += dt;
      if (this._animAccum < 1 / 12) return;
      dt = this._animAccum;
      this._animAccum = 0;
    }

    if (!this.hasAnimation) { this.mixer.update(dt); return; }

    const s = this.speed;
    const idle = this.actions.Idle;
    const walk = this.actions.Walk;
    const run = this.actions.Run;

    let wIdle = 0, wWalk = 0, wRun = 0;
    if (s <= 0.05) {
      wIdle = 1;
    } else if (s <= WALK_SPEED) {
      const t = s / WALK_SPEED;
      wIdle = 1 - t; wWalk = t;
    } else {
      const t = clamp((s - WALK_SPEED) / (RUN_SPEED - WALK_SPEED), 0, 1);
      wWalk = 1 - t; wRun = t;
    }

    if (idle) idle.setEffectiveWeight(wIdle);
    if (walk) {
      walk.setEffectiveWeight(wWalk);
      // Match stride to ground speed so the feet do not slide.
      walk.setEffectiveTimeScale(clamp(s / WALK_NATURAL, 0.35, 2.2));
    }
    if (run) {
      run.setEffectiveWeight(wRun);
      run.setEffectiveTimeScale(clamp(s / RUN_NATURAL, 0.5, 2.0));
    }

    this.mixer.update(dt);
  }

  syncTransform() {
    this.root.position.set(this.x, this.y, this.z);
    this.root.rotation.y = this.heading;
  }

  // ---- vehicles --------------------------------------------------------

  enterVehicle(vehicle) {
    if (this.state !== State.ON_FOOT || !vehicle) return false;
    this.state = State.DRIVING;
    this.vehicle = vehicle;
    vehicle.driver = this;
    this.root.visible = false;
    this.vx = this.vz = 0;
    this.speed = 0;
    return true;
  }

  exitVehicle() {
    if (this.state !== State.DRIVING || !this.vehicle) return false;
    const v = this.vehicle;

    // Step out to the left of the car, or the right if that is blocked.
    const r = v.right;
    const offset = v.halfWidth + RADIUS + 0.25;
    let ex = v.x - r.x * offset;
    let ez = v.z - r.z * offset;
    if (this.city && this.city.blocked(ex, ez, RADIUS)) {
      ex = v.x + r.x * offset;
      ez = v.z + r.z * offset;
    }
    if (this.city && this.city.blocked(ex, ez, RADIUS)) {
      ex = v.x; ez = v.z;
    }

    v.driver = null;
    this.vehicle = null;
    this.state = State.ON_FOOT;
    this.root.visible = true;
    this.setPosition(ex, ez, v.heading);
    return true;
  }

  _followVehicle(dt) {
    const v = this.vehicle;
    if (!v) { this.state = State.ON_FOOT; this.root.visible = true; return; }
    this.x = v.x; this.z = v.z; this.y = v.y;
    this.heading = v.heading;
    this.speed = Math.abs(v.speed);
    if (this.mixer) this.mixer.update(dt);
  }

  // ---- damage ----------------------------------------------------------

  damage(amount, source = null) {
    if (!this.alive) return 0;

    let remaining = amount;
    if (this.armour > 0) {
      const absorbed = Math.min(this.armour, remaining * 0.7);
      this.armour -= absorbed;
      remaining -= absorbed;
    }

    this.hp -= remaining;
    this.hurtFlash = 0.3;
    this.lastAttacker = source;

    if (this.hp <= 0) {
      this.hp = 0;
      this.alive = false;
      this.state = State.DEAD;
      this.vx = this.vz = 0;
      this.speed = 0;
      // Fall over. Pitching the root is cheaper than a death animation and
      // reads fine at the distances this camera ever sees.
      this.root.rotation.x = -Math.PI / 2.2;
      this.root.position.y = this.y + 0.25;
    }
    return remaining;
  }

  heal(amount) {
    this.hp = Math.min(this.maxHp, this.hp + amount);
  }

  revive(x, z) {
    this.hp = this.maxHp;
    this.armour = 0;
    this.alive = true;
    this.state = State.ON_FOOT;
    this.root.visible = true;
    this.root.rotation.x = 0;
    this.root.rotation.z = 0;
    this.setPosition(x, z, this.heading);
  }

  /** World position of the head, for camera and line-of-sight checks. */
  eyePosition(out = new THREE.Vector3()) {
    return out.set(this.x, this.y + HEIGHT * 0.92, this.z);
  }

  dispose() {
    if (this.mixer) this.mixer.stopAllAction();
  }
}
