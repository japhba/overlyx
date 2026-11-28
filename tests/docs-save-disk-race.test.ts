/**
 * A save never writes over a change somebody made to the file on disk while the save made its text.
 * In a document worker the text takes a while, so the save looks at the file again before writing
 * and merges a change first; it did so twice and then, on the third round, wrote its text without
 * looking — a third change in a row (a tool or a sync rewriting the file) was lost without a version.
 * Now the save gives up for the moment instead (the merge is in the document; it retries).
 */
import { it, expect, vi, afterAll } from 'vitest';
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const ROOT = vi.hoisted(() => {
  const root = (process.env.TMPDIR ?? '/tmp') + '/overlyx-save-disk-race-test';
  process.env.OVERLYX_DATA_DIR = root + '/data';
  process.env.OVERLYX_PROJECTS_DIR = root + '/projects';
  process.env.OVERLYX_DOC_WORKERS = '1';
  return root;
});
rmSync(ROOT, { recursive: true, force: true });
mkdirSync(join(ROOT, 'projects', 'u', 'p'), { recursive: true });

const { manager, docWorkers } = await import('../packages/server/src/docs.ts');
const { config } = await import('../packages/server/src/config.ts');
afterAll(() => docWorkers.close());

const docText = (...pars: string[]) => '\\documentclass{article}\n\\begin{document}\n' + pars.map(t => `${t}\n\n`).join('') + '\\end{document}\n';
const file = join(ROOT, 'projects', 'u', 'p', 'a.tex');

it('a file changed on disk during every round of a save is merged, never written over', async () => {
  expect(config.dataDir.startsWith(ROOT)).toBe(true);
  vi.spyOn(console, 'log').mockImplementation(() => undefined);
  vi.spyOn(console, 'error').mockImplementation(() => undefined);
  writeFileSync(file, docText('one', 'two', 'three'));
  const doc = await manager.open('u/p/a.tex');
  expect(doc.usesWorker).toBe(true);
  await doc.loadText(docText('one', 'two EDITED HERE', 'three'), 'test', true);
  doc.dirty = true;
  // every text the save makes, and every merge of the file, is followed by somebody else's write of
  // the file (a merge hands the save its text: the next round makes none)
  const render = doc.renderAsync.bind(doc), apply = doc.applyMirrorUpdate.bind(doc);
  let outside = 0;
  const write = () => { if (outside < 6) writeFileSync(file, readFileSync(file, 'utf8').replace(/three[^\n]*/, `three OUTSIDE ${++outside}`)); };
  doc.renderAsync = async () => { const r = await render(); write(); return r; };
  doc.applyMirrorUpdate = (u, origin, knew) => { apply(u, origin, knew); if (origin === 'file-load') write(); };
  expect(await doc.saveToFile()).toBe(false);   // for now: its editors read "Could not save", a retry follows
  expect(doc.saveError).toContain('kept changing on disk');
  doc.renderAsync = render;
  doc.applyMirrorUpdate = apply;
  expect(outside).toBeGreaterThanOrEqual(3);
  // the last outside change is in the file still (the document has merged those before it)
  expect(readFileSync(file, 'utf8')).toContain(`three OUTSIDE ${outside}`);
  expect(await doc.textAsync()).toContain(`three OUTSIDE ${outside - 1}`);
  // once the file holds still, the next save writes the edit and keeps the outside change
  expect(await doc.saveToFile()).toBe(true);
  const saved = readFileSync(file, 'utf8');
  expect(saved).toContain('two EDITED HERE');
  expect(saved).toContain(`three OUTSIDE ${outside}`);
  expect(doc.saveError).toBeNull();
  doc.dispose();
});
