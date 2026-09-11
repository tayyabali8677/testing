"""
Characters.

Rigged as a plain object hierarchy rather than an armature. For blocky
low-poly limbs, bone skinning buys nothing and automatic weights tend to
smear the joints, whereas a node hierarchy exports to glTF as clean TRS
tracks that three.js AnimationMixer plays directly.

Hierarchy (joints are empties, meshes hang off them):

    Root
      Hips
        Pelvis mesh
        Spine
          Torso mesh
          Head            -> skull, hair, face
          Arm_L  -> Forearm_L -> Hand_L
          Arm_R  -> Forearm_R -> Hand_R      (weapons attach to Hand_R)
        Leg_L  -> Shin_L -> Foot_L
        Leg_R  -> Shin_R -> Foot_R

Clips: Idle, Walk, Run.
"""

import math
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

import lib as L

# Joint heights, in metres, for a 1.80 m character standing with feet at z=0.
HIP_Z = 0.92
SPINE_Z = 1.02
SHOULDER_Z = 1.45
ELBOW_Z = 1.16
WRIST_Z = 0.90
NECK_Z = 1.52
KNEE_Z = 0.46
ANKLE_Z = 0.09

HIP_X = 0.10
SHOULDER_X = 0.22


class Rig:
    """Tracks world-space joint positions so children get correct local offsets."""

    def __init__(self):
        self.world = {}

    def joint(self, name, pos, parent=None):
        obj = L.empty(name, loc=(0, 0, 0), parent=parent)
        base = self.world.get(parent.name, (0, 0, 0)) if parent else (0, 0, 0)
        obj.location = (pos[0] - base[0], pos[1] - base[1], pos[2] - base[2])
        self.world[name] = pos
        return obj

    def mesh(self, name, size, center, joint, material, bevel=0.012, rot=(0, 0, 0)):
        """Box built in world space, re-anchored onto its joint's origin."""
        pivot = self.world[joint.name]
        obj = L.box(name, size, loc=center, rot=rot, pivot=pivot,
                    material=material, parent=joint, bevel=bevel)
        obj.location = (0, 0, 0)   # already baked relative to the joint
        return obj


def _materials(skin, shirt, trousers, shoes, hair, accent=None):
    return {
        "skin": L.mat("Skin", L.hexcol(skin), roughness=0.7),
        "shirt": L.mat("Shirt", L.hexcol(shirt), roughness=0.8),
        "trousers": L.mat("Trousers", L.hexcol(trousers), roughness=0.85),
        "shoes": L.mat("Shoes", L.hexcol(shoes), roughness=0.6),
        "hair": L.mat("Hair", L.hexcol(hair), roughness=0.85),
        "accent": L.mat("Accent", L.hexcol(accent or shirt), roughness=0.5,
                        metallic=0.3),
        "eye": L.mat("Eye", L.hexcol("#14181f"), roughness=0.25),
    }


