// Focused check: put the player in a car and confirm driving actually works.
import { chromium } from "playwright";
import { existsSync } from "node:fs";

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

// Teleport the player next to the nearest traffic car, then get in.
const before = await page.evaluate(() => {
  const g = window.game;
  const v = g.population.vehicles[0];
  // Park it: traffic would otherwise drive away before the key press lands.
  v.speed = 0; v.vx = 0; v.vz = 0;
  g.population.drivers[0].aggression = 0;
  g.player.setPosition(v.x + 1.5, v.z, 0);
  return { carX: v.x, carZ: v.z, state: g.player.state };
});
await page.waitForTimeout(120);
const near = await page.evaluate(() => {
  const g = window.game;
  const car = g._nearestEnterable();
  return { found: !!car, dist: car ? Math.hypot(car.x - g.player.x, car.z - g.player.z) : -1 };
});
await page.keyboard.press("KeyF");
await page.waitForTimeout(400);

const entered = await page.evaluate(() => ({
  state: window.game.player.state,
  hasVehicle: !!window.game.player.vehicle,
  key: window.game.player.vehicle ? window.game.player.vehicle.key : null,
}));

await page.keyboard.down("KeyW");
await page.waitForTimeout(4000);
const driving = await page.evaluate(() => {
  const v = window.game.player.vehicle;
  return v ? { speedKph: v.speedKph, x: v.x, z: v.z, wheelSpin: v.wheelSpin } : null;
});
await page.screenshot({ path: process.argv[2] + "/10-driving.png" });
await page.keyboard.down("KeyD");
await page.waitForTimeout(1500);
await page.keyboard.up("KeyD");
await page.keyboard.up("KeyW");
await page.screenshot({ path: process.argv[2] + "/11-turning.png" });

// Now raise the wanted level and let the police respond.
await page.evaluate(() => window.game.police.addHeat(200));
await page.waitForTimeout(3500);
const heat = await page.evaluate(() => ({
  stars: window.game.police.stars,
  cars: window.game.police.cars.length,
  foot: window.game.police.foot.length,
}));
await page.screenshot({ path: process.argv[2] + "/12-wanted.png" });

await page.keyboard.press("KeyF");
await page.waitForTimeout(600);
const exited = await page.evaluate(() => window.game.player.state);
await page.screenshot({ path: process.argv[2] + "/13-onfoot.png" });

await browser.close();
console.log("before   :", JSON.stringify(before));
console.log("near     :", JSON.stringify(near));
console.log("entered  :", JSON.stringify(entered));
console.log("driving  :", JSON.stringify(driving));
console.log("wanted   :", JSON.stringify(heat));
console.log("exited   :", exited);
console.log("errors   :", errors.length ? errors : "none");
