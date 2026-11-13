// Song Studio: load a song (YouTube / file / another tab), extract its melody,
// loop phrases, slow down, transpose, and sing against the reference with feedback.
import { audioCtx, mic, createTap, renderRate, audioBufferToWav, TakeRecorder, setMasterMuted, pushFrame } from './audio.js';
import { tanpura, Follower } from './sound.js';
import { PitchLane, Overview } from './lane.js';
import { SalienceAnalyzer, trackMelody, melodyAt, melodyDuration, estimateTonic, findPhrases, F_REF } from './melody.js';
import { analyzeTake, transcribe, fitToRange, swaraBiasText, describeSwaraBias } from './coach.js';
import { settings, saveSettings, songs, getSong, upsertSong, removeSong, lastSong, idbGet, idbPut, packMelody, unpackMelody, logActivity } from './store.js';
import { westernName, hzToMidi, percentile, saHzFrom, isIndian } from './music.js';
import { h, toast, ensureMic, tipList, fmtTime, menu, popover, sheet, closePopover, popoverOpen } from './ui.js';
import { LyricsPanel } from './lyrics.js';
import { LiveReadout, stat } from './practice.js';
import { icon } from './icons.js';

// ---------------------------------------------------------------------------
// Players
let ytReady = null;
function loadYT() {
  if (ytReady) return ytReady;
  ytReady = new Promise((res) => {
    if (window.YT && window.YT.Player) return res(window.YT);
    window.onYouTubeIframeAPIReady = () => res(window.YT);
    const s = document.createElement('script'); s.src = 'https://www.youtube.com/iframe_api'; document.head.append(s);
  });
  return ytReady;
}

export function parseYouTubeId(url) {
  const s = url.trim();
  const ok = (id) => (id && /^[\w-]{11}$/.test(id) ? id : null); // YouTube ids are exactly 11 characters
  if (ok(s)) return s;
  try {
    const u = new URL(s);
    if (!/(^|\.)(youtube\.com|youtu\.be|youtube-nocookie\.com)$/.test(u.hostname)) return null;
    if (u.hostname.includes('youtu.be')) return ok(u.pathname.slice(1).split('/')[0]);
    if (u.searchParams.get('v')) return ok(u.searchParams.get('v'));
    const m = u.pathname.match(/\/(embed|shorts|live|v)\/([\w-]+)/);
    if (m) return ok(m[2]);
  } catch {}
  return null;
}

class YTPlayer {
  constructor(el, videoId, { onState, onError, onReady } = {}) {
    this.kind = 'youtube'; this.r = 1; this.playing = false; this.smooth = 0; this.prevNow = performance.now();
    this.ready = loadYT().then((YT) => new Promise((res) => {
      if (!/^[\w-]{11}$/.test(videoId || '')) { onError && onError(2); res(); return; } // 2 = invalid id (YouTube's own code)
      try { this.p = new YT.Player(el, {
        videoId, width: '100%', height: '100%',
        playerVars: { playsinline: 1, rel: 0, modestbranding: 1, origin: location.origin },
        events: {
          onReady: () => { this.ok = true; res(); onReady && onReady(this); },
          onStateChange: (e) => { this.playing = e.data === 1; if (e.data === 1) this.prevNow = performance.now(); onState && onState(e.data, this); },
          onError: (e) => onError && onError(e.data),
        },
      }); } catch (e) { console.warn('YouTube player', e); onError && onError(2); res(); }
    }));
  }
  play() { this.ok && this.p.playVideo(); }
  pause() { this.ok && this.p.pauseVideo(); }
  seek(t) {
    if (!this.ok) return;
    t = Math.max(0, t);
    this.p.seekTo(t, true);
    // getCurrentTime() keeps reporting the old position for a moment after seekTo
    this.pendingSeek = { to: t, at: performance.now() };
    this.smooth = t; this.lastRaw = null;
  }
  setRate(r) { this.r = r; this.ok && this.p.setPlaybackRate(r); }
  mute(m) { if (!this.ok) return; m ? this.p.mute() : this.p.unMute(); }
  setVolume(v) { this.ok && this.p.setVolume(Math.round(Math.max(0, Math.min(1, v)) * 100)); }
  duration() { return this.ok ? this.p.getDuration() || 0 : 0; }
  title() { try { return this.p.getVideoData().title; } catch { return ''; } }
  time() {
    if (!this.ok) return 0;
    let raw = this.p.getCurrentTime();
    const now = performance.now();
    if (this.pendingSeek) {
      const ps = this.pendingSeek, el = (now - ps.at) / 1000;
      const expect = ps.to + (this.playing ? el * this.r : 0);
      if (Math.abs(raw - expect) > 0.6 && el < 2) raw = expect; else this.pendingSeek = null;
    }
    const dt = (now - this.prevNow) / 1000; this.prevNow = now;
    if (!this.playing) { this.smooth = raw; return raw; }
    this.r = this.p.getPlaybackRate ? this.p.getPlaybackRate() : this.r;
    if (raw !== this.lastRaw) { this.lastRaw = raw; this.lastRawAt = now; }
    const est = this.lastRaw + ((now - this.lastRawAt) / 1000) * this.r;
    this.smooth += dt * this.r;
    const err = est - this.smooth;
    if (Math.abs(err) > 0.3) this.smooth = est; else this.smooth += err * 0.1;
    return this.smooth;
  }
  destroy() { this.ok = false; try { this.p && this.p.destroy(); } catch {} }
}

class AudioPlayer {
  constructor(blob, { onState } = {}) {
    this.kind = 'audio'; this.blob = blob; this.factor = 1; this.r = 1; this.st = 0; this.cur = 'mix|0'; this.onState = onState;
    this.a = new Audio(); this.a.preload = 'auto';
    this.a.preservesPitch = true; this.a.mozPreservesPitch = true; this.a.webkitPreservesPitch = true;
    this.url = URL.createObjectURL(blob);
    this.ready = (async () => {
      // MediaRecorder WebM files have no duration or seek index; convert them to WAV so seeking works.
      if (/webm|ogg/.test(blob.type || '')) {
        try { const buf = await this.decoded(); URL.revokeObjectURL(this.url); this.url = URL.createObjectURL(audioBufferToWav(buf)); } catch {}
      }
      this.a.src = this.url;
      await new Promise((res) => { this.a.addEventListener('loadedmetadata', res, { once: true }); this.a.addEventListener('error', res, { once: true }); });
    })();
    const emit = (st) => { if (!this.dead && onState) onState(st, this); };
    this.a.addEventListener('play', () => emit(1));
    this.a.addEventListener('pause', () => emit(2));
    this.a.addEventListener('ended', () => emit(0));
  }
  get playing() { return !this.a.paused && !this.a.ended; }
  play() { this.a.play().catch(() => {}); }
  pause() { this.a.pause(); }
  seek(t) { if (isFinite(t)) this.a.currentTime = Math.max(0, t / this.factor); }
  setRate(r) { this.r = r; this.a.playbackRate = r / this.factor; }
  mute(m) { this.a.muted = m; }
  setVolume(v) { this.a.volume = Math.max(0, Math.min(1, v)); }
  duration() { const d = this.a.duration; return (isFinite(d) ? d : 0) * this.factor; } // MediaRecorder WebM reports Infinity
  time() { return this.a.currentTime * this.factor; }
  async decoded() {
    if (!this.buf) this.buf = await audioCtx().decodeAudioData(await this.blob.arrayBuffer());
    return this.buf;
  }
  // vocals: {L, R} (or mono) Float32Array @44.1 kHz from the separation step; gate: voiceGate()
  setVocals(v) { this.vocals = v; this.stems = {}; }
  setGate(g) { if (g !== this.gate) { this.gate = g; if (this.stems) delete this.stems.vocals; } }
  async setTranspose(st) { this.st0 = st; return this.rebuild(); }
  async setSound(mode) { this.mode0 = mode; return this.rebuild(); }
  wanted() { return (this.vocals ? (this.mode0 || 'mix') : 'mix') + '|' + (this.st0 ?? this.st ?? 0); }
  // One swap at a time: each call waits for the one before and then works towards the latest choice,
  // so quick repeated clicks can't run two swaps at once (that lost the playback position).
  rebuild() {
    const run = () => this.swap();
    return (this.queue = (this.queue || Promise.resolve()).then(run, run));
  }
  async swap() {
    const want = this.wanted();
    if (this.dead || want === (this.cur || 'mix|0')) return;
    const [mode, sts] = want.split('|'), st = +sts, f = Math.pow(2, st / 12);
    let url = this.url;
    if (want !== 'mix|0') {
      let src = await this.decoded();
      if (mode !== 'mix') src = await this.stemBuffer(mode);
      if (this.wanted() !== want || this.dead) return; // a newer choice is queued behind this one
      if (st) src = await renderRate(src, f, Math.min(44100, src.sampleRate));
      if (this.wanted() !== want || this.dead) return;
      if (this.shiftUrl) URL.revokeObjectURL(this.shiftUrl);
      url = this.shiftUrl = URL.createObjectURL(audioBufferToWav(src));
    }
    const t = this.time(), was = this.playing;
    this.pause();
    this.factor = st ? f : 1; this.a.src = url;
    this.st = st; this.cur = want;
    await new Promise((res) => { this.a.addEventListener('loadedmetadata', res, { once: true }); this.a.addEventListener('error', res, { once: true }); });
    this.setRate(this.r); this.seek(t);
    if (was) this.play();
  }
  async stemBuffer(mode) {
    this.stems = this.stems || {};
    if (this.stems[mode]) return this.stems[mode];
    const orig = await renderRate(await this.decoded(), 1, 44100);
    const V = this.vocals, chans = V.L ? [V.L, V.R] : [V, V];
    const out = new AudioBuffer({ numberOfChannels: orig.numberOfChannels, length: orig.length, sampleRate: 44100 });
    for (let ch = 0; ch < orig.numberOfChannels; ch++) {
      const x = orig.getChannelData(ch), o = out.getChannelData(ch);
      const v = orig.numberOfChannels === 1 && V.L ? Float32Array.from(V.L, (a, i) => 0.5 * (a + V.R[i])) : chans[Math.min(ch, 1)];
      const n = Math.min(x.length, v.length), g = this.gate;
      if (mode === 'vocals') for (let i = 0; i < n; i++) o[i] = g ? v[i] * g[Math.min(g.length - 1, (i / 441) | 0)] : v[i];
      else { o.set(x); for (let i = 0; i < n; i++) o[i] = x[i] - v[i]; }
    }
    if (mode !== 'vocals') return (this.stems[mode] = out);
    // soften the hiss band, where cymbal bleed lives (the voice has little there)
    const off = new OfflineAudioContext(out.numberOfChannels, out.length, 44100);
    const src = off.createBufferSource(); src.buffer = out;
    const shelf = off.createBiquadFilter(); shelf.type = 'highshelf'; shelf.frequency.value = 7500; shelf.gain.value = -9;
    src.connect(shelf); shelf.connect(off.destination); src.start();
    return (this.stems[mode] = await off.startRendering());
  }
  destroy() { this.dead = true; this.pause(); this.a.removeAttribute('src'); this.a.load(); URL.revokeObjectURL(this.url); if (this.shiftUrl) URL.revokeObjectURL(this.shiftUrl); }
}

