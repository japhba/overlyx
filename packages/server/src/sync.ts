/**
 * Keeping a local clone of a project in step with the server, both ways and without anybody pulling,
 * committing or pushing: `overlyx sync --watch` and the VS Code extension run the client side
 * (packages/cli/bin/overlyx.js, "sync"). The same credentials and roles as git (viewers receive,
 * editors send too).
 *
 * The sync moves **file contents, not commits**: what a clone saves goes into the project's working
 * tree (and into the open documents) at once, and the project's history stays what it is — OverLyX's
 * own commits a while after the last change (git.ts touchProject), attributed to everybody who
 * edited, whether in the browser or in a synced clone. The clone's branch follows those commits.
 *
 *   GET  state?project=          every file (git's view: tracked + not ignored) with its git blob
 *                                hash, the branch, its head, and a cursor for `wait`
 *   GET  wait?project=&cursor=   returns as soon as something in the project changed (long poll)
 *   GET  file?project=&path=     a file's bytes
 *   POST push {project, files}   the clone's changed files, each with the hash (and, for text, the
 *                                content) of the version it last had from the server: applied where
 *                                the server still has that version; else merged — documents
 *                                paragraph by paragraph (docedit.ts applySyncedSource: a paragraph
 *                                both changed keeps the live text, the clone's comes as a tracked
 *                                change), other text files line by line (git merge-file); what cannot
 *                                be merged (binary files, overlapping lines) keeps the server's
 *                                version, and the clone keeps its own as a conflict copy
 *   POST commit {project, message}   commit the project now with that message (a commit made in the clone)
 */
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';
import crypto from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import express, { type Request, type Response } from 'express';
import { manager, HtmlDoc, OpenDoc, projectFileListeners } from './docs.ts';
import { projectDir, isDocumentFile, assertWritableRelPath } from './projects.ts';
import { readFileIn, writeFileIn, removeIn, lstatIn } from './confined.ts';
import { git, gitEnv, ensureRepo, touchProject, commitProject, commitListeners, authenticateBasic, cliTarget } from './git.ts';
import { logAccess, roleFor } from './access.ts';
import { notePeer } from './syncPeers.ts';
import { assertRoom, noteWritten } from './projectsize.ts';
import type { SessionUser } from './auth.ts';

const execFileP = promisify(execFile);

/** the largest file kept in sync (larger ones stay out of it, on both sides) */
export const SYNC_FILE_MAX = 20 * 1024 * 1024;
/** files in one push (the clients send at most SYNC_BATCH_FILES): each may need a merge, all under the project's lock */
export const SYNC_PUSH_FILES = 1000;
/** pushes of one user at the same time, and in ten minutes (a watching clone pushes every save) */
const PUSHES_AT_ONCE = 2, PUSHES_PER_10MIN = 900;
/** how long a `wait` is held open */
const WAIT_MS = Number(process.env.OVERLYX_SYNC_WAIT_MS ?? 25_000);
const MAX_WAITERS = 2000;

/** git's object name of a file's content: what `git hash-object` says, and what a clone can compute without git */
export function blobHash(data: Buffer): string {
  return crypto.createHash('sha1').update(`blob ${data.length}\0`).update(data).digest('hex');
}

/* -------------------------------------------------------------------- change cursor */

const BOOT = crypto.randomBytes(4).toString('hex');
const counters = new Map<string, number>();
const waiters = new Map<string, Set<() => void>>();
let waiting = 0;

const cursorOf = (project: string) => `${BOOT}.${counters.get(project) ?? 0}`;

function bump(project: string): void {
  counters.set(project, (counters.get(project) ?? 0) + 1);
  const ws = waiters.get(project);
  if (!ws) return;
  waiters.delete(project);
  for (const w of ws) w();
}

projectFileListeners.add(bump);
commitListeners.add(bump);

/* -------------------------------------------------------------------- the file list */

/** hashes by file identity, so that a listing reads only what changed since the last one */
const hashCache = new Map<string, { size: number; mtime: number; ino: number; hash: string }>();

export interface SyncFile { path: string; hash: string; size: number }

