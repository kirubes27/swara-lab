// Widgets for the Theory pages: piano, fretboard, chord boxes, key wheel, tempo control,
// segmented controls and link lists, plus a cleanup scope and a few local icons.
import { h } from './ui.js';
import { icon, iconNames } from './icons.js';
import { isBlack, mod12, octaveOf, SHARP_NAMES, FLAT_NAMES, TUNING, STRING_NAMES } from './theory-core.js';

const SVGNS = 'http://www.w3.org/2000/svg';
export function svg(tag, attrs = {}, ...kids) {
  const el = document.createElementNS(SVGNS, tag);
  for (const [k, v] of Object.entries(attrs || {})) {
    if (v == null || v === false) continue;
    if (k.startsWith('on') && typeof v === 'function') el.addEventListener(k.slice(2), v);
    else el.setAttribute(k, v === true ? '' : v);
  }
  for (const c of kids.flat()) if (c != null && c !== false) el.append(c instanceof Node ? c : document.createTextNode(String(c)));
  return el;
}

// Icons this section needs that js/icons.js may not have, drawn the same way (24×24, 1.75 stroke,
// round caps). The shared set wins when it has the same name, so the tab bar and tiles match.
const P = {
  keys: '<rect x="3" y="4" width="18" height="16" rx="2.5"/><path d="M9 13v7M15 13v7"/><rect x="7.4" y="4" width="3.2" height="9" rx=".8" fill="currentColor" stroke="none"/><rect x="13.4" y="4" width="3.2" height="9" rx=".8" fill="currentColor" stroke="none"/>',
  guitar: '<g transform="rotate(45 12 12)"><path d="M12 7.6c1.9 0 3.2 1.3 3.2 3.1 0 1.1-.6 1.7-.4 2.5 1.6.6 2.4 1.9 2.4 3.6 0 2.7-2.3 4.4-5.2 4.4s-5.2-1.7-5.2-4.4c0-1.7.8-3 2.4-3.6.2-.8-.4-1.4-.4-2.5 0-1.8 1.3-3.1 3.2-3.1z"/><circle cx="12" cy="14.4" r="1.4"/><path d="M12 7.6V1.8M10.6 1.8h2.8M10.4 18.4h3.2"/></g>',
  disc: '<circle cx="12" cy="12" r="9"/><circle cx="12" cy="12" r="2.6"/><path d="M12 6.2a5.8 5.8 0 0 1 5.8 5.8"/>',
  external: '<path d="M13.5 4.5h6v6"/><path d="m19.5 4.5-8 8"/><path d="M17.5 13.5v4.5a1.5 1.5 0 0 1-1.5 1.5H6A1.5 1.5 0 0 1 4.5 18V8A1.5 1.5 0 0 1 6 6.5h4.5"/>',
  video: '<rect x="2.5" y="5" width="19" height="14" rx="4"/><path d="M10 9.2v5.6a.5.5 0 0 0 .76.43l4.6-2.8a.5.5 0 0 0 0-.86l-4.6-2.8A.5.5 0 0 0 10 9.2z" fill="currentColor" stroke="none"/>',
  minus: '<path d="M5 12h14"/>',
};
export function ic(name, size = 20) {
  if (iconNames.includes(name) || !P[name]) return icon(name, size);
  const s = svg('svg', { viewBox: '0 0 24 24', width: size, height: size, fill: 'none', stroke: 'currentColor', 'stroke-width': '1.75', 'stroke-linecap': 'round', 'stroke-linejoin': 'round', 'aria-hidden': 'true', class: 'ic' });
  s.innerHTML = P[name];
  return s;
}

