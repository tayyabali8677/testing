// End-to-end check: load the real page in Chromium, start the game, run it,
// and report anything the console complains about.
//
//   python3 -m http.server 8099 &
//   node tests/browser.mjs [--url http://localhost:8099/play.html] [--shots dir]
//
// Headless Chromium renders WebGL through SwiftShader, so this exercises the
// genuine render path: shaders compile, GLBs load, the loop runs.

import { chromium } from "playwright";
import { mkdirSync } from "node:fs";

const args = process.argv.slice(2);
const argOf = (name, fallback) => {
  const i = args.indexOf(name);
  return i >= 0 && args[i + 1] ? args[i + 1] : fallback;
};

const URL = argOf("--url", "http://localhost:8099/play.html");
const SHOTS = argOf("--shots", "/tmp/lg-shots");
const SECONDS = Number(argOf("--seconds", "12"));

mkdirSync(SHOTS, { recursive: true });

const IGNORE = [
  /favicon/i,
  /Failed to load resource.*favicon/i,
  /WebGL.*deprecated/i,
  /Multiple instances of Three\.js/i,
];

const errors = [];
const warnings = [];

// Prefer the browser already present in the environment. The npm package's
// pinned build number rarely matches what is installed, and re-downloading a
// whole Chromium just to run this check is not worth it.
const CANDIDATES = [
  process.env.CHROMIUM_PATH,
  "/opt/pw-browsers/chromium-1194/chrome-linux/chrome",
  "/opt/pw-browsers/chromium/chrome-linux/chrome",
  "/usr/bin/chromium",
  "/usr/bin/google-chrome",
].filter(Boolean);

const { existsSync } = await import("node:fs");
const executablePath = CANDIDATES.find((p) => existsSync(p));

const browser = await chromium.launch({
  ...(executablePath ? { executablePath } : {}),
  args: [
    "--use-gl=swiftshader",
    "--enable-unsafe-swiftshader",
    "--ignore-gpu-blocklist",
    "--no-sandbox",
  ],
});

const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });

page.on("console", (msg) => {
  const text = msg.text();
  if (IGNORE.some((re) => re.test(text))) return;
  if (msg.type() === "error") errors.push(text);
  else if (msg.type() === "warning") warnings.push(text);
});
page.on("pageerror", (err) => errors.push(`pageerror: ${err.message}`));
page.on("requestfailed", (req) => {
  const f = req.failure();
  errors.push(`request failed: ${req.url()} (${f ? f.errorText : "?"})`);
});

console.log(`opening ${URL}`);
await page.goto(URL, { waitUntil: "load", timeout: 90000 });

// Wait for the loader to finish and the start button to enable.
console.log("waiting for assets...");
try {
  await page.waitForFunction(
    () => {
      const b = document.getElementById("start");
      return b && !b.disabled;
    },
    { timeout: 120000 }
  );
} catch {
  const status = await page.textContent("#status").catch(() => "");
  errors.push(`start button never enabled. status: ${status}`);
}

await page.screenshot({ path: `${SHOTS}/01-menu.png` });

const cityStats = await page.evaluate(() => window.__cityStats || null);

console.log("starting game...");
await page.click("#start").catch(() => {});
await page.waitForTimeout(1500);
await page.screenshot({ path: `${SHOTS}/02-start.png` });

// Drive for a while, firing and switching view, to exercise the systems.
const script = [
  { keys: ["KeyW"], ms: 2500, label: "03-walk" },
  { keys: ["KeyW", "ShiftLeft"], ms: 2000, label: "04-run" },
  { keys: [], ms: 300, label: null },
];

for (const step of script) {
  for (const k of step.keys) await page.keyboard.down(k);
  await page.waitForTimeout(step.ms);
  for (const k of step.keys) await page.keyboard.up(k);
  if (step.label) await page.screenshot({ path: `${SHOTS}/${step.label}.png` });
}

// Try to get into a car.
await page.keyboard.press("KeyF");
await page.waitForTimeout(400);
await page.keyboard.down("KeyW");
await page.waitForTimeout(3000);
await page.keyboard.up("KeyW");
await page.screenshot({ path: `${SHOTS}/05-drive.png` });

// Shoot a little.
await page.keyboard.press("KeyF");
await page.waitForTimeout(400);
await page.mouse.down();
await page.waitForTimeout(700);
await page.mouse.up();
await page.screenshot({ path: `${SHOTS}/06-shoot.png` });

// Big map.
await page.keyboard.press("Tab");
await page.waitForTimeout(500);
await page.screenshot({ path: `${SHOTS}/07-map.png` });
await page.keyboard.press("Tab");

// Let it settle, then measure the frame rate over a second.
await page.waitForTimeout(Math.max(0, SECONDS - 11) * 1000);

const perf = await page.evaluate(() => new Promise((resolve) => {
  let frames = 0;
  const start = performance.now();
  const tick = () => {
    frames++;
    if (performance.now() - start < 1000) requestAnimationFrame(tick);
    else resolve({ fps: frames, ms: performance.now() - start });
  };
  requestAnimationFrame(tick);
}));

const info = await page.evaluate(() => {
  const c = document.getElementById("game");
  return {
    canvas: c ? { w: c.width, h: c.height } : null,
    hud: !!document.querySelector(".hud"),
    minimap: !!document.querySelector(".minimap"),
    overlayHidden: document.getElementById("overlay").classList.contains("hidden"),
    status: (document.getElementById("status") || {}).textContent || "",
  };
});

// Confirm the frame is not blank. Reading the WebGL canvas back through
// drawImage returns an empty buffer unless preserveDrawingBuffer is set, so
// judge the compositor's screenshot instead: a flat black 720p frame encodes
// to a few kilobytes, a real one to hundreds.
const shot = await page.screenshot({ path: `${SHOTS}/08-final.png` });
const shotKB = shot.length / 1024;
await browser.close();

console.log("\n" + "=".repeat(62));
console.log("canvas          :", info.canvas ? `${info.canvas.w}x${info.canvas.h}` : "MISSING");
console.log("overlay hidden  :", info.overlayHidden);
console.log("hud / minimap   :", info.hud, "/", info.minimap);
console.log("frame rate      :", perf.fps, "fps (software rasteriser)");
console.log("frame size      :", shotKB.toFixed(0), "KB (a blank frame is <20)");
if (cityStats) console.log("city            :", JSON.stringify(cityStats));
console.log("screenshots     :", SHOTS);
console.log("=".repeat(62));

if (warnings.length) {
  console.log(`\n${warnings.length} warning(s):`);
  for (const w of [...new Set(warnings)].slice(0, 12)) console.log("  - " + w);
}

if (errors.length) {
  console.log(`\n${errors.length} ERROR(s):`);
  for (const e of [...new Set(errors)].slice(0, 20)) console.log("  - " + e);
  process.exit(1);
}

if (shotKB < 20) {
  console.log("\nERROR: the rendered frame looks blank");
  process.exit(1);
}
if (!info.overlayHidden || !info.hud || !info.minimap) {
  console.log("\nERROR: the game did not reach a running state");
  process.exit(1);
}

console.log("\nbrowser check passed");
