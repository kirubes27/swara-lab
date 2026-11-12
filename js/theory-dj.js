// DJ: tempo and tap tempo, beatmatching, phrasing, harmonic mixing, EQ, and track structure.
import { h } from './ui.js';
import * as A from './theory-audio.js';
import { mod12, camelotKey, camelotStep, voiceChord } from './theory-core.js';
import { seg, field, controls, readout, playButton, tapTempo, wheel, ic, svg } from './theory-ui.js';

const range = (a, b) => Array.from({ length: b - a + 1 }, (_, i) => a + i);
const soon = () => A.now() + 0.03;
const wrapHalf = (x) => x - Math.round(x); // to [-0.5, 0.5]

// One bar of sixteenths per groove: fn(step 0..15, time, options passed to every sound).
const GROOVES = {
  hiphop: (i, t, o) => {
    if (i === 0 || i === 7 || i === 10) A.kick(t, o);
    if (i === 4 || i === 12) A.snare(t, { ...o, vel: 0.9 });
    if (i % 2 === 0) A.hat(t, { ...o, vel: i % 4 ? 0.45 : 0.8 });
  },
  house: (i, t, o) => {
    if (i % 4 === 0) A.kick(t, o);
    if (i === 4 || i === 12) A.clap(t, o);
    if (i % 4 === 2) A.hat(t, { ...o, open: true, vel: 0.7 });
    else A.shaker(t, o);
  },
  techno: (i, t, o) => {
    if (i % 4 === 0) A.kick(t, { ...o, pitch: 0.9 });
    A.hat(t, { ...o, vel: i % 4 === 2 ? 0.9 : 0.32 });
    if (i === 12) A.clap(t, { ...o, vel: 0.55 });
  },
  dnb: (i, t, o) => {
    if (i === 0 || i === 10) A.kick(t, o);
    if (i === 4 || i === 12) A.snare(t, o);
    if (i % 2 === 0) A.hat(t, { ...o, vel: 0.55 });
  },
};

// Re-trigger a CSS animation on an element.
function blink(el, cls = 'is-beat') { el.classList.remove(cls); void el.offsetWidth; el.classList.add(cls); }

// ---------------------------------------------------------------------------
const STYLES = [
  { id: 'hiphop', name: 'Hip-hop', bpm: 90, range: [84, 98] },
  { id: 'house', name: 'House', bpm: 124, range: [118, 128] },
  { id: 'techno', name: 'Techno', bpm: 132, range: [126, 140] },
  { id: 'dnb', name: 'Drum & bass', bpm: 174, range: [168, 176] },
];

function tempoDemo(host, scope) {
  const tag = {}, taps = [];
  let style = STYLES[1], bpm = style.bpm, mystery = false, revealed = false, tapped = 0;
  const num = h('strong', {});
  const dot = h('i', { class: 'th-beatdot', 'aria-hidden': 'true' });
  const tapText = h('div', { class: 'th-sub', 'aria-live': 'polite' }, 'Tap along with the kick drum.');
  const btn = playButton('Play');
  const revealBtn = h('button', { type: 'button', class: 'btn', hidden: true }, 'Reveal');
  const clock = new A.Clock({
    bpm, div: 4,
    onStep: (step, t) => {
      const i = step % 16;
      GROOVES[style.id](i, t, { tag });
      if (i % 4 === 0) A.at(t, () => blink(dot), tag);
    },
  });
  const show = () => { num.textContent = mystery && !revealed ? '?' : String(bpm); };
  const start = () => { if (!clock.running) { clock.start(); btn.set(true); } };
  const stop = () => { clock.stop(); A.silence(tag); btn.set(false); };
  const pick = (id) => {
    if (id === 'mystery') {
      style = STYLES[Math.floor(Math.random() * 3)];
      bpm = style.range[0] + Math.round(Math.random() * (style.range[1] - style.range[0]));
      mystery = true; revealed = false;
    } else {
      style = STYLES.find((s) => s.id === id); bpm = style.bpm; mystery = false;
    }
    taps.length = 0; tapped = 0;
    clock.bpm = bpm;
    revealBtn.hidden = !mystery;
    tapText.textContent = mystery ? 'Tap along, then reveal the answer.' : `${style.name} usually sits around ${style.range[0]}–${style.range[1]} BPM.`;
    show();
    if (clock.running) { A.silence(tag); clock.start(); } else start();
  };
  const styleSeg = seg([...STYLES.map((s) => [s.id, s.name]), ['mystery', 'Mystery']], style.id, pick, 'Style');
  const tap = () => {
    const v = tapTempo(taps);
    if (!v) { tapText.textContent = 'Keep tapping…'; return; }
    tapped = v;
    tapText.textContent = `You tapped ${v.toFixed(1)} BPM` + (taps.length < 5 ? '. A few more taps settle it.' : '.');
  };
  const pad = h('button', { type: 'button', class: 'th-tappad' }, h('strong', {}, 'Tap'), h('small', {}, 'on every beat, or press Space'));
  pad.addEventListener('pointerdown', (e) => { if (e.button === 0) { tap(); blink(pad, 'is-hit'); } });
  pad.addEventListener('keydown', (e) => { if ((e.key === ' ' || e.key === 'Enter') && !e.repeat) { e.preventDefault(); tap(); blink(pad, 'is-hit'); } });
  revealBtn.addEventListener('click', () => {
    revealed = true; show();
    const d = tapped ? tapped - bpm : NaN;
    const half = tapped && Math.abs(tapped * 2 - bpm) < 3 ? ' You tapped half time, which DJs do too.' : tapped && Math.abs(tapped / 2 - bpm) < 3 ? ' You tapped double time.' : '';
    tapText.textContent = `It was ${style.name.toLowerCase()} at ${bpm} BPM.` + (tapped ? ` You were ${Math.abs(d) < 1 ? 'spot on' : `off by ${Math.abs(d).toFixed(1)}`}.` : '') + half;
  });
  btn.el.addEventListener('click', () => (clock.running ? stop() : start()));
  scope.add(() => clock.stop());
  host.append(controls(field('Style', styleSeg.el), h('div', { class: 'th-gap' }), revealBtn, btn.el),
    h('div', { class: 'th-tempo-big' }, h('div', { class: 'th-bignum' }, dot, num, h('small', {}, 'BPM')), pad),
    tapText);
  show();
}

