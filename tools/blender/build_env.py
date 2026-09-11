"""
Environment kit.

The city is a square grid. Every node carries an intersection tile, and the
gaps between nodes carry road segments, with a raised block platform filling
the middle of each cell:

    BLOCK_PITCH = 60      distance between intersection centres
    ROAD_W      = 14      carriageway width (also the intersection size)
    SEG_LEN     = 46      BLOCK_PITCH - ROAD_W, the run between intersections
    CURB_H      = 0.15    pavement height above the road

These numbers are re-exported in the manifest so the engine lays tiles out on
exactly the same grid the models were authored for. Change them here and the
city follows.

Road surfaces are single quads with paint quads floating just above them, so
a tile costs a handful of triangles no matter how much marking it carries.
"""

import math
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

import lib as L

BLOCK_PITCH = 60.0
ROAD_W = 14.0
SEG_LEN = BLOCK_PITCH - ROAD_W
CURB_H = 0.15

ROAD_Z = 0.010
PAINT_Z = 0.020


def _materials():
    return {
        "asphalt": L.mat("Asphalt", L.hexcol("#2b2e34"), roughness=0.94),
        "paint": L.mat("PaintWhite", L.hexcol("#d8dce2"), roughness=0.7),
        "yellow": L.mat("PaintYellow", L.hexcol("#d8a521"), roughness=0.7),
        "pave": L.mat("Pavement", L.hexcol("#7e848d"), roughness=0.92),
        "curb": L.mat("Curb", L.hexcol("#9aa0a8"), roughness=0.85),
        "grass": L.mat("Grass", L.hexcol("#3d5f38"), roughness=0.95),
        "dirt": L.mat("Dirt", L.hexcol("#4a4034"), roughness=0.98),
    }


def _quad(cx, cy, w, h, z):
    """Upward-facing quad centred on (cx, cy)."""
    hw, hh = w / 2, h / 2
    return [(cx - hw, cy - hh, z), (cx + hw, cy - hh, z),
            (cx + hw, cy + hh, z), (cx - hw, cy + hh, z)]


