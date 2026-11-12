// Guitar: the fretboard, open chords, scales, strumming, a tuner, and chords from scales.
import { h, ensureMic } from './ui.js';
import { mic } from './audio.js';
import * as A from './theory-audio.js';
import {
  mod12, hzOf, SHARP_NAMES, BOTH_NAMES, SCALES, scaleNotes, tonicName, CHORDS, chordTones,
  identifyChord, diatonicChords, TUNING, STRING_NAMES, SHAPES, BARRE_EXAMPLES, guitarShape, shapeNotes,
  pentatonicBox, scalePosition,
} from './theory-core.js';
import { Fretboard, chordBox, seg, picker, field, controls, readout, playButton, Tempo, ic, svg, noteLabel, setText } from './theory-ui.js';

const range = (a, b) => Array.from({ length: b - a + 1 }, (_, i) => a + i);
const soon = () => A.now() + 0.03;
const ALL_POSITIONS = TUNING.flatMap((open) => range(0, 15).map((f) => open + f));

// Warm the string sounds after the first touch, so later notes start instantly.
function warmOnce() {
  let done = false;
  return () => { if (!done) { done = true; A.prewarm(ALL_POSITIONS, 'pluck'); } };
}

// ---------------------------------------------------------------------------
function fretboardDemo(host, scope) {
  const tag = {}, warm = warmOnce();
  let mode = 'notes', which = 'all', tonic = 0, scale = 'major', q = 'maj', labels = 'names';
  const out = readout('Tap the fretboard', 'Every position plays its note.');
  const fb = new Fretboard({
    frets: 15, scope,
    onPick: (s, f, m) => {
      A.pluck(m, soon(), { tag, string: s });
      out.set(noteLabel(m), `${STRING_NAMES[s]} string, ${f ? 'fret ' + f : 'open'} · ${hzOf(m).toFixed(1)} Hz`);
      warm();
    },
  });
  const tonicSel = picker(range(0, 11).map((pc) => [pc, BOTH_NAMES[pc]]), tonic, (v) => { tonic = v; paint(); }, 'Key or root');
  const scaleSel = picker(['major', 'minor', 'majPenta', 'minPenta', 'blues'].map((k) => [k, SCALES[k].name]), scale, (v) => { scale = v; paint(); }, 'Scale');
  const chordSel = picker(['maj', 'min', 'dom7', 'maj7', 'min7'].map((k) => [k, CHORDS[k].name]), q, (v) => { q = v; paint(); }, 'Chord');
  const whichSeg = seg([['all', 'All'], ['natural', 'Natural only']], which, (v) => { which = v; paint(); }, 'Which notes');
  const labelSeg = seg([['names', 'Notes'], ['degrees', 'Degrees']], labels, (v) => { labels = v; paint(); }, 'Labels');
  const extra = h('div', { class: 'th-controls th-sub-controls' });
  const modeSeg = seg([['notes', 'All notes'], ['scale', 'A scale'], ['chord', 'A chord']], mode, (v) => { mode = v; setup(); }, 'Show');
  const setup = () => {
    if (mode === 'notes') extra.replaceChildren(field('Notes', whichSeg.el));
    else extra.replaceChildren(field(mode === 'scale' ? 'Key' : 'Root', tonicSel.el), mode === 'scale' ? field('Scale', scaleSel.el) : field('Chord', chordSel.el), field('Labels', labelSeg.el));
    if (mode === 'scale') tonicSel.relabel((pc) => tonicName(scale, pc));
    else tonicSel.relabel((pc) => BOTH_NAMES[pc]);
    paint();
  };
  const paint = () => {
    if (mode === 'scale') tonicSel.relabel((pc) => tonicName(scale, pc));
    if (mode === 'notes') {
      fb.setMarks((s, f, m) => {
        const natural = !SHARP_NAMES[mod12(m)].includes('♯');
        if (which === 'natural' && !natural) return null;
        return { label: SHARP_NAMES[mod12(m)], cls: natural ? '' : 'faint' };
      });
      return;
    }
    const tones = mode === 'scale' ? scaleNotes(scale, tonic) : chordTones(tonic, q);
    const byPc = new Map(tones.map((t) => [mod12(tonic + t.semis), t]));
    fb.setMarks((s, f, m) => {
      const t = byPc.get(mod12(m));
      return t ? { label: labels === 'names' ? t.name : t.deg, cls: t.semis === 0 ? 'root' : '' } : null;
    });
  };
  host.append(controls(field('Show', modeSeg.el)), extra, fb.el, out.el);
  setup();
}