// ---------------------------------------------------------------------------
// Two decks with their own tempo and phase. Positions are in beats; each deck keeps an
// anchor (beat position at an audio time) and is re-anchored whenever its rate changes.
function beatmatchDemo(host, scope) {
  const tag = {};
  const randB = () => { let b; do b = 118 + Math.random() * 12; while (Math.abs(b - 124) < 1.5); return Math.round(b * 10) / 10; };
  const deckA = { bpm0: 124, pitch: 0, nudge: 0, beat: 0, anchor: 0, next: 0 };
  const deckB = { bpm0: randB(), pitch: 0, nudge: 0, beat: 0, anchor: 0, next: 0 };
  let chain = null, timer = 0, showNums = true, xfade = 0;
  const rate = (d) => (d.bpm0 * (1 + d.pitch + d.nudge)) / 60;
  const posAt = (d, t) => d.beat + (t - d.anchor) * rate(d);
  const reanchor = (d) => { if (!chain) return; const t = A.now(); d.beat = posAt(d, t); d.anchor = t; };
  const timeOf = (d, pos) => d.anchor + (pos - d.beat) / rate(d);
  const sounds = {
    a: (i, t, o) => { if (i % 4 === 0) A.kick(t, o); if (i === 4 || i === 12) A.clap(t, { ...o, vel: 0.7 }); if (i % 4 === 2) A.hat(t, { ...o, vel: 0.8 }); },
    b: (i, t, o) => { if (i % 4 === 0) A.kick(t, { ...o, pitch: 0.86, vel: 0.9 }); if (i % 4 === 2) A.hat(t, { ...o, open: true, vel: 0.5 }); A.shaker(t, { ...o, vel: 0.8 }); },
  };
  const pump = () => {
    const now = A.now(), horizon = now + (document.hidden ? 1 : 0.12);
    for (const [d, key] of [[deckA, 'a'], [deckB, 'b']]) {
      let t = timeOf(d, d.next / 4);
      while (t < horizon) {
        if (t > now - 0.02) sounds[key](((d.next % 16) + 16) % 16, t, { tag, dest: chain[key] });
        d.next++;
        t = timeOf(d, d.next / 4);
      }
    }
  };
  const applyFade = () => {
    if (!chain) return;
    const x = (xfade + 1) * Math.PI / 4;
    chain.a.gain.setTargetAtTime(Math.cos(x) * 1.2, A.now(), 0.02);
    chain.b.gain.setTargetAtTime(Math.sin(x) * 1.2, A.now(), 0.02);
  };
  const start = () => {
    const c = A.ctx();
    const mk = (pan) => { const g = c.createGain(), p = c.createStereoPanner(); p.pan.value = pan; g.connect(p); p.connect(A.out()); return { g, p }; };
    const a = mk(-0.35), b = mk(0.35);
    chain = { a: a.g, b: b.g, nodes: [a.p, b.p] };
    applyFade();
    const t0 = c.currentTime + 0.1;
    Object.assign(deckA, { beat: 0, anchor: t0, next: 0, nudge: 0 });
    const off = (0.2 + Math.random() * 0.2) * (Math.random() < 0.5 ? -1 : 1);
    Object.assign(deckB, { beat: off, anchor: t0, next: Math.ceil(off * 4), nudge: 0 });
    timer = setInterval(pump, 25);
    pump();
    btn.set(true);
  };
  const stop = () => {
    clearInterval(timer); timer = 0;
    A.silence(tag);
    if (chain) { const old = chain; setTimeout(() => old.nodes.forEach((n) => n.disconnect()), 300); }
    chain = null;
    btn.set(false);
    lightsA.forEach((l) => l.classList.remove('is-on')); lightsB.forEach((l) => l.classList.remove('is-on'));
    status.textContent = 'Press play to start both decks.';
    meterDot.style.left = '50%';
  };
  const btn = playButton('Play both');
  btn.el.addEventListener('click', () => (chain ? stop() : start()));

  const lights = () => range(0, 3).map(() => h('i', { class: 'th-light' }));
  const lightsA = lights(), lightsB = lights();
  const bpmA = h('span', { class: 'th-deck-bpm' }), bpmB = h('span', { class: 'th-deck-bpm' });
  const fader = h('input', { type: 'range', min: -8, max: 8, step: 0.05, value: 0, class: 'th-fader', 'aria-label': 'Deck B tempo fader, percent' });
  const faderVal = h('span', { class: 'th-faderval' });
  fader.addEventListener('input', () => { reanchor(deckB); deckB.pitch = +fader.value / 100; paintNums(); });
  const nudge = (dir, label) => {
    const b = h('button', { type: 'button', class: 'btn small', 'aria-label': label }, ic(dir < 0 ? 'back' : 'chevron', 16), dir < 0 ? 'Slow' : 'Push');
    const on = () => { reanchor(deckB); deckB.nudge = dir * 0.04; b.classList.add('on'); };
    const offN = () => { if (!deckB.nudge) return; reanchor(deckB); deckB.nudge = 0; b.classList.remove('on'); };
    b.addEventListener('pointerdown', (e) => { if (e.button === 0) { b.setPointerCapture(e.pointerId); on(); } });
    for (const ev of ['pointerup', 'pointercancel', 'lostpointercapture']) b.addEventListener(ev, offN);
    b.addEventListener('keydown', (e) => { if ((e.key === ' ' || e.key === 'Enter') && !e.repeat) { e.preventDefault(); on(); } });
    b.addEventListener('keyup', (e) => { if (e.key === ' ' || e.key === 'Enter') offN(); });
    b.addEventListener('blur', offN);
    return b;
  };
  const xf = h('input', { type: 'range', min: -1, max: 1, step: 0.01, value: 0, class: 'th-xfade', 'aria-label': 'Crossfader, deck A to deck B' });
  xf.addEventListener('input', () => { xfade = +xf.value; applyFade(); });
  const numsChk = h('input', { type: 'checkbox', checked: true, 'aria-label': 'Show tempo numbers', onchange: (e) => { showNums = e.target.checked; paintNums(); } });
  const meterDot = h('i', { class: 'th-phase-dot' });
  const status = h('div', { class: 'th-sub th-match', 'aria-live': 'polite' }, 'Press play to start both decks.');
  const paintNums = () => {
    const b = deckB.bpm0 * (1 + deckB.pitch);
    bpmA.textContent = showNums ? '124.0 BPM' : '';
    bpmB.textContent = showNums ? b.toFixed(1) + ' BPM' : '';
    faderVal.textContent = (deckB.pitch >= 0 ? '+' : '') + (deckB.pitch * 100).toFixed(2) + '%';
  };
  const newTrack = h('button', { type: 'button', class: 'btn', onclick: () => {
    deckB.bpm0 = randB(); deckB.pitch = 0; fader.value = 0; paintNums();
    if (chain) { const t = A.now(); deckB.beat = posAt(deckA, t) + 0.3 * (Math.random() < 0.5 ? -1 : 1); deckB.anchor = t; deckB.next = Math.ceil(deckB.beat * 4); }
  } }, 'New track on B');
  let lastA = -1, lastB = -1;
  scope.loop(() => {
    if (!chain) return;
    const t = A.heardTime();
    const pa = posAt(deckA, t), pb = posAt(deckB, t);
    const ba = Math.floor(pa), bb = Math.floor(pb);
    if (ba !== lastA && pa >= 0) { lastA = ba; lightsA.forEach((l, k) => l.classList.toggle('is-on', k === mod12(ba) % 4)); }
    if (bb !== lastB && pb >= 0) { lastB = bb; lightsB.forEach((l, k) => l.classList.toggle('is-on', k === mod12(bb) % 4)); }
    const off = wrapHalf(pb - pa), ms = (off / rate(deckA)) * 1000;
    meterDot.style.left = (50 + off * 100).toFixed(2) + '%';
    const diff = deckB.bpm0 * (1 + deckB.pitch) - 124;
    const tempoOk = Math.abs(diff) < 0.06, phaseOk = Math.abs(ms) < 12;
    meterDot.classList.toggle('is-good', tempoOk && phaseOk);
    status.textContent = tempoOk && phaseOk ? 'Locked. The kicks land together.'
      : tempoOk ? `Tempo matched. Now nudge B ${ms > 0 ? 'back' : 'ahead'} (${Math.abs(Math.round(ms))} ms ${ms > 0 ? 'early' : 'late'}).`
        : showNums ? `B is ${Math.abs(diff).toFixed(1)} BPM ${diff < 0 ? 'slower' : 'faster'}. Move the fader.`
          : 'Listen: are the two kicks drifting apart? Move the fader until they stop.';
  });
  scope.add(stop);
  const deck = (name, lightsEl, bpmEl, side) => h('div', { class: 'th-deck is-' + side }, h('strong', {}, name), h('div', { class: 'th-lights' }, ...lightsEl), bpmEl);
  host.append(
    h('div', { class: 'th-decks' }, deck('Deck A', lightsA, bpmA, 'a'), deck('Deck B', lightsB, bpmB, 'b')),
    h('div', { class: 'th-phase', role: 'img', 'aria-label': 'Phase meter: where deck B\'s beat lands relative to deck A' },
      h('span', {}, 'B late'), h('div', { class: 'th-phase-track' }, h('i', { class: 'th-phase-mid' }), meterDot), h('span', {}, 'B early')),
    status,
    controls(btn.el, field('B tempo', fader, faderVal), field('Nudge B', nudge(-1, 'Slow deck B down while held'), nudge(1, 'Speed deck B up while held'))),
    controls(field('Crossfader', h('span', { class: 'th-xf' }, 'A', xf, 'B')), h('label', { class: 'ctl' }, numsChk, 'Show BPM'), h('div', { class: 'th-gap' }), newTrack),
    h('p', { class: 'th-note' }, 'Deck A is on the left, B on the right. With headphones, you can hear which kick is which.'));
  paintNums();
}

