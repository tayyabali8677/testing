// Liberty Grid 3D: boot, game loop and the wiring between systems.

import * as THREE from "three";

import { World } from "./renderer.js";
import { Assets } from "./assets.js";
import { City } from "./city.js";
import { Input } from "./input.js";
import { TouchControls, hasTouchSupport } from "./touch.js";
import { CameraRig } from "./camera.js";
import { Character, State, HEIGHT as CHAR_HEIGHT } from "./character.js";
import { Vehicle } from "./vehicle.js";
import { Population } from "./ai.js";
import { Police, CRIME } from "./police.js";
import { Combat, Loadout, WeaponRig, WEAPON_ORDER } from "./weapons.js";
import { Missions } from "./mission.js";
import { Effects } from "./fx.js";
import { Hud } from "./hud.js";
import { Audio } from "./audio.js";
import { clamp, dist2D, forwardX, forwardZ, rightX, rightZ } from "./mathx.js";

const FIXED_STEP = 1 / 60;
const MAX_STEPS = 5;
const RESPAWN_DELAY = 2.6;
const ENTER_RANGE = 4.2;

const _aimPoint = new THREE.Vector3();
const _muzzle = new THREE.Vector3();
const _shootDir = new THREE.Vector3();
const _camDir = new THREE.Vector3();

class Game {
  constructor(canvas, statusEl) {
    this.canvas = canvas;
    this.statusEl = statusEl;
    this.accumulator = 0;
    this.time = 0;
    this.last = 0;
    this.running = false;
    this.respawnTimer = 0;
    this.footstepTimer = 0;
  }

  status(text) {
    if (this.statusEl) this.statusEl.textContent = text;
  }

  async init() {
    this.world = new World(this.canvas, { viewDistance: 460 });

    this.assets = new Assets();
    this.status("Reading manifest...");
    await this.assets.loadManifest();

    const total = Object.keys(this.assets.manifest.assets).length;
    this.status(`Loading models 0/${total}`);
    await this.assets.loadAll((done, count) => {
      this.status(`Loading models ${done}/${count}`);
    });

    this.status("Building city...");
    this.city = new City(this.assets, { size: 11, seed: 0xC17FE });
    const stats = this.city.generate();
    this.world.scene.add(this.city.group);
    window.__cityStats = stats;
    console.log("city:", stats);

    this.effects = new Effects(this.world.scene);

    // ---- player --------------------------------------------------------
    const start = this.city.randomRoadPoint();
    this.player = new Character(this.assets, this.city, "char_player", {});
    this.player.setPosition(start.x, start.z, 0);
    this.world.scene.add(this.player.root);

    this.loadout = new Loadout(["wpn_pistol"]);
    this.weaponRig = new WeaponRig(this.assets, this.player);
    this.weaponRig.show(this.loadout.current);

    // ---- systems -------------------------------------------------------
    this.audio = new Audio();

    this.combat = new Combat(this.city, this.effects, {
      onNoise: (x, z, radius) => this._onGunfire(x, z, radius),
      onKill: (victim, shooter) => this._onKill(victim, shooter),
      onHit: (victim, dmg, shooter) => this._onHit(victim, dmg, shooter),
    });

    this.population = new Population(this.assets, this.city, this.world.scene, {
      vehicles: 24, pedestrians: 30, seed: 0xB0A7,
    });
    this.population.populate(start);

    this.police = new Police(this.assets, this.city, this.world.scene,
      this.combat, {
        onBusted: () => this._onBusted(),
        onStarsChanged: (stars, before) => this._onStars(stars, before),
      });

    this.missions = new Missions(this.assets, this.city, this.world.scene, {
      onEvent: (type, data) => this._onMissionEvent(type, data),
    });

    this._initStreetLights();
    // A touch layout claims the bottom-right quadrant for the joystick and
    // buttons, so the minimap runs smaller and moves out of that corner (see
    // the body.touch-controls rules in src/hud.js).
    this.hud = new Hud(this.city, {
      minimapSize: hasTouchSupport() ? 108 : 176,
    });
    this.input = new Input(this.canvas);
    this.touch = new TouchControls(this.canvas, this.input, {
      onWeaponCycle: () => {
        if (this.loadout.cycle(1)) this.weaponRig.show(this.loadout.current);
      },
    });
    this.camera = new CameraRig(this.world.camera, this.city);
    this.camera.snapBehind(this.player);

    this.status("");
    this.running = true;
    this.last = performance.now();
    requestAnimationFrame((t) => this.frame(t));
  }

