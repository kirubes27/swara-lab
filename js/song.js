// Song Studio: load a song (YouTube / file / another tab), extract its melody,
// loop phrases, slow down, transpose, and sing against the reference with feedback.
import { audioCtx, mic, createTap, renderRate, audioBufferToWav, TakeRecorder, setMasterMuted } from './audio.js';
import { tanpura, Follower } from './sound.js';
import { PitchLane, Overview } from './lane.js';
import { SalienceAnalyzer, trackMelody, melodyAt, melodyDuration, estimateTonic, findPhrases, F_REF } from './melody.js';
import { analyzeTake, transcribe, fitToRange, swaraBiasText, describeSwaraBias } from './coach.js';
import { settings, saveSettings, songs, getSong, upsertSong, removeSong, lastSong, idbGet, idbPut, packMelody, unpackMelody, logActivity } from './store.js';
import { westernName, hzToMidi, midiToHz, kattaiName, kaliSafedName, percentile, saHzFrom, isIndian, term } from './music.js';
import { h, toast, ensureMic, tipList, fmtTime } from './ui.js';
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
  if (/^[\w-]{11}$/.test(s)) return s;
  try {
    const u = new URL(s);
    if (u.hostname.includes('youtu.be')) return u.pathname.slice(1, 12);
    if (u.searchParams.get('v')) return u.searchParams.get('v').slice(0, 11);
    const m = u.pathname.match(/\/(embed|shorts|live|v)\/([\w-]{11})/);
    if (m) return m[2];
  } catch {}
  return null;
}

