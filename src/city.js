// Procedural city.
//
// Layout is a square grid of intersections spaced `pitch` apart, taken from
// the asset manifest so the road tiles line up with what Blender authored.
// Each cell between four intersections holds a raised block, and each block
// is subdivided into plots that receive a building, a park or a car park.
//
// Outputs:
//   - batched static geometry under `this.group`
//   - a collision set of building footprints in a spatial hash
//   - a road graph the traffic and police AI drive along

import * as THREE from "three";
import { Batcher } from "./batch.js";
import { Assets } from "./assets.js";
import { Box2, SpatialHash, makeRng, clamp } from "./mathx.js";

const PLOT_MARGIN = 3.0;      // gap from block edge to any building
const PLOT_GAP = 2.0;         // gap between neighbouring buildings

export class City {
  constructor(assets, opts = {}) {
    this.assets = assets;
    this.grid = assets.grid;
    this.size = opts.size || 12;            // intersections per axis
    this.seed = opts.seed ?? 0xC17;
    this.rng = makeRng(this.seed);

    this.pitch = this.grid.block_pitch;
    this.roadW = this.grid.road_w;
    this.segLen = this.grid.seg_len;
    this.curbH = this.grid.curb_h;

    this.extent = (this.size - 1) * this.pitch;

    this.group = new THREE.Group();
    this.group.name = "City";

    this.colliders = [];
    this.hash = new SpatialHash(Math.max(20, this.pitch / 2));

    /** Cell kind per block: 'built' | 'park' | 'parking'. */
    this.cells = [];
    this.lampPositions = [];
    this.stats = null;
  }

  // ---- geometry helpers ------------------------------------------------

  nodePos(i, j) { return { x: i * this.pitch, z: j * this.pitch }; }

  cellCenter(i, j) {
    return { x: (i + 0.5) * this.pitch, z: (j + 0.5) * this.pitch };
  }

  inBounds(x, z) {
    const m = this.roadW * 0.5;
    return x > -m && z > -m && x < this.extent + m && z < this.extent + m;
  }

  /** True when the point lies on carriageway rather than on a block. */
  isRoad(x, z) {
    const half = this.roadW / 2;
    const dx = Math.abs(((x % this.pitch) + this.pitch) % this.pitch);
    const dz = Math.abs(((z % this.pitch) + this.pitch) % this.pitch);
    const nearX = Math.min(dx, this.pitch - dx) <= half;
    const nearZ = Math.min(dz, this.pitch - dz) <= half;
    return nearX || nearZ;
  }

  /** Walk/drive surface height. Blocks sit a kerb above the road. */
  groundHeight(x, z) {
    return this.isRoad(x, z) ? 0 : this.curbH;
  }

  cellAt(x, z) {
    const i = Math.floor(x / this.pitch);
    const j = Math.floor(z / this.pitch);
    if (i < 0 || j < 0 || i >= this.size - 1 || j >= this.size - 1) return null;
    return this.cells[i * (this.size - 1) + j];
  }

  // ---- generation ------------------------------------------------------

  generate() {
    const t0 = (typeof performance !== "undefined" ? performance.now() : Date.now());
    const batcher = new Batcher(this.assets);

    this._measureAssets();
    this._layRoads(batcher);
    this._layBlocks(batcher);
    this._placeProps(batcher);

    const stats = batcher.build(this.group);

    this._buildRoadGraph();
    for (const c of this.colliders) this.hash.insert(c);

    this.stats = {
      ...stats,
      colliders: this.colliders.length,
      cells: this.cells.length,
      lamps: this.lampPositions.length,
      ms: Math.round((typeof performance !== "undefined"
        ? performance.now() : Date.now()) - t0),
    };
    return this.stats;
  }

