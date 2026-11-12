// Theory data for the Theory pages: note spelling, scales, chords, keys, Camelot codes,
// progressions and guitar shapes. Pure functions, no DOM or audio.

export const mod12 = (x) => ((x % 12) + 12) % 12;
export const isBlack = (m) => [1, 3, 6, 8, 10].includes(mod12(m));

const LETTERS = ['C', 'D', 'E', 'F', 'G', 'A', 'B'];
const LETTER_PC = [0, 2, 4, 5, 7, 9, 11];
const ACC = { '-2': '𝄫', '-1': '♭', 0: '', 1: '♯', 2: '𝄪' };
const MAJOR = [0, 2, 4, 5, 7, 9, 11];

// How most players name the twelve pitch classes.
export const PC_NAMES = ['C', 'C♯', 'D', 'E♭', 'E', 'F', 'F♯', 'G', 'A♭', 'A', 'B♭', 'B'];
export const SHARP_NAMES = ['C', 'C♯', 'D', 'D♯', 'E', 'F', 'F♯', 'G', 'G♯', 'A', 'A♯', 'B'];
export const FLAT_NAMES = ['C', 'D♭', 'D', 'E♭', 'E', 'F', 'G♭', 'G', 'A♭', 'A', 'B♭', 'B'];
export const BOTH_NAMES = PC_NAMES.map((n, pc) => (isBlack(pc) ? `${SHARP_NAMES[pc]}/${FLAT_NAMES[pc]}` : n));

export const octaveOf = (m) => Math.floor(m / 12) - 1;
export const hzOf = (m) => 440 * Math.pow(2, (m - 69) / 12);

// A spelled note is { l, a }: a letter (0 = C … 6 = B) and an accidental (−2 … 2).
export const pcOf = (n) => mod12(LETTER_PC[n.l] + n.a);
export const nameOf = (n) => LETTERS[n.l] + ACC[n.a];
// The usual spelling of a pitch class (C♯, E♭, F♯, A♭, B♭ for the black keys).
export function pcNote(pc) {
  const s = PC_NAMES[mod12(pc)];
  return { l: LETTERS.indexOf(s[0]), a: s[1] === '♯' ? 1 : s[1] === '♭' ? -1 : 0 };
}

// The note `semis` semitones and `steps` letter names above n (a 3rd is 2 steps, a 5th 4).
export function above(n, semis, steps) {
  const l = (n.l + steps) % 7;
  let a = mod12(pcOf(n) + semis - LETTER_PC[l]);
  if (a > 6) a -= 12;
  return { l, a };
}

function tonicSpellings(pc) {
  const nat = LETTER_PC.indexOf(pc);
  if (nat >= 0) return [{ l: nat, a: 0 }];
  return [{ l: LETTER_PC.indexOf(pc - 1), a: 1 }, { l: LETTER_PC.indexOf(pc + 1), a: -1 }];
}

// Spell a set of notes above a tonic, choosing the tonic spelling with the fewest
// accidentals (double sharps and flats count heavily; ties go to the usual name).
function spellFrom(pc, semis, steps) {
  let best = null;
  for (const t of tonicSpellings(pc)) {
    const notes = semis.map((s, i) => above(t, s, steps[i]));
    const cost = notes.reduce((c, n) => c + (Math.abs(n.a) > 1 ? 4 * Math.abs(n.a) : Math.abs(n.a)), 0) + (nameOf(t) === PC_NAMES[pc] ? 0 : 0.5);
    if (!best || cost < best.cost) best = { cost, notes };
  }
  return best.notes;
}

export function degreeLabel(semis, step) {
  const d = semis - MAJOR[step];
  return (d < 0 ? '♭'.repeat(-d) : '♯'.repeat(d)) + (step + 1);
}

