/**
 * Publishing a document's PDF into a GitHub repository — the CV that a personal web page (GitHub
 * Pages, Hugo's `static/`) serves from a fixed address keeps that address: after every successful
 * build the new PDF is committed to `<owner>/<repo>` at `<path>` through the Contents API (one
 * HTTPS request, no clone). Nothing is committed when the file there is byte-identical.
 *
 * The token is the instance's `GITHUB_PUBLISH_TOKEN` (a fine-grained personal access token with
 * *Contents: read & write* on the target repository — nothing else), so only administrators may
 * set up targets: whoever configures one can write into every repository that token reaches.
 */
import fs from 'node:fs';
import crypto from 'node:crypto';
import { config } from './config.ts';
import { db } from './db.ts';
import { docPathOf } from '@overlyx/core';
import { lastBuild, onBuildFinished } from './export.ts';

export interface PublishRow { doc_id: string; repo: string; path: string; branch: string | null; created_by: number | null; created_at: number; last_pushed_at: number | null; last_sha: string | null; last_error: string | null; last_attempt_at: number | null }

export const publishAvailable = () => !!config.github.publishToken;

export function publishTargetFor(docId: string): PublishRow | undefined {
  return db.prepare('SELECT * FROM pdf_publish WHERE doc_id = ?').get(docId) as PublishRow | undefined;
}
export function publishTargetsOf(project: string): PublishRow[] {
  return db.prepare('SELECT * FROM pdf_publish WHERE substr(doc_id, 1, ?) = ? ORDER BY doc_id').all(project.length + 1, project + '/') as PublishRow[];
}

