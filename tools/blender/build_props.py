"""
Street props.

Small, heavily reused pieces. These are the assets the city generator places
in the hundreds, so they are instanced at runtime and kept deliberately cheap.

Props that the engine lights or animates expose an empty marker:
    Lamp    where a PointLight goes
    Bulb_R / Bulb_Y / Bulb_G   traffic light lenses, toggled by the engine
"""

import math
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

import lib as L

HALF_PI = math.pi / 2


def _materials():
    return {
        "metal": L.mat("PropMetal", L.hexcol("#59606b"), metallic=0.8,
                       roughness=0.45),
        "dark": L.mat("PropDark", L.hexcol("#22262c"), metallic=0.5,
                      roughness=0.6),
        "paint": L.mat("PropPaint", L.hexcol("#b8443a"), roughness=0.55),
        "wood": L.mat("PropWood", L.hexcol("#7a5433"), roughness=0.8),
        "leaf": L.mat("Leaf", L.hexcol("#3f6b39"), roughness=0.9),
        "trunk": L.mat("Trunk", L.hexcol("#4b3826"), roughness=0.95),
        "concrete": L.mat("PropConcrete", L.hexcol("#8a8f97"), roughness=0.95),
        "glow": L.mat("LampGlow", L.hexcol("#ffe7bd"),
                      emission=L.hexcol("#ffe7bd"), emission_strength=5.0),
        "red": L.mat("LightRed", L.hexcol("#ff2a1e"),
                     emission=L.hexcol("#ff2a1e"), emission_strength=5.0),
        "amber": L.mat("LightAmber", L.hexcol("#ffb020"),
                       emission=L.hexcol("#ffb020"), emission_strength=5.0),
        "green": L.mat("LightGreen", L.hexcol("#2ce06a"),
                       emission=L.hexcol("#2ce06a"), emission_strength=5.0),
        "hiviz": L.mat("HiViz", L.hexcol("#ef7d1a"), roughness=0.7),
        "white": L.mat("PropWhite", L.hexcol("#d9dde3"), roughness=0.7),
    }


def streetlight():
    L.reset()
    M = _materials()
    root = L.group("Root")
    H = 7.0

    L.cyl("Base", 0.26, 0.35, loc=(0, 0, 0.17), segments=10,
          material=M["concrete"], parent=root)
    L.cyl("Pole", 0.11, H, loc=(0, 0, H / 2), segments=10,
          material=M["metal"], parent=root)
    # Curved arm out over the road.
    L.box("Arm", (0.14, 1.9, 0.14), loc=(0, 0.95, H - 0.1),
          material=M["metal"], parent=root, bevel=0.03)
    L.box("Head", (0.42, 0.9, 0.2), loc=(0, 1.85, H - 0.24),
          material=M["dark"], parent=root, bevel=0.04)
    L.box("Lens", (0.34, 0.78, 0.05), loc=(0, 1.85, H - 0.35),
          material=M["glow"], parent=root)

    L.empty("Lamp", loc=(0, 1.85, H - 0.45), parent=root)
    tris = L.tri_count()
    L.export("prop_streetlight.glb")
    return tris


def trafficlight():
    L.reset()
    M = _materials()
    root = L.group("Root")
    H = 5.6

    L.cyl("Base", 0.24, 0.3, loc=(0, 0, 0.15), segments=10,
          material=M["concrete"], parent=root)
    L.cyl("Pole", 0.1, H, loc=(0, 0, H / 2), segments=10,
          material=M["dark"], parent=root)
    L.box("Arm", (0.12, 2.6, 0.12), loc=(0, 1.3, H - 0.1),
          material=M["dark"], parent=root, bevel=0.03)

    # Housing hanging off the arm.
    hx, hy, hz = 0.0, 2.45, H - 0.95
    L.box("Housing", (0.34, 0.3, 1.05), loc=(hx, hy, hz),
          material=M["dark"], parent=root, bevel=0.04)
    for name, mat, dz in (("Bulb_R", M["red"], 0.33),
                          ("Bulb_Y", M["amber"], 0.0),
                          ("Bulb_G", M["green"], -0.33)):
        L.cyl(name, 0.1, 0.06, rot=(HALF_PI, 0, 0),
              loc=(hx, hy - 0.17, hz + dz), segments=10,
              material=mat, parent=root)

    # Pedestrian box on the pole.
    L.box("PedBox", (0.26, 0.22, 0.4), loc=(0, 0.16, 2.6),
          material=M["dark"], parent=root, bevel=0.03)

    tris = L.tri_count()
    L.export("prop_trafficlight.glb")
    return tris


