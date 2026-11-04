// Exercise player (warm-ups & drills), breath trainer and the live pitch readout.
import { audioCtx } from './audio.js';
import { mic } from './audio.js';
import { tanpura, guide } from './sound.js';
import { PitchLane } from './lane.js';
import { EXERCISES, parseSargam, makePlan, planRefAt, planCurves, scoredNotes, pitchMatchLines } from './exercises.js';
import { analyzeTake, swaraBiasText, describeSwaraBias } from './coach.js';
import { THAATS, saHzFrom, nearestSwara, swaraLabel, SWARA_LONG, wrapCents, westernName, hzToMidi, median, clamp } from './music.js';
import { settings, logActivity } from './store.js';
import { h, toast, ensureMic, tipList } from './ui.js';

// ---------------------------------------------------------------------------
export class LiveReadout {
  constructor(el) {
    this.el = el; this.ema = NaN; this.key = null;
    el.classList.add('readout');
    el.innerHTML = '<div class="ro-main">–</div><div class="ro-dev"></div><div class="ro-sub"></div>';
    this.m = el.querySelector('.ro-main'); this.d = el.querySelector('.ro-dev'); this.s = el.querySelector('.ro-sub');
  }
  // c: cents rel Sa (NaN = silence), refC: cents of target (optional)
  update(c, saHz, refC = NaN) {
    if (isNaN(c)) { this.ema = NaN; this.el.classList.add('idle'); return null; }
    this.el.classList.remove('idle');
    this.ema = isNaN(this.ema) || Math.abs(c - this.ema) > 150 ? c : this.ema + 0.35 * (c - this.ema);
    const x = this.ema;
    let ns = nearestSwara(x, settings.tuning);
    const k = ns.idx + 12 * ns.octave;
    if (this.key != null && this.key !== k && Math.abs(ns.dev) > 38) {
      // hysteresis: keep the previous label until clearly past the midpoint
      const prevIdx = ((this.key % 12) + 12) % 12, prevOct = Math.floor(this.key / 12);
      const prevC = (settings.tuning === 'just' ? [0, 111.73, 203.91, 315.64, 386.31, 498.04, 590.22, 701.96, 813.69, 884.36, 1017.6, 1088.27] : [0, 100, 200, 300, 400, 500, 600, 700, 800, 900, 1000, 1100])[prevIdx] + 1200 * prevOct;
      if (Math.abs(x - prevC) < 62) ns = { idx: prevIdx, octave: prevOct, dev: x - prevC };
    }
    this.key = ns.idx + 12 * ns.octave;
    const dev = !isNaN(refC) ? (settings.octaveFree ? wrapCents(x - refC) : x - refC) : ns.dev;
    const a = Math.abs(dev);
    const cls = a <= settings.tol ? 'good' : a <= settings.tol * 2.2 ? 'ok' : 'bad';
    const label = settings.notation === 'western' ? westernName(hzToMidi(saHz) + x / 100) : swaraLabel(ns.idx, ns.octave, settings.notation);
    this.m.textContent = label;
    this.m.className = 'ro-main ' + cls;
    this.d.textContent = (dev > 0 ? '+' : '') + Math.round(dev) + '¢' + (!isNaN(refC) ? ' vs target' : '');
    this.s.textContent = settings.notation === 'western' ? SWARA_LONG[ns.idx] : westernName(hzToMidi(saHz) + x / 100) + ' · ' + (saHz * Math.pow(2, x / 1200)).toFixed(0) + ' Hz';
    return cls;
  }
}

const centsOf = (hz, sa) => 1200 * Math.log2(hz / sa);

// ---------------------------------------------------------------------------
export class ExercisePlayer {
  constructor(root, { onDone } = {}) {
    this.root = root; this.onDone = onDone; this.running = false;
    root.classList.add('ex');
    root.innerHTML = '';
    this.head = h('div', { class: 'ex-head' });
    this.wrap = h('div', { class: 'lane-wrap' });
    this.canvas = h('canvas', { class: 'lane' });
    this.chip = h('div', { class: 'phase-chip' });
    const ro = h('div');
    this.wrap.append(this.canvas, ro, this.chip);
    this.readout = new LiveReadout(ro);
    this.controls = h('div', { class: 'controls' });
    this.result = h('div', { class: 'ex-result' });
    root.append(this.head, this.wrap, this.controls, this.result);
    this.lane = new PitchLane(this.canvas);
    this.lane.past = 2.5; this.lane.future = 4.5;
    this.lane.message = 'Press Start';
    this.drawIdle();
  }
  drawIdle() { this.lane.saHz = saHzFrom(settings); this.lane.tuning = settings.tuning; this.lane.notation = settings.notation; this.lane.draw(); }

