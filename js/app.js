// App shell: routing, header controls, Today / Warm-up / Drills / Progress / Settings pages.
import { audioCtx, mic } from './audio.js';
import { tanpura } from './sound.js';
import { settings, saveSettings, onSettings, progress, streak, minutesOn, dayKey, resetProgress, songs, lastSong, getSong } from './store.js';
import { saHzFrom, westernName, hzToMidi, kattaiName, kaliSafedName, SWARA_LONG, SWARA_SHORT, THAATS } from './music.js';
import { EXERCISES, WARMUP_ROUTINE } from './exercises.js';
import { ExercisePlayer } from './practice.js';
import { SongStudio } from './song.js';
import { RangeFinder } from './range.js';
import { h, toast, ensureMic } from './ui.js';

const $ = (s) => document.querySelector(s);
const pages = {};
let current = null;

// ---------------------------------------------------------------------------
// Header
function renderHeader() {
  const sa = saHzFrom(settings), m = hzToMidi(sa);
  $('#saChip').textContent = `Sa ${westernName(Math.round(m))}`;
  $('#saChip').title = `Your Sa: ${westernName(Math.round(m))} (${sa.toFixed(1)} Hz) · ${kattaiName(Math.round(m) % 12)} · ${kaliSafedName(Math.round(m) % 12)}. Click to change.`;
  $('#tanpuraBtn').classList.toggle('on', tanpura.on);
  $('#micBtn').classList.toggle('on', mic.running);
}
function setupHeader() {
  $('#tanpuraBtn').addEventListener('click', () => {
    audioCtx();
    if (tanpura.on) tanpura.stop();
    else {
      const songSa = current === 'song' && pages.song && pages.song.song ? pages.song.practiceSa : saHzFrom(settings);
      tanpura.setVolume(settings.tanpuraVol);
      tanpura.start(songSa, settings.tanpuraFirst);
    }
    renderHeader();
  });
  $('#micBtn').addEventListener('click', async () => {
    if (mic.running) mic.stop(); else await ensureMic();
    renderHeader(); pages.song && pages.song.syncMicBtn && pages.song.syncMicBtn();
  });
  $('#saChip').addEventListener('click', () => (location.hash = '#settings'));
  document.addEventListener('mic-change', renderHeader);
  // mic level meter
  const meter = $('#micLevel');
  const tick = () => { meter.style.setProperty('--lv', mic.running ? Math.min(1, mic.level * 12).toFixed(3) : 0); requestAnimationFrame(tick); };
  tick();
  onSettings((s, patch) => {
    renderHeader();
    if (('saMidi' in patch || 'saFine' in patch || 'tanpuraFirst' in patch) && tanpura.on && current !== 'song') tanpura.start(saHzFrom(settings), settings.tanpuraFirst);
    if ('tanpuraVol' in patch) tanpura.setVolume(settings.tanpuraVol);
    if ('micSens' in patch) mic.setSensitivity(settings.micSens);
  });
}

// ---------------------------------------------------------------------------
// Today
const WEAK_TO_DRILL = { highFlat: 'fiveNote', wobble: 'saHold', ornaments: 'gamak', scoop: 'pitchMatch', accuracy: 'aroha', bias: 'saHold' };
const WEAK_LABEL = { highFlat: 'flat high notes', wobble: 'unsteady held notes', ornaments: 'ornaments', scoop: 'scooping into notes', accuracy: 'overall accuracy', bias: 'pitch drift' };
function focusDrill() {
  const w = Object.entries(progress.weak || {}).sort((a, b) => b[1] - a[1])[0];
  if (w && w[1] > 0.5) return { id: WEAK_TO_DRILL[w[0]], why: `your recent takes show ${WEAK_LABEL[w[0]]}` };
  const rot = ['alankar3', 'meend', 'kan', 'intervals', 'gamak', 'alankar4'];
  return { id: rot[new Date().getDate() % rot.length], why: null };
}
function doneToday(pred) { const d = dayKey(new Date()); return progress.log.some((r) => dayKey(r.date) === d && pred(r)); }

