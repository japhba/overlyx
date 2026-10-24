/**
 * Working copies as agent uids get them (agentwork.ts mirrorFile; agentusers.ts): the project's
 * other files hard-linked into the copy — the agent uid reads them without reaching the project —
 * taken for what they are on the way back (nothing to copy), a replaced one copied back and linked
 * again, and the server's bookkeeping beside the copy for root's eyes only.
 * OVERLYX_AGENT_HARDLINKS=1 makes the server's own user link the way agent uids get it.
 */
import { describe, it, expect, afterAll } from 'vitest';
import { lstatSync, mkdirSync, readFileSync, rmSync, statSync, unlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const ROOT = join(process.env.OVERLYX_SCRATCH ?? tmpdir(), 'overlyx-agentwork-links-test');
rmSync(ROOT, { recursive: true, force: true });
const PROJ = join(ROOT, 'projects', 'owner', 'p');
mkdirSync(join(PROJ, 'figs'), { recursive: true });
process.env.OVERLYX_DATA_DIR = join(ROOT, 'data');
process.env.OVERLYX_PROJECTS_DIR = join(ROOT, 'projects');
process.env.OVERLYX_AGENT_USERS = 'off';
process.env.OVERLYX_AGENT_HARDLINKS = '1';

const { prepareWorkspace, syncWorkspace } = await import('../packages/server/src/agentwork.ts');
const { config } = await import('../packages/server/src/config.ts');
const { createUser } = await import('../packages/server/src/auth.ts');
const { registerProject } = await import('../packages/server/src/access.ts');
registerProject('owner/p', createUser('owner', 'Owner', 'pw').id);

writeFileSync(join(PROJ, 'paper.tex'), '\\documentclass{article}\n\\begin{document}\nSee \\includegraphics{figs/plot.png}.\n\\end{document}\n');
writeFileSync(join(PROJ, 'figs', 'plot.png'), Buffer.from([0x89, 0x50, 0x4e, 0x47, 1, 2, 3]));

afterAll(() => rmSync(ROOT, { recursive: true, force: true }));

const T = 'thread-links-1';

describe('working copies with hard-linked project files', () => {
  it('links the project\'s file itself into the copy, and finds nothing to take back from it', async () => {
    const dir = await prepareWorkspace(T, 'owner/p', 1);
    const copy = lstatSync(join(dir, 'figs', 'plot.png')), live = statSync(join(PROJ, 'figs', 'plot.png'));
    expect(copy.isSymbolicLink()).toBe(false);
    expect([copy.dev, copy.ino]).toEqual([live.dev, live.ino]);
    expect(await syncWorkspace(T, 'owner/p', 1)).toEqual([]);
    // the bookkeeping beside the copy is root's alone
    expect(statSync(join(config.agentDir, 'agent-work', `${T}.json`)).mode & 0o077).toBe(0);
    expect(statSync(join(config.agentDir, 'agent-work', `${T}.base`)).mode & 0o077).toBe(0);
  });

  it('a file the agent put in place of the project\'s goes back to the project, and is linked again', async () => {
    const dir = await prepareWorkspace(T, 'owner/p', 1);
    unlinkSync(join(dir, 'figs', 'plot.png'));
    writeFileSync(join(dir, 'figs', 'plot.png'), Buffer.from([0x89, 0x50, 0x4e, 0x47, 9, 9]));
    const r = await syncWorkspace(T, 'owner/p', 1);
    expect(r.map(f => `${f.path}:${f.action}`)).toEqual(['figs/plot.png:copied']);
    expect([...readFileSync(join(PROJ, 'figs', 'plot.png'))]).toEqual([0x89, 0x50, 0x4e, 0x47, 9, 9]);
    const copy = lstatSync(join(dir, 'figs', 'plot.png')), live = statSync(join(PROJ, 'figs', 'plot.png'));
    expect(copy.ino).toBe(live.ino);
    expect(await syncWorkspace(T, 'owner/p', 1)).toEqual([]);
  });
});
