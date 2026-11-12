// Sound for the Theory pages: a soft keys voice, plucked strings (Karplus–Strong),
// synthesized drums and bass, and a lookahead clock that schedules on the audio timeline.
// Nothing here creates the AudioContext until a sound is actually requested.
import { audioCtx, masterOut } from './audio.js';

const hz = (m) => 440 * Math.pow(2, (m - 69) / 12);
const clamp = (x, a, b) => Math.min(b, Math.max(a, x));

let bus = null, body = null;
const live = new Set(); // scheduled or sounding voices
const pending = []; // visual callbacks keyed to audio time, sorted by time
let visRaf = 0;

// The shared context, plus this module's output chain (a gentle limiter into the app's master).
export function ctx() {
  const c = audioCtx();
  if (!bus) {
    bus = c.createGain();
    bus.gain.value = 0.85;
    const lim = c.createDynamicsCompressor();
    lim.threshold.value = -10; lim.knee.value = 6; lim.ratio.value = 6; lim.attack.value = 0.002; lim.release.value = 0.2;
    bus.connect(lim); lim.connect(masterOut());
    // A light "guitar body" colour for plucked strings.
    const lowBody = c.createBiquadFilter(); lowBody.type = 'peaking'; lowBody.frequency.value = 115; lowBody.Q.value = 1.1; lowBody.gain.value = 3;
    const air = c.createBiquadFilter(); air.type = 'highshelf'; air.frequency.value = 4500; air.gain.value = -4;
    lowBody.connect(air); air.connect(bus);
    body = lowBody;
  }
  return c;
}
export const out = () => (ctx(), bus);
export const now = () => ctx().currentTime;

// What the listener hears right now, on the audio clock (output latency removed).
export function heardTime() {
  const c = audioCtx();
  return c.currentTime - (c.outputLatency || c.baseLatency || 0);
}

function track(node, gain, end, tag) {
  const v = { node, gain, end, tag };
  live.add(v);
  node.addEventListener('ended', () => { live.delete(v); try { gain.disconnect(); } catch { /* already gone */ } });
  return v;
}

// Fade out and stop voices (all, or those with a tag) and drop their pending visuals.
export function silence(tag = null, fade = 0.04) {
  for (let i = pending.length - 1; i >= 0; i--) if (!tag || pending[i].tag === tag) pending.splice(i, 1);
  if (!bus) return;
  const t = audioCtx().currentTime;
  for (const v of [...live]) {
    if (tag && v.tag !== tag) continue;
    try {
      v.gain.gain.cancelScheduledValues(t);
      v.gain.gain.setTargetAtTime(0, t, fade / 3);
      v.node.stop(t + fade + 0.05);
    } catch { /* already stopped */ }
    live.delete(v);
  }
}

export function stopAll() {
  silence(null);
  pending.length = 0;
  cancelAnimationFrame(visRaf); visRaf = 0;
  ringing.clear();
}

// Run fn when the audio reaches time t (so lights follow what you hear, not the scheduler).
export function at(t, fn, tag = null) {
  let i = pending.length;
  while (i > 0 && pending[i - 1].t > t) i--;
  pending.splice(i, 0, { t, fn, tag });
  if (!visRaf) visRaf = requestAnimationFrame(flush);
}
function flush() {
  visRaf = 0;
  const t = heardTime();
  while (pending.length && pending[0].t <= t) {
    const p = pending.shift();
    try { p.fn(); } catch (e) { console.error(e); }
  }
  if (pending.length) visRaf = requestAnimationFrame(flush);
}