  /** Footprint of every building asset, so plots can pick something that fits.
   *  Sizes come from the manifest (computed at export) rather than from
   *  instantiating each asset, which keeps generation testable headlessly. */
  _measureAssets() {
    this.buildingSizes = new Map();
    for (const key of this.assets.keysIn("buildings")) {
      const meta = this.assets.metaFor(key);
      const size = meta && meta.bbox
        ? meta.bbox.size
        : (() => {
            const m = Assets.measure(this.assets.instantiate(key)).size;
            return [m.x, m.y, m.z];
          })();
      this.buildingSizes.set(key, { w: size[0], d: size[2], h: size[1] });
    }
    this.buildingKeys = [...this.buildingSizes.keys()];
    // Tall things downtown, low things at the edges.
    this.buildingKeys.sort(
      (a, b) => this.buildingSizes.get(b).h - this.buildingSizes.get(a).h
    );
  }

  _layRoads(batcher) {
    const N = this.size;

    // Ground slab under everything, so gaps never show the void.
    const pad = this.pitch;
    const gx = this.extent / 2, gz = this.extent / 2;
    const g = batcher.add("env_ground",
      new THREE.Vector3(gx, -0.02, gz), 0, this.extent + pad * 2);
    // env_ground is a 1x1 quad, so uniform scale is the world size. The
    // compose() above already applied it.
    void g;

    for (let i = 0; i < N; i++) {
      for (let j = 0; j < N; j++) {
        const p = this.nodePos(i, j);
        batcher.add("env_road_cross", new THREE.Vector3(p.x, 0, p.z));

        // Segment heading +X from this node.
        if (i < N - 1) {
          batcher.add("env_road_seg",
            new THREE.Vector3(p.x + this.pitch / 2, 0, p.z), Math.PI / 2);
        }
        // Segment heading +Z from this node.
        if (j < N - 1) {
          batcher.add("env_road_seg",
            new THREE.Vector3(p.x, 0, p.z + this.pitch / 2), 0);
        }
      }
    }
  }

  _layBlocks(batcher) {
    const N = this.size - 1;
    const mid = (N - 1) / 2;

    for (let i = 0; i < N; i++) {
      for (let j = 0; j < N; j++) {
        const c = this.cellCenter(i, j);
        // Distance from the centre drives density: towers downtown, houses out.
        const d = Math.hypot(i - mid, j - mid) / Math.max(1, mid);
        const roll = this.rng.next();

        let kind = "built";
        if (roll < 0.07) kind = "park";
        else if (roll < 0.12) kind = "parking";

        const cell = { i, j, x: c.x, z: c.z, kind, density: 1 - d };
        this.cells.push(cell);

        if (kind === "park") {
          batcher.add("env_park", new THREE.Vector3(c.x, 0, c.z));
          this._plantPark(batcher, cell);
        } else if (kind === "parking") {
          batcher.add("env_parking", new THREE.Vector3(c.x, 0, c.z));
        } else {
          batcher.add("env_block", new THREE.Vector3(c.x, 0, c.z));
          this._fillPlots(batcher, cell);
        }
      }
    }
  }

  /** Split a block into plots and drop a fitting building into each. */
  _fillPlots(batcher, cell) {
    const usable = this.segLen - PLOT_MARGIN * 2;
    const r = this.rng;

    // Denser centre favours one big footprint; suburbs get several small ones.
    let cols, rows;
    const pick = r.next();
    if (cell.density > 0.62) { cols = 1; rows = 1; }
    else if (pick < 0.3) { cols = 1; rows = 1; }
    else if (pick < 0.65) { cols = 2; rows = 1; }
    else if (pick < 0.85) { cols = 2; rows = 2; }
    else { cols = 1; rows = 2; }

    const plotW = (usable - PLOT_GAP * (cols - 1)) / cols;
    const plotD = (usable - PLOT_GAP * (rows - 1)) / rows;

    for (let a = 0; a < cols; a++) {
      for (let b = 0; b < rows; b++) {
        if (cols * rows > 1 && r.chance(0.12)) continue;   // leave a gap

        const px = cell.x - usable / 2 + plotW / 2 + a * (plotW + PLOT_GAP);
        const pz = cell.z - usable / 2 + plotD / 2 + b * (plotD + PLOT_GAP);

        const rot = r.int(0, 3) * (Math.PI / 2);
        const swapped = rot === Math.PI / 2 || rot === Math.PI * 1.5;
        const availW = swapped ? plotD : plotW;
        const availD = swapped ? plotW : plotD;

        const key = this._pickBuilding(availW, availD, cell.density);
        if (!key) continue;

        const size = this.buildingSizes.get(key);
        batcher.add(key, new THREE.Vector3(px, this.curbH, pz), rot);

        // Collider uses the rotated footprint. Height is carried alongside so
        // bullets and the camera can tell a tower from a bungalow.
        const hw = (swapped ? size.d : size.w) / 2;
        const hd = (swapped ? size.w : size.d) / 2;
        const box = new Box2(px, pz, hw, hd);
        box.height = this.curbH + size.h;
        this.colliders.push(box);
      }
    }
  }

