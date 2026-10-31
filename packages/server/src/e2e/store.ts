/**
 * End-to-end encrypted projects (DOCS.md "End-to-end encrypted projects"): what the server keeps of
 * them. Every byte of their content is encrypted in the browsers with the project's key, which the
 * server never has; it stores and relays ciphertext only:
 *
 *  - each document is a log of encrypted Yjs updates (`log`, per opaque document id; a browser now and
 *    then replaces the oldest entries by one encrypted snapshot of them — `compact`), relayed live to
 *    the document's other editors (relay.ts);
 *  - every other file (figures, .bib, …) is an encrypted blob under an opaque id (`.e2e/blobs/<id>`);
 *  - which path is which document or blob is itself an encrypted document (the manifest, id `manifest`);
 *  - the project key, wrapped (encrypted) for each member's public key (`keys`), and each account's key
 *    pair: the public key and the private key sealed with the account's recovery code (`e2e_user_keys`
 *    in the main database).
 *
 * All of it lives in the project's directory, `.e2e/` (a SQLite file and the blobs), so a project
 * that moves, goes to the trash or into a backup takes its ciphertext along. Dot-directories are
 * not files of a project (projectfiles.ts collect), and `resolveProjectPath` refuses any other path
 * of an encrypted project: nothing of the server writes plaintext into one or reads from it.
 */
import fs from 'node:fs';
import path from 'node:path';
import Database from 'better-sqlite3';
import { isProjectKey } from '@overlyx/core';
import { db } from '../db.ts';
import { config } from '../config.ts';
import { setEncryptedCheck } from '../projectfiles.ts';

/** OVERLYX_E2E=off: no new encrypted projects, the relay and the key routes answer 503 (existing data is kept) */
export const e2eEnabled = process.env.OVERLYX_E2E !== 'off';

/** a document id, blob id: random, URL-safe */
export const OPAQUE_ID = /^[A-Za-z0-9_-]{8,64}$/;
/** the manifest's document id: the project's file list */
export const MANIFEST_DOC = 'manifest';

export const KIND_UPDATE = 0;
export const KIND_SNAPSHOT = 1;

export class E2eRefusal extends Error {
  readonly status = 403;
  readonly code = 'e2e';
  constructor(message = 'This project is end-to-end encrypted: its files can only be opened in the browser of one of its members') { super(message); this.name = 'E2eRefusal'; }
}

export function isE2eProject(project: string): boolean {
  if (!isProjectKey(project)) return false;
  const row = db.prepare('SELECT e2e FROM projects WHERE name = ?').get(project) as { e2e: number } | undefined;
  return !!row?.e2e;
}

setEncryptedCheck(isE2eProject);

export function markE2e(project: string): void {
  db.prepare('UPDATE projects SET e2e = 1 WHERE name = ?').run(project);
}

/** `<projects>/<owner>/<name>/.e2e` */
export function e2eDir(project: string): string {
  if (!isProjectKey(project)) throw new Error('bad project name');
  return path.join(config.projectsDir, project, '.e2e');
}

/* ------------------------------------------------------------------ the project's store */

interface Handle { db: Database.Database; file: string; ino: number; used: number }
const handles = new Map<string, Handle>();

/**
 * The project's SQLite file (opened once, kept while used). A handle whose file is no longer the one
 * at the project's path (the project moved, or went to the trash and another took its name) is
 * closed and the file opened anew.
 */
function store(project: string): Database.Database {
  const dir = e2eDir(project);
  const file = path.join(dir, 'store.sqlite');
  const h = handles.get(project);
  if (h) {
    let ino = -1;
    try { ino = fs.statSync(file).ino; } catch { /* gone */ }
    if (ino === h.ino) { h.used = Date.now(); return h.db; }
    try { h.db.close(); } catch { /* ignore */ }
    handles.delete(project);
  }
  fs.mkdirSync(dir, { recursive: true });
  const d = new Database(file);
  // a rollback journal, not WAL: the backups copy project directories file by file
  d.pragma('journal_mode = DELETE');
  d.exec(`
CREATE TABLE IF NOT EXISTS log (
  doc TEXT NOT NULL,
  seq INTEGER NOT NULL,
  kind INTEGER NOT NULL,
  data BLOB NOT NULL,
  author INTEGER,
  at INTEGER NOT NULL,
  PRIMARY KEY (doc, seq)
);
CREATE TABLE IF NOT EXISTS keys (
  user_id INTEGER NOT NULL,
  version INTEGER NOT NULL,
  wrapped TEXT NOT NULL,
  granted_by INTEGER,
  at INTEGER NOT NULL,
  PRIMARY KEY (user_id, version)
);`);
  handles.set(project, { db: d, file, ino: fs.statSync(file).ino, used: Date.now() });
  return d;
}

