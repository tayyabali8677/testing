// Arcade vehicle physics.
//
// Not a simulation. The model keeps a heading and a world velocity, splits
// that velocity into forward and lateral components each step, and bleeds the
// lateral part away according to grip. High grip means the car goes where it
// points; dropping grip (handbrake, or too much speed through a corner) lets
// the back step out. That gives predictable, controllable slides without a
// tyre model.

import * as THREE from "three";
import {
  clamp, damp, forwardX, forwardZ, rightX, rightZ, wrapAngle,
} from "./mathx.js";

// Per-class handling. topSpeed is m/s; 45 m/s is about 160 km/h.
const CLASSES = {
  veh_sedan:   { power: 15.0, topSpeed: 42, grip: 7.0, turn: 1.75, mass: 1.0 },
  veh_sports:  { power: 22.0, topSpeed: 55, grip: 8.5, turn: 2.05, mass: 0.85 },
  veh_muscle:  { power: 20.0, topSpeed: 50, grip: 5.8, turn: 1.70, mass: 1.1 },
  veh_police:  { power: 19.0, topSpeed: 50, grip: 8.0, turn: 1.90, mass: 1.05 },
  veh_taxi:    { power: 14.0, topSpeed: 40, grip: 6.8, turn: 1.70, mass: 1.05 },
  veh_van:     { power: 12.0, topSpeed: 35, grip: 5.5, turn: 1.40, mass: 1.4 },
  veh_truck:   { power: 11.0, topSpeed: 30, grip: 5.0, turn: 1.15, mass: 2.2 },
};
const DEFAULT_CLASS = CLASSES.veh_sedan;

const BRAKE = 24.0;
const REVERSE_FRACTION = 0.38;
const ROLL_DRAG = 0.55;        // coasting deceleration
const AIR_DRAG = 0.0016;       // grows with speed squared
const WHEEL_FALLBACK_R = 0.34;
// Fraction of the speed range over which engine power tapers to nothing.
const TAPER_BAND = 0.25;

export class Vehicle {
  constructor(assets, city, key, opts = {}) {
    this.city = city;
    this.key = key;
    this.spec = CLASSES[key] || DEFAULT_CLASS;
    this.isPolice = key === "veh_police";

    const inst = assets.instantiate(key);
    this.inst = inst;
    this.root = inst.root;
    this.root.name = `vehicle:${key}`;

    const meta = assets.metaFor(key);
    const size = (meta && meta.bbox && meta.bbox.size) || [2, 1.6, 4.5];
    this.halfWidth = size[0] / 2;
    this.halfLength = size[2] / 2;
    this.height = size[1];

    this.wheels = {
      FL: inst.nodes.get("Wheel_FL") || null,
      FR: inst.nodes.get("Wheel_FR") || null,
      RL: inst.nodes.get("Wheel_RL") || null,
      RR: inst.nodes.get("Wheel_RR") || null,
    };
    this.wheelRadius = this._measureWheel();
    this.seat = inst.nodes.get("Seat") || null;

    // Which way a wheel must turn depends on where its local X axis ends up.
    // A third-party model turned 180 degrees to face our forward has its X
    // axis mirrored, so its wheels turn the opposite way from ours.
    const rotY = Math.abs(Math.round(((meta && meta.rotateY) || 0) / 180));
    this.wheelAxisSign = rotY % 2 === 1 ? -1 : 1;

    this.x = opts.x || 0;
    this.z = opts.z || 0;
    this.y = city ? city.groundHeight(this.x, this.z) : 0;
    this.heading = opts.heading || 0;

    this.vx = 0;
    this.vz = 0;
    this.speed = 0;              // signed, along forward
    this.lateral = 0;            // signed, along right
    this.steer = 0;              // -1..1, smoothed
    this.steerVisual = 0;
    this.wheelSpin = 0;
    this.rpm = 0;
    this.slip = 0;               // 0..1, how sideways the car is going

    this.hp = 100;
    this.alive = true;
    this.driver = null;
    this.lastImpact = 0;
    this.lightsOn = false;
    this.lod = 0;

    this._lightMeshes = [];
    for (const name of ["Headlight_L", "Headlight_R"]) {
      const n = inst.nodes.get(name);
      if (n) this._lightMeshes.push(n);
    }
    // Yaw must be the outermost rotation or lean would tilt the car in
    // world space rather than about its own axis.
    this.root.rotation.order = "YXZ";
    for (const w of Object.values(this.wheels)) {
      // Steer about Y, then spin about the wheel's own axle on X.
      if (w) w.rotation.order = "YXZ";
    }

    this._sirenMeshes = [
      inst.nodes.get("Lightbar_R") || null,
      inst.nodes.get("Lightbar_B") || null,
    ].filter(Boolean);

    this.syncTransform();
  }

