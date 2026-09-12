// Full mobile verification pass: portrait rotate-hint, landscape layout
// (no overlapping controls), PWA manifest/service-worker, and a rerun of the
// touch functional checks now that the minimap and ammo readout have moved
// out of the button cluster's way.
//
//   python3 -m http.server 8099 &
//   node tests/mobile-full.mjs [--shots dir]

import { chromium, devices } from "playwright";
import { mkdirSync, existsSync } from "node:fs";

const args = process.argv.slice(2);
const argOf = (name, fallback) => {
  const i = args.indexOf(name);
  return i >= 0 && args[i + 1] ? args[i + 1] : fallback;
};
const URL = argOf("--url", "http://localhost:8099/play.html");
const SHOTS = argOf("--shots", "/tmp/lg-mobile-shots");
mkdirSync(SHOTS, { recursive: true });

const CANDIDATES = [
  process.env.CHROMIUM_PATH,
  "/opt/pw-browsers/chromium-1194/chrome-linux/chrome",
  "/opt/pw-browsers/chromium/chrome-linux/chrome",
  "/usr/bin/chromium",
  "/usr/bin/google-chrome",
].filter(Boolean);
const executablePath = CANDIDATES.find((p) => existsSync(p));

const browser = await chromium.launch({
  executablePath,
  args: ["--use-gl=swiftshader", "--enable-unsafe-swiftshader",
         "--ignore-gpu-blocklist", "--no-sandbox"],
});

const failures = [];
const check = (cond, msg) => { if (!cond) failures.push(msg); };

// ---- 1. portrait: rotate-hint appears and is dismissable ------------------

{
  const page = await browser.newPage({
    viewport: { width: 412, height: 915 }, hasTouch: true, isMobile: true,
    deviceScaleFactor: 2.6,
  });
  await page.goto(URL, { waitUntil: "load", timeout: 90000 });
  await page.waitForTimeout(400);

  const visible = await page.evaluate(() => {
    const el = document.getElementById("rotate-hint");
    return getComputedStyle(el).display !== "none";
  });
  check(visible, "rotate-hint did not appear in portrait on a touch device");
  await page.screenshot({ path: `${SHOTS}/portrait-hint.png` });

  await page.click("#rotate-dismiss");
  await page.waitForTimeout(150);
  const dismissed = await page.evaluate(() => {
    const el = document.getElementById("rotate-hint");
    return getComputedStyle(el).display === "none";
  });
  check(dismissed, "rotate-hint stayed visible after dismissing it");
  await page.screenshot({ path: `${SHOTS}/portrait-dismissed.png` });
  await page.close();
}

// ---- 2. landscape: full playthrough, no overlapping controls --------------