// ---------------------------------------------------------------------------
const MODELS = {
  kim: new URL('../models/kim-vocal-2.onnx', import.meta.url).href,
  spleeter: new URL('../models/spleeter-vocals.onnx', import.meta.url).href,
  // 464 MB: too big for GitHub Pages, so fetched from Hugging Face at the exact revision that was benchmarked
  roformer: 'https://huggingface.co/audiojs/mel-roformer/resolve/c1aba02c00a0bee852d6754fe6ede8164f90a4b3/mel-roformer.fp16.onnx',
};
// WebGPU: the API can exist without a usable graphics adapter (common on Linux), so ask for one.
let HAS_GPU = typeof navigator !== 'undefined' && !!navigator.gpu;
const gpuChecked = (async () => {
  try {
    const a = navigator.gpu && (await navigator.gpu.requestAdapter());
    HAS_GPU = !!a && !(a.isFallbackAdapter || (a.info && a.info.isFallbackAdapter)); // a software adapter is no faster than the processor
  } catch { HAS_GPU = false; }
  return HAS_GPU;
})();
// The quality actually used: without a graphics card the larger models take many minutes per song,
// so Fast is the default there unless the person picked a quality themselves.
function effectiveQuality() {
  const q = settings.sepQuality || 'balanced';
  if (!HAS_GPU && !settings.sepQualityChosen) return 'fast';
  if (q === 'best' && !HAS_GPU) return 'balanced';
  return q;
}
function pickQuality(v) { saveSettings({ sepQuality: v, sepQualityChosen: true }); }
function qualitySub(v, tip) {
  if (HAS_GPU) return tip;
  if (v === 'best') return 'Needs a graphics card (WebGPU) in this browser';
  if (v === 'balanced') return '~87% of notes · slow without a graphics card: many minutes per song';
  return tip;
}
let activeSep = null; // the running separation worker (to ask it for the faster model)
export function useFastModel() { if (activeSep) activeSep.postMessage({ fast: true }); }
function runWorker(url, msg, transfer, onProgress) {
  return new Promise((res, rej) => {
    const w = new Worker(new URL(url, import.meta.url), { type: 'module' });
    if (url.includes('sep-worker')) activeSep = w;
    w.onmessage = (e) => {
      if (e.data.progress != null) onProgress && onProgress(e.data.progress, e.data.step || e.data.stage, e.data);
      if (e.data.done) { w.terminate(); if (activeSep === w) activeSep = null; res(e.data); }
      if (e.data.error) { w.terminate(); if (activeSep === w) activeSep = null; rej(new Error(e.data.error)); }
    };
    w.onerror = (e) => { w.terminate(); if (activeSep === w) activeSep = null; rej(new Error(e.message || 'worker failed')); };
    w.postMessage(msg, transfer);
  });
}
// Separate the voice from the music (Spleeter, in a worker), then track pitch on the voice alone.
// Falls back to the mix-based tracker if separation can't run in this browser.
async function analyzeBlob(blob, onProgress) {
  await gpuChecked;
  const c = audioCtx();
  const buf = await c.decodeAudioData(await blob.arrayBuffer());
  try {
    const b44 = await renderRate(buf, 1, 44100);
    const L = b44.getChannelData(0).slice(), R = (b44.numberOfChannels > 1 ? b44.getChannelData(1) : b44.getChannelData(0)).slice();
    const r = await runWorker('./sep-worker.js', { L, R, models: MODELS, prefer: effectiveQuality(), testEP: self.__swaraTestEP }, [L.buffer, R.buffer], onProgress);
    return { mel: r.mel, vocals: r.vocals, separated: true, model: r.model };
  } catch (err) {
    console.warn('vocal separation unavailable, using mix-based tracking:', err);
    toast('Voice separation isn\'t available in this browser, so the melody is traced from the full mix (less accurate).', 'info', 7000);
    const small = await renderRate(buf, 1, 22050);
    const L = small.getChannelData(0).slice(), R = (small.numberOfChannels > 1 ? small.getChannelData(1) : small.getChannelData(0)).slice();
    const r = await runWorker('./worker.js', { L, R, sr: 22050 }, [L.buffer, R.buffer], (p) => onProgress && onProgress(p, 'trace', {}));
    return { mel: r.mel, vocals: null, separated: false };
  }
}
// Map a melody measured on the recording's clock onto video time, using the (recording, video) time
// pairs logged during capture, then fine-tune the offset against the live contour.
function placeOnVideo(recMel, mapping, liveCents, frames, minI, maxI) {
  const n = liveCents.length, rtOf = new Float32Array(n).fill(NaN);
  for (let k = 1; k < mapping.length; k++) {
    const m0 = mapping[k - 1], m1 = mapping[k];
    const dv = m1.vt - m0.vt, dr = m1.rt - m0.rt;
    if (!m0.on || !m1.on || dv <= 0 || dv > 0.6 || dr <= 0 || dr > 0.6) continue;
    for (let g = Math.ceil(m0.vt / 0.01); g <= Math.floor(m1.vt / 0.01) && g < n; g++) rtOf[g] = m0.rt + ((g * 0.01 - m0.vt) * dr) / dv;
  }
  let best = 0, bestScore = -1;
  for (let d = -0.5; d <= 0.5001; d += 0.01) {
    let sc = 0;
    for (let g = minI; g <= maxI; g += 4) {
      const rt = rtOf[g], lv = liveCents[g];
      if (isNaN(rt) || isNaN(lv)) continue;
      const v = melodyAt(recMel, rt + d);
      if (!isNaN(v) && Math.abs(wrap1200(v - lv)) < 80) sc++;
    }
    if (sc > bestScore) { bestScore = sc; best = d; }
  }
  if (bestScore < 20) return null; // couldn't line up (e.g. silent capture)
  const out = Float32Array.from(liveCents);
  out.shift = best; // recording position of video time v: rt(v) + shift
  for (let g = minI; g <= maxI && g < n; g++) {
    if (!(frames.has(g) || frames.has(g - 1) || frames.has(g + 1))) continue; // keep earlier captures elsewhere
    out[g] = isNaN(rtOf[g]) ? NaN : melodyAt(recMel, rtOf[g] + best);
  }
  return out;
}
// Where the video really played during a capture: stretches of video time [v0, v1) with the recording
// position rt = v + off. An ad (the video's clock stands still, or runs on the ad and then starts
// the song from 0), buffering and pauses fall between or under them; a later stretch wins.
function playedStretches(mapping) {
  const out = [];
  let cur = null;
  for (let k = 1; k < mapping.length; k++) {
    const a = mapping[k - 1], b = mapping[k], dv = b.vt - a.vt, dr = b.rt - a.rt;
    if (!(a.on && b.on && dr > 0 && dr < 0.6 && Math.abs(dv - dr) < 0.05)) { cur = null; continue; }
    if (!cur) {
      // the video started or resumed between the sample before and this one: from where its clock
      // stood (an ad break) or, after a jump back (an ad's own clock), from up to that long before
      const p = mapping[k - 2];
      const v0 = !p ? Math.max(0, a.vt - a.rt) : p.vt <= a.vt && a.vt - p.vt < 0.15 ? p.vt : Math.max(0, a.vt - Math.min(0.15, a.rt - p.rt));
      out.push((cur = { v0, v1: b.vt, offs: [a.rt - a.vt] }));
    }
    cur.v1 = b.vt; cur.offs.push(b.rt - b.vt);
  }
  const res = out.filter((x) => x.v1 - x.v0 > 0.3).map((x) => ({ v0: x.v0, v1: x.v1, off: percentile(x.offs, 0.5) }));
  // the video played on up to the break, between the last sample and the next stretch: no gap at a cut
  for (let k = 1; k < res.length; k++) if (res[k].v0 > res[k - 1].v1 && res[k].v0 - res[k - 1].v1 < 0.15) res[k - 1].v1 = res[k].v0;
  return res;
}
// Sound re-timed onto the video's clock (ads and gaps cut out): chans recorded at sr, shift as placeOnVideo found it.
function retimeAudio(chans, sr, stretches, shift, vEnd) {
  const n = Math.ceil(vEnd * sr), fade = Math.round(0.004 * sr);
  return chans.map((x) => {
    const o = new Float32Array(n);
    for (const st of stretches) {
      const a = Math.max(0, Math.round(st.v0 * sr)), b = Math.min(n, Math.round(st.v1 * sr)), d = Math.round((st.off + shift) * sr);
      for (let i = a; i < b; i++) {
        const j = i + d;
        const g = Math.min(1, (i - a) / fade, (b - 1 - i) / fade); // a few ms of fade at each cut
        o[i] = j >= 0 && j < x.length ? x[j] * g : 0;
      }
    }
    return o;
  });
}
function retimeMelody(mel, stretches, shift, vEnd) {
  const cents = new Float32Array(Math.ceil(vEnd / 0.01) + 1).fill(NaN);
  for (const st of stretches) for (let g = Math.ceil(st.v0 / 0.01); g * 0.01 < st.v1 && g < cents.length; g++) cents[g] = melodyAt(mel, g * 0.01 + st.off + shift);
  return { hop: 0.01, t0: 0, cents };
}
const wrap1200 = (d) => ((((d + 600) % 1200) + 1200) % 1200) - 600;
const i16 = (f) => { const o = new Int16Array(f.length); for (let i = 0; i < f.length; i++) o[i] = Math.max(-32768, Math.min(32767, Math.round(f[i] * 32767))); return o; };
const f32 = (a) => { const o = new Float32Array(a.length); for (let i = 0; i < a.length; i++) o[i] = a[i] / 32767; return o; };
// separated voice: stereo {L, R} (older songs: one mono track)
const toI16 = (v) => (v && v.L ? { L: i16(v.L), R: i16(v.R) } : i16(v));
const fromI16 = (v) => (v && v.L ? { L: f32(v.L), R: f32(v.R) } : f32(v));
// Where the melody guide hears singing (±0.25 s), as a 100 Hz gain curve: 1 while singing, about
// −24 dB elsewhere. Applied to "Voice only" it removes cymbal and drum bleed between lines.
function voiceGate(mel, durSec) {
  const n = Math.ceil(durSec * 100) + 2, g = new Float32Array(n).fill(0.06);
  for (let i = 0; i < mel.cents.length; i++) {
    if (isNaN(mel.cents[i])) continue;
    const t = mel.t0 + i * mel.hop, a = Math.max(0, Math.floor((t - 0.25) * 100)), b = Math.min(n - 1, Math.ceil((t + 0.25) * 100));
    for (let k = a; k <= b; k++) g[k] = 1;
  }
  for (let k = 1; k < n; k++) g[k] = Math.max(g[k], g[k - 1] * 0.85);      // soft release
  for (let k = n - 2; k >= 0; k--) g[k] = Math.max(g[k], g[k + 1] * 0.75); // soft attack
  return g;
}

const cAbove55 = (hz) => 1200 * Math.log2(hz / F_REF);

// Voice-separation quality (remembered in settings): Fast = Spleeter, Balanced = Kim Vocal 2, Best = Mel-RoFormer.
const QUALITY = [
  ['fast', 'Fast', 'Spleeter · ~72% of notes · about a minute'],
  ['balanced', 'Balanced', 'Kim Vocal 2 · ~87% of notes · seconds with a graphics card'],
  ['best', 'Best', 'Mel-RoFormer + Kim · ~90% of notes · 464 MB once, a few minutes'],
];

// Plain reading of a transcription: the held notes only, no ornament symbols.
function simpleNotes(toks) {
  const out = [];
  for (const tk of toks) {
    if (tk.dur < 0.15) continue;
    const parts = tk.text.replace(/\([^)]*\)/g, '').replace(/[*^%]/g, '').split('~');
    for (const n of [parts[0], parts[parts.length - 1]]) if (n && out[out.length - 1] !== n) out.push(n);
  }
  return out;
}

// ---------------------------------------------------------------------------
const MODES = [
  ['along', 'Sing along', 'The song plays and you sing with it'],
  ['muted', 'Guide only', 'The song goes quiet; a clear tone plays the tune for you'],
  ['blind', 'Test yourself', 'The song plays, but your pitch line only shows after each pass, so your ear does the work'],
];
const SPEEDS = [0.5, 0.6, 0.75, 0.85, 1];
const SOUNDS = [['mix', 'Original'], ['vocals', 'Voice only'], ['karaoke', 'Backing track']];
const fmtSpeed = (v) => (v === 1 ? '1×' : v + '×');
const signed = (x) => (x > 0 ? '+' : x < 0 ? '−' : '') + Math.abs(Math.round(x));
const pct = (x) => Math.round(x * 100) + '%';

export class SongStudio {
  constructor(root) {
    this.root = root;
    this.song = null; this.player = null; this.mel = null; this.source = 'youtube';
    this.speed = 1; this.loopOn = false; this.loop = null; this.mode = 'along'; this.guideOn = false; this.sound = 'mix';
    this.follower = new Follower();
    this.frames = []; this.takeStart = null; this.phrases = [];
    this.collect = true;
    this.coach = { active: false }; // the line coach loads on first use (js/riff.js)
    this.build();
    this.lyrics = new LyricsPanel(this.lyricsEl, this);
    import('./device.js').then((m) => (this.device = m)).catch(() => {}); // browser checks (tab capture support)
  }

  // ---- layout ---------------------------------------------------------------
  build() {
    const r = this.root;
    r.innerHTML = ''; r.classList.add('studio');
    // header: the song is the title; everything else is a chip or a menu
    this.titleText = h('span', { class: 'st-text' }, 'Songs');
    this.titleBtn = h('button', { class: 'song-title', 'aria-haspopup': 'menu', title: 'Your songs', onclick: (e) => this.openLibrary(e.currentTarget) }, this.titleText, icon('down', 22));
    this.subEl = h('span', { class: 'song-sub' });
    this.chipsEl = h('div', { class: 'chips' });
    this.statusEl = h('span', { class: 'status-line', role: 'status', 'aria-live': 'polite' });
    this.head = h('header', { class: 'studio-head' },
      h('div', { class: 'sh-text' }, h('div', { class: 'eyebrow' }, 'Songs'), this.titleBtn, h('div', { class: 'song-meta' }, this.subEl, this.chipsEl)),
      h('div', { class: 'sh-act' }, this.statusEl,
        h('button', { class: 'btn small add-btn', 'aria-label': 'Add song', onclick: () => this.toggleAdd() }, icon('plus', 15), h('span', { class: 'lbl' }, 'Add song')),
        h('button', { class: 'icon-btn', 'aria-label': 'More options', title: 'More', 'aria-haspopup': 'menu', onclick: (e) => this.openMore(e.currentTarget) }, icon('more', 20))));
    // adding a song
    this.ytInput = h('input', { type: 'url', placeholder: 'Paste a YouTube link', class: 'grow', 'aria-label': 'YouTube link', onkeydown: (e) => { if (e.key === 'Enter') this.addUrl(this.ytInput.value); } });
    const fileIn = h('input', { type: 'file', accept: 'audio/*,video/*', hidden: true, onchange: (e) => e.target.files[0] && this.addFile(e.target.files[0]) });
    const row = (ic, title, sub, onclick) => h('button', { class: 'li', onclick }, h('span', { class: 'li-ic' }, icon(ic, 18)), h('span', { class: 'li-text' }, h('strong', {}, title), h('small', {}, sub)), h('span', { class: 'li-end' }, icon('chevron', 16)));
    this.addBox = h('div', { class: 'add-box' },
      h('div', { class: 'list' },
        h('div', { class: 'yt-row' }, h('span', { class: 'li-ic' }, icon('link', 18)), this.ytInput, h('button', { class: 'btn primary small', onclick: () => this.addUrl(this.ytInput.value) }, 'Add')),
        row('upload', 'Import an audio file', 'MP3, M4A, WAV or a video file', () => fileIn.click()),
        row('record', 'Record from another tab', 'Spotify, YouTube Music, any site playing in Chrome', () => this.recordOtherTab())),
      fileIn);
    // stage: the pitch lane on the left, the video and the lyrics beside it
    this.overviewCanvas = h('canvas', { class: 'overview', title: 'Click to jump · drag to loop' });
    this.laneCanvas = h('canvas', { class: 'lane tall' });
    const ro = h('div');
    this.learnBtn = h('button', { class: 'btn small learn learn-pill', hidden: true, title: 'Step-by-step coaching for this part', onclick: () => this.learnLoop() }, icon('target', 15), 'Learn this part');
    this.overlay = h('div', { class: 'lane-overlay', hidden: true });
    this.laneWrap = h('div', { class: 'lane-wrap' }, this.laneCanvas, ro, this.learnBtn, this.overlay);
    this.readout = new LiveReadout(ro);
    this.transport = h('div', { class: 'transport' });
    this.coachBar = h('div', { class: 'coach-bar', hidden: true });
    this.playerBox = h('div', { class: 'player-box' });
    this.lyricsEl = h('section', { class: 'lyrics', 'aria-label': 'Lyrics' });
    this.stage = h('div', { class: 'stage' },
      h('div', { class: 'stage-main' }, this.overviewCanvas, this.laneWrap, this.transport, this.coachBar),
      h('aside', { class: 'stage-side' }, this.playerBox, this.lyricsEl));
    // below: the song's lines and the last take
    this.phraseBox = h('div', { class: 'phrases' });
    this.linesTools = h('div', { class: 'panel-tools' });
    this.feedback = h('div', { class: 'feedback' });
    this.lower = h('div', { class: 'lower' },
      h('section', { class: 'panel lines-panel' }, h('div', { class: 'panel-head' }, h('h3', {}, 'Lines'), this.linesTools), this.phraseBox),
      h('section', { class: 'panel take-panel' }, h('div', { class: 'panel-head' }, h('h3', {}, 'Last take')), this.feedback));
    // "Learn this line" reuses the stage; these hold its header, controls and results
    this.coachHead = h('div', { class: 'coach-head', hidden: true });
    this.coachOut = h('div', { class: 'coach-out', hidden: true });
    r.append(this.head, this.addBox, this.coachHead, this.stage, this.coachOut, this.lower);
    this.lane = new PitchLane(this.laneCanvas);
    this.lane.past = 2.5; this.lane.future = 5;
    this.overview = new Overview(this.overviewCanvas, { onSeek: (t) => this.seekTo(t), onLoop: (a, b) => this.setLoop(a, b, true) });
    this.buildTransport();
    this.renderFeedback(null);
    window.addEventListener('keydown', (e) => this.key(e));
    // how focus arrived decides who gets Space: Chrome marks a clicked button :focus-visible once a key
    // is pressed, so this is read when focus arrives, not at the keypress
    document.addEventListener('focusin', (e) => { this.kbFocus = !!(e.target.matches && e.target.matches(':focus-visible')); }, true);
  }

