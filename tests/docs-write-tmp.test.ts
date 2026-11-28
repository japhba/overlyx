/**
 * A save whose write fails half-way (a full disk) leaves no `<file>.overlyx-tmp` behind: the
 * temporary copy of the document took the room a retry needs, and stayed in the project for good.
 */
import { it, expect, vi } from 'vitest';
import fs, { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const ROOT = vi.hoisted(() => {
  const root = (process.env.TMPDIR ?? '/tmp') + '/overlyx-write-tmp-test';
  process.env.OVERLYX_DATA_DIR = root + '/data';
  process.env.OVERLYX_PROJECTS_DIR = root + '/projects';
  return root;
});
rmSync(ROOT, { recursive: true, force: true });
mkdirSync(join(ROOT, 'projects', 'u', 'p'), { recursive: true });

const { manager } = await import('../packages/server/src/docs.ts');
const docText = (...pars: string[]) => '\\documentclass{article}\n\\begin{document}\n' + pars.map(t => `${t}\n\n`).join('') + '\\end{document}\n';
const file = join(ROOT, 'projects', 'u', 'p', 'a.tex');

it('a write that fails half-way leaves the file as it was and no temporary copy', async () => {
  vi.spyOn(console, 'error').mockImplementation(() => undefined);
  vi.spyOn(console, 'log').mockImplementation(() => undefined);
  writeFileSync(file, docText('one'));
  const doc = await manager.open('u/p/a.tex');
  doc.loadFromLyx(doc.parse(docText('one', 'two')), 'test');
  const write = vi.spyOn(fs, 'writeSync').mockImplementationOnce(() => { throw Object.assign(new Error('ENOSPC: no space left on device, write'), { code: 'ENOSPC' }); });
  expect(await doc.saveToFile()).toBe(false);
  write.mockRestore();
  expect(doc.saveError).toContain('ENOSPC');
  expect(existsSync(file + '.overlyx-tmp')).toBe(false);
  expect(readFileSync(file, 'utf8')).toBe(docText('one'));
  expect(await doc.saveToFile()).toBe(true);
  expect(readFileSync(file, 'utf8')).toContain('two');
  doc.dispose();
});