// ---------------------------------------------------------------------------
function phrasingDemo(host, scope) {
  const tag = {}, BPM = 124;
  let L = 8;
  const cells = range(0, 31).map((i) => h('span', { class: 'th-barcell' }, String(i + 1)));
  const grid = h('div', { class: 'th-bargrid', 'aria-hidden': 'true' }, ...cells);
  const out = readout('Bar 1 · beat 1', 'Phrase 1');
  const btn = playButton('Play');
  const layout = () => {
    cells.forEach((c, i) => { c.classList.toggle('is-start', i % L === 0); c.classList.toggle('is-alt', Math.floor(i / L) % 2 === 1); });
    grid.style.setProperty('--cols', L === 32 ? 8 : L);
  };
  const clock = new A.Clock({
    bpm: BPM, div: 4,
    onStep: (step, t, dt) => {
      const bar = Math.floor(step / 16) % 32, i = step % 16, block = Math.floor(bar / 8), inBlock = bar % 8;
      const o = { tag };
      if (i === 0 && inBlock === 0) A.crash(t, o);
      if (block !== 3 && i % 4 === 0) A.kick(t, o);
      if (block !== 3 || inBlock >= 6) A.hat(t, { ...o, vel: i % 4 === 2 ? 0.75 : 0.3, open: block === 2 && i % 4 === 2 });
      if (block >= 1 && (i === 4 || i === 12)) A.clap(t, o);
      if ((block === 1 || block === 2) && i % 4 === 2) A.bass(33 + (bar % 4 === 3 ? 3 : 0), t, dt * 1.6, o);
      if (block === 2 && (i === 6 || i === 14)) [57, 60, 64].forEach((m) => A.key(m, t, { ...o, vel: 0.35, dur: dt * 1.2 }));
      if (block === 3 && i === 0 && inBlock % 4 === 0) A.pad([57, 60, 64, 67], t, dt * 64, o);
      if (inBlock === 7 && i >= 8) A.snare(t, { ...o, vel: 0.3 + (i - 8) * 0.08 });
      if (i % 4 === 0) {
        const beat = i / 4;
        A.at(t, () => {
          cells.forEach((c, k) => c.classList.toggle('is-on', k === bar));
          const p = Math.floor(bar / L);
          cells.forEach((c, k) => c.classList.toggle('is-phrase', Math.floor(k / L) === p));
          out.set(`Bar ${(bar % L) + 1} of ${L} · beat ${beat + 1}`, `Phrase ${p + 1} of ${32 / L}` + (bar % L === 0 && beat === 0 ? ' · new phrase' : ''));
        }, tag);
      }
    },
  });
  const lenSeg = seg([[8, '8 bars'], [16, '16 bars'], [32, '32 bars']], L, (v) => { L = v; layout(); }, 'Phrase length');
  const jump = h('button', { type: 'button', class: 'btn', onclick: () => {
    if (!clock.running) return;
    const bar = Math.floor(clock.step / 16) % 32;
    let target = (Math.floor(bar / L) + 1) * L - 2;
    if (target <= bar) target += L;
    A.silence(tag, 0.02);
    clock.step = Math.floor(clock.step / 512) * 512 + (target % 32) * 16;
  } }, 'Skip to just before the next phrase');
  btn.el.addEventListener('click', () => {
    if (clock.running) { clock.stop(); A.silence(tag); btn.set(false); cells.forEach((c) => c.classList.remove('is-on', 'is-phrase')); return; }
    clock.start(); btn.set(true);
  });
  scope.add(() => clock.stop());
  host.append(controls(field('Count phrases of', lenSeg.el), h('div', { class: 'th-gap' }), btn.el, jump), out.el, grid,
    h('p', { class: 'th-note' }, 'Listen for the crash at the start of each 8 bars and the snare fill just before it. New sounds arrive on the phrase.'));
  layout();
}