function renderToday() {
  const root = $('#page-today'); root.innerHTML = '';
  const st = streak(), today = minutesOn(dayKey(new Date()));
  let week = 0; for (let i = 0; i < 7; i++) { const d = new Date(); d.setDate(d.getDate() - i); week += minutesOn(dayKey(d)); }
  const song = getSong(lastSong.get()) || songs[0];
  const fd = focusDrill();
  root.append(h('div', { class: 'hero' },
    h('div', {}, h('h1', {}, 'Today\'s riyaz'), h('p', { class: 'muted' }, 'About 20 minutes. Short daily sessions beat long weekly ones, because spaced practice is how motor skills consolidate.')),
    h('div', { class: 'stats' },
      h('div', { class: 'stat' }, h('div', { class: 'stat-v' }, String(st)), h('div', { class: 'stat-l' }, 'day streak')),
      h('div', { class: 'stat' }, h('div', { class: 'stat-v' }, Math.round(today) + ' min'), h('div', { class: 'stat-l' }, 'today')),
      h('div', { class: 'stat' }, h('div', { class: 'stat-v' }, Math.round(week) + ' min'), h('div', { class: 'stat-l' }, 'last 7 days')))));
  if (!settings.saChosen) root.append(h('div', { class: 'callout setup' },
    h('strong', {}, 'First-time setup (2 minutes)'),
    h('ol', {}, h('li', {}, 'Use ', h('strong', {}, 'wired headphones'), ' (Bluetooth adds delay, and speakers leak into the mic).'),
      h('li', {}, 'Run the ', h('a', { href: '#range' }, 'range test'), '. It picks a Sa (tonic) that fits your voice. Every exercise is built on it.'),
      h('li', {}, 'Allow the microphone when the browser asks.')),
  ));
  const steps = [
    { title: 'Warm-up', mins: 8, href: '#warmup', done: doneToday((r) => r.type === 'drill' && WARMUP_ROUTINE.includes(r.id)), what: 'Breath, Sa hold, lip-trill sirens, 5-note scale, aroha, meend, cool-down.' },
    { title: 'Ear ↔ voice: pitch-match', mins: 2, href: '#drills/pitchMatch', done: doneToday((r) => r.id === 'pitchMatch'), what: 'Hear a note, then sing it. Trains the ear-to-voice link that most "off-key" singing comes down to.' },
    { title: 'Focus drill: ' + EXERCISES[fd.id].name, mins: 3, href: '#drills/' + fd.id, done: doneToday((r) => r.id === fd.id), what: fd.why ? 'Chosen because ' + fd.why + '.' : 'Today\'s technique focus (changes daily until your takes show a specific weakness).' },
    { title: 'Song: ' + (song ? song.title : 'add a song'), mins: 10, href: '#song', done: doneToday((r) => r.type === 'song'), what: 'Loop 2–3 lines. Listen at 0.75× with the guide tone, then sing along, then try Song muted.' },
    { title: 'Cool-down', mins: 1, href: '#drills/cooldown', done: doneToday((r) => r.id === 'cooldown'), what: 'Soft descending hum.' },
  ];
  root.append(h('ol', { class: 'plan' }, ...steps.map((s) => h('li', { class: s.done ? 'done' : '' },
    h('a', { href: s.href, class: 'plan-item' },
      h('span', { class: 'check' }, s.done ? '✓' : ''),
      h('span', { class: 'plan-text' }, h('strong', {}, s.title), h('small', {}, s.what)),
      h('span', { class: 'mins' }, s.mins + ' min'))))));
  root.append(h('div', { class: 'card' },
    h('h3', {}, 'How to learn singing on your own'),
    h('ol', { class: 'principles' },
      h('li', {}, h('strong', {}, 'Sing in your key. '), 'Most "can\'t reach that note" problems are key problems. Transpose the song until it fits, then expand your range with exercises.'),
      h('li', {}, h('strong', {}, 'Listen, then sing, then check. '), 'Hear the target, sing it, then compare (the pitch line, your recording). Feedback is what turns repetition into improvement.'),
      h('li', {}, h('strong', {}, 'Slow and small. '), 'Loop one line at 0.6–0.75× until it\'s accurate, then speed up. Ornaments (gamaka, murki, kan) are learned slowly first.'),
      h('li', {}, h('strong', {}, 'Wean off the screen. '), 'Use the live line to learn, then switch to "Song muted" and Blind mode so your ear does the work.'),
      h('li', {}, h('strong', {}, 'Record yourself. '), 'People judge their own singing poorly while singing. Listening back is one of the most effective tools.'),
      h('li', {}, h('strong', {}, 'No pain. '), 'Strain, hoarseness or pain means stop. Hoarseness lasting over 2 weeks needs an ENT doctor.')),
    h('a', { href: '#learn' }, 'The research behind this, and fixes for common problems →')));
}