  /**
   * A handful of point lights that hop between whichever street lamps are
   * nearest the player. Lighting every lamp in the city is impossible; moving
   * a small pool is indistinguishable from it at street level.
   */
  _initStreetLights(count = 8) {
    this.lampLights = [];
    for (let i = 0; i < count; i++) {
      const light = new THREE.PointLight(0xffe7bd, 0, 34, 2);
      light.castShadow = false;
      light.visible = false;
      this.world.scene.add(light);
      this.lampLights.push(light);
    }
    this._lampTimer = 0;
  }

  _updateStreetLights(dt, subject) {
    if (!this.lampLights) return;
    const night = this.world.night;

    if (night < 0.08) {
      for (const l of this.lampLights) l.visible = false;
      return;
    }

    // Re-pick targets a few times a second; sorting every frame is wasteful
    // and the player cannot move far enough between picks to notice.
    this._lampTimer -= dt;
    if (this._lampTimer <= 0) {
      this._lampTimer = 0.25;
      const lamps = this.city.lampPositions;
      const near = [];
      for (let i = 0; i < lamps.length; i++) {
        const l = lamps[i];
        const d = dist2D(l.x, l.z, subject.x, subject.z);
        if (d < 70) near.push({ l, d });
      }
      near.sort((a, b) => a.d - b.d);

      for (let i = 0; i < this.lampLights.length; i++) {
        const light = this.lampLights[i];
        const pick = near[i];
        if (!pick) { light.visible = false; continue; }
        light.position.set(pick.l.x, pick.l.y, pick.l.z);
        light.visible = true;
      }
    }

    for (const l of this.lampLights) {
      if (l.visible) l.intensity = 26 * night;
    }
  }

  // ---- event handlers --------------------------------------------------

  _onGunfire(x, z, radius) {
    this.population.alarm(x, z, radius * 2.2, this.player);
    this.audio.gunshot(this.loadout.current);
    this.camera.addShake(this.loadout.spec.shake);

    // Firing where someone can see you attracts attention.
    let witnessed = false;
    for (const ped of this.population.pedestrians) {
      if (ped.alive && dist2D(ped.x, ped.z, x, z) < radius * 2) {
        witnessed = true;
        break;
      }
    }
    if (witnessed || this.police.stars > 0) {
      this.police.addHeat(CRIME.gunfire);
    }
  }

  _onKill(victim, shooter) {
    if (shooter !== this.player) return;
    const isCop = this.police.characters.includes(victim);
    this.police.addHeat(isCop ? CRIME.copKilled : CRIME.pedestrianKilled);
    this.missions.cash += isCop ? 60 : 15;
    this.hud.toast(isCop ? "Officer down" : "", isCop ? "+$60" : "");
  }

  _onHit(victim, dmg, shooter) {
    if (victim === this.player) {
      this.audio.hurt();
      this.camera.addShake(0.18);
      return;
    }
    if (shooter !== this.player) return;
    if (this.police.characters.includes(victim)) {
      this.police.addHeat(CRIME.copHit * 0.25);
    }
  }

  _onBusted() {
    const fine = Math.round(this.missions.cash * 0.25);
    this.missions.spend(fine);
    this.hud.showBanner("BUSTED", `Fine $${fine}`);
    this._respawnPlayer(2.0);
  }

  _onStars(stars, before) {
    if (stars > before) {
      this.audio.star();
      if (stars === 1) this.hud.toast("Wanted", "Lose the police");
    } else if (stars === 0) {
      this.hud.toast("Lost them", "");
    }
  }

