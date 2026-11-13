// Lyrics: finds time-synced lyrics for the song in LRCLIB (a free, open lyrics database), lines them
// up with the melody guide, and shows the line being sung next to the pitch lane.
// Lyrics without timestamps can be synced by tapping along once; pasted lyrics work too.
import { h, toast, menu, sheet, fmtTime } from './ui.js';
import { icon } from './icons.js';
import { idbGet, idbPut, idbDel, upsertSong } from './store.js';

const API = 'https://lrclib.net/api';

// ---- finding the right lyrics -------------------------------------------------------------
const JUNK_BRACKET = /official|video|audio|lyric|visuali[sz]er|\bmv\b|\bhd\b|\bhq\b|\b4k\b|full song|remaster|explicit|out now|teaser|trailer|\bfrom\b|\bost\b|soundtrack|letra|song/i;
const JUNK_WORDS = /\b(official (music |lyric )?video|official audio|lyric(al)? video|lyrical|lyrics?|video song|full video( song)?|full song|music video|official|video|audio|visuali[sz]er|hd|hq|4k|mv)\b/gi;
const STOP = new Set(['the', 'a', 'an', 'of', 'and', 'from', 'feat', 'ft', 'by', 'in', 'on', 'to', 'la', 'le', 'de', 'el']);
const VARIANTS = ['instrumental', 'karaoke', 'reprise', 'remix', 'sped up', 'slowed', 'lofi', 'lo-fi', '8d', 'cover', 'live', 'acoustic', 'trending', 'flip', 'version', 'mashup', 'unplugged', 'reverb'];

const decode = (s) => { const t = document.createElement('textarea'); t.innerHTML = s || ''; return t.value; };
export function tokens(s) {
  return (s || '').toLowerCase().normalize('NFKD').replace(/[̀-ͯ]/g, '').match(/[\p{L}\p{N}]+/gu)?.filter((w) => w.length > 1 && !STOP.has(w)) || [];
}

// Search queries to try for a video or file title, best first.
export function titleQueries(raw) {
  let t = decode(raw).normalize('NFKC');
  t = t.replace(/[\u{1F000}-\u{1FAFF}\u{2600}-\u{27BF}\u{FE0F}]/gu, ' ');
  t = t.replace(/^\s*\d{1,2}[\s.\-_)]+(?=\D)/, '').replace(/_/g, ' ');            // "01 - Song.mp3"
  t = t.replace(/[(\[【{]([^)\]】}]*)[)\]】}]/g, (m, inner) => (JUNK_BRACKET.test(inner) ? ' ' : m));
  t = t.replace(/\s+(ft|feat|featuring)\.?\s+[^-|(\[]*/i, ' ').replace(/#\S+/g, ' ');
  const parts = t.split(/\s+[-–—:•]\s+|\s*[|｜]\s*/).map((s) => s.replace(JUNK_WORDS, ' ').replace(/\s+/g, ' ').trim()).filter(Boolean);
  const bare = (s) => s.replace(/[(\[【{][^)\]】}]*[)\]】}]/g, ' ').replace(/\s+/g, ' ').trim();
  const qs = [];
  const add = (q) => { q = (q || '').trim(); if (q.length > 1 && !qs.includes(q)) qs.push(q); };
  add(parts.join(' '));
  if (parts.length >= 2) { add(bare(parts[1]) + ' ' + bare(parts[0])); add(bare(parts[0])); add(bare(parts[1])); }
  add(bare(parts.join(' ')));
  return { queries: qs.slice(0, 4), words: tokens(parts.join(' ')) };
}

function scoreHit(x, words, duration) {
  if (x.instrumental || (!x.syncedLyrics && !x.plainLyrics)) return -Infinity;
  const tn = tokens(x.trackName), an = tokens(x.artistName);
  let s = 0;
  if (tn.length) s += (4 * tn.filter((w) => words.includes(w)).length) / tn.length;      // the song name is in the title
  if (an.length) s += (1.5 * an.filter((w) => words.includes(w)).length) / an.length;    // so is the artist
  if (x.syncedLyrics) s += 2.5;
  const name = `${x.trackName} ${x.albumName || ''}`.toLowerCase(), q = words.join(' ');
  let pen = 0;
  for (const v of VARIANTS) if (name.includes(v) && !q.includes(v)) pen += 3;              // a remix or karaoke cut is a different timeline
  s -= Math.min(4, pen);
  if (duration > 30 && x.duration) { const d = Math.abs(x.duration - duration); s += d < 3 ? 1.5 : d < 12 ? 0.5 : -Math.min(3, d / 20); }
  return s;
}

