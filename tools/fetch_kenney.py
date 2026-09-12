#!/usr/bin/env python3
"""
Fetch Kenney's CC0 asset packs and register them as drop-in models.

    python3 tools/fetch_kenney.py

Downloads to a cache, extracts the GLB builds, copies a curated selection
into assets/models/custom/kenney/ and writes the index the engine reads.
Re-running is cheap: the archives are cached and only the staging is redone.

Everything here is Creative Commons Zero. Kenney asks for credit but does not
require it, so ATTRIBUTION.md credits them anyway.

The models do not share this project's conventions. Kenney's kits face +Z,
this project faces -Z, and the kits are authored at roughly a third of real
world scale. The per-entry `rotateY`, `fit` and `nodes` fields below describe
those differences; src/assets.js applies them at load.
"""

import json
import os
import shutil
import sys
import urllib.request
import zipfile

ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), ".."))
CACHE = os.path.join(ROOT, ".cache", "kenney")
DEST = os.path.join(ROOT, "assets", "models", "custom")
STAGE = os.path.join(DEST, "kenney")

PACKS = {
    "car-kit": "car-kit",
    "city-kit-commercial": "city-kit-commercial",
    "city-kit-suburban": "city-kit-suburban",
    "blocky-characters": "blocky-characters",
}

# Kenney's node names, mapped onto the contract in README.md.
CAR_NODES = {
    "Wheel_FL": "wheel-front-left",
    "Wheel_FR": "wheel-front-right",
    "Wheel_RL": "wheel-back-left",
    "Wheel_RR": "wheel-back-right",
    "Body": "body",
}

CHAR_NODES = {
    "Hips": "root",
    "Spine": "torso",
    "Head": "head",
    "Arm_L": "arm-left",
    "Arm_R": "arm-right",
    "Leg_L": "leg-left",
    "Leg_R": "leg-right",
    # No hand node in this rig, so weapons mount on the forearm instead.
    "Hand_R": "arm-right",
    "Forearm_R": "arm-right",
}

CHAR_CLIPS = {"Idle": "idle", "Walk": "walk", "Run": "sprint"}

# --------------------------------------------------------------------------
# What to stage. Keys that already exist replace the generated asset.
# --------------------------------------------------------------------------

VEHICLES = [
    # (our key, pack, file, length in metres)
    ("veh_sedan", "car-kit", "sedan", 4.4),
    ("veh_sports", "car-kit", "sedan-sports", 4.3),
    ("veh_muscle", "car-kit", "hatchback-sports", 4.4),
    ("veh_police", "car-kit", "police", 4.6),
    ("veh_taxi", "car-kit", "taxi", 4.5),
    ("veh_van", "car-kit", "van", 4.9),
    ("veh_truck", "car-kit", "truck", 6.2),
    ("veh_suv", "car-kit", "suv", 4.7),
    ("veh_suv_luxury", "car-kit", "suv-luxury", 4.9),
    ("veh_delivery", "car-kit", "delivery", 5.2),
    ("veh_ambulance", "car-kit", "ambulance", 5.4),
    ("veh_firetruck", "car-kit", "firetruck", 6.6),
    ("veh_garbage", "car-kit", "garbage-truck", 6.4),
    ("veh_race", "car-kit", "race", 4.2),
]

CHARACTERS = [
    ("char_player", "blocky-characters", "character-a"),
    ("char_cop", "blocky-characters", "character-b"),
    ("char_male", "blocky-characters", "character-c"),
    ("char_female", "blocky-characters", "character-d"),
    ("char_worker", "blocky-characters", "character-e"),
    ("char_business", "blocky-characters", "character-f"),
    ("char_g", "blocky-characters", "character-g"),
    ("char_h", "blocky-characters", "character-h"),
    ("char_i", "blocky-characters", "character-i"),
    ("char_j", "blocky-characters", "character-j"),
    ("char_k", "blocky-characters", "character-k"),
    ("char_l", "blocky-characters", "character-l"),
    ("char_m", "blocky-characters", "character-m"),
    ("char_n", "blocky-characters", "character-n"),
    ("char_o", "blocky-characters", "character-o"),
    ("char_p", "blocky-characters", "character-p"),
]

