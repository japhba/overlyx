/**
 * HTML deliverables in VS Code (slide decks, posters, web pages: a folder with an index.html — core
 * html/, the web app's deliverable editor): the OverLyX editor for .html files, backed by the file's
 * TextDocument, and a local server for the pages' folders.
 *
 * The page is whatever its authors wrote, scripts included, so it is served by a server of its own
 * (not the bridge, whose API edits documents): 127.0.0.1, a random token in every path, responses
 * `Content-Security-Policy: sandbox allow-scripts …` (an opaque origin), the frames sandboxed too —
 * the same as overlyx.app's /ol-d/. Paths stay inside the workspace folder (`../figures/plot.pdf`
 * reaches the paper's figures). A page is served as its editor has it (unsaved changes included),
 * with the OverLyX runtime (dist/ol/runtime.js and its MathJax) put first into its <head>.
 */
import * as vscode from 'vscode';
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { URL } from 'node:url';
import { runtimeTags, injectRuntime, resolveInProject, SANDBOX_CSP, RUNTIME_MODES, type RuntimeMode } from '@overlyx/core/html/serve.ts';
import { starterFor, type DeliverableKind } from '@overlyx/core/html/deliverable.ts';
import { webviewHtml } from './webviewHtml.ts';
import { toPng } from './graphics.ts';

const TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8', '.htm': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8',
  '.json': 'application/json', '.svg': 'image/svg+xml', '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif', '.webp': 'image/webp', '.avif': 'image/avif',
  '.ico': 'image/x-icon', '.woff': 'font/woff', '.woff2': 'font/woff2', '.ttf': 'font/ttf', '.otf': 'font/otf', '.mp4': 'video/mp4', '.webm': 'video/webm', '.mp3': 'audio/mpeg', '.wav': 'audio/wav',
  '.csv': 'text/csv; charset=utf-8', '.tsv': 'text/tab-separated-values; charset=utf-8', '.txt': 'text/plain; charset=utf-8', '.pdf': 'application/pdf',
};

/** The local server of deliverables' folders (one per window, started on first use). */
export class DeliverableServer {
  private server: http.Server | null = null;
  private starting: Promise<void> | null = null;
  private port = 0;
  private token = crypto.randomBytes(16).toString('hex');
  /** served roots: id → absolute directory */
  private roots = new Map<string, string>();

  constructor(private runtimeDir: string, private cacheDir: string) {}

  start(): Promise<void> {
    if (this.starting) return this.starting;
    this.starting = new Promise((resolve, reject) => {
      this.server = http.createServer((req, res) => { void this.handle(req, res).catch(() => { try { res.statusCode = 500; res.end(); } catch { /* sent */ } }); });
      this.server.on('error', reject);
      this.server.listen(0, '127.0.0.1', () => {
        const a = this.server!.address();
        this.port = typeof a === 'object' && a ? a.port : 0;
        resolve();
      });
    });
    return this.starting;
  }

  dispose(): void { this.server?.close(); this.server = null; }

  get origin(): string { return `http://127.0.0.1:${this.port}`; }

  /** the base URL of a root's files (ends with a slash) */
  baseFor(root: string): string {
    let id = [...this.roots].find(([, r]) => r === root)?.[0];
    if (!id) { id = crypto.createHash('sha1').update(root).digest('hex').slice(0, 12); this.roots.set(id, root); }
    return `${this.origin}/d/${this.token}/${id}/`;
  }

