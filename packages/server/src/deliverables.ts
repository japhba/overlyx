/**
 * HTML deliverables (core html/): a folder with an index.html — a deck, a poster, a web page —
 * served to the editor's frame, the presentation, the PDF export and the agents' render_page.
 *
 * The page is whatever its authors wrote, scripts included, so it must never run as overlyx.app:
 * it is served under /ol-d/<token>/… with `Content-Security-Policy: sandbox allow-scripts …`
 * (an opaque origin: no cookies, no storage of the app, no same-origin requests), and the frames
 * showing it are sandboxed too. The token is a capability — project, folder, account, expiry,
 * signed — so the frame's requests (images, stylesheets, fonts, fetch()) need no cookie, which an
 * opaque origin would not send anyway; the account's access is checked again on every request.
 * Relative paths resolve inside the project (`../figures/plot.pdf` reaches the paper's figures);
 * a PDF or EPS figure asked for as an image is converted (to SVG / PNG).
 *
 * An HTML file is served as the editors have it now (the open document's text, not the file on
 * disk), with the OverLyX runtime (client src/deliverable/runtime) injected: it lays out, presents,
 * prints and typesets math, and in the editor's frame does the canvas editing (see `?ol=` modes).
 */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import type { Express, Request, Response } from 'express';
import { JWT_SECRET } from './config.ts';
import { db } from './db.ts';
import { toSessionUser, type SessionUser } from './auth.ts';
import { roleFor } from './access.ts';
import { projectDir } from './projects.ts';
import { staysInside } from './projectfiles.ts';
import { manager, HtmlDoc } from './docs.ts';
import { isHtmlPath, deliverableInfo } from '@overlyx/core/html/deliverable.ts';
import { RUNTIME_MODES, runtimeTags, injectRuntime, resolveInProject, SANDBOX_CSP, type RuntimeMode } from '@overlyx/core/html/serve.ts';
import { toPng, toSvg } from './graphics.ts';

const KEY = crypto.createHmac('sha256', JWT_SECRET || 'dev').update('overlyx deliverable token').digest();

export interface DeliverableGrant { project: string; dir: string; userId: number; exp: number }

const b64 = (b: Buffer) => b.toString('base64url');

/** A capability for the folder `dir` of `project` (project-relative, '' for the top) on behalf of `userId`. */
export function deliverableToken(project: string, dir: string, userId: number, ttlMs = 12 * 3600 * 1000): string {
  const payload = b64(Buffer.from(JSON.stringify({ p: project, d: dir, u: userId, e: Date.now() + ttlMs })));
  const sig = b64(crypto.createHmac('sha256', KEY).update(payload).digest()).slice(0, 32);
  return `${payload}.${sig}`;
}

export function verifyDeliverableToken(token: string): DeliverableGrant | null {
  const dot = token.lastIndexOf('.');
  if (dot < 0) return null;
  const payload = token.slice(0, dot), sig = token.slice(dot + 1);
  const want = b64(crypto.createHmac('sha256', KEY).update(payload).digest()).slice(0, 32);
  if (sig.length !== want.length || !crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(want))) return null;
  try {
    const j = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8')) as { p: string; d: string; u: number; e: number };
    if (typeof j.p !== 'string' || typeof j.d !== 'string' || typeof j.u !== 'number' || !(j.e > Date.now())) return null;
    return { project: j.p, dir: j.d, userId: j.u, exp: j.e };
  } catch { return null; }
}

/** the URL path (no origin) of a file of a deliverable's folder; `entry` relative to the folder */
export function deliverablePath(token: string, entry: string, mode?: string): string {
  return `/ol-d/${token}/${entry.split('/').map(encodeURIComponent).join('/')}${mode ? `?ol=${encodeURIComponent(mode)}` : ''}`;
}

/** The folder of a deliverable's page and the page's name in it. */
export function splitEntry(relPath: string): { dir: string; entry: string } {
  const i = relPath.lastIndexOf('/');
  return i < 0 ? { dir: '', entry: relPath } : { dir: relPath.slice(0, i), entry: relPath.slice(i + 1) };
}

