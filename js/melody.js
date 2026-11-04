// Predominant-melody extraction from a full music mix (vocals + instruments).
// A compact take on the salience approach of Salamon & Gómez (2012, "Melodia"):
//   1. STFT, with optional centre-channel emphasis (vocals are usually panned centre)
//   2. spectral peaks -> harmonic-summation salience over 10-cent f0 bins
//   3. top-K salience peaks per frame -> Viterbi tracking with jump penalties + voicing state
//   4. octave-error repair, short-segment cleanup.
// Pure JS so it runs both in a Worker (files) and live (tab capture).

import { fft, hann } from './dsp.js';

export const F_REF = 55;          // Hz at bin 0
export const BIN_CENTS = 10;
export const N_BINS = 600;        // 55 Hz .. 1760 Hz
export const binToHz = (b) => F_REF * Math.pow(2, (b * BIN_CENTS) / 1200);
export const hzToBin = (hz) => (1200 * Math.log2(hz / F_REF)) / BIN_CENTS;

const K_PEAKS = 6;

export class SalienceAnalyzer {
  constructor(sr, opts = {}) {
    this.sr = sr;
    this.win = opts.win || 2 ** Math.round(Math.log2(0.046 * sr));
    this.nfft = this.win * 4;
    this.re = new Float64Array(this.nfft);
    this.im = new Float64Array(this.nfft);
    this.magM = new Float64Array(this.nfft / 2);
    this.minF0 = opts.minF0 || 70;
    this.maxF0 = opts.maxF0 || 1100;
    this.nh = opts.harmonics || 20;
    this.center = opts.center ?? 0.8;
    this.kMin = Math.max(2, Math.floor((this.minF0 * 0.9) / sr * this.nfft));
    this.kMax = Math.min(this.nfft / 2 - 2, Math.ceil(5000 / sr * this.nfft));
    this.binMin = Math.max(1, Math.floor(hzToBin(this.minF0)));
    this.binMax = Math.min(N_BINS - 2, Math.ceil(hzToBin(this.maxF0)));
    // perceptual-ish weighting: de-emphasise bass and the very top
    this.weight = new Float64Array(this.nfft / 2);
    for (let k = 0; k < this.nfft / 2; k++) {
      const f = (k * sr) / this.nfft;
      let w = f < 150 ? Math.pow(f / 150, 1.5) : 1;
      if (f > 3000) w *= Math.sqrt(3000 / f);
      this.weight[k] = w;
    }
    // lookup tables for harmonic weighting
    this.gTab = new Float64Array(201); // |delta| in 0.05-bin steps, 0..10 bins
    for (let i = 0; i <= 200; i++) { const d = (i * 0.05) / 10; const c = Math.cos((d * Math.PI) / 2); this.gTab[i] = c * c; }
    this.aTab = new Float64Array(this.nh + 1);
    for (let h = 1; h <= this.nh; h++) this.aTab[h] = Math.pow(0.8, h - 1);
    this.sal = new Float64Array(N_BINS);
    this.pf = new Float64Array(80); this.pa = new Float64Array(80);
  }

