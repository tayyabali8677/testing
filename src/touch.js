// On-screen touch controls for phones and tablets.
//
// This never talks to game systems directly. Every control synthesizes the
// exact input a keyboard and mouse would produce — setKey("KeyW", true),
// addLookDelta(dx, dy), setMouseButton("left", true) — through the same
// Input instance the desktop path uses. That means vehicle physics, aiming,
// shooting and the HUD prompt all work unmodified; they have no idea a
// finger was involved.
//
// Layout is a dynamic joystick (appears wherever the left thumb lands) for
// movement/steering, a drag zone over the rest of the screen for looking,
// and a small button cluster for actions. Running is triggered by pushing
// the joystick past 75% of its travel rather than a separate button, which
// keeps the button count small and mirrors how a analog stick reads on a
// gamepad.

const DEADZONE = 0.22;
const RUN_THRESHOLD = 0.72;
const JOY_RADIUS = 52;   // px the nub can travel from its base

export function hasTouchSupport() {
  return (
    "ontouchstart" in window ||
    (navigator.maxTouchPoints || 0) > 0 ||
    (navigator.msMaxTouchPoints || 0) > 0
  );
}

const CSS = `
.tc-root { position: fixed; inset: 0; z-index: 8; }
.tc-zone {
  position: absolute; touch-action: none;
  -webkit-user-select: none; user-select: none;
}
.tc-joyzone { left: 0; top: 30%; bottom: 0; width: 55%; }
.tc-lookzone { right: 0; top: 0; bottom: 0; left: 55%; }
.tc-lookzone.tc-full { left: 0; }

.tc-joybase, .tc-joynub {
  position: absolute; border-radius: 50%; pointer-events: none;
  opacity: 0; transition: opacity .12s;
}
.tc-joybase {
  width: 108px; height: 108px; margin: -54px 0 0 -54px;
  background: rgba(255,255,255,.06); border: 2px solid rgba(255,255,255,.22);
}
.tc-joynub {
  width: 48px; height: 48px; margin: -24px 0 0 -24px;
  background: rgba(255,255,255,.22); border: 2px solid rgba(255,255,255,.4);
}
.tc-joybase.show, .tc-joynub.show { opacity: 1; }

.tc-btn {
  z-index: 2; touch-action: none; flex: none;
  display: flex; align-items: center; justify-content: center;
  border-radius: 50%; background: rgba(20,23,30,.55);
  border: 2px solid rgba(255,255,255,.28); color: #eef2f7;
  font: 600 12px/1 "Segoe UI", system-ui, sans-serif; letter-spacing: .5px;
  -webkit-user-select: none; user-select: none;
  transition: background .08s, transform .08s;
}
.tc-btn.active { background: rgba(255,211,77,.5); transform: scale(0.94); }
.tc-btn.hidden { visibility: hidden; }

/*
 * The action cluster is anchored to the bottom-right corner as one flex
 * column, sized in vmin rather than fixed pixels. That is what actually
 * fixes button collisions: a phone in landscape is short (its vmin tracks
 * height), so every button in the cluster shrinks together and the whole
 * stack still fits — fixed-pixel offsets, tuned against a tall portrait
 * screen, silently overlapped once the same screen turned 90 degrees and
 * height dropped to a third of its width.
 */
.tc-cluster {
  position: absolute; z-index: 2;
  right: max(14px, env(safe-area-inset-right));
  bottom: max(12px, env(safe-area-inset-bottom));
  display: flex; flex-direction: column; align-items: flex-end;
  gap: clamp(8px, 1.6vmin, 14px);
}
.tc-cluster-row { display: flex; gap: clamp(8px, 1.6vmin, 14px); }

.tc-fire {
  width: clamp(60px, 15vmin, 88px); height: clamp(60px, 15vmin, 88px);
  background: rgba(200,40,40,.42); border-color: rgba(255,120,120,.55);
  font-size: clamp(11px, 2.6vmin, 14px);
}
.tc-fire.active { background: rgba(255,70,70,.65); }
.tc-aim {
  width: clamp(44px, 11vmin, 64px); height: clamp(44px, 11vmin, 64px);
  font-size: clamp(9px, 2vmin, 11px);
}
.tc-reload, .tc-weapon, .tc-enter {
  width: clamp(36px, 9vmin, 52px); height: clamp(36px, 9vmin, 52px);
  font-size: clamp(8px, 1.7vmin, 10px);
}

.tc-map {
  position: absolute; z-index: 2;
  width: clamp(36px, 9vmin, 44px); height: clamp(36px, 9vmin, 44px);
  left: max(14px, env(safe-area-inset-left));
  top: max(14px, env(safe-area-inset-top));
  font-size: clamp(8px, 1.7vmin, 9px);
}
`;

