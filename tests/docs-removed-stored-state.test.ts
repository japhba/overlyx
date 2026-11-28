/**
 * A document whose file is removed outside the app is closed with its text kept as a version — and
 * its stored state goes with it. Left behind (stored unsaved, with the file text it was based on), it
 * was merged three-way into whatever file took the name later: a new document opened with a
 * paragraph of the old one in it. Document workers on, as in production.
 */
import { it, expect, vi, afterAll } from 'vitest';
import { mkdirSync, readFileSync, rmSync, unlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const ROOT = vi.hoisted(() => {
  const root = (process.env.TMPDIR ?? '/tmp') + '/overlyx-removed-stored-state-test';
  process.env.OVERLYX_DATA_DIR = root + '/data';
  process.env.OVERLYX_PROJECTS_DIR = root + '/projects';
  process.env.OVERLYX_DOC_WORKERS = '1';
  // nothing is written by the timer: the edit stays unsaved
  process.env.OVERLYX_SAVE_DEBOUNCE = '600000';
  process.env.OVERLYX_SAVE_MAX_WAIT = '600000';
  return root;
});
rmSync(ROOT, { recursive: true, force: true });
mkdirSync(join(ROOT, 'projects', 'u', 'p'), { recursive: true });

const { manager, docWorkers } = await import('../packages/server/src/docs.ts');
const { db } = await import('../packages/server/src/db.ts');
const { config } = await import('../packages/server/src/config.ts');
afterAll(() => docWorkers.close());

const doc = (...p: string[]) => '\\documentclass{article}\n\\begin{document}\n' + p.map(x => x + '\n\n').join('') + '\\end{document}\n';
const file = join(ROOT, 'projects', 'u', 'p', 'n.tex');
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));

it('removed with unsaved typing, then another file takes the name: that file opens as it is', async () => {
  expect(config.dataDir.startsWith(ROOT)).toBe(true);
  vi.spyOn(console, 'log').mockImplementation(() => undefined);
  writeFileSync(file, doc('Old one.', 'Old two.', 'Old three.'));
  const id = 'u/p/n.tex';
  const d = await manager.open(id);
  d.loadFromLyx(d.parse(doc('Old one.', 'Old two.', 'Old three.', 'UNSAVED TEXT OF THE OLD FILE.')), 'test');
  d.dirty = true;
  d.persistState();   // (the persist timer's, within the second: stored as unsaved, with the file text it is based on)
  expect(db.prepare('SELECT saved FROM ydocs_saved WHERE id = ?').get(id)).toEqual({ saved: 0 });
  await sleep(300);   // (the watcher settles on the file)
  unlinkSync(file);
  for (let i = 0; i < 120 && manager.docs.has(id); i++) await sleep(100);
  expect(manager.docs.has(id)).toBe(false);
  const kept = db.prepare("SELECT lyx FROM versions WHERE doc_id = ? AND name = 'file removed on disk'").get(id) as { lyx: string } | undefined;
  expect(kept?.lyx).toContain('UNSAVED TEXT OF THE OLD FILE.');

  const NEW = doc('A new document.', 'Nothing of the old one.');
  writeFileSync(file, NEW);
  const n = await manager.open(id);
  for (let i = 0; i < 50 && (n.dirty || n.saving); i++) await sleep(100);
  expect(await n.textAsync()).toBe(NEW);
  expect(readFileSync(file, 'utf8')).toBe(NEW);
  n.dispose();
}, 30_000);
