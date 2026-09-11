// Visual check of the day/night cycle: window glow and street lamps should
// only light up after dark.
import { chromium } from "playwright";
import { existsSync } from "node:fs";

const out = process.argv[2] || "/tmp/lg-shots";
const exe = ["/opt/pw-browsers/chromium-1194/chrome-linux/chrome"].find(existsSync);
const browser = await chromium.launch({
  executablePath: exe,
  args: ["--use-gl=swiftshader", "--enable-unsafe-swiftshader", "--no-sandbox"],
});
const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });
const errors = [];
page.on("pageerror", (e) => errors.push(e.message));

await page.goto("http://localhost:8099/play.html", { waitUntil: "load", timeout: 90000 });
await page.waitForFunction(() => { const b = document.getElementById("start"); return b && !b.disabled; }, { timeout: 120000 });
await page.click("#start");
await page.waitForTimeout(1200);

// Put the camera somewhere with a skyline in view and hold the clock still.
await page.evaluate(() => {
  const g = window.game;
  g.world.dayLength = 0;
  const p = g.city.randomRoadPoint();
  g.player.setPosition(p.x, p.z, 0);
  g.camera.snapBehind(g.player);
});

const rows = [];
for (const [label, t] of [["noon", 0.5], ["dusk", 0.79], ["night", 0.02]]) {
  await page.evaluate((tod) => window.game.world.setTimeOfDay(tod), t);
  await page.waitForTimeout(1400);
  const info = await page.evaluate(() => ({
    night: +window.game.world.night.toFixed(2),
    lamp: +(window.game.assets.nightMaterials.get("LampGlow")?.material.emissiveIntensity ?? -1).toFixed(2),
    win: +(window.game.assets.nightMaterials.get("BGlassLit")?.material.emissiveIntensity ?? -1).toFixed(2),
    sun: +window.game.world.sun.intensity.toFixed(2),
  }));
  await page.screenshot({ path: `${out}/tod-${label}.png` });
  rows.push([label, info]);
}

await browser.close();
for (const [label, i] of rows) {
  console.log(`${label.padEnd(6)} night=${i.night}  sun=${i.sun}  lamp=${i.lamp}  windows=${i.win}`);
}
console.log("errors:", errors.length ? errors : "none");
