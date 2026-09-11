// Heads-up display and minimap.
//
// The readouts are DOM, which stays crisp at any resolution and costs nothing
// per frame beyond a few text assignments. Only the minimap is canvas, drawn
// from the city's own road graph and collider list rather than by rendering
// the scene a second time.

import { clamp, dist2D } from "./mathx.js";

const CSS = `
.hud { position: fixed; inset: 0; pointer-events: none; z-index: 5;
  font: 500 14px "Segoe UI", system-ui, sans-serif; color: #eef2f7;
  text-shadow: 0 1px 3px rgba(0,0,0,.75); user-select: none; }

.hud-bl { position: absolute; left: 20px; bottom: 20px; }
.hud-tr { position: absolute; right: 20px; top: 18px; text-align: right; }
.hud-br { position: absolute; right: 20px; bottom: 20px; text-align: right; }
.hud-tc { position: absolute; left: 50%; top: 18px; transform: translateX(-50%);
  text-align: center; }

.bar { width: 208px; height: 13px; background: rgba(8,10,14,.6);
  border: 1px solid rgba(255,255,255,.18); border-radius: 7px;
  overflow: hidden; margin-bottom: 7px; }
.bar > i { display: block; height: 100%; width: 100%;
  transition: width .12s linear; }
.bar.hp > i { background: linear-gradient(90deg,#49d06a,#7fe08a); }
.bar.hp.low > i { background: linear-gradient(90deg,#d03c3c,#ff6b6b); }
.bar.armour > i { background: linear-gradient(90deg,#3d7fd2,#6fb0f0); }

.cash { font: 700 30px "Segoe UI", system-ui, sans-serif; color: #7fe08a;
  letter-spacing: .5px; }
.stars { font-size: 26px; letter-spacing: 3px; color: #ffd34d; height: 32px; }
.stars .off { color: rgba(255,255,255,.16); }

.weapon { font: 600 15px "Segoe UI", system-ui, sans-serif; }
.weapon b { font-size: 26px; color: #ffd34d; }
.weapon .reserve { opacity: .6; font-size: 15px; }
.weapon .reloading { color: #ffb020; }

.speed { font: 700 40px "Segoe UI", system-ui, sans-serif; line-height: 1; }
.speed span { font-size: 14px; font-weight: 500; opacity: .65; }

.objective { font-size: 13px; letter-spacing: 1px; text-transform: uppercase;
  opacity: .85; }
.objective b { color: #ffd34d; }
.objective .urgent { color: #ff6b6b; }

.toast { position: absolute; left: 50%; top: 26%; transform: translateX(-50%);
  text-align: center; font: 600 20px "Segoe UI", system-ui, sans-serif;
  opacity: 0; transition: opacity .25s; }
.toast.show { opacity: 1; }
.toast .sub { display: block; font-size: 14px; font-weight: 500; opacity: .8;
  margin-top: 3px; }

.prompt { position: absolute; left: 50%; bottom: 26%; transform: translateX(-50%);
  background: rgba(10,12,17,.66); border: 1px solid rgba(255,255,255,.16);
  border-radius: 8px; padding: 7px 14px; font-size: 14px; display: none; }
.prompt.show { display: block; }
.prompt b { color: #ffd34d; }

.crosshair { position: absolute; left: 50%; top: 50%; width: 22px; height: 22px;
  margin: -11px 0 0 -11px; display: none; }
.crosshair.show { display: block; }
.crosshair::before, .crosshair::after { content: ""; position: absolute;
  background: rgba(255,255,255,.85); }
.crosshair::before { left: 50%; top: 0; width: 2px; height: 100%; margin-left: -1px; }
.crosshair::after { top: 50%; left: 0; height: 2px; width: 100%; margin-top: -1px; }

.minimap { position: absolute; right: 20px; bottom: 84px;
  border-radius: 50%; overflow: hidden;
  border: 2px solid rgba(255,255,255,.22);
  box-shadow: 0 6px 22px rgba(0,0,0,.45); }
.minimap.big { border-radius: 10px; right: 50%; bottom: 50%;
  transform: translate(50%, 50%); }

.stats { position: absolute; left: 20px; top: 18px; font: 500 12px/1.5
  ui-monospace, "SF Mono", Menlo, Consolas, monospace; color: #9fb4c8;
  background: rgba(8,10,14,.55); border-radius: 6px; padding: 7px 11px;
  display: none; white-space: pre; }
.stats.show { display: block; }

.flash { position: fixed; inset: 0; pointer-events: none; z-index: 6;
  background: #ff2020; opacity: 0; transition: opacity .18s; }

.banner { position: fixed; inset: 0; display: none; align-items: center;
  justify-content: center; z-index: 7; background: rgba(6,7,10,.72);
  color: #fff; text-align: center; }
.banner.show { display: flex; }
.banner h2 { font: 700 56px "Segoe UI", system-ui, sans-serif; margin: 0;
  letter-spacing: 6px; color: #ff6b6b; }
.banner p { opacity: .7; letter-spacing: 2px; font-size: 14px; }
`;

