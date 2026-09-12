// Verifies the on-screen touch controls actually work, not just that they
// render. Runs Chromium with a phone viewport and hasTouch enabled, so
// navigator.maxTouchPoints reflects a real touchscreen and TouchControls
// activates exactly the way it would on a phone.
//
//   python3 -m http.server 8099 &
//   node tests/touch.mjs [--url http://localhost:8099/play.html] [--shots dir]

import { chromium, devices } from "playwright";
import { mkdirSync, existsSync } from "node:fs";

const args = process.argv.slice(2);
const argOf = (name, fallback) => {
  const i = args.indexOf(name);
  return i >= 0 && args[i + 1] ? args[i + 1] : fallback;
};
const URL = argOf("--url", "http://localhost:8099/play.html");
const SHOTS = argOf("--shots", "/tmp/lg-touch-shots");
mkdirSync(SHOTS, { recursive: true });

const CANDIDATES = [
  process.env.CHROMIUM_PATH,
  "/opt/pw-browsers/chromium-1194/chrome-linux/chrome",
  "/opt/pw-browsers/chromium/chrome-linux/chrome",
  "/usr/bin/chromium",
  "/usr/bin/google-chrome",
].filter(Boolean);
const executablePath = CANDIDATES.find((p) => existsSync(p));

const errors = [];
const browser = await chromium.launch({
  executablePath,
  args: ["--use-gl=swiftshader", "--enable-unsafe-swiftshader",
         "--ignore-gpu-blocklist", "--no-sandbox"],
});

// A real phone profile: touch enabled, device pixel ratio, landscape
// viewport — the orientation the game actually expects to be played in
// (see #rotate-hint in play.html, which blocks #start in portrait).
const base = devices["Pixel 7"] || {
  viewport: { width: 412, height: 915 },
  hasTouch: true,
  isMobile: true,
  deviceScaleFactor: 2.6,
};
const phone = {
  ...base,
  viewport: { width: base.viewport.height, height: base.viewport.width },
};

const page = await browser.newPage({ ...phone });
page.on("console", (m) => { if (m.type() === "error") errors.push(m.text()); });
page.on("pageerror", (e) => errors.push("pageerror: " + e.message));

console.log(`opening ${URL} as a touch device (${phone.viewport.width}x${phone.viewport.height})`);
await page.goto(URL, { waitUntil: "load", timeout: 90000 });
await page.waitForFunction(
  () => { const b = document.getElementById("start"); return b && !b.disabled; },
  { timeout: 120000 }
);

const detected = await page.evaluate(() => ({
  maxTouchPoints: navigator.maxTouchPoints,
  bodyHasTouchClass: document.body.classList.contains("touch-controls"),
  startLabel: document.getElementById("start").textContent,
}));
console.log("touch detection:", JSON.stringify(detected));
if (!detected.bodyHasTouchClass) {
  console.log("ERROR: touch-controls class was never added to <body>");
  process.exit(1);
}
if (detected.maxTouchPoints < 1) {
  console.log("ERROR: this Chromium profile is not reporting as touch-capable");
  process.exit(1);
}

// Defensive: the rotate-hint only shows in portrait, but if this test is
// ever pointed at a portrait viewport it should dismiss it rather than
// fail obscurely on an intercepted click.
const rotateHintUp = await page.evaluate(() =>
  getComputedStyle(document.getElementById("rotate-hint")).display !== "none");
if (rotateHintUp) await page.click("#rotate-dismiss");

await page.click("#start");
await page.waitForTimeout(1000);

const buttons = await page.evaluate(() => {
  const q = (sel) => {
    const el = document.querySelector(sel);
    if (!el) return null;
    const r = el.getBoundingClientRect();
    return { x: r.x + r.width / 2, y: r.y + r.height / 2, visible: !el.classList.contains("hidden") };
  };
  return {
    joyzone: q(".tc-joyzone"),
    lookzone: q(".tc-lookzone"),
    fire: q(".tc-fire"),
    aim: q(".tc-aim"),
    reload: q(".tc-reload"),
    weapon: q(".tc-weapon"),
    enter: q(".tc-enter"),
    map: q(".tc-map"),
  };
});
for (const [name, b] of Object.entries(buttons)) {
  if (!b) { console.log(`ERROR: ${name} control not found in the DOM`); process.exit(1); }
}
await page.screenshot({ path: `${SHOTS}/01-controls-visible.png` });

// --- drive the joystick: push up-left inside its zone -----------------
const jz = buttons.joyzone;
const startX = jz.x - 60, startY = jz.y + 40;
await page.touchscreen.tap(startX, startY).catch(() => {});
// touchscreen.tap doesn't hold, so use a raw touch sequence via CDP-level
// dispatch through mouse-like pointer emulation instead: Playwright exposes
// this through page.touchscreen only for taps, so drive a drag by dispatching
// pointer events directly, matching what a finger drag actually sends.
async function pointerDrag(page, id, points, pauseMs = 120) {
  for (let i = 0; i < points.length; i++) {
    const [x, y] = points[i];
    const type = i === 0 ? "pointerdown" : "pointermove";
    await page.evaluate(({ x, y, type, id }) => {
      const el = document.elementFromPoint(x, y) || document.body;
      const ev = new PointerEvent(type, {
        pointerId: id, pointerType: "touch", isPrimary: true,
        clientX: x, clientY: y, bubbles: true, cancelable: true,
      });
      el.dispatchEvent(ev);
    }, { x, y, type, id });
    await page.waitForTimeout(pauseMs);
  }
}
async function pointerUp(page, id, x, y) {
  await page.evaluate(({ x, y, id }) => {
    const el = document.elementFromPoint(x, y) || document.body;
    el.dispatchEvent(new PointerEvent("pointerup", {
      pointerId: id, pointerType: "touch", isPrimary: true,
      clientX: x, clientY: y, bubbles: true, cancelable: true,
    }));
  }, { x, y, id });
}