// ---------------------------------------------------------------------------
// Keys: additive synthesis with a two-stage decay (a quick drop, then a long tail),
// slightly stretched partials and a soft hammer. Rendered once per note and cached.
const keyCache = new Map();
function keyBuffer(c, midi) {
  const k = midi + '@' + c.sampleRate;
  if (keyCache.has(k)) return keyCache.get(k);
  const sr = c.sampleRate, f0 = hz(midi);
  const dur = clamp(3.4 - (midi - 48) * 0.035, 1.4, 3.8);
  const n = Math.round(dur * sr);
  const x = new Float32Array(n);
  const stretch = 0.00022 * Math.pow(2, (midi - 60) / 18);
  const H = clamp(Math.floor(6500 / f0), 3, 14);
  const dark = clamp((midi - 48) / 36, 0, 1);
  for (let h = 1; h <= H; h++) {
    const f = f0 * h * Math.sqrt(1 + stretch * h * h);
    if (f > sr * 0.42) break;
    const amp = Math.pow(h, -1.3) * Math.pow(0.82 - 0.2 * dark, h - 1);
    const tFast = 0.22 / (1 + 0.18 * h), tSlow = (dur * 0.4) / (1 + 0.25 * (h - 1));
    const kF = Math.exp(-1 / (tFast * sr)), kS = Math.exp(-1 / (tSlow * sr));
    for (const det of h <= 3 ? [-0.0004, 0.0004] : [0]) { // two strings per note, slightly apart
      const w = (2 * Math.PI * f * (1 + det)) / sr, cw = Math.cos(w), sw = Math.sin(w);
      let re = Math.cos(h * 1.7), im = Math.sin(h * 1.7), eF = 0.5, eS = 0.5;
      const a = det ? amp * 0.5 : amp;
      for (let i = 0; i < n; i++) {
        const nr = re * cw - im * sw; im = re * sw + im * cw; re = nr;
        x[i] += a * (eF + eS) * im;
        eF *= kF; eS *= kS;
        if ((i & 4095) === 0) { const m = Math.hypot(re, im); re /= m; im /= m; }
      }
    }
  }
  // hammer: a few milliseconds of soft noise
  let seed = midi * 7919 + 13, lp = 0;
  const hn = Math.round(0.012 * sr);
  for (let i = 0; i < hn; i++) {
    seed = (seed * 16807) % 2147483647;
    lp += 0.25 * ((seed / 1073741823.5 - 1) - lp);
    x[i] += lp * 0.06 * (1 - i / hn);
  }
  const att = Math.round(0.004 * sr), rel = Math.round(0.08 * sr);
  for (let i = 0; i < att; i++) x[i] *= i / att;
  for (let i = 0; i < rel; i++) x[n - 1 - i] *= i / rel;
  normalize(x, 0.5);
  const b = c.createBuffer(1, n, sr);
  b.copyToChannel(x, 0);
  keyCache.set(k, b);
  return b;
}

function normalize(x, peak) {
  let m = 0;
  for (let i = 0; i < x.length; i++) m = Math.max(m, Math.abs(x[i]));
  const g = peak / (m || 1);
  for (let i = 0; i < x.length; i++) x[i] *= g;
}

// Pre-render notes, one per idle moment, so later presses never wait for synthesis.
// Call it only after a user gesture (it needs the audio context's sample rate).
export function prewarm(midis, kind = 'key') {
  const c = ctx(), list = [...new Set(midis)].filter((m) => m != null);
  const idle = window.requestIdleCallback || ((f) => setTimeout(f, 40));
  const next = () => {
    const m = list.shift();
    if (m == null) return;
    (kind === 'pluck' ? pluckBuffer : keyBuffer)(c, m);
    idle(next);
  };
  idle(next);
}

export function key(midi, when, { vel = 0.8, dur = null, tag = null, dest = null } = {}) {
  const c = ctx();
  const src = c.createBufferSource();
  src.buffer = keyBuffer(c, midi);
  const g = c.createGain();
  g.gain.setValueAtTime(0.6 * vel, when);
  let end = when + src.buffer.duration;
  if (dur != null) {
    const rel = when + Math.max(0.06, dur);
    g.gain.setTargetAtTime(0, rel, 0.07);
    end = Math.min(end, rel + 0.45);
  }
  src.connect(g); g.connect(dest || bus);
  src.start(when); src.stop(end);
  return track(src, g, end, tag);
}

export function chord(midis, when, opts = {}) {
  const spread = opts.spread || 0;
  midis.forEach((m, i) => key(m, when + i * spread, { ...opts, vel: (opts.vel ?? 0.7) * (midis.length > 3 ? 0.8 : 0.9) }));
}