const userCache = new Map<number, { user: SessionUser | null; at: number }>();
function userById(id: number): SessionUser | null {
  const hit = userCache.get(id);
  if (hit && Date.now() - hit.at < 10000) return hit.user;
  const row = db.prepare('SELECT * FROM users WHERE id = ?').get(id) as Parameters<typeof toSessionUser>[0] | undefined;
  const user = row ? toSessionUser(row) : null;
  userCache.set(id, { user, at: Date.now() });
  return user;
}

export { RUNTIME_MODES, runtimeTags, injectRuntime, resolveInProject, type RuntimeMode };

/** The page's text as the editors have it (an open document's), else the file's. */
export async function liveHtml(project: string, rel: string): Promise<string> {
  const id = `${project}/${rel}`;
  const open = manager.docs.get(id);
  if (open instanceof HtmlDoc) return open.html.toString();
  return fs.readFileSync(path.join(projectDir(project), rel), 'utf8');
}


function commonHeaders(res: Response): void {
  res.setHeader('Content-Security-Policy', SANDBOX_CSP);
  res.setHeader('Referrer-Policy', 'no-referrer');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  // the page's own fetch() and fonts come from an opaque origin: cross-origin to us
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Cross-Origin-Resource-Policy', 'cross-origin');
}

export function mountDeliverables(app: Express): void {
  // the runtime and its MathJax: public code, fetched by opaque-origin frames
  app.use('/_ol', (_req, res, next) => { res.setHeader('Access-Control-Allow-Origin', '*'); res.setHeader('Cross-Origin-Resource-Policy', 'cross-origin'); next(); });

  app.get(/^\/ol-d\/([^/]+)\/(.*)$/, (req: Request, res: Response) => {
    const params = req.params as unknown as Record<string, string>;
    const token = params[0], rest = params[1];
    void resolveDeliverable(token, rest ?? '', { ol: req.query.ol, as: req.query.as }, req.headers['sec-fetch-dest'] as string | undefined).then(r => {
      commonHeaders(res);
      for (const [k, v] of Object.entries(r.headers ?? {})) res.setHeader(k, v);
      if (r.file) { res.status(r.status); if (r.type) res.type(r.type); res.sendFile(r.file, { dotfiles: 'allow', lastModified: true }); return; }
      res.status(r.status);
      if (r.type) res.type(r.type);
      res.send(r.body ?? '');
    }, e => { console.error('[deliverables]', e); res.status(500).end(); });
  });
}

/** what a request of a deliverable's folder gets: a file to send, or a body */
export interface Served { status: number; type?: string; body?: string | Buffer; file?: string; headers?: Record<string, string> }

/**
 * A request of `/ol-d/<token>/<rest>` — the route's and the renderer's (render.ts serves its
 * headless browser in-process, without any network).
 */
export async function resolveDeliverable(token: string, rawRest: string, query: { ol?: unknown; as?: unknown }, fetchDest?: string): Promise<Served> {
  const grant = verifyDeliverableToken(token);
  if (!grant) return { status: 403, type: 'text/plain', body: 'This link has expired — reload the page.' };
  const user = userById(grant.userId);
  if (!user || !roleFor(user, grant.project)) return { status: 403, type: 'text/plain', body: 'No access.' };
  let rest: string;
  try { rest = decodeURIComponent(rawRest); } catch { return { status: 400 }; }
  if (!rest || rest.endsWith('/')) rest += 'index.html';
  const rel = resolveInProject(grant.dir, rest);
  if (rel === null) return { status: 404 };
  const root = projectDir(grant.project);
  const abs = path.join(root, rel);
  if (!abs.startsWith(root + path.sep) || !staysInside(root, abs)) return { status: 404 };

  if (isHtmlPath(rel)) {
    let html: string;
    try { html = await liveHtml(grant.project, rel); } catch { return { status: 404, type: 'text/plain', body: 'Not found.' }; }
    const mode = (RUNTIME_MODES as readonly string[]).includes(String(query.ol)) ? String(query.ol) as RuntimeMode : 'view';
    return { status: 200, type: 'text/html; charset=utf-8', body: injectRuntime(html, runtimeTags(mode)), headers: { 'Cache-Control': 'no-store' } };
  }

  let st: fs.Stats;
  try { st = fs.statSync(abs); } catch { return { status: 404 }; }
  if (!st.isFile()) return { status: 404 };
  const ext = path.extname(rel).toLowerCase();
  const asImage = fetchDest === 'image' || query.as === 'image';
  const headers = { 'Cache-Control': 'private, max-age=5' };
  try {
    if (asImage && ext === '.pdf') return { status: 200, type: 'image/svg+xml', file: await toSvg(abs), headers };
    if (asImage && (ext === '.eps' || ext === '.ps' || ext === '.tif' || ext === '.tiff')) return { status: 200, type: 'image/png', file: await toPng(abs, 1600), headers };
  } catch (e) { console.error('[deliverables] converting', rel, e); return { status: 500 }; }
  return { status: 200, file: abs, headers };
}

