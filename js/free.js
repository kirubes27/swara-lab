// Free sing: an open pitch monitor. Sing anything and see every note, slide and wobble.
import { mic } from './audio.js';
import { PitchLane } from './lane.js';
import { settings, logActivity } from './store.js';
import { saHzFrom, noteText, nearestSwara, westernName, hzToMidi, median, isIndian } from './music.js';
import { h, ensureMic } from './ui.js';
import { icon } from './icons.js';

export class FreeSing {
  constructor(root) {
    this.root = root; this.frames = []; this.win = 10; this.running = false;
    this.lo = null; this.hi = null; this.longest = 0; this.hold = null; this.t0 = 0;
    this.build();
  }
  build() {
    const r = this.root; r.innerHTML = '';
    this.note = h('div', { class: 'big-note' }, '–');
    this.dev = h('div', { class: 'muted' }, 'Start, then sing anything');
    this.needle = h('i');
    const meter = h('div', { class: 'meter', title: 'Distance from the nearest note: centre = in tune' }, this.needle);
    this.sLo = h('div', { class: 'stat-v' }, '–'); this.sHi = h('div', { class: 'stat-v' }, '–'); this.sHold = h('div', { class: 'stat-v' }, '–');
    this.canvas = h('canvas', { class: 'lane tall' });
    this.btn = h('button', { class: 'btn primary big', onclick: () => (this.running ? this.stop() : this.start()) }, icon('mic', 18), 'Start singing');
    const seg = h('div', { class: 'seg' }, ...[5, 10, 20].map((s) => h('button', { class: s === this.win ? 'on' : '', onclick: (e) => { this.win = s; [...seg.children].forEach((b) => b.classList.toggle('on', b === e.currentTarget)); } }, s + ' s')));
    r.append(
      h('a', { class: 'back', href: '#practice' }, icon('back', 18), 'Practice'),
      h('div', { class: 'page-head' }, h('h1', {}, 'Free sing'), h('p', { class: 'lead' }, 'Sing anything and watch every note, slide and wobble as you make it. Good for exploring your range, checking a held note, or just playing around.')),
      h('div', { class: 'card' },
        h('div', { class: 'row spread wrap', style: 'gap:24px;align-items:flex-end' },
          h('div', {}, this.note, this.dev, h('div', { style: 'margin-top:12px' }, meter)),
          h('div', { class: 'stats' },
            h('div', { class: 'stat' }, this.sLo, h('div', { class: 'stat-l' }, 'lowest held')),
            h('div', { class: 'stat' }, this.sHi, h('div', { class: 'stat-l' }, 'highest held')),
            h('div', { class: 'stat' }, this.sHold, h('div', { class: 'stat-l' }, 'longest steady note'))))),
      h('div', { class: 'lane-wrap' }, this.canvas),
      h('div', { class: 'controls' }, this.btn, h('span', { class: 'ctl' }, h('span', { class: 'muted' }, 'Window'), seg),
        h('button', { class: 'btn', onclick: () => this.clear() }, 'Clear'),
        h('span', { class: 'small muted' }, 'Tip: turn on the drone (top bar) to sing against your key note.')),
    );
    this.lane = new PitchLane(this.canvas);
    this.lane.nearestColor = true; this.lane.refAt = null;
    this.lane.message = 'Press "Start singing"';
    this.syncLane(); this.lane.draw();
  }
  syncLane() {
    const L = this.lane;
    L.saHz = saHzFrom(settings); L.tuning = settings.tuning; L.notation = settings.notation; L.tol = settings.tol;
    L.past = this.win * 0.94; L.future = this.win * 0.06;
  }
  clear() { this.frames.length = 0; this.lo = this.hi = null; this.longest = 0; this.sLo.textContent = this.sHi.textContent = this.sHold.textContent = '–'; }
  async start() {
    if (!(await ensureMic())) return;
    this.running = true; this.t0 = performance.now();
    this.btn.replaceChildren(icon('stop', 16), 'Stop');
    this.btn.classList.remove('primary');
    this.lane.message = '';
    const sa = () => saHzFrom(settings);
    this.off = mic.on((f) => {
      const t = f.t / 1000;
      const c = f.hz > 0 ? 1200 * Math.log2(f.hz / sa()) : NaN;
      this.frames.push({ t, c });
      if (this.frames.length > 6000) this.frames.splice(0, 2000);
      this.track(t, c);
    });
    const loop = () => {
      if (!this.running) return;
      this.syncLane();
      const now = performance.now() / 1000;
      this.lane.now = now;
      this.lane.user = this.frames;
      // follow the voice: range from the last few seconds
      const recent = []; for (let i = this.frames.length - 1; i >= 0 && this.frames[i].t > now - 4; i--) if (!isNaN(this.frames[i].c)) recent.push(this.frames[i].c);
      if (recent.length > 10) { const m = median(recent); const lo = Math.min(...recent), hi = Math.max(...recent); const span = Math.max(1300, hi - lo + 500); this.lane.setRange(m - span / 2, m + span / 2); }
      const last = this.frames[this.frames.length - 1];
      this.lane.live = last && !isNaN(last.c) ? { c: last.c } : null;
      this.lane.draw();
      this.raf = requestAnimationFrame(loop);
    };
    this.raf = requestAnimationFrame(loop);
  }
  track(t, c) {
    const sa = saHzFrom(settings);
    if (isNaN(c)) { this.note.parentElement && this.note.classList.add('dim'); this.endHold(t); return; }
    const ns = nearestSwara(c, settings.tuning);
    this.note.textContent = noteText(ns.idx, ns.octave, sa, settings);
    const d = Math.round(ns.dev);
    const a = Math.abs(d);
    this.note.style.color = a <= settings.tol ? 'var(--good)' : a <= settings.tol * 2.2 ? 'var(--ok)' : 'var(--bad)';
    this.dev.textContent = `${d > 0 ? '+' : ''}${d}¢ · ${(sa * Math.pow(2, c / 1200)).toFixed(0)} Hz` + (isIndian(settings) ? ' · ' + westernName(hzToMidi(sa) + c / 100) : '');
    this.needle.style.left = `${50 + Math.max(-50, Math.min(50, ns.dev))}%`;
    // steady-note tracking (within ±40¢ of one note)
    const key = ns.idx + 12 * ns.octave;
    if (this.hold && this.hold.key === key && a < 45) this.hold.end = t;
    else { this.endHold(t); this.hold = { key, start: t, end: t, c: c - ns.dev }; }
  }
  endHold() {
    const hd = this.hold; this.hold = null;
    if (!hd) return;
    const dur = hd.end - hd.start;
    if (dur >= 0.5) {
      const sa = saHzFrom(settings), name = westernName(Math.round(hzToMidi(sa) + hd.c / 100));
      if (this.lo == null || hd.c < this.lo) { this.lo = hd.c; this.sLo.textContent = name; }
      if (this.hi == null || hd.c > this.hi) { this.hi = hd.c; this.sHi.textContent = name; }
      if (dur > this.longest) { this.longest = dur; this.sHold.textContent = dur.toFixed(1) + ' s'; }
    }
  }
  stop() {
    if (!this.running) return;
    this.running = false; cancelAnimationFrame(this.raf); this.off && this.off();
    this.btn.replaceChildren(icon('mic', 18), 'Start singing'); this.btn.classList.add('primary');
    const mins = (performance.now() - this.t0) / 60000;
    if (mins > 0.2) logActivity({ type: 'free', id: 'free', minutes: mins });
  }
}