// ---------------------------------------------------------------------------
function openChordsDemo(host, scope) {
  const tag = {}, warm = warmOnce();
  let style = 'down';
  const all = [...Object.entries(SHAPES).map(([name, sh]) => ({ name, label: name, shape: sh })),
    ...Object.entries(BARRE_EXAMPLES).map(([label, sh]) => ({ name: sh.chord, label, shape: sh }))];
  const play = (shape) => {
    A.silence(tag, 0.02);
    const notes = shapeNotes(shape), t = soon();
    if (style === 'pick') notes.filter((m) => m != null).forEach((m, i) => A.pluck(m, t + i * 0.16, { tag, vel: 0.75 }));
    else A.strum(notes, t, { up: style === 'up', vel: 0.85, spread: style === 'up' ? 0.012 : 0.016, tag });
    warm();
  };
  const cards = all.map((c) => {
    const notes = shapeNotes(c.shape).filter((m) => m != null);
    const id = identifyChord(notes);
    const tones = id ? chordTones(id.root, id.q).map((t) => t.name).join(' ') : '';
    const b = h('button', { type: 'button', class: 'th-boxcard', 'aria-label': `${c.label} chord: ${tones}. Play it.` },
      h('strong', {}, c.label), chordBox(c.shape, c.label), h('small', {}, tones));
    b.addEventListener('click', () => { cards.forEach((x) => x.classList.toggle('is-sel', x === b)); play(c.shape); });
    return b;
  });
  const styleSeg = seg([['down', 'Down'], ['up', 'Up'], ['pick', 'One by one']], style, (v) => { style = v; }, 'How to play the chord');
  host.append(controls(field('Strum', styleSeg.el)), h('div', { class: 'th-boxgrid' }, ...cards),
    h('p', { class: 'th-note' }, 'Numbers are fingers. A curved bar is a barre: one finger flat across several strings.'));
  scope.add(() => A.silence(tag));
}