def build_body(spec):
    """Construct the rig and geometry. Returns (rig, animated joint list)."""
    M = _materials(spec["skin"], spec["shirt"], spec["trousers"],
                   spec["shoes"], spec["hair"], spec.get("accent"))

    rig = Rig()
    root = L.group("Root")
    rig.world["Root"] = (0, 0, 0)

    hips = rig.joint("Hips", (0, 0, HIP_Z), root)
    spine = rig.joint("Spine", (0, 0, SPINE_Z), hips)
    head = rig.joint("Head", (0, 0, NECK_Z), spine)

    arm_l = rig.joint("Arm_L", (-SHOULDER_X, 0, SHOULDER_Z), spine)
    fore_l = rig.joint("Forearm_L", (-SHOULDER_X, 0, ELBOW_Z), arm_l)
    hand_l = rig.joint("Hand_L", (-SHOULDER_X, 0, WRIST_Z), fore_l)

    arm_r = rig.joint("Arm_R", (SHOULDER_X, 0, SHOULDER_Z), spine)
    fore_r = rig.joint("Forearm_R", (SHOULDER_X, 0, ELBOW_Z), arm_r)
    hand_r = rig.joint("Hand_R", (SHOULDER_X, 0, WRIST_Z), fore_r)

    leg_l = rig.joint("Leg_L", (-HIP_X, 0, HIP_Z), hips)
    shin_l = rig.joint("Shin_L", (-HIP_X, 0, KNEE_Z), leg_l)
    foot_l = rig.joint("Foot_L", (-HIP_X, 0, ANKLE_Z), shin_l)

    leg_r = rig.joint("Leg_R", (HIP_X, 0, HIP_Z), hips)
    shin_r = rig.joint("Shin_R", (HIP_X, 0, KNEE_Z), leg_r)
    foot_r = rig.joint("Foot_R", (HIP_X, 0, ANKLE_Z), shin_r)

    build = spec.get("build", 1.0)      # 1.0 average, >1 heavier
    w = lambda v: v * build

    # ---- torso -----------------------------------------------------------
    rig.mesh("Pelvis", (w(0.31), 0.19, 0.20), (0, 0, 0.965), hips, M["trousers"])
    rig.mesh("Torso", (w(0.39), 0.22, 0.40), (0, 0, 1.255), spine, M["shirt"])
    rig.mesh("Shoulders", (w(0.46), 0.21, 0.13), (0, 0, 1.425), spine,
             M["shirt"], bevel=0.02)

    if spec.get("vest"):
        rig.mesh("Vest", (w(0.42), 0.25, 0.30), (0, 0, 1.27), spine,
                 M["accent"], bevel=0.02)

    # ---- head ------------------------------------------------------------
    rig.mesh("Neck", (0.10, 0.10, 0.07), (0, 0, 1.555), head, M["skin"],
             bevel=0.008)
    rig.mesh("Skull", (0.20, 0.215, 0.235), (0, 0, 1.705), head, M["skin"],
             bevel=0.03)
    rig.mesh("Hair", (0.212, 0.225, 0.09), (0, -0.005, 1.795), head, M["hair"],
             bevel=0.025)
    rig.mesh("Eye_L", (0.035, 0.02, 0.022), (-0.048, 0.108, 1.715), head, M["eye"],
             bevel=0.0)
    rig.mesh("Eye_R", (0.035, 0.02, 0.022), (0.048, 0.108, 1.715), head, M["eye"],
             bevel=0.0)

    if spec.get("cap"):
        rig.mesh("Cap", (0.215, 0.23, 0.07), (0, 0, 1.835), head, M["accent"],
                 bevel=0.02)
        rig.mesh("Peak", (0.19, 0.10, 0.02), (0, 0.15, 1.805), head, M["accent"],
                 bevel=0.008)

    # ---- arms ------------------------------------------------------------
    sleeve = M["shirt"] if spec.get("sleeves", True) else M["skin"]
    for side, arm, fore, hand in ((-1, arm_l, fore_l, hand_l),
                                  (1, arm_r, fore_r, hand_r)):
        sx = side * SHOULDER_X
        tag = "L" if side < 0 else "R"
        rig.mesh(f"UpperArm_{tag}", (w(0.105), 0.12, 0.30), (sx, 0, 1.30),
                 arm, sleeve)
        rig.mesh(f"LowerArm_{tag}", (w(0.092), 0.10, 0.27), (sx, 0, 1.025),
                 fore, M["skin"])
        rig.mesh(f"Fist_{tag}", (0.095, 0.11, 0.11), (sx, 0.01, 0.855),
                 hand, M["skin"], bevel=0.02)

    # ---- legs ------------------------------------------------------------
    for side, leg, shin, foot in ((-1, leg_l, shin_l, foot_l),
                                  (1, leg_r, shin_r, foot_r)):
        sx = side * HIP_X
        tag = "L" if side < 0 else "R"
        rig.mesh(f"Thigh_{tag}", (w(0.155), 0.175, 0.47), (sx, 0, 0.685),
                 leg, M["trousers"])
        rig.mesh(f"Calf_{tag}", (w(0.135), 0.15, 0.38), (sx, 0, 0.27),
                 shin, M["trousers"])
        rig.mesh(f"Shoe_{tag}", (0.135, 0.26, 0.09), (sx, 0.055, 0.045),
                 foot, M["shoes"], bevel=0.02)

    animated = dict(
        hips=hips, spine=spine, head=head,
        arm_l=arm_l, arm_r=arm_r, fore_l=fore_l, fore_r=fore_r,
        leg_l=leg_l, leg_r=leg_r, shin_l=shin_l, shin_r=shin_r,
        foot_l=foot_l, foot_r=foot_r,
    )
    return rig, animated


# --------------------------------------------------------------------------
# animation clips
# --------------------------------------------------------------------------

def _all(joints):
    return list(joints.values())


def clip_idle(J):
    """Slow breathing plus a small weight shift.

    Every joint gets some motion, however slight. A channel whose value never
    changes is dropped by the exporter, and a joint with no track in Idle
    keeps whatever pose Walk last left it in when the mixer blends back.
    """
    L.start_clip(_all(J))
    span = 48
    for f, amt in ((1, 0.0), (13, 1.0), (25, 0.0), (37, -1.0), (49, 0.0)):
        L.key(J["hips"], f, location=(0, 0, HIP_Z + amt * 0.008),
              rotation=(0, 0, amt * 0.02))
        L.key(J["spine"], f, rotation=(-amt * 0.018, 0, 0))
        L.key(J["head"], f, rotation=(amt * 0.012, 0, amt * 0.03))
        L.key(J["arm_l"], f, rotation=(amt * 0.02, 0, -0.07 - amt * 0.012))
        L.key(J["arm_r"], f, rotation=(-amt * 0.02, 0, 0.07 + amt * 0.012))
        L.key(J["fore_l"], f, rotation=(-0.12 - amt * 0.03, 0, 0))
        L.key(J["fore_r"], f, rotation=(-0.12 + amt * 0.03, 0, 0))
        # Weight shifts from one leg to the other.
        L.key(J["leg_l"], f, rotation=(amt * 0.015, 0, 0))
        L.key(J["leg_r"], f, rotation=(-amt * 0.015, 0, 0))
        L.key(J["shin_l"], f, rotation=(-0.02 - max(0.0, amt) * 0.03, 0, 0))
        L.key(J["shin_r"], f, rotation=(-0.02 - max(0.0, -amt) * 0.03, 0, 0))
        L.key(J["foot_l"], f, rotation=(amt * 0.01, 0, 0))
        L.key(J["foot_r"], f, rotation=(-amt * 0.01, 0, 0))
    L.push_clip(_all(J), "Idle", 1, span + 1)


