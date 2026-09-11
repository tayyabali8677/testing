// Manifest-driven asset loading.
//
// Everything the engine knows about the model library comes from
// assets/models/manifest.json, which the Blender build writes. Nothing here
// hardcodes an asset name, so regenerating the library with new models makes
// them available without touching engine code.
//
// Drop-in models: any GLB listed in assets/models/custom/index.json is loaded
// alongside the generated ones and can override a generated asset by reusing
// its key. That is how externally generated models (Meshy, Sketchfab, a hand
// export from Blender) get into the game.

import * as THREE from "three";
import { GLTFLoader } from "three/addons/loaders/GLTFLoader.js";

const MODEL_DIR = "assets/models/";

// Window glow and street lamps: lit at night, dark by day.
const NIGHT_MATERIALS = new Set(["BGlassLit", "LampGlow"]);

export class Assets {
  constructor() {
    this.loader = new GLTFLoader();
    this.manifest = null;
    this.templates = new Map();   // key -> { scene, clips, meta }
    this.grid = null;
    // Emissive materials that should only glow after dark. Collected by name
    // because the Blender build controls the naming, and they are shared
    // across every instance, so one write lights the whole city.
    this.nightMaterials = new Map();
  }

  async loadManifest() {
    const res = await fetch(MODEL_DIR + "manifest.json");
    if (!res.ok) {
      throw new Error(
        `Could not read ${MODEL_DIR}manifest.json (HTTP ${res.status}). ` +
        `Run: python3 tools/blender/build_all.py`
      );
    }
    this.manifest = await res.json();
    this.grid = this.manifest.grid;
    return this.manifest;
  }

  /** Optional list of externally supplied models. Missing file is fine. */
  async loadCustomIndex() {
    const dir = this.manifest.custom_dir || "custom";
    try {
      const res = await fetch(`${MODEL_DIR}${dir}/index.json`);
      if (!res.ok) return [];
      const list = await res.json();
      return Array.isArray(list) ? list : (list.assets || []);
    } catch {
      return [];
    }
  }

  _loadGLB(url) {
    return new Promise((resolve, reject) => {
      this.loader.load(url, resolve, undefined, reject);
    });
  }

  async loadAll(onProgress) {
    if (!this.manifest) await this.loadManifest();

    const jobs = [];
    for (const [key, meta] of Object.entries(this.manifest.assets)) {
      jobs.push({ key, url: MODEL_DIR + meta.file, meta });
    }

    for (const entry of await this.loadCustomIndex()) {
      const key = entry.key || entry.file.replace(/\.glb$/i, "");
      const dir = this.manifest.custom_dir || "custom";
      jobs.push({
        key,
        url: `${MODEL_DIR}${dir}/${entry.file}`,
        meta: { ...entry, category: entry.category || "custom", custom: true },
      });
    }

    let done = 0;
    // Sequential-ish batching keeps the progress bar honest without
    // hammering the connection with fifty parallel requests.
    const BATCH = 8;
    for (let i = 0; i < jobs.length; i += BATCH) {
      const slice = jobs.slice(i, i + BATCH);
      await Promise.all(slice.map(async (job) => {
        try {
          const gltf = await this._loadGLB(job.url);
          this._register(job.key, gltf, job.meta);
        } catch (err) {
          console.error(`asset failed: ${job.key} (${job.url})`, err);
        } finally {
          done++;
          if (onProgress) onProgress(done, jobs.length, job.key);
        }
      }));
    }

    return this.templates;
  }

  _register(key, gltf, meta) {
    const scene = gltf.scene;
    scene.name = key;

    scene.traverse((o) => {
      if (!o.isMesh) return;
      o.castShadow = true;
      o.receiveShadow = true;
      // Emissive surfaces are light sources, not shadow casters; letting
      // them cast produces black halos around every lit window.
      const m = o.material;
      if (m && m.emissive && m.emissiveIntensity > 0 &&
          (m.emissive.r + m.emissive.g + m.emissive.b) > 0.05) {
        o.castShadow = false;
      }
      if (m) m.shadowSide = THREE.FrontSide;

      if (m && NIGHT_MATERIALS.has(m.name) && !this.nightMaterials.has(m.name)) {
        this.nightMaterials.set(m.name, {
          material: m,
          full: m.emissiveIntensity ?? 1,
        });
      }
    });

    this.templates.set(key, { scene, clips: gltf.animations || [], meta });
  }

  /** @param night 0 by day, 1 at full dark. */
  setNightLights(night) {
    for (const entry of this.nightMaterials.values()) {
      const want = entry.full * night;
      if (Math.abs(entry.material.emissiveIntensity - want) > 0.01) {
        entry.material.emissiveIntensity = want;
      }
    }
  }

  has(key) { return this.templates.has(key); }

  /** Manifest entry for an asset: nodes, clips, bbox, triangle count. */
  metaFor(key) {
    const t = this.templates.get(key);
    if (t) return t.meta;
    return this.manifest ? this.manifest.assets[key] : null;
  }

  keysIn(category) {
    const out = [];
    for (const [key, t] of this.templates) {
      if (t.meta.category === category) out.push(key);
    }
    return out.sort();
  }

  /**
   * Fresh instance of an asset.
   *
   * Geometry and materials are shared with the template; only the node graph
   * is cloned. Animation clips are handed back unchanged because
   * AnimationMixer binds them to the clone by node name at runtime.
   */
  instantiate(key) {
    const t = this.templates.get(key);
    if (!t) throw new Error(`unknown asset: ${key}`);

    const root = t.scene.clone(true);
    const nodes = new Map();
    root.traverse((o) => { if (o.name) nodes.set(o.name, o); });

    return { key, root, nodes, clips: t.clips, meta: t.meta };
  }

  /** Node lookup that throws loudly rather than returning undefined. */
  static node(inst, name) {
    const n = inst.nodes.get(name);
    if (!n) {
      throw new Error(`asset ${inst.key} has no node "${name}"`);
    }
    return n;
  }

  static maybeNode(inst, name) { return inst.nodes.get(name) || null; }

  /** Bounding box of an instantiated asset, in its own local space. */
  static measure(inst) {
    const box = new THREE.Box3().setFromObject(inst.root);
    const size = new THREE.Vector3();
    const center = new THREE.Vector3();
    box.getSize(size);
    box.getCenter(center);
    return { box, size, center };
  }
}