export class Hud {
  constructor(city, opts = {}) {
    this.city = city;
    this.minimapRange = 150;
    this.bigMap = false;

    const style = document.createElement("style");
    style.textContent = CSS;
    document.head.appendChild(style);

    this.root = document.createElement("div");
    this.root.className = "hud";
    this.root.innerHTML = `
      <div class="hud-bl">
        <div class="bar hp"><i></i></div>
        <div class="bar armour"><i></i></div>
        <div class="speed" data-speed><span>KM/H</span></div>
      </div>
      <div class="hud-tr">
        <div class="cash" data-cash>$0</div>
        <div class="stars" data-stars></div>
      </div>
      <div class="hud-tc">
        <div class="objective" data-objective></div>
      </div>
      <div class="hud-br">
        <div class="weapon" data-weapon></div>
      </div>
      <div class="stats" data-stats></div>
      <div class="toast" data-toast></div>
      <div class="prompt" data-prompt></div>
      <div class="crosshair" data-crosshair></div>
    `;
    document.body.appendChild(this.root);

    this.flash = document.createElement("div");
    this.flash.className = "flash";
    document.body.appendChild(this.flash);

    this.banner = document.createElement("div");
    this.banner.className = "banner";
    this.banner.innerHTML = `<div><h2 data-banner-title></h2>
      <p data-banner-sub></p></div>`;
    document.body.appendChild(this.banner);

    this.el = {
      hp: this.root.querySelector(".bar.hp"),
      hpFill: this.root.querySelector(".bar.hp > i"),
      armour: this.root.querySelector(".bar.armour"),
      armourFill: this.root.querySelector(".bar.armour > i"),
      cash: this.root.querySelector("[data-cash]"),
      stars: this.root.querySelector("[data-stars]"),
      weapon: this.root.querySelector("[data-weapon]"),
      speed: this.root.querySelector("[data-speed]"),
      objective: this.root.querySelector("[data-objective]"),
      stats: this.root.querySelector("[data-stats]"),
      toast: this.root.querySelector("[data-toast]"),
      prompt: this.root.querySelector("[data-prompt]"),
      crosshair: this.root.querySelector("[data-crosshair]"),
      bannerTitle: this.banner.querySelector("[data-banner-title]"),
      bannerSub: this.banner.querySelector("[data-banner-sub]"),
    };

    this._initMinimap(opts.minimapSize || 176);
    this._toastTimer = 0;
    this._lastCash = -1;
  }

  _initMinimap(size) {
    this.map = document.createElement("canvas");
    this.map.className = "minimap";
    this.mapSize = size;
    const dpr = Math.min(devicePixelRatio || 1, 2);
    this.map.width = size * dpr;
    this.map.height = size * dpr;
    this.map.style.width = size + "px";
    this.map.style.height = size + "px";
    this.mapCtx = this.map.getContext("2d");
    this.mapCtx.scale(dpr, dpr);
    document.body.appendChild(this.map);
  }