  // L, R: Float32Array sources; off: start index of the frame. Returns {p, e}.
  analyze(L, R, off = 0) {
    const { win, nfft, re, im, magM } = this;
    const w = hann(win);
    const stereo = R && R !== L;
    let energy = 0;
    for (let i = 0; i < win; i++) {
      const l = L[off + i] || 0, r = stereo ? (R[off + i] || 0) : l;
      const m = 0.5 * (l + r);
      energy += m * m;
      re[i] = m * w[i];
      im[i] = stereo ? 0.5 * (l - r) * w[i] : 0;
    }
    re.fill(0, win); im.fill(0, win);
    energy = Math.sqrt(energy / win);
    fft(re, im);
    // separate the two real spectra packed into one complex FFT
    let maxMag = 0;
    const c = this.center;
    for (let k = this.kMin - 1; k <= this.kMax + 1; k++) {
      const nk = (nfft - k) % nfft;
      const mr = 0.5 * (re[k] + re[nk]), mi = 0.5 * (im[k] - im[nk]);
      let mag = Math.hypot(mr, mi);
      if (stereo && c > 0) {
        const sr_ = 0.5 * (im[k] + im[nk]), si = -0.5 * (re[k] - re[nk]);
        mag = Math.max(0, mag - c * Math.hypot(sr_, si));
      }
      mag *= this.weight[k];
      magM[k] = mag;
      if (mag > maxMag) maxMag = mag;
    }
    const sal = this.sal; sal.fill(0);
    const out = { p: new Float32Array(0), e: energy };
    if (maxMag <= 1e-9) return out;
    // spectral peaks within 40 dB of the frame max
    const thr = maxMag * 0.01;
    const pf = this.pf, pa = this.pa;
    let np = 0;
    for (let k = this.kMin; k <= this.kMax; k++) {
      const m = magM[k];
      if (m > thr && m > magM[k - 1] && m >= magM[k + 1]) {
        const a = Math.log(magM[k - 1] + 1e-12), b = Math.log(m + 1e-12), g = Math.log(magM[k + 1] + 1e-12);
        const den = a - 2 * b + g;
        const p = den !== 0 ? (0.5 * (a - g)) / den : 0;
        const f = ((k + p) * this.sr) / nfft;
        const amp = Math.exp(b - 0.25 * (a - g) * p);
        if (np < pf.length) { pf[np] = f; pa[np] = amp; np++; }
        else { // replace the weakest
          let wi = 0; for (let j = 1; j < np; j++) if (pa[j] < pa[wi]) wi = j;
          if (amp > pa[wi]) { pf[wi] = f; pa[wi] = amp; }
        }
      }
    }
    // harmonic summation
    const minF = this.minF0 * 0.94, maxF = this.maxF0 * 1.06;
    for (let i = 0; i < np; i++) {
      const f = pf[i], a = pa[i];
      for (let h = 1; h <= this.nh; h++) {
        const f0 = f / h;
        if (f0 < minF) break;
        if (f0 > maxF) continue;
        const bc = hzToBin(f0);
        const b0 = Math.max(0, Math.ceil(bc - 10)), b1 = Math.min(N_BINS - 1, Math.floor(bc + 10));
        const ah = this.aTab[h] * a;
        for (let b = b0; b <= b1; b++) {
          const idx = Math.round(Math.abs(b - bc) * 20);
          sal[b] += this.gTab[idx] * ah;
        }
      }
    }
    // top-K salience peaks
    const cand = [];
    for (let b = this.binMin; b <= this.binMax; b++) {
      const s = sal[b];
      if (s > 0 && s > sal[b - 1] && s >= sal[b + 1]) {
        const den = sal[b - 1] - 2 * s + sal[b + 1];
        const p = den !== 0 ? (0.5 * (sal[b - 1] - sal[b + 1])) / den : 0;
        cand.push(b + p, s - 0.25 * (sal[b - 1] - sal[b + 1]) * p);
      }
    }
    // select top K by salience
    const idxs = [];
    for (let i = 0; i < cand.length; i += 2) idxs.push(i);
    idxs.sort((x, y) => cand[y + 1] - cand[x + 1]);
    const n = Math.min(K_PEAKS, idxs.length);
    const P = new Float32Array(n * 2);
    for (let j = 0; j < n; j++) { P[2 * j] = cand[idxs[j]]; P[2 * j + 1] = cand[idxs[j] + 1]; }
    out.p = P;
    return out;
  }
}

// frames: array of {p, e} or null, evenly spaced by `hop` seconds.
// Returns { hop, t0, cents: Float32Array (cents above 55 Hz, NaN = unvoiced), sal: Float32Array }
export function trackMelody(frames, { hop = 0.01, t0 = 0, voicing = 0.22, jump = 0.25, silence: silenceRatio = 0.03 } = {}) {
  const T = frames.length;
  const cents = new Float32Array(T).fill(NaN);
  const salOut = new Float32Array(T);
  if (!T) return { hop, t0, cents, sal: salOut };
  // normalisers
  const energies = [], tops = [];
  for (const f of frames) if (f) { energies.push(f.e); if (f.p.length) tops.push(f.p[1]); }
  energies.sort((a, b) => a - b); tops.sort((a, b) => a - b);
  const eRef = energies.length ? energies[Math.floor(energies.length * 0.9)] : 1;
  const silence = eRef * silenceRatio;
  const sRef = tops.length ? tops[Math.floor(tops.length * 0.8)] : 1;
  const logUnv = Math.log(voicing);
  const switchCost = 1.2;
  // Viterbi. State 0 = unvoiced; state j>0 = peak j-1.
  let prevScore = [0], prevBins = [NaN];
  const back = new Array(T);
  for (let t = 0; t < T; t++) {
    const f = frames[t];
    const voicedOK = f && f.e > silence && f.p.length;
    const nS = voicedOK ? 1 + f.p.length / 2 : 1;
    const score = new Float64Array(nS), bp = new Int16Array(nS), bins = new Float64Array(nS);
    bins[0] = NaN;
    for (let j = 0; j < nS; j++) {
      const emit = j === 0 ? logUnv : Math.log(f.p[2 * (j - 1) + 1] / sRef + 1e-9);
      if (j > 0) bins[j] = f.p[2 * (j - 1)];
      let best = -Infinity, bi = 0;
      for (let i = 0; i < prevScore.length; i++) {
        let tr;
        if (i === 0 && j === 0) tr = 0;
        else if (i === 0 || j === 0) tr = -switchCost;
        else {
          const d = Math.abs(bins[j] - prevBins[i]) / 10; // semitones
          tr = -jump * Math.max(0, d - 0.5);
        }
        const s = prevScore[i] + tr;
        if (s > best) { best = s; bi = i; }
      }
      score[j] = best + emit; bp[j] = bi;
    }
    back[t] = bp;
    prevScore = score; prevBins = bins;
  }
  // backtrack
  let j = 0, best = -Infinity;
  for (let i = 0; i < prevScore.length; i++) if (prevScore[i] > best) { best = prevScore[i]; j = i; }
  for (let t = T - 1; t >= 0; t--) {
    const f = frames[t];
    if (j > 0 && f) { cents[t] = f.p[2 * (j - 1)] * BIN_CENTS; salOut[t] = f.p[2 * (j - 1) + 1] / sRef; }
    j = back[t][j] ?? 0;
  }
  cleanContour(cents, hop);
  return { hop, t0, cents, sal: salOut };
}

