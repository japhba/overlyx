/**
 * The canvas of an encrypted project's deck, poster or web page (deliverable/): its frames made in
 * this browser from the decrypted project, as the deck editor's offline frames are made
 * (deliverable/offlineframes.ts) — the server, which has only ciphertext, cannot serve the folder.
 *
 * The page's files go into the frame as data URLs. Its folder's address is on a host that never
 * resolves (E2E_BASE, RFC 6761 `.invalid`), so a file the page names that the project lacks is asked
 * of nobody, least of all this server by its name; and the frame's own policy (FRAME_CSP) lets it
 * reach only public hosts for fonts, libraries and pictures, never this server's API.
 */
import { injectRuntime, runtimeTags, resolveInProject, type RuntimeMode } from '@overlyx/core/html/serve.ts';
import { deckExtras } from '@overlyx/core/html/deckextras.ts';
import { parseBibtex } from '@overlyx/core';
import { publicAssets, referencedAssets } from '../deliverable/offlineframes';
import { mapAssets, mappedCss, cssAssetValues, type AssetUrls } from '../deliverable/offlineassets';
import { openE2eProject, mimeOf, type E2eProject } from './project';

/** the project's root as the frames see it (the page's relative addresses resolve against it) */
export const E2E_BASE = 'https://e2e.invalid/';
/** public hosts a page may load fonts and libraries from (the server's renderer allows the same: render.ts CDN_HOSTS) */
const CDN = ['fonts.googleapis.com', 'fonts.gstatic.com', 'cdn.jsdelivr.net', 'unpkg.com', 'cdnjs.cloudflare.com', 'esm.sh', 'cdn.tailwindcss.com', 'code.jquery.com', 'd3js.org', 'cdn.plot.ly', 'use.typekit.net', 'rsms.me'].map(h => 'https://' + h);
const FRAME_CSP = () => {
  const runtime = new URL('/_ol/', location.origin).href;
  const code = ["'unsafe-inline'", "'unsafe-eval'", 'data:', 'blob:', runtime, ...CDN].join(' ');
  return `default-src 'none'; script-src ${code}; style-src ${code}; font-src data: blob: ${runtime} ${CDN.join(' ')}; img-src data: blob: https:; media-src data: blob: https:; connect-src data: blob: ${CDN.join(' ')}; worker-src blob: data:; frame-src https:; form-action 'none'`;
};

const enc = (rel: string) => rel.split('/').map(encodeURIComponent).join('/');
/** (paths computed on this origin's addresses, which referencedAssets takes; never requested) */
const SCOPE = () => new URL('/_e2e-paths/', location.origin).href;

function dataUrl(bytes: Uint8Array, type: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(String(r.result)); r.onerror = () => reject(r.error);
    r.readAsDataURL(new Blob([bytes.slice().buffer as ArrayBuffer], { type }));
  });
}

/** The project's files the page at `rel` names, project-relative. */
function namedFiles(html: string, rel: string): string[] {
  const scope = SCOPE(), dir = rel.includes('/') ? rel.slice(0, rel.lastIndexOf('/') + 1) : '';
  const out: string[] = [];
  for (const url of referencedAssets(html, scope + enc(dir), scope)) {
    try { out.push(decodeURIComponent(new URL(url).pathname.slice(new URL(scope).pathname.length))); } catch { /* not a file name */ }
  }
  return out;
}

