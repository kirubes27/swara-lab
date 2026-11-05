// App shell: routing, header, Today, Practice hub, Progress, Settings, first-run tour.
import { audioCtx, mic } from './audio.js';
import { tanpura } from './sound.js';
import { settings, saveSettings, onSettings, progress, streak, minutesOn, dayKey, resetProgress, songs, lastSong, getSong } from './store.js';
import { saHzFrom, westernName, hzToMidi, kattaiName, kaliSafedName, SWARA_LONG, SWARA_SHORT, DEGREE_LONG, scaleList, scaleLabel, isIndian, term } from './music.js';
import { EXERCISES, WARMUP_ROUTINE, exText } from './exercises.js';
import { ExercisePlayer } from './practice.js';
import { SongStudio } from './song.js';
import { RangeFinder } from './range.js';
import { FreeSing } from './free.js';
import { h, toast, ensureMic } from './ui.js';
import { icon } from './icons.js';

const $ = (s) => document.querySelector(s);
const pages = {};
let current = null;

function hydrateIcons(root = document) {
  root.querySelectorAll('[data-icon]').forEach((el) => { if (!el.firstChild || el.dataset.iconDone !== '1') { el.prepend(icon(el.dataset.icon, el.classList.contains('mark') ? 18 : 20)); el.dataset.iconDone = '1'; } });
}
function applyTheme() {
  const t = settings.theme || 'auto';
  if (t === 'auto') delete document.documentElement.dataset.theme; else document.documentElement.dataset.theme = t;
  document.dispatchEvent(new Event('themechange'));
}

// ---------------------------------------------------------------------------
// Header
function renderHeader() {
  const sa = saHzFrom(settings), m = hzToMidi(sa);
  const ind = isIndian(settings), n = westernName(Math.round(m));
  $('#saChip').textContent = `${ind ? 'Sa' : 'Key'} ${n}`;
  $('#saChip').title = ind ? `Your Sa: ${n} (${sa.toFixed(1)} Hz) · ${kattaiName(Math.round(m) % 12)} · ${kaliSafedName(Math.round(m) % 12)}. Click to change.` : `Key note for exercises: ${n} (${sa.toFixed(1)} Hz). Click to change.`;
  const tb = $('#tanpuraBtn');
  tb.title = (tanpura.kind() === 'tanpura' ? 'Tanpura' : 'Drone') + ' on your key note: a steady pitch to sing against';
  tb.classList.toggle('on', tanpura.on);
  $('#micBtn').classList.toggle('on', mic.running);
}
function setupHeader() {
  tanpura.kindFn = () => (settings.droneSound === 'auto' || !settings.droneSound ? (isIndian(settings) ? 'tanpura' : 'pad') : settings.droneSound);
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
  const meter = $('#micLevel');
  const tick = () => { meter.style.setProperty('--lv', mic.running ? Math.min(1, mic.level * 12).toFixed(3) : 0); requestAnimationFrame(tick); };
  tick();
  onSettings((s, patch) => {
    renderHeader();
    if (('saMidi' in patch || 'saFine' in patch || 'tanpuraFirst' in patch || 'droneSound' in patch || 'notation' in patch) && tanpura.on) {
      tanpura.start(current === 'song' && pages.song && pages.song.song ? pages.song.practiceSa : saHzFrom(settings), settings.tanpuraFirst);
    }
    if ('tanpuraVol' in patch) tanpura.setVolume(settings.tanpuraVol);
    if ('micSens' in patch) mic.setSensitivity(settings.micSens);
    if ('notation' in patch || 'tuning' in patch) {
      for (const k of ['player', 'warm', 'free', 'range']) { if (pages[k] && pages[k].stop) pages[k].stop(); pages[k] = null; }
      if (pages.song && pages.song.song) { pages.song.refreshKey(); pages.song.renderPhrases(); }
    }
  });
}