  load(id, { custom = null } = {}) {
    this.stop(true);
    if (this.stopBreath) { this.stopBreath(); this.stopBreath = null; }
    this.wrap.style.display = '';
    this.id = id;
    const def = id === 'custom' ? { name: 'Swara Pad (your own line)', text: custom || 'S R G m P - P m G R S -', bpm: 60, echo: true, tanpura: true,
      what: 'Type any sargam line, e.g. a phrase from your song, and practise it as a drill. Notation: S r R g G m M P d D n N (lowercase = komal, M = tivra), N. = lower octave, S\' = upper, - = hold, _ = rest, S~G = meend, (N)S = kan, G* = gamak, [S R G m] = 4 notes in one beat.',
      why: 'Breaking a hard line into slow, exact sargam is how classical students learn compositions. Once it\'s accurate slowly, raise the tempo in small steps.' } : EXERCISES[id];
    this.def = def;
    this.text = null;
    this.bpm = def.bpm || 60;
    this.echo = def.echo !== false;
    this.head.innerHTML = '';
    this.head.append(
      h('h3', {}, def.name),
      h('p', { class: 'what' }, def.what),
      h('details', { class: 'why' }, h('summary', {}, 'Why this helps'), h('p', {}, def.why)),
    );
    this.result.innerHTML = '';
    this.controls.innerHTML = '';
    if (def.kind === 'breath') return this.loadBreath();
    this.startBtn = h('button', { class: 'btn primary', onclick: () => (this.running ? this.stop() : this.start()) }, '▶ Start');
    const echo = h('input', { type: 'checkbox', checked: this.echo, onchange: (e) => (this.echo = e.target.checked) });
    const bpmOut = h('span', { class: 'mono' }, String(this.bpm));
    const tempo = h('input', { type: 'range', min: 30, max: 160, step: 2, value: this.bpm, oninput: (e) => { this.bpm = +e.target.value; bpmOut.textContent = this.bpm; } });
    const blind = h('input', { type: 'checkbox', checked: settings.blind, onchange: (e) => (this.blind = e.target.checked) });
    this.blind = settings.blind;
    const items = [this.startBtn];
    if (def.kind !== 'match') items.push(h('label', { class: 'ctl', title: 'Listen first, then sing it back' }, echo, ' Listen → sing'));
    items.push(h('label', { class: 'ctl' }, 'Tempo ', tempo, ' ', bpmOut));
    items.push(h('label', { class: 'ctl', title: 'Hide your pitch line while singing; see it afterwards. Builds independence from the screen.' }, blind, ' Blind'));
    if (def.thaatText || def.kind === 'match' || id === 'custom') {
      const sel = h('select', { onchange: (e) => (this.thaat = e.target.value) }, ...Object.keys(THAATS).map((k) => h('option', { value: k, selected: k === settings.thaat }, `${k} / ${THAATS[k].carnatic}`)));
      this.thaat = settings.thaat;
      items.push(h('label', { class: 'ctl' }, 'Scale ', sel));
    }
    if (id === 'custom') {
      this.text = h('textarea', { class: 'sargam-input', rows: 2, spellcheck: false }, def.text);
      this.head.append(this.text);
    }
    this.controls.append(...items);
    this.lane.message = 'Press Start (headphones recommended)';
    this.preview();
  }