async function getJSON(url, ms = 12000) {
  const ac = new AbortController(), tm = setTimeout(() => ac.abort(), ms);
  try {
    const r = await fetch(url, { signal: ac.signal });
    if (!r.ok) throw new Error('HTTP ' + r.status);
    return await r.json();
  } finally { clearTimeout(tm); }
}

// Is (nearly) all of the song's name in the title? One shared word isn't enough to use lyrics
// unasked ('Mix Test' isn't 'Fight Test').
function nameCovered(x, words) {
  const tn = tokens(x.trackName);
  return tn.length > 0 && tn.filter((w) => words.includes(w)).length / tn.length >= 0.6;
}

// All candidates for a title, best first: [{score, hit, sure}]
export async function searchLyrics(title, duration = 0) {
  const { queries, words } = titleQueries(title);
  const seen = new Map();
  let failures = 0;
  for (const q of queries) {
    let list;
    try { list = await getJSON(`${API}/search?q=${encodeURIComponent(q)}`); } catch { failures++; continue; }
    for (const x of list || []) if (!seen.has(x.id)) seen.set(x.id, { score: scoreHit(x, words, duration), hit: x, sure: nameCovered(x, words) });
    const best = Math.max(-Infinity, ...[...seen.values()].map((v) => v.score));
    if (best >= 6) break; // a good synced match; no need to try more queries
  }
  if (failures === queries.length) throw new Error('offline');
  return [...seen.values()].filter((v) => isFinite(v.score)).sort((a, b) => b.score - a.score);
}

export function toLyrics(x, source = 'lrclib') {
  const lines = x.syncedLyrics ? parseLRC(x.syncedLyrics) : [];
  const plain = (x.plainLyrics || (x.syncedLyrics ? lines.map((l) => l.text).join('\n') : '')).split(/\r?\n/).map((s) => s.trim());
  const synced = lines.filter((l) => l.text).length > 3;
  return { source, id: x.id, track: decode(x.trackName), artist: decode(x.artistName), duration: x.duration || 0, synced, lines: synced ? lines : null, plain };
}

export function parseLRC(text) {
  const out = [];
  let offset = 0;
  for (const raw of text.split(/\r?\n/)) {
    const off = raw.match(/^\[offset:\s*([+-]?\d+)\]/i);
    if (off) { offset = +off[1] / 1000; continue; }
    const tags = [...raw.matchAll(/\[(\d{1,3}):(\d{1,2}(?:[.:]\d{1,3})?)\]/g)];
    if (!tags.length) continue;
    const txt = raw.replace(/\[[^\]]*\]/g, '').replace(/<\d+:\d+(?:[.:]\d+)?>/g, '').replace(/\s+/g, ' ').trim();
    for (const m of tags) out.push({ t: +m[1] * 60 + parseFloat(m[2].replace(':', '.')) - offset, text: txt });
  }
  return out.sort((a, b) => a.t - b.t);
}

