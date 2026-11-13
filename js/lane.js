// Canvas renderers: the scrolling pitch lane and a whole-song overview strip.
import { ET_CENTS, JUST_CENTS, SWARA_SHORT, CARNATIC, WESTERN, hzToMidi, wrapCents, nearestSwara } from './music.js';

function cssVars(el) {
  const cs = getComputedStyle(el);
  const g = (n, d) => (cs.getPropertyValue(n).trim() || d);
  return {
    bg: g('--lane-bg', '#14161c'), grid: g('--lane-grid', 'rgba(255,255,255,0.06)'), gridStrong: g('--lane-grid-strong', 'rgba(255,255,255,0.18)'),
    text: g('--lane-text', 'rgba(255,255,255,0.75)'), dim: g('--lane-dim', 'rgba(255,255,255,0.4)'),
    ref: g('--lane-ref', 'rgba(120,170,255,0.30)'), refLine: g('--lane-ref-line', 'rgba(150,190,255,0.85)'),
    good: g('--good', '#3ecf8e'), ok: g('--ok', '#f5b942'), bad: g('--bad', '#ff6b6b'),
    now: g('--accent', '#f39c3d'), shadeListen: g('--lane-listen', 'rgba(120,170,255,0.06)'), shadeSing: g('--lane-sing', 'rgba(62,207,142,0.06)'),
    loop: g('--lane-loop', 'rgba(243,156,61,0.10)'), font: getComputedStyle(document.body).fontFamily,
  };
}

function fit(canvas) {
  const dpr = Math.min(2, window.devicePixelRatio || 1);
  const w = Math.max(10, Math.round(canvas.clientWidth * dpr)), h = Math.max(10, Math.round(canvas.clientHeight * dpr));
  if (canvas.width !== w || canvas.height !== h) { canvas.width = w; canvas.height = h; }
  return dpr;
}