// ---------------------------------------------------------------------------
// Scales. `steps` gives each note's letter distance from the tonic (defaults to 0..6).
export const SCALES = {
  major: { name: 'Major', semis: [0, 2, 4, 5, 7, 9, 11], mood: 'Bright and settled.', indian: ['Bilawal', 'Shankarabharanam'] },
  minor: { name: 'Natural minor', semis: [0, 2, 3, 5, 7, 8, 10], mood: 'Darker and wistful.', indian: ['Asavari', 'Natabhairavi'] },
  majPenta: { name: 'Major pentatonic', semis: [0, 2, 4, 7, 9], steps: [0, 1, 2, 4, 5], mood: 'Open and sunny. No semitone steps, so nothing clashes.', indian: ['Bhoopali', 'Mohanam'] },
  minPenta: { name: 'Minor pentatonic', semis: [0, 3, 5, 7, 10], steps: [0, 2, 3, 4, 6], mood: 'The sound of riffs, blues and vocal runs.', indian: ['Dhani', 'Shuddha Dhanyasi'] },
  blues: { name: 'Blues', semis: [0, 3, 5, 6, 7, 10], steps: [0, 2, 3, 4, 4, 6], mood: 'Minor pentatonic plus one tense "blue" note, the ♭5.' },
  dorian: { name: 'Dorian', semis: [0, 2, 3, 5, 7, 9, 10], mood: 'Minor with a brighter 6th. Soulful.', indian: ['Kafi', 'Kharaharapriya'], mode: 2 },
  phrygian: { name: 'Phrygian', semis: [0, 1, 3, 5, 7, 8, 10], mood: 'Minor with a dark ♭2.', indian: ['Bhairavi', 'Hanumatodi'], mode: 3 },
  lydian: { name: 'Lydian', semis: [0, 2, 4, 6, 7, 9, 11], mood: 'Major with a floating ♯4.', indian: ['Kalyan', 'Mechakalyani'], mode: 4 },
  mixolydian: { name: 'Mixolydian', semis: [0, 2, 4, 5, 7, 9, 10], mood: 'Major with a bluesy ♭7. Rock and folk.', indian: ['Khamaj', 'Harikambhoji'], mode: 5 },
  locrian: { name: 'Locrian', semis: [0, 1, 3, 5, 6, 8, 10], mood: 'Unstable. Rarely used as home.', mode: 7 },
};

// [{ semis, deg, note, name }] for a scale on a tonic pitch class.
export function scaleNotes(key, tonicPc) {
  const sc = SCALES[key];
  const steps = sc.steps || sc.semis.map((_, i) => i);
  const notes = spellFrom(mod12(tonicPc), sc.semis, steps);
  return sc.semis.map((s, i) => ({ semis: s, deg: degreeLabel(s, steps[i]), note: notes[i], name: nameOf(notes[i]) }));
}
export const tonicName = (key, pc) => scaleNotes(key, pc)[0].name;

// ---------------------------------------------------------------------------
// Chords
export const CHORDS = {
  maj: { name: 'Major', sym: '', semis: [0, 4, 7], steps: [0, 2, 4] },
  min: { name: 'Minor', sym: 'm', semis: [0, 3, 7], steps: [0, 2, 4] },
  dim: { name: 'Diminished', sym: 'dim', semis: [0, 3, 6], steps: [0, 2, 4] },
  aug: { name: 'Augmented', sym: 'aug', semis: [0, 4, 8], steps: [0, 2, 4] },
  sus2: { name: 'Sus2', sym: 'sus2', semis: [0, 2, 7], steps: [0, 1, 4] },
  sus4: { name: 'Sus4', sym: 'sus4', semis: [0, 5, 7], steps: [0, 3, 4] },
  maj7: { name: 'Major 7th', sym: 'maj7', semis: [0, 4, 7, 11], steps: [0, 2, 4, 6] },
  dom7: { name: 'Dominant 7th', sym: '7', semis: [0, 4, 7, 10], steps: [0, 2, 4, 6] },
  min7: { name: 'Minor 7th', sym: 'm7', semis: [0, 3, 7, 10], steps: [0, 2, 4, 6] },
  m7b5: { name: 'Half-diminished', sym: 'm7♭5', semis: [0, 3, 6, 10], steps: [0, 2, 4, 6] },
};

