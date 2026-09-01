/**
 * Every project is a git repository that can be cloned, pulled and pushed from a local machine:
 *
 *  - the project directory *is* the working tree (`git init` in place, a `.gitignore` for build
 *    products and LyX backups, an initial commit) — desktop LyX, OverLyX and git all work on the
 *    same files;
 *  - OverLyX **commits its own writes** automatically: a couple of minutes after the last change
 *    (`OVERLYX_GIT_COMMIT_MS`), and always right before a clone / fetch / push is served, so the
 *    remote is never behind what the editor shows. Commits are attributed to the people who edited;
 *  - the repository is served over **smart HTTP** at `/git/<project>.git` by `git http-backend`,
 *    with HTTP Basic authentication (username + OverLyX password, or a personal *access token* —
 *    Google accounts have no password) and the project's roles: viewers may fetch, editors and the
 *    owner may push;
 *  - a **push updates the working tree** (`receive.denyCurrentBranch = updateInstead` with a
 *    `push-to-checkout` hook that keeps uncommitted changes in files the push does not touch); the
 *    file watcher then merges the new content into the open documents like any external save.
 */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { execFile, spawn } from 'node:child_process';
import { promisify } from 'node:util';
import express, { type Request, type Response } from 'express';
import { config } from './config.ts';
import { db, type UserRow } from './db.ts';
import { projectDir, listProjects } from './projects.ts';
import { manager, fileWrittenListeners } from './docs.ts';
import { verifyPassword, toSessionUser, type SessionUser } from './auth.ts';
import { roleFor, atLeast, logAccess } from './access.ts';

const execFileP = promisify(execFile);

const PROJECT_NAME = /^[A-Za-z0-9._ -]+$/;

/** Files git should never track in a LyX project: LaTeX build products, LyX backups, our temp files. */
export const DEFAULT_GITIGNORE = `# OverLyX: LaTeX build products
*.aux
*.bbl
*.blg
*.log
*.out
*.toc
*.lof
*.lot
*.loa
*.lol
*.nav
*.snm
*.vrb
*.fls
*.fdb_latexmk
*.synctex.gz
*.synctex(busy)
*.run.xml
*.bcf
*.xdv
*.dvi
*-blx.bib
*.spl
*.idx
*.ind
*.ilg
*.glo
*.gls
*.glg
_build/
svg-inkscape/
# LyX backups, autosaves and emergency files
*.lyx~
*~
\\#*\\#
*.emergency
*.autosave
*.lyx#
# OverLyX
*.overlyx-tmp
.DS_Store
`;

/** Installed as .git/hooks/push-to-checkout: a push to the checked-out branch updates the working tree. */
const PUSH_TO_CHECKOUT_HOOK = `#!/bin/sh
# Installed by OverLyX. A push to the checked-out branch updates the working tree and index
# (receive.denyCurrentBranch = updateInstead); unlike git's default, uncommitted changes in files
# the push does not touch are kept (OverLyX commits them a moment later). See githooks(5).
git update-index -q --refresh
exec git read-tree -u -m HEAD "$1"
`;

function gitHome(): string {
  const home = path.join(config.dataDir, 'git-home');
  fs.mkdirSync(home, { recursive: true });
  return home;
}

/**
 * Environment for every git we run: the projects may belong to another user (rsynced from a
 * laptop) — `safe.directory=*` — and nothing from the server account's own git configuration
 * (credential helpers, identities, hooks) must leak in.
 */
export function gitEnv(extra: Record<string, string> = {}): NodeJS.ProcessEnv {
  return {
    PATH: process.env.PATH ?? '/usr/local/bin:/usr/bin:/bin',
    HOME: gitHome(),
    LANG: 'C.UTF-8', LC_ALL: 'C.UTF-8',
    GIT_TERMINAL_PROMPT: '0',
    GIT_CONFIG_COUNT: '1',
    GIT_CONFIG_KEY_0: 'safe.directory', GIT_CONFIG_VALUE_0: '*',
    ...extra,
  };
}

