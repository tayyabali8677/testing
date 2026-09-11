"""
Weapons.

Barrel points along +Y (forward) and the grip hangs down -Z, matching the
vehicle convention, so the engine can parent a weapon straight onto the
character's Hand_R node with no corrective rotation.

Every weapon exports:
    Root
      ... geometry ...
      Muzzle     empty at the barrel tip, where flash and tracers spawn
      Grip       empty at the palm position, for hand alignment
      Eject      empty at the ejection port, for shell casings
"""

import math
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

import lib as L

HALF_PI = math.pi / 2


def _materials():
    return {
        "steel": L.mat("GunSteel", L.hexcol("#3a3f47"), metallic=0.9, roughness=0.34),
        "dark": L.mat("GunDark", L.hexcol("#1b1e24"), metallic=0.7, roughness=0.5),
        "poly": L.mat("GunPoly", L.hexcol("#26292f"), metallic=0.0, roughness=0.75),
        "wood": L.mat("GunWood", L.hexcol("#6b4426"), metallic=0.0, roughness=0.6),
        "accent": L.mat("GunAccent", L.hexcol("#8e959f"), metallic=1.0, roughness=0.22),
        "sight": L.mat("GunSight", L.hexcol("#20ff88"),
                       emission=L.hexcol("#20ff88"), emission_strength=4.0),
    }


def _markers(root, muzzle, grip, eject):
    L.empty("Muzzle", loc=muzzle, parent=root)
    L.empty("Grip", loc=grip, parent=root)
    L.empty("Eject", loc=eject, parent=root)


def build_pistol():
    L.reset()
    M = _materials()
    root = L.group("Root")

    # Frame and slide.
    L.box("Frame", (0.045, 0.20, 0.055), loc=(0, 0.01, 0),
          material=M["poly"], parent=root, bevel=0.005)
    L.box("Slide", (0.048, 0.215, 0.05), loc=(0, 0.02, 0.052),
          material=M["steel"], parent=root, bevel=0.006)
    L.box("SlideRail", (0.05, 0.06, 0.012), loc=(0, -0.05, 0.052),
          material=M["dark"], parent=root)

    # Barrel poking out of the slide.
    L.cyl("Barrel", 0.011, 0.05, rot=(HALF_PI, 0, 0), loc=(0, 0.145, 0.052),
          segments=12, material=M["accent"], parent=root)

    # Grip, raked back like a real pistol.
    L.box("Handle", (0.042, 0.062, 0.145), loc=(0, -0.062, -0.095),
          rot=(-0.28, 0, 0), material=M["poly"], parent=root, bevel=0.008)
    L.box("Magazine", (0.03, 0.04, 0.03), loc=(0, -0.083, -0.168),
          rot=(-0.28, 0, 0), material=M["dark"], parent=root)

    # Trigger group.
    L.box("TriggerGuard", (0.03, 0.055, 0.012), loc=(0, -0.022, -0.048),
          material=M["poly"], parent=root)
    L.box("Trigger", (0.012, 0.012, 0.028), loc=(0, -0.026, -0.03),
          material=M["dark"], parent=root)

    L.box("Sight", (0.01, 0.012, 0.01), loc=(0, 0.105, 0.082),
          material=M["sight"], parent=root)

    _markers(root, muzzle=(0, 0.175, 0.052), grip=(0, -0.06, -0.09),
             eject=(0.026, 0.02, 0.062))
    tris = L.tri_count()
    L.export("wpn_pistol.glb")
    return tris


def build_smg():
    L.reset()
    M = _materials()
    root = L.group("Root")

    L.box("Receiver", (0.055, 0.30, 0.085), loc=(0, 0.03, 0),
          material=M["poly"], parent=root, bevel=0.007)
    L.box("Rail", (0.04, 0.2, 0.014), loc=(0, 0.06, 0.05),
          material=M["dark"], parent=root)
    L.cyl("Barrel", 0.013, 0.14, rot=(HALF_PI, 0, 0), loc=(0, 0.23, 0.008),
          segments=12, material=M["steel"], parent=root)
    L.cyl("Shroud", 0.022, 0.09, rot=(HALF_PI, 0, 0), loc=(0, 0.205, 0.008),
          segments=12, material=M["dark"], parent=root)

    L.box("Handle", (0.04, 0.055, 0.125), loc=(0, -0.075, -0.09),
          rot=(-0.24, 0, 0), material=M["poly"], parent=root, bevel=0.007)
    L.box("Magazine", (0.032, 0.05, 0.16), loc=(0, -0.005, -0.10),
          rot=(-0.08, 0, 0), material=M["dark"], parent=root, bevel=0.005)
    L.box("Foregrip", (0.032, 0.04, 0.085), loc=(0, 0.135, -0.062),
          material=M["poly"], parent=root, bevel=0.006)

    # Folding stock: two struts and a pad.
    L.box("StockTop", (0.012, 0.16, 0.012), loc=(-0.02, -0.185, 0.02),
          material=M["steel"], parent=root)
    L.box("StockBot", (0.012, 0.16, 0.012), loc=(0.02, -0.185, 0.02),
          material=M["steel"], parent=root)
    L.box("StockPad", (0.05, 0.025, 0.075), loc=(0, -0.268, 0.015),
          material=M["poly"], parent=root, bevel=0.008)

    L.box("Sight", (0.012, 0.03, 0.012), loc=(0, 0.12, 0.064),
          material=M["sight"], parent=root)

    _markers(root, muzzle=(0, 0.30, 0.008), grip=(0, -0.07, -0.085),
             eject=(0.03, 0.05, 0.02))
    tris = L.tri_count()
    L.export("wpn_smg.glb")
    return tris