  _pickBuilding(availW, availD, density) {
    const fits = [];
    for (const key of this.buildingKeys) {
      const s = this.buildingSizes.get(key);
      if (s.w <= availW && s.d <= availD) fits.push(key);
    }
    if (!fits.length) return null;

    // Bias toward the tallest that fits when downtown, shortest when not.
    const r = this.rng.next();
    const bias = clamp(density, 0, 1);
    const skew = Math.pow(r, bias > 0.5 ? 2.2 : 0.5);
    const idx = Math.min(fits.length - 1, Math.floor(skew * fits.length));
    return fits[idx];
  }

  _plantPark(batcher, cell) {
    const r = this.rng;
    const half = this.segLen / 2 - 4;
    const n = r.int(5, 9);
    for (let k = 0; k < n; k++) {
      const x = cell.x + r.range(-half, half);
      const z = cell.z + r.range(-half, half);
      // Keep the crossing paths clear.
      if (Math.abs(x - cell.x) < 2.5 || Math.abs(z - cell.z) < 2.5) continue;
      batcher.add("prop_tree", new THREE.Vector3(x, this.curbH, z),
                  r.range(0, Math.PI * 2), r.range(0.85, 1.25));
    }
    for (let k = 0; k < 3; k++) {
      batcher.add("prop_bench",
        new THREE.Vector3(cell.x + r.range(-half, half), this.curbH,
                          cell.z + r.range(-half, half)),
        r.int(0, 3) * (Math.PI / 2));
    }
  }

  _placeProps(batcher) {
    const N = this.size;
    const r = this.rng;
    const inset = this.roadW / 2 + 1.6;   // just inside the kerb

    for (let i = 0; i < N; i++) {
      for (let j = 0; j < N; j++) {
        const p = this.nodePos(i, j);

        // Traffic lights on two opposing corners of each junction.
        const hasEW = i < N - 1 || i > 0;
        const hasNS = j < N - 1 || j > 0;
        if (hasEW && hasNS) {
          batcher.add("prop_trafficlight",
            new THREE.Vector3(p.x - inset, this.curbH, p.z - inset), 0);
          batcher.add("prop_trafficlight",
            new THREE.Vector3(p.x + inset, this.curbH, p.z + inset), Math.PI);
        }

        // Street lighting along each outgoing segment. The lamp stands on
        // the pavement and its arm reaches back over the carriageway, so the
        // rotation is whichever heading points the arm (local -Z) inward.
        if (i < N - 1) {
          for (const t of [0.3, 0.7]) {
            const lx = p.x + this.pitch * t;
            const side = r.chance(0.5) ? 1 : -1;
            const lz = p.z + inset * side;
            // Arm must point toward -side on Z: heading 0 aims -Z.
            batcher.add("prop_streetlight",
              new THREE.Vector3(lx, this.curbH, lz),
              side > 0 ? 0 : Math.PI);
            this.lampPositions.push({ x: lx, y: 6.5, z: lz - 1.85 * side });
          }
        }
        if (j < N - 1) {
          for (const t of [0.3, 0.7]) {
            const lz = p.z + this.pitch * t;
            const side = r.chance(0.5) ? 1 : -1;
            const lx = p.x + inset * side;
            // Heading +PI/2 aims the arm at -X, -PI/2 aims it at +X.
            batcher.add("prop_streetlight",
              new THREE.Vector3(lx, this.curbH, lz),
              side > 0 ? Math.PI / 2 : -Math.PI / 2);
            this.lampPositions.push({ x: lx - 1.85 * side, y: 6.5, z: lz });
          }
        }
      }
    }

    // Street furniture scattered along block edges.
    const furniture = ["prop_bin", "prop_hydrant", "prop_bench",
                       "prop_dumpster", "prop_busstop", "prop_sign",
                       "prop_cone", "prop_barrier"];
    for (const cell of this.cells) {
      if (cell.kind === "park") continue;
      const edge = this.segLen / 2 - 1.4;
      const n = r.int(2, 5);
      for (let k = 0; k < n; k++) {
        const side = r.int(0, 3);
        const along = r.range(-edge + 3, edge - 3);
        let x = cell.x, z = cell.z, rot = 0;
        if (side === 0) { x += along; z -= edge; rot = 0; }
        else if (side === 1) { x += along; z += edge; rot = Math.PI; }
        else if (side === 2) { x -= edge; z += along; rot = Math.PI / 2; }
        else { x += edge; z += along; rot = -Math.PI / 2; }
        batcher.add(r.pick(furniture),
                    new THREE.Vector3(x, this.curbH, z), rot);
      }
      if (r.chance(0.5)) {
        batcher.add("prop_tree",
          new THREE.Vector3(cell.x + r.range(-edge, edge), this.curbH,
                            cell.z + r.range(-edge, edge)),
          r.range(0, Math.PI * 2), r.range(0.8, 1.15));
      }
    }
  }

