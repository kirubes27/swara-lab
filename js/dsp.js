// Low-level DSP: FFT, windows, YIN monophonic pitch detection.

const fftCache = new Map();
function fftTables(n) {
  let t = fftCache.get(n);
  if (t) return t;
  const levels = Math.log2(n) | 0;
  if (1 << levels !== n) throw new Error('FFT size must be a power of 2');
  const cos = new Float64Array(n / 2), sin = new Float64Array(n / 2);
  for (let i = 0; i < n / 2; i++) { cos[i] = Math.cos(2 * Math.PI * i / n); sin[i] = Math.sin(2 * Math.PI * i / n); }
  const rev = new Uint32Array(n);
  for (let i = 0; i < n; i++) {
    let x = i, r = 0;
    for (let j = 0; j < levels; j++) { r = (r << 1) | (x & 1); x >>>= 1; }
    rev[i] = r;
  }
  t = { cos, sin, rev };
  fftCache.set(n, t);
  return t;
}

// In-place complex FFT (re, im are Float64Array of length n).
export function fft(re, im) {
  const n = re.length;
  const { cos, sin, rev } = fftTables(n);
  for (let i = 0; i < n; i++) {
    const j = rev[i];
    if (j > i) {
      let t = re[i]; re[i] = re[j]; re[j] = t;
      t = im[i]; im[i] = im[j]; im[j] = t;
    }
  }
  for (let size = 2; size <= n; size <<= 1) {
    const half = size >> 1, step = n / size;
    for (let i = 0; i < n; i += size) {
      for (let j = i, k = 0; j < i + half; j++, k += step) {
        const l = j + half;
        const tre = re[l] * cos[k] + im[l] * sin[k];
        const tim = -re[l] * sin[k] + im[l] * cos[k];
        re[l] = re[j] - tre; im[l] = im[j] - tim;
        re[j] += tre; im[j] += tim;
      }
    }
  }
}

const hannCache = new Map();
export function hann(n) {
  let w = hannCache.get(n);
  if (!w) {
    w = new Float64Array(n);
    for (let i = 0; i < n; i++) w[i] = 0.5 - 0.5 * Math.cos(2 * Math.PI * i / (n - 1));
    hannCache.set(n, w);
  }
  return w;
}

export function rms(buf) {
  let s = 0;
  for (let i = 0; i < buf.length; i++) s += buf[i] * buf[i];
  return Math.sqrt(s / buf.length);
}

// YIN pitch detector (de Cheveigné & Kawahara 2002) for a single voice.
export class Yin {
  constructor(sampleRate, { minHz = 65, maxHz = 1200, threshold = 0.15 } = {}) {
    this.sr = sampleRate;
    this.tauMin = Math.max(2, Math.floor(sampleRate / maxHz));
    this.tauMax = Math.ceil(sampleRate / minHz);
    this.threshold = threshold;
    this.d = new Float64Array(this.tauMax + 2);
  }
  // Returns { hz, clarity } or null.
  detect(buf) {
    const { tauMin, tauMax, d } = this;
    const W = buf.length - tauMax - 1;
    if (W < 64) return null;
    // difference function
    for (let tau = 1; tau <= tauMax; tau++) {
      let s = 0;
      for (let i = 0; i < W; i++) {
        const x = buf[i] - buf[i + tau];
        s += x * x;
      }
      d[tau] = s;
    }
    // cumulative mean normalized difference
    d[0] = 1;
    let running = 0;
    for (let tau = 1; tau <= tauMax; tau++) {
      running += d[tau];
      d[tau] = running > 0 ? d[tau] * tau / running : 1;
    }
    let tau = -1;
    for (let t = tauMin; t < tauMax; t++) {
      if (d[t] < this.threshold) {
        while (t + 1 < tauMax && d[t + 1] < d[t]) t++;
        tau = t;
        break;
      }
    }
    if (tau < 0) {
      // fall back to global min if it is reasonably periodic
      let best = 1, bt = -1;
      for (let t = tauMin; t < tauMax; t++) if (d[t] < best) { best = d[t]; bt = t; }
      if (best > 0.3) return null;
      tau = bt;
    }
    // parabolic interpolation
    let betterTau = tau;
    if (tau > 1 && tau < tauMax) {
      const s0 = d[tau - 1], s1 = d[tau], s2 = d[tau + 1];
      const den = 2 * (2 * s1 - s2 - s0);
      if (den !== 0) betterTau = tau + (s2 - s0) / den;
    }
    const hz = this.sr / betterTau;
    return { hz, clarity: 1 - d[tau] };
  }
}

// Mono mixdown helper for an AudioBuffer-like object.
export function channelsOf(audioBuffer) {
  const L = audioBuffer.getChannelData(0);
  const R = audioBuffer.numberOfChannels > 1 ? audioBuffer.getChannelData(1) : L;
  return [L, R];
}