export class TouchControls {
  constructor(canvas, input, opts = {}) {
    this.canvas = canvas;
    this.input = input;
    this.onWeaponCycle = opts.onWeaponCycle || (() => {});
    this.onToggleMap = opts.onToggleMap || (() => {});
    this.active = opts.force || hasTouchSupport();
    this.driving = false;

    // Pointer id -> what it's doing, so a finger moving over a button's old
    // position after a layout change never gets misattributed.
    this.pointers = new Map();

    if (!this.active) return;
    this._build();
    this._bind();
  }

  // ---- construction ------------------------------------------------------

  _build() {
    const style = document.createElement("style");
    style.textContent = CSS;
    document.head.appendChild(style);

    const root = document.createElement("div");
    root.className = "tc-root";
    root.innerHTML = `
      <div class="tc-zone tc-joyzone" data-zone="joy">
        <div class="tc-joybase"></div>
        <div class="tc-joynub"></div>
      </div>
      <div class="tc-zone tc-lookzone" data-zone="look"></div>

      <button class="tc-btn tc-map" data-action="map">MAP</button>

      <div class="tc-cluster">
        <div class="tc-cluster-row">
          <button class="tc-btn tc-weapon" data-action="weapon">WPN</button>
          <button class="tc-btn tc-enter" data-action="enter">ENTER</button>
        </div>
        <div class="tc-cluster-row">
          <button class="tc-btn tc-reload" data-action="reload">RELOAD</button>
          <button class="tc-btn tc-aim" data-action="aim">AIM</button>
        </div>
        <button class="tc-btn tc-fire" data-action="fire">FIRE</button>
      </div>
    `;
    document.body.appendChild(root);
    this.root = root;

    this.el = {
      joyzone: root.querySelector('[data-zone="joy"]'),
      lookzone: root.querySelector('[data-zone="look"]'),
      joybase: root.querySelector(".tc-joybase"),
      joynub: root.querySelector(".tc-joynub"),
      fire: root.querySelector(".tc-fire"),
      aim: root.querySelector(".tc-aim"),
      reload: root.querySelector(".tc-reload"),
      weapon: root.querySelector(".tc-weapon"),
      enter: root.querySelector(".tc-enter"),
      map: root.querySelector(".tc-map"),
    };

    document.body.classList.add("touch-controls");
  }

  // ---- input plumbing -----------------------------------------------------

  _bind() {
    this._onDown = (e) => this._pointerDown(e);
    this._onMove = (e) => this._pointerMove(e);
    this._onUp = (e) => this._pointerUp(e);

    this.root.addEventListener("pointerdown", this._onDown, { passive: false });
    addEventListener("pointermove", this._onMove, { passive: false });
    addEventListener("pointerup", this._onUp, { passive: false });
    addEventListener("pointercancel", this._onUp, { passive: false });
  }

  _pointerDown(e) {
    e.preventDefault();
    const target = e.target.closest("[data-action],[data-zone]");
    if (!target) return;

    if (target.dataset.action) {
      this._pressButton(target, true);
      this.pointers.set(e.pointerId, { kind: "button", el: target });
      return;
    }

    if (target.dataset.zone === "joy") {
      const rect = this.el.joyzone.getBoundingClientRect();
      this.pointers.set(e.pointerId, {
        kind: "joy", originX: e.clientX, originY: e.clientY,
      });
      void rect;
      this._showJoystick(e.clientX, e.clientY);
      this._updateJoystick(e.clientX, e.clientY, e.clientX, e.clientY);
      return;
    }

    if (target.dataset.zone === "look") {
      this.pointers.set(e.pointerId, {
        kind: "look", lastX: e.clientX, lastY: e.clientY,
      });
    }
  }

