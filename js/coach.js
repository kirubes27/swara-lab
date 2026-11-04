// Feedback: score a take against a reference contour, diagnose patterns, suggest fixes.
import { nearestSwara, wrapCents, median, percentile, SWARA_LONG, swaraLabel, swaraCents } from './music.js';

// Resample user frames [{t, c}] onto a 10 ms grid over [a, b].
function grid(frames, a, b, hop = 0.01) {
  const n = Math.max(0, Math.floor((b - a) / hop));
  const out = new Float32Array(n).fill(NaN);
  let j = 0;
  for (let i = 0; i < n; i++) {
    const t = a + i * hop;
    while (j + 1 < frames.length && frames[j + 1].t <= t) j++;
    let best = null, bd = 0.03;
    for (let k = Math.max(0, j - 1); k <= Math.min(frames.length - 1, j + 2); k++) {
      const d = Math.abs(frames[k].t - t);
      if (d < bd && !isNaN(frames[k].c)) { bd = d; best = frames[k]; }
    }
    if (best) out[i] = best.c;
  }
  return out;
}

function devOf(u, r, octaveFree) { const d = u - r; return octaveFree ? wrapCents(d) : d; }

// Core analysis shared by songs and exercises.
// refAt(t) -> cents rel Sa or NaN. frames: user [{t, c}] (cents rel Sa).
export function analyzeTake({ frames, refAt, start, end, tol = 35, octaveFree = true, tuning = 'et', rangeHi = null, rangeLo = null }) {
  const hop = 0.01;
  const n = Math.max(0, Math.floor((end - start) / hop));
  const R = new Float32Array(n), U = grid(frames, start, end, hop);
  for (let i = 0; i < n; i++) R[i] = refAt(start + i * hop);
  let refV = 0, both = 0, inTol = 0, userV = 0;
  const devs = [], absDevs = [];
  const perSwara = {};
  const refVals = [];
  for (let i = 0; i < n; i++) if (!isNaN(R[i])) refVals.push(R[i]);
  const p80 = percentile(refVals, 0.8), p20 = percentile(refVals, 0.2);
  const hiDev = [], loDev = [];
  // local movement of reference (for ornament / stability analysis)
  const W = 15; // 150 ms half window
  const localStd = (A, i) => {
    let s = 0, s2 = 0, m = 0;
    for (let k = i - W; k <= i + W; k++) { if (k < 0 || k >= n || isNaN(A[k])) continue; s += A[k]; s2 += A[k] * A[k]; m++; }
    if (m < W) return NaN;
    const mu = s / m; return Math.sqrt(Math.max(0, s2 / m - mu * mu));
  };
  let stableN = 0, stableWobble = 0, ornN = 0, ornRatio = 0;
  const wobbleArr = [];
  for (let i = 0; i < n; i++) {
    const r = R[i], u = U[i];
    if (!isNaN(u)) userV++;
    if (isNaN(r)) continue;
    refV++;
    if (isNaN(u)) continue;
    both++;
    const d = devOf(u, r, octaveFree);
    absDevs.push(Math.abs(d));
    if (Math.abs(d) <= tol) inTol++;
    if (Math.abs(d) < 250) {
      devs.push(d);
      if (r >= p80) hiDev.push(d);
      if (r <= p20) loDev.push(d);
    }
    if (i % 3 === 0) {
      const rs = localStd(R, i);
      if (!isNaN(rs)) {
        if (rs < 12) {
          const ns = nearestSwara(r, tuning);
          const key = ns.idx;
          const ps = perSwara[key] || (perSwara[key] = { sum: 0, abs: 0, n: 0 });
          if (Math.abs(d) < 80) { ps.sum += d; ps.abs += Math.abs(d); ps.n++; } // intonation tendency, not wrong notes
          // wobble: spread of user deviation on held notes
          const us = localStd(U, i);
          if (!isNaN(us)) { stableN++; stableWobble += us; wobbleArr.push(us); }
        } else if (rs > 35) {
          const us = localStd(U, i);
          if (!isNaN(us)) { ornN++; ornRatio += us / rs; }
        }
      }
    }
  }
  // timing lag: which shift of the user line best matches the reference?
  let bestLag = 0, bestErr = Infinity, zeroErr = Infinity;
  for (let lagF = -40; lagF <= 40; lagF += 2) {
    let e = 0, m = 0;
    for (let i = 0; i < n; i += 2) {
      const j = i + lagF; if (j < 0 || j >= n) continue;
      if (isNaN(R[i]) || isNaN(U[j])) continue;
      e += Math.min(300, Math.abs(devOf(U[j], R[i], octaveFree))); m++;
    }
    if (m < 50) continue;
    e /= m;
    if (lagF === 0) zeroErr = e;
    if (e < bestErr) { bestErr = e; bestLag = lagF * hop; }
  }
  // scooping: user starts well below at note onsets
  let scoopN = 0, onsets = 0;
  for (let i = 1; i < n - 20; i++) {
    const onset = (isNaN(R[i - 1]) && !isNaN(R[i])) || (!isNaN(R[i - 1]) && !isNaN(R[i]) && Math.abs(R[i] - R[i - 1]) > 80);
    if (!onset) continue;
    // reference must hold steady afterwards
    if (isNaN(R[i + 15]) || Math.abs(R[i + 15] - R[i]) > 40) continue;
    let early = [], late = [];
    for (let k = i; k < i + 8; k++) if (!isNaN(U[k])) early.push(devOf(U[k], R[k], octaveFree));
    for (let k = i + 12; k < i + 20; k++) if (!isNaN(U[k])) late.push(devOf(U[k], R[k], octaveFree));
    if (early.length < 3 || late.length < 3) continue;
    onsets++;
    if (median(early) < -70 && Math.abs(median(late)) < 50) scoopN++;
  }
  const accuracy = both ? inTol / both : 0;
  const coverage = refV ? Math.min(1, both / refV) : 0;
  const res = {
    accuracy, coverage,
    score: Math.round(100 * accuracy * Math.sqrt(coverage)),
    bias: devs.length ? median(devs) : 0,
    medAbs: absDevs.length ? median(absDevs) : NaN,
    hiBias: hiDev.length > 20 ? median(hiDev) : null,
    loBias: loDev.length > 20 ? median(loDev) : null,
    wobble: stableN ? median(wobbleArr) : null,
    ornRatio: ornN > 8 ? ornRatio / ornN : null,
    lag: bestErr < zeroErr * 0.85 ? bestLag : 0,
    scoop: onsets >= 3 ? scoopN / onsets : 0,
    perSwara, refVoicedSec: refV * hop, userVoicedSec: userV * hop,
    refHi: refVals.length ? percentile(refVals, 0.95) : null,
    refLo: refVals.length ? percentile(refVals, 0.05) : null,
  };
  res.tips = tipsFor(res, { tol, rangeHi, rangeLo });
  res.weak = weaknessVector(res);
  return res;
}

