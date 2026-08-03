const CACHE = 'io-notes-shell-v25';
const ASSETS = ['/', '/index.html', '/app.css?v=25', '/app.js?v=25', '/manifest.webmanifest?v=25', '/icon-note-192.png', '/icon-note-512.png', '/icon-note-maskable-512.png', '/favicon-io-notes.png'];
const NAV_TIMEOUT = 3000;

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

function navigateWithTimeout(request) {
  return new Promise((resolve) => {
    let settled = false;
    const fallback = () => {
      if (settled) return;
      settled = true;
      caches.match('/index.html').then((r) => resolve(r || Response.error()));
    };
    const timer = setTimeout(fallback, NAV_TIMEOUT);
    fetch(request).then((r) => {
      clearTimeout(timer);
      if (settled) return;
      settled = true;
      resolve(r);
    }).catch(() => { clearTimeout(timer); fallback(); });
  });
}

self.addEventListener('fetch', (e) => {
  if (e.request.method !== 'GET') return;
  const u = new URL(e.request.url);
  if (u.origin !== self.location.origin) return;
  if (u.pathname.startsWith('/api/') || u.pathname === '/config.js' || u.pathname === '/sw.js') return;

  if (e.request.mode === 'navigate') {
    e.respondWith(navigateWithTimeout(e.request));
    return;
  }

  e.respondWith(caches.match(e.request).then((hit) => hit || fetch(e.request).then((r) => {
    if (r.ok) {
      const copy = r.clone();
      caches.open(CACHE).then((c) => c.put(e.request, copy));
    }
    return r;
  })));
});

self.addEventListener('sync', (e) => {
  if (e.tag !== 'io-notes-outbox') return;
  e.waitUntil(self.clients.matchAll({ includeUncontrolled: true, type: 'window' })
    .then((cs) => cs.forEach((c) => c.postMessage({ type: 'io-notes-sync' }))));
});
