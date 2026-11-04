// Vocal separation worker: Spleeter 2-stem "vocals" network (Deezer, MIT) running in
// onnxruntime-web, followed by melody tracking on the isolated voice.
//   in:  { L, R } Float32Array at 44.1 kHz, modelUrl
//   out: { vocals: Float32Array (mono, 44.1 kHz), mel: { hop, t0, cents } }
import * as ort from 'https://cdn.jsdelivr.net/npm/onnxruntime-web@1.20.1/dist/ort.wasm.min.mjs';
import { fft, hann } from './dsp.js';
import { analyzeSignal } from './melody.js';

ort.env.wasm.wasmPaths = 'https://cdn.jsdelivr.net/npm/onnxruntime-web@1.20.1/dist/';
ort.env.wasm.numThreads = Math.min(4, (self.crossOriginIsolated && navigator.hardwareConcurrency) || 1);

const N_FFT = 4096, HOP = 1024, F = 1024, T = 512, NB = N_FFT / 2 + 1;
let session = null;

function periodicHann(n) { const w = new Float64Array(n); for (let i = 0; i < n; i++) w[i] = 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / n); return w; }

// Halve the sample rate with a windowed-sinc low-pass (for pitch analysis at 22.05 kHz).
function decimate2(x) {
  const taps = 31, h = new Float64Array(taps), c = (taps - 1) / 2, w = hann(taps);
  let s = 0;
  for (let i = 0; i < taps; i++) { const k = i - c; h[i] = (k === 0 ? 0.45 : Math.sin(Math.PI * 0.9 * k) / (Math.PI * k) / 1) * w[i]; s += h[i]; }
  for (let i = 0; i < taps; i++) h[i] /= s;
  const out = new Float32Array(Math.floor(x.length / 2));
  for (let n = 0; n < out.length; n++) {
    let acc = 0; const m = 2 * n;
    for (let i = 0; i < taps; i++) { const j = m - c + i; if (j >= 0 && j < x.length) acc += h[i] * x[j]; }
    out[n] = acc;
  }
  return out;
}

self.onmessage = async (e) => {
  const { L, R, modelUrl } = e.data;
  try {
    const post = (stage, p) => self.postMessage({ progress: p, stage });
    post('Loading the separation model…', 0);
    if (!session) session = await ort.InferenceSession.create(modelUrl, { executionProviders: ['wasm'], graphOptimizationLevel: 'all' });
    const N = L.length;
    const win = periodicHann(N_FFT);
    const pad = N_FFT / 2;
    const frames = 1 + Math.floor((N + 2 * pad - N_FFT) / HOP);
    const splits = Math.ceil(frames / T);
    const outL = new Float64Array(N + 2 * pad), outR = R !== L ? new Float64Array(N + 2 * pad) : null;
    const wsum = new Float64Array(N + 2 * pad);
    const chans = outR ? [L, R] : [L];
    const re = new Float64Array(N_FFT), im = new Float64Array(N_FFT);
    // complex spectra of one split, per channel
    const specRe = chans.map(() => new Float32Array(T * NB)), specIm = chans.map(() => new Float32Array(T * NB));
    const input = new Float32Array(2 * T * F);
    const sample = (x, i) => { const j = i - pad; return j >= 0 && j < N ? x[j] : 0; };
    for (let s = 0; s < splits; s++) {
      post('Separating the voice from the music…', s / splits);
      input.fill(0);
      const f0 = s * T, nf = Math.min(T, frames - f0);
      for (let c = 0; c < 2; c++) {
        const ci = Math.min(c, chans.length - 1), x = chans[ci];
        for (let t = 0; t < nf; t++) {
          const off = (f0 + t) * HOP;
          if (c === ci) {
            for (let i = 0; i < N_FFT; i++) { re[i] = sample(x, off + i) * win[i]; im[i] = 0; }
            fft(re, im);
            const base = t * NB;
            for (let k = 0; k < NB; k++) { specRe[ci][base + k] = re[k]; specIm[ci][base + k] = im[k]; }
          }
          const base = t * NB, ib = (c * T + t) * F;
          for (let k = 0; k < F; k++) input[ib + k] = Math.hypot(specRe[ci][base + k], specIm[ci][base + k]);
        }
      }
      const res = await session.run({ x: new ort.Tensor('float32', input, [2, 1, T, F]) });
      const y = res[Object.keys(res)[0]].data;
      // Wiener-style soft mask from the vocal estimate and the remainder, then inverse STFT.
      for (let ci = 0; ci < chans.length; ci++) {
        const out = ci === 0 ? outL : outR;
        for (let t = 0; t < nf; t++) {
          const base = t * NB, yb = (ci * T + t) * F;
          for (let k = 0; k < NB; k++) {
            let m = 0;
            if (k < F) {
              const mag = input[yb + k], v = y[yb + k], a = Math.max(0, mag - v);
              m = (v * v + 1e-10) / (v * v + a * a + 2e-10);
            }
            re[k] = specRe[ci][base + k] * m; im[k] = specIm[ci][base + k] * m;
          }
          for (let k = 1; k < NB - 1; k++) { re[N_FFT - k] = re[k]; im[N_FFT - k] = -im[k]; }
          // inverse FFT via conjugation
          for (let k = 0; k < N_FFT; k++) im[k] = -im[k];
          fft(re, im);
          const off = (f0 + t) * HOP;
          for (let i = 0; i < N_FFT; i++) {
            out[off + i] += (re[i] / N_FFT) * win[i];
            if (ci === 0) wsum[off + i] += win[i] * win[i];
          }
        }
      }
    }
    post('Separating the voice from the music…', 1);
    const vocals = new Float32Array(N);
    for (let i = 0; i < N; i++) {
      const w = wsum[i + pad] > 1e-6 ? wsum[i + pad] : 1;
      vocals[i] = outR ? 0.5 * (outL[i + pad] + outR[i + pad]) / w : outL[i + pad] / w;
    }
    post('Tracking the melody…', 0);
    const v22 = decimate2(vocals);
    const mel = analyzeSignal(v22, v22, 22050, { center: 0, silence: 0.1, onProgress: (p) => post('Tracking the melody…', p) });
    self.postMessage({ done: true, vocals, mel: { hop: mel.hop, t0: mel.t0, cents: mel.cents } }, [vocals.buffer, mel.cents.buffer]);
  } catch (err) {
    self.postMessage({ error: String((err && err.message) || err) });
  }
};
