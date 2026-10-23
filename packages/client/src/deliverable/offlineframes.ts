import { injectRuntime, runtimeTags, type RuntimeMode } from '@overlyx/core/html/serve.ts';
import { offlineGet } from '../offline-api';
import { mapAssets, mappedCss, cssAssetValues, srcsetAssetValues, type AssetUrls } from './offlineassets';

const scriptData = (text: string) => 'data:text/javascript;charset=utf-8,' + encodeURIComponent(text);
let publicPromise: Promise<AssetUrls> | null = null;

async function publicAssets(): Promise<AssetUrls> {
  return publicPromise ??= (async () => {
    const manifestCache = await caches.open('overlyx-runtime-manifest');
    const manifestUrl = new URL('/_ol/offline.json', location.origin).href;
    let response: Response | undefined;
    try {
      response = await fetch(manifestUrl);
      if (!response.ok) { const error = new Error('The offline canvas is not available') as Error & { status: number }; error.status = response.status; throw error; }
      try { await manifestCache.put(manifestUrl, response.clone()); } catch { /* Optional online cache. */ }
    } catch (error) {
      if ((error as { status?: number }).status) throw error;
      response = await manifestCache.match(manifestUrl);
      if (!response) throw error;
    }
    const manifest = await response.json() as { version: string; files: string[] };
    if (!Array.isArray(manifest.files) || manifest.files.some(file => !/^\/_ol\/[A-Za-z0-9_./-]+\.js$/.test(file) || file.includes('..'))) throw new Error('Invalid offline canvas manifest');
    const cache = await caches.open(`overlyx-runtime-${manifest.version}`);
    const assets: AssetUrls = {};
    await Promise.all(manifest.files.map(async file => {
      const url = new URL(file, location.origin).href;
      let stored = await cache.match(url);
      if (!stored) {
        stored = await fetch(url);
        if (!stored.ok) throw new Error('Could not cache the offline canvas');
        await cache.put(url, stored.clone());
      }
      assets[url] = scriptData(await stored.text());
    }));
    return assets;
  })().catch(error => { publicPromise = null; throw error; });
}

const dataUrl = (blob: Blob): Promise<string> => new Promise((resolve, reject) => {
  const reader = new FileReader();
  reader.onload = () => resolve(String(reader.result)); reader.onerror = () => reject(reader.error);
  reader.readAsDataURL(blob);
});

/** Only assets inside this document's signed folder can be read by its frame.
 * Imported HTML must never make the parent fetch an authenticated API URL. */
function folderAsset(value: string, base: string): string | null {
  try {
    const folder = new URL(base), url = new URL(value, base);
    return folder.origin === location.origin && folder.pathname.endsWith('/') && url.origin === folder.origin && url.pathname.startsWith(folder.pathname) ? url.href : null;
  } catch { return null; }
}

/** what in the text could name a file (without parsing it): while these stay the same, so do its assets */
const ASSET_HINTS = /\b(?:src|href|poster|srcset)\s*=\s*(?:"[^"]*"|'[^']*'|[^\s>]+)|url\(\s*[^)]*\)|@import[^;]*;/gi;
const assetHints = (html: string): string => (html.match(ASSET_HINTS) ?? []).join('\n');

function referencedAssets(html: string, base: string, scope = base): string[] {
  const doc = new DOMParser().parseFromString(html, 'text/html'), urls = new Set<string>();
  const suppliedBase = doc.querySelector('base[href]')?.getAttribute('href');
  if (suppliedBase !== undefined && suppliedBase !== null) { try { base = new URL(suppliedBase, base).href; } catch { /* Retain the document folder for an invalid base. */ } }
  const add = (value: string) => { try { const url = folderAsset(new URL(value, base).href, scope); if (url) urls.add(url); } catch { /* Not a usable local resource. */ } };
  for (const el of Array.from(doc.querySelectorAll('img[src],source[src],video[src],audio[src],script[src],video[poster],link[rel~="stylesheet"][href],svg image[href]'))) {
    for (const attr of ['src', 'poster', 'href']) { const value = el.getAttribute(attr); if (value) add(value); }
  }
  for (const el of Array.from(doc.querySelectorAll('style,[style]'))) {
    const css = el.localName === 'style' ? el.textContent ?? '' : el.getAttribute('style') ?? '';
    for (const value of cssAssetValues(css)) add(value);
  }
  for (const el of Array.from(doc.querySelectorAll('[srcset]'))) for (const value of srcsetAssetValues(el.getAttribute('srcset')!)) add(value);
  return [...urls];
}