  buildLines() {
    const def = this.def;
    const scale = THAATS[this.thaat || settings.thaat].notes;
    const opts = { bpm: this.bpm, tuning: settings.tuning, scale };
    if (def.kind === 'match') {
      const sa = saHzFrom(settings);
      let lo = -500, hi = 1200;
      if (settings.rangeLowMidi != null) { lo = (settings.rangeLowMidi - hzToMidi(sa)) * 100 + 150; hi = (settings.rangeHighMidi - hzToMidi(sa)) * 100 - 150; }
      return { lines: pitchMatchLines(scale, { lo, hi, bpm: this.bpm, tuning: settings.tuning }), echo: true };
    }
    let text = id2text(def, scale, this.text);
    const parts = text.split('||').map((s) => s.trim()).filter(Boolean);
    const lines = parts.map((p) => parseSargam(p, opts));
    if (def.transposeReps) {
      const reps = [];
      for (let i = 0; i < def.transposeReps; i++) reps.push(lines[0]);
      return { lines: reps, echo: this.echo, transposeEach: (i) => i * 100 };
    }
    return { lines, echo: this.echo };
  }
  preview() {
    try {
      const { lines, echo, transposeEach } = this.buildLines();
      this.plan = makePlan(lines, { echo, transposeEach });
      this.setupLane();
      this.lane.now = -0.5;
      this.drawIdle();
    } catch (e) { this.lane.refAt = null; this.lane.message = e.message; this.drawIdle(); }
  }
  setupLane() {
    const plan = this.plan;
    let lo = Infinity, hi = -Infinity;
    for (const s of plan.segments) for (const e of s.events) for (const c of [e.c0, e.c1, e.osc && e.osc.c1]) if (c != null && !isNaN(c)) { lo = Math.min(lo, c); hi = Math.max(hi, c); }
    if (!isFinite(lo)) { lo = 0; hi = 1200; }
    const pad = 250, span = Math.max(900, hi - lo + 2 * pad);
    this.lane.setRange((lo + hi) / 2 - span / 2, (lo + hi) / 2 + span / 2, true);
    this.lane.refAt = (t) => planRefAt(plan, t);
    this.lane.regions = plan.segments.map((s) => ({ start: s.start, end: s.end, kind: s.mode === 'listen' ? 'listen' : 'sing', label: s.mode === 'listen' ? 'Listen' : s.mode === 'sing' ? 'Your turn' : 'Sing along' }));
    this.lane.tol = settings.tol; this.lane.octaveFree = settings.octaveFree;
    this.lane.scale = this.def.kind === 'match' || this.def.thaatText ? THAATS[this.thaat || settings.thaat].notes : null;
    this.lane.user = [];
    this.lane.message = '';
  }

  async start() {
    if (this.running || this.starting) return;
    this.starting = true;
    try { if (!(await ensureMic())) return; } finally { this.starting = false; }
    if (this.running) return;
    try { const { lines, echo, transposeEach } = this.buildLines(); this.plan = makePlan(lines, { echo, transposeEach }); }
    catch (e) { toast(e.message, 'bad'); return; }
    const c = audioCtx();
    const sa = saHzFrom(settings);
    this.setupLane();
    this.result.innerHTML = '';
    this.frames = [];
    this.lane.user = this.frames;
    const spb = 60 / this.bpm;
    const lead = Math.max(1.2, 2 * spb + 0.3);
    this.T0 = c.currentTime + lead;
    guide.vol = settings.guideVol; guide.timbre = settings.guideTimbre;
    guide.click(this.T0 - 2 * spb, true); guide.click(this.T0 - spb);
    const groups = planCurves(this.plan, sa).map((g) => ({ ...g, start: g.start + this.T0, end: g.end + this.T0 }));
    guide.playCurves(groups);
    this.duckedTanpura = this.def.tanpura === false && tanpura.on;
    if (this.duckedTanpura) tanpura.duck(true);
    if (this.def.tanpura && !tanpura.on && settings.autoTanpura !== false) { tanpura.start(sa, settings.tanpuraFirst); this.startedTanpura = true; }
    const lat = mic.latencySec() + (c.outputLatency || 0) + (settings.latencyMs || 0) / 1000;
    this.off = mic.on((f) => {
      const t = c.currentTime - this.T0 - lat;
      this.frames.push({ t, c: f.hz > 0 ? centsOf(f.hz, sa) : NaN });
    });
    this.running = true;
    this.startBtn.textContent = '■ Stop';
    this.startBtn.classList.remove('primary');
    this.hideFrom = this.blind ? 0 : Infinity;
    const loop = () => {
      if (!this.running) return;
      const t = c.currentTime - this.T0;
      this.lane.now = t;
      const seg = this.plan.segments.find((s) => t >= s.start - 0.3 && t < s.end + 0.3);
      this.chip.textContent = t < 0 ? 'Get ready…' : seg ? (seg.mode === 'listen' ? '👂 Listen' : seg.mode === 'sing' ? '🎤 Your turn' : '🎤 Sing along') : '';
      this.chip.className = 'phase-chip ' + (seg ? seg.mode : '');
      this.lane.hideUserFrom = this.blind ? -1e9 : Infinity;
      const last = this.frames[this.frames.length - 1];
      const ref = planRefAt(this.plan, t);
      const cls = this.readout.update(last ? last.c : NaN, sa, ref);
      this.lane.live = last && !this.blind ? { c: last.c, color: cls ? getComputedStyle(this.root).getPropertyValue('--' + cls) : null } : null;
      this.lane.draw();
      if (t > this.plan.duration + 0.2) { this.finish(); return; }
      this.raf = requestAnimationFrame(loop);
    };
    this.raf = requestAnimationFrame(loop);
  }