  _pointerMove(e) {
    const p = this.pointers.get(e.pointerId);
    if (!p) return;
    e.preventDefault();

    if (p.kind === "joy") {
      this._updateJoystick(p.originX, p.originY, e.clientX, e.clientY);
    } else if (p.kind === "look") {
      const dx = e.clientX - p.lastX;
      const dy = e.clientY - p.lastY;
      p.lastX = e.clientX;
      p.lastY = e.clientY;
      this.input.touchActive = true;
      this.input.addLookDelta(dx * 2.1, dy * 2.1);
    }
  }

  _pointerUp(e) {
    const p = this.pointers.get(e.pointerId);
    if (!p) return;
    this.pointers.delete(e.pointerId);

    if (p.kind === "button") {
      this._pressButton(p.el, false);
    } else if (p.kind === "joy") {
      this._hideJoystick();
      this._setMoveKeys(0, 0);
    }
  }

  _showJoystick(x, y) {
    this.el.joybase.style.left = x + "px";
    this.el.joybase.style.top = y + "px";
    this.el.joynub.style.left = x + "px";
    this.el.joynub.style.top = y + "px";
    this.el.joybase.classList.add("show");
    this.el.joynub.classList.add("show");
  }

  _hideJoystick() {
    this.el.joybase.classList.remove("show");
    this.el.joynub.classList.remove("show");
  }

  _updateJoystick(ox, oy, x, y) {
    let dx = x - ox, dy = y - oy;
    const dist = Math.hypot(dx, dy);
    if (dist > JOY_RADIUS) {
      dx = (dx / dist) * JOY_RADIUS;
      dy = (dy / dist) * JOY_RADIUS;
    }
    this.el.joynub.style.left = ox + dx + "px";
    this.el.joynub.style.top = oy + dy + "px";

    const nx = dx / JOY_RADIUS;   // -1..1, right positive
    const ny = dy / JOY_RADIUS;   // -1..1, down positive
    const mag = Math.min(1, dist / JOY_RADIUS);
    this._setMoveKeys(nx, ny, mag);
  }

  /**
   * Turn a joystick vector into the same WASD state the keyboard would set.
   * Both on-foot movement and vehicle steer/throttle in main.js already read
   * these keys as plain booleans, so the stick needs no separate code path
   * for driving versus walking.
   */
  _setMoveKeys(nx, ny, mag = Math.max(Math.abs(nx), Math.abs(ny))) {
    const input = this.input;
    input.setKey("KeyW", ny < -DEADZONE);
    input.setKey("KeyS", ny > DEADZONE);
    input.setKey("KeyA", nx < -DEADZONE);
    input.setKey("KeyD", nx > DEADZONE);
    input.setKey("ShiftLeft", mag > RUN_THRESHOLD);
  }

  _pressButton(el, isDown) {
    el.classList.toggle("active", isDown);
    const input = this.input;

    switch (el.dataset.action) {
      case "fire":
        input.setMouseButton("left", isDown);
        break;
      case "aim":
        if (this.driving) input.setKey("Space", isDown);      // handbrake
        else input.setMouseButton("right", isDown);
        break;
      case "reload":
        input.setKey("KeyR", isDown);
        break;
      case "enter":
        input.setKey("KeyF", isDown);
        break;
      case "map":
        input.setKey("Tab", isDown);
        break;
      case "weapon":
        if (isDown) this.onWeaponCycle();
        break;
    }
  }

  // ---- per-frame -----------------------------------------------------------

  /** Called once a frame so the button cluster matches on-foot vs driving. */
  setDriving(driving) {
    if (!this.active || this.driving === driving) return;
    this.driving = driving;

    this.el.fire.classList.toggle("hidden", driving);
    this.el.reload.classList.toggle("hidden", driving);
    this.el.weapon.classList.toggle("hidden", driving);

    this.el.aim.textContent = driving ? "BRAKE" : "AIM";
    this.el.enter.textContent = driving ? "EXIT" : "ENTER";
  }

  dispose() {
    if (!this.active) return;
    this.root.removeEventListener("pointerdown", this._onDown);
    removeEventListener("pointermove", this._onMove);
    removeEventListener("pointerup", this._onUp);
    removeEventListener("pointercancel", this._onUp);
    this.root.remove();
  }
}
