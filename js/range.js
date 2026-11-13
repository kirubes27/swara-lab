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

export function voiceType(lo, hi) {
  const mid = (lo + hi) / 2;
  return VOICE_TYPES.map(([n, a, b]) => ({ n, d: Math.abs((a + b) / 2 - mid) + Math.max(0, a - lo) * 0.3 })).sort((x, y) => x.d - y.d)[0].n;
}
export function spanText(lo, hi, short = false) {
  const s = hi - lo, o = Math.floor(s / 12), r = s % 12;
  if (short) return o ? `${o} oct${r ? ' + ' + r : ''}` : `${r} semitones`;
  return [o ? `${o} octave${o > 1 ? 's' : ''}` : '', r ? `${r} semitone${r > 1 ? 's' : ''}` : ''].filter(Boolean).join(' + ') || '0 semitones';
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

// The saved range, how long ago it was checked, whether a new check is due, and the check before.
export function rangeStatus(now = new Date()) {
  const lo = settings.rangeLowMidi, hi = settings.rangeHighMidi;
  if (lo == null || hi == null || hi <= lo) return { tested: false };
  const days = settings.rangeTestedAt ? daysSince(settings.rangeTestedAt, now) : null;
  const hist = settings.rangeHistory || [];
  const prev = hist.length > 1 ? hist[hist.length - 2] : null;
  return { tested: true, lo, hi, days, due: days == null || days >= RANGE_DUE_DAYS, prev };
}

// ---- keyboard ---------------------------------------------------------------------------------
// C2 to C6 with the range lit. SVG, so it takes the theme's colours; note names are HTML underneath.
const BLACK = new Set([1, 3, 6, 8, 10]);
const KB_FROM = 36, KB_TO = 84;
const WHITES = []; for (let m = KB_FROM; m <= KB_TO; m++) if (!BLACK.has(m % 12)) WHITES.push(m);
// Where a (fractional) note sits along the keyboard, 0..1: a white key's middle, or the gap a black key covers.
export function keyX(m) {
  const n = Math.round(Math.min(KB_TO, Math.max(KB_FROM, m)));
  let i = 0; for (let k = KB_FROM; k < n; k++) if (!BLACK.has(k % 12)) i++;
  return (BLACK.has(n % 12) ? i : i + 0.5) / WHITES.length;
}
export function keyboard(lo, hi, { mini = false } = {}) {
  const n = WHITES.length, H = 60;
  const lit = (m) => lo != null && hi != null && m >= lo && m <= hi;
  let s = `<svg viewBox="0 0 ${n * 10} ${H}" preserveAspectRatio="none" aria-hidden="true">`;
  WHITES.forEach((m, i) => { s += `<rect class="kw${lit(m) ? ' on' : ''}" x="${i * 10 + 0.6}" width="8.8" height="${H}" rx="1.2"/>`; });
  for (let m = KB_FROM; m <= KB_TO; m++) if (BLACK.has(m % 12)) {
    const i = WHITES.indexOf(m - 1);
    s += `<rect class="kk${lit(m) ? ' on' : ''}" x="${i * 10 + 6.8}" width="6.4" height="${H * 0.6}" rx="1"/>`;
  }
  const label = lo != null && hi != null ? `Keyboard from C2 to C6 with ${westernName(lo)} to ${westernName(hi)} lit` : 'Keyboard from C2 to C6';
  return h('div', { class: 'kb' + (mini ? ' mini' : ''), role: 'img', 'aria-label': label, html: s + '</svg>' },
    h('div', { class: 'kb-labels', 'aria-hidden': 'true' }, ...WHITES.map((m, i) => (m % 12 === 0 ? h('span', { style: `left:${((i + 0.5) / n) * 100}%` }, westernName(m)) : null))));
}

// ---- the check ------------------------------------------------------------------------------------
const STEPS = {
  low: { n: 1, title: 'Lowest note', idle: 'Slide down slowly to the lowest note you can hold comfortably.', done: 'The lowest note you held steady.', go: 'Listening. Slide down slowly…', more: 'Go lower if you can, or stop singing to finish.' },
  high: { n: 2, title: 'Highest note', idle: 'Then slide up to the highest note you can hold comfortably.', done: 'The highest note you held steady.', go: 'Listening. Slide up slowly…', more: 'Go higher if you can, or stop singing to finish.' },
};
const QUIET_MS = 2500; // after a held note, this much quiet ends the step
const MAX_MS = 30000;

export class RangeFinder {
  constructor(root) {
    this.root = root; this.mode = null; this.buf = [];
    this.low = settings.rangeLowMidi; this.high = settings.rangeHighMidi;
    this.stableLow = null; this.stableHigh = null;
    this.got = { low: false, high: false }; this.logged = false; // notes caught in this visit
    this.render();
  }
  render() {
    const r = this.root; r.innerHTML = '';
    this.steps = {};
    const step = (k) => {
      const s = STEPS[k];
      const el = { box: h('div', { class: 'vr-step' }), num: h('span', { class: 'vr-n', 'aria-hidden': 'true' }), val: h('div', { class: 'vr-v' }), hint: h('div', { class: 'vr-hint' }) };
      el.btn = h('button', { class: 'btn small', onclick: () => (this.mode === k ? this.finish() : this.run(k)) });
      el.box.append(el.num, h('div', { class: 'vr-body' }, h('div', { class: 'vr-t' }, s.title), el.val, el.hint, el.btn));
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
      h('div', { class: 'card' }, h('div', { class: 'vr-steps' }, step('low'), step('high')), this.kbBox, this.out, this.status),
    );
    this.paint();
  }
  // which step to do next (shown as the main button)
  next() { return this.mode ? null : this.low == null ? 'low' : this.high == null ? 'high' : null; }
  paint() {
    for (const k of ['low', 'high']) {
      const s = this.steps[k], st = STEPS[k], live = this.mode === k;
      const v = k === 'low' ? this.low : this.high, held = k === 'low' ? this.stableLow : this.stableHigh;
      s.box.classList.toggle('live', live);
      s.box.classList.toggle('got', !live && v != null);
      s.num.replaceChildren(!live && v != null ? icon('check', 14) : String(st.n));
      s.val.textContent = live ? (held != null ? westernName(held) : '–') : v != null ? westernName(v) : '–';
      s.hint.textContent = live ? (held != null ? `Held ${westernName(held)}. ${st.more}` : st.go) : v != null ? st.done : st.idle;
      s.btn.textContent = live ? 'Done' : v != null ? 'Again' : 'Start';
      s.btn.className = 'btn small' + (live || this.next() === k ? ' primary' : '');
    }
    this.drawKb();
    this.renderOut();
  }
  drawKb() {
    let lo = this.low, hi = this.high;
    if (this.mode === 'low' && this.stableLow != null) lo = this.stableLow;
    if (this.mode === 'high' && this.stableHigh != null) hi = this.stableHigh;
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
    this.paint();
    this.status.textContent = STEPS[k].go;
  }
  finish(quiet = false) {
    if (this.off) { this.off(); this.off = null; }
    if (this.prevMic) { mic.setRange(this.prevMic.lo, this.prevMic.hi, this.prevMic.hpf); this.prevMic = null; }
    const k = this.mode;
    if (!k) return;
    this.mode = null; this.dot.hidden = true;
    const held = k === 'low' ? this.stableLow : this.stableHigh;
    if (held != null) { if (k === 'low') this.low = held; else this.high = held; }
    this.save();
    this.paint();
    if (held != null) {
      this.status.textContent = `${STEPS[k].title}: ${westernName(held)}.`;
      const nx = this.next();
      if (nx) this.steps[nx].btn.focus({ preventScroll: true });
    } else if (!quiet) toast(`No steady note heard. Hold the ${k === 'low' ? 'low' : 'high'} note for a second, then stop.`);
  }
  stop() { this.finish(true); } // leaving the page
  // Notes caught are saved at once. A full check (both steps in this visit) also sets the date and
  // joins the history, which is what Today's reminder and the "since last time" line go by.
  save() {
    const lo = this.low, hi = this.high;
    if (!(this.got.low || this.got.high) || lo == null || hi == null || hi <= lo) return;
    const patch = { rangeLowMidi: lo, rangeHighMidi: hi };
    if (this.got.low && this.got.high) {
      const today = dayKey(new Date());
      patch.rangeHistory = (settings.rangeHistory || []).filter((e) => e.d !== today).concat({ d: today, lo, hi }).slice(-24);
      patch.rangeTestedAt = new Date().toISOString(); patch.rangeSnooze = null;
      if (!this.logged) { this.logged = true; logActivity({ type: 'range', id: 'range', minutes: 1 }); }
    }
    saveSettings(patch);
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
      const md = median(v);
      const sd = Math.sqrt(v.reduce((a, x) => a + (x - md) * (x - md), 0) / v.length);
      if (sd < 0.35) { // held steady for a second
        const note = Math.round(md);
        const lower = this.mode === 'low' && (this.stableLow == null || note < this.stableLow);
        const higher = this.mode === 'high' && (this.stableHigh == null || note > this.stableHigh);
        if (lower) this.stableLow = note;
        if (higher) this.stableHigh = note;
        if (lower || higher) { this.got[this.mode] = true; this.paint(); this.status.textContent = `Held ${westernName(note)}`; }
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
  renderOut() {
    const o = this.out; o.innerHTML = '';
    const lo = this.low, hi = this.high;
    if (lo == null || hi == null || hi <= lo) {
      o.append(h('p', { class: 'muted small vr-wait' }, lo != null ? `Lowest: ${westernName(lo)}. Now the highest note.` : 'Your range appears here after both steps.'));
      return;
    }
    const rs = rangeStatus();
    const sa = lo + 5; // mandra Pa ≈ lowest note
    const ind = isIndian(settings);
    let change = null;
    if (rs.prev && rs.days === 0) {
      const d = (rs.prev.lo - lo) + (hi - rs.prev.hi), was = `${westernName(rs.prev.lo)}–${westernName(rs.prev.hi)} on ${dayLabel(rs.prev.d)}`;
      change = d > 0 ? `${d} semitone${d > 1 ? 's' : ''} wider than your last check (${was}).`
        : d < 0 ? `${-d} semitone${d < -1 ? 's' : ''} narrower than your last check (${was}). A tired or cold voice often reads lower; try again after warming up.`
          : lo !== rs.prev.lo ? `The same width as your last check (${was}), shifted ${lo < rs.prev.lo ? 'lower' : 'higher'}.` : `The same as your last check (${was}).`;
    }
    const when = [rs.days != null ? `Checked ${agoText(rs.days)}.` : '', change || ''].filter(Boolean).join(' ');
    o.append(...[
      h('div', { class: 'stats' },
        h('div', { class: 'stat' }, h('div', { class: 'stat-v' }, `${westernName(lo)} – ${westernName(hi)}`), h('div', { class: 'stat-l' }, 'comfortable range')),
        h('div', { class: 'stat' }, h('div', { class: 'stat-v' }, spanText(lo, hi, true)), h('div', { class: 'stat-l' }, 'span')),
        h('div', { class: 'stat' }, h('div', { class: 'stat-v' }, voiceType(lo, hi)), h('div', { class: 'stat-l' }, 'rough voice type')),
      ),
      when ? h('p', { class: 'small muted vr-when' }, when) : null,
      h('div', { class: 'callout' },
        h('strong', {}, ind ? `Suggested Sa: ${westernName(sa)} (${kattaiName(sa % 12)} · ${kaliSafedName(sa % 12)})` : `Suggested key note for exercises: ${westernName(sa)}`),
        h('p', {}, (ind ? 'Your lowest comfortable note becomes mandra Pa, which leaves room above for the taar saptak (upper octave). ' : 'This puts your lowest comfortable note a fifth below the key note, leaving room above for an octave or more. Songs are matched to your range separately in Song Studio. ') + 'Beginners usually have 1–1.5 octaves; regular practice typically adds a few semitones over months.'),
        h('div', { class: 'row' }, h('button', { class: 'btn primary', onclick: () => { saveSettings({ saMidi: sa, saFine: 0, saChosen: true }); toast(`${ind ? 'Sa' : 'Key note'} set to ${westernName(sa)}.`, 'good'); } }, `Use ${westernName(sa)}${ind ? ' as my Sa' : ' for exercises'}`)),
        hi - lo < 12 ? h('p', { class: 'small muted' }, 'Range under an octave usually just means a cautious first try. Repeat after warming up.') : null,
      ),
      h('p', { class: 'small muted' }, 'Voice type here is only a rough guess from range. Real classification also depends on timbre and where your voice feels easy.'),
    ].filter(Boolean));
  }
}
