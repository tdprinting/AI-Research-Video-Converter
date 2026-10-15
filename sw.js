// Offline support: the app shell is cached so the Home Screen app opens
// without a connection. Pages are fetched fresh when online so updates show up.
const CACHE = 'shrinker-v1';
const SHELL = [
  './',
  'index.html',
  'style.css',
  'js/app.js',
  'js/planner.js',
  'manifest.webmanifest',
  'icons/apple-touch-icon.png',
  'icons/icon-192.png',
  'vendor/mediabunny-1.60.0.min.mjs',
  'vendor/mediabunny-aac-encoder-1.60.0.min.mjs',
];

self.addEventListener('install', (event) => {
  event.waitUntil(caches.open(CACHE).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim()),
  );
});

self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET' || new URL(req.url).origin !== location.origin) return;
  // Versioned vendor files never change: serve from cache first.
  if (req.url.includes('/vendor/')) {
    event.respondWith(caches.match(req).then((hit) => hit || fetch(req)));
    return;
  }
  // Everything else: network first, cache as fallback, refreshing the cache.
  event.respondWith(
    fetch(req)
      .then((res) => {
        if (res.ok) {
          const copy = res.clone();
          caches.open(CACHE).then((c) => c.put(req, copy));
        }
        return res;
      })
      .catch(() => caches.match(req).then((hit) => hit || caches.match('./'))),
  );
});
