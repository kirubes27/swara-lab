// Vocal separation worker.
// Primary: Kim_Vocal_2 (MDX-Net, MIT): strong, slower. Fallback: Spleeter 2-stem (Deezer, MIT).
// Runs in onnxruntime-web (WebGPU when available, otherwise WebAssembly), then tracks the melody
// on the isolated voice.
//   in:  { L, R } Float32Array @44.1 kHz, models: { kim, spleeter } URLs
//   out: { vocals: Float32Array mono @44.1 kHz, mel, model }
import * as ort from 'https://cdn.jsdelivr.net/npm/onnxruntime-web@1.20.1/dist/ort.webgpu.min.mjs';
import { fft, hann, anyFFT } from './dsp.js';
import { analyzeSignal } from './melody.js';

ort.env.wasm.wasmPaths = 'https://cdn.jsdelivr.net/npm/onnxruntime-web@1.20.1/dist/';
ort.env.wasm.numThreads = Math.min(4, (self.crossOriginIsolated && navigator.hardwareConcurrency) || 1);

const sessions = {};
let wantFast = false; // set when the user asks for the faster model mid-way
async function session(url, key) {
  if (sessions[key]) return sessions[key];
  const tries = [];
  if (self.navigator && navigator.gpu) tries.push(['webgpu']);
  tries.push(['wasm']);
  let lastErr;
  for (const eps of tries) {
    try { sessions[key] = { s: await ort.InferenceSession.create(url, { executionProviders: eps, graphOptimizationLevel: 'all' }), ep: eps[0] }; return sessions[key]; }
    catch (e) { lastErr = e; }
  }
  throw lastErr;
}
const periodicHann = (n) => { const w = new Float64Array(n); for (let i = 0; i < n; i++) w[i] = 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / n); return w; };
const fmtEta = (s) => (s > 90 ? `about ${Math.round(s / 60)} min left` : s > 5 ? `about ${Math.round(s / 5) * 5} s left` : 'almost done');

// ---- Kim_Vocal_2 (MDX-Net): complex spectrogram in, vocal complex spectrogram out ----------------
async function separateKim(L, R, url, post) {
  const N_FFT = 7680, HOP = 1024, DF = 3072, DT = 256, NB = N_FFT / 2 + 1;
  const CH = HOP * (DT - 1), TRIM = N_FFT / 2, GEN = CH - 2 * TRIM;
  post('Loading the AI voice-separation model (67 MB, first time only)…', 0);
  const { s, ep } = await session(url, 'kim');
  const n = L.length, pad = GEN - (n % GEN);
  const total = TRIM + n + pad + TRIM;
  const sig = (x, j) => { const k = j - TRIM; return k >= 0 && k < n ? x[k] : 0; };
  const win = periodicHann(N_FFT);
  const F = anyFFT(N_FFT), Fi = anyFFT(N_FFT, true);
  const re = new Float64Array(N_FFT), im = new Float64Array(N_FFT);
  const input = new Float32Array(4 * DF * DT);
  const outL = new Float32Array(n), outR = new Float32Array(n);
  const cl = new Float64Array(CH + N_FFT), cr = new Float64Array(CH + N_FFT), ws = new Float64Array(CH + N_FFT);
  const chunks = Math.ceil((n + pad) / GEN);
  const t0 = performance.now();
  for (let c = 0, i = 0; i < n + pad; i += GEN, c++) {
    // chunk samples with reflect padding (torch.stft center=True)
    const at = (x, j) => { // j in [-N_FFT/2, CH + N_FFT/2)
      let q = j; if (q < 0) q = -q; if (q >= CH) q = 2 * (CH - 1) - q;
      return sig(x, i + q);
    };
    for (let t = 0; t < DT; t++) {
      const off = t * HOP - N_FFT / 2;
      for (let k = 0; k < N_FFT; k++) { re[k] = at(L, off + k) * win[k]; im[k] = at(R, off + k) * win[k]; }
      F(re, im); // packs both channels: Z = FFT(L + iR)
      for (let k = 0; k < DF; k++) {
        const nk = (N_FFT - k) % N_FFT;
        const lr = 0.5 * (re[k] + re[nk]), li = 0.5 * (im[k] - im[nk]);
        const rr = 0.5 * (im[k] + im[nk]), ri = -0.5 * (re[k] - re[nk]);
        input[(0 * DF + k) * DT + t] = lr; input[(1 * DF + k) * DT + t] = li;
        input[(2 * DF + k) * DT + t] = rr; input[(3 * DF + k) * DT + t] = ri;
      }
    }
    const res = await s.run({ input: new ort.Tensor('float32', input, [1, 4, DF, DT]) });
    const y = res[Object.keys(res)[0]].data;
    cl.fill(0); cr.fill(0); ws.fill(0);
    for (let t = 0; t < DT; t++) {
      // Z = VL + i·VR over the full Hermitian spectrum, inverse FFT gives both channels at once
      re.fill(0); im.fill(0);
      for (let k = 0; k < DF; k++) {
        const vlr = y[(0 * DF + k) * DT + t], vli = y[(1 * DF + k) * DT + t];
        const vrr = y[(2 * DF + k) * DT + t], vri = y[(3 * DF + k) * DT + t];
        re[k] += vlr - vri; im[k] += vli + vrr;
        if (k > 0) { const nk = N_FFT - k; re[nk] += vlr + vri; im[nk] += -vli + vrr; }
      }
      Fi(re, im);
      const off = t * HOP;
      for (let k = 0; k < N_FFT; k++) { const w = win[k]; cl[off + k] += (re[k] / N_FFT) * w; cr[off + k] += (im[k] / N_FFT) * w; ws[off + k] += w * w; }
    }
    // remove centre padding, keep the un-trimmed middle of the chunk
    for (let j = TRIM; j < CH - TRIM; j++) {
      const q = j + N_FFT / 2, w = ws[q] > 1e-8 ? ws[q] : 1;
      const dst = i + j - TRIM;
      if (dst < n) { outL[dst] = (cl[q] / w) * 1.009; outR[dst] = (cr[q] / w) * 1.009; }
    }
    if (wantFast) throw new Error('FAST');
    const el = (performance.now() - t0) / 1000, done = (c + 1) / chunks;
    post(`Separating the voice with a strong AI model${ep === 'webgpu' ? ' (using your graphics card)' : ''}: ${fmtEta((el / done) * (1 - done))}`, done);
  }
  const v = new Float32Array(n);
  for (let k = 0; k < n; k++) v[k] = 0.5 * (outL[k] + outR[k]);
  return v;
}

