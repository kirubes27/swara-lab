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
let wantFast = false; // set when the user asks for a faster model mid-way
let wantBalanced = false;
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

// ---- Kim_Vocal_2 (MDX-Net): complex spectrogram in, vocal complex spectrogram out ----------------
async function separateKim(L, R, url, post) {
  const N_FFT = 7680, HOP = 1024, DF = 3072, DT = 256, NB = N_FFT / 2 + 1;
  const CH = HOP * (DT - 1), TRIM = N_FFT / 2, GEN = CH - 2 * TRIM;
  post('load', 0, { model: 'kim' });
  let { s, ep } = await session(url, 'kim');
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
  post('separate', 0, { model: 'kim', gpu: ep === 'webgpu' }); // model is ready: show the separation step right away
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
    let res = await s.run({ input: new ort.Tensor('float32', input, [1, 4, DF, DT]) });
    let y = res[Object.keys(res)[0]].data;
    // Safety check on the GPU path: the voice can't carry more energy than the mix, and must be finite.
    if (ep === 'webgpu' && c === 0) {
      let ein = 0, eout = 0, bad = false;
      for (let k = 0; k < input.length; k += 7) { ein += input[k] * input[k]; const v = y[k]; if (!Number.isFinite(v)) { bad = true; break; } eout += v * v; }
      if (bad || eout > ein * 1.5 + 1e-6) {
        console.warn('WebGPU output failed the sanity check; switching to WebAssembly');
        sessions.kim = { s: await ort.InferenceSession.create(url, { executionProviders: ['wasm'], graphOptimizationLevel: 'all' }), ep: 'wasm' };
        ({ s, ep } = sessions.kim);
        res = await s.run({ input: new ort.Tensor('float32', input, [1, 4, DF, DT]) });
        y = res[Object.keys(res)[0]].data;
      }
    }
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
    post('separate', done, { model: 'kim', gpu: ep === 'webgpu', eta: (el / done) * (1 - done) });
  }
  return { L: outL, R: outR }; // stereo: subtracting each channel's own voice leaves no voice in the backing
}