  private async handle(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Cross-Origin-Resource-Policy', 'cross-origin');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Referrer-Policy', 'no-referrer');
    if (req.method !== 'GET' && req.method !== 'HEAD') { res.statusCode = 405; res.end(); return; }
    const url = new URL(req.url ?? '/', 'http://localhost');
    let pathname: string;
    try { pathname = decodeURIComponent(url.pathname); } catch { res.statusCode = 400; res.end(); return; }
    // the runtime and its MathJax (public code)
    if (pathname.startsWith('/_ol/')) {
      const rel = resolveInProject('', pathname.slice('/_ol/'.length));
      const abs = rel === null ? null : path.join(this.runtimeDir, rel);
      if (!abs || !fs.existsSync(abs) || !fs.statSync(abs).isFile()) { res.statusCode = 404; res.end(); return; }
      res.setHeader('Content-Type', TYPES[path.extname(abs)] ?? 'application/octet-stream');
      res.setHeader('Cache-Control', 'max-age=3600');
      fs.createReadStream(abs).pipe(res);
      return;
    }
    res.setHeader('Content-Security-Policy', SANDBOX_CSP);
    const m = /^\/d\/([0-9a-f]+)\/([0-9a-f]+)\/(.*)$/.exec(pathname);
    if (!m || m[1].length !== this.token.length || !crypto.timingSafeEqual(Buffer.from(m[1]), Buffer.from(this.token))) { res.statusCode = 403; res.end(); return; }
    const root = this.roots.get(m[2]);
    let rest = m[3];
    if (!rest || rest.endsWith('/')) rest += 'index.html';
    const rel = root ? resolveInProject('', rest) : null;
    if (!root || rel === null) { res.statusCode = 404; res.end(); return; }
    const abs = path.join(root, rel);
    if (!abs.startsWith(root + path.sep)) { res.statusCode = 404; res.end(); return; }
    if (/\.html?$/i.test(abs)) {
      // as the editor has it (unsaved changes included)
      const open = vscode.workspace.textDocuments.find(d => !d.isClosed && d.uri.scheme === 'file' && d.uri.fsPath === abs);
      let html: string;
      try { html = open ? open.getText() : fs.readFileSync(abs, 'utf8'); } catch { res.statusCode = 404; res.end(); return; }
      const mode = (RUNTIME_MODES as readonly string[]).includes(url.searchParams.get('ol') ?? '') ? url.searchParams.get('ol') as RuntimeMode : 'view';
      res.setHeader('Content-Type', 'text/html; charset=utf-8');
      res.setHeader('Cache-Control', 'no-store');
      res.end(injectRuntime(html, runtimeTags(mode)));
      return;
    }
    let st: fs.Stats;
    try { st = fs.statSync(abs); } catch { res.statusCode = 404; res.end(); return; }
    if (!st.isFile()) { res.statusCode = 404; res.end(); return; }
    let file = abs;
    const ext = path.extname(abs).toLowerCase();
    // a PDF / EPS figure in an <img>: as a picture
    if ((req.headers['sec-fetch-dest'] === 'image' || url.searchParams.get('as') === 'image') && (ext === '.pdf' || ext === '.eps' || ext === '.ps')) {
      try { file = await toPng(abs, this.cacheDir, 1600); } catch { res.statusCode = 500; res.end(); return; }
    }
    res.setHeader('Content-Type', TYPES[path.extname(file).toLowerCase()] ?? 'application/octet-stream');
    res.setHeader('Cache-Control', 'no-cache');
    fs.createReadStream(file).pipe(res);
  }
}

/* ------------------------------------------------------------------ the editor */

/** messages of the deliverable webview (src/webview/deliverableMain.tsx) */
export type DeliverableToHost =
  | { type: 'ready' }
  | { type: 'dlApply'; version: number; splices: { from: number; to: number; insert: string }[] }
  | { type: 'dlUndo' } | { type: 'dlRedo' }
  | { type: 'dlUpload'; id: number; rel: string; data: string }
  | { type: 'dlOpenExternal'; url: string }
  | { type: 'dlSave' }
  | { type: 'notify'; kind?: 'info' | 'error'; text: string };

export type HostToDeliverable =
  | { type: 'dlInit'; text: string; version: number; base: string; entry: string; readOnly: boolean; dark: boolean }
  | { type: 'dlText'; text: string; version: number }
  | { type: 'dlAsset'; path: string; v: number }
  | { type: 'dlUploaded'; id: number; error?: string };

const isDark = () => [vscode.ColorThemeKind.Dark, vscode.ColorThemeKind.HighContrast].includes(vscode.window.activeColorTheme.kind);

/** the folder a page's links resolve in: its workspace folder (so `../figures` reaches the project's figures), else the page's parent */
function rootFor(uri: vscode.Uri): string {
  const ws = vscode.workspace.getWorkspaceFolder(uri);
  if (ws?.uri.scheme === 'file') return ws.uri.fsPath;
  return path.dirname(path.dirname(uri.fsPath));
}

export class DeliverableEditorProvider implements vscode.CustomTextEditorProvider {
  constructor(private context: vscode.ExtensionContext, private server: DeliverableServer, private bridgeBase: () => Promise<string>) {}