// ---------------------------------------------------------------------------
// Plucked string: Karplus–Strong with a fractional-delay allpass for exact tuning,
// a filtered noise burst plucked near the bridge, and pitch-dependent sustain.
const pluckCache = new Map();
function pluckBuffer(c, midi) {
  const k = midi + '@' + c.sampleRate;
  if (pluckCache.has(k)) return pluckCache.get(k);
  const sr = c.sampleRate, f = hz(midi);
  const t60 = clamp(5.5 * Math.pow(2, -(midi - 40) / 22), 1.1, 5.5);
  const dur = Math.min(t60 * 0.75, 4);
  const n = Math.round(dur * sr);
  const P = sr / f, S = 0.5;
  let L = Math.floor(P - S), frac = P - S - L;
  if (frac < 0.2) { L -= 1; frac += 1; }
  const C = (1 - frac) / (1 + frac);
  const rho = Math.min(0.9997, Math.pow(10, -3 / (t60 * f)));
  // excitation
  const line = new Float32Array(L);
  let seed = midi * 9301 + 49297, lp = 0, mean = 0;
  const soft = clamp(0.55 - (midi - 40) * 0.006, 0.3, 0.55);
  for (let i = 0; i < L; i++) {
    seed = (seed * 16807) % 2147483647;
    lp += soft * ((seed / 1073741823.5 - 1) - lp);
    line[i] = lp; mean += lp;
  }
  mean /= L;
  for (let i = 0; i < L; i++) line[i] -= mean;
  const pick = Math.max(1, Math.round(L * 0.13));
  for (let i = L - 1; i >= pick; i--) line[i] -= line[i - pick];
  // the loop
  const x = new Float32Array(n);
  let idx = 0, prev = 0, apIn = 0, apOut = 0;
  for (let i = 0; i < n; i++) {
    const y = line[idx];
    x[i] = y;
    const lpv = rho * ((1 - S) * y + S * prev);
    prev = y;
    const ap = C * lpv + apIn - C * apOut;
    apIn = lpv; apOut = ap;
    line[idx] = ap;
    if (++idx === L) idx = 0;
  }
  // remove DC, soften the very start and fade the tail
  let dc = 0;
  for (let i = 0; i < n; i++) { dc += 0.0015 * (x[i] - dc); x[i] -= dc; }
  const att = Math.round(0.0015 * sr), rel = Math.round(0.25 * sr);
  for (let i = 0; i < att; i++) x[i] *= i / att;
  for (let i = 0; i < rel; i++) x[n - 1 - i] *= i / rel;
  normalize(x, 0.5);
  const b = c.createBuffer(1, n, sr);
  b.copyToChannel(x, 0);
  pluckCache.set(k, b);
  return b;
}

const ringing = new Map(); // string number -> voice, so a new note damps the old one

export function pluck(midi, when, { vel = 0.8, string = null, tag = null, dest = null } = {}) {
  const c = ctx();
  const src = c.createBufferSource();
  src.buffer = pluckBuffer(c, midi);
  const g = c.createGain();
  g.gain.setValueAtTime(0.75 * vel, when);
  src.connect(g); g.connect(dest || body);
  const end = when + src.buffer.duration;
  src.start(when); src.stop(end);
  const v = track(src, g, end, tag);
  if (string != null) {
    const old = ringing.get(string);
    if (old && old.end > when && live.has(old)) old.gain.gain.setTargetAtTime(0, when, 0.012);
    ringing.set(string, v);
  }
  return v;
}

// Strum per-string notes (low E first; null = not played). Up strokes go high to low.
export function strum(notes, when, { up = false, vel = 0.8, spread = 0.011, maxStrings = 6, tag = null } = {}) {
  let order = notes.map((m, s) => [m, s]).filter(([m]) => m != null);
  if (up) order = order.reverse().slice(0, maxStrings);
  order.forEach(([m, s], i) => pluck(m, when + i * spread, { vel: vel * (1 - i * 0.04), string: s, tag }));
}

// ---------------------------------------------------------------------------
// Drums, synthesized.
let noise = null;
function noiseBuffer(c) {
  if (!noise || noise.sampleRate !== c.sampleRate) {
    noise = c.createBuffer(1, c.sampleRate, c.sampleRate);
    const d = noise.getChannelData(0);
    let s = 22222;
    for (let i = 0; i < d.length; i++) { s = (s * 16807) % 2147483647; d[i] = s / 1073741823.5 - 1; }
  }
  return noise;
}

function burst(when, { vel, hp = 0, bp = 0, q = 0.8, lp = 0, decay, attack = 0.001, tag, dest }) {
  const c = ctx();
  const s = c.createBufferSource();
  s.buffer = noiseBuffer(c);
  s.loop = true;
  let node = s;
  for (const [type, f] of [['highpass', hp], ['bandpass', bp], ['lowpass', lp]]) {
    if (!f) continue;
    const flt = c.createBiquadFilter();
    flt.type = type; flt.frequency.value = f;
    if (type === 'bandpass') flt.Q.value = q;
    node.connect(flt); node = flt;
  }
  const g = c.createGain();
  g.gain.setValueAtTime(0.0001, when);
  g.gain.exponentialRampToValueAtTime(Math.max(0.0002, vel), when + attack);
  g.gain.exponentialRampToValueAtTime(0.0001, when + attack + decay);
  node.connect(g); g.connect(dest || bus);
  const end = when + attack + decay + 0.02;
  s.start(when, Math.random() * 0.7); s.stop(end);
  track(s, g, end, tag);
}