// ---- lining lyrics up with the melody guide ---------------------------------------------------
// Where the singing starts again after a pause, in song time.
function vocalOnsets(mel, minGap = 0.22) {
  const c = mel.cents, gapN = Math.round(minGap / mel.hop), out = [];
  let silent = gapN;
  for (let i = 0; i < c.length; i++) {
    if (isNaN(c[i])) { silent++; continue; }
    if (silent >= gapN) out.push(mel.t0 + i * mel.hop);
    silent = 0;
  }
  return out;
}
// The time shift that puts the most lyric lines on a vocal entry. Videos often have an intro the
// album version lacks, so a constant shift fixes most mismatches.
export function alignLyrics(lines, mel) {
  const L = lines.filter((l) => l.text).map((l) => l.t);
  if (L.length < 4 || !mel) return null;
  const O = vocalOnsets(mel);
  if (O.length < 4) return null;
  const sig = 0.3;
  const score = (d) => {
    let s = 0;
    for (const t of L) {
      const x = t + d;
      let lo = 0, hi = O.length - 1;
      while (lo < hi) { const m = (lo + hi) >> 1; if (O[m] < x) lo = m + 1; else hi = m; }
      let best = Infinity;
      for (const k of [lo - 1, lo]) if (k >= 0 && k < O.length) best = Math.min(best, Math.abs(O[k] - x));
      s += Math.exp(-(best * best) / (2 * sig * sig));
    }
    return s / L.length;
  };
  let bd = 0, bs = -1;
  for (let d = -45; d <= 45; d += 0.1) { const s = score(d); if (s > bs) { bs = s; bd = d; } }
  for (let d = bd - 0.1; d <= bd + 0.1; d += 0.01) { const s = score(d); if (s > bs) { bs = s; bd = d; } }
  const s0 = score(0);
  if (bs < 0.3 || bs < s0 * 1.15) return { offset: 0, conf: s0 }; // only move when clearly better
  return { offset: Math.round(bd * 100) / 100, conf: bs };
}

// Line by line: each lyric line is matched, in order, to a place where the singing starts, letting
// the tempo drift (a cover, a live take, an extra bar, an intro or an ad) while keeping the gaps
// between lines roughly in proportion. Returns a song time for every non-empty line, or null.
export function alignLines(lines, mel, off = 0) {
  const L = lines.filter((l) => l.text).map((l) => l.t), n = L.length;
  if (n < 4 || !mel) return null;
  const c = mel.cents, gapN = Math.round(0.22 / mel.hop), O = [], G = [];
  let silent = 1e9;
  for (let i = 0; i < c.length; i++) {
    if (isNaN(c[i])) { silent++; continue; }
    if (silent >= gapN) { O.push(mel.t0 + i * mel.hop); G.push(Math.min(silent, 1e4) * mel.hop); }
    silent = 0;
  }
  if (O.length < 4) return null;
  const lb = (x) => { let lo = 0, hi = O.length; while (lo < hi) { const m = (lo + hi) >> 1; if (O[m] < x) lo = m + 1; else hi = m; } return lo; };
  const W = 25, SKIP = 1, strength = (p) => Math.min(1, G[p] / 0.6); // a long pause before = likely a new line
  const states = L.map((t, i) => {
    const x = t + off, out = [];
    for (let p = lb(x - W); p < lb(x + W); p++) out.push({ p, c: Infinity, from: null });
    return out;
  });
  for (let i = 0; i < n; i++) for (const st of states[i]) {
    st.c = i * SKIP + (0.5 * Math.abs(O[st.p] - (L[i] + off))) / W - strength(st.p); // first matched line
    for (let k = 1; k <= 3 && i - k >= 0; k++) for (const pr of states[i - k]) {
      if (!isFinite(pr.c) || O[pr.p] > O[st.p] - 0.3) continue;
      const dl = Math.max(0.05, L[i] - L[i - k]), ds = O[st.p] - O[pr.p], ratio = ds / dl;
      let step;
      if (ratio > 0.7 && ratio < 1.45) step = 6 * Math.abs(Math.log(ratio));   // same section, tempo a little different
      else if (ds - dl > 1 && ds - dl < 40) step = 2.5;                        // an extra bar, intro or break in this version
      else continue;
      const cost = pr.c + step + (k - 1) * SKIP - strength(st.p);
      if (cost < st.c) { st.c = cost; st.from = { i: i - k, st: pr }; }
    }
  }
  let end = null, endI = -1;
  for (let i = Math.max(0, n - 3); i < n; i++) for (const st of states[i]) { const c2 = st.c + (n - 1 - i) * SKIP; if (!end || c2 < end.c2) { end = { st, c2 }; endI = i; } }
  if (!end) return null;
  const matched = new Map();
  for (let cur = { i: endI, st: end.st }; cur; cur = cur.st.from) matched.set(cur.i, O[cur.st.p]);
  if (matched.size < Math.max(4, n * 0.5)) return null; // too little agreement: keep the simple shift
  const idx = [...matched.keys()].sort((a, b) => a - b), times = new Array(n);
  for (let i = 0; i < n; i++) {
    if (matched.has(i)) { times[i] = matched.get(i); continue; }
    const a = idx.filter((k) => k < i).pop(), b = idx.find((k) => k > i);
    if (a != null && b != null) times[i] = matched.get(a) + ((matched.get(b) - matched.get(a)) * (L[i] - L[a])) / (L[b] - L[a]);
    else { const k = a != null ? a : b; times[i] = L[i] + (matched.get(k) - L[k]); }
  }
  return times.map((t) => Math.round(t * 100) / 100);
}
// How well a set of line times sits on vocal entries (0..1): the yardstick for picking a timing.
export function timingFit(times, mel) {
  const c = mel.cents, gapN = Math.round(0.22 / mel.hop), O = [], G = [];
  let silent = 1e9;
  for (let i = 0; i < c.length; i++) { if (isNaN(c[i])) { silent++; continue; } if (silent >= gapN) { O.push(mel.t0 + i * mel.hop); G.push(silent * mel.hop); } silent = 0; }
  if (!O.length || !times.length) return 0;
  let s = 0;
  for (const t of times) {
    let lo = 0, hi = O.length - 1;
    while (lo < hi) { const m = (lo + hi) >> 1; if (O[m] < t) lo = m + 1; else hi = m; }
    let best = 0;
    for (const k of [lo - 1, lo]) if (k >= 0 && k < O.length) { const d = O[k] - t; best = Math.max(best, Math.exp(-(d * d) / (2 * 0.25 * 0.25)) * Math.min(1, G[k] / 0.6)); }
    s += best;
  }
  return s / times.length;
}