/** The files' data URLs, by their address under E2E_BASE (a stylesheet with the files it names, mapped too). */
async function filesOf(p: E2eProject, rels: string[]): Promise<AssetUrls> {
  const out: AssetUrls = {}, busy = new Map<string, Promise<void>>();
  const load = (rel: string, depth = 0): Promise<void> => {
    if (busy.has(rel) || depth > 8) return busy.get(rel) ?? Promise.resolve();
    const run = (async () => {
      const e = p.entry(rel);
      if (!e || e.kind === 'dir') return;
      const bytes = await p.readFile(rel).catch(() => null);
      if (!bytes) return;
      const url = E2E_BASE + enc(rel);
      if (/\.css$/i.test(rel)) {
        const css = new TextDecoder().decode(bytes), dir = rel.includes('/') ? rel.slice(0, rel.lastIndexOf('/')) : '';
        for (const v of cssAssetValues(css)) { const r = resolveInProject(dir, v.split(/[?#]/)[0]); if (r) await load(r, depth + 1); }
        out[url] = 'data:text/css;charset=utf-8,' + encodeURIComponent(mappedCss(css, out, url));
      } else out[url] = await dataUrl(bytes, mimeOf(rel));
    })();
    busy.set(rel, run);
    return run;
  };
  for (const rel of rels) await load(rel);
  return out;
}

/** What the page's server would give the runtime with it: its citations' entries and its macros (core deckextras.ts). */
function extrasOf(p: E2eProject, html: string, rel: string) {
  return deckExtras(html, rel, {
    read: r => p.cachedText(r) ?? null,
    bibFiles: () => p.paths().filter(x => x.endsWith('.bib')),
    bibEntries: r => { const t = p.cachedText(r); try { return t ? parseBibtex(t) : []; } catch { return []; } },
    resolve: (from, href) => resolveInProject(from.includes('/') ? from.slice(0, from.lastIndexOf('/')) : '', href),
  });
}

/** The frames of the page `rel` of the encrypted `project` (the same face as deliverable/offlineframes.ts offlineFrames). */
export function e2eFrames(project: string, rel: string, html: () => string) {
  let assets: AssetUrls = {};
  let assetKey = '';
  let timer: ReturnType<typeof setTimeout> | undefined;
  let closed = false;
  const listeners = new Set<(a: AssetUrls) => void>();
  const opened = () => openE2eProject(project);
  /** the runtime's scripts and the page's files, read again when the page names other files */
  const refresh = async (force = false): Promise<AssetUrls> => {
    const p = await opened();
    await p.prefetchTexts();
    const source = html(), files = namedFiles(source, rel), key = files.join('\n');
    if (!force && key === assetKey && Object.keys(assets).length) return assets;
    const [pub, own] = await Promise.all([publicAssets().catch(() => ({} as AssetUrls)), filesOf(p, files)]);
    if (closed) return assets;
    assetKey = key;
    assets = { ...pub, ...own };
    return assets;
  };
  return {
    link: () => ({ base: E2E_BASE, entry: rel, expires: 0 }),
    async frame(mode: RuntimeMode, _link?: { base: string; entry: string }): Promise<string | null> {
      const p = await opened();
      const current = await refresh();
      const source = html(), doc = new DOMParser().parseFromString(source, 'text/html');
      const folder = new URL('.', E2E_BASE + enc(rel)).href;
      const authoredBase = doc.querySelector('base[href]');
      let effective = folder;
      if (authoredBase) { try { effective = new URL(authoredBase.getAttribute('href')!, folder).href; } catch { /* invalid */ } }
      mapAssets(doc.documentElement, current, effective);
      if (authoredBase) authoredBase.setAttribute('href', effective);
      const runtime = current[new URL('/_ol/runtime.js', location.origin).href];
      if (!runtime) throw new Error('The canvas could not be loaded (its scripts are missing)');
      const tags = `<meta http-equiv="Content-Security-Policy" content="${FRAME_CSP()}">`
        + (authoredBase ? '' : `<base data-ol-runtime href="${folder.replace(/"/g, '&quot;')}">`)
        + runtimeTags(mode, { ...extrasOf(p, source, rel), source, folderBase: folder, runtimeBase: new URL('/_ol/', location.origin).href, assetUrls: current }, runtime);
      return injectRuntime('<!doctype html>' + doc.documentElement.outerHTML, tags);
    },
    resources: () => refresh(),
    async uploaded(path: string, blob: Blob): Promise<void> {
      const url = E2E_BASE + enc(path);
      assets = { ...assets, [url]: await dataUrl(new Uint8Array(await blob.arrayBuffer()), blob.type || mimeOf(path)) };
      listeners.forEach(cb => cb(assets));
    },
    onResources(cb: (a: AssetUrls) => void) { listeners.add(cb); return () => { listeners.delete(cb); }; },
    disconnected() { /* nothing comes from the network */ },
    changed(force = false) {
      clearTimeout(timer);
      timer = setTimeout(() => {
        const before = assets;
        void refresh(force).then(next => { if (!closed && next !== before) listeners.forEach(cb => cb(next)); }).catch(() => {});
      }, force ? 600 : 2500);
    },
    /** a file of the project, decrypted (pictures the editor works on: background removal) */
    async readFile(path: string): Promise<Blob> {
      const p = await opened();
      return new Blob([(await p.readFile(path)).slice().buffer as ArrayBuffer], { type: mimeOf(path) });
    },
    destroy() { closed = true; clearTimeout(timer); listeners.clear(); assets = {}; },
  };
}

/**
 * Print the page (or save it as a PDF) in this browser: the runtime's print mode in a frame of its
 * own, opened as the editor's offline frames are (/_ol/offline-frame.html takes the document by
 * message), which calls print() once the runtime has laid the pages out, then goes.
 */
export async function printE2ePage(frames: ReturnType<typeof e2eFrames>): Promise<void> {
  const html = await frames.frame('print');
  if (!html) return;
  const done = `<script>(function () { var t = setInterval(function () { if (!window.__olReady) return; clearInterval(t);
    setTimeout(function () { print(); parent.postMessage({ ol: 'e2ePrinted' }, '*'); }, 300); }, 100); })();</script>`;
  const doc = /<\/body>/i.test(html) ? html.replace(/<\/body>(?![\s\S]*<\/body>)/i, done + '</body>') : html + done;
  const frame = document.createElement('iframe');
  // (laid out at a screen's size and printed in the print layout; in the window though unseen — the
  // browser draws no frames for a frame off the screen, and the runtime waits for them)
  frame.style.cssText = 'position:fixed;left:0;top:0;width:1280px;height:800px;border:0;opacity:0;pointer-events:none;z-index:-1';
  frame.title = 'Print';
  let finished = false;
  const finish = () => { if (finished) return; finished = true; removeEventListener('message', onMessage); frame.remove(); };
  const onMessage = (e: MessageEvent) => {
    if (e.source !== frame.contentWindow || !e.data || typeof e.data !== 'object') return;
    if (e.data.ol === 'offlineBoot' && e.data.opaque === true) {
      frame.setAttribute('sandbox', 'allow-scripts allow-modals');
      frame.contentWindow?.postMessage({ ol: 'offlineDocument', html: doc }, '*');
    } else if (e.data.ol === 'e2ePrinted') setTimeout(finish, 1000);
  };
  addEventListener('message', onMessage);
  frame.src = `/_ol/offline-frame.html?ol=print&revision=${Date.now()}`;
  document.body.appendChild(frame);
  setTimeout(finish, 10 * 60 * 1000);
}
