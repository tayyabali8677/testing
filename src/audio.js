// Procedural audio. No sample files, everything synthesised on the fly.
//
// One-shots (gunfire, impacts) are short noise or oscillator bursts through a
// shared limiter. The engine and siren are continuous voices whose parameters
// are driven from gameplay each frame, which is why they can follow revs and
// doppler without any crossfading between clips.

const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);

export class Audio {
  constructor() {
    this.ctx = null;
    this.ready = false;
    this.muted = false;
    this.master = null;
    this.engineOn = false;
  }

  /** Must be called from a user gesture or the context stays suspended. */
  init() {
    if (this.ctx) {
      if (this.ctx.state === "suspended") this.ctx.resume();
      return;
    }
    const AC = window.AudioContext || window.webkitAudioContext;
    if (!AC) return;

    const ctx = new AC();
    this.ctx = ctx;

    this.master = ctx.createGain();
    this.master.gain.value = 0.55;

    // A gentle limiter stops a firefight from clipping.
    this.limiter = ctx.createDynamicsCompressor();
    this.limiter.threshold.value = -12;
    this.limiter.knee.value = 12;
    this.limiter.ratio.value = 8;
    this.limiter.attack.value = 0.003;
    this.limiter.release.value = 0.18;

    this.master.connect(this.limiter).connect(ctx.destination);

    this.noiseBuffer = this._makeNoise(2.0);
    this._initEngine();
    this._initSiren();
    this.ready = true;
  }

  _makeNoise(seconds) {
    const ctx = this.ctx;
    const len = Math.floor(ctx.sampleRate * seconds);
    const buf = ctx.createBuffer(1, len, ctx.sampleRate);
    const data = buf.getChannelData(0);
    for (let i = 0; i < len; i++) data[i] = Math.random() * 2 - 1;
    return buf;
  }

  setMuted(muted) {
    this.muted = muted;
    if (this.master) {
      this.master.gain.setTargetAtTime(muted ? 0 : 0.55,
        this.ctx.currentTime, 0.05);
    }
  }

  // ---- one-shots -------------------------------------------------------

  _burst(duration, freqStart, freqEnd, type, gain, filterHz) {
    if (!this.ready || this.muted) return;
    const ctx = this.ctx;
    const t = ctx.currentTime;

    const osc = ctx.createOscillator();
    osc.type = type;
    osc.frequency.setValueAtTime(freqStart, t);
    osc.frequency.exponentialRampToValueAtTime(Math.max(20, freqEnd), t + duration);

    const g = ctx.createGain();
    g.gain.setValueAtTime(gain, t);
    g.gain.exponentialRampToValueAtTime(0.0001, t + duration);

    let node = osc;
    if (filterHz) {
      const f = ctx.createBiquadFilter();
      f.type = "lowpass";
      f.frequency.value = filterHz;
      osc.connect(f);
      node = f;
    }
    node.connect(g).connect(this.master);
    osc.start(t);
    osc.stop(t + duration + 0.02);
  }

  _noise(duration, gain, filterHz, q = 1, sweepTo = null) {
    if (!this.ready || this.muted) return;
    const ctx = this.ctx;
    const t = ctx.currentTime;

    const src = ctx.createBufferSource();
    src.buffer = this.noiseBuffer;
    src.loop = true;

    const f = ctx.createBiquadFilter();
    f.type = "bandpass";
    f.frequency.setValueAtTime(filterHz, t);
    f.Q.value = q;
    if (sweepTo) {
      f.frequency.exponentialRampToValueAtTime(Math.max(30, sweepTo), t + duration);
    }

    const g = ctx.createGain();
    g.gain.setValueAtTime(gain, t);
    g.gain.exponentialRampToValueAtTime(0.0001, t + duration);

    src.connect(f).connect(g).connect(this.master);
    src.start(t);
    src.stop(t + duration + 0.02);
  }

  gunshot(weapon = "wpn_pistol") {
    const profiles = {
      wpn_pistol: [0.13, 0.30, 900, 4],
      wpn_smg: [0.09, 0.24, 1200, 3],
      wpn_rifle: [0.17, 0.34, 700, 3],
      wpn_shotgun: [0.28, 0.42, 420, 2],
    };
    const [dur, gain, hz, q] = profiles[weapon] || profiles.wpn_pistol;
    this._noise(dur, gain, hz, q, hz * 0.25);
    this._burst(dur * 0.7, 180, 40, "square", gain * 0.5, 600);
  }