// ---- panel ---------------------------------------------------------------------------------------
export class LyricsPanel {
  // studio: the SongStudio (player time, melody, seeking)
  constructor(el, studio) {
    this.el = el; this.s = studio; this.state = 'idle'; this.data = null; this.cur = -2; this.userScroll = 0;
    el.classList.add('lyrics');
    this.render();
  }
  // Timing for the current source (the video and a recorded copy can have different timelines):
  // { offset, times: [song time per non-empty line] | null, user: true when set by hand }
  get timing() {
    if (!this.song) return { offset: 0, times: null };
    const song = this.song, all = (song.lyricsTiming = song.lyricsTiming || {});
    if ('lyricsOffset' in song || 'lyricsOffsetUser' in song) {
      // from the version with one shift for every source: keep a shift set by hand for both sources
      if (song.lyricsOffsetUser) for (const src of ['youtube', 'audio']) if (!all[src]) all[src] = { offset: song.lyricsOffset || 0, times: null, user: true };
      delete song.lyricsOffset; delete song.lyricsOffsetUser;
    }
    return all[this.s.source] || (all[this.s.source] = { offset: 0, times: null, user: false });
  }
  setTiming(patch) { Object.assign(this.timing, patch); this.ver = (this.ver || 0) + 1; upsertSong(this.song); }
  get offset() { return this.timing.offset || 0; }
  // Display lines in song time: [{t, end, text}] without the empty "break" lines.
  get lines() {
    if (this.state === 'tap') return this.tapLines;
    const d = this.data;
    if (!d || !d.lines) return null;
    const key = d.lines.length + ':' + this.s.source + ':' + (this.ver || 0);
    if (this._linesFor === d && this._key === key) return this._lines;
    const T = this.timing, src = d.lines, out = [];
    let k = 0;
    for (let i = 0; i < src.length; i++) {
      if (!src[i].text) continue;
      const t = T.times && T.times.length > k ? T.times[k] : src[i].t + (T.offset || 0);
      out.push({ t, end: Infinity, text: src[i].text, lrc: src[i].t, gapAfter: src[i + 1] && !src[i + 1].text ? src[i + 1].t - src[i].t : null });
      k++;
    }
    for (let i = 0; i < out.length; i++) { // a line lasts until the next one, or until an instrumental break
      const next = out[i + 1] ? out[i + 1].t : out[i].t + 6;
      out[i].end = out[i].gapAfter != null ? Math.min(next, out[i].t + out[i].gapAfter) : next;
    }
    this._linesFor = d; this._key = key; this._lines = out;
    return out;
  }
  // Lyric text sung between two song times (for the list of lines and the coach).
  textBetween(a, b) {
    const L = this.lines; if (!L) return '';
    return L.filter((l) => l.t >= a - 0.6 && l.t < b - 0.25).map((l) => l.text).join(' / ');
  }