// ---------------------------------------------------------------------------
function guitarScalesDemo(host, scope) {
  const tag = {}, warm = warmOnce();
  let scale = 'minPenta', tonic = 9, pos = 0, labels = 'degrees';
  let current = [];
  const fb = new Fretboard({ frets: 15, scope, onPick: (s, f, m) => { A.pluck(m, soon(), { tag, string: s }); warm(); } });
  const note = h('p', { class: 'th-note' });
  const btn = playButton('Play it');
  const tonicSel = picker(range(0, 11).map((pc) => [pc, tonicName(scale, pc)]), tonic, (v) => { tonic = v; paint(); }, 'Key');
  const labelSeg = seg([['names', 'Notes'], ['degrees', 'Degrees']], labels, (v) => { labels = v; paint(); }, 'Labels');
  const posWrap = h('div', { class: 'th-field' });
  const positions = () => (scale === 'minPenta'
    ? [['all', 'All'], [0, 'Box 1'], [1, '2'], [2, '3'], [3, '4'], [4, '5']]
    : [['all', 'All'], ['E', 'Root on low E'], ['A', 'Root on A']]);
  const buildPosSeg = () => {
    pos = scale === 'minPenta' ? 0 : 'E';
    const s = seg(positions(), pos, (v) => { pos = v; paint(); }, 'Position');
    posWrap.replaceChildren(h('span', { class: 'th-flabel' }, scale === 'minPenta' ? 'Box' : 'Position'), s.el);
  };
  const scaleSeg = seg([['minPenta', 'Minor pentatonic'], ['major', 'Major scale']], scale, (v) => {
    scale = v;
    tonic = v === 'minPenta' ? 9 : 7;
    tonicSel.relabel((pc) => tonicName(scale, pc));
    tonicSel.set(tonic);
    buildPosSeg(); paint();
  }, 'Scale');
  const paint = () => {
    A.silence(tag); btn.set(false);
    const tones = scaleNotes(scale, tonic);
    const byPc = new Map(tones.map((t) => [mod12(tonic + t.semis), t]));
    if (pos === 'all') current = [];
    else if (scale === 'minPenta') current = pentatonicBox(tonic, pos) || [];
    else current = scalePosition(tonic, SCALES.major.semis, pos === 'E' ? 0 : 1);
    const inPos = new Set(current.map((p) => p.s + ':' + p.f));
    fb.setMarks((s, f, m) => {
      const t = byPc.get(mod12(m));
      if (!t) return null;
      const strong = pos === 'all' || inPos.has(s + ':' + f);
      return { label: labels === 'names' ? t.name : t.deg, cls: !strong ? 'faint' : t.semis === 0 ? 'root' : '' };
    });
    btn.el.disabled = pos === 'all';
    btn.el.title = pos === 'all' ? 'Pick a box or position to play it' : '';
    if (pos === 'all') note.textContent = 'The whole neck. Pick a box or position to see one hand shape, and to play it.';
    else if (scale === 'minPenta') {
      const lo = Math.min(...current.map((p) => p.f)), hi = Math.max(...current.map((p) => p.f));
      note.textContent = `Box ${pos + 1}: frets ${lo} to ${hi}, two notes on every string.` + (pos === 0 ? ' The root is under your first finger on the low E string.' : '');
    } else {
      note.textContent = `One finger per fret across four frets, root on the ${pos === 'E' ? 'low E' : 'A'} string.`;
    }
  };
  btn.el.addEventListener('click', () => {
    if (btn.on) { A.silence(tag); btn.set(false); return; }
    if (!current.length) return;
    const seen = new Set();
    const up = current.map((p) => ({ ...p, m: TUNING[p.s] + p.f })).sort((a, b) => a.m - b.m || a.s - b.s).filter((p) => !seen.has(p.m) && seen.add(p.m));
    const run = [...up, ...up.slice(0, -1).reverse()];
    btn.set(true);
    const t0 = soon() + 0.05, gap = 0.2;
    run.forEach((p, i) => {
      const t = t0 + i * gap;
      A.pluck(p.m, t, { tag, string: p.s, vel: 0.75 });
      A.at(t, () => fb.flash(p.s, p.f, gap * 1100), tag);
    });
    A.at(t0 + run.length * gap + 0.3, () => btn.set(false), tag);
    warm();
  });
  buildPosSeg();
  host.append(controls(field('Scale', scaleSeg.el), field('Key', tonicSel.el)), controls(posWrap, field('Labels', labelSeg.el), h('div', { class: 'th-gap' }), btn.el), fb.el, note);
  paint();
}

// ---------------------------------------------------------------------------
const STRUMS = [
  { id: 'downs', name: 'Downs', slots: 'D-D-D-D-' },
  { id: 'eighths', name: 'Down-ups', slots: 'DUDUDUDU' },
  { id: 'faithful', name: 'Old faithful', slots: 'D-DU-UDU' },
  { id: 'waltz', name: 'Waltz, 3/4', slots: 'D-DUDU' },
];
const LOOPS = [['G', 'C', 'D', 'Em'], ['C', 'G', 'Am', 'F'], ['Am', 'F', 'C', 'G'], ['A', 'D', 'E', 'D']];
const arrow = (up) => svg('svg', { viewBox: '0 0 24 24', width: 22, height: 22, class: 'ic', fill: 'none', stroke: 'currentColor', 'stroke-width': 2, 'stroke-linecap': 'round', 'stroke-linejoin': 'round', 'aria-hidden': 'true' },
  svg('path', { d: up ? 'M12 20V4M6 10l6-6 6 6' : 'M12 4v16M6 14l6 6 6-6' }));