// Collects cleanups (clocks, frames, observers, mic listeners) so a page can be torn down at once.
export class Scope {
  constructor() { this.fns = []; this.alive = true; }
  add(fn) { if (this.alive) this.fns.push(fn); else fn(); return fn; }
  observe(el, fn) { const ro = new ResizeObserver(fn); ro.observe(el); this.add(() => ro.disconnect()); return ro; }
  // A requestAnimationFrame loop that ends with the scope (or when the returned function is called).
  loop(fn) {
    let id = 0, on = true;
    const tick = (t) => { if (!on || !this.alive) return; fn(t); id = requestAnimationFrame(tick); };
    id = requestAnimationFrame(tick);
    const stop = () => { on = false; cancelAnimationFrame(id); };
    this.add(stop);
    return stop;
  }
  dispose() {
    this.alive = false;
    for (const fn of this.fns.splice(0).reverse()) { try { fn(); } catch (e) { console.error(e); } }
  }
}

// Immediate response for mouse and pen; touch waits for the tap (so scrolling doesn't play),
// and keyboard activation arrives as a click with detail 0.
function onPress(el, fn) {
  let type = '';
  el.addEventListener('pointerdown', (e) => { type = e.pointerType; if (e.button === 0 && (type === 'mouse' || type === 'pen')) fn(e); });
  el.addEventListener('click', (e) => { if (e.detail === 0 || (type !== 'mouse' && type !== 'pen')) fn(e); type = ''; });
}

export const noteLabel = (m, flats = false) => (flats ? FLAT_NAMES : SHARP_NAMES)[mod12(m)] + octaveOf(m);

// ---------------------------------------------------------------------------
// Small controls
export function seg(options, value, onChange, label) {
  const el = h('div', { class: 'seg th-seg', role: 'group', 'aria-label': label });
  const api = {
    el, value,
    set(v) {
      api.value = v;
      btns.forEach((b, i) => { const on = options[i][0] === v; b.classList.toggle('on', on); b.setAttribute('aria-pressed', String(on)); });
    },
    enable(v, yes) { const i = options.findIndex((o) => o[0] === v); if (i >= 0) btns[i].disabled = !yes; },
  };
  const btns = options.map(([v, text, title]) => h('button', { type: 'button', title, onclick: () => { if (api.value === v) return; api.set(v); onChange(v); } }, text));
  el.append(...btns);
  api.set(value);
  return api;
}

export function picker(options, value, onChange, label) {
  const el = h('select', { 'aria-label': label, class: 'th-select' }, ...options.map(([v, t]) => h('option', { value: String(v), selected: v === value }, t)));
  el.addEventListener('change', () => onChange(options[el.selectedIndex][0]));
  return {
    el,
    get value() { return options[el.selectedIndex][0]; },
    set(v) { const i = options.findIndex((o) => o[0] === v); if (i >= 0) el.selectedIndex = i; },
    relabel(fn) { [...el.options].forEach((o, i) => { o.textContent = fn(options[i][0], options[i][1]); }); },
  };
}

// A labelled group of controls, and a row of them.
export const field = (label, ...ctl) => h('div', { class: 'th-field' }, h('span', { class: 'th-flabel' }, label), ...ctl);
export const controls = (...kids) => h('div', { class: 'th-controls' }, ...kids);

// A large line of text with a smaller one under it. Pass live = false when it changes
// many times a second, so screen readers aren't flooded.
export function readout(main = '', sub = '', live = true) {
  const m = h('div', { class: 'th-big' }, main), s = h('div', { class: 'th-sub' }, sub);
  return {
    el: h('div', { class: 'th-readout', 'aria-live': live ? 'polite' : null }, m, s),
    set(a, b = '') { setText(m, a); setText(s, b); },
  };
}
// Write text only when it changes (avoids needless layout and repeated announcements).
export function setText(el, text) { if (el.textContent !== text) el.textContent = text; }

export function playButton(label = 'Play') {
  const b = h('button', { type: 'button', class: 'btn primary th-play' });
  const api = {
    el: b, on: false,
    set(on) {
      api.on = on;
      b.replaceChildren(ic(on ? 'stop' : 'play', 16), on ? 'Stop' : label);
      b.classList.toggle('primary', !on);
    },
  };
  api.set(false);
  return api;
}

