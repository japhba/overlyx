/* OverLyX service worker (generated into dist/sw.js at build time, see vite.config.ts).
 *
 * Makes the app shell work offline, Google-Docs style:
 *  - the built app (index.html, JS/CSS bundles, fonts) is precached on install; navigations are
 *    network-first (a new deployment is picked up on the next load) with the cached shell as fallback;
 *  - a few read-only API responses that the editor needs to open a document (who am I, the project
 *    list, a document's metadata/versions, rendered graphics) are network-first with the last
 *    response kept as an offline fallback;
 *  - the math font chosen in the editor, if not the precached default, is cached whole when the page
 *    names it ('math-font' message, on every load and on a change): MathJax fetches a font's files
 *    as formulas need them, so offline a formula could miss a style that had not been drawn yet —
 *    and every deployment starts a new cache;
 *  - everything else (edits go through the WebSocket, mutations through POST) is untouched.
 * The documents themselves live in IndexedDB (y-indexeddb) and sync through Yjs; the service worker
 * never sees them.
 */
const VERSION = '__VERSION__';
const PRECACHE = __PRECACHE__;
/** each MathJax font other than the precached default: its files (assets/mathjax/<font>/) */
const FONTS = __FONTS__;
const SHELL = 'overlyx-shell-' + VERSION;
// Content-hashed public assets remain usable by pages running an earlier build,
// including pages restored from the back/forward cache. They cannot be retired
// just because the old shell or its window is no longer visible to this worker.
const ASSETS = 'overlyx-public-assets';
const API = 'overlyx-api';
const API_CACHED = /^\/api\/(auth\/me$|projects$|users\/\d+\/avatar$|docs\/[^/]+\/(meta|versions)$|projects\/[^/]+\/(graphics|file)\/)/;

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(SHELL).then((c) => c.addAll(PRECACHE)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (e) => {
  e.waitUntil(caches.keys()
    .then(async (keys) => {
      for (const key of keys.filter(k => k.startsWith('overlyx-shell-'))) {
        // On quota/copy failure keep the old cache as the durable fallback.
        const copied = await preserveAssets(key).catch(() => false);
        if (copied && key !== SHELL) await caches.delete(key);
      }
    })
    .then(() => self.clients.claim()));
});

function fingerprintedAsset(req) {
  const url = new URL(typeof req === 'string' ? req : req.url, self.location.origin);
  return url.origin === self.location.origin && url.pathname.startsWith('/assets/')
    && /\/[^/]+-[A-Za-z0-9_-]{8,}\.[A-Za-z0-9]+$/.test(url.pathname);
}

function usableAsset(req, res) {
  if (!res?.ok) return false;
  const path = new URL(typeof req === 'string' ? req : req.url, self.location.origin).pathname;
  const type = (res.headers.get('content-type') ?? '').split(';')[0].trim().toLowerCase();
  if (path.endsWith('.js')) return /^(?:text|application)\/(?:javascript|ecmascript)$/.test(type);
  if (path.endsWith('.css')) return type === 'text/css';
  return !!type && type !== 'text/html' && type !== 'application/xhtml+xml';
}

async function preserveAssets(name) {
  const source = await caches.open(name), assets = await caches.open(ASSETS);
  for (const req of await source.keys()) {
    if (!fingerprintedAsset(req)) continue;
    const res = await source.match(req);
    if (!usableAsset(req, res)) continue;
    if (!usableAsset(req, await assets.match(req))) await assets.put(req, res);
  }
  return true;
}

async function publicAsset(req) {
  const shell = await caches.open(SHELL);
  const hit = await shell.match(req);
  if (usableAsset(req, hit)) return hit;
  if (fingerprintedAsset(req)) {
    const assets = await caches.open(ASSETS).catch(() => null);
    const retained = await assets?.match(req);
    if (usableAsset(req, retained)) return retained;
    // A quota failure during activation deliberately leaves the old shell.
    for (const name of await caches.keys()) {
      if (!name.startsWith('overlyx-shell-') || name === SHELL) continue;
      const old = await (await caches.open(name)).match(req);
      if (usableAsset(req, old)) return old;
    }
  }
  const res = await fetch(req);
  if (usableAsset(req, res)) await shell.put(req, res.clone()).catch(() => {});
  return res;
}

self.addEventListener('message', (e) => {
  const files = e.data && e.data.type === 'math-font' ? FONTS[e.data.font] : undefined;
  if (!files) return;
  e.waitUntil(caches.open(SHELL).then((c) => Promise.all(files.map((f) => c.match(f).then((hit) => hit || c.add(f)).catch(() => {})))));
});

async function networkFirst(req, cacheName, fallbackUrl) {
  const cache = await caches.open(cacheName);
  let res;
  try {
    res = await fetch(req);
  } catch (err) {
    const hit = await cache.match(fallbackUrl ?? req, { ignoreSearch: !!fallbackUrl });
    if (hit) return hit;
    throw err;
  }
  if (res.ok) cache.put(req, res.clone()).catch(() => {});
  // the server is restarting (the proxy answers 502/503 for a couple of seconds): the app shell
  // from the cache loads and reconnects by itself instead of showing the proxy's error page
  else if (fallbackUrl && res.status >= 500) {
    const hit = await cache.match(fallbackUrl, { ignoreSearch: true });
    if (hit) return hit;
  }
  return res;
}

async function cacheFirst(req, cacheName, ignoreSearch = false) {
  const cache = await caches.open(cacheName);
  const hit = await cache.match(req, { ignoreSearch });
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
  if (url.pathname.startsWith('/pdf/')) return;   // a public PDF link: the file itself, never the app shell
  // Select the cached opaque response before the navigation's app-shell fallback.
  if (url.pathname === '/_ol/offline-frame.html') { e.respondWith(cacheFirst(req, SHELL, true)); return; }
  if (req.mode === 'navigate') { e.respondWith(networkFirst(req, SHELL, '/index.html')); return; }
  if (url.pathname.startsWith('/assets/')) { e.respondWith(publicAsset(req)); return; }
  if (url.pathname.startsWith('/_ol/')) { e.respondWith(cacheFirst(req, SHELL, true)); return; }
  if (API_CACHED.test(url.pathname)) { e.respondWith(networkFirst(req, API)); return; }
});
