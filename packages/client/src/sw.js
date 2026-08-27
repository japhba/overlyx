/* OverLyX service worker (generated into dist/sw.js at build time, see vite.config.ts).
 *
 * Makes the app shell work offline, Google-Docs style:
 *  - the built app (index.html, JS/CSS bundles, fonts) is precached on install; navigations are
 *    network-first (a new deployment is picked up on the next load) with the cached shell as fallback;
 *  - a few read-only API responses that the editor needs to open a document (who am I, the project
 *    list, a document's metadata/versions, rendered graphics) are network-first with the last
 *    response kept as an offline fallback;
 *  - everything else (edits go through the WebSocket, mutations through POST) is untouched.
 * The documents themselves live in IndexedDB (y-indexeddb) and sync through Yjs; the service worker
 * never sees them.
 */
const VERSION = '__VERSION__';
const PRECACHE = __PRECACHE__;
const SHELL = 'overlyx-shell-' + VERSION;
const API = 'overlyx-api';
const API_CACHED = /^\/api\/(auth\/me$|projects$|users\/\d+\/avatar$|docs\/[^/]+\/(meta|versions)$|projects\/[^/]+\/(graphics|file)\/)/;

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(SHELL).then((c) => c.addAll(PRECACHE)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (e) => {
  e.waitUntil(caches.keys()
    .then((keys) => Promise.all(keys.filter((k) => k.startsWith('overlyx-shell-') && k !== SHELL).map((k) => caches.delete(k))))
    .then(() => self.clients.claim()));
});

async function networkFirst(req, cacheName, fallbackUrl) {
  const cache = await caches.open(cacheName);
  try {
    const res = await fetch(req);
    if (res.ok) cache.put(req, res.clone()).catch(() => {});
    return res;
  } catch (err) {
    const hit = await cache.match(fallbackUrl ?? req, { ignoreSearch: !!fallbackUrl });
    if (hit) return hit;
    throw err;
  }
}

async function cacheFirst(req, cacheName) {
  const cache = await caches.open(cacheName);
  const hit = await cache.match(req);
  if (hit) return hit;
  const res = await fetch(req);
  if (res.ok) cache.put(req, res.clone()).catch(() => {});
  return res;
}

self.addEventListener('fetch', (e) => {
  const req = e.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return;
  if (req.mode === 'navigate') { e.respondWith(networkFirst(req, SHELL, '/index.html')); return; }
  if (url.pathname.startsWith('/assets/')) { e.respondWith(cacheFirst(req, SHELL)); return; }
  if (API_CACHED.test(url.pathname)) { e.respondWith(networkFirst(req, API)); return; }
});