// Spelled chord tones. Pass `root` (a spelled note) to keep a key's spelling.
export function chordTones(rootPc, q, root = null) {
  const c = CHORDS[q];
  const notes = root ? c.semis.map((s, i) => above(root, s, c.steps[i])) : spellFrom(mod12(rootPc), c.semis, c.steps);
  return notes.map((n, i) => ({ note: n, name: nameOf(n), semis: c.semis[i], deg: degreeLabel(c.semis[i], c.steps[i]) }));
}
export const chordName = (rootPc, q, root = null) => chordTones(rootPc, q, root)[0].name + CHORDS[q].sym;

const INV_NAMES = ['root position', '1st inversion', '2nd inversion', '3rd inversion'];
export const inversionName = (i) => INV_NAMES[i] || '';

// Name the chord formed by a set of MIDI notes, if it is a common one.
export function identifyChord(midis) {
  const sorted = [...midis].sort((a, b) => a - b);
  const pcs = [...new Set(sorted.map(mod12))];
  if (pcs.length < 3) return null;
  const bass = mod12(sorted[0]);
  for (const root of [bass, ...pcs.filter((p) => p !== bass)]) {
    const set = pcs.map((p) => mod12(p - root)).sort((a, b) => a - b);
    for (const [q, c] of Object.entries(CHORDS)) {
      if (c.semis.length === set.length && c.semis.every((s, i) => s === set[i])) {
        return { root, q, inv: c.semis.indexOf(mod12(bass - root)) };
      }
    }
  }
  return null;
}

// ---------------------------------------------------------------------------
// Intervals, with a song whose melody opens with (or features) the interval going up.
export const INTERVALS = [
  { n: 1, short: 'm2', name: 'Minor 2nd', song: 'Jaws theme', sargam: 'Sa to komal Re' },
  { n: 2, short: 'M2', name: 'Major 2nd', song: 'Happy Birthday ("Hap-py birth-")', sargam: 'Sa to Re' },
  { n: 3, short: 'm3', name: 'Minor 3rd', song: 'Greensleeves ("A-las")', sargam: 'Sa to komal Ga' },
  { n: 4, short: 'M3', name: 'Major 3rd', song: 'When the Saints ("Oh when")', sargam: 'Sa to Ga' },
  { n: 5, short: 'P4', name: 'Perfect 4th', song: 'Amazing Grace ("A-ma-")', sargam: 'Sa to Ma' },
  { n: 6, short: 'TT', name: 'Tritone', song: 'The Simpsons theme ("The Simp-")', sargam: 'Sa to tivra Ma' },
  { n: 7, short: 'P5', name: 'Perfect 5th', song: 'Twinkle, Twinkle, Little Star', sargam: 'Sa to Pa' },
  { n: 8, short: 'm6', name: 'Minor 6th', song: 'The Entertainer (the leaps after the opening run)', sargam: 'Sa to komal Dha' },
  { n: 9, short: 'M6', name: 'Major 6th', song: 'My Bonnie Lies over the Ocean ("My Bon-")', sargam: 'Sa to Dha' },
  { n: 10, short: 'm7', name: 'Minor 7th', song: 'Somewhere, West Side Story ("There\'s a")', sargam: 'Sa to komal Ni' },
  { n: 11, short: 'M7', name: 'Major 7th', song: 'Take On Me, the chorus ("Take on")', sargam: 'Sa to Ni' },
  { n: 12, short: 'P8', name: 'Octave', song: 'Over the Rainbow ("Some-where")', sargam: 'Sa to upper Sa' },
];

// ---------------------------------------------------------------------------
// Keys and the circle of fifths. Position k (clockwise from C at the top) holds the
// major key a 5th above position k − 1.
export const FIFTHS = Array.from({ length: 12 }, (_, k) => mod12(7 * k));

const SHARP_ORDER = [3, 0, 4, 1, 5, 2, 6]; // F C G D A E B
const FLAT_ORDER = [6, 2, 5, 1, 4, 0, 3]; // B E A D G C F
export function keySignature(pc, minor = false) {
  const notes = scaleNotes(minor ? 'minor' : 'major', pc).map((x) => x.note);
  const acc = notes.filter((n) => n.a !== 0);
  if (!acc.length) return { count: 0, kind: null, names: [] };
  const kind = acc[0].a > 0 ? 'sharp' : 'flat';
  const order = kind === 'sharp' ? SHARP_ORDER : FLAT_ORDER;
  const names = order.map((l) => acc.find((n) => n.l === l)).filter(Boolean).map(nameOf);
  return { count: names.length, kind, names };
}
export function signatureText(sig) {
  if (!sig.count) return 'No sharps or flats';
  return `${sig.count} ${sig.kind}${sig.count > 1 ? 's' : ''}: ${sig.names.join(' ')}`;
}

