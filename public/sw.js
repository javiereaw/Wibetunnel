// Service worker: network-first con fallback a cache para los estaticos.
// Nunca toca /socket.io, /health ni /fs/ (tiempo real y transferencias).
// __WIBE_BUILD__ lo sustituye el servidor al servir /sw.js (ver server.js):
// cualquier deploy que toque public/ produce un SW byte-distinto → reinstalacion.
const CACHE = 'wibetunnel-__WIBE_BUILD__';
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
  // Vista /claude: hasta ahora no se precacheaba nada suyo, asi que era la
  // unica pagina que no arrancaba sin red ni se beneficiaba del precache.
  '/claude',
  '/css/claude.css',
  '/css/claude-chat.css',
  '/css/claude-tools.css',
  '/css/claude-files.css',
  '/js/shell-quote.js',
  '/js/claude/app.js',
  '/js/claude/tabs.js',
  '/js/claude/net.js',
  '/js/claude/stream.js',
  '/js/claude/peek.js',
  '/js/claude/status.js',
  '/js/claude/fsapi.js',
  '/js/claude/files.js',
  '/js/claude/editor.js',
  '/js/claude/render/index.js',
  '/js/claude/render/item.js',
  '/js/claude/render/card.js',
  '/js/claude/render/dom.js',
  '/js/claude/render/tools.js',
  '/js/claude/render/tools-extra.js',
  '/js/claude/render/diff.js',
  '/js/claude/render/system.js',
  '/js/claude/render/md.js',
  '/js/claude/render/inline.js',
  '/js/claude/render/hl.js',
  '/js/claude/render/decorate.js',
  '/js/claude/render/search.js',
  '/js/claude/chrome.js',
];

self.addEventListener('install', (e) => {
  e.waitUntil(
    // cache:'no-cache' tambien en el precache: sin esto la instalacion puede
    // sembrarse desde copias stale impuestas por el proxy (el fix del fetch
    // handler no cubria este camino)
    caches.open(CACHE)
      .then((c) => c.addAll(PRECACHE.map((u) => new Request(u, { cache: 'no-cache' }))))
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

self.addEventListener('fetch', (e) => {
  if (e.request.method !== 'GET') return;
  const url = new URL(e.request.url);
  if (url.origin !== self.location.origin) return;
  if (url.pathname.startsWith('/socket.io') || url.pathname === '/health' || url.pathname.startsWith('/fs/')) return;

  // Network-first: la app siempre fresca; el cache solo entra sin red.
  // cache:'no-cache' fuerza revalidacion con ETag aunque un proxy (Cloudflare)
  // imponga max-age largos en el navegador — sin esto el SW leeria HTTP cache viejo.
  e.respondWith(
    fetch(e.request, { cache: 'no-cache' })
      .then((res) => {
        if (res.ok) {
          const clone = res.clone();
          caches.open(CACHE).then((c) => c.put(e.request, clone)).catch(() => {});
          return res;
        }
        // 5xx (502/1033 del tunel devuelven HTML): mejor la copia cacheada que
        // un cuerpo de error entregado al parser de modulos ES (app en blanco)
        if (res.status >= 500) {
          return caches.match(e.request, { ignoreSearch: url.pathname === '/' })
            .then((hit) => hit || res);
        }
        return res;
      })
      .catch(() => caches.match(e.request, { ignoreSearch: url.pathname === '/' }))
  );
});