// ---------------------------------------------------------------------------
function camelotDemo(host, scope) {
  const tag = {};
  let sel = { n: 8, letter: 'A' };
  const item = (k, letter) => { const n = k || 12, key = camelotKey(n, letter); return { main: n + letter, sub: key.short, aria: `${n}${letter}: ${key.name}` }; };
  const w = wheel({
    outer: range(0, 11).map((k) => item(k, 'B')), inner: range(0, 11).map((k) => item(k, 'A')),
    label: 'Camelot wheel. Choose a key to see the keys that mix well with it.',
    onPick: (ring, k) => { sel = { n: k || 12, letter: ring ? 'A' : 'B' }; w.focusOn(ring, k); update(); A.silence(tag); playKey(sel, soon(), 1.6); },
  });
  const head = h('h3', { class: 'th-keyname' });
  const sub = h('p', { class: 'th-sub' });
  const moves = h('div', { class: 'list th-moves' });
  const playKey = (code, t, dur) => {
    const key = camelotKey(code.n, code.letter);
    voiceChord(key.pc, key.minor ? 'min' : 'maj').forEach((m) => A.key(m, t, { tag, vel: 0.55, dur }));
    A.key(40 + mod12(key.pc - 4), t, { tag, vel: 0.5, dur });
  };
  const blend = (to) => { A.silence(tag); const t = soon(); playKey(sel, t, 2.8); playKey(to, t + 1.1, 1.8); };
  const update = () => {
    const key = camelotKey(sel.n, sel.letter);
    const other = sel.letter === 'A' ? 'B' : 'A';
    const list = [
      [{ n: sel.n, letter: other }, other === 'B' ? 'Relative major: same notes, brighter' : 'Relative minor: same notes, darker'],
      [{ n: camelotStep(sel.n, 1), letter: sel.letter }, 'One step clockwise: a gentle lift'],
      [{ n: camelotStep(sel.n, -1), letter: sel.letter }, 'One step anticlockwise: a gentle drop'],
      [{ n: camelotStep(sel.n, 6), letter: sel.letter }, 'Opposite side: hear the clash'],
    ];
    const good = new Set(list.slice(0, 3).map(([c]) => c.n + c.letter)), bad = list[3][0].n + list[3][0].letter;
    w.state((ring, k) => {
      const code = (k || 12) + (ring ? 'A' : 'B');
      return code === sel.n + sel.letter ? 'is-sel' : good.has(code) ? 'is-key' : code === bad ? 'is-clash' : '';
    });
    w.center(sel.n + sel.letter, key.short);
    head.textContent = `${sel.n}${sel.letter} · ${key.name}`;
    sub.textContent = 'Tap a move to hear the two keys overlap, the way they would in a mix.';
    moves.replaceChildren(...list.map(([c, text], i) => {
      const k = camelotKey(c.n, c.letter);
      return h('button', { type: 'button', class: 'li' + (i === 3 ? ' is-clash' : ''), onclick: () => blend(c) },
        h('span', { class: 'li-ic th-code' }, c.n + c.letter),
        h('span', { class: 'li-text' }, h('strong', {}, k.name), h('small', {}, text)),
        h('span', { class: 'li-end' }, ic('play', 14)));
    }));
  };
  scope.add(() => A.silence(tag));
  host.append(h('div', { class: 'th-cof' }, h('div', { class: 'th-cof-wheel' }, w.el), h('div', { class: 'th-cof-info' }, head, sub, moves)));
  update();
  w.focusOn(1, 8);
}

