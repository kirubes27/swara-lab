// Audio engine: shared AudioContext, microphone pitch tracking, take recording.
import { Yin, rms } from './dsp.js';

let ctx = null;
export function audioCtx() {
  if (!ctx) {
    ctx = new (window.AudioContext || window.webkitAudioContext)({ latencyHint: 'interactive' });
    master = ctx.createGain();
    master.connect(ctx.destination);
  }
  if (ctx.state === 'suspended') ctx.resume();
  return ctx;
}
let master = null;
export function masterOut() { audioCtx(); return master; }
export function setMasterMuted(m) { if (master) master.gain.setTargetAtTime(m ? 0 : 1, ctx.currentTime, 0.02); }

// ---------------------------------------------------------------------------
// Microphone + pitch tracking
export class Mic {
  constructor() {
    this.stream = null; this.analyser = null; this.yin = null;
    this.listeners = new Set();
    this.running = false;
    this.last = null;      // latest {t, hz, clarity, level}
    this.level = 0;
    this.gate = 0.008;     // rms gate set by the sensitivity slider
    this.floor = 0;        // slowly adapting background level
    this.echoCancel = true; // cancels the song when it plays through speakers
    this.lowHz = 70; this.highHz = 1100;
    this.acc = null;       // last accepted pitch {hz, t}
    this.pend = null;      // a big jump waiting for confirmation {hz, n}
  }
  // Limit detection to a plausible singing range (widened around the singer's measured range).
  setRange(lowHz, highHz, hpfHz = 70) {
    this.lowHz = Math.max(55, lowHz); this.highHz = Math.min(1500, highHz); this.hpfHz = hpfHz;
    if (this.hpf) for (const f of this.hpf) f.frequency.value = hpfHz;
    if (this.yin) this.yin = new Yin(audioCtx().sampleRate, { minHz: this.lowHz * 0.94, maxHz: this.highHz * 1.06, threshold: 0.15 });
  }
  async setEchoCancel(on) {
    if (on === this.echoCancel) return;
    this.echoCancel = on;
    if (this.running) { this.stop(); await this.start(); }
  }
  start() {
    if (this.running) return Promise.resolve();
    if (!this.starting) this.starting = this._start().finally(() => { this.starting = null; });
    return this.starting; // concurrent callers share one getUserMedia request
  }
  async _start() {
    const c = audioCtx();
    this.stream = await navigator.mediaDevices.getUserMedia({
      audio: { echoCancellation: this.echoCancel, noiseSuppression: false, autoGainControl: false, channelCount: 1 },
    });
    this.src = c.createMediaStreamSource(this.stream);
    this.analyser = c.createAnalyser();
    this.analyser.fftSize = 2048;
    this.analyser.smoothingTimeConstant = 0;
    // 4th-order high-pass below the voice: removes bass, rumble and handling noise that would
    // otherwise be mistaken for very low notes (tested: 26 → 638 of 718 frames right with bass bleed)
    this.hpf = [0, 1].map(() => { const f = c.createBiquadFilter(); f.type = 'highpass'; f.frequency.value = this.hpfHz || 70; f.Q.value = 0.707; return f; });
    this.src.connect(this.hpf[0]); this.hpf[0].connect(this.hpf[1]); this.hpf[1].connect(this.analyser);
    this.buf = new Float32Array(this.analyser.fftSize);
    this.yin = new Yin(c.sampleRate, { minHz: this.lowHz * 0.94, maxHz: this.highHz * 1.06, threshold: 0.15 });
    this.acc = null; this.pend = null; this.floor = 0;
    this.running = true;
    const loop = () => {
      if (!this.running) return;
      this.tick();
      this.raf = requestAnimationFrame(loop);
    };
    this.raf = requestAnimationFrame(loop);
  }
  stop() {
    this.running = false;
    cancelAnimationFrame(this.raf);
    if (this.stream) this.stream.getTracks().forEach((t) => t.stop());
    this.stream = null;
    this.last = null;
  }
  setSensitivity(v) { // 0..1 -> gate
    this.gate = 0.03 * Math.pow(10, -2 * v); // v=0 -> 0.03, v=1 -> 0.0003
  }
  tick() {
    this.analyser.getFloatTimeDomainData(this.buf);
    const level = rms(this.buf);
    this.level = level;
    const now = performance.now();
    // background level: drops at once to quiet moments, rises only slowly (~10 s), so a long
    // sustained note is never mistaken for background noise
    // Holding a note: for 150 ms after a pitch was accepted, a quieter or less clearly periodic frame
    // near that pitch still counts (breathy singing, or the voice partly removed by echo cancellation).
    const holding = this.acc && now - this.acc.t < 150;
    const need = holding ? Math.max(this.gate * 0.7, this.floor * 1.4) : Math.max(this.gate, this.floor * 2);
    let hz = 0, clarity = 0;
    if (level > need) {
      const r = this.yin.detect(this.buf, holding ? { hz: this.acc.hz, maxD: 0.4 } : null);
      if (r && r.clarity > (holding ? 0.58 : 0.65) && r.hz >= this.lowHz * 0.94 && r.hz <= this.highHz * 1.06) { hz = r.hz; clarity = r.clarity; }
    }
    // background level: drops at once to quiet moments, rises only slowly (~10 s) and never while a
    // note is being sung, so a long held note is never mistaken for background noise
    if (!this.floor || level < this.floor) this.floor = level;
    else if (!hz) this.floor += (level - this.floor) * 0.0015;
    // Jump confirmation against the recent context (median of what was sung in the last 1.5 s):
    // a leap of more than ~3.5 semitones is only believed once it repeats (2 frames; ~6 frames for
    // an octave or more). Real leaps survive with a tiny delay; blips from consonants, drum hits or
    // the song bleeding into the mic don't, and a stray blip can't drag the reference with it.
    this.ctxp = (this.ctxp || []).filter((p) => now - p.t < 1500);
    let out = 0;
    if (hz > 0) {
      let ref = null;
      if (this.ctxp.length >= 5) { const v = this.ctxp.map((p) => p.hz).sort((a, b) => a - b); ref = v[v.length >> 1]; }
      else if (this.acc && now - this.acc.t < 160) ref = this.acc.hz;
      let jump = ref ? Math.abs(1200 * Math.log2(hz / ref)) : 0;
      if (ref && Math.abs(jump - 1200) < 60 && !(this.pend && Math.abs(1200 * Math.log2(hz / this.pend.hz)) < 80)) {
        hz = hz > ref ? hz / 2 : hz * 2; jump = Math.abs(1200 * Math.log2(hz / ref)); // a one-off octave slip of the detector
      }
      if (!ref || jump < 350) { out = hz; this.pend = null; }
      else if (this.pend && Math.abs(1200 * Math.log2(hz / this.pend.hz)) < 80) {
        if (++this.pend.n >= (jump > 900 ? 6 : 2)) { out = hz; this.pend = null; this.ctxp = []; } // a confirmed leap starts a new context
      } else this.pend = { hz, n: 1 };
      if (out) { this.acc = { hz: out, t: now }; this.ctxp.push({ hz: out, t: now }); }
    } else this.pend = null;
    this.last = { t: now, hz: out, clarity, level };
    for (const fn of this.listeners) fn(this.last);
  }
  on(fn) { this.listeners.add(fn); return () => this.listeners.delete(fn); }
  // Analysis delay: half the analysis window + input latency estimate.
  latencySec() {
    const c = audioCtx();
    return 1024 / c.sampleRate + (c.baseLatency || 0.01) + 0.01;
  }
}

