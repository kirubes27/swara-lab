// Vocal range finder: only counts notes held steadily for ~1 s.
import { mic } from './audio.js';
import { settings, saveSettings, logActivity } from './store.js';
import { westernName, hzToMidi, kattaiName, kaliSafedName, median, midiToHz, isIndian } from './music.js';
import { h, ensureMic, toast } from './ui.js';

const VOICE_TYPES = [
  ['Bass', 40, 64], ['Baritone', 45, 69], ['Tenor', 48, 72], ['Alto', 53, 77], ['Mezzo-soprano', 57, 81], ['Soprano', 60, 84],
];

export class RangeFinder {
  constructor(root) {
    this.root = root; this.mode = null; this.buf = []; this.low = settings.rangeLowMidi; this.high = settings.rangeHighMidi; this.stableLow = null; this.stableHigh = null;
    this.render();
  }
  render() {
    const r = this.root; r.innerHTML = '';
    this.live = h('div', { class: 'range-live' }, '–');
    this.kb = h('canvas', { class: 'keyboard' });
    this.out = h('div', { class: 'range-out' });
    this.btnLow = h('button', { class: 'btn primary', onclick: () => this.run('low') }, '1 · Find my lowest note');
    this.btnHigh = h('button', { class: 'btn primary', onclick: () => this.run('high') }, '2 · Find my highest note');
    r.append(
      h('div', { class: 'card' },
        h('h2', {}, isIndian(settings) ? 'Find your range and your Sa' : 'Find your vocal range'),
        h('p', {}, 'Sing on a relaxed "aa" or hum. ', h('strong', {}, 'Slide slowly'), ' towards your lowest (then highest) note and ', h('strong', {}, 'hold it for a second'), '. Only notes you can hold steadily count. That keeps out croaks and squeaks, and it\'s the range you can actually use in songs. Stop before any strain.'),
        h('div', { class: 'row wrap' }, this.btnLow, this.btnHigh, h('button', { class: 'btn', onclick: () => this.stop() }, 'Stop')),
        this.live, this.kb, this.out,
      ),
    );
    this.drawKb();
    this.renderOut();
  }
  async run(mode) {
    if (!(await ensureMic())) return;
    this.stop();
    this.mode = mode; this.buf = [];
    if (mode === 'low') this.stableLow = null; else this.stableHigh = null;
    (mode === 'low' ? this.btnLow : this.btnHigh).classList.add('on');
    this.live.textContent = mode === 'low' ? 'Sing and slide down… hold the lowest comfortable note' : 'Sing and slide up… hold the highest comfortable note';
    this.off = mic.on((f) => this.frame(f));
    this.timeout = setTimeout(() => this.stop(), 30000);
  }
  stop() {
    if (this.off) this.off(); this.off = null; clearTimeout(this.timeout);
    this.btnLow.classList.remove('on'); this.btnHigh.classList.remove('on');
    if (this.mode) {
      if (this.mode === 'low' && this.stableLow != null) this.low = this.stableLow;
      if (this.mode === 'high' && this.stableHigh != null) this.high = this.stableHigh;
      this.mode = null; this.renderOut();
      if (this.low != null && this.high != null && this.high > this.low) {
        saveSettings({ rangeLowMidi: this.low, rangeHighMidi: this.high });
        logActivity({ type: 'range', id: 'range', minutes: 1 });
      }
    }
  }
  frame(f) {
    const now = f.t;
    this.buf.push({ t: now, m: f.hz > 0 ? hzToMidi(f.hz) : NaN });
    while (this.buf.length && now - this.buf[0].t > 1000) this.buf.shift();
    const v = this.buf.filter((x) => !isNaN(x.m)).map((x) => x.m);
    if (f.hz > 0) this.live.textContent = `${westernName(hzToMidi(f.hz))}  (${f.hz.toFixed(0)} Hz)`;
    if (this.buf.length > 30 && v.length / this.buf.length > 0.85) {
      const md = median(v);
      const sd = Math.sqrt(v.reduce((a, x) => a + (x - md) * (x - md), 0) / v.length);
      if (sd < 0.35) {
        const note = Math.round(md);
        if (this.mode === 'low' && (this.stableLow == null || note < this.stableLow)) { this.stableLow = note; this.flash(note); }
        if (this.mode === 'high' && (this.stableHigh == null || note > this.stableHigh)) { this.stableHigh = note; this.flash(note); }
      }
    }
    this.drawKb(f.hz > 0 ? hzToMidi(f.hz) : null);
  }
  flash(note) { this.live.textContent = `✓ held ${westernName(note)}`; }
  drawKb(cur = null) {
    const c = this.kb, dpr = Math.min(2, devicePixelRatio || 1);
    c.width = c.clientWidth * dpr; c.height = c.clientHeight * dpr;
    const g = c.getContext('2d');
    const lo = 36, hi = 84; // C2..C6
    const whites = []; for (let m = lo; m <= hi; m++) if (![1, 3, 6, 8, 10].includes(m % 12)) whites.push(m);
    const ww = c.width / whites.length;
    const cs = getComputedStyle(document.body);
    const acc = cs.getPropertyValue('--accent').trim() || '#f39c3d', good = cs.getPropertyValue('--good').trim() || '#3ecf8e';
    const inRange = (m) => this.low != null && this.high != null && m >= (this.mode === 'low' && this.stableLow != null ? this.stableLow : this.low) && m <= (this.mode === 'high' && this.stableHigh != null ? this.stableHigh : this.high);
    whites.forEach((m, i) => {
      g.fillStyle = inRange(m) ? good : '#f4f1ea'; g.fillRect(i * ww + 1, 0, ww - 2, c.height);
      if (m % 12 === 0) { g.fillStyle = '#555'; g.font = `${10 * dpr}px sans-serif`; g.fillText('C' + (m / 12 - 1), i * ww + 3 * dpr, c.height - 5 * dpr); }
    });
    for (let m = lo; m <= hi; m++) if ([1, 3, 6, 8, 10].includes(m % 12)) {
      const i = whites.indexOf(m - 1);
      g.fillStyle = inRange(m) ? '#1f8a5c' : '#222'; g.fillRect((i + 0.68) * ww, 0, ww * 0.64, c.height * 0.6);
    }
    const mark = (m, col) => { if (m == null) return; const i = whites.findIndex((x) => x >= Math.round(m)); g.fillStyle = col; g.beginPath(); g.arc((i + 0.5) * ww, c.height * 0.8, 6 * dpr, 0, 6.283); g.fill(); };
    mark(cur, acc);
  }
  renderOut() {
    const o = this.out; o.innerHTML = '';
    const lo = this.low, hi = this.high;
    if (lo == null || hi == null || hi <= lo) { o.append(h('p', { class: 'muted' }, lo != null ? `Lowest: ${westernName(lo)}. Now find your highest note.` : 'Do both steps to see your range.')); this.drawKb(); return; }
    const span = hi - lo;
    const mid = (lo + hi) / 2;
    const vt = VOICE_TYPES.map(([n, a, b]) => ({ n, d: Math.abs((a + b) / 2 - mid) + Math.max(0, a - lo) * 0.3 })).sort((x, y) => x.d - y.d)[0].n;
    const sa = lo + 5; // mandra Pa ≈ lowest note
    o.append(
      h('div', { class: 'stats' },
        h('div', { class: 'stat' }, h('div', { class: 'stat-v' }, `${westernName(lo)} – ${westernName(hi)}`), h('div', { class: 'stat-l' }, 'comfortable range')),
        h('div', { class: 'stat' }, h('div', { class: 'stat-v' }, `${Math.floor(span / 12)} oct + ${span % 12}`), h('div', { class: 'stat-l' }, 'span')),
        h('div', { class: 'stat' }, h('div', { class: 'stat-v' }, vt), h('div', { class: 'stat-l' }, 'rough voice type')),
      ),
      h('div', { class: 'callout' },
        h('strong', {}, isIndian(settings) ? `Suggested Sa: ${westernName(sa)} (${kattaiName(sa % 12)} · ${kaliSafedName(sa % 12)})` : `Suggested key note for exercises: ${westernName(sa)}`),
        h('p', {}, (isIndian(settings) ? 'Your lowest comfortable note becomes mandra Pa, which leaves room above for the taar saptak (upper octave). ' : 'This puts your lowest comfortable note a fifth below the key note, leaving room above for an octave or more. Songs are matched to your range separately in Song Studio. ') + 'Beginners usually have 1–1.5 octaves; regular practice typically adds a few semitones over months.'),
        h('div', { class: 'row' }, h('button', { class: 'btn primary', onclick: () => { saveSettings({ saMidi: sa, saFine: 0, saChosen: true }); toast(`${isIndian(settings) ? 'Sa' : 'Key note'} set to ${westernName(sa)}.`, 'good'); } }, `Use ${westernName(sa)}${isIndian(settings) ? ' as my Sa' : ' for exercises'}`)),
        span < 12 ? h('p', { class: 'small muted' }, 'Range under an octave usually just means a cautious first try. Repeat after warming up.') : null,
      ),
      h('p', { class: 'small muted' }, 'Voice type here is only a rough guess from range. Real classification also depends on timbre and where your voice feels easy.'),
    );
    this.drawKb();
  }
}
