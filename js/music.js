// Music theory helpers: Hz <-> cents, swara naming, tunings, thaats.

export const WESTERN = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'];

// Hindustani shorthand: lowercase = komal, M = tivra Ma.
export const SWARA_SHORT = ['S', 'r', 'R', 'g', 'G', 'm', 'M', 'P', 'd', 'D', 'n', 'N'];
export const SWARA_LONG = ['Sa', 'Komal Re', 'Re', 'Komal Ga', 'Ga', 'Ma', 'Tivra Ma', 'Pa', 'Komal Dha', 'Dha', 'Komal Ni', 'Ni'];
export const CARNATIC = ['S', 'R1', 'R2', 'G2', 'G3', 'M1', 'M2', 'P', 'D1', 'D2', 'N2', 'N3'];

// Just-intonation (5-limit) cents for the 12 swarasthanas, close to how
// a tanpura-referenced singer tends to place them.
export const JUST_CENTS = [0, 111.73, 203.91, 315.64, 386.31, 498.04, 590.22, 701.96, 813.69, 884.36, 1017.6, 1088.27];
export const ET_CENTS = [0, 100, 200, 300, 400, 500, 600, 700, 800, 900, 1000, 1100];

export const THAATS = {
  Bilawal: { carnatic: 'Shankarabharanam', notes: [0, 2, 4, 5, 7, 9, 11], hint: 'Like the Western major scale.' },
  Kalyan: { carnatic: 'Mechakalyani', notes: [0, 2, 4, 6, 7, 9, 11], hint: 'Major scale with a raised (tivra) Ma.' },
  Khamaj: { carnatic: 'Harikambhoji', notes: [0, 2, 4, 5, 7, 9, 10], hint: 'Major scale with a flat (komal) Ni.' },
  Kafi: { carnatic: 'Kharaharapriya', notes: [0, 2, 3, 5, 7, 9, 10], hint: 'Komal Ga and komal Ni (Dorian-like).' },
  Asavari: { carnatic: 'Natabhairavi', notes: [0, 2, 3, 5, 7, 8, 10], hint: 'Natural minor.' },
  Bhairavi: { carnatic: 'Hanumatodi', notes: [0, 1, 3, 5, 7, 8, 10], hint: 'All komal notes (Phrygian-like).' },
  Bhairav: { carnatic: 'Mayamalavagowla', notes: [0, 1, 4, 5, 7, 8, 11], hint: 'Komal Re and Dha. The classic first scale in Carnatic training.' },
  Poorvi: { carnatic: 'Kamavardhani', notes: [0, 1, 4, 6, 7, 8, 11], hint: 'Komal Re/Dha with tivra Ma.' },
  Marwa: { carnatic: 'Gamanashrama', notes: [0, 1, 4, 6, 7, 9, 11], hint: 'Komal Re, tivra Ma, shuddha Dha.' },
  Todi: { carnatic: 'Shubhapantuvarali', notes: [0, 1, 3, 6, 7, 8, 11], hint: 'Komal Re/Ga/Dha with tivra Ma.' },
};

export const A4 = 440;
export const hzToMidi = (hz) => 69 + 12 * Math.log2(hz / A4);
export const midiToHz = (m) => A4 * Math.pow(2, (m - 69) / 12);
export const centsBetween = (hz, refHz) => 1200 * Math.log2(hz / refHz);
export const centsToHz = (c, refHz) => refHz * Math.pow(2, c / 1200);

export function westernName(midi) {
  const m = Math.round(midi);
  return WESTERN[((m % 12) + 12) % 12] + (Math.floor(m / 12) - 1);
}

// Carnatic "kattai" (pitch-pipe numbering) for a Sa in the C..B range.
export function kattaiName(pc) {
  const k = ['1', '1½', '2', '2½', '3', '4', '4½', '5', '5½', '6', '6½', '7'];
  return k[((pc % 12) + 12) % 12] + ' kattai';
}
// Hindustani harmonium naming (white/black key numbering from C).
export function kaliSafedName(pc) {
  const n = ['Safed 1', 'Kali 1', 'Safed 2', 'Kali 2', 'Safed 3', 'Safed 4', 'Kali 3', 'Safed 5', 'Kali 4', 'Safed 6', 'Kali 5', 'Safed 7'];
  return n[((pc % 12) + 12) % 12];
}