// ---------------------------------------------------------------------------
// Today
const WEAK_TO_DRILL = { highFlat: 'fiveNote', wobble: 'saHold', ornaments: 'meend', scoop: 'pitchMatch', accuracy: 'aroha', bias: 'saHold' };
const WEAK_LABEL = { highFlat: 'flat high notes', wobble: 'unsteady held notes', ornaments: 'flattened ornaments', scoop: 'scooping into notes', accuracy: 'overall accuracy', bias: 'pitch drift' };
function focusDrill() {
  const w = Object.entries(progress.weak || {}).sort((a, b) => b[1] - a[1])[0];
  if (w && w[1] > 0.5) return { id: WEAK_TO_DRILL[w[0]], why: `your recent takes show ${WEAK_LABEL[w[0]]}` };
  const rot = isIndian(settings) ? ['alankar3', 'meend', 'kan', 'intervals', 'gamak', 'runs', 'alankar4'] : ['alankar3', 'meend', 'vibrato', 'intervals', 'runs', 'flips', 'kan'];
  return { id: rot[new Date().getDate() % rot.length], why: null };
}
function doneToday(pred) { const d = dayKey(new Date()); return progress.log.some((r) => dayKey(r.date) === d && pred(r)); }
const TIPS = [
  ['Sing in your key.', 'If a line strains, transpose it down. Original keys suit the original singer, not you.'],
  ['Slow is fast.', 'Loop a hard line at 0.6× until it\'s clean, then speed up in steps.'],
  ['Listen back.', 'Your take is saved after every pass. People hear their own singing more accurately on playback than while singing.'],
  ['Wean off the line.', 'Once a line is green, try Blind mode so your ear does the work.'],
  ['Lighter goes higher.', 'High notes get easier with less volume, not more.'],
  ['Breathe low.', 'Belly and lower ribs expand; shoulders stay still.'],
  ['Hum first.', 'Humming or lip trills before singing make the voice work with less effort.'],
  ['Little and often.', 'Twenty minutes a day beats two hours on Sunday.'],
];
function greeting() { const h0 = new Date().getHours(); return h0 >= 5 && h0 < 12 ? 'Good morning' : h0 >= 12 && h0 < 18 ? 'Good afternoon' : 'Good evening'; }
function signatureSVG() {
  return `<svg class="signature" viewBox="0 0 460 140" aria-hidden="true">
    <path class="band" d="M10 96 C 60 96, 70 54, 120 54 S 170 54, 190 80 S 240 112, 270 70 S 320 30, 360 38 S 420 64, 450 60"/>
    <path class="voice" d="M10 100 C 40 102, 62 60, 96 58 C 118 57, 124 49, 134 56 C 150 66, 166 60, 184 76 C 206 98, 226 118, 254 82 C 268 64, 274 60, 282 63 C 300 46, 322 22, 352 38 C 368 46, 372 30, 384 44 C 400 60, 420 66, 448 58"/>
    <circle class="dot" cx="448" cy="58" r="5"/></svg>`;
}
function tile({ href, ic, title, sub, hero = false }) {
  return h('a', { class: 'tile' + (hero ? ' hero' : ''), href }, h('span', { class: 't-ic' }, icon(ic, 20)), h('span', { class: 't-body' }, h('span', { class: 't-title' }, title), h('span', { class: 't-sub' }, sub)), h('span', { class: 't-go' }, icon('chevron', 18)));
}
function renderToday() {
  const root = $('#page-today'); root.innerHTML = '';
  const st = streak(), today = minutesOn(dayKey(new Date()));
  let week = 0; for (let i = 0; i < 7; i++) { const d = new Date(); d.setDate(d.getDate() - i); week += minutesOn(dayKey(d)); }
  const song = getSong(lastSong.get()) || songs[0];
  const fd = focusDrill();
  const hello = h('div', { class: 'hello', html: signatureSVG() });
  hello.append(h('h1', {}, greeting() + '.'), h('p', { class: 'lead muted', style: 'font-size:1.12rem;margin:0' }, st ? `Day ${st} in a row. Keep the streak going.` : 'Pick anything below, or follow today\'s suggestions.'));
  root.append(hello);
  root.append(h('div', { class: 'grid3' },
    tile({ href: '#practice/warmup', ic: 'breath', title: 'Warm up', sub: '8 minutes. Breath, sirens, scales, slides.', hero: true }),
    tile({ href: '#songs', ic: 'songs', title: song ? 'Continue: ' + song.title.replace(/\s*\(.*\)\s*$/, '') : 'Learn a song', sub: song ? 'Loop a line, slow it down, sing against the original.' : 'Import any song and sing against its melody.' }),
    tile({ href: '#practice/free', ic: 'wave', title: 'Free sing', sub: 'Sing anything and see your pitch live.' })));
  if (!settings.saChosen) root.append(h('div', { class: 'callout row wrap spread', style: 'margin-top:16px' },
    h('div', {}, h('strong', {}, 'Find your range first'), h('p', { class: 'small', style: 'margin:2px 0 0' }, 'Two minutes. It sets a comfortable key for every exercise and lets songs suggest a key that fits you.')),
    h('a', { class: 'btn primary', href: '#practice/range' }, 'Find my range')));
  const steps = [
    { id: 'warm', ic: 'breath', title: 'Warm-up', mins: 8, href: '#practice/warmup', done: doneToday((r) => r.type === 'drill' && WARMUP_ROUTINE.includes(r.id)), what: 'Gets the voice moving before anything demanding.' },
    { id: 'match', ic: 'target', title: 'Pitch matching', mins: 2, href: '#practice/pitchMatch', done: doneToday((r) => r.id === 'pitchMatch'), what: 'Hear a note, sing it back. Trains the ear-to-voice link behind most off-key singing.' },
    { id: 'focus', ic: 'sparkle', title: exText(EXERCISES[fd.id], settings).name, mins: 3, href: '#practice/' + fd.id, done: doneToday((r) => r.id === fd.id), what: fd.why ? 'Because ' + fd.why + '.' : 'Today\'s technique focus.' },
    { id: 'song', ic: 'songs', title: song ? song.title : 'A song', mins: 10, href: '#songs', done: doneToday((r) => r.type === 'song'), what: 'Two or three lines: listen at 0.75×, sing along, then try it muted.' },
  ];
  root.append(h('div', { class: 'section' }, h('h2', {}, 'Suggested for today'), h('span', { class: 'small muted' }, 'About 20 minutes · all optional')));
  root.append(h('div', { class: 'list' }, ...steps.map((s) => h('a', { href: s.href, class: s.done ? 'done' : '' },
    h('span', { class: 'li-ic' }, icon(s.done ? 'check' : s.ic, 18)),
    h('span', { class: 'li-text' }, h('strong', {}, s.title), h('small', {}, s.what)),
    h('span', { class: 'li-end' }, s.mins + ' min', icon('chevron', 16))))));
  const [tt, td] = TIPS[(new Date().getDate() + new Date().getMonth()) % TIPS.length];
  root.append(h('div', { class: 'grid2', style: 'margin-top:16px' },
    h('div', { class: 'card', style: 'margin:0' }, h('div', { class: 'stats' },
      h('div', { class: 'stat' }, h('div', { class: 'stat-v' }, String(st)), h('div', { class: 'stat-l' }, 'day streak')),
      h('div', { class: 'stat' }, h('div', { class: 'stat-v' }, Math.round(today) + ' min'), h('div', { class: 'stat-l' }, 'today')),
      h('div', { class: 'stat' }, h('div', { class: 'stat-v' }, Math.round(week) + ' min'), h('div', { class: 'stat-l' }, 'this week')))),
    h('div', { class: 'card tip-card', style: 'margin:0' }, h('span', { class: 'li-ic' }, icon('sparkle', 18)), h('div', {}, h('strong', {}, tt), h('p', { class: 'small' }, td)))));
}