  /** Intersections and their neighbours, used by every driving AI. */
  _buildRoadGraph() {
    const N = this.size;
    const nodes = [];
    for (let i = 0; i < N; i++) {
      for (let j = 0; j < N; j++) {
        const p = this.nodePos(i, j);
        nodes.push({ i, j, x: p.x, z: p.z, index: i * N + j, links: [] });
      }
    }
    const at = (i, j) => (i < 0 || j < 0 || i >= N || j >= N)
      ? null : nodes[i * N + j];

    for (const n of nodes) {
      for (const [di, dj] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
        const other = at(n.i + di, n.j + dj);
        if (other) n.links.push(other.index);
      }
    }
    this.roadNodes = nodes;
    this.nodeAt = at;
  }

  randomNode() {
    return this.rng.pick(this.roadNodes);
  }

  /** Random point on a carriageway, optionally far from a reference. */
  randomRoadPoint(awayFrom = null, minDist = 0) {
    for (let attempt = 0; attempt < 80; attempt++) {
      const a = this.randomNode();
      const link = this.rng.pick(a.links);
      const b = this.roadNodes[link];
      const t = this.rng.range(0.2, 0.8);
      const x = a.x + (b.x - a.x) * t;
      const z = a.z + (b.z - a.z) * t;
      if (!awayFrom) return { x, z };
      if (Math.hypot(x - awayFrom.x, z - awayFrom.z) > minDist) return { x, z };
    }
    const n = this.roadNodes[0];
    return { x: n.x, z: n.z };
  }

  // ---- collision -------------------------------------------------------

  /**
   * Push a circle out of any building it overlaps.
   * Returns the corrected position and whether anything was hit.
   */
  resolveCircle(x, z, radius) {
    const boxes = this.hash.query(x, z, radius + 1);
    let hit = false;
    let nx = 0, nz = 0;

    for (let i = 0; i < boxes.length; i++) {
      const b = boxes[i];
      const c = b.closest(x, z);
      let dx = x - c.x, dz = z - c.z;
      let d = Math.hypot(dx, dz);

      if (d < radius) {
        hit = true;
        if (d < 1e-5) {
          // Centre is inside the box: escape along the shallowest axis.
          const ox = b.hw - Math.abs(x - b.x);
          const oz = b.hd - Math.abs(z - b.z);
          if (ox < oz) {
            dx = Math.sign(x - b.x) || 1; dz = 0; d = 1;
            x = b.x + dx * (b.hw + radius);
          } else {
            dx = 0; dz = Math.sign(z - b.z) || 1; d = 1;
            z = b.z + dz * (b.hd + radius);
          }
        } else {
          const push = (radius - d) / d;
          x += dx * push;
          z += dz * push;
        }
        nx += dx / (d || 1);
        nz += dz / (d || 1);
      }
    }

    // Keep everything inside the map.
    const lo = -this.roadW / 2 + radius;
    const hi = this.extent + this.roadW / 2 - radius;
    if (x < lo) { x = lo; hit = true; nx += 1; }
    if (x > hi) { x = hi; hit = true; nx -= 1; }
    if (z < lo) { z = lo; hit = true; nz += 1; }
    if (z > hi) { z = hi; hit = true; nz -= 1; }

    const len = Math.hypot(nx, nz) || 1;
    return { x, z, hit, nx: nx / len, nz: nz / len };
  }

