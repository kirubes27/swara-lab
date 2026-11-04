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
    this.gate = 0.008;     // rms gate
    this.hist = [];
  }
  start() {
    if (this.running) return Promise.resolve();
    if (!this.starting) this.starting = this._start().finally(() => { this.starting = null; });
    return this.starting; // concurrent callers share one getUserMedia request
  }
  async _start() {
    const c = audioCtx();
    this.stream = await navigator.mediaDevices.getUserMedia({
      audio: { echoCancellation: false, noiseSuppression: false, autoGainControl: false, channelCount: 1 },
    });
    this.src = c.createMediaStreamSource(this.stream);
    this.analyser = c.createAnalyser();
    this.analyser.fftSize = 2048;
    this.analyser.smoothingTimeConstant = 0;
    this.src.connect(this.analyser);
    this.buf = new Float32Array(this.analyser.fftSize);
    this.yin = new Yin(c.sampleRate, { minHz: 65, maxHz: 1100, threshold: 0.15 });
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
    let hz = 0, clarity = 0;
    if (level > this.gate) {
      const r = this.yin.detect(this.buf);
      if (r && r.clarity > 0.6) { hz = r.hz; clarity = r.clarity; }
    }
    // median-of-3 to remove isolated octave blips
    this.hist.push(hz); if (this.hist.length > 3) this.hist.shift();
    let out = hz;
    if (this.hist.length === 3 && this.hist.every((x) => x > 0)) {
      const s = [...this.hist].sort((a, b) => a - b); out = s[1];
    } else if (hz > 0 && this.hist.filter((x) => x > 0).length === 1 && this.hist.length === 3) {
      out = 0; // isolated voiced frame
    }
    const now = performance.now();
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
