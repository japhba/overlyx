/**
 * A document is forgotten only when its file holds what it has. DocManager.unload looked at the
 * save's error alone: a save that wrote nothing without one (the file gone a moment ago — the
 * watcher's removal keeps the text as a version 1.5 s later, but the document was forgotten by then)
 * or edits that came in during the save left it dirty, and it went — with its persist timer — so
 * the edits were in no file, no stored state and no version. reset and closeProject did the same.
 */
import { it, expect, vi } from 'vitest';
import { chmodSync, mkdirSync, rmSync, unlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const ROOT = vi.hoisted(() => {
  const root = (process.env.TMPDIR ?? '/tmp') + '/overlyx-unload-dirty-test';
  process.env.OVERLYX_DATA_DIR = root + '/data';
  process.env.OVERLYX_PROJECTS_DIR = root + '/projects';
  return root;
});
rmSync(ROOT, { recursive: true, force: true });
mkdirSync(join(ROOT, 'projects', 'u', 'p'), { recursive: true });

const { manager } = await import('../packages/server/src/docs.ts');
const { config } = await import('../packages/server/src/config.ts');
const docText = (...pars: string[]) => '\\documentclass{article}\n\\begin{document}\n' + pars.map(t => `${t}\n\n`).join('') + '\\end{document}\n';
const dir = join(ROOT, 'projects', 'u', 'p');
const versions = (id: string) => manager.listVersions(id).map(v => ({ name: v.name, text: manager.getVersion(id, v.id)!.lyx }));

it('unload keeps a document whose file was removed with edits it does not have; they end up as a version', async () => {
  expect(config.dataDir.startsWith(ROOT)).toBe(true);
  vi.spyOn(console, 'log').mockImplementation(() => undefined);
  writeFileSync(join(dir, 'a.tex'), docText('one', 'two'));
  const doc = await manager.open('u/p/a.tex');
  doc.loadFromLyx(doc.parse(docText('one', 'two THE LAST EDIT')), 'test');
  doc.scheduleSave();
  await new Promise(r => setTimeout(r, 300));    // (the watcher settles on the file)
  unlinkSync(join(dir, 'a.tex'));                // removed (a tool, a sync) just before the unload timer
  await manager.unload('u/p/a.tex');
  expect(manager.docs.get('u/p/a.tex')).toBe(doc);
  // the watcher's removal closes it with its text kept
  await vi.waitFor(() => expect(manager.docs.has('u/p/a.tex')).toBe(false), { timeout: 12_000, interval: 100 });
  expect(versions('u/p/a.tex').some(v => v.text.includes('THE LAST EDIT'))).toBe(true);
}, 20_000);

it('reset and closeProject keep as a version what could not be written', async () => {
  vi.spyOn(console, 'error').mockImplementation(() => undefined);
  writeFileSync(join(dir, 'b.tex'), docText('one', 'two'));
  writeFileSync(join(dir, 'c.tex'), docText('one', 'two'));
  chmodSync(dir, 0o555);                         // saves fail from here on (a full disk, permissions)
  try {
    for (const [id, edit] of [['u/p/b.tex', 'RESET'], ['u/p/c.tex', 'CLOSED']] as const) {
      const doc = await manager.open(id);
      doc.loadFromLyx(doc.parse(docText('one', `two ${edit} EDIT`)), 'test');
      doc.scheduleSave();
    }
    await manager.reset('u/p/b.tex');
    expect(versions('u/p/b.tex').some(v => v.text.includes('two RESET EDIT'))).toBe(true);
    await manager.closeProject('u/p');
    expect(manager.docs.has('u/p/c.tex')).toBe(false);
    expect(versions('u/p/c.tex').some(v => v.text.includes('two CLOSED EDIT'))).toBe(true);
  } finally { chmodSync(dir, 0o755); }
});