  _measureWheel() {
    const w = this.wheels.FL;
    if (!w) return WHEEL_FALLBACK_R;
    try {
      const box = new THREE.Box3().setFromObject(w);
      const size = new THREE.Vector3();
      box.getSize(size);
      const r = Math.max(size.y, size.z) / 2;
      return r > 0.05 ? r : WHEEL_FALLBACK_R;
    } catch {
      return WHEEL_FALLBACK_R;
    }
  }

  get forward() { return { x: forwardX(this.heading), z: forwardZ(this.heading) }; }
  get right() { return { x: rightX(this.heading), z: rightZ(this.heading) }; }
  get speedKph() { return Math.abs(this.speed) * 3.6; }

  setPosition(x, z, heading = this.heading) {
    this.x = x; this.z = z; this.heading = heading;
    this.y = this.city ? this.city.groundHeight(x, z) : 0;
    this.vx = this.vz = 0;
    this.speed = this.lateral = 0;
    this.syncTransform();
  }

  /**
   * @param controls {throttle:-1..1, steer:-1..1, handbrake:boolean}
   */
  update(dt, controls = {}) {
    if (dt <= 0) return;

    const throttle = clamp(controls.throttle || 0, -1, 1);
    const steerInput = clamp(controls.steer || 0, -1, 1);
    const handbrake = !!controls.handbrake;

    const spec = this.spec;

    // Decompose world velocity into the car's own axes.
    const f = this.forward, r = this.right;
    let vF = this.vx * f.x + this.vz * f.z;
    let vL = this.vx * r.x + this.vz * r.z;

    // ---- engine and brakes ---------------------------------------------
    // Power holds flat until the last quarter of the range, then tapers. A
    // taper that starts at zero speed cannot overcome drag near the limit, so
    // the car would top out well under its stated figure.
    if (throttle > 0) {
      const headroom = clamp((spec.topSpeed - vF) / (spec.topSpeed * TAPER_BAND),
                             0, 1);
      vF += spec.power * throttle * headroom * dt;
    } else if (throttle < 0) {
      if (vF > 0.5) {
        vF -= BRAKE * -throttle * dt;              // braking
      } else {
        const revTop = spec.topSpeed * REVERSE_FRACTION;
        const headroom = clamp((revTop + vF) / (revTop * TAPER_BAND), 0, 1);
        vF += spec.power * throttle * 0.6 * headroom * dt;
      }
    }

    // Rolling and aerodynamic drag.
    vF -= Math.sign(vF) * ROLL_DRAG * dt;
    vF -= vF * Math.abs(vF) * AIR_DRAG * dt;
    if (Math.abs(vF) < 0.12 && Math.abs(throttle) < 0.01) vF = 0;
    vF = clamp(vF, -spec.topSpeed * REVERSE_FRACTION, spec.topSpeed);

    if (handbrake) {
      vF -= Math.sign(vF) * BRAKE * 0.55 * dt;
      if (Math.abs(vF) < 0.4) vF = 0;
    }

    // ---- steering -------------------------------------------------------
    // Smooth the input so keyboard taps do not snap the wheels over.
    this.steer = damp(this.steer, steerInput, 9, dt);
    this.steerVisual = damp(this.steerVisual, steerInput, 12, dt);

    const absF = Math.abs(vF);
    // Authority builds from a standstill and fades at speed, otherwise the
    // car spins on the spot and becomes twitchy on the motorway.
    const authority = Math.min(absF / 5.0, 1) * (1 - Math.min(absF / (spec.topSpeed * 2.1), 0.55));
    const turn = this.steer * spec.turn * authority * Math.sign(vF || 1);
    this.heading = wrapAngle(this.heading + turn * dt);

    // ---- grip -----------------------------------------------------------
    // Cornering throws velocity sideways; grip decides how fast that decays.
    const nf = this.forward, nr = this.right;
    let grip = spec.grip;
    if (handbrake) grip *= 0.14;
    // Lose a little grip when already sliding, so slides are progressive.
    grip *= 1 - clamp(Math.abs(vL) / 16, 0, 0.55);

    vL += -turn * vF * dt;                 // centripetal transfer
    vL *= Math.exp(-grip * dt);

    this.speed = vF;
    this.lateral = vL;
    this.slip = clamp(Math.abs(vL) / 9, 0, 1);

    this.vx = nf.x * vF + nr.x * vL;
    this.vz = nf.z * vF + nr.z * vL;

    // ---- integrate and collide -----------------------------------------
    this.x += this.vx * dt;
    this.z += this.vz * dt;
    if (this.city) this._collideWorld(dt);

    this.y = damp(this.y, this.city ? this.city.groundHeight(this.x, this.z) : 0,
                  14, dt);

    // ---- visuals --------------------------------------------------------
    this.wheelSpin += (vF / this.wheelRadius) * dt;
    this.rpm = clamp(Math.abs(vF) / spec.topSpeed, 0, 1);
    this.lastImpact = Math.max(0, this.lastImpact - dt);

    this.syncTransform(dt);
  }