{
  const page = await browser.newPage({
    viewport: { width: 915, height: 412 }, hasTouch: true, isMobile: true,
    deviceScaleFactor: 2.6,
  });
  const errors = [];
  page.on("console", (m) => { if (m.type() === "error") errors.push(m.text()); });
  page.on("pageerror", (e) => errors.push("pageerror: " + e.message));

  await page.goto(URL, { waitUntil: "load", timeout: 90000 });
  await page.waitForFunction(
    () => { const b = document.getElementById("start"); return b && !b.disabled; },
    { timeout: 120000 }
  );

  const hintVisible = await page.evaluate(() =>
    getComputedStyle(document.getElementById("rotate-hint")).display !== "none");
  check(!hintVisible, "rotate-hint showed up in landscape");

  await page.click("#start");
  await page.waitForTimeout(1000);
  await page.screenshot({ path: `${SHOTS}/landscape-play.png` });

  // Overlap check: none of the touch buttons, the minimap, or the ammo
  // readout should occupy the same screen region.
  const rects = await page.evaluate(() => {
    const grab = (sel) => {
      const el = document.querySelector(sel);
      if (!el || getComputedStyle(el).display === "none") return null;
      const r = el.getBoundingClientRect();
      if (r.width === 0 || r.height === 0) return null;
      return { x: r.x, y: r.y, w: r.width, h: r.height };
    };
    return {
      fire: grab(".tc-fire"), aim: grab(".tc-aim"), reload: grab(".tc-reload"),
      weapon: grab(".tc-weapon"), enter: grab(".tc-enter"), map: grab(".tc-map"),
      minimap: grab(".minimap"), ammo: grab(".hud-br"),
    };
  });

  const overlaps = (a, b) =>
    a.x < b.x + b.w && a.x + a.w > b.x && a.y < b.y + b.h && a.y + a.h > b.y;

  const pairs = [
    ["fire", "aim"], ["fire", "reload"], ["aim", "weapon"],
    ["minimap", "fire"], ["minimap", "aim"], ["minimap", "reload"],
    ["minimap", "weapon"], ["ammo", "fire"], ["ammo", "aim"],
    ["ammo", "reload"], ["ammo", "weapon"], ["ammo", "minimap"],
  ];
  for (const [a, b] of pairs) {
    if (rects[a] && rects[b] && overlaps(rects[a], rects[b])) {
      failures.push(`${a} overlaps ${b}: ${JSON.stringify(rects[a])} vs ${JSON.stringify(rects[b])}`);
    }
  }

  // Drive it briefly to confirm the joystick and look-drag still work when
  // the screen is short and wide rather than tall and narrow.
  const jz = await page.evaluate(() => {
    const r = document.querySelector(".tc-joyzone").getBoundingClientRect();
    return { x: r.x + r.width * 0.4, y: r.y + r.height * 0.6 };
  });
  const before = await page.evaluate(() => ({ x: window.game.player.x, z: window.game.player.z }));
  await page.evaluate(({ x, y }) => {
    document.elementFromPoint(x, y).dispatchEvent(new PointerEvent("pointerdown", {
      pointerId: 9, pointerType: "touch", isPrimary: true,
      clientX: x, clientY: y, bubbles: true, cancelable: true,
    }));
  }, jz);
  await page.evaluate(({ x, y }) => {
    document.elementFromPoint(x, y).dispatchEvent(new PointerEvent("pointermove", {
      pointerId: 9, pointerType: "touch", isPrimary: true,
      clientX: x, clientY: y - 40, bubbles: true, cancelable: true,
    }));
  }, jz);
  await page.waitForTimeout(700);
  await page.evaluate(({ x, y }) => {
    document.elementFromPoint(x, y).dispatchEvent(new PointerEvent("pointerup", {
      pointerId: 9, pointerType: "touch", isPrimary: true,
      clientX: x, clientY: y - 40, bubbles: true, cancelable: true,
    }));
  }, jz);
  const after = await page.evaluate(() => ({ x: window.game.player.x, z: window.game.player.z }));
  const moved = Math.hypot(after.x - before.x, after.z - before.z);
  check(moved > 0.2, `joystick barely moved the player in landscape (${moved.toFixed(2)}m)`);

  await page.screenshot({ path: `${SHOTS}/landscape-after-drive.png` });
  check(errors.length === 0, "console errors in landscape: " + errors.join(" | "));
  await page.close();
}

// ---- 3. PWA basics ---------------------------------------------------------

{
  const page = await browser.newPage();
  await page.goto(URL.replace(/play\.html$/, "") || URL, { waitUntil: "load", timeout: 90000 });
  await page.waitForTimeout(600);

  const manifestHref = await page.evaluate(() => {
    const l = document.querySelector('link[rel="manifest"]');
    return l ? l.getAttribute("href") : null;
  });
  check(!!manifestHref, "index.html has no <link rel=manifest>");

  const manifest = await page.evaluate(async () => {
    const res = await fetch("manifest.webmanifest");
    if (!res.ok) return null;
    return res.json();
  });
  check(!!manifest, "manifest.webmanifest did not fetch");
  if (manifest) {
    check(manifest.display === "standalone", "manifest display is not standalone");
    check(manifest.orientation === "landscape", "manifest orientation is not landscape");
    check(Array.isArray(manifest.icons) && manifest.icons.length >= 2,
      "manifest is missing icons");
  }
  await page.close();
}

{
  const page = await browser.newPage();
  const swErrors = [];
  page.on("console", (m) => { if (m.type() === "error") swErrors.push(m.text()); });
  await page.goto(URL, { waitUntil: "load", timeout: 90000 });
  await page.waitForFunction(() => navigator.serviceWorker.ready, { timeout: 15000 })
    .catch(() => { failures.push("service worker never became ready"); });

  const registered = await page.evaluate(async () => {
    const regs = await navigator.serviceWorker.getRegistrations();
    return regs.length > 0;
  });
  check(registered, "no service worker registration found");
  check(swErrors.length === 0, "console errors during SW registration: " + swErrors.join(" | "));
  await page.close();
}

await browser.close();

console.log(failures.length ? "\nFAILED:" : "\nall mobile checks passed");
for (const f of failures) console.log("  - " + f);
process.exit(failures.length ? 1 : 0);