// ---------------------------------------------------------------------------
// Practice hub and its sub-pages (#practice/<id>)
const GROUPS = [
  ['Foundations', ['breath', 'saHold', 'sirens', 'fiveNote', 'aroha', 'intervals', 'pitchMatch']],
  ['Agility', ['alankar3', 'alankar4', 'runs', 'custom']],
  ['Expression', ['meend', 'vibrato', 'kan', 'gamak', 'flips']],
  ['Cool-down', ['cooldown']],
];
function drillCard(id) {
  const d = id === 'custom' ? { name: 'Note Pad', what: 'Type any line of notes, such as a hard phrase from your song, and drill it slowly.' } : exText(EXERCISES[id], settings);
  const mins = id === 'custom' ? '' : `${EXERCISES[id].mins} min`;
  return h('a', { class: 'drill-card', href: '#practice/' + id }, h('strong', {}, d.name), h('small', {}, d.what.split('. ')[0].replace(/\.$/, '') + '.'), h('span', { class: 'd-meta' }, mins));
}
function renderPractice(sub) {
  const root = $('#page-practice');
  for (const k of ['player', 'warm', 'free', 'range']) if (pages[k] && pages[k].stop && pages._sub !== sub) pages[k].stop();
  pages._sub = sub;
  root.innerHTML = '';
  if (!sub) {
    root.append(h('div', { class: 'page-head' }, h('h1', {}, 'Practice'), h('p', { class: 'lead' }, 'Everything is open. Warm up, explore your voice, or work on one skill at a time.')),
      h('div', { class: 'grid3' },
        tile({ href: '#practice/warmup', ic: 'breath', title: 'Warm-up routine', sub: `${WARMUP_ROUTINE.length} short steps · about 8 minutes`, hero: true }),
        tile({ href: '#practice/free', ic: 'wave', title: 'Free sing', sub: 'An open pitch monitor. Sing anything.' }),
        tile({ href: '#practice/range', ic: 'target', title: 'Find your range', sub: settings.rangeLowMidi != null ? `Currently ${westernName(settings.rangeLowMidi)}–${westernName(settings.rangeHighMidi)}` : 'Lowest and highest comfortable notes.' })));
    for (const [g, ids] of GROUPS) root.append(h('div', { class: 'section' }, h('h2', {}, g)), h('div', { class: 'drill-grid' }, ...ids.map(drillCard)));
    return;
  }
  const back = h('a', { class: 'back', href: '#practice' }, icon('back', 18), 'Practice');
  if (sub === 'free') { pages.free = new FreeSing(root); return; }
  if (sub === 'range') {
    root.append(back);
    const host = h('div'); root.append(host);
    pages.range = new RangeFinder(host); return;
  }
  if (sub === 'warmup') {
    const list = h('ol', { class: 'steps' });
    const host = h('div', { class: 'grow' });
    root.append(back, h('div', { class: 'split' }, h('aside', {}, h('h2', {}, 'Warm-up'), h('p', { class: 'muted small' }, 'About 8 minutes. Jump to any step.'), list), host));
    const player = new ExercisePlayer(host);
    let idx = 0;
    const go = (i) => { idx = i; [...list.children].forEach((li, k) => li.classList.toggle('cur', k === i)); player.load(WARMUP_ROUTINE[i]); };
    WARMUP_ROUTINE.forEach((id, i) => list.append(h('li', { onclick: () => go(i) }, exText(EXERCISES[id], settings).name, h('small', {}, `${EXERCISES[id].mins}′`))));
    player.onNext = () => { list.children[idx].classList.add('done'); if (idx + 1 < WARMUP_ROUTINE.length) go(idx + 1); else toast('Warm-up complete. Nice work.', 'good'); };
    player.onDone = () => list.children[idx].classList.add('done');
    pages.warm = { stop: () => player.stop() };
    go(0);
    return;
  }
  if (EXERCISES[sub] || sub === 'custom') {
    const host = h('div');
    root.append(back, host);
    const player = new ExercisePlayer(host);
    player.load(sub);
    pages.player = { stop: () => player.stop() };
    return;
  }
  location.hash = '#practice';
}

