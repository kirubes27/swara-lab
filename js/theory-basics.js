// Basics: notes, intervals, scales, chords, keys, rhythm, progressions, and theory for singers.
import { h, ensureMic } from './ui.js';
import { mic } from './audio.js';
import { settings } from './store.js';
import * as A from './theory-audio.js';
import {
  mod12, isBlack, octaveOf, hzOf, above, nameOf, pcNote, SHARP_NAMES, FLAT_NAMES, BOTH_NAMES,
  SCALES, scaleNotes, tonicName, CHORDS, chordTones, chordName, identifyChord, inversionName, INTERVALS,
  FIFTHS, keySignature, signatureText, PROGRESSIONS, progressionChords, voiceChord,
} from './theory-core.js';
import { Piano, seg, picker, field, controls, readout, playButton, Tempo, wheel, ic, noteLabel } from './theory-ui.js';

const range = (a, b) => Array.from({ length: b - a + 1 }, (_, i) => a + i);
const soon = () => A.now() + 0.03;
const INTERVAL_STEPS = [0, 1, 1, 2, 2, 3, 3, 4, 5, 5, 6, 6, 7]; // letter steps per semitone count
const STACK_NAMES = { 2: 'major 2nd', 3: 'minor 3rd', 4: 'major 3rd', 5: 'perfect 4th' };

// ---------------------------------------------------------------------------
function notesDemo(host) {
  const tag = {};
  const out = readout('Tap a key', 'Its name, octave and frequency appear here.');
  const show = (m) => {
    const pc = mod12(m), o = octaveOf(m);
    out.set(isBlack(pc) ? `${SHARP_NAMES[pc]}${o} or ${FLAT_NAMES[pc]}${o}` : SHARP_NAMES[pc] + o,
      `${hzOf(m).toFixed(1)} Hz` + (m === 60 ? ' · middle C' : '') + (isBlack(pc) ? ' · one key, two names' : ''));
  };
  let warmed = false;
  const piano = new Piano({
    lo: 48, hi: 72, label: 'Piano, C3 to C5',
    onKey: (m) => {
      A.key(m, soon(), { tag });
      show(m);
      if (!warmed) { warmed = true; A.prewarm(range(48, 72)); }
    },
  });
  const sequence = (ms, gap) => {
    A.silence(tag);
    const t0 = soon() + 0.05;
    ms.forEach((m, i) => {
      const t = t0 + i * gap;
      A.key(m, t, { tag, dur: gap * 1.5 });
      A.at(t, () => { piano.flash(m, gap * 800); show(m); }, tag);
    });
  };
  host.append(
    controls(
      field('Black keys', seg([['sharp', 'Sharps'], ['flat', 'Flats']], 'sharp', (v) => { piano.flats = v === 'flat'; piano.relabel(); }, 'Name black keys as').el),
      h('div', { class: 'th-gap' }),
      h('button', { type: 'button', class: 'btn', onclick: () => sequence(range(60, 72), 0.3) }, ic('play', 14), 'All twelve'),
      h('button', { type: 'button', class: 'btn', onclick: () => sequence([48, 60, 72], 0.9) }, ic('play', 14), 'Octaves of C')),
    piano.el, out.el);
}

// ---------------------------------------------------------------------------
function intervalsDemo(host) {
  const tag = {};
  let iv = INTERVALS[6], mode = 'up', root = 60;
  const piano = new Piano({ lo: 60, hi: 84, label: 'Piano, C4 to C6', onKey: (m) => A.key(m, soon(), { tag }) });
  const title = h('div', { class: 'th-big' });
  const facts = h('div', { class: 'th-sub' });
  const song = h('div', { class: 'th-song' });
  const buttons = new Map();
  const grid = h('div', { class: 'th-ivgrid', role: 'group', 'aria-label': 'Intervals' }, ...INTERVALS.map((x) => {
    const b = h('button', { type: 'button', class: 'th-iv', 'aria-pressed': 'false', onclick: () => { iv = x; update(); play(); } },
      h('strong', {}, x.short), h('small', {}, x.name));
    buttons.set(x, b);
    return b;
  }));
  const update = () => {
    const top = root + iv.n;
    const rootNote = pcNote(root);
    const topNote = above(rootNote, iv.n, INTERVAL_STEPS[iv.n]);
    for (const [x, b] of buttons) { b.classList.toggle('on', x === iv); b.setAttribute('aria-pressed', String(x === iv)); }
    title.textContent = iv.name;
    facts.textContent = `${iv.n} semitone${iv.n > 1 ? 's' : ''} · ${nameOf(rootNote)} to ${nameOf(topNote)} · in sargam, ${iv.sargam}`;
    song.replaceChildren(h('span', { class: 'th-song-k' }, 'Sounds like'), ' ', iv.song);
    piano.clear('is-root', 'is-hl');
    piano.mark(root, 'is-root'); piano.mark(top, 'is-hl');
  };
  const play = () => {
    A.silence(tag);
    const t = soon() + 0.02, top = root + iv.n;
    const seq = mode === 'up' ? [[root, 0], [top, 0.65]] : mode === 'down' ? [[top, 0], [root, 0.65]] : [[root, 0], [top, 0]];
    for (const [m, d] of seq) { A.key(m, t + d, { tag, dur: mode === 'both' ? 1.6 : 0.9 }); A.at(t + d, () => piano.flash(m, 500), tag); }
  };
  const modeSeg = seg([['up', 'Up'], ['down', 'Down'], ['both', 'Together']], mode, (v) => { mode = v; play(); }, 'Play the interval');
  const rootSel = picker(range(60, 71).map((m) => [m, BOTH_NAMES[mod12(m)]]), root, (v) => { root = v; update(); play(); }, 'Starting note');
  host.append(grid,
    controls(field('Play', modeSeg.el), field('From', rootSel.el), h('div', { class: 'th-gap' }),
      h('button', { type: 'button', class: 'btn primary', onclick: play }, ic('play', 14), 'Play again')),
    piano.el,
    h('div', { class: 'th-readout' }, title, facts, song));
  update();
}