// ---------------------------------------------------------------------------
// Tempo: − / + (hold to repeat), a slider and tap tempo.
export class Tempo {
  constructor({ bpm = 100, min = 40, max = 220, onChange = () => {}, tap = true }) {
    this.min = min; this.max = max; this.onChange = onChange; this.bpm = bpm; this.taps = [];
    this.num = h('strong', { class: 'th-bpm-n' });
    this.range = h('input', { type: 'range', min, max, step: 1, value: bpm, 'aria-label': 'Tempo in beats per minute', class: 'th-bpm-range' });
    this.range.addEventListener('input', () => this.set(+this.range.value));
    const step = (d) => this.set(this.bpm + d);
    this.el = h('div', { class: 'th-tempo' },
      this.repeatBtn('minus', 'Slower', () => step(-1)),
      h('div', { class: 'th-bpm' }, this.num, h('small', {}, 'BPM')),
      this.repeatBtn('plus', 'Faster', () => step(1)),
      this.range,
      tap ? this.tapBtn() : null);
    this.set(bpm, true);
  }
  repeatBtn(name, label, fn) {
    const b = h('button', { type: 'button', class: 'btn round small', 'aria-label': label }, ic(name, 16));
    let t1 = 0, t2 = 0;
    const end = () => { clearTimeout(t1); clearInterval(t2); };
    b.addEventListener('pointerdown', (e) => {
      if (e.button !== 0) return;
      fn(); end();
      t1 = setTimeout(() => { t2 = setInterval(() => (b.isConnected ? fn() : end()), 70); }, 420);
    });
    for (const ev of ['pointerup', 'pointerleave', 'pointercancel']) b.addEventListener(ev, end);
    b.addEventListener('click', (e) => { if (e.detail === 0) fn(); });
    return b;
  }
  tapBtn() {
    const b = h('button', { type: 'button', class: 'btn small th-tap' }, 'Tap');
    b.addEventListener('pointerdown', (e) => { if (e.button === 0) this.tap(); });
    b.addEventListener('keydown', (e) => { if ((e.key === ' ' || e.key === 'Enter') && !e.repeat) { e.preventDefault(); this.tap(); } });
    return b;
  }
  tap() {
    const bpm = tapTempo(this.taps);
    if (bpm) this.set(Math.round(bpm));
  }
  set(bpm, silent = false) {
    const v = Math.round(Math.min(this.max, Math.max(this.min, bpm)));
    const changed = v !== this.bpm;
    this.bpm = v;
    this.num.textContent = v;
    this.range.value = v;
    if (changed && !silent) this.onChange(v);
  }
}

// Average of recent tap intervals (a gap of more than 2 s starts over). Mutates `taps`.
export function tapTempo(taps, now = performance.now()) {
  if (taps.length && now - taps[taps.length - 1] > 2000) taps.length = 0;
  taps.push(now);
  if (taps.length > 9) taps.shift();
  if (taps.length < 2) return 0;
  const d = [];
  for (let i = 1; i < taps.length; i++) d.push(taps[i] - taps[i - 1]);
  const med = [...d].sort((a, b) => a - b)[d.length >> 1];
  const good = d.filter((x) => Math.abs(x - med) < med * 0.35);
  return 60000 / (good.reduce((a, b) => a + b, 0) / good.length);
}