  impact(strength = 1) {
    this._noise(0.22 * strength, clamp(0.12 * strength, 0.02, 0.35),
                220, 1.2, 70);
    this._burst(0.18, 130, 45, "sawtooth", 0.14 * strength, 400);
  }

  explosion() {
    this._noise(0.9, 0.42, 320, 0.7, 45);
    this._burst(0.7, 90, 30, "sawtooth", 0.3, 300);
  }

  pickup() {
    this._burst(0.09, 660, 880, "sine", 0.14);
    setTimeout(() => this._burst(0.14, 990, 1320, "sine", 0.12), 80);
  }

  reward() {
    const notes = [523, 659, 784, 1046];
    notes.forEach((f, i) => {
      setTimeout(() => this._burst(0.16, f, f, "triangle", 0.11), i * 75);
    });
  }

  star() { this._burst(0.2, 1200, 1500, "triangle", 0.1); }
  hurt() { this._noise(0.16, 0.18, 400, 1.5, 120); }
  skid() { this._noise(0.3, 0.08, 1800, 2.5, 900); }

  footstep(running) {
    this._noise(0.06, running ? 0.05 : 0.03, running ? 260 : 200, 1.4, 90);
  }

  // ---- engine ----------------------------------------------------------

  _initEngine() {
    const ctx = this.ctx;

    this.engineGain = ctx.createGain();
    this.engineGain.gain.value = 0;

    this.engineFilter = ctx.createBiquadFilter();
    this.engineFilter.type = "lowpass";
    this.engineFilter.frequency.value = 700;
    this.engineFilter.Q.value = 3;

    // Two detuned saws an octave apart give a passable combustion rasp.
    this.engineOscA = ctx.createOscillator();
    this.engineOscA.type = "sawtooth";
    this.engineOscA.frequency.value = 60;

    this.engineOscB = ctx.createOscillator();
    this.engineOscB.type = "square";
    this.engineOscB.frequency.value = 30;

    const mixB = ctx.createGain();
    mixB.gain.value = 0.35;

    this.engineOscA.connect(this.engineFilter);
    this.engineOscB.connect(mixB).connect(this.engineFilter);
    this.engineFilter.connect(this.engineGain).connect(this.master);

    this.engineOscA.start();
    this.engineOscB.start();
  }

  /** @param rpm 0..1, @param load 0..1 */
  engine(active, rpm = 0, load = 0) {
    if (!this.ready) return;
    const t = this.ctx.currentTime;
    const target = active && !this.muted ? 0.09 + load * 0.07 : 0;
    this.engineGain.gain.setTargetAtTime(target, t, 0.08);
    if (!active) return;

    const base = 48 + rpm * 150;
    this.engineOscA.frequency.setTargetAtTime(base, t, 0.05);
    this.engineOscB.frequency.setTargetAtTime(base * 0.5, t, 0.05);
    this.engineFilter.frequency.setTargetAtTime(420 + rpm * 2200, t, 0.06);
  }

  // ---- siren -----------------------------------------------------------

  _initSiren() {
    const ctx = this.ctx;
    this.sirenGain = ctx.createGain();
    this.sirenGain.gain.value = 0;

    this.sirenOsc = ctx.createOscillator();
    this.sirenOsc.type = "sine";
    this.sirenOsc.frequency.value = 700;

    const shaper = ctx.createBiquadFilter();
    shaper.type = "bandpass";
    shaper.frequency.value = 900;
    shaper.Q.value = 1.2;

    this.sirenOsc.connect(shaper).connect(this.sirenGain).connect(this.master);
    this.sirenOsc.start();
    this._sirenPhase = 0;
  }

  /** @param proximity 0..1, how close the nearest active unit is */
  siren(active, proximity = 0, dt = 0.016) {
    if (!this.ready) return;
    const t = this.ctx.currentTime;
    const target = active && !this.muted ? 0.05 * proximity : 0;
    this.sirenGain.gain.setTargetAtTime(target, t, 0.15);
    if (!active) return;

    this._sirenPhase += dt;
    // Classic two-tone wail, about 1.4 seconds per sweep.
    const wail = Math.sin(this._sirenPhase * 4.4);
    this.sirenOsc.frequency.setTargetAtTime(700 + wail * 260, t, 0.03);
  }
}
