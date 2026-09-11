"""
Vehicles.

Convention: +Y is forward, +X is right, +Z is up. Blender's glTF exporter
converts to Y-up, which lands Blender +Y on three.js -Z, i.e. the direction
an Object3D already treats as forward.

Every car exports the same node names so the engine can drive any of them:

    Root
      Body, Skirt, Hood, Roof, Glass, Bumper_F, Bumper_R
      Wheel_FL, Wheel_FR, Wheel_RL, Wheel_RR   (pivot at the hub)
      Headlight_L/R, Taillight_L/R
      Lightbar_R, Lightbar_B                   (police only)
      Seat                                     (where a character sits)
"""

import math
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

import lib as L

HALF_PI = math.pi / 2


def _materials(paint_hex, trim_hex="#16181e"):
    return {
        "paint": L.mat("Paint", L.hexcol(paint_hex), metallic=0.55, roughness=0.32),
        "trim": L.mat("Trim", L.hexcol(trim_hex), metallic=0.2, roughness=0.6),
        "glass": L.mat("Glass", L.hexcol("#1d2733"), metallic=0.0,
                       roughness=0.06, alpha=0.42),
        "rubber": L.mat("Rubber", L.hexcol("#141416"), metallic=0.0, roughness=0.92),
        "rim": L.mat("Rim", L.hexcol("#ccd2dc"), metallic=1.0, roughness=0.28),
        "head": L.mat("Headlight", L.hexcol("#fff4d6"),
                      emission=L.hexcol("#fff4d6"), emission_strength=6.0),
        "tail": L.mat("Taillight", L.hexcol("#ff2a1e"),
                      emission=L.hexcol("#ff2a1e"), emission_strength=4.0),
        "copred": L.mat("CopRed", L.hexcol("#ff2020"),
                        emission=L.hexcol("#ff2020"), emission_strength=8.0),
        "copblue": L.mat("CopBlue", L.hexcol("#2050ff"),
                         emission=L.hexcol("#2050ff"), emission_strength=8.0),
        "chrome": L.mat("Chrome", L.hexcol("#9aa3b0"), metallic=1.0, roughness=0.18),
    }


def _wheel(name, M, x, y, r, w, root):
    """Tyre plus rim, sharing a pivot at the hub so the engine can spin it."""
    hub = (x, y, r)
    tyre = L.cyl(name, r, w, rot=(0, HALF_PI, 0), loc=hub, pivot=hub,
                 segments=20, material=M["rubber"], parent=root, bevel=0.02)
    # Rim sits just proud of the tyre's outer face.
    side = math.copysign(w * 0.5 + 0.012, x)
    L.cyl(name + "_Rim", r * 0.58, 0.03, rot=(0, HALF_PI, 0),
          loc=(side, 0, 0), segments=16, material=M["rim"], parent=tyre)
    L.cyl(name + "_Hub", r * 0.18, 0.05, rot=(0, HALF_PI, 0),
          loc=(side, 0, 0), segments=10, material=M["chrome"], parent=tyre)
    return tyre


