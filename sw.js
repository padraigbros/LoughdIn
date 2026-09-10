/* Resolve every URL against the registration scope so a GitHub Pages project
 * hosted below the origin root can launch and work offline at that subpath. */
const CACHE_PREFIX = 'loughdin-shell:';
const CACHE_VERSION = 'v1';
const REGISTRATION_SCOPE = new URL(self.registration.scope);
const CACHE_NAMESPACE = `${CACHE_PREFIX}${encodeURIComponent(REGISTRATION_SCOPE.href)}`;
const OWN_CACHE_PREFIX = `${CACHE_NAMESPACE}:`;
const CACHE_NAME = `${OWN_CACHE_PREFIX}${CACHE_VERSION}`;

const SHELL_PATHS = [
  './index.html',
  './manifest.json',
  './icons/icon-192.png',
  './icons/icon-512.png',
  './src/app.js',
  './src/timer.js',
  './src/storage.js',
  './src/sync.js',
  './src/scenes.js',
  './src/planner.js',
  './src/config.js',
  './src/native.js',
  './vendor/supabase.js',
  './vendor/native.js',
  './styles/enhancements.css'
];
const SHELL_URLS = SHELL_PATHS.map(path => new URL(path, REGISTRATION_SCOPE).href);
const SHELL_URL_SET = new Set(SHELL_URLS);
const INDEX_URL = new URL('./index.html', REGISTRATION_SCOPE).href;

self.addEventListener('install', event => {
  event.waitUntil(
    caches.open(CACHE_NAME).then(cache => cache.addAll(SHELL_URLS))
  );
});

self.addEventListener('activate', event => {
  event.waitUntil(
    caches.keys().then(keys => Promise.all(
      keys
        .filter(key => key.startsWith(OWN_CACHE_PREFIX) && key !== CACHE_NAME)
        .map(key => caches.delete(key))
    )).then(() => self.clients.claim())
  );
});

// Do not replace a pending worker while the writing app may be active. The
// client must send this message after it is safe to update.
self.addEventListener('message', event => {
  if (event.data === 'SKIP_WAITING' || event.data?.type === 'SKIP_WAITING') {
    event.waitUntil(self.skipWaiting());
  }
});

self.addEventListener('fetch', event => {
  const request = event.request;
  if (request.method !== 'GET') return;

  const requestURL = new URL(request.url);
  if (requestURL.origin !== self.location.origin) return;
  if (!requestURL.pathname.startsWith(REGISTRATION_SCOPE.pathname)) return;

  if (request.mode === 'navigate') {
    event.respondWith((async () => { const cache = await caches.open(CACHE_NAME); return await cache.match(INDEX_URL) || fetch(request); })());
    return;
  }

  // Only explicitly listed shell files are cached. API, auth and media
  // requests pass through untouched, even when they share this origin.
  if (!SHELL_URL_SET.has(requestURL.href)) return;
  event.respondWith((async () => {
    const shell = await caches.open(CACHE_NAME);
    const cached = await shell.match(request);
    if (cached) return cached;

    try {
      const response = await fetch(request);
      if (response.ok) {
        const cache = await caches.open(CACHE_NAME);
        await cache.put(request, response.clone());
      }
      return response;
    } catch {
      return Response.error();
    }
  })());
});