// Given cents relative to Sa, find nearest swara index (0..11), octave and deviation.
export function nearestSwara(cents, tuning = 'et') {
  const table = tuning === 'just' ? JUST_CENTS : ET_CENTS;
  const oct = Math.floor(cents / 1200);
  const within = cents - oct * 1200;
  let best = 0, bestD = Infinity;
  for (let i = 0; i <= 12; i++) {
    const c = i === 12 ? 1200 : table[i];
    const d = within - c;
    if (Math.abs(d) < Math.abs(bestD)) { bestD = d; best = i; }
  }
  let idx = best, o = oct;
  if (best === 12) { idx = 0; o = oct + 1; }
  return { idx, octave: o, dev: bestD };
}

export function swaraCents(idx, octave = 0, tuning = 'et') {
  const table = tuning === 'just' ? JUST_CENTS : ET_CENTS;
  return table[((idx % 12) + 12) % 12] + 1200 * (octave + Math.floor(idx / 12));
}

// Text label with octave dots (combining dot below / above).
export function swaraLabel(idx, octave, notation = 'hindustani') {
  if (notation === 'western') return null;
  const base = notation === 'carnatic' ? CARNATIC[idx] : SWARA_SHORT[idx];
  if (octave < 0) return base + '̣'.repeat(Math.min(2, -octave)) + (octave < -1 ? '' : '');
  if (octave > 0) return base + '̇'.repeat(Math.min(2, octave));
  return base;
}

export function noteLabel(cents, saHz, settings) {
  const ns = nearestSwara(cents, settings.tuning);
  const midi = hzToMidi(centsToHz(cents, saHz));
  const west = westernName(midi);
  if (settings.notation === 'western') return { main: west, sub: SWARA_SHORT[ns.idx], dev: ns.dev, ns };
  return { main: swaraLabel(ns.idx, ns.octave, settings.notation), sub: west, dev: ns.dev, ns };
}

// Sa frequency from settings: saMidi (e.g. 49 = C#3) plus fine cents.
export function saHzFrom(settings) {
  return midiToHz(settings.saMidi) * Math.pow(2, (settings.saFine || 0) / 1200);
}

export function clamp(x, a, b) { return x < a ? a : x > b ? b : x; }
export function median(arr) {
  if (!arr.length) return NaN;
  const s = Float64Array.from(arr).sort();
  const m = s.length >> 1;
  return s.length % 2 ? s[m] : 0.5 * (s[m - 1] + s[m]);
}
export function percentile(arr, p) {
  if (!arr.length) return NaN;
  const s = Float64Array.from(arr).sort();
  const i = clamp(Math.round((s.length - 1) * p), 0, s.length - 1);
  return s[i];
}
export function wrapCents(d) { return ((((d + 600) % 1200) + 1200) % 1200) - 600; }

// ---------------------------------------------------------------------------
// Style: 'general' (any song; note names, scale degrees) or Indian (sargam).
// settings.notation: 'western' | 'hindustani' | 'carnatic'
export const isIndian = (s) => s.notation === 'hindustani' || s.notation === 'carnatic';