export async function git(project: string, args: string[], opts: { env?: Record<string, string>; maxBuffer?: number } = {}): Promise<string> {
  const { stdout } = await execFileP('git', ['-C', projectDir(project), ...args], { env: gitEnv(opts.env), maxBuffer: opts.maxBuffer ?? 16 * 1024 * 1024 });
  return stdout;
}

export function hasRepo(project: string): boolean {
  try { return fs.existsSync(path.join(projectDir(project), '.git')); } catch { return false; }
}

/* ------------------------------------------------------------ per-project lock */

const locks = new Map<string, Promise<unknown>>();

/** Run `fn` when no other git operation on `project` is running (commits and pushes must not interleave). */
export async function withRepoLock<T>(project: string, fn: () => Promise<T>): Promise<T> {
  const prev = locks.get(project) ?? Promise.resolve();
  const run = prev.catch(() => {}).then(fn);
  locks.set(project, run);
  try { return await run; }
  finally { if (locks.get(project) === run) locks.delete(project); }
}

/* --------------------------------------------------------------- repositories */

/** projects whose repository configuration was checked in this process */
const prepared = new Set<string>();

function hostName(): string {
  try { return config.publicUrl ? new URL(config.publicUrl).host : 'overlyx.local'; } catch { return 'overlyx.local'; }
}

/** Identity OverLyX commits with (as committer; the author is the person who edited when known). */
export function serverIdentity(): { name: string; email: string } {
  return { name: 'OverLyX', email: `overlyx@${hostName()}` };
}

/**
 * Make sure the project directory is a git repository configured for us: created (with a
 * `.gitignore` and an initial commit) if it is none yet; an existing repository is left alone
 * apart from the two settings a push into a checked-out branch needs.
 */
export async function ensureRepo(project: string): Promise<void> {
  if (!config.git) return;
  if (!PROJECT_NAME.test(project)) throw new Error('bad project name');
  const dir = projectDir(project);
  if (!fs.existsSync(dir)) throw new Error('project not found');
  // prepared in this process — unless the project was deleted and created again under the same name meanwhile
  if (prepared.has(project)) { if (fs.existsSync(path.join(dir, '.git'))) return; prepared.delete(project); }
  await withRepoLock(project, async () => {
    if (prepared.has(project)) return;
    const fresh = !fs.existsSync(path.join(dir, '.git'));
    if (fresh) {
      await git(project, ['init', '-q', '-b', 'main']);
      const ignore = path.join(dir, '.gitignore');
      if (!fs.existsSync(ignore)) fs.writeFileSync(ignore, DEFAULT_GITIGNORE, 'utf8');
    }
    // a push into the checked-out branch updates the working tree; symlinks are checked out as
    // plain files (a pushed link must not point our file routes outside the project)
    await git(project, ['config', 'receive.denyCurrentBranch', 'updateInstead']);
    await git(project, ['config', 'core.symlinks', 'false']);
    await git(project, ['config', 'core.quotepath', 'false']);
    const hooks = path.join(dir, '.git', 'hooks');
    fs.mkdirSync(hooks, { recursive: true });
    const hook = path.join(hooks, 'push-to-checkout');
    if (!fs.existsSync(hook)) fs.writeFileSync(hook, PUSH_TO_CHECKOUT_HOOK, { mode: 0o755 });
    prepared.add(project);
    if (fresh) {
      const n = await commitLocked(project, { message: `Import "${project}" into OverLyX` });
      console.log(`[git] initialised repository for "${project}"${n ? ' (initial commit)' : ''}`);
    }
  });
}

/** Initialise the repositories of all projects that have none yet (startup, new directories). */
export async function ensureAllRepos(): Promise<void> {
  if (!config.git) return;
  for (const p of listProjects()) {
    if (prepared.has(p.name)) continue;
    try { await ensureRepo(p.name); } catch (e) { console.error(`[git] cannot initialise "${p.name}":`, e); }
  }
}

/* -------------------------------------------------------------------- commits */

interface Pending { editors: Set<number>; timer: NodeJS.Timeout | null; since: number }
const pending = new Map<string, Pending>();