  _collideWorld(dt) {
    // Three probes down the centreline approximate the hull well enough for
    // a city of axis-aligned boxes, and cost far less than a real SAT test.
    const f = this.forward;
    const probes = [
      { ox: f.x * this.halfLength * 0.62, oz: f.z * this.halfLength * 0.62 },
      { ox: 0, oz: 0 },
      { ox: -f.x * this.halfLength * 0.62, oz: -f.z * this.halfLength * 0.62 },
    ];
    const radius = this.halfWidth * 0.95;

    let nx = 0, nz = 0, hits = 0;
    for (const p of probes) {
      const res = this.city.resolveCircle(this.x + p.ox, this.z + p.oz, radius);
      if (!res.hit) continue;
      hits++;
      this.x += res.x - (this.x + p.ox);
      this.z += res.z - (this.z + p.oz);
      nx += res.nx; nz += res.nz;
    }
    if (!hits) return;

    const len = Math.hypot(nx, nz) || 1;
    nx /= len; nz /= len;

    // Reflect, keeping only a little of the incoming energy.
    const vn = this.vx * nx + this.vz * nz;
    if (vn < 0) {
      const impact = -vn;
      this.vx -= (1 + 0.28) * vn * nx;
      this.vz -= (1 + 0.28) * vn * nz;
      // Scrubbing along a wall should not stop the car dead.
      this.vx *= 0.78;
      this.vz *= 0.78;

      const f2 = this.forward, r2 = this.right;
      this.speed = this.vx * f2.x + this.vz * f2.z;
      this.lateral = this.vx * r2.x + this.vz * r2.z;

      if (impact > 3) {
        this.lastImpact = Math.min(1, impact / 20);
        this.damage(impact * 0.9);
      }
    }
  }

