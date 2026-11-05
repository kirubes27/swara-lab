// Persistence: settings/progress/songs in localStorage, big blobs (melodies, audio) in IndexedDB.

const LS = 'swaralab.';
function lsGet(k, d) { try { const v = localStorage.getItem(LS + k); return v ? JSON.parse(v) : d; } catch { return d; } }
function lsSet(k, v) { try { localStorage.setItem(LS + k, JSON.stringify(v)); } catch (e) { console.warn('storage', e); } }

export const DEFAULT_SETTINGS = {
  saMidi: 49,          // C#3: a common male Sa. Range test suggests a personal one.
  saFine: 0,
  saChosen: false,
  notation: 'western',   // 'western' = general style; 'hindustani' / 'carnatic' = Indian style
  tuning: 'et',
  tol: 35,
  scale: 'major',
  droneSound: 'auto',   // auto = tanpura in Indian style, soft pad otherwise
  tanpuraFirst: 'P',
  tanpuraVol: 0.35,
  guideVol: 0.6,
  guideTimbre: 'reed',
  micSens: 0.55,
  latencyMs: 0,         // extra user calibration
  rangeLowMidi: null,
  rangeHighMidi: null,
  octaveFree: true,
  showOrnaments: false, // song lines: plain notes vs notes with ornament symbols
  sepQuality: 'balanced', // voice separation: 'fast' (Spleeter), 'balanced' (Kim Vocal 2), 'best' (Mel-RoFormer)
  blind: false,
};

export const settings = Object.assign({}, DEFAULT_SETTINGS, lsGet('settings', {}));
if ((settings.styleVersion || 0) === 2) { // v3: quality levels renamed ('best' used to mean Kim Vocal 2)
  if (settings.sepQuality === 'best') settings.sepQuality = 'balanced';
  settings.styleVersion = 3; lsSet('settings', settings);
}
if (!settings.styleVersion) { // v2: general style became the default (Indian style is opt-in)
  settings.notation = 'western'; settings.styleVersion = 3;
  if (settings.thaat) delete settings.thaat;
  lsSet('settings', settings);
}
const listeners = new Set();
export function saveSettings(patch = {}) {
  Object.assign(settings, patch);
  lsSet('settings', settings);
  for (const fn of listeners) fn(settings, patch);
}
export function onSettings(fn) { listeners.add(fn); return () => listeners.delete(fn); }

// ---- progress log --------------------------------------------------------------
export const progress = Object.assign({ log: [], swara: {}, weak: {} }, lsGet('progress', {}));
export function logActivity(rec) {
  rec.date = rec.date || new Date().toISOString();
  progress.log.push(rec);
  if (progress.log.length > 3000) progress.log.splice(0, progress.log.length - 3000);
  if (rec.perSwara) for (const [k, v] of Object.entries(rec.perSwara)) {
    const s = progress.swara[k] || (progress.swara[k] = { sum: 0, abs: 0, n: 0 });
    // exponential forgetting so the profile reflects recent singing
    s.sum = s.sum * 0.97 + v.sum; s.abs = s.abs * 0.97 + v.abs; s.n = s.n * 0.97 + v.n;
  }
  if (rec.weak) for (const [k, v] of Object.entries(rec.weak)) progress.weak[k] = (progress.weak[k] || 0) * 0.85 + v;
  lsSet('progress', progress);
}
export function resetProgress() { progress.log = []; progress.swara = {}; progress.weak = {}; lsSet('progress', progress); }

export function dayKey(d) { const x = new Date(d); return x.getFullYear() + '-' + String(x.getMonth() + 1).padStart(2, '0') + '-' + String(x.getDate()).padStart(2, '0'); }
export function streak() {
  const days = new Set(progress.log.map((r) => dayKey(r.date)));
  let n = 0; const d = new Date();
  if (!days.has(dayKey(d))) d.setDate(d.getDate() - 1); // today not done yet doesn't break streak
  while (days.has(dayKey(d))) { n++; d.setDate(d.getDate() - 1); }
  return n;
}
export function minutesOn(day) { return progress.log.filter((r) => dayKey(r.date) === day).reduce((a, r) => a + (r.minutes || 0), 0); }

// ---- songs -----------------------------------------------------------------------
const DEFAULT_SONGS = [{
  id: 'yt-p7GmO8ewjmw', title: 'Unnai Kaanadhu Naan (Vishwaroopam)', kind: 'youtube', videoId: 'p7GmO8ewjmw',
  created: '2026-11-04T00:00:00Z', note: 'Shankar Mahadevan & Kamal Haasan, music by Shankar–Ehsaan–Loy',
}];
export const songs = lsGet('songs', DEFAULT_SONGS);
export function saveSongs() { lsSet('songs', songs); }
export function getSong(id) { return songs.find((s) => s.id === id); }
export function upsertSong(s) { const i = songs.findIndex((x) => x.id === s.id); if (i >= 0) songs[i] = Object.assign(songs[i], s); else songs.push(s); saveSongs(); return getSong(s.id); }
export function removeSong(id) { const i = songs.findIndex((x) => x.id === id); if (i >= 0) songs.splice(i, 1); saveSongs(); idbDel('melody', id + ':youtube'); idbDel('melody', id + ':audio'); idbDel('audio', id); idbDel('audio', id + ':vocals'); }
export const lastSong = { get: () => lsGet('lastSong', DEFAULT_SONGS[0].id), set: (id) => lsSet('lastSong', id) };

// ---- IndexedDB ---------------------------------------------------------------------
let dbp = null;
function db() {
  if (!dbp) dbp = new Promise((res, rej) => {
    const r = indexedDB.open('swaralab', 1);
    r.onupgradeneeded = () => { r.result.createObjectStore('melody'); r.result.createObjectStore('audio'); };
    r.onsuccess = () => res(r.result);
    r.onerror = () => rej(r.error);
  });
  return dbp;
}
export async function idbPut(store, key, val) {
  const d = await db();
  return new Promise((res, rej) => { const tx = d.transaction(store, 'readwrite'); tx.objectStore(store).put(val, key); tx.oncomplete = () => res(); tx.onerror = () => rej(tx.error); });
}
export async function idbGet(store, key) {
  const d = await db();
  return new Promise((res, rej) => { const tx = d.transaction(store, 'readonly'); const q = tx.objectStore(store).get(key); q.onsuccess = () => res(q.result); q.onerror = () => rej(q.error); });
}
export async function idbDel(store, key) {
  try { const d = await db(); const tx = d.transaction(store, 'readwrite'); tx.objectStore(store).delete(key); } catch {}
}

// melody <-> storable
export function packMelody(m) { return { hop: m.hop, t0: m.t0, cents: Float32Array.from(m.cents), edits: m.edits || 0 }; }
export function unpackMelody(o) { if (!o) return null; return { hop: o.hop, t0: o.t0, cents: o.cents instanceof Float32Array ? o.cents : Float32Array.from(o.cents), edits: o.edits || 0 }; }