function strummingDemo(host, scope) {
  const tag = {}, warm = warmOnce();
  let pat = STRUMS[2], loop = LOOPS[0], clickOn = true;
  const slotsEl = h('div', { class: 'th-slots' });
  const now = h('div', { class: 'th-big' }, loop[0]);
  const next = h('div', { class: 'th-sub' }, 'Next: ' + loop[1]);
  const btn = playButton('Play');
  const draw = () => {
    const beats = pat.slots.length / 2;
    slotsEl.replaceChildren(...[...pat.slots].map((c, i) => h('span', { class: 'th-slot' + (c === '-' ? ' is-miss' : '') },
      c === '-' ? h('i', { class: 'th-miss' }) : arrow(c === 'U'),
      h('small', {}, i % 2 ? '&' : String(i / 2 + 1)))));
    slotsEl.style.setProperty('--n', pat.slots.length);
    slotsEl.setAttribute('aria-label', `Pattern ${pat.name}: ` + [...pat.slots].map((c) => (c === 'D' ? 'down' : c === 'U' ? 'up' : 'miss')).join(', ') + `, ${beats} beats`);
  };
  const clock = new A.Clock({
    bpm: 80, div: 2,
    onStep: (step, t) => {
      const n = pat.slots.length, i = step % n, bar = Math.floor(step / n) % loop.length;
      const name = loop[bar], c = pat.slots[i];
      const notes = shapeNotes(SHAPES[name]);
      if (c !== '-') A.strum(notes, t, { up: c === 'U', maxStrings: 4, vel: c === 'U' ? 0.5 : i === 0 ? 0.9 : 0.72, spread: c === 'U' ? 0.009 : 0.012, tag });
      if (clickOn && i % 2 === 0) A.click(t, i === 0 ? 2 : 1, { tag });
      A.at(t, () => {
        [...slotsEl.children].forEach((el, k) => el.classList.toggle('is-on', k === i));
        if (i === 0) { now.textContent = name; next.textContent = 'Next: ' + loop[(bar + 1) % loop.length]; }
      }, tag);
    },
  });
  const tempo = new Tempo({ bpm: 80, min: 50, max: 150, onChange: (b) => { clock.bpm = b; } });
  const patSeg = seg(STRUMS.map((p) => [p.id, p.name]), pat.id, (v) => { pat = STRUMS.find((p) => p.id === v); draw(); if (clock.running) { A.silence(tag); clock.start(); } }, 'Strumming pattern');
  const loopSel = picker(LOOPS.map((l, i) => [i, l.join(' – ')]), 0, (i) => { loop = LOOPS[i]; now.textContent = loop[0]; next.textContent = 'Next: ' + loop[1]; }, 'Chords');
  const clickChk = h('input', { type: 'checkbox', checked: true, onchange: (e) => { clickOn = e.target.checked; } });
  btn.el.addEventListener('click', () => {
    if (clock.running) { clock.stop(); A.silence(tag); btn.set(false); [...slotsEl.children].forEach((el) => el.classList.remove('is-on')); return; }
    warm(); clock.start(); btn.set(true);
  });
  scope.add(() => clock.stop());
  host.append(controls(field('Pattern', patSeg.el)),
    controls(field('Chords', loopSel.el), tempo.el, h('label', { class: 'ctl' }, clickChk, 'Click'), h('div', { class: 'th-gap' }), btn.el),
    h('div', { class: 'th-strum' }, h('div', { class: 'th-readout' }, now, next), slotsEl),
    h('p', { class: 'th-note' }, 'A dash is a miss: the hand keeps moving but skips the strings. One chord per bar.'));
  draw();
}

