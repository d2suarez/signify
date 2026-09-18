// Signify Learning service worker — installable PWA + offline app shell.
// Strategy:
//   • /api + socket.io transport → network only (never cache live data)
//   • the app's OWN code (HTML, /js, /css) → NETWORK-FIRST, so a deploy takes
//     effect immediately online; the cache is only an offline fallback. (A
//     cache-first app would keep running stale JS after a fix, which is
//     dangerous when the client/server protocol changes.)
//   • heavy, rarely-changing vendor libs + fonts → cache-first, refreshed in
//     the background (they're big and stable).
const CACHE = 'signify-v2';
const SHELL = [
  '/', '/index.html', '/board.html',
  '/css/style.css', '/js/app.js', '/js/whiteboard.js',
  '/socket.io/socket.io.js',
  '/vendor/fabric.min.js', '/vendor/pdf.min.js',
  '/vendor/bricolage-grotesque.woff2',
  '/vendor/opendyslexic-400.woff2', '/vendor/opendyslexic-700.woff2',
  '/manifest.webmanifest', '/icons/icon.svg',
];

self.addEventListener('install', (e) => {
  // best-effort precache; a single missing asset must not abort the install
  e.waitUntil(
    caches.open(CACHE)
      .then((c) => Promise.allSettled(SHELL.map((u) => c.add(u))))
      .then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

function cacheFirst(req) {
  return caches.match(req).then((cached) => {
    const net = fetch(req).then((res) => {
      if (res && res.status === 200 && res.type === 'basic') {
        const clone = res.clone();
        caches.open(CACHE).then((c) => c.put(req, clone));
      }
      return res;
    }).catch(() => cached);
    return cached || net;
  });
}

function networkFirst(req, fallbackPath) {
  return fetch(req).then((res) => {
    if (res && res.status === 200 && res.type === 'basic') {
      const clone = res.clone();
      caches.open(CACHE).then((c) => c.put(req, clone));
    }
    return res;
  }).catch(() => caches.match(req).then((m) => m || (fallbackPath && caches.match(fallbackPath))));
}

self.addEventListener('fetch', (e) => {
  const req = e.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  if (url.origin !== location.origin) return;   // cross-origin (Google, etc.) passes through
  if (url.pathname.startsWith('/api')) return;   // live data: never cache
  // Who is signed in, and their app list. Even as an offline fallback a
  // cached copy would show one person's identity to whoever used the device
  // next, so these always go to the network.
  if (url.pathname.startsWith('/auth/')) return;
  // socket.io transport must always hit the network; the client LIB is cacheable
  // (needed so the page can even boot offline).
  if (url.pathname.startsWith('/socket.io/') && url.pathname !== '/socket.io/socket.io.js') return;

  // Page navigations: fresh when online, cached shell when offline.
  if (req.mode === 'navigate') {
    e.respondWith(networkFirst(req, '/board.html'));
    return;
  }

  // Heavy, stable vendor libs, fonts, icons & the socket.io client lib:
  // cache-first (instant, refresh in the background).
  // The shared Signify chrome is the exception under /vendor/: it changes with
  // the fleet rather than with this app, so it takes the network-first path
  // below and a fix to it lands on the next load, not the one after.
  if ((url.pathname.startsWith('/vendor/') && url.pathname !== '/vendor/signify-switcher.js')
      || url.pathname.startsWith('/icons/') || url.pathname === '/socket.io/socket.io.js') {
    e.respondWith(cacheFirst(req));
    return;
  }

  // The app's own code (js/css/manifest): network-first so deploys land at once.
  e.respondWith(networkFirst(req));
});