/** A new deliverable folder `dir` with an index.html of `kind` (refused when it exists). */
export function createDeliverable(project: string, dir: string, html: string): string {
  const rel = (dir ? dir.replace(/\/+$/, '') + '/' : '') + 'index.html';
  const abs = path.join(projectDir(project), rel);
  if (!abs.startsWith(projectDir(project) + path.sep)) throw new Error('bad folder');
  if (fs.existsSync(abs)) throw new Error(`${rel} exists already`);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, html, 'utf8');
  return rel;
}


/* ------------------------------------------------------------------ the folder as a website (.zip) */

const WEB_FILE = /\.(html?|css|m?js|json|svg|png|jpe?g|gif|webp|avif|ico|woff2?|ttf|otf|mp4|webm|mp3|wav|ogg|csv|tsv|txt|pdf)$/i;
const ZIP_MAX = 200 * 1024 * 1024;

/**
 * The files of a deliverable's folder for a .zip that works without OverLyX: every page with the
 * runtime (`_overlyx/runtime.js` and its MathJax; a deck opens presenting), files it uses from
 * elsewhere in the project copied into `_assets/` and its references rewritten, PDF and EPS
 * figures (which no browser shows in an <img>) converted to SVG / PNG.
 */
export async function deliverableZip(project: string, rel: string, clientDist: string): Promise<{ name: string; entries: { name: string; data: Buffer }[] }> {
  const { dir } = splitEntry(rel);
  const root = projectDir(project);
  const folder = dir ? path.join(root, dir) : root;
  if (!folder.startsWith(root)) throw new Error('bad folder');
  const entries: { name: string; data: Buffer }[] = [];
  const assets = new Map<string, string>();   // project-relative source → zip path
  let total = 0;
  const add = (name: string, data: Buffer) => {
    total += data.length;
    if (total > ZIP_MAX) throw new Error('the folder is too large to download (200 MB)');
    entries.push({ name, data });
  };

  /** a file the page refers to, as it goes into the zip: the path to write instead (null: leave it) */
  const asset = async (fromZipDir: string, ref: string, asImage: boolean): Promise<string | null> => {
    if (!ref || /^([a-z][a-z0-9+.-]*:|\/\/|#|\/)/i.test(ref)) return null;
    const clean = ref.replace(/[?#].*$/, '');
    let decoded: string;
    try { decoded = decodeURIComponent(clean); } catch { return null; }
    const projRel = resolveInProject(path.posix.join(dir, fromZipDir), decoded);
    if (projRel === null) return null;
    const abs = path.join(root, projRel);
    if (!fs.existsSync(abs) || !fs.statSync(abs).isFile()) return null;
    const ext = path.extname(projRel).toLowerCase();
    const convert = asImage && (ext === '.pdf' || ext === '.eps' || ext === '.ps');
    const inside = dir ? projRel.startsWith(dir + '/') : true;
    if (inside && !convert) return null;
    let target = assets.get(projRel + (convert ? '#img' : ''));
    if (!target) {
      const flat = projRel.replace(/[^A-Za-z0-9._-]+/g, '_');
      target = `_assets/${convert ? flat.replace(/\.[^.]+$/, ext === '.pdf' ? '.svg' : '.png') : flat}`;
      assets.set(projRel + (convert ? '#img' : ''), target);
      const data = convert ? fs.readFileSync(ext === '.pdf' ? await toSvg(abs) : await toPng(abs, 1600)) : fs.readFileSync(abs);
      add(target, data);
    }
    const depth = fromZipDir ? fromZipDir.split('/').length : 0;
    return '../'.repeat(depth) + target;
  };

  const rewriteHtml = async (html: string, zipDir: string): Promise<string> => {
    const tags = /<(img|source|video|audio|script|link|image|object|embed|iframe|track)\b[^>]*>/gi;
    let out = '', last = 0;
    for (let m = tags.exec(html); m; m = tags.exec(html)) {
      const tag = m[0], name = m[1].toLowerCase();
      const img = name === 'img' || name === 'source' || name === 'image';
      let t = tag;
      for (const attrName of ['src', 'href', 'poster', 'data', 'xlink:href']) {
        const re = new RegExp(`(\\s${attrName.replace(':', '\\:')}\\s*=\\s*)("([^"]*)"|'([^']*)')`, 'i');
        const a = re.exec(t);
        if (!a) continue;
        if (name === 'link' && attrName === 'href' && !/rel\s*=\s*["']?[^"'>]*(stylesheet|icon|preload)/i.test(t)) continue;
        const v = a[3] ?? a[4] ?? '';
        const to = await asset(zipDir, v.replace(/&amp;/g, '&'), img || attrName === 'poster');
        if (to) t = t.slice(0, a.index) + `${a[1]}"${to.replace(/"/g, '&quot;')}"` + t.slice(a.index + a[0].length);
      }
      out += html.slice(last, m.index) + t;
      last = m.index + tag.length;
    }
    return out + html.slice(last);
  };

  const rewriteCss = async (css: string, zipDir: string): Promise<string> => {
    const re = /url\(\s*(["']?)([^"')]+)\1\s*\)/g;
    let out = '', last = 0;
    for (let m = re.exec(css); m; m = re.exec(css)) {
      const to = await asset(zipDir, m[2], true);
      out += css.slice(last, m.index) + (to ? `url("${to}")` : m[0]);
      last = m.index + m[0].length;
    }
    return out + css.slice(last);
  };

  const walk = async (abs: string, prefix: string): Promise<void> => {
    for (const e of fs.readdirSync(abs, { withFileTypes: true })) {
      if (e.name.startsWith('.') || e.name === 'node_modules' || (!prefix && (e.name === '_overlyx' || e.name === '_assets'))) continue;
      const a = path.join(abs, e.name), r = prefix ? `${prefix}/${e.name}` : e.name;
      if (e.isDirectory()) { await walk(a, r); continue; }
      if (!e.isFile() || /~$|^#|\.emergency$/.test(e.name)) continue;
      // (a deliverable at the project's top: only its web files, not the project's LaTeX)
      if (!dir && !WEB_FILE.test(e.name)) continue;
      let data = fs.readFileSync(a);
      if (isHtmlPath(e.name)) {
        const projRel = (dir ? dir + '/' : '') + r;
        const open = manager.docs.get(`${project}/${projRel}`);
        const text = open instanceof HtmlDoc ? open.html.toString() : data.toString('utf8');
        const kind = deliverableInfo(text).kind;
        const up = '../'.repeat(r.split('/').length - 1);
        const tags = `<script>window.__OL={mode:${JSON.stringify(kind === 'deck' ? 'present' : 'view')}}</script><script src="${up}_overlyx/runtime.js"></script>`;
        data = Buffer.from(injectRuntime(await rewriteHtml(text, path.posix.dirname(r) === '.' ? '' : path.posix.dirname(r)), tags));
      } else if (/\.css$/i.test(e.name)) {
        data = Buffer.from(await rewriteCss(data.toString('utf8'), path.posix.dirname(r) === '.' ? '' : path.posix.dirname(r)));
      }
      add(r, data);
    }
  };
  await walk(folder, '');

  const ol = path.join(clientDist, '_ol');
  if (!fs.existsSync(path.join(ol, 'runtime.js'))) throw new Error('the runtime is not built (npm run build)');
  const addDir = (abs: string, prefix: string) => {
    for (const e of fs.readdirSync(abs, { withFileTypes: true })) {
      const a = path.join(abs, e.name), r = `${prefix}/${e.name}`;
      if (e.isDirectory()) addDir(a, r); else add(r, fs.readFileSync(a));
    }
  };
  add('_overlyx/runtime.js', fs.readFileSync(path.join(ol, 'runtime.js')));
  addDir(path.join(ol, 'mathjax'), '_overlyx/mathjax');
  return { name: dir.split('/').pop() || '', entries };
}
