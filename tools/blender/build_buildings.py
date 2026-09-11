"""
Buildings.

All footprints are sized to sit inside a city lot, with the origin on the
ground at the centre of the footprint, so the generator can drop one at a
plot position with no vertical adjustment.

Windows are batched quads rather than boxes: one object per facade, two
triangles per window. A twelve-storey tower comes in under 1500 triangles.
"""

import math
import os
import random
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

import lib as L

FLOOR_H = 3.2


def _materials(wall_hex, trim_hex, lit=True):
    return {
        "wall": L.mat("Wall", L.hexcol(wall_hex), roughness=0.82),
        "trim": L.mat("BTrim", L.hexcol(trim_hex), roughness=0.6, metallic=0.2),
        "glass": L.mat("BGlass", L.hexcol("#4d6678"), metallic=0.6,
                       roughness=0.12),
        "lit": L.mat("BGlassLit", L.hexcol("#ffd9a0"),
                     emission=L.hexcol("#ffcf90"),
                     emission_strength=1.6 if lit else 0.0),
        "roof": L.mat("Roof", L.hexcol("#2c3038"), roughness=0.9),
        "door": L.mat("Door", L.hexcol("#243040"), metallic=0.4, roughness=0.25),
        "sign": L.mat("Sign", L.hexcol("#ff7a3d"),
                      emission=L.hexcol("#ff7a3d"), emission_strength=2.5),
        "concrete": L.mat("Concrete", L.hexcol("#767b84"), roughness=0.95),
    }


def _facades(root, M, w, d, h, base_z, cols_x, cols_y, rows, lit_ratio, seed):
    """Window grids on all four walls, split into lit and unlit batches."""
    rnd = random.Random(seed)
    hw, hd = w / 2, d / 2
    eps = 0.02

    sets = {"lit": [], "dark": []}

    def emit(plane, u0, u1, offset, cols):
        du = (u1 - u0) / cols
        dv = (h - 0.6) / rows
        v0 = base_z + 0.3
        for i in range(cols):
            for j in range(rows):
                cu = u0 + du * (i + 0.5)
                cv = v0 + dv * (j + 0.5)
                hwq = du * 0.62 * 0.5
                hhq = dv * 0.58 * 0.5
                a, b = cu - hwq, cu + hwq
                c2, d2 = cv - hhq, cv + hhq
                if plane == '+x':
                    q = [(offset, a, c2), (offset, b, c2),
                         (offset, b, d2), (offset, a, d2)]
                elif plane == '-x':
                    q = [(offset, b, c2), (offset, a, c2),
                         (offset, a, d2), (offset, b, d2)]
                elif plane == '+y':
                    q = [(b, offset, c2), (a, offset, c2),
                         (a, offset, d2), (b, offset, d2)]
                else:
                    q = [(a, offset, c2), (b, offset, c2),
                         (b, offset, d2), (a, offset, d2)]
                sets["lit" if rnd.random() < lit_ratio else "dark"].append(q)

    emit('+x', -hd, hd, hw + eps, cols_y)
    emit('-x', -hd, hd, -hw - eps, cols_y)
    emit('+y', -hw, hw, hd + eps, cols_x)
    emit('-y', -hw, hw, -hd - eps, cols_x)

    if sets["dark"]:
        L.quads("Windows", sets["dark"], material=M["glass"], parent=root)
    if sets["lit"]:
        L.quads("WindowsLit", sets["lit"], material=M["lit"], parent=root)