  buildTransport() {
    const t = this.transport; t.innerHTML = '';
    this.playBtn = h('button', { class: 'btn primary round big', title: 'Play / pause (Space)', 'aria-label': 'Play', onclick: () => this.toggle() }, icon('play', 22));
    this.timeEl = h('span', { class: 'mono time' }, '0:00');
    this.loopBtn = h('button', { class: 'btn small', title: 'Loop (L)', onclick: () => this.toggleLoop() }, icon('loop', 15), 'Loop');
    this.aBtn = h('button', { class: 'btn small ab', title: 'Loop start here ([)', 'aria-label': 'Loop start here', onclick: () => this.markAB('a') }, 'A');
    this.bBtn = h('button', { class: 'btn small ab', title: 'Loop end here (])', 'aria-label': 'Loop end here', onclick: () => this.markAB('b') }, 'B');
    this.speedBtn = h('button', { class: 'btn small', title: 'Speed (the pitch stays the same)', 'aria-haspopup': 'menu', onclick: (e) => this.openSpeed(e.currentTarget) });
    this.soundBtn = h('button', { class: 'btn small', title: 'What you hear', 'aria-haspopup': 'menu', onclick: (e) => this.openSound(e.currentTarget) });
    this.micBtn = h('button', { class: 'btn round mic-btn', 'aria-label': 'Microphone', onclick: () => this.toggleMic() });
    this.modeBtn = h('button', { class: 'btn small', title: 'How you sing with the song', 'aria-haspopup': 'menu', onclick: (e) => this.openMode(e.currentTarget) });
    t.append(
      h('div', { class: 'tgroup main' },
        h('button', { class: 'btn round', title: 'Previous line (↑)', 'aria-label': 'Previous line', onclick: () => this.stepPhrase(-1) }, icon('prev', 18)),
        this.playBtn,
        h('button', { class: 'btn round', title: 'Next line (↓)', 'aria-label': 'Next line', onclick: () => this.stepPhrase(1) }, icon('next', 18)),
        this.timeEl),
      h('div', { class: 'tgroup' }, this.loopBtn, this.aBtn, this.bBtn),
      h('div', { class: 'tgroup' }, this.speedBtn, this.soundBtn),
      h('div', { class: 'tgroup' }, this.micBtn, this.modeBtn));
    this.syncTransport();
  }
  syncTransport() {
    this.speedBtn.replaceChildren(icon('slow', 15), fmtSpeed(this.speed));
    const snd = SOUNDS.find((x) => x[0] === (this.sound || 'mix')) || SOUNDS[0];
    this.soundBtn.replaceChildren(icon('volume', 15), snd[1] + (this.guideOn ? ' + guide' : ''));
    this.modeBtn.replaceChildren((MODES.find((x) => x[0] === this.mode) || MODES[0])[1], icon('down', 14));
    this.syncMicBtn();
  }
  openSpeed(anchor) {
    menu(anchor, [{ head: 'Speed · the pitch stays the same' }, ...SPEEDS.map((v) => ({ label: fmtSpeed(v), checked: this.speed === v, onclick: () => this.setSpeed(v) }))]);
  }
  setSpeed(v) { this.speed = v; this.player && this.player.setRate(v); this.syncTransport(); }
  canStems() { return !!(this.player && this.player.kind === 'audio' && this.player.vocals); }
  openSound(anchor) {
    const ok = this.canStems();
    const why = !(this.player && this.player.kind === 'audio') ? (this.song && this.song.hasCopy ? 'Switch to the recorded copy first' : 'Needs a recorded copy or an audio file') : this.mel ? 'Needs voice separation: Analyse again (⋯ menu)' : 'Analyse the song first';
    const sw = h('input', { type: 'checkbox', checked: this.guideOn, 'aria-label': 'Guide tone', onchange: (e) => this.setGuide(e.target.checked) });
    const hp = h('input', { type: 'checkbox', checked: !!settings.headphones, 'aria-label': 'Headphones', onchange: (e) => saveSettings({ headphones: e.target.checked }) });
    menu(anchor, [
      ...SOUNDS.map(([v, label]) => ({ label, checked: (this.sound || 'mix') === v, disabled: v !== 'mix' && !ok, sub: v === 'mix' ? null : !ok ? why : v === 'vocals' ? 'The singer on their own' : 'Everything except the singer', onclick: () => this.setSound(v) })),
      ok && this.song && this.song.stemModel === 'spleeter' ? { head: 'Split with the Fast model. For a cleaner voice and backing, pick Balanced or Best in ⋯ and analyse again.' } : null,
      'sep',
      { el: h('label', { class: 'menu-switch' }, h('span', { class: 'mi-text' }, h('span', {}, 'Guide tone'), h('small', {}, 'The melody as a clear tone (G)')), sw) },
      { el: h('label', { class: 'menu-switch' }, h('span', { class: 'mi-text' }, h('span', {}, 'Headphones'), h('small', {}, 'On when you listen with headphones: cleaner tracking')), hp) },
    ]);
  }
  setGuide(on, auto = false) {
    this.guideOn = !!on; if (!auto) this.guideAuto = false; // switched by hand: modes leave it alone
    if (!this.guideOn) this.follower.set(0);
    this.syncTransport();
  }
  async setSound(mode) {
    if (mode !== 'mix' && !this.canStems()) {
      toast(this.player && this.player.kind === 'audio' ? 'Analyse the song first. That step separates the voice from the music.' : this.song && this.song.hasCopy ? 'Switch the source to the recorded copy to hear the voice or the backing on their own.' : 'Voice only and backing need the song\'s audio: import a file, or capture the YouTube song once.', 'info', 6000);
      return;
    }
    if (!this.player || this.player.kind !== 'audio') { this.sound = 'mix'; this.soundTarget = 'mix'; this.syncTransport(); return; }
    this.soundTarget = mode;
    this.setStatus(mode === 'mix' ? '' : mode === 'vocals' ? 'Preparing the voice…' : 'Preparing the backing track…');
    const player = this.player;
    await player.setSound(mode);
    if (this.soundTarget !== mode || this.player !== player) { if (this.player !== player) this.setStatus(''); return; } // a newer choice (or another song) took over
    this.sound = mode; this.setStatus(''); this.syncTransport();
  }
  openMode(anchor) { menu(anchor, MODES.map(([v, label, sub]) => ({ label, sub, checked: this.mode === v, onclick: () => this.setMode(v) }))); }
  setMode(m, quiet = false) {
    const was = this.mode;
    this.mode = m;
    this.player && this.player.mute(m === 'muted');
    if (!quiet) {
      if (m === 'muted' && !this.guideOn) { this.setGuide(true, true); this.guideAuto = true; } // the guide is the point of this mode
      else if (was === 'muted' && m !== 'muted' && this.guideAuto) { this.setGuide(false, true); }
      if (m !== 'muted') this.guideAuto = false;
    }
    this.syncTransport();
  }