  _onMissionEvent(type, data) {
    if (type === "delivery") {
      this.audio.reward();
      this.hud.toast(`+$${data.payout}`,
        data.streak > 1 ? `Streak x${data.streak}` : "Delivered");
    } else if (type === "pickup") {
      this.audio.pickup();
      if (data.message) this.hud.toast(data.message, "");
    }
  }

  // ---- loop ------------------------------------------------------------

  frame(now) {
    if (!this.running) return;
    requestAnimationFrame((t) => this.frame(t));

    const elapsed = clamp((now - this.last) / 1000, 0, 0.25);
    this.last = now;

    // Edge-triggered input is sampled once per rendered frame. Doing it
    // inside the fixed-step loop below fires a single key press once per
    // physics step, so one tap of F would enter and leave a car several
    // times in a row.
    this._pollInput(elapsed);

    this.accumulator += elapsed;

    let steps = 0;
    while (this.accumulator >= FIXED_STEP && steps < MAX_STEPS) {
      this.update(FIXED_STEP);
      this.accumulator -= FIXED_STEP;
      steps++;
    }
    // Never let the accumulator run away after a stall.
    if (steps === MAX_STEPS) this.accumulator = 0;

    this.render(elapsed);
    this.input.endFrame();
  }

  update(dt) {
    this.time += dt;

    // Re-read the state each step: entering or leaving a car during input
    // polling must not leave this loop holding a stale flag.
    const driving = this.player.state === State.DRIVING;
    const vehicle = driving ? this.player.vehicle : null;

    this.loadout.update(dt);
    this.player.update(dt, this._playerIntent(dt, driving));
    if (vehicle) this.player.x = vehicle.x;

    const subject = vehicle || this.player;

    this.population.update(dt, {
      player: this.player,
      center: subject,
      time: this.time,
    });

    this.police.update(dt, {
      player: this.player,
      time: this.time,
      pedestrians: this.population.pedestrians,
      vehicles: [...this.population.vehicles, ...this.police.vehicles],
    });

    if (vehicle) {
      this._vehicleVersusWorld(dt, vehicle);
    }

    this.missions.update(dt, this.player, this.loadout);

    if (!this.player.alive && this.respawnTimer <= 0) {
      this._respawnPlayer(RESPAWN_DELAY);
    }
    if (this.respawnTimer > 0) {
      this.respawnTimer -= dt;
      if (this.respawnTimer <= 0) this._doRespawn();
    }

    this._updateAudio(dt, vehicle);
  }

  /** Once-per-frame input: camera look and every edge-triggered action. */
  _pollInput(dt) {
    const input = this.input;
    const driving = this.player.state === State.DRIVING;

    const delta = input.takeMouseDelta();
    // Touch drives look through the same delta, since mobile browsers do
    // not grant pointer lock; touchActive is set the first time a look-drag
    // happens and simply stays true afterwards.
    if (input.locked || input.touchActive) this.camera.look(delta.dx, delta.dy);
    if (delta.wheel) this.camera.zoomBy(delta.wheel);

    if (input.pressed("Tab")) this.hud.toggleBigMap();
    if (input.pressed("F3")) this.hud.toggleStats();
    if (input.pressed("KeyM")) {
      this.audio.setMuted(!this.audio.muted);
      this.hud.toast(this.audio.muted ? "Muted" : "Sound on", "");
    }

    if (input.pressed("KeyF")) {
      if (driving) {
        this.player.exitVehicle();
        this.camera.snapBehind(this.player);
      } else {
        const car = this._nearestEnterable();
        if (car) {
          const stolen = !this.police.vehicles.includes(car);
          this.player.enterVehicle(car);
          this.camera.snapBehind(car);
          this.police.addHeat(stolen ? CRIME.carStolen : CRIME.carStolen * 3);
        }
      }
    }

    if (!driving) {
      if (input.pressed("KeyR")) this.loadout.startReload();
      for (let i = 0; i < WEAPON_ORDER.length; i++) {
        if (input.pressed(`Digit${i + 1}`)) {
          if (this.loadout.switchTo(WEAPON_ORDER[i])) {
            this.weaponRig.show(this.loadout.current);
          }
        }
      }
    }
  }

