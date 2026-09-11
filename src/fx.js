// Pooled visual effects: tracers, sparks, smoke, muzzle flash, explosions.
//
// Everything here is allocated once at construction and recycled. Nothing in
// this file creates a geometry, material or Object3D after startup, so a long
// firefight cannot stutter the frame with garbage collection.

import * as THREE from "three";
import { clamp } from "./mathx.js";

const MAX_PARTICLES = 900;
const MAX_TRACERS = 48;

export class Effects {
  constructor(scene, opts = {}) {
    this.scene = scene;
    this.group = new THREE.Group();
    this.group.name = "Effects";
    scene.add(this.group);

    this._initParticles();
    this._initTracers();
    this._initFlash();
  }

  // ---- particles -------------------------------------------------------

  _initParticles() {
    const n = MAX_PARTICLES;
    this.pCount = n;
    this.pPos = new Float32Array(n * 3);
    this.pVel = new Float32Array(n * 3);
    this.pColor = new Float32Array(n * 3);
    this.pLife = new Float32Array(n);
    this.pMax = new Float32Array(n);
    this.pSize = new Float32Array(n);      // current, written to the GPU
    this.pBase = new Float32Array(n);      // spawn size, fades are relative to it
    this.pGravity = new Float32Array(n);
    this.pNext = 0;

    const geo = new THREE.BufferGeometry();
    geo.setAttribute("position", new THREE.BufferAttribute(this.pPos, 3));
    geo.setAttribute("color", new THREE.BufferAttribute(this.pColor, 3));
    geo.setAttribute("size", new THREE.BufferAttribute(this.pSize, 1));
    geo.setDrawRange(0, n);
    // Particles are scattered worldwide; culling the whole cloud as one
    // object would pop every effect off at once.
    geo.boundingSphere = new THREE.Sphere(new THREE.Vector3(), 1e6);

    const mat = new THREE.ShaderMaterial({
      uniforms: {},
      vertexShader: /* glsl */`
        attribute float size;
        varying vec3 vColor;
        void main() {
          vColor = color;
          vec4 mv = modelViewMatrix * vec4(position, 1.0);
          gl_PointSize = size * (260.0 / max(-mv.z, 0.001));
          gl_Position = projectionMatrix * mv;
        }
      `,
      fragmentShader: /* glsl */`
        varying vec3 vColor;
        void main() {
          vec2 d = gl_PointCoord - vec2(0.5);
          float r = dot(d, d);
          if (r > 0.25) discard;
          float a = 1.0 - smoothstep(0.06, 0.25, r);
          gl_FragColor = vec4(vColor, a);
        }
      `,
      vertexColors: true,
      transparent: true,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
    });

    this.points = new THREE.Points(geo, mat);
    this.points.frustumCulled = false;
    this.group.add(this.points);
  }

  spawnParticle(x, y, z, vx, vy, vz, color, life, size, gravity = -9) {
    const i = this.pNext;
    this.pNext = (this.pNext + 1) % this.pCount;
    const i3 = i * 3;

    this.pPos[i3] = x; this.pPos[i3 + 1] = y; this.pPos[i3 + 2] = z;
    this.pVel[i3] = vx; this.pVel[i3 + 1] = vy; this.pVel[i3 + 2] = vz;
    this.pColor[i3] = color.r; this.pColor[i3 + 1] = color.g;
    this.pColor[i3 + 2] = color.b;
    this.pLife[i] = life;
    this.pMax[i] = life;
    this.pSize[i] = size;
    this.pBase[i] = size;
    this.pGravity[i] = gravity;
  }

  // ---- tracers ---------------------------------------------------------

  _initTracers() {
    // A unit cylinder along +Y, scaled and oriented per shot.
    const geo = new THREE.CylinderGeometry(0.022, 0.022, 1, 5, 1, true);
    geo.translate(0, 0.5, 0);   // pivot at the base
    const mat = new THREE.MeshBasicMaterial({
      color: 0xffd98a,
      transparent: true,
      opacity: 0.85,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
    });

    this.tracers = [];
    for (let i = 0; i < MAX_TRACERS; i++) {
      const m = new THREE.Mesh(geo, mat.clone());
      m.visible = false;
      m.frustumCulled = false;
      m.userData.life = 0;
      this.group.add(m);
      this.tracers.push(m);
    }
    this.tracerNext = 0;
    this._up = new THREE.Vector3(0, 1, 0);
    this._dir = new THREE.Vector3();
  }

  tracer(from, to, life = 0.06) {
    const m = this.tracers[this.tracerNext];
    this.tracerNext = (this.tracerNext + 1) % this.tracers.length;

    this._dir.copy(to).sub(from);
    const len = this._dir.length();
    if (len < 1e-4) return;
    this._dir.divideScalar(len);

    m.position.copy(from);
    m.quaternion.setFromUnitVectors(this._up, this._dir);
    m.scale.set(1, len, 1);
    m.visible = true;
    m.material.opacity = 0.85;
    m.userData.life = life;
    m.userData.maxLife = life;
  }

  // ---- muzzle flash ----------------------------------------------------

  _initFlash() {
    this.flash = new THREE.PointLight(0xffcf80, 0, 14, 2);
    this.flash.visible = false;
    this.group.add(this.flash);
    this.flashLife = 0;

    const geo = new THREE.PlaneGeometry(0.5, 0.5);
    this.flashSprite = new THREE.Mesh(geo, new THREE.MeshBasicMaterial({
      color: 0xffe0a0, transparent: true, opacity: 0,
      depthWrite: false, blending: THREE.AdditiveBlending, side: THREE.DoubleSide,
    }));
    this.flashSprite.visible = false;
    this.group.add(this.flashSprite);
  }