// ---------------------------------------------------------------------------
// Piano keyboard built from real buttons. Arrow keys move between keys.
const BLACK_NUDGE = { 1: -0.12, 3: 0.12, 6: -0.14, 8: 0, 10: 0.14 };
export class Piano {
  constructor({ lo = 48, hi = 72, onKey = null, flats = false, label = 'Piano keyboard' } = {}) {
    this.lo = lo; this.hi = hi; this.onKey = onKey; this.flats = flats; this.labelFn = null;
    this.keys = new Map();
    this.el = h('div', { class: 'th-piano', role: 'group', 'aria-label': label });
    this.el.addEventListener('keydown', (e) => this.nav(e));
    this.render();
  }
  render() {
    this.el.replaceChildren();
    this.keys.clear();
    const whites = [];
    for (let m = this.lo; m <= this.hi; m++) if (!isBlack(m)) whites.push(m);
    const ww = 100 / whites.length, bw = ww * 0.6;
    whites.forEach((m, i) => this.add(m, false, i * ww, ww));
    for (let m = this.lo; m <= this.hi; m++) {
      if (!isBlack(m)) continue;
      const i = whites.indexOf(m - 1) + 1;
      this.add(m, true, i * ww - bw / 2 + BLACK_NUDGE[mod12(m)] * bw, bw);
    }
    this.focusKey = this.keys.get(this.lo);
    this.focusKey.tabIndex = 0;
    this.relabel();
  }
  add(m, black, left, width) {
    const b = h('button', { type: 'button', class: 'th-key ' + (black ? 'th-bk' : 'th-wk'), style: `left:${left.toFixed(3)}%;width:${width.toFixed(3)}%`, tabindex: -1 }, h('span', { class: 'th-kl' }));
    onPress(b, () => this.press(m));
    b.addEventListener('focus', () => { if (this.focusKey !== b) { this.focusKey.tabIndex = -1; b.tabIndex = 0; this.focusKey = b; } });
    this.keys.set(m, b);
    this.el.append(b);
  }
  press(m) {
    this.flash(m);
    if (this.onKey) this.onKey(m);
  }
  nav(e) {
    const d = { ArrowRight: 1, ArrowUp: 1, ArrowLeft: -1, ArrowDown: -1 }[e.key];
    if (!d && e.key !== 'Home' && e.key !== 'End') return;
    const cur = [...this.keys.entries()].find(([, b]) => b === document.activeElement);
    if (!cur) return;
    e.preventDefault();
    const m = e.key === 'Home' ? this.lo : e.key === 'End' ? this.hi : Math.min(this.hi, Math.max(this.lo, cur[0] + d));
    this.keys.get(m).focus();
  }
  // labelFn(m) -> text or null; default: letter names, with the octave on each C.
  setLabels(fn) { this.labelFn = fn; this.relabel(); }
  relabel() {
    for (const [m, b] of this.keys) {
      const name = noteLabel(m, this.flats);
      const text = this.labelFn ? this.labelFn(m) : mod12(m) === 0 ? name : name.replace(/-?\d+$/, '');
      b.firstChild.textContent = text || '';
      b.setAttribute('aria-label', isBlack(m) ? `${SHARP_NAMES[mod12(m)]}${octaveOf(m)} / ${FLAT_NAMES[mod12(m)]}${octaveOf(m)}` : name);
    }
  }
  mark(m, cls, on = true) { const b = this.keys.get(m); if (b) b.classList.toggle(cls, on); }
  clear(...cls) { for (const b of this.keys.values()) b.classList.remove(...cls); }
  flash(m, ms = 220) {
    const b = this.keys.get(m);
    if (!b) return;
    b.classList.add('is-on');
    clearTimeout(b._t);
    b._t = setTimeout(() => b.classList.remove('is-on'), ms);
  }
}

