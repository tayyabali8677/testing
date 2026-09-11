// Static geometry batching.
//
// A city places the same ten buildings and eleven props thousands of times.
// Two separate costs have to be controlled:
//
//   Draw calls. An asset arrives as a node hierarchy with a mesh per part: a
//   bench is nine meshes for two materials. Parts of a static asset that share
//   a material are merged into a single geometry first, with each part's own
//   transform baked in, so the bench costs two draws rather than nine.
//
//   Submitted geometry. One InstancedMesh spanning the whole map must disable
//   frustum culling, because its bounds always contain the camera, so every
//   building in the city is submitted every frame including the ones behind
//   you. Instances are therefore grouped into spatial chunks that can be
//   culled individually.

import * as THREE from "three";
import { mergeGeometries } from "three/addons/utils/BufferGeometryUtils.js";

export class Batcher {
  constructor(assets) {
    this.assets = assets;
    this.pending = new Map();   // assetKey -> Matrix4[]
    this._merged = new Map();   // assetKey -> [{ geometry, material, castShadow }]
  }

  /** Queue one placement of `key` at the given transform. */
  add(key, position, rotationY = 0, scale = 1) {
    const m = new THREE.Matrix4();
    m.compose(
      position instanceof THREE.Vector3
        ? position
        : new THREE.Vector3(position.x, position.y, position.z),
      new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), rotationY),
      new THREE.Vector3(scale, scale, scale)
    );
    let list = this.pending.get(key);
    if (!list) { list = []; this.pending.set(key, list); }
    list.push(m);
    return m;
  }

  count(key) { return (this.pending.get(key) || []).length; }

  /**
   * Flatten an asset to one geometry per material, with every part's local
   * transform baked in. Cached, since an asset is placed many times.
   */
  _flatten(key) {
    if (this._merged.has(key)) return this._merged.get(key);

    const template = this.assets.instantiate(key);
    template.root.updateWorldMatrix(true, true);
    const rootInverse = new THREE.Matrix4()
      .copy(template.root.matrixWorld).invert();

    const groups = new Map();   // material uuid -> { material, geometries, cast, receive }
    const local = new THREE.Matrix4();

    template.root.traverse((o) => {
      if (!o.isMesh || !o.geometry) return;
      // Multi-material meshes would need geometry groups preserved; the
      // generated assets never produce them, so one material per mesh holds.
      const material = Array.isArray(o.material) ? o.material[0] : o.material;
      if (!material) return;

      local.copy(rootInverse).multiply(o.matrixWorld);
      const geo = o.geometry.clone();
      geo.applyMatrix4(local);
      // Merging requires identical attribute sets; drop anything exotic.
      for (const name of Object.keys(geo.attributes)) {
        if (!["position", "normal", "uv"].includes(name)) {
          geo.deleteAttribute(name);
        }
      }
      if (!geo.attributes.uv) {
        const count = geo.attributes.position.count;
        geo.setAttribute("uv",
          new THREE.BufferAttribute(new Float32Array(count * 2), 2));
      }
      if (!geo.index) {
        // mergeGeometries needs all inputs indexed or all non-indexed.
        const count = geo.attributes.position.count;
        const idx = new Uint32Array(count);
        for (let i = 0; i < count; i++) idx[i] = i;
        geo.setIndex(new THREE.BufferAttribute(idx, 1));
      }

      let g = groups.get(material.uuid);
      if (!g) {
        g = { material, geometries: [], cast: false, receive: false };
        groups.set(material.uuid, g);
      }
      g.geometries.push(geo);
      g.cast = g.cast || o.castShadow;
      g.receive = g.receive || o.receiveShadow;
    });

    const parts = [];
    for (const g of groups.values()) {
      let geometry = g.geometries[0];
      if (g.geometries.length > 1) {
        const merged = mergeGeometries(g.geometries, false);
        if (merged) {
          geometry = merged;
          for (const old of g.geometries) old.dispose();
        } else {
          // Attribute mismatch: keep the parts separate rather than fail.
          console.warn(`batcher: could not merge parts of "${key}"`);
          for (const geo of g.geometries) {
            parts.push({ geometry: geo, material: g.material,
                         cast: g.cast, receive: g.receive });
          }
          continue;
        }
      }
      parts.push({ geometry, material: g.material,
                   cast: g.cast, receive: g.receive });
    }

    this._merged.set(key, parts);
    return parts;
  }

  /**
   * Realise everything queued into InstancedMeshes under `parent`.
   * Returns stats so the caller can report draw-call counts.
   */
  build(parent, chunkSize = 200) {
    let instancedMeshes = 0;
    let instances = 0;
    let chunks = 0;
    const pos = new THREE.Vector3();

    for (const [key, matrices] of this.pending) {
      if (!matrices.length) continue;
      if (!this.assets.has(key)) {
        console.warn(`batcher: unknown asset "${key}"`);
        continue;
      }

      const parts = this._flatten(key);
      if (!parts.length) continue;

      // Bucket placements into chunks so each can be culled on its own.
      const buckets = new Map();
      for (const m of matrices) {
        pos.setFromMatrixPosition(m);
        const id = `${Math.floor(pos.x / chunkSize)},${Math.floor(pos.z / chunkSize)}`;
        let list = buckets.get(id);
        if (!list) { list = []; buckets.set(id, list); }
        list.push(m);
      }
      chunks += buckets.size;

      for (const part of parts) {
        for (const [id, list] of buckets) {
          const inst = new THREE.InstancedMesh(
            part.geometry, part.material, list.length
          );
          inst.name = `${key}@${id}`;
          inst.castShadow = part.cast;
          inst.receiveShadow = part.receive;

          for (let i = 0; i < list.length; i++) inst.setMatrixAt(i, list[i]);
          inst.instanceMatrix.needsUpdate = true;
          inst.computeBoundingSphere();

          parent.add(inst);
          instancedMeshes++;
          instances += list.length;
        }
      }
    }

    this.pending.clear();
    return { instancedMeshes, instances, chunks };
  }
}