// ---------------------------------------------------------------------------
// Warm-up
function renderWarmup() {
  const root = $('#page-warmup');
  if (!pages.warm) {
    root.innerHTML = '';
    const list = h('ol', { class: 'steps' });
    const host = h('div', { class: 'grow' });
    root.append(h('div', { class: 'split' }, h('aside', {}, h('h2', {}, 'Warm-up'), h('p', { class: 'muted small' }, '≈ 8 minutes. Do it before singing songs; voices warmed up gently strain less.'), list), host));
    const player = new ExercisePlayer(host);
    let idx = 0;
    const go = (i) => {
      idx = i;
      [...list.children].forEach((li, k) => li.classList.toggle('cur', k === i));
      player.load(WARMUP_ROUTINE[i]);
    };
    WARMUP_ROUTINE.forEach((id, i) => list.append(h('li', { onclick: () => go(i) }, EXERCISES[id].name, h('small', {}, ` ${EXERCISES[id].mins} min`))));
    player.onNext = () => { list.children[idx].classList.add('done'); if (idx + 1 < WARMUP_ROUTINE.length) go(idx + 1); else toast('Warm-up complete. Nice work. 🎉', 'good'); };
    player.onDone = () => list.children[idx].classList.add('done');
    pages.warm = { player, go };
    go(0);
  }
}

// ---------------------------------------------------------------------------
// Drills
function renderDrills(sub) {
  const root = $('#page-drills');
  if (!pages.drills) {
    root.innerHTML = '';
    const grid = h('div', { class: 'drill-grid' });
    const host = h('div', { class: 'drill-host' });
    root.append(h('h2', {}, 'Drills'), h('p', { class: 'muted' }, 'Pick one. Each one gives feedback per note. Scale-based drills follow the scale (thaat) you choose.'), grid, host);
    const ids = Object.keys(EXERCISES).concat(['custom']);
    for (const id of ids) {
      const d = id === 'custom' ? { name: 'Swara Pad: type your own line', what: 'Practise any sargam phrase, such as a hard line from your song.' } : EXERCISES[id];
      grid.append(h('a', { class: 'drill-card', href: '#drills/' + id }, h('strong', {}, d.name), h('small', {}, d.what.split('. ')[0].replace(/\.$/, '') + '.')));
    }
    const player = new ExercisePlayer(host);
    player.onNext = null;
    pages.drills = { player, grid, host };
  }
  const { player, grid, host } = pages.drills;
  if (sub && (EXERCISES[sub] || sub === 'custom')) {
    [...grid.children].forEach((a) => a.classList.toggle('cur', a.getAttribute('href') === '#drills/' + sub));
    if (player.id !== sub) player.load(sub);
    host.style.display = '';
    setTimeout(() => host.scrollIntoView({ behavior: 'smooth', block: 'start' }), 50);
  } else host.style.display = player.id ? '' : 'none';
}