// ---------------------------------------------------------------------------
function scalesDemo(host, scope) {
  const tag = {};
  let key = 'major', tonic = 0, show = 'names';
  const piano = new Piano({ lo: 60, hi: 83, label: 'Piano, C4 to B5', onKey: (m) => A.key(m, soon(), { tag }) });
  const strip = h('div', { class: 'th-strip' });
  const info = h('p', { class: 'th-note' });
  const scaleSel = picker(Object.entries(SCALES).map(([k, s]) => [k, s.name]), key, (v) => { key = v; keySel.relabel((pc) => tonicName(key, pc)); update(); }, 'Scale');
  const keySel = picker(range(0, 11).map((pc) => [pc, tonicName(key, pc)]), tonic, (v) => { tonic = v; update(); }, 'Key');
  const labelSeg = seg([['names', 'Notes'], ['degrees', 'Degrees']], show, (v) => { show = v; update(); }, 'Label the keys with');
  const btn = playButton('Play');
  let notes = [];
  const update = () => {
    A.silence(tag); btn.set(false);
    const sc = scaleNotes(key, tonic);
    const t = 60 + tonic;
    notes = [...sc.map((n) => ({ ...n, m: t + n.semis })), { ...sc[0], m: t + 12, deg: '8' }];
    const label = new Map(notes.map((n) => [n.m, show === 'names' ? n.name : n.deg]));
    piano.setLabels((m) => label.get(m) || '');
    piano.clear('is-root', 'is-hl');
    for (const n of notes) piano.mark(n.m, n.semis === 0 ? 'is-root' : 'is-hl');
    strip.replaceChildren();
    notes.forEach((n, i) => {
      if (i) {
        const gap = n.m - notes[i - 1].m;
        strip.append(h('span', { class: 'th-step' + (gap === 1 ? ' is-s' : '') }, gap === 1 ? 'S' : gap === 2 ? 'T' : '1½'));
      }
      strip.append(h('span', { class: 'th-chip' + (n.semis === 0 ? ' is-root' : '') }, h('strong', {}, n.name), h('small', {}, n.deg)));
    });
    const s = SCALES[key];
    const parts = [s.mood];
    if (s.mode) parts.push(`The major scale played from its ${['', '', '2nd', '3rd', '4th', '5th', '6th', '7th'][s.mode]} note.`);
    if (s.indian) parts.push(`Same notes as ${s.indian[0]} (${s.indian[1]}).`);
    info.textContent = parts.join(' ');
  };
  btn.el.addEventListener('click', () => {
    if (btn.on) { A.silence(tag); btn.set(false); return; }
    btn.set(true);
    const run = [...notes, ...notes.slice(0, -1).reverse()];
    const t0 = soon() + 0.04, gap = 0.32;
    const chips = [...strip.querySelectorAll('.th-chip')];
    run.forEach((n, i) => {
      const t = t0 + i * gap, idx = notes.indexOf(n);
      A.key(n.m, t, { tag, dur: gap * 1.4 });
      A.at(t, () => {
        piano.flash(n.m, gap * 900);
        chips.forEach((c, k) => c.classList.toggle('is-on', k === idx));
      }, tag);
    });
    A.at(t0 + run.length * gap + 0.2, () => { btn.set(false); chips.forEach((c) => c.classList.remove('is-on')); }, tag);
  });
  scope.add(() => A.silence(tag));
  host.append(controls(field('Scale', scaleSel.el), field('Key', keySel.el), field('Show', labelSeg.el), h('div', { class: 'th-gap' }), btn.el),
    piano.el, strip, info);
  update();
}

