/**
 * A document whose save keeps failing (a full disk, a permission problem) must not be forgotten:
 * DocManager.unload used to drop it although its edits were only in the stored state, and the next
 * open loaded the file over them — hours of work gone. It stays loaded and keeps retrying, and its
 * editors are told (the saved message carries the error in plain words: "Could not save").
 */
import { it, expect, vi } from 'vitest';
import { chmodSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import * as decoding from 'lib0/decoding';

const ROOT = vi.hoisted(() => {
  const root = (process.env.TMPDIR ?? '/tmp') + '/overlyx-failed-save-test';
  process.env.OVERLYX_DATA_DIR = root + '/data';
  process.env.OVERLYX_PROJECTS_DIR = root + '/projects';
  return root;
});
rmSync(ROOT, { recursive: true, force: true });
mkdirSync(join(ROOT, 'projects', 'u', 'p'), { recursive: true });

const { manager } = await import('../packages/server/src/docs.ts');
const { savedMessage } = await import('../packages/server/src/ws.ts');
const docText = (...pars: string[]) => '\\documentclass{article}\n\\begin{document}\n' + pars.map(t => `${t}\n\n`).join('') + '\\end{document}\n';
const dir = join(ROOT, 'projects', 'u', 'p');

/** the save error a saved message carries ('' = none), read as the editor reads it (client editor.ts) */
function errorInSavedMessage(msg: Uint8Array): string {
  const dec = decoding.createDecoder(msg);
  decoding.readVarUint(dec); decoding.readVarUint(dec); decoding.readVarUint8Array(dec); decoding.readVarUint8Array(dec);
  return decoding.hasContent(dec) ? decoding.readVarString(dec) : '';
}

it('stays loaded while its save fails, tells its editors, and saves once it can', async () => {
  vi.spyOn(console, 'error').mockImplementation(() => undefined);
  vi.spyOn(console, 'log').mockImplementation(() => undefined);
  writeFileSync(join(dir, 'a.tex'), docText('one', 'two', 'three'));
  const doc = await manager.open('u/p/a.tex');
  const told: string[] = [];
  doc.savedListeners.add(() => told.push(errorInSavedMessage(savedMessage(doc))));
  chmodSync(dir, 0o555);                        // saves fail from here on
  try {
    doc.loadFromLyx(doc.parse(docText('one', 'two AN HOUR OF WORK', 'three')), 'test');
    expect(await doc.saveToFile()).toBe(false);
    expect(told).toEqual(['the server may not write the file']);
    doc.persistState();
    await manager.unload('u/p/a.tex');          // nobody connected for hours (or the unload timer)
    expect(manager.docs.get('u/p/a.tex')).toBe(doc);
  } finally { chmodSync(dir, 0o755); }          // the disk has room again
  expect(await doc.saveToFile()).toBe(true);
  expect(told.at(-1)).toBe('');                 // "Could not save" clears
  expect(readFileSync(join(dir, 'a.tex'), 'utf8')).toContain('AN HOUR OF WORK');
  await manager.unload('u/p/a.tex');            // saved: now it may go
  expect(manager.docs.has('u/p/a.tex')).toBe(false);
  const again = await manager.open('u/p/a.tex');
  expect(again.toText()).toContain('AN HOUR OF WORK');
  again.dispose();
});