// Diatonic triads (or sevenths) of a major or natural-minor key.
const ROMAN = ['I', 'II', 'III', 'IV', 'V', 'VI', 'VII'];
const QUALITY_OF = { '4,7': 'maj', '3,7': 'min', '3,6': 'dim', '4,8': 'aug', '4,7,11': 'maj7', '4,7,10': 'dom7', '3,7,10': 'min7', '3,6,10': 'm7b5' };
export function diatonicChords(tonicPc, minor = false, sevenths = false) {
  const sc = scaleNotes(minor ? 'minor' : 'major', tonicPc);
  return sc.map((n, i) => {
    const stack = (sevenths ? [2, 4, 6] : [2, 4]).map((k) => mod12(sc[(i + k) % 7].semis - n.semis));
    const q = QUALITY_OF[stack.join(',')];
    const rootPc = mod12(tonicPc + n.semis);
    const lower = q === 'min' || q === 'dim' || q === 'min7' || q === 'm7b5';
    let rn = lower ? ROMAN[i].toLowerCase() : ROMAN[i];
    if (q === 'dim') rn += '°';
    if (q === 'm7b5') rn += 'ø7';
    if (q === 'maj7') rn += 'maj7';
    if (q === 'dom7' || q === 'min7') rn += '7';
    return { degree: i, rootPc, q, roman: rn, root: n.note, name: chordName(rootPc, q, n.note), tones: chordTones(rootPc, q, n.note) };
  });
}

// ---------------------------------------------------------------------------
// Camelot codes: 8B = C major, 8A = A minor, +1 per step clockwise (up a 5th).
export function camelotCode(pc, minor) {
  const k = FIFTHS.indexOf(mod12(minor ? pc + 3 : pc));
  return { n: ((k + 7) % 12) + 1, letter: minor ? 'A' : 'B' };
}
export function camelotKey(n, letter) {
  const majPc = FIFTHS[mod12(n - 8)];
  const minor = letter === 'A';
  const pc = minor ? mod12(majPc + 9) : majPc;
  return { pc, minor, name: tonicName(minor ? 'minor' : 'major', pc) + (minor ? ' minor' : ' major'), short: tonicName(minor ? 'minor' : 'major', pc) + (minor ? 'm' : '') };
}
export const camelotStep = (n, d) => mod12(n - 1 + d) + 1;

// ---------------------------------------------------------------------------
// Progressions: [root semitones above the tonic, letter steps, quality, numeral].
export const PROGRESSIONS = [
  { id: 'pop', name: 'I–V–vi–IV', title: 'Pop', minor: false, key: 0, bpm: 96,
    chords: [[0, 0, 'maj', 'I'], [7, 4, 'maj', 'V'], [9, 5, 'min', 'vi'], [5, 3, 'maj', 'IV']],
    note: 'The four-chord pop progression.' },
  { id: 'minorPop', name: 'i–VI–III–VII', title: 'Minor pop', minor: true, key: 9, bpm: 92,
    chords: [[0, 0, 'min', 'i'], [8, 5, 'maj', 'VI'], [3, 2, 'maj', 'III'], [10, 6, 'maj', 'VII']],
    note: 'The same four chords, started on the minor one. Suits melodies in natural minor (Asavari).' },
  { id: 'doowop', name: 'I–vi–IV–V', title: '50s', minor: false, key: 0, bpm: 80,
    chords: [[0, 0, 'maj', 'I'], [9, 5, 'min', 'vi'], [5, 3, 'maj', 'IV'], [7, 4, 'maj', 'V']],
    note: 'The doo-wop progression, still everywhere in ballads.' },
  { id: 'jazz', name: 'ii–V–I', title: 'Jazz', minor: false, key: 0, bpm: 104,
    chords: [[2, 1, 'min7', 'ii7'], [7, 4, 'dom7', 'V7'], [0, 0, 'maj7', 'Imaj7'], [0, 0, 'maj7', 'Imaj7']],
    note: 'Tension, more tension, home. The backbone of jazz.' },
  { id: 'blues', name: '12-bar blues', title: 'Blues', minor: false, key: 9, bpm: 112,
    chords: [[0, 0, 'dom7', 'I7'], [0, 0, 'dom7', 'I7'], [0, 0, 'dom7', 'I7'], [0, 0, 'dom7', 'I7'],
      [5, 3, 'dom7', 'IV7'], [5, 3, 'dom7', 'IV7'], [0, 0, 'dom7', 'I7'], [0, 0, 'dom7', 'I7'],
      [7, 4, 'dom7', 'V7'], [5, 3, 'dom7', 'IV7'], [0, 0, 'dom7', 'I7'], [7, 4, 'dom7', 'V7']],
    note: 'Three chords over twelve bars. The last bar turns it around.' },
];