def tree():
    L.reset()
    M = _materials()
    root = L.group("Root")

    L.cyl("Trunk", 0.2, 2.6, radius_top=0.15, loc=(0, 0, 1.3), segments=8,
          material=M["trunk"], parent=root)
    # Three offset blobs read as foliage far more cheaply than a sphere stack.
    L.sphere("Canopy_A", 1.5, loc=(0, 0, 3.5), u=10, v=7,
             material=M["leaf"], parent=root, squash=(1.0, 1.0, 0.82))
    L.sphere("Canopy_B", 1.05, loc=(0.8, 0.35, 3.0), u=8, v=6,
             material=M["leaf"], parent=root, squash=(1.0, 1.0, 0.85))
    L.sphere("Canopy_C", 0.95, loc=(-0.7, -0.4, 3.15), u=8, v=6,
             material=M["leaf"], parent=root, squash=(1.0, 1.0, 0.85))

    tris = L.tri_count()
    L.export("prop_tree.glb")
    return tris


def bench():
    L.reset()
    M = _materials()
    root = L.group("Root")

    for i, sx in enumerate((-0.7, 0.7)):
        L.box(f"Leg_{i}", (0.09, 0.5, 0.42), loc=(sx, 0, 0.21),
              material=M["metal"], parent=root, bevel=0.02)
    for i in range(4):
        L.box(f"Slat_{i}", (1.8, 0.11, 0.05), loc=(0, -0.18 + i * 0.13, 0.45),
              material=M["wood"], parent=root, bevel=0.012)
    for i in range(3):
        L.box(f"Back_{i}", (1.8, 0.05, 0.11), loc=(0, 0.24, 0.62 + i * 0.15),
              material=M["wood"], parent=root, bevel=0.012)

    tris = L.tri_count()
    L.export("prop_bench.glb")
    return tris


def hydrant():
    L.reset()
    M = _materials()
    root = L.group("Root")

    L.cyl("Foot", 0.19, 0.1, loc=(0, 0, 0.05), segments=10,
          material=M["paint"], parent=root)
    L.cyl("Body", 0.14, 0.62, loc=(0, 0, 0.4), segments=10,
          material=M["paint"], parent=root)
    L.sphere("Cap", 0.145, loc=(0, 0, 0.72), u=10, v=6,
             material=M["paint"], parent=root, squash=(1, 1, 0.7))
    for i, ry in enumerate((HALF_PI, -HALF_PI)):
        L.cyl(f"Nozzle_{i}", 0.06, 0.16, rot=(0, ry, 0),
              loc=(0.16 * (1 if i == 0 else -1), 0, 0.46), segments=8,
              material=M["paint"], parent=root)

    tris = L.tri_count()
    L.export("prop_hydrant.glb")
    return tris


def bin_():
    L.reset()
    M = _materials()
    root = L.group("Root")
    L.cyl("Body", 0.32, 0.9, radius_top=0.36, loc=(0, 0, 0.45), segments=12,
          material=M["dark"], parent=root)
    L.cyl("Rim", 0.38, 0.07, loc=(0, 0, 0.92), segments=12,
          material=M["metal"], parent=root)
    tris = L.tri_count()
    L.export("prop_bin.glb")
    return tris


def dumpster():
    L.reset()
    M = _materials()
    root = L.group("Root")
    L.box("Body", (2.0, 1.2, 1.1), loc=(0, 0, 0.62), material=M["hiviz"],
          parent=root, bevel=0.05, taper=(1.08, 1.05))
    L.box("Lid", (2.05, 1.26, 0.1), loc=(0, 0, 1.2), material=M["dark"],
          parent=root, bevel=0.03)
    for i, (sx, sy) in enumerate(((-0.8, -0.5), (0.8, -0.5), (-0.8, 0.5), (0.8, 0.5))):
        L.cyl(f"Caster_{i}", 0.11, 0.08, rot=(0, HALF_PI, 0),
              loc=(sx, sy, 0.11), segments=8, material=M["dark"], parent=root)
    tris = L.tri_count()
    L.export("prop_dumpster.glb")
    return tris