  async load(song, { search = true } = {}) {
    this.song = song; this.data = null; this.cur = -2; this.picking = false; this.removed = false;
    const token = (this.token = (this.token || 0) + 1);
    if (!song) { this.state = 'idle'; this.render(); return; }
    this.state = 'loading'; this.render();
    const saved = await idbGet('melody', song.id + ':lyrics').catch(() => null);
    if (token !== this.token) return;
    if (saved) return this.use(saved, { save: false });
    const placeholder = !song.title || song.untitled || (/^YouTube [\w-]{11}$/.test(song.title) && !song.titleFetched);
    if (!search || song.lyricsTried || placeholder) { this.state = 'none'; this.render(); return; }
    await this.autoSearch(token);
  }
  async autoSearch(token = this.token) {
    const song = this.song;
    this.state = 'loading'; this.render();
    try {
      const res = await searchLyrics(song.title, this.s.player ? this.s.player.duration() : 0);
      if (token !== this.token) return;
      song.lyricsTried = true; upsertSong(song);
      const best = res.find((r) => r.sure && r.score >= 2.5);
      if (!best) { this.state = 'none'; this.render(); return; }
      this.use(toLyrics(best.hit));
    } catch {
      if (token !== this.token) return;
      this.state = 'error'; this.render();
    }
  }
  use(d, { save = true } = {}) {
    this.data = d; this.cur = -2; this.removed = false; this.picking = false; this.ver = (this.ver || 0) + 1;
    if (save) {
      idbPut('melody', this.song.id + ':lyrics', d);
      this.song.lyricsTiming = {}; delete this.song.lyricsOffset; delete this.song.lyricsOffsetUser;
      upsertSong(this.song); // new lyrics: time them afresh for every source
    }
    this.state = d.synced ? 'synced' : (d.plain && d.plain.some(Boolean) ? 'plain' : 'none');
    if (d.synced) this.realign();
    this.render();
    this.s.onLyrics && this.s.onLyrics();
  }
  // Called when the melody guide appears or changes.
  // Time the lyrics to this source's melody guide (once per source, unless set by hand).
  realign() {
    const d = this.data, mel = this.s.mel, T = this.timing;
    if (!d || !d.synced || !mel || T.user || T.auto || d.source === 'tap') return;
    const r = alignLyrics(d.lines, mel), off = r ? r.offset : 0;
    let times = alignLines(d.lines, mel, off);
    if (times) { // keep the simple shift unless line-by-line timing clearly sits better on the singing
      const shifted = d.lines.filter((l) => l.text).map((l) => l.t + off);
      if (timingFit(times, mel) < timingFit(shifted, mel) + 0.08) times = null;
    }
    this.setTiming({ offset: off, times, auto: true });
    this.cur = -2; this.render();
    this.s.onLyrics && this.s.onLyrics();
  }
  // The melody guide was rebuilt: time the lyrics again (unless they were set by hand).
  invalidate(source = this.s.source) {
    const T = this.song && this.song.lyricsTiming && this.song.lyricsTiming[source];
    if (T && !T.user) { delete this.song.lyricsTiming[source]; this.ver = (this.ver || 0) + 1; upsertSong(this.song); }
  }
  shiftAll(dt, from = 0) {
    const L = this.lines; if (!L) return;
    const times = L.map((l, i) => (i >= from ? l.t + dt : l.t));
    for (let k = from - 1; k >= 0; k--) { // earlier lines must still come before it
      const gap = Math.max(0.5, (L[k + 1].lrc ?? L[k + 1].t) - (L[k].lrc ?? L[k].t));
      if (times[k] > times[k + 1] - 0.3) times[k] = times[k + 1] - gap; else break;
    }
    this.setTiming({ times: times.map((t) => Math.round(t * 100) / 100), user: true });
    this.cur = -2; this.tick(this.s.player ? this.s.player.time() : 0, true);
    this.s.onLyrics && this.s.onLyrics();
  }
  nudge(d) {
    this.shiftAll(d);
    toast(`Lyrics ${d < 0 ? 'earlier' : 'later'} by ${Math.abs(d)} s`, 'info', 1600);
  }
  // "This is the line being sung now": everything from that line on moves to match.
  adjustTo(i) {
    const L = this.lines; if (!L || !L[i] || !this.s.player) return;
    const now = this.s.player.time() - 0.25; // allow for reaction time
    this.shiftAll(now - L[i].t, i);
    this.picking = false; this.render();
    toast('Lyrics lined up from that line on.', 'good', 2200);
  }

