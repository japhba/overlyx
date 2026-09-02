/**
 * A local HTTP bridge for the webviews: implements the subset of the OverLyX REST API the editor
 * UI calls (`api.ts` in the client, pointed here via OVERLYX_API_BASE). Bound to 127.0.0.1 with a
 * random token in the path; CORS is open (the token is the credential, and only this machine can
 * connect).
 */
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { URL } from 'node:url';
import { isDirectImage, toPng } from './graphics.ts';

export interface BridgeDelegate {
  /** project name → absolute root directory (undefined: unknown project) */
  projectRoot(project: string): string | undefined;
  /** all projects with their files (the client's GET /api/projects shape, roughly) */
  projects(): { name: string; files: unknown[] }[];
  meta(docId: string): Promise<Record<string, unknown>>;
  /** current LaTeX text of a document (the open editor's state, else the file) */
  texText(docId: string): Promise<string>;
  clip(docId: string, latex: string): Promise<{ blocks: unknown[]; warnings: string[] }>;
  headerGet(docId: string): Promise<{ headerLines: string[] }>;
  headerSet(docId: string, body: { headerLines?: string[]; preamble?: string; set?: Record<string, string> }): Promise<{ ok: boolean; headerLines: string[] }>;
  outline(docId: string): { headings: unknown[]; mtime: number };
  bibSearch(docId: string, q: string, keys: string[], limit: number): Promise<{ entries: unknown[]; total: number; matches?: number }>;
  exportDoc(docId: string, format: string): Promise<Record<string, unknown>>;
  buildStatus(docId: string, withTex: boolean): Record<string, unknown>;
  cancelBuild(docId: string): boolean;
  pdfPath(docId: string): string | null;
  synctexView(docId: string, line: number, column: number): Promise<unknown>;
  synctexEdit(docId: string, page: number, x: number, y: number): Promise<unknown>;
  cacheDir(): string;
  /** spell checker dictionaries (dictionary-en etc. from node_modules), or null */
  dictionary(lang: string, ext: 'aff' | 'dic'): string | null;
}

const JSON_LIMIT = 32 * 1024 * 1024;

export class Bridge {
  private server: http.Server | null = null;
  port = 0;
  token = crypto.randomBytes(16).toString('hex');

  constructor(private delegate: BridgeDelegate) {}

  /** Base URL (ends without a slash): http://127.0.0.1:<port>/t/<token> */
  get base(): string { return `http://127.0.0.1:${this.port}/t/${this.token}`; }

  start(): Promise<void> {
    return new Promise((resolve, reject) => {
      this.server = http.createServer((req, res) => { void this.handle(req, res).catch(e => { try { send(res, 500, { error: String(e) }); } catch { /* headers sent */ } }); });
      this.server.on('error', reject);
      this.server.listen(0, '127.0.0.1', () => {
        const addr = this.server!.address();
        this.port = typeof addr === 'object' && addr ? addr.port : 0;
        resolve();
      });
    });
  }

  dispose(): void { this.server?.close(); this.server = null; }

  private async handle(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    // reflect the Origin: pdf.js and the client fetch with credentials, which forbids ACAO '*'
    res.setHeader('Access-Control-Allow-Origin', String(req.headers.origin ?? '*'));
    res.setHeader('Access-Control-Allow-Credentials', 'true');
    res.setHeader('Vary', 'Origin');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'content-type');
    res.setHeader('Access-Control-Allow-Private-Network', 'true');
    if (req.method === 'OPTIONS') { res.statusCode = 204; res.end(); return; }
    const url = new URL(req.url ?? '/', 'http://localhost');
    const prefix = `/t/${this.token}`;
    if (!url.pathname.startsWith(prefix + '/')) { send(res, 403, { error: 'bad token' }); return; }
    const p = url.pathname.slice(prefix.length);
    const d = this.delegate;

    // dictionaries for the spell checker
    let m = /^\/dict\/([a-z-]+)\.(aff|dic)$/.exec(p);
    if (m) {
      const f = d.dictionary(m[1], m[2] as 'aff' | 'dic');
      if (!f || !fs.existsSync(f)) { res.statusCode = 404; res.end(); return; }
      res.setHeader('content-type', 'text/plain; charset=utf-8');
      res.setHeader('cache-control', 'public, max-age=86400');
      fs.createReadStream(f).pipe(res);
      return;
    }

    if (!p.startsWith('/api/')) { send(res, 404, { error: 'not found' }); return; }
    const api = p.slice(4);

    /* ---- stubs the client UI expects to exist ---- */
    if (api === '/auth/me') { send(res, 200, { user: { id: 1, username: 'you', name: 'You', color: '#3b6ea5', isAdmin: false }, google: false }); return; }
    if (api === '/ai/status') { send(res, 200, { available: false, model: '', completionModel: '', models: [] }); return; }
    if (api === '/agent/status') { send(res, 200, { enabled: false, authenticated: false }); return; }
    if (api === '/feedback/info') { send(res, 200, { enabled: false, repo: '', newIssueUrl: '', version: 'vscode', errorReports: false }); return; }
    if (api === '/settings') { send(res, 200, { settings: { allowRecopyTokens: false } }); return; }
    if (api === '/bib/sources') { send(res, 200, { enabled: false, sources: [] }); return; }
    if (api === '/client-error') { send(res, 200, { url: null }); return; }
    if (api === '/projects' && req.method === 'GET') { send(res, 200, { projects: d.projects() }); return; }