def barrier():
    L.reset()
    M = _materials()
    root = L.group("Root")
    L.box("Plank", (2.4, 0.12, 0.28), loc=(0, 0, 0.86), material=M["white"],
          parent=root, bevel=0.02)
    for i in range(4):
        L.box(f"Stripe_{i}", (0.3, 0.14, 0.29), loc=(-0.9 + i * 0.6, 0, 0.86),
              material=M["hiviz"], parent=root)
    for i, sx in enumerate((-0.95, 0.95)):
        L.box(f"LegA_{i}", (0.08, 0.7, 0.95), loc=(sx, 0, 0.47),
              rot=(0.22, 0, 0), material=M["white"], parent=root, bevel=0.02)
    tris = L.tri_count()
    L.export("prop_barrier.glb")
    return tris


def cone():
    L.reset()
    M = _materials()
    root = L.group("Root")
    L.box("Base", (0.42, 0.42, 0.05), loc=(0, 0, 0.025), material=M["hiviz"],
          parent=root, bevel=0.01)
    L.cyl("Cone", 0.17, 0.62, radius_top=0.03, loc=(0, 0, 0.33), segments=10,
          material=M["hiviz"], parent=root)
    L.cyl("Band", 0.13, 0.1, radius_top=0.115, loc=(0, 0, 0.42), segments=10,
          material=M["white"], parent=root)
    tris = L.tri_count()
    L.export("prop_cone.glb")
    return tris


def busstop():
    L.reset()
    M = _materials()
    root = L.group("Root")
    for i, sx in enumerate((-1.7, 1.7)):
        L.box(f"Post_{i}", (0.1, 0.1, 2.6), loc=(sx, -0.5, 1.3),
              material=M["metal"], parent=root)
    L.box("Roof", (3.8, 1.5, 0.12), loc=(0, -0.1, 2.66),
          material=M["metal"], parent=root, bevel=0.03)
    L.box("BackGlass", (3.7, 0.06, 2.0), loc=(0, 0.55, 1.5),
          material=L.mat("StopGlass", L.hexcol("#7f95a8"), alpha=0.35,
                         roughness=0.1),
          parent=root)
    L.box("Seat", (3.2, 0.42, 0.08), loc=(0, 0.35, 0.62),
          material=M["wood"], parent=root, bevel=0.02)
    L.box("Sign", (0.7, 0.08, 0.5), loc=(1.9, -0.5, 2.2),
          material=M["paint"], parent=root, bevel=0.02)
    tris = L.tri_count()
    L.export("prop_busstop.glb")
    return tris


def lamppost_sign():
    L.reset()
    M = _materials()
    root = L.group("Root")
    L.cyl("Pole", 0.06, 2.7, loc=(0, 0, 1.35), segments=8,
          material=M["metal"], parent=root)
    L.box("Plate", (0.72, 0.04, 0.26), loc=(0, 0, 2.45),
          material=M["white"], parent=root, bevel=0.02)
    tris = L.tri_count()
    L.export("prop_sign.glb")
    return tris


PROPS = [
    ("prop_streetlight.glb", streetlight),
    ("prop_trafficlight.glb", trafficlight),
    ("prop_tree.glb", tree),
    ("prop_bench.glb", bench),
    ("prop_hydrant.glb", hydrant),
    ("prop_bin.glb", bin_),
    ("prop_dumpster.glb", dumpster),
    ("prop_barrier.glb", barrier),
    ("prop_cone.glb", cone),
    ("prop_busstop.glb", busstop),
    ("prop_sign.glb", lamppost_sign),
]


def main():
    print("building props")
    total = 0
    for name, fn in PROPS:
        tris = fn()
        total += tris
        print(f"    {name:<24} {tris:>5} tris")
    print(f"  props total: {total} tris")


if __name__ == "__main__":
    main()