export class PitchLane {
  constructor(canvas) {
    this.c = canvas; this.g = canvas.getContext('2d');
    this.now = 0; this.past = 3; this.future = 5;
    this.refAt = null;            // fn(t) -> cents rel Sa or NaN
    this.user = [];               // [{t, c}] cents rel Sa
    this.lo = -600; this.hi = 1500; this.targetLo = this.lo; this.targetHi = this.hi;
    this.tol = 35; this.tuning = 'et'; this.notation = 'hindustani'; this.saHz = 138.6;
    this.scale = null;            // array of swara idx in scale (others dimmed)
    this.regions = [];            // [{start, end, kind:'listen'|'sing'|'loop', label}]
    this.labels = [];             // [{t, text}]
    this.hideUserFrom = Infinity; // blind mode: hide user frames after this time
    this.octaveFree = true;
    this.live = null;             // {c, dev} current pitch readout
    this.theme = null;
    this.message = '';
    this.nearestColor = false;    // free singing: colour by distance to the nearest note
    this.fixed = null;            // {t0, t1}: a static window; the playhead moves across it
    new ResizeObserver(() => { this.theme = null; }).observe(canvas);
    document.addEventListener('themechange', () => { this.theme = null; });
    matchMedia('(prefers-color-scheme: dark)').addEventListener?.('change', () => { this.theme = null; });
  }
  setRange(lo, hi, instant = false) {
    this.targetLo = lo; this.targetHi = hi;
    if (instant) { this.lo = lo; this.hi = hi; }
  }
  // fit range to reference over a time window (and the singer's recent pitch)
  autoRange(t0, t1, pad = 250) {
    if (!this.refAt) return;
    let lo = Infinity, hi = -Infinity;
    const step = Math.max(0.02, (t1 - t0) / 300);
    for (let t = t0; t <= t1; t += step) { const v = this.refAt(t); if (!isNaN(v)) { lo = Math.min(lo, v); hi = Math.max(hi, v); } }
    if (!isFinite(lo)) { lo = -200; hi = 1300; }
    const span = Math.max(1000, hi - lo + 2 * pad);
    const mid = (lo + hi) / 2;
    this.setRange(mid - span / 2, mid + span / 2);
  }
  y(c, H) { return H - ((c - this.lo) / (this.hi - this.lo)) * H; }
  draw() {
    const dpr = fit(this.c);
    if (!this.theme) this.theme = cssVars(this.c);
    const T = this.theme, g = this.g, W = this.c.width, H = this.c.height;
    // ease range
    this.lo += (this.targetLo - this.lo) * 0.12; this.hi += (this.targetHi - this.hi) * 0.12;
    const fx = this.fixed && this.fixed.t1 > this.fixed.t0 ? this.fixed : null;
    const t0 = fx ? fx.t0 : this.now - this.past, t1 = fx ? fx.t1 : this.now + this.future;
    const gx = fx ? 56 * dpr : 0; // a fixed window starts right of the note labels
    const X = (t) => gx + ((t - t0) / (t1 - t0)) * (W - gx);
    const Y = (c) => this.y(c, H);
    g.fillStyle = T.bg; g.fillRect(0, 0, W, H);
    // regions
    for (const r of this.regions) {
      if (r.end < t0 || r.start > t1) continue;
      g.fillStyle = r.kind === 'listen' ? T.shadeListen : r.kind === 'sing' ? T.shadeSing : T.loop;
      const x0 = Math.max(0, X(r.start)), x1 = Math.min(W, X(r.end));
      g.fillRect(x0, 0, x1 - x0, H);
      if (r.label) {
        g.fillStyle = T.dim; g.font = `${11 * dpr}px ${T.font}`; g.textBaseline = 'top';
        g.fillText(r.label, Math.max(x0 + 6 * dpr, 64 * dpr), 6 * dpr);
      }
    }
    // grid
    const table = this.tuning === 'just' ? JUST_CENTS : ET_CENTS;
    g.font = `${11 * dpr}px ${T.font}`; g.textBaseline = 'middle';
    const pxPerCent = H / (this.hi - this.lo);
    const oMin = Math.floor(this.lo / 1200) - 1, oMax = Math.ceil(this.hi / 1200) + 1;
    for (let o = oMin; o <= oMax; o++) {
      for (let i = 0; i < 12; i++) {
        const c = table[i] + 1200 * o;
        if (c < this.lo - 50 || c > this.hi + 50) continue;
        const y = Y(c);
        const inScale = !this.scale || this.scale.includes(i);
        const strong = i === 0, mid = i === 7;
        g.strokeStyle = strong ? T.gridStrong : T.grid;
        g.lineWidth = (strong ? 1.6 : mid ? 1.2 : 1) * dpr;
        g.globalAlpha = inScale ? 1 : 0.35;
        g.beginPath(); g.moveTo(56 * dpr, y); g.lineTo(W, y); g.stroke();
        const lab = this.notation === 'western' ? '' : this.notation === 'carnatic' ? CARNATIC[i] : SWARA_SHORT[i];
        // Only where the whole label fits (octave dots included): a name cut in half at the edge misreads.
        const above = (lab && o > 0 ? 10 : 7) * dpr, below = (lab && o < 0 ? 10 : 7) * dpr;
        if ((pxPerCent * 100 > 9 * dpr || strong || mid) && y - above >= 0 && y + below <= H) {
          g.fillStyle = strong ? T.text : T.dim;
          const midi = Math.round(hzToMidi(this.saHz) + c / 100);
          const west = WESTERN[((midi % 12) + 12) % 12] + (Math.floor(midi / 12) - 1);
          g.font = `${(strong ? 12 : 11) * dpr}px ${T.font}`;
          if (lab) {
            g.fillText(lab, 6 * dpr, y);
            const w = g.measureText(lab).width;
            if (o !== 0) { // octave dot
              g.beginPath(); g.arc(6 * dpr + w / 2, y + (o < 0 ? 8 : -8) * dpr, 1.6 * dpr, 0, 6.283); g.fill();
              if (Math.abs(o) > 1) { g.beginPath(); g.arc(6 * dpr + w / 2 + 4 * dpr, y + (o < 0 ? 8 : -8) * dpr, 1.6 * dpr, 0, 6.283); g.fill(); }
            }
            g.globalAlpha *= 0.7; g.font = `${9 * dpr}px ${T.font}`;
            g.fillText(west, 26 * dpr, y);
          } else g.fillText(west, 6 * dpr, y);
        }
        g.globalAlpha = 1;
      }
    }
    // plotted data is clipped to the right of the label gutter
    g.save(); g.beginPath(); g.rect(54 * dpr, 0, W - 54 * dpr, H); g.clip();
    // reference band
    if (this.refAt) {
      const step = (t1 - t0) / (W / (2 * dpr));
      const band = Math.max(4 * dpr, 2 * this.tol * pxPerCent);
      g.lineCap = 'round'; g.lineJoin = 'round';
      for (const pass of [0, 1]) {
        g.strokeStyle = pass ? T.refLine : T.ref;
        g.lineWidth = pass ? 1.5 * dpr : band;
        g.beginPath();
        let pen = false, prev = NaN;
        for (let t = t0; t <= t1; t += step) {
          const v = this.refAt(t);
          if (isNaN(v) || (!isNaN(prev) && Math.abs(v - prev) > 400)) { pen = false; prev = v; if (isNaN(v)) continue; }
          const x = X(t), y = Y(v);
          if (!pen) { g.moveTo(x, y); pen = true; } else g.lineTo(x, y);
          prev = v;
        }
        g.stroke();
      }
    }
    // labels (sargam of the reference)
    g.fillStyle = T.text; g.font = `600 ${12 * dpr}px ${T.font}`; g.textBaseline = 'bottom';
    for (const l of this.labels) {
      if (l.t < t0 || l.t > t1) continue;
      const y = l.c != null ? Y(l.c) - 10 * dpr : 18 * dpr;
      g.fillText(l.text, X(l.t), Math.max(14 * dpr, y));
    }
    // user trace
    g.lineWidth = 3 * dpr; g.lineCap = 'round';
    let p = null;
    for (const u of this.user) {
      if (u.t < t0 - 0.1) { p = null; continue; }
      if (u.t > t1) break;
      if (u.t > this.hideUserFrom) break;
      if (isNaN(u.c)) { p = null; continue; }
      if (p && u.t - p.t < 0.09 && Math.abs(u.c - p.c) < 300) { // never join across gaps or big leaps
        let col = T.text;
        const r = this.refAt ? this.refAt(u.t) : NaN;
        let d = NaN;
        if (!isNaN(r)) { d = u.c - r; if (this.octaveFree) d = wrapCents(d); }
        else if (this.nearestColor) d = nearestSwara(u.c, this.tuning).dev;
        if (!isNaN(d)) { const a = Math.abs(d); col = a <= this.tol ? T.good : a <= this.tol * 2.2 ? T.ok : T.bad; }
        g.strokeStyle = col;
        g.beginPath(); g.moveTo(X(p.t), Y(p.c)); g.lineTo(X(u.t), Y(u.c)); g.stroke();
      }
      p = u;
    }
    g.restore();
    // now line
    g.strokeStyle = T.now; g.lineWidth = 2 * dpr; g.globalAlpha = 0.9;
    const xn = X(this.now);
    g.beginPath(); g.moveTo(xn, 0); g.lineTo(xn, H); g.stroke();
    g.globalAlpha = 1;
    // live dot
    if (this.live && !isNaN(this.live.c) && this.now <= this.hideUserFrom) {
      g.fillStyle = this.live.color || T.now;
      g.beginPath(); g.arc(xn, Y(this.live.c), 6 * dpr, 0, 6.283); g.fill();
    }
    if (this.message) {
      g.fillStyle = T.dim; g.font = `${14 * dpr}px ${T.font}`; g.textAlign = 'center'; g.textBaseline = 'middle';
      g.fillText(this.message, W / 2, H / 2);
      g.textAlign = 'left';
    }
  }
}