  // ---- per-frame update ----
  tick(t, force = false) {
    const L = this.lines;
    if (!L || !this.body) return;
    let i = -1;
    if (this.state === 'tap') i = this.tapI;
    else {
      let lo = 0, hi = L.length - 1;
      while (lo <= hi) { const m = (lo + hi) >> 1; if (L[m].t <= t + 0.45) { i = m; lo = m + 1; } else hi = m - 1; }
      if (i >= 0 && t > L[i].end + 0.3) i = -1; // an instrumental break after the line
    }
    if (i === this.cur && !force) return;
    this.cur = i;
    const kids = this.body.children;
    for (let k = 0; k < kids.length; k++) {
      const d = k - i;
      kids[k].className = 'ly-line' + (d === 0 ? ' cur' : Math.abs(d) === 1 && i >= 0 ? ' near' : k < i ? ' past' : '');
    }
    if (i >= 0 && kids[i] && performance.now() - this.userScroll > 3500) {
      const box = this.body, el = kids[i];
      const y = el.offsetTop - box.clientHeight * 0.32;
      box.scrollTo({ top: Math.max(0, y), behavior: force ? 'auto' : 'smooth' });
      this.autoScrollAt = performance.now();
    }
  }

  // ---- rendering ----
  render() {
    const el = this.el; el.innerHTML = '';
    this.body = null;
    el.classList.toggle('tapping', this.state === 'tap');
    el.classList.toggle('picking', !!this.picking && this.state === 'synced');
    el.hidden = this.state === 'idle';
    if (this.state === 'idle') return;
    const head = h('div', { class: 'ly-head' }, h('span', { class: 'ly-label' }, 'Lyrics'));
    const more = h('button', { class: 'icon-btn sm', 'aria-label': 'Lyrics options', title: 'Lyrics options', onclick: (e) => this.openMenu(e.currentTarget) }, icon('more', 18));
    if (this.state === 'plain') head.append(h('button', { class: 'btn small soft', title: 'Play the song and tap as each line starts', onclick: () => this.startTap() }, 'Sync'));
    if (this.state === 'synced') {
      if (this.picking) head.append(h('span', { class: 'ly-hint' }, 'Tap the line being sung now'));
      head.append(h('button', { class: 'btn small soft' + (this.picking ? ' on' : ''), title: 'Lyrics out of step? Tap this, then tap the line you hear right now', 'aria-pressed': String(!!this.picking), onclick: () => { this.picking = !this.picking; this.render(); } }, this.picking ? 'Cancel' : 'Adjust'));
    }
    if (this.state === 'tap') head.append(h('span', { class: 'ly-hint' }, 'Tap as each line starts'));
    head.append(more);
    el.append(head);
    if (this.state === 'loading') { el.append(h('div', { class: 'ly-skel' }, h('i'), h('i'), h('i'), h('i'))); return; }
    if (this.state === 'none' || this.state === 'error') {
      el.append(h('div', { class: 'ly-empty' },
        h('p', {}, this.state === 'error' ? 'Couldn\'t reach the lyrics library.' : this.removed ? 'Lyrics removed.' : this.song && this.song.untitled ? 'Name the song to look up its lyrics, or paste them.' : 'No lyrics found.'),
        h('div', { class: 'row center' },
          h('button', { class: 'btn small', onclick: () => this.openSearch() }, icon('search', 14), 'Search'),
          h('button', { class: 'btn small', onclick: () => this.openPaste() }, 'Paste'))));
      return;
    }
    const body = (this.body = h('div', { class: 'ly-scroll' + (this.state === 'plain' ? ' plain' : '') }));
    body.addEventListener('wheel', () => (this.userScroll = performance.now()), { passive: true });
    body.addEventListener('touchmove', () => (this.userScroll = performance.now()), { passive: true });
    if (this.state === 'plain') {
      for (const line of this.data.plain) body.append(h('div', { class: 'ly-line' + (line ? '' : ' gap') }, line || ' '));
    } else {
      const L = this.lines;
      L.forEach((l, k) => body.append(h('button', {
        class: 'ly-line', title: fmtTime(l.t),
        onclick: () => {
          if (this.state === 'tap') return;
          if (this.picking) { this.adjustTo(k); return; }
          this.userScroll = 0; this.s.seekTo(Math.max(0, l.t - 0.3));
        },
      }, l.text)));
    }
    el.append(body);
    if (this.state === 'tap') {
      el.append(h('div', { class: 'ly-tapbar' },
        h('button', { class: 'btn small', onclick: () => this.tapUndo() }, 'Undo'),
        h('button', { class: 'btn small primary', onclick: () => this.tap() }, 'Tap', h('kbd', {}, 'Space')),
        h('button', { class: 'btn small ghost', title: 'Keep the lines tapped so far', onclick: () => this.endTap(true) }, 'Done'),
        h('button', { class: 'btn small ghost', onclick: () => this.endTap(false) }, 'Cancel')));
    }
    this.cur = -2;
    this.tick(this.s.player ? this.s.player.time() : 0, true);
  }