export function offlineFrames(userId: number, html: () => string, getLink: () => Promise<{ base: string; entry: string }>) {
  let prepared: Promise<{ network: boolean; base: string; folder: string; rendered: string; assets: AssetUrls; generation: number }> | null = null;
  let generation = 0;
  let preparedKey: string | undefined;
  let assets: AssetUrls | null = null;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let closed = false;
  let initialized = false;
  let assetKey: string | undefined;
  /** the text's file names, roughly (assetHints), when its assets were last read from it */
  let hintKey: string | undefined;
  const resourceListeners = new Set<(assets: AssetUrls) => void>();
  const ownsAccount = () => {
    try { return !closed && JSON.parse(localStorage.getItem('ol.user') ?? 'null')?.id === userId; }
    catch { return false; }
  };
  const checkAccount = () => {
    if (!ownsAccount()) { const error = new Error('This account is no longer active') as Error & { status: number }; error.status = 401; throw error; }
  };
  const privateAssets = async (source: string, folder: string, base: string, initial: AssetUrls): Promise<AssetUrls> => {
    checkAccount();
    let cache: Cache | undefined;
    try { cache = await caches.open(`overlyx-api-user-${userId}`); } catch { /* Online resources still work without storage. */ }
    const result = { ...initial }, loads = new Map<string, Promise<void>>();
    const load = (url: string, ancestors = new Set<string>()): Promise<void> => {
      if (ancestors.has(url)) return Promise.resolve();
      const previous = loads.get(url);
      if (previous) return previous;
      const next = new Set(ancestors).add(url);
      const promise = (async () => {
      checkAccount();
      let response: Response | undefined;
      try {
        response = await fetch(url, { credentials: 'same-origin' });
        if (!response.ok) { const error = new Error('Could not cache an image or page resource') as Error & { status: number }; error.status = response.status; throw error; }
        checkAccount();
        try { await cache?.put(url, response.clone()); } catch { /* A full cache must not hide an online picture. */ }
      } catch (error) {
        checkAccount();
        const status = (error as { status?: number }).status;
        if (status === 401 || status === 403) throw error;
        if (status) return; // A missing optional picture does not block editing the page.
        try { response = await cache?.match(url); } catch { /* Optional picture unavailable. */ }
        if (!response) return;
      }
      if (/text\/css/.test(response.headers.get('content-type') ?? '')) {
        const css = await response.text();
        for (const value of cssAssetValues(css)) {
          const nested = folderAsset(new URL(value, url).href, base);
          if (nested) await load(nested, next);
        }
        // Browsers ignore cyclic CSS imports. Avoid an offline network request
        // for that same back edge when flattening imports into data URLs.
        const resolved = { ...result };
        for (const ancestor of next) if (!resolved[ancestor]) resolved[ancestor] = 'data:text/css,';
        result[url] = 'data:text/css;charset=utf-8,' + encodeURIComponent(mappedCss(css, resolved, url));
      } else result[url] = await dataUrl(await response.blob());
      checkAccount();
      })();
      loads.set(url, promise);
      return promise;
    };
    // Sequential roots also avoid a wait cycle between two importing stylesheets.
    for (const url of referencedAssets(source, folder, base)) await load(url);
    return result;
  };
  const prepare = (supplied?: { base: string; entry: string }) => {
    const key = supplied && new URL(supplied.base, location.origin).href + '|' + supplied.entry;
    if (key && key !== preparedKey) { prepared = null; assets = null; preparedKey = key; }
    if (prepared) return prepared;
    const active = ++generation;
    return prepared ??= (async () => {
    checkAccount();
    const link = supplied ?? await getLink(), base = new URL(link.base, location.origin).href;
    if (active === generation) preparedKey = base + '|' + link.entry;
    const pageUrl = new URL(link.entry.split('/').map(encodeURIComponent).join('/'), base);
    const folder = new URL('.', pageUrl).href;
    const url = pageUrl.href + '?ol=edit';
    let network = false;
    const rendered = await offlineGet(url, async () => {
      const response = await fetch(url, { credentials: 'same-origin' });
      if (!response.ok) { const error = new Error('Could not open the page') as Error & { status: number }; error.status = response.status; throw error; }
      const body = await response.text(); network = true; return body;
    });
    let publicUrls: AssetUrls;
    try { publicUrls = await publicAssets(); }
    catch (error) { if (!network) throw error; publicUrls = {}; }
    let found: AssetUrls;
    try { found = await privateAssets(html() || rendered, folder, base, publicUrls); }
    catch (error) { if (!network || (error as { status?: number }).status === 401 || (error as { status?: number }).status === 403) throw error; found = publicUrls; }
    checkAccount();
    if (active === generation) assets = found;
    return { network, base, folder, rendered, assets: found, generation: active };
  })().catch(error => { if (active === generation) prepared = null; throw error; });
  };
  return {
    async frame(mode: RuntimeMode, link?: { base: string; entry: string }): Promise<string | null> {
      const ready = await prepare(link);
      initialized = true;
      if (ready.network) return null;
      const served = new DOMParser().parseFromString(ready.rendered, 'text/html');
      const setup = served.querySelector('script[data-ol-runtime]')?.textContent ?? '';
      const { mode: _servedMode, ...extra } = JSON.parse(setup.replace(/^\s*window\.__OL\s*=\s*/, '').replace(/;\s*$/, ''));
      const source = html(), doc = new DOMParser().parseFromString(source, 'text/html');
      checkAccount();
      const current = ready.generation === generation ? assets ?? ready.assets : ready.assets;
      const authoredBase = doc.querySelector('base[href]');
      let effective = ready.folder;
      if (authoredBase) { try { effective = new URL(authoredBase.getAttribute('href')!, ready.folder).href; } catch { /* Invalid authored base. */ } }
      mapAssets(doc.documentElement, current, effective);
      if (authoredBase) authoredBase.setAttribute('href', effective);
      const tags = (authoredBase ? '' : `<base data-ol-runtime href="${ready.folder.replace(/"/g, '&quot;')}">`) + runtimeTags(mode,
        { ...extra, source, folderBase: ready.folder, runtimeBase: new URL('/_ol/', location.origin).href, assetUrls: current }, current[new URL('/_ol/runtime.js', location.origin).href]);
      return injectRuntime('<!doctype html>' + doc.documentElement.outerHTML, tags);
    },
    async resources(): Promise<AssetUrls> { const ready = await prepare(); checkAccount(); return ready.generation === generation ? assets ?? ready.assets : ready.assets; },
    async uploaded(rel: string, blob: Blob): Promise<void> {
      const ready = await prepare(); checkAccount();
      const url = folderAsset(new URL(rel.split('/').map(encodeURIComponent).join('/'), ready.base).href, ready.base);
      if (!url) return;
      try { const cache = await caches.open(`overlyx-api-user-${userId}`); checkAccount(); await cache.put(url, new Response(blob)); } catch { /* Server upload still succeeded without optional storage. */ }
      const value = await dataUrl(blob); checkAccount();
      if (ready.generation !== generation) return;
      assets = { ...(assets ?? ready.assets), [url]: value };
      resourceListeners.forEach(callback => callback(assets!));
    },
    onResources(callback: (assets: AssetUrls) => void) { resourceListeners.add(callback); return () => { resourceListeners.delete(callback); }; },
    disconnected() { generation++; prepared = null; },
    changed(force = false) {
      clearTimeout(timer);
      // Background text synchronization must not acquire a second link before
      // the opening controller has succeeded, particularly after a denial.
      if (!initialized) return;
      // (the text's pictures are read from all of it, parsed again: after a pause, not between the strokes of a word written by hand)
      timer = setTimeout(() => { void prepare().then(async ready => {
        const source = html(), hints = ready.base + '|' + assetHints(source);
        // (strokes written, words typed: no file named anew, nothing parsed — half a MB on a deck with much ink)
        if (!force && hints === hintKey) return;
        const key = ready.base + '|' + JSON.stringify(referencedAssets(source, ready.folder, ready.base));
        if (!force && key === assetKey) { hintKey = hints; return; }
        const next = await privateAssets(source, ready.folder, ready.base, await publicAssets());
        if (closed || ready.generation !== generation) return;
        assetKey = key; hintKey = hints;
        const same = assets && Object.keys(next).length === Object.keys(assets).length && Object.entries(next).every(([url, value]) => assets![url] === value);
        assets = next;
        if (!same) resourceListeners.forEach(callback => callback(next));
      }).catch(() => {}); }, force ? 600 : 2500);
    },
    destroy() { closed = true; generation++; clearTimeout(timer); assets = null; prepared = null; resourceListeners.clear(); },
  };
}