def _gait(J, name, span, swing, knee, arm, bob, lean):
    """One symmetric walk/run cycle.

    Phase runs 0..1 over the clip; the right side is half a cycle behind the
    left, which is what makes it read as walking rather than hopping.
    """
    L.start_clip(_all(J))
    steps = 8
    for i in range(steps + 1):
        f = 1 + i * (span / steps)
        t = i / steps
        a = math.sin(t * math.tau)          # left leg forward swing
        b = math.sin(t * math.tau + math.pi)  # right leg, opposite phase

        L.key(J["hips"], f,
              location=(0, 0, HIP_Z + abs(math.sin(t * math.tau * 2)) * bob),
              rotation=(lean, 0, -a * 0.05))
        L.key(J["spine"], f, rotation=(lean * 0.5, 0, a * 0.06))
        L.key(J["head"], f, rotation=(-lean * 0.6, 0, -a * 0.03))

        L.key(J["leg_l"], f, rotation=(a * swing, 0, 0))
        L.key(J["leg_r"], f, rotation=(b * swing, 0, 0))
        # Knees only bend one way, and most on the back-swing.
        L.key(J["shin_l"], f, rotation=(-max(0.0, -a) * knee - knee * 0.12, 0, 0))
        L.key(J["shin_r"], f, rotation=(-max(0.0, -b) * knee - knee * 0.12, 0, 0))
        L.key(J["foot_l"], f, rotation=(a * 0.18, 0, 0))
        L.key(J["foot_r"], f, rotation=(b * 0.18, 0, 0))

        # Arms counter-swing against the legs.
        L.key(J["arm_l"], f, rotation=(b * arm, 0, -0.07))
        L.key(J["arm_r"], f, rotation=(a * arm, 0, 0.07))
        L.key(J["fore_l"], f, rotation=(-0.2 - max(0.0, b) * 0.35, 0, 0))
        L.key(J["fore_r"], f, rotation=(-0.2 - max(0.0, a) * 0.35, 0, 0))

    L.push_clip(_all(J), name, 1, span + 1)


def build_character(spec):
    L.reset()
    rig, J = build_body(spec)

    clip_idle(J)
    _gait(J, "Walk", span=32, swing=0.42, knee=0.55, arm=0.30,
          bob=0.022, lean=0.03)
    _gait(J, "Run", span=20, swing=0.78, knee=1.05, arm=0.62,
          bob=0.050, lean=0.16)

    L.set_interpolation(_all(J), 'BEZIER')

    tris = L.tri_count()
    L.export(spec["file"], animations=True)
    return tris


CHARACTERS = [
    dict(file="char_player.glb", skin="#c79a6b", shirt="#2b3d57",
         trousers="#23262e", shoes="#15171b", hair="#2a2119", build=1.05),

    dict(file="char_male.glb", skin="#b8825a", shirt="#6a8f5e",
         trousers="#38414f", shoes="#1d1f24", hair="#1d1712"),

    dict(file="char_female.glb", skin="#d9ab84", shirt="#a8496b",
         trousers="#2f3540", shoes="#23252b", hair="#4a2c1c", build=0.9),

    dict(file="char_cop.glb", skin="#c08a60", shirt="#1d2b47",
         trousers="#16203a", shoes="#111318", hair="#241c15",
         accent="#0f1626", vest=True, cap=True, build=1.1),

    dict(file="char_worker.glb", skin="#8f6340", shirt="#d8892a",
         trousers="#3a3f46", shoes="#2b2118", hair="#141210",
         accent="#f0b323", cap=True, build=1.12),

    dict(file="char_business.glb", skin="#e0bb95", shirt="#1b1e26",
         trousers="#1b1e26", shoes="#0f1013", hair="#3a2a1c",
         accent="#8a1f2b", build=0.98),
]


def main():
    print("building characters")
    total = 0
    for spec in CHARACTERS:
        tris = build_character(spec)
        total += tris
        print(f"    {spec['file']:<20} {tris:>5} tris")
    print(f"  characters total: {total} tris")


if __name__ == "__main__":
    main()
