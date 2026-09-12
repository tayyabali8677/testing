# Third-party assets

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