// ---------------------------------------------------------------------------
// Chromatic tuner. Readings are median-filtered and smoothed, and the needle eases
// towards them, so it glides instead of jumping.
function tunerDemo(host, scope) {
  const tag = {};
  let mode = 'guitar', off = null, target = null, est = NaN, angle = 0, lastVoiced = 0, inTuneSince = 0;
  const hist = [];
  // Gauge: ±50 cents spread over ±60 degrees; the green zone is ±5 cents.
  const R = 86, DEG = Math.PI / 180;
  const arc = (deg) => `M${(-R * Math.sin(deg * DEG)).toFixed(2)} ${(-R * Math.cos(deg * DEG)).toFixed(2)} A${R} ${R} 0 0 1 ${(R * Math.sin(deg * DEG)).toFixed(2)} ${(-R * Math.cos(deg * DEG)).toFixed(2)}`;
  const ticks = range(-5, 5).map((i) => {
    const a = i * 12 * DEG, r0 = i % 5 === 0 ? R - 13 : R - 7;
    return svg('line', { x1: (r0 * Math.sin(a)).toFixed(2), y1: (-r0 * Math.cos(a)).toFixed(2), x2: (R * Math.sin(a)).toFixed(2), y2: (-R * Math.cos(a)).toFixed(2), class: i === 0 ? 'th-tick0' : 'th-tickl' });
  });
  const needle = svg('g', { class: 'th-needle' }, svg('line', { x1: 0, y1: 0, x2: 0, y2: -(R - 4) }), svg('circle', { r: 5 }));
  const gauge = svg('svg', { viewBox: '-100 -100 200 112', class: 'th-gauge', 'aria-hidden': 'true' },
    svg('path', { d: arc(60), class: 'th-arc' }),
    svg('path', { d: arc(6), class: 'th-arc-ok' }),
    ...ticks,
    svg('text', { x: -R * 0.5, y: -R * 0.16, class: 'th-gl' }, '♭'), svg('text', { x: R * 0.5, y: -R * 0.16, class: 'th-gl' }, '♯'),
    needle);
  const noteEl = h('div', { class: 'th-tnote' }, '–');
  const centsEl = h('div', { class: 'th-tcents' }, 'Start, then pluck a string');
  const status = h('div', { class: 'th-tstatus', 'aria-live': 'polite' });
  const strings = TUNING.map((m, s) => h('button', { type: 'button', class: 'th-tstr', 'aria-label': `Play the target for the ${STRING_NAMES[s]} string, ${noteLabel(m)}`, onclick: () => { A.silence(tag, 0.02); A.pluck(m, soon(), { tag, vel: 0.85 }); } },
    h('strong', {}, SHARP_NAMES[mod12(m)]), h('small', {}, String(6 - s))));
  const modeSeg = seg([['guitar', 'Guitar'], ['chromatic', 'Chromatic']], mode, (v) => { mode = v; target = null; }, 'Tuner mode');
  const btn = h('button', { type: 'button', class: 'btn primary', 'aria-pressed': 'false' }, ic('mic', 16), 'Start tuner');
  const idle = (text) => { noteEl.textContent = '–'; noteEl.className = 'th-tnote'; centsEl.textContent = text; status.textContent = ''; strings.forEach((b) => b.classList.remove('is-target', 'is-good')); };
  const stop = () => {
    if (off) off();
    off = null; hist.length = 0; est = NaN; target = null;
    btn.replaceChildren(ic('mic', 16), 'Start tuner'); btn.classList.add('primary'); btn.setAttribute('aria-pressed', 'false');
    idle('Start, then pluck a string');
  };
  const frame = (f) => {
    const t = performance.now();
    if (!(f.hz > 0)) return;
    lastVoiced = t;
    const midi = 69 + 12 * Math.log2(f.hz / 440);
    hist.push(midi); if (hist.length > 5) hist.shift();
    const med = [...hist].sort((a, b) => a - b)[hist.length >> 1];
    if (mode === 'guitar') {
      const nearest = TUNING.reduce((b, m) => (Math.abs(m - med) < Math.abs(b - med) ? m : b), TUNING[0]);
      if (target == null || Math.abs(med - target) > Math.abs(med - nearest) + 0.6) target = nearest; // a little hysteresis
    } else {
      const n = Math.round(med);
      if (target == null || Math.abs(med - target) > 0.62) target = n;
    }
    const cents = 100 * (med - target);
    est = isNaN(est) || Math.abs(cents - est) > 60 ? cents : est + 0.25 * (cents - est);
    const a = Math.abs(est);
    noteEl.textContent = noteLabel(target);
    noteEl.className = 'th-tnote ' + (a <= 5 ? 'is-good' : a <= 15 ? 'is-ok' : 'is-off');
    centsEl.textContent = `${est > 0 ? '+' : ''}${Math.round(est)} cents · ${f.hz.toFixed(1)} Hz`;
    if (a <= 5) { if (!inTuneSince) inTuneSince = t; } else inTuneSince = 0;
    setText(status, a <= 5 && t - inTuneSince > 350 ? 'In tune' : est < 0 ? 'Flat: tune up' : 'Sharp: tune down');
    strings.forEach((b, s) => { b.classList.toggle('is-target', mode === 'guitar' && TUNING[s] === target); b.classList.toggle('is-good', mode === 'guitar' && TUNING[s] === target && a <= 5); });
  };
  btn.addEventListener('click', async () => {
    if (off) { stop(); return; }
    if (!(await ensureMic()) || !scope.alive || off) return;
    off = mic.on(frame);
    btn.replaceChildren(ic('stop', 14), 'Stop'); btn.classList.remove('primary'); btn.setAttribute('aria-pressed', 'true');
    idle('Listening. Pluck one string and let it ring.');
  });
  // The needle eases towards the estimate and drifts back to centre when the string stops.
  scope.loop(() => {
    const silent = performance.now() - lastVoiced > 700;
    if (off && silent && !isNaN(est)) { est = NaN; hist.length = 0; idle('Listening. Pluck one string and let it ring.'); }
    const goal = isNaN(est) ? 0 : Math.max(-50, Math.min(50, est)) * 1.2;
    angle += (goal - angle) * 0.16;
    needle.setAttribute('transform', `rotate(${angle.toFixed(2)})`);
    needle.classList.toggle('is-live', !isNaN(est));
  });
  scope.add(stop);
  host.append(
    h('div', { class: 'th-tuner' }, gauge, noteEl, centsEl, status),
    h('div', { class: 'th-tstrings', role: 'group', 'aria-label': 'Reference notes, low to high' }, ...strings),
    controls(field('Mode', modeSeg.el), h('div', { class: 'th-gap' }), btn),
    h('p', { class: 'th-note' }, 'Tap a string above to hear its target note. Use headphones or a quiet room for the steadiest reading.'));
}

