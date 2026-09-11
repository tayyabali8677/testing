// Keyboard, mouse and pointer-lock input.
//
// Exposes edge-triggered `pressed()` alongside level-triggered `down()` so
// callers never have to track previous-frame state themselves.

export class Input {
  constructor(canvas) {
    this.canvas = canvas;
    this.keys = new Set();
    this.prevKeys = new Set();
    this.mouse = { dx: 0, dy: 0, wheel: 0, left: false, right: false };
    this.prevMouse = { left: false, right: false };
    this.locked = false;
    this.enabled = true;

    this._onKeyDown = (e) => {
      if (!this.enabled) return;
      const k = e.code;
      this.keys.add(k);
      // Stop the page scrolling or tabbing away mid-game.
      if (["Space", "Tab", "ArrowUp", "ArrowDown", "ArrowLeft",
           "ArrowRight"].includes(k)) e.preventDefault();
    };
    this._onKeyUp = (e) => { this.keys.delete(e.code); };

    this._onMouseMove = (e) => {
      if (!this.locked) return;
      this.mouse.dx += e.movementX || 0;
      this.mouse.dy += e.movementY || 0;
    };
    this._onMouseDown = (e) => {
      if (e.button === 0) this.mouse.left = true;
      if (e.button === 2) this.mouse.right = true;
    };
    this._onMouseUp = (e) => {
      if (e.button === 0) this.mouse.left = false;
      if (e.button === 2) this.mouse.right = false;
    };
    this._onWheel = (e) => { this.mouse.wheel += Math.sign(e.deltaY); };
    this._onBlur = () => {
      this.keys.clear();
      this.mouse.left = this.mouse.right = false;
    };
    this._onLockChange = () => {
      this.locked = document.pointerLockElement === this.canvas;
      if (!this.locked) this._onBlur();
    };

    addEventListener("keydown", this._onKeyDown);
    addEventListener("keyup", this._onKeyUp);
    addEventListener("mousemove", this._onMouseMove);
    addEventListener("mousedown", this._onMouseDown);
    addEventListener("mouseup", this._onMouseUp);
    addEventListener("wheel", this._onWheel, { passive: true });
    addEventListener("blur", this._onBlur);
    document.addEventListener("pointerlockchange", this._onLockChange);
    canvas.addEventListener("contextmenu", (e) => e.preventDefault());
  }

  requestLock() {
    if (!this.locked && this.canvas.requestPointerLock) {
      this.canvas.requestPointerLock();
    }
  }

  down(code) { return this.keys.has(code); }
  pressed(code) { return this.keys.has(code) && !this.prevKeys.has(code); }
  released(code) { return !this.keys.has(code) && this.prevKeys.has(code); }

  get leftDown() { return this.mouse.left; }
  get leftPressed() { return this.mouse.left && !this.prevMouse.left; }
  get rightDown() { return this.mouse.right; }

  /** Movement intent on the XZ plane, already normalised. */
  moveAxis() {
    let x = 0, z = 0;
    if (this.down("KeyA") || this.down("ArrowLeft")) x -= 1;
    if (this.down("KeyD") || this.down("ArrowRight")) x += 1;
    if (this.down("KeyW") || this.down("ArrowUp")) z -= 1;
    if (this.down("KeyS") || this.down("ArrowDown")) z += 1;
    const len = Math.hypot(x, z);
    if (len > 1) { x /= len; z /= len; }
    return { x, z, len: Math.min(len, 1) };
  }

  /** Consume accumulated mouse delta; call once per frame. */
  takeMouseDelta() {
    const d = { dx: this.mouse.dx, dy: this.mouse.dy, wheel: this.mouse.wheel };
    this.mouse.dx = this.mouse.dy = 0;
    this.mouse.wheel = 0;
    return d;
  }

  /** Must run at the very end of a frame, after all polling. */
  endFrame() {
    this.prevKeys = new Set(this.keys);
    this.prevMouse.left = this.mouse.left;
    this.prevMouse.right = this.mouse.right;
  }

  dispose() {
    removeEventListener("keydown", this._onKeyDown);
    removeEventListener("keyup", this._onKeyUp);
    removeEventListener("mousemove", this._onMouseMove);
    removeEventListener("mousedown", this._onMouseDown);
    removeEventListener("mouseup", this._onMouseUp);
    removeEventListener("wheel", this._onWheel);
    removeEventListener("blur", this._onBlur);
    document.removeEventListener("pointerlockchange", this._onLockChange);
  }
}