// ---------------------------------------------------------------------------
// Fretboard: horizontal (high E on top) when wide, vertical (low E on the left) when narrow.
// Every position is a button; arrow keys move along frets and across strings.
const INLAYS = [3, 5, 7, 9, 12, 15, 17];
export class Fretboard {
  constructor({ frets = 15, onPick = null, scope }) {
    this.frets = frets; this.onPick = onPick; this.markFn = null; this.vertical = null;
    this.cells = [];
    this.el = h('div', { class: 'th-fb' });
    this.el.addEventListener('keydown', (e) => this.nav(e));
    scope.observe(this.el, () => this.layout());
    this.layout();
  }
  layout() {
    const w = this.el.clientWidth || this.el.parentElement?.clientWidth || 800;
    const v = w < 560;
    if (v !== this.vertical) { this.vertical = v; this.render(); }
  }
  // Position of fret wire n along the neck (0..1), slightly compressed like a real neck.
  wire(n) {
    const open = this.vertical ? 0.07 : 0.065, k = 0.6;
    return open + (1 - open) * (1 - Math.pow(2, (-k * n) / 12)) / (1 - Math.pow(2, (-k * this.frets) / 12));
  }
  render() {
    const v = this.vertical, F = this.frets;
    const pos = (p, q) => (v ? `top:${(p * 100).toFixed(3)}%;left:${(q * 100).toFixed(3)}%` : `left:${(p * 100).toFixed(3)}%;top:${(q * 100).toFixed(3)}%`);
    const across = (s) => (v ? (s + 0.5) / 6 : (5 - s + 0.5) / 6);
    const board = h('div', { class: 'th-fb-board ' + (v ? 'is-v' : 'is-h') });
    for (let n = 0; n <= F; n++) board.append(h('i', { class: n === 0 ? 'th-nut' : 'th-fret', style: pos(this.wire(n), 0) }));
    for (const f of INLAYS) {
      if (f > F) continue;
      const p = (this.wire(f - 1) + this.wire(f)) / 2;
      for (const q of f === 12 ? [2 / 6, 4 / 6] : [0.5]) board.append(h('i', { class: 'th-inlay', style: pos(p, q) }));
    }
    for (let s = 0; s < 6; s++) board.append(h('i', { class: 'th-string', style: (v ? `left:${(across(s) * 100).toFixed(3)}%;` : `top:${(across(s) * 100).toFixed(3)}%;`) + `--w:${(2.6 - s * 0.32).toFixed(2)}px` }));
    this.cells = [];
    for (let s = 0; s < 6; s++) {
      this.cells[s] = [];
      for (let f = 0; f <= F; f++) {
        const a = f === 0 ? 0 : this.wire(f - 1), b = this.wire(f);
        const size = v ? `height:${((b - a) * 100).toFixed(3)}%;width:${(100 / 6).toFixed(3)}%` : `width:${((b - a) * 100).toFixed(3)}%;height:${(100 / 6).toFixed(3)}%`;
        const q = across(s) - 0.5 / 6;
        const btn = h('button', { type: 'button', class: 'th-pos', style: pos(a, q) + ';' + size, tabindex: -1 }, h('span', { class: 'th-dot' }));
        onPress(btn, () => this.pick(s, f));
        btn.addEventListener('focus', () => this.setFocus(s, f));
        this.cells[s][f] = btn;
        board.append(btn);
      }
    }
    const nums = h('div', { class: 'th-fb-nums ' + (v ? 'is-v' : 'is-h'), 'aria-hidden': 'true' });
    for (const f of INLAYS) if (f <= F) nums.append(h('span', { style: pos((this.wire(f - 1) + this.wire(f)) / 2, 0) }, f));
    this.el.replaceChildren(h('div', { class: 'th-fb-wrap ' + (v ? 'is-v' : 'is-h') }, nums, board));
    this.focus = this.focus || { s: 0, f: 0 };
    this.cells[this.focus.s][this.focus.f].tabIndex = 0;
    this.paint();
  }
  midi(s, f) { return TUNING[s] + f; }
  pick(s, f) {
    this.flash(s, f);
    if (this.onPick) this.onPick(s, f, this.midi(s, f));
  }
  setFocus(s, f) {
    const old = this.cells[this.focus.s]?.[this.focus.f];
    if (old) old.tabIndex = -1;
    this.focus = { s, f };
    this.cells[s][f].tabIndex = 0;
  }
  nav(e) {
    const { s, f } = this.focus;
    const v = this.vertical;
    const moves = v
      ? { ArrowDown: [0, 1], ArrowUp: [0, -1], ArrowRight: [1, 0], ArrowLeft: [-1, 0] }
      : { ArrowRight: [0, 1], ArrowLeft: [0, -1], ArrowUp: [1, 0], ArrowDown: [-1, 0] };
    const m = moves[e.key];
    if (!m || !this.el.contains(document.activeElement)) return;
    e.preventDefault();
    const ns = Math.min(5, Math.max(0, s + m[0])), nf = Math.min(this.frets, Math.max(0, f + m[1]));
    this.cells[ns][nf].focus();
  }
  // markFn(s, f, midi) -> null | { label, cls } where cls is '', 'root' or 'faint'.
  setMarks(fn) { this.markFn = fn; this.paint(); }
  paint() {
    for (let s = 0; s < 6; s++) for (let f = 0; f <= this.frets; f++) {
      const btn = this.cells[s][f], m = this.midi(s, f);
      const mk = this.markFn ? this.markFn(s, f, m) : null;
      btn.className = 'th-pos' + (mk ? ' has-dot' + (mk.cls ? ' is-' + mk.cls : '') : '');
      btn.firstChild.textContent = mk ? mk.label : '';
      btn.setAttribute('aria-label', `${STRING_NAMES[s]} string, ${f ? 'fret ' + f : 'open'}: ${noteLabel(m)}`);
    }
  }
  flash(s, f, ms = 260) {
    const btn = this.cells[s]?.[f];
    if (!btn) return;
    btn.classList.add('is-on');
    clearTimeout(btn._t);
    btn._t = setTimeout(() => btn.classList.remove('is-on'), ms);
  }
}

