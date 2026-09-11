// Renderer, lighting, sky and the day/night cycle.

import * as THREE from "three";
import { clamp, lerp } from "./mathx.js";

const SKY_VERT = /* glsl */`
  varying vec3 vWorld;
  void main() {
    vWorld = (modelMatrix * vec4(position, 1.0)).xyz;
    gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
  }
`;

// Three-stop vertical gradient plus a cheap sun disc. Cheaper and far more
// controllable than a physical sky model, and it matches the stylised look.
const SKY_FRAG = /* glsl */`
  uniform vec3 uTop, uMid, uBottom, uSunColor;
  uniform vec3 uSunDir;
  uniform float uSunSize;
  varying vec3 vWorld;

  void main() {
    vec3 dir = normalize(vWorld);
    float h = clamp(dir.y * 0.5 + 0.5, 0.0, 1.0);
    vec3 col = h < 0.5
      ? mix(uBottom, uMid, smoothstep(0.0, 0.5, h))
      : mix(uMid, uTop, smoothstep(0.5, 1.0, h));

    float d = max(dot(dir, normalize(uSunDir)), 0.0);
    col += uSunColor * pow(d, uSunSize) * 1.6;
    col += uSunColor * pow(d, 4.0) * 0.12;

    gl_FragColor = vec4(col, 1.0);
  }
`;

// Key points in the daily cycle. `t` is 0..1 across 24 hours, 0.5 is noon.
const SKY_KEYS = [
  { t: 0.00, top: 0x05070f, mid: 0x0a1020, bot: 0x11172a, sun: 0x223055,
    amb: 0x1a2340, ambI: 0.28, sunI: 0.06, fog: 0x0a0f1c, night: 1.0 },
  { t: 0.22, top: 0x2b3f63, mid: 0x6b5570, bot: 0xc07a54, sun: 0xffb066,
    amb: 0x50506f, ambI: 0.55, sunI: 0.75, fog: 0x8a6a66, night: 0.45 },
  { t: 0.30, top: 0x3f74b8, mid: 0x8fb2d6, bot: 0xd6c4a8, sun: 0xffd9a0,
    amb: 0x8fa4c0, ambI: 0.8, sunI: 1.5, fog: 0xb8c6d6, night: 0.0 },
  { t: 0.50, top: 0x2f78c8, mid: 0x86b6e2, bot: 0xcfe0ee, sun: 0xfff4e0,
    amb: 0x9fb8d4, ambI: 0.95, sunI: 2.1, fog: 0xc3d4e4, night: 0.0 },
  { t: 0.72, top: 0x3a6fae, mid: 0x9a9ec2, bot: 0xe0a878, sun: 0xffc890,
    amb: 0x8c93b0, ambI: 0.78, sunI: 1.3, fog: 0xbcaeb0, night: 0.0 },
  { t: 0.80, top: 0x22304e, mid: 0x5d4a66, bot: 0xb06848, sun: 0xff9a55,
    amb: 0x43486a, ambI: 0.5, sunI: 0.5, fog: 0x6e5a60, night: 0.6 },
  { t: 1.00, top: 0x05070f, mid: 0x0a1020, bot: 0x11172a, sun: 0x223055,
    amb: 0x1a2340, ambI: 0.28, sunI: 0.06, fog: 0x0a0f1c, night: 1.0 },
];

function sampleKeys(t) {
  t = ((t % 1) + 1) % 1;
  let a = SKY_KEYS[0], b = SKY_KEYS[SKY_KEYS.length - 1];
  for (let i = 0; i < SKY_KEYS.length - 1; i++) {
    if (t >= SKY_KEYS[i].t && t <= SKY_KEYS[i + 1].t) {
      a = SKY_KEYS[i]; b = SKY_KEYS[i + 1];
      break;
    }
  }
  const span = b.t - a.t;
  const k = span <= 0 ? 0 : (t - a.t) / span;
  const mixC = (ca, cb) => new THREE.Color(ca).lerp(new THREE.Color(cb), k);
  return {
    top: mixC(a.top, b.top),
    mid: mixC(a.mid, b.mid),
    bot: mixC(a.bot, b.bot),
    sun: mixC(a.sun, b.sun),
    amb: mixC(a.amb, b.amb),
    ambI: lerp(a.ambI, b.ambI, k),
    sunI: lerp(a.sunI, b.sunI, k),
    fog: mixC(a.fog, b.fog),
    night: lerp(a.night, b.night, k),
  };
}