    /* ---- documents ---- */
    m = /^\/docs\/([^/]+)\/([a-z-]+)(?:\/([a-z-]+))?$/.exec(api);
    if (m) {
      const docId = decodeURIComponent(m[1]);
      const kind = m[3] ? `${m[2]}/${m[3]}` : m[2];
      if (kind === 'meta') { send(res, 200, await d.meta(docId)); return; }
      if (kind === 'tex') { res.setHeader('Content-Type', 'application/x-tex; charset=utf-8'); res.end(await d.texText(docId)); return; }
      if (kind === 'outline') { send(res, 200, d.outline(docId)); return; }
      if (kind === 'header' && req.method === 'GET') { send(res, 200, await d.headerGet(docId)); return; }
      if (kind === 'header' && req.method === 'POST') { send(res, 200, await d.headerSet(docId, await body(req))); return; }
      if (kind === 'clip' && req.method === 'POST') {
        const b = await body(req);
        const latex = String(b?.latex ?? '');
        if (!latex.trim() || latex.length > 256 * 1024) { send(res, 400, { error: 'no LaTeX' }); return; }
        send(res, 200, await d.clip(docId, latex));
        return;
      }
      if (kind === 'bib') {
        const keys = String(url.searchParams.get('keys') ?? '').split(',').map(k => k.trim()).filter(Boolean);
        const limit = Math.min(500, Number(url.searchParams.get('limit') ?? 100) || 100);
        send(res, 200, await d.bibSearch(docId, String(url.searchParams.get('q') ?? ''), keys, limit));
        return;
      }
      if (kind === 'export' && req.method === 'POST') { send(res, 200, await d.exportDoc(docId, String((await body(req))?.format ?? 'pdf'))); return; }
      if (kind === 'export/cancel' && req.method === 'POST') { send(res, 200, { ok: d.cancelBuild(docId) }); return; }
      if (kind === 'build') { send(res, 200, d.buildStatus(docId, url.searchParams.get('tex') === '1')); return; }
      if (kind === 'pdf') {
        const file = d.pdfPath(docId);
        if (!file || !fs.existsSync(file)) { send(res, 404, { error: 'no pdf built yet' }); return; }
        res.setHeader('Content-Type', 'application/pdf');
        res.setHeader('Cache-Control', 'no-store');
        if (url.searchParams.get('download') === '1') res.setHeader('Content-Disposition', `attachment; filename="${path.basename(file)}"`);
        fs.createReadStream(file).pipe(res);
        return;
      }
      if (kind === 'synctex/view') { send(res, 200, { boxes: await d.synctexView(docId, Math.floor(Number(url.searchParams.get('line'))), Number(url.searchParams.get('column') ?? 0) || 0) }); return; }
      if (kind === 'synctex/edit') {
        const r = await d.synctexEdit(docId, Math.floor(Number(url.searchParams.get('page'))), Number(url.searchParams.get('x')), Number(url.searchParams.get('y')));
        send(res, 200, r ?? { line: null });
        return;
      }
      if (kind === 'save' && req.method === 'POST') { send(res, 200, { ok: true }); return; }
      if (kind === 'versions') { send(res, 200, { versions: [] }); return; }
      send(res, 404, { error: `not supported in VS Code: docs/${kind}` });
      return;
    }

    /* ---- project files: graphics (converted) and raw files ---- */
    m = /^\/projects\/([^/]+)\/(graphics|file)\/(.+)$/.exec(api);
    if (m) {
      const root = d.projectRoot(decodeURIComponent(m[1]));
      if (!root) { send(res, 404, { error: 'unknown project' }); return; }
      const rel = m[3].split('/').map(decodeURIComponent).join('/');
      const abs = path.resolve(root, rel);
      if (abs !== root && !abs.startsWith(root + path.sep)) { send(res, 403, { error: 'path escapes project' }); return; }
      if (!fs.existsSync(abs) || fs.statSync(abs).isDirectory()) { send(res, 404, { error: 'not found' }); return; }
      if (m[2] === 'graphics' && !isDirectImage(abs)) {
        try {
          const png = await toPng(abs, d.cacheDir(), Math.min(3000, Number(url.searchParams.get('w') ?? 1200) || 1200));
          res.setHeader('Content-Type', 'image/png');
          res.setHeader('Cache-Control', 'private, max-age=300');
          fs.createReadStream(png).pipe(res);
        } catch (e) { send(res, 500, { error: 'conversion failed: ' + String(e) }); }
        return;
      }
      res.setHeader('Content-Type', contentType(abs));
      res.setHeader('Cache-Control', 'private, max-age=60');
      fs.createReadStream(abs).pipe(res);
      return;
    }

    send(res, 404, { error: 'not found: ' + api });
  }
}

function send(res: http.ServerResponse, status: number, data: unknown): void {
  res.statusCode = status;
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.end(JSON.stringify(data));
}

function body(req: http.IncomingMessage): Promise<any> {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => { size += c.length; if (size > JSON_LIMIT) { reject(new Error('body too large')); req.destroy(); } else chunks.push(c); });
    req.on('end', () => { try { resolve(chunks.length ? JSON.parse(Buffer.concat(chunks).toString('utf8')) : {}); } catch (e) { reject(e); } });
    req.on('error', reject);
  });
}

const TYPES: Record<string, string> = {
  '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif', '.webp': 'image/webp',
  '.svg': 'image/svg+xml', '.pdf': 'application/pdf', '.tex': 'text/plain; charset=utf-8', '.bib': 'text/plain; charset=utf-8',
  '.txt': 'text/plain; charset=utf-8', '.json': 'application/json',
};
function contentType(file: string): string { return TYPES[path.extname(file).toLowerCase()] ?? 'application/octet-stream'; }