// Push the stick forward (up) and check the player actually moves.
const before = await page.evaluate(() => {
  const p = window.game.player;
  return { x: p.x, z: p.z };
});

await pointerDrag(page, 1, [[jz.x, jz.y], [jz.x, jz.y - 45]], 100);
await page.waitForTimeout(900);
const midDrive = await page.evaluate(() => {
  const g = window.game;
  return {
    keys: { W: g.input.down("KeyW"), S: g.input.down("KeyS"),
            A: g.input.down("KeyA"), D: g.input.down("KeyD") },
    speed: +g.player.speed.toFixed(2),
  };
});
console.log("joystick forward -> keys/speed:", JSON.stringify(midDrive));
await pointerUp(page, 1, jz.x, jz.y - 45);
await page.waitForTimeout(200);

const after = await page.evaluate(() => {
  const p = window.game.player;
  return { x: p.x, z: p.z };
});
const moved = Math.hypot(after.x - before.x, after.z - before.z);
console.log(`player moved ${moved.toFixed(2)}m from the joystick`);

await page.screenshot({ path: `${SHOTS}/02-after-joystick.png` });

// --- drag the look zone and confirm the camera yaw changes -------------
const lz = buttons.lookzone;
const yawBefore = await page.evaluate(() => window.game.camera.yaw);
await pointerDrag(page, 2, [
  [lz.x, lz.y], [lz.x + 120, lz.y], [lz.x + 240, lz.y],
], 90);
await pointerUp(page, 2, lz.x + 240, lz.y);
await page.waitForTimeout(150);
const yawAfter = await page.evaluate(() => window.game.camera.yaw);
console.log(`camera yaw: ${yawBefore.toFixed(3)} -> ${yawAfter.toFixed(3)}`);

// --- fire button: hold and check ammo drops ----------------------------
const fireAmmoBefore = await page.evaluate(() => window.game.loadout.mag);
await page.evaluate(({ x, y }) => {
  const el = document.elementFromPoint(x, y);
  el.dispatchEvent(new PointerEvent("pointerdown", {
    pointerId: 3, pointerType: "touch", isPrimary: true,
    clientX: x, clientY: y, bubbles: true, cancelable: true,
  }));
}, { x: buttons.fire.x, y: buttons.fire.y });
await page.waitForTimeout(700);
await pointerUp(page, 3, buttons.fire.x, buttons.fire.y);
const fireAmmoAfter = await page.evaluate(() => window.game.loadout.mag);
console.log(`fire button: ammo ${fireAmmoBefore} -> ${fireAmmoAfter}`);
await page.screenshot({ path: `${SHOTS}/03-after-fire.png` });

// --- enter/exit vehicle button ------------------------------------------
await page.evaluate(() => {
  const g = window.game;
  const v = g.population.vehicles[0];
  v.speed = 0; v.vx = 0; v.vz = 0;
  g.population.drivers[0].aggression = 0;
  g.player.setPosition(v.x + 1.4, v.z, 0);
});
await page.waitForTimeout(150);
const enterBtn = await page.evaluate(() => {
  const r = document.querySelector(".tc-enter").getBoundingClientRect();
  return { x: r.x + r.width / 2, y: r.y + r.height / 2 };
});
await page.evaluate(({ x, y }) => {
  const el = document.elementFromPoint(x, y);
  el.dispatchEvent(new PointerEvent("pointerdown", {
    pointerId: 4, pointerType: "touch", isPrimary: true,
    clientX: x, clientY: y, bubbles: true, cancelable: true,
  }));
}, enterBtn);
await page.waitForTimeout(150);
await pointerUp(page, 4, enterBtn.x, enterBtn.y);
await page.waitForTimeout(300);
const drivingState = await page.evaluate(() => ({
  state: window.game.player.state,
  buttonLabel: document.querySelector(".tc-enter").textContent,
  aimLabel: document.querySelector(".tc-aim").textContent,
  fireHidden: document.querySelector(".tc-fire").classList.contains("hidden"),
}));
console.log("after ENTER tap:", JSON.stringify(drivingState));
await page.screenshot({ path: `${SHOTS}/04-driving-buttons.png` });

await browser.close();

console.log("\nerrors:", errors.length ? errors : "none");

const failures = [];
if (moved < 0.3) failures.push("joystick did not move the player");
if (Math.abs(yawAfter - yawBefore) < 0.05) failures.push("look-drag did not change camera yaw");
if (fireAmmoAfter >= fireAmmoBefore) failures.push("fire button did not spend ammo");
if (drivingState.state !== "driving") failures.push("ENTER button did not put the player in the car");
if (drivingState.buttonLabel !== "EXIT") failures.push("ENTER button did not relabel to EXIT while driving");
if (drivingState.aimLabel !== "BRAKE") failures.push("AIM button did not relabel to BRAKE while driving");
if (!drivingState.fireHidden) failures.push("FIRE button did not hide while driving");
if (errors.length) failures.push(...errors.map((e) => "console: " + e));

if (failures.length) {
  console.log("\nFAILED:");
  for (const f of failures) console.log("  - " + f);
  process.exit(1);
}
console.log("\ntouch controls check passed");
