// Learn this line: a focused, step-by-step coach for one line (or riff) of a song.
// It takes over the Songs page. The studio keeps the pitch lane, the player and the lyrics where
// they are and hands the coach three containers (head, bar, out) plus a small API (see song.js).
//
// The method: listen first, then sing slowly with full guidance and take the guidance away step
// by step (constant feedback breeds dependence: the guidance hypothesis, Salmoni, Schmidt &
// Walter 1984), drill the hardest notes on their own, then put the line back together
// (part-whole practice).
import { analyzeTake, transcribe, noteResults, hardestSpan } from './coach.js';
import { settings, upsertSong, logActivity } from './store.js';
import { noteText, isIndian, SWARA_LONG } from './music.js';
import { h, ensureMic, menu, closePopover, fmtTime } from './ui.js';
import { icon } from './icons.js';

const LEAD = 1.4, TAIL = 0.6;   // seconds of song before and after the stretch that is sung
const SPEEDS = [0.5, 0.6, 0.75, 0.85, 1];
const PASS = 70;                // a sung step counts as passed from this best score
const STEPS = [
  { id: 'listen', name: 'Listen', short: 'Listen', speed: 0.85 },
  { id: 'guide', name: 'With the guide', short: 'Guide', speed: 0.75 },
  { id: 'song', name: 'With the singer', short: 'Singer', speed: 0.85 },
  { id: 'memory', name: 'On your own', short: 'Solo', speed: 1 },
];
const STEP = Object.fromEntries(STEPS.map((x, i) => [x.id, { ...x, i }]));
const nextStep = (id) => (STEPS[STEP[id].i + 1] || {}).id || null;
const WHY = 'Listening first builds an accurate memory of the sound. Then you sing slowly with full guidance and take it away step by step, because feedback that is always on makes you depend on it (the guidance hypothesis; Salmoni, Schmidt & Walter, 1984). Drilling just the hardest notes, then putting the line back together, is part–whole practice.';

const fmtSpeed = (v) => (v === 1 ? '1×' : v + '×');
const signed = (x) => (Math.round(x) > 0 ? '+' : Math.round(x) < 0 ? '−' : '') + Math.abs(Math.round(x));
const scoreClass = (v) => (v >= 75 ? 'good' : v >= 50 ? 'ok' : 'bad');
const ord = (n) => { const s = ['th', 'st', 'nd', 'rd'], v = n % 100; return n + (s[(v - 20) % 10] || s[v] || s[0]); };
const listJoin = (a) => (a.length < 2 ? a.join('') : a.slice(0, -1).join(', ') + ' and ' + a[a.length - 1]);
// A mouse click leaves focus on the button; drop it so Space goes back to the primary action.
const tap = (fn) => (e) => { if (e && e.detail > 0 && e.currentTarget && e.currentTarget.blur) e.currentTarget.blur(); fn(e); };

export class RiffCoach {
  constructor(studio) {
    this.s = studio;
    this.active = false;
    this.span = { a: 0, b: 0 };
  }

  // ---- open / close -------------------------------------------------------------
  open({ a, b, phrase = null } = {}) {
    const s = this.s;
    if (this.active) this.close();
    if (!s.song) return;
    const p = phrase != null && s.phrases ? s.phrases[phrase] : null;
    if (!(isFinite(a) && isFinite(b) && b > a) && p) { a = p.start; b = p.end; }
    if (!(isFinite(a) && isFinite(b) && b > a)) return;
    if (b - a < 0.5) { const m = (a + b) / 2; a = Math.max(0, m - 0.25); b = a + 0.5; }
    this.prev = {
      speed: s.speed, mode: s.mode, guideOn: !!s.guideOn, sound: this.soundNow(), // a restore may still be in flight
      loop: s.loop ? { a: s.loop.a, b: s.loop.b } : null, loopOn: !!s.loopOn, curPhrase: s.curPhrase ?? null,
    };
    this.active = true;
    this.line = { a, b, phrase: p ? phrase : null };
    this.recKey = this.line.phrase != null ? 'p' + this.line.phrase : `${a.toFixed(1)}-${b.toFixed(1)}`; // song.learn[recKey]
    this.hard = null;        // the part being drilled: {a, b, from, to}
    this.found = null;       // the hard part found in the last full-line pass
    this.result = null;      // what the out panel shows
    this.hardBest = {};      // best scores while drilling the hard part (this session only)
    this.sung = {};          // steps sung at least once ('l:guide', 'h:song', …)
    this.lineSpeeds = Object.fromEntries(STEPS.map((x) => [x.id, x.speed]));
    this.speeds = this.lineSpeeds; // each step remembers its own speed
    this.pass = null; this.lastPass = null; this.passN = 0; this.runPasses = 0; this.listens = 0;
    this.stopping = false; this.busy = false; this.muted = false; this.back = false;
    this.tokens = this.lineNotes();
    this.step = this.startStep();
    // take over the page
    const pl = s.player;
    s.finishTake(true);
    this.playing = !!(pl && pl.playing);
    if (this.playing) { this.stopping = true; pl.pause(); }
    s.root.classList.add('coaching');
    for (const [el, cls] of [[s.coachHead, 'rc-head'], [s.coachBar, 'rc-bar'], [s.coachOut, 'rc-out']]) { el.hidden = false; el.classList.add(cls); }
    this.buildBar();
    this.setSpan(this.line);
    this.applySoon();
    this.renderHead();
    this.renderOut();
  }

