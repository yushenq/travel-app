// Offline cache for the app itself. Bump VERSION on every release so phones pick up the new files.
const VERSION = 'v2';
const CACHE = 'travel-shell-' + VERSION;
const SHELL = [
  './', 'index.html', 'styles.css', 'app.js', 'db.js', 'map.js', 'config.js',
  'manifest.webmanifest', 'vendor/supabase.js', 'vendor/591.supabase.js',
  'icons/icon-192.png', 'icons/icon-512.png', 'icons/maskable-512.png'
];

self.addEventListener('install', e => {
  e.waitUntil(caches.open(CACHE).then(c => c.addAll(SHELL)));
});

self.addEventListener('activate', e => {
  e.waitUntil((async () => {
    for (const k of await caches.keys()) if (k !== CACHE) await caches.delete(k);
    await self.clients.claim();
  })());
});

self.addEventListener('message', e => { if (e.data === 'skipWaiting') self.skipWaiting(); });

self.addEventListener('fetch', e => {
  const req = e.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return; // Supabase calls go straight to the network

  if (req.mode === 'navigate') {
    // Always answer from the cache so the app opens with no signal; refresh it in the background.
    e.respondWith((async () => {
      const cache = await caches.open(CACHE);
      const cached = await cache.match('index.html');
      const net = fetch(req).then(r => { if (r.ok) cache.put('index.html', r.clone()); return r; }).catch(() => null);
      return cached || (await net) || new Response('Offline', { status: 503 });
    })());
    return;
  }

  e.respondWith((async () => {
    const cache = await caches.open(CACHE);
    const cached = await cache.match(req, { ignoreSearch: true });
    if (cached) return cached;
    try {
      const r = await fetch(req);
      if (r.ok) cache.put(req, r.clone());
      return r;
    } catch {
      return new Response('', { status: 504 });
    }
  })());
});