// ---------------------------------------------------------------------------
function chordsDemo(host) {
  const tag = {};
  let rootPc = 0, q = 'maj', inv = 0;
  let notes = new Set();
  const piano = new Piano({ lo: 60, hi: 84, label: 'Piano, C4 to C6. Tap keys to add or remove notes.', onKey: (m) => toggle(m) });
  const name = h('div', { class: 'th-big' });
  const detail = h('div', { class: 'th-sub' });
  const how = h('div', { class: 'th-note' });
  const rootSel = picker(range(0, 11).map((pc) => [pc, BOTH_NAMES[pc]]), rootPc, (v) => { rootPc = v; fromControls(); }, 'Root');
  const qSel = picker(Object.entries(CHORDS).filter(([k]) => k !== 'm7b5').map(([k, c]) => [k, c.name]), q, (v) => { q = v; if (CHORDS[q].semis.length < 4 && inv > 2) { inv = 0; invSeg.set(0); } fromControls(); }, 'Chord type');
  const invSeg = seg([[0, 'Root'], [1, '1st'], [2, '2nd'], [3, '3rd']], inv, (v) => { inv = v; fromControls(); }, 'Inversion');
  const fromControls = (play = true) => {
    let v = CHORDS[q].semis.map((s) => 60 + rootPc + s);
    const k = Math.min(inv, v.length - 1);
    v = [...v.slice(k), ...v.slice(0, k).map((m) => m + 12)];
    while (Math.max(...v) > 84) v = v.map((m) => m - 12);
    while (Math.min(...v) < 60) v = v.map((m) => m + 12);
    notes = new Set(v);
    render();
    if (play) playBlock();
  };
  const toggle = (m) => {
    if (notes.has(m)) notes.delete(m);
    else { notes.add(m); A.key(m, soon(), { tag, vel: 0.7 }); }
    render();
  };
  const render = () => {
    invSeg.enable(3, CHORDS[q].semis.length > 3);
    const ms = [...notes].sort((a, b) => a - b);
    piano.clear('is-hl', 'is-root');
    ms.forEach((m) => piano.mark(m, 'is-hl'));
    const id = identifyChord(ms);
    if (id) {
      ms.filter((m) => mod12(m) === id.root).forEach((m) => piano.mark(m, 'is-root'));
      const tones = chordTones(id.root, id.q);
      const c = CHORDS[id.q];
      name.textContent = chordName(id.root, id.q) + (id.inv ? ' / ' + tones[id.inv].name : '');
      detail.textContent = `${tones.map((t) => t.name).join(' ')} · ${tones.map((t) => t.deg).join(' ')}`;
      const gaps = c.semis.slice(1).map((s, i) => STACK_NAMES[s - c.semis[i]]);
      how.textContent = `${c.name}, ${inversionName(id.inv)}. Built from a ${gaps.join(', then a ')}, counting up from the root.`;
    } else if (ms.length === 2) {
      const iv = INTERVALS.find((x) => x.n === ms[1] - ms[0]);
      name.textContent = iv ? iv.name : 'Two notes';
      detail.textContent = 'Add a third note to make a chord.';
      how.textContent = '';
    } else {
      name.textContent = ms.length ? 'No common name' : 'Tap keys to build a chord';
      detail.textContent = ms.length ? 'Try moving one note by a semitone, or pick a chord above.' : 'Or pick a root and a type above.';
      how.textContent = '';
    }
  };
  const playBlock = () => { A.silence(tag); const t = soon(); [...notes].sort((a, b) => a - b).forEach((m) => { A.key(m, t, { tag, vel: 0.62, dur: 1.6 }); piano.flash(m, 500); }); };
  const playArp = () => {
    A.silence(tag);
    const t0 = soon();
    [...notes].sort((a, b) => a - b).forEach((m, i) => { const t = t0 + i * 0.22; A.key(m, t, { tag, vel: 0.65, dur: 1.4 }); A.at(t, () => piano.flash(m, 400), tag); });
  };
  host.append(
    controls(field('Root', rootSel.el), field('Type', qSel.el), field('Inversion', invSeg.el), h('div', { class: 'th-gap' }),
      h('button', { type: 'button', class: 'btn primary', onclick: playBlock }, ic('play', 14), 'Play'),
      h('button', { type: 'button', class: 'btn', onclick: playArp }, 'Arpeggio')),
    piano.el, h('div', { class: 'th-readout', 'aria-live': 'polite' }, name, detail), how);
  fromControls(false);
}

// ---------------------------------------------------------------------------
function keysDemo(host) {
  const tag = {};
  const majName = (pc) => tonicName('major', pc), minName = (pc) => tonicName('minor', pc);
  const outer = FIFTHS.map((pc) => ({ main: majName(pc), aria: `${majName(pc)} major` }));
  const inner = FIFTHS.map((pc) => ({ main: minName(mod12(pc + 9)) + 'm', aria: `${minName(mod12(pc + 9))} minor` }));
  let sel = { ring: 0, k: 0 };
  const w = wheel({ outer, inner, label: 'Circle of fifths. Choose a key to hear its main chords.', onPick: (ring, k) => { sel = { ring, k }; w.focusOn(ring, k); update(); cadence(); } });
  const head = h('h3', { class: 'th-keyname' });
  const sig = h('p', { class: 'th-sub' });
  const rel = h('p', { class: 'th-sub' });
  const chips = h('div', { class: 'th-chords' });
  const chordsOf = () => {
    const minor = sel.ring === 1;
    const at = (ring, d) => {
      const k = (sel.k + d + 12) % 12, pc = FIFTHS[k];
      return ring === 0 ? { pc, q: 'maj', name: majName(pc) } : { pc: mod12(pc + 9), q: 'min', name: minName(mod12(pc + 9)) + 'm' };
    };
    return minor
      ? [['i', at(1, 0)], ['iv', at(1, -1)], ['v', at(1, 1)], ['III', at(0, 0)], ['VI', at(0, -1)], ['VII', at(0, 1)]]
      : [['I', at(0, 0)], ['IV', at(0, -1)], ['V', at(0, 1)], ['ii', at(1, -1)], ['iii', at(1, 1)], ['vi', at(1, 0)]];
  };
  const playChord = (c, t, dur, prev) => {
    const v = voiceChord(c.pc, c.q, prev);
    v.forEach((m) => A.key(m, t, { tag, vel: 0.6, dur }));
    A.key(40 + mod12(c.pc - 4), t, { tag, vel: 0.55, dur });
    return v;
  };
  const playBtn = h('button', { type: 'button', class: 'btn primary', onclick: () => cadence() });
  const cadence = () => {
    A.silence(tag);
    const list = chordsOf();
    const seq = [list[0], list[1], list[2], list[0]];
    let prev = null;
    const t0 = soon() + 0.03;
    seq.forEach(([rn, c], i) => {
      const t = t0 + i * 0.7;
      prev = playChord(c, t, i === 3 ? 1.6 : 0.68, prev);
      A.at(t, () => [...chips.children].forEach((b) => b.classList.toggle('is-on', b.dataset.rn === rn)), tag);
    });
    A.at(t0 + 4 * 0.7 + 0.6, () => [...chips.children].forEach((b) => b.classList.remove('is-on')), tag);
  };
  const update = () => {
    const minor = sel.ring === 1;
    const majPc = FIFTHS[sel.k], pc = minor ? mod12(majPc + 9) : majPc;
    const name = minor ? minName(pc) + ' minor' : majName(pc) + ' major';
    const s = keySignature(pc, minor);
    w.center(minor ? minName(pc) + 'm' : majName(pc), minor ? 'minor' : 'major');
    w.state((ring, k) => {
      const d = (k - sel.k + 12) % 12;
      if (ring === sel.ring && k === sel.k) return 'is-sel';
      if (d === 0 || d === 1 || d === 11) return 'is-key';
      return '';
    });
    head.textContent = name;
    sig.textContent = signatureText(s) + (pc === 6 && !minor ? ' (or G♭ major, 6 flats)' : '');
    rel.textContent = minor ? `Relative major: ${majName(majPc)} major. Same notes, different home.` : `Relative minor: ${minName(mod12(pc + 9))} minor. Same notes, different home.`;
    chips.replaceChildren(...chordsOf().map(([rn, c]) => h('button', { type: 'button', class: 'th-chordchip', 'data-rn': rn, onclick: () => { A.silence(tag); playChord(c, soon(), 1.4); } },
      h('small', {}, rn), h('strong', {}, c.name))));
    playBtn.replaceChildren(ic('play', 14), minor ? 'Play i–iv–v–i' : 'Play I–IV–V–I');
  };
  host.append(h('div', { class: 'th-cof' }, h('div', { class: 'th-cof-wheel' }, w.el),
    h('div', { class: 'th-cof-info' }, head, sig, rel,
      h('p', { class: 'th-flabel' }, 'Its six main chords sit side by side on the circle'), chips, playBtn)));
  update();
}

