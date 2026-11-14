/**
 * The sync never adds NFS's renamed open files (.nfs…), editor swap, lock and backup files,
 * .DS_Store or a clone's own conflict copies to a project (they appeared in projects, Nov 2026): the
 * clone does not send them (cli overlyx.js syncIgnored, in localPaths) and the server refuses a new
 * one (server sync.ts syncIgnored, in applyFile). Both sides decide alike.
 */
import { it, expect, vi } from 'vitest';

vi.hoisted(() => {
  const root = (process.env.TMPDIR ?? '/tmp') + '/overlyx-sync-ignore-test';
  process.env.OVERLYX_DATA_DIR = root + '/data';
  process.env.OVERLYX_PROJECTS_DIR = root + '/projects';
});
const server = await import('../packages/server/src/sync.ts');
const cli = await import('../packages/cli/bin/overlyx.js');

const IGNORED = [
  'figures/.nfs0000000006fde4ba0000137e', '.nfs8a2b', 'README (conflict, laptop 2026-11-13 15.40).md',
  'figures/plot (conflict 2, u435d.example.org 2026-11-13 15.37).svg', 'model_4 (conflict, host 2026-11-14 10.42).md',
  '.main.tex.swp', 'sec/.intro.tex.swo', '.#main.tex', '#main.tex#', 'main.tex~', '.DS_Store', 'img/.DS_Store',
];
const KEPT = ['main.tex', 'README.md', 'figures/plot.svg', '.gitignore', 'notes/nfs.md', 'conflict.tex', 'a (draft).tex', 'swp.tex', '.latexmkrc', 'refs.bib'];

it('ignores temporary, backup and conflict files, on both sides alike', () => {
  for (const p of IGNORED) { expect(server.syncIgnored(p), p).toBe(true); expect(cli.syncIgnored(p), p).toBe(true); }
  for (const p of KEPT) { expect(server.syncIgnored(p), p).toBe(false); expect(cli.syncIgnored(p), p).toBe(false); }
});
