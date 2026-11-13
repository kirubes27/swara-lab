// Vocal range: a two-step check (lowest note, then highest) that only counts notes held steady for
// about a second, plus what the rest of the app needs to show it and to ask for a new check.
import { mic } from './audio.js';
import { settings, saveSettings, logActivity, dayKey } from './store.js';
import { westernName, hzToMidi, kattaiName, kaliSafedName, median, isIndian } from './music.js';
import { h, ensureMic, toast } from './ui.js';
import { icon } from './icons.js';

const VOICE_TYPES = [
  ['Bass', 40, 64], ['Baritone', 45, 69], ['Tenor', 48, 72], ['Alto', 53, 77], ['Mezzo-soprano', 57, 81], ['Soprano', 60, 84],
];
// A check a month: with regular practice the edges of a range move by a few semitones over months.
export const RANGE_DUE_DAYS = 28;

// The closest voice type by range alone, or null when the range is too narrow to say. Ranges of
// neighbouring types (and of men's and women's types) overlap, so a near tie names both.
export function voiceType(lo, hi) {
  if (hi - lo < 12) return null;
  const mid = (lo + hi) / 2;
  const d = VOICE_TYPES.map(([n, a, b], i) => ({ n, i, d: Math.abs((a + b) / 2 - mid) + Math.max(0, a - lo) * 0.3 + Math.max(0, hi - b) * 0.5 })).sort((x, y) => x.d - y.d);
  return d[1].d - d[0].d < 1.5 ? [d[0], d[1]].sort((x, y) => x.i - y.i).map((x) => x.n).join(' or ') : d[0].n;
}
const plural = (n, w) => `${n} ${w}${n === 1 ? '' : 's'}`;
export function spanText(lo, hi, short = false) {
  const s = hi - lo, o = Math.floor(s / 12), r = s % 12;
  if (short) return o ? `${plural(o, 'octave')}${r ? ' + ' + r : ''}` : plural(r, 'semitone');
  return [o ? plural(o, 'octave') : '', r ? plural(r, 'semitone') : ''].filter(Boolean).join(' + ') || '0 semitones';
}
// Whole calendar days since an ISO time, by the local clock.
function daysSince(iso, now = new Date()) {
  const a = new Date(iso);
  if (isNaN(a)) return null;
  const d0 = new Date(a.getFullYear(), a.getMonth(), a.getDate()), d1 = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  return Math.max(0, Math.round((d1 - d0) / 864e5));
}
export function agoText(days) {
  if (days == null) return null;
  if (days === 0) return 'today';
  if (days === 1) return 'yesterday';
  if (days < 14) return `${days} days ago`;
  if (days < 63) return `${Math.round(days / 7)} weeks ago`;
  const m = Math.round(days / 30.44);
  return m < 12 ? `${m} months ago` : m < 18 ? 'a year ago' : `${Math.round(m / 12)} years ago`;
}
const dayLabel = (d) => new Date(d + 'T12:00').toLocaleDateString(/^en\b/i.test(navigator.language || '') ? navigator.language : 'en-GB', { day: 'numeric', month: 'short' });
export const rangeText = (lo, hi) => `${westernName(lo)}–${westernName(hi)}`;

// The saved range, how long ago it was checked, whether a new check is due, and whether today's
// check answered a reminder.
export function rangeStatus(now = new Date()) {
  const lo = settings.rangeLowMidi, hi = settings.rangeHighMidi;
  if (lo == null || hi == null || hi <= lo) return { tested: false };
  const days = settings.rangeTestedAt ? daysSince(settings.rangeTestedAt, now) : null;
  return { tested: true, lo, hi, days, due: days == null || days >= RANGE_DUE_DAYS, answeredToday: settings.rangeDueAnswered === dayKey(now) };
}