// ---------------------------------------------------------------------------
// Chord box (vertical: low E on the left, nut at the top).
export function chordBox(shape, label = '') {
  const { frets, fingers = [], barre = null } = shape;
  const played = frets.filter((f) => f > 0);
  const top = Math.max(0, ...played);
  const base = top <= 4 ? 1 : Math.min(...played);
  const rows = Math.max(4, top - base + 1);
  const X = (s) => 14 + s * 12, Y = (r) => 24 + r * 15;
  const g = svg('svg', { viewBox: `0 0 92 ${Y(rows) + 6}`, class: 'th-box', role: 'img', 'aria-label': label });
  if (base > 1) g.append(svg('text', { x: 2, y: Y(0.5) + 3.5, class: 'th-box-fr' }, base + 'fr'));
  for (let r = 0; r <= rows; r++) g.append(svg('line', { x1: X(0), x2: X(5), y1: Y(r), y2: Y(r), class: r === 0 && base === 1 ? 'th-box-nut' : 'th-box-line' }));
  for (let s = 0; s < 6; s++) g.append(svg('line', { x1: X(s), x2: X(s), y1: Y(0), y2: Y(rows), class: 'th-box-line' }));
  frets.forEach((f, s) => {
    if (f < 0) g.append(svg('path', { d: `M${X(s) - 3.2} 9.8l6.4 6.4M${X(s) + 3.2} 9.8l-6.4 6.4`, class: 'th-box-x' }));
    else if (f === 0) g.append(svg('circle', { cx: X(s), cy: 13, r: 3.4, class: 'th-box-o' }));
  });
  if (barre) {
    const y = Y(barre.fret - base + 0.5);
    g.append(svg('rect', { x: X(barre.from) - 5.6, y: y - 5.6, width: X(barre.to) - X(barre.from) + 11.2, height: 11.2, rx: 5.6, class: 'th-box-dot' }));
  }
  frets.forEach((f, s) => {
    if (f <= 0) return;
    const y = Y(f - base + 0.5);
    const inBarre = barre && f === barre.fret && s >= barre.from && s <= barre.to;
    if (!inBarre) g.append(svg('circle', { cx: X(s), cy: y, r: 5.6, class: 'th-box-dot' }));
    if (fingers[s] && (!inBarre || s === barre.from)) g.append(svg('text', { x: X(s), y: y + 2.7, class: 'th-box-num' }, fingers[s]));
  });
  return g;
}

