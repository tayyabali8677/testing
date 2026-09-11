// A stand-in for Assets that needs no WebGL and no GLTFLoader.
//
// It reads the real manifest.json, so tests exercise the actual asset
// dimensions the Blender build produced, but substitutes a plain box mesh for
// each model. That is enough for the city generator, the batcher and every
// collision path, none of which care what the geometry looks like.

import * as THREE from "three";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

export class MockAssets {
  constructor() {
    this.manifest = JSON.parse(
      readFileSync(join(ROOT, "assets/models/manifest.json"), "utf8")
    );
    this.grid = this.manifest.grid;
    this.templates = new Map();

    const geo = new THREE.BoxGeometry(1, 1, 1);
    const mat = new THREE.MeshStandardMaterial();

    for (const [key, meta] of Object.entries(this.manifest.assets)) {
      const size = (meta.bbox && meta.bbox.size) || [1, 1, 1];
      const min = (meta.bbox && meta.bbox.min) || [0, 0, 0];

      const root = new THREE.Group();
      root.name = key;

      const mesh = new THREE.Mesh(geo, mat);
      mesh.name = "Body";
      mesh.scale.set(
        Math.max(size[0], 0.01),
        Math.max(size[1], 0.01),
        Math.max(size[2], 0.01)
      );
      // Keep the box where the real model sits relative to its origin.
      mesh.position.set(
        min[0] + size[0] / 2,
        min[1] + size[1] / 2,
        min[2] + size[2] / 2
      );
      root.add(mesh);

      // Reproduce the marker nodes the engine looks up by name.
      for (const nodeName of meta.nodes || []) {
        if (root.getObjectByName(nodeName)) continue;
        const o = new THREE.Object3D();
        o.name = nodeName;
        root.add(o);
      }

      this.templates.set(key, { scene: root, clips: [], meta });
    }
  }

  has(key) { return this.templates.has(key); }
  metaFor(key) {
    const t = this.templates.get(key);
    return t ? t.meta : null;
  }

  keysIn(category) {
    const out = [];
    for (const [key, t] of this.templates) {
      if (t.meta.category === category) out.push(key);
    }
    return out.sort();
  }

  instantiate(key) {
    const t = this.templates.get(key);
    if (!t) throw new Error(`unknown asset: ${key}`);
    const root = t.scene.clone(true);
    const nodes = new Map();
    root.traverse((o) => { if (o.name) nodes.set(o.name, o); });
    return { key, root, nodes, clips: t.clips, meta: t.meta };
  }
}