  /**
   * Nearest hit along a ray against buildings and the ground plane.
   *
   * Buildings are axis-aligned boxes, so this is a slab test in XZ with a
   * height check, which is both exact and far cheaper than raycasting the
   * scene graph. Candidates come from marching the spatial hash along the ray.
   *
   * Returns { t, nx, ny, nz, kind } or null.
   */
  raycast(ox, oy, oz, dx, dy, dz, maxDist) {
    let best = maxDist;
    let nx = 0, ny = 0, nz = 0;
    let kind = null;

    // Ground. Roads sit at y=0 and pavements a kerb above; testing the lower
    // plane and then confirming the surface height avoids a second trace.
    if (dy < -1e-6) {
      for (const plane of [this.curbH, 0]) {
        const t = (plane - oy) / dy;
        if (t < 0 || t > best) continue;
        const px = ox + dx * t, pz = oz + dz * t;
        if (Math.abs(this.groundHeight(px, pz) - plane) > 1e-6) continue;
        best = t; nx = 0; ny = 1; nz = 0; kind = "ground";
        break;
      }
    }

    const seen = new Set();
    const step = Math.max(4, this.hash.cell * 0.75);
    const samples = Math.ceil(maxDist / step);
    const candidates = [];

    for (let i = 0; i <= samples; i++) {
      const t = Math.min(maxDist, i * step);
      const list = this.hash.query(ox + dx * t, oz + dz * t, step);
      for (const b of list) {
        if (seen.has(b)) continue;
        seen.add(b);
        candidates.push(b);
      }
    }

    for (const b of candidates) {
      let tmin = 0, tmax = best;
      let axis = -1, sign = 1;
      let ok = true;

      for (let a = 0; a < 2 && ok; a++) {
        const o = a === 0 ? ox : oz;
        const d = a === 0 ? dx : dz;
        const c = a === 0 ? b.x : b.z;
        const h = a === 0 ? b.hw : b.hd;
        const lo = c - h, hi = c + h;

        if (Math.abs(d) < 1e-9) {
          if (o < lo || o > hi) ok = false;
          continue;
        }
        let t1 = (lo - o) / d;
        let t2 = (hi - o) / d;
        let s = -1;
        if (t1 > t2) { const tmp = t1; t1 = t2; t2 = tmp; s = 1; }
        if (t1 > tmin) { tmin = t1; axis = a; sign = s; }
        if (t2 < tmax) tmax = t2;
        if (tmin > tmax) ok = false;
      }

      if (!ok || tmin < 0 || tmin >= best) continue;

      const hitY = oy + dy * tmin;
      const top = b.height ?? 1e6;
      if (hitY < 0 || hitY > top) continue;

      best = tmin;
      kind = "building";
      nx = axis === 0 ? sign : 0;
      ny = 0;
      nz = axis === 1 ? sign : 0;
    }

    if (!kind) return null;
    return { t: best, nx, ny, nz, kind };
  }

  /** Cheap yes/no test, for bullets and spawn validation. */
  blocked(x, z, radius = 0.2) {
    const boxes = this.hash.query(x, z, radius + 0.5);
    for (let i = 0; i < boxes.length; i++) {
      if (boxes[i].overlapsCircle(x, z, radius)) return true;
    }
    return !this.inBounds(x, z);
  }
}
