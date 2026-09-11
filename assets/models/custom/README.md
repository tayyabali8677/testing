# Drop-in models

Put externally generated `.glb` files here (Meshy, Sketchfab, a hand export
from Blender, anything that writes glTF 2.0) and list them in `index.json`:

```json
[
  { "file": "my_character.glb", "key": "char_player", "category": "characters" }
]
```

`key` decides what the model is used as. Reusing a generated key replaces that
asset everywhere in the game; a new key adds an extra option.

Set `category` to one of `characters`, `vehicles`, `buildings`, `props`,
`weapons`, `items` or `environment` so the game knows where the model belongs.

To stand in for a character the file should carry the same node names the
generated characters use (`Hips`, `Spine`, `Head`, `Arm_L`, `Leg_L`, ... and
`Hand_R` for the weapon mount) plus `Idle`, `Walk` and `Run` animation clips.
Without those the model still loads, but it will not animate.

Run `python3 tools/validate_glb.py` to check a file against the contract
before relying on it in game.
