/**
 * A change on disk (an agent writing the file, git, desktop LyX, a synced clone) is merged three-way
 * into the open document; where it and unsaved typing here changed the same paragraph, the disk wins
 * and the document as it was here is kept as a version "before a change on disk" (as HtmlDoc does), so
 * the typing can be restored from history. Typing in the *next* paragraph is kept (core merge.ts
 * mergeApart, since 21 Nov 2026 — before, a region grown over touching changes went to the disk whole).
 */
import { it, expect, vi } from 'vitest';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const ROOT = vi.hoisted(() => {
  const root = (process.env.TMPDIR ?? '/tmp') + '/overlyx-disk-merge-version-test';
  process.env.OVERLYX_DATA_DIR = root + '/data';
  process.env.OVERLYX_PROJECTS_DIR = root + '/projects';
  return root;
});
rmSync(ROOT, { recursive: true, force: true });
mkdirSync(join(ROOT, 'projects', 'u', 'p'), { recursive: true });

const { manager } = await import('../packages/server/src/docs.ts');
const { db } = await import('../packages/server/src/db.ts');
const doc = (...p: string[]) => '\\documentclass{article}\n\\begin{document}\n' + p.map(x => x + '\n\n').join('') + '\\end{document}\n';
const file = (name: string) => join(ROOT, 'projects', 'u', 'p', name);
const versions = (id: string) => db.prepare("SELECT name, lyx FROM versions WHERE doc_id = ? AND name = 'before a change on disk'").all(id) as { name: string; lyx: string }[];
const PARS = ['Alpha one.', 'Beta two.', 'Gamma three.', 'Delta four.', 'Epsilon five.'];
const DISK = doc('Alpha one.', 'Beta two CHANGED ON DISK.', 'Gamma three.', 'Delta four.', 'Epsilon five.');

for (const [name, at, lost] of [['the next paragraph', 2, false], ['the same paragraph', 1, true], ['a distant paragraph', 4, false]] as const) {
  it(`typing in ${name} as the file changes on disk: ${lost ? 'kept as a version' : 'merged, no version'}`, async () => {
    vi.spyOn(console, 'log').mockImplementation(() => undefined);
    const id = `u/p/${at}.tex`;
    writeFileSync(file(`${at}.tex`), doc(...PARS));
    const d = await manager.open(id);
    const typed = PARS.map((p, i) => (i === at ? p.replace('.', ' TYPED BY THE USER.') : p));
    d.loadFromLyx(d.parse(doc(...typed)), 'test');
    writeFileSync(file(`${at}.tex`), DISK);
    expect(d.absorbExternalChange()).toBe(true);
    expect(d.toText()).toContain('CHANGED ON DISK');
    expect(d.toText().includes('TYPED BY THE USER')).toBe(!lost);
    const v = versions(id);
    if (lost) { expect(v.length).toBe(1); expect(v[0].lyx).toContain('TYPED BY THE USER'); }
    else expect(v.length).toBe(0);
    d.dispose();
  });
}