/** Every file of the project git would keep (tracked, or untracked and not ignored by a .gitignore), regular files only. */
async function listFiles(project: string): Promise<SyncFile[]> {
  const root = projectDir(project);
  // the project's own .gitignore files only — what a clone's `overlyx sync` lists the same way, whatever
  // its machine's global excludes say (a file one side skips would look deleted to the other)
  const out = await git(project, ['ls-files', '-z', '--cached', '--others', '--exclude-per-directory=.gitignore'], { maxBuffer: 64 * 1024 * 1024 });
  const seen = new Set<string>();
  const files: SyncFile[] = [];
  for (const rel of out.split('\0')) {
    if (!rel || seen.has(rel) || !syncable(rel)) continue;
    seen.add(rel);
    const st = lstatIn(root, rel);
    if (!st?.isFile() || st.size > SYNC_FILE_MAX) continue;
    const key = `${project}\0${rel}`;
    const c = hashCache.get(key);
    if (c && c.size === st.size && c.mtime === st.mtimeMs && c.ino === st.ino) { files.push({ path: rel, hash: c.hash, size: st.size }); continue; }
    const data = readFileIn(root, rel, SYNC_FILE_MAX);
    if (!data) continue;
    const hash = blobHash(data);
    hashCache.set(key, { size: st.size, mtime: st.mtimeMs, ino: st.ino, hash });
    files.push({ path: rel, hash, size: data.length });
  }
  if (hashCache.size > 200_000) hashCache.clear();
  return files;
}

/** a path the sync may carry: inside the project, never into .git, never our temp files */
function syncable(rel: string): boolean {
  try { assertWritableRelPath(rel); } catch { return false; }
  return !rel.endsWith('.overlyx-tmp');
}

async function headOf(project: string): Promise<{ branch: string | null; head: string | null }> {
  const branch = await git(project, ['symbolic-ref', '--short', '-q', 'HEAD']).then(s => s.trim() || null, () => null);
  const head = await git(project, ['rev-parse', '-q', '--verify', 'HEAD']).then(s => s.trim() || null, () => null);
  return { branch, head };
}

/* -------------------------------------------------------------------- applying a clone's files */

export interface PushedFile {
  path: string;
  /** hash of the version the clone last had from the server (null: the clone created the file) */
  base: string | null;
  /** that version's text, for merging (text files) */
  baseText?: string;
  /** the clone's version: text, or base64 bytes; `deleted`: the clone removed the file */
  text?: string;
  data?: string;
  deleted?: boolean;
}

export interface PushResult {
  path: string;
  /** applied: the server took the clone's version as it is; merged: combined with changes made here
   *  meanwhile; conflict: changes here and in the clone overlap (documents: the clone's text is a
   *  tracked change; other files: the server's version stayed); unchanged: the server had it already */
  status: 'applied' | 'merged' | 'conflict' | 'unchanged' | 'error';
  /** the file on the server now (null: there is none) */
  hash: string | null;
  /** its content when it differs from what the clone sent */
  text?: string;
  data?: string;
  /** documents: paragraphs both sides changed */
  conflicts?: number;
  error?: string;
}

const projectLocks = new Map<string, Promise<unknown>>();
function exclusive<T>(project: string, fn: () => Promise<T>): Promise<T> {
  const prev = projectLocks.get(project) ?? Promise.resolve();
  const run = prev.catch(() => undefined).then(fn);
  const tail = run.catch(() => undefined);
  projectLocks.set(project, tail);
  void tail.then(() => { if (projectLocks.get(project) === tail) projectLocks.delete(project); });
  return run;
}

/** UTF-8 without NUL bytes (what the merges and the JSON transport treat as text) */
const isText = (b: Buffer) => !b.includes(0) && Buffer.from(b.toString('utf8'), 'utf8').equals(b);
const contentOf = (b: Buffer): { text: string } | { data: string } => isText(b) ? { text: b.toString('utf8') } : { data: b.toString('base64') };

/** Three-way merge of text by lines (git merge-file); null when changes overlap. */
async function mergeText(base: string, ours: string, theirs: string): Promise<string | null> {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'overlyx-merge-'));
  try {
    const f = (n: string, t: string) => { const p = path.join(dir, n); fs.writeFileSync(p, t); return p; };
    const o = f('server', ours), b = f('base', base), t = f('clone', theirs);
    try {
      const { stdout } = await execFileP('git', ['merge-file', '-p', o, b, t], { encoding: 'utf8', env: gitEnv(), maxBuffer: 4 * SYNC_FILE_MAX });
      return stdout;
    } catch { return null; }   // exit code = number of conflicts (or an error)
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
}

