# Liberty Grid

An open-city driving and shooting sandbox that runs in a browser. Two versions
live here:

| | |
|---|---|
| `play.html` | **3D.** Procedural city, drivable traffic, pedestrians, police, missions. Models generated from Blender scripts. |
| `index.html` | **2D.** The original top-down prototype. Single file, no build step, no server. |

Nothing is downloaded at runtime. three.js is vendored, the models are in the
repo, and the audio is synthesised in the browser.

---

## Running it

The 3D version loads models over `fetch`, which browsers block on `file://`,
so it needs any static server:

```sh
python3 -m http.server 8080
# then open http://localhost:8080/play.html
```

The 2D version is a plain file — open `index.html` directly.

### Controls

| Key | On foot | Driving |
|---|---|---|
| `W A S D` | move | throttle, brake/reverse, steer |
| Mouse | look | look |
| `Shift` | sprint | — |
| `Space` | — | handbrake |
| Left click | shoot | — |
| Right click | aim | — |
| `F` | get in a nearby car | get out |
| `R` | reload | — |
| `1`–`4` | switch weapon | — |
| `Tab` | full map | full map |
| `Alt` | — | free look |
| `M` | mute | mute |
| `F3` | stats overlay | stats overlay |

Reach the gold marker to get paid; consecutive on-time deliveries build a
multiplier. Shooting people or running them over raises the wanted level.
Police heat only decays once no unit has seen you for a while, so escaping
means breaking line of sight rather than waiting out a timer.

---

## How it fits together

```
tools/blender/     asset generation (Python, runs in Blender)
  lib.py             bmesh primitives, materials, rigging, glTF export
  build_*.py         one script per asset family
  build_all.py       runs everything, writes manifest.json
assets/models/     generated .glb files + manifest.json
  custom/            drop-in folder for externally made models
src/               the game (ES modules, no build step)
tests/             headless test suite + browser check
vendor/three/      pinned three.js, so the game works offline
```

The engine reads **only** `assets/models/manifest.json`. Nothing in `src/`
hardcodes an asset name, so regenerating the library with new models makes
them available without touching any JavaScript.

### Regenerating the models

```sh
pip install "bpy==4.5.13"          # Blender as a Python module (Python 3.11)
python3 tools/blender/build_all.py # ~5 seconds for the whole library
python3 tools/validate_glb.py      # check every asset against its contract
```

Or with a normal Blender install:

```sh
blender --background --python tools/blender/build_all.py
```

Build one family at a time by naming it: `python3 tools/blender/build_all.py vehicles`.

Current library: 50 assets, ~44k triangles, 2.7 MB total.

### Asset contracts

Each family exports a fixed set of node names, which is the whole interface
between Blender and the engine. `tools/validate_glb.py` enforces them.

| Prefix | Required nodes | Clips |
|---|---|---|
| `veh_` | `Root`, `Body`, `Glass`, `Wheel_FL/FR/RL/RR`, `Headlight_L/R`, `Taillight_L`, `Seat` | — |
| `char_` | `Root`, `Hips`, `Spine`, `Head`, `Arm_L/R`, `Leg_L/R`, `Hand_R` | `Idle`, `Walk`, `Run` |
| `wpn_` | `Root`, `Muzzle`, `Grip`, `Eject` | — |
| `bld_`, `prop_`, `env_`, `item_` | `Root` | — |

Coordinates: **+Y is forward** in Blender, which the glTF exporter converts to
**-Z in three.js** — the direction an `Object3D` already treats as forward.
Every system uses a heading `θ` whose forward vector is `(-sin θ, 0, -cos θ)`.

---

## Using models from elsewhere

The pipeline is glTF, so anything that exports `.glb` drops straight in —
including AI model generators like Meshy, which are far better than procedural
code at organic shapes (faces, bodies, clothing) even though code wins on
hard-surface things like vehicles and buildings.

Put the file in `assets/models/custom/` and list it in
`assets/models/custom/index.json`:

```json
[
  { "file": "my_character.glb", "key": "char_player", "category": "characters" }
]
```

Reusing a generated key replaces that asset everywhere; a new key adds an
extra option. For a character to animate it needs the node names and clips
from the table above — see `assets/models/custom/README.md`.

---

## Tests

```sh
npm install          # three.js and playwright, for the tests only
npm test             # 80 headless tests, no browser needed
```

The suite substitutes box meshes for the real GLBs, so it covers generation,
physics, combat and AI without WebGL. It asserts invariants rather than
snapshots: no building intrudes on a carriageway, no two footprints overlap,
bullets cannot pass through walls, collision resolution is stable when
reapplied, populations never drift, and nothing goes non-finite under tens of
thousands of frames of random input.

There is also an end-to-end check that drives the real page in headless
Chromium, where WebGL runs on SwiftShader:

```sh
python3 -m http.server 8099 &
node tests/browser.mjs --shots /tmp/shots
```

It fails on any console error, verifies the game reaches a running state, and
writes screenshots. Two narrower checks use the same setup:

```sh
node tests/drive.mjs    /tmp/shots   # get in a car, drive, raise the heat, get out
node tests/daynight.mjs /tmp/shots   # window and lamp glow across the day
```

Frame rate reported by these is meaningless — it is a software rasteriser —
but `F3` in a real browser shows live draw calls and triangle counts.

---

## Notes on the implementation

A few decisions that are not obvious from the code:

**Characters are rigged as node hierarchies, not armatures.** For blocky
low-poly limbs, skinning buys nothing and automatic weights smear the joints.
A hierarchy exports as clean TRS tracks that `AnimationMixer` plays directly.

**Every joint is keyframed in every clip, even where the motion is invisible.**
The glTF exporter drops channels whose value never changes, and a joint absent
from `Idle` keeps whatever pose `Walk` last left it in when the mixer blends
back.

**Windows are batched quads, not boxes.** A window is 2 triangles instead of
12, and a whole facade is one object, so a twenty-storey tower costs about
1500 triangles.

**Static geometry is merged by material, then chunked spatially.** Merging
takes a nine-mesh bench to two draws. Chunking matters because a single
map-wide `InstancedMesh` has to disable frustum culling — its bounds always
contain the camera — so every building in the city would be submitted every
frame, including the ones behind you.

**Traffic uses pure pursuit along the lane line.** Steering at the next
junction makes cars cut the corner onto the pavement, and at a fraction of
their top speed they reach a 60 m junction far too fast to turn at all.

**Combat is hitscan, resolved walls-first.** The nearest wall is found before
any entity is tested, so nothing can be shot through a building, and buildings
carry their height so a round can pass over a bungalow but not a tower.

---

## Licence

Game code and assets: do what you like with them.
`vendor/three` is three.js r160, MIT — see `vendor/three/LICENSE`.
