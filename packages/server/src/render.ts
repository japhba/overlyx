/**
 * Headless rendering of HTML deliverables (deliverables.ts): the agents' render_page (a page as an
 * image and what is wrong with it), the PDF export.
 *
 * A deliverable is anyone's HTML and JavaScript, so the browser that renders it gets nothing of the
 * server: Chromium runs in the bubblewrap sandbox (sandbox.ts — no network namespace, the system
 * read-only, no capabilities) and every request the page makes comes back to this process over
 * the DevTools pipe, where it is answered like the editor's frame would be (resolveDeliverable),
 * or — for a short list of public font and script CDNs — fetched here. Nothing else is reachable:
 * not the server's own API, not the machine's other services.
 *
 * One browser for everybody, started on first use and closed when idle; at most two pages at once.
 */
import fs from 'node:fs';
import path from 'node:path';
import { chromium, type Browser, type BrowserContext, type Route } from 'playwright-core';
import { config } from './config.ts';
import { sandboxAvailable } from './sandbox.ts';
import { deliverableToken, resolveDeliverable, liveHtml, type RuntimeMode } from './deliverables.ts';
import { deliverableInfo } from '@overlyx/core/html/deliverable.ts';

const ORIGIN = 'http://overlyx.internal';
/** public CDNs a deliverable may load fonts and libraries from */
const CDN_HOSTS = new Set(['fonts.googleapis.com', 'fonts.gstatic.com', 'cdn.jsdelivr.net', 'unpkg.com', 'cdnjs.cloudflare.com', 'esm.sh', 'cdn.tailwindcss.com', 'code.jquery.com', 'd3js.org', 'cdn.plot.ly', 'use.typekit.net', 'rsms.me']);
const CDN_MAX = 20 * 1024 * 1024;
const IDLE_MS = 3 * 60 * 1000;
const RENDER_TIMEOUT_MS = 45000;

let browser: Promise<Browser> | null = null;
let idleTimer: NodeJS.Timeout | null = null;
let running = 0;
const queue: (() => void)[] = [];

/** the shell script that starts Chromium inside bubblewrap (written once into the data directory) */
function sandboxedChrome(): string | undefined {
  const chrome = process.env.OVERLYX_CHROMIUM || chromium.executablePath();
  if (!fs.existsSync(chrome)) throw new Error('Chromium is not installed on the server (npx playwright install chromium)');
  if (!sandboxAvailable()) return chrome;
  const ro = ['/usr', '/lib', '/lib64', '/lib32', '/bin', '/sbin', '/etc/fonts', '/etc/ld.so.cache', '/etc/ld.so.conf', '/etc/ld.so.conf.d', '/etc/passwd', '/etc/group', '/etc/alternatives', '/var/cache/fontconfig', path.dirname(path.dirname(chrome))];
  const args: string[] = [];
  for (const d of ro) if (fs.existsSync(d)) args.push('--ro-bind', d, d);
  args.push('--proc', '/proc', '--dev', '/dev', '--tmpfs', '/tmp', '--tmpfs', '/dev/shm',
    '--unshare-net', '--unshare-pid', '--unshare-ipc', '--unshare-uts', '--die-with-parent',
    ...(process.getuid?.() === 0 ? ['--cap-drop', 'ALL'] : ['--unshare-user']),
    '--clearenv', '--setenv', 'PATH', '/usr/bin:/bin', '--setenv', 'HOME', '/tmp', '--setenv', 'LANG', 'C.UTF-8');
  const q = (s: string) => `'${s.replace(/'/g, `'\\''`)}'`;
  const script = `#!/bin/sh\nexec bwrap ${args.map(q).join(' ')} -- ${q(chrome)} "$@"\n`;
  const file = path.join(config.dataDir, 'chromium-sandboxed.sh');
  let same = false;
  try { same = fs.readFileSync(file, 'utf8') === script; } catch { /* new */ }
  if (!same) { fs.writeFileSync(file, script, { mode: 0o755 }); }
  return file;
}

