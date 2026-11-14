/**
 * Search in a project's files — `GET /api/projects/:project/search?q=…&case=1&word=1&regex=1`, the
 * files panel's Search (client app/ProjectSearch.tsx; the VS Code extension has VS Code's own).
 *
 * Which files: the project's text files as the file browser lists them (projectfiles.ts collect: no
 * dot-folders, so no .git, no node_modules), without LaTeX's build products, backups, pictures, PDFs,
 * whiteboards, .lyx originals and archives; each one resolved inside the project (a symbolic link out
 * of it is left out). Documents are searched in their files on disk: the server writes an open
 * document there within seconds of an edit (config saveDebounceMs, at most saveMaxWaitMs), so what
 * was typed a moment ago may be found a moment later.
 *
 * The matching runs in a worker thread (searchworker.ts), one search at a time: a search stops itself
 * after SEARCH_LIMITS.softMs between files, and a regular expression that never finishes in one file
 * has its worker stopped after SEARCH_LIMITS.hardMs — the answer then says so and the next search gets a new one.
 */
import path from 'node:path';
import { Worker } from 'node:worker_threads';
import { roleFor, roleAt, atLeast, accessibleProjects } from './access.ts';
import { lastOpenedByProject } from './userSettings.ts';
import type { SessionUser } from './auth.ts';
import { collect, resolveProjectPath, isBackupFile } from './projectfiles.ts';
import { compileQuery, SearchError, SEARCH_LIMITS, type SearchFileResult, type SearchLimits, type SearchQuery, type SearchResult, type SearchTarget } from './searchtext.ts';

export { SearchError, type SearchQuery, type SearchResult } from './searchtext.ts';

/** LaTeX's build products (the file browser hides them too: client api.ts isAuxFile) */
const AUX_EXTS = new Set(['olx', 'olsrc', 'aux', 'log', 'bbl', 'blg', 'fls', 'fdb_latexmk', 'out', 'toc', 'lof', 'lot', 'nav', 'snm', 'bcf', 'dvi', 'xdv', 'spl', 'idx', 'ind', 'ilg', 'glo', 'gls', 'glg', 'acn', 'acr', 'alg', 'ist', 'loa', 'lol', 'thm', 'vrb', 'xcp', 'upa', 'upb', 'synctex']);
/** files that are not text (pictures and PDFs are known by their kind) */
const BINARY_EXTS = new Set(['zip', 'gz', 'tgz', 'tar', 'bz2', 'xz', '7z', 'rar', 'otf', 'ttf', 'woff', 'woff2', 'eot', 'mp3', 'mp4', 'm4a', 'wav', 'ogg', 'oga', 'webm', 'mov', 'avi', 'mkv', 'docx', 'xlsx', 'pptx', 'odt', 'ods', 'odp', 'sqlite', 'db', 'npy', 'npz', 'pkl', 'pt', 'h5', 'hdf5', 'mat', 'ico', 'psd', 'ai', 'xcf', 'bin', 'exe', 'dll', 'so', 'dylib', 'class', 'jar', 'pyc', 'wasm']);

/** A file the search reads (`searchTargets`)? */
export function searchable(name: string, kind: string): boolean {
  if (kind === 'dir' || kind === 'image' || kind === 'pdf' || kind === 'board' || kind === 'lyx' || isBackupFile(name)) return false;
  const base = name.toLowerCase();
  if (base.endsWith('.synctex.gz') || base.endsWith('.run.xml')) return false;
  const ext = base.includes('.') ? base.slice(base.lastIndexOf('.') + 1) : '';
  return !AUX_EXTS.has(ext) && !BINARY_EXTS.has(ext);
}

/** The project's files to search, in the file browser's order, each inside the project. */
export function searchTargets(project: string): SearchTarget[] {
  const root = resolveProjectPath(project, '.');
  const out: SearchTarget[] = [];
  for (const f of collect(root, root, [], 0)) {
    if (!searchable(f.name, f.kind)) continue;
    let abs: string;
    try { abs = resolveProjectPath(project, f.path); } catch { continue; }   // a link that leads out of the project
    out.push({ path: f.path.split(path.sep).join('/'), abs, size: f.size, html: f.kind === 'html' || f.format === 'article' });
  }
  return out;
}

/** searches waiting for the worker; more are refused (someone typing fast gets the latest) */
const QUEUE_MAX = 6;

interface Job { id: number; targets: SearchTarget[]; query: SearchQuery; limits: SearchLimits; gone: () => boolean; resolve: (r: SearchResult) => void; reject: (e: Error) => void }
let worker: Worker | null = null;
let running: (Job & { timer: NodeJS.Timeout; w: Worker }) | null = null;
const queue: Job[] = [];
let nextId = 1;

