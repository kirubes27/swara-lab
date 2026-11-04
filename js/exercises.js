// Exercise model: a mini sargam notation, plan builder, target-contour lookup and library.
import { swaraCents, THAATS, SWARA_SHORT, SWARA_LONG } from './music.js';

const LETTERS = { S: 0, r: 1, R: 2, g: 3, G: 4, m: 5, M: 6, P: 7, d: 8, D: 9, n: 10, N: 11 };

// ---------------------------------------------------------------------------
// Notation (documented in the UI):
//   S r R g G m M P d D n N   swaras (lowercase = komal, M = tivra Ma)
//   .N or N.                   lower octave (mandra);  S'  upper octave (taar)
//   -                          hold previous note one more beat     _ or ,  rest
//   S~G                        meend (glide) from S to G within the beat
//   (N)S                       kan swar: grace note N touched just before S
//   G*                         gamak: oscillate G with the next scale note
//   g^                         andolan: slow gentle swing below the note
//   [S R G m]                  several notes squeezed into one beat (fast phrases)
function parseNote(tok) {
  const m = tok.match(/^(\.*)([SrRgGmMPdDnN])((?:'|\.)*)$/);
  if (!m) return null;
  let oct = -m[1].length;
  for (const ch of m[3]) oct += ch === "'" ? 1 : -1;
  return { idx: LETTERS[m[2]], oct };
}

function tokenize(text) {
  const out = [];
  let i = 0;
  const s = text.replace(/\|/g, ' ');
  while (i < s.length) {
    if (/\s/.test(s[i])) { i++; continue; }
    if (s[i] === '[') {
      const j = s.indexOf(']', i);
      const inner = s.slice(i + 1, j < 0 ? s.length : j);
      out.push({ group: inner.trim().split(/\s+/).filter(Boolean) });
      i = j < 0 ? s.length : j + 1;
      // trailing dashes attached to a group
      while (s[i] === '-') { out.push('-'); i++; }
      continue;
    }
    let j = i;
    while (j < s.length && !/\s|\[/.test(s[j])) j++;
    out.push(s.slice(i, j));
    i = j;
  }
  return out;
}

function nextScaleNote(c, scale, tuning) {
  for (let o = 0; o <= 1; o++) for (const n of scale) {
    const v = swaraCents(n, Math.floor(c / 1200) + o, tuning);
    if (v > c + 40) return v;
  }
  return c + 200;
}

// Parse one item (no spaces) into events spanning [t, t+dur] (beats).
function itemEvents(item, t, dur, ctx) {
  const ev = [];
  let kan = null;
  let body = item;
  const km = body.match(/^\(([^)]+)\)(.+)$/);
  if (km) { kan = parseNote(km[1]); body = km[2]; }
  let mod = '';
  const mm = body.match(/([*^]+)$/);
  if (mm) { mod = mm[1]; body = body.slice(0, -mod.length); }
  const parts = body.split('~').map(parseNote);
  if (parts.some((p) => !p)) throw new Error(`Can't read "${item}"`);
  const cents = parts.map((p) => swaraCents(p.idx, p.oct, ctx.tuning));
  const labels = parts.map((p) => ({ idx: p.idx, oct: p.oct }));
  let cur = t;
  if (kan) {
    const kc = swaraCents(kan.idx, kan.oct, ctx.tuning);
    const kd = Math.min(0.09 * ctx.bpm / 60, dur * 0.25);
    ev.push({ kind: 'glide', t: cur, dur: kd, c0: kc, c1: cents[0], kan: true });
    cur += kd;
  }
  const rem = t + dur - cur;
  if (parts.length === 1) {
    const e = { kind: 'note', t: cur, dur: rem, c0: cents[0], note: labels[0] };
    if (mod.includes('*')) { e.osc = { c1: nextScaleNote(cents[0], ctx.scale, ctx.tuning), rate: 4.5 }; e.orn = 'gamak'; }
    if (mod.includes('^')) { e.osc = { c1: cents[0] - 45, rate: 1.4 }; e.orn = 'andolan'; }
    ev.push(e);
  } else {
    // meend: brief hold, smooth glide(s), land
    const n = parts.length - 1;
    const hold = rem * 0.15;
    ev.push({ kind: 'note', t: cur, dur: hold, c0: cents[0], note: labels[0] });
    cur += hold;
    const gl = (rem * 0.7) / n;
    for (let k = 0; k < n; k++) {
      ev.push({ kind: 'glide', t: cur, dur: gl, c0: cents[k], c1: cents[k + 1], orn: 'meend' });
      cur += gl;
    }
    ev.push({ kind: 'note', t: cur, dur: t + dur - cur, c0: cents[n], note: labels[n] });
  }
  return ev;
}

export function parseSargam(text, { bpm = 60, tuning = 'et', scale = THAATS.Bilawal.notes } = {}) {
  const ctx = { bpm, tuning, scale };
  const toks = tokenize(text);
  const events = [];
  let beat = 0;
  for (const tok of toks) {
    if (tok === '-' || /^-+$/.test(tok)) {
      const last = events[events.length - 1];
      const add = tok.length;
      if (last && last.kind !== 'rest') last.dur += add; else events.push({ kind: 'rest', t: beat, dur: add });
      beat += add;
      continue;
    }
    if (tok === '_' || tok === ',') { events.push({ kind: 'rest', t: beat, dur: 1 }); beat += 1; continue; }
    if (typeof tok === 'object') {
      const n = tok.group.length;
      tok.group.forEach((it, k) => events.push(...itemEvents(it, beat + k / n, 1 / n, ctx)));
      beat += 1;
      continue;
    }
    let item = tok, extra = 0;
    const dm = item.match(/(-+)$/);
    if (dm) { extra = dm[1].length; item = item.slice(0, -extra); }
    events.push(...itemEvents(item, beat, 1 + extra, ctx));
    beat += 1 + extra;
  }
  // convert beats to seconds
  const spb = 60 / bpm;
  for (const e of events) { e.t *= spb; e.dur *= spb; }
  return { events, duration: beat * spb };
}

// ---------------------------------------------------------------------------
// Plans: sequences of segments, each 'listen' (guide plays), 'sing' (scored) or 'together'.
export function makePlan(lines, { echo = true, gap = 0.6, transposeEach = null } = {}) {
  const segments = [];
  let t = 0;
  lines.forEach((line, li) => {
    const shift = transposeEach ? transposeEach(li) : 0;
    const ev = line.events.map((e) => ({ ...e, t: e.t, c0: e.c0 + shift, c1: e.c1 != null ? e.c1 + shift : undefined, osc: e.osc ? { ...e.osc, c1: e.osc.c1 + shift } : undefined }));
    const modes = echo ? ['listen', 'sing'] : ['together'];
    for (const mode of modes) {
      segments.push({ mode, start: t, end: t + line.duration, line: li, events: ev.map((e) => ({ ...e, t: e.t + t })) });
      t += line.duration + gap;
    }
  });
  return { segments, duration: t };
}

function evAt(e, t) {
  const x = t - e.t;
  if (x < 0 || x >= e.dur) return NaN;
  if (e.kind === 'rest') return NaN;
  if (e.kind === 'glide') {
    const u = x / e.dur, s = u * u * (3 - 2 * u);
    return e.c0 + (e.c1 - e.c0) * s;
  }
  if (e.osc) {
    const ramp = Math.min(1, x / 0.15);
    return e.c0 + (e.osc.c1 - e.c0) * ramp * (0.5 - 0.5 * Math.cos(2 * Math.PI * e.osc.rate * x));
  }
  return e.c0;
}

export function planRefAt(plan, t) {
  for (const s of plan.segments) {
    if (t < s.start || t >= s.end) continue;
    for (const e of s.events) {
      const v = evAt(e, t);
      if (!isNaN(v)) return v;
    }
    return NaN;
  }
  return NaN;
}
export function planSegmentAt(plan, t) {
  for (const s of plan.segments) if (t >= s.start && t < s.end + 0.3) return s;
  return null;
}

// Frequency curves for the guide synth (legato groups), times relative to plan start.
export function planCurves(plan, saHz, modes = ['listen', 'together']) {
  const groups = [];
  const rate = 200;
  for (const s of plan.segments) {
    if (!modes.includes(s.mode)) continue;
    let cur = null;
    const flush = () => { if (cur && cur.vals.length > 1) groups.push({ start: cur.start, end: cur.end, curve: Float32Array.from(cur.vals), amp: s.mode === 'together' ? 0.6 : 1 }); cur = null; };
    for (const e of s.events) {
      if (e.kind === 'rest') { flush(); continue; }
      if (!cur || Math.abs(cur.end - e.t) > 0.005) { flush(); cur = { start: e.t, end: e.t, vals: [] }; }
      const n = Math.max(2, Math.round(e.dur * rate));
      for (let k = 0; k < n; k++) {
        const tt = e.t + (k / n) * e.dur;
        const c = evAt(e, tt);
        cur.vals.push(saHz * Math.pow(2, (isNaN(c) ? e.c0 : c) / 1200));
      }
      cur.end = e.t + e.dur;
    }
    flush();
  }
  return groups;
}

// Notes to score: the main (non-kan) note events in sing/together segments.
export function scoredNotes(plan) {
  const out = [];
  for (const s of plan.segments) {
    if (s.mode === 'listen') continue;
    for (const e of s.events) if (e.kind === 'note' && e.dur >= 0.15) out.push({ ...e, seg: s });
  }
  return out;
}

// ---------------------------------------------------------------------------
// Library
const deg = (scale, i) => { // i-th degree (can exceed 7 / be negative) -> [idx, oct]
  const n = scale.length;
  const o = Math.floor(i / n);
  return [scale[((i % n) + n) % n], o];
};
const tok = ([idx, oct]) => SWARA_SHORT[idx] + (oct > 0 ? "'".repeat(oct) : oct < 0 ? '.'.repeat(-oct) : '');

export function arohaAvaroha(scale) {
  const up = [], down = [];
  for (let i = 0; i <= scale.length; i++) up.push(tok(deg(scale, i)));
  for (let i = scale.length; i >= 0; i--) down.push(tok(deg(scale, i)));
  return up.join(' ') + ' - ' + down.join(' ') + ' -';
}
// Alankar: patterns of k consecutive notes climbing the scale, then mirrored.
export function alankar(scale, k = 3) {
  const n = scale.length, asc = [], desc = [];
  for (let s = 0; s + k - 1 <= n; s++) { const g = []; for (let j = 0; j < k; j++) g.push(tok(deg(scale, s + j))); asc.push(g.join(' ')); }
  for (let s = n; s - k + 1 >= 0; s--) { const g = []; for (let j = 0; j < k; j++) g.push(tok(deg(scale, s - j))); desc.push(g.join(' ')); }
  return asc.join(' | ') + ' | ' + desc.join(' | ');
}

export const EXERCISES = {
  breath: { name: 'Breath: sustained hiss', kind: 'breath', mins: 1.5,
    what: 'Inhale low and quietly for 4 counts (belly and lower ribs expand, shoulders stay down), then hiss "ssss" steadily for as long as you can without squeezing.',
    why: 'Singing phrases need a slow, controlled exhale. The hiss lets you practise steady airflow without the voice; the mic measures how long you sustain it.' },
  saHold: { name: 'Sa sadhana: hold Sa', text: 'S - - - - - _ S - - - - - _', bpm: 60, echo: false, mins: 1, tanpura: true,
    what: 'Hum (lips closed, "mmm") or sing "aa" on Sa with the tanpura and keep the line flat and centred for 6 beats.',
    why: 'Holding Sa against a drone is the oldest exercise in Indian music. It trains your ear to lock onto the tonic and gives you a stable pitch to measure everything else from.' },
  sirens: { name: 'Lip-trill sirens', text: 'S~P~S\' - S\'~P~S - S~P - P~S -', bpm: 50, echo: false, mins: 1.5,
    what: 'Do a lip trill ("brrr"), or hum through a straw, and slide smoothly up and down following the line. Keep it light; the trill should not stop.',
    why: 'Semi-occluded vocal tract exercises (lip trills, straw phonation, humming) back-pressure the vocal folds so they vibrate with less effort, which makes them a safe warm-up and good for range (Titze 2006).' },
  fiveNote: { name: '5-note scale, moving up', text: 'S R G m P m G R S -', bpm: 100, echo: false, mins: 2, transposeReps: 5, tanpura: false,
    what: 'Sing on "ma-a-a-a-a" or "nee". Each repetition starts one semitone higher. Stop at the first strain. Range is built gradually, never forced.',
    why: 'Moving a simple pattern up in small steps lets your voice pass through register changes gradually instead of jumping into them.' },
  aroha: { name: 'Aroha / Avaroha (scale)', thaatText: (sc) => arohaAvaroha(sc), bpm: 66, echo: true, mins: 2, tanpura: true,
    what: 'Listen to the scale, then sing it back. Land each note in the centre of its band before moving on.',
    why: 'Call-and-response gives your ear a clear target first. Over time this tightens your auditory-motor mapping, the main thing that separates accurate singers from "off-key" ones (Pfordresher & Brown 2007; Hutchins & Peretz 2012).' },
  alankar3: { name: 'Alankar: groups of 3', thaatText: (sc) => alankar(sc, 3), bpm: 80, echo: true, mins: 2.5, tanpura: true,
    what: 'S R G, R G m, G m P ... then back down. Keep notes evenly spaced and in tune.',
    why: 'Alankars are the standard swara-agility drills of both Hindustani and Carnatic training. They build note-to-note accuracy and the clean, fast note changes that taans and sangatis need.' },
  alankar4: { name: 'Alankar: groups of 4', thaatText: (sc) => alankar(sc, 4), bpm: 84, echo: true, mins: 3, tanpura: true,
    what: 'S R G m, R G m P ... Try it at slow speed until 90%+ of notes are green, then raise the speed.',
    why: 'Longer groups train your working memory for melodic patterns as well as your accuracy.' },
  meend: { name: 'Meend (glides)', text: 'S~G - G~S - S~P - P~S - G~P - P~G -', bpm: 50, echo: true, mins: 2, tanpura: true,
    what: 'Slide continuously between the two notes: no steps, no breaks, constant volume. Watch the curve match the shape of the band.',
    why: 'Meend is everywhere in film songs. Practise glides slowly so that you pass through every microtone in between and the slide stays smooth.' },
  kan: { name: 'Kan swar (grace notes)', text: '(R)S - (S)N. - (P)G - (m)G - (D)P - (S\')N -', bpm: 50, echo: true, mins: 2, tanpura: true,
    what: 'Touch the small grace note very briefly, then settle on the main note. Pressure goes on the main note, and the kan is barely there.',
    why: 'Many "two notes at once" sounds in Indian singing are actually a kan: a very brief touch of a neighbouring note. Slowed down, you can see it as a little hook on the curve.' },
  gamak: { name: 'Gamak & andolan (oscillations)', text: 'G* - - P* - - g^ - - - S - -', bpm: 50, echo: true, mins: 2, tanpura: true,
    what: 'Gamak (*): an even, controlled oscillation between the note and the next scale note. Andolan (^): a slow, gentle swing just below the note. Start slow, keep the voice relaxed, and don\'t shake the jaw.',
    why: 'Oscillating ornaments come from controlled pitch changes in the larynx, not tremolo. Slow, accurate repetition comes first and speed comes later.' },
  intervals: { name: 'Interval jumps', text: 'S P S - S m S - S G S - S S\' S - S D S - S R S -', bpm: 60, echo: true, mins: 2, tanpura: true,
    what: 'Jump cleanly from Sa to each note and back. Hear the target in your head before you sing it.',
    why: 'Leaps are where beginners most often miss. Pre-hearing ("audiation") the target note before singing it improves accuracy.' },
  pitchMatch: { name: 'Pitch-match game', kind: 'match', mins: 2.5, tanpura: true,
    what: 'The app plays a random swara, and you sing it back. 10 rounds. The score rewards quick, accurate landing.',
    why: 'Matching single notes with immediate feedback is the most direct way to train ear-to-voice mapping, and visual feedback during this kind of practice has been shown to improve accuracy (Welch, Howard & Rush 1989).' },
  cooldown: { name: 'Cool-down: soft descending hum', text: "P~S - m G R S - - P~S - -", bpm: 50, echo: false, mins: 1, tanpura: true,
    what: 'Hum gently and slide down. Quiet, easy, no pressure.',
    why: 'Gentle, low-effort phonation after practice helps the voice settle back to speaking pitch.' },
};

export const WARMUP_ROUTINE = ['breath', 'saHold', 'sirens', 'fiveNote', 'aroha', 'meend', 'cooldown'];

// Random pitch-match lines, constrained to the singer's range (cents rel. Sa)
export function pitchMatchLines(scale, { lo = -500, hi = 1200, rounds = 10, bpm = 60, tuning = 'et' } = {}) {
  const pool = [];
  for (let o = -1; o <= 1; o++) for (const n of scale) { const c = swaraCents(n, o, tuning); if (c >= lo && c <= hi) pool.push([n, o]); }
  const lines = [];
  let prev = null;
  for (let r = 0; r < rounds; r++) {
    let p;
    do { p = pool[Math.floor(Math.random() * pool.length)]; } while (pool.length > 1 && prev && p[0] === prev[0] && p[1] === prev[1]);
    prev = p;
    lines.push(parseSargam(tok(p) + ' - -', { bpm, tuning, scale }));
  }
  return lines;
}

export function noteName(n) { return n ? SWARA_LONG[n.idx] : ''; }
