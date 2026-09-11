"""
Shared helpers for the Liberty Grid asset scripts.

Everything is built from bmesh primitives and baked straight into mesh data,
so exported objects keep an identity transform unless they need a pivot for
runtime animation (wheels, limbs). That keeps the glTF clean and predictable
on the three.js side.

Runs either way:
    python3 tools/blender/build_all.py          # bpy installed as a module
    blender --background --python tools/blender/build_all.py
"""

import math
import os
import sys

import bpy  # must come first: bmesh/mathutils register with the bpy runtime
import bmesh
from mathutils import Euler, Vector

TAU = math.pi * 2
DEG = math.pi / 180.0

# Repo root, regardless of where the script is invoked from.
ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), "..", ".."))
OUT_DIR = os.path.join(ROOT, "assets", "models")


# --------------------------------------------------------------------------
# scene
# --------------------------------------------------------------------------

def reset():
    """Wipe to a completely empty scene."""
    bpy.ops.wm.read_factory_settings(use_empty=True)
    # read_factory_settings leaves orphaned datablocks around between builds.
    for coll in (bpy.data.meshes, bpy.data.materials, bpy.data.actions,
                 bpy.data.armatures, bpy.data.objects):
        for item in list(coll):
            try:
                coll.remove(item)
            except RuntimeError:
                pass


def link(obj):
    bpy.context.scene.collection.objects.link(obj)
    return obj


# --------------------------------------------------------------------------
# materials
# --------------------------------------------------------------------------

def mat(name, color, metallic=0.0, roughness=0.65, emission=None,
        emission_strength=3.0, alpha=1.0):
    """Create (or fetch) a Principled BSDF material.

    color/emission are 0-1 RGB tuples.
    """
    if name in bpy.data.materials:
        return bpy.data.materials[name]

    m = bpy.data.materials.new(name)
    m.use_nodes = True
    bsdf = m.node_tree.nodes.get("Principled BSDF")

    def setin(key, value):
        if key in bsdf.inputs:
            bsdf.inputs[key].default_value = value

    setin("Base Color", (color[0], color[1], color[2], 1.0))
    setin("Metallic", metallic)
    setin("Roughness", roughness)
    setin("Alpha", alpha)

    if emission is not None:
        setin("Emission Color", (emission[0], emission[1], emission[2], 1.0))
        setin("Emission Strength", emission_strength)

    if alpha < 1.0:
        m.blend_method = 'BLEND'

    return m


def hexcol(s):
    """'#rrggbb' -> linear-ish 0-1 tuple. Good enough for stylised assets."""
    s = s.lstrip("#")
    if len(s) == 3:
        s = "".join(c * 2 for c in s)
    if len(s) != 6:
        raise ValueError(f"bad hex colour: {s!r}")
    srgb = [int(s[i:i + 2], 16) / 255.0 for i in (0, 2, 4)]
    # sRGB -> linear, so colours look right in Blender and glTF viewers.
    out = []
    for c in srgb:
        out.append(c / 12.92 if c <= 0.04045 else ((c + 0.055) / 1.055) ** 2.4)
    return tuple(out)


# --------------------------------------------------------------------------
# primitives
# --------------------------------------------------------------------------

def _finish(name, bm, pivot, material, parent, bevel, bevel_segments):
    if bevel and bevel > 0:
        geom = list(bm.verts) + list(bm.edges) + list(bm.faces)
        try:
            bmesh.ops.bevel(
                bm, geom=geom, offset=bevel, segments=bevel_segments,
                profile=0.5, affect='EDGES', clamp_overlap=True,
            )
        except (TypeError, RuntimeError):
            pass  # a degenerate bevel is not worth failing the whole build

    if pivot != (0, 0, 0):
        bmesh.ops.translate(bm, verts=bm.verts,
                            vec=(-pivot[0], -pivot[1], -pivot[2]))

    mesh = bpy.data.meshes.new(name)
    bm.to_mesh(mesh)
    bm.free()

    obj = bpy.data.objects.new(name, mesh)
    obj.location = pivot
    link(obj)

    if material is not None:
        mesh.materials.append(material)
    if parent is not None:
        obj.parent = parent

    return obj


def _place(bm, loc, rot):
    if rot != (0, 0, 0):
        m = Euler(rot, 'XYZ').to_matrix().to_4x4()
        bmesh.ops.transform(bm, matrix=m, verts=bm.verts)
    if loc != (0, 0, 0):
        bmesh.ops.translate(bm, verts=bm.verts, vec=loc)


def box(name, size, loc=(0, 0, 0), rot=(0, 0, 0), material=None, parent=None,
        pivot=(0, 0, 0), bevel=0.0, bevel_segments=2, taper=None):
    """Axis-aligned box, centred on `loc`, then optionally rotated.

    taper: (sx, sy) scale applied to the +Z face only, for wedge shapes.
    """
    bm = bmesh.new()
    bmesh.ops.create_cube(bm, size=1.0)
    bmesh.ops.scale(bm, vec=Vector(size), verts=bm.verts)

    if taper is not None:
        top = max(v.co.z for v in bm.verts)
        for v in bm.verts:
            if abs(v.co.z - top) < 1e-6:
                v.co.x *= taper[0]
                v.co.y *= taper[1]

    _place(bm, loc, rot)
    return _finish(name, bm, pivot, material, parent, bevel, bevel_segments)