/** Close the handles nobody used for ten minutes. */
const sweep = setInterval(() => {
  const old = Date.now() - 10 * 60 * 1000;
  for (const [k, h] of handles) if (h.used < old) { try { h.db.close(); } catch { /* ignore */ } handles.delete(k); }
}, 60 * 1000);
sweep.unref();

/** Before a project's directory is removed or moved: let go of its file. */
export function closeE2eStore(project: string): void {
  const h = handles.get(project);
  if (!h) return;
  try { h.db.close(); } catch { /* ignore */ }
  handles.delete(project);
}

/* -------------------------------------------------------------------------- documents */

export interface LogEntry { seq: number; kind: number; data: Uint8Array }

export function headSeq(project: string, doc: string): number {
  const r = store(project).prepare('SELECT MAX(seq) AS s FROM log WHERE doc = ?').get(doc) as { s: number | null };
  return r.s ?? 0;
}

/** The entries after `since`, oldest first. */
export function entriesSince(project: string, doc: string, since = 0): LogEntry[] {
  return (store(project).prepare('SELECT seq, kind, data FROM log WHERE doc = ? AND seq > ? ORDER BY seq').all(doc, since) as { seq: number; kind: number; data: Buffer }[])
    .map(r => ({ seq: r.seq, kind: r.kind, data: new Uint8Array(r.data.buffer, r.data.byteOffset, r.data.byteLength) }));
}

/** Append an encrypted update; returns its sequence number. */
export function appendUpdate(project: string, doc: string, data: Uint8Array, author: number): number {
  const d = store(project);
  return d.transaction(() => {
    const seq = ((d.prepare('SELECT MAX(seq) AS s FROM log WHERE doc = ?').get(doc) as { s: number | null }).s ?? 0) + 1;
    d.prepare('INSERT INTO log (doc, seq, kind, data, author, at) VALUES (?,?,?,?,?,?)').run(doc, seq, KIND_UPDATE, Buffer.from(data), author, Date.now());
    return seq;
  })();
}

/**
 * Replace the entries up to `upTo` by one snapshot of them (encrypted by a browser that had applied
 * exactly those). Refused when `upTo` is not an entry of the log.
 */
export function compact(project: string, doc: string, upTo: number, data: Uint8Array, author: number): boolean {
  const d = store(project);
  return d.transaction(() => {
    if (!d.prepare('SELECT 1 FROM log WHERE doc = ? AND seq = ?').get(doc, upTo)) return false;
    d.prepare('DELETE FROM log WHERE doc = ? AND seq <= ?').run(doc, upTo);
    d.prepare('INSERT INTO log (doc, seq, kind, data, author, at) VALUES (?,?,?,?,?,?)').run(doc, upTo, KIND_SNAPSHOT, Buffer.from(data), author, Date.now());
    return true;
  })();
}

export function deleteDoc(project: string, doc: string): void {
  store(project).prepare('DELETE FROM log WHERE doc = ?').run(doc);
}

/** The documents that have a log, with their size (the manifest's browsers clean up the ones it no longer names). */
export function docIds(project: string): { doc: string; bytes: number; entries: number }[] {
  return store(project).prepare('SELECT doc, SUM(LENGTH(data)) AS bytes, COUNT(*) AS entries FROM log GROUP BY doc').all() as { doc: string; bytes: number; entries: number }[];
}

/* ------------------------------------------------------------------------------ blobs */

function blobPath(project: string, id: string): string {
  if (!OPAQUE_ID.test(id)) throw new Error('bad blob id');
  return path.join(e2eDir(project), 'blobs', id);
}