function weaknessVector(r) {
  const w = {};
  if (r.hiBias != null && r.hiBias < -25) w.highFlat = 1;
  if (r.wobble != null && r.wobble > 22) w.wobble = 1;
  if (r.ornRatio != null && r.ornRatio < 0.5) w.ornaments = 1;
  if (r.scoop > 0.35) w.scoop = 1;
  if (r.accuracy < 0.5) w.accuracy = 1;
  if (Math.abs(r.bias) > 20) w.bias = 1;
  return w;
}

export function swaraBiasText(perSwara, minN = 8) {
  const out = [];
  for (const [k, v] of Object.entries(perSwara)) {
    if (v.n < minN) continue;
    const b = v.sum / v.n;
    if (Math.abs(b) >= 18) out.push({ idx: +k, bias: b, n: v.n });
  }
  out.sort((a, b) => Math.abs(b.bias) - Math.abs(a.bias));
  return out;
}

function tipsFor(r, { tol, rangeHi }) {
  const tips = [];
  const c = (x) => `${x > 0 ? '+' : ''}${Math.round(x)}¢`;
  if (r.refVoicedSec < 0.8) return [{ title: 'Not enough melody here', detail: 'This stretch has very little sung melody. Pick a phrase that contains singing.', level: 'info' }];
  if (r.coverage < 0.45) tips.push({ title: 'Sing through the whole line', level: 'high',
    detail: `You sang about ${Math.round(r.coverage * 100)}% of the melody. Learn the words and tune separately first: play the line at 0.75× with the guide tone on, hum along, then add the words.`, drill: null });
  if (r.hiBias != null && r.hiBias < -25) tips.push({ title: `High notes are flat (${c(r.hiBias)})`, level: 'high', drill: 'fiveNote',
    detail: 'On the highest notes of this line you fall short of the pitch. Common causes: not enough breath support, or reaching up with the throat and jaw. Try the line on a lip trill or "ng" hum first, keep the jaw loose, and think of the high note as forward and light, not up and loud. If it still strains, transpose down 1–2 semitones and work back up over the weeks.' });
  if (rangeHi != null && r.refHi != null && r.refHi > rangeHi + 50) tips.push({ title: 'This line goes above your comfortable top', level: 'high',
    detail: 'The reference peaks above the highest comfortable note from your range test. Pushing up there is how voices get strained. Use transpose, or sing those notes an octave lower for now.' });
  if (r.loBias != null && r.loBias > 30) tips.push({ title: `Low notes drift sharp (${c(r.loBias)})`, level: 'mid',
    detail: 'Low notes need a relaxed, open throat. Let the larynx sit low, sing softer, and don\'t press. Practising Sa sadhana in the lower octave (mandra) helps.' , drill: 'saHold' });
  if (Math.abs(r.bias) > 20 && !(r.hiBias != null && r.hiBias < -25 && r.bias < 0)) tips.push({ title: r.bias < 0 ? `Overall slightly flat (${c(r.bias)})` : `Overall slightly sharp (${c(r.bias)})`, level: 'mid', drill: 'saHold',
    detail: r.bias < 0 ? 'Across the line you sit a little under the pitch. Keep the tanpura on and listen for Sa. Flatness often comes from low energy or a tired voice, so give the line a little more breath and a brighter vowel ("aa" towards "eh").' : 'You tend to overshoot. This is usually tension or pushing. Sing a little softer and keep the shoulders and jaw relaxed.' });
  if (r.wobble != null && r.wobble > 22) tips.push({ title: 'Held notes are unsteady', level: 'mid', drill: 'saHold',
    detail: `Your pitch wavers by about ±${Math.round(r.wobble)}¢ on notes that should be steady. Practise holding single notes over the tanpura (Sa sadhana) with a slow, steady exhale. Steadiness comes from breath control, not from the throat.` });
  if (r.ornRatio != null && r.ornRatio < 0.5) tips.push({ title: 'Ornaments are coming out straight', level: 'mid', drill: 'gamak',
    detail: 'Where the original has gamakas, kan swaras or murkis, your line is much flatter (you move about ' + Math.round(r.ornRatio * 100) + '% as much). Slow the song to 0.5–0.6×, watch the shape of the curve, and copy the movement on "aa" before adding words.' });
  if (r.ornRatio != null && r.ornRatio > 1.8) tips.push({ title: 'Extra movement where the melody is simple', level: 'low',
    detail: 'You are adding wobble or slides where the original is clean. Aim to land straight on each note.' });
  if (r.scoop > 0.35) tips.push({ title: 'Scooping into notes', level: 'mid', drill: 'pitchMatch',
    detail: 'You often start below the note and slide up into it. Hear the note in your head before you sing (pre-hearing), then start the sound right on it. The pitch-match game trains exactly this.' });
  if (Math.abs(r.lag) >= 0.08) tips.push({ title: r.lag > 0 ? `You're about ${Math.round(r.lag * 1000)} ms behind` : `You're about ${Math.round(-r.lag * 1000)} ms ahead`, level: 'low',
    detail: r.lag > 0 ? 'Either you are following the singer instead of singing with them (learn the line until you can anticipate it), or your headphones add delay. Bluetooth headphones often add 150–250 ms. If it\'s always the same, set the latency in Settings.' : 'You rush ahead of the beat. Listen for the rhythm of the words.' });
  if (r.accuracy >= 0.8 && r.coverage >= 0.75) tips.unshift({ title: 'Solid take', level: 'good',
    detail: 'Over 80% in tune. Next step: try "Song muted" mode, or the Blind mode (no live line) so you rely on your ear instead of the screen.' });
  if (!tips.length) tips.push({ title: 'Keep looping this phrase', level: 'info', detail: 'Repeat the phrase until you get two good takes in a row, then move on. Short, focused repetitions beat long run-throughs.' });
  return tips;
}