export const mic = new Mic();

// Add a pitch frame {t, c} (c = cents, NaN = unvoiced) to a take. A dropout of up to 0.12 s between
// two frames of the same note (within 80 cents) is filled in, so a sustained note isn't shown
// or scored as broken by a few lost frames.
export function pushFrame(frames, f) {
  if (!isNaN(f.c) && frames.length) {
    let k = frames.length - 1;
    while (k >= 0 && isNaN(frames[k].c) && f.t - frames[k].t < 0.13) k--;
    if (k >= 0 && k < frames.length - 1 && !isNaN(frames[k].c) && f.t - frames[k].t <= 0.13 && Math.abs(f.c - frames[k].c) < 80) {
      const a = frames[k];
      for (let j = k + 1; j < frames.length; j++) frames[j].c = a.c + ((f.c - a.c) * (frames[j].t - a.t)) / (f.t - a.t);
    }
  }
  frames.push(f);
}

// Record the microphone (for listening back to a take).
export class TakeRecorder {
  constructor(stream) { this.stream = stream; this.chunks = []; this.rec = null; }
  start() {
    if (!this.stream || typeof MediaRecorder === 'undefined') return false;
    this.chunks = [];
    try { this.rec = new MediaRecorder(this.stream); } catch { return false; }
    this.rec.ondataavailable = (e) => e.data.size && this.chunks.push(e.data);
    this.rec.start(250);
    return true;
  }
  stop() {
    return new Promise((resolve) => {
      if (!this.rec || this.rec.state === 'inactive') return resolve(null);
      this.rec.onstop = () => resolve(new Blob(this.chunks, { type: this.rec.mimeType || 'audio/webm' }));
      this.rec.stop();
    });
  }
}