  muzzleFlash(pos, dir, scale = 1) {
    this.flash.position.copy(pos);
    this.flash.intensity = 26 * scale;
    this.flash.visible = true;
    this.flashLife = 0.06;

    this.flashSprite.position.copy(pos).addScaledVector(dir, 0.18);
    this.flashSprite.scale.setScalar(scale);
    this.flashSprite.material.opacity = 0.9;
    this.flashSprite.visible = true;

    const c = new THREE.Color(0xffcf80);
    for (let i = 0; i < 5; i++) {
      this.spawnParticle(
        pos.x, pos.y, pos.z,
        dir.x * 7 + (Math.random() - 0.5) * 3,
        dir.y * 7 + (Math.random() - 0.5) * 3,
        dir.z * 7 + (Math.random() - 0.5) * 3,
        c, 0.07, 2.4, -2
      );
    }
  }

  // ---- impacts ---------------------------------------------------------

  impact(pos, normal, kind = "concrete") {
    const palette = {
      concrete: 0xbfc3c8,
      metal: 0xffd98a,
      blood: 0x9b1f1f,
      glass: 0x9fd4e8,
    };
    const color = new THREE.Color(palette[kind] ?? palette.concrete);
    const count = kind === "blood" ? 12 : 8;

    for (let i = 0; i < count; i++) {
      const spread = 3.2;
      this.spawnParticle(
        pos.x, pos.y, pos.z,
        (normal.x + (Math.random() - 0.5)) * spread,
        (normal.y + Math.random() * 0.8) * spread,
        (normal.z + (Math.random() - 0.5)) * spread,
        color,
        0.25 + Math.random() * 0.3,
        kind === "blood" ? 2.6 : 1.8,
        kind === "blood" ? -14 : -9
      );
    }
  }

  explosion(pos, scale = 1) {
    const hot = new THREE.Color(0xffc04a);
    const smoke = new THREE.Color(0x3a3a3e);
    for (let i = 0; i < 46; i++) {
      const a = Math.random() * Math.PI * 2;
      const e = Math.random() * Math.PI - Math.PI / 2;
      const sp = (4 + Math.random() * 12) * scale;
      this.spawnParticle(
        pos.x, pos.y + 0.4, pos.z,
        Math.cos(a) * Math.cos(e) * sp,
        Math.sin(e) * sp + 4,
        Math.sin(a) * Math.cos(e) * sp,
        i % 3 === 0 ? smoke : hot,
        0.5 + Math.random() * 0.7,
        (3 + Math.random() * 4) * scale,
        -5
      );
    }
    this.flash.position.copy(pos);
    this.flash.intensity = 120 * scale;
    this.flash.visible = true;
    this.flashLife = 0.22;
  }

  /** Dust kicked up by a sliding tyre. */
  tyreSmoke(x, y, z, amount) {
    if (Math.random() > amount) return;
    const c = new THREE.Color(0x6a6a70);
    this.spawnParticle(
      x, y + 0.1, z,
      (Math.random() - 0.5) * 1.4, 0.6 + Math.random(),
      (Math.random() - 0.5) * 1.4,
      c, 0.45, 3.2, -0.6
    );
  }

  // ---- per-frame -------------------------------------------------------

  update(dt) {
    const pos = this.pPos, vel = this.pVel, life = this.pLife;
    const size = this.pSize, base = this.pBase, max = this.pMax;
    const grav = this.pGravity;

    for (let i = 0; i < this.pCount; i++) {
      if (life[i] <= 0) {
        if (size[i] !== 0) size[i] = 0;    // park dead particles
        continue;
      }
      life[i] -= dt;
      const i3 = i * 3;
      vel[i3 + 1] += grav[i] * dt;
      pos[i3] += vel[i3] * dt;
      pos[i3 + 1] += vel[i3 + 1] * dt;
      pos[i3 + 2] += vel[i3 + 2] * dt;

      // Bounce off the ground once, then settle.
      if (pos[i3 + 1] < 0.02 && vel[i3 + 1] < 0) {
        pos[i3 + 1] = 0.02;
        vel[i3 + 1] *= -0.32;
        vel[i3] *= 0.6;
        vel[i3 + 2] *= 0.6;
      }

      if (life[i] <= 0) {
        life[i] = 0;
        size[i] = 0;
      } else {
        // Fade from the spawn size, never from last frame's value, or the
        // shrink compounds and every particle vanishes almost immediately.
        size[i] = base[i] * clamp(life[i] / max[i], 0, 1);
      }
    }

    this.points.geometry.attributes.position.needsUpdate = true;
    this.points.geometry.attributes.color.needsUpdate = true;
    this.points.geometry.attributes.size.needsUpdate = true;

    for (const t of this.tracers) {
      if (!t.visible) continue;
      t.userData.life -= dt;
      if (t.userData.life <= 0) {
        t.visible = false;
      } else {
        t.material.opacity = 0.85 * (t.userData.life / t.userData.maxLife);
      }
    }

    if (this.flashLife > 0) {
      this.flashLife -= dt;
      const k = clamp(this.flashLife / 0.06, 0, 1);
      this.flash.intensity *= 0.72;
      this.flashSprite.material.opacity = 0.9 * k;
      if (this.flashLife <= 0) {
        this.flash.visible = false;
        this.flash.intensity = 0;
        this.flashSprite.visible = false;
      }
    }
  }

  /** Billboard the flash sprite; call after the camera has been positioned. */
  faceCamera(camera) {
    if (this.flashSprite.visible) this.flashSprite.quaternion.copy(camera.quaternion);
  }
}