const REPO_RE = /^[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?\/[A-Za-z0-9._-]+$/;
/** `owner/repo`, a path inside it and an optional branch; throws when they are not usable */
export function normalizeTarget(t: { repo: string; path: string; branch?: string | null }): { repo: string; path: string; branch: string | null } {
  const repo = t.repo.trim().replace(/^https?:\/\/github\.com\//i, '').replace(/\.git$/i, '').replace(/\/+$/, '');
  if (!REPO_RE.test(repo)) throw new Error('the repository must be given as owner/name');
  const path = t.path.trim().replace(/\\/g, '/').replace(/^\/+/, '').replace(/\/+/g, '/');
  if (!path || path.endsWith('/') || path.split('/').some(s => s === '.' || s === '..' || s === '' || s.startsWith('.git'))) throw new Error('the path must name a file inside the repository (folders/name.pdf)');
  if (path.length > 300) throw new Error('the path is too long');
  const branch = (t.branch ?? '').trim();
  if (branch && !/^[^\s~^:?*[\\]{1,200}$/.test(branch)) throw new Error('not a branch name');
  return { repo, path, branch: branch || null };
}

export function setPublishTarget(docId: string, t: { repo: string; path: string; branch?: string | null }, userId: number | null): PublishRow {
  const n = normalizeTarget(t);
  db.prepare(`INSERT INTO pdf_publish (doc_id, repo, path, branch, created_by, created_at) VALUES (?,?,?,?,?,?)
              ON CONFLICT(doc_id) DO UPDATE SET repo=excluded.repo, path=excluded.path, branch=excluded.branch, last_sha=NULL, last_error=NULL`)
    .run(docId, n.repo, n.path, n.branch, userId, Date.now());
  return publishTargetFor(docId)!;
}
export function deletePublishTarget(docId: string): boolean {
  return db.prepare('DELETE FROM pdf_publish WHERE doc_id = ?').run(docId).changes > 0;
}

/** git's blob id of a file's content (what the Contents API reports as `sha`) */
export function blobSha(content: Buffer): string {
  return crypto.createHash('sha1').update(`blob ${content.length}\0`).update(content).digest('hex');
}

async function gh(method: string, path: string, body?: unknown): Promise<{ status: number; json: any }> {
  const r = await fetch(config.github.api + path, {
    method,
    headers: { Authorization: `Bearer ${config.github.publishToken}`, Accept: 'application/vnd.github+json', 'X-GitHub-Api-Version': '2022-11-28', 'User-Agent': 'overlyx', ...(body ? { 'Content-Type': 'application/json' } : {}) },
    body: body ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(60000),
  });
  let json: any = null;
  try { json = await r.json(); } catch { /* no body */ }
  return { status: r.status, json };
}

const inFlight = new Map<string, Promise<PublishRow | undefined>>();

/**
 * Commit the document's current PDF to its target (when there is one and the token is configured).
 * Returns the row afterwards; failures are recorded in `last_error`, never thrown.
 */
export function publishPdf(docId: string, reason = 'built'): Promise<PublishRow | undefined> {
  const running = inFlight.get(docId);
  if (running) return running;
  const p = (async () => {
    const t = publishTargetFor(docId);
    if (!t) return undefined;
    const fail = (msg: string) => { db.prepare('UPDATE pdf_publish SET last_error = ?, last_attempt_at = ? WHERE doc_id = ?').run(msg.slice(0, 500), Date.now(), docId); console.warn(`[publish] ${docId} → ${t.repo}:${t.path}: ${msg}`); return publishTargetFor(docId); };
    if (!publishAvailable()) return fail('GITHUB_PUBLISH_TOKEN is not configured on this server');
    const b = lastBuild(docId);
    if (!b?.pdf_path || !fs.existsSync(b.pdf_path)) return fail('no PDF built yet');
    let content: Buffer;
    try { content = fs.readFileSync(b.pdf_path); } catch (e) { return fail(String(e)); }
    const sha = blobSha(content);
    if (t.last_sha === sha) { db.prepare('UPDATE pdf_publish SET last_error = NULL, last_attempt_at = ? WHERE doc_id = ?').run(Date.now(), docId); return publishTargetFor(docId); }
    const file = `/repos/${t.repo}/contents/${t.path.split('/').map(encodeURIComponent).join('/')}`;
    const ref = t.branch ? `?ref=${encodeURIComponent(t.branch)}` : '';
    try {
      const cur = await gh('GET', file + ref);
      let existing: string | undefined;
      if (cur.status === 200 && cur.json?.sha) existing = String(cur.json.sha);
      else if (cur.status === 401 || cur.status === 403) return fail(`GitHub refused the token for ${t.repo} (${cur.status}${cur.json?.message ? `: ${cur.json.message}` : ''}) — it needs Contents: read & write on that repository`);
      else if (cur.status !== 404) return fail(`GitHub: ${cur.status}${cur.json?.message ? ` ${cur.json.message}` : ''}`);
      if (existing === sha) { db.prepare('UPDATE pdf_publish SET last_sha = ?, last_error = NULL, last_attempt_at = ? WHERE doc_id = ?').run(sha, Date.now(), docId); return publishTargetFor(docId); }
      const name = docPathOf(docId);
      const put = await gh('PUT', file, {
        message: `${existing ? 'Update' : 'Add'} ${t.path.split('/').pop()} (${name} ${reason} on OverLyX)`,
        content: content.toString('base64'),
        ...(existing ? { sha: existing } : {}),
        ...(t.branch ? { branch: t.branch } : {}),
      });
      if (put.status !== 200 && put.status !== 201) return fail(`GitHub would not take the file: ${put.status}${put.json?.message ? ` ${put.json.message}` : ''}`);
      db.prepare('UPDATE pdf_publish SET last_sha = ?, last_pushed_at = ?, last_attempt_at = ?, last_error = NULL WHERE doc_id = ?').run(sha, Date.now(), Date.now(), docId);
      console.log(`[publish] ${docId} → ${t.repo}${t.branch ? '@' + t.branch : ''}:${t.path} (${content.length} bytes)`);
      return publishTargetFor(docId);
    } catch (e) { return fail(`GitHub could not be reached: ${(e as Error).message}`); }
  })().finally(() => inFlight.delete(docId));
  inFlight.set(docId, p);
  return p;
}

/** Every successful build of a document with a target publishes it (a build with errors keeps the last good PDF online). */
export function startPublishing(): void {
  onBuildFinished((docId, r) => { if (r.ok && r.pdfPath && publishTargetFor(docId)) void publishPdf(docId); });
}
