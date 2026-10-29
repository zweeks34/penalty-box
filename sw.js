/**
 * Service worker: makes Penalty Box work with no signal at the rink.
 *
 * - App shell: pre-cached on install, served cache-first.
 * - teams.json (club team list): network first, cached copy when offline.
 * - Logos referenced by path (logos/*.png): cached the first time they load.
 * - Google Fonts: cached the first time they load (stale-while-revalidate);
 *   if they never loaded, the CSS falls back to system fonts.
 *
 * To ship an update: change CACHE_VERSION. Phones pick up the new version
 * the next time the app is opened with a connection.
 */
const CACHE_VERSION = 'penaltybox-v7';
const FONT_CACHE = 'penaltybox-fonts';

const APP_SHELL = [
  './',
  './index.html',
  './styles.css',
  './js/app.js',
  './js/engine.js',
  './js/teams.js',
  './manifest.webmanifest',
  './icons/icon-192.png',
  './icons/icon-512.png',
  './icons/apple-touch-icon.png',
];

self.addEventListener('install', (event) => {
  event.waitUntil(caches.open(CACHE_VERSION).then((c) => c.addAll(APP_SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (event) => {
  // Drop caches from older versions.
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE_VERSION && k !== FONT_CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim()),
  );
});

self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);

  // Fonts: serve cached copy immediately, refresh in the background.
  if (url.hostname === 'fonts.googleapis.com' || url.hostname === 'fonts.gstatic.com') {
    event.respondWith(
      caches.open(FONT_CACHE).then(async (cache) => {
        const cached = await cache.match(req);
        const network = fetch(req).then((res) => {
          if (res.ok || res.type === 'opaque') cache.put(req, res.clone());
          return res;
        }).catch(() => cached);
        return cached || network;
      }),
    );
    return;
  }

  if (url.origin !== self.location.origin) return;

  // Club team list: network first so edits pushed to GitHub show up; cached copy when offline.
  if (url.pathname.endsWith('/teams.json')) {
    event.respondWith(
      fetch(req).then((res) => {
        if (res.ok) { const copy = res.clone(); caches.open(CACHE_VERSION).then((c) => c.put(req, copy)); }
        return res;
      }).catch(() => caches.match(req, { ignoreSearch: true }).then((r) => r || Response.error())),
    );
    return;
  }

  // App files and logos/: cache first; anything fetched later (e.g. logos/hawks.png) is cached for offline.
  event.respondWith(
    caches.match(req, { ignoreSearch: true }).then((cached) => cached || fetch(req).then((res) => {
      if (res.ok && res.type === 'basic') { const copy = res.clone(); caches.open(CACHE_VERSION).then((c) => c.put(req, copy)); }
      return res;
    }).catch(() => (req.mode === 'navigate' ? caches.match('./index.html') : Response.error()))),
  );
});
