// Check this device: what this browser and OS can do, the fix for anything that won't work, and a
// measurement of what differs between machines (the microphone signal, the speaker-to-mic delay).
import { audioCtx, mic, createTap, masterOut, setMasterMuted } from './audio.js';
import { settings, saveSettings, onSettings } from './store.js';
import { h, toast, ensureMic, sheet } from './ui.js';
import { icon } from './icons.js';
import { westernName, hzToMidi, median, percentile } from './music.js';

// ---------------------------------------------------------------------------
// Browser and OS
const PLATFORM_OS = { macOS: 'macOS', Windows: 'Windows', Linux: 'Linux', Android: 'Android', iOS: 'iOS', 'Chrome OS': 'ChromeOS', ChromeOS: 'ChromeOS', 'Chromium OS': 'ChromeOS' };
// navigator.userAgentData brands (Chromium only), most specific first
const BRANDS = [[/Edge/, 'Edge'], [/Opera/, 'Opera'], [/Brave/, 'Brave'], [/Samsung/, 'Samsung Internet'], [/Yandex/, 'Yandex'], [/Vivaldi/, 'Vivaldi'], [/Google Chrome/, 'Chrome'], [/Chromium|HeadlessChrome/, 'Chromium']];
// user-agent string, for Firefox, Safari and anything without userAgentData; most specific first
const UA_NAMES = [[/Edg(?:e|A|iOS)?\/(\d+)/, 'Edge'], [/OPR\/(\d+)|OPiOS\/(\d+)/, 'Opera'], [/SamsungBrowser\/(\d+)/, 'Samsung Internet'], [/YaBrowser\/(\d+)/, 'Yandex'],
  [/Vivaldi\/(\d+)/, 'Vivaldi'], [/(?:Firefox|FxiOS)\/(\d+)/, 'Firefox'], [/CriOS\/(\d+)/, 'Chrome'], [/(?:Chromium|HeadlessChrome)\/(\d+)/, 'Chromium'], [/Chrome\/(\d+)/, 'Chrome'],
  [/Version\/(\d+(?:\.\d+)?).*Safari\//, 'Safari']];

// chromium / firefox / safari name the engine: every browser on iPhone and iPad is Safari underneath.
// webgpu only says the API exists; gpuInfo() says whether there is a graphics adapter behind it.
export function browserInfo() {
  const nav = globalThis.navigator || {}, ua = nav.userAgent || '', uad = nav.userAgentData;
  const brands = (uad && uad.brands) || [];
  let os = (uad && PLATFORM_OS[uad.platform]) || '';
  if (!os) {
    os = /iPhone|iPod/.test(ua) ? 'iOS' : /iPad/.test(ua) || (/Macintosh/.test(ua) && nav.maxTouchPoints > 1) ? 'iPadOS'
      : /Android/.test(ua) ? 'Android' : /CrOS/.test(ua) ? 'ChromeOS' : /Windows/.test(ua) ? 'Windows'
        : /Macintosh|Mac OS X/.test(ua) ? 'macOS' : /Linux|X11|BSD/.test(ua) ? 'Linux' : 'Unknown';
  }
  const apple = os === 'iOS' || os === 'iPadOS';
  let name = '', version = '';
  for (const [re, n] of BRANDS) { const x = brands.find((y) => re.test(y.brand)); if (x) { name = n; version = x.version; break; } }
  if (!name) for (const [re, n] of UA_NAMES) { const m = ua.match(re); if (m) { name = n; version = m[1] || m[2] || ''; break; } }
  if (nav.brave) name = 'Brave';
  const chromium = !apple && (brands.some((y) => /Chromium|HeadlessChrome/.test(y.brand)) || /Chrome\/|Chromium\//.test(ua));
  const firefox = !apple && !chromium && /Firefox\//.test(ua);
  const safari = apple || (!chromium && !firefox && /AppleWebKit\//.test(ua));
  if (!name) name = safari ? 'Safari' : 'Unknown';
  if (name === 'Safari' && !apple && os !== 'macOS') { name = 'WebKit browser'; version = ''; } // e.g. GNOME Web on Linux
  const mobile = !!(uad && uad.mobile) || apple || os === 'Android';
  const gdm = !!(nav.mediaDevices && nav.mediaDevices.getDisplayMedia);
  return { os, name, version, chromium, firefox, safari, mobile, tabAudio: chromium && !mobile && gdm, webgpu: !!nav.gpu };
}

// ---------------------------------------------------------------------------
// Graphics adapter for voice separation (WebGPU). Resolves, never rejects.
let gpuP = null;
export async function gpuInfo() {
  if (!gpuP) gpuP = probeGpu().then((r) => { if (r.reason === 'timeout') gpuP = null; return r; });
  return gpuP;
}
async function probeGpu() {
  const none = { ok: false, vendor: '', architecture: '', description: '', fallback: false };
  try {
    const gpu = globalThis.navigator && navigator.gpu;
    if (!gpu) return { ...none, reason: 'no-api' };
    const adapter = await Promise.race([gpu.requestAdapter(), sleep(5000).then(() => 'timeout')]);
    if (adapter === 'timeout') return { ...none, reason: 'timeout' };
    if (!adapter) return { ...none, reason: 'no-adapter' };
    let info = adapter.info;
    if (!info && typeof adapter.requestAdapterInfo === 'function') info = await adapter.requestAdapterInfo().catch(() => null);
    info = info || {};
    return {
      ok: true, vendor: info.vendor || '', architecture: info.architecture || '', description: info.description || '',
      fallback: !!(info.isFallbackAdapter ?? adapter.isFallbackAdapter), // a software renderer: no faster than WebAssembly
      f16: !!(adapter.features && adapter.features.has('shader-f16')),
    };
  } catch (e) {
    return { ...none, reason: 'error', error: String((e && e.message) || e) };
  }
}

// ---------------------------------------------------------------------------
// Recording a tab's sound (getDisplayMedia with "Also share tab audio") works only in desktop Chromium.
const OR_FILE = 'or import the song as an audio file.';
export function captureBlocker(b = browserInfo()) {
  if (b.mobile) return { title: "Phones and tablets can't record a tab's sound", detail: 'Open this site in Chrome or Edge on a computer, ' + OR_FILE };
  if (b.firefox) return { title: "Firefox can't record a tab's sound", detail: 'Open this site in Chrome or Edge, ' + OR_FILE };
  if (b.safari) return { title: "Safari can't record a tab's sound", detail: 'Open this site in Chrome or Edge, ' + OR_FILE };
  if (!globalThis.isSecureContext) return { title: 'Recording a tab needs a secure page', detail: 'Open the https:// address of this site, ' + OR_FILE };
  const md = globalThis.navigator && navigator.mediaDevices;
  if (!(md && md.getDisplayMedia)) return { title: `${b.name} can't share a tab's sound`, detail: `Update ${b.name} to the latest version, ` + OR_FILE };
  if (!b.chromium) return { title: `${b.name} may not record a tab's sound`, detail: 'Chrome and Edge work best, ' + OR_FILE };
  return null;
}

// ---------------------------------------------------------------------------
// Speaker-to-mic delay: play short clicks at known context times, find them in a raw (unprocessed)
// mic recording, and save the part of the round trip the app's own estimate doesn't cover.
const CLICKS = 6, CLICK_HZ = 2000, CLICK_S = 0.01, WIN_S = 0.7, SPREAD_S = 0.025;

export async function measureDelay({ onProgress, cancelled = () => false } = {}) {
  const c = audioCtx();
  const out = { ok: false, reason: '', total: CLICKS, found: 0, hits: null, rt: null, spread: null, latencyMs: null, saved: false, sr: c.sampleRate };
  const wasRunning = mic.running;
  if (wasRunning) { mic.stop(); micChanged(); } // its echo cancellation would remove the clicks
  const unmute = masterOut().gain.value > 0.5;
  if (unmute) setMasterMuted(true); // the drone and guide tone would mask the clicks
  let stream = null, src = null, tap = null;
  const srcs = [];
  try {
    if (c.state !== 'running') await Promise.race([c.resume(), sleep(1500)]).catch(() => {});
    try {
      stream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: false, noiseSuppression: false, autoGainControl: false } });
    } catch (e) {
      out.reason = e && e.name === 'NotAllowedError' ? 'blocked' : 'nomic'; out.error = String((e && e.message) || e);
      return out;
    }
    src = c.createMediaStreamSource(stream);
    tap = await createTap(c);
    const blocks = [];
    tap.port.onmessage = (e) => blocks.push(e.data);
    src.connect(tap);
    const sr = c.sampleRate, buf = clickBuffer(c), times = [];
    let t = c.currentTime + 0.8; // ~0.7 s of background before the first click
    for (let k = 0; k < CLICKS; k++) {
      const s = c.createBufferSource();
      s.buffer = buf; s.connect(c.destination); s.start(t);
      srcs.push(s); times.push(t);
      t += 0.5 + Math.random() * 0.2; // uneven gaps, so a regular noise (a ticking clock) can't pass for the clicks
    }
    const until = times[CLICKS - 1] + WIN_S + 0.03;
    const deadline = performance.now() + (until - c.currentTime + 3) * 1000;
    for (;;) {
      const last = blocks.length ? blocks[blocks.length - 1].t + 128 / sr : 0;
      if (last >= until) break;
      if (cancelled()) { out.reason = 'cancelled'; return out; }
      if (performance.now() > deadline) { out.reason = 'error'; out.error = 'no audio arrived from the microphone'; return out; }
      if (onProgress) onProgress(times.filter((x) => c.currentTime >= x).length);
      await sleep(40);
    }
    if (onProgress) onProgress(CLICKS);
    Object.assign(out, findClicks(blocks, times, sr), { baseLatency: c.baseLatency, outputLatency: c.outputLatency });
    if (out.ok) {
      // song.js: lat = mic.latencySec() + (outputLatency || 0.02) + latencyMs / 1000 should equal the
      // round trip plus the analysis window's half (1024 samples)
      const ms = Math.round(1000 * (out.rt + 1024 / sr - mic.latencySec() - (c.outputLatency || 0.02)));
      out.latencyMs = Math.max(-200, Math.min(600, ms));
      saveSettings({ latencyMs: out.latencyMs });
      out.saved = true;
    }
    return out;
  } catch (e) {
    out.reason = 'error'; out.error = String((e && e.message) || e);
    return out;
  } finally {
    for (const s of srcs) { try { s.stop(); } catch {} s.disconnect(); }
    if (tap) { tap.port.onmessage = null; tap.disconnect(); if (tap._sink) tap._sink.disconnect(); }
    if (src) src.disconnect();
    if (stream) stream.getTracks().forEach((tr) => tr.stop());
    if (unmute) setMasterMuted(false);
    if (wasRunning) await ensureMic();
  }
}

// 10 ms at 2 kHz with 0.5 ms fades: short, sharp, easy for any speaker and mic.
function clickBuffer(c) {
  const sr = c.sampleRate, n = Math.round(CLICK_S * sr), ramp = Math.round(0.0005 * sr);
  const b = c.createBuffer(1, n, sr), d = b.getChannelData(0);
  for (let i = 0; i < n; i++) {
    const e = i < ramp ? 0.5 - 0.5 * Math.cos((Math.PI * i) / ramp) : i >= n - ramp ? 0.5 - 0.5 * Math.cos((Math.PI * (n - 1 - i)) / ramp) : 1;
    d[i] = 0.7 * e * Math.sin((2 * Math.PI * CLICK_HZ * i) / sr);
  }
  return b;
}

function findClicks(blocks, times, sr) {
  if (!blocks.length) return { reason: 'error', error: 'no audio' };
  // A tap block's t is the context time of its last 128-frame render quantum, so its first sample
  // is 896 frames earlier. Placing each block by its own stamp keeps every sample on context time.
  const Q = 896 / sr, t0 = blocks[0].t - Q;
  const n = Math.round((blocks[blocks.length - 1].t - Q - t0) * sr) + 1024;
  const L = new Float32Array(n), R = new Float32Array(n);
  for (const b of blocks) {
    const o = Math.round((b.t - Q - t0) * sr);
    if (o >= 0 && o + 1024 <= n) { L.set(b.L, o); R.set(b.R, o); }
  }
  // band-pass around the click; take the louder channel (some laptop mic pairs are wired out of phase)
  const fl = bandpass(L, CLICK_HZ, 2, sr), fr = bandpass(R, CLICK_HZ, 2, sr), env = new Float32Array(n);
  for (let i = 0; i < n; i++) env[i] = Math.max(Math.abs(fl[i]), Math.abs(fr[i]));
  const at = (t) => Math.max(0, Math.min(n, Math.round((t - t0) * sr)));
  const pre = env.subarray(at(Math.max(t0 + 0.1, times[0] - 0.6)), at(times[0]));
  if (pre.length < 0.1 * sr) return { reason: 'error', error: 'too little audio before the first click' };
  const noise = percentile(pre, 0.995);
  const peaks = times.map((t) => { let p = 0; for (let i = at(t), e = at(t + WIN_S); i < e; i++) if (env[i] > p) p = env[i]; return p; });
  const P = median(peaks), floor = Math.max(4 * noise, 3e-4);
  const res = { noiseDb: dbfs(noise), clickDb: dbfs(P), hits: times.map(() => false) };
  if (!(P >= 2 * floor)) return { ...res, reason: 'quiet' };
  // first crossing of a threshold well above the background, confirmed as a burst rather than a spike
  const thr = Math.max(floor, 0.2 * P), hold = Math.round(0.005 * sr);
  const rts = times.map((t) => {
    for (let i = at(t), e = at(t + WIN_S); i < e; i++) {
      if (env[i] < thr) continue;
      const j1 = Math.min(n, i + hold);
      let s = 0;
      for (let j = i; j < j1; j++) s += env[j];
      if (s / (j1 - i) >= 0.5 * thr) return t0 + i / sr - t;
    }
    return NaN;
  });
  // the largest group of round trips that agree within 25 ms
  const found = rts.filter((x) => !isNaN(x)).sort((a, b) => a - b);
  let best = [];
  for (let i = 0; i < found.length; i++) {
    let j = i;
    while (j + 1 < found.length && found[j + 1] - found[i] <= SPREAD_S) j++;
    if (j - i + 1 > best.length) best = found.slice(i, j + 1);
  }
  Object.assign(res, { rts, hits: rts.map((x) => best.includes(x)), found: best.length });
  if (best.length >= 4) return { ...res, ok: true, rt: median(best), spread: best[best.length - 1] - best[0] };
  return { ...res, reason: found.length < 4 ? 'quiet' : 'inconsistent' };
}

// RBJ band-pass (0 dB peak), run forwards: about 0.3 ms of delay at the centre, negligible here
function bandpass(x, f0, q, sr) {
  const w = (2 * Math.PI * f0) / sr, al = Math.sin(w) / (2 * q), a0 = 1 + al;
  const b0 = al / a0, b2 = -al / a0, a1 = (-2 * Math.cos(w)) / a0, a2 = (1 - al) / a0;
  const y = new Float32Array(x.length);
  let x1 = 0, x2 = 0, y1 = 0, y2 = 0;
  for (let i = 0; i < x.length; i++) {
    const v = b0 * x[i] + b2 * x2 - a1 * y1 - a2 * y2;
    x2 = x1; x1 = x[i]; y2 = y1; y1 = v; y[i] = v;
  }
  return y;
}

// ---------------------------------------------------------------------------
// The panel
const MIC_SECS = 10;
const SILENT = 0.002, LOUD = 0.3, MIN_VOICED = 12; // mic RMS: about -54 dBFS, about -10 dBFS; frames with a note
const OS_LABEL = { Windows: 'Windows', macOS: 'macOS', Linux: 'Linux', ChromeOS: 'ChromeOS', Android: 'Android', iOS: 'iOS', iPadOS: 'iPadOS' };
const OS_TIPS = {
  Windows: { title: 'Tips for Windows', items: [
    ['Song gets quieter when the mic is on?', 'Sound settings → More sound settings → Communications → "Do nothing".'],
    ['Pitch line breaks up?', 'Turn off "Audio enhancements" for the microphone in Sound settings.'],
  ] },
  Linux: { title: 'Tips for Linux', items: [
    ['Input volume:', 'set it to 80–100% in the sound settings (PipeWire or PulseAudio).'],
    ['Sharing a tab:', 'in Chrome\'s share dialog, pick the tab and keep "Also share tab audio" on.'],
  ] },
  macOS: { title: 'Tips for Mac', note: 'Nothing special to set up.', items: [
    ['Mic hears nothing?', 'System Settings → Privacy & Security → Microphone, and allow your browser.'],
  ] },
};
const SPEAKER_HINT = "Turn the speakers up and try again in a quiet room. It can't be measured with headphones; Bluetooth adds about 150–250 ms.";
const DELAY_FAIL = {
  quiet: ['warn', "Couldn't hear the clicks", SPEAKER_HINT],
  inconsistent: ['warn', "The clicks didn't line up", SPEAKER_HINT],
  blocked: ['bad', 'Microphone blocked', 'Allow it from the site settings next to the address bar, then try again.'],
  nomic: ['bad', "Couldn't open the microphone", 'Check the input device in your system sound settings.'],
  error: ['bad', "Couldn't measure in this browser", 'Reload the page and try again.'],
};
const STATE_LABEL = { ok: 'Works', warn: 'Needs attention', bad: 'Not working', busy: 'Checking', live: 'Running', idle: 'Not tested yet' };
const GLYPHS = {
  ok: () => icon('check', 18),
  bad: () => icon('close', 16),
  warn: () => { const s = icon('check', 18); s.innerHTML = '<path d="M12 6.5v7.2"/><circle cx="12" cy="17.6" r="1.2" fill="currentColor" stroke="none"/>'; return s; },
};
const VENDORS = { nvidia: 'NVIDIA', amd: 'AMD', ati: 'AMD', intel: 'Intel', apple: 'Apple', qualcomm: 'Qualcomm', arm: 'Arm', microsoft: 'Microsoft', google: 'Google', mesa: 'Mesa', imagination: 'Imagination' };
const handles = new WeakMap();

// Renders the check into container (appended; an earlier check in the same container is replaced).
// Returns { el, destroy }. Tests still running stop by themselves when the panel leaves the page.
export function renderDeviceCheck(container, { title = 'Check this device' } = {}) {
  for (const old of container.querySelectorAll(':scope > .dc')) (handles.get(old) || { destroy: () => old.remove() }).destroy();
  const b = browserInfo();
  const rep = { browser: b, gpu: null, mic: null, delay: null };
  let destroyed = false, seen = false, busy = false, stopMicTest = null;
  const root = h('div', { class: 'list dc' });
  const gone = () => { if (root.isConnected) seen = true; return destroyed || (seen && !root.isConnected); };

  root.append(h('div', { class: 'dc-head' },
    h('div', { class: 'dc-head-text' }, title ? h('h3', {}, title) : null, h('p', { class: 'small muted' }, 'What works in this browser, and the timing of your audio.')),
    h('button', { class: 'btn ghost small', type: 'button', onclick: () => copyReport(rep) }, 'Copy details')));
  const rBrowser = row('browser', 'Browser', 'globe');
  const rCapture = row('capture', 'Song capture from tabs', 'record');
  const rSep = row('separation', 'Voice separation', 'sparkle');
  const rMic = row('mic', 'Microphone', 'mic');
  const rDelay = row('delay', 'Delay', 'slow');
  const rEcho = row('echo', 'Echo cancellation', 'headphones');
  const tips = OS_TIPS[b.os], rTips = tips ? row('tips', tips.title, 'device') : null;
  for (const r of [rBrowser, rCapture, rSep, rMic, rDelay, rEcho, rTips]) if (r) root.append(r.el);

  // browser
  const desc = b.name + (b.version ? ' ' + b.version : '') + (OS_LABEL[b.os] ? ' on ' + OS_LABEL[b.os] : '');
  if (b.chromium && !b.mobile) rBrowser.set('ok', desc);
  else rBrowser.set('warn', desc, b.mobile ? 'Some features need a computer.' : 'Chrome or Edge work best for this site.');

  // tab capture
  const blk = captureBlocker(b);
  if (blk) rCapture.set('bad', blk.title, blk.detail); else rCapture.set('ok', 'Works in this browser');

  // voice separation
  rSep.set('busy', 'Checking the graphics card…');
  gpuInfo().then((g) => {
    rep.gpu = g;
    if (destroyed) return;
    if (g.ok && !g.fallback) {
      rSep.set('ok', 'Graphics card · fast');
      const v = VENDORS[(g.vendor || '').toLowerCase()] || g.vendor;
      rSep.end.textContent = v || '';
      rSep.end.title = [g.vendor, g.architecture, g.description].filter(Boolean).join(' · ');
    } else rSep.set('warn', 'Processor · slower (a few minutes per song)', gpuTip(b));
  });

  // microphone
  const micBtn = h('button', { class: 'btn small', type: 'button', onclick: () => (stopMicTest ? stopMicTest() : micTest()) }, 'Test');
  const delayBtn = h('button', { class: 'btn small', type: 'button', onclick: () => delayTest() }, 'Measure');
  rMic.end.append(micBtn);
  rDelay.end.append(delayBtn);
  rMic.set('idle', 'Sing or hum to check the level.');
  const lock = (on) => { busy = on; micBtn.disabled = on && !stopMicTest; delayBtn.disabled = on; };

  async function micTest() {
    if (busy) return;
    lock(true);
    const wasRunning = mic.running;
    rMic.set('busy', 'Starting the microphone…');
    const ok = await ensureMic();
    if (!ok || gone()) {
      if (ok && !wasRunning) { mic.stop(); micChanged(); }
      lock(false);
      if (!ok) rMic.set('bad', "Couldn't start the microphone", 'Check the input device, and allow the microphone for this site.');
      return;
    }
    const track = mic.stream && mic.stream.getAudioTracks()[0];
    const ts = (track && track.getSettings && track.getSettings()) || {};
    const info = { label: (track && track.label) || '', sr: audioCtx().sampleRate, trackSr: ts.sampleRate || 0, channels: ts.channelCount,
      echoCancellation: ts.echoCancellation, noiseSuppression: ts.noiseSuppression, autoGainControl: ts.autoGainControl, latency: ts.latency };
    const where = [info.label, khz(info.trackSr || info.sr)].filter(Boolean).join(' · ');
    const quiet = Math.max(0.004, (mic.gate || 0.0024) * 3); // comfortably above the level the pitch tracker ignores
    const bar = h('i'), meter = h('div', { class: 'dc-meter quiet' }, bar);
    const note = h('span', { class: 'dc-note' }, '–'), count = h('span', { class: 'dc-count' }, MIC_SECS + ' s');
    rMic.extra.replaceChildren(h('div', { class: 'dc-live' }, meter, note, count));
    rMic.set('live', 'Sing or hum a note', null, where);
    let frames = 0, maxL = 0, lastNote = 0, done = false;
    const voiced = [], names = new Map();
    const off = mic.on((f) => {
      frames++;
      const lv = f.level || 0;
      if (lv > maxL) maxL = lv;
      const db = lv > 0 ? 20 * Math.log10(lv) : -120;
      bar.style.transform = `scaleX(${Math.min(1, Math.max(0, (db + 60) / 54)).toFixed(3)})`;
      meter.className = 'dc-meter' + (lv < quiet ? ' quiet' : lv > LOUD ? ' loud' : '');
      if (f.hz > 0) {
        const nm = westernName(hzToMidi(f.hz));
        voiced.push(lv); names.set(nm, (names.get(nm) || 0) + 1);
        note.textContent = nm; lastNote = f.t;
      } else if (f.t - lastNote > 500) note.textContent = '–';
    });
    const t0 = performance.now();
    const finish = () => {
      if (done) return;
      done = true; stopMicTest = null;
      clearInterval(iv); off();
      if (!wasRunning && mic.running) { mic.stop(); micChanged(); }
      micBtn.textContent = 'Test';
      lock(false);
      rMic.extra.replaceChildren();
      const v = micVerdict({ frames, maxL, voiced, names, label: info.label, quiet });
      rep.mic = { ...info, frames, voiced: voiced.length, peakDb: dbfs(maxL), voicedDb: dbfs(median(voiced)), verdict: v[1] };
      if (!destroyed) rMic.set(v[0], v[1], v[2], where);
    };
    stopMicTest = finish;
    micBtn.textContent = 'Stop';
    micBtn.disabled = false;
    const iv = setInterval(() => {
      const left = MIC_SECS - (performance.now() - t0) / 1000;
      count.textContent = Math.max(0, Math.ceil(left)) + ' s';
      if (left <= 0 || !mic.running || gone()) finish();
    }, 200);
  }

  // delay
  const delayIdle = () => rDelay.set('idle', 'Lines your singing up with the song.',
    settings.headphones ? "Needs speakers: it can't be measured with headphones." : 'Needs speakers and a quiet room.',
    settings.latencyMs ? `Extra latency compensation: ${settings.latencyMs} ms` : null);
  delayIdle();
  async function delayTest() {
    if (busy) return;
    lock(true);
    audioCtx(); // still inside the click, so audio may start
    const dots = Array.from({ length: CLICKS }, () => h('i'));
    rDelay.extra.replaceChildren(h('div', { class: 'dc-dots', 'aria-hidden': 'true' }, ...dots));
    rDelay.set('live', 'Listening… keep the room quiet');
    const r = await measureDelay({ onProgress: (k) => dots.forEach((d, i) => d.classList.toggle('on', i < k)), cancelled: gone });
    rep.delay = r;
    lock(false);
    if (r.reason === 'cancelled' || destroyed) return;
    dots.forEach((d, i) => { d.classList.remove('on'); d.classList.add(r.hits && r.hits[i] ? 'hit' : 'miss'); });
    if (r.ok) rDelay.set('ok', `Round trip ${Math.round(r.rt * 1000)} ms · saved`, 'Measure again if you change speakers.', `Extra latency compensation: ${r.latencyMs} ms`);
    else {
      const [st, text, more] = DELAY_FAIL[r.reason] || DELAY_FAIL.error;
      rDelay.set(st, text, more);
      if (!r.hits) rDelay.extra.replaceChildren();
    }
  }

  // echo cancellation
  const echo = () => rEcho.set('info', settings.headphones ? 'Off: you said you sing with headphones' : 'On: for speakers, the song is removed from the mic', 'Change it in Settings below.');
  echo();

  // OS tips
  if (rTips) {
    rTips.set('info', tips.note || null);
    rTips.extra.append(h('ul', { class: 'dc-tips' }, ...tips.items.map(([lead, text]) => h('li', {}, h('b', {}, lead), ' ', text))));
  }

  const offSettings = onSettings((s, patch) => {
    if (gone()) { offSettings(); return; }
    if ('headphones' in patch) echo();
    if (('latencyMs' in patch || 'headphones' in patch) && rDelay.el.dataset.state === 'idle') delayIdle();
  });
  const handle = {
    el: root,
    destroy() {
      if (destroyed) return;
      destroyed = true;
      if (stopMicTest) stopMicTest();
      offSettings();
      root.remove();
    },
  };
  handles.set(root, handle);
  container.append(root);
  return handle;
}

// One row: status tile, title, status line, advice, a faint detail line, room for live content.
function row(key, title, topic) {
  const ic = h('span', { class: 'li-ic dc-ic' });
  const main = h('small', { class: 'dc-main' }), sub = h('small', { class: 'dc-sub' }), meta = h('small', { class: 'dc-meta' });
  const extra = h('div', { class: 'dc-extra' }), end = h('span', { class: 'li-end' });
  const el = h('div', { class: 'li dc-row', 'data-check': key }, ic, h('div', { class: 'li-text' }, h('strong', {}, title), main, sub, meta, extra), end);
  const fill = (node, v) => node.replaceChildren(...(v == null || v === '' ? [] : [].concat(v)));
  return {
    el, extra, end,
    set(state, text, more, detail) {
      el.dataset.state = state;
      ic.className = 'li-ic dc-ic ' + state;
      ic.replaceChildren(state === 'busy' ? h('span', { class: 'dc-spin' }) : GLYPHS[state] ? GLYPHS[state]() : icon(topic, 18));
      if (STATE_LABEL[state]) { ic.setAttribute('role', 'img'); ic.setAttribute('aria-label', STATE_LABEL[state]); ic.removeAttribute('aria-hidden'); }
      else { ic.removeAttribute('role'); ic.removeAttribute('aria-label'); ic.setAttribute('aria-hidden', 'true'); }
      fill(main, text); fill(sub, more); fill(meta, detail);
      meta.title = typeof detail === 'string' ? detail : '';
    },
  };
}

function micVerdict({ frames, maxL, voiced, names, label, quiet }) {
  if (/monitor of|stereo mix|what u hear|loopback/i.test(label)) return ['warn', "This input records the computer's sound", 'Choose a microphone as the input in your system sound settings.'];
  if (frames < 20) return ['warn', "The test didn't run", 'Keep this tab in front while testing.'];
  if (maxL < SILENT) return ['bad', 'Nothing heard', "Check the input device in your system sound settings, and that this site may use the microphone."];
  if (voiced.length < MIN_VOICED) {
    return maxL < quiet ? ['warn', 'Very quiet', 'Raise the input volume in your system sound settings.'] : ['warn', 'No clear note heard', 'Sing or hum a steady note, then test again.'];
  }
  const lv = median(voiced);
  if (lv < quiet) return ['warn', 'Quiet signal', 'Raise the input volume in your system sound settings.'];
  if (lv > LOUD) return ['warn', 'Very loud', 'Lower the input volume a little, or sing further from the mic.'];
  const top = [...names].sort((x, y) => y[1] - x[1])[0][0];
  return ['ok', `Good level · heard ${top}`];
}

function gpuTip(b) {
  if (b.mobile) return null;
  if (b.firefox || b.safari) return 'Chrome or Edge may use the graphics card instead.';
  if (b.os === 'Linux') {
    return [`${b.name} on Linux may need WebGPU switched on: `, h('code', {}, 'chrome://flags/#enable-unsafe-webgpu'), ' and ', h('code', {}, '#enable-vulkan'), ', then a restart.'];
  }
  if (b.os === 'Windows') return 'Updating the graphics driver may help.';
  return null;
}

// Plain-text summary, for pasting into a message or an issue when something doesn't work.
async function copyReport(rep) {
  const c = audioCtx();
  if (!c.outputLatency) await sleep(300); // a context that just started reports its latency a moment later
  const text = reportText(rep, c);
  const show = () => sheet('Device details', h('textarea', { class: 'dc-report', readonly: true, rows: 14, spellcheck: 'false', onfocus: (e) => e.target.select() }, text));
  if (navigator.clipboard && navigator.clipboard.writeText) navigator.clipboard.writeText(text).then(() => toast('Details copied', 'good'), show);
  else show();
}
function reportText(rep, c) {
  const b = rep.browser, g = rep.gpu, m = rep.mic, d = rep.delay, nav = navigator;
  const msOf = (s) => (s == null ? '?' : Math.round(s * 1000));
  const dbOf = (x) => (x == null ? 'silent' : x + ' dBFS');
  const blk = captureBlocker(b);
  const gpu = !g ? 'not checked' : g.ok ? [g.vendor, g.architecture, g.description].filter(Boolean).join(' ') + (g.fallback ? ' (software)' : '') + (g.f16 ? ' · shader-f16' : '')
    : `none (${g.reason || 'unknown'}${g.error ? ': ' + g.error : ''})`;
  const micLine = !m ? 'not tested' : `${m.verdict} · ${m.label || 'unnamed input'} · ${m.trackSr || '?'} Hz, ${m.channels || '?'} ch · peak ${dbOf(m.peakDb)}, singing ${dbOf(m.voicedDb)} · ${m.voiced}/${m.frames} frames with a note`
    + ` · echo cancellation ${m.echoCancellation}, noise suppression ${m.noiseSuppression}, auto gain ${m.autoGainControl}${m.latency != null ? ` · input latency ${msOf(m.latency)} ms` : ''}`;
  const delayLine = !d ? 'not measured' : (d.ok ? `round trip ${msOf(d.rt)} ms, spread ${msOf(d.spread)} ms, ${d.found}/${d.total} clicks · saved ${d.latencyMs} ms` : `failed (${d.reason}${d.error ? ': ' + d.error : ''}), ${d.found || 0}/${d.total} clicks`)
    + (d.rts ? ' · each ' + d.rts.map((x) => (isNaN(x) ? '-' : msOf(x))).join(' ') : '')
    + ('noiseDb' in d ? ` · background ${dbOf(d.noiseDb)}, clicks ${dbOf(d.clickDb)}` : '');
  return [
    'Swara Lab device check · ' + new Date().toISOString().slice(0, 16).replace('T', ' ') + ' UTC',
    `Browser: ${b.name} ${b.version} on ${b.os} · engine ${b.chromium ? 'Chromium' : b.firefox ? 'Gecko' : b.safari ? 'WebKit' : 'unknown'}${b.mobile ? ' · mobile' : ''}`,
    'Tab audio: ' + (blk ? 'no (' + blk.title + ')' : 'yes'),
    `WebGPU: API ${b.webgpu ? 'present' : 'missing'} · adapter ${gpu}`,
    `Audio: ${c.sampleRate} Hz · base latency ${msOf(c.baseLatency)} ms · output latency ${msOf(c.outputLatency)} ms · ${c.state}`,
    'Microphone: ' + micLine,
    'Delay: ' + delayLine,
    `Settings: headphones ${settings.headphones ? 'on' : 'off'} · extra latency ${settings.latencyMs || 0} ms · separation ${settings.sepQuality || 'balanced'} · mic sensitivity ${settings.micSens}`,
    `Computer: ${nav.hardwareConcurrency || '?'} threads${nav.deviceMemory ? ' · ' + nav.deviceMemory + ' GB' : ''} · cross-origin isolated ${globalThis.crossOriginIsolated ? 'yes' : 'no'} · screen ${screen.width}×${screen.height} @${devicePixelRatio}`,
    'User agent: ' + nav.userAgent,
  ].join('\n');
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const micChanged = () => document.dispatchEvent(new CustomEvent('mic-change'));
const dbfs = (x) => (x > 0 ? Math.round(20 * Math.log10(x)) : null);
const khz = (sr) => (sr ? +(sr / 1000).toFixed(1) + ' kHz' : '');