// ---------------------------------------------------------------------------
// Progress
function renderProgress() {
  const root = $('#page-progress'); root.innerHTML = '';
  const log = progress.log;
  root.append(h('div', { class: 'page-head' }, h('h1', {}, 'Progress'), h('p', { class: 'lead' }, 'How much you practise, how your scores move, and where each note tends to land.')));
  if (!log.length) { root.append(h('div', { class: 'card flat' }, h('p', { class: 'muted', style: 'margin:0' }, 'Nothing yet. Minutes, scores and your tuning map appear here as you practise.'))); return; }
  const st = streak(); let week = 0; for (let i = 0; i < 7; i++) { const d = new Date(); d.setDate(d.getDate() - i); week += minutesOn(dayKey(d)); }
  const total = log.reduce((x, r) => x + (r.minutes || 0), 0);
  root.append(h('div', { class: 'card' }, h('div', { class: 'stats' },
    h('div', { class: 'stat' }, h('div', { class: 'stat-v' }, String(st)), h('div', { class: 'stat-l' }, 'day streak')),
    h('div', { class: 'stat' }, h('div', { class: 'stat-v' }, Math.round(week) + ' min'), h('div', { class: 'stat-l' }, 'this week')),
    h('div', { class: 'stat' }, h('div', { class: 'stat-v' }, (total / 60).toFixed(1) + ' h'), h('div', { class: 'stat-l' }, 'all time')),
    h('div', { class: 'stat' }, h('div', { class: 'stat-v' }, String(log.filter((r) => r.type === 'song').length)), h('div', { class: 'stat-l' }, 'song takes')))));
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
      h('h3', {}, isIndian(settings) ? 'Microtone map: where each swara lands for you' : 'Tuning map: where each scale degree lands for you'),
      h('p', { class: 'small muted' }, 'Average offset on held notes (recent sessions weigh more). Left = flat, right = sharp. Within ±15¢ is very good.'),
      h('div', { class: 'diverge' }, ...rows.map((r) => {
        const w = (Math.abs(r.b) / lim) * 50;
        return h('div', { class: 'drow', title: `${isIndian(settings) ? SWARA_LONG[r.i] : DEGREE_LONG[r.i]}: ${r.b > 0 ? '+' : ''}${Math.round(r.b)}¢ over ${Math.round(r.n)} samples` },
          h('span', { class: 'dlab' }, isIndian(settings) ? SWARA_SHORT[r.i] + ' · ' + SWARA_LONG[r.i] : DEGREE_LONG[r.i]),
          h('span', { class: 'dtrack' }, h('span', { class: 'dzero' }), h('span', { class: 'dbar ' + (r.b < 0 ? 'flat' : 'sharp'), style: r.b < 0 ? `right:50%;width:${w}%` : `left:50%;width:${w}%` })),
          h('span', { class: 'dval mono' }, (r.b > 0 ? '+' : '') + Math.round(r.b) + '¢'));
      })),
      h('div', { class: 'row small muted spread' }, h('span', {}, 'flat'), h('span', {}, 'sharp'))));
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
    ...notes.map((m) => h('option', { value: m, selected: m === settings.saMidi }, isIndian(settings) ? `${westernName(m)} · ${kattaiName(m % 12)} · ${kaliSafedName(m % 12)}` : westernName(m))));
  const fineOut = h('span', { class: 'mono' }, settings.saFine + '¢');
  const fine = h('input', { type: 'range', min: -50, max: 50, step: 1, value: settings.saFine, oninput: (e) => { fineOut.textContent = e.target.value + '¢'; }, onchange: (e) => saveSettings({ saFine: +e.target.value }) });
  const sel = (key, opts) => h('select', { onchange: (e) => saveSettings({ [key]: isNaN(+e.target.value) ? e.target.value : +e.target.value }) }, ...opts.map(([v, l]) => h('option', { value: v, selected: settings[key] == v }, l)));
  const range = (key, min, max, step, fmt = (v) => v) => {
    const out = h('span', { class: 'mono' }, fmt(settings[key]));
    return h('span', { class: 'row' }, h('input', { type: 'range', min, max, step, value: settings[key], oninput: (e) => (out.textContent = fmt(+e.target.value)), onchange: (e) => saveSettings({ [key]: +e.target.value }) }), out);
  };
  const chk = (key) => h('input', { type: 'checkbox', checked: !!settings[key], onchange: (e) => saveSettings({ [key]: e.target.checked }) });
  const ind = isIndian(settings);
  const styleSel = h('select', { onchange: (e) => { saveSettings({ notation: e.target.value }); renderSettings(); } },
    ...[['western', 'General: any song (note names C D E, scale degrees 1–7)'], ['hindustani', 'Indian, Hindustani sargam (S R G m P D N)'], ['carnatic', 'Indian, Carnatic (S R1 R2 G2 G3 M1 …)']]
      .map(([v, l]) => h('option', { value: v, selected: settings.notation === v }, l)));
  const themeSeg = h('div', { class: 'seg' }, ...[['auto', 'Automatic'], ['light', 'Light'], ['dark', 'Dark']].map(([v, l]) => h('button', { class: (settings.theme || 'auto') === v ? 'on' : '', onclick: () => { saveSettings({ theme: v }); applyTheme(); renderSettings(); } }, l)));
  root.append(h('div', { class: 'page-head' }, h('h1', {}, 'Settings')),
    h('div', { class: 'card form' },
      h('h3', {}, 'Appearance'),
      field('Theme', themeSeg),
    ),
    h('div', { class: 'card form' },
      h('h3', {}, 'Music style'),
      field('Style', styleSel, 'Changes note names, scales, drone and exercise wording. Any song works in either style; pick whichever way of naming notes you think in.'),
    ),
    h('div', { class: 'card form' },
      h('h3', {}, ind ? 'Your tonic (Sa)' : 'Exercise key'),
      field(ind ? 'Sa' : 'Key note', saSel, ind ? 'Run the range test for a suggestion. Typical: men C#3–E3 (1½–3 kattai), women G#3–C4 (5½ kattai and up).' : 'The note warm-ups and drills are built on. Run the range test for a suggestion.'),
      field('Fine tune', h('span', { class: 'row' }, fine, fineOut), ind ? 'For matching a harmonium or shruti box that\'s slightly off.' : 'For matching an instrument that\'s slightly off A=440.'),
      field('Drone sound', sel('droneSound', [['auto', ind ? 'Automatic (tanpura)' : 'Automatic (soft pad)'], ['pad', 'Soft pad (root + fifth)'], ['tanpura', 'Tanpura']])),
      tanpura.kind() === 'tanpura' ? field('Tanpura tuning', sel('tanpuraFirst', [['P', 'Pa – Sa Sa Sa (most ragas)'], ['M', 'Ma – Sa Sa Sa (ragas without Pa)'], ['N', 'Ni – Sa Sa Sa'], ['S', 'Sa – Sa Sa Sa']])) : null,
      field('Drone volume', range('tanpuraVol', 0, 1, 0.05, (v) => Math.round(v * 100) + '%')),
    ),
    h('div', { class: 'card form' },
      h('h3', {}, 'Tuning & scales'),
      field('Note positions', sel('tuning', [['et', 'Equal temperament (piano / most recordings)'], ['just', 'Just intonation (drone-natural, e.g. major 3rd at 386¢)']]), 'Singing against a drone pulls you towards just intervals: major 3rds and 7ths sit slightly lower than on a piano. Indian classical music uses them; most pop and rock recordings are equal-tempered.'),
      field('Default scale', sel('scale', scaleList(settings).map((k) => [k, scaleLabel(k, settings)]))),
    ),
    h('div', { class: 'card form' },
      h('h3', {}, 'Feedback'),
      field('In-tune tolerance', sel('tol', [[50, '±50¢: beginner (half a semitone)'], [35, '±35¢: standard'], [25, '±25¢: strict'], [15, '±15¢: microtone work']])),
      field('Octave-forgiving', h('span', {}, chk('octaveFree'), ' count a note as right in any octave'), 'Useful when singing a song originally sung by another voice type.'),
      field('Blind mode by default', h('span', {}, chk('blind'), ' hide my live line in drills'), 'Practising without constant feedback improves retention (the "guidance hypothesis" in motor learning).'),
    ),
    h('div', { class: 'card form' },
      h('h3', {}, 'Audio'),
      field('Voice separation', sel('sepQuality', [['fast', 'Fast: Spleeter, about a minute'], ['balanced', 'Balanced: Kim Vocal 2, seconds with a graphics card'], ['best', 'Best: Mel-RoFormer, 464 MB download once, a few minutes (needs a graphics card)']]), 'Used when a song is analysed. In testing on 50 real songs: Fast traced 72% of sung notes correctly, Balanced 87%, Best (Mel-RoFormer blended with Kim) 90%, with fewer false notes.'),
      field('Mic sensitivity', range('micSens', 0, 1, 0.05, (v) => Math.round(v * 100) + '%'), 'Raise it if quiet singing isn\'t detected; lower it if room noise is drawn as pitch.'),
      field('Guide volume', range('guideVol', 0, 1, 0.05, (v) => Math.round(v * 100) + '%')),
      field('Guide sound', sel('guideTimbre', [['reed', 'Harmonium-like'], ['sine', 'Pure tone']])),
      field('Extra latency compensation', range('latencyMs', 0, 400, 10, (v) => v + ' ms'), 'If you\'re always reported "behind" with the same amount, set it here (Bluetooth: try 150–250 ms).'),
    ),
    h('div', { class: 'card form' },
      h('h3', {}, 'Data & about'),
      h('p', { class: 'small muted' }, 'Everything (songs, melodies, recordings, progress) stays in this browser. Nothing is uploaded. Swara Lab is free and open source.'),
      h('div', { class: 'row wrap' },
        h('button', { class: 'btn', onclick: () => { const b = new Blob([JSON.stringify({ settings, progress, songs }, null, 1)], { type: 'application/json' }); const a = h('a', { href: URL.createObjectURL(b), download: 'swara-lab-backup.json' }); a.click(); } }, icon('download', 16), 'Export backup'),
        h('button', { class: 'btn', onclick: () => showTour() }, icon('sparkle', 16), 'Show the tour'),
        h('a', { class: 'btn', href: 'https://github.com/kirubes27/swara-lab', target: '_blank', rel: 'noopener' }, icon('globe', 16), 'Source on GitHub'))),
  );
}