// The chords of a progression in a key: [{ rootPc, q, roman, name, tones }].
export function progressionChords(prog, tonicPc) {
  const tonic = scaleNotes(prog.minor ? 'minor' : 'major', tonicPc)[0].note;
  return prog.chords.map(([semis, steps, q, roman]) => {
    const root = above(tonic, semis, steps);
    const rootPc = mod12(tonicPc + semis);
    return { rootPc, q, roman, name: chordName(rootPc, q, root), tones: chordTones(rootPc, q, root) };
  });
}

// A close voicing near middle C that moves as little as possible from `prev`.
export function voiceChord(rootPc, q, prev = null, lo = 55, hi = 77) {
  const semis = CHORDS[q].semis;
  const options = [];
  for (let base = lo - 12; base <= hi; base++) {
    if (mod12(base) !== mod12(rootPc)) continue;
    const notes = semis.map((s) => base + s);
    for (let inv = 0; inv < notes.length; inv++) {
      const v = [...notes.slice(inv), ...notes.slice(0, inv).map((m) => m + 12)];
      if (v[0] >= lo && v[v.length - 1] <= hi) options.push(v);
    }
  }
  const centre = (lo + hi) / 2;
  const cost = (v) => (prev ? v.reduce((c, m, i) => c + Math.abs(m - (prev[i] ?? prev[prev.length - 1])), 0) : Math.abs(v.reduce((a, b) => a + b, 0) / v.length - centre));
  options.sort((a, b) => cost(a) - cost(b));
  return options[0] || semis.map((s) => 60 + mod12(rootPc) + s);
}

// ---------------------------------------------------------------------------
// Guitar: standard tuning, low E first.
export const TUNING = [40, 45, 50, 55, 59, 64];
export const STRING_NAMES = ['low E', 'A', 'D', 'G', 'B', 'high E'];

// Chord boxes: frets low E → high E (−1 = not played), fingers (1 index … 4 little).
export const SHAPES = {
  C: { frets: [-1, 3, 2, 0, 1, 0], fingers: [0, 3, 2, 0, 1, 0] },
  G: { frets: [3, 2, 0, 0, 0, 3], fingers: [2, 1, 0, 0, 0, 3] },
  D: { frets: [-1, -1, 0, 2, 3, 2], fingers: [0, 0, 0, 1, 3, 2] },
  A: { frets: [-1, 0, 2, 2, 2, 0], fingers: [0, 0, 1, 2, 3, 0] },
  E: { frets: [0, 2, 2, 1, 0, 0], fingers: [0, 2, 3, 1, 0, 0] },
  Am: { frets: [-1, 0, 2, 2, 1, 0], fingers: [0, 0, 2, 3, 1, 0] },
  Em: { frets: [0, 2, 2, 0, 0, 0], fingers: [0, 2, 3, 0, 0, 0] },
  Dm: { frets: [-1, -1, 0, 2, 3, 1], fingers: [0, 0, 0, 2, 3, 1] },
  F: { frets: [-1, -1, 3, 2, 1, 1], fingers: [0, 0, 3, 2, 1, 1], barre: { fret: 1, from: 4, to: 5 } },
};
export const BARRE_EXAMPLES = {
  'F barre': { frets: [1, 3, 3, 2, 1, 1], fingers: [1, 3, 4, 2, 1, 1], barre: { fret: 1, from: 0, to: 5 }, chord: 'F' },
  'Bm barre': { frets: [-1, 2, 4, 4, 3, 2], fingers: [0, 1, 3, 4, 2, 1], barre: { fret: 2, from: 1, to: 5 }, chord: 'Bm' },
};