def build_car(spec):
    L.reset()
    M = _materials(spec["paint"], spec.get("trim", "#16181e"))

    W = spec["width"]
    Lg = spec["length"]
    wr = spec["wheel_r"]
    ww = spec.get("wheel_w", 0.24)

    body_z = wr + spec.get("ride", 0.16)
    body_h = spec["body_h"]

    root = L.group("Root")

    # ---- main hull -------------------------------------------------------
    L.box("Body", (W, Lg, body_h), loc=(0, 0, body_z + body_h / 2),
          material=M["paint"], parent=root, bevel=spec.get("bevel", 0.07),
          bevel_segments=2)

    # Lower skirt tucks the sills in so the car does not read as one slab.
    L.box("Skirt", (W * 0.94, Lg * 0.96, 0.18),
          loc=(0, 0, body_z - 0.02), material=M["trim"], parent=root, bevel=0.03)

    # ---- greenhouse ------------------------------------------------------
    cab_l = Lg * spec.get("cabin_len", 0.46)
    cab_y = Lg * spec.get("cabin_y", -0.04)
    cab_h = spec.get("cabin_h", 0.52)
    cab_z = body_z + body_h + cab_h / 2

    L.box("Glass", (W * 0.9, cab_l, cab_h), loc=(0, cab_y, cab_z),
          material=M["glass"], parent=root,
          taper=spec.get("cabin_taper", (0.84, 0.8)), bevel=0.03)

    roof_t = 0.08
    L.box("Roof", (W * 0.9 * spec.get("cabin_taper", (0.84, 0.8))[0],
                   cab_l * spec.get("cabin_taper", (0.84, 0.8))[1], roof_t),
          loc=(0, cab_y, cab_z + cab_h / 2 + roof_t / 2 - 0.01),
          material=M["paint"], parent=root, bevel=0.03)

    # Hood and boot break up the flat top.
    if spec.get("hood", True):
        L.box("Hood", (W * 0.95, Lg * 0.24, 0.09),
              loc=(0, Lg * 0.33, body_z + body_h + 0.02),
              material=M["paint"], parent=root, bevel=0.03)
        L.box("Boot", (W * 0.95, Lg * 0.18, 0.09),
              loc=(0, -Lg * 0.38, body_z + body_h + 0.02),
              material=M["paint"], parent=root, bevel=0.03)

    # ---- bumpers ---------------------------------------------------------
    L.box("Bumper_F", (W * 1.01, 0.18, 0.24),
          loc=(0, Lg / 2 - 0.02, body_z + 0.18),
          material=M["trim"], parent=root, bevel=0.05)
    L.box("Bumper_R", (W * 1.01, 0.18, 0.24),
          loc=(0, -Lg / 2 + 0.02, body_z + 0.18),
          material=M["trim"], parent=root, bevel=0.05)

    # ---- lights ----------------------------------------------------------
    lx = W * 0.34
    L.box("Headlight_L", (0.3, 0.08, 0.14),
          loc=(-lx, Lg / 2 + 0.01, body_z + body_h * 0.62),
          material=M["head"], parent=root)
    L.box("Headlight_R", (0.3, 0.08, 0.14),
          loc=(lx, Lg / 2 + 0.01, body_z + body_h * 0.62),
          material=M["head"], parent=root)
    L.box("Taillight_L", (0.26, 0.07, 0.12),
          loc=(-lx, -Lg / 2 - 0.01, body_z + body_h * 0.62),
          material=M["tail"], parent=root)
    L.box("Taillight_R", (0.26, 0.07, 0.12),
          loc=(lx, -Lg / 2 - 0.01, body_z + body_h * 0.62),
          material=M["tail"], parent=root)

    # ---- wheels ----------------------------------------------------------
    ax = W / 2 - ww * 0.42
    fy = Lg * spec.get("axle_f", 0.32)
    ry = -Lg * spec.get("axle_r", 0.32)
    _wheel("Wheel_FL", M, -ax, fy, wr, ww, root)
    _wheel("Wheel_FR", M, ax, fy, wr, ww, root)
    _wheel("Wheel_RL", M, -ax, ry, wr, ww, root)
    _wheel("Wheel_RR", M, ax, ry, wr, ww, root)

    # ---- extras ----------------------------------------------------------
    if spec.get("police"):
        bar_z = cab_z + cab_h / 2 + roof_t + 0.05
        L.box("Lightbar_Base", (W * 0.5, 0.16, 0.05), loc=(0, cab_y, bar_z),
              material=M["trim"], parent=root)
        L.box("Lightbar_R", (W * 0.22, 0.14, 0.09),
              loc=(-W * 0.13, cab_y, bar_z + 0.06),
              material=M["copred"], parent=root)
        L.box("Lightbar_B", (W * 0.22, 0.14, 0.09),
              loc=(W * 0.13, cab_y, bar_z + 0.06),
              material=M["copblue"], parent=root)

    if spec.get("cargo"):
        # Van / truck box behind the cab.
        cg_l = Lg * spec["cargo"]["len"]
        cg_h = spec["cargo"]["h"]
        L.box("Cargo", (W * 1.0, cg_l, cg_h),
              loc=(0, -Lg / 2 + cg_l / 2 + 0.05, body_z + body_h + cg_h / 2 - 0.05),
              material=M["paint"], parent=root, bevel=0.04)

    # Seat marker: where the engine parks the driver model.
    L.empty("Seat", loc=(-W * 0.2, cab_y + 0.1, body_z + body_h * 0.4), parent=root)
    L.empty("ExhaustL", loc=(-W * 0.25, -Lg / 2 - 0.05, body_z + 0.05), parent=root)

    tris = L.tri_count()
    L.export(spec["file"])
    return tris


VEHICLES = [
    dict(file="veh_sedan.glb", paint="#2d6fb5", width=1.86, length=4.42,
         body_h=0.62, wheel_r=0.34, cabin_len=0.46, cabin_h=0.52),

    dict(file="veh_sports.glb", paint="#d22f27", width=1.94, length=4.30,
         body_h=0.46, wheel_r=0.33, ride=0.08, cabin_len=0.40, cabin_h=0.40,
         cabin_y=-0.08, cabin_taper=(0.78, 0.62), axle_f=0.34, axle_r=0.34,
         bevel=0.09),

    dict(file="veh_police.glb", paint="#e9edf2", trim="#11151c", width=1.90,
         length=4.60, body_h=0.64, wheel_r=0.35, cabin_len=0.46,
         cabin_h=0.54, police=True),

    dict(file="veh_taxi.glb", paint="#f2b21c", width=1.88, length=4.50,
         body_h=0.64, wheel_r=0.34, cabin_len=0.48, cabin_h=0.56),

    dict(file="veh_van.glb", paint="#e3e6ea", width=2.00, length=4.90,
         body_h=0.70, wheel_r=0.36, ride=0.20, cabin_len=0.26, cabin_y=0.26,
         cabin_h=0.58, cabin_taper=(0.92, 0.9), hood=False,
         axle_f=0.34, axle_r=0.36,
         cargo=dict(len=0.62, h=1.05)),

    dict(file="veh_truck.glb", paint="#3f7d4e", width=2.16, length=6.20,
         body_h=0.82, wheel_r=0.44, ride=0.26, cabin_len=0.22, cabin_y=0.32,
         cabin_h=0.66, cabin_taper=(0.94, 0.9), hood=False,
         axle_f=0.36, axle_r=0.34, wheel_w=0.30,
         cargo=dict(len=0.58, h=1.30)),

    dict(file="veh_muscle.glb", paint="#1b1d22", width=1.98, length=4.75,
         body_h=0.58, wheel_r=0.36, ride=0.12, cabin_len=0.38, cabin_y=-0.10,
         cabin_h=0.46, cabin_taper=(0.82, 0.7), axle_f=0.33, axle_r=0.33),
]


def main():
    print("building vehicles")
    total = 0
    for spec in VEHICLES:
        tris = build_car(spec)
        total += tris
        print(f"    {spec['file']:<18} {tris:>5} tris")
    print(f"  vehicles total: {total} tris")


if __name__ == "__main__":
    main()