class YTPlayer {
  constructor(el, videoId, { onState, onError, onReady } = {}) {
    this.kind = 'youtube'; this.r = 1; this.playing = false; this.smooth = 0; this.prevNow = performance.now();
    this.ready = loadYT().then((YT) => new Promise((res) => {
      this.p = new YT.Player(el, {
        videoId, width: '100%', height: '100%',
        playerVars: { playsinline: 1, rel: 0, modestbranding: 1, origin: location.origin },
        events: {
          onReady: () => { this.ok = true; res(); onReady && onReady(this); },
          onStateChange: (e) => { this.playing = e.data === 1; if (e.data === 1) this.prevNow = performance.now(); onState && onState(e.data, this); },
          onError: (e) => onError && onError(e.data),
        },
      });
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
    this.url = URL.createObjectURL(blob); this.a.src = this.url;
    const emit = (st) => { if (!this.dead && onState) onState(st, this); };
    this.a.addEventListener('play', () => emit(1));
    this.a.addEventListener('pause', () => emit(2));
    this.a.addEventListener('ended', () => emit(0));
    this.ready = new Promise((res) => { this.a.addEventListener('loadedmetadata', () => res(), { once: true }); this.a.addEventListener('error', () => res(), { once: true }); });
  }
  get playing() { return !this.a.paused && !this.a.ended; }
  play() { this.a.play().catch(() => {}); }
  pause() { this.a.pause(); }
  seek(t) { if (isFinite(t)) this.a.currentTime = Math.max(0, t / this.factor); }
  setRate(r) { this.r = r; this.a.playbackRate = r / this.factor; }
  mute(m) { this.a.muted = m; }
  duration() { const d = this.a.duration; return (isFinite(d) ? d : 0) * this.factor; } // MediaRecorder WebM reports Infinity
  time() { return this.a.currentTime * this.factor; }
  async decoded() {
    if (!this.buf) this.buf = await audioCtx().decodeAudioData(await this.blob.arrayBuffer());
    return this.buf;
  }
  // vocals: Float32Array mono @44.1 kHz from the separation step
  setVocals(v) { this.vocals = v; }
  async setTranspose(st) { this.st0 = st; return this.rebuild(); }
  async setSound(mode) { this.mode0 = mode; return this.rebuild(); }
  async rebuild() {
    const st = this.st0 ?? this.st ?? 0, mode = this.vocals ? (this.mode0 || 'mix') : 'mix';
    const want = mode + '|' + st;
    this.target = want;
    if (want === (this.cur || 'mix|0')) return;
    let url = this.url, f = Math.pow(2, st / 12);
    if (want !== 'mix|0') {
      let src = await this.decoded();
      if (this.target !== want || this.dead) return;
      if (mode !== 'mix') src = await this.stemBuffer(mode);
      if (this.target !== want || this.dead) return;
      if (st) src = await renderRate(src, f, Math.min(44100, src.sampleRate));
      if (this.target !== want || this.dead) return; // superseded by a newer choice
      if (this.shiftUrl) URL.revokeObjectURL(this.shiftUrl);
      url = this.shiftUrl = URL.createObjectURL(audioBufferToWav(src));
    }
    const t = this.time(), was = this.playing;
    this.pause();
    this.factor = st ? f : 1; this.a.src = url;
    this.st = st; this.cur = want;
    await new Promise((res) => this.a.addEventListener('loadedmetadata', res, { once: true }));
    this.setRate(this.r); this.seek(t);
    if (was) this.play();
  }
  async stemBuffer(mode) {
    this.stems = this.stems || {};
    if (this.stems[mode]) return this.stems[mode];
    const orig = await renderRate(await this.decoded(), 1, 44100);
    const v = this.vocals, n = Math.min(orig.length, v.length);
    const out = new AudioBuffer({ numberOfChannels: orig.numberOfChannels, length: orig.length, sampleRate: 44100 });
    for (let ch = 0; ch < orig.numberOfChannels; ch++) {
      const x = orig.getChannelData(ch), o = out.getChannelData(ch);
      if (mode === 'vocals') for (let i = 0; i < n; i++) o[i] = v[i];
      else { o.set(x); for (let i = 0; i < n; i++) o[i] = x[i] - v[i]; }
    }
    return (this.stems[mode] = out);
  }
  destroy() { this.dead = true; this.pause(); this.a.removeAttribute('src'); this.a.load(); URL.revokeObjectURL(this.url); if (this.shiftUrl) URL.revokeObjectURL(this.shiftUrl); }
}

// ---------------------------------------------------------------------------
const MODEL_URL = new URL('../models/spleeter-vocals.onnx', import.meta.url).href;
function runWorker(url, msg, transfer, onProgress) {
  return new Promise((res, rej) => {
    const w = new Worker(new URL(url, import.meta.url), { type: 'module' });
    w.onmessage = (e) => {
      if (e.data.progress != null) onProgress && onProgress(e.data.progress, e.data.stage);
      if (e.data.done) { w.terminate(); res(e.data); }
      if (e.data.error) { w.terminate(); rej(new Error(e.data.error)); }
    };
    w.onerror = (e) => { w.terminate(); rej(new Error(e.message || 'worker failed')); };
    w.postMessage(msg, transfer);
  });
}
// Separate the voice from the music (Spleeter, in a worker), then track pitch on the voice alone.
// Falls back to the mix-based tracker if separation can't run in this browser.
async function analyzeBlob(blob, onProgress) {
  const c = audioCtx();
  const buf = await c.decodeAudioData(await blob.arrayBuffer());
  try {
    const b44 = await renderRate(buf, 1, 44100);
    const L = b44.getChannelData(0).slice(), R = (b44.numberOfChannels > 1 ? b44.getChannelData(1) : b44.getChannelData(0)).slice();
    const r = await runWorker('./sep-worker.js', { L, R, modelUrl: MODEL_URL }, [L.buffer, R.buffer], onProgress);
    return { mel: r.mel, vocals: r.vocals, separated: true };
  } catch (err) {
    console.warn('vocal separation unavailable, using mix-based tracking:', err);
    toast('Voice separation isn\'t available in this browser, so the melody is traced from the full mix (less accurate).', 'info', 7000);
    const small = await renderRate(buf, 1, 22050);
    const L = small.getChannelData(0).slice(), R = (small.numberOfChannels > 1 ? small.getChannelData(1) : small.getChannelData(0)).slice();
    const r = await runWorker('./worker.js', { L, R, sr: 22050 }, [L.buffer, R.buffer], (p) => onProgress && onProgress(p, 'Tracking the melody…'));
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
  for (let g = minI; g <= maxI && g < n; g++) {
    if (!(frames.has(g) || frames.has(g - 1) || frames.has(g + 1))) continue; // keep earlier captures elsewhere
    out[g] = isNaN(rtOf[g]) ? NaN : melodyAt(recMel, rtOf[g] + best);
  }
  return out;
}
const wrap1200 = (d) => ((((d + 600) % 1200) + 1200) % 1200) - 600;
const toI16 = (f) => { const o = new Int16Array(f.length); for (let i = 0; i < f.length; i++) o[i] = Math.max(-32768, Math.min(32767, Math.round(f[i] * 32767))); return o; };
const fromI16 = (a) => { const o = new Float32Array(a.length); for (let i = 0; i < a.length; i++) o[i] = a[i] / 32767; return o; };

const cAbove55 = (hz) => 1200 * Math.log2(hz / F_REF);

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
export class SongStudio {
  constructor(root) {
    this.root = root;
    this.song = null; this.player = null; this.mel = null; this.source = 'youtube';
    this.speed = 1; this.loopOn = false; this.loop = null; this.mode = 'along'; this.guideOn = false;
    this.follower = new Follower();
    this.frames = []; this.takeStart = null; this.phrases = [];
    this.build();
  }

  // ---- layout ---------------------------------------------------------------
  build() {
    const r = this.root;
    r.innerHTML = '';
    this.sel = h('select', { class: 'song-select', 'aria-label': 'Song', onchange: (e) => this.open(e.target.value) });
    const addBtn = h('button', { class: 'btn primary', onclick: () => this.addBox.classList.toggle('open') }, icon('plus', 16), 'Add song');
    this.ytInput = h('input', { type: 'url', placeholder: 'Paste a YouTube link', class: 'grow' });
    const fileIn = h('input', { type: 'file', accept: 'audio/*,video/*', style: 'display:none', onchange: (e) => e.target.files[0] && this.addFile(e.target.files[0]) });
    const row = (ic, title, sub, onclick) => h('button', { class: 'li', onclick }, h('span', { class: 'li-ic' }, icon(ic, 18)), h('span', { class: 'li-text' }, h('strong', {}, title), h('small', {}, sub)), h('span', { class: 'li-end' }, icon('chevron', 16)));
    this.addBox = h('div', { class: 'add-box' },
      h('div', { class: 'list' },
        row('upload', 'Import an audio file', 'MP3, M4A, WAV… Songs you own, karaoke tracks, recordings.', () => fileIn.click()),
        row('record', 'Record from another tab', 'Play the song in another Chrome tab (Spotify, YouTube…) and record it here.', () => this.recordOtherTab()),
        h('div', { class: 'yt-row' }, h('span', { class: 'li-ic' }, icon('link', 18)), this.ytInput, h('button', { class: 'btn', onclick: () => this.addUrl(this.ytInput.value) }, 'Add'))),
      fileIn,
      h('p', { class: 'muted small' }, 'Recordings and files stay in this browser and are only used for your practice.'));
    this.playerBox = h('div', { class: 'player-box' });
    this.info = h('div', { class: 'song-info' });
    this.overviewCanvas = h('canvas', { class: 'overview', title: 'Click to jump · drag to loop a section' });
    this.laneCanvas = h('canvas', { class: 'lane tall' });
    const ro = h('div');
    this.chip = h('div', { class: 'phase-chip' });
    this.laneWrap = h('div', { class: 'lane-wrap' }, this.laneCanvas, ro, this.chip);
    this.readout = new LiveReadout(ro);
    this.transport = h('div', { class: 'transport' });
    this.phraseBox = h('div', { class: 'phrases' });
    this.feedback = h('div', { class: 'feedback' });
    this.tools = h('details', { class: 'tools' });
    r.append(
      h('div', { class: 'page-head' }, h('h1', {}, 'Songs'), h('p', { class: 'lead' }, 'Pick a song, loop one line at a time, and sing against the original melody.')),
      h('div', { class: 'row song-top' }, this.sel, addBtn, h('button', { class: 'btn ghost', title: 'Remove this song from the library', onclick: () => this.remove() }, icon('trash', 16), 'Remove')),
      this.addBox,
      h('div', { class: 'song-grid' }, this.playerBox, this.info),
      this.overviewCanvas, this.laneWrap, this.transport,
      h('div', { class: 'song-cols' }, h('div', {}, h('h3', {}, 'Lines'), this.phraseBox), h('div', {}, h('h3', {}, 'Last take'), this.feedback)),
      this.tools,
    );
    this.lane = new PitchLane(this.laneCanvas);
    this.lane.past = 2.5; this.lane.future = 5;
    this.overview = new Overview(this.overviewCanvas, {
      onSeek: (t) => { this.player && this.player.seek(t); },
      onLoop: (a, b) => this.setLoop(a, b, true),
    });
    this.buildTransport();
    this.feedback.append(h('p', { class: 'muted' }, 'Loop a line, turn on the mic, and sing. Feedback appears after each pass.'));
    window.addEventListener('keydown', (e) => this.key(e));
  }

  buildTransport() {
    const t = this.transport; t.innerHTML = '';
    const seg = (items, cur, onpick, title) => {
      const el = h('div', { class: 'seg', title });
      for (const [v, label] of items) el.append(h('button', { class: v === cur ? 'on' : '', onclick: () => { [...el.children].forEach((b) => b.classList.toggle('on', b.dataset.v == String(v))); onpick(v); }, 'data-v': String(v) }, label));
      return el;
    };
    this.playBtn = h('button', { class: 'btn primary round big', title: 'Play / pause (Space)', 'aria-label': 'Play', onclick: () => this.toggle() }, icon('play', 22));
    this.timeEl = h('span', { class: 'mono time' }, '0:00');
    this.loopBtn = h('button', { class: 'btn small', title: 'Loop the selected line or A–B section (L)', onclick: () => { this.loopOn = !this.loopOn; this.syncLoopUI(); } }, icon('loop', 15), 'Loop');
    this.aBtn = h('button', { class: 'btn small', title: 'Set loop start at the current position ([)', onclick: () => this.markAB('a') }, 'A start');
    this.bBtn = h('button', { class: 'btn small', title: 'Set loop end at the current position (])', onclick: () => this.markAB('b') }, 'B end');
    this.clearBtn = h('button', { class: 'btn small ghost', title: 'Remove the loop', onclick: () => this.clearLoop() }, 'Clear');
    const speedSeg = seg([[0.5, '0.5×'], [0.6, '0.6×'], [0.75, '0.75×'], [0.85, '0.85×'], [1, '1×']], 1, (v) => { this.speed = v; this.player && this.player.setRate(v); }, 'Playback speed (pitch stays the same)');
    this.micBtn = h('button', { class: 'btn small', title: 'Microphone (M)', onclick: () => this.toggleMic() }, icon('mic', 15), 'Mic');
    const modeSeg = seg([['along', 'Sing along'], ['muted', 'Solo'], ['blind', 'Blind']], this.mode, (v) => this.setMode(v), 'Sing along with the song, sing with it muted, or hide your live line');
    this.soundSeg = seg([['mix', 'Original'], ['vocals', 'Voice only'], ['karaoke', 'Backing']], 'mix', (v) => this.setSound(v), 'Hear the full song, the separated voice, or the backing track (karaoke)');
    this.guideChk = h('input', { type: 'checkbox', 'aria-label': 'Guide tone', onchange: (e) => { this.guideOn = e.target.checked; if (!this.guideOn) this.follower.set(0); } });
    this.octSel = h('select', { title: 'Which octave you sing in, relative to the original singer', onchange: (e) => { this.song.octave = +e.target.value; upsertSong(this.song); this.refreshKey(); } },
      h('option', { value: -1 }, 'Octave −1'), h('option', { value: 0, selected: true }, 'Same octave'), h('option', { value: 1 }, 'Octave +1'));
    this.trSel = h('select', { title: 'Transpose (audio files and practice copies)', onchange: (e) => this.setTranspose(+e.target.value) },
      ...Array.from({ length: 13 }, (_, i) => i - 6).map((v) => h('option', { value: v, selected: v === 0 }, v === 0 ? 'Original key' : (v > 0 ? '+' : '') + v + ' semitones')));
    t.append(
      h('div', { class: 'tgroup main' }, h('button', { class: 'btn round', title: 'Previous line (↑)', 'aria-label': 'Previous line', onclick: () => this.stepPhrase(-1) }, icon('prev', 18)), this.playBtn, h('button', { class: 'btn round', title: 'Next line (↓)', 'aria-label': 'Next line', onclick: () => this.stepPhrase(1) }, icon('next', 18)), this.timeEl),
      h('div', { class: 'tgroup' }, this.loopBtn, this.aBtn, this.bBtn, this.clearBtn),
      h('div', { class: 'tgroup' }, speedSeg),
      h('div', { class: 'tgroup' }, this.micBtn, modeSeg),
      h('div', { class: 'tgroup' }, this.soundSeg, h('label', { class: 'ctl', title: 'Play the melody as a clear tone (G)' }, this.guideChk, 'Guide tone')),
      h('div', { class: 'tgroup' }, this.octSel, this.trSel),
    );
  }
  async setSound(mode) {
    if (!(this.player && this.player.kind === 'audio')) { toast('Voice-only and backing track work on imported songs and practice copies.', 'info'); this.syncSoundSeg(); return; }
    if (!this.player.vocals) { toast('Analyse the song first. That step separates the voice from the music.', 'info'); this.syncSoundSeg(); return; }
    this.setStatus(mode === 'mix' ? '' : 'Preparing ' + (mode === 'vocals' ? 'the voice track' : 'the backing track') + '…');
    await this.player.setSound(mode);
    this.sound = mode; this.setStatus('');
  }
  syncSoundSeg() { if (this.soundSeg) [...this.soundSeg.children].forEach((b) => b.classList.toggle('on', b.dataset.v === (this.sound || 'mix'))); }

  // ---- library ---------------------------------------------------------------
  refreshSelect() {
    this.sel.innerHTML = '';
    for (const s of songs) this.sel.append(h('option', { value: s.id, selected: this.song && s.id === this.song.id }, s.title || s.id));
  }
  async activate() {
    this.active = true;
    this.refreshSelect();
    if (!this.song) await this.open(lastSong.get() && getSong(lastSong.get()) ? lastSong.get() : songs[0] && songs[0].id);
    this.loopRAF();
  }
  deactivate() {
    this.active = false;
    cancelAnimationFrame(this.raf);
    if (this.player && this.player.playing) this.player.pause();
    this.follower.set(0);
  }

  resetTake() {
    this.finishTake(true);
    this.curPhrase = null; this.lastTakeFrames = null; this.lastTake = null;
    this.feedback.innerHTML = '';
    this.feedback.append(h('p', { class: 'muted' }, 'Loop a line, turn on the mic, and sing. Feedback appears after each pass.'));
  }
  guardBusy() {
    if (!this.busy) return false;
    toast('Wait for the current melody capture/analysis to finish first.', 'info');
    this.refreshSelect();
    return true;
  }
  async open(id) {
    if (this.guardBusy()) return;
    this.resetTake();
    if (this.player) { this.player.destroy(); this.player = null; }
    if (!id || !getSong(id)) {
      this.song = null; this.mel = null; this.phrases = [];
      this.playerBox.innerHTML = '<p class="muted">Add a song to begin: "+ Add song" above.</p>';
      this.info.innerHTML = ''; this.overview.mel = null; this.overview.phrases = []; this.overview.duration = 0;
      this.lane.refAt = null; this.lane.labels = []; this.lane.message = 'No song loaded';
      this.renderPhrases();
      return;
    }
    const s = getSong(id);
    const token = (this.openToken = (this.openToken || 0) + 1);
    this.song = s; lastSong.set(id);
    s.octave = s.octave || 0; s.transpose = s.transpose || 0; s.best = s.best || {}; s.sync = s.sync || 0;
    this.source = s.kind === 'audio' ? 'audio' : (s.useCopy && s.hasCopy ? 'audio' : 'youtube');
    this.refreshSelect();
    this.loop = null; this.pendingA = null; this.loopOn = false; this.syncLoopUI();
    this.octSel.value = String(s.octave);
    this.trSel.value = '0';
    await this.mountPlayer();
    if (token !== this.openToken) return; // a newer open() took over
    await this.loadMelody();
    if (token !== this.openToken) return;
    this.renderInfo();
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
          const why = code === 101 || code === 150 ? 'YouTube won\'t play this video inside other sites (the owner may block embedding, or it\'s unavailable here).' : code === 100 ? 'This video was not found or is private.' : 'YouTube error ' + code + '.';
          this.playerBox.append(h('div', { class: 'warn' }, why + ' Workaround: ', h('a', { href: 'https://www.youtube.com/watch?v=' + s.videoId, target: '_blank', rel: 'noopener' }, 'open it on YouTube ↗'), ', then come back and use "+ Add song → Record from another tab". You\'ll get a practice copy you can loop, slow down and transpose.'));
        },
        onReady: (p) => { if (!s.titleFetched) { const t = p.title(); if (t) { s.title = t; s.titleFetched = true; upsertSong(s); this.refreshSelect(); } } },
      });
      await Promise.race([this.player.ready, new Promise((r) => setTimeout(r, 8000))]);
    } else {
      const blob = await idbGet('audio', s.id);
      if (!blob) { this.playerBox.append(h('div', { class: 'warn' }, 'The audio for this song is missing from this browser. Add it again.')); return; }
      this.player = new AudioPlayer(blob, { onState: (st) => this.onState(st) });
      await this.player.ready;
      const cover = h('div', { class: 'audio-cover' }, h('div', { class: 'big' }, icon('songs', 44)), h('div', {}, s.title));
      this.playerBox.append(cover);
      const stem = await idbGet('audio', s.id + ':vocals');
      if (stem && this.player) this.player.setVocals(fromI16(stem));
      this.sound = 'mix'; this.syncSoundSeg();
      if (s.transpose) { this.trSel.value = String(s.transpose); await this.player.setTranspose(s.transpose); }
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
    this.refreshKey();
    this.renderPhrases();
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
    this.lane.message = this.mel ? '' : 'No melody guide yet. Use "Build melody guide" above.';
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

  // ---- info panel ------------------------------------------------------------
  renderInfo() {
    const s = this.song, i = this.info; if (!s || this.capturing) return;
    i.innerHTML = '';
    i.append(h('h2', {}, s.title || 'Untitled'));
    if (s.note) i.append(h('p', { class: 'muted small' }, s.note));
    if (s.kind === 'youtube' && s.hasCopy) {
      const sw = h('div', { class: 'seg' },
        h('button', { class: 'btn small' + (this.source === 'youtube' ? ' on' : ''), onclick: () => this.switchSource('youtube') }, 'YouTube video'),
        h('button', { class: 'btn small' + (this.source === 'audio' ? ' on' : ''), onclick: () => this.switchSource('audio') }, 'Practice copy (transposable)'));
      i.append(h('div', { class: 'row' }, h('span', { class: 'muted small' }, 'Source: '), sw));
    }
    // melody status
    if (!this.mel) {
      i.append(h('div', { class: 'callout' },
        h('strong', {}, 'First, build the melody guide'),
        h('p', {}, this.source === 'youtube'
          ? 'Swara Lab listens to the song once while it plays, separates the voice from the instruments, and traces the melody. Click below, choose "This tab", and switch on "Also share tab audio". Keep this tab open while the song plays.'
          : 'Swara Lab separates the voice from the instruments and traces the melody. It runs on your computer and takes about a minute for a full song.'),
        this.source === 'youtube'
          ? h('button', { class: 'btn primary', onclick: () => this.captureTab() }, icon('headphones', 16), 'Build melody guide')
          : h('button', { class: 'btn primary', onclick: () => this.analyzeAudio() }, icon('sparkle', 16), 'Analyse the song'),
      ));
    } else {
      const sa = this.songSa, m = hzToMidi(sa);
      const cands = (s[this.source + 'SaCands'] || []).slice(1);
      i.append(h('div', { class: 'keyrow' },
        h('div', {}, h('div', { class: 'muted small' }, isIndian(settings) ? 'Song Sa (tonic)' : 'Song key note (tonic)'), h('div', { class: 'keyname' }, westernName(m), h('small', {}, ` ${(m - Math.round(m)) * 100 > 0 ? '+' : ''}${Math.round((m - Math.round(m)) * 100)}¢`)), isIndian(settings) ? h('div', { class: 'muted small' }, `${kattaiName(Math.round(m) % 12)} · ${kaliSafedName(Math.round(m) % 12)}`) : null),
        h('div', { class: 'col' },
          h('div', { class: 'row' }, h('button', { class: 'btn small', onclick: () => this.nudgeSa(-100) }, '−1 st'), h('button', { class: 'btn small', onclick: () => this.nudgeSa(100) }, '+1 st'), h('button', { class: 'btn small', onclick: () => this.nudgeSa(-10) }, '−10¢'), h('button', { class: 'btn small', onclick: () => this.nudgeSa(10) }, '+10¢')),
          cands.length ? h('div', { class: 'muted small' }, 'Other guesses: ', ...cands.map((hz) => h('a', { href: '#', onclick: (e) => { e.preventDefault(); this.setSa(hz); } }, westernName(hzToMidi(hz)) + ' '))) : null,
          h('div', { class: 'muted small' }, isIndian(settings) ? 'Check: the Sa line should sit where phrases come to rest.' : 'Check: the bold key-note line should be where phrases come to rest. Minor-key songs often rest there too.'),
        ),
      ));
      // range fit
      const fit = fitToRange(this.melP5, this.melP95, settings.rangeLowMidi, settings.rangeHighMidi);
      const span = `${westernName(hzToMidi(this.melP5))}–${westernName(hzToMidi(this.melP95))}`;
      if (fit) {
        const b = fit.best;
        const msg = b.st === 0 && b.oct === 0 ? `Melody spans ${span}. It fits your range as it is.`
          : `Melody spans ${span}. ${fit.asIs.over > 0 ? `As is, it goes ${fit.asIs.over} semitone(s) outside your comfortable range. ` : ''}Best fit: ${b.oct ? `octave ${b.oct > 0 ? '+1' : '−1'} ` : ''}${b.st ? `${b.st > 0 ? '+' : ''}${b.st} semitones` : ''}.`;
        i.append(h('p', { class: 'small' }, msg, ' ', h('a', { href: '#', onclick: (e) => { e.preventDefault(); this.applyFit(b); } }, 'Apply')));
      } else i.append(h('p', { class: 'small muted' }, `Melody spans ${span}. `, h('a', { href: '#range' }, 'Do the range test'), ' to get a key suggestion.'));
      const row = h('div', { class: 'row wrap' });
      if (this.source === 'youtube') row.append(h('button', { class: 'btn small', onclick: () => this.captureTab() }, icon('headphones', 14), 'Capture again'));
      else row.append(h('button', { class: 'btn small', onclick: () => this.analyzeAudio() }, icon('sparkle', 14), 'Re-analyse'));
      if (!s[this.source + 'Separated']) row.append(h('span', { class: 'small muted' }, 'Traced from the full mix. Re-analyse to separate the voice for better accuracy.'));
      i.append(row);
    }
    this.status = h('div', { class: 'status small' });
    i.append(this.status);
    this.renderTools();
  }
  nudgeSa(c) { this.setSa(this.songSa * Math.pow(2, c / 1200)); }
  setSa(hz) { this.song[this.source + 'Sa'] = hz; upsertSong(this.song); this.refreshKey(); this.renderPhrases(); }
  async applyFit(b) {
    this.song.octave = b.oct; this.octSel.value = String(b.oct);
    if (b.st && this.source !== 'audio') toast(this.song.hasCopy ? 'Switch to the practice copy to transpose by ' + b.st + ' semitones.' : 'To transpose a YouTube song, rebuild the melody guide with "save a practice copy" ticked.', 'info', 6000);
    else if (b.st) await this.setTranspose(b.st);
    upsertSong(this.song); this.refreshKey();
  }
  async setTranspose(st) {
    if (this.source !== 'audio') { this.trSel.value = '0'; toast(this.song.hasCopy ? 'Transpose works on the practice copy. Switch the source above.' : 'YouTube audio can\'t be pitch-shifted directly. Rebuild the melody guide with "save a practice copy" ticked, then use the copy.', 'info', 6000); return; }
    this.setStatus('Transposing…');
    await this.player.setTranspose(st);
    this.song.transpose = st; upsertSong(this.song); this.refreshKey();
    this.setStatus('');
  }
  async switchSource(src) {
    if (src === this.source || this.guardBusy()) return;
    this.resetTake();
    this.source = src; this.song.useCopy = src === 'audio'; upsertSong(this.song);
    if (this.player) { this.player.destroy(); this.player = null; }
    await this.mountPlayer(); await this.loadMelody();
    if (!this.mel && src === 'audio') await this.analyzeAudio();
    this.renderInfo();
  }
  setStatus(t) { if (this.status) this.status.textContent = t; }

  // ---- phrases -----------------------------------------------------------------
  renderPhrases() {
    const b = this.phraseBox; b.innerHTML = '';
    if (!this.song || !this.phrases || !this.phrases.length) { b.append(h('p', { class: 'muted' }, this.mel ? 'No lines found.' : 'Lines appear once the melody guide is built.')); return; }
    b.append(h('p', { class: 'muted small' }, 'Each row is one phrase (line) of the song. The letters are the notes the singer sings, approximately. Click a row to loop it, then sing along.'));
    const list = h('ol', { class: 'phrase-list' });
    this.phrases.forEach((p, i) => {
      const best = this.song.best[i];
      const li = h('li', { class: this.curPhrase === i ? 'cur' : '', onclick: () => this.loopPhrase(i) },
        h('span', { class: 'ptime mono' }, fmtTime(p.start)),
        h('span', { class: 'psargam' }, p.sargam || ''),
        h('span', { class: 'pbest ' + (best >= 75 ? 'good' : best >= 50 ? 'ok' : best != null ? 'bad' : '') }, best != null ? String(best) : '–'));
      list.append(li);
    });
    const orn = h('input', { type: 'checkbox', checked: !!settings.showOrnaments, onchange: (e) => { saveSettings({ showOrnaments: e.target.checked }); this.refreshKey(); this.renderPhrases(); } });
    b.append(list, h('label', { class: 'ctl small' }, orn, ' Show ornaments'));
    if (settings.showOrnaments) b.append(h('p', { class: 'muted small' }, isIndian(settings)
        ? '~ = meend (slide), * = gamak (shake), (x) = kan swar (grace note). '
        : '~ = slide, * = shake/trill, (x) = grace note. ', h('a', { href: '#learn' }, 'What are these?')));
  }
  loopPhrase(i) {
    const p = this.song && this.phrases && this.phrases[i]; if (!p) return;
    this.setLoop(Math.max(0, p.start - 0.4), p.end + 0.5, true);
    this.curPhrase = i; // set after setLoop, which clears it for custom loops
    this.player && this.player.seek(this.loop.a);
    this.renderPhrases();
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
  // A marks the start (playback carries on); B marks the end, and looping starts from A.
  markAB(which) {
    if (!this.player) return;
    const t = this.player.time();
    if (which === 'a') {
      this.finishTake(true);
      this.pendingA = t; this.loop = null; this.loopOn = false; this.curPhrase = null;
      this.syncLoopUI(); this.renderPhrases();
      toast(`Loop start set at ${fmtTime(t)}. Press "B end" where the section should stop.`, 'info', 3500);
      return;
    }
    const a = this.pendingA ?? (this.loop ? this.loop.a : null);
    if (a == null) { toast('Set the start first with "A start".', 'info'); return; }
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
    this.lane.regions = show ? [{ start: this.loop.a, end: this.loop.b, kind: 'loop' }] : marker ? [{ start: marker.a, end: marker.a + 0.04, kind: 'loop', label: 'A' }] : [];
    if (this.loopBtn) { this.loopBtn.classList.toggle('on', show); this.loopBtn.disabled = !this.loop; }
    if (this.aBtn) this.aBtn.classList.toggle('on', this.pendingA != null);
  }

  // ---- transport ---------------------------------------------------------------
  toggle() {
    if (!this.player) return;
    audioCtx();
    if (this.player.playing) this.player.pause();
    else {
      if (this.loopOn && this.loop) { const t = this.player.time(); if (t < this.loop.a - 0.2 || t > this.loop.b) this.player.seek(this.loop.a); }
      this.player.play();
    }
  }
  setMode(m) {
    this.mode = m;
    this.player && this.player.mute(m === 'muted');
    if (m === 'muted' && !this.guideOn) toast('Tip: turn on "Guide tone" to hear the melody as a soft tone while the song is muted.', 'info');
  }
  async toggleMic() {
    if (mic.running) { mic.stop(); document.dispatchEvent(new CustomEvent('mic-change')); }
    else await ensureMic();
    this.syncMicBtn();
  }
  syncMicBtn() { this.micBtn.replaceChildren(icon('mic', 15), mic.running ? 'Mic on' : 'Mic'); this.micBtn.classList.toggle('on', mic.running); }
  onState(st) {
    this.playBtn.replaceChildren(icon(st === 1 ? 'pause' : 'play', 22));
    if (st !== 1) this.follower.set(0);
    if (st === 2 || st === 0) this.finishTake(); // paused / ended (not buffering)
  }
  key(e) {
    if (!this.active || /INPUT|TEXTAREA|SELECT/.test(document.activeElement && document.activeElement.tagName)) return;
    const k = e.key;
    if (k === ' ') { e.preventDefault(); this.toggle(); }
    else if (k === '[') this.markAB('a');
    else if (k === ']') this.markAB('b');
    else if (k === 'l' || k === 'L') { if (this.loop) { this.loopOn = !this.loopOn; this.syncLoopUI(); } }
    else if (k === 'ArrowLeft') { this.player && this.player.seek(this.player.time() - 2); }
    else if (k === 'ArrowRight') { this.player && this.player.seek(this.player.time() + 2); }
    else if (k === 'ArrowUp') { e.preventDefault(); this.stepPhrase(-1); }
    else if (k === 'ArrowDown') { e.preventDefault(); this.stepPhrase(1); }
    else if (k === 'm' || k === 'M') this.toggleMic();
    else if (k === 'g' || k === 'G') { this.guideOn = !this.guideOn; this.guideChk.checked = this.guideOn; if (!this.guideOn) this.follower.set(0); }
  }

  // ---- main loop ------------------------------------------------------------------
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
    {
      const p = this.player;
      const t = p ? p.time() : 0;
      const playing = p && p.playing;
      if (this.timeEl) this.timeEl.textContent = fmtTime(t) + ' / ' + fmtTime(p ? p.duration() : 0);
      // looping
      if (playing && this.loopOn && this.loop && t >= this.loop.b) { this.finishTake(); p.seek(this.loop.a); }
      // mic frames
      if (mic.running && mic.last && playing && !this.capturing) {
        const f = mic.last;
        if (f !== this.lastMicFrame) {
          this.lastMicFrame = f;
          const lat = (mic.latencySec() + (c.outputLatency || 0.02) + (settings.latencyMs || 0) / 1000) * (p.r || 1);
          const st = t - lat;
          if (this.takeStart == null) { this.takeStart = st; this.startTakeRecording(); }
          this.frames.push({ t: st, c: f.hz > 0 ? 1200 * Math.log2(f.hz / this.practiceSa) : NaN });
        }
      }
      // guide tone follows the melody
      if (this.guideOn && playing && this.mel) {
        const r = this.refAt(t);
        this.follower.vol = settings.guideVol;
        this.follower.set(isNaN(r) ? 0 : this.practiceSa * Math.pow(2, r / 1200));
      }
      // lane
      this.lane.now = t;
      this.lane.user = this.frames.length ? this.frames : this.lastTakeFrames || [];
      this.lane.hideUserFrom = this.mode === 'blind' && playing ? -1e9 : Infinity;
      if (performance.now() - lastRange > 400) { this.lane.autoRange(t - 2, t + 6); setLastRange(performance.now()); }
      const last = this.frames[this.frames.length - 1];
      const ref = this.refAt(t);
      const cls = mic.running ? this.readout.update(last && playing ? last.c : (mic.last && mic.last.hz > 0 ? 1200 * Math.log2(mic.last.hz / this.practiceSa) : NaN), this.practiceSa, ref) : this.readout.update(NaN);
      this.lane.live = mic.running && this.mode !== 'blind' && last && playing ? { c: last.c, color: cls ? getComputedStyle(this.root).getPropertyValue('--' + cls) : null } : null;
      this.chip.textContent = this.capturing ? 'Listening to the song…' : (mic.running && playing ? (this.loopOn ? 'Take in progress' : 'Singing') : '');
      this.chip.className = 'phase-chip ' + (this.capturing ? 'listen' : 'sing');
      this.lane.draw();
      this.overview.duration = p ? p.duration() || (this.mel ? melodyDuration(this.mel) : 0) : 0;
      this.overview.now = t;
      this.overview.draw();
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
    const a = this.loopOn && this.loop ? this.loop.a : frames[0].t;
    const b = this.loopOn && this.loop ? this.loop.b : frames[frames.length - 1].t;
    const res = analyzeTake({
      frames, refAt: this.refAt, start: a, end: b, tol: settings.tol, octaveFree: settings.octaveFree, tuning: settings.tuning,
      rangeHi: settings.rangeHighMidi != null ? (settings.rangeHighMidi - hzToMidi(this.practiceSa)) * 100 : null,
    });
    this.lastTakeFrames = frames;
    this.lastTake = { res, blob, a, b, frames };
    if (this.curPhrase != null && this.loopOn && res.refVoicedSec > 0.8) {
      const prev = this.song.best[this.curPhrase];
      if (prev == null || res.score > prev) { this.song.best[this.curPhrase] = res.score; upsertSong(this.song); this.renderPhrases(); }
    }
    logActivity({ type: 'song', id: this.song.id, phrase: this.curPhrase, score: res.score, accuracy: res.accuracy, minutes: (b - a) / 60 / (this.speed || 1), perSwara: res.perSwara, weak: res.weak });
    this.renderFeedback(res, blob);
  }
  renderFeedback(res, blob) {
    const f = this.feedback; f.innerHTML = '';
    const big = h('div', { class: 'score-big ' + (res.score >= 75 ? 'good' : res.score >= 50 ? 'ok' : 'bad'), style: `--p:${res.score}` }, String(res.score));
    f.append(h('div', { class: 'result-top' }, big, h('div', { class: 'stats' },
      stat('In tune', Math.round(res.accuracy * 100) + '%'), stat('Sung', Math.round(res.coverage * 100) + '%'),
      stat('Avg offset', (res.bias > 0 ? '+' : '') + Math.round(res.bias) + '¢'),
      res.hiBias != null ? stat('High notes', (res.hiBias > 0 ? '+' : '') + Math.round(res.hiBias) + '¢') : null,
      res.wobble != null ? stat('Wobble', '±' + Math.round(res.wobble) + '¢') : null,
      res.ornRatio != null ? stat('Ornaments', Math.round(res.ornRatio * 100) + '%') : null)));
    const bias = swaraBiasText(res.perSwara);
    if (bias.length) f.append(h('p', { class: 'small' }, h('strong', {}, 'Note-by-note tuning: '), describeSwaraBias(bias.slice(0, 4))));
    f.append(tipList(res.tips));
    if (blob) {
      const url = URL.createObjectURL(blob);
      const au = h('audio', { controls: true, src: url, class: 'take-audio' });
      f.append(h('div', { class: 'row wrap' }, h('span', { class: 'small muted' }, 'Your take: '), au,
        h('button', { class: 'btn small', onclick: () => this.playTakeWithSong(url) }, icon('play', 14), 'Take + song')));
    }
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
    if (!navigator.mediaDevices || !navigator.mediaDevices.getDisplayMedia) return toast('Tab audio capture needs desktop Chrome or Edge. Alternatively upload the song as an audio file.', 'bad', 7000);
    const keepCopy = true; // the recorded copy is what the voice separation runs on
    let stream;
    try {
      stream = await navigator.mediaDevices.getDisplayMedia({
        video: { frameRate: 1, width: 320, height: 180 },
        audio: { echoCancellation: false, noiseSuppression: false, autoGainControl: false, suppressLocalAudioPlayback: false },
        preferCurrentTab: true, selfBrowserSurface: 'include', systemAudio: 'exclude', surfaceSwitching: 'exclude',
      });
    } catch (e) { return toast('Capture cancelled.', 'info'); }
    const at = stream.getAudioTracks()[0];
    if (!at) { stream.getTracks().forEach((t) => t.stop()); return toast('No audio was shared. Pick this tab and switch on "Also share tab audio".', 'bad', 7000); }
    const song = this.song, source = this.source;
    this.busy = true;
    try { await this._capture(stream, at, song, source, keepCopy); }
    finally { this.busy = false; this.capturing = false; setMasterMuted(false); }
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
    let w = 0, sinceHop = 0, total = 0;
    const lin = new Float32Array(an.win), rin = new Float32Array(an.win);
    const frames = this.captureFrames = new Map(); // grid index -> frame
    const preview = new Map();
    const p = this.player;
    tap.port.onmessage = (ev) => {
      const { L: bl, R: br, t: tEnd } = ev.data;
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
    const stopBtn = h('button', { class: 'btn primary' }, icon('stop', 14), 'Finish');
    const prog = h('span', { class: 'small' });
    this.status.innerHTML = ''; this.status.append(h('div', { class: 'callout' }, h('p', {}, 'Capturing. Let the song play to the end (or as far as you need), then press Finish. Don\'t switch the tab away from YouTube audio.'), h('div', { class: 'row' }, stopBtn, prog)));
    const startT = 0;
    if (!this.mel) { p.seek(startT); }
    p.setRate(1); p.play();
    // map recording time -> video time, so the separated melody can be placed on the video's timeline
    const mapping = [];
    let recStart = 0;
    if (rec) { rec.ondataavailable = (e) => e.data.size && chunks.push(e.data); rec.start(1000); recStart = performance.now(); }
    const mapTimer = setInterval(() => mapping.push({ rt: (performance.now() - recStart) / 1000, vt: p.time(), on: p.playing }), 100);
    const progTimer = setInterval(() => { prog.textContent = `${fmtTime(p.time())} / ${fmtTime(p.duration())}`; }, 500);
    await new Promise((res) => {
      stopBtn.onclick = res;
      at.addEventListener('ended', res, { once: true });
      const endChk = setInterval(() => { if (p.duration() && p.time() >= p.duration() - 0.3) { clearInterval(endChk); res(); } }, 500);
      stopBtn.addEventListener('click', () => clearInterval(endChk));
    });
    clearInterval(progTimer); clearInterval(mapTimer);
    p.pause();
    this.capturing = false;
    setMasterMuted(false);
    if (prevMode === 'muted') this.player.mute(true);
    p.setRate(this.speed);
    try { src.disconnect(); tap.disconnect(); tap._sink && tap._sink.disconnect(); } catch {}
    let copyBlob = null;
    if (rec && rec.state !== 'inactive') { await new Promise((r2) => { rec.onstop = r2; rec.stop(); }); copyBlob = new Blob(chunks, { type: rec.mimeType || 'audio/webm' }); }
    stream.getTracks().forEach((t) => t.stop());
    this.setStatus('Building melody…');
    // assemble grid, merge with any existing melody
    const idx = [...frames.keys()];
    if (idx.length < 100) { this.lane.refAt = prevRef; this.renderInfo(); return toast('Too little audio was captured. Was tab audio shared?', 'bad'); }
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
    if (copyBlob && copyBlob.size > 50000 && song.kind === 'youtube' && !song.hasCopy) {
      await idbPut('audio', song.id, copyBlob);
      song.hasCopy = true; savedCopy = true; upsertSong(song);
    }
    // Better melody: separate the voice from the recorded audio, then place it on the video timeline.
    if (copyBlob && copyBlob.size > 50000 && recStart) {
      try {
        const res = await analyzeBlob(copyBlob, (pr, stage) => this.setStatus(`${stage || 'Analysing…'} ${Math.round(pr * 100)}%`));
        if (res.separated) {
          const sepCents = placeOnVideo(res.mel, mapping, cents, frames, minI, maxCap);
          if (sepCents) { mel = { hop: 0.01, t0: 0, cents: sepCents }; song[source + 'Separated'] = true; }
          if (savedCopy) {
            await idbPut('melody', song.id + ':audio', packMelody(res.mel));
            await idbPut('audio', song.id + ':vocals', toI16(res.vocals));
            song.audioSeparated = true;
          }
          upsertSong(song);
        }
      } catch (e) { console.warn('separation after capture failed', e); }
      this.setStatus('');
    }
    await idbPut('melody', song.id + ':' + source, packMelody(mel));
    if (savedCopy) toast('Also saved a practice copy of the song: switch the source to "Practice copy" to transpose it or hear the voice or backing track on their own.', 'good', 7000);
    if (firstCapture) { song[source + 'Sa'] = null; upsertSong(song); }
    if (this.song !== song || this.source !== source) return; // user moved on; data is saved for later
    this.mel = mel;
    this.analyzeMelody();
    this.renderInfo();
    toast(`Melody guide ready: ${this.phrases.length} lines found.`, 'good');
  }

  async analyzeAudio() {
    if (!this.song || this.busy) return;
    const song = this.song;
    const blob = await idbGet('audio', song.id);
    if (!blob) return toast('Audio not found in this browser.', 'bad');
    this.busy = true;
    this.setStatus('Analysing… 0%');
    try {
      const { mel, vocals, separated } = await analyzeBlob(blob, (p, stage) => { if (this.song === song) this.setStatus(`${stage || 'Analysing…'} ${Math.round(p * 100)}%`); });
      await idbPut('melody', song.id + ':audio', packMelody(mel));
      if (vocals) await idbPut('audio', song.id + ':vocals', toI16(vocals));
      song.audioSa = null; song.audioSeparated = separated; upsertSong(song);
      if (this.song === song && this.source === 'audio') {
        if (vocals && this.player && this.player.kind === 'audio') this.player.setVocals(vocals);
        this.setStatus('');
        this.mel = mel;
        this.analyzeMelody(); this.renderInfo();
        toast(`Melody guide ready: ${this.phrases.length} lines found.`, 'good');
      }
    } catch (e) { this.setStatus(''); toast('Analysis failed: ' + e.message, 'bad', 7000); }
    finally { this.busy = false; }
  }

  // ---- adding songs ---------------------------------------------------------------
  async addUrl(url) {
    if (/spotify\.com/.test(url)) {
      toast('Spotify can\'t be embedded for full playback. Open the song in another Chrome tab, then use "Record from another tab". Afterwards it behaves like an audio file (loop, slow down, transpose).', 'info', 10000);
      return;
    }
    const id = parseYouTubeId(url);
    if (!id) return toast('That doesn\'t look like a YouTube link.', 'bad');
    const s = upsertSong({ id: 'yt-' + id, kind: 'youtube', videoId: id, title: 'YouTube ' + id, created: new Date().toISOString() });
    this.ytInput.value = ''; this.addBox.classList.remove('open');
    await this.open(s.id);
  }
  async addFile(file) {
    const id = 'au-' + Date.now().toString(36);
    await idbPut('audio', id, file);
    upsertSong({ id, kind: 'audio', title: file.name.replace(/\.[^.]+$/, ''), created: new Date().toISOString() });
    this.addBox.classList.remove('open');
    await this.open(id);
    await this.analyzeAudio();
  }
  async recordOtherTab() {
    if (!navigator.mediaDevices || !navigator.mediaDevices.getDisplayMedia) return toast('Recording another tab needs desktop Chrome or Edge.', 'bad');
    let stream;
    try {
      stream = await navigator.mediaDevices.getDisplayMedia({ video: { frameRate: 1, width: 320, height: 180 }, audio: { echoCancellation: false, noiseSuppression: false, autoGainControl: false }, selfBrowserSurface: 'exclude', systemAudio: 'include' });
    } catch { return; }
    const at = stream.getAudioTracks()[0];
    if (!at) { stream.getTracks().forEach((t) => t.stop()); return toast('No audio shared. Pick the tab with the song and switch on "Also share tab audio".', 'bad', 7000); }
    const rec = new MediaRecorder(new MediaStream([at]), { audioBitsPerSecond: 160000 });
    const chunks = [];
    rec.ondataavailable = (e) => e.data.size && chunks.push(e.data);
    rec.start(1000);
    const t0 = Date.now();
    const name = h('input', { type: 'text', placeholder: 'Song name', value: 'Recorded song' });
    const timer = h('span', { class: 'mono' }, '0:00');
    const stop = h('button', { class: 'btn primary' }, icon('stop', 14), 'Stop recording');
    const box = h('div', { class: 'callout' }, h('p', {}, 'Recording the other tab. Play the song there from the start, and press Stop when it ends.'), h('div', { class: 'row' }, name, timer, stop));
    this.addBox.append(box);
    const iv = setInterval(() => (timer.textContent = fmtTime((Date.now() - t0) / 1000)), 500);
    await new Promise((res) => { stop.onclick = res; at.addEventListener('ended', res, { once: true }); });
    clearInterval(iv);
    await new Promise((res) => { rec.onstop = res; rec.stop(); });
    stream.getTracks().forEach((t) => t.stop());
    box.remove();
    const blob = new Blob(chunks, { type: rec.mimeType || 'audio/webm' });
    if (blob.size < 20000) return toast('The recording is empty. Was tab audio shared?', 'bad');
    const id = 'au-' + Date.now().toString(36);
    await idbPut('audio', id, blob);
    upsertSong({ id, kind: 'audio', title: name.value || 'Recorded song', created: new Date().toISOString() });
    this.addBox.classList.remove('open');
    await this.open(id);
    await this.analyzeAudio();
  }
  remove() {
    if (!this.song) return;
    if (!confirm(`Remove "${this.song.title}" and its melody/practice data from this browser?`)) return;
    const id = this.song.id;
    if (this.player) this.player.destroy();
    this.player = null; this.song = null; this.mel = null;
    removeSong(id);
    this.refreshSelect();
    this.open(songs[0] && songs[0].id);
  }

  // ---- reference repair tools ---------------------------------------------------------
  renderTools() {
    const t = this.tools; t.innerHTML = '';
    t.append(h('summary', {}, 'Fix the melody guide / sync (advanced)'));
    const syncOut = h('span', { class: 'mono' }, (this.song.sync || 0) + ' ms');
    const sync = h('input', { type: 'range', min: -400, max: 400, step: 10, value: this.song.sync || 0, oninput: (e) => { this.song.sync = +e.target.value; syncOut.textContent = this.song.sync + ' ms'; }, onchange: () => upsertSong(this.song) });
    t.append(
      h('p', { class: 'small muted' }, 'Instruments (flute, violin, harmonium) can sometimes fool the melody extractor. Set a loop (drag on the overview strip, or press A/B) over the bad stretch and fix it:'),
      h('div', { class: 'row wrap' },
        h('button', { class: 'btn small', onclick: () => this.editRegion('up') }, 'Octave ↑'),
        h('button', { class: 'btn small', onclick: () => this.editRegion('down') }, 'Octave ↓'),
        h('button', { class: 'btn small', onclick: () => this.editRegion('erase') }, 'Erase (not the singer)'),
        h('button', { class: 'btn small', onclick: () => this.undoEdit() }, 'Undo')),
      h('label', { class: 'ctl' }, 'Guide sync ', sync, ' ', syncOut),
      h('p', { class: 'small muted' }, 'If the line is consistently ahead or behind the singer\'s voice, nudge the sync.'),
    );
  }
  async editRegion(op) {
    if (!this.mel || !this.loop) return toast('Set a loop region first (drag on the overview strip).', 'info');
    this.undo = Float32Array.from(this.mel.cents);
    const { hop, t0, cents } = this.mel;
    const a = Math.max(0, Math.floor((this.loop.a - t0) / hop)), b = Math.min(cents.length, Math.ceil((this.loop.b - t0) / hop));
    for (let i = a; i < b; i++) { if (isNaN(cents[i])) continue; cents[i] = op === 'up' ? cents[i] + 1200 : op === 'down' ? cents[i] - 1200 : NaN; }
    await idbPut('melody', this.song.id + ':' + this.source, packMelody(this.mel));
    this.analyzeMelody();
  }
  async undoEdit() {
    if (!this.undo || !this.mel) return;
    this.mel.cents = this.undo; this.undo = null;
    await idbPut('melody', this.song.id + ':' + this.source, packMelody(this.mel));
    this.analyzeMelody();
  }
}