  toggleBigMap() {
    this.bigMap = !this.bigMap;
    const size = this.bigMap
      ? Math.min(innerWidth, innerHeight) * 0.8
      : this.mapSize;
    const dpr = Math.min(devicePixelRatio || 1, 2);
    this.map.width = size * dpr;
    this.map.height = size * dpr;
    this.map.style.width = size + "px";
    this.map.style.height = size + "px";
    this.mapCtx = this.map.getContext("2d");
    this.mapCtx.scale(dpr, dpr);
    this.map.classList.toggle("big", this.bigMap);
  }

  toggleStats() {
    this.el.stats.classList.toggle("show");
    return this.el.stats.classList.contains("show");
  }

  get statsVisible() { return this.el.stats.classList.contains("show"); }

  setStats(text) {
    if (this.statsVisible) this.el.stats.textContent = text;
  }

  toast(text, sub = "") {
    this.el.toast.innerHTML = `${text}${sub ? `<span class="sub">${sub}</span>` : ""}`;
    this.el.toast.classList.add("show");
    this._toastTimer = 2.4;
  }

  prompt(text) {
    if (!text) {
      this.el.prompt.classList.remove("show");
      return;
    }
    this.el.prompt.innerHTML = text;
    this.el.prompt.classList.add("show");
  }

  showBanner(title, sub) {
    this.el.bannerTitle.textContent = title;
    this.el.bannerSub.textContent = sub || "";
    this.banner.classList.add("show");
  }

  hideBanner() { this.banner.classList.remove("show"); }

  update(dt, state) {
    const { player, loadout, missions, police, vehicle } = state;

    const hpPct = clamp(player.hp / player.maxHp, 0, 1);
    this.el.hpFill.style.width = `${hpPct * 100}%`;
    this.el.hp.classList.toggle("low", hpPct < 0.3);
    this.el.armourFill.style.width = `${clamp(player.armour / 100, 0, 1) * 100}%`;
    this.el.armour.style.opacity = player.armour > 0 ? "1" : "0.25";

    if (missions.cash !== this._lastCash) {
      this._lastCash = missions.cash;
      this.el.cash.textContent = `$${missions.cash.toLocaleString()}`;
    }

    let stars = "";
    for (let i = 0; i < 5; i++) {
      stars += i < police.stars ? "★" : `<span class="off">★</span>`;
    }
    this.el.stars.innerHTML = stars;

    if (loadout && loadout.spec) {
      const reloading = loadout.reloading > 0;
      this.el.weapon.innerHTML = reloading
        ? `<span class="reloading">RELOADING</span>`
        : `${loadout.spec.label} <b>${loadout.mag}</b>` +
          `<span class="reserve"> / ${loadout.reserve}</span>`;
    } else {
      this.el.weapon.textContent = "Unarmed";
    }

    const kph = vehicle ? Math.round(vehicle.speedKph) : 0;
    this.el.speed.innerHTML = vehicle
      ? `${kph}<span> KM/H</span>` : "";

    const subject = vehicle || player;
    const obj = missions.objective(subject);
    const urgent = obj.timeLeft > 0 && obj.timeLeft < 10;
    const timeText = obj.timeLeft > 0
      ? `<b class="${urgent ? "urgent" : ""}">${obj.timeLeft.toFixed(0)}s</b>`
      : `<span class="urgent">no bonus</span>`;
    this.el.objective.innerHTML =
      `Delivery <b>${Math.round(obj.distance)}m</b> &middot; ${timeText}` +
      (missions.streak > 1 ? ` &middot; streak <b>x${missions.streak}</b>` : "");

    this.el.crosshair.classList.toggle("show", !!state.aiming);

    if (this._toastTimer > 0) {
      this._toastTimer -= dt;
      if (this._toastTimer <= 0) this.el.toast.classList.remove("show");
    }

    this.flash.style.opacity = player.hurtFlash > 0
      ? String(clamp(player.hurtFlash, 0, 0.45)) : "0";

    this._drawMinimap(state);
  }