// Movable shapes: E shape (root on the low E string) and A shape (root on the A string).
const E_SHAPE = { maj: [[0, 2, 2, 1, 0, 0], [1, 3, 4, 2, 1, 1]], min: [[0, 2, 2, 0, 0, 0], [1, 3, 4, 1, 1, 1]] };
const A_SHAPE = { maj: [[-1, 0, 2, 2, 2, 0], [0, 1, 3, 3, 3, 1]], min: [[-1, 0, 2, 2, 1, 0], [0, 1, 3, 4, 2, 1]], dim: [[-1, 0, 1, 2, 1, -1], [0, 1, 2, 4, 3, 0]] };

const OPEN_EXTRA = { Adim: { frets: [-1, 0, 1, 2, 1, -1], fingers: [0, 0, 1, 3, 2, 0] } };

// A playable shape for a triad: an open chord if there is one, otherwise a barre chord.
export function guitarShape(rootPc, q, name) {
  if (SHAPES[name] || OPEN_EXTRA[name]) return SHAPES[name] || OPEN_EXTRA[name];
  const fE = mod12(rootPc - 4), fA = mod12(rootPc - 9);
  const useE = E_SHAPE[q] && (!A_SHAPE[q] || (fE > 0 && fE <= fA));
  const [tpl, fing] = useE ? E_SHAPE[q] : A_SHAPE[q] || A_SHAPE.maj;
  const at = useE ? fE : fA || 12;
  const frets = tpl.map((f) => (f < 0 ? -1 : f + at));
  const first = frets.findIndex((f) => f === at);
  const last = frets.length - 1 - [...frets].reverse().findIndex((f) => f === at);
  return { frets, fingers: fing, barre: q === 'dim' ? null : { fret: at, from: first, to: last } };
}

// MIDI notes a shape sounds, per string (null = not played).
export const shapeNotes = (shape) => shape.frets.map((f, s) => (f < 0 ? null : TUNING[s] + f));

// The five minor-pentatonic boxes: two notes per string, starting from the k-th scale note
// on the low E string. Returns [{ s, f }] or null if it doesn't fit below `maxFret`.
export function pentatonicBox(tonicPc, box, maxFret = 15) {
  const semis = [0, 3, 5, 7, 10];
  let start = mod12(tonicPc + semis[box] - TUNING[0]);
  const build = (f0) => {
    const notes = [];
    let m = TUNING[0] + f0;
    const pcs = semis.map((s) => mod12(tonicPc + s));
    while (notes.length < 12) { if (pcs.includes(mod12(m))) notes.push(m); m++; }
    return notes.map((n, i) => ({ s: i >> 1, f: n - TUNING[i >> 1] }));
  };
  let pos = build(start);
  if (pos.some((p) => p.f < 0)) pos = build(start + 12);
  if (pos.some((p) => p.f > maxFret) && pos.every((p) => p.f - 12 >= 0)) pos = pos.map((p) => ({ s: p.s, f: p.f - 12 }));
  return pos.some((p) => p.f > maxFret) ? null : pos;
}

// A four-fret position of any scale around a root on a given string (0 = low E, 1 = A).
export function scalePosition(tonicPc, semis, rootString, maxFret = 15) {
  let r = mod12(tonicPc - TUNING[rootString]);
  if (r < 1) r += 12;
  if (r + 2 > maxFret) r -= 12;
  const pcs = semis.map((s) => mod12(tonicPc + s));
  const lo = Math.max(0, r - 1), hi = r + 2;
  const pos = [];
  for (let s = 0; s < 6; s++) for (let f = lo; f <= hi; f++) if (pcs.includes(mod12(TUNING[s] + f))) pos.push({ s, f });
  return pos;
}