def build_tower(spec):
    L.reset()
    M = _materials(spec["wall"], spec["trim"], spec.get("lit", True))
    rnd = random.Random(spec.get("seed", 0))

    w, d = spec["w"], spec["d"]
    floors = spec["floors"]
    h = floors * FLOOR_H

    root = L.group("Root")

    # Ground floor podium, slightly wider than the shaft.
    pod_h = spec.get("podium", 4.2)
    L.box("Podium", (w + 0.8, d + 0.8, pod_h), loc=(0, 0, pod_h / 2),
          material=M["trim"], parent=root, bevel=0.12)

    # Main shaft.
    shaft_h = h - pod_h
    L.box("Shaft", (w, d, shaft_h), loc=(0, 0, pod_h + shaft_h / 2),
          material=M["wall"], parent=root, bevel=0.1)

    cols_x = max(2, int(w / 2.6))
    cols_y = max(2, int(d / 2.6))
    rows = max(1, int(shaft_h / FLOOR_H))
    _facades(root, M, w, d, shaft_h, pod_h, cols_x, cols_y, rows,
             spec.get("lit_ratio", 0.35), spec.get("seed", 0))

    # Ground floor glazing and entrance.
    L.box("Storefront", (w * 0.8, d + 0.86, pod_h * 0.52),
          loc=(0, 0, pod_h * 0.42), material=M["glass"], parent=root)
    L.box("Door", (2.0, d + 0.92, 2.6), loc=(0, 0, 1.3),
          material=M["door"], parent=root)

    # Parapet and roof clutter so the skyline is not a field of flat tops.
    L.box("Parapet", (w + 0.3, d + 0.3, 0.9), loc=(0, 0, h + 0.35),
          material=M["trim"], parent=root, bevel=0.06)
    L.box("RoofDeck", (w - 0.4, d - 0.4, 0.2), loc=(0, 0, h),
          material=M["roof"], parent=root)

    for i in range(spec.get("roof_units", 2)):
        ux = rnd.uniform(-w * 0.28, w * 0.28)
        uy = rnd.uniform(-d * 0.28, d * 0.28)
        uw = rnd.uniform(1.4, 2.6)
        uh = rnd.uniform(0.8, 1.6)
        L.box(f"AC_{i}", (uw, uw * 0.8, uh), loc=(ux, uy, h + uh / 2 + 0.1),
              material=M["roof"], parent=root, bevel=0.05)

    if spec.get("antenna"):
        L.cyl("Antenna", 0.12, 6.0, loc=(0, 0, h + 3.2), segments=8,
              material=M["trim"], parent=root)
        L.box("AntennaLight", (0.3, 0.3, 0.3), loc=(0, 0, h + 6.3),
              material=M["sign"], parent=root)

    tris = L.tri_count()
    L.export(spec["file"])
    return tris


def build_shop(spec):
    """Two-storey street-level retail with signage."""
    L.reset()
    M = _materials(spec["wall"], spec["trim"])
    w, d = spec["w"], spec["d"]
    h = spec.get("floors", 2) * FLOOR_H
    root = L.group("Root")

    L.box("Shell", (w, d, h), loc=(0, 0, h / 2), material=M["wall"],
          parent=root, bevel=0.1)
    L.box("Storefront", (w * 0.88, d + 0.06, 2.6), loc=(0, 0, 1.5),
          material=M["glass"], parent=root)
    L.box("Door", (1.4, d + 0.12, 2.4), loc=(w * 0.3, 0, 1.2),
          material=M["door"], parent=root)

    # Awning over the frontage.
    L.box("Awning", (w * 0.92, 1.4, 0.12), loc=(0, d / 2 + 0.6, 3.25),
          material=M["trim"], parent=root, bevel=0.04)
    L.box("Sign", (w * 0.6, 0.18, 0.9), loc=(0, d / 2 + 0.12, 4.4),
          material=M["sign"], parent=root, bevel=0.04)

    rows = max(1, int((h - 3.6) / FLOOR_H))
    if rows > 0:
        L.window_grid("Windows", '+y', -w * 0.4, w * 0.4, 3.9, h - 0.5,
                      d / 2 + 0.02, max(2, int(w / 2.4)), rows,
                      material=M["glass"], parent=root)
        L.window_grid("Windows_B", '-y', -w * 0.4, w * 0.4, 3.9, h - 0.5,
                      -d / 2 - 0.02, max(2, int(w / 2.4)), rows,
                      material=M["glass"], parent=root)

    L.box("Parapet", (w + 0.24, d + 0.24, 0.6), loc=(0, 0, h + 0.2),
          material=M["trim"], parent=root, bevel=0.05)

    tris = L.tri_count()
    L.export(spec["file"])
    return tris


