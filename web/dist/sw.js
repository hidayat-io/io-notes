const CACHE = 'io-notes-shell-v71';
const ASSETS = ['/', '/index.html', '/config.js', '/app.css?v=71', '/app.js?v=71', '/md.css?v=71', '/md.js?v=71', '/manifest.webmanifest?v=71', '/icon-note-192.png', '/icon-note-512.png', '/icon-note-maskable-512.png', '/favicon-io-notes.png'];
const ASSET_PATHS = new Set(['/app.css', '/app.js', '/md.css', '/md.js', '/manifest.webmanifest', '/icon-note-192.png', '/icon-note-512.png', '/icon-note-maskable-512.png', '/favicon-io-notes.png', '/favicon.ico', '/icon.svg']);

self.addEventListener('install', (e) => {
  // No skipWaiting here: the page decides when to swap, so an open editor is never
  // reloaded mid-edit. It posts {type:'skip-waiting'} once the local save is flushed.
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(ASSETS)));
});

self.addEventListener('message', (e) => {
  if (e.data && e.data.type === 'skip-waiting') self.skipWaiting();
});

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

// config.js only carries per-deployment settings (auth mode, client id, limits):
// serve the cached copy at once and refresh it for the next launch.
function staleWhileRevalidate(e) {
  return caches.open(CACHE).then(async (c) => {
    const hit = await c.match(e.request);
    const fresh = fetch(e.request).then((r) => {
      if (r.ok) return c.put(e.request, r.clone()).then(() => r);
      return r;
    });
    if (!hit) return fresh;
    e.waitUntil(fresh.catch(() => {}));
    return hit;
  });
}

self.addEventListener('fetch', (e) => {
  if (e.request.method !== 'GET') return;
  const u = new URL(e.request.url);
  if (u.origin !== self.location.origin) return;
  if (u.pathname.startsWith('/api/') || u.pathname === '/sw.js') return;

  // The app is hash-routed, so every launch requests "/". Serve the cached shell
  // without asking the network: it only references versioned assets, and a new
  // version arrives through the waiting worker and the page's "Reload" toast.
  if (e.request.mode === 'navigate') {
    if (u.pathname === '/' || u.pathname === '/index.html') {
      e.respondWith(caches.match('/index.html').then((hit) => hit || fetch(e.request)));
    }
    return;
  }

  if (u.pathname === '/config.js') {
    e.respondWith(staleWhileRevalidate(e));
    return;
  }

  // Cache only the immutable application shell. Runtime-caching every same-origin
  // GET made cache storage grow forever as URLs and assets changed.
  if (ASSET_PATHS.has(u.pathname)) {
    e.respondWith(caches.match(e.request).then((hit) => hit || fetch(e.request)));
  }
});

self.addEventListener('sync', (e) => {
  if (e.tag !== 'io-notes-outbox') return;
  e.waitUntil(self.clients.matchAll({ includeUncontrolled: true, type: 'window' })
    .then((cs) => cs.forEach((c) => c.postMessage({ type: 'io-notes-sync' }))));
});