// ---- keyboard ---------------------------------------------------------------------------------
// C2 to C6 with the range lit, and a bar under the lit keys so it reads without relying on colour.
// SVG, so it takes the theme's colours; note names are HTML underneath.
const BLACK = new Set([1, 3, 6, 8, 10]);
const KB_FROM = 36, KB_TO = 84;
const WHITES = []; for (let m = KB_FROM; m <= KB_TO; m++) if (!BLACK.has(m % 12)) WHITES.push(m);
const clampKey = (m) => Math.round(Math.min(KB_TO, Math.max(KB_FROM, m)));
const whitesBelow = (n) => { let i = 0; for (let k = KB_FROM; k < n; k++) if (!BLACK.has(k % 12)) i++; return i; };
// Where a (fractional) note sits along the keyboard, 0..1: a white key's middle, or the gap a black key covers.
export function keyX(m) { const n = clampKey(m), i = whitesBelow(n); return (BLACK.has(n % 12) ? i : i + 0.5) / WHITES.length; }
// A key's left and right edges, 0..1.
function keyEdges(m) { const n = clampKey(m), i = whitesBelow(n), w = WHITES.length; return BLACK.has(n % 12) ? [(i - 0.32) / w, (i + 0.32) / w] : [i / w, (i + 1) / w]; }
export function keyboard(lo, hi, { mini = false } = {}) {
  const n = WHITES.length, H = 60, has = lo != null && hi != null;
  const lit = (m) => has && m >= lo && m <= hi;
  let s = `<svg viewBox="0 0 ${n * 10} ${H}" preserveAspectRatio="none" aria-hidden="true">`;
  WHITES.forEach((m, i) => { s += `<rect class="kw${lit(m) ? ' on' : ''}" x="${i * 10 + 0.6}" width="8.8" height="${H}" rx="1.2"/>`; });
  for (let m = KB_FROM; m <= KB_TO; m++) if (BLACK.has(m % 12)) {
    const i = WHITES.indexOf(m - 1);
    s += `<rect class="kk${lit(m) ? ' on' : ''}" x="${i * 10 + 6.8}" width="6.4" height="${H * 0.6}" rx="1"/>`;
  }
  const [a, b] = has ? [keyEdges(lo)[0], keyEdges(hi)[1]] : [0, 0];
  const band = h('div', { class: 'kb-band' }, has ? h('span', { style: `left:${(a * 100).toFixed(2)}%;width:${((b - a) * 100).toFixed(2)}%` }) : null);
  // A mini keyboard repeats the range written above it, so it stays out of the accessibility tree.
  const named = !mini && has && hi > lo;
  return h('div', { class: 'kb' + (mini ? ' mini' : ''), role: named ? 'img' : null, 'aria-label': named ? `${westernName(lo)} to ${westernName(hi)}, lit on a keyboard from C2 to C6` : null, 'aria-hidden': named ? null : 'true', html: s + '</svg>' },
    band, h('div', { class: 'kb-labels', 'aria-hidden': 'true' }, ...WHITES.map((m, i) => (m % 12 === 0 ? h('span', { style: `left:${((i + 0.5) / n) * 100}%` }, westernName(m)) : null))));
}

// ---- the check ------------------------------------------------------------------------------------
const STEPS = {
  low: { n: 1, title: 'Lowest note', name: 'lowest note', idle: 'Slide down slowly to the lowest note you can hold comfortably.', done: 'The lowest note you held steady.', go: 'Listening. Slide down slowly…', more: 'Held. Go a little lower only if it still feels easy, or stop singing to finish.' },
  high: { n: 2, title: 'Highest note', name: 'highest note', idle: 'Then slide up to the highest note you can hold comfortably.', done: 'The highest note you held steady.', go: 'Listening. Slide up slowly…', more: 'Held. Go a little higher only if it still feels easy, or stop singing to finish.' },
};
const QUIET_MS = 2500; // after a held note, this much quiet ends the step
const MAX_MS = 30000;
let pending = null; // one step done, the other not yet: kept for half an hour if the singer wanders off