  stop(silent = false) {
    if (!this.running) return;
    this.running = false;
    cancelAnimationFrame(this.raf);
    guide.stopAll();
    if (this.off) this.off();
    if (this.duckedTanpura) tanpura.duck(false);
    if (this.startBtn) { this.startBtn.textContent = '▶ Start'; this.startBtn.classList.add('primary'); }
    this.chip.textContent = '';
    if (!silent) { this.lane.hideUserFrom = Infinity; this.lane.draw(); }
  }

  finish() {
    this.stop(true);
    this.lane.hideUserFrom = Infinity; this.lane.live = null;
    const plan = this.plan;
    // show the whole exercise statically so the singer can review it
    this.lane.past = 0; this.lane.future = plan.duration + 0.5; this.lane.now = -0.2;
    this.lane.draw();
    setTimeout(() => { this.lane.past = 2.5; this.lane.future = 4.5; }, 0);
    const scoredRef = (t) => { const s = plan.segments.find((x) => t >= x.start && t < x.end); return s && s.mode !== 'listen' ? planRefAt(plan, t) : NaN; };
    const res = analyzeTake({ frames: this.frames, refAt: scoredRef, start: 0, end: plan.duration, tol: settings.tol, octaveFree: settings.octaveFree, tuning: settings.tuning });
    // per-note view
    const notes = scoredNotes(plan).map((e) => {
      const a = e.t + Math.min(0.12, e.dur * 0.25), b = e.t + e.dur - 0.04;
      const ds = this.frames.filter((f) => f.t >= a && f.t <= b && !isNaN(f.c)).map((f) => { const d = f.c - planRefAt(plan, f.t); return settings.octaveFree ? wrapCents(d) : d; });
      const cover = ds.length / Math.max(1, (b - a) * 60);
      const md = ds.length ? median(ds) : NaN;
      return { e, md, cover, ok: ds.length > 3 && Math.abs(md) <= settings.tol && cover > 0.3 };
    });
    const hit = notes.filter((n) => n.ok).length;
    this.renderResult(res, notes, hit);
    const minutes = (plan.duration + 2) / 60;
    logActivity({ type: 'drill', id: this.id, score: res.score, accuracy: res.accuracy, minutes, perSwara: res.perSwara, weak: res.weak });
    this.onDone && this.onDone(res);
  }

  renderResult(res, notes, hit) {
    const r = this.result; r.innerHTML = '';
    const big = h('div', { class: 'score-big ' + (res.score >= 75 ? 'good' : res.score >= 50 ? 'ok' : 'bad') }, String(res.score));
    const stats = h('div', { class: 'stats' },
      stat('In tune', Math.round(res.accuracy * 100) + '%'),
      stat('Sung', Math.round(res.coverage * 100) + '%'),
      stat('Notes hit', `${hit}/${notes.length}`),
      stat('Avg offset', (res.bias > 0 ? '+' : '') + Math.round(res.bias) + '¢'),
      res.wobble != null ? stat('Wobble', '±' + Math.round(res.wobble) + '¢') : null,
    );
    const chips = h('div', { class: 'note-chips' }, ...notes.map((n) => {
      const lab = n.e.note ? swaraLabel(n.e.note.idx, n.e.note.oct, settings.notation === 'western' ? 'hindustani' : settings.notation) : '·';
      const cls = isNaN(n.md) ? 'miss' : n.ok ? 'good' : Math.abs(n.md) <= settings.tol * 2.2 ? 'ok' : 'bad';
      return h('span', { class: 'chip ' + cls, title: isNaN(n.md) ? 'not sung' : `${n.md > 0 ? '+' : ''}${Math.round(n.md)}¢` }, lab, h('small', {}, isNaN(n.md) ? '–' : `${n.md > 0 ? '+' : ''}${Math.round(n.md)}`));
    }));
    const bias = swaraBiasText(res.perSwara, 6);
    r.append(h('div', { class: 'result-top' }, big, stats), chips);
    if (bias.length) r.append(h('p', { class: 'muted small' }, 'Per-swara tendency: ' + describeSwaraBias(bias.slice(0, 4))));
    r.append(tipList(res.tips.filter((t) => !/lag|behind|ahead/.test(t.title))));
    r.append(h('div', { class: 'row' }, h('button', { class: 'btn', onclick: () => this.start() }, '↻ Again'), this.onNext ? h('button', { class: 'btn primary', onclick: () => this.onNext() }, 'Next →') : null));
  }