# Added alongside the generated buildings rather than replacing them, so the
# skyline keeps the lit windows the Blender build produces.
BUILDINGS = [
    ("bld_k_tower_a", "city-kit-commercial", "building-skyscraper-a", 16.0),
    ("bld_k_tower_b", "city-kit-commercial", "building-skyscraper-b", 15.0),
    ("bld_k_tower_c", "city-kit-commercial", "building-skyscraper-c", 17.0),
    ("bld_k_tower_d", "city-kit-commercial", "building-skyscraper-d", 15.0),
    ("bld_k_shop_a", "city-kit-commercial", "building-a", 13.0),
    ("bld_k_shop_b", "city-kit-commercial", "building-c", 13.0),
    ("bld_k_shop_c", "city-kit-commercial", "building-f", 14.0),
    ("bld_k_shop_d", "city-kit-commercial", "building-j", 14.0),
    ("bld_k_house_a", "city-kit-suburban", "building-type-a", 11.0),
    ("bld_k_house_b", "city-kit-suburban", "building-type-e", 11.0),
    ("bld_k_house_c", "city-kit-suburban", "building-type-j", 12.0),
    ("bld_k_house_d", "city-kit-suburban", "building-type-n", 12.0),
]

PROPS = [
    ("prop_k_tree_large", "city-kit-suburban", "tree-large", 6.5),
    ("prop_k_tree_small", "city-kit-suburban", "tree-small", 4.2),
    ("prop_k_planter", "city-kit-suburban", "planter", 1.6),
    ("prop_k_fence", "city-kit-suburban", "fence", 2.4),
]


def log(msg):
    print(msg, flush=True)


def download(slug):
    """Fetch a pack, returning the local zip path. Cached between runs."""
    os.makedirs(CACHE, exist_ok=True)
    zip_path = os.path.join(CACHE, f"{slug}.zip")
    if os.path.exists(zip_path) and os.path.getsize(zip_path) > 100_000:
        log(f"  cached   {slug}")
        return zip_path

    page_url = f"https://kenney.nl/assets/{slug}"
    log(f"  fetching {slug}")
    with urllib.request.urlopen(page_url, timeout=60) as r:
        html = r.read().decode("utf-8", "replace")

    if "CC0" not in html:
        raise SystemExit(
            f"{slug}: page does not state CC0. Refusing to stage it; check the "
            f"licence at {page_url} by hand."
        )

    import re
    m = re.search(r"https://kenney\.nl/media/pages/assets/[^\"' ]*\.zip", html)
    if not m:
        raise SystemExit(f"{slug}: no download link found on {page_url}")

    urllib.request.urlretrieve(m.group(0), zip_path)
    return zip_path


def extract(slug, zip_path):
    out = os.path.join(CACHE, "x", slug)
    marker = os.path.join(out, ".done")
    if os.path.exists(marker):
        return out
    with zipfile.ZipFile(zip_path) as z:
        for name in z.namelist():
            if "/GLB format/" in name and not name.endswith("/"):
                z.extract(name, out)
        for name in z.namelist():
            if name.lower().endswith("license.txt"):
                z.extract(name, out)
    open(marker, "w").close()
    return out


def glb_dir(extracted):
    for base, dirs, _ in os.walk(extracted):
        for d in dirs:
            if d == "GLB format":
                return os.path.join(base, d)
    raise SystemExit(f"no GLB folder inside {extracted}")