  _playerIntent(dt, driving) {
    const input = this.input;
    const vehicle = this.player.vehicle;

    if (driving && vehicle) {
      let throttle = 0, steer = 0;
      if (input.down("KeyW") || input.down("ArrowUp")) throttle += 1;
      if (input.down("KeyS") || input.down("ArrowDown")) throttle -= 1;
      if (input.down("KeyA") || input.down("ArrowLeft")) steer -= 1;
      if (input.down("KeyD") || input.down("ArrowRight")) steer += 1;

      vehicle.update(dt, {
        throttle, steer,
        handbrake: input.down("Space"),
      });
      vehicle.setLights(this.world.night > 0.35);

      if (vehicle.lastImpact > 0.35) {
        this.audio.impact(vehicle.lastImpact);
        this.camera.addShake(vehicle.lastImpact * 0.5);
        vehicle.lastImpact = 0;
      }
      if (vehicle.slip > 0.4 && Math.abs(vehicle.speed) > 6) {
        this.effects.tyreSmoke(vehicle.x, vehicle.y, vehicle.z, vehicle.slip * 0.5);
      }
      return {};
    }

    // On foot: movement is relative to where the camera is looking.
    const axis = input.moveAxis();
    const yaw = this.camera.yaw;
    const fx = forwardX(yaw), fz = forwardZ(yaw);
    const rx = rightX(yaw), rz = rightZ(yaw);

    const moveX = fx * -axis.z + rx * axis.x;
    const moveZ = fz * -axis.z + rz * axis.x;

    const aiming = input.rightDown;
    const firing = input.leftDown;
    if (this.player.alive && firing) this._tryShoot(aiming);

    return {
      moveX, moveZ,
      run: input.down("ShiftLeft") || input.down("ShiftRight"),
      lookHeading: this.camera.lookHeading,
      // Firing raises the weapon too, not just holding right mouse.
      aiming: aiming || firing,
      aimPitch: this.camera.pitch,
    };
  }

  _tryShoot(aiming) {
    if (!this.loadout.canFire()) {
      if (this.loadout.mag === 0) this.loadout.startReload();
      return;
    }

    // Aim at whatever is under the crosshair, then fire from the muzzle
    // toward that point. Firing straight along the muzzle would send rounds
    // wide, because the gun sits off to the character's side.
    const cam = this.world.camera;
    this.camera.aimDirection(_camDir);
    const range = this.loadout.spec.range;
    const hit = this.city.raycast(cam.position.x, cam.position.y, cam.position.z,
                                  _camDir.x, _camDir.y, _camDir.z, range + 20);
    const reach = hit ? hit.t : range + 20;
    _aimPoint.copy(cam.position).addScaledVector(_camDir, reach);

    this.weaponRig.muzzleWorld(_muzzle);
    _shootDir.copy(_aimPoint).sub(_muzzle).normalize();

    const targets = {
      characters: [...this.population.pedestrians, ...this.police.characters],
      vehicles: [...this.population.vehicles, ...this.police.vehicles],
    };

    this.combat.fire(this.player, this.loadout, _muzzle, _shootDir, targets,
                     aiming ? 1.7 : 1.0);
  }

  _nearestEnterable() {
    let best = this.population.nearestVehicle(this.player.x, this.player.z,
                                              ENTER_RANGE);
    let bestD = best
      ? dist2D(best.x, best.z, this.player.x, this.player.z) : Infinity;

    for (const v of this.police.vehicles) {
      if (v.driver) continue;
      const d = dist2D(v.x, v.z, this.player.x, this.player.z);
      if (d < ENTER_RANGE && d < bestD) { best = v; bestD = d; }
    }
    return best;
  }

