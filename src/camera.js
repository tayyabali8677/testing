// Third-person camera rig.
//
// Three behaviours share one rig: a free orbit on foot, a chase camera that
// settles behind a car, and a tight over-the-shoulder pose while aiming.
// Switching between them is a blend of the same parameters (distance, height,
// shoulder offset, field of view) rather than three separate cameras, so
// transitions never pop.
//
// Occlusion is resolved in 2D. Buildings are tall boxes and the camera lives
// a few metres off the ground, so a plan-view march along the boom catches
// essentially every real occlusion at a fraction of the cost of raycasting
// the scene graph.

import * as THREE from "three";
import { clamp, damp, dampAngle, wrapAngle, lerp } from "./mathx.js";

const MODES = {
  foot: { dist: 5.6, height: 2.25, shoulder: 0.55, fov: 62, pitch: -0.12,
          followYaw: 0.0, lookAhead: 0.0 },
  aim:  { dist: 2.6, height: 1.72, shoulder: 0.85, fov: 50, pitch: -0.05,
          followYaw: 0.0, lookAhead: 0.0 },
  car:  { dist: 9.0, height: 3.5, shoulder: 0.0, fov: 66, pitch: -0.16,
          followYaw: 3.2, lookAhead: 0.35 },
};

const PITCH_MIN = -0.95;
const PITCH_MAX = 0.62;
const MIN_DISTANCE = 0.8;

export class CameraRig {
  constructor(camera, city, opts = {}) {
    this.camera = camera;
    this.city = city;

    this.yaw = 0;
    this.pitch = -0.12;
    this.mode = "foot";

    // Smoothed rig parameters, so a mode change eases instead of snapping.
    this.dist = MODES.foot.dist;
    this.height = MODES.foot.height;
    this.shoulder = MODES.foot.shoulder;
    this.fov = MODES.foot.fov;
    this.zoom = 1;

    this.sensitivity = opts.sensitivity ?? 0.0026;
    this.invertY = !!opts.invertY;

    this.target = new THREE.Vector3();
    this.desired = new THREE.Vector3();
    this.shake = 0;
    this._shakeOffset = new THREE.Vector3();

    this.camera.rotation.order = "YXZ";
  }

  addShake(amount) {
    this.shake = clamp(this.shake + amount, 0, 1);
  }

  /** Apply raw pointer movement. */
  look(dx, dy) {
    this.yaw = wrapAngle(this.yaw - dx * this.sensitivity);
    const dir = this.invertY ? -1 : 1;
    this.pitch = clamp(this.pitch - dy * this.sensitivity * dir,
                       PITCH_MIN, PITCH_MAX);
  }

  zoomBy(steps) {
    this.zoom = clamp(this.zoom + steps * 0.12, 0.6, 1.8);
  }

