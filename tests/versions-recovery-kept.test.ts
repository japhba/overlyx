/**
 * The versions OverLyX keeps so that nothing is lost — "before a change on disk" (which a notice on
 * screen points at for a week, docnotices.ts), "file removed on disk", "before large deletion",
 * "before restore of …", "before merging …'s offline edits" — are not thinned out with the routine
 * autosaves: only those (name "autosave") are held to the last 60 per document. Before, both shared
 * the kind 'auto' and the pruning went by kind, so ten hours of editing removed the recovery copy.
 */
import { it, expect, vi } from 'vitest';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const ROOT = vi.hoisted(() => {
  const root = (process.env.TMPDIR ?? '/tmp') + '/overlyx-versions-recovery-kept-test';
  process.env.OVERLYX_DATA_DIR = root + '/data';
  process.env.OVERLYX_PROJECTS_DIR = root + '/projects';
  process.env.OVERLYX_AUTOVERSION_MS = '0';
  return root;
});
rmSync(ROOT, { recursive: true, force: true });
mkdirSync(join(ROOT, 'projects', 'u', 'p'), { recursive: true });

const { manager } = await import('../packages/server/src/docs.ts');
const { db } = await import('../packages/server/src/db.ts');
const { config } = await import('../packages/server/src/config.ts');

it('sixty-one autosaves later the recovery versions are still there, and only 60 autosaves', async () => {
  expect(config.dataDir.startsWith(ROOT)).toBe(true);
  writeFileSync(join(ROOT, 'projects', 'u', 'p', 'a.tex'), '\\documentclass{article}\n\\begin{document}\nAlpha.\n\n\\end{document}\n');
  const id = 'u/p/a.tex';
  const d = await manager.open(id);
  const kept = d.snapshot('before a change on disk', 'THE EDITOR\'S SIDE');
  const removed = d.snapshot('file removed on disk', 'THE LAST TEXT');
  expect(kept).not.toBeNull();
  // (created_at decides the order: the recovery versions first, then the autosaves a millisecond apart, all in the past)
  const t0 = Date.now() - 1_000_000;
  db.prepare('UPDATE versions SET created_at = ? WHERE id IN (?, ?)').run(t0 - 1000, kept, removed);
  for (let i = 0; i < 61; i++) {
    d.lastAutoVersion = 0;
    d.maybeAutoVersion(`text ${i}`);
    db.prepare('UPDATE versions SET created_at = ? WHERE doc_id = ? AND lyx = ?').run(t0 + i, id, `text ${i}`);
  }
  const names = (db.prepare('SELECT name FROM versions WHERE doc_id = ?').all(id) as { name: string }[]).map(v => v.name);
  expect(names.filter(n => n === 'autosave').length).toBe(60);
  expect(names).toContain('before a change on disk');
  expect(names).toContain('file removed on disk');
  d.dispose();
});
