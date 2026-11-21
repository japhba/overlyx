/**
 * Notices to the editors of a document that the file changed outside the editor while it had edits
 * not written yet, and that where both changed the same place the file's version was kept — the
 * editor's version is in History (docs.ts: the versions "before a change on disk" and "unsaved edits
 * from before a restart"). People connected at the time are told at once (ws.ts, message 8); everybody
 * else who edits the document is told at their next open within a week. Each person once: the editor
 * says it was seen (the card was on screen a few seconds, or clicked); until then every open tells again.
 */
import { db } from './db.ts';

/** 'disk': a change on disk merged (while open, or at an open); 'restart': the same with edits the server had not written before it stopped; 'stale': such edits kept whole as a version, the file loaded as it is */
export type NoticeKind = 'disk' | 'restart' | 'stale';

export interface DocNotice {
  id: number;
  doc: string;
  /** the version in History that holds the editor's side (null: none was kept) */
  version: number | null;
  kind: NoticeKind;
  /** how many places both sides changed (null: not counted) */
  places: number | null;
  at: number;
}

/** how long somebody who was not there is still told at their next open */
export const NOTICE_DAYS = 7;

/** told about every notice as it is recorded (ws.ts sends it to the connected editors) */
export const noticeListeners = new Set<(n: DocNotice) => void>();

type Row = { id: number; doc_id: string; version_id: number | null; kind: NoticeKind; places: number | null; created_at: number };
const fromRow = (r: Row): DocNotice => ({ id: r.id, doc: r.doc_id, version: r.version_id, kind: r.kind, places: r.places, at: r.created_at });

/** Record a notice and tell the listeners (never throws: a notice is never worth a failed merge). */
export function recordNotice(doc: string, version: number | null, kind: NoticeKind, places: number | null = null): void {
  try {
    const at = Date.now();
    const info = db.prepare('INSERT INTO doc_notices (doc_id, version_id, kind, places, created_at) VALUES (?,?,?,?,?)').run(doc, version, kind, places, at);
    db.prepare('DELETE FROM doc_notices_seen WHERE notice_id IN (SELECT id FROM doc_notices WHERE created_at < ?)').run(at - 30 * 86_400_000);
    db.prepare('DELETE FROM doc_notices WHERE created_at < ?').run(at - 30 * 86_400_000);
    const n: DocNotice = { id: Number(info.lastInsertRowid), doc, version, kind, places, at };
    for (const l of noticeListeners) { try { l(n); } catch (e) { console.error('[notices] listener failed', e); } }
  } catch (e) { console.error('[notices] could not record a notice', doc, e); }
}

/** The notices of a document this person has not been told about, from the last week (oldest first). */
export function unseenNotices(doc: string, userId: number): DocNotice[] {
  try {
    return (db.prepare(`SELECT * FROM doc_notices n WHERE doc_id = ? AND created_at > ?
      AND NOT EXISTS (SELECT 1 FROM doc_notices_seen s WHERE s.notice_id = n.id AND s.user_id = ?) ORDER BY created_at`)
      .all(doc, Date.now() - NOTICE_DAYS * 86_400_000, userId) as Row[]).map(fromRow);
  } catch { return []; }
}

/** This person has seen the notice `id` of document `doc` (the editor said so). */
export function markNoticeSeen(id: number, userId: number, doc: string): void {
  try { db.prepare('INSERT OR IGNORE INTO doc_notices_seen (notice_id, user_id) SELECT id, ? FROM doc_notices WHERE id = ? AND doc_id = ?').run(userId, id, doc); } catch { /* told again next time */ }
}
