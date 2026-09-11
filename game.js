'use strict';

/* ============================== Liberty Grid ==============================
   A top-down open-city sandbox. Drive, walk, shoot, run from the cops.
   No dependencies. Everything below is plain canvas 2D.
   ========================================================================= */

// ------------------------------- constants --------------------------------

const TILE = 480;              // distance between road centrelines
const ROAD = 140;              // road width
const SIDEWALK = 22;           // sidewalk band inside each block
const GRID = 13;               // intersections per axis
const WORLD = TILE * (GRID - 1);

const CAR_W = 46, CAR_H = 22;
const PED_R = 9;

const MAX_CARS = 44;
const MAX_PEDS = 55;
const DESPAWN_DIST = 2400;     // recycle entities past this range

const COLORS = {
  asphalt: '#23262d',
  lane:    '#6f7683',
  ground:  '#2f3440',
  park:    '#2c4433',
  walk:    '#3b4151',
  wall:    ['#4a515f', '#545b6b', '#3f4654', '#5b6373', '#454d5c'],
  roof:    ['#6b7488', '#767f93', '#5f6879', '#818aa0', '#707a8e'],
};

const CAR_PAINT = [
  '#c0392b', '#2980b9', '#27ae60', '#f39c12', '#8e44ad',
  '#16a085', '#d35400', '#bdc3c7', '#34495e', '#e74c3c',
];

// -------------------------------- helpers ---------------------------------

const clamp = (v, a, b) => v < a ? a : v > b ? b : v;
const lerp = (a, b, t) => a + (b - a) * t;
const dist2 = (ax, ay, bx, by) => { const dx = ax - bx, dy = ay - by; return dx * dx + dy * dy; };
const dist = (ax, ay, bx, by) => Math.hypot(ax - bx, ay - by);

/** Wrap an angle into [-PI, PI). Modulo, not a loop: a huge or infinite
 *  input must never spin here. */
function wrapAngle(a) {
  const TAU = Math.PI * 2;
  a = (a + Math.PI) % TAU;
  if (a < 0) a += TAU;
  return a - Math.PI;
}

