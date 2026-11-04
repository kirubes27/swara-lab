// Service worker: makes Swara Lab installable and usable offline.
// Network-first for the app's own files (so updates arrive immediately),
// falling back to the cached copy when offline. Third-party requests (YouTube) pass through.
const CACHE = 'swaralab-v3';
const SHELL = ['./', 'index.html', 'css/style.css', 'manifest.webmanifest', 'icons/icon-192.png',
  'js/app.js', 'js/audio.js', 'js/coach.js', 'js/dsp.js', 'js/exercises.js', 'js/lane.js', 'js/melody.js',
  'js/music.js', 'js/practice.js', 'js/range.js', 'js/song.js', 'js/sound.js', 'js/store.js', 'js/ui.js', 'js/worker.js'];

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting()));
});
self.addEventListener('activate', (e) => {
  e.waitUntil(caches.keys().then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k)))).then(() => self.clients.claim()));
});
self.addEventListener('fetch', (e) => {
  const req = e.request;
  if (req.method !== 'GET' || new URL(req.url).origin !== self.location.origin) return;
  e.respondWith((async () => {
    try {
      const res = await fetch(req, { cache: 'no-cache' });
      if (res.ok) { const c = await caches.open(CACHE); c.put(req, res.clone()); }
      return res;
    } catch {
      const hit = await caches.match(req, { ignoreSearch: true });
      return hit || (req.mode === 'navigate' ? caches.match('index.html') : Response.error());
    }
  })());
});