// ---------------------------------------------------------------------------
// First-run tour (re-openable from Settings)
const TOUR_ART = {
  line: `<svg viewBox="0 0 500 160" preserveAspectRatio="none"><g stroke="var(--lane-grid)" stroke-width="1">${[30, 55, 80, 105, 130].map((y) => `<line x1="0" x2="500" y1="${y}" y2="${y}"/>`).join('')}</g>
    <path d="M0 110 C 60 110, 80 60, 140 60 S 200 60, 230 90 S 290 120, 320 80 S 380 40, 420 46 S 480 70, 500 66" fill="none" stroke="var(--lane-ref)" stroke-width="16" stroke-linecap="round"/>
    <path d="M0 114 C 50 116, 78 66, 122 63 C 150 61, 160 55, 172 62 C 190 72, 208 68, 226 86 C 246 106, 266 122, 296 90 C 310 74, 318 70, 326 72" fill="none" stroke="var(--good)" stroke-width="4" stroke-linecap="round"/>
    <path d="M326 72 C 344 50, 366 30, 396 44" fill="none" stroke="var(--ok)" stroke-width="4" stroke-linecap="round"/><circle cx="396" cy="44" r="7" fill="var(--accent)"/></svg>`,
  song: `<svg viewBox="0 0 500 160" preserveAspectRatio="none">${Array.from({ length: 62 }, (_, i) => { const x = 8 + i * 7.9, hgt = 14 + 46 * Math.abs(Math.sin(i * 0.55) * Math.cos(i * 0.17)); return `<rect x="${x}" y="${120 - hgt}" width="4" height="${hgt}" rx="2" fill="var(--surface3)"/>`; }).join('')}
    <path d="M10 70 L 60 70 C 70 70, 72 50, 84 50 L 140 50 M 168 62 L 226 62 C 236 62, 238 40, 250 40 L 300 40 M 330 56 L 380 56 C 392 56, 396 76, 408 76 L 490 76" fill="none" stroke="var(--accent)" stroke-width="4" stroke-linecap="round"/>
    <rect x="160" y="18" width="150" height="118" rx="10" fill="var(--lane-loop)" stroke="var(--accent)" stroke-opacity=".4"/></svg>`,
  explore: `<svg viewBox="0 0 500 160">${[['Warm-up', 30, 'var(--accent)'], ['Free sing', 180, 'var(--info)'], ['Drills', 330, 'var(--good)']].map(([t, x, c]) => `<g><rect x="${x}" y="28" width="140" height="104" rx="18" fill="var(--surface)"/><circle cx="${x + 30}" cy="58" r="14" fill="${c}" opacity=".18"/><circle cx="${x + 30}" cy="58" r="5" fill="${c}"/><text x="${x + 18}" y="112" font-family="-apple-system,system-ui,sans-serif" font-size="15" font-weight="600" fill="var(--text)">${t}</text></g>`).join('')}</svg>`,
  phones: `<svg viewBox="0 0 500 160"><g fill="none" stroke="var(--text2)" stroke-width="5" stroke-linecap="round"><path d="M190 110 v-24 a60 60 0 0 1 120 0 v24"/><rect x="176" y="98" width="30" height="44" rx="10" fill="var(--accent)" stroke="none"/><rect x="294" y="98" width="30" height="44" rx="10" fill="var(--accent)" stroke="none"/></g></svg>`,
};
function showTour() {
  document.querySelector('.tour')?.remove();
  let i = 0;
  const slides = [
    { art: 'line', title: 'See your voice.', text: 'As you sing, your voice is drawn as a line over the target melody: green when you\'re on the note, amber when close, red when off. You can see exactly where a note goes sharp, flat or wanders.' },
    { art: 'song', title: 'Learn any song.', text: 'Import a song (or paste a YouTube link). Swara Lab pulls out the vocal melody, splits it into lines and writes out the notes. Loop a line, slow it down, transpose it to your key, and sing against it.' },
    { art: 'explore', title: 'Practise your way.', text: 'Warm-ups, drills for vibrato, runs, slides and high notes, and a free-sing pitch monitor. There are no levels or locks. Explore whatever you like, in any order.' },
    { art: null, title: 'What do you mostly sing?', text: 'This only changes how notes are named. Any song works either way, and you can switch in Settings.', pick: true },
    { art: 'phones', title: 'Two things before you start.', text: 'Wired headphones work best: speakers leak into the mic and Bluetooth adds delay. When the browser asks, allow the microphone. Nothing you sing is uploaded; everything stays on this device.', last: true },
  ];
  const box = h('div', { class: 'tour', role: 'dialog', 'aria-modal': 'true', 'aria-label': 'Welcome tour' });
  const card = h('div', { class: 'tour-card' });
  box.append(card);
  const done = (to) => { saveSettings({ toured: true }); box.remove(); if (to) location.hash = to; };
  const render = () => {
    const s = slides[i];
    card.innerHTML = '';
    const slide = h('div', { class: 'tour-slide' });
    if (s.art) slide.append(h('div', { class: 'tour-art', html: TOUR_ART[s.art] }));
    slide.append(h('h2', {}, s.title), h('p', {}, s.text));
    if (s.pick) slide.append(h('div', { class: 'style-pick' },
      h('button', { class: 'btn' + (!isIndian(settings) ? ' on' : ''), onclick: () => { saveSettings({ notation: 'western' }); render(); } }, 'Any song', h('small', {}, 'Pop, rock, soul, film, musicals. Notes named C D E.')),
      h('button', { class: 'btn' + (isIndian(settings) ? ' on' : ''), onclick: () => { saveSettings({ notation: 'hindustani' }); render(); } }, 'Indian classical / film', h('small', {}, 'Sargam (Sa Re Ga), tanpura, ragas, gamakas.'))));
    const dots = h('div', { class: 'dots' }, ...slides.map((_, k) => h('i', { class: k === i ? 'on' : '' })));
    const nextBtns = s.last
      ? h('div', { class: 'row' }, h('button', { class: 'btn', onclick: () => done('#practice/range') }, 'Find my range'), h('button', { class: 'btn primary', onclick: () => done() }, 'Start exploring'))
      : h('div', { class: 'row' }, i > 0 ? h('button', { class: 'btn ghost', onclick: () => { i--; render(); } }, 'Back') : null, h('button', { class: 'btn primary', onclick: () => { i++; render(); } }, 'Continue'));
    card.append(h('button', { class: 'btn ghost small tour-skip', onclick: () => done() }, 'Skip'), slide, h('div', { class: 'tour-foot' }, dots, nextBtns));
  };
  render();
  document.body.append(box);
  box.addEventListener('keydown', (e) => { if (e.key === 'Escape') done(); });
}

