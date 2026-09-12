#!/usr/bin/env python3
"""
Generate the PWA icon set with no image libraries.

No PIL, no ImageMagick, no cairosvg available in this environment, so this
writes raw PNG bytes directly: build an RGBA pixel buffer by hand (simple
distance-based circle and rounded-rect tests), zlib-deflate the scanlines,
and wrap them in the PNG chunk structure. Good enough for flat, iconographic
art like this; not something you'd reach for over Pillow if it were installed.

    python3 tools/make_icons.py
"""

import os
import struct
import zlib

ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), ".."))
OUT = os.path.join(ROOT, "assets", "icons")

BG = (14, 17, 23)          # #0e1117, matches the game's dark background
RING = (255, 211, 77)      # #ffd34d, the brand yellow used across the HUD
RING_DARK = (167, 130, 20)
HUB = (255, 211, 77)


def write_png(path, w, h, pixels):
    """pixels: list of h rows, each a list of w (r,g,b,a) tuples."""
    raw = bytearray()
    for row in pixels:
        raw.append(0)  # filter type 0 (none) per scanline
        for (r, g, b, a) in row:
            raw += bytes((r, g, b, a))

    def chunk(tag, data):
        c = tag + data
        return struct.pack(">I", len(data)) + c + struct.pack(">I", zlib.crc32(c))

    sig = b"\x89PNG\r\n\x1a\n"
    ihdr = struct.pack(">IIBBBBB", w, h, 8, 6, 0, 0, 0)  # 8-bit RGBA
    idat = zlib.compress(bytes(raw), 9)

    with open(path, "wb") as f:
        f.write(sig)
        f.write(chunk(b"IHDR", ihdr))
        f.write(chunk(b"IDAT", idat))
        f.write(chunk(b"IEND", b""))


def lerp(a, b, t):
    return tuple(round(a[i] + (b[i] - a[i]) * t) for i in range(3))


def rounded_rect_mask(x, y, w, h, r):
    """1 if (x,y) is inside a rounded rect of size (w,h) radius r, else 0."""
    if x < r and y < r:
        return (x - r) ** 2 + (y - r) ** 2 <= r * r
    if x >= w - r and y < r:
        return (x - (w - r - 1)) ** 2 + (y - r) ** 2 <= r * r
    if x < r and y >= h - r:
        return (x - r) ** 2 + (y - (h - r - 1)) ** 2 <= r * r
    if x >= w - r and y >= h - r:
        return (x - (w - r - 1)) ** 2 + (y - (h - r - 1)) ** 2 <= r * r
    return True


def draw_icon(size, padding_frac=0.0, rounded=True):
    """
    A simple steering-wheel glyph: a ring, three spokes, a hub. Recognisable
    as "driving game" at a glance, legible down to launcher-icon sizes.

    padding_frac shrinks the glyph inward, leaving a safe margin — Android's
    "maskable" icon spec crops to a circle/squircle and can clip anything
    outside the centre ~80% safe zone.
    """
    cx = cy = size / 2
    R = size * (0.5 - padding_frac) * 0.82
    ring_w = R * 0.16
    hub_r = R * 0.22
    corner_r = int(size * 0.22)

    pixels = []
    for y in range(size):
        row = []
        for x in range(size):
            if rounded and not rounded_rect_mask(x, y, size, size, corner_r):
                row.append((0, 0, 0, 0))
                continue

            dx, dy = x - cx, y - cy
            d = (dx * dx + dy * dy) ** 0.5
            ang = None

            color = BG
            if d <= hub_r:
                color = HUB
            elif R - ring_w <= d <= R:
                # Shade the ring like a chunky bevel: brighter near the top.
                t = 0.5 + 0.5 * (-dy / max(d, 1))
                color = lerp(RING_DARK, RING, t)
            elif d < R - ring_w:
                # Three spokes, 120 degrees apart, hub to inner ring edge.
                import math
                ang = math.atan2(dy, dx)
                spoke_half_width = 0.24
                on_spoke = False
                for k in range(3):
                    a0 = -math.pi / 2 + k * (2 * math.pi / 3)
                    diff = (ang - a0 + math.pi) % (2 * math.pi) - math.pi
                    if abs(diff) < spoke_half_width and d > hub_r * 0.9:
                        on_spoke = True
                        break
                if on_spoke:
                    color = RING
                else:
                    color = BG
            row.append((*color, 255))
        pixels.append(row)
    return pixels


def main():
    os.makedirs(OUT, exist_ok=True)

    targets = [
        ("icon-512.png", 512, 0.06, True),
        ("icon-192.png", 192, 0.06, True),
        ("icon-180.png", 180, 0.06, True),   # apple-touch-icon
        ("icon-512-maskable.png", 512, 0.18, False),  # safe-zone padded, no
                                                        # rounding: the OS
                                                        # applies its own mask
    ]
    for name, size, pad, rounded in targets:
        pixels = draw_icon(size, padding_frac=pad, rounded=rounded)
        path = os.path.join(OUT, name)
        write_png(path, size, size, pixels)
        print(f"  wrote {name} ({size}x{size}, {os.path.getsize(path)} bytes)")


if __name__ == "__main__":
    main()