// ---------------------------------------------------------------------------
// A loop through a three-band EQ and a one-knob filter, with a live spectrum.
const dbOf = (v) => (v < 0 ? -40 * Math.pow(-v, 1.6) : 6 * v);

function eqDemo(host, scope) {
  const tag = {};
  let nodes = null;
  const vals = { low: 0, mid: 0, high: 0, filter: 0 };
  const canvas = h('canvas', { class: 'th-spectrum', 'aria-hidden': 'true' });
  const btn = playButton('Play loop');
  const apply = () => {
    if (!nodes) return;
    const t = A.now();
    nodes.low.gain.setTargetAtTime(dbOf(vals.low), t, 0.02);
    nodes.mid.gain.setTargetAtTime(dbOf(vals.mid), t, 0.02);
    nodes.high.gain.setTargetAtTime(dbOf(vals.high), t, 0.02);
    const f = vals.filter;
    nodes.lp.frequency.setTargetAtTime(f < 0 ? 20000 * Math.pow(150 / 20000, -f) : 20000, t, 0.03);
    nodes.hp.frequency.setTargetAtTime(f > 0 ? 20 * Math.pow(5000 / 20, f) : 20, t, 0.03);
  };
  const build = () => {
    const c = A.ctx();
    const mk = (type, freq, q) => { const n = c.createBiquadFilter(); n.type = type; n.frequency.value = freq; if (q) n.Q.value = q; return n; };
    const input = c.createGain();
    const low = mk('lowshelf', 220), mid = mk('peaking', 1000, 0.8), high = mk('highshelf', 3500);
    const lp = mk('lowpass', 20000, 1.2), hp = mk('highpass', 20, 1.2);
    const an = c.createAnalyser(); an.fftSize = 2048; an.smoothingTimeConstant = 0.78;
    input.connect(low); low.connect(mid); mid.connect(high); high.connect(lp); lp.connect(hp); hp.connect(an); an.connect(A.out());
    nodes = { input, low, mid, high, lp, hp, an, bins: new Uint8Array(an.frequencyBinCount), sr: c.sampleRate };
    apply();
  };
  const clock = new A.Clock({
    bpm: 122, div: 4,
    onStep: (step, t, dt) => {
      const i = step % 16, bar = Math.floor(step / 16) % 2, o = { tag, dest: nodes.input };
      if (i % 4 === 0) A.kick(t, o);
      if (i === 4 || i === 12) A.clap(t, o);
      A.hat(t, { ...o, open: i % 4 === 2, vel: i % 4 === 2 ? 0.6 : 0.35 });
      if (i % 4 === 2) A.bass(bar ? (i < 8 ? 29 : 31) : 33, t, dt * 1.7, o);
      if (i === 6 || i === 14) (bar ? [53, 57, 60] : [57, 60, 64]).forEach((m) => A.key(m, t, { ...o, vel: 0.42, dur: dt * 1.5 }));
    },
  });
  const slider = (key, label) => {
    const out = h('span', { class: 'th-db' });
    const input = h('input', { type: 'range', min: -1, max: 1, step: 0.01, value: 0, 'aria-label': label });
    const show = () => {
      const v = vals[key];
      if (key === 'filter') out.textContent = Math.abs(v) < 0.02 ? 'Off' : v < 0 ? 'Low-pass' : 'High-pass';
      else out.textContent = v <= -0.99 ? 'Kill' : (dbOf(v) > 0 ? '+' : '') + dbOf(v).toFixed(0) + ' dB';
    };
    input.addEventListener('input', () => { let v = +input.value; if (Math.abs(v) < 0.04) v = 0; vals[key] = v; show(); apply(); });
    input.addEventListener('dblclick', () => { input.value = 0; vals[key] = 0; show(); apply(); });
    show();
    return { el: h('label', { class: 'th-eqrow is-' + key }, h('span', { class: 'th-eqname' }, label), input, out), reset: () => { input.value = 0; vals[key] = 0; show(); } };
  };
  const rows = [slider('low', 'Low'), slider('mid', 'Mid'), slider('high', 'High'), slider('filter', 'Filter')];
  const reset = h('button', { type: 'button', class: 'btn', onclick: () => { rows.forEach((r) => r.reset()); apply(); } }, 'Reset');
  btn.el.addEventListener('click', () => {
    if (clock.running) { clock.stop(); A.silence(tag); btn.set(false); return; }
    if (!nodes) build();
    clock.start(); btn.set(true);
  });
  // spectrum
  let colors = null, frame = 0;
  const readColors = () => {
    const cs = getComputedStyle(document.documentElement);
    colors = { low: cs.getPropertyValue('--info').trim(), mid: cs.getPropertyValue('--accent').trim(), high: cs.getPropertyValue('--good').trim(), base: cs.getPropertyValue('--surface3').trim(), text: cs.getPropertyValue('--text3').trim() };
  };
  scope.loop(() => {
    const w = canvas.clientWidth, hgt = canvas.clientHeight, dpr = Math.min(2, window.devicePixelRatio || 1);
    if (!w) return;
    if (canvas.width !== Math.round(w * dpr) || canvas.height !== Math.round(hgt * dpr)) { canvas.width = Math.round(w * dpr); canvas.height = Math.round(hgt * dpr); }
    if (!colors || frame++ % 30 === 0) readColors();
    const g = canvas.getContext('2d');
    g.setTransform(dpr, 0, 0, dpr, 0, 0);
    g.clearRect(0, 0, w, hgt);
    const N = Math.max(24, Math.min(64, Math.floor(w / 9))), gap = 2, bw = (w - gap * (N - 1)) / N;
    if (nodes && clock.running) nodes.an.getByteFrequencyData(nodes.bins);
    for (let k = 0; k < N; k++) {
      const f0 = 30 * Math.pow(16000 / 30, k / N), f1 = 30 * Math.pow(16000 / 30, (k + 1) / N);
      let v = 0;
      if (nodes && clock.running) {
        const b0 = Math.floor((f0 / nodes.sr) * 2 * nodes.bins.length), b1 = Math.max(b0 + 1, Math.floor((f1 / nodes.sr) * 2 * nodes.bins.length));
        for (let b = b0; b < b1; b++) v = Math.max(v, nodes.bins[b] || 0);
      }
      const bh = Math.max(2, (v / 255) * (hgt - 18));
      g.fillStyle = v ? (f1 < 250 ? colors.low : f0 > 3000 ? colors.high : colors.mid) : colors.base;
      g.fillRect(k * (bw + gap), hgt - 16 - bh, bw, bh);
    }
    g.fillStyle = colors.text;
    g.font = '11px ' + getComputedStyle(canvas).fontFamily;
    if (!clock.running) {
      g.textAlign = 'center'; g.textBaseline = 'middle';
      g.fillText('Play the loop to see its spectrum', w / 2, (hgt - 16) / 2);
    }
    g.textBaseline = 'bottom';
    const xOf = (f) => (Math.log(f / 30) / Math.log(16000 / 30)) * w;
    g.textAlign = 'left'; g.fillText('Low', 2, hgt);
    g.textAlign = 'center'; g.fillText('Mid', xOf(1000), hgt);
    g.textAlign = 'right'; g.fillText('High', w - 2, hgt);
  });
  scope.add(() => { clock.stop(); if (nodes) { const n = nodes; setTimeout(() => { try { n.an.disconnect(); } catch { /* gone */ } }, 300); } });
  host.append(controls(btn.el, reset, h('span', { class: 'th-note' }, 'Double-click a slider to centre it.')),
    h('div', { class: 'th-eq' }, h('div', { class: 'th-eqrows' }, ...rows.map((r) => r.el)), canvas));
}

