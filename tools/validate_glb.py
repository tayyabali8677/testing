#!/usr/bin/env python3
"""
Validate exported GLB files without needing Blender.

Parses the container and JSON chunk directly, then asserts that each asset
carries the node names and animation clips the engine relies on. Run it after
every asset build:

    python3 tools/validate_glb.py
"""

import json
import os
import struct
import sys

ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), ".."))
MODELS = os.path.join(ROOT, "assets", "models")

# What the engine expects to find inside each family of asset.
CONTRACTS = {
    "veh_": dict(
        nodes=["Root", "Body", "Glass", "Wheel_FL", "Wheel_FR",
               "Wheel_RL", "Wheel_RR", "Headlight_L", "Taillight_L", "Seat"],
        clips=[],
    ),
    "wpn_": dict(nodes=["Root", "Muzzle"], clips=[]),
    "char_": dict(
        nodes=["Root", "Hips", "Spine", "Head",
               "Arm_L", "Arm_R", "Leg_L", "Leg_R", "Hand_R"],
        clips=["Idle", "Walk", "Run"],
    ),
    "bld_": dict(nodes=["Root"], clips=[]),
    "prop_": dict(nodes=["Root"], clips=[]),
    "env_": dict(nodes=["Root"], clips=[]),
    "item_": dict(nodes=["Root"], clips=[]),
}


def read_glb(path):
    with open(path, "rb") as f:
        data = f.read()
    if data[:4] != b"glTF":
        raise ValueError("not a GLB container")
    version, total = struct.unpack("<II", data[4:12])
    if total != len(data):
        raise ValueError(f"declared length {total} != actual {len(data)}")
    chunk_len, chunk_type = struct.unpack("<II", data[12:20])
    if chunk_type != 0x4E4F534A:
        raise ValueError("first chunk is not JSON")
    gltf = json.loads(data[20:20 + chunk_len])
    return gltf, len(data)


def summarise(gltf):
    nodes = [n.get("name", "") for n in gltf.get("nodes", [])]
    clips = [a.get("name", "") for a in gltf.get("animations", [])]
    mats = [m.get("name", "") for m in gltf.get("materials", [])]
    tris = 0
    accessors = gltf.get("accessors", [])
    for mesh in gltf.get("meshes", []):
        for prim in mesh.get("primitives", []):
            idx = prim.get("indices")
            if idx is not None and idx < len(accessors):
                tris += accessors[idx].get("count", 0) // 3
    return nodes, clips, mats, tris


def contract_for(name):
    for prefix, rules in CONTRACTS.items():
        if name.startswith(prefix):
            return prefix, rules
    return None, None


def main():
    if not os.path.isdir(MODELS):
        print(f"no model directory at {MODELS}")
        return 1

    files = sorted(f for f in os.listdir(MODELS)
                   if f.endswith(".glb") and not f.startswith("_"))
    if not files:
        print("no .glb files found")
        return 1

    failures = []
    total_tris = 0
    total_bytes = 0

    print(f"{'asset':<26}{'tris':>7}{'KB':>8}  nodes/clips")
    print("-" * 78)

    for fn in files:
        path = os.path.join(MODELS, fn)
        try:
            gltf, size = read_glb(path)
        except Exception as exc:
            failures.append(f"{fn}: unreadable ({exc})")
            print(f"{fn:<26}{'--':>7}{'--':>8}  BROKEN: {exc}")
            continue

        nodes, clips, mats, tris = summarise(gltf)
        total_tris += tris
        total_bytes += size

        prefix, rules = contract_for(fn)
        note = ""
        if rules is None:
            note = "no contract (skipped)"
        else:
            missing_nodes = [n for n in rules["nodes"] if n not in nodes]
            missing_clips = [c for c in rules["clips"] if c not in clips]
            if missing_nodes:
                failures.append(f"{fn}: missing nodes {missing_nodes}")
            if missing_clips:
                failures.append(f"{fn}: missing clips {missing_clips}")
            note = f"{len(nodes)} nodes, {len(mats)} mats"
            if clips:
                note += f", clips={clips}"
            if missing_nodes or missing_clips:
                note += "  <-- FAIL"

        print(f"{fn:<26}{tris:>7}{size/1024:>8.1f}  {note}")

    print("-" * 78)
    print(f"{'TOTAL':<26}{total_tris:>7}{total_bytes/1024:>8.1f} KB  "
          f"({len(files)} assets)")

    if failures:
        print("\nFAILURES:")
        for f in failures:
            print("  " + f)
        return 1

    print("\nall assets valid")
    return 0


if __name__ == "__main__":
    sys.exit(main())