  close() {
    if (!this.active) return;
    const s = this.s, pl = s.player, prev = this.prev;
    this.active = false;
    this.stopTakeAudio();
    closePopover();
    s.finishTake(true);                 // a pass in progress isn't scored
    if (pl && pl.playing) pl.pause();
    s.collect = true;
    s.lane.fixed = null; s.lane.regions = [];
    s.lastTakeFrames = null;
    if (pl) { pl.setVolume(1); pl.mute(false); }
    if (s.speed !== prev.speed) s.setSpeed(prev.speed);
    if (s.mode !== prev.mode) s.setMode(prev.mode, true);
    if (!!s.guideOn !== prev.guideOn) s.setGuide(prev.guideOn);
    this.setSound(prev.sound);
    s.loopOn = false;
    if (prev.loop) s.setLoop(prev.loop.a, prev.loop.b, prev.loopOn); else s.loop = null;
    s.loopOn = !!(prev.loop && prev.loopOn);
    s.curPhrase = prev.curPhrase;
    s.root.classList.remove('coaching');
    for (const [el, cls] of [[s.coachHead, 'rc-head'], [s.coachBar, 'rc-bar'], [s.coachOut, 'rc-out']]) { el.hidden = true; el.classList.remove(cls); el.replaceChildren(); }
    this.stepBtns = null; this.goBtn = null;
  }

  // ---- the stretch being sung ---------------------------------------------------
  // The playback window is the span plus a lead-in and a tail; the lane shows exactly that window.
  setSpan(sp) {
    const s = this.s, L = s.lane, pl = s.player;
    this.span = { a: sp.a, b: sp.b };
    const dur = pl && pl.duration ? pl.duration() || 0 : 0;
    const a = Math.max(0, sp.a - LEAD);
    let b = sp.b + TAIL;
    if (dur > sp.b) b = Math.min(b, dur);
    this.win = { a, b };
    this.fixed = { t0: a, t1: b };
    s.setLoop(a, b, true);
    L.fixed = this.fixed;
    L.autoRange(a, b);
    L.lo = L.targetLo; L.hi = L.targetHi;
    this.range = { lo: L.targetLo, hi: L.targetHi };
    s.lastTakeFrames = null;
    s.seekTo(a);
    this.updateRegions();
  }
  // Lane shading: on the whole line, where it went wrong; while drilling, the stretch that is scored.
  updateRegions() {
    const f = this.found;
    this.regions = this.hard ? [{ start: this.span.a, end: this.span.b, kind: 'sing' }]
      : f ? [{ start: f.a, end: f.b, kind: 'loop', label: 'Hard part' }] : [];
  }

  // Held notes of the line (the same ones the header lists and the result scores).
  lineNotes() {
    const s = this.s, L = this.line;
    if (!s.mel || !s.refAt) return [];
    const toks = transcribe(s.refAt, L.a, L.b, { tuning: settings.tuning, notation: settings.notation, saHz: s.practiceSa });
    return toks.filter((t) => t.dur >= 0.12).map((t, n) => ({ t: t.t, dur: t.dur, idx: t.idx, oct: t.oct, n }));
  }
  notesIn(sp) { return this.tokens.filter((t) => t.t + t.dur / 2 >= sp.a && t.t + t.dur / 2 <= sp.b); }
  label(t) { const x = noteText(t.idx, t.oct, this.s.practiceSa, settings); return isIndian(settings) ? x : x.replace(/-?\d+$/, ''); }
  proseName(t) { return isIndian(settings) ? SWARA_LONG[t.idx] : this.label(t); }