// ---------------------------------------------------------------------------
// Progress
function renderProgress() {
  const root = $('#page-progress'); root.innerHTML = '';
  const log = progress.log;
  root.append(h('h2', {}, 'Progress'));
  if (!log.length) { root.append(h('p', { class: 'muted' }, 'Nothing yet. Your practice minutes, scores and per-swara tendencies appear here as you practise.')); return; }
  // 28-day minutes
  const days = [];
  for (let i = 27; i >= 0; i--) { const d = new Date(); d.setDate(d.getDate() - i); days.push({ d, m: minutesOn(dayKey(d)) }); }
  const maxM = Math.max(10, ...days.map((x) => x.m));
  const bars = h('div', { class: 'bars', role: 'img', 'aria-label': 'Practice minutes per day, last 28 days' },
    ...days.map((x) => h('div', { class: 'bar-col', title: `${x.d.toDateString()}: ${Math.round(x.m)} min` }, h('div', { class: 'bar', style: `height:${(x.m / maxM) * 100}%` }))));
  root.append(h('div', { class: 'card' }, h('h3', {}, 'Practice minutes (last 28 days)'), h('div', { class: 'chart-wrap' }, h('div', { class: 'axis-max small muted' }, Math.round(maxM) + ' min'), bars), h('div', { class: 'row small muted spread' }, h('span', {}, '4 weeks ago'), h('span', {}, 'today'))));
  // score trend (daily mean of drill + song scores)
  const byDay = new Map();
  for (const r of log) if (r.score != null && (r.type === 'drill' || r.type === 'song')) { const k = dayKey(r.date); const a = byDay.get(k) || []; a.push(r.score); byDay.set(k, a); }
  const pts = [...byDay.entries()].sort().slice(-30).map(([k, a]) => ({ k, v: a.reduce((x, y) => x + y, 0) / a.length, n: a.length }));
  if (pts.length) {
    const W = 600, H = 160, pad = 24;
    const X = (i) => pad + (pts.length === 1 ? (W - 2 * pad) / 2 : (i / (pts.length - 1)) * (W - 2 * pad));
    const Y = (v) => H - pad - (v / 100) * (H - 2 * pad);
    const path = pts.map((p, i) => (i ? 'L' : 'M') + X(i).toFixed(1) + ' ' + Y(p.v).toFixed(1)).join(' ');
    const svg = `<svg viewBox="0 0 ${W} ${H}" class="trend" role="img" aria-label="Average score per practice day">
      ${[0, 50, 100].map((v) => `<line x1="${pad}" x2="${W - pad}" y1="${Y(v)}" y2="${Y(v)}" class="gridline"/><text x="2" y="${Y(v) + 4}" class="axis">${v}</text>`).join('')}
      <path d="${path}" class="trend-line"/>
      ${pts.map((p, i) => `<circle cx="${X(i)}" cy="${Y(p.v)}" r="5" class="trend-dot"><title>${p.k}: ${Math.round(p.v)} (${p.n} takes)</title></circle>`).join('')}
    </svg>`;
    root.append(h('div', { class: 'card' }, h('h3', {}, 'Average score per practice day'), h('div', { html: svg })));
  }
  // per-swara tendency (diverging)
  const sw = progress.swara || {};
  const rows = [];
  for (let i = 0; i < 12; i++) { const s = sw[i]; if (s && s.n >= 5) rows.push({ i, b: s.sum / s.n, n: s.n }); }
  if (rows.length) {
    const lim = Math.max(30, ...rows.map((r) => Math.abs(r.b)));
    root.append(h('div', { class: 'card' },
      h('h3', {}, 'Microtone map: where each swara lands for you'),
      h('p', { class: 'small muted' }, 'Average offset on held notes (recent sessions weigh more). Left = flat, right = sharp. Within ±15¢ is very good.'),
      h('div', { class: 'diverge' }, ...rows.map((r) => {
        const w = (Math.abs(r.b) / lim) * 50;
        return h('div', { class: 'drow', title: `${SWARA_LONG[r.i]}: ${r.b > 0 ? '+' : ''}${Math.round(r.b)}¢ over ${Math.round(r.n)} samples` },
          h('span', { class: 'dlab' }, SWARA_SHORT[r.i] + ' · ' + SWARA_LONG[r.i]),
          h('span', { class: 'dtrack' }, h('span', { class: 'dzero' }), h('span', { class: 'dbar ' + (r.b < 0 ? 'flat' : 'sharp'), style: r.b < 0 ? `right:50%;width:${w}%` : `left:50%;width:${w}%` })),
          h('span', { class: 'dval mono' }, (r.b > 0 ? '+' : '') + Math.round(r.b) + '¢'));
      })),
      h('div', { class: 'row small muted spread' }, h('span', {}, '◀ flat'), h('span', {}, 'sharp ▶'))));
  }
  // songs
  const songRows = songs.filter((s) => s.best && Object.keys(s.best).length);
  if (songRows.length) root.append(h('div', { class: 'card' }, h('h3', {}, 'Songs'), h('table', { class: 'tbl' },
    h('tr', {}, h('th', {}, 'Song'), h('th', {}, 'Lines practised'), h('th', {}, 'Average best')),
    ...songRows.map((s) => { const v = Object.values(s.best); return h('tr', {}, h('td', {}, s.title), h('td', {}, String(v.length)), h('td', {}, String(Math.round(v.reduce((a, b) => a + b, 0) / v.length)))); }))));
  root.append(h('p', {}, h('button', { class: 'btn ghost small', onclick: () => { if (confirm('Erase all progress data?')) { resetProgress(); renderProgress(); } } }, 'Reset progress')));
}

