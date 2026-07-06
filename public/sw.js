// Service worker: network-first con fallback a cache para los estaticos.
// Nunca toca /socket.io, /health ni /fs/ (tiempo real y transferencias).
const CACHE = 'wibetunnel-v1';
const PRECACHE = [
  '/',
  '/manifest.json',
  '/css/base.css',
  '/css/layout.css',
  '/css/overlays.css',
  '/vendor/xterm.css',
  '/vendor/xterm.js',
  '/vendor/xterm-addon-fit.js',
  '/vendor/xterm-addon-search.js',
  '/vendor/xterm-addon-webgl.js',
  '/vendor/xterm-addon-web-links.js',
  '/js/main.js',
  '/js/state.js',
  '/js/socket.js',
  '/js/sessions.js',
  '/js/theme.js',
  '/js/ui.js',
  '/js/settings.js',
  '/js/palette.js',
  '/js/filebrowser.js',
  '/js/statuspanel.js',
  '/icons/icon-192.png',
  '/icons/icon-512.png',
];

self.addEventListener('install', (e) => {
  e.waitUntil(
    caches.open(CACHE).then((c) => c.addAll(PRECACHE)).then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (e) => {
  if (e.request.method !== 'GET') return;
  const url = new URL(e.request.url);
  if (url.origin !== self.location.origin) return;
  if (url.pathname.startsWith('/socket.io') || url.pathname === '/health' || url.pathname.startsWith('/fs/')) return;

  // Network-first: la app siempre fresca; el cache solo entra sin red
  e.respondWith(
    fetch(e.request)
      .then((res) => {
        if (res.ok) {
          const clone = res.clone();
          caches.open(CACHE).then((c) => c.put(e.request, clone));
        }
        return res;
      })
      .catch(() => caches.match(e.request, { ignoreSearch: url.pathname === '/' }))
  );
});