/** One file of a push. Runs under the project's lock. */
async function applyFile(project: string, user: SessionUser, f: PushedFile): Promise<PushResult> {
  const rel = String(f.path ?? '');
  if (!syncable(rel)) return { path: rel, status: 'error', hash: null, error: 'not a path the sync may write' };
  const root = projectDir(project);
  const content = f.deleted ? null : typeof f.text === 'string' ? Buffer.from(f.text, 'utf8') : typeof f.data === 'string' ? Buffer.from(f.data, 'base64') : undefined;
  if (content === undefined) return { path: rel, status: 'error', hash: null, error: 'no content' };
  if (content && content.length > SYNC_FILE_MAX) return { path: rel, status: 'error', hash: null, error: `larger than ${SYNC_FILE_MAX >> 20} MB: not synced` };

  const st = lstatIn(root, rel);
  if (st && !st.isFile()) return { path: rel, status: 'error', hash: null, error: 'not a regular file on the server' };
  const id = `${project}/${rel}`;
  // the file holds what the editors show (an open document's unsaved edits are written first)
  const open = manager.docs.get(id);
  if (open) { try { await open.saveToFile(); } catch { /* compared with what is on disk */ } }
  const cur = readFileIn(root, rel, SYNC_FILE_MAX);
  const curHash = cur ? blobHash(cur) : null;
  const newHash = content ? blobHash(content) : null;
  if (curHash === newHash) return { path: rel, status: 'unchanged', hash: curHash };
  const keepServer = (): PushResult => ({ path: rel, status: 'conflict', hash: curHash, ...(cur ? contentOf(cur) : {}) });

  // the server still has the version the clone started from (or the clone edited a file removed here: the edit wins)
  if (curHash === f.base || (cur === null && content !== null)) {
    if (content === null) {
      removeIn(root, rel);
      hashCache.delete(`${project}\0${rel}`);
      noteWritten(project, -(st?.size ?? 0));
    } else {
      assertRoom(project, content.length, st?.size ?? 0, rel);
      await writeWhole(open, root, rel, content);
    }
    touchProject(project, user.id);
    return { path: rel, status: 'applied', hash: newHash };
  }
  // changed on both sides
  if (content === null || cur === null || f.base === null || typeof f.baseText !== 'string' || typeof f.text !== 'string' || !isText(cur)) return keepServer();
  if (f.baseText.length > SYNC_FILE_MAX) return keepServer();
  if (isDocumentFile(project, rel) && !(open instanceof HtmlDoc)) {
    const doc = open ?? await manager.open(id);
    if (!(doc instanceof OpenDoc) || doc instanceof HtmlDoc) return keepServer();
    const { result } = await doc.agentEdit('sync', f.baseText, { after: f.text }, { author: user.name });
    await doc.saveToFile();
    touchProject(project, user.id);
    const now = readFileIn(root, rel, SYNC_FILE_MAX);
    if (!now) return keepServer();
    return { path: rel, status: result.conflicts ? 'conflict' : 'merged', hash: blobHash(now), conflicts: result.conflicts, ...(now.equals(content) ? {} : contentOf(now)) };
  }
  const merged = await mergeText(f.baseText, cur.toString('utf8'), f.text);
  if (merged === null) return keepServer();
  const bytes = Buffer.from(merged, 'utf8');
  assertRoom(project, bytes.length, cur.length, rel);
  await writeWhole(open, root, rel, bytes);
  touchProject(project, user.id);
  return { path: rel, status: 'merged', hash: blobHash(bytes), ...(bytes.equals(content) ? {} : { text: merged }) };
}

/** Put `content` in place of the file; an open document (an HTML deliverable too) takes it in like any external save. */
async function writeWhole(open: OpenDoc | undefined, root: string, rel: string, content: Buffer): Promise<void> {
  writeFileIn(root, rel, content);
  // an open document takes it in now (the watcher would, a moment later), merged with what was typed meanwhile
  if (open) { try { await open.absorbExternalChangeAsync(content.toString('utf8')); } catch (e) { console.error(`[sync] ${rel}: the open document did not take the file in:`, e); } }
}

/* -------------------------------------------------------------------- routes */

function target(req: Request, res: Response, need: 'view' | 'edit'): { user: SessionUser; project: string } | null {
  const user = (res.locals.user as SessionUser | undefined) ?? authenticateBasic(req, res);
  if (!user) return null;
  const t = cliTarget(req, res, user, need, false);
  if (!t) return null;
  // a synced clone at work: the web interface says so while its requests (the long poll too) go on
  res.on('close', notePeer(t.project, user, req));
  return { user, project: t.project };
}