function editorsOf(ids: Iterable<number>): { name: string; email: string; username: string }[] {
  const out: { name: string; email: string; username: string }[] = [];
  for (const id of ids) {
    const u = db.prepare('SELECT username, display_name, email FROM users WHERE id = ?').get(id) as { username: string; display_name: string; email: string | null } | undefined;
    if (u) out.push({ name: u.display_name, username: u.username, email: u.email ?? `${u.username}@${hostName()}` });
  }
  return out;
}

/** Commit everything that changed in the working tree. Returns true when a commit was made. */
async function commitLocked(project: string, opts: { message?: string; editors?: Iterable<number> } = {}): Promise<boolean> {
  if (!hasRepo(project)) return false;
  await git(project, ['add', '-A', '--', '.']);
  const changed = (await git(project, ['diff', '--cached', '--name-only', '-z'])).split('\0').filter(Boolean);
  if (!changed.length) return false;
  const people = editorsOf(opts.editors ?? []);
  const self = serverIdentity();
  const author = people[0] ?? self;
  let message = opts.message;
  if (!message) {
    const names = changed.slice(0, 3).map(f => path.basename(f));
    message = `Update ${names.join(', ')}${changed.length > 3 ? ` and ${changed.length - 3} more` : ''}`;
    message += '\n\n' + (people.length ? `Edited in OverLyX by ${people.map(p => p.name).join(', ')}` : 'Written by OverLyX') + `\n\nFiles:\n${changed.map(f => '  ' + f).join('\n')}\n`;
  }
  await git(project, ['commit', '-q', '--no-verify', '-m', message, '--author', `${author.name} <${author.email}>`], {
    env: { GIT_COMMITTER_NAME: self.name, GIT_COMMITTER_EMAIL: self.email },
  });
  return true;
}

/** The people who edited since the last commit; the pending timer is dropped. */
function takeEditors(project: string, extra?: number | null): Set<number> {
  const p = pending.get(project);
  const editors = new Set<number>(p?.editors ?? []);
  if (extra != null) editors.add(extra);
  if (p) { if (p.timer) clearTimeout(p.timer); pending.delete(project); }
  return editors;
}

/** A commit failed: keep its editors for the next attempt. */
function keepEditors(project: string, editors: Set<number>): void {
  const again = pending.get(project) ?? { editors: new Set<number>(), timer: null, since: Date.now() };
  for (const id of editors) again.editors.add(id);
  pending.set(project, again);
}

/** Commit the project's pending changes now (after writing what the editors hold). */
export async function commitProject(project: string, opts: { message?: string; by?: number } = {}): Promise<boolean> {
  if (!config.git) return false;
  await ensureRepo(project);
  await manager.saveProject(project);
  return withRepoLock(project, async () => {
    const editors = takeEditors(project, opts.by);
    try { return await commitLocked(project, { message: opts.message, editors }); }
    catch (e) { keepEditors(project, editors); throw e; }
  });
}

/**
 * Something changed in the project (a document was written, a file uploaded, a text file saved):
 * commit a while after the last change — with a maximum wait, so that continuous editing still
 * produces commits.
 */
export function touchProject(project: string, userIds?: number[] | number | null): void {
  if (!config.git) return;
  let p = pending.get(project);
  if (!p) { p = { editors: new Set(), timer: null, since: Date.now() }; pending.set(project, p); }
  for (const id of userIds == null ? [] : Array.isArray(userIds) ? userIds : [userIds]) p.editors.add(id);
  if (p.timer) clearTimeout(p.timer);
  const delay = Math.max(1000, Math.min(config.gitCommitMs, p.since + config.gitCommitMaxWaitMs - Date.now()));
  p.timer = setTimeout(() => { p!.timer = null; commitProject(project).catch(e => console.error(`[git] auto-commit of "${project}" failed:`, e)); }, delay);
}

/** Commit every project with pending changes (shutdown). */
export async function flushCommits(): Promise<void> {
  for (const project of [...pending.keys()]) {
    try { await commitProject(project); } catch (e) { console.error(`[git] commit of "${project}" failed:`, e); }
  }
}