function cleanContour(c, hop) {
  const T = c.length;
  // 1. octave repair against a 1-second running median of voiced frames
  const half = Math.round(0.5 / hop);
  const buf = [];
  const fixed = Float32Array.from(c);
  for (let t = 0; t < T; t++) {
    if (isNaN(c[t])) continue;
    buf.length = 0;
    for (let k = Math.max(0, t - half); k <= Math.min(T - 1, t + half); k += 2) if (!isNaN(c[k])) buf.push(c[k]);
    if (buf.length < 10) continue;
    buf.sort((a, b) => a - b);
    const med = buf[buf.length >> 1];
    const d = med - c[t];
    if (Math.abs(d) > 850) fixed[t] = c[t] + 1200 * Math.round(d / 1200);
  }
  // 2. 3-point median smoothing
  for (let t = 1; t < T - 1; t++) {
    const a = fixed[t - 1], b = fixed[t], d = fixed[t + 1];
    if (isNaN(a) || isNaN(b) || isNaN(d)) { c[t] = b; continue; }
    c[t] = Math.max(Math.min(a, b), Math.min(Math.max(a, b), d));
  }
  c[0] = fixed[0]; c[T - 1] = fixed[T - 1];
  // 3. drop voiced islands shorter than 70 ms, fill gaps shorter than 40 ms
  const minRun = Math.round(0.07 / hop), maxGap = Math.round(0.04 / hop);
  let t = 0;
  while (t < T) {
    if (isNaN(c[t])) { t++; continue; }
    let e = t; while (e < T && !isNaN(c[e])) e++;
    if (e - t < minRun) for (let k = t; k < e; k++) c[k] = NaN;
    t = e;
  }
  t = 0;
  while (t < T) {
    if (!isNaN(c[t])) { t++; continue; }
    let e = t; while (e < T && isNaN(c[e])) e++;
    if (t > 0 && e < T && e - t <= maxGap) {
      const a = c[t - 1], b = c[e];
      if (Math.abs(a - b) < 150) for (let k = t; k < e; k++) c[k] = a + ((b - a) * (k - t + 1)) / (e - t + 1);
    }
    t = e;
  }
}

// Offline analysis of a (preferably ~22 kHz) stereo signal.
export function analyzeSignal(L, R, sr, { hop = 0.01, onProgress, center = 0.8, silence = 0.03 } = {}) {
  const an = new SalienceAnalyzer(sr, { center });
  const hopS = Math.round(hop * sr);
  const frames = [];
  const n = Math.max(0, Math.floor((L.length - an.win) / hopS) + 1);
  for (let i = 0; i < n; i++) {
    frames.push(an.analyze(L, R, i * hopS));
    if (onProgress && i % 500 === 0) onProgress(i / n);
  }
  // frame i covers [i*hop, i*hop+win]; its centre is the time stamp
  const t0 = an.win / 2 / sr;
  // label frames with the true hop (hopS samples), not the nominal one, or long songs drift
  return trackMelody(frames, { hop: hopS / sr, t0, silence });
}

// Melody object helpers ----------------------------------------------------
// A melody is { hop, t0, cents (above 55 Hz) } ; these turn it into a lookup.
export function melodyAt(mel, t) {
  const x = (t - mel.t0) / mel.hop;
  const i = Math.floor(x);
  if (i < 0 || i + 1 >= mel.cents.length) return NaN;
  const a = mel.cents[i], b = mel.cents[i + 1];
  if (isNaN(a)) return isNaN(b) || x - i < 0.5 ? NaN : b;
  if (isNaN(b)) return x - i < 0.5 ? a : NaN;
  return a + (b - a) * (x - i);
}

export const melodyDuration = (mel) => mel.t0 + mel.cents.length * mel.hop;