// ---- Mel-Band RoFormer (Kimberley Jensen's vocals model, MIT; ONNX export by audiojs) ----------------
// Complex spectrogram in (Hann 2048, hop 441, centred, unnormalised), vocal complex spectrogram out.
// 8 s segments every 4 s with linear fades of 0.8 s, as Music-Source-Separation-Training's demix() runs it.
async function cachedModel(url, post, total) {
  const cache = self.caches ? await caches.open('swaralab-models-v1') : null;
  const hit = cache && (await cache.match(url));
  if (hit) return new Uint8Array(await hit.arrayBuffer());
  const r = await fetch(url);
  if (!r.ok) throw new Error('model download failed (' + r.status + ')');
  total = +r.headers.get('content-length') || total;
  const reader = r.body.getReader(), parts = [];
  let got = 0, last = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    parts.push(value); got += value.length;
    if (got - last > 2e6) { last = got; post('download', got / total, { model: 'roformer', mb: got / 1e6, totalMb: total / 1e6 }); }
  }
  const blob = new Blob(parts); parts.length = 0;
  try { if (cache) await cache.put(url, new Response(blob)); } catch {} // storage full: just don't cache
  return new Uint8Array(await blob.arrayBuffer());
}
async function separateRoformer(L, R, url, post, testEP) {
  if (!testEP && !(self.navigator && navigator.gpu)) throw new Error('NO_GPU');
  const N_FFT = 2048, HOP = 441, T = 801, NB = N_FFT / 2 + 1, SEG = 352800, STEP = SEG / 2, FADE = SEG / 10;
  post('download', 0, { model: 'roformer', mb: 0, totalMb: 464 });
  if (!sessions.rof) {
    const bytes = await cachedModel(url, post, 464050097);
    post('load', 0, { model: 'roformer' });
    sessions.rof = { s: await ort.InferenceSession.create(bytes, { executionProviders: [testEP || 'webgpu'], graphOptimizationLevel: 'all' }), ep: testEP || 'webgpu' };
  }
  const { s, ep } = sessions.rof;
  const win = periodicHann(N_FFT), n = L.length;
  // reflect the input a segment-less-a-step out on each side (when long enough), like demix()
  const border = SEG - STEP, wide = n > 2 * border;
  const M = wide ? n + 2 * border : n;
  const xAt = (x, i) => { if (!wide) return i < n ? x[i] : 0; let k = i - border, p = 2 * (n - 1); k = ((k % p) + p) % p; return k < n ? x[k] : p - k < n ? x[p - k] : 0; };
  const starts = []; for (let st = 0; ; st += STEP) { starts.push(st); if (st + SEG >= M) break; }
  const acc = [new Float64Array(M), new Float64Array(M)], wsum = new Float64Array(M);
  const re = new Float64Array(N_FFT), im = new Float64Array(N_FFT);
  const spec = new Float32Array(4 * NB * T), seg = [new Float32Array(SEG), new Float32Array(SEG)];
  const ola = [new Float64Array((T - 1) * HOP + N_FFT), new Float64Array((T - 1) * HOP + N_FFT)], env = new Float64Array((T - 1) * HOP + N_FFT);
  for (let t = 0; t < T; t++) for (let k = 0; k < N_FFT; k++) env[t * HOP + k] += win[k] * win[k];
  post('separate', 0, { model: 'roformer', gpu: ep === 'webgpu' });
  const t0 = performance.now();
  for (let si = 0; si < starts.length; si++) {
    const st = starts[si], len = Math.min(SEG, M - st), reflect = len > SEG / 2;
    for (let c = 0; c < 2; c++) {
      const x = c === 0 ? L : R;
      for (let i = 0; i < SEG; i++) { let j = i; if (i >= len) { if (!reflect) { seg[c][i] = 0; continue; } const p = 2 * (len - 1); j = ((i % p) + p) % p; if (j >= len) j = p - j; } seg[c][i] = xAt(x, st + j); }
    }
    // STFT of both channels at once (L + iR), centre-reflect padded
    for (let t = 0; t < T; t++) {
      const off = t * HOP - N_FFT / 2;
      for (let k = 0; k < N_FFT; k++) { let q = off + k; if (q < 0) q = -q; if (q >= SEG) q = 2 * (SEG - 1) - q; re[k] = seg[0][q] * win[k]; im[k] = seg[1][q] * win[k]; }
      fft(re, im);
      for (let f = 0; f < NB; f++) {
        const nf = (N_FFT - f) % N_FFT;
        spec[(0 * NB + f) * T + t] = 0.5 * (re[f] + re[nf]); spec[(1 * NB + f) * T + t] = 0.5 * (im[f] - im[nf]);
        spec[(2 * NB + f) * T + t] = 0.5 * (im[f] + im[nf]); spec[(3 * NB + f) * T + t] = -0.5 * (re[f] - re[nf]);
      }
    }
    const res = await s.run({ mix_spec: new ort.Tensor('float32', spec, [1, 4, NB, T]) });
    const z = res[Object.keys(res)[0]].data;
    ola[0].fill(0); ola[1].fill(0);
    for (let t = 0; t < T; t++) {
      re.fill(0); im.fill(0);
      for (let f = 0; f < NB; f++) {
        const lr = z[(0 * NB + f) * T + t], li = z[(1 * NB + f) * T + t], rr = z[(2 * NB + f) * T + t], ri = z[(3 * NB + f) * T + t];
        re[f] += lr - ri; im[f] += li + rr;
        if (f > 0 && f < N_FFT / 2) { const nf = N_FFT - f; re[nf] += lr + ri; im[nf] += -li + rr; }
      }
      for (let k = 0; k < N_FFT; k++) im[k] = -im[k];
      fft(re, im); // inverse via conjugation; real part = left, imaginary = right
      const off = t * HOP;
      for (let k = 0; k < N_FFT; k++) { ola[0][off + k] += (re[k] / N_FFT) * win[k]; ola[1][off + k] += (-im[k] / N_FFT) * win[k]; }
    }
    for (let i = 0; i < len; i++) {
      let w = 1;
      if (si > 0 && i < FADE) w = i / (FADE - 1);
      if (si < starts.length - 1 && i >= SEG - FADE) w = Math.min(w, (SEG - 1 - i) / (FADE - 1));
      const q = i + N_FFT / 2, e = env[q] > 1e-11 ? env[q] : 1;
      acc[0][st + i] += (ola[0][q] / e) * w; acc[1][st + i] += (ola[1][q] / e) * w; wsum[st + i] += w;
    }
    const el = (performance.now() - t0) / 1000, done = (si + 1) / starts.length;
    if (wantFast) throw new Error('FAST');
    post('separate', done, { model: 'roformer', gpu: ep === 'webgpu', eta: (el / done) * (1 - done) });
  }
  const vL = new Float32Array(n), vR = new Float32Array(n), off0 = wide ? border : 0;
  for (let i = 0; i < n; i++) { const w = wsum[i + off0] > 0 ? wsum[i + off0] : 1; vL[i] = acc[0][i + off0] / w; vR[i] = acc[1][i + off0] / w; }
  return { L: vL, R: vR };
}