// ---------------------------------------------------------------------------
// Encode an AudioBuffer as 16-bit PCM WAV (used for pitch-shifted playback copies).
export function audioBufferToWav(buf) {
  const nCh = Math.min(2, buf.numberOfChannels), sr = buf.sampleRate, n = buf.length;
  const bytes = 44 + n * nCh * 2;
  const ab = new ArrayBuffer(bytes), dv = new DataView(ab);
  const w = (o, s) => { for (let i = 0; i < s.length; i++) dv.setUint8(o + i, s.charCodeAt(i)); };
  w(0, 'RIFF'); dv.setUint32(4, bytes - 8, true); w(8, 'WAVE'); w(12, 'fmt ');
  dv.setUint32(16, 16, true); dv.setUint16(20, 1, true); dv.setUint16(22, nCh, true);
  dv.setUint32(24, sr, true); dv.setUint32(28, sr * nCh * 2, true); dv.setUint16(32, nCh * 2, true);
  dv.setUint16(34, 16, true); w(36, 'data'); dv.setUint32(40, n * nCh * 2, true);
  const chans = []; for (let c = 0; c < nCh; c++) chans.push(buf.getChannelData(c));
  let o = 44;
  for (let i = 0; i < n; i++) for (let c = 0; c < nCh; c++) {
    const s = Math.max(-1, Math.min(1, chans[c][i]));
    dv.setInt16(o, s < 0 ? s * 0x8000 : s * 0x7fff, true); o += 2;
  }
  return new Blob([ab], { type: 'audio/wav' });
}

// Resample an AudioBuffer with a playback-rate factor (pitch AND speed change).
export async function renderRate(buf, factor, targetSr = buf.sampleRate) {
  const len = Math.ceil((buf.length / factor) * (targetSr / buf.sampleRate));
  const off = new OfflineAudioContext(Math.min(2, buf.numberOfChannels), len, targetSr);
  const s = off.createBufferSource();
  s.buffer = buf; s.playbackRate.value = factor;
  s.connect(off.destination); s.start();
  return off.startRendering();
}

// AudioWorklet that taps stereo samples and posts them in ~1024-frame chunks.
const TAP_SRC = `
class Tap extends AudioWorkletProcessor {
  constructor(){ super(); this.L=new Float32Array(1024); this.R=new Float32Array(1024); this.n=0; }
  process(inputs){
    const inp = inputs[0];
    if (inp && inp.length){
      const l = inp[0], r = inp[1] || inp[0];
      for (let i=0;i<l.length;i++){
        this.L[this.n]=l[i]; this.R[this.n]=r[i]; this.n++;
        if (this.n===1024){ this.port.postMessage({L:this.L,R:this.R,t:currentTime}); this.L=new Float32Array(1024); this.R=new Float32Array(1024); this.n=0; }
      }
    }
    return true;
  }
}
registerProcessor('swara-tap', Tap);`;
let tapLoaded = null;
export async function createTap(c) {
  if (!tapLoaded) {
    const url = URL.createObjectURL(new Blob([TAP_SRC], { type: 'application/javascript' }));
    tapLoaded = c.audioWorklet.addModule(url);
  }
  await tapLoaded;
  const node = new AudioWorkletNode(c, 'swara-tap', { numberOfInputs: 1, numberOfOutputs: 1, outputChannelCount: [1], channelCount: 2, channelCountMode: 'explicit' });
  // keep it in the render graph (silently) so the browser always pulls it
  const sink = c.createGain(); sink.gain.value = 0;
  node.connect(sink); sink.connect(c.destination);
  node._sink = sink;
  return node;
}
