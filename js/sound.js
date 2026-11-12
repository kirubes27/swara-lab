// Sound sources: tanpura drone, guide-tone synth (harmonium-like), follower tone, clicks.
import { audioCtx, masterOut } from './audio.js';
import { settings } from './store.js';

// ---------------------------------------------------------------------------
// Tanpura: additive synthesis with a moving "jawari" formant that sweeps down the
// harmonic series after each pluck (the shimmering buzz of the bridge).
export function renderTanpuraCycle(sr, saHz, first = 'P') {
  const firstRatio = { P: 0.75, M: 2 / 3, N: 15 / 16, S: 1 }[first] || 0.75;
  const strings = [
    { f: saHz * firstRatio, at: 0.0, pan: -0.3, amp: 0.9 },
    { f: saHz * 1.0007, at: 1.2, pan: 0.15, amp: 0.8 },
    { f: saHz * 0.9995, at: 2.4, pan: -0.1, amp: 0.8 },
    { f: saHz * 0.5, at: 3.6, pan: 0.3, amp: 1.0 },
  ];
  const cycle = 5.2, N = Math.round(cycle * sr);
  const L = new Float32Array(N), R = new Float32Array(N);
  const noteLen = 7.5, nN = Math.round(noteLen * sr), B = 64;
  const tmp = new Float32Array(nN);
  let seed = 7;
  const rnd = () => { seed = (seed * 16807) % 2147483647; return seed / 2147483647; };
  for (const s of strings) {
    tmp.fill(0);
    const H = Math.min(44, Math.floor(7000 / s.f));
    for (let h = 1; h <= H; h++) {
      const fh = h * s.f * (1 + 0.00003 * h * h) * (1 + (rnd() - 0.5) * 0.0004);
      const w = (2 * Math.PI * fh) / sr;
      const cw = Math.cos(w), sw = Math.sin(w);
      let cr = Math.cos(rnd() * 6.283), ci = Math.sin(rnd() * 6.283);
      const tau = 4.2 / (1 + 0.035 * h);
      const base = 1 / Math.pow(h, 0.85);
      for (let b = 0; b < nN; b += B) {
        const t = b / sr;
        const c = 1.5 + 20 * Math.exp(-t / 1.3);
        const wd = 2.5 + 2 * (1 - Math.exp(-t / 1.3));
        const boost = 1 + 3.2 * Math.exp(-((h - c) * (h - c)) / (2 * wd * wd));
        const env = Math.exp(-t / tau) * (1 - Math.exp(-t / 0.004)) * (1 + 0.08 * Math.sin(2 * Math.PI * 0.7 * t + h));
        const a = base * boost * env;
        const end = Math.min(nN, b + B);
        for (let i = b; i < end; i++) {
          const nr = cr * cw - ci * sw; ci = cr * sw + ci * cw; cr = nr;
          tmp[i] += a * ci;
        }
        const mag = Math.hypot(cr, ci); cr /= mag; ci /= mag;
      }
    }
    const off = Math.round(s.at * sr);
    const gl = s.amp * Math.sqrt(0.5 * (1 - s.pan)), gr = s.amp * Math.sqrt(0.5 * (1 + s.pan));
    for (let i = 0; i < nN; i++) {
      const j = (off + i) % N; // wrap tails into the start so the loop is seamless
      L[j] += tmp[i] * gl; R[j] += tmp[i] * gr;
    }
  }
  let peak = 0;
  for (let i = 0; i < N; i++) peak = Math.max(peak, Math.abs(L[i]), Math.abs(R[i]));
  const g = 0.85 / (peak || 1);
  for (let i = 0; i < N; i++) { L[i] *= g; R[i] *= g; }
  return { L, R };
}