function tone(when, { type = 'sine', f0, f1 = f0, glide = 0.1, vel, decay, tag, dest }) {
  const c = ctx();
  const o = c.createOscillator(), g = c.createGain();
  o.type = type;
  o.frequency.setValueAtTime(f0, when);
  if (f1 !== f0) o.frequency.exponentialRampToValueAtTime(f1, when + glide);
  g.gain.setValueAtTime(0.0001, when);
  g.gain.exponentialRampToValueAtTime(Math.max(0.0002, vel), when + 0.003);
  g.gain.exponentialRampToValueAtTime(0.0001, when + decay);
  o.connect(g); g.connect(dest || bus);
  const end = when + decay + 0.02;
  o.start(when); o.stop(end);
  track(o, g, end, tag);
}

export function kick(when, { vel = 1, pitch = 1, tag = null, dest = null } = {}) {
  tone(when, { f0: 150 * pitch, f1: 45 * pitch, glide: 0.11, vel: 0.95 * vel, decay: 0.42, tag, dest });
  burst(when, { vel: 0.1 * vel, hp: 2500, decay: 0.01, tag, dest });
}
export function snare(when, { vel = 1, tag = null, dest = null } = {}) {
  tone(when, { type: 'triangle', f0: 200, f1: 160, glide: 0.06, vel: 0.35 * vel, decay: 0.1, tag, dest });
  burst(when, { vel: 0.42 * vel, hp: 1100, lp: 9000, decay: 0.17, tag, dest });
}
export function clap(when, { vel = 1, tag = null, dest = null } = {}) {
  for (const d of [0, 0.011, 0.022]) burst(when + d, { vel: 0.3 * vel, bp: 1300, q: 1.2, decay: d === 0.022 ? 0.16 : 0.012, tag, dest });
}
export function hat(when, { vel = 1, open = false, tag = null, dest = null } = {}) {
  burst(when, { vel: 0.17 * vel, hp: 7500, decay: open ? 0.3 : 0.04, tag, dest });
}
export function shaker(when, { vel = 1, tag = null, dest = null } = {}) {
  burst(when, { vel: 0.08 * vel, bp: 9000, q: 1.5, attack: 0.012, decay: 0.05, tag, dest });
}
export function crash(when, { vel = 1, tag = null, dest = null } = {}) {
  burst(when, { vel: 0.18 * vel, hp: 4200, decay: 1.7, attack: 0.002, tag, dest });
}
// A noise sweep that rises over `dur` seconds (the "whoosh" before a drop).
export function riser(when, dur, { vel = 1, tag = null, dest = null } = {}) {
  const c = ctx();
  const s = c.createBufferSource();
  s.buffer = noiseBuffer(c); s.loop = true;
  const bp = c.createBiquadFilter(); bp.type = 'bandpass'; bp.Q.value = 2.5;
  bp.frequency.setValueAtTime(400, when);
  bp.frequency.exponentialRampToValueAtTime(7000, when + dur);
  const g = c.createGain();
  g.gain.setValueAtTime(0.0001, when);
  g.gain.exponentialRampToValueAtTime(0.16 * vel, when + dur);
  g.gain.setTargetAtTime(0.0001, when + dur, 0.03);
  s.connect(bp); bp.connect(g); g.connect(dest || bus);
  const end = when + dur + 0.2;
  s.start(when); s.stop(end);
  track(s, g, end, tag);
}

// Metronome: 2 = downbeat, 1 = beat, 0 = subdivision.
export function click(when, level = 1, { tag = null, dest = null } = {}) {
  const f = [1250, 1700, 2350][level];
  tone(when, { type: 'triangle', f0: f, vel: [0.12, 0.32, 0.5][level], decay: level ? 0.06 : 0.035, tag, dest });
}