export function syncRouter(): express.Router {
  const r = express.Router();

  r.get('/state', async (req, res) => {
    const t = target(req, res, 'view');
    if (!t) return;
    try {
      await ensureRepo(t.project);
      await manager.saveProject(t.project);   // the files hold what the editors show (unsaved edits too)
      const cursor = cursorOf(t.project);   // before listing: a change during the listing wakes the next wait
      const [files, h] = await Promise.all([listFiles(t.project), headOf(t.project)]);
      logAccess(t.project, t.user.id, 'git-fetch', 'sync');
      res.json({ project: t.project, role: roleFor(t.user, t.project), ...h, cursor, max: SYNC_FILE_MAX, files });
    } catch (e) { res.status(500).json({ error: (e as Error).message }); }
  });

  r.get('/wait', (req, res) => {
    const t = target(req, res, 'view');
    if (!t) return;
    const since = String(req.query.cursor ?? '');
    if (since !== cursorOf(t.project)) { res.json({ cursor: cursorOf(t.project) }); return; }
    if (waiting >= MAX_WAITERS) { res.status(503).json({ error: 'busy, try again' }); return; }
    let done = false;
    const finish = () => {
      if (done) return;
      done = true;
      waiting--;
      clearTimeout(timer);
      waiters.get(t.project)?.delete(finish);
      if (!res.writableEnded) res.json({ cursor: cursorOf(t.project) });
    };
    waiting++;
    const timer = setTimeout(finish, WAIT_MS);
    let ws = waiters.get(t.project);
    if (!ws) { ws = new Set(); waiters.set(t.project, ws); }
    ws.add(finish);
    res.on('close', finish);
  });

  r.get('/file', (req, res) => {
    const t = target(req, res, 'view');
    if (!t) return;
    const rel = String(req.query.path ?? '');
    if (!syncable(rel)) { res.status(400).json({ error: 'bad path' }); return; }
    const data = readFileIn(projectDir(t.project), rel, SYNC_FILE_MAX);
    if (!data) { res.status(404).json({ error: `no file ${rel}` }); return; }
    res.set('X-OverLyX-Hash', blobHash(data)).type('application/octet-stream').send(data);
  });

  // authenticated before the (large) body is read
  const authFirst = (req: Request, res: Response, next: () => void) => { const user = authenticateBasic(req, res); if (user) { res.locals.user = user; next(); } };

  // one user's pushes: how many run now, and when the recent ones started
  const pushing = new Map<number, number>();
  const recent = new Map<number, number[]>();
  const pushAllowed = (req: Request, res: Response, next: () => void) => {
    const id = (res.locals.user as SessionUser).id;
    const now = Date.now();
    const times = (recent.get(id) ?? []).filter(x => now - x < 600000);
    if ((pushing.get(id) ?? 0) >= PUSHES_AT_ONCE || times.length >= PUSHES_PER_10MIN) { res.status(429).set('Retry-After', '5').json({ error: 'too many pushes at once — try again in a moment' }); return; }
    times.push(now);
    recent.set(id, times);
    pushing.set(id, (pushing.get(id) ?? 0) + 1);
    res.on('close', () => { const n = (pushing.get(id) ?? 1) - 1; if (n > 0) pushing.set(id, n); else pushing.delete(id); });
    next();
  };

  r.post('/push', authFirst, pushAllowed, express.json({ limit: '64mb' }), async (req, res) => {
    const t = target(req, res, 'edit');
    if (!t) return;
    const files = Array.isArray(req.body?.files) ? req.body.files as PushedFile[] : null;
    if (!files) { res.status(400).json({ error: 'files missing' }); return; }
    if (files.length > SYNC_PUSH_FILES) { res.status(413).json({ error: `at most ${SYNC_PUSH_FILES} files per push` }); return; }
    try {
      await ensureRepo(t.project);
      const results = await exclusive(t.project, async () => {
        const out: PushResult[] = [];
        for (const f of files) {
          try { out.push(await applyFile(t.project, t.user, f)); }
          catch (e) { out.push({ path: String(f?.path ?? ''), status: 'error', hash: null, error: (e as Error).message }); }
        }
        return out;
      });
      logAccess(t.project, t.user.id, 'git-push', 'sync');
      const changed = results.filter(x => x.status !== 'unchanged' && x.status !== 'error').length;
      if (changed) console.log(`[sync] ${t.user.username} → "${t.project}": ${results.map(x => `${x.path} ${x.status}`).join(', ')}`);
      res.json({ results, cursor: cursorOf(t.project) });
    } catch (e) { res.status(500).json({ error: (e as Error).message }); }
  });

  r.post('/commit', authFirst, express.json({ limit: '64kb' }), async (req, res) => {
    const t = target(req, res, 'edit');
    if (!t) return;
    const message = String(req.body?.message ?? '').trim().slice(0, 10_000);
    if (!message) { res.status(400).json({ error: 'message missing' }); return; }
    try {
      const committed = await commitProject(t.project, { message, by: t.user.id });
      res.json({ committed, ...(await headOf(t.project)) });
    } catch (e) { res.status(500).json({ error: (e as Error).message }); }
  });

  return r;
}