// Whole-song overview: melody contour, phrases, loop, playhead. Click = seek, drag = loop.
export class Overview {
  constructor(canvas, { onSeek, onLoop } = {}) {
    this.c = canvas; this.g = canvas.getContext('2d');
    this.duration = 0; this.mel = null; this.phrases = []; this.loop = null; this.now = 0; this.theme = null;
    this.onSeek = onSeek; this.onLoop = onLoop; this.capture = null; // live capture preview {cents:Map}
    document.addEventListener('themechange', () => { this.theme = null; this.draw(); });
    let down = null;
    const tAt = (e) => { const r = canvas.getBoundingClientRect(); return Math.max(0, Math.min(1, (e.clientX - r.left) / r.width)) * this.duration; };
    canvas.addEventListener('pointerdown', (e) => { if (!this.duration) return; down = { t: tAt(e), x: e.clientX }; canvas.setPointerCapture(e.pointerId); });
    canvas.addEventListener('pointermove', (e) => {
      if (!down) return;
      if (Math.abs(e.clientX - down.x) > 6) { const t = tAt(e); this.loop = { a: Math.min(down.t, t), b: Math.max(down.t, t) }; this.draw(); }
    });
    canvas.addEventListener('pointerup', (e) => {
      if (!down) return;
      if (Math.abs(e.clientX - down.x) > 6) { const t = tAt(e); this.onLoop && this.onLoop(Math.min(down.t, t), Math.max(down.t, t)); }
      else this.onSeek && this.onSeek(down.t);
      down = null;
    });
    new ResizeObserver(() => this.draw()).observe(canvas);
  }
  draw() {
    const dpr = fit(this.c);
    if (!this.theme) this.theme = cssVars(this.c);
    const T = this.theme, g = this.g, W = this.c.width, H = this.c.height;
    g.fillStyle = T.bg; g.fillRect(0, 0, W, H);
    if (!this.duration) return;
    const X = (t) => (t / this.duration) * W;
    for (const p of this.phrases) { g.fillStyle = T.grid; g.fillRect(X(p.start), 0, Math.max(1, X(p.end) - X(p.start)), H); }
    if (this.loop) { g.fillStyle = T.loop; g.fillRect(X(this.loop.a), 0, X(this.loop.b) - X(this.loop.a), H); g.fillStyle = T.now; g.fillRect(X(this.loop.a), 0, dpr, H); g.fillRect(X(this.loop.b), 0, dpr, H); }
    const mel = this.mel;
    if (mel) {
      let lo = Infinity, hi = -Infinity;
      for (const v of mel.cents) if (!isNaN(v)) { if (v < lo) lo = v; if (v > hi) hi = v; }
      if (isFinite(lo)) {
        const pad = 100; lo -= pad; hi += pad;
        g.fillStyle = T.refLine;
        const per = Math.max(1, Math.floor(mel.cents.length / (W)));
        for (let i = 0; i < mel.cents.length; i += per) {
          const v = mel.cents[i]; if (isNaN(v)) continue;
          const t = mel.t0 + i * mel.hop;
          g.fillRect(X(t), H - ((v - lo) / (hi - lo)) * H, Math.max(1, dpr), Math.max(1, dpr));
        }
      }
    }
    g.fillStyle = T.now; g.fillRect(X(this.now) - dpr, 0, 2 * dpr, H);
  }
}