async function getBrowser(): Promise<Browser> {
  if (idleTimer) { clearTimeout(idleTimer); idleTimer = null; }
  if (!browser) {
    browser = chromium.launch({
      executablePath: sandboxedChrome(),
      args: ['--no-sandbox', '--disable-dev-shm-usage', '--disable-gpu', '--font-render-hinting=none', '--disable-background-networking', '--disable-component-update', '--no-first-run'],
      timeout: 30000,
    });
    browser.then(b => b.on('disconnected', () => { browser = null; }), () => { browser = null; });
  }
  return browser;
}

function release(): void {
  running--;
  queue.shift()?.();
  if (!running && !queue.length) {
    if (idleTimer) clearTimeout(idleTimer);
    idleTimer = setTimeout(() => { const b = browser; browser = null; void b?.then(x => x.close()).catch(() => undefined); }, IDLE_MS);
  }
}
const acquire = () => new Promise<void>(r => { if (running < 2) { running++; r(); } else queue.push(() => { running++; r(); }); });

/** Answer every request of the page: the deliverable's files, the runtime, a public CDN — nothing else. */
async function answer(route: Route): Promise<void> {
  const req = route.request();
  if (process.env.OVERLYX_DEBUG_RENDER) console.log('[render]', req.method(), req.url().slice(0, 140));
  let u: URL;
  try { u = new URL(req.url()); } catch { await route.abort(); return; }
  if (u.origin === ORIGIN) {
    if (u.pathname.startsWith('/_ol/')) {
      const rel = path.posix.normalize(decodeURIComponent(u.pathname.slice('/_ol/'.length)));
      const abs = path.join(config.clientDist, '_ol', rel);
      if (rel.startsWith('..') || !abs.startsWith(path.join(config.clientDist, '_ol') + path.sep) || !fs.existsSync(abs)) { await route.fulfill({ status: 404 }); return; }
      await route.fulfill({ status: 200, path: abs, headers: { 'Access-Control-Allow-Origin': '*' } });
      return;
    }
    const m = /^\/ol-d\/([^/]+)\/(.*)$/.exec(u.pathname);
    if (!m) { await route.fulfill({ status: 404 }); return; }
    const r = await resolveDeliverable(m[1], m[2], Object.fromEntries(u.searchParams), req.resourceType() === 'image' ? 'image' : undefined);
    const headers = { 'Access-Control-Allow-Origin': '*', ...(r.headers ?? {}), ...(r.type ? { 'Content-Type': r.type } : {}) };
    if (r.file) await route.fulfill({ status: r.status, path: r.file, headers });
    else await route.fulfill({ status: r.status, body: r.body ?? '', headers });
    return;
  }
  if (u.protocol === 'https:' && CDN_HOSTS.has(u.hostname) && req.method() === 'GET') {
    try {
      const res = await fetch(u, { signal: AbortSignal.timeout(15000), redirect: 'follow', headers: { 'User-Agent': req.headers()['user-agent'] ?? 'Mozilla/5.0' } });
      const buf = Buffer.from(await res.arrayBuffer());
      if (buf.length > CDN_MAX) { await route.abort(); return; }
      const headers: Record<string, string> = { 'Access-Control-Allow-Origin': '*' };
      const ct = res.headers.get('content-type');
      if (ct) headers['Content-Type'] = ct;
      await route.fulfill({ status: res.status, body: buf, headers });
    } catch { await route.abort(); }
    return;
  }
  await route.abort();
}

async function withPage<T>(project: string, rel: string, userId: number, mode: RuntimeMode, viewport: { width: number; height: number }, scale: number, f: (ctx: BrowserContext, page: import('playwright-core').Page) => Promise<T>): Promise<T> {
  await acquire();
  let ctx: BrowserContext | null = null;
  try {
    const b = await getBrowser();
    ctx = await b.newContext({ viewport, deviceScaleFactor: scale, serviceWorkers: 'block', acceptDownloads: false });
    await ctx.route('**/*', answer);
    const page = await ctx.newPage();
    page.setDefaultTimeout(RENDER_TIMEOUT_MS);
    const token = deliverableToken(project, '', userId, 10 * 60 * 1000);
    await page.goto(`${ORIGIN}/ol-d/${token}/${rel.split('/').map(encodeURIComponent).join('/')}?ol=${mode}`, { waitUntil: 'load' });
    // the runtime says when fonts, math and the page's own scripts have settled
    await page.waitForFunction(() => (window as unknown as { __olReady?: boolean }).__olReady === true, undefined, { timeout: 20000 }).catch(() => undefined);
    return await f(ctx, page);
  } finally {
    await ctx?.close().catch(() => undefined);
    release();
  }
}

