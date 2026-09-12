# Drop-in models

Anything that exports glTF 2.0 (`.glb`) can be used here: Kenney, Quaternius,
Poly Pizza, Sketchfab, Mixamo, an AI generator like Meshy, or your own Blender
export. Put the file in this folder and add an entry to `index.json`.

The packs already staged under `kenney/` were fetched by
`python3 tools/fetch_kenney.py`. See `ATTRIBUTION.md` for their licence.

## index.json

```json
[
  {
    "key": "char_player",
    "file": "kenney/blocky-characters/character-a.glb",
    "category": "characters",
    "rotateY": 180,
    "fit": { "axis": "y", "size": 1.8 },
    "nodes": { "Head": "head", "Arm_R": "arm-right" },
    "clips": { "Idle": "idle", "Walk": "walk", "Run": "sprint" }
  }
]
```

| Field | Meaning |
|---|---|
| `key` | What the model is used as. Reusing a generated key **replaces** that asset everywhere; a new key **adds** an extra option. |
| `file` | Path relative to this folder. |
| `category` | `characters`, `vehicles`, `buildings`, `props`, `weapons`, `items` or `environment`. |
| `rotateY` | Degrees to turn the model so it faces **-Z**, which is forward here. Most kits face +Z, so `180` is common. |
| `fit` | `{ axis, size }` scales the model uniformly until that axis measures `size` metres. Use `y` for characters, `z` for vehicles, `x` for buildings. |
| `ground` | Defaults to true: drops the model so its lowest point rests at y = 0. Set false to keep the original origin. |
| `center` | Also centres it horizontally. Useful for buildings whose origin is off in a corner. |
| `nodes` | `{ ourName: theirName }`. Lets a foreign rig answer to the names the engine looks up, without renaming anything and breaking its own animations. |
| `clips` | `{ Idle: "idle", ... }` renames animations to what the engine expects. |
| `credit` | Free text, for your own records. |

## What the engine looks for

| Category | Nodes | Clips |
|---|---|---|
| characters | `Hips` `Spine` `Head` `Arm_L` `Arm_R` `Leg_L` `Leg_R` `Hand_R` | `Idle` `Walk` `Run` |
| vehicles | `Wheel_FL` `Wheel_FR` `Wheel_RL` `Wheel_RR`, optionally `Body` `Seat` `Headlight_L/R` | — |
| weapons | `Muzzle`, optionally `Grip` `Eject` | — |
| everything else | nothing required | — |

Missing nodes are not fatal. A vehicle with no wheel nodes still drives, its
wheels just will not turn; a character with no clips stands still.

## Things that trip people up

**Facing.** If a car drives backwards, add `"rotateY": 180`. Wheel spin
direction follows this automatically.

**Scale.** Asset kits are rarely authored in metres. Kenney's cars are about
2.5 m long and its buildings about 1 m tall. `fit` handles it, so you do not
have to rescale anything by hand.

**Missing tracks.** Authors often leave tracks out of a clip that does not
need them, and Kenney's `idle` animates the arms but not the legs. Blended
through an AnimationMixer that freezes the legs mid-stride when you stop
walking, so the loader fills any track present in one mapped clip and absent
from another with the node's rest pose.

**Skinned meshes.** These models are node hierarchies, not skinned rigs.
A skinned character (most Mixamo exports) will load, but cloning it needs
`SkeletonUtils.clone()` rather than `Object3D.clone()`, which the loader does
not do yet. Node-hierarchy rigs like Kenney's work today.

Run `python3 tools/validate_glb.py` to check a file's contents before relying
on it.