  async resolveCustomTextEditor(document: vscode.TextDocument, panel: vscode.WebviewPanel): Promise<void> {
    await this.server.start();
    const root = rootFor(document.uri);
    const entry = path.relative(root, document.uri.fsPath).split(path.sep).join('/');
    const local = this.server.baseFor(root);
    // (Remote-SSH, Codespaces: the forwarded address of the local server)
    const external = (await vscode.env.asExternalUri(vscode.Uri.parse(this.server.origin))).toString().replace(/\/$/, '');
    const base = external + local.slice(this.server.origin.length);
    panel.webview.options = { enableScripts: true, localResourceRoots: [vscode.Uri.joinPath(this.context.extensionUri, 'dist')] };
    panel.webview.html = await webviewHtml(panel.webview, this.context.extensionUri, 'deliverable', { page: 'deliverable', docId: entry, base: await this.bridgeBase(), dark: isDark(), frameOrigin: external });
    const post = (m: HostToDeliverable) => void panel.webview.postMessage(m);
    const subs: vscode.Disposable[] = [];
    let chain = Promise.resolve();

    subs.push(vscode.workspace.onDidChangeTextDocument(e => {
      if (e.document !== document || !e.contentChanges.length) return;
      post({ type: 'dlText', text: document.getText(), version: document.version });
    }));
    // files the page uses changed on disk: the frames fetch stylesheets and pictures again
    const watcher = vscode.workspace.createFileSystemWatcher(new vscode.RelativePattern(root, '**/*.{css,js,mjs,json,csv,tsv,svg,png,jpg,jpeg,gif,webp,avif,pdf,woff,woff2,ttf,otf}'));
    const asset = (uri: vscode.Uri) => {
      const rel = path.relative(root, uri.fsPath).split(path.sep).join('/');
      if (rel.startsWith('..') || rel.split('/').some(s => s === '.git' || s === 'node_modules')) return;
      post({ type: 'dlAsset', path: rel, v: Date.now() });
    };
    subs.push(watcher, watcher.onDidChange(asset), watcher.onDidCreate(asset));

    subs.push(panel.webview.onDidReceiveMessage((msg: DeliverableToHost) => {
      switch (msg.type) {
        case 'ready':
          post({ type: 'dlInit', text: document.getText(), version: document.version, base, entry, readOnly: false, dark: isDark() });
          break;
        case 'dlApply':
          chain = chain.then(async () => {
            if (msg.version !== document.version) {
              // changed meanwhile (an agent, another editor): the webview gets the text as it is and does it again
              post({ type: 'dlText', text: document.getText(), version: document.version });
              return;
            }
            const edit = new vscode.WorkspaceEdit();
            for (const s of [...msg.splices].sort((a, b) => b.from - a.from)) {
              edit.replace(document.uri, new vscode.Range(document.positionAt(s.from), document.positionAt(s.to)), s.insert);
            }
            await vscode.workspace.applyEdit(edit);
          }).catch(e => void vscode.window.showErrorMessage(`OverLyX could not change ${entry}: ${String(e)}`));
          break;
        case 'dlUndo':
        case 'dlRedo':
          panel.reveal(panel.viewColumn, false);
          void vscode.commands.executeCommand(msg.type === 'dlUndo' ? 'undo' : 'redo');
          break;
        case 'dlUpload': {
          const target = resolveInProject('', msg.rel);
          const abs = target === null ? null : path.join(root, target);
          if (!abs || !abs.startsWith(root + path.sep)) { post({ type: 'dlUploaded', id: msg.id, error: 'not in the folder' }); break; }
          if (fs.existsSync(abs)) { post({ type: 'dlUploaded', id: msg.id, error: 'file exists' }); break; }
          try {
            fs.mkdirSync(path.dirname(abs), { recursive: true });
            fs.writeFileSync(abs, Buffer.from(msg.data, 'base64'));
            post({ type: 'dlUploaded', id: msg.id });
          } catch (e) { post({ type: 'dlUploaded', id: msg.id, error: String(e) }); }
          break;
        }
        case 'dlOpenExternal':
          // only this server's pages
          if (msg.url.startsWith(external + '/d/') || msg.url.startsWith(this.server.origin + '/d/')) void vscode.env.openExternal(vscode.Uri.parse(msg.url));
          break;
        case 'dlSave':
          chain = chain.then(async () => { await document.save(); }).catch(e => void vscode.window.showErrorMessage(`OverLyX could not save ${entry}: ${String(e)}`));
          break;
        case 'notify':
          if (msg.kind === 'error') void vscode.window.showErrorMessage('OverLyX: ' + msg.text);
          else vscode.window.setStatusBarMessage('OverLyX: ' + msg.text, 5000);
          break;
      }
    }));
    panel.onDidDispose(() => { for (const s of subs) s.dispose(); });
  }
}

/* ------------------------------------------------------------------ new deliverables */

const KIND_LABEL: Record<DeliverableKind, string> = { deck: 'slide deck', poster: 'poster', page: 'web page' };
const FOLDER: Record<DeliverableKind, string> = { deck: 'talk', poster: 'poster', page: 'site' };

/**
 * A new deck, poster or web page: a folder (the user picks where and its name) with an index.html
 * from core's starting point, opened in the OverLyX editor.
 */
export async function newDeliverable(kind: DeliverableKind, startDir: string): Promise<void> {
  const picked = await vscode.window.showSaveDialog({
    title: `New ${KIND_LABEL[kind]} — a folder with an index.html`,
    saveLabel: 'Create folder',
    defaultUri: vscode.Uri.file(path.join(startDir, freeFolder(startDir, FOLDER[kind]))),
    filters: { Folder: ['*'] },
  });
  if (!picked) return;
  const dir = picked.fsPath.replace(/\.html?$/i, '');
  const file = path.join(dir, 'index.html');
  if (fs.existsSync(file)) { void vscode.window.showErrorMessage(`OverLyX: ${file} exists already`); return; }
  fs.mkdirSync(dir, { recursive: true });
  const title = path.basename(dir).replace(/[-_]+/g, ' ');
  fs.writeFileSync(file, starterFor(kind, title.charAt(0).toUpperCase() + title.slice(1)), 'utf8');
  await vscode.commands.executeCommand('vscode.openWith', vscode.Uri.file(file), 'overlyx.htmlEditor');
}

function freeFolder(dir: string, name: string): string {
  for (let i = 2, n = name; ; n = `${name}-${i++}`) if (!fs.existsSync(path.join(dir, n))) return n;
}