function spawn(): Worker {
  // the server runs TypeScript through tsx and a worker inherits that; vitest's workers register it (as docpool.ts does)
  const viaTsx = process.execArgv.some(a => a.includes('tsx'));
  const w = new Worker(new URL('./searchworker.ts', import.meta.url), { name: 'overlyx-search', ...(viaTsx ? {} : { execArgv: ['--import', 'tsx'] }) });
  w.unref();
  w.on('message', (m: { id: number; ok: boolean; result?: SearchResult; error?: string; status?: number }) => {
    const job = running;
    if (!job || job.w !== w || job.id !== m.id) return;
    clearTimeout(job.timer); running = null;
    if (m.ok) job.resolve(m.result!); else job.reject(m.status && m.status < 500 ? new SearchError(m.error ?? 'search failed', m.status) : new Error(m.error ?? 'search failed'));
    pump();
  });
  w.on('error', e => { if (worker === w) worker = null; if (running?.w === w) fail(e); });
  w.on('exit', () => { if (worker === w) worker = null; if (running?.w === w) fail(new Error('the search worker stopped')); });
  return w;
}

function fail(e: Error) {
  const job = running;
  if (!job) return;
  clearTimeout(job.timer); running = null;
  job.reject(e);
  pump();
}

function pump() {
  if (running) return;
  let job: Job | undefined;
  while ((job = queue.shift()) && job.gone()) job.reject(new SearchError('cancelled', 499));
  if (!job) { worker?.unref(); return; }
  worker ??= spawn();
  worker.ref();
  const w = worker;
  const timer = setTimeout(() => {
    // a pattern that never finishes: stop the worker, the next search gets a new one
    worker = null;
    running = null;
    void w.terminate();
    job!.reject(new SearchError('The search took too long — try a simpler pattern', 422));
    pump();
  }, job.limits.hardMs);
  running = { ...job, timer, w };
  w.postMessage({ id: job.id, targets: job.targets, query: job.query, limits: job.limits });
}

/** Search a project for `query` as `user` (who needs to be able to view it). `gone`: the asker left — skip it if it still waits. */
export function searchProject(user: SessionUser, project: string, query: SearchQuery, gone: () => boolean = () => false, limits: SearchLimits = SEARCH_LIMITS): Promise<SearchResult> {
  if (!atLeast(roleFor(user, project), 'view')) return Promise.reject(new SearchError('You do not have access to this project', 403));
  try { compileQuery(query); } catch (e) { return Promise.reject(e); }
  return enqueue(searchTargets(project), query, limits, gone);
}

function enqueue(targets: SearchTarget[], query: SearchQuery, limits: SearchLimits, gone: () => boolean): Promise<SearchResult> {
  if (queue.length >= QUEUE_MAX) return Promise.reject(new SearchError('Too many searches at once — try again in a moment', 503));
  return new Promise((resolve, reject) => {
    queue.push({ id: nextId++, targets, query, limits, gone, resolve, reject });
    pump();
  });
}

/** the start page's search inside all projects: a few lines per file, fewer files than in one project */
export const ALL_SEARCH_LIMITS: SearchLimits = { ...SEARCH_LIMITS, perFile: 3, shown: 600, files: 300 };

export interface AllSearchResult {
  /** projects with matches, the ones this person worked in lately first; `files` as in a project's search */
  projects: { project: string; files: SearchFileResult[]; count: number }[];
  total: number; truncated: boolean; searched: number; skipped: number;
  /** end-to-end encrypted projects: the server cannot read them, so they were not searched */
  encrypted: string[];
}

/**
 * Search all the projects `user` can open (the start page's "Search inside files", `GET /api/search`):
 * one job over all their text files, the projects opened or changed lately first (a search that stops
 * early has looked there). A project of which only folders or files are shared with them is searched
 * there only (roleAt); end-to-end encrypted projects are left out and named; projects opened as an
 * administrator are not "theirs" and are left out too.
 */
export function searchAllProjects(user: SessionUser, query: SearchQuery, gone: () => boolean = () => false, limits: SearchLimits = ALL_SEARCH_LIMITS): Promise<AllSearchResult> {
  try { compileQuery(query); } catch (e) { return Promise.reject(e); }
  const opened = lastOpenedByProject(user.id);
  const recency = (p: { name: string; files: { mtime: number; kind: string }[] }) => p.files.reduce((t, f) => f.kind !== 'dir' && f.mtime > t ? f.mtime : t, opened.get(p.name) ?? 0);
  const list = accessibleProjects(user).filter(p => p.via !== 'admin').sort((a, b) => recency(b) - recency(a));
  const encrypted: string[] = [];
  const targets: SearchTarget[] = [];
  const where = new Map<string, { project: string; path: string }>();
  for (const p of list) {
    if (p.e2e) { encrypted.push(p.name); continue; }
    let own: SearchTarget[];
    try { own = searchTargets(p.name); } catch { continue; }
    for (const t of own) {
      if (p.partial ? !atLeast(roleAt(user, p.name, t.path), 'view') : !atLeast(roleFor(user, p.name), 'view')) continue;
      const key = p.name + '//' + t.path;
      where.set(key, { project: p.name, path: t.path });
      targets.push({ ...t, path: key });
    }
  }
  return enqueue(targets, query, limits, gone).then(r => {
    const byProject = new Map<string, AllSearchResult['projects'][number]>();
    for (const f of r.files) {
      const w = where.get(f.path);
      if (!w) continue;
      let entry = byProject.get(w.project);
      if (!entry) byProject.set(w.project, entry = { project: w.project, files: [], count: 0 });
      entry.files.push({ ...f, path: w.path });
      entry.count += f.count;
    }
    return { projects: [...byProject.values()], total: r.total, truncated: r.truncated, searched: r.searched, skipped: r.skipped, encrypted };
  });
}