// ---- Spleeter 2-stem (fallback): magnitude in, vocal magnitude out -------------------------------
async function separateSpleeter(L, R, url, post) {
  const N_FFT = 4096, HOP = 1024, F = 1024, T = 512, NB = N_FFT / 2 + 1;
  post('Loading the fallback separation model…', 0);
  const { s } = await session(url, 'spleeter');
  const N = L.length, win = periodicHann(N_FFT), pad = N_FFT / 2;
  const frames = 1 + Math.floor((N + 2 * pad - N_FFT) / HOP), splits = Math.ceil(frames / T);
  const out = [new Float64Array(N + 2 * pad), new Float64Array(N + 2 * pad)], wsum = new Float64Array(N + 2 * pad);
  const chans = [L, R], re = new Float64Array(N_FFT), im = new Float64Array(N_FFT);
  const specRe = [new Float32Array(T * NB), new Float32Array(T * NB)], specIm = [new Float32Array(T * NB), new Float32Array(T * NB)];
  const input = new Float32Array(2 * T * F);
  const sample = (x, i) => { const j = i - pad; return j >= 0 && j < N ? x[j] : 0; };
  for (let sp = 0; sp < splits; sp++) {
    post('Separating the voice…', sp / splits);
    input.fill(0);
    const f0 = sp * T, nf = Math.min(T, frames - f0);
    for (let c = 0; c < 2; c++) for (let t = 0; t < nf; t++) {
      const off = (f0 + t) * HOP;
      for (let i = 0; i < N_FFT; i++) { re[i] = sample(chans[c], off + i) * win[i]; im[i] = 0; }
      fft(re, im);
      const base = t * NB, ib = (c * T + t) * F;
      for (let k = 0; k < NB; k++) { specRe[c][base + k] = re[k]; specIm[c][base + k] = im[k]; }
      for (let k = 0; k < F; k++) input[ib + k] = Math.hypot(re[k], im[k]);
    }
    const res = await s.run({ x: new ort.Tensor('float32', input, [2, 1, T, F]) });
    const y = res[Object.keys(res)[0]].data;
    for (let c = 0; c < 2; c++) for (let t = 0; t < nf; t++) {
      const base = t * NB, yb = (c * T + t) * F;
      for (let k = 0; k < NB; k++) {
        let m = 0;
        if (k < F) { const mag = input[yb + k], v = y[yb + k], a = Math.max(0, mag - v); m = (v * v + 1e-10) / (v * v + a * a + 2e-10); }
        re[k] = specRe[c][base + k] * m; im[k] = specIm[c][base + k] * m;
      }
      for (let k = 1; k < NB - 1; k++) { re[N_FFT - k] = re[k]; im[N_FFT - k] = -im[k]; }
      for (let k = 0; k < N_FFT; k++) im[k] = -im[k];
      fft(re, im);
      const off = (f0 + t) * HOP;
      for (let i = 0; i < N_FFT; i++) { out[c][off + i] += (re[i] / N_FFT) * win[i]; if (c === 0) wsum[off + i] += win[i] * win[i]; }
    }
  }
  const v = new Float32Array(N);
  for (let i = 0; i < N; i++) { const w = wsum[i + pad] > 1e-6 ? wsum[i + pad] : 1; v[i] = (0.5 * (out[0][i + pad] + out[1][i + pad])) / w; }
  return v;
}

function decimate2(x) {
  const taps = 31, h = new Float64Array(taps), c = (taps - 1) / 2, w = hann(taps);
  let s = 0;
  for (let i = 0; i < taps; i++) { const k = i - c; h[i] = (k === 0 ? 0.45 : Math.sin(Math.PI * 0.9 * k) / (Math.PI * k)) * w[i]; s += h[i]; }
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
  if (e.data && e.data.fast) { wantFast = true; return; }
  const { L, R, models } = e.data;
  const post = (stage, p) => self.postMessage({ progress: p, stage });
  try {
    let vocals, model = 'kim';
    try { vocals = await separateKim(L, R, models.kim, post); }
    catch (err) {
      if (String(err && err.message) !== 'FAST') console.warn('Kim_Vocal_2 failed, falling back to Spleeter:', err);
      model = 'spleeter';
      vocals = await separateSpleeter(L, R, models.spleeter, post);
    }
    post('Tracing the melody of the voice…', 0);
    const v22 = decimate2(vocals);
    const mel = analyzeSignal(v22, v22, 22050, { center: 0, silence: 0.1, onProgress: (p) => post('Tracing the melody of the voice…', p) });
    self.postMessage({ done: true, vocals, model, mel: { hop: mel.hop, t0: mel.t0, cents: mel.cents } }, [vocals.buffer, mel.cents.buffer]);
  } catch (err) {
    self.postMessage({ error: String((err && err.message) || err) });
  }
};