// ---------------------------------------------------------------------------
// Settings
function renderSettings() {
  const root = $('#page-settings'); root.innerHTML = '';
  const field = (label, ctl, help) => h('label', { class: 'field' }, h('span', { class: 'flabel' }, label), ctl, help ? h('small', { class: 'muted' }, help) : null);
  const notes = []; for (let m = 36; m <= 72; m++) notes.push(m);
  const saSel = h('select', { onchange: (e) => saveSettings({ saMidi: +e.target.value, saChosen: true }) },
    ...notes.map((m) => h('option', { value: m, selected: m === settings.saMidi }, `${westernName(m)} · ${kattaiName(m % 12)} · ${kaliSafedName(m % 12)}`)));
  const fineOut = h('span', { class: 'mono' }, settings.saFine + '¢');
  const fine = h('input', { type: 'range', min: -50, max: 50, step: 1, value: settings.saFine, oninput: (e) => { fineOut.textContent = e.target.value + '¢'; }, onchange: (e) => saveSettings({ saFine: +e.target.value }) });
  const sel = (key, opts) => h('select', { onchange: (e) => saveSettings({ [key]: isNaN(+e.target.value) ? e.target.value : +e.target.value }) }, ...opts.map(([v, l]) => h('option', { value: v, selected: settings[key] == v }, l)));
  const range = (key, min, max, step, fmt = (v) => v) => {
    const out = h('span', { class: 'mono' }, fmt(settings[key]));
    return h('span', { class: 'row' }, h('input', { type: 'range', min, max, step, value: settings[key], oninput: (e) => (out.textContent = fmt(+e.target.value)), onchange: (e) => saveSettings({ [key]: +e.target.value }) }), out);
  };
  const chk = (key) => h('input', { type: 'checkbox', checked: !!settings[key], onchange: (e) => saveSettings({ [key]: e.target.checked }) });
  root.append(h('h2', {}, 'Settings'),
    h('div', { class: 'card form' },
      h('h3', {}, 'Your tonic'),
      field('Sa', saSel, 'Run the range test for a suggestion. Typical: men C#3–E3 (1½–3 kattai), women G#3–C4 (5½ kattai and up).'),
      field('Fine tune', h('span', { class: 'row' }, fine, fineOut), 'For matching a harmonium or shruti box that\'s slightly off.'),
      field('Drone', sel('tanpuraFirst', [['P', 'Pa – Sa Sa Sa (most ragas)'], ['M', 'Ma – Sa Sa Sa (ragas without Pa)'], ['N', 'Ni – Sa Sa Sa'], ['S', 'Sa – Sa Sa Sa']])),
      field('Drone volume', range('tanpuraVol', 0, 1, 0.05, (v) => Math.round(v * 100) + '%')),
    ),
    h('div', { class: 'card form' },
      h('h3', {}, 'Notation & tuning'),
      field('Note names', sel('notation', [['hindustani', 'Hindustani (S r R g G m M P d D n N)'], ['carnatic', 'Carnatic (S R1 R2 G2 G3 M1 M2 P D1 D2 N2 N3)'], ['western', 'Western (C D E…)']])),
      field('Swara positions', sel('tuning', [['et', 'Equal temperament (keyboard)'], ['just', 'Just intonation (tanpura-natural, e.g. Ga at 386¢)']]), 'Indian singing against a tanpura tends towards just intervals. Ga and Ni sit slightly lower than on a keyboard.'),
      field('Default scale (thaat)', sel('thaat', Object.keys(THAATS).map((k) => [k, `${k} / ${THAATS[k].carnatic}: ${THAATS[k].hint}`]))),
    ),
    h('div', { class: 'card form' },
      h('h3', {}, 'Feedback'),
      field('In-tune tolerance', sel('tol', [[50, '±50¢: beginner (half a semitone)'], [35, '±35¢: standard'], [25, '±25¢: strict'], [15, '±15¢: microtone work']])),
      field('Octave-forgiving', h('span', {}, chk('octaveFree'), ' count a note as right in any octave'), 'Useful when singing a song originally sung by another voice type.'),
      field('Blind mode by default', h('span', {}, chk('blind'), ' hide my live line in drills'), 'Practising without constant feedback improves retention (the "guidance hypothesis" in motor learning).'),
    ),
    h('div', { class: 'card form' },
      h('h3', {}, 'Audio'),
      field('Mic sensitivity', range('micSens', 0, 1, 0.05, (v) => Math.round(v * 100) + '%'), 'Raise it if quiet singing isn\'t detected; lower it if room noise is drawn as pitch.'),
      field('Guide volume', range('guideVol', 0, 1, 0.05, (v) => Math.round(v * 100) + '%')),
      field('Guide sound', sel('guideTimbre', [['reed', 'Harmonium-like'], ['sine', 'Pure tone']])),
      field('Extra latency compensation', range('latencyMs', 0, 400, 10, (v) => v + ' ms'), 'If you\'re always reported "behind" with the same amount, set it here (Bluetooth: try 150–250 ms).'),
    ),
    h('div', { class: 'card form' },
      h('h3', {}, 'Data'),
      h('p', { class: 'small muted' }, 'Everything (songs, melodies, recordings, progress) stays in this browser. Nothing is uploaded.'),
      h('button', { class: 'btn', onclick: () => { const b = new Blob([JSON.stringify({ settings, progress, songs }, null, 1)], { type: 'application/json' }); const a = h('a', { href: URL.createObjectURL(b), download: 'swara-lab-backup.json' }); a.click(); } }, 'Export backup (JSON)')),
  );
}