  /** Elastic-ish separation between two vehicles. */
  static collidePair(a, b) {
    const dx = b.x - a.x, dz = b.z - a.z;
    const d = Math.hypot(dx, dz);
    const minD = (a.halfLength + b.halfLength) * 0.78;
    if (d >= minD || d < 1e-5) return 0;

    const nx = dx / d, nz = dz / d;
    const push = (minD - d) * 0.5;
    const ma = a.spec.mass, mb = b.spec.mass;
    const total = ma + mb;

    a.x -= nx * push * (mb / total) * 2;
    a.z -= nz * push * (mb / total) * 2;
    b.x += nx * push * (ma / total) * 2;
    b.z += nz * push * (ma / total) * 2;

    const rel = (b.vx - a.vx) * nx + (b.vz - a.vz) * nz;
    if (rel > 0) return 0;

    const impulse = -(1 + 0.2) * rel / total;
    a.vx -= impulse * nx * mb;
    a.vz -= impulse * nz * mb;
    b.vx += impulse * nx * ma;
    b.vz += impulse * nz * ma;

    for (const v of [a, b]) {
      const f = v.forward, r = v.right;
      v.speed = v.vx * f.x + v.vz * f.z;
      v.lateral = v.vx * r.x + v.vz * r.z;
    }

    const impact = Math.abs(rel);
    if (impact > 3) {
      a.lastImpact = b.lastImpact = Math.min(1, impact / 20);
      a.damage(impact * 0.5);
      b.damage(impact * 0.5);
    }
    return impact;
  }

  damage(amount) {
    if (!this.alive) return;
    this.hp -= amount;
    if (this.hp <= 0) {
      this.hp = 0;
      this.alive = false;
    }
  }

  syncTransform(dt = 0) {
    this.root.position.set(this.x, this.y, this.z);
    this.root.rotation.y = this.heading;

    // Lean into corners and squat under acceleration. Purely cosmetic, but
    // it is most of what makes an arcade car feel weighty.
    const targetRoll = clamp(-this.lateral * 0.018, -0.16, 0.16);
    const targetPitch = clamp(-this.speed * 0.0016 * (this.rpm > 0.02 ? 1 : 0),
                              -0.06, 0.06);
    if (dt > 0) {
      this.root.rotation.z = damp(this.root.rotation.z, targetRoll, 8, dt);
      this.root.rotation.x = damp(this.root.rotation.x, targetPitch, 8, dt);
    }

    const steerAngle = this.steerVisual * 0.5;
    // Driving forward carries the wheel's contact patch backwards, which is a
    // negative rotation about its own X axis. Getting this sign wrong is easy
    // to miss in a still frame and obvious the moment the car moves.
    const spin = -this.wheelSpin * this.wheelAxisSign;
    for (const [tag, wheel] of Object.entries(this.wheels)) {
      if (!wheel) continue;
      wheel.rotation.set(0, 0, 0);
      if (tag === "FL" || tag === "FR") wheel.rotation.y = steerAngle;
      // Wheels are modelled with their axle along X, so spin is about X.
      wheel.rotation.x = spin;
    }
  }

  /** 0 full detail, 1 no shadow casting, 2 hidden. */
  setLod(level) {
    if (this.lod === level) return;
    this.lod = level;
    this.root.visible = level < 2;
    // Shadow casting costs a second pass over the geometry; distant cars
    // contribute a few pixels of shadow at most.
    const cast = level === 0;
    this.root.traverse((o) => { if (o.isMesh) o.castShadow = cast; });
  }

  setLights(on) {
    if (this.lightsOn === on) return;
    this.lightsOn = on;
    for (const mesh of this._lightMeshes) {
      mesh.visible = true;
      if (mesh.material && mesh.material.emissiveIntensity !== undefined) {
        // Shared material across instances, so clone on first change.
        if (!mesh.material.userData._perVehicle) {
          mesh.material = mesh.material.clone();
          mesh.material.userData._perVehicle = true;
        }
        mesh.material.emissiveIntensity = on ? 6 : 0.4;
      }
    }
  }

  updateSiren(t, active) {
    if (!this._sirenMeshes.length) return;
    const phase = Math.floor(t * 6) % 2;
    this._sirenMeshes.forEach((m, i) => {
      m.visible = active ? (i === phase) : true;
    });
  }
}
