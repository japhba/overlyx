/**
 * The Agent panel's working copy (packages/server/src/agentwork.ts): the live project mirrored
 * in, the agent's edits taken back — documents as word-level tracked changes merged with the
 * live document, other files copied, build output left behind.
 */
import { describe, it, expect, afterAll } from 'vitest';
import { existsSync, lstatSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const ROOT = join(process.env.OVERLYX_SCRATCH ?? tmpdir(), 'overlyx-agentwork-test');
rmSync(ROOT, { recursive: true, force: true });
const PROJ = join(ROOT, 'projects', 'owner', 'cv');
mkdirSync(join(PROJ, 'figs'), { recursive: true });
process.env.OVERLYX_DATA_DIR = join(ROOT, 'data');
process.env.OVERLYX_PROJECTS_DIR = join(ROOT, 'projects');

const { prepareWorkspace, syncWorkspace, workspaceDir } = await import('../packages/server/src/agentwork.ts');
const { manager } = await import('../packages/server/src/docs.ts');
const { createUser } = await import('../packages/server/src/auth.ts');
const { registerProject } = await import('../packages/server/src/access.ts');
registerProject('owner/cv', createUser('owner', 'Owner', 'pw').id);

const tex = (body: string) => `\\documentclass{article}\n\\begin{document}\n${body}\n\\end{document}\n`;
writeFileSync(join(PROJ, 'cv.tex'), tex('\\section*{Education}\n\nPhD in Neuroscience, UCL \\hfill 2021--2025.\n\nSecond paragraph stays.'));
writeFileSync(join(PROJ, 'refs.bib'), '@article{a, title={A}}\n');
writeFileSync(join(PROJ, 'figs', 'plot.png'), Buffer.from([0x89, 0x50, 0x4e, 0x47, 0, 1, 2]));

afterAll(() => rmSync(ROOT, { recursive: true, force: true }));

const T = 'thread-test-1';

describe('agent working copy', () => {
  it('mirrors documents and text files as copies, binaries as read-only links', async () => {
    const dir = await prepareWorkspace(T, 'owner/cv', 1);
    expect(dir).toBe(workspaceDir(T, 'owner/cv'));
    expect(readFileSync(join(dir, 'cv.tex'), 'utf8')).toContain('2021--2025');
    expect(readFileSync(join(dir, 'refs.bib'), 'utf8')).toContain('@article{a');
    expect(lstatSync(join(dir, 'figs', 'plot.png')).isSymbolicLink()).toBe(true);
  });

  it("a patched document reaches the live document as tracked changes, merged with people's edits", async () => {
    const dir = workspaceDir(T, 'owner/cv');
    const doc = await manager.open('owner/cv/cv.tex');
    // meanwhile somebody edits another paragraph of the live document
    const live = doc.toText();
    doc.loadFromLyx(doc.parse(live.replace('Second paragraph stays.', 'Second paragraph stays, edited live.')), 'test');
    // the agent patches its copy (which still has the old second paragraph)
    const copy = readFileSync(join(dir, 'cv.tex'), 'utf8');
    writeFileSync(join(dir, 'cv.tex'), copy.replace('2021--2025', '2021--2026'));
    const r = await syncWorkspace(T, 'owner/cv', 1);
    expect(r).toEqual([{ path: 'cv.tex', action: 'tracked', inserted: 1, deleted: 1 }]);
    const text = doc.toText();
    expect(text).toMatch(/2021--202\\lyxdeleted\{Agent panel \(MCP\)\}\{[^}]*\}\{5\}\\lyxadded\{Agent panel \(MCP\)\}\{[^}]*\}\{6\}/);
    expect(text).toContain('Second paragraph stays, edited live.');
    // nothing new in the copy: a second sync does nothing
    expect(await syncWorkspace(T, 'owner/cv', 1)).toEqual([]);
  });

  it('the next turn mirrors the live state (with the markup) again', async () => {
    const dir = await prepareWorkspace(T, 'owner/cv', 1);
    const copy = readFileSync(join(dir, 'cv.tex'), 'utf8');
    expect(copy).toContain('edited live');
    expect(copy).toContain('\\lyxadded{Agent panel (MCP)}');
    // refining its own change: re-derived, not stacked
    writeFileSync(join(dir, 'cv.tex'), copy.replace(/\\lyxadded\{Agent panel \(MCP\)\}\{[^}]*\}\{6\}/, '7'));
    await syncWorkspace(T, 'owner/cv', 1);
    const text = (await manager.open('owner/cv/cv.tex')).toText();
    expect(text.match(/\\lyx(added|deleted)\{Agent panel \(MCP\)\}\{[^}]*\}\{(.)\}/g)?.map(m => m.slice(-3))).toEqual(['{5}', '{7}']);
  });

  it('copies other files and new figures; leaves build output behind; never follows links', async () => {
    const dir = workspaceDir(T, 'owner/cv');
    writeFileSync(join(dir, 'refs.bib'), '@article{a, title={A}}\n@book{b, title={B}}\n');
    writeFileSync(join(dir, 'figs', 'new.pdf'), '%PDF-1.4 figure');
    writeFileSync(join(dir, 'cv.aux'), 'aux');
    writeFileSync(join(dir, 'cv.pdf'), '%PDF-1.4 build output');
    writeFileSync(join(dir, 'notes.md'), '# notes\n');
    const r = await syncWorkspace(T, 'owner/cv', 1);
    expect(r.map(f => `${f.path}:${f.action}`).sort()).toEqual(['figs/new.pdf:created', 'notes.md:created', 'refs.bib:copied']);
    expect(readFileSync(join(PROJ, 'refs.bib'), 'utf8')).toContain('@book{b');
    expect(existsSync(join(PROJ, 'figs', 'new.pdf'))).toBe(true);
    expect(existsSync(join(PROJ, 'cv.aux'))).toBe(false);
    expect(existsSync(join(PROJ, 'cv.pdf'))).toBe(false);
    expect(lstatSync(join(dir, 'figs', 'new.pdf')).isSymbolicLink()).toBe(true);   // a link to the project's file from now on
    expect(await syncWorkspace(T, 'owner/cv', 1)).toEqual([]);
  });

  it('what a restart left unsynced is taken over before the copy is refreshed', async () => {
    const dir = workspaceDir(T, 'owner/cv');
    const copy = readFileSync(join(dir, 'cv.tex'), 'utf8');
    writeFileSync(join(dir, 'cv.tex'), copy.replace('Second paragraph', 'The second paragraph'));
    await prepareWorkspace(T, 'owner/cv', 1);   // no sync in between (a missed notification)
    expect((await manager.open('owner/cv/cv.tex')).toText()).toMatch(/\\lyxdeleted\{Agent panel \(MCP\)\}\{[^}]*\}\{Second\}\\lyxadded\{Agent panel \(MCP\)\}\{[^}]*\}\{The second\} paragraph stays, edited live\./);
  });
});
