// Static geometry batching.
//
// A city places the same ten buildings and eleven props thousands of times.
// Adding each as its own Object3D would mean thousands of draw calls; instead
// every (geometry, material) pair inside an asset becomes one InstancedMesh,
// so the cost scales with how many *kinds* of thing exist, not how many.
//
// The catch is that a mesh sits somewhere inside its asset's node hierarchy,
// so its instance matrix has to be the placement matrix composed with the
// mesh's own transform relative to the asset root.

import * as THREE from "three";

export class Batcher {
  constructor(assets) {
    this.assets = assets;
    this.pending = new Map();   // assetKey -> Matrix4[]
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
   * Realise everything queued into InstancedMeshes under `parent`.
   * Returns stats so the caller can report draw-call counts.
   */
  build(parent) {
    let instancedMeshes = 0;
    let instances = 0;
    const local = new THREE.Matrix4();
    const out = new THREE.Matrix4();

    for (const [key, matrices] of this.pending) {
      if (!matrices.length) continue;
      if (!this.assets.has(key)) {
        console.warn(`batcher: unknown asset "${key}"`);
        continue;
      }

      const template = this.assets.instantiate(key);
      template.root.updateWorldMatrix(true, true);
      const rootInverse = new THREE.Matrix4()
        .copy(template.root.matrixWorld).invert();

      const meshes = [];
      template.root.traverse((o) => { if (o.isMesh) meshes.push(o); });

      for (const mesh of meshes) {
        // Mesh transform relative to the asset root.
        local.copy(rootInverse).multiply(mesh.matrixWorld);

        const inst = new THREE.InstancedMesh(
          mesh.geometry, mesh.material, matrices.length
        );
        inst.name = `${key}:${mesh.name}`;
        inst.castShadow = mesh.castShadow;
        inst.receiveShadow = mesh.receiveShadow;
        // Instances span the whole map, so per-object culling only ever
        // produces false negatives here.
        inst.frustumCulled = false;

        for (let i = 0; i < matrices.length; i++) {
          out.copy(matrices[i]).multiply(local);
          inst.setMatrixAt(i, out);
        }
        inst.instanceMatrix.needsUpdate = true;
        inst.computeBoundingSphere();

        parent.add(inst);
        instancedMeshes++;
        instances += matrices.length;
      }
    }

    this.pending.clear();
    return { instancedMeshes, instances };
  }
}