// Soft "pad" drone (root + fifth + octave), for songs outside Indian music.
// Every partial completes a whole number of cycles in the loop, so it loops seamlessly.
export function renderPadCycle(sr, saHz) {
  const L = 8, N = Math.round(L * sr);
  const out = [new Float32Array(N), new Float32Array(N)];
  const voices = [[saHz / 2, 0.8], [saHz, 0.6], [saHz * 1.5, 0.35], [saHz * 2, 0.22]];
  const harm = [1, 0.28, 0.1, 0.05];
  let k = 0;
  for (const [f0, a0] of voices) for (const det of [-0.12, 0.12]) {
    k++;
    for (let h = 1; h <= harm.length; h++) {
      const f = Math.round(f0 * h * (1 + det / 100) * L) / L;
      if (f > 5000) continue;
      const w = (2 * Math.PI * f) / sr, ph = k * 1.7 + h;
      const lfoRate = (1 + ((k + h) % 3)) / L; // 1-3 slow swells per loop
      const a = a0 * harm[h - 1];
      const ch = out[k % 2];
      for (let i = 0; i < N; i++) {
        const lfo = 0.75 + 0.25 * Math.sin(2 * Math.PI * lfoRate * (i / sr) + k);
        ch[i] += a * lfo * Math.sin(w * i + ph);
      }
    }
  }
  let peak = 0;
  for (const ch of out) for (let i = 0; i < N; i++) peak = Math.max(peak, Math.abs(ch[i]));
  for (const ch of out) for (let i = 0; i < N; i++) ch[i] *= 0.7 / (peak || 1);
  return { L: out[0], R: out[1] };
}

export class Tanpura {
  constructor() { this.src = null; this.gain = null; this.on = false; this.vol = 0.35; this.key = ''; this.cache = new Map(); }
  // kindFn() -> 'tanpura' | 'pad' (set by the app from settings)
  kind() { return this.kindFn ? this.kindFn() : 'tanpura'; }
  buffer(saHz, first) {
    const c = audioCtx();
    const kind = this.kind();
    const key = kind + saHz.toFixed(2) + first + c.sampleRate;
    if (this.cache.has(key)) return this.cache.get(key);
    const { L, R } = kind === 'pad' ? renderPadCycle(c.sampleRate, saHz) : renderTanpuraCycle(c.sampleRate, saHz, first);
    const b = c.createBuffer(2, L.length, c.sampleRate);
    b.copyToChannel(L, 0); b.copyToChannel(R, 1);
    if (this.cache.size > 6) this.cache.clear();
    this.cache.set(key, b);
    return b;
  }
  start(saHz, first = 'P') {
    const c = audioCtx();
    const key = this.kind() + saHz.toFixed(2) + first;
    if (this.on && key === this.key) return;
    const old = this.src, oldG = this.gain;
    const g = c.createGain(); g.gain.value = 0;
    const s = c.createBufferSource();
    s.buffer = this.buffer(saHz, first); s.loop = true;
    s.connect(g); g.connect(masterOut());
    s.start();
    g.gain.setTargetAtTime(this.vol, c.currentTime, 0.15);
    if (old) { oldG.gain.setTargetAtTime(0, c.currentTime, 0.2); old.stop(c.currentTime + 1.5); }
    this.src = s; this.gain = g; this.on = true; this.key = key;
  }
  stop() {
    if (!this.src) return;
    const c = audioCtx();
    this.gain.gain.setTargetAtTime(0, c.currentTime, 0.2);
    this.src.stop(c.currentTime + 1.2);
    this.src = null; this.on = false; this.key = '';
  }
  setVolume(v) { this.vol = v; if (this.gain) this.gain.gain.setTargetAtTime(v, audioCtx().currentTime, 0.05); }
  duck(on, level = 0) { if (this.gain) this.gain.gain.setTargetAtTime(on ? this.vol * level : this.vol, audioCtx().currentTime, 0.05); }
}
export const tanpura = new Tanpura();

// ---------------------------------------------------------------------------
// Guide tone: harmonium-ish reed timbre.
let wave = null;
// Soft guide tone: a strong fundamental with a gentle octave and twelfth (like a flute or a soft
// organ stop). The low harmonics keep it audible on laptop speakers, which barely play low notes.
let softW = null;
function softWave(c) {
  if (softW) return softW;
  const amps = [0, 1, 0.55, 0.28, 0.12, 0.05, 0.02], re = new Float32Array(amps.length), im = Float32Array.from(amps);
  softW = c.createPeriodicWave(re, im);
  return softW;
}
export function guideWave(c, timbre) { return timbre === 'reed' ? reedWave(c) : timbre === 'sine' ? null : softWave(c); }
function reedWave(c) {
  if (wave) return wave;
  const n = 24, re = new Float32Array(n), im = new Float32Array(n);
  const amps = [0, 1, 0.75, 0.55, 0.42, 0.36, 0.25, 0.2, 0.16, 0.12, 0.1, 0.08, 0.06, 0.05, 0.04, 0.035, 0.03, 0.025, 0.02, 0.018, 0.015, 0.012, 0.01, 0.008];
  for (let i = 1; i < n; i++) im[i] = amps[i];
  wave = c.createPeriodicWave(re, im);
  return wave;
}