// ---------------------------------------------------------------------------
// Transcription: approximate sargam of a melody stretch (cents rel Sa via relAt).
export function transcribe(relAt, start, end, { tuning = 'et', notation = 'hindustani' } = {}) {
  const hop = 0.01;
  const raw = [];
  for (let t = start; t < end; t += hop) raw.push(relAt(t));
  // running median (±70 ms) gives the "intended" note through fast oscillations
  const sm = raw.map((v, i) => {
    if (isNaN(v)) return NaN;
    const w = [];
    for (let k = Math.max(0, i - 7); k <= Math.min(raw.length - 1, i + 7); k++) if (!isNaN(raw[k])) w.push(raw[k]);
    return median(w);
  });
  const notes = [];
  let cur = null, gap = 0;
  for (let i = 0; i < raw.length; i++) {
    const t = start + i * hop, r = sm[i];
    if (isNaN(r)) { gap++; if (cur && gap > 4) { notes.push(cur); cur = null; } continue; }
    gap = 0;
    const ns = nearestSwara(r, tuning);
    let key = ns.idx + 12 * ns.octave;
    if (cur && Math.abs(r - cur.nom) < 75) key = cur.key; // hysteresis around the current swara
    if (!cur || key !== cur.key) {
      if (cur) notes.push(cur);
      const idx = ((key % 12) + 12) % 12, oct = Math.floor(key / 12);
      cur = { key, idx, oct, t, dur: 0, nom: swaraCents(idx, oct, tuning), vals: [] };
    }
    cur.dur = t - cur.t + hop; cur.vals.push(raw[i]);
  }
  if (cur) notes.push(cur);
  // turn into tokens: long notes, short ones become kan / gamak / murki
  const toks = [];
  const lab = (n) => swaraLabel(n.idx, n.oct, notation === 'western' ? 'hindustani' : notation);
  let pendingKan = null, glideFrom = null;
  const pushLong = (n, text) => {
    if (glideFrom) { // meend landing: join onto the token we glided from
      glideFrom.text += '~' + text.replace(/^\([^)]*\)/, '');
      glideFrom.dur = n.t + n.dur - glideFrom.t;
      glideFrom = null;
      return;
    }
    toks.push({ t: n.t, dur: n.dur, idx: n.idx, oct: n.oct, text });
  };
  for (let i = 0; i < notes.length; i++) {
    const n = notes[i];
    if (n.dur >= 0.09) {
      // oscillation inside a held note?
      // oscillation = repeated swings of > ~35 cents in the middle of the note (ignores entry/exit slides)
      const v = n.vals.filter((x) => !isNaN(x)).slice(6, -6);
      let ext = 0, dir = 0, anchor = v[0];
      for (let k = 1; k < v.length; k++) {
        const d = v[k] - anchor;
        if (Math.abs(d) > 35 && Math.sign(d) !== dir) { ext++; dir = Math.sign(d); anchor = v[k]; }
        else if (dir && Math.sign(v[k] - anchor) === dir) anchor = v[k];
      }
      const amp = v.length > 8 ? percentile(v, 0.9) - percentile(v, 0.1) : 0;
      let text = lab(n) + (ext >= 3 && amp > 70 ? '*' : '');
      if (pendingKan && pendingKan.key !== n.key) text = '(' + lab(pendingKan) + ')' + text;
      pendingKan = null;
      pushLong(n, text);
    } else {
      // run of short notes moving one way = meend (glide)
      let j = i, dirn = 0;
      while (j + 1 < notes.length && notes[j + 1].dur < 0.14 && notes[j + 1].t - (notes[j].t + notes[j].dur) < 0.05) {
        const s = Math.sign(notes[j + 1].key - notes[j].key);
        if (dirn && s !== dirn) break;
        dirn = s; j++;
      }
      const prevTok = toks[toks.length - 1];
      const from = prevTok && prevTok.t + prevTok.dur > n.t - 0.06 ? prevTok : null;
      const startKey = from ? from.idx + 12 * from.oct : n.key;
      const land = notes[j + 1] && notes[j + 1].t - (notes[j].t + notes[j].dur) < 0.05 ? notes[j + 1] : notes[j];
      const runDur = notes[j].t + notes[j].dur - n.t;
      if (j > i && runDur >= 0.1 && Math.abs(land.key - startKey) >= 3 && Math.sign(land.key - startKey) === Math.sign(notes[j].key - n.key || dirn)) {
        if (from) glideFrom = from; else { toks.push({ t: n.t, dur: n.dur, idx: n.idx, oct: n.oct, text: lab(n) }); glideFrom = toks[toks.length - 1]; }
        if (land === notes[j]) { pushLong(land, lab(land)); }
        i = j; // landing note (if long) is handled next iteration
        continue;
      }
      const next = notes[i + 1];
      const prevT = toks[toks.length - 1];
      // a short note lying between its neighbours is just a passing tone of the slide: ignore it
      if (prevT && next) {
        const pk = prevT.idx + 12 * prevT.oct;
        if (n.key > Math.min(pk, next.key) && n.key < Math.max(pk, next.key)) continue;
      }
      if (next && next.dur >= 0.09 && next.t - (n.t + n.dur) < 0.05) pendingKan = n;
      else if (prevT && n.dur >= 0.05 && !prevT.text.endsWith('*')) prevT.text += '*';
    }
  }
  // collapse repeated identical notes separated by tiny gaps
  const out = [];
  for (const t of toks) {
    const p = out[out.length - 1];
    if (p && p.text === t.text && t.t - (p.t + p.dur) < 0.06) { p.dur = t.t + t.dur - p.t; continue; }
    out.push({ ...t });
  }
  return out;
}

// How to transpose a song melody (Hz percentiles) into the singer's range.
export function fitToRange(p5Hz, p95Hz, lowMidi, highMidi) {
  if (!p5Hz || lowMidi == null || highMidi == null) return null;
  const lo = 69 + 12 * Math.log2(p5Hz / 440), hi = 69 + 12 * Math.log2(p95Hz / 440);
  const opts = [];
  for (let oct = -1; oct <= 1; oct++) for (let st = -6; st <= 6; st++) {
    const s = st + 12 * oct;
    const a = lo + s, b = hi + s;
    const over = Math.max(0, b - (highMidi - 1)) + Math.max(0, (lowMidi + 1) - a);
    opts.push({ st, oct, over, cost: over * 4 + Math.abs(st) * 0.6 + Math.abs(oct) * 1.5 });
  }
  opts.sort((x, y) => x.cost - y.cost);
  return { best: opts[0], asIs: opts.find((o) => o.st === 0 && o.oct === 0), span: hi - lo };
}

export function describeSwaraBias(list, notation) {
  return list.map((x) => `${SWARA_LONG[x.idx]} ${x.bias > 0 ? 'sharp' : 'flat'} by ${Math.round(Math.abs(x.bias))}¢`).join(' · ');
}