// ---- Spleeter 2-stem (fallback): magnitude in, vocal magnitude out -------------------------------
async function separateSpleeter(L, R, url, post) {
  const N_FFT = 4096, HOP = 1024, F = 1024, T = 512, NB = N_FFT / 2 + 1;
  post('load', 0, { model: 'spleeter' });
  const { s } = await session(url, 'spleeter');
  const N = L.length, win = periodicHann(N_FFT), pad = N_FFT / 2;
  const frames = 1 + Math.floor((N + 2 * pad - N_FFT) / HOP), splits = Math.ceil(frames / T);
  const out = [new Float64Array(N + 2 * pad), new Float64Array(N + 2 * pad)], wsum = new Float64Array(N + 2 * pad);
  const chans = [L, R], re = new Float64Array(N_FFT), im = new Float64Array(N_FFT);
  const specRe = [new Float32Array(T * NB), new Float32Array(T * NB)], specIm = [new Float32Array(T * NB), new Float32Array(T * NB)];
  const input = new Float32Array(2 * T * F);
  const sample = (x, i) => { const j = i - pad; return j >= 0 && j < N ? x[j] : 0; };
  for (let sp = 0; sp < splits; sp++) {
    post('separate', sp / splits, { model: 'spleeter' });
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
  const vL = new Float32Array(N), vR = new Float32Array(N);
  for (let i = 0; i < N; i++) { const w = wsum[i + pad] > 1e-6 ? wsum[i + pad] : 1; vL[i] = out[0][i + pad] / w; vR[i] = out[1][i + pad] / w; }
  return { L: vL, R: vR };
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
  const { L, R, models, prefer, testEP } = e.data; // testEP: automated tests only (no GPU in CI)
  const post = (step, p, extra = {}) => self.postMessage({ progress: p, step, ...extra });
  try {
    let vocals, model = 'kim';
    if (prefer === 'best') {
      try {
        vocals = await separateRoformer(L, R, models.roformer, post, testEP); model = 'roformer';
        // Blend with Kim Vocal 2 (35 %): on 50 real songs the blend traced 89.8 % of sung notes vs 88.4 % for RoFormer alone.
        try {
          const refine = (step, p, extra = {}) => post('refine', step === 'separate' ? p : 0, { ...extra, model: 'roformer' });
          const kim = await separateKim(L, R, models.kim, refine);
          for (const ch of ['L', 'R']) { const a = vocals[ch], b = kim[ch]; for (let i = 0; i < a.length; i++) a[i] = 0.65 * a[i] + 0.35 * b[i]; }
          model = 'roformer+kim';
        } catch (err) { if (String(err && err.message) === 'FAST') wantFast = false; else console.warn('Kim refinement skipped:', err); }
      }
      catch (err) {
        const why = String(err && err.message);
        if (why === 'FAST') { wantFast = false; wantBalanced = true; }
        else console.warn('Mel-RoFormer unavailable, using Kim_Vocal_2:', err);
        post('fallback', 0, { model: 'kim', reason: why === 'NO_GPU' ? 'nogpu' : why === 'FAST' ? 'user' : 'error' });
      }
    }
    if (!vocals) {
      try { if (prefer === 'fast') throw new Error('FAST'); vocals = await separateKim(L, R, models.kim, post); model = 'kim'; }
      catch (err) {
        if (String(err && err.message) !== 'FAST') console.warn('Kim_Vocal_2 failed, falling back to Spleeter:', err);
        model = 'spleeter';
        vocals = await separateSpleeter(L, R, models.spleeter, post);
      }
    }
    post('trace', 0, { model });
    const mono = new Float32Array(vocals.L.length);
    for (let i = 0; i < mono.length; i++) mono[i] = 0.5 * (vocals.L[i] + vocals.R[i]);
    const v22 = decimate2(mono);
    const mel = analyzeSignal(v22, v22, 22050, { center: 0, silence: 0.1, onProgress: (p) => post('trace', p, { model }) });
    self.postMessage({ done: true, vocals, model, mel: { hop: mel.hop, t0: mel.t0, cents: mel.cents } }, [vocals.L.buffer, vocals.R.buffer, mel.cents.buffer]);
  } catch (err) {
    self.postMessage({ error: String((err && err.message) || err) });
  }
};
