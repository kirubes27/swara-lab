// Exercise model: a mini sargam notation, plan builder, target-contour lookup and library.
import { swaraCents, SCALES, SWARA_SHORT, SWARA_LONG, isIndian, wrapCents, clamp } from './music.js';

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
const MAJOR = [0, 2, 4, 5, 7, 9, 11];
function parseNote(tok) {
  // sargam letter (S r R ...) or scale degree (1-8 with b/#; 8 = octave), with octave marks
  const m = tok.match(/^(\.*)([SrRgGmMPdDnN]|[b#]?[1-8])((?:'|\.)*)$/);
  if (!m) return null;
  let oct = -m[1].length;
  for (const ch of m[3]) oct += ch === "'" ? 1 : -1;
  let idx;
  if (/[1-8]/.test(m[2])) {
    const acc = m[2][0] === 'b' ? -1 : m[2][0] === '#' ? 1 : 0;
    const d = +m[2].slice(-1);
    idx = MAJOR[(d - 1) % 7] + acc + (d === 8 ? 12 : 0); // 8 = octave
    if (idx < 0) { idx += 12; oct -= 1; }
    if (idx > 11) { idx -= 12; oct += 1; }
  } else idx = LETTERS[m[2]];
  return { idx, oct };
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
  const mm = body.match(/([*^%]+)$/);
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
    if (mod.includes('%')) { e.osc = { c1: cents[0] - 40, rate: 5.5, centred: true }; e.orn = 'vibrato'; }
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

export function parseSargam(text, { bpm = 60, tuning = 'et', scale = SCALES.major.notes } = {}) {
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
  return { events, duration: beat * spb, beat: spb }; // beat: seconds per beat
}

// ---------------------------------------------------------------------------
// Plans: sequences of segments, each 'listen' (guide plays), 'sing' (scored) or 'together'.
// Gaps follow the tempo: 2 beats after a 'listen' line (at least 0.9 s), so a count-in fits
// before "Your turn", and 1 beat after a sung line (at least 0.6 s). beat = seconds per beat
// (defaults to the lines' own tempo); a fixed `gap` in seconds overrides both.
export function makePlan(lines, { echo = true, beat = null, gap = null, transposeEach = null } = {}) {
  const spb = beat || (lines.find((l) => l.beat) || {}).beat || 0;
  const gapAfter = (mode) => (gap != null ? gap : mode === 'listen' ? Math.max(0.9, 2 * spb) : Math.max(0.6, spb));
  const segments = [];
  let t = 0;
  lines.forEach((line, li) => {
    const shift = transposeEach ? transposeEach(li) : 0;
    const ev = line.events.map((e) => ({ ...e, t: e.t, c0: e.c0 + shift, c1: e.c1 != null ? e.c1 + shift : undefined, osc: e.osc ? { ...e.osc, c1: e.osc.c1 + shift } : undefined }));
    const modes = echo ? ['listen', 'sing'] : ['together'];
    for (const mode of modes) {
      segments.push({ mode, start: t, end: t + line.duration, line: li, events: ev.map((e) => ({ ...e, t: e.t + t })) });
      t += line.duration + gapAfter(mode);
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
    if (e.osc.centred) return e.c0 + ((e.c0 - e.osc.c1) / 2) * ramp * Math.sin(2 * Math.PI * e.osc.rate * x); // vibrato: ±half-width around the note
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
// Timing-tolerant scoring. Singers answering a line come in a little late (reaction time),
// and at the exact plan time each sung note would be compared with the previous target.
// alignTake estimates one constant offset per scored segment and shifts that segment's
// frames by it, so the notes are judged on pitch; the offsets are returned for timing feedback.
// frames: [{t, c}] in time order (cents rel Sa, NaN = unvoiced). Input frames are not modified,
// and each one lands in the output at most once.
const LAG_RANGE = { sing: [-0.25, 0.8], together: [-0.15, 0.35] }; // s: how early / late a singer may be
const WIN_PRE = 0.3, WIN_POST = 0.9; // a segment owns user frames from start - 0.3 s to end + 0.9 s

function lowerBound(frames, t) {
  let lo = 0, hi = frames.length;
  while (lo < hi) { const m = (lo + hi) >> 1; if (frames[m].t < t) lo = m + 1; else hi = m; }
  return lo;
}
// n values on a grid from time a: the nearest voiced frame within 30 ms (as analyzeTake does)
function resample(frames, a, n, hop) {
  const out = new Float32Array(n).fill(NaN);
  let j = lowerBound(frames, a - 0.03);
  for (let i = 0; i < n; i++) {
    const t = a + i * hop;
    while (j < frames.length && frames[j].t <= t - 0.03) j++;
    let bd = 0.03;
    for (let k = j; k < frames.length && frames[k].t < t + 0.03; k++) {
      const d = Math.abs(frames[k].t - t);
      if (d < bd && !isNaN(frames[k].c)) { bd = d; out[i] = frames[k].c; }
    }
  }
  return out;
}

// The singer's constant offset (s) against one segment, or null when it can't be told.
function segmentLag(s, frames, [lo, hi], octaveFree) {
  const hop = 0.01;
  const n = Math.floor((s.end - s.start) / hop);
  const R = new Float32Array(n);
  let rMin = Infinity, rMax = -Infinity;
  for (let i = 0; i < n; i++) {
    const t = s.start + i * hop;
    let v = NaN;
    for (const e of s.events) { v = evAt(e, t); if (!isNaN(v)) break; }
    R[i] = v;
    if (!isNaN(v)) { rMin = Math.min(rMin, v); rMax = Math.max(rMax, v); }
  }
  if (!(rMax - rMin >= 80)) return null; // one held pitch: no note changes to time against
  let voiced = 0;
  for (let k = lowerBound(frames, s.start + lo); k < frames.length && frames[k].t < s.end + hi; k++) if (!isNaN(frames[k].c)) voiced++;
  if (voiced < 25) return null;
  const k0 = Math.round(lo / hop), k1 = Math.round(hi / hop);
  const U = resample(frames, s.start + k0 * hop, n + k1 - k0, hop);
  // error at each candidate lag: mean of min(|deviation|, 300 cents) over frames where both are voiced
  const cand = [];
  for (let k = k0; k <= k1; k++) {
    let e = 0, m = 0;
    for (let i = 0; i < n; i++) {
      const r = R[i], u = U[i + k - k0];
      if (isNaN(r) || isNaN(u)) continue;
      const d = octaveFree ? wrapCents(u - r) : u - r;
      e += Math.min(300, Math.abs(d)); m++;
    }
    cand.push({ lag: Math.round(k * hop * 1000) / 1000, err: m ? e / m : Infinity, m });
  }
  // ignore shifts that only line up a sliver of the singing
  const maxM = Math.max(...cand.map((x) => x.m));
  const ok = cand.filter((x) => x.m >= 25 && x.m >= 0.5 * maxM);
  if (!ok.length) return null;
  let best = ok[0];
  for (const x of ok) if (x.err < best.err - 1e-6 || (x.err <= best.err + 1e-6 && Math.abs(x.lag) < Math.abs(best.lag))) best = x;
  if (best.err > 150) return null; // the melody wasn't followed at any shift: timing can't be told
  const zero = ok.find((x) => x.lag === 0);
  // prefer no shift unless another one is clearly better
  return best.err <= 0.85 * (zero ? zero.err : Infinity) ? best.lag : 0;
}

// -> { frames: aligned [{t, c}] sorted by t, lags: [{seg, lag, ok}] } for the 'sing' and
// 'together' segments; ok = there was enough singing (and melody movement) to measure.
export function alignTake(plan, frames, { octaveFree = true } = {}) {
  if (frames.some((f, i) => i && f.t < frames[i - 1].t)) frames = [...frames].sort((a, b) => a.t - b.t);
  const segs = plan.segments.filter((s) => LAG_RANGE[s.mode]).sort((a, b) => a.start - b.start);
  const lags = segs.map((seg) => {
    const lag = segmentLag(seg, frames, LAG_RANGE[seg.mode], octaveFree);
    return { seg, lag: lag || 0, ok: lag != null };
  });
  // Raw-time windows the segments draw frames from. Where neighbouring windows overlap, split
  // them halfway between where one sung line ends and the next begins.
  const win = lags.map(({ seg, lag }) => ({ a: seg.start - WIN_PRE, b: seg.end + WIN_POST, lag }));
  for (let k = 0; k + 1 < win.length; k++) {
    const p = win[k], q = win[k + 1];
    if (p.b > q.a) p.b = q.a = clamp((segs[k].end + p.lag + segs[k + 1].start + q.lag) / 2, q.a, p.b);
  }
  // Where those frames land once shifted (ca..cb). Overlaps are split down the middle, and
  // frames outside every window are kept only where no shifted segment landed.
  for (const w of win) { w.ca = w.a - w.lag; w.cb = w.b - w.lag; }
  for (let k = 0; k + 1 < win.length; k++) {
    const p = win[k], q = win[k + 1];
    if (p.cb > q.ca) p.cb = q.ca = (p.cb + q.ca) / 2;
  }
  const out = [];
  let k = 0;
  for (const f of frames) {
    while (k < win.length && f.t >= win[k].b) k++;
    const w = win[k];
    if (w && f.t >= w.a) {
      const t = f.t - w.lag;
      if (t >= w.ca && t < w.cb) out.push(w.lag ? { ...f, t } : f);
    } else if (!win.some((x) => f.t >= x.ca && f.t < x.cb)) out.push(f);
  }
  out.sort((a, b) => a.t - b.t);
  return { frames: out, lags };
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

// Each exercise has general wording (any style of song) plus optional Indian-style
// wording (i: {name, what, why}) used when the app is set to Indian notation.
export const EXERCISES = {
  breath: { name: 'Breath: sustained hiss', kind: 'breath', mins: 1.5,
    what: 'Inhale low and quietly for 4 counts (belly and lower ribs expand, shoulders stay down), then hiss "ssss" steadily for as long as you can without squeezing.',
    why: 'Long phrases need a slow, controlled exhale. The hiss trains steady airflow without the voice; the mic times how long you sustain it.' },
  saHold: { name: 'Long tones on the key note', text: 'S - - - - - _ S - - - - - _', bpm: 60, echo: false, mins: 1, tanpura: true,
    what: 'Hum (lips closed, "mmm") or sing "ah" on the key note with the drone, and keep the line flat and centred for 6 beats.',
    why: 'Long tones against a reference pitch are a staple of every vocal tradition. They train your ear to lock onto a pitch and build a steady, supported tone.',
    i: { name: 'Sa sadhana: hold Sa', what: 'Hum ("mmm") or sing "aa" on Sa with the tanpura, and keep the line flat and centred for 6 beats.',
      why: 'Holding Sa against a drone is the oldest exercise in Indian music. It trains your ear to lock onto the tonic and gives you a stable pitch to measure everything else from.' } },
  sirens: { name: 'Lip-trill sirens', text: "S~P~S' - S'~P~S - S~P - P~S -", bpm: 50, echo: false, mins: 1.5,
    what: 'Do a lip trill ("brrr"), or hum through a straw, and slide smoothly up and down following the line. Keep it light; the trill should not stop.',
    why: 'Semi-occluded vocal tract exercises (lip trills, straw phonation, humming) create back-pressure that lets the vocal folds vibrate with less effort. That makes them a safe warm-up and good for range (Titze 2006).' },
  fiveNote: { name: '5-note scale, moving up', text: 'S R G m P m G R S -', bpm: 100, echo: false, mins: 2, transposeReps: 5, tanpura: false,
    what: 'Sing 1-2-3-4-5-4-3-2-1 on "mah" or "nee". Each repetition starts a semitone higher. Stop at the first sign of strain. Range is built gradually, never forced.',
    why: 'Moving a simple pattern up in small steps lets your voice pass through register changes gradually instead of jumping into them.' },
  aroha: { name: 'Scale up & down', thaatText: (sc) => arohaAvaroha(sc), bpm: 66, echo: true, mins: 2, tanpura: true,
    what: 'Listen to the scale, then sing it back. Land each note in the centre of its band before moving on.',
    why: 'Call-and-response gives your ear a clear target first. Over time this tightens your ear-to-voice mapping, the main thing that separates accurate singers from "off-key" ones (Pfordresher & Brown 2007; Hutchins & Peretz 2012).',
    i: { name: 'Aroha / Avaroha', what: 'Listen to the aroha and avaroha, then sing them back. Land each swara in the centre of its band before moving on.' } },
  alankar3: { name: 'Scale patterns: groups of 3', thaatText: (sc) => alankar(sc, 3), bpm: 80, echo: true, mins: 2.5, tanpura: true,
    what: '1-2-3, 2-3-4, 3-4-5 … to the top, then back down. Keep the notes even and in tune.',
    why: 'Sequenced scale patterns are standard agility drills in classical, jazz and pop training (and alankars in Indian music). They build the clean, fast note changes that runs and riffs need.',
    i: { name: 'Alankar: groups of 3', what: 'S R G, R G m, G m P … then back down. Keep the notes even and in tune.' } },
  alankar4: { name: 'Scale patterns: groups of 4', thaatText: (sc) => alankar(sc, 4), bpm: 84, echo: true, mins: 3, tanpura: true,
    what: '1-2-3-4, 2-3-4-5 … Practise slowly until 90%+ of notes are green, then raise the tempo.',
    why: 'Longer groups train your memory for melodic patterns as well as your accuracy.',
    i: { name: 'Alankar: groups of 4', what: 'S R G m, R G m P … Practise slowly until 90%+ of notes are green, then raise the tempo.' } },
  meend: { name: 'Slides (portamento)', text: 'S~G - G~S - S~P - P~S - G~P - P~G -', bpm: 50, echo: true, mins: 2, tanpura: true,
    what: 'Slide continuously between the two notes: no steps, no breaks, even volume. Watch your curve match the shape of the band.',
    why: 'Slides are everywhere: soul and R&B scoops, rock and pop fall-offs, Indian meend. Practising them slowly teaches you to control the whole path between notes, not just where it ends.',
    i: { name: 'Meend (glides)', why: 'Meend is everywhere in Indian film songs. Practise glides slowly so you pass through every microtone in between and the slide stays smooth.' } },
  vibrato: { name: 'Vibrato', text: 'S - S% - - - G - G% - - - P - P% - - - S - - -', bpm: 60, echo: true, mins: 2, tanpura: true,
    what: 'Hold each note straight first, then let it "spin" into a gentle, even wobble (about 5–6 times per second, a quarter-tone or so wide). It should come from relaxed breath, not from shaking the jaw or throat.',
    why: 'A free, even vibrato appears when the voice is relaxed and well supported. Most singers (pop, rock, soul, classical) control when it starts. Alternating straight and vibrato tones trains that control.' },
  kan: { name: 'Grace notes & flips', text: "(R)S - (S)N. - (P)G - (m)G - (D)P - (S')N -", bpm: 50, echo: true, mins: 2, tanpura: true,
    what: 'Touch the small grace note very briefly, then settle on the main note. The weight goes on the main note; the grace note is a flick.',
    why: 'Quick flips and grace notes give pop, soul and folk singing its expressive edge. Slowed down, you can see them as little hooks on the curve.',
    i: { name: 'Kan swar (grace notes)', what: 'Touch the small grace note very briefly, then settle on the main note. The weight goes on the main note; the kan is barely there.',
      why: 'Many "two notes at once" sounds in Indian singing are actually a kan: a split-second touch of a neighbouring note. Slowed down, you can see it as a little hook on the curve.' } },
  gamak: { name: 'Trills & shakes', text: 'G* - - P* - - g^ - - - S - -', bpm: 50, echo: true, mins: 2, tanpura: true,
    what: 'Oscillate evenly between the note and the next scale note (*), then try a slow, gentle swing just below a note (^). Start slow and keep the voice relaxed.',
    why: 'Trills and shakes are controlled pitch changes, not tremolo. Get them slow and accurate first; speed comes later.',
    i: { name: 'Gamak & andolan', what: 'Gamak (*): an even, controlled oscillation between the note and the next scale note. Andolan (^): a slow, gentle swing just below the note. Start slow and keep the voice relaxed.',
      why: 'Gamakas come from controlled pitch changes in the larynx, not from shaking. Slow, accurate repetition comes first; speed comes later.' } },
  runs: { name: 'Runs & riffs', text: "[P D S' D] [P G R S] - - [G P D S'] [D P G R] S - - _", bpm: 48, echo: true, mins: 2.5, tanpura: true,
    what: 'Four quick notes per beat on the major pentatonic, the scale most pop/R&B riffs live in. Start at a slow tempo, keep every note distinct, and only speed up when it\'s clean.',
    why: 'Fast melismatic runs (R&B riffs, Indian taans and murkis) are built from scale fragments. Practised slowly, they become automatic patterns you can drop into songs.',
    i: { name: 'Fast phrases (taan / murki)', what: 'Four quick swaras per beat. Start slow, keep every swara distinct, and only speed up when it\'s clean.' } },
  flips: { name: 'Register flips (chest ↔ head)', text: "S - S' - S - - _ P. - P - P. - - _ S~S'~S - -", bpm: 56, echo: true, mins: 2, tanpura: true,
    what: 'Jump an octave and let the top note be light (head voice or falsetto), then come back down. Do it quietly. A small "flip" in the sound is fine; we\'re learning to control it.',
    why: 'Many singers (Jeff Buckley, Bon Iver, Arijit Singh) move expressively between chest and head voice. Practising light octave leaps builds a smoother, controllable transition.' },
  intervals: { name: 'Interval jumps', text: "S P S - S m S - S G S - S S' S - S D S - S R S -", bpm: 60, echo: true, mins: 2, tanpura: true,
    what: 'Jump cleanly from the key note to each note and back. Hear the target in your head before you sing it.',
    why: 'Leaps are where beginners miss most. Pre-hearing the target note ("audiation") before singing improves accuracy.' },
  pitchMatch: { name: 'Pitch matching', kind: 'match', mins: 2.5, tanpura: true,
    what: 'The app plays a random note, and you sing it back. 10 rounds. The score rewards quick, accurate landing.',
    why: 'Matching single notes with immediate feedback is the most direct way to train ear-to-voice mapping, and visual feedback during this kind of practice improves accuracy (Welch, Howard & Rush 1989).' },
  cooldown: { name: 'Cool-down: soft descending hum', text: 'P~S - m G R S - - P~S - -', bpm: 50, echo: false, mins: 1, tanpura: true,
    what: 'Hum gently and slide down. Quiet, easy, no pressure.',
    why: 'Gentle, low-effort voicing after practice helps the voice settle back to its speaking pitch.' },
};

// Wording for the current style.
export function exText(def, s) {
  const ind = isIndian(s) && def.i ? def.i : {};
  return { name: ind.name || def.name, what: ind.what || def.what, why: ind.why || def.why };
}

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