// ---------------------------------------------------------------------------
function harmonyDemo(host, scope) {
  const tag = {}, warm = warmOnce();
  let tonic = 7, minor = false;
  const strip = h('div', { class: 'th-strip' });
  const grid = h('div', { class: 'th-boxgrid is-7' });
  let chords = [];
  const strumChord = (c, t) => A.strum(shapeNotes(guitarShape(c.rootPc, c.q, c.name)), t, { vel: 0.8, spread: 0.014, tag });
  const keySel = picker(range(0, 11).map((pc) => [pc, tonicName('major', pc)]), tonic, (v) => { tonic = v; update(); }, 'Key');
  const modeSeg = seg([[false, 'Major key'], [true, 'Minor key']], minor, (v) => {
    minor = v;
    tonic = v ? 4 : 7;
    keySel.relabel((pc) => tonicName(minor ? 'minor' : 'major', pc));
    keySel.set(tonic);
    update();
  }, 'Key type');
  const playSeq = (idx, gap = 0.85) => {
    A.silence(tag, 0.02);
    const t0 = soon() + 0.04;
    idx.forEach((k, i) => {
      const t = t0 + i * gap;
      strumChord(chords[k], t);
      A.at(t, () => [...grid.children].forEach((el, j) => el.classList.toggle('is-sel', j === k)), tag);
    });
    warm();
  };
  const update = () => {
    A.silence(tag);
    chords = diatonicChords(tonic, minor);
    strip.replaceChildren(...scaleNotes(minor ? 'minor' : 'major', tonic).map((n) => h('span', { class: 'th-chip' + (n.semis === 0 ? ' is-root' : '') }, h('strong', {}, n.name), h('small', {}, n.deg))));
    grid.replaceChildren(...chords.map((c) => {
      const shape = guitarShape(c.rootPc, c.q, c.name);
      const b = h('button', { type: 'button', class: 'th-boxcard', 'aria-label': `${c.roman}: ${c.name}, ${c.tones.map((t) => t.name).join(' ')}. Play it.` },
        h('span', { class: 'th-rn' }, c.roman), h('strong', {}, c.name), chordBox(shape, c.name), h('small', {}, c.tones.map((t) => t.name).join(' ')));
      b.addEventListener('click', () => { [...grid.children].forEach((x) => x.classList.toggle('is-sel', x === b)); A.silence(tag, 0.02); strumChord(c, soon()); warm(); });
      return b;
    }));
    seqBtn.replaceChildren(ic('play', 14), minor ? 'Play i–iv–v–i' : 'Play I–IV–V–I');
  };
  const seqBtn = h('button', { type: 'button', class: 'btn primary', onclick: () => playSeq([0, 3, 4, 0]) });
  const allBtn = h('button', { type: 'button', class: 'btn', onclick: () => playSeq([0, 1, 2, 3, 4, 5, 6, 0], 0.7) }, 'All seven');
  scope.add(() => A.silence(tag));
  host.append(controls(field('Key', keySel.el), field('Type', modeSeg.el), h('div', { class: 'th-gap' }), seqBtn, allBtn), strip, grid);
  update();
}