/** Deterministic PRNG so the city is identical on every load. */
function mulberry32(seed) {
  return function () {
    seed |= 0; seed = (seed + 0x6D2B79F5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const rng = mulberry32(0x5EED);
const rand = (a, b) => a + rng() * (b - a);
const randInt = (a, b) => Math.floor(rand(a, b + 1));
const pick = arr => arr[Math.floor(rng() * arr.length)];

/** Distance from a coordinate to the nearest road centreline on that axis. */
function axisRoadDist(v) {
  const m = ((v % TILE) + TILE) % TILE;
  return Math.min(m, TILE - m);
}

function circleRect(cx, cy, r, b) {
  const nx = clamp(cx, b.x, b.x + b.w);
  const ny = clamp(cy, b.y, b.y + b.h);
  return dist2(cx, cy, nx, ny) < r * r;
}

// ------------------------------- world gen --------------------------------

/** @type {{x:number,y:number,w:number,h:number,wall:string,roof:string,floors:number}[]} */
const buildings = [];
/** @type {Map<string, object[]>} */
const buildingGrid = new Map();
/** @type {{x:number,y:number,w:number,h:number}[]} */
const parks = [];

function bucketKey(bi, bj) { return bi + ',' + bj; }

function addBuilding(b) {
  buildings.push(b);
  const bi = Math.floor((b.x + b.w / 2) / TILE);
  const bj = Math.floor((b.y + b.h / 2) / TILE);
  const k = bucketKey(bi, bj);
  let list = buildingGrid.get(k);
  if (!list) { list = []; buildingGrid.set(k, list); }
  list.push(b);
}

function generateCity() {
  for (let bi = 0; bi < GRID - 1; bi++) {
    for (let bj = 0; bj < GRID - 1; bj++) {
      const x0 = bi * TILE + ROAD / 2 + SIDEWALK;
      const y0 = bj * TILE + ROAD / 2 + SIDEWALK;
      const x1 = (bi + 1) * TILE - ROAD / 2 - SIDEWALK;
      const y1 = (bj + 1) * TILE - ROAD / 2 - SIDEWALK;

      if (rng() < 0.11) {                       // leave a park
        parks.push({ x: x0, y: y0, w: x1 - x0, h: y1 - y0 });
        continue;
      }

      const cols = randInt(1, 3);
      const rows = randInt(1, 3);
      const gap = 12;
      const cw = (x1 - x0 - gap * (cols - 1)) / cols;
      const ch = (y1 - y0 - gap * (rows - 1)) / rows;

      for (let c = 0; c < cols; c++) {
        for (let r = 0; r < rows; r++) {
          if (rng() < 0.08) continue;           // occasional empty lot
          const inset = rand(0, 10);
          addBuilding({
            x: x0 + c * (cw + gap) + inset,
            y: y0 + r * (ch + gap) + inset,
            w: cw - inset * 2,
            h: ch - inset * 2,
            wall: pick(COLORS.wall),
            roof: pick(COLORS.roof),
            floors: rand(1, 3.4),
          });
        }
      }
    }
  }
}

/** Buildings in the 3x3 block neighbourhood around a point. */
function nearbyBuildings(x, y) {
  const bi = Math.floor(x / TILE), bj = Math.floor(y / TILE);
  const out = [];
  for (let i = bi - 1; i <= bi + 1; i++) {
    for (let j = bj - 1; j <= bj + 1; j++) {
      const list = buildingGrid.get(bucketKey(i, j));
      if (list) out.push(...list);
    }
  }
  return out;
}

function blockedCircle(x, y, r) {
  if (x < r || y < r || x > WORLD - r || y > WORLD - r) return true;
  const list = nearbyBuildings(x, y);
  for (let i = 0; i < list.length; i++) if (circleRect(x, y, r, list[i])) return true;
  return false;
}

/** Random point on a road, optionally far from a reference point. */
function randomRoadPoint(awayFrom, minDist) {
  for (let tries = 0; tries < 120; tries++) {
    const i = randInt(0, GRID - 1);
    const j = randInt(0, GRID - 1);
    const along = rand(0.15, 0.85);
    let x, y;
    if (rng() < 0.5) { x = i * TILE; y = (j + along) * TILE; }
    else { x = (i + along) * TILE; y = j * TILE; }
    x = clamp(x, 60, WORLD - 60); y = clamp(y, 60, WORLD - 60);
    if (!awayFrom || dist(x, y, awayFrom.x, awayFrom.y) > (minDist || 0)) return { x, y };
  }
  return { x: TILE, y: TILE };
}

// ------------------------------- entities ---------------------------------

const player = {
  x: TILE * 2, y: TILE * 2,
  angle: 0, vx: 0, vy: 0,
  hp: 100, cash: 0,
  car: null,
  fireCooldown: 0,
  hitFlash: 0,
  alive: true,
  respawnTimer: 0,
};

/** @type {object[]} */ const cars = [];
/** @type {object[]} */ const peds = [];
/** @type {object[]} */ const bullets = [];
/** @type {object[]} */ const particles = [];

let wanted = 0;
let wantedDecay = 0;
let marker = null;
let combo = 0;

function makeCar(x, y, opts) {
  opts = opts || {};
  const i = Math.round(x / TILE), j = Math.round(y / TILE);
  return {
    x, y,
    angle: rng() < 0.5 ? 0 : Math.PI / 2,
    speed: 0,
    hp: 100,
    paint: opts.cop ? '#1b2942' : pick(CAR_PAINT),
    cop: !!opts.cop,
    ai: true,
    from: { i, j },
    to: { i: clamp(i + (rng() < 0.5 ? 1 : -1), 0, GRID - 1), j },
    maxSpeed: opts.cop ? 330 : rand(130, 190),
    fireCooldown: rand(0.4, 1.6),
    siren: 0,
  };
}

function makePed(x, y) {
  return {
    x, y,
    angle: rand(0, Math.PI * 2),
    speed: rand(34, 58),
    tx: x, ty: y,
    hp: 30,
    panic: 0,
    shirt: `hsl(${randInt(0, 360)} 45% ${randInt(42, 66)}%)`,
    skin: `hsl(${randInt(18, 36)} ${randInt(30, 48)}% ${randInt(38, 74)}%)`,
  };
}

function spawnInitialTraffic() {
  for (let i = 0; i < MAX_CARS; i++) {
    const p = randomRoadPoint(player, 400);
    cars.push(makeCar(p.x, p.y));
  }
  for (let i = 0; i < MAX_PEDS; i++) {
    const p = randomSidewalkPoint();
    peds.push(makePed(p.x, p.y));
  }
}

function randomSidewalkPoint() {
  for (let tries = 0; tries < 100; tries++) {
    const bi = randInt(0, GRID - 2), bj = randInt(0, GRID - 2);
    const x0 = bi * TILE + ROAD / 2, y0 = bj * TILE + ROAD / 2;
    const x1 = (bi + 1) * TILE - ROAD / 2, y1 = (bj + 1) * TILE - ROAD / 2;
    const band = SIDEWALK * 0.5;
    let x, y;
    switch (randInt(0, 3)) {
      case 0: x = rand(x0, x1); y = y0 + band; break;
      case 1: x = rand(x0, x1); y = y1 - band; break;
      case 2: x = x0 + band; y = rand(y0, y1); break;
      default: x = x1 - band; y = rand(y0, y1); break;
    }
    if (!blockedCircle(x, y, PED_R)) return { x, y };
  }
  return { x: TILE + ROAD / 2 + 8, y: TILE + ROAD / 2 + 8 };
}

// --------------------------------- audio ----------------------------------

let audioCtx = null;

function initAudio() {
  if (audioCtx) return;
  const AC = window.AudioContext || window.webkitAudioContext;
  if (AC) audioCtx = new AC();
}

function blip(freq, dur, type, gain) {
  if (!audioCtx) return;
  const t = audioCtx.currentTime;
  const osc = audioCtx.createOscillator();
  const g = audioCtx.createGain();
  osc.type = type || 'square';
  osc.frequency.setValueAtTime(freq, t);
  osc.frequency.exponentialRampToValueAtTime(Math.max(40, freq * 0.4), t + dur);
  g.gain.setValueAtTime(gain == null ? 0.05 : gain, t);
  g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
  osc.connect(g).connect(audioCtx.destination);
  osc.start(t); osc.stop(t + dur + 0.02);
}

const sfx = {
  shot:   () => blip(240, 0.09, 'square', 0.045),
  hit:    () => blip(120, 0.13, 'sawtooth', 0.05),
  crash:  () => blip(70, 0.22, 'sawtooth', 0.06),
  pickup: () => { blip(660, 0.1, 'sine', 0.07); setTimeout(() => blip(990, 0.14, 'sine', 0.07), 90); },
  star:   () => blip(1200, 0.16, 'triangle', 0.05),
  death:  () => blip(160, 0.7, 'sawtooth', 0.08),
};

// --------------------------------- input ----------------------------------

const keys = Object.create(null);
const mouse = { x: 0, y: 0, down: false, wx: 0, wy: 0 };
let showBigMap = false;
let started = false;

addEventListener('keydown', e => {
  const k = e.key.toLowerCase();
  keys[k] = true;
  if (k === 'tab') { showBigMap = !showBigMap; e.preventDefault(); }
  if (k === 'f') tryToggleVehicle();
  if ([' ', 'arrowup', 'arrowdown', 'arrowleft', 'arrowright'].includes(k)) e.preventDefault();
});
addEventListener('keyup', e => { keys[e.key.toLowerCase()] = false; });
addEventListener('blur', () => { for (const k in keys) keys[k] = false; mouse.down = false; });

const canvas = document.getElementById('game');
const ctx = canvas.getContext('2d');

canvas.addEventListener('mousemove', e => {
  const r = canvas.getBoundingClientRect();
  mouse.x = e.clientX - r.left;
  mouse.y = e.clientY - r.top;
});
canvas.addEventListener('mousedown', () => { mouse.down = true; });
addEventListener('mouseup', () => { mouse.down = false; });
canvas.addEventListener('contextmenu', e => e.preventDefault());

const overlay = document.getElementById('overlay');
overlay.addEventListener('click', () => {
  overlay.classList.add('hidden');
  started = true;
  initAudio();
  if (audioCtx && audioCtx.state === 'suspended') audioCtx.resume();
});

// ------------------------------ vehicle swap ------------------------------

function tryToggleVehicle() {
  if (!started || !player.alive) return;
  if (player.car) {
    const car = player.car;
    const ox = Math.cos(car.angle + Math.PI / 2) * 34;
    const oy = Math.sin(car.angle + Math.PI / 2) * 34;
    let px = car.x + ox, py = car.y + oy;
    if (blockedCircle(px, py, PED_R)) { px = car.x - ox; py = car.y - oy; }
    if (blockedCircle(px, py, PED_R)) { px = car.x; py = car.y; }
    player.x = px; player.y = py;
    player.car = null;
    car.ai = true;
    car.speed *= 0.3;
  } else {
    let best = null, bestD = 80 * 80;
    for (const car of cars) {
      const d = dist2(player.x, player.y, car.x, car.y);
      if (d < bestD) { bestD = d; best = car; }
    }
    if (best) {
      if (best.cop) addWanted(1);
      player.car = best;
      best.ai = false;
    }
  }
}

// ------------------------------ wanted level ------------------------------

function addWanted(n) {
  const before = wanted;
  wanted = clamp(wanted + n, 0, 5);
  wantedDecay = 18;
  if (wanted > before) {
    sfx.star();
    for (let i = 0; i < (wanted - before) * 2; i++) spawnCopCar();
  }
}

function spawnCopCar() {
  const ref = player.car || player;
  const p = randomRoadPoint(ref, 900);
  const c = makeCar(p.x, p.y, { cop: true });
  cars.push(c);
  if (cars.length > MAX_CARS + 24) {
    const idx = cars.findIndex(k => !k.cop && k !== player.car);
    if (idx >= 0) cars.splice(idx, 1);
  }
}

// ------------------------------- particles --------------------------------

function burst(x, y, color, n, power) {
  for (let i = 0; i < n; i++) {
    const a = rand(0, Math.PI * 2);
    const s = rand(0.2, 1) * (power || 140);
    particles.push({
      x, y,
      vx: Math.cos(a) * s, vy: Math.sin(a) * s,
      life: rand(0.25, 0.7), max: 0.7,
      color, size: rand(1.5, 3.5),
    });
  }
}

// -------------------------------- shooting --------------------------------

function fireBullet(x, y, angle, friendly, speed) {
  const spread = friendly ? 0.035 : 0.12;
  const a = angle + rand(-spread, spread);
  bullets.push({
    x, y,
    vx: Math.cos(a) * (speed || 900),
    vy: Math.sin(a) * (speed || 900),
    life: 0.85, friendly,
  });
  burst(x, y, '#ffd98a', 3, 60);
  sfx.shot();
}

// --------------------------------- update ---------------------------------

function updatePlayerOnFoot(dt) {
  let ix = 0, iy = 0;
  if (keys['a'] || keys['arrowleft']) ix -= 1;
  if (keys['d'] || keys['arrowright']) ix += 1;
  if (keys['w'] || keys['arrowup']) iy -= 1;
  if (keys['s'] || keys['arrowdown']) iy += 1;

  const len = Math.hypot(ix, iy);
  const sprint = keys['shift'] ? 1.75 : 1;
  const speed = 168 * sprint;
  if (len > 0) { ix /= len; iy /= len; }

  const nx = player.x + ix * speed * dt;
  const ny = player.y + iy * speed * dt;
  if (!blockedCircle(nx, player.y, PED_R)) player.x = nx;
  if (!blockedCircle(player.x, ny, PED_R)) player.y = ny;

  player.angle = Math.atan2(mouse.wy - player.y, mouse.wx - player.x);

  player.fireCooldown -= dt;
  if ((mouse.down || keys[' ']) && player.fireCooldown <= 0) {
    player.fireCooldown = 0.14;
    fireBullet(
      player.x + Math.cos(player.angle) * 14,
      player.y + Math.sin(player.angle) * 14,
      player.angle, true
    );
  }
}

function updateCarPhysics(car, dt, input) {
  const throttle = input.throttle;
  const steer = input.steer;
  const handbrake = input.handbrake;

  const accel = 300, brake = 520, drag = 0.86;

  if (throttle > 0) car.speed += accel * throttle * dt;
  else if (throttle < 0) car.speed -= brake * -throttle * dt;

  if (handbrake) car.speed *= Math.pow(0.12, dt);
  car.speed *= Math.pow(drag, dt);
  car.speed = clamp(car.speed, -car.maxSpeed * 0.45, car.maxSpeed);

  const grip = clamp(Math.abs(car.speed) / 90, 0, 1);
  car.angle += steer * dt * 2.4 * grip * Math.sign(car.speed || 1);

  const nx = car.x + Math.cos(car.angle) * car.speed * dt;
  const ny = car.y + Math.sin(car.angle) * car.speed * dt;

  if (carBlocked(nx, ny, car.angle)) {
    if (Math.abs(car.speed) > 150) {
      burst(car.x, car.y, '#ffca6b', 8, 120);
      sfx.crash();
      car.hp -= Math.abs(car.speed) * 0.05;
      if (car === player.car) damagePlayer(Math.abs(car.speed) * 0.02);
    }
    car.speed *= -0.28;
  } else {
    car.x = nx; car.y = ny;
  }

  car.x = clamp(car.x, 24, WORLD - 24);
  car.y = clamp(car.y, 24, WORLD - 24);
}

function carBlocked(x, y, angle) {
  const list = nearbyBuildings(x, y);
  if (!list.length) return x < 24 || y < 24 || x > WORLD - 24 || y > WORLD - 24;
  const ca = Math.cos(angle), sa = Math.sin(angle);
  const hw = CAR_W / 2, hh = CAR_H / 2;
  for (let i = -1; i <= 1; i += 2) {
    for (let j = -1; j <= 1; j += 2) {
      const px = x + ca * hw * i - sa * hh * j;
      const py = y + sa * hw * i + ca * hh * j;
      for (let b = 0; b < list.length; b++) {
        if (circleRect(px, py, 2, list[b])) return true;
      }
    }
  }
  return x < 24 || y < 24 || x > WORLD - 24 || y > WORLD - 24;
}

function updatePlayerDriving(dt) {
  const car = player.car;
  let throttle = 0, steer = 0;
  if (keys['w'] || keys['arrowup']) throttle += 1;
  if (keys['s'] || keys['arrowdown']) throttle -= 1;
  if (keys['a'] || keys['arrowleft']) steer -= 1;
  if (keys['d'] || keys['arrowright']) steer += 1;

  car.maxSpeed = 430;
  updateCarPhysics(car, dt, { throttle, steer, handbrake: !!keys['shift'] });

  player.x = car.x; player.y = car.y;
  player.angle = car.angle;

  // Run people over.
  for (const ped of peds) {
    if (Math.abs(car.speed) > 70 && dist2(car.x, car.y, ped.x, ped.y) < 26 * 26) {
      killPed(ped, true);
    }
  }
}

function nodePos(n) { return { x: n.i * TILE, y: n.j * TILE }; }

function pickNextNode(car) {
  const opts = [];
  const { i, j } = car.to;
  const cand = [{ i: i + 1, j }, { i: i - 1, j }, { i, j: j + 1 }, { i, j: j - 1 }];
  for (const c of cand) {
    if (c.i < 0 || c.j < 0 || c.i > GRID - 1 || c.j > GRID - 1) continue;
    if (c.i === car.from.i && c.j === car.from.j) continue;
    opts.push(c);
  }
  car.from = car.to;
  car.to = opts.length ? pick(opts) : { i: car.from.i, j: car.from.j };
}

function updateTrafficCar(car, dt) {
  const target = nodePos(car.to);
  // Keep to the right-hand lane.
  const dirA = Math.atan2(target.y - car.y, target.x - car.x);
  const lane = ROAD / 4;
  const tx = target.x + Math.cos(dirA + Math.PI / 2) * lane;
  const ty = target.y + Math.sin(dirA + Math.PI / 2) * lane;

  if (car.cop) {
    const ref = player.car || player;
    if (dist2(car.x, car.y, ref.x, ref.y) < 1600 * 1600 && wanted > 0) {
      chase(car, ref, dt);
      return;
    }
  }

  const want = Math.atan2(ty - car.y, tx - car.x);
  const diff = wrapAngle(want - car.angle);
  const steer = clamp(diff * 2.2, -1, 1);
  const turning = Math.abs(diff) > 0.5;
  const throttle = Math.abs(car.speed) < car.maxSpeed * (turning ? 0.45 : 1) ? 1 : 0;

  updateCarPhysics(car, dt, { throttle, steer, handbrake: false });

  if (dist2(car.x, car.y, target.x, target.y) < 70 * 70) pickNextNode(car);
}

function chase(car, ref, dt) {
  car.siren += dt;
  const want = Math.atan2(ref.y - car.y, ref.x - car.x);
  const diff = wrapAngle(want - car.angle);
  const steer = clamp(diff * 2.4, -1, 1);
  const d = dist(car.x, car.y, ref.x, ref.y);
  const throttle = d > 90 ? 1 : -0.4;
  updateCarPhysics(car, dt, { throttle, steer, handbrake: false });

  // Ram damage.
  if (d < 34 && Math.abs(car.speed) > 120) {
    damagePlayer(8 * dt * 10);
    burst(car.x, car.y, '#ffca6b', 4, 100);
  }

  // Shoot at the player.
  car.fireCooldown -= dt;
  if (wanted >= 2 && d < 420 && car.fireCooldown <= 0) {
    car.fireCooldown = rand(0.7, 1.5);
    fireBullet(car.x, car.y, Math.atan2(ref.y - car.y, ref.x - car.x), false, 620);
  }
}

function updatePed(ped, dt) {
  const ref = player.car || player;
  const dp = dist(ped.x, ped.y, ref.x, ref.y);

  if (wanted > 0 && dp < 260) ped.panic = 1.6;
  if (ped.panic > 0) ped.panic -= dt;

  if (ped.panic > 0) {
    const away = Math.atan2(ped.y - ref.y, ped.x - ref.x);
    ped.tx = ped.x + Math.cos(away) * 200;
    ped.ty = ped.y + Math.sin(away) * 200;
  } else if (dist2(ped.x, ped.y, ped.tx, ped.ty) < 18 * 18) {
    const p = randomSidewalkPoint();
    ped.tx = p.x; ped.ty = p.y;
  }

  const a = Math.atan2(ped.ty - ped.y, ped.tx - ped.x);
  ped.angle = a;
  const sp = ped.speed * (ped.panic > 0 ? 2.1 : 1);
  const nx = ped.x + Math.cos(a) * sp * dt;
  const ny = ped.y + Math.sin(a) * sp * dt;
  if (!blockedCircle(nx, ped.y, PED_R)) ped.x = nx; else ped.tx = ped.x + rand(-100, 100);
  if (!blockedCircle(ped.x, ny, PED_R)) ped.y = ny; else ped.ty = ped.y + rand(-100, 100);
}

function killPed(ped, byCar) {
  burst(ped.x, ped.y, '#9b2b2b', 12, 150);
  sfx.hit();
  const p = randomSidewalkPoint();
  ped.x = p.x; ped.y = p.y; ped.tx = p.x; ped.ty = p.y; ped.hp = 30; ped.panic = 0;
  addWanted(1);
  player.cash += 15;
}

function damagePlayer(n) {
  if (!player.alive) return;
  player.hp -= n;
  player.hitFlash = 0.25;
  if (player.hp <= 0) {
    player.hp = 0;
    player.alive = false;
    player.respawnTimer = 2.2;
    sfx.death();
    burst(player.x, player.y, '#b33', 26, 220);
    if (player.car) { player.car.ai = true; player.car = null; }
  }
}

function respawn() {
  const p = randomRoadPoint(null, 0);
  player.x = p.x; player.y = p.y;
  player.hp = 100; player.alive = true; player.car = null;
  player.cash = Math.floor(player.cash * 0.9);
  wanted = 0; wantedDecay = 0;
  for (let i = cars.length - 1; i >= 0; i--) if (cars[i].cop) cars.splice(i, 1);
}

function updateBullets(dt) {
  for (let i = bullets.length - 1; i >= 0; i--) {
    const b = bullets[i];
    b.life -= dt;
    const nx = b.x + b.vx * dt, ny = b.y + b.vy * dt;

    let hit = false;

    const list = nearbyBuildings(nx, ny);
    for (let k = 0; k < list.length; k++) {
      if (circleRect(nx, ny, 1, list[k])) { hit = true; break; }
    }

    if (!hit && b.friendly) {
      for (const ped of peds) {
        if (dist2(nx, ny, ped.x, ped.y) < 12 * 12) { killPed(ped, false); hit = true; break; }
      }
      if (!hit) {
        for (const car of cars) {
          if (car === player.car) continue;
          if (dist2(nx, ny, car.x, car.y) < 24 * 24) {
            car.hp -= 12;
            burst(nx, ny, '#ffd98a', 4, 90);
            if (car.cop) addWanted(0.02);
            if (car.hp <= 0) {
              burst(car.x, car.y, '#ff8c2b', 26, 240);
              sfx.crash();
              if (car.cop) { addWanted(1); player.cash += 120; }
              const p = randomRoadPoint(player, 1200);
              Object.assign(car, makeCar(p.x, p.y, { cop: car.cop }));
            }
            hit = true; break;
          }
        }
      }
    } else if (!hit && !b.friendly) {
      const ref = player.car || player;
      const r = player.car ? 22 : 11;
      if (dist2(nx, ny, ref.x, ref.y) < r * r) {
        damagePlayer(player.car ? 4 : 9);
        burst(nx, ny, '#ff6b6b', 5, 100);
        hit = true;
      }
    }

    b.x = nx; b.y = ny;
    if (hit || b.life <= 0) {
      if (hit) burst(b.x, b.y, '#cfd6e2', 3, 70);
      bullets.splice(i, 1);
    }
  }
}

function updateParticles(dt) {
  for (let i = particles.length - 1; i >= 0; i--) {
    const p = particles[i];
    p.life -= dt;
    p.x += p.vx * dt; p.y += p.vy * dt;
    p.vx *= Math.pow(0.12, dt); p.vy *= Math.pow(0.12, dt);
    if (p.life <= 0) particles.splice(i, 1);
  }
}

function recycleEntities() {
  const ref = player.car || player;
  for (const car of cars) {
    if (car === player.car) continue;
    if (dist(car.x, car.y, ref.x, ref.y) > DESPAWN_DIST) {
      const p = randomRoadPoint(ref, 1000);
      Object.assign(car, makeCar(p.x, p.y, { cop: car.cop }));
    }
  }
  for (const ped of peds) {
    if (dist(ped.x, ped.y, ref.x, ref.y) > DESPAWN_DIST) {
      const p = randomSidewalkPoint();
      ped.x = p.x; ped.y = p.y; ped.tx = p.x; ped.ty = p.y;
    }
  }
}

function newMarker() {
  const ref = player.car || player;
  const p = randomRoadPoint(ref, 900);
  marker = { x: p.x, y: p.y, pulse: 0 };
}

function updateMarker(dt) {
  if (!marker) { newMarker(); return; }
  marker.pulse += dt * 3;
  const ref = player.car || player;
  if (dist2(ref.x, ref.y, marker.x, marker.y) < 46 * 46) {
    combo++;
    const reward = 250 + combo * 40 + wanted * 150;
    player.cash += reward;
    burst(marker.x, marker.y, '#ffd34d', 24, 200);
    sfx.pickup();
    newMarker();
  }
}

function update(dt) {
  if (!started) return;

  if (!player.alive) {
    player.respawnTimer -= dt;
    if (player.respawnTimer <= 0) respawn();
  } else if (player.car) {
    updatePlayerDriving(dt);
  } else {
    updatePlayerOnFoot(dt);
  }

  player.hitFlash = Math.max(0, player.hitFlash - dt);

  for (const car of cars) if (car.ai) updateTrafficCar(car, dt);
  for (const ped of peds) updatePed(ped, dt);

  updateBullets(dt);
  updateParticles(dt);
  updateMarker(dt);
  recycleEntities();

  if (wanted > 0) {
    wantedDecay -= dt;
    if (wantedDecay <= 0) { wanted = Math.max(0, wanted - 1); wantedDecay = 16; }
  }
  if (wanted <= 0) {
    for (let i = cars.length - 1; i >= 0; i--) {
      if (cars[i].cop && cars[i] !== player.car &&
          dist(cars[i].x, cars[i].y, player.x, player.y) > 1400) cars.splice(i, 1);
    }
  }
}

// --------------------------------- camera ---------------------------------

const cam = { x: player.x, y: player.y, shake: 0 };

function updateCamera(dt) {
  const ref = player.car || player;
  const lead = player.car ? clamp(player.car.speed / 430, -1, 1) * 110 : 0;
  const tx = ref.x + Math.cos(ref.angle) * lead;
  const ty = ref.y + Math.sin(ref.angle) * lead;
  const k = 1 - Math.pow(0.0015, dt);
  cam.x = lerp(cam.x, tx, k);
  cam.y = lerp(cam.y, ty, k);
  cam.shake = Math.max(0, cam.shake - dt * 3);
}

// --------------------------------- render ---------------------------------

let W = 0, H = 0, DPR = 1;

function resize() {
  DPR = Math.min(devicePixelRatio || 1, 2);
  W = innerWidth; H = innerHeight;
  canvas.width = Math.floor(W * DPR);
  canvas.height = Math.floor(H * DPR);
  canvas.style.width = W + 'px';
  canvas.style.height = H + 'px';
}
addEventListener('resize', resize);

function screenToWorld() {
  mouse.wx = mouse.x - W / 2 + cam.x;
  mouse.wy = mouse.y - H / 2 + cam.y;
}

function drawGround(l, t, r, b) {
  ctx.fillStyle = COLORS.asphalt;
  ctx.fillRect(l, t, r - l, b - t);

  const bi0 = Math.max(0, Math.floor(l / TILE) - 1);
  const bi1 = Math.min(GRID - 2, Math.floor(r / TILE) + 1);
  const bj0 = Math.max(0, Math.floor(t / TILE) - 1);
  const bj1 = Math.min(GRID - 2, Math.floor(b / TILE) + 1);

  // Block ground + sidewalks.
  for (let i = bi0; i <= bi1; i++) {
    for (let j = bj0; j <= bj1; j++) {
      const x = i * TILE + ROAD / 2, y = j * TILE + ROAD / 2;
      const w = TILE - ROAD, h = TILE - ROAD;
      ctx.fillStyle = COLORS.walk;
      ctx.fillRect(x, y, w, h);
      ctx.fillStyle = COLORS.ground;
      ctx.fillRect(x + SIDEWALK, y + SIDEWALK, w - SIDEWALK * 2, h - SIDEWALK * 2);
    }
  }

  for (const p of parks) {
    if (p.x > r || p.x + p.w < l || p.y > b || p.y + p.h < t) continue;
    ctx.fillStyle = COLORS.park;
    ctx.fillRect(p.x, p.y, p.w, p.h);
  }

  // Lane dashes.
  ctx.strokeStyle = COLORS.lane;
  ctx.lineWidth = 3;
  ctx.setLineDash([26, 30]);
  ctx.beginPath();
  const i0 = Math.max(0, Math.floor(l / TILE)), i1 = Math.min(GRID - 1, Math.ceil(r / TILE));
  const j0 = Math.max(0, Math.floor(t / TILE)), j1 = Math.min(GRID - 1, Math.ceil(b / TILE));
  for (let i = i0; i <= i1; i++) { ctx.moveTo(i * TILE, t); ctx.lineTo(i * TILE, b); }
  for (let j = j0; j <= j1; j++) { ctx.moveTo(l, j * TILE); ctx.lineTo(r, j * TILE); }
  ctx.stroke();
  ctx.setLineDash([]);
}

function drawBuildings(l, t, r, b) {
  for (let i = 0; i < buildings.length; i++) {
    const bd = buildings[i];
    if (bd.x > r || bd.x + bd.w < l || bd.y > b || bd.y + bd.h < t) continue;

    const cx = bd.x + bd.w / 2, cy = bd.y + bd.h / 2;
    const ox = (cx - cam.x) * 0.045 * bd.floors;
    const oy = (cy - cam.y) * 0.045 * bd.floors;

    ctx.fillStyle = 'rgba(0,0,0,0.35)';
    ctx.fillRect(bd.x + 4, bd.y + 4, bd.w, bd.h);

    ctx.fillStyle = bd.wall;
    ctx.fillRect(bd.x, bd.y, bd.w, bd.h);

    ctx.fillStyle = bd.roof;
    ctx.fillRect(bd.x + ox, bd.y + oy, bd.w, bd.h);

    ctx.strokeStyle = 'rgba(0,0,0,0.28)';
    ctx.lineWidth = 1;
    ctx.strokeRect(bd.x + ox + 0.5, bd.y + oy + 0.5, bd.w - 1, bd.h - 1);
  }
}

function drawCar(car) {
  ctx.save();
  ctx.translate(car.x, car.y);
  ctx.rotate(car.angle);

  ctx.fillStyle = 'rgba(0,0,0,0.35)';
  ctx.fillRect(-CAR_W / 2 + 3, -CAR_H / 2 + 3, CAR_W, CAR_H);

  ctx.fillStyle = car.paint;
  ctx.fillRect(-CAR_W / 2, -CAR_H / 2, CAR_W, CAR_H);

  ctx.fillStyle = 'rgba(20,24,32,0.72)';
  ctx.fillRect(-6, -CAR_H / 2 + 3, 16, CAR_H - 6);

  ctx.fillStyle = 'rgba(255,255,255,0.14)';
  ctx.fillRect(-CAR_W / 2, -CAR_H / 2, CAR_W, 3);

  if (car.cop) {
    const on = Math.floor(performance.now() / 160) % 2 === 0;
    ctx.fillStyle = on ? '#ff3b3b' : '#3b6bff';
    ctx.fillRect(-4, -CAR_H / 2 - 2, 8, 4);
  }
  ctx.restore();
}

function drawPerson(x, y, angle, shirt, skin) {
  ctx.save();
  ctx.translate(x, y);
  ctx.rotate(angle);
  ctx.fillStyle = 'rgba(0,0,0,0.32)';
  ctx.beginPath(); ctx.arc(2, 2, PED_R, 0, Math.PI * 2); ctx.fill();
  ctx.fillStyle = shirt;
  ctx.beginPath(); ctx.arc(0, 0, PED_R, 0, Math.PI * 2); ctx.fill();
  ctx.fillStyle = skin;
  ctx.beginPath(); ctx.arc(2, 0, PED_R * 0.55, 0, Math.PI * 2); ctx.fill();
  ctx.restore();
}

function drawMarker() {
  if (!marker) return;
  const pr = 34 + Math.sin(marker.pulse) * 6;
  ctx.save();
  ctx.globalAlpha = 0.22;
  ctx.fillStyle = '#ffd34d';
  ctx.beginPath(); ctx.arc(marker.x, marker.y, pr + 14, 0, Math.PI * 2); ctx.fill();
  ctx.globalAlpha = 0.75;
  ctx.strokeStyle = '#ffd34d';
  ctx.lineWidth = 4;
  ctx.beginPath(); ctx.arc(marker.x, marker.y, pr, 0, Math.PI * 2); ctx.stroke();
  ctx.restore();
}

function drawWorld() {
  const sx = (rng() - 0.5) * cam.shake * 14;
  const sy = (rng() - 0.5) * cam.shake * 14;

  ctx.save();
  ctx.translate(W / 2 - cam.x + sx, H / 2 - cam.y + sy);

  const l = cam.x - W / 2 - 80, r = cam.x + W / 2 + 80;
  const t = cam.y - H / 2 - 80, b = cam.y + H / 2 + 80;

  drawGround(l, t, r, b);
  drawMarker();
  drawBuildings(l, t, r, b);

  for (const ped of peds) {
    if (ped.x < l || ped.x > r || ped.y < t || ped.y > b) continue;
    drawPerson(ped.x, ped.y, ped.angle, ped.shirt, ped.skin);
  }

  for (const car of cars) {
    if (car.x < l - 60 || car.x > r + 60 || car.y < t - 60 || car.y > b + 60) continue;
    drawCar(car);
  }

  if (player.alive && !player.car) {
    drawPerson(player.x, player.y, player.angle, '#e8ecf2', '#c99b6e');
    ctx.save();
    ctx.translate(player.x, player.y);
    ctx.rotate(player.angle);
    ctx.fillStyle = '#232733';
    ctx.fillRect(6, -2, 14, 4);
    ctx.restore();
  }

  for (const p of particles) {
    ctx.globalAlpha = clamp(p.life / p.max, 0, 1);
    ctx.fillStyle = p.color;
    ctx.fillRect(p.x - p.size / 2, p.y - p.size / 2, p.size, p.size);
  }
  ctx.globalAlpha = 1;

  ctx.fillStyle = '#ffe9a8';
  for (const b2 of bullets) ctx.fillRect(b2.x - 1.5, b2.y - 1.5, 3, 3);

  ctx.restore();
}

// ---------------------------------- HUD -----------------------------------

function drawBar(x, y, w, h, pct, fill, bg) {
  ctx.fillStyle = bg || 'rgba(0,0,0,0.45)';
  ctx.fillRect(x, y, w, h);
  ctx.fillStyle = fill;
  ctx.fillRect(x + 2, y + 2, (w - 4) * clamp(pct, 0, 1), h - 4);
}

function drawStars() {
  const x = W - 28, y = 26;
  for (let i = 0; i < 5; i++) {
    const lit = i < Math.round(wanted);
    ctx.save();
    ctx.translate(x - i * 28, y);
    ctx.beginPath();
    for (let k = 0; k < 10; k++) {
      const rr = k % 2 === 0 ? 11 : 4.6;
      const a = -Math.PI / 2 + k * Math.PI / 5;
      ctx.lineTo(Math.cos(a) * rr, Math.sin(a) * rr);
    }
    ctx.closePath();
    ctx.fillStyle = lit ? '#ffd34d' : 'rgba(255,255,255,0.12)';
    ctx.fill();
    ctx.restore();
  }
}

function drawMinimap() {
  const size = showBigMap ? Math.min(W, H) * 0.8 : 176;
  const mx = showBigMap ? (W - size) / 2 : W - size - 18;
  const my = showBigMap ? (H - size) / 2 : 52;
  const range = showBigMap ? WORLD : 1700;
  const ref = player.car || player;
  const scale = size / (showBigMap ? WORLD : range);

  ctx.save();
  ctx.beginPath();
  ctx.rect(mx, my, size, size);
  ctx.clip();

  ctx.fillStyle = 'rgba(12,14,19,0.88)';
  ctx.fillRect(mx, my, size, size);

  const originX = showBigMap ? 0 : ref.x - range / 2;
  const originY = showBigMap ? 0 : ref.y - range / 2;
  const toMapX = wx => mx + (wx - originX) * scale;
  const toMapY = wy => my + (wy - originY) * scale;

  ctx.strokeStyle = 'rgba(120,132,152,0.55)';
  ctx.lineWidth = showBigMap ? 2 : 4;
  ctx.beginPath();
  for (let i = 0; i < GRID; i++) {
    ctx.moveTo(toMapX(i * TILE), my); ctx.lineTo(toMapX(i * TILE), my + size);
    ctx.moveTo(mx, toMapY(i * TILE)); ctx.lineTo(mx + size, toMapY(i * TILE));
  }
  ctx.stroke();

  if (marker) {
    ctx.fillStyle = '#ffd34d';
    ctx.beginPath(); ctx.arc(toMapX(marker.x), toMapY(marker.y), 5, 0, Math.PI * 2); ctx.fill();
  }

  for (const car of cars) {
    if (!car.cop) continue;
    ctx.fillStyle = '#5b8cff';
    ctx.beginPath(); ctx.arc(toMapX(car.x), toMapY(car.y), 3.2, 0, Math.PI * 2); ctx.fill();
  }

  ctx.fillStyle = '#7fe08a';
  ctx.beginPath(); ctx.arc(toMapX(ref.x), toMapY(ref.y), 4.5, 0, Math.PI * 2); ctx.fill();

  ctx.restore();

  ctx.strokeStyle = 'rgba(255,255,255,0.18)';
  ctx.lineWidth = 2;
  ctx.strokeRect(mx, my, size, size);
}

function drawHUD() {
  ctx.font = '600 13px "Segoe UI", system-ui, sans-serif';
  ctx.textBaseline = 'top';

  drawBar(18, 18, 210, 16, player.hp / 100, player.hp > 30 ? '#7fe08a' : '#ff6b6b');
  ctx.fillStyle = '#0c0e13';
  ctx.fillText('HP', 26, 20);

  ctx.fillStyle = '#ffd34d';
  ctx.font = '700 22px "Segoe UI", system-ui, sans-serif';
  ctx.fillText('$' + player.cash.toLocaleString(), 18, 44);

  ctx.font = '600 12px "Segoe UI", system-ui, sans-serif';
  ctx.fillStyle = '#8b97a8';
  if (player.car) {
    const kph = Math.round(Math.abs(player.car.speed) * 0.42);
    ctx.fillText(kph + ' km/h', 18, 74);
  } else {
    ctx.fillText('on foot  ·  F near a car to drive', 18, 74);
  }

  if (marker) {
    const ref = player.car || player;
    const d = Math.round(dist(ref.x, ref.y, marker.x, marker.y));
    ctx.fillStyle = '#ffd34d';
    ctx.fillText('drop-off  ' + d + 'm', 18, 92);
  }

  drawStars();
  drawMinimap();

  if (player.hitFlash > 0) {
    ctx.fillStyle = `rgba(255,40,40,${player.hitFlash * 0.5})`;
    ctx.fillRect(0, 0, W, H);
  }

  if (!player.alive) {
    ctx.fillStyle = 'rgba(6,7,10,0.72)';
    ctx.fillRect(0, 0, W, H);
    ctx.textAlign = 'center';
    ctx.fillStyle = '#ff6b6b';
    ctx.font = '700 54px "Segoe UI", system-ui, sans-serif';
    ctx.fillText('WASTED', W / 2, H / 2 - 40);
    ctx.fillStyle = '#8b97a8';
    ctx.font = '600 14px "Segoe UI", system-ui, sans-serif';
    ctx.fillText('respawning...', W / 2, H / 2 + 26);
    ctx.textAlign = 'left';
  }
}

// --------------------------------- loop -----------------------------------

let last = performance.now();

function frame(now) {
  // Clamp low as well as high: a backwards clock must not drive physics.
  const dt = clamp((now - last) / 1000, 0, 0.05);
  last = now;

  ctx.setTransform(DPR, 0, 0, DPR, 0, 0);
  ctx.clearRect(0, 0, W, H);

  screenToWorld();
  update(dt);
  updateCamera(dt);

  drawWorld();
  drawHUD();

  requestAnimationFrame(frame);
}

// --------------------------------- boot -----------------------------------

generateCity();

// Put the player somewhere sane on a road.
(function placePlayer() {
  const p = randomRoadPoint(null, 0);
  player.x = p.x; player.y = p.y;
  cam.x = p.x; cam.y = p.y;
})();

spawnInitialTraffic();
newMarker();
resize();
requestAnimationFrame(frame);