// ---------------------------------------------------------------------------
// Earlier versions registered a service worker; remove it so nobody gets a stale cached copy.
function removeOldServiceWorker() {
  if (!('serviceWorker' in navigator)) return;
  navigator.serviceWorker.getRegistrations().then((rs) => rs.forEach((r) => r.unregister())).catch(() => {});
  if (window.caches) caches.keys().then((ks) => ks.filter((k) => k.startsWith('swaralab')).forEach((k) => caches.delete(k))).catch(() => {});
}

// ---------------------------------------------------------------------------
// Router
const ALIAS = { song: 'songs', warmup: 'practice/warmup', drills: 'practice', range: 'practice/range' };
function route() {
  let hash = location.hash.slice(1) || 'today';
  let [page, sub] = hash.split('/');
  if (page === 'drills' && sub) { location.replace('#practice/' + sub); return; }
  if (ALIAS[page]) { location.replace('#' + ALIAS[page]); return; }
  const ROUTES = ['today', 'songs', 'practice', 'progress', 'learn', 'settings'];
  if (!ROUTES.includes(page)) page = 'today';
  const pageId = page === 'songs' ? 'song' : page;
  if (current === 'song' && pageId !== 'song' && pages.song) pages.song.deactivate();
  if (current === 'practice' && pageId !== 'practice') for (const k of ['player', 'warm', 'free', 'range']) if (pages[k] && pages[k].stop) pages[k].stop();
  current = pageId;
  document.querySelectorAll('.page').forEach((el) => (el.hidden = el.id !== 'page-' + pageId));
  document.querySelectorAll('.nav a, .tabbar a').forEach((a) => a.classList.toggle('active', a.getAttribute('href') === '#' + page));
  document.title = page === 'today' ? 'Swara Lab · singing trainer' : `${page[0].toUpperCase() + page.slice(1)} · Swara Lab`;
  if (pageId === 'today') renderToday();
  if (pageId === 'practice') renderPractice(sub);
  if (pageId === 'song') { if (!pages.song) pages.song = new SongStudio($('#page-song')); pages.song.activate(); pages.song.syncMicBtn(); }
  if (pageId === 'progress') renderProgress();
  if (pageId === 'settings') renderSettings();
  window.scrollTo(0, 0);
}

applyTheme();
hydrateIcons();
setupHeader();
removeOldServiceWorker();
renderHeader();
window.swaraLab = { pages }; // handy for debugging from the console
window.addEventListener('hashchange', route);
route();
if (!settings.toured) setTimeout(showTour, 300);
window.addEventListener('pointerdown', () => audioCtx(), { once: true });
