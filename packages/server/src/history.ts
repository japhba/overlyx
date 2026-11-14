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
 *    stay in the store, keyed by the document's id, until the project is deleted).
 */
import fs from 'node:fs';
import { db } from './db.ts';
import { manager, HtmlDoc, BoardDoc } from './docs.ts';
import { resolveProjectPath } from './projects.ts';

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