  // ---- progress ------------------------------------------------------------------
  peek() { const L = this.s.song.learn; return (L && L[this.recKey]) || {}; }
  rec() { const s = this.s, L = s.song.learn || (s.song.learn = {}); return L[this.recKey] || (L[this.recKey] = {}); }
  save() { upsertSong(this.s.song); }
  best(id) { return this.hard ? this.hardBest[id] : this.peek()[id]; }
  passed(id) { if (id === 'listen') return !!this.peek().listen; const b = this.best(id); return b != null && b >= PASS; }
  startStep() {
    const r = this.peek();
    if (!r.listen) return 'listen';
    if (!(r.guide >= PASS)) return 'guide';
    if (!(r.song >= PASS)) return 'song';
    return 'memory';
  }
  markListened() {
    const r = this.rec();
    if (!r.listen) { r.listen = 1; this.save(); }
    if (this.step === 'listen') this.select('guide');
    else this.syncBar();
  }

  // ---- step settings ---------------------------------------------------------------
  applyStep() {
    const s = this.s, pl = s.player, st = this.step;
    const v = this.speeds[st];
    if (s.speed !== v) s.setSpeed(v);
    if (!!s.guideOn !== (st === 'guide')) s.setGuide(st === 'guide');
    const mode = st === 'memory' ? 'blind' : 'along';
    if (s.mode !== mode) s.setMode(mode, true);
    if (pl) { pl.setVolume(st === 'guide' ? 0.3 : 1); pl.mute(false); }
    this.muted = false;
    s.collect = st !== 'listen';
    return this.setSound(st === 'listen' && s.canStems() ? 'vocals' : 'mix');
  }
  // The studio's setSound is async (it may rebuild the audio): track where it is heading.
  soundNow() { return this.soundP ? this.soundWant : this.s.sound || 'mix'; }
  setSound(snd) {
    const s = this.s;
    if (this.soundNow() === snd) return this.soundP || Promise.resolve();
    this.soundWant = snd;
    const p = this.soundP = Promise.resolve().then(() => s.setSound(snd)).catch((e) => console.warn(e))
      .finally(() => { if (this.soundP === p) this.soundP = null; });
    return p;
  }
  select(id) {
    if (!this.active || !STEP[id] || id === this.step) return;
    if (this.playing && !this.stopping) this.stop();
    this.step = id;
    this.listens = 0;
    this.s.lastTakeFrames = null;
    this.applySoon();
    this.syncBar();
  }
  // While a pause is still landing, wait for it (no guide tone over the tail of the last pass).
  applySoon() { if (this.stopping) this.applyLater = true; else this.applyStep(); }
  setStepSpeed(v) {
    this.speeds[this.step] = v;
    this.s.setSpeed(v);
    if (this.pass && this.pass.step === this.step) { this.pass.speed = v; this.pass.minSpeed = Math.min(this.pass.minSpeed, v); }
    this.syncControls();
  }
  openSpeed(anchor) {
    menu(anchor, [{ head: 'Speed · the pitch stays the same' },
      ...SPEEDS.map((v) => ({ label: fmtSpeed(v), checked: this.speeds[this.step] === v, onclick: () => this.setStepSpeed(v) }))], { align: 'end' });
  }