  // ---- header: title, chips, menus ----------------------------------------------
  refreshTitle() {
    const s = this.song;
    this.titleText.textContent = s ? s.title || 'Untitled' : 'Songs';
    const sub = s ? s.note || '' : '';
    this.subEl.textContent = sub; this.subEl.hidden = !sub;
  }
  openLibrary(anchor) {
    const items = songs.map((s) => ({ label: s.title || s.id, sub: s.kind === 'youtube' ? (s.hasCopy ? 'YouTube · recorded copy' : 'YouTube') : 'Audio file', checked: !!(this.song && s.id === this.song.id), onclick: () => { if (!this.song || s.id !== this.song.id) this.open(s.id); } }));
    menu(anchor, [{ head: 'Your songs' }, ...items, 'sep', { label: 'Add a song', icon: 'plus', onclick: () => this.toggleAdd(true) }], { className: 'library' });
  }
  toggleAdd(open) {
    const on = open ?? !this.addBox.classList.contains('open');
    this.addBox.classList.toggle('open', on);
    if (on) setTimeout(() => this.ytInput.focus(), 60);
  }
  openMore(anchor) {
    const s = this.song;
    if (!s) return menu(anchor, [{ label: 'Add a song', icon: 'plus', onclick: () => this.toggleAdd(true) }], { align: 'end' });
    const yt = this.source === 'youtube', q = effectiveQuality();
    menu(anchor, [
      { label: this.mel ? (yt ? 'Build the melody guide again' : 'Analyse again') : (yt ? 'Build the melody guide' : 'Analyse the song'), icon: 'sparkle', disabled: this.busy, onclick: () => (yt ? this.captureTab() : this.analyzeAudio()) },
      { head: HAS_GPU ? 'Analysis quality' : 'Analysis quality · no graphics acceleration here' },
      ...QUALITY.map(([v, label, tip]) => ({ label, sub: qualitySub(v, tip), checked: q === v, disabled: v === 'best' && !HAS_GPU, onclick: () => pickQuality(v) })),
      'sep',
      { label: 'Fix the melody guide', icon: 'edit', disabled: !this.mel, onclick: () => this.openFix() },
      { label: 'Keyboard shortcuts', icon: 'keyboard', onclick: () => this.openKeys() },
      { label: 'Check this device', icon: 'device', onclick: () => { location.hash = '#settings/device'; } },
      'sep',
      { label: 'Remove from library', icon: 'trash', danger: true, onclick: () => this.remove() },
    ], { align: 'end' });
  }
  // Small header chips that open a popover with the detail.
  chipEl(key, label, value, { tone = '', title = '', onclick } = {}) {
    this._chips = this._chips || new Map();
    let el = this._chips.get(key);
    if (!el) {
      el = h('button', { class: 'chip-btn', 'aria-haspopup': 'dialog', onclick: (e) => el._on && el._on(e) }, h('span', { class: 'cl' }), h('span', { class: 'cv' }));
      this._chips.set(key, el);
    }
    el._on = onclick; el.className = 'chip-btn' + (tone ? ' tone-' + tone : ''); el.title = title;
    el.firstChild.textContent = label || ''; el.firstChild.hidden = !label; el.lastChild.textContent = value;
    return el;
  }
  renderInfo() {
    const s = this.song;
    this.refreshTitle();
    const out = [];
    if (s && this.mel) {
      const m = hzToMidi(this.songSa), pm = hzToMidi(this.practiceSa);
      const moved = Math.round(pm) !== Math.round(m);
      out.push(this.chipEl('key', isIndian(settings) ? 'Sa' : 'Key', westernName(m) + (moved ? ' → ' + westernName(pm) : ''), { title: 'Key note and transposition', onclick: (e) => this.openKey(e.currentTarget) }));
      const rf = this.rangeFit();
      out.push(this.chipEl('range', 'Range', rf.span, { tone: rf.tone, title: rf.title, onclick: (e) => this.openRange(e.currentTarget) }));
    }
    if (s && s.kind === 'youtube' && s.hasCopy) out.push(this.chipEl('src', 'Source', this.source === 'youtube' ? 'Video' : 'Recorded copy', { title: 'Play the video or the recorded copy', onclick: (e) => this.openSource(e.currentTarget) }));
    if (s && this.mel && !s[this.source + 'Separated']) out.push(this.chipEl('rough', '', 'Rough guide', { tone: 'warn', title: 'Traced from the full mix', onclick: (e) => this.openRough(e.currentTarget) }));
    this.chipsEl.replaceChildren(...out);
    this.renderEmpty();
  }
  rangeFit() {
    const shift = (this.source === 'audio' ? this.song.transpose || 0 : 0) + 12 * (this.song.octave || 0);
    const span = `${westernName(hzToMidi(this.melP5) + shift)}–${westernName(hzToMidi(this.melP95) + shift)}`;
    if (settings.rangeLowMidi == null) return { span, tone: '', title: 'Melody range. Do the range test for a key suggestion.' };
    const lo = hzToMidi(this.melP5) + shift, hi = hzToMidi(this.melP95) + shift;
    const over = Math.max(0, Math.round(hi - (settings.rangeHighMidi - 1))), under = Math.max(0, Math.round((settings.rangeLowMidi + 1) - lo));
    return { span, over, under, tone: over || under ? 'warn' : 'good', title: over || under ? 'Partly outside your comfortable range' : 'Fits your range' };
  }
  popHead(label, big, sub) { return h('div', { class: 'pop-head' }, h('div', { class: 'kp-label' }, label), h('div', { class: 'kp-big' }, big, sub ? h('small', {}, sub) : null)); }
  openKey(anchor) {
    const s = this.song;
    const box = h('div', { class: 'keypop' });
    const draw = () => {
      const m = hzToMidi(this.songSa), cents = Math.round((m - Math.round(m)) * 100);
      const cands = (s[this.source + 'SaCands'] || []).filter((hz) => Math.abs(1200 * Math.log2(hz / this.songSa)) > 50).slice(0, 3);
      const stepper = (label, value, dec, inc, disabled) => h('div', { class: 'stepper' }, h('span', { class: 'sp-l' }, label),
        h('div', { class: 'sp-c' }, h('button', { class: 'btn small round', 'aria-label': label + ' down', disabled, onclick: dec }, '−'), h('span', { class: 'sp-v' }, value), h('button', { class: 'btn small round', 'aria-label': label + ' up', disabled, onclick: inc }, '+')));
      const tr = this.player && this.player.kind === 'audio' && this.player.st0 != null ? this.player.st0 : s.transpose || 0, oc = s.octave || 0;
      const trTo = (v) => { const p = this.setTranspose(v); draw(); p.then(draw); };
      box.replaceChildren(...[
        this.popHead(isIndian(settings) ? 'Song Sa' : 'Song key note', westernName(m), cents ? ` ${signed(cents)}¢` : ''),
        h('div', { class: 'row wrap kp-nudge' },
          h('button', { class: 'btn small', onclick: () => { this.nudgeSa(-100); draw(); } }, '−1 st'),
          h('button', { class: 'btn small', onclick: () => { this.nudgeSa(100); draw(); } }, '+1 st'),
          h('button', { class: 'btn small', onclick: () => { this.nudgeSa(-10); draw(); } }, '−10¢'),
          h('button', { class: 'btn small', onclick: () => { this.nudgeSa(10); draw(); } }, '+10¢')),
        cands.length ? h('div', { class: 'kp-alt' }, 'Or ', ...cands.map((hz, i) => [i ? ' · ' : '', h('button', { class: 'linkish', onclick: () => { this.setSa(hz); draw(); } }, westernName(hzToMidi(hz)))])) : null,
        h('p', { class: 'kp-hint' }, 'Phrases usually come to rest on the key note: the bold line.'),
        h('div', { class: 'kp-sep' }),
        h('div', { class: 'kp-label' }, 'You sing it'),
        stepper('Transpose', (tr > 0 ? '+' : '') + tr + ' st', () => trTo(tr - 1), () => trTo(tr + 1), this.source !== 'audio'),
        this.source !== 'audio' ? h('p', { class: 'kp-hint' }, s.hasCopy ? 'Transposing works on the recorded copy (Source chip).' : 'To transpose, build the guide once. That saves a recorded copy.') : null,
        stepper('Octave', ['Lower', 'Same', 'Higher'][oc + 1], () => { this.setOctave(oc - 1); draw(); }, () => { this.setOctave(oc + 1); draw(); })].filter(Boolean));
    };
    draw();
    popover(anchor, box, { className: 'wide' });
  }
  openRange(anchor) {
    const rf = this.rangeFit();
    const box = h('div', { class: 'keypop' }, this.popHead('Melody range', rf.span));
    if (settings.rangeLowMidi == null) {
      box.append(h('p', { class: 'kp-hint' }, 'Find your comfortable range (2 minutes) to see whether this song suits your voice.'), h('a', { class: 'btn small', href: '#practice/range' }, 'Find my range'));
    } else {
      const yours = `${westernName(settings.rangeLowMidi)}–${westernName(settings.rangeHighMidi)}`;
      box.append(h('p', { class: 'kp-line' }, h('span', { class: 'muted' }, 'Your range '), yours));
      box.append(h('p', { class: 'kp-line ' + (rf.tone || '') }, rf.over ? `Goes ${rf.over} semitone${rf.over > 1 ? 's' : ''} above your comfortable top.` : rf.under ? `Goes ${rf.under} semitone${rf.under > 1 ? 's' : ''} below your comfortable bottom.` : 'Fits your range.'));
      const fit = fitToRange(this.melP5, this.melP95, settings.rangeLowMidi, settings.rangeHighMidi);
      const cur = { st: this.source === 'audio' ? this.song.transpose || 0 : 0, oct: this.song.octave || 0 };
      if (fit && (fit.best.st !== cur.st || fit.best.oct !== cur.oct) && (rf.over || rf.under)) {
        const b = fit.best, what = [b.oct ? `octave ${b.oct > 0 ? 'up' : 'down'}` : '', b.st ? `${b.st > 0 ? '+' : ''}${b.st} semitones` : ''].filter(Boolean).join(', ') || 'the original key';
        box.append(h('div', { class: 'row spread kp-fit' }, h('span', {}, 'Best for you: ', h('strong', {}, what)), h('button', { class: 'btn small primary', onclick: () => { closePopover(); this.applyFit(b); } }, 'Apply')));
      }
    }
    popover(anchor, box, { className: 'wide' });
  }
  openSource(anchor) {
    menu(anchor, [
      { label: 'YouTube video', sub: 'The original, in step with the video', checked: this.source === 'youtube', onclick: () => this.switchSource('youtube') },
      { label: 'Recorded copy', sub: 'Transpose it, and hear the voice or the backing alone', checked: this.source === 'audio', onclick: () => this.switchSource('audio') },
    ]);
  }
  openRough(anchor) {
    const yt = this.source === 'youtube';
    menu(anchor, [
      { head: 'Traced from the full mix, so instruments can pull the line off the voice.' },
      { label: yt ? 'Build it again with voice separation' : 'Analyse again with voice separation', icon: 'sparkle', disabled: this.busy, onclick: () => (yt ? this.captureTab() : this.analyzeAudio()) },
    ]);
  }
  qualityPill() {
    const cur = () => (QUALITY.find((x) => x[0] === effectiveQuality()) || QUALITY[1]);
    const btn = h('button', { class: 'btn small soft', 'aria-haspopup': 'menu', title: 'Voice separation quality', onclick: (e) => menu(e.currentTarget, [{ head: HAS_GPU ? 'Voice separation' : 'Voice separation · no graphics acceleration in this browser' }, ...QUALITY.map(([v, label, tip]) => ({ label, sub: qualitySub(v, tip), checked: cur()[0] === v, disabled: v === 'best' && !HAS_GPU, onclick: () => { pickQuality(v); btn.replaceChildren(cur()[1], icon('down', 14)); } }))], { align: 'center' }) }, cur()[1], icon('down', 14));
    gpuChecked.then(() => { if (btn.isConnected) btn.replaceChildren(cur()[1], icon('down', 14)); });
    return btn;
  }
  // The empty lane before a melody guide exists: one clear action.
  renderEmpty() {
    if (this.busy) return;
    if (!this.song || this.mel) { this.hideOverlay(); return; }
    const yt = this.source === 'youtube';
    this.showOverlay('center', h('div', { class: 'empty' },
      h('div', { class: 'empty-ic' }, icon('wave', 26)),
      h('h3', {}, 'Build the melody guide'),
      h('p', {}, yt ? 'The song plays once while the voice is traced. When Chrome asks, pick this tab and keep “Also share tab audio” on.' : 'The voice is separated from the music and traced. It runs on this device.'),
      h('div', { class: 'row center wrap' },
        h('button', { class: 'btn primary', onclick: () => (yt ? this.captureTab() : this.analyzeAudio()) }, icon(yt ? 'headphones' : 'sparkle', 16), yt ? 'Start' : 'Analyse'),
        this.qualityPill())));
  }
  showOverlay(kind, ...kids) { const o = this.overlay; o.hidden = false; o.className = 'lane-overlay ' + kind; o.replaceChildren(...kids); }
  hideOverlay() { this.overlay.hidden = true; this.overlay.replaceChildren(); }
  openFix() {
    const syncOut = h('span', { class: 'mono' }, (this.song.sync || 0) + ' ms');
    const sync = h('input', { type: 'range', min: -400, max: 400, step: 10, value: this.song.sync || 0, oninput: (e) => { this.song.sync = +e.target.value; syncOut.textContent = this.song.sync + ' ms'; }, onchange: () => upsertSong(this.song) });
    const btn = (label, op) => h('button', { class: 'btn small', onclick: () => this.editRegion(op) }, label);
    sheet('Fix the melody guide', h('div', { class: 'fix' },
      h('p', { class: 'muted' }, 'Instruments can pull the guide off the voice. Loop the bad stretch first (drag on the strip above the lane), then:'),
      h('div', { class: 'row wrap' }, btn('Octave up', 'up'), btn('Octave down', 'down'), btn('Erase (not the singer)', 'erase'), h('button', { class: 'btn small ghost', onclick: () => this.undoEdit() }, 'Undo')),
      h('div', { class: 'kp-sep' }),
      h('label', { class: 'ctl' }, 'Guide timing ', sync, ' ', syncOut),
      h('p', { class: 'small muted' }, 'If the guide is always a little ahead of or behind the singer, slide this until they line up.')));
  }
  openKeys() {
    const rows = [['Space', 'Play or pause'], ['↑ ↓', 'Previous or next line'], ['← →', 'Back or forward 2 s'], ['[ ]', 'Loop start or end'], ['L', 'Loop on or off'], ['M', 'Microphone'], ['G', 'Guide tone']];
    sheet('Keyboard shortcuts', h('dl', { class: 'keys' }, ...rows.flatMap(([k, v]) => [h('dt', {}, ...k.split(' ').map((x) => h('kbd', {}, x))), h('dd', {}, v)])));
  }

  // ---- library ---------------------------------------------------------------
  refreshSelect() { this.refreshTitle(); }
  async activate() {
    this.active = true;
    if (!this.song && !this.opening) this.opening = this.open(lastSong.get() && getSong(lastSong.get()) ? lastSong.get() : songs[0] && songs[0].id);
    else this.refreshTitle();
    this.loopRAF();
    return this.opening;
  }
  deactivate() {
    this.active = false;
    cancelAnimationFrame(this.raf);
    if (this.player && this.player.playing) this.player.pause();
    this.follower.set(0);
    closePopover();
  }
  // Sub-routes: #songs/learn/<line> or #songs/learn/<a>-<b> open the line coach.
  async route(sub, arg) {
    await this.opening;
    if (sub === 'learn' && arg != null) {
      let range = null;
      if (/^\d+$/.test(arg)) { const p = this.phrases[+arg]; if (p) range = { a: p.start, b: p.end, phrase: +arg }; }
      else { const m = String(arg).match(/^(\d+(?:\.\d+)?)-(\d+(?:\.\d+)?)$/); if (m && +m[2] > +m[1] + 0.3) range = { a: +m[1], b: +m[2], phrase: null }; }
      if (!range || !this.mel) { location.replace('#songs'); return; }
      if (!this.coach.open) {
        try { const { RiffCoach } = await import('./riff.js'); if (!this.coach.open) this.coach = new RiffCoach(this); }
        catch (e) { console.error(e); toast('The line coach couldn\'t load.', 'bad'); location.replace('#songs'); return; }
      }
      if (this.coach.active) this.closeCoach();
      this.coach.open(range);
    } else if (this.coach.active) this.closeCoach();
  }
  closeCoach() {
    this.coach.close();
    this.syncLoopUI(); this.renderPhrases(); this.syncTransport();
  }
  learnRange(a, b, phrase) { location.hash = '#songs/learn/' + (phrase != null ? phrase : `${a.toFixed(2)}-${b.toFixed(2)}`); }
  learnLoop() {
    if (this.curPhrase != null && this.loopOn) return this.learnRange(0, 0, this.curPhrase);
    if (this.loop) this.learnRange(this.loop.a, this.loop.b, null);
  }
  onLyrics() {
    this.refreshTitle();
    this.renderPhrases();
    if (this.coach.active && this.coach.onLyrics) this.coach.onLyrics();
  }