if (config.git) {
  fileWrittenListeners.add((project, userIds) => touchProject(project, userIds));
}

/* ----------------------------------------------------------------------- info */

export interface CommitInfo { hash: string; author: string; date: number; message: string }
export interface RepoInfo { branch: string; commits: CommitInfo[]; pending: number; pendingFiles: string[]; head: string | null }

export async function repoInfo(project: string, limit = 12): Promise<RepoInfo> {
  await ensureRepo(project);
  await manager.saveProject(project);
  const branch = (await git(project, ['rev-parse', '--abbrev-ref', 'HEAD']).catch(() => 'main')).trim();
  const log = await git(project, ['log', `-n${limit}`, '--format=%H%x1f%an%x1f%at%x1f%s']).catch(() => '');
  const commits: CommitInfo[] = log.split('\n').filter(Boolean).map(l => {
    const [hash, author, at, message] = l.split('\x1f');
    return { hash, author, date: Number(at) * 1000, message };
  });
  const status = (await git(project, ['status', '--porcelain', '-z', '--untracked-files=all'])).split('\0').filter(Boolean);
  const pendingFiles = status.map(l => l.slice(3));
  return { branch, commits, pending: pendingFiles.length, pendingFiles: pendingFiles.slice(0, 50), head: commits[0]?.hash ?? null };
}

/** The clone URL of a project as seen from outside. */
export function cloneUrl(req: Request, project: string): string {
  const base = (config.publicUrl || `${req.protocol}://${req.get('host')}`).replace(/\/$/, '');
  return `${base}/git/${encodeURIComponent(project)}.git`;
}

/* --------------------------------------------------------------------- tokens */

export interface TokenRow { id: number; user_id: number; name: string; token_hash: string; token_plain: string | null; created_at: number; last_used_at: number | null }

function hashToken(token: string): string { return crypto.createHash('sha256').update(token).digest('hex'); }

/** A new personal access token for git (shown once — unless `storePlain` keeps the plaintext for later re-copy, see userSettings.ts). */
export function createToken(userId: number, name: string, storePlain = false): { id: number; token: string } {
  const token = 'olx_' + crypto.randomBytes(24).toString('base64url');
  const info = db.prepare('INSERT INTO git_tokens (user_id, name, token_hash, token_plain, created_at) VALUES (?,?,?,?,?)').run(userId, name.trim().slice(0, 60) || 'token', hashToken(token), storePlain ? token : null, Date.now());
  return { id: Number(info.lastInsertRowid), token };
}

/** The user's tokens; with `includeSecrets`, rows whose plaintext was kept carry `token`. */
export function listTokens(userId: number, includeSecrets = false): { id: number; name: string; created_at: number; last_used_at: number | null; token?: string }[] {
  const rows = db.prepare('SELECT id, name, created_at, last_used_at, token_plain FROM git_tokens WHERE user_id = ? ORDER BY created_at DESC').all(userId) as { id: number; name: string; created_at: number; last_used_at: number | null; token_plain: string | null }[];
  return rows.map(({ token_plain, ...r }) => (includeSecrets && token_plain ? { ...r, token: token_plain } : r));
}

export function deleteToken(userId: number, id: number): boolean {
  return db.prepare('DELETE FROM git_tokens WHERE id = ? AND user_id = ?').run(id, userId).changes > 0;
}

/**
 * The account behind HTTP Basic credentials: `secret` is an access token of that user or their
 * OverLyX password. Tokens first (a cheap hash), the password (scrypt) only when no token matched.
 */