export class World {
  constructor(canvas, opts = {}) {
    this.renderer = new THREE.WebGLRenderer({
      canvas,
      antialias: opts.antialias !== false,
      powerPreference: "high-performance",
    });
    this.renderer.setPixelRatio(Math.min(devicePixelRatio || 1, 2));
    this.renderer.shadowMap.enabled = true;
    this.renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
    this.renderer.toneMappingExposure = 1.05;
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;

    this.scene = new THREE.Scene();
    this.camera = new THREE.PerspectiveCamera(62, 1, 0.3, 3000);
    this.camera.position.set(0, 8, 14);

    this.viewDistance = opts.viewDistance || 420;
    this.scene.fog = new THREE.Fog(0xc3d4e4, this.viewDistance * 0.35,
                                   this.viewDistance);

    // ---- lighting ------------------------------------------------------
    this.ambient = new THREE.HemisphereLight(0x9fb8d4, 0x40444c, 0.9);
    this.scene.add(this.ambient);

    this.sun = new THREE.DirectionalLight(0xfff4e0, 2.1);
    this.sun.castShadow = true;
    this.sun.shadow.mapSize.set(opts.shadowMap || 2048, opts.shadowMap || 2048);
    this.sun.shadow.bias = -0.0009;
    this.sun.shadow.normalBias = 0.035;
    const s = opts.shadowExtent || 110;
    const cam = this.sun.shadow.camera;
    cam.left = -s; cam.right = s; cam.top = s; cam.bottom = -s;
    cam.near = 1; cam.far = 520;
    cam.updateProjectionMatrix();
    this.scene.add(this.sun);
    this.scene.add(this.sun.target);

    // ---- sky -----------------------------------------------------------
    this.skyUniforms = {
      uTop: { value: new THREE.Color(0x2f78c8) },
      uMid: { value: new THREE.Color(0x86b6e2) },
      uBottom: { value: new THREE.Color(0xcfe0ee) },
      uSunColor: { value: new THREE.Color(0xfff4e0) },
      uSunDir: { value: new THREE.Vector3(0.4, 0.6, 0.2) },
      uSunSize: { value: 900.0 },
    };
    this.sky = new THREE.Mesh(
      new THREE.SphereGeometry(1600, 24, 16),
      new THREE.ShaderMaterial({
        uniforms: this.skyUniforms,
        vertexShader: SKY_VERT,
        fragmentShader: SKY_FRAG,
        side: THREE.BackSide,
        depthWrite: false,
        fog: false,
      })
    );
    this.sky.frustumCulled = false;
    this.scene.add(this.sky);

    // Time of day, 0..1. Start mid-afternoon.
    this.timeOfDay = opts.timeOfDay ?? 0.42;
    this.dayLength = opts.dayLength || 480;   // seconds per in-game day
    this.night = 0;
    this.paused = false;

    this._resize = () => this.resize();
    addEventListener("resize", this._resize);
    this.resize();
    this.setTimeOfDay(this.timeOfDay);
  }

  resize() {
    const w = innerWidth, h = innerHeight;
    this.renderer.setSize(w, h, false);
    this.camera.aspect = w / Math.max(1, h);
    this.camera.updateProjectionMatrix();
  }

  setTimeOfDay(t) {
    this.timeOfDay = ((t % 1) + 1) % 1;
    const k = sampleKeys(this.timeOfDay);

    this.skyUniforms.uTop.value.copy(k.top);
    this.skyUniforms.uMid.value.copy(k.mid);
    this.skyUniforms.uBottom.value.copy(k.bot);
    this.skyUniforms.uSunColor.value.copy(k.sun);

    // Sun arcs east to west, never quite overhead so shadows stay readable.
    const ang = (this.timeOfDay - 0.25) * Math.PI * 2;
    const elev = Math.sin(ang);
    const dir = new THREE.Vector3(Math.cos(ang) * 0.85, Math.max(elev, -0.4),
                                  0.38).normalize();
    this.skyUniforms.uSunDir.value.copy(dir);
    this.sunDir = dir;

    this.sun.color.copy(k.sun);
    this.sun.intensity = k.sunI;
    this.ambient.color.copy(k.amb);
    this.ambient.groundColor.setHex(0x3a3e46);
    this.ambient.intensity = k.ambI;

    this.scene.fog.color.copy(k.fog);
    this.renderer.setClearColor(k.fog);
    this.night = k.night;
  }

  /** Keep the shadow frustum tight around wherever the action is. */
  focusShadows(x, y, z) {
    const d = this.sunDir || new THREE.Vector3(0.5, 0.8, 0.3);
    this.sun.target.position.set(x, y, z);
    this.sun.position.set(x + d.x * 180, y + d.y * 180 + 40, z + d.z * 180);
    this.sun.target.updateMatrixWorld();
  }

  update(dt) {
    if (!this.paused && this.dayLength > 0) {
      this.setTimeOfDay(this.timeOfDay + dt / this.dayLength);
    }
    this.sky.position.copy(this.camera.position);
  }

  render() {
    this.renderer.render(this.scene, this.camera);
  }

  dispose() {
    removeEventListener("resize", this._resize);
    this.renderer.dispose();
  }
}