// Scales offered in drills. Indian names shown in Indian style when they exist.
export const SCALES = {
  major:      { name: 'Major', indian: 'Bilawal', carnatic: 'Shankarabharanam', notes: [0, 2, 4, 5, 7, 9, 11] },
  minor:      { name: 'Natural minor', indian: 'Asavari', carnatic: 'Natabhairavi', notes: [0, 2, 3, 5, 7, 8, 10] },
  majPenta:   { name: 'Major pentatonic', indian: 'Bhoopali', carnatic: 'Mohanam', notes: [0, 2, 4, 7, 9] },
  minPenta:   { name: 'Minor pentatonic', indian: 'Dhani', carnatic: 'Shuddha Dhanyasi', notes: [0, 3, 5, 7, 10] },
  blues:      { name: 'Blues', indian: null, carnatic: null, notes: [0, 3, 5, 6, 7, 10] },
  dorian:     { name: 'Dorian', indian: 'Kafi', carnatic: 'Kharaharapriya', notes: [0, 2, 3, 5, 7, 9, 10] },
  mixolydian: { name: 'Mixolydian', indian: 'Khamaj', carnatic: 'Harikambhoji', notes: [0, 2, 4, 5, 7, 9, 10] },
  lydian:     { name: 'Lydian', indian: 'Kalyan', carnatic: 'Mechakalyani', notes: [0, 2, 4, 6, 7, 9, 11] },
  phrygian:   { name: 'Phrygian', indian: 'Bhairavi', carnatic: 'Hanumatodi', notes: [0, 1, 3, 5, 7, 8, 10] },
  harmMinor:  { name: 'Harmonic minor', indian: 'Kirwani', carnatic: 'Keeravani', notes: [0, 2, 3, 5, 7, 8, 11] },
  bhairav:    { name: 'Double harmonic', indian: 'Bhairav', carnatic: 'Mayamalavagowla', notes: [0, 1, 4, 5, 7, 8, 11] },
  poorvi:     { name: 'Poorvi', indian: 'Poorvi', carnatic: 'Kamavardhani', notes: [0, 1, 4, 6, 7, 8, 11], indianOnly: true },
  marwa:      { name: 'Marwa', indian: 'Marwa', carnatic: 'Gamanashrama', notes: [0, 1, 4, 6, 7, 9, 11], indianOnly: true },
  todi:       { name: 'Todi', indian: 'Todi', carnatic: 'Shubhapantuvarali', notes: [0, 1, 3, 6, 7, 8, 11], indianOnly: true },
};
export function scaleLabel(key, s) {
  const sc = SCALES[key];
  if (!sc) return key;
  if (!isIndian(s)) return sc.name + (sc.indian && !sc.indianOnly ? '' : '');
  const ind = s.notation === 'carnatic' ? sc.carnatic : sc.indian;
  return ind ? `${ind} (${sc.name})` : sc.name;
}
export function scaleList(s) { return Object.keys(SCALES).filter((k) => isIndian(s) || !SCALES[k].indianOnly); }

// Scale-degree names relative to the tonic (for the general style).
export const DEGREES = ['1', '♭2', '2', '♭3', '3', '4', '♯4', '5', '♭6', '6', '♭7', '7'];
export const DEGREE_LONG = ['1 (tonic)', '♭2', '2', '♭3 (minor 3rd)', '3 (major 3rd)', '4', '♯4', '5 (fifth)', '♭6', '6', '♭7', '7'];

// A note given as (semitone idx above tonic, octave) -> display text in the current style.
export function noteText(idx, oct, saHz, s) {
  if (isIndian(s)) return swaraLabel(idx, oct, s.notation);
  return westernName(Math.round(hzToMidi(saHz)) + idx + 12 * oct);
}
export function degreeText(idx, s) { return isIndian(s) ? SWARA_LONG[idx] : DEGREE_LONG[idx]; }

// Vocabulary that changes with style.
const VOCAB = {
  tonic:     ['Key', 'Sa'],
  tonicLong: ['home note (tonic)', 'Sa (tonic)'],
  drone:     ['Drone', 'Tanpura'],
  scale:     ['Scale', 'Thaat / raga scale'],
  slide:     ['slide', 'meend'],
  grace:     ['grace note', 'kan swar'],
  shake:     ['shake / vibrato', 'gamak'],
  ornaments: ['runs, slides and ornaments', 'gamakas, kan swaras and murkis'],
  practice:  ['practice', 'riyaz'],
  noteWord:  ['note', 'swara'],
  lowOct:    ['lower octave', 'mandra saptak'],
};
export function term(key, s) { const v = VOCAB[key]; return v ? v[isIndian(s) ? 1 : 0] : key; }
