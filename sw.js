// sw.js — tiny service worker so the app opens at once, signal or not.
// Strategy: saved copy first, refreshed in the background. A file that is in the cache is answered
// from it straight away (no waiting on one bar of signal at the gym) while a fresh copy is fetched
// for the next open. A file that is not in the cache yet comes from the network.
// API calls go to another origin and are never touched here.
//
// When deploying a change, bump VERSION (and the ?v= numbers below). The browser then installs this
// file again, which downloads the whole shell fresh into a new cache and drops the old one; app.js
// reloads the page once when that happens (registerServiceWorker), so the new version shows on the
// same open unless she is in the middle of a workout.

const VERSION = 'swa-v17';
const SHELL = [
  './',
  './index.html',
  './styles.css?v=17',
  './app.js?v=17',
  './config.js',
  './videos.js',
  './starting.js',
  './program.json',
  './manifest.webmanifest',
  './icons/icon.svg',
  './icons/icon-192.png',
  './icons/icon-512.png',
  './icons/apple-touch-icon.png',
];
// The local preview (python -m http.server) is left alone, so an edit shows on the next reload.
const LOCAL = self.location.hostname === 'localhost' || self.location.hostname === '127.0.0.1';

self.addEventListener('install', event => {
  event.waitUntil(
    caches.open(VERSION)
      // cache: 'reload' skips the browser's own HTTP cache, so a new version never precaches old files
      .then(cache => Promise.all(SHELL.map(url => cache.add(new Request(url, { cache: 'reload' })).catch(() => null))))
      .then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', event => {
  event.waitUntil(
    caches.keys()
      .then(keys => Promise.all(keys.filter(k => k !== VERSION).map(k => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', event => {
  const req = event.request;
  if (req.method !== 'GET' || LOCAL) return;
  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return;       // the Apps Script and its redirects
  event.respondWith(cacheFirst(event));
});

async function cacheFirst(event) {
  const req = event.request;
  const cache = await caches.open(VERSION);
  const cached = await cache.match(req);
  // 'no-cache' = ask the server whether the file changed (a cheap "not modified" when it didn't)
  const refresh = fetch(req.url, { cache: 'no-cache' }).then(res => {
    if (res && res.ok && !res.redirected) cache.put(req, res.clone());
    return res;
  });
  if (cached) {
    event.waitUntil(refresh.catch(() => null));          // keep the worker alive until the refresh lands
    return cached;
  }
  try {
    return await refresh;
  } catch (e) {
    if (req.mode === 'navigate') {
      const shell = await cache.match('./index.html');
      if (shell) return shell;
    }
    throw e;
  }
}
