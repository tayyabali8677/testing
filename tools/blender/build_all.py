"""
Build every asset and write the manifest.

    python3 tools/blender/build_all.py            # bpy as a pip module
    blender --background --python tools/blender/build_all.py

Writes assets/models/*.glb plus assets/models/manifest.json. The engine reads
only the manifest, so adding an asset here makes it available in game without
touching any JavaScript.
"""

import json
import os
import struct
import sys
import time

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)

import lib as L  # noqa: E402

import build_buildings  # noqa: E402
import build_characters  # noqa: E402
import build_env  # noqa: E402
import build_items  # noqa: E402
import build_props  # noqa: E402
import build_vehicles  # noqa: E402
import build_weapons  # noqa: E402

STAGES = [
    ("environment", build_env),
    ("buildings", build_buildings),
    ("props", build_props),
    ("vehicles", build_vehicles),
    ("weapons", build_weapons),
    ("characters", build_characters),
    ("items", build_items),
]

CATEGORY_BY_PREFIX = {
    "env_": "environment",
    "bld_": "buildings",
    "prop_": "props",
    "veh_": "vehicles",
    "wpn_": "weapons",
    "char_": "characters",
    "item_": "items",
}


def _mat_mul(a, b):
    """Column-major 4x4 multiply, matching glTF's matrix layout."""
    out = [0.0] * 16
    for c in range(4):
        for r in range(4):
            out[c * 4 + r] = sum(a[k * 4 + r] * b[c * 4 + k] for k in range(4))
    return out


def _mat_from_node(node):
    if "matrix" in node:
        return list(node["matrix"])

    t = node.get("translation", [0.0, 0.0, 0.0])
    r = node.get("rotation", [0.0, 0.0, 0.0, 1.0])   # xyzw
    s = node.get("scale", [1.0, 1.0, 1.0])

    x, y, z, w = r
    xx, yy, zz = x * x, y * y, z * z
    xy, xz, yz = x * y, x * z, y * z
    wx, wy, wz = w * x, w * y, w * z

    # Rotation columns, scaled.
    return [
        (1 - 2 * (yy + zz)) * s[0], (2 * (xy + wz)) * s[0], (2 * (xz - wy)) * s[0], 0.0,
        (2 * (xy - wz)) * s[1], (1 - 2 * (xx + zz)) * s[1], (2 * (yz + wx)) * s[1], 0.0,
        (2 * (xz + wy)) * s[2], (2 * (yz - wx)) * s[2], (1 - 2 * (xx + yy)) * s[2], 0.0,
        t[0], t[1], t[2], 1.0,
    ]


def _xform(m, p):
    return (
        m[0] * p[0] + m[4] * p[1] + m[8] * p[2] + m[12],
        m[1] * p[0] + m[5] * p[1] + m[9] * p[2] + m[13],
        m[2] * p[0] + m[6] * p[1] + m[10] * p[2] + m[14],
    )


def _bbox(gltf):
    """World-space bounds, from each primitive's POSITION accessor min/max.

    Transforming the eight corners of a local box is a slight over-estimate
    under rotation, but every asset here is axis-aligned at export, and an
    over-estimate is the safe direction for plot fitting anyway.
    """
    nodes = gltf.get("nodes", [])
    meshes = gltf.get("meshes", [])
    accessors = gltf.get("accessors", [])

    lo = [float("inf")] * 3
    hi = [float("-inf")] * 3
    found = False

    def walk(index, parent):
        nonlocal found
        node = nodes[index]
        world = _mat_mul(parent, _mat_from_node(node))

        if "mesh" in node and node["mesh"] < len(meshes):
            for prim in meshes[node["mesh"]].get("primitives", []):
                pos = prim.get("attributes", {}).get("POSITION")
                if pos is None or pos >= len(accessors):
                    continue
                acc = accessors[pos]
                amin, amax = acc.get("min"), acc.get("max")
                if not amin or not amax:
                    continue
                found = True
                for cx in (amin[0], amax[0]):
                    for cy in (amin[1], amax[1]):
                        for cz in (amin[2], amax[2]):
                            p = _xform(world, (cx, cy, cz))
                            for k in range(3):
                                lo[k] = min(lo[k], p[k])
                                hi[k] = max(hi[k], p[k])

        for child in node.get("children", []):
            walk(child, world)

    identity = [1.0, 0, 0, 0, 0, 1.0, 0, 0, 0, 0, 1.0, 0, 0, 0, 0, 1.0]
    scene = gltf.get("scenes", [{}])[gltf.get("scene", 0)]
    for root in scene.get("nodes", []):
        walk(root, identity)

    if not found:
        return dict(min=[0, 0, 0], max=[0, 0, 0], size=[0, 0, 0])

    return dict(
        min=[round(v, 4) for v in lo],
        max=[round(v, 4) for v in hi],
        size=[round(hi[k] - lo[k], 4) for k in range(3)],
    )


