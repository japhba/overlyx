/**
 * The History pane's server side (client app/history/): what the per-document version store
 * (`versions`, docs.ts) offers beyond listing, reading and restoring a whole version —
 *
 *  - naming a version ("Name this version": an automatic one becomes a named one, which the
 *    pruning of automatic versions leaves alone);
 *  - restoring one part of a text (a hunk of the comparison) as an ordinary edit of the live
 *    document — a splice of a deck's Y.Text, a LaTeX/markdown source loaded as a diff — that
 *    collaborators see at once; refused when that passage changed meanwhile;
 *  - the project's recent versions across its files, also of files deleted since (their versions
 *    stay in the store, keyed by the document's id, until the project is deleted);
 *  - the project's git history (git.ts) with the files each commit changed, a file as a commit had
 *    it, and a file a commit deleted brought back.
 */
import fs from 'node:fs';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { config } from './config.ts';
import { git, gitEnv, hasRepo, touchProject } from './git.ts';
import { isE2eProject } from './e2e/store.ts';
import { assertRoom } from './projectsize.ts';
import { db } from './db.ts';
import { manager, HtmlDoc, BoardDoc } from './docs.ts';
import { resolveProjectPath, projectDir } from './projects.ts';

const execFileP = promisify(execFile);

export class HistoryError extends Error { constructor(message: string, public status = 400) { super(message); } }

/** Give a version a name; an automatic one becomes a kept (named) one. */
export function nameVersion(docId: string, vid: number, name: string): boolean {
  const clean = name.replace(/\s+/g, ' ').trim().slice(0, 200);
  if (!clean) throw new HistoryError('a name is needed');
  const r = db.prepare(`UPDATE versions SET name = ?, kind = CASE WHEN kind = 'auto' THEN 'manual' ELSE kind END WHERE id = ? AND doc_id = ?`).run(clean, vid, docId);
  return r.changes > 0;
}

/**
 * Replace one passage of the live text: `cur` at `at` (where the client saw it) becomes `text`.
 * When the passage moved (edits above it) it is found again by its text, when that is unique.
 * Returns where it went, so that the client can undo it the same way.
 */
export async function replacePassage(docId: string, part: { at: number; cur: string; text: string }): Promise<{ at: number }> {
  const doc = await manager.open(docId);
  if (doc instanceof BoardDoc) throw new HistoryError('a board is restored as a whole');
  const live = doc instanceof HtmlDoc ? doc.html.toString() : await doc.textAsync();
  let at = part.at;
  if (live.slice(at, at + part.cur.length) !== part.cur) {
    const first = part.cur ? live.indexOf(part.cur) : -1;
    if (first < 0 || live.indexOf(part.cur, first + 1) >= 0) throw new HistoryError('That part was changed meanwhile — compare again.', 409);
    at = first;
  }
  const next = live.slice(0, at) + part.text + live.slice(at + part.cur.length);
  if (doc instanceof HtmlDoc) doc.replaceText(next, 'restore');
  else { await doc.loadText(next, 'restore', true); doc.scheduleSave(); }
  return { at };
}

export interface ProjectVersion { id: number; doc: string; path: string; name: string; author: string; kind: string; created_at: number; size: number }
export interface ProjectFileHistory { doc: string; path: string; exists: boolean; versions: number; last: number }

/** The project's recent versions across its files, and every file the store has versions of (deleted ones too). */
export function projectHistory(project: string, limit = 80): { recent: ProjectVersion[]; files: ProjectFileHistory[] } {
  const prefix = project + '/';
  const like = prefix.replace(/[\\%_]/g, c => '\\' + c) + '%';
  const rel = (doc: string) => doc.slice(prefix.length);
  const exists = (p: string) => { try { return fs.statSync(resolveProjectPath(project, p)).isFile(); } catch { return false; } };
  const recent = (db.prepare(`SELECT id, doc_id AS doc, name, author, kind, created_at, length(lyx) AS size FROM versions WHERE doc_id LIKE ? ESCAPE '\\' ORDER BY created_at DESC LIMIT ?`).all(like, limit) as Omit<ProjectVersion, 'path'>[])
    .map(v => ({ ...v, path: rel(v.doc) }));
  const files = (db.prepare(`SELECT doc_id AS doc, COUNT(*) AS versions, MAX(created_at) AS last FROM versions WHERE doc_id LIKE ? ESCAPE '\\' GROUP BY doc_id ORDER BY last DESC`).all(like) as { doc: string; versions: number; last: number }[])
    .map(f => ({ ...f, path: rel(f.doc), exists: exists(rel(f.doc)) }));
  return { recent, files };
}

/* ------------------------------------------------- the project's git history */

/** a commit of the project's history with the files it changed (A added, M changed, D deleted, R renamed) */
export interface GitChange { hash: string; author: string; date: number; message: string; files: { status: string; path: string; from?: string }[] }

const HASH = /^[0-9a-f]{7,64}$/;
/** a project-relative path that stays inside the project */
const safeRel = (p: string) => !!p && !p.startsWith('/') && !p.split('/').some(s => s === '..' || s === '' || s === '.git');

/**
 * The project's recent commits (git.ts: OverLyX commits people's edits every few minutes, with
 * their names; pushes from elsewhere land here too) with the files each changed — every kind of
 * file, not only documents. Null where the project has no repository (git off, encrypted projects).
 */
export async function gitChanges(project: string, limit = 40): Promise<GitChange[] | null> {
  if (!config.git || isE2eProject(project) || !hasRepo(project)) return null;
  const out = await git(project, ['-c', 'core.quotePath=false', 'log', `-n${Math.min(200, Math.max(1, limit))}`, '--format=%x1e%H%x1f%an%x1f%at%x1f%s', '--name-status', '--no-renames']).catch(() => '');
  return out.split('\x1e').filter(s => s.trim()).map(block => {
    const [head, ...lines] = block.split('\n');
    const [hash, author, at, message] = head.split('\x1f');
    const files = lines.filter(Boolean).map(l => { const [status, ...rest] = l.split('\t'); return { status: status.charAt(0), path: rest[rest.length - 1] ?? '' }; }).filter(f => f.path);
    return { hash, author, date: Number(at) * 1000, message, files };
  });
}

/** A file as a commit had it (null: not there or too large); `parent`: as it was just before that commit. */
export async function gitFileAt(project: string, hash: string, rel: string, parent = false): Promise<Buffer | null> {
  if (!config.git || !HASH.test(hash) || !safeRel(rel) || !hasRepo(project)) return null;
  try {
    const { stdout } = await execFileP('git', ['-C', projectDir(project), 'show', `${hash}${parent ? '^' : ''}:${rel}`], { env: gitEnv(), encoding: 'buffer', maxBuffer: 64 * 1024 * 1024 });
    return stdout as Buffer;
  } catch { return null; }
}

/** Bring back a file a commit deleted, as it was before that commit — only where nothing is now. */
export async function restoreDeletedFile(project: string, hash: string, rel: string, by: number): Promise<void> {
  const data = await gitFileAt(project, hash, rel, true);
  if (!data) throw new HistoryError('That file is not in the history before this change', 404);
  const abs = resolveProjectPath(project, rel);
  if (fs.existsSync(abs)) throw new HistoryError(`${rel} exists — it is not restored over the file that is there now`, 409);
  assertRoom(project, data.length, 0, 'The restored file');
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, data, { flag: 'wx' });
  touchProject(project, by);
}