export function userForCredentials(username: string, secret: string): SessionUser | null {
  const row = db.prepare('SELECT * FROM users WHERE username = ?').get(username.trim().toLowerCase()) as UserRow | undefined;
  if (!row || !secret) return null;
  const t = db.prepare('SELECT * FROM git_tokens WHERE token_hash = ? AND user_id = ?').get(hashToken(secret), row.id) as TokenRow | undefined;
  if (t) {
    if (!t.last_used_at || Date.now() - t.last_used_at > 60_000) db.prepare('UPDATE git_tokens SET last_used_at = ? WHERE id = ?').run(Date.now(), t.id);
    return toSessionUser(row);
  }
  if (secret.startsWith('olx_')) return null;   // a token that does not exist (any more): never try it as a password
  return verifyPassword(secret, row.password_hash) ? toSessionUser(row) : null;
}

/* ------------------------------------------------------------------ smart HTTP */

const failures = new Map<string, { n: number; until: number }>();

function basicCredentials(req: Request): { username: string; secret: string } | null {
  const h = req.headers.authorization ?? '';
  const m = /^Basic\s+([A-Za-z0-9+/=]+)$/i.exec(h);
  if (!m) return null;
  const dec = Buffer.from(m[1], 'base64').toString('utf8');
  const i = dec.indexOf(':');
  if (i < 0) return null;
  return { username: dec.slice(0, i), secret: dec.slice(i + 1) };
}

function unauthorized(res: Response, msg = 'Authentication required: your OverLyX username and an access token (File ▸ Git repository…) or your password'): void {
  res.setHeader('WWW-Authenticate', 'Basic realm="OverLyX", charset="UTF-8"');
  res.status(401).type('text').send(msg + '\n');
}

const SERVICES = new Set(['git-upload-pack', 'git-receive-pack']);

/**
 * `/git/<project>.git/...` — the smart HTTP protocol served by `git http-backend` (a CGI program:
 * environment in, headers + body out). Only the smart endpoints are exposed (`info/refs?service=`,
 * `git-upload-pack`, `git-receive-pack`); the dumb protocol (`objects/…`) is not.
 */
export function gitRouter(): express.Router {
  const r = express.Router();
  r.all(/.*/, (req, res) => { void handle(req, res); });
  return r;
}