def inspect_glb(path):
    """Pull node names, clips, bounds and triangle count out of the GLB."""
    with open(path, "rb") as f:
        data = f.read()
    chunk_len = struct.unpack("<I", data[12:16])[0]
    gltf = json.loads(data[20:20 + chunk_len])

    nodes = [n.get("name", "") for n in gltf.get("nodes", [])]
    clips = [a.get("name", "") for a in gltf.get("animations", [])]
    accessors = gltf.get("accessors", [])
    tris = 0
    for mesh in gltf.get("meshes", []):
        for prim in mesh.get("primitives", []):
            idx = prim.get("indices")
            if idx is not None and idx < len(accessors):
                tris += accessors[idx].get("count", 0) // 3

    return dict(nodes=nodes, clips=clips, tris=tris, bytes=len(data),
                bbox=_bbox(gltf))


def write_manifest():
    out_dir = L.OUT_DIR
    files = sorted(f for f in os.listdir(out_dir)
                   if f.endswith(".glb") and not f.startswith("_"))

    assets = {}
    by_category = {}

    for fn in files:
        info = inspect_glb(os.path.join(out_dir, fn))
        key = fn[:-4]
        category = "misc"
        for prefix, cat in CATEGORY_BY_PREFIX.items():
            if fn.startswith(prefix):
                category = cat
                break
        info["file"] = fn
        info["category"] = category
        assets[key] = info
        by_category.setdefault(category, []).append(key)

    manifest = dict(
        generated=time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
        # Authored grid dimensions. The city generator must use these or the
        # road tiles will not line up.
        grid=build_env.GRID,
        categories={k: sorted(v) for k, v in by_category.items()},
        assets=assets,
        totals=dict(
            count=len(assets),
            tris=sum(a["tris"] for a in assets.values()),
            bytes=sum(a["bytes"] for a in assets.values()),
        ),
        # Anything dropped in assets/models/custom/ is loaded too. That is
        # where externally generated models (Meshy and friends) go.
        custom_dir="custom",
    )

    path = os.path.join(out_dir, "manifest.json")
    with open(path, "w") as f:
        json.dump(manifest, f, indent=2)
    return manifest, path


def main():
    t0 = time.time()
    print("=" * 60)
    print("Liberty Grid asset build")
    print("=" * 60)

    only = sys.argv[1:] or None
    for name, module in STAGES:
        if only and name not in only:
            continue
        module.main()

    manifest, path = write_manifest()

    print("=" * 60)
    for cat in sorted(manifest["categories"]):
        keys = manifest["categories"][cat]
        tris = sum(manifest["assets"][k]["tris"] for k in keys)
        print(f"  {cat:<14} {len(keys):>3} assets  {tris:>7} tris")
    t = manifest["totals"]
    print("-" * 60)
    print(f"  {'TOTAL':<14} {t['count']:>3} assets  {t['tris']:>7} tris  "
          f"{t['bytes']/1024/1024:.2f} MB")
    print(f"  manifest -> {os.path.relpath(path, L.ROOT)}")
    print(f"  built in {time.time() - t0:.1f}s")


if __name__ == "__main__":
    main()