// Estimate tonic (Sa) of a vocal melody. Returns { saHz, candidates:[{saHz,score}] }
export function estimateTonic(mel) {
  const H = new Float64Array(120), E = new Float64Array(120);
  const c = mel.cents, T = c.length;
  const pcOf = (x) => { // x = cents above 55 Hz (A1). pitch class relative to C
    const fromC = x + 900; // A is 900 cents above C
    return ((Math.round(fromC / 10) % 120) + 120) % 120;
  };
  const voiced = [];
  for (let t = 1; t < T - 1; t++) {
    if (isNaN(c[t])) continue;
    voiced.push(c[t]);
    const slope = Math.abs((c[t + 1] || c[t]) - (c[t - 1] || c[t])) / 2;
    H[pcOf(c[t])] += slope < 20 ? 1 : 0.15;
  }
  // phrase endings
  let t = 0;
  const endN = Math.round(0.25 / mel.hop);
  while (t < T) {
    if (isNaN(c[t])) { t++; continue; }
    let e = t; while (e < T && !isNaN(c[e])) e++;
    if ((e - t) * mel.hop > 0.3) for (let k = Math.max(t, e - endN); k < e; k++) E[pcOf(c[k])] += 3;
    t = e;
  }
  const smooth = (A) => {
    const out = new Float64Array(120);
    for (let i = 0; i < 120; i++) for (let d = -6; d <= 6; d++) out[i] += A[(i + d + 120) % 120] * Math.exp(-(d * d) / 8);
    return out;
  };
  const Hs = smooth(H), Es = smooth(E);
  const scores = [];
  for (let i = 0; i < 120; i++) {
    const s = Hs[i] + 0.5 * Hs[(i + 70) % 120] + 0.6 * Es[i] + 0.2 * Es[(i + 70) % 120];
    scores.push({ pc10: i, score: s });
  }
  scores.sort((a, b) => b.score - a.score);
  if (!voiced.length) return { saHz: 0, candidates: [] };
  voiced.sort((a, b) => a - b);
  const med = voiced[voiced.length >> 1];
  const pick = [];
  for (const s of scores) {
    if (pick.some((p) => Math.min(Math.abs(p.pc10 - s.pc10), 120 - Math.abs(p.pc10 - s.pc10)) < 7)) continue;
    pick.push(s);
    if (pick.length >= 3) break;
  }
  const toHz = (pc10) => {
    const pcCentsAboveA1 = pc10 * 10 - 900; // relative to A1 (55 Hz)
    // choose octave so that the median sits roughly in the middle (madhya) octave
    const k = Math.floor((med - pcCentsAboveA1 + 200) / 1200);
    return F_REF * Math.pow(2, (pcCentsAboveA1 + 1200 * k) / 1200);
  };
  const candidates = pick.map((p) => ({ saHz: toHz(p.pc10), score: p.score / pick[0].score }));
  return { saHz: candidates[0].saHz, candidates };
}

// Split a melody into phrases (lines) using gaps in voicing.
export function findPhrases(mel, { minGap = 0.35, maxLen = 14 } = {}) {
  const c = mel.cents, T = c.length, hop = mel.hop;
  const segs = [];
  let t = 0;
  while (t < T) {
    if (isNaN(c[t])) { t++; continue; }
    let e = t; while (e < T && !isNaN(c[e])) e++;
    segs.push([t, e]);
    t = e;
  }
  const gapN = Math.round(minGap / hop);
  const phrases = [];
  for (const s of segs) {
    const last = phrases[phrases.length - 1];
    if (last && s[0] - last[1] < gapN) last[1] = s[1];
    else phrases.push([s[0], s[1]]);
  }
  // merge very short phrases into a neighbour, split very long ones at the largest gap
  const out = [];
  for (const p of phrases) {
    const dur = (p[1] - p[0]) * hop;
    const last = out[out.length - 1];
    if (dur < 0.8 && last && (p[0] - last[1]) * hop < 1.2) { last[1] = p[1]; continue; }
    out.push(p);
  }
  const final = [];
  const split = (p) => {
    if ((p[1] - p[0]) * hop <= maxLen) { final.push(p); return; }
    let bestGap = 0, at = -1, run = 0;
    const lo = p[0] + Math.round(2 / hop), hi = p[1] - Math.round(2 / hop);
    for (let k = lo; k < hi; k++) {
      if (isNaN(c[k])) { run++; if (run > bestGap) { bestGap = run; at = k; } } else run = 0;
    }
    if (at < 0) at = Math.round((p[0] + p[1]) / 2);
    split([p[0], at - Math.floor(bestGap / 2)]);
    split([at, p[1]]);
  };
  out.forEach(split);
  return final
    .filter((p) => (p[1] - p[0]) * hop >= 0.4)
    .map((p, i) => ({ i, start: mel.t0 + p[0] * hop, end: mel.t0 + p[1] * hop }));
}