// ---------------------------------------------------------------------------
// Bass, pad and drone (for the DJ loops and the singing ladder).
export function bass(midi, when, dur, { vel = 0.8, tag = null, dest = null } = {}) {
  const c = ctx();
  const f = hz(midi);
  const saw = c.createOscillator(); saw.type = 'sawtooth'; saw.frequency.value = f;
  const sub = c.createOscillator(); sub.type = 'sine'; sub.frequency.value = f;
  const lpf = c.createBiquadFilter(); lpf.type = 'lowpass'; lpf.Q.value = 4;
  lpf.frequency.setValueAtTime(1100, when);
  lpf.frequency.exponentialRampToValueAtTime(220, when + Math.max(0.08, dur * 0.7));
  const mix = c.createGain(); mix.gain.value = 0.5;
  const g = c.createGain();
  g.gain.setValueAtTime(0.0001, when);
  g.gain.exponentialRampToValueAtTime(0.5 * vel, when + 0.008);
  g.gain.setTargetAtTime(0.0001, when + dur, 0.03);
  saw.connect(lpf); lpf.connect(mix); sub.connect(mix); mix.connect(g); g.connect(dest || bus);
  const end = when + dur + 0.2;
  for (const o of [saw, sub]) { o.start(when); o.stop(end); }
  track(saw, g, end, tag); track(sub, g, end, tag);
}

export function pad(midis, when, dur, { vel = 0.6, tag = null, dest = null } = {}) {
  const c = ctx();
  const lpf = c.createBiquadFilter(); lpf.type = 'lowpass'; lpf.frequency.value = 1500; lpf.Q.value = 0.5;
  const g = c.createGain();
  g.gain.setValueAtTime(0.0001, when);
  g.gain.linearRampToValueAtTime(0.09 * vel, when + Math.min(0.6, dur * 0.4));
  g.gain.setTargetAtTime(0.0001, when + dur, 0.25);
  lpf.connect(g); g.connect(dest || bus);
  const end = when + dur + 1.2;
  for (const m of midis) for (const det of [-7, 7]) {
    const o = c.createOscillator();
    o.type = 'sawtooth'; o.frequency.value = hz(m); o.detune.value = det;
    o.connect(lpf); o.start(when); o.stop(end);
    track(o, g, end, tag);
  }
}

// A soft held drone on a note (root, octave below and fifth). Returns { stop() }.
export function drone(midi, { tag = null } = {}) {
  const c = ctx(), t = c.currentTime;
  const lpf = c.createBiquadFilter(); lpf.type = 'lowpass'; lpf.frequency.value = 900;
  const g = c.createGain();
  g.gain.setValueAtTime(0, t);
  g.gain.linearRampToValueAtTime(0.16, t + 0.8);
  lpf.connect(g); g.connect(bus);
  const oscs = [[midi - 12, 0.55, -3], [midi - 12, 0.55, 3], [midi, 0.32, 0], [midi + 7, 0.2, 2]].map(([m, a, det]) => {
    const o = c.createOscillator(), og = c.createGain();
    o.type = 'triangle'; o.frequency.value = hz(m); o.detune.value = det;
    og.gain.value = a;
    o.connect(og); og.connect(lpf); o.start(t);
    track(o, g, Infinity, tag);
    return o;
  });
  return {
    stop() {
      const s = audioCtx().currentTime;
      g.gain.cancelScheduledValues(s);
      g.gain.setTargetAtTime(0, s, 0.15);
      for (const o of oscs) try { o.stop(s + 1); } catch { /* stopped */ }
    },
  };
}

// ---------------------------------------------------------------------------
// A lookahead clock: a timer wakes it every 25 ms, and it schedules every step that
// falls in the next ~120 ms at an exact audio-clock time. Changing bpm takes effect
// from the next unscheduled step.
export class Clock {
  constructor({ bpm = 100, div = 1, onStep }) {
    this.bpm = bpm; this.div = div; this.onStep = onStep;
    this.running = false; this.timer = 0; this.step = 0; this.next = 0;
  }
  get stepDur() { return 60 / this.bpm / this.div; }
  start(delay = 0.08) {
    const c = ctx();
    this.stop();
    this.running = true; this.step = 0; this.next = this.t0 = c.currentTime + delay;
    this.timer = setInterval(() => this.pump(), 25);
    this.pump();
  }
  pump() {
    if (!this.running) return;
    const c = audioCtx();
    const horizon = c.currentTime + (document.hidden ? 1.2 : 0.12);
    if (this.next < c.currentTime - 0.25) { // the tab stalled: skip ahead rather than burst
      const missed = Math.ceil((c.currentTime - this.next) / this.stepDur);
      this.step += missed; this.next += missed * this.stepDur;
    }
    while (this.next < horizon) {
      this.onStep(this.step, this.next, this.stepDur);
      this.step++;
      this.next += this.stepDur;
    }
  }
  stop() { this.running = false; clearInterval(this.timer); this.timer = 0; }
}
