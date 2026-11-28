/**
 * A project's file list is read when somebody asks for it, not when the projects are listed: the
 * routes that want one project's files (`listProjects().find(…)?.files` — a document's meta, a
 * project's landing page, the agents' file tools) used to walk every file of every account's
 * projects on the server's one thread first, and the start page's list those of projects the
 * account cannot open.
 */
import { it, expect, vi } from 'vitest';
import fs, { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const ROOT = vi.hoisted(() => {
  const root = (process.env.TMPDIR ?? '/tmp') + '/overlyx-projects-lazy-files-test';
  process.env.OVERLYX_DATA_DIR = root + '/data';
  process.env.OVERLYX_PROJECTS_DIR = root + '/projects';
  return root;
});
rmSync(ROOT, { recursive: true, force: true });
for (const p of ['ada/one', 'ada/two/figures', 'bob/three/notes']) mkdirSync(join(ROOT, 'projects', p), { recursive: true });
writeFileSync(join(ROOT, 'projects', 'ada/one/main.tex'), '\\documentclass{article}\n\\begin{document}\nOne.\n\\end{document}\n');
writeFileSync(join(ROOT, 'projects', 'ada/two/figures/plot.png'), 'x');
writeFileSync(join(ROOT, 'projects', 'bob/three/notes/a.md'), '# A\n');

const { db } = await import('../packages/server/src/db.ts');
const { config } = await import('../packages/server/src/config.ts');
const { listProjects } = await import('../packages/server/src/projects.ts');
for (const u of ['ada', 'bob']) db.prepare('INSERT INTO users (username, display_name, color, created_at) VALUES (?,?,?,?)').run(u, u, '#000', Date.now());

it('one project\'s files cost one project\'s walk', () => {
  expect(config.projectsDir.startsWith(ROOT)).toBe(true);
  const read = vi.spyOn(fs, 'readdirSync');
  const inProject = (p: string) => read.mock.calls.filter(c => String(c[0]).startsWith(join(ROOT, 'projects', p))).length;
  const list = listProjects();
  expect(list.map(p => p.name)).toEqual(['ada/one', 'ada/two', 'bob/three']);
  expect(inProject('ada/one') + inProject('ada/two') + inProject('bob/three')).toBe(0);
  const files = list.find(p => p.name === 'ada/one')!.files;
  expect(files.map(f => [f.path, f.kind])).toEqual([['main.tex', 'doc']]);
  expect(inProject('ada/one')).toBeGreaterThan(0);
  expect(inProject('ada/two') + inProject('bob/three')).toBe(0);
  // read once per listing; a copy of the project ({...p}, JSON) carries the files as before
  const n = inProject('ada/one');
  expect(list[0].files).toBe(files);
  expect(inProject('ada/one')).toBe(n);
  expect({ ...list[1] }.files.map(f => f.path)).toEqual(['figures', 'figures/plot.png']);
  expect(JSON.parse(JSON.stringify(list[2])).files.map((f: { path: string }) => f.path)).toEqual(['notes', 'notes/a.md']);
  expect(listProjects({ files: false }).every(p => p.files.length === 0)).toBe(true);
  read.mockRestore();
});