  /** Ramming pedestrians and other cars while the player is driving. */
  _vehicleVersusWorld(dt, vehicle) {
    for (const other of this.population.vehicles) {
      if (other === vehicle) continue;
      const impact = Vehicle.collidePair(vehicle, other);
      if (impact > 6) {
        this.audio.impact(clamp(impact / 14, 0.2, 1));
        this.camera.addShake(clamp(impact / 26, 0, 0.5));
      }
    }
    for (const v of this.police.vehicles) {
      Vehicle.collidePair(vehicle, v);
    }

    const speed = Math.abs(vehicle.speed);
    if (speed < 4) return;

    for (const ped of this.population.pedestrians) {
      if (!ped.alive) continue;
      const d = dist2D(ped.x, ped.z, vehicle.x, vehicle.z);
      if (d > vehicle.halfLength + 0.8) continue;

      const wasAlive = ped.alive;
      ped.damage(speed * 6);
      this.effects.impact(
        new THREE.Vector3(ped.x, ped.y + 1, ped.z),
        new THREE.Vector3(0, 1, 0), "blood");
      this.audio.impact(0.6);
      this.camera.addShake(0.2);
      this.police.addHeat(
        wasAlive && !ped.alive ? CRIME.pedestrianKilled : CRIME.pedestrianHit);
    }
  }

  _respawnPlayer(delay) {
    if (this.respawnTimer > 0) return;
    this.respawnTimer = delay;
    if (this.player.alive) {
      this.player.hp = 0;
      this.player.alive = false;
      this.player.state = State.DEAD;
    }
    if (!this.hud.banner.classList.contains("show")) {
      this.hud.showBanner("WASTED", "");
    }
  }

  _doRespawn() {
    const p = this.city.randomRoadPoint();
    if (this.player.vehicle) this.player.exitVehicle();
    this.player.revive(p.x, p.z);
    this.player.armour = 0;
    this.loadout = new Loadout(["wpn_pistol"]);
    this.weaponRig.show(this.loadout.current);
    this.police.clear();
    this.missions.spend(Math.round(this.missions.cash * 0.1));
    this.missions.streak = 0;
    this.camera.snapBehind(this.player);
    this.hud.hideBanner();
  }

  _updateAudio(dt, vehicle) {
    if (!this.audio.ready) return;

    this.audio.engine(!!vehicle, vehicle ? vehicle.rpm : 0,
                      vehicle ? Math.abs(vehicle.speed) / 40 : 0);

    // Siren volume follows the nearest active police unit.
    let nearest = Infinity;
    for (const v of this.police.vehicles) {
      nearest = Math.min(nearest, dist2D(v.x, v.z, this.player.x, this.player.z));
    }
    const proximity = nearest === Infinity ? 0 : clamp(1 - nearest / 120, 0, 1);
    this.audio.siren(this.police.stars > 0 && proximity > 0, proximity, dt);

    if (!vehicle && this.player.alive && this.player.speed > 0.6) {
      this.footstepTimer -= dt * this.player.speed;
      if (this.footstepTimer <= 0) {
        this.footstepTimer = 1.6;
        this.audio.footstep(this.player.speed > 3);
      }
    }
  }

  _updateStats(dt) {
    if (!this.hud.statsVisible) return;
    this._fpsAccum = (this._fpsAccum || 0) + dt;
    this._fpsFrames = (this._fpsFrames || 0) + 1;
    if (this._fpsAccum < 0.5) return;

    const fps = this._fpsFrames / this._fpsAccum;
    this._fpsAccum = 0;
    this._fpsFrames = 0;

    const info = this.world.renderer.info;
    const p = this.player;
    this.hud.setStats(
      `fps       ${fps.toFixed(0)}\n` +
      `draws     ${info.render.calls}\n` +
      `triangles ${info.render.triangles.toLocaleString()}\n` +
      `geometries${String(info.memory.geometries).padStart(5)}\n` +
      `textures  ${info.memory.textures}\n` +
      `traffic   ${this.population.vehicles.length}\n` +
      `peds      ${this.population.pedestrians.length}\n` +
      `police    ${this.police.cars.length}c ${this.police.foot.length}f\n` +
      `heat      ${this.police.heat.toFixed(0)} (${this.police.stars}*)\n` +
      `pos       ${p.x.toFixed(0)}, ${p.z.toFixed(0)}\n` +
      `time      ${(this.world.timeOfDay * 24).toFixed(1)}h`
    );
  }