// ---------------------------------------------------------------------------
// Router
const ROUTES = ['today', 'warmup', 'song', 'drills', 'range', 'learn', 'progress', 'settings'];
function route() {
  const [page, sub] = (location.hash.slice(1) || 'today').split('/');
  const p = ROUTES.includes(page) ? page : 'today';
  if (current === 'song' && p !== 'song' && pages.song) pages.song.deactivate();
  if (current && current !== p) {
    if (pages.warm) pages.warm.player.stop();
    if (pages.drills) pages.drills.player.stop();
    pages.range && pages.range.stop();
  }
  current = p;
  document.querySelectorAll('.page').forEach((el) => (el.hidden = el.id !== 'page-' + p));
  document.querySelectorAll('nav a').forEach((a) => a.classList.toggle('active', a.getAttribute('href') === '#' + p));
  if (p === 'today') renderToday();
  if (p === 'warmup') renderWarmup();
  if (p === 'drills') renderDrills(sub);
  if (p === 'song') { if (!pages.song) pages.song = new SongStudio($('#page-song')); pages.song.activate(); pages.song.syncMicBtn(); }
  if (p === 'range') { if (!pages.range) pages.range = new RangeFinder($('#page-range')); else pages.range.renderOut(); }
  if (p === 'progress') renderProgress();
  if (p === 'settings') renderSettings();
  window.scrollTo(0, 0);
}

setupHeader();
renderHeader();
window.swaraLab = { pages }; // handy for debugging from the console
window.addEventListener('hashchange', route);
route();
// Unlock audio on first interaction (browser autoplay policy).
window.addEventListener('pointerdown', () => audioCtx(), { once: true });