  /**
   * @param subject { x, y, z, heading, speed }  what the camera follows
   * @param opts { mode, aiming }
   */
  update(dt, subject, opts = {}) {
    const mode = opts.mode || "foot";
    this.mode = mode;
    const cfg = MODES[mode] || MODES.foot;

    // While driving, the camera drifts to sit behind the car unless the
    // player is actively looking around.
    if (cfg.followYaw > 0 && !opts.freeLook) {
      const behind = subject.heading;
      const rate = cfg.followYaw * clamp(Math.abs(subject.speed || 0) / 8, 0.15, 1);
      this.yaw = dampAngle(this.yaw, behind, rate, dt);
    }

    const rate = 8;
    this.dist = damp(this.dist, cfg.dist * this.zoom, rate, dt);
    this.height = damp(this.height, cfg.height, rate, dt);
    this.shoulder = damp(this.shoulder, cfg.shoulder, rate, dt);
    this.fov = damp(this.fov, this._speedFov(cfg, subject), 5, dt);

    // Focus point: a bit above the subject, pushed forward at speed so the
    // road ahead stays in frame.
    const fx = -Math.sin(subject.heading);
    const fz = -Math.cos(subject.heading);
    const ahead = cfg.lookAhead * clamp((subject.speed || 0) / 12, 0, 1) * 6;

    this.target.set(
      subject.x + fx * ahead,
      subject.y + this.height,
      subject.z + fz * ahead
    );

    // Boom direction from yaw/pitch.
    const cp = Math.cos(this.pitch);
    const boomX = Math.sin(this.yaw) * cp;
    const boomY = -Math.sin(this.pitch);
    const boomZ = Math.cos(this.yaw) * cp;

    // Shoulder offset is perpendicular to the boom, in the ground plane.
    const sx = Math.cos(this.yaw) * this.shoulder;
    const sz = -Math.sin(this.yaw) * this.shoulder;

    const wanted = this.dist;
    const allowed = this._clearDistance(
      this.target.x + sx, this.target.y, this.target.z + sz,
      boomX, boomY, boomZ, wanted
    );

    this.desired.set(
      this.target.x + sx + boomX * allowed,
      this.target.y + boomY * allowed,
      this.target.z + sz + boomZ * allowed
    );

    // Never let the camera drop below the pavement.
    const floor = (this.city ? this.city.groundHeight(this.desired.x, this.desired.z) : 0) + 0.5;
    if (this.desired.y < floor) this.desired.y = floor;

    // Pull in hard, ease out gently: popping out of a wall is far more
    // noticeable than easing back to the full boom length.
    const closing = this.desired.distanceTo(this.camera.position);
    const follow = closing > 6 ? 30 : 14;
    this.camera.position.x = damp(this.camera.position.x, this.desired.x, follow, dt);
    this.camera.position.y = damp(this.camera.position.y, this.desired.y, follow, dt);
    this.camera.position.z = damp(this.camera.position.z, this.desired.z, follow, dt);

    this._applyShake(dt);
    this.camera.lookAt(this.target);

    if (Math.abs(this.camera.fov - this.fov) > 0.01) {
      this.camera.fov = this.fov;
      this.camera.updateProjectionMatrix();
    }
  }

  _speedFov(cfg, subject) {
    const s = Math.abs(subject.speed || 0);
    // Widening with speed sells velocity without making slow driving fisheye.
    return cfg.fov + clamp(s / 55, 0, 1) * (this.mode === "car" ? 14 : 4);
  }

  /**
   * March along the boom and stop short of the first obstruction.
   * Returns the usable boom length.
   */
  _clearDistance(ox, oy, oz, dx, dy, dz, maxDist) {
    if (!this.city) return maxDist;

    const steps = 10;
    const pad = 0.45;
    for (let i = 1; i <= steps; i++) {
      const t = (i / steps) * maxDist;
      const px = ox + dx * t;
      const pz = oz + dz * t;
      if (this.city.blocked(px, pz, pad)) {
        // Back off to just before the hit.
        return Math.max(MIN_DISTANCE, ((i - 1) / steps) * maxDist - 0.1);
      }
    }
    return maxDist;
  }

  _applyShake(dt) {
    if (this.shake <= 0.001) {
      this.shake = 0;
      return;
    }
    const a = this.shake * this.shake * 0.55;
    this._shakeOffset.set(
      (Math.random() - 0.5) * a,
      (Math.random() - 0.5) * a,
      (Math.random() - 0.5) * a
    );
    this.camera.position.add(this._shakeOffset);
    this.shake = Math.max(0, this.shake - dt * 2.4);
  }

  /** Heading the camera is facing, for aim direction.
   *  The boom places the camera at (sin yaw, cos yaw) from the target, so it
   *  looks back along (-sin yaw, -cos yaw), which is forward(yaw) exactly. */
  get lookHeading() {
    return wrapAngle(this.yaw);
  }

  /** Unit aim vector, including pitch. */
  aimDirection(out = new THREE.Vector3()) {
    const cp = Math.cos(this.pitch);
    return out.set(-Math.sin(this.yaw) * cp, Math.sin(this.pitch),
                   -Math.cos(this.yaw) * cp).normalize();
  }

  snapBehind(subject) {
    this.yaw = subject.heading;
    this.pitch = -0.12;
    const cp = Math.cos(this.pitch);
    this.camera.position.set(
      subject.x + Math.sin(this.yaw) * cp * this.dist,
      subject.y + this.height + 1,
      subject.z + Math.cos(this.yaw) * cp * this.dist
    );
  }
}