// ---------------------------------------------------------------------------
const METERS = { '2/4': { beats: 2 }, '3/4': { beats: 3 }, '4/4': { beats: 4 }, '6/8': { beats: 2, sub: 3 } };
const COUNTS = { 1: [''], 2: ['', '&'], 3: ['', 'trip', 'let'], 4: ['', 'e', '&', 'a'] };

function rhythmDemo(host, scope) {
  const tag = {};
  let meter = '4/4', sub = 1;
  const per = () => METERS[meter].sub || sub;
  const pulses = h('div', { class: 'th-pulses', 'aria-hidden': 'true' });
  const btn = playButton('Start');
  const clock = new A.Clock({
    bpm: 90, div: 1,
    onStep: (step, t) => {
      const p = per(), n = METERS[meter].beats * p, i = step % n;
      A.click(t, i === 0 ? 2 : i % p === 0 ? 1 : 0, { tag });
      A.at(t, () => [...pulses.children].forEach((el, k) => el.classList.toggle('is-on', k === i)), tag);
    },
  });
  const tempo = new Tempo({ bpm: 90, min: 40, max: 220, onChange: (b) => { clock.bpm = b; } });
  const draw = () => {
    const p = per(), beats = METERS[meter].beats;
    pulses.replaceChildren(...range(0, beats * p - 1).map((i) => {
      const beat = Math.floor(i / p), k = i % p;
      const label = meter === '6/8' ? String(i + 1) : k === 0 ? String(beat + 1) : COUNTS[p][k];
      return h('span', { class: 'th-pulse' + (k === 0 ? ' is-beat' : '') + (i === 0 ? ' is-one' : '') }, label);
    }));
  };
  const restart = () => { draw(); if (clock.running) { A.silence(tag); clock.div = per(); clock.start(); } };
  const meterSeg = seg(Object.keys(METERS).map((m) => [m, m]), meter, (v) => { meter = v; subSeg.el.classList.toggle('is-off', v === '6/8'); for (const s of [1, 2, 3, 4]) subSeg.enable(s, v !== '6/8'); restart(); }, 'Time signature');
  const subSeg = seg([[1, 'Beats'], [2, '8ths'], [3, 'Triplets'], [4, '16ths']], sub, (v) => { sub = v; restart(); }, 'Subdivision');
  btn.el.addEventListener('click', () => {
    if (clock.running) { clock.stop(); A.silence(tag); btn.set(false); [...pulses.children].forEach((el) => el.classList.remove('is-on')); return; }
    clock.div = per(); clock.start(); btn.set(true);
  });
  scope.add(() => clock.stop());
  host.append(controls(tempo.el), controls(field('Time', meterSeg.el), field('Split each beat', subSeg.el), h('div', { class: 'th-gap' }), btn.el), pulses);
  draw();
}

