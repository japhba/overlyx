/**
 * Edits made offline, merged when their editor reconnects (DOCS.md "Offline mode").
 *
 * The CRDT merges a reconnecting editor's offline edits with everybody else's by itself, and where
 * the two sides changed different words that is all it takes. Where both changed the same words it
 * interleaves them, and nobody would notice. So an editor that made edits offline sends, before its
 * sync step 2, the state its local copy had when the first of them was made (MSG_OFFLINE_BASE,
 * client editor.ts). With it the server has all three versions — that base, the live document and
 * the offline copy (the base with the editor's updates) — and when the step 2 comes:
 *  - the live document is kept as a version ("before merging …'s offline edits") when both sides
 *    changed the text meanwhile;
 *  - after the offline edits went in, the places both changed differently (core lyx/merge3.ts) are
 *    laid out for review: the live text, with the offline version over it as tracked changes by
 *    "<name> (offline)" — Reject keeps the live text, Accept takes the offline one. The merge is
 *    noted in the CRDT's `offlineMerges` map, which the editors show as a review card
 *    (client editor/plugins/mergereview.ts).
 *
 * A base the server lacks parts of (edits sent into a connection that had died before the editor
 * noticed) is cut down to what the server has, so those edits count as the offline side's.
 */
import * as Y from 'yjs';
import type { WebSocket } from 'ws';
import { merge3, reviewBody, adoptReview, addAuthor, lyxAuthorId, writeParagraphs, type LyxDocument } from '@overlyx/core';
import { isModel2 } from '@overlyx/core/collab/model.ts';
import type { OpenDoc } from './docs.ts';
import { lyxDocumentOf } from './docwork.ts';

/** origin of the review's transaction (an ordinary sync update for the editors: nobody's undo step) */
export const OFFLINE_MERGE_ORIGIN = 'offline-merge';
/** the CRDT's map of merges laid out for review: `<author id>:<time>` → JSON of an OfflineMergeEntry */
export const OFFLINE_MERGES = 'offlineMerges';
/** reviews older than this are forgotten (their tracked changes stay, as ordinary ones) */
const KEEP_MS = 60 * 86400_000;

export interface OfflineMergeEntry {
  /** who worked offline, and the author of the review's tracked changes ("<name> (offline)") */
  name: string; reviewer: string; authorId: number;
  /** the changes' time (unix seconds) and when the merge happened (ms) */
  time: number; at: number;
  conflicts: number;
}

interface Session { base: Uint8Array; updates: Uint8Array[]; name: string }
const sessions = new WeakMap<WebSocket, Session>();

/** A connection's offline base arrived: its next sync step 2 is merged for review. */
export function offlineBase(conn: WebSocket, base: Uint8Array, name: string): void {
  sessions.set(conn, { base, updates: [], name });
}

/**
 * An update a client sent (`step2`: its sync step 2): applied — and, when the connection brought an
 * offline base, the offline edits it carries are merged for review.
 */
export function applyClientUpdate(doc: OpenDoc, conn: WebSocket, update: Uint8Array, step2: boolean): void {
  const s = sessions.get(conn);
  if (!s) { Y.applyUpdate(doc.ydoc, update, conn); return; }
  s.updates.push(update);
  if (!step2) { Y.applyUpdate(doc.ydoc, update, conn); return; }
  sessions.delete(conn);
  let before: Prepared | null = null;
  try { before = prepare(doc, s); } catch (e) { console.error(`[offline] ${doc.id}: preparing the merge failed`, e); }
  Y.applyUpdate(doc.ydoc, update, conn);
  if (!before) return;
  try { review(doc, s, before); } catch (e) { console.error(`[offline] ${doc.id}: the review of ${s.name}'s offline edits failed`, e); }
}

interface Prepared { base: Y.Doc; live: LyxDocument }

/** The base cut down to what the server has, and the live document — null when nobody changed anything the base lacks (nothing to merge). */
function prepare(doc: OpenDoc, s: Session): Prepared | null {
  const base = new Y.Doc({ gc: false });
  Y.applyUpdate(base, s.base);
  if (!isModel2(base)) return null;
  const snap = Y.snapshot(base);
  const server = Y.decodeStateVector(Y.encodeStateVector(doc.ydoc));
  const added = [...server].some(([client, clock]) => clock > (snap.sv.get(client) ?? 0));
  const deleted = !Y.equalDeleteSets(Y.mergeDeleteSets([snap.ds, Y.createDeleteSetFromStructStore(doc.ydoc.store)]), Y.mergeDeleteSets([snap.ds]));
  if (!added && !deleted) return null;
  const unknown = [...snap.sv].some(([client, clock]) => clock > (server.get(client) ?? 0));
  if (!unknown) return { base, live: lyxDocumentOf(doc.ydoc) };
  const known = new Map([...snap.sv].map(([client, clock]) => [client, Math.min(clock, server.get(client) ?? 0)] as [number, number]).filter(([, clock]) => clock > 0));
  return { base: Y.createDocFromSnapshot(base, Y.createSnapshot(snap.ds, known)), live: lyxDocumentOf(doc.ydoc) };
}

function review(doc: OpenDoc, s: Session, p: Prepared): void {
  const offlineDoc = new Y.Doc();
  Y.applyUpdate(offlineDoc, s.base);
  for (const u of s.updates) Y.applyUpdate(offlineDoc, u);
  const base = lyxDocumentOf(p.base), offline = lyxDocumentOf(offlineDoc), live = p.live;
  const text = (d: LyxDocument) => writeParagraphs(d.body);
  if (text(offline) === text(base) || text(live) === text(base)) return;   // one side did not touch the text
  try { doc.snapshot(`before merging ${s.name}'s offline edits`, doc.textOf(live)); } catch (e) { console.error(`[offline] ${doc.id}: no version before the merge`, e); }
  const m = merge3(base.body, live.body, offline.body);
  console.log(`[offline] ${doc.id}: ${s.name}'s offline edits merged, ${m.conflicts} conflict${m.conflicts === 1 ? '' : 's'}`);
  if (!m.conflicts) return;
  const reviewer = `${s.name} (offline)`;
  const as = { author: lyxAuthorId(reviewer, ''), time: Math.floor(Date.now() / 1000) };
  const now = doc.toLyxDocument();
  const header = { lines: [...now.header.lines] };
  addAuthor(header, as.author, reviewer, '');
  const body = adoptReview(live.body, now.body, reviewBody(m, as), as);
  const entry: OfflineMergeEntry = { name: s.name, reviewer, authorId: as.author, time: as.time, at: Date.now(), conflicts: m.conflicts };
  doc.ydoc.transact(() => {
    doc.loadFromLyx({ ...now, header, body }, OFFLINE_MERGE_ORIGIN);
    const merges = doc.ydoc.getMap<string>(OFFLINE_MERGES);
    for (const [k, v] of merges) { try { if (Date.now() - (JSON.parse(v) as OfflineMergeEntry).at > KEEP_MS) merges.delete(k); } catch { merges.delete(k); } }
    merges.set(`${as.author}:${as.time}`, JSON.stringify(entry));
  }, OFFLINE_MERGE_ORIGIN);
  doc.edited();
}