export class GuideSynth {
  constructor() { this.vol = 0.5; this.timbre = 'reed'; this.active = new Set(); }
  _voice(c) {
    const o = c.createOscillator();
    const w = guideWave(c, this.timbre);
    if (w) o.setPeriodicWave(w); else o.type = 'sine';
    const lp = c.createBiquadFilter(); lp.type = 'lowpass'; lp.frequency.value = this.timbre === 'reed' ? 2600 : 1800; lp.Q.value = 0.5;
    const g = c.createGain(); g.gain.value = 0;
    o.connect(lp); lp.connect(g); g.connect(masterOut());
    return { o, g };
  }
  // groups: [{start, end, curve: Float32Array (Hz), rate (points per sec), amp}] in ctx time
  playCurves(groups) {
    const c = audioCtx();
    for (const gr of groups) {
      const { o, g } = this._voice(c);
      const dur = gr.end - gr.start;
      if (dur <= 0.02) continue;
      o.frequency.setValueAtTime(gr.curve[0], gr.start);
      if (gr.curve.length > 1) o.frequency.setValueCurveAtTime(gr.curve, gr.start + 0.001, dur - 0.002);
      const peak = this.vol * (gr.amp ?? 1) * 0.5;
      g.gain.setValueAtTime(0, gr.start);
      g.gain.linearRampToValueAtTime(peak, gr.start + Math.min(0.04, dur / 3));
      g.gain.setValueAtTime(peak, Math.max(gr.start + 0.04, gr.end - 0.07));
      g.gain.linearRampToValueAtTime(0, gr.end);
      o.start(gr.start); o.stop(gr.end + 0.05);
      const v = { o, g };
      this.active.add(v);
      o.onended = () => { this.active.delete(v); g.disconnect(); };
    }
  }
  stopAll() {
    const c = audioCtx();
    for (const v of this.active) { try { v.g.gain.cancelScheduledValues(c.currentTime); v.g.gain.setTargetAtTime(0, c.currentTime, 0.02); v.o.stop(c.currentTime + 0.1); } catch {} }
    this.active.clear();
  }
  click(when, accent = false) {
    const c = audioCtx();
    const o = c.createOscillator(), g = c.createGain();
    o.frequency.value = accent ? 1760 : 1320;
    g.gain.setValueAtTime(0, when);
    g.gain.linearRampToValueAtTime(0.12 * this.vol, when + 0.002);
    g.gain.exponentialRampToValueAtTime(0.0001, when + 0.05);
    o.connect(g); g.connect(masterOut());
    o.start(when); o.stop(when + 0.06);
  }
}
export const guide = new GuideSynth();

// A continuously running tone that follows a target pitch (song melody guide).
export class Follower {
  constructor() { this.v = null; this.vol = 0.35; }
  set(hz) {
    const c = audioCtx();
    if (!this.v) {
      const o = c.createOscillator(); const w = guideWave(c, this.timbre || settings.guideTimbre); if (w) o.setPeriodicWave(w); else o.type = 'sine';
      const lp = c.createBiquadFilter(); lp.type = 'lowpass'; lp.frequency.value = (this.timbre || settings.guideTimbre) === 'reed' ? 2200 : 1700;
      const g = c.createGain(); g.gain.value = 0;
      o.connect(lp); lp.connect(g); g.connect(masterOut()); o.start();
      this.v = { o, g };
    }
    const t = c.currentTime;
    if (hz > 0) {
      this.v.o.frequency.setTargetAtTime(hz, t, 0.006);
      this.v.g.gain.setTargetAtTime(this.vol * 0.6, t, 0.03);
    } else this.v.g.gain.setTargetAtTime(0, t, 0.04);
  }
  stop() {
    if (!this.v) return;
    const c = audioCtx();
    this.v.g.gain.setTargetAtTime(0, c.currentTime, 0.03);
    this.v.o.stop(c.currentTime + 0.3);
    this.v = null;
  }
}