// ---------------------------------------------------------------------------
function progressionsDemo(host, scope) {
  const tag = {};
  let prog = PROGRESSIONS[0], tonic = prog.key, drums = true, chords = [], voicings = [];
  const chipsEl = h('div', { class: 'th-bars' });
  const note = h('p', { class: 'th-note' });
  const btn = playButton('Play');
  const keyName = (pc) => tonicName(prog.minor ? 'minor' : 'major', pc) + (prog.minor ? ' minor' : ' major');
  const keySel = picker(range(0, 11).map((pc) => [pc, keyName(pc)]), tonic, (v) => { tonic = v; build(); }, 'Key');
  const clock = new A.Clock({
    bpm: prog.bpm, div: 2,
    onStep: (step, t, dt) => {
      const bar = Math.floor(step / 8) % chords.length, pos = step % 8;
      const c = chords[bar], v = voicings[bar];
      if (pos === 0 || pos === 4) {
        v.forEach((m) => A.key(m, t, { tag, vel: pos ? 0.42 : 0.58, dur: dt * 3.6 }));
        A.key(40 + mod12(c.rootPc - 4), t, { tag, vel: 0.6, dur: dt * 3.8 });
      }
      if (pos === 0) A.at(t, () => [...chipsEl.children].forEach((el, k) => el.classList.toggle('is-on', k === bar)), tag);
      if (drums) {
        if (pos === 0 || pos === 4 || pos === 5) A.kick(t, { tag, vel: pos === 5 ? 0.45 : 0.7 });
        if (pos === 2 || pos === 6) A.snare(t, { tag, vel: 0.5 });
        A.hat(t, { tag, vel: pos % 2 ? 0.35 : 0.6 });
      }
    },
  });
  const tempo = new Tempo({ bpm: prog.bpm, min: 50, max: 180, onChange: (b) => { clock.bpm = b; } });
  const build = () => {
    chords = progressionChords(prog, tonic);
    let prev = null;
    voicings = chords.map((c) => (prev = voiceChord(c.rootPc, c.q, prev)));
    note.textContent = prog.note;
    chipsEl.classList.toggle('is-12', chords.length === 12);
    chipsEl.replaceChildren(...chords.map((c, i) => h('button', {
      type: 'button', class: 'th-chordchip', 'aria-label': `Bar ${i + 1}: ${c.name}`,
      onclick: () => { if (!clock.running) { A.silence(tag); voicings[i].forEach((m) => A.key(m, soon(), { tag, vel: 0.6, dur: 1.4 })); } },
    }, h('small', {}, c.roman), h('strong', {}, c.name))));
  };
  const progSeg = seg(PROGRESSIONS.map((p) => [p.id, p.title, p.name]), prog.id, (id) => {
    prog = PROGRESSIONS.find((p) => p.id === id);
    tonic = prog.key;
    keySel.relabel((pc) => keyName(pc));
    keySel.set(tonic);
    tempo.set(prog.bpm);
    build();
  }, 'Progression');
  const drumChk = h('input', { type: 'checkbox', checked: true, 'aria-label': 'Drums', onchange: (e) => { drums = e.target.checked; } });
  btn.el.addEventListener('click', () => {
    if (clock.running) { clock.stop(); A.silence(tag); btn.set(false); [...chipsEl.children].forEach((el) => el.classList.remove('is-on')); return; }
    clock.start(); btn.set(true);
  });
  scope.add(() => clock.stop());
  host.append(controls(field('Progression', progSeg.el)),
    controls(field('Key', keySel.el), tempo.el, h('label', { class: 'ctl' }, drumChk, 'Drums'), h('div', { class: 'th-gap' }), btn.el),
    chipsEl, note);
  build();
}

// ---------------------------------------------------------------------------
// Theory for singers: a ladder of scale degrees in your key, with a drone and live pitch.
const DEGREES = [
  { semis: 0, deg: '1', sargam: 'Sa', solfa: 'Do' }, { semis: 2, deg: '2', sargam: 'Re', solfa: 'Re' },
  { semis: 4, deg: '3', sargam: 'Ga', solfa: 'Mi' }, { semis: 5, deg: '4', sargam: 'Ma', solfa: 'Fa' },
  { semis: 7, deg: '5', sargam: 'Pa', solfa: 'Sol' }, { semis: 9, deg: '6', sargam: 'Dha', solfa: 'La' },
  { semis: 11, deg: '7', sargam: 'Ni', solfa: 'Ti' }, { semis: 12, deg: '8', sargam: 'Sa', solfa: 'Do' },
];
const PATTERNS = [['1 3 5 8 5 3 1', [0, 2, 4, 7, 4, 2, 0]], ['1 2 3 4 5 4 3 2 1', [0, 1, 2, 3, 4, 3, 2, 1, 0]], ['1 5 8 5 1', [0, 4, 7, 4, 0]]];