/* ------------------------------------------------------------------ what the runtime reports */

export interface PageIssue { kind: 'overflow' | 'offpage' | 'overlap' | 'small-text' | 'contrast' | 'clipped'; text: string; at?: { x: number; y: number; w: number; h: number } }
export interface PageReport { index: number; title: string; issues: PageIssue[] }
export interface DeliverableReport { kind: 'deck' | 'poster' | 'page'; width: number; height: number; pages: PageReport[]; errors: string[] }

/** the size of the deliverable's pages (CSS px), its kind and every page's problems */
async function report(page: import('playwright-core').Page): Promise<DeliverableReport> {
  return await page.evaluate(() => (window as unknown as { __ol: { report(): DeliverableReport } }).__ol.report());
}

export interface RenderedPage { index: number; png: Buffer; report: PageReport }

/**
 * Pages of a deliverable as images (at most `maxWidth` px wide) with their reports. `pages`:
 * 0-based indices (deck); default the first. A web page is shot from the top, `width` CSS px wide.
 */
export async function renderPages(project: string, rel: string, userId: number, opts: { pages?: number[]; maxWidth?: number; width?: number } = {}): Promise<{ report: DeliverableReport; images: RenderedPage[] }> {
  const maxWidth = Math.min(2400, Math.max(320, opts.maxWidth ?? 1568));
  const pageWidth = Math.min(2400, Math.max(320, opts.width ?? 1280));
  // a poster is large (A0: ~3200 CSS px wide): shot at half scale, an image an agent can take in whole
  let kind = 'deck';
  try { kind = deliverableInfo(await liveHtml(project, rel)).kind; } catch { /* rendered as a deck */ }
  const dsf = kind === 'poster' ? 0.5 : 1;
  return withPage(project, rel, userId, 'check', { width: pageWidth, height: 900 }, dsf, async (_ctx, page) => {
    const rep = await report(page);
    void maxWidth;
    const images: RenderedPage[] = [];
    if (rep.kind === 'page') {
      const full = await page.evaluate(() => Math.min(document.documentElement.scrollHeight, 6000));
      const png = await page.screenshot({ clip: { x: 0, y: 0, width: pageWidth, height: full }, fullPage: true });
      images.push({ index: 0, png, report: rep.pages[0] ?? { index: 0, title: '', issues: [] } });
      return { report: rep, images };
    }
    const want = (opts.pages?.length ? opts.pages : [0]).filter(i => i >= 0 && i < rep.pages.length).slice(0, 12);
    for (const i of want) {
      const loc = page.locator('[data-ol-slide-index="' + i + '"]');
      const png = await loc.screenshot({ animations: 'disabled' });
      images.push({ index: i, png, report: rep.pages[i] });
    }
    return { report: rep, images };
  });
}

/** The deliverable as a PDF: a deck one slide per page, a poster one page of its size, a web page on A4. */
export async function deliverablePdf(project: string, rel: string, userId: number): Promise<Buffer> {
  return withPage(project, rel, userId, 'print', { width: 1280, height: 900 }, 1, async (_ctx, page) => {
    const rep = await report(page);
    if (rep.kind === 'page') return await page.pdf({ format: 'A4', printBackground: true, margin: { top: '12mm', bottom: '12mm', left: '12mm', right: '12mm' } });
    return await page.pdf({ width: `${rep.width}px`, height: `${rep.height}px`, printBackground: true, preferCSSPageSize: false, margin: { top: '0', right: '0', bottom: '0', left: '0' } });
  });
}

export async function shutdownRenderer(): Promise<void> {
  const b = browser;
  browser = null;
  await b?.then(x => x.close()).catch(() => undefined);
}