export class RangeFinder {
  constructor(root) {
    this.root = root; this.mode = null; this.buf = [];
    // This visit's notes. The saved range is only "the last check" until both steps are done again.
    this.low = null; this.high = null;
    if (pending && Date.now() - pending.t < 30 * 60e3) ({ low: this.low, high: this.high } = pending);
    this.stableLow = null; this.stableHigh = null;
    this.result = null; // set when a full check is saved in this visit
    this.onMic = () => { if (this.mode && !mic.running) this.finish(true); };
    document.addEventListener('mic-change', this.onMic);
    this.render();
  }
  render() {
    const r = this.root; r.innerHTML = '';
    this.steps = {};
    const step = (k) => {
      const s = STEPS[k], id = 'vr-step-' + k;
      const el = { box: h('div', { class: 'vr-step', role: 'group', 'aria-labelledby': id }), num: h('span', { class: 'vr-n', 'aria-hidden': 'true' }), val: h('div', { class: 'vr-v' }), hint: h('div', { class: 'vr-hint' }) };
      el.btn = h('button', { class: 'btn small', onclick: () => (this.mode === k ? this.finish() : this.run(k)) });
      el.box.append(el.num, h('div', { class: 'vr-body' }, h('div', { class: 'vr-t', id }, s.title), el.val, el.hint, el.btn));
      this.steps[k] = el;
      return el.box;
    };
    this.kbBox = h('div', { class: 'vr-kb' });
    this.dot = h('span', { class: 'vr-dot', hidden: true });
    this.out = h('div', { class: 'range-out' });
    this.status = h('p', { class: 'sr-only', role: 'status', 'aria-live': 'polite' });
    r.append(
      h('div', { class: 'page-head' }, h('h1', {}, isIndian(settings) ? 'Find your range and your Sa' : 'Find your range'),
        h('p', { class: 'lead' }, 'Two short steps on a relaxed "ah" or a hum. A note counts once you hold it steady for about a second, so cracks and squeaks don\'t. Warm up first, and stop before anything strains.')),
      h('div', { class: 'card vr-check' }, this.kbBox, h('div', { class: 'vr-steps' }, step('low'), step('high')), this.out, this.status),
    );
    this.paint();
  }
  // which step to do next in this visit (shown as the main button)
  next() { return this.mode ? null : this.low == null ? 'low' : this.high == null ? 'high' : null; }
  paint() {
    const saved = rangeStatus();
    for (const k of ['low', 'high']) {
      const s = this.steps[k], st = STEPS[k], live = this.mode === k;
      const v = k === 'low' ? this.low : this.high, held = k === 'low' ? this.stableLow : this.stableHigh;
      const last = saved.tested && v == null && !live ? (k === 'low' ? saved.lo : saved.hi) : null;
      s.box.classList.toggle('live', live);
      s.box.classList.toggle('got', !live && v != null);
      s.num.replaceChildren(!live && v != null ? icon('check', 14) : String(st.n));
      s.val.textContent = live ? (held != null ? westernName(held) : '–') : v != null ? westernName(v) : '–';
      s.hint.textContent = live ? (held != null ? st.more : st.go) : v != null ? st.done : (last != null ? `Last time: ${westernName(last)}. ` : '') + st.idle;
      const label = live ? 'Done' : v != null ? 'Again' : 'Start';
      s.btn.textContent = label;
      s.btn.setAttribute('aria-label', `${label}: ${st.name}`);
      s.btn.className = 'btn small' + (live || this.next() === k ? ' primary' : '');
    }
    this.drawKb(saved);
    this.renderOut(saved);
  }
  drawKb(saved = rangeStatus()) {
    let lo = this.low, hi = this.high;
    if (this.mode === 'low' && this.stableLow != null) lo = this.stableLow;
    if (this.mode === 'high' && this.stableHigh != null) hi = this.stableHigh;
    if (lo == null && hi == null && !this.mode && saved.tested) { lo = saved.lo; hi = saved.hi; } // the last check, until this one has notes
    if (lo != null && (hi == null || hi < lo)) hi = lo;
    if (hi != null && lo == null) lo = hi;
    this.kbBox.replaceChildren(keyboard(lo, hi), this.dot);
  }
  async run(k) {
    if (!(await ensureMic())) return;
    this.finish(true); // end any other step first
    this.mode = k; this.buf = []; this.t0 = null; this.voicedAt = null; this.liveNote = null;
    if (k === 'low') this.stableLow = null; else this.stableHigh = null;
    // listen across every voice type, not just around a saved range
    this.prevMic = { lo: mic.lowHz, hi: mic.highHz, hpf: mic.hpfHz };
    mic.setRange(60, 1400, 55);
    this.off = mic.on((f) => this.frame(f));
    this.timer = setTimeout(() => this.finish(), MAX_MS + 1000); // in case the mic stops sending frames
    this.paint();
    this.status.textContent = `Listening for your ${STEPS[k].name}.`;
    // keep the step and the keyboard in view (on phones, clear of the tab bar)
    this.steps[k].box.scrollIntoView({ block: 'nearest' });
    this.kbBox.scrollIntoView({ block: 'nearest' });
  }
  finish(quiet = false) {
    if (this.off) { this.off(); this.off = null; }
    clearTimeout(this.timer);
    if (this.prevMic) { mic.setRange(this.prevMic.lo, this.prevMic.hi, this.prevMic.hpf); this.prevMic = null; }
    const k = this.mode;
    if (!k) return;
    this.mode = null; this.dot.hidden = true;
    const held = k === 'low' ? this.stableLow : this.stableHigh;
    if (held != null) { if (k === 'low') this.low = held; else this.high = held; }
    let msg = '', saved = false;
    if (this.low != null && this.high != null && this.low >= this.high) { // sung the wrong way round
      msg = `The lowest note (${westernName(this.low)}) came out above the highest (${westernName(this.high)}). Do both steps again.`;
      toast(msg); this.low = this.high = null; pending = null;
    } else if (held != null && this.low != null && this.high != null) {
      this.save(); saved = true;
      msg = `Your range: ${westernName(this.low)} to ${westernName(this.high)}, ${spanText(this.low, this.high)}.` + (this.result.keySet ? ` ${isIndian(settings) ? 'Sa' : 'Key note for exercises'} set to ${westernName(this.result.sa)}.` : '');
    } else if (held != null) {
      pending = { low: this.low, high: this.high, t: Date.now() };
      msg = `${STEPS[k].title}: ${westernName(held)}. Now the ${STEPS[k === 'low' ? 'high' : 'low'].name}.`;
    } else if (!quiet) {
      msg = `Stopped. No steady note heard. Hold the ${k === 'low' ? 'low' : 'high'} note for a second, then stop.`;
      toast(msg);
    }
    this.paint();
    this.status.textContent = msg;
    if (saved) { // show the result, and take keyboard users to it
      this.out.scrollIntoView({ block: 'start', behavior: matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth' });
      this.out.querySelector('.vr-res-title')?.focus({ preventScroll: true });
    }
    else if (held != null) { const nx = this.next(); if (nx) this.steps[nx].btn.focus(); }
  }
  stop() { this.finish(true); document.removeEventListener('mic-change', this.onMic); } // leaving the page
  // Both steps done in this visit: save the range with today's date and a history entry. On a first
  // check (no key note picked yet) it also sets the key note, so warm-ups and drills fit the voice.
  save() {
    const lo = this.low, hi = this.high;
    const before = rangeStatus(), today = dayKey(new Date());
    const patch = {
      rangeLowMidi: lo, rangeHighMidi: hi, rangeTestedAt: new Date().toISOString(), rangeSnooze: null,
      rangeHistory: (settings.rangeHistory || []).filter((e) => e.d !== today).concat({ d: today, lo, hi }).slice(-24),
    };
    if (before.tested && before.due) patch.rangeDueAnswered = today; // Today shows the reminder as done
    const sa = lo + 5, keySet = !settings.saChosen;
    if (keySet) Object.assign(patch, { saMidi: sa, saFine: 0, saChosen: true });
    saveSettings(patch);
    logActivity({ type: 'range', id: 'range', minutes: 1 });
    pending = null;
    this.result = { sa, keySet };
    if (keySet) toast(`${isIndian(settings) ? 'Sa' : 'Key note for exercises'} set to ${westernName(sa)} to fit your range. You can change it in Settings.`, 'good', 6000);
  }
  frame(f) {
    const now = f.t;
    if (this.t0 == null) this.t0 = now;
    const m = f.hz > 0 ? hzToMidi(f.hz) : NaN;
    this.buf.push({ t: now, m });
    while (this.buf.length && now - this.buf[0].t > 1000) this.buf.shift();
    if (!isNaN(m)) this.voicedAt = now;
    const v = this.buf.filter((x) => !isNaN(x.m)).map((x) => x.m);
    if (this.buf.length > 30 && v.length / this.buf.length > 0.85) {
      // Steady once vibrato is averaged out: a ~200 ms moving average (about one vibrato cycle) keeps a
      // held note with a wide vibrato, while slides, cracks and off notes still fail.
      const k = Math.max(3, Math.round(this.buf.length / 5)), sm = [];
      for (let i = 0; i + k <= v.length; i++) { let a = 0; for (let j = i; j < i + k; j++) a += v[j]; sm.push(a / k); }
      const md = median(sm);
      const sd = Math.sqrt(sm.reduce((a, x) => a + (x - md) * (x - md), 0) / sm.length);
      if (sd < 0.35 && sm.every((x) => Math.abs(x - md) < 0.6)) { // held steady for a second
        const note = Math.round(md);
        const lower = this.mode === 'low' && (this.stableLow == null || note < this.stableLow);
        const higher = this.mode === 'high' && (this.stableHigh == null || note > this.stableHigh);
        if (lower) this.stableLow = note;
        if (higher) this.stableHigh = note;
        if (lower || higher) { this.paint(); this.status.textContent = `Held ${westernName(note)}.`; }
      }
    }
    // the note being sung, on the keyboard and in words
    if (!isNaN(m)) {
      this.dot.hidden = false; this.dot.style.left = (keyX(m) * 100).toFixed(2) + '%';
      const held = this.mode === 'low' ? this.stableLow : this.stableHigh, note = westernName(Math.round(m));
      if (held == null && note !== this.liveNote) { this.liveNote = note; this.steps[this.mode].val.textContent = note; }
    } else this.dot.hidden = true;
    // a held note and then a few seconds of quiet end the step; so does half a minute
    const held = this.mode === 'low' ? this.stableLow : this.stableHigh;
    if ((held != null && now - (this.voicedAt ?? now) > QUIET_MS) || now - this.t0 > MAX_MS) this.finish();
  }
  renderOut(saved = rangeStatus()) {
    const o = this.out; o.innerHTML = '';
    const ind = isIndian(settings);
    if (!this.result || this.mode) { // no full check in this visit yet, or a step running: the last check as context
      const last = saved.tested ? `Last check${saved.days != null ? `, ${agoText(saved.days)}` : ''}: ${rangeText(saved.lo, saved.hi)}.` : null;
      o.append(h('p', { class: 'muted small vr-wait' }, this.mode ? last || 'Your range appears here after both steps.'
        : this.low != null && this.high == null ? `Lowest: ${westernName(this.low)}. Now the highest note.`
          : this.high != null && this.low == null ? `Highest: ${westernName(this.high)}. Now the lowest note.`
            : last ? `${last} Do both steps to check again.` : 'Your range appears here after both steps.'));
      return;
    }
    const lo = this.low, hi = this.high, { sa, keySet } = this.result;
    const vt = voiceType(lo, hi);
    let change = null;
    const hist = settings.rangeHistory || [], p = hist.length > 1 ? hist[hist.length - 2] : null; // the check before today's
    if (p) {
      const word = (n, up, down) => (n === 0 ? 'the same' : `${plural(Math.abs(n), 'semitone')} ${n > 0 ? up : down}`);
      change = `Since your last check (${rangeText(p.lo, p.hi)}, ${dayLabel(p.d)}): bottom ${word(p.lo - lo, 'lower', 'higher')}, top ${word(hi - p.hi, 'higher', 'lower')}.`;
      if (hi - lo < p.hi - p.lo) change += ' A tired or unwarmed voice often measures narrower; try again after warming up.';
    }
    const isKey = keySet || Math.round(settings.saMidi) === sa;
    const keyName = `${westernName(sa)}${ind ? ` (${kattaiName(sa % 12)} · ${kaliSafedName(sa % 12)})` : ''}`;
    o.append(...[
      h('h2', { class: 'vr-res-title', tabindex: '-1' }, 'Your range'),
      h('div', { class: 'stats' },
        h('div', { class: 'stat' }, h('div', { class: 'stat-v' }, rangeText(lo, hi)), h('div', { class: 'stat-l' }, 'lowest to highest')),
        h('div', { class: 'stat' }, h('div', { class: 'stat-v' }, spanText(lo, hi, true)), h('div', { class: 'stat-l' }, 'span')),
        h('div', { class: 'stat' }, h('div', { class: 'stat-v' }, vt || 'Too narrow to tell'), h('div', { class: 'stat-l' }, 'rough voice type')),
      ),
      change ? h('p', { class: 'small muted vr-when' }, change) : null,
      h('div', { class: 'callout' },
        h('strong', {}, ind ? `${isKey ? 'Your Sa' : 'Suggested Sa'}: ${keyName}` : `${isKey ? 'Key note for exercises' : 'Suggested key note for exercises'}: ${keyName}`),
        h('p', {}, (ind ? 'Your lowest comfortable note becomes mandra Pa, which leaves room above for the taar saptak (upper octave). ' : 'Your lowest note becomes the fifth degree below the key note (a fourth under it), which leaves room above for an octave or more. Songs are matched to your range separately. ') + 'Beginners usually have 1–1.5 octaves; regular practice typically adds a few semitones over months.'),
        isKey ? h('p', { class: 'small muted' }, keySet ? 'Set from this check. You can change it in Settings.' : 'Already set.')
          : h('div', { class: 'row' }, h('button', { class: 'btn primary', onclick: (e) => { saveSettings({ saMidi: sa, saFine: 0, saChosen: true }); toast(`${ind ? 'Sa' : 'Key note'} set to ${westernName(sa)}.`, 'good'); e.currentTarget.replaceWith(h('p', { class: 'small muted' }, 'Set.')); } }, `Use ${westernName(sa)}${ind ? ' as my Sa' : ' for exercises'}`)),
        hi - lo < 12 ? h('p', { class: 'small muted' }, 'Range under an octave usually just means a cautious first try. Repeat after warming up.') : null,
      ),
      h('p', { class: 'small muted' }, 'Voice type here is only a rough guess from range. Real classification also depends on timbre and where your voice feels easy.'),
    ].filter(Boolean));
  }
}