// ---------------------------------------------------------------------------
// A dance track in miniature: each part shortened to two bars, with its energy drawn above.
const PARTS = [
  { name: 'Intro', energy: 0.32, what: 'Drums only. Made for mixing in.' },
  { name: 'Build', energy: 0.6, what: 'Bass arrives, a riser and a snare roll pull upwards.' },
  { name: 'Drop', energy: 1, what: 'Everything at once. The main groove.' },
  { name: 'Breakdown', energy: 0.28, what: 'The kick drops out. Chords and space.' },
  { name: 'Build', energy: 0.66, what: 'Tension again, faster roll.' },
  { name: 'Drop', energy: 1, what: 'The payoff, a second time.' },
  { name: 'Outro', energy: 0.36, what: 'Back to drums, ready for the next track.' },
];

function structureDemo(host, scope) {
  const tag = {}, BARS = 2, W = 700, H = 120;
  const btn = playButton('Play the track');
  const out = readout('Seven parts, two bars each', 'Press play, or tap a part to start there.');
  const xs = PARTS.map((_, i) => ((i + 0.5) / PARTS.length) * W);
  const ys = PARTS.map((p) => H - 14 - p.energy * (H - 30));
  let d = `M0 ${ys[0]}`;
  PARTS.forEach((_, i) => { const x0 = i ? xs[i - 1] : 0, y0 = i ? ys[i - 1] : ys[0], xm = (x0 + xs[i]) / 2; d += ` C${xm} ${y0} ${xm} ${ys[i]} ${xs[i]} ${ys[i]}`; });
  d += ` C${(xs[6] + W) / 2} ${ys[6]} ${(xs[6] + W) / 2} ${ys[6]} ${W} ${ys[6]}`;
  const head = svg('line', { x1: 0, x2: 0, y1: 0, y2: H, class: 'th-playhead' });
  const bands = PARTS.map((_, i) => svg('rect', { x: (i / PARTS.length) * W, y: 0, width: W / PARTS.length, height: H, class: 'th-band' }));
  const chart = svg('svg', { viewBox: `0 0 ${W} ${H}`, preserveAspectRatio: 'none', class: 'th-energy', 'aria-hidden': 'true' },
    ...bands, svg('path', { d: d + ` L${W} ${H} L0 ${H} Z`, class: 'th-energy-fill' }), svg('path', { d, class: 'th-energy-line' }), head);
  const partBtns = PARTS.map((p, i) => h('button', { type: 'button', class: 'th-part', onclick: () => startAt(i) }, h('strong', {}, p.name), h('small', {}, p.what)));
  let startStep = 0, t0 = 0;
  const steps = BARS * 16;
  const clock = new A.Clock({
    bpm: 126, div: 4,
    onStep: (step, t, dt) => {
      const s = step + startStep, part = Math.floor(s / steps);
      if (part >= PARTS.length) { if (step === Math.ceil(steps * PARTS.length - startStep)) A.at(t, () => stopAll(true), tag); return; }
      const i = s % 16, inPart = s % steps, o = { tag };
      const name = PARTS[part].name;
      const full = name === 'Drop';
      if (inPart === 0) A.at(t, () => mark(part), tag);
      if (full && inPart === 0) A.crash(t, o);
      if (name !== 'Breakdown' && (name !== 'Build' || part === 1) && i % 4 === 0) A.kick(t, { ...o, vel: name === 'Intro' || name === 'Outro' ? 0.8 : 1 });
      if (name !== 'Breakdown' && i % 2 === 0) A.hat(t, { ...o, vel: i % 4 === 2 ? 0.7 : 0.3, open: full && i % 4 === 2 });
      if (full && (i === 4 || i === 12)) A.clap(t, o);
      if ((full || part === 1) && i % 4 === 2) A.bass(33 + (Math.floor(inPart / 16) ? 5 : 0), t, dt * 1.6, o);
      if (full && (i === 6 || i === 14)) [57, 60, 64].forEach((m) => A.key(m + (Math.floor(inPart / 16) ? 5 : 0), t, { ...o, vel: 0.4, dur: dt * 1.4 }));
      if (name === 'Breakdown' && inPart === 0) { A.pad([57, 60, 64, 69], t, dt * 16, o); A.pad([53, 57, 60, 65], t + dt * 16, dt * 15, o); }
      if (name === 'Build') {
        if (inPart === 0) A.riser(t, dt * steps, o);
        const every = part === 1 ? (inPart < 16 ? 4 : 2) : (inPart < 16 ? 2 : 1);
        if (inPart % every === 0) A.snare(t, { ...o, vel: 0.25 + 0.6 * (inPart / steps) });
      }
    },
  });
  const mark = (part) => {
    partBtns.forEach((b, i) => b.classList.toggle('is-on', i === part));
    bands.forEach((b, i) => b.classList.toggle('is-on', i === part));
    out.set(PARTS[part].name, PARTS[part].what);
  };
  const stopAll = (ended = false) => {
    clock.stop(); A.silence(tag); btn.set(false);
    head.style.opacity = 0;
    partBtns.forEach((b) => b.classList.remove('is-on')); bands.forEach((b) => b.classList.remove('is-on'));
    if (ended) out.set('That was the whole shape', 'Real tracks stretch each part to 16 or 32 bars.');
  };
  const startAt = (part) => {
    clock.stop(); A.silence(tag);
    startStep = part * steps;
    clock.start();
    t0 = clock.t0 - startStep * clock.stepDur;
    btn.set(true);
    head.style.opacity = 1;
  };
  btn.el.addEventListener('click', () => (clock.running ? stopAll() : startAt(0)));
  scope.loop(() => {
    if (!clock.running) return;
    const total = (steps * PARTS.length * 60) / 126 / 4;
    const x = Math.min(1, Math.max(0, (A.heardTime() - t0) / total)) * W;
    head.setAttribute('x1', x.toFixed(1)); head.setAttribute('x2', x.toFixed(1));
  });
  scope.add(() => clock.stop());
  head.style.opacity = 0;
  host.append(controls(btn.el), chart, h('div', { class: 'th-parts' }, ...partBtns), out.el);
}