  openMenu(anchor) {
    const d = this.data;
    const src = d ? (d.source === 'lrclib' ? `${d.track} · ${d.artist} (LRCLIB)` : d.source === 'tap' ? 'Synced by you' : 'Pasted') : null;
    menu(anchor, [
      src ? { head: src } : null,
      this.state === 'synced' ? { label: 'Line up with what I hear', sub: 'Then tap the line being sung now', icon: 'target', onclick: () => { this.picking = true; this.render(); } } : null,
      this.state === 'synced' ? { label: 'Earlier', sub: 'All lines show up sooner', icon: 'prev', keepOpen: true, onclick: () => this.nudge(-0.25) } : null,
      this.state === 'synced' ? { label: 'Later', sub: 'All lines show up later', icon: 'next', keepOpen: true, onclick: () => this.nudge(0.25) } : null,
      this.state === 'synced' && this.timing.user && d.source !== 'tap' ? { label: 'Time automatically again', sub: 'Undo your adjustments', icon: 'sparkle', onclick: () => { this.song.lyricsTiming = {}; upsertSong(this.song); this.ver = (this.ver || 0) + 1; this.realign(); } } : null,
      this.state === 'synced' ? 'sep' : null,
      { label: 'Find other lyrics…', icon: 'search', onclick: () => this.openSearch() },
      { label: 'Paste lyrics…', icon: 'edit', onclick: () => this.openPaste() },
      d && d.plain && d.plain.some(Boolean) && this.state !== 'tap' ? { label: 'Sync by tapping', sub: 'Tap along once as the song plays', icon: 'steps', onclick: () => this.startTap() } : null,
      d ? 'sep' : null,
      d ? { label: 'Remove lyrics', icon: 'trash', danger: true, onclick: () => this.clear() } : null,
    ], { align: 'end' });
  }
  async clear() {
    await idbDel('melody', this.song.id + ':lyrics');
    this.data = null; this.song.lyricsTried = true; this.song.lyricsTiming = {}; upsertSong(this.song);
    this.removed = true; this.state = 'none'; this.render(); this.s.onLyrics && this.s.onLyrics();
  }