def road_segment():
    """Straight run of carriageway, long axis along +Y."""
    L.reset()
    M = _materials()
    root = L.group("Root")

    L.quads("Surface", [_quad(0, 0, ROAD_W, SEG_LEN, ROAD_Z)],
            material=M["asphalt"], parent=root)

    # Dashed centre line.
    dashes = []
    dash_len, gap = 2.4, 2.0
    n = int(SEG_LEN // (dash_len + gap))
    span = n * (dash_len + gap) - gap
    y = -span / 2
    for _ in range(n):
        dashes.append(_quad(0, y + dash_len / 2, 0.16, dash_len, PAINT_Z))
        y += dash_len + gap
    L.quads("CentreLine", dashes, material=M["yellow"], parent=root)

    # Solid edge lines just inside the kerb.
    edge = ROAD_W / 2 - 0.5
    L.quads("EdgeLines", [_quad(-edge, 0, 0.14, SEG_LEN, PAINT_Z),
                          _quad(edge, 0, 0.14, SEG_LEN, PAINT_Z)],
            material=M["paint"], parent=root)

    tris = L.tri_count()
    L.export("env_road_seg.glb")
    return tris


def intersection():
    """Square junction with stop bars and zebra crossings on all four arms."""
    L.reset()
    M = _materials()
    root = L.group("Root")

    L.quads("Surface", [_quad(0, 0, ROAD_W, ROAD_W, ROAD_Z)],
            material=M["asphalt"], parent=root)

    half = ROAD_W / 2
    bars = []
    stripes = []

    for sign in (1, -1):
        # Stop bar across the approach lane.
        bars.append(_quad(sign * ROAD_W * 0.25, sign * (half - 0.7),
                          ROAD_W * 0.44, 0.4, PAINT_Z))
        bars.append(_quad(sign * (half - 0.7), -sign * ROAD_W * 0.25,
                          0.4, ROAD_W * 0.44, PAINT_Z))

        # Zebra crossing: bands running across the carriageway.
        for i in range(6):
            off = -ROAD_W * 0.4 + i * (ROAD_W * 0.8 / 5)
            stripes.append(_quad(off, sign * (half - 2.1),
                                 0.7, 1.5, PAINT_Z))
            stripes.append(_quad(sign * (half - 2.1), off,
                                 1.5, 0.7, PAINT_Z))

    L.quads("StopBars", bars, material=M["paint"], parent=root)
    L.quads("Crossings", stripes, material=M["paint"], parent=root)

    tris = L.tri_count()
    L.export("env_road_cross.glb")
    return tris


def block_platform():
    """Raised pavement filling the middle of a city cell, with a kerb lip."""
    L.reset()
    M = _materials()
    root = L.group("Root")
    S = SEG_LEN

    L.box("Pavement", (S, S, CURB_H), loc=(0, 0, CURB_H / 2),
          material=M["pave"], parent=root)

    # Kerb edging, slightly proud so the join with the road reads as a step.
    t = 0.5
    for name, sx, sy, w, h in (("Kerb_N", 0, S / 2 - t / 2, S, t),
                               ("Kerb_S", 0, -S / 2 + t / 2, S, t),
                               ("Kerb_E", S / 2 - t / 2, 0, t, S),
                               ("Kerb_W", -S / 2 + t / 2, 0, t, S)):
        L.box(name, (w, h, CURB_H + 0.04), loc=(sx, sy, (CURB_H + 0.04) / 2),
              material=M["curb"], parent=root)

    tris = L.tri_count()
    L.export("env_block.glb")
    return tris


def park_block():
    """Same footprint as a block platform, but planted."""
    L.reset()
    M = _materials()
    root = L.group("Root")
    S = SEG_LEN

    L.box("Ground", (S, S, CURB_H), loc=(0, 0, CURB_H / 2),
          material=M["grass"], parent=root)

    t = 0.5
    for name, sx, sy, w, h in (("Kerb_N", 0, S / 2 - t / 2, S, t),
                               ("Kerb_S", 0, -S / 2 + t / 2, S, t),
                               ("Kerb_E", S / 2 - t / 2, 0, t, S),
                               ("Kerb_W", -S / 2 + t / 2, 0, t, S)):
        L.box(name, (w, h, CURB_H + 0.04), loc=(sx, sy, (CURB_H + 0.04) / 2),
              material=M["curb"], parent=root)

    # Crossing paths, so the park does not look like a bare green square.
    L.quads("Paths", [_quad(0, 0, S * 0.9, 3.0, CURB_H + 0.01),
                      _quad(0, 0, 3.0, S * 0.9, CURB_H + 0.01)],
            material=M["dirt"], parent=root)

    # A low pond in one quadrant.
    L.cyl("Pond", 6.0, 0.1, loc=(S * 0.22, -S * 0.22, CURB_H - 0.02),
          segments=18,
          material=L.mat("Water", L.hexcol("#2f5f7a"), metallic=0.3,
                         roughness=0.08),
          parent=root)

    tris = L.tri_count()
    L.export("env_park.glb")
    return tris


def ground_plane():
    """1x1 quad the engine scales to cover the whole world."""
    L.reset()
    M = _materials()
    root = L.group("Root")
    L.quads("Ground", [_quad(0, 0, 1.0, 1.0, 0.0)],
            material=M["asphalt"], parent=root)
    tris = L.tri_count()
    L.export("env_ground.glb")
    return tris


def parking_lot():
    """Flat lot with bay markings, an alternative to a building on a plot."""
    L.reset()
    M = _materials()
    root = L.group("Root")
    S = SEG_LEN

    L.box("Surface", (S, S, CURB_H), loc=(0, 0, CURB_H / 2),
          material=M["asphalt"], parent=root)

    bays = []
    for row_y in (-S * 0.22, S * 0.22):
        for i in range(9):
            x = -S * 0.36 + i * (S * 0.72 / 8)
            bays.append(_quad(x, row_y, 0.12, 10.0, CURB_H + 0.01))
    L.quads("BayLines", bays, material=M["paint"], parent=root)

    tris = L.tri_count()
    L.export("env_parking.glb")
    return tris


TILES = [
    ("env_road_seg.glb", road_segment),
    ("env_road_cross.glb", intersection),
    ("env_block.glb", block_platform),
    ("env_park.glb", park_block),
    ("env_parking.glb", parking_lot),
    ("env_ground.glb", ground_plane),
]

# Re-exported into the manifest so the engine and the models agree on scale.
GRID = dict(block_pitch=BLOCK_PITCH, road_w=ROAD_W, seg_len=SEG_LEN,
            curb_h=CURB_H)


def main():
    print("building environment")
    total = 0
    for name, fn in TILES:
        tris = fn()
        total += tris
        print(f"    {name:<24} {tris:>5} tris")
    print(f"  environment total: {total} tris")


if __name__ == "__main__":
    main()