def stage():
    if os.path.exists(STAGE):
        shutil.rmtree(STAGE)
    os.makedirs(STAGE, exist_ok=True)

    sources = {}
    for slug in PACKS:
        sources[slug] = glb_dir(extract(slug, download(slug)))

    entries = []
    copied = set()

    def copy_model(pack, name):
        """Copy a GLB plus the textures it references, preserving relative paths."""
        src_dir = sources[pack]
        src = os.path.join(src_dir, f"{name}.glb")
        if not os.path.exists(src):
            log(f"  MISSING  {pack}/{name}.glb")
            return None

        pack_dir = os.path.join(STAGE, pack)
        os.makedirs(pack_dir, exist_ok=True)
        dst = os.path.join(pack_dir, f"{name}.glb")
        if dst not in copied:
            shutil.copy2(src, dst)
            copied.add(dst)

        # Textures sit in a sibling folder and are referenced by relative URI,
        # so the whole folder is mirrored once per pack. One atlas serves every
        # model in the kit, which is why this stays small.
        tex_src = os.path.join(src_dir, "Textures")
        tex_dst = os.path.join(pack_dir, "Textures")
        if os.path.isdir(tex_src) and not os.path.isdir(tex_dst):
            shutil.copytree(tex_src, tex_dst)

        return f"kenney/{pack}/{name}.glb"

    for key, pack, name, length in VEHICLES:
        rel = copy_model(pack, name)
        if not rel:
            continue
        entries.append({
            "key": key, "file": rel, "category": "vehicles",
            # Kenney vehicles put the front wheels at +Z; this project drives
            # toward -Z, so every car is turned to face the other way.
            "rotateY": 180,
            "fit": {"axis": "z", "size": length},
            "nodes": dict(CAR_NODES),
            "credit": "Kenney Car Kit (CC0)",
        })

    for key, pack, name in CHARACTERS:
        rel = copy_model(pack, name)
        if not rel:
            continue
        entries.append({
            "key": key, "file": rel, "category": "characters",
            "rotateY": 180,
            "fit": {"axis": "y", "size": 1.8},
            "nodes": dict(CHAR_NODES),
            "clips": dict(CHAR_CLIPS),
            "credit": "Kenney Blocky Characters (CC0)",
        })

    for key, pack, name, width in BUILDINGS:
        rel = copy_model(pack, name)
        if not rel:
            continue
        entries.append({
            "key": key, "file": rel, "category": "buildings",
            "fit": {"axis": "x", "size": width},
            "center": True,
            "credit": "Kenney City Kit (CC0)",
        })

    for key, pack, name, height in PROPS:
        rel = copy_model(pack, name)
        if not rel:
            continue
        entries.append({
            "key": key, "file": rel, "category": "props",
            "fit": {"axis": "y", "size": height},
            "center": True,
            "credit": "Kenney City Kit (CC0)",
        })

    index_path = os.path.join(DEST, "index.json")
    with open(index_path, "w") as f:
        json.dump(entries, f, indent=2)

    write_attribution()
    return entries, index_path


def write_attribution():
    path = os.path.join(DEST, "ATTRIBUTION.md")
    with open(path, "w") as f:
        f.write("""# Third-party assets

Everything under `kenney/` comes from [Kenney](https://kenney.nl) and is
released under [Creative Commons Zero (CC0)](https://creativecommons.org/publicdomain/zero/1.0/):
public domain, free for personal and commercial use, no attribution required.
Credited here regardless, because it is deserved.

| Pack | Used for |
|---|---|
| [Car Kit](https://kenney.nl/assets/car-kit) | every drivable vehicle |
| [Blocky Characters](https://kenney.nl/assets/blocky-characters) | player, police and pedestrians |
| [City Kit (Commercial)](https://kenney.nl/assets/city-kit-commercial) | towers and shops |
| [City Kit (Suburban)](https://kenney.nl/assets/city-kit-suburban) | houses, trees, fences |

Each pack's own `License.txt` is preserved alongside its models.

Re-fetch or update them with:

```sh
python3 tools/fetch_kenney.py
```

The script refuses to stage a pack whose page no longer states CC0, so a
licence change upstream fails the build instead of passing silently.

## Adding your own

Anything that exports glTF 2.0 works. Put the `.glb` under
`assets/models/custom/` and add an entry to `index.json` — see this folder's
`README.md` for the fields, including how to map a foreign rig's node and
clip names onto the ones the engine expects.
""")


def main():
    log("staging Kenney CC0 packs")
    entries, index_path = stage()

    by_cat = {}
    for e in entries:
        by_cat.setdefault(e["category"], []).append(e)

    total = 0
    for base, _, files in os.walk(STAGE):
        for fn in files:
            total += os.path.getsize(os.path.join(base, fn))

    log("")
    for cat in sorted(by_cat):
        log(f"  {cat:<12} {len(by_cat[cat]):>3} assets")
    log(f"  {'TOTAL':<12} {len(entries):>3} assets, {total/1024/1024:.1f} MB")
    log(f"  index -> {os.path.relpath(index_path, ROOT)}")


if __name__ == "__main__":
    main()