export function blobSize(project: string, id: string): number | null {
  try { return fs.statSync(blobPath(project, id)).size; } catch { return null; }
}

export function writeBlob(project: string, id: string, data: Buffer): void {
  const p = blobPath(project, id);
  fs.mkdirSync(path.dirname(p), { recursive: true });
  const tmp = `${p}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, data);
  fs.renameSync(tmp, p);
}

export function blobFile(project: string, id: string): string | null {
  const p = blobPath(project, id);
  return fs.existsSync(p) ? p : null;
}

export function deleteBlob(project: string, id: string): boolean {
  try { fs.unlinkSync(blobPath(project, id)); return true; } catch { return false; }
}

/* ------------------------------------------------------------------------------- keys */

export interface UserKeys { publicKey: string; sealedPrivate: string; updatedAt: number }

export function userKeys(userId: number): UserKeys | null {
  const r = db.prepare('SELECT public_key, sealed_private, updated_at FROM e2e_user_keys WHERE user_id = ?').get(userId) as { public_key: string; sealed_private: string; updated_at: number } | undefined;
  return r ? { publicKey: r.public_key, sealedPrivate: r.sealed_private, updatedAt: r.updated_at } : null;
}

export function publicKeysOf(userIds: number[]): Map<number, string> {
  const out = new Map<number, string>();
  const q = db.prepare('SELECT public_key FROM e2e_user_keys WHERE user_id = ?');
  for (const id of userIds) { const r = q.get(id) as { public_key: string } | undefined; if (r) out.set(id, r.public_key); }
  return out;
}

/** A new key pair replaces the old one: project keys wrapped for the old public key are of no use any more (the client says so first). */
export function setUserKeys(userId: number, publicKey: string, sealedPrivate: string): void {
  const now = Date.now();
  db.prepare(`INSERT INTO e2e_user_keys (user_id, public_key, sealed_private, created_at, updated_at) VALUES (?,?,?,?,?)
    ON CONFLICT(user_id) DO UPDATE SET public_key = excluded.public_key, sealed_private = excluded.sealed_private, updated_at = excluded.updated_at`).run(userId, publicKey, sealedPrivate, now, now);
}

/** The same private key sealed anew (a new recovery code): the key pair stays. */
export function resealPrivate(userId: number, sealedPrivate: string): boolean {
  return db.prepare('UPDATE e2e_user_keys SET sealed_private = ?, updated_at = ? WHERE user_id = ?').run(sealedPrivate, Date.now(), userId).changes > 0;
}

export function deleteUserKeys(userId: number): void {
  db.prepare('DELETE FROM e2e_user_keys WHERE user_id = ?').run(userId);
}

export interface WrappedKey { userId: number; version: number; wrapped: string; grantedBy: number | null; at: number }

export function wrappedKeys(project: string): WrappedKey[] {
  return (store(project).prepare('SELECT user_id, version, wrapped, granted_by, at FROM keys ORDER BY version, at').all() as { user_id: number; version: number; wrapped: string; granted_by: number | null; at: number }[])
    .map(r => ({ userId: r.user_id, version: r.version, wrapped: r.wrapped, grantedBy: r.granted_by, at: r.at }));
}

export function grantKey(project: string, userId: number, version: number, wrapped: string, by: number): void {
  store(project).prepare(`INSERT INTO keys (user_id, version, wrapped, granted_by, at) VALUES (?,?,?,?,?)
    ON CONFLICT(user_id, version) DO UPDATE SET wrapped = excluded.wrapped, granted_by = excluded.granted_by, at = excluded.at`).run(userId, version, wrapped, by, Date.now());
}

/** A member who left, or whose key pair was replaced: the server stops handing them the project key. */
export function dropKeys(project: string, userId: number): void {
  store(project).prepare('DELETE FROM keys WHERE user_id = ?').run(userId);
}

/** Every project in which the account holds a key (its key pair is being replaced). */
export function dropKeysEverywhere(userId: number): void {
  for (const r of db.prepare('SELECT name FROM projects WHERE e2e = 1').all() as { name: string }[]) {
    try { if (fs.existsSync(path.join(e2eDir(r.name), 'store.sqlite'))) dropKeys(r.name, userId); } catch { /* a project being moved */ }
  }
}
