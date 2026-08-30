/**
 * Off-site mirror of the project repositories in a GitHub organisation.
 *
 *  - every project (its git repository, see git.ts) is pushed to a **private** repository
 *    `<org>/<project>` of the organisation `GITHUB_MIRROR_ORG`; the repository is created through
 *    the GitHub API the first time (a fine-grained token with Contents + Administration: write);
 *  - a sweeper runs every `OVERLYX_MIRROR_INTERVAL_MS` (5 min): each project whose HEAD moved since
 *    the last push (pending edits are committed first) is pushed with `--force --all` — the server
 *    is the only writer, GitHub only receives, so nothing ever needs merging;
 *  - the token never touches `.git/config` or the command line: it is handed to git through a
 *    credential helper reading it from the environment of that one git process;
 *  - a deleted project's repository is *archived* on GitHub, never deleted;
 *  - `OVERLYX_MIRROR_URL=file:///…/{repo}.git` replaces GitHub by bare repositories on disk (tests).
 *
 * Status per project is kept in the `mirrors` table and shown in the Git dialog.
 */
import fs from 'node:fs';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { config } from './config.ts';
import { db } from './db.ts';
import { listProjects } from './projects.ts';
import { projectRow } from './access.ts';
import { git, gitEnv, ensureRepo, commitProject, withRepoLock, hasRepo } from './git.ts';

const execFileP = promisify(execFile);

export interface MirrorRow { project: string; repo: string; enabled: number; last_head: string | null; last_push_at: number | null; last_error: string | null; last_attempt_at: number | null }
export interface MirrorStatus {
  /** the server has a mirror target (organisation + token, or the test hook) */
  configured: boolean;
  org: string | null; repo: string | null;
  /** the repository on GitHub (null with the test hook) */
  url: string | null;
  enabled: boolean;
  head: string | null; lastHead: string | null; lastPushAt: number | null; lastAttemptAt: number | null; lastError: string | null;
  /** HEAD differs from what was pushed last (or the last push failed) */
  behind: boolean;
  intervalMs: number;
}

export function mirrorConfigured(): boolean {
  return config.git && (!!config.mirror.urlTemplate || (!!config.mirror.org && !!config.mirror.token));
}

/** GitHub repository names: letters, digits, '.', '-' and '_' (a project name may contain spaces). */
export function repoNameFor(project: string): string {
  const n = project.replace(/[^A-Za-z0-9._-]+/g, '-').replace(/^[.-]+|[.-]+$/g, '') || 'project';
  return /\.git$/i.test(n) ? n.slice(0, -4) + '-git' : n;
}

function remoteUrl(repo: string): string {
  if (config.mirror.urlTemplate) return config.mirror.urlTemplate.replace('{repo}', repo);
  return `https://github.com/${config.mirror.org}/${repo}.git`;
}

export function mirrorRow(project: string): MirrorRow | undefined {
  return db.prepare('SELECT * FROM mirrors WHERE project = ?').get(project) as MirrorRow | undefined;
}
function ensureRow(project: string): MirrorRow {
  db.prepare('INSERT OR IGNORE INTO mirrors (project, repo, enabled) VALUES (?, ?, 1)').run(project, repoNameFor(project));
  return mirrorRow(project)!;
}

export function setMirrorEnabled(project: string, enabled: boolean): void {
  ensureRow(project);
  db.prepare('UPDATE mirrors SET enabled = ? WHERE project = ?').run(enabled ? 1 : 0, project);
}

/* ------------------------------------------------------------------ GitHub */