// ---------------------------------------------------------------------------
export const GUITAR = {
  id: 'guitar',
  title: 'Guitar',
  icon: 'guitar',
  sub: 'The fretboard, first chords, scales, strumming and a tuner.',
  lead: 'Everything a beginner needs to make sense of the neck.',
  lessons: [
    {
      id: 'fretboard', title: 'The fretboard', sub: 'Every note on the neck, and how to find it.',
      lead: 'Each fret raises a string by one semitone. Learn a few landmarks and every note follows.',
      body: [
        'Standard tuning, from the thickest string: **E A D G B E**. The 12th fret is the open string\'s note an octave up, so the pattern repeats from there.',
        'Fret 5 on any string gives the note of the next open string, except on the G string, where it is fret 4. That is also how you tune by ear.',
        'Learn the natural notes on the two lowest strings first. They hold the root of most chord shapes.',
      ],
      demo: fretboardDemo,
      links: [
        { t: 'Open notes on the guitar', by: 'JustinGuitar · YouTube', url: 'https://www.youtube.com/watch?v=Abrd0c92xRE' },
        { t: 'Learn the fretboard', by: 'GuitarZero2Hero · YouTube', url: 'https://www.youtube.com/watch?v=jTCyiq5mjn8' },
        { t: 'Fretboard note trainer', by: 'musictheory.net', url: 'https://www.musictheory.net/exercises/fretboard' },
      ],
    },
    {
      id: 'chords', title: 'Open chords', sub: 'Nine beginner shapes, plus your first barre chords.',
      lead: 'A handful of open chords covers thousands of songs.',
      body: [
        'Read a chord box as if the guitar stands upright, facing you: vertical lines are strings, low E on the left; horizontal lines are frets. **x** means skip that string, **o** means play it open.',
        'Press just behind the fret with your fingertips, and strum only the strings in the chord.',
        'A **barre** chord lays one finger flat across the strings, so the whole shape can move. The F barre shape two frets higher is G; at the 5th fret it is A.',
      ],
      demo: openChordsDemo,
      links: [
        { t: 'How to read guitar chord charts', by: 'JustinGuitar · YouTube', url: 'https://www.youtube.com/watch?v=LlN2yrFQKzY' },
        { t: 'Your first chord: D', by: 'JustinGuitar · YouTube', url: 'https://www.youtube.com/watch?v=yh6sPqDEZCY' },
        { t: 'The easiest F chord lesson', by: 'JustinGuitar · YouTube', url: 'https://www.youtube.com/watch?v=4cR1sa1_d_8' },
        { t: 'Easy barre chords for beginners', by: 'JustinGuitar · YouTube', url: 'https://www.youtube.com/watch?v=ZYbxYoG6Mo0' },
      ],
    },
    {
      id: 'scales', title: 'Scales on guitar', sub: 'The five minor pentatonic boxes and the major scale.',
      lead: 'On guitar, scales are shapes. Learn a shape once, then move it to any key.',
      body: [
        'The **minor pentatonic** (1 ♭3 4 5 ♭7) is the scale behind most rock, blues and pop solos. Its notes fall into five boxes that link up the neck, each sharing an edge with the next.',
        '**Box 1** starts on the root on the low E string. In A, that is the 5th fret.',
        'The **major scale** adds two notes. Learn one position with the root on the low E string, then one with the root on the A string.',
        'Shapes move: play a box two frets higher and you are in a key two semitones higher.',
      ],
      demo: guitarScalesDemo,
      links: [
        { t: 'Minor pentatonic scale, beginner course', by: 'JustinGuitar · YouTube', url: 'https://www.youtube.com/watch?v=G-X1RemAzks' },
        { t: 'Minor pentatonic: the five positions', by: 'JustinGuitar · YouTube', url: 'https://www.youtube.com/watch?v=ZHBomQaAvQo' },
        { t: 'Pattern 1 of the major scale', by: 'JustinGuitar · YouTube', url: 'https://www.youtube.com/watch?v=T84Wiid_ZfE' },
      ],
    },
    {
      id: 'strumming', title: 'Strumming patterns', sub: 'Keep the hand moving; choose which strokes hit.',
      lead: 'Good strumming is a steady down-up motion. A pattern is just which strokes touch the strings.',
      body: [
        'Move your hand down on every beat and up between beats, all the time, like a pendulum. To leave a gap, keep moving and miss the strings.',
        'Count out loud: 1 & 2 & 3 & 4 &. Downs land on the numbers, ups on the &s.',
        'Start slowly, around 60 to 70 BPM, and speed up only when the pattern feels automatic.',
      ],
      demo: strummingDemo,
      links: [
        { t: 'The most common strumming pattern of all time', by: 'JustinGuitar · YouTube', url: 'https://www.youtube.com/watch?v=6LmQCdt_ZhQ' },
        { t: 'Learn any strumming pattern with this exercise', by: 'JustinGuitar · YouTube', url: 'https://www.youtube.com/watch?v=CjM5fyXoV8w' },
        { t: '11 tips to help you strum better', by: 'JustinGuitar · YouTube', url: 'https://www.youtube.com/watch?v=kmzS-7KiNlw' },
      ],
    },
    {
      id: 'tuner', title: 'Tuner', sub: 'Tune all six strings with your microphone.',
      lead: 'Play one string at a time and bring the needle to the centre.',
      body: [
        'Standard tuning, low to high: **E A D G B E**. Pluck a string firmly and let it ring; the reading settles after a moment.',
        'Needle to the left means **flat**: tighten the string to raise it. To the right means **sharp**: loosen it.',
        'Tune up to the note. If you overshoot, go below it and come back up; the string holds its pitch better.',
      ],
      demo: tunerDemo,
      links: [
        { t: 'How to tune your guitar', by: 'JustinGuitar · YouTube', url: 'https://www.youtube.com/watch?v=X2EmpWr9vUc' },
        { t: 'Tune by ear, using harmonics', by: 'JustinGuitar · YouTube', url: 'https://www.youtube.com/watch?v=ihlDFZjNM6g' },
        { t: 'How to tune your guitar for beginners', by: 'Marty Music · YouTube', url: 'https://www.youtube.com/watch?v=5jTsSvkBv60' },
      ],
    },
    {
      id: 'harmony', title: 'Chords from scales', sub: 'Why songs in G use G, C, D and Em.',
      lead: 'Build a chord on every note of a scale, using only that scale\'s notes, and you get the chords of the key.',
      body: [
        'In a major key the pattern never changes: major chords on **I**, **IV** and **V**, minor chords on **ii**, **iii** and **vi**, and a diminished chord on **vii°**.',
        'In G major that gives G, Am, Bm, C, D, Em and F♯dim. That is why so many songs in G use G, C, D and Em.',
        'Use it to guess chords by ear, to write your own songs and to transpose: the numbers stay the same, only the names change.',
      ],
      demo: harmonyDemo,
      links: [
        { t: 'Understanding chords in a key', by: 'JustinGuitar · YouTube', url: 'https://www.youtube.com/watch?v=q_0X6b_MFGw' },
        { t: 'Diatonic triads', by: 'musictheory.net', url: 'https://www.musictheory.net/lessons/43' },
        { t: 'Roman numeral analysis: triads', by: 'musictheory.net', url: 'https://www.musictheory.net/lessons/44' },
        { t: 'Diatonic triads, by ear', by: 'Ableton Learning Music', url: 'https://learningmusic.ableton.com/advanced-topics/diatonic-triads.html' },
      ],
    },
  ],
};