def build_rifle():
    L.reset()
    M = _materials()
    root = L.group("Root")

    L.box("Receiver", (0.06, 0.36, 0.095), loc=(0, 0.04, 0),
          material=M["poly"], parent=root, bevel=0.007)
    L.box("Rail", (0.042, 0.30, 0.015), loc=(0, 0.10, 0.055),
          material=M["dark"], parent=root)
    L.box("Handguard", (0.05, 0.22, 0.06), loc=(0, 0.24, -0.005),
          material=M["dark"], parent=root, bevel=0.006)
    L.cyl("Barrel", 0.013, 0.30, rot=(HALF_PI, 0, 0), loc=(0, 0.40, 0.005),
          segments=12, material=M["steel"], parent=root)
    L.cyl("Muzzlebrake", 0.021, 0.06, rot=(HALF_PI, 0, 0), loc=(0, 0.53, 0.005),
          segments=12, material=M["accent"], parent=root)

    L.box("Handle", (0.04, 0.052, 0.12), loc=(0, -0.085, -0.088),
          rot=(-0.3, 0, 0), material=M["poly"], parent=root, bevel=0.007)
    L.box("Magazine", (0.034, 0.07, 0.19), loc=(0, 0.0, -0.115),
          rot=(0.18, 0, 0), material=M["dark"], parent=root, bevel=0.006)

    L.box("Stock", (0.045, 0.20, 0.075), loc=(0, -0.21, -0.01),
          material=M["poly"], parent=root, bevel=0.01)
    L.box("StockPad", (0.05, 0.03, 0.105), loc=(0, -0.32, -0.02),
          material=M["dark"], parent=root, bevel=0.01)
    L.box("Cheek", (0.04, 0.14, 0.03), loc=(0, -0.20, 0.045),
          material=M["poly"], parent=root, bevel=0.006)

    # Optic.
    L.cyl("Scope", 0.024, 0.13, rot=(HALF_PI, 0, 0), loc=(0, 0.06, 0.092),
          segments=14, material=M["dark"], parent=root)
    L.box("ScopeMount", (0.03, 0.04, 0.03), loc=(0, 0.03, 0.065),
          material=M["steel"], parent=root)
    L.cyl("Reticle", 0.016, 0.006, rot=(HALF_PI, 0, 0), loc=(0, -0.005, 0.092),
          segments=12, material=M["sight"], parent=root)

    _markers(root, muzzle=(0, 0.56, 0.005), grip=(0, -0.08, -0.082),
             eject=(0.033, 0.08, 0.02))
    tris = L.tri_count()
    L.export("wpn_rifle.glb")
    return tris


def build_shotgun():
    L.reset()
    M = _materials()
    root = L.group("Root")

    L.box("Receiver", (0.055, 0.24, 0.09), loc=(0, 0.02, 0),
          material=M["steel"], parent=root, bevel=0.007)
    L.cyl("Barrel", 0.019, 0.46, rot=(HALF_PI, 0, 0), loc=(0, 0.36, 0.022),
          segments=14, material=M["dark"], parent=root)
    L.cyl("Tube", 0.016, 0.40, rot=(HALF_PI, 0, 0), loc=(0, 0.33, -0.026),
          segments=12, material=M["steel"], parent=root)

    # Pump, kept as its own object so the engine can slide it on firing.
    L.box("Pump", (0.052, 0.10, 0.05), loc=(0, 0.26, -0.026),
          material=M["wood"], parent=root, bevel=0.008)

    L.box("Stock", (0.05, 0.26, 0.085), loc=(0, -0.20, -0.045),
          rot=(-0.1, 0, 0), material=M["wood"], parent=root, bevel=0.012)
    L.box("StockPad", (0.052, 0.025, 0.10), loc=(0, -0.325, -0.062),
          material=M["dark"], parent=root, bevel=0.01)

    L.box("TriggerGuard", (0.03, 0.06, 0.012), loc=(0, -0.05, -0.052),
          material=M["steel"], parent=root)
    L.box("Trigger", (0.012, 0.012, 0.026), loc=(0, -0.055, -0.036),
          material=M["dark"], parent=root)
    L.box("Bead", (0.008, 0.008, 0.012), loc=(0, 0.575, 0.046),
          material=M["sight"], parent=root)

    _markers(root, muzzle=(0, 0.59, 0.022), grip=(0, -0.06, -0.055),
             eject=(0.03, 0.02, 0.02))
    tris = L.tri_count()
    L.export("wpn_shotgun.glb")
    return tris


BUILDERS = [
    ("wpn_pistol.glb", build_pistol),
    ("wpn_smg.glb", build_smg),
    ("wpn_rifle.glb", build_rifle),
    ("wpn_shotgun.glb", build_shotgun),
]


def main():
    print("building weapons")
    total = 0
    for name, fn in BUILDERS:
        tris = fn()
        total += tris
        print(f"    {name:<18} {tris:>5} tris")
    print(f"  weapons total: {total} tris")


if __name__ == "__main__":
    main()