// ---------------------------------------------------------------------------
// A two-ring key wheel (circle of fifths, Camelot). Items run clockwise from the top.
// Each segment is focusable; arrows move around (left/right) and between rings (up/down).
export function wheel({ outer, inner, label, onPick }) {
  const R = [100, 69, 41];
  const el = svg('svg', { viewBox: '-104 -104 208 208', class: 'th-wheel', role: 'group', 'aria-label': label });
  const pt = (r, a) => [r * Math.sin(a), -r * Math.cos(a)].map((v) => v.toFixed(2)).join(' ');
  const sector = (r0, r1, k) => {
    const a0 = ((k - 0.5) * Math.PI) / 6 + 0.004, a1 = ((k + 0.5) * Math.PI) / 6 - 0.004;
    return `M${pt(r0, a0)} A${r0} ${r0} 0 0 1 ${pt(r0, a1)} L${pt(r1, a1)} A${r1} ${r1} 0 0 0 ${pt(r1, a0)} Z`;
  };
  const segs = [[], []];
  [outer, inner].forEach((items, ring) => items.forEach((it, k) => {
    const r0 = R[ring], r1 = R[ring + 1], mid = (r0 + r1) / 2, a = (k * Math.PI) / 6;
    const [x, y] = [mid * Math.sin(a), -mid * Math.cos(a)];
    const g = svg('g', { class: 'th-ws ' + (ring ? 'is-in' : 'is-out'), tabindex: ring === 0 && k === 0 ? 0 : -1, role: 'button', 'aria-label': it.aria || it.main },
      svg('path', { d: sector(r0, r1, k) }),
      svg('text', { x: x.toFixed(2), y: (y + (it.sub ? -1 : 3.6)).toFixed(2), class: 'th-wm' }, it.main),
      it.sub ? svg('text', { x: x.toFixed(2), y: (y + (ring ? 7.6 : 9.2)).toFixed(2), class: 'th-wsub' }, it.sub) : null);
    g.addEventListener('click', () => onPick(ring, k));
    g.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onPick(ring, k); return; }
      const mv = { ArrowRight: [0, 1], ArrowLeft: [0, -1], ArrowDown: [1, 0], ArrowUp: [-1, 0] }[e.key];
      if (!mv) return;
      e.preventDefault();
      const nr = Math.min(1, Math.max(0, ring + mv[0])), nk = (k + mv[1] + 12) % 12;
      g.tabIndex = -1;
      segs[nr][nk].tabIndex = 0;
      segs[nr][nk].focus();
    });
    segs[ring][k] = g;
    el.append(g);
  }));
  const cMain = svg('text', { x: 0, y: -2, class: 'th-wc-main' });
  const cSub = svg('text', { x: 0, y: 13, class: 'th-wc-sub' });
  el.append(svg('g', { class: 'th-wc', 'aria-hidden': 'true' }, svg('circle', { r: R[2] - 3 }), cMain, cSub));
  return {
    el,
    center(main, sub = '') { cMain.textContent = main; cSub.textContent = sub; },
    // fn(ring, k) -> extra class ('is-sel' marks the chosen key)
    state(fn) {
      segs.forEach((ring, r) => ring.forEach((g, k) => {
        const cls = fn(r, k);
        g.setAttribute('class', 'th-ws ' + (r ? 'is-in' : 'is-out') + (cls ? ' ' + cls : ''));
        g.setAttribute('aria-pressed', String(cls === 'is-sel'));
      }));
    },
    focusOn(ring, k) { segs.flat().forEach((g) => (g.tabIndex = -1)); segs[ring][k].tabIndex = 0; },
  };
}

// ---------------------------------------------------------------------------
// "Watch and read" links. External ones open in a new tab.
export function linkList(links) {
  return h('div', { class: 'list th-links' }, ...links.map((l) => {
    const external = /^https?:/.test(l.url);
    const kind = /youtube\.com/.test(l.url) ? 'video' : external ? 'book' : 'practice';
    return h('a', external ? { href: l.url, target: '_blank', rel: 'noopener' } : { href: l.url },
      h('span', { class: 'li-ic' }, ic(kind, 18)),
      h('span', { class: 'li-text' }, h('strong', {}, l.t), h('small', {}, l.by), external ? h('span', { class: 'th-sr' }, ' (opens in a new tab)') : null),
      h('span', { class: 'li-end' }, ic(external ? 'external' : 'chevron', 16)));
  }));
}
