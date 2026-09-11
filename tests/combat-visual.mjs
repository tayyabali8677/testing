// Visual check of animation and gunfire.
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
page.on("pageerror", (e) => errors.push(e.stack || e.message));
page.on("console", (m) => { if (m.type() === "error") errors.push(m.text()); });

await page.goto("http://localhost:8099/play.html", { waitUntil: "load", timeout: 90000 });
await page.waitForFunction(() => { const b = document.getElementById("start"); return b && !b.disabled; }, { timeout: 120000 });
await page.click("#start");
await page.waitForTimeout(1200);

// Bright daylight, camera close in, a pedestrian placed right in front.
await page.evaluate(() => {
  const g = window.game;
  g.world.dayLength = 0;
  g.world.setTimeOfDay(0.42);
  const p = g.city.randomRoadPoint();
  g.player.setPosition(p.x, p.z, 0);
  g.camera.yaw = 0; g.camera.pitch = -0.1; g.camera.zoom = 0.75;
  g.camera.snapBehind(g.player);
  // Park a pedestrian downrange to shoot at.
  const ped = g.population.pedestrians[0];
  ped.setPosition(p.x, p.z - 9, 0);
  g.population.brains[0].target = { x: ped.x, z: ped.z };
  window.__ped = ped;
});
await page.waitForTimeout(800);

// Capture the run cycle at intervals, so the limbs should differ between shots.
await page.keyboard.down("KeyW");
await page.keyboard.down("ShiftLeft");
for (let i = 0; i < 3; i++) {
  await page.waitForTimeout(420);
  await page.screenshot({ path: `${out}/anim-${i}.png` });
}
const legs = await page.evaluate(() => {
  const g = window.game;
  const l = g.player.inst.nodes.get("Leg_L");
  const r = g.player.inst.nodes.get("Leg_R");
  return { speed: +g.player.speed.toFixed(2),
           legL: +l.rotation.x.toFixed(3), legR: +r.rotation.x.toFixed(3) };
});
await page.keyboard.up("ShiftLeft");
await page.keyboard.up("KeyW");
await page.waitForTimeout(500);

// Re-place the target before firing: both the player and the pedestrian have
// moved during the run above, so the original setup no longer holds.
await page.evaluate(() => {
  const g = window.game;
  const ped = window.__ped;
  const f = g.player.forward;
  ped.setPosition(g.player.x + f.x * 9, g.player.z + f.z * 9, 0);
  g.population.brains[0].target = { x: ped.x, z: ped.z };
  g.camera.yaw = g.player.heading;
  g.camera.pitch = -0.1;
});
await page.waitForTimeout(400);

const hpBefore = await page.evaluate(() => window.__ped.hp);
await page.mouse.down();
await page.waitForTimeout(120);
await page.screenshot({ path: `${out}/shoot-flash.png` });
await page.waitForTimeout(900);
await page.mouse.up();
const after = await page.evaluate(() => ({
  pedHp: window.__ped.hp,
  mag: window.game.loadout.mag,
  heat: +window.game.police.heat.toFixed(0),
  stars: window.game.police.stars,
}));
await page.screenshot({ path: `${out}/shoot-after.png` });

await browser.close();
console.log("run cycle :", JSON.stringify(legs));
console.log("ped hp    :", hpBefore, "->", after.pedHp);
console.log("ammo left :", after.mag, "of 12");
console.log("heat      :", after.heat, `(${after.stars} stars)`);
console.log("errors    :", errors.length ? errors : "none");