  // ---- breath trainer -------------------------------------------------------
  loadBreath() {
    const orb = h('div', { class: 'breath-orb' }, h('span', {}, 'Ready'));
    const info = h('div', { class: 'breath-info' });
    const btn = h('button', { class: 'btn primary', onclick: () => run() }, '▶ Start (3 rounds)');
    this.wrap.style.display = 'none';
    const box = h('div', { class: 'breath' }, orb, info);
    this.controls.append(btn);
    this.result.append(box);
    const results = [];
    let stopFlag = false;
    const run = async () => {
      if (!(await ensureMic())) return;
      btn.disabled = true; results.length = 0;
      for (let round = 1; round <= 3 && !stopFlag; round++) {
        // inhale 4 s
        for (let k = 4; k > 0; k--) { orb.className = 'breath-orb in'; orb.firstChild.textContent = `Inhale ${k}`; await wait(1000); if (stopFlag) return; }
        orb.className = 'breath-orb out'; orb.firstChild.textContent = 'Hiss…';
        const base = mic.level;
        let started = 0, lastLoud = 0, t0 = performance.now();
        await new Promise((res) => {
          const tick = () => {
            const now = performance.now();
            const loud = mic.level > Math.max(mic.gate * 1.5, 0.004);
            if (loud) { if (!started) started = now; lastLoud = now; }
            const dur = started ? (lastLoud - started) / 1000 : 0;
            orb.firstChild.textContent = started ? dur.toFixed(1) + ' s' : 'Hiss…';
            orb.style.setProperty('--p', Math.min(1, dur / 30));
            if ((started && now - lastLoud > 700) || (!started && now - t0 > 6000) || now - t0 > 60000 || stopFlag) return res();
            requestAnimationFrame(tick);
          };
          tick();
        });
        const dur = started ? (lastLoud - started) / 1000 : 0;
        results.push(dur);
        info.textContent = results.map((d, i) => `Round ${i + 1}: ${d.toFixed(1)} s`).join(' · ');
        orb.className = 'breath-orb'; orb.firstChild.textContent = 'Rest';
        await wait(2500);
        if (stopFlag) return;
      }
      if (stopFlag || !results.length) return;
      const best = Math.max(...results);
      orb.firstChild.textContent = `Best ${best.toFixed(1)} s`;
      info.append(h('p', {}, best < 12 ? 'Goal: 20 s+. Breathe low (belly and sides expand), keep the hiss quiet and even, and don\'t push the air out.' : best < 25 ? 'Good. Aim for 25–30 s with an even, quiet hiss.' : 'Excellent breath control. Keep it even and relaxed.'));
      logActivity({ type: 'breath', id: 'breath', score: Math.min(100, Math.round((best / 30) * 100)), seconds: best, minutes: 1.5 });
      btn.disabled = false; btn.textContent = '↻ Again';
      if (this.onNext) this.controls.append(h('button', { class: 'btn primary', onclick: () => this.onNext() }, 'Next →'));
      this.onDone && this.onDone({ score: best });
    };
    this.stopBreath = () => { stopFlag = true; };
  }
}

function id2text(def, scale, textEl) {
  if (textEl) return textEl.value;
  if (def.thaatText) {
    const t = def.thaatText(scale);
    // split ascending / descending halves into separate echo lines
    if (t.includes(' - ')) { const k = t.indexOf(' - '); return t.slice(0, k + 2) + ' || ' + t.slice(k + 3); }
    const parts = t.split(' | '); const half = Math.ceil(parts.length / 2);
    return parts.slice(0, half).join(' ') + ' || ' + parts.slice(half).join(' ');
  }
  return def.text;
}
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
function stat(label, val) { return h('div', { class: 'stat' }, h('div', { class: 'stat-v' }, val), h('div', { class: 'stat-l' }, label)); }
export { stat };