  _drawMinimap(state) {
    const ctx = this.mapCtx;
    const size = this.bigMap
      ? Math.min(innerWidth, innerHeight) * 0.8
      : this.mapSize;
    const city = this.city;
    const subject = state.vehicle || state.player;

    const range = this.bigMap ? city.extent * 0.62 : this.minimapRange;
    const scale = size / (range * 2);
    const cx = size / 2, cy = size / 2;
    // The full map shows the whole city, so it frames the city centre; the
    // corner minimap tracks the player instead.
    const focus = this.bigMap
      ? { x: city.extent / 2, z: city.extent / 2 }
      : subject;

    // The minimap rotates with the player unless it is the full-screen map.
    // Canvas rotate(t) maps (x,y) to (x cos t - y sin t, x sin t + y cos t);
    // rotating by +heading sends world forward to screen-up exactly.
    const rot = this.bigMap ? 0 : subject.heading;

    ctx.clearRect(0, 0, size, size);
    ctx.fillStyle = "#12151b";
    ctx.fillRect(0, 0, size, size);

    ctx.save();
    ctx.translate(cx, cy);
    ctx.rotate(rot);
    ctx.translate(-focus.x * scale, -focus.z * scale);
    ctx.scale(scale, scale);

    // Roads.
    ctx.strokeStyle = "#3c424e";
    ctx.lineWidth = city.roadW;
    ctx.lineCap = "round";
    ctx.beginPath();
    const N = city.size;
    for (let i = 0; i < N; i++) {
      const p = city.nodePos(i, 0);
      ctx.moveTo(p.x, 0);
      ctx.lineTo(p.x, city.extent);
      const q = city.nodePos(0, i);
      ctx.moveTo(0, q.z);
      ctx.lineTo(city.extent, q.z);
    }
    ctx.stroke();

    // Buildings, only when zoomed out far enough to be useful.
    if (this.bigMap) {
      ctx.fillStyle = "#232833";
      for (const b of city.colliders) {
        ctx.fillRect(b.x - b.hw, b.z - b.hd, b.hw * 2, b.hd * 2);
      }
    }

    const blip = (x, z, color, r) => {
      ctx.fillStyle = color;
      ctx.beginPath();
      ctx.arc(x, z, r / scale, 0, Math.PI * 2);
      ctx.fill();
    };

    for (const v of state.traffic || []) blip(v.x, v.z, "#6d7686", 2.2);
    for (const v of state.policeVehicles || []) blip(v.x, v.z, "#5b8cff", 3.2);
    for (const c of state.policeFoot || []) blip(c.x, c.z, "#5b8cff", 2.4);

    const obj = state.missions.objective(subject);
    blip(obj.x, obj.z, "#ffd34d", 4.0);

    ctx.restore();

    // Player arrow, always centred and pointing up.
    ctx.save();
    ctx.translate(cx, cy);
    // On the static full map the arrow itself must turn; it is drawn
    // pointing up, and rotate(-heading) lands it on world forward.
    if (this.bigMap) ctx.rotate(-subject.heading);
    ctx.fillStyle = "#7fe08a";
    ctx.beginPath();
    ctx.moveTo(0, -7);
    ctx.lineTo(5, 6);
    ctx.lineTo(0, 3);
    ctx.lineTo(-5, 6);
    ctx.closePath();
    ctx.fill();
    ctx.restore();

    // Off-map objective marker on the rim.
    if (!this.bigMap) {
      const d = dist2D(subject.x, subject.z, obj.x, obj.z);
      if (d > range) {
        // Rotate the world-space offset by the same transform the map uses,
        // then clamp it to the rim.
        const dx = obj.x - subject.x, dz = obj.z - subject.z;
        const rx = dx * Math.cos(rot) - dz * Math.sin(rot);
        const ry = dx * Math.sin(rot) + dz * Math.cos(rot);
        const len = Math.hypot(rx, ry) || 1;
        const rr = size / 2 - 10;
        ctx.fillStyle = "#ffd34d";
        ctx.beginPath();
        ctx.arc(cx + (rx / len) * rr, cy + (ry / len) * rr, 4, 0, Math.PI * 2);
        ctx.fill();
      }
    }
  }
}