async function gh(method: string, pathname: string, body?: unknown): Promise<{ status: number; json: any }> {
  const res = await fetch(config.github.api + pathname, {
    method,
    headers: {
      Authorization: `Bearer ${config.mirror.token}`, Accept: 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28', 'User-Agent': 'OverLyX', ...(body ? { 'Content-Type': 'application/json' } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(30000),
  });
  let json: any = null;
  try { json = await res.json(); } catch { /* no body */ }
  return { status: res.status, json };
}

/** repositories verified (or created) in this process */
const known = new Set<string>();

async function ensureRemoteRepo(repo: string, project: string): Promise<void> {
  if (known.has(repo)) return;
  if (config.mirror.urlTemplate) {
    const url = remoteUrl(repo);
    if (url.startsWith('file://')) {
      const dir = url.slice('file://'.length);
      if (!fs.existsSync(dir)) {
        fs.mkdirSync(path.dirname(dir), { recursive: true });
        await execFileP('git', ['init', '-q', '--bare', '-b', 'main', dir], { env: gitEnv() });
      }
    }
    known.add(repo);
    return;
  }
  const org = config.mirror.org;
  const r = await gh('GET', `/repos/${org}/${repo}`);
  if (r.status === 200) {
    // a project deleted earlier and created again: its archived mirror is reopened
    if (r.json?.archived) {
      const u = await gh('PATCH', `/repos/${org}/${repo}`, { archived: false });
      if (u.status !== 200) throw new Error(`GitHub: cannot unarchive ${org}/${repo}: ${u.status} ${u.json?.message ?? ''}`);
    }
    known.add(repo);
    return;
  }
  if (r.status !== 404) throw new Error(`GitHub: ${r.status} ${r.json?.message ?? 'cannot read the repository'}`);
  const c = await gh('POST', `/orgs/${org}/repos`, {
    name: repo, private: true, description: `OverLyX mirror of "${project}"`,
    has_issues: false, has_projects: false, has_wiki: false, auto_init: false,
  });
  if (c.status !== 201) throw new Error(`GitHub: cannot create ${org}/${repo}: ${c.status} ${c.json?.message ?? ''}`);
  console.log(`[mirror] created ${org}/${repo}`);
  known.add(repo);
}

/** Archive the mirror of a deleted project (best effort; nothing is ever deleted on GitHub). */
export async function archiveMirror(project: string): Promise<void> {
  const row = mirrorRow(project);
  db.prepare('DELETE FROM mirrors WHERE project = ?').run(project);
  if (!row || !mirrorConfigured() || config.mirror.urlTemplate) return;
  known.delete(row.repo);
  try {
    const r = await gh('PATCH', `/repos/${config.mirror.org}/${row.repo}`, { archived: true });
    if (r.status === 200) console.log(`[mirror] archived ${config.mirror.org}/${row.repo}`);
    else if (r.status !== 404) console.error(`[mirror] cannot archive ${row.repo}: ${r.status} ${r.json?.message ?? ''}`);
  } catch (e) { console.error(`[mirror] cannot archive ${row.repo}:`, e); }
}

/* -------------------------------------------------------------------- push */

/** git options that hand the token to git without putting it into a file or the command line */
const CREDENTIALS = ['-c', 'credential.helper=', '-c', 'credential.helper=!f() { echo username=x-access-token; echo "password=$OVERLYX_MIRROR_TOKEN"; }; f'];

/** Push the project to its mirror when its HEAD moved since the last push (or the last push failed). */
export async function pushProject(project: string, opts: { force?: boolean } = {}): Promise<MirrorStatus> {
  if (!mirrorConfigured()) return statusOf(project);
  const row = ensureRow(project);
  if (!row.enabled && !opts.force) return statusOf(project);
  await commitProject(project);                    // pending edits become a commit first
  const head = (await git(project, ['rev-parse', 'HEAD']).catch(() => '')).trim();
  if (!head) return statusOf(project);
  if (head === row.last_head && !row.last_error && !opts.force) return statusOf(project);
  try {
    await ensureRemoteRepo(row.repo, project);
    await withRepoLock(project, async () => {
      const url = remoteUrl(row.repo);
      const remotes = (await git(project, ['remote'])).split('\n').map(s => s.trim());
      await git(project, remotes.includes('mirror') ? ['remote', 'set-url', 'mirror', url] : ['remote', 'add', 'mirror', url]);
      const env = { OVERLYX_MIRROR_TOKEN: config.mirror.token };
      await git(project, [...CREDENTIALS, 'push', '--quiet', '--force', '--all', 'mirror'], { env });
      await git(project, [...CREDENTIALS, 'push', '--quiet', '--force', '--tags', 'mirror'], { env });
    });
    db.prepare('UPDATE mirrors SET last_head = ?, last_push_at = ?, last_attempt_at = ?, last_error = NULL WHERE project = ?').run(head, Date.now(), Date.now(), project);
    console.log(`[mirror] pushed "${project}" → ${row.repo} (${head.slice(0, 7)})`);
  } catch (e) {
    const msg = String((e as Error).message ?? e).replace(/x-access-token:[^@\s]*@/g, '').slice(0, 500);
    db.prepare('UPDATE mirrors SET last_attempt_at = ?, last_error = ? WHERE project = ?').run(Date.now(), msg, project);
    console.error(`[mirror] push of "${project}" failed: ${msg}`);
  }
  return statusOf(project);
}

export async function statusOf(project: string): Promise<MirrorStatus> {
  const configured = mirrorConfigured();
  const row = configured ? ensureRow(project) : mirrorRow(project);
  const head = hasRepo(project) ? (await git(project, ['rev-parse', 'HEAD']).catch(() => '')).trim() || null : null;
  return {
    configured, org: config.mirror.org || null, repo: row?.repo ?? null,
    url: row && configured && !config.mirror.urlTemplate ? `https://github.com/${config.mirror.org}/${row.repo}` : null,
    enabled: row ? !!row.enabled : false,
    head, lastHead: row?.last_head ?? null, lastPushAt: row?.last_push_at ?? null, lastAttemptAt: row?.last_attempt_at ?? null, lastError: row?.last_error ?? null,
    behind: !!head && (head !== (row?.last_head ?? null) || !!row?.last_error),
    intervalMs: config.mirror.intervalMs,
  };
}

/* ----------------------------------------------------------------- sweeper */

let sweeping = false;

/** Push every project that moved (personal example projects are not mirrored). */
export async function mirrorAll(): Promise<void> {
  if (!mirrorConfigured() || sweeping) return;
  sweeping = true;
  try {
    for (const p of listProjects()) {
      const kind = projectRow(p.name)?.kind ?? 'project';
      if (kind !== 'project') continue;
      try { await ensureRepo(p.name); await pushProject(p.name); }
      catch (e) { console.error(`[mirror] "${p.name}":`, e); }
    }
  } finally { sweeping = false; }
}

export function startMirrorSweeper(): void {
  if (!mirrorConfigured()) return;
  console.log(`[mirror] mirroring projects to ${config.mirror.urlTemplate || `github.com/${config.mirror.org}`} every ${Math.round(config.mirror.intervalMs / 1000)} s`);
  setTimeout(() => void mirrorAll(), 30 * 1000).unref();
  setInterval(() => void mirrorAll(), Math.max(30 * 1000, config.mirror.intervalMs)).unref();
}