  openSearch() {
    const input = h('input', { type: 'text', value: titleQueries(this.song.title).queries[0] || this.song.title, class: 'grow', 'aria-label': 'Song and artist' });
    const results = h('div', { class: 'ly-results' });
    const run = async () => {
      results.innerHTML = '';
      results.append(h('p', { class: 'muted small' }, 'Searching…'));
      let res;
      try { res = await searchLyrics(input.value, this.s.player ? this.s.player.duration() : 0); }
      catch { results.innerHTML = ''; results.append(h('p', { class: 'muted small' }, 'Couldn\'t reach the lyrics library. Check your connection.')); return; }
      results.innerHTML = '';
      if (!res.length) { results.append(h('p', { class: 'muted small' }, 'Nothing found. Try the song name only, or paste the lyrics.')); return; }
      const list = h('div', { class: 'list' });
      for (const { hit } of res.slice(0, 8)) {
        list.append(h('button', { class: 'li', onclick: () => { dlg.close(); this.use(toLyrics(hit)); } },
          h('span', { class: 'li-text' }, h('strong', {}, decode(hit.trackName)), h('small', {}, `${decode(hit.artistName)} · ${fmtTime(hit.duration)}`)),
          h('span', { class: 'li-end' }, hit.syncedLyrics ? 'Synced' : 'Text only')));
      }
      results.append(list);
    };
    const form = h('form', { class: 'row', onsubmit: (e) => { e.preventDefault(); run(); } }, input, h('button', { class: 'btn primary', type: 'submit' }, 'Search'));
    const dlg = sheet('Find lyrics', h('div', {}, form, results, h('p', { class: 'tiny muted', style: 'margin-top:12px' }, 'From LRCLIB, a free, community-made lyrics library. Only the search words are sent.')));
    run();
  }
  openPaste() {
    const ta = h('textarea', { rows: 12, class: 'paste-area', placeholder: 'Paste the lyrics here. Lines with times like [00:13.70] are synced automatically.' });
    const dlg = sheet('Paste lyrics', ta, {
      actions: [h('button', { class: 'btn', onclick: () => dlg.close() }, 'Cancel'), h('button', { class: 'btn primary', onclick: () => {
        const txt = ta.value.trim(); if (!txt) return;
        const lines = parseLRC(txt);
        const d = lines.filter((l) => l.text).length > 3
          ? { source: 'paste', synced: true, lines, plain: lines.map((l) => l.text) }
          : { source: 'paste', synced: false, lines: null, plain: txt.split(/\r?\n/).map((s) => s.trim()) };
        dlg.close(); this.use(d);
        if (!d.synced) toast('Lyrics added. Press "Sync" and tap along once to time them.', 'info', 5000);
      } }, 'Use these lyrics')],
    });
    setTimeout(() => ta.focus(), 50);
  }

  // ---- tap to sync ----
  startTap() {
    if (!this.data || !this.s.player) return;
    const text = this.data.plain.filter(Boolean);
    if (!text.length) return;
    this.tapLines = text.map((t) => ({ t: NaN, end: NaN, text: t }));
    this.tapPrev = this.state; this.picking = false;
    this.tapI = 0; this.state = 'tap'; this.render();
    toast('Play the song and press Space (or Tap) as each line starts.', 'info', 5000);
  }
  tap() {
    if (this.state !== 'tap') return;
    const t = this.s.player.time() - 0.12; // typical reaction delay
    this.tapLines[this.tapI].t = t;
    this.tapI++;
    if (this.tapI >= this.tapLines.length) return this.endTap(true);
    this.tick(t, true);
  }
  tapUndo() { if (this.tapI > 0) { this.tapI--; this.tapLines[this.tapI].t = NaN; this.s.seekTo(Math.max(0, (this.tapLines[this.tapI - 1] || { t: 0 }).t || 0)); this.tick(0, true); } }
  // done: keep what was tapped (all lines, or the first ones when finishing early); otherwise discard.
  endTap(done) {
    const got = (this.tapLines || []).filter((l) => !isNaN(l.t));
    const prev = this.tapPrev || 'plain';
    if (done && got.length >= 2) {
      const rest = this.tapLines.slice(got.length).map((l) => l.text); // untapped lines stay as text
      const d = { source: 'tap', synced: true, lines: got.map((l) => ({ t: l.t, text: l.text })), plain: got.map((l) => l.text).concat(rest) };
      this.song.lyricsTiming = { [this.s.source]: { offset: 0, times: null, user: true } }; upsertSong(this.song);
      idbPut('melody', this.song.id + ':lyrics', d);
      this.data = d; this._linesFor = null; this.ver = (this.ver || 0) + 1; this.state = 'synced';
      toast(rest.length ? `Synced ${got.length} lines.` : 'Lyrics synced.', 'good');
    } else this.state = prev;
    this.tapLines = null; this.render(); this.s.onLyrics && this.s.onLyrics();
  }
}