  render(dt) {
    const driving = this.player.state === State.DRIVING;
    const vehicle = driving ? this.player.vehicle : null;
    const subject = vehicle || this.player;

    this.camera.update(dt, {
      x: subject.x,
      y: subject.y,
      z: subject.z,
      heading: subject.heading,
      speed: vehicle ? vehicle.speed : this.player.speed,
    }, {
      mode: driving ? "car" : (this.input.rightDown ? "aim" : "foot"),
      freeLook: this.input.down("AltLeft"),
    });

    this.world.update(dt);
    // Windows and street lamps only glow once it is actually dark.
    this.assets.setNightLights(this.world.night);
    this._updateStreetLights(dt, subject);
    this.world.focusShadows(subject.x, 0, subject.z);
    this.effects.update(dt);
    this.effects.faceCamera(this.world.camera);

    const car = this._nearestEnterable();
    this.hud.prompt(
      !driving && car ? "<b>F</b> to get in" :
      driving ? "<b>F</b> to get out" : null
    );
    this.touch.setDriving(driving);

    this.hud.update(dt, {
      player: this.player,
      loadout: this.loadout,
      missions: this.missions,
      police: this.police,
      vehicle,
      aiming: this.input.rightDown && !driving,
      traffic: this.population.vehicles,
      policeVehicles: this.police.vehicles,
      policeFoot: this.police.characters,
    });

    this.world.render();
    this._updateStats(dt);
  }
}

// --------------------------------------------------------------------------

/**
 * Best-effort landscape lock for phones.
 *
 * The Screen Orientation API only grants a lock inside fullscreen on most
 * mobile browsers (and not at all on iOS Safari, which has no arbitrary
 * fullscreen API either), so this tries fullscreen first and treats the
 * whole thing as optional. The CSS rotate-hint in play.html is what actually
 * carries devices this can't reach; this is a nicety for the ones it can.
 */
function _tryLockLandscape() {
  if (!hasTouchSupport()) return;
  const el = document.documentElement;
  const request = el.requestFullscreen || el.webkitRequestFullscreen;
  if (!request) return;

  Promise.resolve(request.call(el))
    .then(() => screen.orientation && screen.orientation.lock &&
      screen.orientation.lock("landscape"))
    .catch(() => {});
}

async function boot() {
  // Set this before anything else, not inside Game.init(), so the correct
  // control legend and the rotate-hint media query both see the right
  // device type from the very first paint — otherwise a touch device shows
  // desktop key hints for however long asset loading takes.
  if (hasTouchSupport()) document.body.classList.add("touch-controls");

  const canvas = document.getElementById("game");
  const statusEl = document.getElementById("status");
  const overlay = document.getElementById("overlay");
  const startBtn = document.getElementById("start");

  if (location.protocol === "file:") {
    statusEl.innerHTML =
      "This page must be served over HTTP, not opened as a file.<br>" +
      "Run <code>python3 -m http.server 8080</code> in the project folder, " +
      "then open <code>http://localhost:8080/play.html</code>.";
    startBtn.style.display = "none";
    return;
  }

  const game = new Game(canvas, statusEl);
  // Exposed deliberately: the browser check and the console both need a way
  // to inspect and poke a running world.
  window.game = game;

  try {
    await game.init();
  } catch (err) {
    console.error(err);
    statusEl.innerHTML = `Failed to start:<br><code>${err.message}</code>`;
    startBtn.style.display = "none";
    return;
  }

  startBtn.disabled = false;
  startBtn.textContent = hasTouchSupport() ? "Tap to play" : "Click to play";
  startBtn.addEventListener("click", () => {
    overlay.classList.add("hidden");
    game.audio.init();
    // No-ops harmlessly on touch devices, which do not grant pointer lock;
    // TouchControls supplies look input through the same path instead.
    game.input.requestLock();
    _tryLockLandscape();
  });

  // Re-lock the pointer after the player presses escape. Touch devices never
  // lock in the first place, so this is a no-op for them.
  canvas.addEventListener("click", () => {
    if (!overlay.classList.contains("hidden")) return;
    game.input.requestLock();
  });
}

boot();