function singingDemo(host, scope) {
  const tag = {};
  let tonic = Math.min(67, Math.max(43, settings.saMidi || 48)), drone = null, off = null, shown = NaN;
  const ladder = h('div', { class: 'th-ladder', role: 'group', 'aria-label': 'Scale degrees in your key' });
  const marker = h('div', { class: 'th-voice', 'aria-hidden': 'true' });
  const IDLE = ['Hear it, then sing it', 'Press Sing and your voice appears on the ladder.'];
  const live = readout(...IDLE);
  const rows = DEGREES.map((d) => {
    const b = h('button', { type: 'button', class: 'th-rung', style: `bottom:${(d.semis / 12) * 100}%`, onclick: () => playDeg(d) },
      h('strong', {}, d.deg), h('span', {}, d.sargam), h('span', { class: 'th-solfa' }, d.solfa), h('small', {}));
    ladder.append(b);
    return b;
  });
  for (const s of [1, 3, 6, 8, 10]) ladder.append(h('i', { class: 'th-tick', style: `bottom:${(s / 12) * 100}%` }));
  ladder.append(marker);
  const relabel = () => DEGREES.forEach((d, i) => { rows[i].lastChild.textContent = noteLabel(tonic + d.semis); rows[i].setAttribute('aria-label', `${d.deg}, ${d.sargam}, ${d.solfa}: ${noteLabel(tonic + d.semis)}`); });
  const flashRow = (i, ms = 450) => { rows[i].classList.add('is-on'); setTimeout(() => rows[i].classList.remove('is-on'), ms); };
  function playDeg(d) { A.key(tonic + d.semis, soon(), { tag, dur: 1.2 }); flashRow(DEGREES.indexOf(d)); }
  const playPattern = (idx) => {
    A.silence(tag, 0.02);
    const t0 = soon() + 0.05;
    idx.forEach((k, i) => { const t = t0 + i * 0.55; A.key(tonic + DEGREES[k].semis, t, { tag, dur: 0.6 }); A.at(t, () => flashRow(k, 480), tag); });
  };
  const keySel = picker(range(43, 67).map((m) => [m, noteLabel(m)]), tonic, (v) => { tonic = v; relabel(); if (drone) { drone.stop(); drone = A.drone(tonic); } }, 'Key note (Sa)');
  const droneBtn = h('button', { type: 'button', class: 'btn', 'aria-pressed': 'false' }, ic('drone', 16), 'Drone');
  droneBtn.addEventListener('click', () => {
    if (drone) { drone.stop(); drone = null; } else drone = A.drone(tonic);
    droneBtn.classList.toggle('on', !!drone); droneBtn.setAttribute('aria-pressed', String(!!drone));
  });
  const micBtn = h('button', { type: 'button', class: 'btn primary', 'aria-pressed': 'false' }, ic('mic', 16), 'Sing');
  const stopMic = () => {
    if (off) off();
    off = null; shown = NaN;
    marker.classList.remove('is-live');
    rows.forEach((r) => r.classList.remove('is-near'));
    micBtn.replaceChildren(ic('mic', 16), 'Sing'); micBtn.classList.add('primary'); micBtn.setAttribute('aria-pressed', 'false');
    live.set(...IDLE);
  };
  micBtn.addEventListener('click', async () => {
    if (off) { stopMic(); return; }
    if (!(await ensureMic()) || !scope.alive || off) return;
    micBtn.replaceChildren(ic('stop', 14), 'Stop'); micBtn.classList.remove('primary'); micBtn.setAttribute('aria-pressed', 'true');
    live.set('Sing any note', 'Your voice shows on the ladder.');
    let quiet = 0;
    off = mic.on((f) => {
      if (!(f.hz > 0)) { if (++quiet > 20) { marker.classList.remove('is-live'); rows.forEach((r) => r.classList.remove('is-near')); } return; }
      quiet = 0;
      const c = 1200 * Math.log2(f.hz / hzOf(tonic));
      const ref = isNaN(shown) ? 600 : shown;
      const folded = c - 1200 * Math.round((c - ref) / 1200);
      shown = isNaN(shown) || Math.abs(folded - shown) > 150 ? folded : shown + 0.35 * (folded - shown);
      const y = Math.min(1260, Math.max(-60, shown));
      marker.style.bottom = (y / 1200) * 100 + '%';
      marker.classList.add('is-live');
      let best = 0;
      DEGREES.forEach((d, i) => { if (Math.abs(shown - d.semis * 100) < Math.abs(shown - DEGREES[best].semis * 100)) best = i; });
      const dev = Math.round(shown - DEGREES[best].semis * 100);
      rows.forEach((r, i) => r.classList.toggle('is-near', i === best && Math.abs(dev) <= 50));
      const d = DEGREES[best];
      live.set(Math.abs(dev) <= 50 ? `${d.deg} · ${d.sargam} · ${d.solfa}` : 'Between steps', `${dev > 0 ? '+' : ''}${dev}¢ from ${d.deg} · ${noteLabel(Math.round(69 + 12 * Math.log2(f.hz / 440)))}`);
    });
  });
  scope.add(() => { stopMic(); if (drone) drone.stop(); drone = null; });
  host.append(
    controls(field('Your key', keySel.el), droneBtn, micBtn),
    h('div', { class: 'th-sing' },
      ladder,
      h('div', { class: 'th-sing-side' },
        live.el,
        h('p', { class: 'th-flabel' }, 'Hear a pattern, then sing it back'),
        h('div', { class: 'th-patterns' }, ...PATTERNS.map(([label, idx]) => h('button', { type: 'button', class: 'btn small', onclick: () => playPattern(idx) }, ic('play', 12), label))),
        h('p', { class: 'th-note' }, 'Gaps on the ladder are to scale: 3 to 4 and 7 to 8 are semitones, the rest are tones.'))));
  relabel();
}