  // ---- playback ---------------------------------------------------------------------
  primary() {
    if (!this.active || this.busy) return;
    if (this.playing && !this.stopping) this.stop();
    else this.start();
  }
  // Play the window from the top in the current step. Works while already playing (the pass restarts).
  async start({ reveal = false } = {}) {
    const s = this.s, pl = s.player;
    if (!pl || this.busy) return;
    this.busy = true; this.syncControls();
    try {
      const st = this.step;
      if (st !== 'listen' && !(await ensureMic())) return;
      this.applyLater = false;
      await this.applyStep();
      if (!this.active || st !== this.step) return;
      this.stopTakeAudio();
      s.finishTake(true);
      s.lastTakeFrames = null;
      this.listens = 0; this.runPasses = 0;
      s.seekTo(this.win.a);
      this.beginPass();
      this.stopping = false;
      pl.play();
      if (reveal) this.reveal();
    } finally {
      this.busy = false;
      if (this.active) this.syncControls();
    }
  }
  // Stop now. A pass that reached the end of the line is still scored; a partial one isn't.
  stop() {
    const s = this.s, pl = s.player;
    if (!pl) return;
    const done = this.pass && this.step !== 'listen' && pl.time() >= this.span.b - 0.1;
    if (done) { this.endPass(); s.finishTake(false); } else this.discard();
    this.halt();
  }
  discard() { this.pass = null; this.s.finishTake(true); } // drop the pass in progress
  halt() { // pause; the studio then ends the take and calls onTake
    const pl = this.s.player;
    if (pl && pl.playing) { this.stopping = true; pl.pause(); }
    this.listens = 0;
    this.syncControls();
  }
  beginPass() {
    if (this.lastPass && performance.now() - this.lastPass.ended > 4000) this.lastPass = null;
    const v = this.s.speed || this.speeds[this.step];
    this.pass = { step: this.step, hard: this.hard, span: { ...this.span }, win: { ...this.win }, speed: v, minSpeed: v, n: ++this.passN };
    this.runPasses++;
  }
  endPass() {
    const p = this.pass;
    this.pass = null;
    if (!p || p.used) return;
    p.ended = performance.now();
    this.lastPass = p;
  }
  // The studio: playback reached the end of the window while looping.
  passEnd() {
    if (!this.active || this.stopping) return;
    const now = performance.now();
    if (now - (this.passEndAt || 0) < 400) return; // the seek back hasn't landed yet
    this.passEndAt = now;
    const s = this.s;
    if (this.step === 'listen') {
      if (++this.listens < 2) { s.seekTo(this.win.a); this.wrapped = true; this.syncCounter(); return; }
      this.pass = null;
      this.halt();
      this.markListened();
      return;
    }
    if (!this.pass) this.beginPass(); // playback was started from elsewhere
    this.endPass();
    s.finishTake(false);              // scored: the studio calls onTake
    if (this.step === 'memory') { this.halt(); return; } // one pass, then the result
    s.seekTo(this.win.a);
    this.wrapped = true;
    this.beginPass();
    this.syncCounter();
  }
  // The studio: every animation frame while coaching.
  frame(t, playing) {
    if (!this.active) return;
    const s = this.s, L = s.lane, pl = s.player;
    if (L.fixed !== this.fixed) L.fixed = this.fixed;
    if (this.range) { L.targetLo = this.range.lo; L.targetHi = this.range.hi; }
    L.regions = this.regions;
    if (playing !== this.playing) {
      this.playing = playing;
      if (playing) { if (!this.pass && !this.stopping) this.beginPass(); }
      else {
        this.stopping = false; this.endPass(); this.listens = 0;
        if (this.applyLater) { this.applyLater = false; this.applyStep(); }
      }
      this.syncControls();
    }
    // a safety net for a missed loop end
    if (playing && !this.stopping && t > this.win.b + 0.3) this.passEnd();
    // The frame that wrapped still carries the time from before the seek: don't collect it,
    // or the next pass starts with a sample stamped at the end of the window.
    const collect = this.step !== 'listen' && !this.wrapped;
    if (s.collect !== collect) s.collect = collect;
    this.wrapped = false;
    // On your own: the song drops out where the singer comes in
    const mute = !!(playing && this.step === 'memory' && t >= this.span.a - 0.08 && t <= this.win.b + 0.3);
    if (mute !== this.muted && pl) { this.muted = mute; pl.mute(mute); }
    this.syncCounter();
  }
  reveal() {
    const c = this.s.lane && this.s.lane.c;
    if (!c || !c.getBoundingClientRect) return;
    const r = c.getBoundingClientRect();
    if (r.top < 0 || r.bottom > window.innerHeight) c.scrollIntoView({ block: 'nearest', behavior: matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth' });
  }

  // ---- results --------------------------------------------------------------------
  // The studio: a pass with singing ended. res = analyzeTake over this.span.
  onTake(res, frames, blob) {
    if (!this.active) return;
    const s = this.s;
    const ctx = this.lastPass && !this.lastPass.used ? this.lastPass : this.pass;
    this.lastPass = null;
    if (!ctx || ctx.used || ctx.step === 'listen' || !frames || !frames.length) return;
    ctx.used = true;
    const sp = ctx.span;
    // in time order (a frame taken on the loop wrap can carry the time from before the seek)
    let sorted = true;
    for (let i = 1; i < frames.length && sorted; i++) if (frames[i].t < frames[i - 1].t) sorted = false;
    if (!sorted) frames = frames.slice().sort((x, y) => x.t - y.t);
    if (frames[0].t > sp.a + 0.3 || frames[frames.length - 1].t < sp.b - 0.3) return; // a partial pass
    const opt = { refAt: s.refAt, start: sp.a, end: sp.b, tol: settings.tol, octaveFree: settings.octaveFree, tuning: settings.tuning };
    const same = sorted && this.span.a === sp.a && this.span.b === sp.b;
    const base = res && same ? res : analyzeTake({ frames, ...opt });
    if (!(base.refVoicedSec >= 0.5)) { this.result = { empty: true }; this.renderOut(); return; }
    // Pitch is judged on its own: a steady timing offset is reported, not penalised.
    const lag = base.lag || 0;
    let scored = base, fr = frames;
    if (Math.abs(lag) >= 0.05) {
      const shifted = frames.map((f) => ({ t: f.t - lag, c: f.c }));
      const r2 = analyzeTake({ frames: shifted, ...opt });
      if (r2.score >= base.score) { scored = r2; fr = shifted; }
    }
    const score = scored.score;
    const notes = noteResults(this.notesIn(sp), fr, s.refAt, { tol: settings.tol, octaveFree: settings.octaveFree });
    const found = ctx.hard ? null : this.worthDrilling(hardestSpan(notes), notes);
    const field = ctx.step;
    if (ctx.hard) {
      if (!(this.hardBest[field] >= score)) this.hardBest[field] = score;
    } else {
      const r = this.rec();
      if (!(r[field] >= score)) r[field] = score;
      // a full-line pass at full speed without the guide counts as the line's best
      if (this.line.phrase != null && (field === 'song' || field === 'memory') && ctx.minSpeed >= 1) {
        const best = s.song.best || (s.song.best = {});
        if (!(best[this.line.phrase] >= score)) best[this.line.phrase] = score;
      }
      this.save();
      this.found = found;
    }
    this.sung[(ctx.hard ? 'h:' : 'l:') + field] = true;
    logActivity({ type: 'song', id: s.song.id, phrase: this.line.phrase, score, accuracy: scored.accuracy,
      minutes: (ctx.win.b - ctx.win.a) / 60 / (ctx.speed || 1), perSwara: scored.perSwara, weak: scored.weak, coach: field, ...(ctx.hard ? { part: 'hard' } : {}) });
    const fresh = !this.result || this.result.empty;
    this.result = { ctx, score, res: scored, lag, notes, outline: ctx.hard || found, found, blob, fresh };
    this.back = false;
    this.updateRegions();
    this.syncBar();
    this.renderOut();
  }
  // Drilling a part pays off when it is clearly shorter than the line and the rest mostly works;
  // when most of the line is off, the line itself (slower, or a step back) is the thing to practise.
  worthDrilling(f, notes) {
    if (!f || f.b - f.a >= 0.8 * (this.line.b - this.line.a)) return null;
    const rest = notes.filter((n) => n.n < f.from || n.n > f.to);
    const fine = rest.filter((n) => n.status === 'good' || n.status === 'ok').length;
    return rest.length && fine >= rest.length / 2 ? f : null;
  }

  drill(f) {
    if (!f) return;
    this.discard();
    this.lineStep = this.step;
    this.hard = { a: f.a, b: f.b, from: f.from, to: f.to };
    this.hardBest = {};
    this.speeds = { ...this.lineSpeeds, guide: Math.min(this.lineSpeeds.guide, 0.75) };
    this.result = null;
    this.setSpan(this.hard);
    this.step = 'guide';
    this.renderHead(); this.syncBar(); this.renderOut();
    this.start({ reveal: true });
  }
  wholeLine() {
    if (!this.hard) return;
    this.discard(); this.halt();
    this.hard = null;
    this.speeds = this.lineSpeeds;
    this.result = null; this.back = true;
    this.setSpan(this.line);
    this.step = this.lineStep || this.startStep();
    this.applySoon();
    this.renderHead(); this.syncBar(); this.renderOut();
    this.reveal();
  }
  goStep(id) { // from the result: carry straight on into the next step
    this.discard();
    this.step = id; this.listens = 0;
    this.syncBar();
    this.start({ reveal: true });
  }
  trySpeed(id, v) {
    if (id !== this.step) this.select(id);
    this.setStepSpeed(v);
    if (!(this.playing && !this.stopping)) this.start({ reveal: true });
  }

  // ---- keys ------------------------------------------------------------------------
  key(e) {
    if (!this.active) return false;
    const k = e.key;
    if (k === ' ') {
      const ae = document.activeElement;
      if (ae && ae !== document.body && ae.closest && ae.closest('button, summary, [role="button"]')) return false; // the focused control acts
      this.primary();
      return true;
    }
    if (/^[1-4]$/.test(k)) { this.select(STEPS[+k - 1].id); return true; }
    if (k === '[' || k === ']' || k === 'l' || k === 'L' || k === 'ArrowLeft' || k === 'ArrowRight') return true; // the coach owns the loop
    return false;
  }
  onLyrics() { if (this.active) this.renderHead(); }

  // ---- header -------------------------------------------------------------------------
  renderHead() {
    const s = this.s, L = this.line;
    const words = this.lyricText();
    const notes = this.tokens.map((t) => this.label(t)).join(' ');
    const total = s.phrases ? s.phrases.length : 0;
    const eyebrow = L.phrase != null ? `Line ${L.phrase + 1} of ${total} · ${fmtTime(L.a)}` : `Your selection · ${fmtTime(L.a)}–${fmtTime(L.b)}`;
    const lines = words ? words.split(/\s+\/\s+/).filter(Boolean) : [];
    const title = lines.length ? lines.map((x) => h('span', { class: 'rc-tl' }, x))
      : notes || (L.phrase != null ? `Line ${L.phrase + 1}` : 'Your selection');
    const long = words.length > 70 || lines.length > 2;
    s.coachHead.replaceChildren(...[
      h('a', { class: 'back rc-back', href: '#songs' }, icon('back', 18), h('span', {}, s.song.title || 'Songs')),
      h('div', { class: 'eyebrow rc-eyebrow' }, eyebrow),
      h('h1', { class: 'rc-title' + (lines.length ? '' : ' notes') + (long ? ' long' : '') }, title),
      lines.length && notes ? h('p', { class: 'rc-notes', 'aria-label': 'Notes' }, notes) : null,
      this.hard ? h('div', { class: 'rc-part' },
        h('span', { class: 'rc-part-l' }, 'Hard part'),
        h('span', { class: 'rc-part-t' }, `· ${fmtTime(this.hard.a)}–${fmtTime(this.hard.b)}`),
        h('button', { class: 'btn small', onclick: tap(() => this.wholeLine()) }, 'Whole line')) : null,
    ].filter(Boolean));
  }
  lyricText() {
    try { const l = this.s.lyrics; return (l && l.textBetween && l.textBetween(this.line.a, this.line.b)) || ''; } catch { return ''; }
  }

  // ---- bar: steps, one sentence, speed, primary --------------------------------------------
  buildBar() {
    this.stepBtns = {};
    const steps = h('div', { class: 'rc-steps', role: 'group', 'aria-label': 'Steps' },
      ...STEPS.map((st, i) => {
        const badge = h('span', { class: 'rc-badge', 'aria-hidden': 'true' });
        const best = h('span', { class: 'rc-best', 'aria-hidden': 'true' });
        const b = h('button', { class: 'rc-step', onclick: tap(() => this.select(st.id)) },
          badge,
          h('span', { class: 'rc-name', 'aria-hidden': 'true' }, h('span', { class: 'rc-full' }, st.name), h('span', { class: 'rc-short' }, st.short)),
          best);
        this.stepBtns[st.id] = { b, badge, best, i };
        return b;
      }));
    this.sayEl = h('p', { class: 'rc-say' });
    this.countEl = h('span', { class: 'rc-count', 'aria-hidden': 'true' });
    this.speedBtn = h('button', { class: 'btn small rc-speed', title: 'Speed (the pitch stays the same)', 'aria-haspopup': 'menu', onclick: (e) => this.openSpeed(e.currentTarget) });
    this.goBtn = h('button', { class: 'btn primary rc-go', onclick: tap(() => this.primary()) });
    this.liveEl = h('p', { class: 'rc-sr', role: 'status', 'aria-live': 'polite' }); // results, for screen readers
    this.ctlSig = '';
    this.s.coachBar.replaceChildren(steps, h('div', { class: 'rc-row' }, this.sayEl, h('div', { class: 'rc-ctl' }, this.countEl, this.speedBtn, this.goBtn)), this.liveEl);
    this.syncBar();
  }
  syncBar() {
    if (!this.stepBtns) return;
    for (const st of STEPS) {
      const { b, badge, best, i } = this.stepBtns[st.id];
      const cur = st.id === this.step, done = this.passed(st.id);
      b.classList.toggle('cur', cur); b.classList.toggle('done', done);
      if (cur) b.setAttribute('aria-current', 'step'); else b.removeAttribute('aria-current');
      badge.replaceChildren(done ? icon('check', 12) : String(i + 1));
      const v = st.id === 'listen' ? null : this.best(st.id);
      best.textContent = v != null ? String(v) : '';
      best.className = 'rc-best' + (v != null ? ' ' + scoreClass(v) : '');
      b.setAttribute('aria-label', `Step ${i + 1}, ${st.name}${done ? ', passed' : ''}${v != null ? ', best ' + v : ''}`);
    }
    this.sayEl.textContent = this.describe();
    this.syncControls();
  }
  describe() {
    switch (this.step) {
      case 'listen': return this.s.canStems() ? 'Hear it twice, with the singer alone.' : 'Hear it twice and follow the shape of the line.';
      case 'guide': return 'Sing along with a guide tone. The song plays quietly.';
      case 'song': return 'Sing with the original singer. No guide tone.';
      default: return 'The song stops where you come in. Sing it from memory.';
    }
  }
  syncControls() {
    if (!this.goBtn) return;
    const playing = this.playing && !this.stopping, st = this.step;
    const again = this.sung[(this.hard ? 'h:' : 'l:') + st];
    const [ic, label] = this.busy ? ['more', 'Preparing'] : playing ? ['stop', 'Stop'] : st === 'listen' ? ['play', 'Listen'] : again ? ['loop', 'Again'] : ['mic', 'Sing'];
    const sp = fmtSpeed(this.speeds[st]);
    const sig = label + '|' + sp + '|' + this.busy;
    if (sig === this.ctlSig) return;
    this.ctlSig = sig;
    this.goBtn.replaceChildren(icon(ic, 16), label);
    this.goBtn.disabled = this.busy;
    this.goBtn.title = label + ' (Space)';
    this.speedBtn.replaceChildren(icon('slow', 15), sp);
    this.speedBtn.setAttribute('aria-label', 'Speed ' + sp);
    this.syncCounter();
  }
  syncCounter() {
    if (!this.countEl) return;
    const playing = this.playing && !this.stopping;
    const txt = !playing ? '' : this.step === 'listen' ? `${Math.min(2, this.listens + 1)} of 2` : this.step === 'memory' ? '' : this.runPasses > 1 ? `Pass ${this.runPasses}` : '';
    if (txt !== this.countEl.textContent) this.countEl.textContent = txt;
  }

  // ---- out: the hint before a pass, the result after one ---------------------------------
  renderOut() {
    const el = this.s.coachOut, R = this.result;
    this.stopTakeAudio();
    el.replaceChildren(R && !R.empty ? this.resultCard(R) : this.hint(R && R.empty));
  }
  hint(empty) {
    const s = this.s;
    const msg = empty ? 'There is almost no singing in this stretch to compare with.'
      : !s.mel ? 'This song has no melody guide yet, so passes can’t be scored.'
        : this.hard ? 'Loop just these notes until they’re clean, then sing the whole line again.'
          : this.back ? 'Now sing the whole line again.'
            : 'Wear headphones if you can, so the mic hears only you.';
    return h('div', { class: 'rc-hint' },
      h('p', { class: 'rc-tip' }, icon(this.hard ? 'target' : 'headphones', 16), h('span', {}, msg)),
      h('details', { class: 'rc-why' },
        h('summary', {}, h('span', {}, 'Why these steps'), icon('chevron', 14)),
        h('p', {}, WHY, ' ', h('a', { href: '#learn' }, 'More in Learn'))));
  }
  verdict(R) {
    const clean = !R.notes.some((n) => n.status === 'bad' || n.status === 'miss'); // not "that's it" while a note is clearly off
    return R.score >= 85 && clean ? 'That’s it.' : R.score >= 70 ? 'Close.' : 'Keep at it.';
  }
  resultCard(R) {
    const { ctx, score, notes, lag } = R;
    const verdict = this.verdict(R), advice = this.advice(notes, lag, R.res, score);
    const meta = STEP[ctx.step].name + ' · ' + fmtSpeed(ctx.speed) + (ctx.hard ? ' · hard part' : '');
    if (this.liveEl) this.liveEl.textContent = `${score}. ${verdict} ${advice}`;
    const card = h('section', { class: 'rc-card' + (R.fresh ? ' fresh' : ''), 'aria-label': 'Result' },
      h('div', { class: 'rc-top' },
        h('div', { class: 'score-big ' + scoreClass(score), style: `--p:${score}`, role: 'img', 'aria-label': `Score ${score} of 100` }, String(score)),
        h('div', { class: 'rc-sum' },
          h('div', { class: 'rc-meta' }, meta),
          h('h2', { class: 'rc-verdict' }, verdict),
          h('p', { class: 'rc-advice' }, advice))),
      notes.length ? this.chips(notes, R.outline) : null,
      this.actions(R));
    R.fresh = false;
    return card;
  }
  advice(notes, lag, res, score) {
    const out = [];
    const sung = notes.filter((n) => n.status !== 'miss'), missed = notes.filter((n) => n.status === 'miss');
    let worst = null;
    for (const n of sung) if (!worst || Math.abs(n.dev) > Math.abs(worst.dev)) worst = n;
    // name the note furthest off: always when it's outside the tolerance, and when the score
    // shows there is still something to fix even though every note landed inside it
    if (worst && (worst.status !== 'good' || (score < 85 && Math.abs(worst.dev) >= 15))) out.push(this.noteSentence(worst));
    else if (sung.length && !missed.length) out.push('Every note was in tune.');
    else if (!notes.length && res && Math.abs(res.bias) >= 20) {
      const d = Math.round(Math.abs(res.bias));
      out.push(`You were ${d} cents ${res.bias < 0 ? 'flat' : 'sharp'} overall: aim a little ${res.bias < 0 ? 'higher' : 'lower'}.`);
    }
    if (missed.length) {
      if (!sung.length) out.push('The mic didn’t catch any of the notes.');
      else if (missed.length <= 3) out.push(`You missed the ${listJoin(missed.map((n) => ord(n.n + 1)))} note${missed.length > 1 ? 's' : ''}.`);
      else out.push(`You missed ${missed.length} notes.`);
    }
    if (Math.abs(lag) >= 0.12) out.push(`You came in ${(Math.round(Math.abs(lag) * 10) / 10).toFixed(1)} s ${lag > 0 ? 'late' : 'early'}.`);
    return out.join(' ');
  }
  noteSentence(n) {
    const pitch = (t) => t.idx + 12 * t.oct;
    const all = this.tokens.map(pitch), hi = Math.max(...all), lo = Math.min(...all);
    const q = hi - lo >= 3 ? (pitch(n) === hi ? 'high ' : pitch(n) === lo ? 'low ' : '') : '';
    const d = Math.abs(n.dev), flat = n.dev < 0;
    const amount = d < 100 ? `${Math.round(d)} cents` : d < 150 ? 'a semitone' : `about ${Math.round(d / 100)} semitones`;
    const aim = (d < 60 ? 'aim a little ' : 'aim ') + (flat ? 'higher' : 'lower');
    return `The ${q}${this.proseName(n)} (${ord(n.n + 1)} note) was ${amount} ${flat ? 'flat' : 'sharp'}: ${aim}.`;
  }
  chips(notes, outline) {
    const box = h('div', { class: 'note-chips rc-chips' });
    let group = null;
    for (const n of notes) {
      const miss = n.status === 'miss';
      const chip = h('span', { class: 'chip ' + n.status, title: `${ord(n.n + 1)} note · ${miss ? 'not heard' : signed(n.dev) + ' cents'}` },
        this.label(n), h('small', {}, miss ? '–' : signed(n.dev)));
      if (outline && n.n >= outline.from && n.n <= outline.to) {
        if (!group) { group = h('span', { class: 'rc-hardnotes', title: 'Hard part' }); box.append(group); }
        group.append(chip);
      } else { group = null; box.append(chip); }
    }
    return box;
  }
  actions(R) {
    const { ctx, score } = R;
    const nx = nextStep(ctx.step), good = score >= 75;
    const btn = (label, fn, { primary = false, ic = null } = {}) =>
      h('button', { class: 'btn small' + (primary ? ' primary' : ''), onclick: tap(fn) }, ic ? icon(ic, 15) : null, label);
    const left = [], right = [];
    if (!ctx.hard && R.found && !this.hard) left.push(btn('Practise the hard part', () => this.drill(R.found), { ic: 'target' }));
    if (ctx.hard && this.hard) left.push(btn('Back to the whole line', () => this.wholeLine(), { primary: !nx && good }));
    const up = SPEEDS.find((v) => v > ctx.speed);
    const speeds = ctx.hard ? (this.hard ? this.speeds : null) : this.lineSpeeds;
    if (score >= 80 && ctx.speed < 1 && up && speeds && speeds[ctx.step] <= ctx.speed) left.push(btn(`Try ${fmtSpeed(up)}`, () => this.trySpeed(ctx.step, up)));
    if (R.blob) {
      const take = btn('Your take', () => this.playTake(take, R.blob), { ic: 'play' });
      take.classList.add('rc-take');
      right.push(take);
    }
    if (nx) right.push(btn(`Next: ${STEP[nx].name}`, () => this.goStep(nx), { primary: good }));
    else if (!ctx.hard && this.line.phrase != null && this.s.phrases && this.line.phrase + 1 < this.s.phrases.length) {
      right.push(h('a', { class: 'btn small' + (good ? ' primary' : ''), href: `#songs/learn/${this.line.phrase + 1}` }, 'Next line'));
    }
    return h('div', { class: 'rc-acts' }, h('div', { class: 'rc-acts-l' }, left), h('div', { class: 'rc-acts-r' }, right));
  }

  // ---- your take ------------------------------------------------------------------------
  playTake(btn, blob) {
    if (this.takeAudio) { const same = this.takeAudio.btn === btn; this.stopTakeAudio(); if (same) return; }
    if (this.playing && !this.stopping) this.stop();
    const url = URL.createObjectURL(blob), au = new Audio(url);
    this.takeAudio = { au, url, btn };
    const done = () => { if (this.takeAudio && this.takeAudio.au === au) this.stopTakeAudio(); };
    au.addEventListener('ended', done); au.addEventListener('error', done);
    au.play().catch(done);
    btn.replaceChildren(icon('pause', 15), 'Your take');
    btn.setAttribute('aria-pressed', 'true');
  }
  stopTakeAudio() {
    const ta = this.takeAudio; if (!ta) return;
    this.takeAudio = null;
    ta.au.pause(); ta.au.removeAttribute('src');
    try { ta.au.load(); } catch {}
    URL.revokeObjectURL(ta.url);
    if (ta.btn.isConnected) { ta.btn.replaceChildren(icon('play', 15), 'Your take'); ta.btn.setAttribute('aria-pressed', 'false'); }
  }
}
