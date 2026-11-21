/**
 * At server start: edits the server stored but had not written to their files when it stopped — a
 * crash, a hard kill, a save that kept failing — are written right away. Opening such a document
 * keeps and writes them (docs.ts openUnsaved / rescueUnsaved, with the three-way merge of a file
 * changed meanwhile), but until somebody opened it a LaTeX build, git, the sync and the VS Code clones
 * saw the older file. So shortly after the start every document whose stored state is marked
 * unsaved (`ydocs_saved.saved = 0`) is opened through that same path, written, and closed again
 * unless somebody is editing it by then.
 *
 * Bounded, because this box's memory is shared with everything else: one document at a time, none
 * whose stored state or file is over `maxBytes`, at most `budgetMs` in all and `perDocMs` per
 * document (what is left is written at its next open, as before). End-to-end encrypted projects are
 * skipped (the server cannot read them). One log line per document; nothing here throws.
 */
import fs from 'node:fs';
import { splitDocId } from '@overlyx/core';
import { db } from './db.ts';
import { manager } from './docs.ts';
import { resolveProjectPath } from './projects.ts';
import { isE2eProject } from './e2e/store.ts';

export interface RescueOptions {
  /** skip a document whose stored state or file is larger (bytes) */
  maxBytes?: number;
  /** stop after this long in all (ms) */
  budgetMs?: number;
  /** give up on one document after this long (ms) */
  perDocMs?: number;
  /** only states stored within this long (ms) */
  maxAgeMs?: number;
  log?: (line: string) => void;
}

export interface RescueResult { written: string[]; nothing: string[]; skipped: string[]; failed: string[]; left: string[] }

const timeout = (ms: number) => new Promise<'timeout'>(res => { const t = setTimeout(() => res('timeout'), ms); t.unref?.(); });

/** Write the edits stored but not written before the last stop (see the module comment). */
export async function writeRescuedEdits(opts: RescueOptions = {}): Promise<RescueResult> {
  const maxBytes = opts.maxBytes ?? 32 * 1024 * 1024;
  const budgetMs = opts.budgetMs ?? 3 * 60_000;
  const perDocMs = opts.perDocMs ?? 60_000;
  const maxAgeMs = opts.maxAgeMs ?? 30 * 86_400_000;
  const log = opts.log ?? ((s: string) => console.log(s));
  const out: RescueResult = { written: [], nothing: [], skipped: [], failed: [], left: [] };
  const t0 = Date.now();
  let rows: { id: string; size: number }[];
  try {
    rows = db.prepare(`SELECT s.id AS id, length(y.state) AS size FROM ydocs_saved s JOIN ydocs y ON y.id = s.id
      WHERE s.saved = 0 AND s.file_hash = y.file_hash AND y.updated_at > ? ORDER BY y.updated_at DESC`).all(Date.now() - maxAgeMs) as { id: string; size: number }[];
  } catch (e) { log(`[rescue] could not look for unsaved edits: ${String(e)}`); return out; }
  if (!rows.length) return out;
  log(`[rescue] ${rows.length} document(s) have edits stored but not written to their files — writing them`);
  for (const { id, size } of rows) {
    if (Date.now() - t0 > budgetMs) { out.left.push(id); continue; }
    try {
      const r = await rescueOne(id, size, maxBytes, perDocMs);
      out[r.kind].push(id);
      log(`[rescue] ${id}: ${r.say}`);
    } catch (e) {
      out.failed.push(id);
      log(`[rescue] ${id}: failed — ${e instanceof Error ? e.message : String(e)}`);
    }
  }
  if (out.left.length) log(`[rescue] out of time: ${out.left.length} document(s) left for their next open`);
  log(`[rescue] done in ${Math.round((Date.now() - t0) / 1000)} s: ${out.written.length} written, ${out.nothing.length} had nothing to write, ${out.skipped.length} skipped, ${out.failed.length} failed`);
  return out;
}

async function rescueOne(id: string, size: number, maxBytes: number, perDocMs: number): Promise<{ kind: 'written' | 'nothing' | 'skipped' | 'failed'; say: string }> {
  if (manager.docs.has(id)) return { kind: 'skipped', say: 'open already (its own save writes it)' };
  const { project, path: rel } = splitDocId(id);
  if (!project || !rel) return { kind: 'skipped', say: 'not a document id' };
  if (isE2eProject(project)) return { kind: 'skipped', say: 'end-to-end encrypted project' };
  if (size > maxBytes) return { kind: 'skipped', say: `stored state too large (${Math.round(size / 1048576)} MB) — written at its next open` };
  let abs: string, before: fs.Stats;
  try { abs = resolveProjectPath(project, rel); before = fs.statSync(abs); } catch { return { kind: 'skipped', say: 'its file is gone' }; }
  if (before.size > maxBytes) return { kind: 'skipped', say: `file too large (${Math.round(before.size / 1048576)} MB) — written at its next open` };
  const work = (async () => {
    // the open keeps the stored edits and starts writing them (a document on the main thread has
    // written them by the time it returns)
    const doc = await manager.open(id);
    if (doc.dirty || doc.saving) await doc.saveToFile();
    if (doc.saveError) return { kind: 'failed' as const, say: `could not write it yet (${doc.saveError}) — it stays open and retries` };
    let after: fs.Stats | null = null;
    try { after = fs.statSync(abs); } catch { /* removed meanwhile */ }
    const changed = !after || after.ino !== before.ino || after.mtimeMs !== before.mtimeMs || after.size !== before.size;
    return changed ? { kind: 'written' as const, say: 'written' } : { kind: 'nothing' as const, say: 'the file had everything (nothing to write)' };
  })();
  work.catch(() => undefined);
  const r = await Promise.race([work, timeout(perDocMs)]);
  if (r === 'timeout') return { kind: 'failed', say: `no answer in ${Math.round(perDocMs / 1000)} s — moving on (its save goes on)` };
  // closed again unless somebody opened it meanwhile (unload keeps a document whose save failed)
  try { await manager.unload(id); } catch { /* stays open: harmless */ }
  return r;
}