async function handle(req: Request, res: Response): Promise<void> {
  if (!config.git) { res.status(404).type('text').send('git access is disabled on this server\n'); return; }
  const m = /^\/([^/]+?)(?:\.git)?\/(info\/refs|git-upload-pack|git-receive-pack)$/.exec(req.path);
  if (!m) { res.status(404).type('text').send('not found — clone with: git clone <server>/git/<project>.git\n'); return; }
  let project: string;
  try { project = decodeURIComponent(m[1]); } catch { res.status(400).end(); return; }
  const endpoint = m[2];
  const service = endpoint === 'info/refs' ? String(req.query.service ?? '') : endpoint;
  if (!SERVICES.has(service)) { res.status(403).type('text').send('only the smart HTTP protocol is supported (git >= 1.6.6)\n'); return; }
  if (endpoint !== 'info/refs' && req.method !== 'POST') { res.status(405).end(); return; }
  if (endpoint === 'info/refs' && req.method !== 'GET') { res.status(405).end(); return; }

  // --- who
  const ip = req.ip ?? 'x';
  const f = failures.get(ip);
  if (f && f.n >= 10 && Date.now() < f.until) { res.status(429).type('text').send('too many failed attempts, try again later\n'); return; }
  const creds = basicCredentials(req);
  if (!creds) { unauthorized(res); return; }
  const user = userForCredentials(creds.username, creds.secret);
  if (!user) {
    const cur = failures.get(ip) ?? { n: 0, until: 0 };
    cur.n++; cur.until = Date.now() + 10 * 60 * 1000; failures.set(ip, cur);
    if (failures.size > 5000) { const now = Date.now(); for (const [k, v] of failures) if (v.until < now) failures.delete(k); }
    unauthorized(res, 'Invalid username or token/password');
    return;
  }
  failures.delete(ip);

  // --- what they may do
  if (!PROJECT_NAME.test(project) || !fs.existsSync(projectDir(project))) { res.status(404).type('text').send(`no project "${project}"\n`); return; }
  const write = service === 'git-receive-pack';
  const role = roleFor(user, project);
  if (!atLeast(role, write ? 'edit' : 'view')) {
    res.status(403).type('text').send(role ? `You can only view "${project}" — pushing needs editor access\n` : `You do not have access to "${project}"\n`);
    return;
  }
  // the owner's activity log: one entry per person and direction (info/refs precedes every fetch and push)
  if (endpoint !== 'info/refs') logAccess(project, user.id, write ? 'git-push' : 'git-fetch');

  // --- the repository, up to date with the editors
  try {
    await ensureRepo(project);
    await manager.saveProject(project);
  } catch (e) { res.status(500).type('text').send(String(e) + '\n'); return; }

  const serve = () => new Promise<void>(resolve => {
    const env = gitEnv({
      GIT_PROJECT_ROOT: config.projectsDir,
      GIT_HTTP_EXPORT_ALL: '1',
      PATH_INFO: `/${project}/${endpoint}`,
      REQUEST_METHOD: req.method,
      QUERY_STRING: req.originalUrl.includes('?') ? req.originalUrl.slice(req.originalUrl.indexOf('?') + 1) : '',
      CONTENT_TYPE: req.headers['content-type'] ?? '',
      REMOTE_USER: user.username,
      REMOTE_ADDR: ip,
      GIT_COMMITTER_NAME: user.name,
      GIT_COMMITTER_EMAIL: user.email ?? `${user.username}@${hostName()}`,
    });
    if (req.headers['content-length']) env.CONTENT_LENGTH = String(req.headers['content-length']);
    if (req.headers['content-encoding']) env.HTTP_CONTENT_ENCODING = String(req.headers['content-encoding']);
    const child = spawn('git', ['http-backend'], { env, stdio: ['pipe', 'pipe', 'pipe'] });
    let stderr = '';
    child.stderr.on('data', d => { stderr += String(d); });
    child.on('error', e => { console.error('[git] http-backend failed to start:', e); if (!res.headersSent) res.status(500).end(); resolve(); });
    // CGI output: header lines, an empty line, the body
    let head = Buffer.alloc(0);
    let headerDone = false;
    child.stdout.on('data', (chunk: Buffer) => {
      if (headerDone) { res.write(chunk); return; }
      head = Buffer.concat([head, chunk]);
      const end = head.indexOf('\r\n\r\n');
      if (end < 0) return;
      headerDone = true;
      let status = 200;
      for (const line of head.subarray(0, end).toString('utf8').split('\r\n')) {
        const i = line.indexOf(':');
        if (i < 0) continue;
        const name = line.slice(0, i).trim(), value = line.slice(i + 1).trim();
        if (name.toLowerCase() === 'status') status = Number(value.split(' ')[0]) || 200;
        else res.setHeader(name, value);
      }
      res.status(status);
      const rest = head.subarray(end + 4);
      if (rest.length) res.write(rest);
    });
    child.stdout.on('end', () => {
      if (!headerDone) { if (!res.headersSent) res.status(500); res.write(head); }
      res.end();
    });
    child.on('close', code => {
      if (code) console.error(`[git] http-backend exited with ${code} for ${user.username} ${service} ${project}: ${stderr.trim()}`);
      else if (write && endpoint === 'git-receive-pack') console.log(`[git] ${user.username} pushed to "${project}"`);
      if (stderr && !code && /error|fatal|rejected/i.test(stderr)) console.warn(`[git] ${service} ${project}: ${stderr.trim()}`);
      resolve();
    });
    req.on('aborted', () => { try { child.kill(); } catch { /* ignore */ } });
    req.pipe(child.stdin);
  });

  if (write) {
    // a push and a commit must not interleave: commit what is pending, then let receive-pack update the tree
    await withRepoLock(project, async () => {
      const editors = takeEditors(project);
      try { await commitLocked(project, { editors }); } catch (e) { keepEditors(project, editors); console.error('[git] commit before push failed:', e); }
      await serve();
    });
  } else {
    // a fetch only reads: commit pending changes first (locked), then serve outside the lock
    try { await commitProject(project); } catch (e) { console.error('[git] commit before fetch failed:', e); }
    await serve();
  }
}