def build_house(spec):
    """Low-rise house with a pitched roof."""
    L.reset()
    M = _materials(spec["wall"], spec["trim"])
    w, d = spec["w"], spec["d"]
    h = spec.get("h", 5.4)
    root = L.group("Root")

    L.box("Shell", (w, d, h), loc=(0, 0, h / 2), material=M["wall"],
          parent=root, bevel=0.08)

    # Pitched roof: a box tapered to a ridge.
    L.box("Roof", (w + 0.7, d + 0.7, 2.2), loc=(0, 0, h + 1.1),
          material=M["roof"], parent=root, taper=(0.06, 0.92), bevel=0.05)

    L.box("Door", (1.1, 0.16, 2.2), loc=(0, d / 2 + 0.02, 1.1),
          material=M["door"], parent=root)
    L.box("Step", (1.8, 0.9, 0.18), loc=(0, d / 2 + 0.5, 0.09),
          material=M["concrete"], parent=root)

    for plane, off in (('+y', d / 2 + 0.02), ('-y', -d / 2 - 0.02)):
        L.window_grid(f"Windows_{plane[1]}{plane[0]}", plane,
                      -w * 0.38, w * 0.38, 1.0, h - 0.7, off,
                      2, max(1, int(h / 3.0)),
                      material=M["glass"], parent=root)

    L.cyl("Chimney", 0.4, 2.0, loc=(w * 0.28, -d * 0.2, h + 1.6), segments=8,
          material=M["trim"], parent=root)

    tris = L.tri_count()
    L.export(spec["file"])
    return tris


def build_warehouse(spec):
    L.reset()
    M = _materials(spec["wall"], spec["trim"])
    w, d = spec["w"], spec["d"]
    h = spec.get("h", 8.0)
    root = L.group("Root")

    L.box("Shell", (w, d, h), loc=(0, 0, h / 2), material=M["wall"],
          parent=root, bevel=0.1)
    L.box("Roof", (w + 0.4, d + 0.4, 0.5), loc=(0, 0, h + 0.2),
          material=M["roof"], parent=root, bevel=0.06)

    # Roller shutters along the long face.
    for i, sx in enumerate((-w * 0.28, 0.0, w * 0.28)):
        L.box(f"Shutter_{i}", (w * 0.2, 0.16, 4.2),
              loc=(sx, d / 2 + 0.02, 2.1), material=M["trim"], parent=root)

    L.window_grid("Windows", '+y', -w * 0.44, w * 0.44, 5.2, h - 0.6,
                  d / 2 + 0.02, max(3, int(w / 3.0)), 1,
                  material=M["glass"], parent=root)

    for i in range(3):
        L.box(f"Vent_{i}", (1.6, 1.6, 0.7),
              loc=(-w * 0.25 + i * w * 0.25, 0, h + 0.75),
              material=M["roof"], parent=root, bevel=0.05)

    tris = L.tri_count()
    L.export(spec["file"])
    return tris


BUILDINGS = [
    # Tall towers for the downtown core.
    (build_tower, dict(file="bld_tower_a.glb", w=16, d=16, floors=16,
                       wall="#5a6474", trim="#3b424e", seed=11,
                       antenna=True, roof_units=3, lit_ratio=0.38)),
    (build_tower, dict(file="bld_tower_b.glb", w=14, d=18, floors=12,
                       wall="#6d6156", trim="#443c34", seed=22,
                       roof_units=2, lit_ratio=0.30)),
    (build_tower, dict(file="bld_tower_c.glb", w=18, d=14, floors=20,
                       wall="#4a5566", trim="#2f3742", seed=33,
                       antenna=True, roof_units=3, lit_ratio=0.42)),
    (build_tower, dict(file="bld_office.glb", w=20, d=16, floors=8,
                       wall="#7a808a", trim="#4c525c", seed=44,
                       podium=5.0, roof_units=2, lit_ratio=0.25)),
    (build_tower, dict(file="bld_apartment.glb", w=13, d=13, floors=6,
                       wall="#8a7360", trim="#584839", seed=55,
                       podium=3.6, roof_units=1, lit_ratio=0.45)),

    (build_shop, dict(file="bld_shop_a.glb", w=12, d=10, floors=2,
                      wall="#9c6a52", trim="#5e3f31")),
    (build_shop, dict(file="bld_shop_b.glb", w=14, d=11, floors=3,
                      wall="#66798a", trim="#3e4a57")),

    (build_house, dict(file="bld_house_a.glb", w=10, d=9, h=5.4,
                       wall="#c2b49a", trim="#6b5d47")),
    (build_house, dict(file="bld_house_b.glb", w=11, d=10, h=6.2,
                       wall="#9fb0a2", trim="#4f5a50")),

    (build_warehouse, dict(file="bld_warehouse.glb", w=22, d=16, h=8.5,
                           wall="#8b8f96", trim="#565b63")),
]


def main():
    print("building buildings")
    total = 0
    for fn, spec in BUILDINGS:
        tris = fn(spec)
        total += tris
        print(f"    {spec['file']:<22} {tris:>5} tris")
    print(f"  buildings total: {total} tris")


if __name__ == "__main__":
    main()
