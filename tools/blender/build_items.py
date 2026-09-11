"""
Pickups.

Each item sits with its visual centre roughly at z=0.5 and its Root at the
ground, so the engine can place one on a spot and spin the Root about Z
without the model wobbling off-axis.
"""

import math
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

import lib as L

HALF_PI = math.pi / 2


def _materials():
    return {
        "note": L.mat("Cash", L.hexcol("#4f9e5c"), roughness=0.75),
        "band": L.mat("CashBand", L.hexcol("#c9a227"), roughness=0.5,
                      metallic=0.4),
        "white": L.mat("ItemWhite", L.hexcol("#e9edf2"), roughness=0.5),
        "red": L.mat("ItemRed", L.hexcol("#d23b3b"), roughness=0.5),
        "kevlar": L.mat("Kevlar", L.hexcol("#39424f"), roughness=0.75),
        "metal": L.mat("ItemMetal", L.hexcol("#6b727d"), metallic=0.85,
                       roughness=0.35),
        "brass": L.mat("Brass", L.hexcol("#b08d3f"), metallic=1.0,
                       roughness=0.3),
        "olive": L.mat("Olive", L.hexcol("#59603a"), roughness=0.8),
        "glow": L.mat("ItemGlow", L.hexcol("#ffd34d"),
                      emission=L.hexcol("#ffd34d"), emission_strength=3.0),
        "blue": L.mat("ItemBlue", L.hexcol("#3d7fd2"),
                      emission=L.hexcol("#3d7fd2"), emission_strength=2.0),
    }


def _halo(root, mat, radius=0.5):
    """Flat disc under the pickup so it reads from a distance."""
    L.cyl("Halo", radius, 0.02, loc=(0, 0, 0.02), segments=20,
          material=mat, parent=root)


def cash():
    L.reset()
    M = _materials()
    root = L.group("Root")
    for i in range(4):
        L.box(f"Note_{i}", (0.42, 0.20, 0.035),
              loc=(0, 0, 0.42 + i * 0.045), rot=(0, 0, i * 0.12),
              material=M["note"], parent=root, bevel=0.006)
    L.box("Band", (0.12, 0.21, 0.19), loc=(0, 0, 0.50),
          material=M["band"], parent=root, bevel=0.006)
    _halo(root, M["glow"])
    tris = L.tri_count()
    L.export("item_cash.glb")
    return tris


def health():
    L.reset()
    M = _materials()
    root = L.group("Root")
    L.box("Case", (0.44, 0.30, 0.30), loc=(0, 0, 0.5),
          material=M["white"], parent=root, bevel=0.03)
    L.box("Cross_V", (0.09, 0.31, 0.24), loc=(0, 0, 0.5),
          material=M["red"], parent=root)
    L.box("Cross_H", (0.24, 0.31, 0.09), loc=(0, 0, 0.5),
          material=M["red"], parent=root)
    L.box("Handle", (0.18, 0.04, 0.06), loc=(0, 0, 0.68),
          material=M["metal"], parent=root, bevel=0.01)
    _halo(root, M["glow"])
    tris = L.tri_count()
    L.export("item_health.glb")
    return tris


def armour():
    L.reset()
    M = _materials()
    root = L.group("Root")
    L.box("Vest", (0.42, 0.20, 0.46), loc=(0, 0, 0.52),
          material=M["kevlar"], parent=root, bevel=0.04, taper=(0.8, 1.0))
    L.box("Strap_L", (0.07, 0.21, 0.16), loc=(-0.15, 0, 0.72),
          material=M["olive"], parent=root, bevel=0.01)
    L.box("Strap_R", (0.07, 0.21, 0.16), loc=(0.15, 0, 0.72),
          material=M["olive"], parent=root, bevel=0.01)
    L.box("Plate", (0.26, 0.04, 0.28), loc=(0, 0.10, 0.50),
          material=M["metal"], parent=root, bevel=0.02)
    _halo(root, M["blue"])
    tris = L.tri_count()
    L.export("item_armour.glb")
    return tris


def ammo():
    L.reset()
    M = _materials()
    root = L.group("Root")
    L.box("Crate", (0.50, 0.32, 0.28), loc=(0, 0, 0.46),
          material=M["olive"], parent=root, bevel=0.025)
    L.box("Lid", (0.52, 0.34, 0.05), loc=(0, 0, 0.62),
          material=M["olive"], parent=root, bevel=0.015)
    L.box("Latch", (0.08, 0.35, 0.07), loc=(0, 0, 0.58),
          material=M["metal"], parent=root)
    for i, sx in enumerate((-0.12, 0.0, 0.12)):
        L.cyl(f"Round_{i}", 0.032, 0.16, loc=(sx, 0, 0.70), segments=8,
              material=M["brass"], parent=root)
    _halo(root, M["glow"])
    tris = L.tri_count()
    L.export("item_ammo.glb")
    return tris


def weapon_pickup():
    """Pedestal the engine parks a weapon model on top of."""
    L.reset()
    M = _materials()
    root = L.group("Root")
    L.cyl("Base", 0.34, 0.12, loc=(0, 0, 0.06), segments=14,
          material=M["metal"], parent=root)
    L.cyl("Column", 0.09, 0.5, loc=(0, 0, 0.32), segments=10,
          material=M["metal"], parent=root)
    L.cyl("Top", 0.26, 0.05, loc=(0, 0, 0.59), segments=14,
          material=M["metal"], parent=root)
    L.empty("Mount", loc=(0, 0, 0.66), parent=root)
    _halo(root, M["glow"], radius=0.55)
    tris = L.tri_count()
    L.export("item_weapon_stand.glb")
    return tris


def marker():
    """Mission waypoint: a tall translucent cylinder plus a floating chevron."""
    L.reset()
    M = _materials()
    glow = L.mat("MarkerGlow", L.hexcol("#ffd34d"),
                 emission=L.hexcol("#ffd34d"), emission_strength=2.2,
                 alpha=0.32)
    root = L.group("Root")
    L.cyl("Pillar", 1.5, 6.0, loc=(0, 0, 3.0), segments=22,
          material=glow, parent=root)
    L.cyl("Ring", 1.7, 0.08, loc=(0, 0, 0.05), segments=24,
          material=M["glow"], parent=root)
    L.box("Chevron", (0.9, 0.9, 0.9), loc=(0, 0, 2.4), rot=(0, 0.78, 0.78),
          material=M["glow"], parent=root, bevel=0.05)
    tris = L.tri_count()
    L.export("item_marker.glb")
    return tris


ITEMS = [
    ("item_cash.glb", cash),
    ("item_health.glb", health),
    ("item_armour.glb", armour),
    ("item_ammo.glb", ammo),
    ("item_weapon_stand.glb", weapon_pickup),
    ("item_marker.glb", marker),
]


def main():
    print("building items")
    total = 0
    for name, fn in ITEMS:
        tris = fn()
        total += tris
        print(f"    {name:<24} {tris:>5} tris")
    print(f"  items total: {total} tris")


if __name__ == "__main__":
    main()