  // Stop whatever is playing (and the guide tone) before the player goes away.
  stopPlayer() {
    if (!this.player) return;
    this.finishTake(true); // a take on the old song isn't scored against the next one
    try { if (this.player.playing) this.player.pause(); } catch {}
    this.follower.set(0);
    this.player.destroy(); this.player = null;
    this.onState(2);
  }
  resetTake() {
    this.finishTake(true);
    this.curPhrase = null; this.lastTakeFrames = null; this.lastTake = null;
    this.renderFeedback(null);
  }
  guardBusy() {
    if (!this.busy) return false;
    toast('Wait for the current capture or analysis to finish first.', 'info');
    return true;
  }
  async open(id) {
    if (this.guardBusy()) return;
    if (this.coach.active) { this.closeCoach(); if (/^#songs\/learn/.test(location.hash)) history.replaceState(null, '', '#songs'); }
    closePopover();
    this.resetTake();
    this.stopPlayer();
    this.lyrics.load(null);
    // forget the previous song at once, so nothing of it stays clickable while the next one loads
    this.undo = null; this.mel = null; this.phrases = []; this.soundTarget = 'mix'; this.setStatus('');
    this.overview.mel = null; this.overview.phrases = []; this.overview.loop = null;
    this.lane.refAt = null; this.lane.labels = []; this.lane.regions = []; this.lastTakeFrames = null;
    this.readout.update(NaN); this.hideOverlay();
    this.chipsEl.replaceChildren(); this.renderPhrases();
    if (!id || !getSong(id)) {
      this.song = null; this.mel = null; this.phrases = [];
      this.playerBox.replaceChildren(h('div', { class: 'player-empty' }, h('p', {}, 'Add a song to begin.'), h('button', { class: 'btn primary small', onclick: () => this.toggleAdd(true) }, icon('plus', 15), 'Add song')));
      this.overview.mel = null; this.overview.phrases = []; this.overview.duration = 0;
      this.lane.refAt = null; this.lane.labels = []; this.lane.message = 'No song yet';
      this.renderInfo(); this.renderPhrases();
      return;
    }
    const s = getSong(id);
    const token = (this.openToken = (this.openToken || 0) + 1);
    this.song = s; lastSong.set(id);
    s.octave = s.octave || 0; s.transpose = s.transpose || 0; s.best = s.best || {}; s.sync = s.sync || 0;
    this.source = s.kind === 'audio' ? 'audio' : (s.useCopy && s.hasCopy ? 'audio' : 'youtube');
    this.refreshTitle();
    this.loop = null; this.pendingA = null; this.loopOn = false; this.syncLoopUI();
    this.sound = 'mix'; this.soundTarget = 'mix'; this.syncTransport();
    await this.mountPlayer();
    if (token !== this.openToken) return; // a newer open() took over
    await this.loadMelody();
    if (token !== this.openToken) return;
    this.renderInfo();
    this.lyrics.load(s);
  }

  async mountPlayer() {
    const s = this.song;
    this.playerBox.innerHTML = '';
    if (this.source === 'youtube') {
      const holder = h('div'); const frame = h('div', { class: 'yt' }, holder);
      this.playerBox.append(frame);
      this.player = new YTPlayer(holder, s.videoId, {
        onState: (st) => this.onState(st),
        onError: (code) => {
          const why = code === 100 ? 'This video is private or was removed.' : 'YouTube won\'t play this video here.';
          this.playerBox.append(h('div', { class: 'warn' }, why, ' ', h('a', { href: 'https://www.youtube.com/watch?v=' + s.videoId, target: '_blank', rel: 'noopener' }, 'Open it on YouTube'), ', then use Add song → Record from another tab.', code === 101 || code === 150 ? h('span', { class: 'warn-more' }, ' "Too many devices"? Close other YouTube tabs and reload.') : null));
        },
        onReady: (p) => {
          if (!s.titleFetched) {
            const t = p.title();
            if (t) { s.title = t; s.titleFetched = true; upsertSong(s); if (this.song === s) { this.refreshTitle(); if (this.lyrics.state === 'none' && !s.lyricsTried) this.lyrics.load(s); } }
          }
        },
      });
      await Promise.race([this.player.ready, new Promise((r) => setTimeout(r, 8000))]);
    } else {
      const blob = await idbGet('audio', s.id);
      if (!blob) { this.playerBox.append(h('div', { class: 'warn' }, 'The audio for this song is missing from this browser. Add it again.')); return; }
      this.player = new AudioPlayer(blob, { onState: (st) => this.onState(st) });
      await this.player.ready;
      this.playerBox.append(h('div', { class: 'audio-cover' }, h('div', { class: 'ac-ic' }, icon('songs', 22)), h('div', { class: 'ac-text' }, h('strong', {}, s.title), h('small', {}, s.kind === 'youtube' ? 'Recorded copy of the video' : 'Audio file · ' + fmtTime(this.player.duration())))));
      const stem = await idbGet('audio', s.id + ':vocals');
      if (stem && this.player) this.player.setVocals(fromI16(stem));
      this.sound = 'mix'; this.soundTarget = 'mix'; this.syncTransport();
      if (s.transpose) await this.player.setTranspose(s.transpose);
    }
    this.player.setRate(this.speed);
    if (this.mode === 'muted') this.player.mute(true);
  }

  async loadMelody() {
    const s = this.song;
    this.mel = unpackMelody(await idbGet('melody', s.id + ':' + this.source));
    this.analyzeMelody();
  }
  analyzeMelody() {
    const s = this.song, mel = this.mel;
    this.phrases = mel ? findPhrases(mel) : [];
    if (mel) {
      const key = this.source + 'Sa';
      if (!s[key]) { const ton = estimateTonic(mel); s[key] = ton.saHz; s[key + 'Cands'] = ton.candidates.map((c) => c.saHz); upsertSong(s); }
      const v = []; for (const x of mel.cents) if (!isNaN(x)) v.push(x);
      this.melP5 = F_REF * Math.pow(2, percentile(v, 0.05) / 1200); this.melP95 = F_REF * Math.pow(2, percentile(v, 0.95) / 1200);
    }
    this.overview.mel = mel; this.overview.phrases = this.phrases;
    if (mel && this.source === 'audio' && this.player && this.player.kind === 'audio' && this.player.setGate) this.player.setGate(voiceGate(mel, this.player.duration() || melodyDuration(mel)));
    this.refreshKey();
    this.renderPhrases();
    if (this.lyrics && this.lyrics.song === s) this.lyrics.realign();
  }
  get songSa() { return (this.song && this.song[this.source + 'Sa']) || saHzFrom(settings); }
  get practiceSa() {
    if (!this.song) return saHzFrom(settings);
    return this.songSa * Math.pow(2, ((this.source === 'audio' ? this.song.transpose || 0 : 0) + 12 * (this.song.octave || 0)) / 12);
  }
  refAt = (t) => {
    if (!this.mel) return NaN;
    const v = melodyAt(this.mel, t - (this.song.sync || 0) / 1000);
    return isNaN(v) ? NaN : v - cAbove55(this.songSa);
  };
  refreshKey() {
    this.lane.saHz = this.practiceSa; this.lane.tuning = settings.tuning; this.lane.notation = settings.notation;
    this.lane.tol = settings.tol; this.lane.octaveFree = settings.octaveFree;
    this.lane.refAt = this.mel ? this.refAt : null;
    this.lane.message = '';
    this.labelTokens = [];
    if (this.mel) for (const p of this.phrases) {
      const toks = transcribe(this.refAt, p.start, p.end, { tuning: settings.tuning, notation: settings.notation, saHz: this.practiceSa });
      const west = !isIndian(settings);
      const bare = (x) => (west ? x.replace(/-?\d+$/, '') : x); // "G3" -> "G" in line text
      p.sargam = settings.showOrnaments ? toks.map((x) => x.text.replace(/[A-G]#?-?\d+/g, bare)).join(' ') : simpleNotes(toks).map(bare).join(' ');
      let lastT = -1;
      for (const tk of toks) if (tk.dur >= 0.12 && tk.t - lastT > 0.2) { this.labelTokens.push({ t: tk.t, c: (tk.idx + 12 * tk.oct) * 100, text: bare(tk.text.replace(/^\([^)]*\)/, '').replace(/~.*/, '').replace(/[*^%]/g, '')) }); lastT = tk.t; }
    }
    this.lane.labels = settings.showLabels === false ? [] : this.labelTokens;
    if (tanpura.on) tanpura.start(this.practiceSa, settings.tanpuraFirst);
    this.renderInfo();
  }
  nudgeSa(c) { this.setSa(this.songSa * Math.pow(2, c / 1200)); }
  setSa(hz) { this.song[this.source + 'Sa'] = hz; upsertSong(this.song); this.refreshKey(); this.renderPhrases(); }
  setOctave(o) { o = Math.max(-1, Math.min(1, o)); this.song.octave = o; upsertSong(this.song); this.refreshKey(); }
  async applyFit(b) {
    this.song.octave = b.oct;
    if (b.st && this.source !== 'audio') toast(this.song.hasCopy ? `Switch the source to the recorded copy to transpose by ${b.st} semitones.` : 'To transpose a YouTube song, build the guide once. That saves a recorded copy you can transpose.', 'info', 6000);
    else if (b.st || this.source === 'audio') await this.setTranspose(b.st);
    upsertSong(this.song); this.refreshKey();
  }
  async setTranspose(st) {
    st = Math.max(-6, Math.min(6, st));
    if (this.source !== 'audio' || !this.player) return;
    if (st === (this.song.transpose || 0) && this.player.st0 === st) return;
    const song = this.song, player = this.player;
    this.setStatus('Transposing…');
    await player.setTranspose(st);
    if (this.song !== song || this.player !== player) return; // another song took over meanwhile
    if (player.st0 !== st) return; // a newer choice is on its way and saves itself
    song.transpose = st; upsertSong(song); this.refreshKey();
    this.setStatus('');
  }
  async switchSource(src) {
    if (src === this.source || this.guardBusy()) return;
    this.resetTake();
    this.source = src; this.song.useCopy = src === 'audio'; upsertSong(this.song);
    this.stopPlayer(); this.undo = null;
    await this.mountPlayer(); await this.loadMelody();
    if (!this.mel && src === 'audio') await this.analyzeAudio();
    this.renderInfo();
  }
  setStatus(t) { this.statusEl.textContent = t; this.statusEl.classList.toggle('on', !!t); }
  // Progress card for long jobs: ring, steps, time left, a faster option.
  showProgress(step, p, info = {}) {
    let box = this.overlay.querySelector('.analysis');
    const eq = effectiveQuality(), want = eq === 'best' ? 'roformer' : eq === 'fast' ? 'spleeter' : 'kim';
    if (step === 'fallback') {
      if (box) { box.dataset.model = info.model; this.buildSteps(box); }
      toast(info.reason === 'nogpu' ? 'Best quality needs a graphics card (WebGPU) in this browser, so Balanced is being used.' : info.reason === 'user' ? 'Switched to Balanced.' : 'Best quality couldn\'t run here, so Balanced is being used.', 'info', 6000);
      return;
    }
    if (!box) {
      const C = 2 * Math.PI * 26;
      box = h('div', { class: 'analysis', role: 'status', 'aria-live': 'polite' },
        h('div', { class: 'ring', html: `<svg viewBox="0 0 64 64" aria-hidden="true"><circle class="track" cx="32" cy="32" r="26"/><circle class="fill" cx="32" cy="32" r="26" stroke-dasharray="${C}" stroke-dashoffset="${C}"/></svg><span class="pct">0%</span>` }),
        h('div', { class: 'a-body' },
          h('div', { class: 'a-title' }, 'Analysing the song'),
          h('ol', { class: 'a-steps' }),
          h('div', { class: 'a-meta' }),
          h('div', { class: 'a-foot' },
            h('button', { class: 'btn small a-faster', onclick: () => { useFastModel(); box.querySelector('.a-faster').disabled = true; box.querySelector('.a-faster').textContent = 'Switching…'; } }, 'Use a faster model'),
            h('span', { class: 'a-note' }, 'Runs on this device. Each song is analysed once, then saved.'))));
      box.dataset.model = want;
      this.buildSteps(box);
      this.showOverlay('center solid', box);
    }
    if (info.model && info.model !== box.dataset.model) { box.dataset.model = info.model; this.buildSteps(box); }
    if (step === 'build') { box.classList.add('indeterminate'); box.querySelector('.a-title').textContent = 'Building the melody'; return; }
    box.classList.remove('indeterminate');
    const steps = box._steps, idx = Math.max(0, steps.findIndex(([k]) => k === step));
    let overall = 0;
    steps.forEach(([k, , w], i) => { overall += i < idx ? w : i === idx ? w * Math.min(1, p || 0) : 0; });
    const C = 2 * Math.PI * 26;
    box.querySelector('.fill').style.strokeDashoffset = String(C * (1 - overall));
    box.querySelector('.pct').textContent = Math.round(overall * 100) + '%';
    box.querySelectorAll('.a-steps li').forEach((li, i) => { li.className = i < idx ? 'done' : i === idx ? 'cur' : ''; });
    if (step === 'download' && info.totalMb) box.querySelector('[data-s="download"] .a-sub').textContent = `${Math.round(info.mb)} of ${Math.round(info.totalMb)} MB · saved in your browser for next time`;
    const meta = [];
    const eta = info.eta;
    if (step === 'separate' && eta != null && p > 0) meta.push(eta > 90 ? `About ${Math.round(eta / 60)} minutes left` : eta > 50 ? 'About a minute left' : eta > 8 ? `About ${Math.round(eta / 5) * 5} seconds left` : 'Almost done');
    if (info.gpu != null) meta.push(info.gpu ? 'Using your graphics card' : box.dataset.model === 'spleeter' ? 'Using your processor' : 'Using your processor, so this can take a while');
    if (meta.length) box.querySelector('.a-meta').textContent = meta.join(' · ');
    box.querySelector('.a-faster').hidden = box.dataset.model === 'spleeter' || step === 'trace';
  }
  buildSteps(box) {
    const m = box.dataset.model;
    const name = { roformer: 'Mel-RoFormer (best quality)', kim: 'Kim Vocal 2 (balanced)', spleeter: 'Spleeter (fast)' }[m];
    const size = { roformer: '464 MB', kim: '67 MB', spleeter: '39 MB' }[m];
    box._steps = [['prepare', 'Preparing the audio', 0.03]]
      .concat(m === 'roformer' ? [['download', 'Downloading the model', 0.12]] : [])
      .concat([['load', 'Loading the voice-separation model', 0.05], ['separate', 'Separating the voice from the music', m === 'roformer' ? 0.62 : 0.82]])
      .concat(m === 'roformer' ? [['refine', 'Refining with a second model', 0.10]] : [])
      .concat([['trace', 'Tracing the melody', 0.08]]);
    const ol = box.querySelector('.a-steps'); ol.innerHTML = '';
    for (const [k, label] of box._steps) ol.append(h('li', { 'data-s': k }, h('span', { class: 'a-dot' }), h('span', { class: 'a-label' }, label), h('span', { class: 'a-sub' }, k === 'load' ? `${name} · ${size}${m === 'roformer' ? '' : ', downloaded once'}` : k === 'download' ? `${size}, once · saved in your browser for next time` : k === 'refine' ? 'Kim Vocal 2, blended in for extra accuracy' : '')));
  }
  hideProgress() { this.hideOverlay(); if (!this.mel && !this.busy) this.renderEmpty(); }

  // ---- lines -----------------------------------------------------------------------
  renderPhrases() {
    const b = this.phraseBox; b.innerHTML = '';
    this.linesTools.innerHTML = '';
    this.phraseEls = null;
    if (!this.song || !this.phrases || !this.phrases.length) { b.append(h('p', { class: 'empty-note' }, this.mel ? 'No lines found.' : 'The song\'s lines appear here once the melody guide is built.')); return; }
    const orn = h('input', { type: 'checkbox', checked: !!settings.showOrnaments, 'aria-label': 'Show ornaments', onchange: (e) => { saveSettings({ showOrnaments: e.target.checked }); this.refreshKey(); this.renderPhrases(); } });
    this.linesTools.append(h('label', { class: 'ctl small', title: 'Show slides, shakes and grace notes' }, 'Ornaments', orn));
    const list = h('ol', { class: 'phrase-list' });
    this.phraseEls = this.phrases.map((p, i) => {
      const best = this.song.best[i];
      const words = this.lyrics ? this.lyrics.textBetween(p.start, p.end) : '';
      const li = h('li', { class: this.curPhrase === i ? 'cur' : '', tabindex: 0, role: 'button', 'aria-current': this.curPhrase === i ? 'true' : null, 'aria-label': `Loop line ${i + 1}${words ? ': ' + words : ''}`, onclick: () => this.loopPhrase(i), onkeydown: (e) => { if ((e.key === 'Enter' || e.key === ' ') && e.target === li) { e.preventDefault(); this.loopPhrase(i); } } },
        h('span', { class: 'ptime mono' }, fmtTime(p.start)),
        h('span', { class: 'ptext' }, words ? h('span', { class: 'pwords' }, words) : null, h('span', { class: 'psargam' }, p.sargam || '')),
        h('span', { class: 'pbest ' + (best >= 75 ? 'good' : best >= 50 ? 'ok' : best != null ? 'bad' : '') }, best != null ? String(best) : ''),
        h('button', { class: 'plearn', title: 'Learn this line step by step', 'aria-label': `Learn line ${i + 1}`, onclick: (e) => { e.stopPropagation(); this.learnRange(p.start, p.end, i); } }, icon('target', 16)));
      list.append(li);
      return li;
    });
    b.append(list);
    if (settings.showOrnaments) b.append(h('p', { class: 'legend' }, isIndian(settings) ? '~ meend · * gamak · (x) kan swar · ' : '~ slide · * shake · (x) grace note · ', h('a', { href: '#learn' }, 'more')));
    this.playingLine = -1;
  }
  loopPhrase(i) {
    const p = this.song && this.phrases && this.phrases[i]; if (!p) return;
    this.setLoop(Math.max(0, p.start - 0.4), p.end + 0.5, true);
    this.curPhrase = i; // set after setLoop, which clears it for custom loops
    this.player && this.player.seek(this.loop.a);
    this.renderPhrases(); this.syncLoopUI();
  }
  stepPhrase(d) {
    if (!this.phrases || !this.phrases.length) return;
    const t = this.player ? this.player.time() : 0;
    let i = this.curPhrase != null ? this.curPhrase + d : this.phrases.findIndex((p) => p.end > t);
    i = Math.max(0, Math.min(this.phrases.length - 1, i));
    this.loopPhrase(i);
  }
  setLoop(a, b, on) {
    if (!isFinite(a) || !isFinite(b) || b <= a) return;
    this.loop = { a, b }; this.pendingA = null;
    this.curPhrase = null; // a custom loop isn't one of the detected lines
    if (on) this.loopOn = true;
    this.syncLoopUI();
    this.finishTake(true);
  }
  toggleLoop() {
    if (!this.loop) return toast('Pick a line below, drag on the strip above the lane, or set A and B.', 'info');
    this.loopOn = !this.loopOn; this.syncLoopUI();
  }
  // A marks the start (playback carries on); B marks the end, and looping starts from A.
  markAB(which) {
    if (!this.player) return;
    const t = this.player.time();
    if (which === 'a') {
      this.finishTake(true);
      this.pendingA = t; this.loop = null; this.loopOn = false; this.curPhrase = null;
      this.syncLoopUI(); this.renderPhrases();
      toast(`Start set at ${fmtTime(t)}. Press B where it should end.`, 'info', 3000);
      return;
    }
    const a = this.pendingA ?? (this.loop ? this.loop.a : null);
    if (a == null) { toast('Set the start first with A.', 'info'); return; }
    if (t <= a + 0.3) { toast('The end needs to be after the start.', 'info'); return; }
    this.setLoop(a, t, true);
    this.player.seek(a);
  }
  clearLoop() {
    this.loop = null; this.pendingA = null; this.loopOn = false; this.curPhrase = null;
    this.syncLoopUI(); this.renderPhrases();
  }
  syncLoopUI() {
    const show = !!(this.loopOn && this.loop);
    const marker = this.pendingA != null ? { a: this.pendingA, b: this.pendingA + 0.05 } : null;
    this.overview.loop = show ? this.loop : marker;
    this.lane.regions = show && !this.coach.active ? [{ start: this.loop.a, end: this.loop.b, kind: 'loop' }] : marker ? [{ start: marker.a, end: marker.a + 0.04, kind: 'loop', label: 'A' }] : [];
    if (this.loopBtn) { this.loopBtn.classList.toggle('on', show); this.loopBtn.setAttribute('aria-pressed', String(show)); }
    if (this.aBtn) this.aBtn.classList.toggle('on', this.pendingA != null);
    if (this.learnBtn) {
      this.learnBtn.hidden = !(show && this.mel && this.loop.b - this.loop.a >= 0.8);
      this.learnBtn.lastChild.textContent = this.curPhrase != null ? 'Learn this line' : 'Learn this part';
    }
  }

  // ---- transport ---------------------------------------------------------------
  seekTo(t) { this.player && this.player.seek(t); }
  toggle() {
    if (!this.player) return;
    audioCtx();
    if (this.player.playing) this.player.pause();
    else {
      if (this.loopOn && this.loop) { const t = this.player.time(); if (t < this.loop.a - 0.2 || t > this.loop.b) this.player.seek(this.loop.a); }
      this.player.play();
    }
  }
  async toggleMic() {
    if (mic.running) { mic.stop(); document.dispatchEvent(new CustomEvent('mic-change')); }
    else await ensureMic();
    this.syncMicBtn();
  }
  syncMicBtn() {
    if (!this.micBtn) return;
    this.micBtn.replaceChildren(icon('mic', 17));
    this.micBtn.classList.toggle('on', mic.running);
    this.micBtn.setAttribute('aria-pressed', String(mic.running));
    this.micBtn.title = mic.running ? 'Microphone on (M)' : 'Microphone off (M)';
  }
  onState(st) {
    this.playBtn.replaceChildren(icon(st === 1 ? 'pause' : 'play', 22));
    this.playBtn.setAttribute('aria-label', st === 1 ? 'Pause' : 'Play');
    if (st !== 1) this.follower.set(0);
    if (st === 2 || st === 0) this.finishTake(); // paused / ended (not buffering)
    if (st === 0 && this.capturing && this.onCaptureEnd) this.onCaptureEnd(); // video finished: stop capturing
  }
  key(e) {
    if (!this.active || e.defaultPrevented || e.metaKey || e.ctrlKey || e.altKey) return;
    const ae = document.activeElement;
    if ((ae && (/INPUT|TEXTAREA|SELECT/.test(ae.tagName) || ae.isContentEditable)) || document.querySelector('dialog[open]') || popoverOpen()) return;
    const k = e.key;
    // a control reached with the keyboard keeps Space and Enter; after a mouse click Space plays/pauses
    if ((k === ' ' || k === 'Enter') && ae && ae !== document.body && ae.matches('button, a, summary, [role=button], [tabindex]') && this.kbFocus) return;
    if (this.lyrics.state === 'tap' && k === ' ') { e.preventDefault(); this.lyrics.tap(); return; }
    if (this.coach.active) { if (this.coach.key && this.coach.key(e)) { e.preventDefault(); return; } if (k === ' ' || /^Arrow(Up|Down)$/.test(k)) return; }
    if (k === ' ') { e.preventDefault(); this.toggle(); }
    else if (k === '[') this.markAB('a');
    else if (k === ']') this.markAB('b');
    else if (k === 'l' || k === 'L') { if (this.loop) { this.loopOn = !this.loopOn; this.syncLoopUI(); } }
    else if (k === 'ArrowLeft') { this.player && this.player.seek(this.player.time() - 2); }
    else if (k === 'ArrowRight') { this.player && this.player.seek(this.player.time() + 2); }
    else if (k === 'ArrowUp') { e.preventDefault(); this.stepPhrase(-1); }
    else if (k === 'ArrowDown') { e.preventDefault(); this.stepPhrase(1); }
    else if (k === 'm' || k === 'M') this.toggleMic();
    else if (k === 'g' || k === 'G') this.setGuide(!this.guideOn);
  }

  // ---- main loop ------------------------------------------------------------------
  // How long a change made now takes to be heard: from the context's own output clock when it has one,
  // smoothed, else its stated latencies.
  outputAhead(c) {
    let a = NaN;
    const o = c.getOutputTimestamp ? c.getOutputTimestamp() : null;
    if (o && o.contextTime > 0 && o.performanceTime > 0) a = c.currentTime - o.contextTime - (performance.now() - o.performanceTime) / 1000;
    if (!(a >= 0 && a < 1)) a = (c.baseLatency || 0.01) + (c.outputLatency || 0.03);
    this.guideAhead = this.guideAhead == null ? a : this.guideAhead + 0.05 * (a - this.guideAhead);
    return Math.min(0.6, this.guideAhead);
  }
  loopRAF() {
    cancelAnimationFrame(this.raf);
    let lastRange = 0;
    const c = audioCtx();
    const step = () => {
      if (!this.active) return;
      try { this.frameStep(c, lastRange, (v) => (lastRange = v)); } catch (e) { if (!this.loggedErr) { console.error(e); this.loggedErr = true; } }
      this.raf = requestAnimationFrame(step);
    };
    this.raf = requestAnimationFrame(step);
  }
  frameStep(c, lastRange, setLastRange) {
    const p = this.player;
    let t = p ? p.time() : 0;
    let playing = !!(p && p.playing);
    const coaching = !!this.coach.active;
    // looping: after jumping back, read the time again so nothing from the old pass is stamped on the new one
    let wrapped = false;
    if (playing && this.loopOn && this.loop && t >= this.loop.b) {
      if (coaching) this.coach.passEnd();
      else { this.finishTake(); p.seek(this.loop.a); }
      wrapped = true; t = p.time(); playing = !!p.playing;
      this.lastMicFrame = mic.last; // the sample in hand was sung at the end of the old pass
    }
    if (this.timeEl) this.timeEl.textContent = fmtTime(t) + ' / ' + fmtTime(p ? p.duration() : 0);
    if (coaching && this.coach.frame) this.coach.frame(t, playing);
    // singing along through speakers: say once that headphones track far better
    if (mic.running && playing && !settings.headphones && !this.speakerTip && !this.capturing && this.mode !== 'muted' && (p.muted !== true)) {
      this.speakerTip = true;
      if (!settings.speakerTipShown) {
        saveSettings({ speakerTipShown: true });
        toast('Singing with the song through speakers? Use headphones if you can: the song has to be filtered out of your mic, and that can cut your voice too. Then switch on Headphones in the Sound menu.', 'info', 11000);
      }
    }
    // mic frames
    if (!wrapped && mic.running && mic.last && playing && !this.capturing && this.collect !== false) {
      const f = mic.last;
      if (f !== this.lastMicFrame) {
        this.lastMicFrame = f;
        const lat = (mic.latencySec() + (c.outputLatency || 0.02) + (settings.latencyMs || 0) / 1000) * (p.r || 1);
        const st = t - lat;
        // a jump in the song (a seek, a lyric line, the arrow keys) ends the take: the next frame starts a new one
        const prev = this.frames[this.frames.length - 1];
        if (prev && (st < prev.t - 0.15 || st > prev.t + 1)) this.finishTake();
        if (this.takeStart == null) { this.takeStart = st; this.startTakeRecording(); }
        pushFrame(this.frames, { t: st, c: f.hz > 0 ? 1200 * Math.log2(f.hz / this.practiceSa) : NaN });
      }
    }
    // guide tone follows the melody. The song's clock gives what is heard now, but a change to the tone
    // is heard only after the audio output's delay (larger on Bluetooth), so aim that far ahead, plus a
    // frame for the update and the glide
    if (this.guideOn && playing && this.mel) {
      const r = this.refAt(t + (this.outputAhead(c) + 0.016) * (p.r || 1));
      this.follower.vol = settings.guideVol;
      this.follower.set(isNaN(r) ? 0 : this.practiceSa * Math.pow(2, r / 1200));
    }
    // lane
    this.lane.now = t;
    this.lane.user = this.frames.length ? this.frames : this.lastTakeFrames || [];
    const blindNow = this.mode === 'blind' && playing; // Test yourself: no live feedback until the pass ends
    this.lane.hideUserFrom = blindNow ? -1e9 : Infinity;
    if (this.readout.el.hidden !== blindNow) this.readout.el.hidden = blindNow;
    if (!this.lane.fixed && performance.now() - lastRange > 400) { this.lane.autoRange(t - 2, t + 6); setLastRange(performance.now()); }
    const last = this.frames[this.frames.length - 1];
    const ref = this.refAt(t);
    const cls = mic.running ? this.readout.update(last && playing ? last.c : (mic.last && mic.last.hz > 0 ? 1200 * Math.log2(mic.last.hz / this.practiceSa) : NaN), this.practiceSa, ref) : this.readout.update(NaN);
    this.lane.live = mic.running && this.mode !== 'blind' && last && playing ? { c: last.c, color: cls ? getComputedStyle(this.root).getPropertyValue('--' + cls) : null } : null;
    this.lane.draw();
    this.overview.duration = p ? p.duration() || (this.mel ? melodyDuration(this.mel) : 0) : 0;
    this.overview.now = t;
    this.overview.draw();
    this.lyrics.tick(t);
    // the line being sung, highlighted in the list
    if (this.phraseEls && !coaching) {
      let li = -1;
      for (let i = 0; i < this.phrases.length; i++) if (t >= this.phrases[i].start - 0.2 && t < this.phrases[i].end + 0.3) { li = i; break; }
      if (li !== this.playingLine) {
        if (this.phraseEls[this.playingLine]) this.phraseEls[this.playingLine].classList.remove('playing');
        if (this.phraseEls[li]) this.phraseEls[li].classList.add('playing');
        this.playingLine = li;
      }
    }
  }

  // ---- takes & feedback ----------------------------------------------------------
  startTakeRecording() {
    if (!mic.stream) return;
    this.takeRec = new TakeRecorder(mic.stream);
    this.takeRec.start();
  }
  async finishTake(discard = false) {
    const frames = this.frames;
    this.frames = []; this.takeStart = null;
    const rec = this.takeRec; this.takeRec = null;
    const blob = rec ? await rec.stop() : null;
    if (discard || !this.mel || frames.length < 30) return;
    const voiced = frames.filter((f) => !isNaN(f.c)).length;
    if (voiced < 30) return; // didn't really sing
    const coaching = this.coach.active;
    const span = coaching ? this.coach.span : null;
    const a = span ? span.a : this.loopOn && this.loop ? this.loop.a : frames[0].t;
    const b = span ? span.b : this.loopOn && this.loop ? this.loop.b : frames[frames.length - 1].t;
    if (!(b - a > 0.5)) return;
    const res = analyzeTake({
      frames, refAt: this.refAt, start: a, end: b, tol: settings.tol, octaveFree: settings.octaveFree, tuning: settings.tuning,
      rangeHi: settings.rangeHighMidi != null ? (settings.rangeHighMidi - hzToMidi(this.practiceSa)) * 100 : null, forgiveLag: !coaching,
    });
    this.lastTakeFrames = frames;
    this.lastTake = { res, blob, a, b, frames, phrase: this.loopOn ? this.curPhrase : null };
    if (coaching) { this.coach.onTake(res, frames, blob); return; }
    if (this.curPhrase != null && this.loopOn && res.refVoicedSec > 0.8) {
      const prev = this.song.best[this.curPhrase];
      if (prev == null || res.score > prev) { this.song.best[this.curPhrase] = res.score; upsertSong(this.song); this.renderPhrases(); }
    }
    logActivity({ type: 'song', id: this.song.id, phrase: this.curPhrase, score: res.score, accuracy: res.accuracy, minutes: Math.max(0, b - a) / 60 / (this.speed || 1), perSwara: res.perSwara, weak: res.weak });
    this.renderFeedback(res, blob);
  }
  renderFeedback(res, blob) {
    const f = this.feedback; f.innerHTML = '';
    if (!res) { f.append(h('p', { class: 'empty-note' }, 'Loop a line, turn the mic on and sing. How it went shows up here.')); return; }
    const cls = res.score >= 75 ? 'good' : res.score >= 50 ? 'ok' : 'bad';
    f.append(h('div', { class: 'result-top' },
      h('div', { class: 'score-big ' + cls, style: `--p:${res.score}` }, String(res.score)),
      h('div', { class: 'stats' }, stat('In tune', pct(res.accuracy)), stat('Sung', pct(res.coverage)), stat('Offset', signed(res.bias) + '¢'))));
    const tips = res.tips || [];
    if (tips[0]) {
      const t = tips[0];
      f.append(h('div', { class: 'insight ' + (t.level || 'info') }, h('strong', {}, t.title),
        t.level === 'good' || t.level === 'info' ? h('p', {}, t.detail) : h('details', {}, h('summary', {}, 'How to fix it'), h('p', {}, t.detail), t.drill ? h('a', { class: 'tip-link', href: '#practice/' + t.drill }, 'Open the drill') : null)));
    }
    const extra = [];
    if (res.hiBias != null) extra.push(stat('High notes', signed(res.hiBias) + '¢'));
    if (res.wobble != null) extra.push(stat('Wobble', '±' + Math.round(res.wobble) + '¢'));
    if (res.ornRatio != null) extra.push(stat('Ornaments', pct(res.ornRatio)));
    const bias = swaraBiasText(res.perSwara);
    if (extra.length || bias.length || tips.length > 1) {
      f.append(h('details', { class: 'more' }, h('summary', {}, 'More detail'),
        extra.length ? h('div', { class: 'stats' }, ...extra) : null,
        bias.length ? h('p', { class: 'small' }, h('strong', {}, 'Note by note: '), describeSwaraBias(bias.slice(0, 4))) : null,
        tips.length > 1 ? tipList(tips.slice(1)) : null));
    }
    const acts = h('div', { class: 'row wrap acts' });
    const lt = this.lastTake;
    if (lt && lt.b - lt.a >= 0.8) acts.append(h('button', { class: 'btn small learn', onclick: () => this.learnRange(lt.a, lt.b, lt.phrase) }, icon('target', 15), lt.phrase != null ? 'Learn this line' : 'Learn this part'));
    if (blob) {
      const url = URL.createObjectURL(blob);
      const au = new Audio(url);
      const take = h('button', { class: 'btn small', onclick: () => { if (au.paused) { au.currentTime = 0; au.play(); } else au.pause(); } }, icon('play', 14), 'Your take');
      au.onplay = () => take.replaceChildren(icon('pause', 14), 'Your take');
      au.onpause = au.onended = () => take.replaceChildren(icon('play', 14), 'Your take');
      acts.append(take, h('button', { class: 'btn small', onclick: () => this.playTakeWithSong(url) }, icon('play', 14), 'With the song'));
    }
    if (acts.children.length) f.append(acts);
  }
  async playTakeWithSong(url) {
    if (!this.lastTake || !this.player) return;
    const a = this.lastTake.a;
    const au = new Audio(url);
    this.player.seek(a);
    this.player.mute(false);
    this.player.play();
    const stopAt = this.lastTake.b, player = this.player, t0 = performance.now();
    const done = () => { au.pause(); if (this.mode === 'muted' && this.player === player) player.mute(true); };
    const startWhen = () => {
      if (this.player !== player) return;
      if (!player.playing) { if (performance.now() - t0 < 8000) setTimeout(startWhen, 30); return; }
      au.play();
      // only start watching for the end once both are actually playing
      const chk = setInterval(() => { if (this.player !== player || !player.playing || player.time() >= stopAt) { clearInterval(chk); done(); } }, 100);
    };
    startWhen();
  }

  // ---- melody capture from this tab (YouTube) --------------------------------------
  async captureTab() {
    const why = this.device && this.device.captureBlocker ? this.device.captureBlocker() : (!navigator.mediaDevices || !navigator.mediaDevices.getDisplayMedia ? { title: 'This browser can\'t record a tab', detail: 'Open this site in Chrome or Edge on a computer, or import the song as an audio file.' } : null);
    if (why) {
      const dlg = sheet(why.title, h('p', {}, why.detail), { actions: [h('a', { class: 'btn', href: '#settings/device', onclick: () => dlg.close() }, 'Check this device'), h('button', { class: 'btn primary', onclick: () => { dlg.close(); this.toggleAdd(true); } }, 'Import a file instead')] });
      return;
    }
    if (this.busy) return;
    const keepCopy = true; // the recorded copy is what the voice separation runs on
    let stream;
    try {
      stream = await navigator.mediaDevices.getDisplayMedia({
        video: { frameRate: 1, width: 320, height: 180 },
        audio: { echoCancellation: false, noiseSuppression: false, autoGainControl: false, suppressLocalAudioPlayback: false },
        preferCurrentTab: true, selfBrowserSurface: 'include', systemAudio: 'exclude', surfaceSwitching: 'exclude',
      });
    } catch (e) {
      return toast(e && e.name === 'NotAllowedError' ? 'Capture cancelled.' : 'Couldn\'t start the capture: ' + ((e && e.message) || e), 'info', 6000);
    }
    const at = stream.getAudioTracks()[0];
    if (!at) {
      stream.getTracks().forEach((t) => t.stop());
      return toast('No sound was shared. Try again, pick this tab, and keep "Also share tab audio" switched on.', 'bad', 8000);
    }
    const song = this.song, source = this.source;
    this.busy = true;
    try { await this._capture(stream, at, song, source, keepCopy); }
    catch (e) { console.error(e); toast('Capture failed: ' + e.message, 'bad', 7000); }
    finally { this.busy = false; this.capturing = false; setMasterMuted(false); stream.getTracks().forEach((t) => t.stop()); this.hideProgress(); }
  }
  async _capture(stream, at, song, source, keepCopy) {
    const c = audioCtx();
    const src = c.createMediaStreamSource(new MediaStream([at]));
    const tap = await createTap(c);
    src.connect(tap);
    const an = new SalienceAnalyzer(c.sampleRate);
    const hopS = Math.round(0.01 * c.sampleRate);
    const ringN = an.win * 4;
    const L = new Float32Array(ringN), R = new Float32Array(ringN);
    let w = 0, sinceHop = 0, total = 0, lastSound = performance.now();
    const lin = new Float32Array(an.win), rin = new Float32Array(an.win);
    const frames = this.captureFrames = new Map(); // grid index -> frame
    const preview = new Map();
    const p = this.player;
    tap.port.onmessage = (ev) => {
      const { L: bl, R: br, t: tEnd } = ev.data;
      let pk = 0; for (let i = 0; i < bl.length; i += 8) pk = Math.max(pk, Math.abs(bl[i]));
      if (pk > 0.01) lastSound = performance.now();
      for (let i = 0; i < bl.length; i++) {
        L[w] = bl[i]; R[w] = br[i]; w = (w + 1) % ringN; total++; sinceHop++;
        if (sinceHop >= hopS && total >= an.win) {
          sinceHop = 0;
          if (!p.playing) continue;
          for (let k = 0; k < an.win; k++) { const j = (w - an.win + k + ringN) % ringN; lin[k] = L[j]; rin[k] = R[j]; }
          const fr = an.analyze(lin, rin, 0);
          // timestamp: frame centre, mapped to video time
          const samplesAfterCentre = (bl.length - 1 - i) + an.win / 2;
          // (-0.04 s calibrated against offline analysis of the same audio: capture arrives slightly ahead of media time)
          const ageSec = c.currentTime - tEnd + samplesAfterCentre / c.sampleRate - 0.04;
          const vt = p.time() - ageSec * (p.r || 1);
          const gi = Math.round(vt / 0.01);
          if (gi >= 0) { frames.set(gi, fr); if (fr.p.length) preview.set(gi, fr.p[0] * 10); }
        }
      }
    };
    // recording a practice copy
    let rec = null, chunks = [];
    if (keepCopy && typeof MediaRecorder !== 'undefined') {
      try { rec = new MediaRecorder(new MediaStream([at]), { mimeType: MediaRecorder.isTypeSupported('audio/webm;codecs=opus') ? 'audio/webm;codecs=opus' : undefined, audioBitsPerSecond: 160000 }); } catch { rec = null; }
    }
    this.capturing = true;
    setMasterMuted(true);
    const prevMode = this.mode; if (prevMode === 'muted') this.player.mute(false);
    // live preview of the melody while capturing
    const prevRef = this.lane.refAt;
    this.lane.refAt = (t) => { const g = Math.round(t / 0.01); const v = preview.get(g) ?? preview.get(g - 1) ?? preview.get(g + 1); return v == null ? NaN : v - cAbove55(this.songSa); };
    this.lane.message = '';
    const C = 2 * Math.PI * 26;
    const stopBtn = h('button', { class: 'btn small primary' }, icon('stop', 13), 'Finish');
    const prog = h('span', { class: 'cb-sub' }, 'Starting…');
    const ring = h('div', { class: 'ring sm', html: `<svg viewBox="0 0 64 64" aria-hidden="true"><circle class="track" cx="32" cy="32" r="26"/><circle class="fill" cx="32" cy="32" r="26" stroke-dasharray="${C}" stroke-dashoffset="${C}"/></svg>` });
    this.showOverlay('top', h('div', { class: 'capture-bar', role: 'status' }, ring, h('div', { class: 'cb-text' }, h('strong', {}, 'Listening to the song'), prog), stopBtn));
    if (!this.mel) p.seek(0);
    p.setRate(1); p.play();
    // map recording time -> video time, so the separated melody can be placed on the video's timeline
    const mapping = [];
    let recStart = 0;
    if (rec) { rec.ondataavailable = (e) => e.data.size && chunks.push(e.data); rec.start(1000); recStart = performance.now(); }
    const mapTimer = setInterval(() => mapping.push({ rt: (performance.now() - recStart) / 1000, vt: p.time(), on: p.playing }), 100);
    const progTimer = setInterval(() => {
      const d = p.duration() || 1, f = Math.min(1, p.time() / d);
      prog.textContent = `${fmtTime(p.time())} of ${fmtTime(p.duration())} · keep this tab open`;
      ring.querySelector('.fill').style.strokeDashoffset = String(C * (1 - f));
    }, 500);
    await new Promise((res) => {
      stopBtn.onclick = res;
      this.onCaptureEnd = res; // called from onState when the video ends
      at.addEventListener('ended', res, { once: true });
      let lastT = -1, still = 0;
      const endChk = setInterval(() => {
        const t = p.time();
        if (p.duration() && t >= p.duration() - 0.5) { clearInterval(endChk); res(); return; }
        still = Math.abs(t - lastT) < 0.01 && t > 5 ? still + 1 : 0; lastT = t;
        // nothing has moved for 4 s and the tab is quiet (an ad keeps the clock still but makes sound)
        if (still >= 8 && (performance.now() - lastSound > 3000 || still >= 240)) { clearInterval(endChk); res(); }
      }, 500);
      stopBtn.addEventListener('click', () => clearInterval(endChk));
    });
    clearInterval(progTimer); clearInterval(mapTimer);
    p.pause();
    this.capturing = false; this.onCaptureEnd = null;
    setMasterMuted(false);
    if (prevMode === 'muted') this.player.mute(true);
    p.setRate(this.speed);
    try { src.disconnect(); tap.disconnect(); tap._sink && tap._sink.disconnect(); } catch {}
    let copyBlob = null;
    if (rec && rec.state !== 'inactive') { await new Promise((r2) => { rec.onstop = r2; rec.stop(); }); copyBlob = new Blob(chunks, { type: rec.mimeType || 'audio/webm' }); }
    stream.getTracks().forEach((t) => t.stop());
    this.showProgress('build', null);
    // assemble grid, merge with any existing melody
    const idx = [...frames.keys()];
    if (idx.length < 100) { this.lane.refAt = prevRef; return toast('Too little audio was captured. Was the tab\'s sound shared?', 'bad', 7000); }
    const firstCapture = !this.mel;
    const maxI = Math.max(...idx, this.mel ? this.mel.cents.length - 1 : 0);
    const minI = Math.min(...idx), maxCap = Math.max(...idx);
    const arr = new Array(maxCap - minI + 1);
    for (let g = minI; g <= maxCap; g++) arr[g - minI] = frames.get(g) || frames.get(g - 1) || frames.get(g + 1) || null;
    const part = trackMelody(arr, { hop: 0.01, t0: minI * 0.01 });
    const cents = new Float32Array(maxI + 1).fill(NaN);
    if (this.mel) for (let g = 0; g < this.mel.cents.length; g++) { const tt = this.mel.t0 + g * this.mel.hop; const gi = Math.round(tt / 0.01); if (gi <= maxI) cents[gi] = this.mel.cents[g]; }
    // only overwrite stretches that were actually captured this time (keeps earlier captures)
    for (let g = 0; g < part.cents.length; g++) { const gi = minI + g; if (frames.has(gi) || frames.has(gi - 1) || frames.has(gi + 1)) cents[gi] = part.cents[g]; }
    let mel = { hop: 0.01, t0: 0, cents };
    let savedCopy = false;
    const recSecs = mapping.length ? mapping[mapping.length - 1].rt : 0;
    if (copyBlob && copyBlob.size > 50000 && song.kind === 'youtube' && (!song.hasCopy || recSecs > (song.copySecs || 0) - 1)) {
      song.copySecs = recSecs;
      await idbPut('audio', song.id, copyBlob);
      song.hasCopy = true; savedCopy = true; upsertSong(song);
    }
    // An ad, buffering or a pause recorded along with the song is cut out of the copy, so the copy
    // runs on the video's own timeline. Only when there is something to cut (over a second).
    const stretches = playedStretches(mapping);
    const vStart = Math.min(...stretches.map((x) => x.v0)), vEnd = Math.max(...stretches.map((x) => x.v1));
    const trim = savedCopy && stretches.length && vStart < 1 && recSecs - (vEnd - vStart) > 1 ? { stretches, vEnd, cut: recSecs - (vEnd - vStart) } : null;
    // Better melody: separate the voice from the recorded audio, then place it on the video timeline.
    let cutDone = false, copyMelSaved = false;
    if (copyBlob && copyBlob.size > 50000 && recStart) {
      try {
        const res = await analyzeBlob(copyBlob, (pr, step, d) => { if (this.song === song) this.showProgress(step, pr, d); });
        let shift = 0;
        if (res.separated) {
          const sepCents = placeOnVideo(res.mel, mapping, cents, frames, minI, maxCap);
          if (sepCents) { mel = { hop: 0.01, t0: 0, cents: sepCents }; song[source + 'Separated'] = true; shift = sepCents.shift; }
        }
        let copyMel = res.mel, copyVox = res.vocals;
        if (trim && (cutDone = await this.cutCopy(song, copyBlob, trim, shift))) { // the copy's melody and voice, cut the same way
          copyMel = retimeMelody(res.mel, trim.stretches, shift, trim.vEnd);
          if (copyVox) { const o = retimeAudio(copyVox.L ? [copyVox.L, copyVox.R] : [copyVox], 44100, trim.stretches, shift, trim.vEnd); copyVox = o.length > 1 ? { L: o[0], R: o[1] } : o[0]; }
        }
        if (savedCopy) {
          await idbPut('melody', song.id + ':audio', packMelody(copyMel)); copyMelSaved = true;
          if (res.separated) { await idbPut('audio', song.id + ':vocals', toI16(copyVox)); song.audioSeparated = true; song.stemModel = res.model; }
        }
        upsertSong(song);
      } catch (e) { console.warn('separation after capture failed', e); }
    }
    if (trim && !cutDone && !copyMelSaved) cutDone = await this.cutCopy(song, copyBlob, trim, 0); // not analysed: cut the sound alone
    await idbPut('melody', song.id + ':' + source, packMelody(mel));
    if (savedCopy) toast(`Saved a recorded copy${cutDone ? ` (${Math.round(trim.cut)} s of ad or silence cut out)` : ''}. Use the Source chip to switch to it: then you can transpose, or hear the voice or the backing alone.`, 'good', 8000);
    if (firstCapture) { song[source + 'Sa'] = null; upsertSong(song); }
    if (song.lyricsTiming) { for (const k of [source, 'audio']) if (song.lyricsTiming[k] && !song.lyricsTiming[k].user) delete song.lyricsTiming[k]; upsertSong(song); } // re-time lyrics to the new guide
    if (this.song !== song || this.source !== source) return; // user moved on; data is saved for later
    this.mel = mel;
    this.analyzeMelody();
    toast(`Melody guide ready: ${this.phrases.length} lines.`, 'good');
  }

  // Store the copy cut onto the video's timeline (see playedStretches). True when it worked.
  async cutCopy(song, blob, trim, shift) {
    try {
      const buf = await audioCtx().decodeAudioData(await blob.arrayBuffer());
      const ch = [buf.getChannelData(0), buf.numberOfChannels > 1 ? buf.getChannelData(1) : buf.getChannelData(0)];
      const o = retimeAudio(ch, buf.sampleRate, trim.stretches, shift, trim.vEnd);
      const out = new AudioBuffer({ numberOfChannels: 2, length: o[0].length, sampleRate: buf.sampleRate });
      out.copyToChannel(o[0], 0); out.copyToChannel(o[1], 1);
      await idbPut('audio', song.id, audioBufferToWav(out));
      song.copySecs = trim.vEnd; song.copyCut = Math.round(trim.cut); upsertSong(song);
      return true;
    } catch (e) { console.warn('cutting the copy failed', e); return false; }
  }
  async analyzeAudio() {
    if (!this.song || this.busy) return;
    const song = this.song;
    const blob = await idbGet('audio', song.id);
    if (!blob) return toast('Audio not found in this browser.', 'bad');
    this.busy = true;
    this.showProgress('prepare', 0);
    try {
      const { mel, vocals, separated, model } = await analyzeBlob(blob, (p, step, d) => { if (this.song === song) this.showProgress(step, p, d); });
      song.stemModel = model;
      await idbPut('melody', song.id + ':audio', packMelody(mel));
      if (vocals) await idbPut('audio', song.id + ':vocals', toI16(vocals));
      song.audioSa = null; song.audioSeparated = separated;
      if (song.lyricsTiming && song.lyricsTiming.audio && !song.lyricsTiming.audio.user) delete song.lyricsTiming.audio; // re-time lyrics to the new guide
      upsertSong(song);
      if (this.song === song && this.source === 'audio') {
        if (vocals && this.player && this.player.kind === 'audio') this.player.setVocals(vocals);
        this.mel = mel;
        this.busy = false;
        this.analyzeMelody();
        toast(`Melody guide ready: ${this.phrases.length} lines.`, 'good');
      }
    } catch (e) { toast('Analysis failed: ' + e.message, 'bad', 7000); }
    finally { this.busy = false; this.hideProgress(); }
  }

  // ---- adding songs ---------------------------------------------------------------
  async addUrl(url) {
    if (/spotify\.com/.test(url)) {
      toast('Spotify can\'t be embedded. Play the song in another Chrome tab, then use "Record from another tab".', 'info', 9000);
      return;
    }
    const id = parseYouTubeId(url);
    if (!id) return toast('That doesn\'t look like a YouTube link.', 'bad');
    const s = upsertSong({ id: 'yt-' + id, kind: 'youtube', videoId: id, title: 'YouTube ' + id, created: new Date().toISOString() });
    this.ytInput.value = ''; this.toggleAdd(false);
    await this.open(s.id);
  }
  async addFile(file) {
    const id = 'au-' + Date.now().toString(36);
    await idbPut('audio', id, file);
    upsertSong({ id, kind: 'audio', title: file.name.replace(/\.[^.]+$/, ''), created: new Date().toISOString() });
    this.toggleAdd(false);
    await this.open(id);
    await this.analyzeAudio();
  }
  async recordOtherTab() {
    const why = this.device && this.device.captureBlocker ? this.device.captureBlocker() : null;
    if (why || !navigator.mediaDevices || !navigator.mediaDevices.getDisplayMedia) return toast(why ? why.detail : 'Recording another tab needs Chrome or Edge on a computer.', 'bad', 8000);
    let stream;
    try {
      stream = await navigator.mediaDevices.getDisplayMedia({ video: { frameRate: 1, width: 320, height: 180 }, audio: { echoCancellation: false, noiseSuppression: false, autoGainControl: false }, selfBrowserSurface: 'exclude', systemAudio: 'include' });
    } catch (e) { if (!e || e.name !== 'NotAllowedError') toast('Couldn\'t start the recording: ' + ((e && e.message) || e), 'bad', 7000); return; }
    const at = stream.getAudioTracks()[0];
    if (!at) { stream.getTracks().forEach((t) => t.stop()); return toast('No sound was shared. Pick the tab with the song and keep "Also share tab audio" on.', 'bad', 8000); }
    const rec = new MediaRecorder(new MediaStream([at]), { audioBitsPerSecond: 160000 });
    const chunks = [];
    rec.ondataavailable = (e) => e.data.size && chunks.push(e.data);
    rec.start(1000);
    const t0 = Date.now();
    const name = h('input', { type: 'text', placeholder: 'Song name', value: 'Recorded song', 'aria-label': 'Song name' });
    const timer = h('span', { class: 'mono' }, '0:00');
    const stop = h('button', { class: 'btn small primary' }, icon('stop', 13), 'Stop');
    const box = h('div', { class: 'rec-bar' }, h('span', { class: 'rec-dot' }), h('div', { class: 'cb-text' }, h('strong', {}, 'Recording the other tab'), h('span', { class: 'cb-sub' }, 'Play the song there from the start, then press Stop.')), name, timer, stop);
    this.addBox.append(box);
    const iv = setInterval(() => (timer.textContent = fmtTime((Date.now() - t0) / 1000)), 500);
    await new Promise((res) => { stop.onclick = res; at.addEventListener('ended', res, { once: true }); });
    clearInterval(iv);
    await new Promise((res) => { rec.onstop = res; rec.stop(); });
    stream.getTracks().forEach((t) => t.stop());
    box.remove();
    const blob = new Blob(chunks, { type: rec.mimeType || 'audio/webm' });
    if (blob.size < 20000) return toast('The recording is empty. Was the tab\'s sound shared?', 'bad');
    const id = 'au-' + Date.now().toString(36);
    await idbPut('audio', id, blob);
    const title = name.value.trim() || 'Recorded song';
    upsertSong({ id, kind: 'audio', title, untitled: title === 'Recorded song', created: new Date().toISOString() });
    this.toggleAdd(false);
    await this.open(id);
    await this.analyzeAudio();
  }
  remove() {
    if (!this.song) return;
    if (!confirm(`Remove "${this.song.title}" and its melody and practice data from this browser?`)) return;
    const id = this.song.id;
    this.stopPlayer();
    this.song = null; this.mel = null;
    removeSong(id);
    this.open(songs[0] && songs[0].id);
  }

  // ---- melody guide repair ---------------------------------------------------------------
  async editRegion(op) {
    if (!this.mel || !this.loop) return toast('Set a loop over the bad stretch first (drag on the strip above the lane).', 'info');
    this.undo = Float32Array.from(this.mel.cents);
    const { hop, t0, cents } = this.mel;
    const a = Math.max(0, Math.floor((this.loop.a - t0) / hop)), b = Math.min(cents.length, Math.ceil((this.loop.b - t0) / hop));
    for (let i = a; i < b; i++) { if (isNaN(cents[i])) continue; cents[i] = op === 'up' ? cents[i] + 1200 : op === 'down' ? cents[i] - 1200 : NaN; }
    await idbPut('melody', this.song.id + ':' + this.source, packMelody(this.mel));
    this.analyzeMelody();
    toast(op === 'erase' ? 'Erased from the guide.' : 'Moved an octave ' + (op === 'up' ? 'up.' : 'down.'), 'good', 2000);
  }
  async undoEdit() {
    if (!this.undo || !this.mel) return;
    this.mel.cents = this.undo; this.undo = null;
    await idbPut('melody', this.song.id + ':' + this.source, packMelody(this.mel));
    this.analyzeMelody();
  }
}