// ---------------------------------------------------------------------------
export const DJ = {
  id: 'dj',
  title: 'DJ',
  icon: 'disc',
  sub: 'Tempo, beatmatching, phrasing, keys, EQ and energy.',
  lead: 'The ideas behind a smooth mix, with decks you can play.',
  lessons: [
    {
      id: 'tempo', title: 'BPM and tap tempo', sub: 'Find a track\'s tempo by ear.',
      lead: 'BPM, beats per minute, is a track\'s tempo. In dance music, it is usually the kick drum you count.',
      body: [
        'Styles live in tempo ranges: hip-hop often sits around 85–95 BPM, house 120–128, techno 125–140, drum & bass about 170–175.',
        'To find a BPM, tap along on every beat for a few bars. The average settles quickly.',
        'Half and double time link styles together: 87 BPM hip-hop lines up with every other beat of 174 BPM drum & bass.',
      ],
      demo: tempoDemo,
      links: [
        { t: 'Tempo and genre', by: 'Ableton Learning Music', url: 'https://learningmusic.ableton.com/make-beats/tempo-and-genre.html' },
        { t: 'How to count the BPM of any music', by: 'ellaskins · YouTube', url: 'https://www.youtube.com/watch?v=JdBuXkEVtOY' },
        { t: 'How to count beats and bars', by: 'DJ Shortee · YouTube', url: 'https://www.youtube.com/watch?v=P2s2dxhpcd4' },
      ],
    },
    {
      id: 'beatmatching', title: 'Beatmatching', sub: 'Line up two tracks by ear.',
      lead: 'To mix two tracks, their beats must line up: the same tempo, with the beats landing together.',
      body: [
        'First match the **tempo**. Move the incoming track\'s tempo fader until its BPM equals the one that is playing.',
        'Then fix the **phase**. Nudge the incoming track ahead or back, as you would with a jog wheel, until the kicks hit together. A galloping double kick means they are close but not aligned.',
        'Sync buttons do this for you, but matching by ear teaches you to hear drift before the dance floor does.',
      ],
      demo: beatmatchDemo,
      links: [
        { t: 'Beatmatch by ear', by: 'DJ Phil Harris · YouTube', url: 'https://www.youtube.com/watch?v=jeZeMGlTqAg' },
        { t: 'How to beatmatch by ear', by: 'Christian Jackson · YouTube', url: 'https://www.youtube.com/watch?v=wJ1JjA7Pvvc' },
        { t: 'Three ways to perfect beatmatching', by: 'Club Ready DJ School · YouTube', url: 'https://www.youtube.com/watch?v=4g0tOBQJ6M4' },
      ],
    },
    {
      id: 'phrasing', title: 'Phrasing', sub: 'Count bars and mix on the phrase.',
      lead: 'Dance music is built in blocks: four beats to a bar, and bars grouped into phrases of 8, 16 or 32.',
      body: [
        'Something changes at the start of a phrase: a new sound comes in, the drums drop out, the drop arrives. Crashes and drum fills mark the boundaries.',
        'Start the next track at the start of a phrase, so both tracks change at the same moment. A mix that ignores phrasing sounds clumsy even when the beats match.',
        'Count in bars, not seconds: 1 2 3 4, 2 2 3 4, 3 2 3 4, and so on.',
      ],
      demo: phrasingDemo,
      links: [
        { t: 'Phrasing tutorial and basic mixing', by: 'Crossfader · YouTube', url: 'https://www.youtube.com/watch?v=9oCnVJFpXhQ' },
        { t: 'How DJs know exactly when to mix', by: 'DJ Blakey · YouTube', url: 'https://www.youtube.com/watch?v=1dLfSkKLhuk' },
        { t: 'Bars', by: 'Ableton Learning Music', url: 'https://learningmusic.ableton.com/make-beats/bars.html' },
      ],
    },
    {
      id: 'harmonic', title: 'Harmonic mixing', sub: 'The Camelot wheel: which keys blend.',
      lead: 'Tracks in compatible keys blend smoothly; clashing keys sound sour where they overlap.',
      body: [
        'The **Camelot wheel** numbers the keys 1 to 12 around the circle of fifths. **A** codes are minor keys, **B** codes major: 8B is C major and 8A is A minor.',
        'From any code you can mix into the same code, one step either way on the same ring (8A to 7A or 9A), or straight across to the other ring (8A to 8B).',
        'DJ software and tools such as Mixed In Key detect each track\'s key and show its code.',
      ],
      demo: camelotDemo,
      links: [
        { t: 'Why DJs renamed the circle of fifths', by: 'David Bennett Music Theory · YouTube', url: 'https://www.youtube.com/watch?v=u5BrWJ1r0u8' },
        { t: 'Mixing in key with harmonic mixing', by: 'Crossfader · YouTube', url: 'https://www.youtube.com/watch?v=U_tS7iMwU54' },
        { t: 'Harmonic mixing', by: 'Wikipedia', url: 'https://en.wikipedia.org/wiki/Harmonic_mixing' },
      ],
    },
    {
      id: 'eq', title: 'EQ and filters', sub: 'Lows, mids, highs, and the bass swap.',
      lead: 'A mixer\'s EQ splits the sound into three bands, so you can make room for the next track.',
      body: [
        '**Low** is the kick and the bass. **Mid** holds vocals, chords and the snare. **High** is hi-hats and cymbals.',
        'Cut rather than boost. Two basslines at once turn to mud, so while two tracks play, keep the low EQ of one turned down. Swapping them on a phrase boundary is called a **bass swap**.',
        'A **filter** removes everything above a point (low-pass) or below it (high-pass). Sweeping one is a smooth way to bring a track in or take it out.',
      ],
      demo: eqDemo,
      links: [
        { t: 'How to use the EQ on a DJ mixer', by: 'Pro DJ Academy · YouTube', url: 'https://www.youtube.com/watch?v=-jRCizG7Ito' },
        { t: 'Bass swap EQ technique', by: 'AlphaTheta / Pioneer DJ · YouTube', url: 'https://www.youtube.com/watch?v=Dmb5GmLkbrY' },
        { t: 'Five EQ techniques for better mixes', by: 'Club Ready DJ School · YouTube', url: 'https://www.youtube.com/watch?v=z0mFNt1ZTBw' },
      ],
    },
    {
      id: 'structure', title: 'Energy and structure', sub: 'Intro, build, drop, breakdown, outro.',
      lead: 'Most dance tracks follow the same plan, and their energy rises and falls in ways you can predict.',
      body: [
        '**Intro**: mostly drums, made for mixing in. **Build**: tension rises with risers and snare rolls. **Drop**: the full groove. **Breakdown**: drums out, melody and space. Then a second build and drop, and a DJ-friendly **outro**.',
        'Energy comes from layers, not just volume. Taking the kick out feels like a dip; bringing it back feels like a lift.',
        'Pop songs work the same way with verse, pre-chorus, chorus and bridge: the chorus is the song\'s drop. DJs shape a set like this too: build, give the floor a breather, lift again.',
      ],
      demo: structureDemo,
      links: [
        { t: 'Song structure', by: 'Ableton Learning Music', url: 'https://learningmusic.ableton.com/song-structure/song-structure.html' },
        { t: 'Every type of song structure explained', by: 'David Bennett Music Theory · YouTube', url: 'https://www.youtube.com/watch?v=SDJwg1JoPtY' },
        { t: 'The art of DJing: building energy', by: 'Resident Advisor · YouTube', url: 'https://www.youtube.com/watch?v=I7LwQV9T7gg' },
        { t: 'EDM song structure', by: 'EDM Tips · YouTube', url: 'https://www.youtube.com/watch?v=EXx9At3iUOw' },
      ],
    },
  ],
};