def cyl(name, radius, depth, loc=(0, 0, 0), rot=(0, 0, 0), segments=16,
        radius_top=None, material=None, parent=None, pivot=(0, 0, 0),
        bevel=0.0, bevel_segments=1):
    """Cylinder along +Z. radius_top < radius gives a cone/frustum."""
    bm = bmesh.new()
    r_top = radius if radius_top is None else radius_top
    bmesh.ops.create_cone(
        bm, cap_ends=True, cap_tris=False, segments=segments,
        radius1=radius, radius2=r_top, depth=depth,
    )
    _place(bm, loc, rot)
    return _finish(name, bm, pivot, material, parent, bevel, bevel_segments)


def sphere(name, radius, loc=(0, 0, 0), u=16, v=10, material=None,
           parent=None, pivot=(0, 0, 0), squash=None):
    bm = bmesh.new()
    bmesh.ops.create_uvsphere(bm, u_segments=u, v_segments=v, radius=radius)
    if squash is not None:
        bmesh.ops.scale(bm, vec=Vector(squash), verts=bm.verts)
    _place(bm, loc, (0, 0, 0))
    return _finish(name, bm, pivot, material, parent, 0.0, 1)


def empty(name, loc=(0, 0, 0), parent=None):
    """Marker node, e.g. a muzzle point. Exports as an empty glTF node."""
    obj = bpy.data.objects.new(name, None)
    obj.empty_display_size = 0.06
    obj.location = loc
    link(obj)
    if parent is not None:
        obj.parent = parent
    return obj


def group(name, loc=(0, 0, 0), parent=None):
    """Invisible transform node used to parent a whole asset."""
    return empty(name, loc, parent)


def mirror_x(obj, name):
    """Duplicate an object mirrored across X, baked into the mesh."""
    mesh = obj.data.copy()
    for v in mesh.vertices:
        v.co.x = -v.co.x
    mesh.flip_normals()
    dup = bpy.data.objects.new(name, mesh)
    dup.location = (-obj.location.x, obj.location.y, obj.location.z)
    dup.parent = obj.parent
    link(dup)
    return dup


# --------------------------------------------------------------------------
# animation
# --------------------------------------------------------------------------

def key(obj, frame, location=None, rotation=None, scale=None):
    """Insert a keyframe on whichever channels are supplied."""
    if location is not None:
        obj.location = location
        obj.keyframe_insert("location", frame=frame)
    if rotation is not None:
        obj.rotation_euler = rotation
        obj.keyframe_insert("rotation_euler", frame=frame)
    if scale is not None:
        obj.scale = scale
        obj.keyframe_insert("scale", frame=frame)


def start_clip(objs):
    """Detach any current action so a fresh one is recorded."""
    for o in objs:
        if o.animation_data is not None:
            o.animation_data.action = None


def push_clip(objs, clip_name, start=1, end=24):
    """Bank each object's current action into an NLA track named `clip_name`.

    The glTF exporter emits one named animation per NLA track, which is how
    three.js ends up with clips called 'Idle', 'Walk', 'Run'.
    """
    for o in objs:
        ad = o.animation_data
        if ad is None or ad.action is None:
            continue
        action = ad.action
        action.name = f"{clip_name}_{o.name}"
        track = ad.nla_tracks.new()
        track.name = clip_name
        track.strips.new(clip_name, int(start), action)
        ad.action = None

    scene = bpy.context.scene
    scene.frame_start = int(start)
    scene.frame_end = int(end)


def set_interpolation(objs, kind='LINEAR'):
    for o in objs:
        ad = o.animation_data
        if ad is None:
            continue
        actions = [s.action for t in ad.nla_tracks for s in t.strips]
        if ad.action:
            actions.append(ad.action)
        for act in actions:
            if act is None:
                continue
            for fc in act.fcurves:
                for kp in fc.keyframe_points:
                    kp.interpolation = kind


# --------------------------------------------------------------------------
# export
# --------------------------------------------------------------------------

def export(filename, animations=False):
    """Write the whole scene to assets/models/<filename>.glb."""
    os.makedirs(OUT_DIR, exist_ok=True)
    path = os.path.join(OUT_DIR, filename)

    opts = dict(
        filepath=path,
        export_format='GLB',
        export_apply=True,
        export_yup=True,
        export_cameras=False,
        export_lights=False,
    )
    if animations:
        opts.update(
            export_animations=True,
            export_animation_mode='NLA_TRACKS',
            export_frame_range=False,
            export_bake_animation=True,
        )
    else:
        opts.update(export_animations=False)

    # The exporter's keyword set shifts between Blender versions; drop any it
    # does not recognise rather than hard-failing the build.
    while True:
        try:
            bpy.ops.export_scene.gltf(**opts)
            break
        except TypeError as exc:
            msg = str(exc)
            bad = None
            for k in list(opts):
                if k in msg and k not in ("filepath", "export_format"):
                    bad = k
                    break
            if bad is None:
                raise
            opts.pop(bad)

    size = os.path.getsize(path)
    print(f"  wrote {filename}  ({size/1024:.1f} KB)")
    return path


def tri_count():
    total = 0
    for o in bpy.data.objects:
        if o.type == 'MESH':
            o.data.calc_loop_triangles()
            total += len(o.data.loop_triangles)
    return total