// ---------------------------------------------------------------------------
export const BASICS = {
  id: 'basics',
  title: 'Basics',
  icon: 'keys',
  sub: 'Notes, intervals, scales, chords, keys and rhythm.',
  lead: 'The building blocks of every song, each with something to play.',
  lessons: [
    {
      id: 'notes', title: 'Notes and octaves', sub: 'Twelve notes, sharps and flats, and why they repeat.',
      lead: 'All of music is built from twelve notes. Here they are.',
      body: [
        'The white keys are named A to G. Each black key borrows a neighbour\'s name: a **sharp** (♯) is one key higher, a **flat** (♭) one key lower. So the black key between C and D is both C♯ and D♭.',
        'From any key to the very next one, black or white, is a **semitone**. Two semitones make a **tone**. E to F and B to C have no black key between them: they are already a semitone apart.',
        'After B the names start again at C, one **octave** higher. Going up an octave doubles the frequency, which is why the two notes sound like the same note. The number says which octave: C4 is middle C.',
      ],
      tip: 'When a man and a woman sing "the same" note, they are usually an octave apart.',
      demo: notesDemo,
      links: [
        { t: 'Steps and accidentals', by: 'musictheory.net', url: 'https://www.musictheory.net/lessons/20' },
        { t: 'Notes and scales', by: 'Ableton Learning Music', url: 'https://learningmusic.ableton.com/notes-and-scales/notes-and-scales.html' },
        { t: 'Why does music only use 12 different notes?', by: 'David Bennett Music Theory · YouTube', url: 'https://www.youtube.com/watch?v=lvmzgVtZtUQ' },
        { t: 'Keyboard note trainer', by: 'musictheory.net', url: 'https://www.musictheory.net/exercises/keyboard' },
      ],
    },
    {
      id: 'intervals', title: 'Intervals', sub: 'The distance between two notes, and how to hear it.',
      lead: 'An interval is the distance between two notes, counted in semitones.',
      body: [
        'Intervals give melodies and chords their character. Small ones are steps, larger ones are leaps. **Major** intervals sound bright, **minor** ones darker. The perfect 4th, 5th and octave sound open and stable; the **tritone**, six semitones, sounds tense.',
        'The quickest way to learn them is to tie each one to a song you already know. Pick an interval and hear it rising, falling and played together.',
      ],
      demo: intervalsDemo,
      links: [
        { t: 'Specific intervals', by: 'musictheory.net', url: 'https://www.musictheory.net/lessons/31' },
        { t: 'Songs that help you identify ascending intervals', by: 'David Bennett Music Theory · YouTube', url: 'https://www.youtube.com/watch?v=PhDIm_2qS5s' },
        { t: 'Musical intervals, explained clearly', by: 'Signals Music Studio · YouTube', url: 'https://www.youtube.com/watch?v=m9GlB8tanNE' },
        { t: 'Interval ear training', by: 'musictheory.net', url: 'https://www.musictheory.net/exercises/ear-interval' },
      ],
    },
    {
      id: 'scales', title: 'Scales and modes', sub: 'Major, minor, pentatonic, blues and the modes.',
      lead: 'A scale is the set of notes a melody draws from, arranged from the home note up.',
      body: [
        'The **major scale** follows a fixed pattern of tones (T) and semitones (S): T T S T T T S. Start on any note, follow the pattern, and you have that note\'s major scale. **Natural minor** uses T S T T S T T and sounds darker.',
        '**Pentatonic** scales keep five notes and drop the semitone steps, so nothing clashes. Most riffs and vocal runs live here. The **blues** scale adds one tense note to the minor pentatonic.',
        '**Modes** are the major scale started from another of its notes. Each keeps the same notes but feels different, because the home note moved.',
      ],
      demo: scalesDemo,
      links: [
        { t: 'The major scale', by: 'musictheory.net', url: 'https://www.musictheory.net/lessons/21' },
        { t: 'The minor scales', by: 'musictheory.net', url: 'https://www.musictheory.net/lessons/22' },
        { t: 'Modes', by: 'Ableton Learning Music', url: 'https://learningmusic.ableton.com/advanced-topics/modes.html' },
        { t: 'How I wish scales and modes were explained to me', by: 'Nahre Sol · YouTube', url: 'https://www.youtube.com/watch?v=qBeyDkoyiWA' },
      ],
    },
    {
      id: 'chords', title: 'Chords', sub: 'Triads, sevenths and inversions. Build your own.',
      lead: 'A chord is three or more notes played together, usually built by stacking every other note of a scale.',
      body: [
        'A **triad** has a root, a 3rd and a 5th. Major (1 3 5) sounds bright, minor (1 ♭3 5) sadder, diminished (1 ♭3 ♭5) tense and augmented (1 3 ♯5) unsettled. **Sus** chords swap the 3rd for a 2nd or a 4th and sound open, waiting to resolve.',
        'Add a 7th for more colour: **maj7** sounds dreamy, a plain **7** bluesy and restless, **m7** soft and soulful.',
        'An **inversion** puts a note other than the root at the bottom. It is the same chord with a different shape, and it lets one chord flow into the next with less movement.',
      ],
      demo: chordsDemo,
      links: [
        { t: 'Introduction to chords', by: 'musictheory.net', url: 'https://www.musictheory.net/lessons/40' },
        { t: 'Seventh chords', by: 'musictheory.net', url: 'https://www.musictheory.net/lessons/45' },
        { t: 'Inversions', by: 'Ableton Learning Music', url: 'https://learningmusic.ableton.com/advanced-topics/inversions.html' },
        { t: 'Triads: everything you need to know', by: 'Brad Harrison Music · YouTube', url: 'https://www.youtube.com/watch?v=-KzJFzb-HQg' },
      ],
    },
    {
      id: 'keys', title: 'Keys and the circle of fifths', sub: 'How the twelve keys relate. Tap one to hear it.',
      lead: 'A key is a home note plus the scale built on it. The circle of fifths shows how all twelve relate.',
      body: [
        'Clockwise, each key is a 5th higher than the last and adds one sharp. Anticlockwise, each adds a flat. Neighbouring keys share all but one note, so moving between them sounds smooth.',
        'The keys either side of a key are its **IV** and **V** chords. With the key itself, **I**, they are the three most-used chords in that key.',
        'Every major key has a **relative minor** with exactly the same notes: C major and A minor, for example. It sits on the inner ring.',
      ],
      demo: keysDemo,
      links: [
        { t: 'Keys and scales', by: 'Ableton Learning Music', url: 'https://learningmusic.ableton.com/notes-and-scales/keys-and-scales.html' },
        { t: 'Key signatures', by: 'musictheory.net', url: 'https://www.musictheory.net/lessons/24' },
        { t: 'Four levels of the circle of fifths', by: 'David Bennett Music Theory · YouTube', url: 'https://www.youtube.com/watch?v=K0_nf1YGXQI' },
        { t: 'Circle of fifths', by: 'Wikipedia', url: 'https://en.wikipedia.org/wiki/Circle_of_fifths' },
      ],
    },
    {
      id: 'rhythm', title: 'Rhythm and meter', sub: 'Beats, bars, time signatures and a metronome.',
      lead: 'Rhythm is when notes happen. Tempo is how fast the beat goes, in beats per minute (BPM).',
      body: [
        'Beats group into bars, and the **time signature** says how. **4/4** has four beats to a bar and covers most pop. **3/4** has three, like a waltz. **6/8** has two beats, each split into three, which gives a rolling, lilting feel.',
        'Split each beat into two, three or four and you get eighth notes, triplets and sixteenths. Counting them out loud (1 & 2 &) is how musicians stay steady.',
        'Indian music counts in **taals**: Dadra has 6 beats, Keherwa 8, Teentaal 16.',
      ],
      tip: 'Learn a hard run slowly with a click, then raise the tempo a few BPM at a time.',
      demo: rhythmDemo,
      links: [
        { t: 'Beat and tempo', by: 'Ableton Learning Music', url: 'https://learningmusic.ableton.com/make-beats/beat-and-tempo.html' },
        { t: 'Measures and time signature', by: 'musictheory.net', url: 'https://www.musictheory.net/lessons/12' },
        { t: 'What\'s the difference between 3/4 and 6/8?', by: 'David Bennett Music Theory · YouTube', url: 'https://www.youtube.com/watch?v=N4q2kBe82-o' },
        { t: 'How and why to use a metronome', by: 'JustinGuitar · YouTube', url: 'https://www.youtube.com/watch?v=sNa44EmrsDc' },
      ],
    },
    {
      id: 'progressions', title: 'Chord progressions', sub: 'The handful of sequences behind thousands of songs.',
      lead: 'A progression is a sequence of chords. A few of them carry a huge share of popular music.',
      body: [
        'Musicians name chords by their place in the key, in Roman numerals: **I** is built on the 1st note, **V** on the 5th. Upper case means major, lower case minor. Learn a progression once and you can play it in any key.',
        { list: [
          '**I–V–vi–IV**: the pop progression.',
          '**i–VI–III–VII**: the same four chords, started on the minor one.',
          '**I–vi–IV–V**: the 1950s doo-wop progression.',
          '**ii–V–I**: the backbone of jazz.',
          '**12-bar blues**: three chords over twelve bars.',
        ] },
      ],
      demo: progressionsDemo,
      links: [
        { t: '1-5-6-4', by: 'Ableton Learning Music', url: 'https://learningmusic.ableton.com/chords/1-5-6-4.html' },
        { t: 'TheoryTab: the chords of real songs', by: 'Hooktheory', url: 'https://www.hooktheory.com/theorytab' },
        { t: 'Seven super common chord progressions', by: 'David Bennett Music Theory · YouTube', url: 'https://www.youtube.com/watch?v=Vyc8lezaa9g' },
        { t: '4 Chords', by: 'The Axis of Awesome · YouTube', url: 'https://www.youtube.com/watch?v=oOlDewpCfZQ' },
      ],
    },
    {
      id: 'singing', title: 'Theory for singers', sub: 'Scale degrees, sargam, and singing intervals in tune.',
      lead: 'Theory helps you hear where a melody is going, instead of copying it note by note.',
      body: [
        'Think in **scale degrees**. 1 is home. 3 and 5 feel stable; 2, 4, 6 and 7 lean towards their neighbours. Most melodies are a walk between these.',
        'Sargam is the same idea with names: **Sa Re Ga Ma Pa Dha Ni** are 1 to 7. Sa can sit on any pitch, so you can sing any song in the key that suits your voice.',
        'Learn intervals as jumps between degrees: a 5th is 1 to 5 (Sa to Pa), an octave 1 to 8. For harmonies and long held notes, the notes of the chord underneath (its 1, 3 and 5) are the safest choices.',
      ],
      demo: singingDemo,
      practice: [
        { t: 'Interval jumps', by: 'Sing leaps from Sa and back, with feedback', url: '#practice/intervals' },
        { t: 'Pitch matching', by: 'Hear a note, sing it back', url: '#practice/pitchMatch' },
      ],
      links: [
        { t: 'Scale degrees', by: 'musictheory.net', url: 'https://www.musictheory.net/lessons/23' },
        { t: 'Sight singing, relative pitch and solfège', by: 'Brad Harrison Music · YouTube', url: 'https://www.youtube.com/watch?v=-S2D-BxSkBU' },
        { t: 'Note ear training', by: 'musictheory.net', url: 'https://www.musictheory.net/exercises/ear-note' },
      ],
    },
  ],
};
