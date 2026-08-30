/**
 * Off-site mirror of the project repositories (packages/server/src/mirror.ts) against bare
 * repositories on disk standing in for the GitHub organisation (OVERLYX_MIRROR_URL): a project is
 * pushed with its history, pushed again only when its HEAD moved, skipped while paused, repository
 * names are made GitHub-safe, and a deleted project's mirror row goes away.
 */
import { describe, it, expect } from 'vitest';
import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileP = promisify(execFile);
const ROOT = join(process.env.OVERLYX_SCRATCH ?? tmpdir(), 'overlyx-mirror-test');
rmSync(ROOT, { recursive: true, force: true });
mkdirSync(join(ROOT, 'projects', 'My Paper v2'), { recursive: true });
writeFileSync(join(ROOT, 'projects', 'My Paper v2', 'main.tex'), '\\documentclass{article}\n\\begin{document}\nHello.\n\\end{document}\n');
process.env.OVERLYX_DATA_DIR = join(ROOT, 'data');
process.env.OVERLYX_PROJECTS_DIR = join(ROOT, 'projects');
process.env.OVERLYX_OWNER_EMAIL = 'owner@example.com';
process.env.OVERLYX_GIT_COMMIT_MS = '300';
process.env.OVERLYX_MIRROR_URL = `file://${join(ROOT, 'mirrors')}/{repo}.git`;
delete process.env.GITHUB_MIRROR_ORG; delete process.env.GITHUB_MIRROR_TOKEN;

const mirror = await import('../packages/server/src/mirror.ts');
const gitmod = await import('../packages/server/src/git.ts');
const access = await import('../packages/server/src/access.ts');
const { createUser } = await import('../packages/server/src/auth.ts');

createUser('jan', 'Jan Bauer', null, { email: 'owner@example.com', googleSub: 'g-jan' });
access.adoptProjects();
const PROJECT = 'My Paper v2';
const bare = join(ROOT, 'mirrors', 'My-Paper-v2.git');
const bareHead = async () => (await execFileP('git', ['-C', bare, 'rev-parse', 'main'])).stdout.trim();

describe('mirror', () => {
  it('names the repository after the project, GitHub-safe', () => {
    expect(mirror.repoNameFor('My Paper v2')).toBe('My-Paper-v2');
    expect(mirror.repoNameFor('Ideas (draft) #3')).toBe('Ideas-draft-3');
    expect(mirror.repoNameFor('recurrent_feature')).toBe('recurrent_feature');
    expect(mirror.repoNameFor('.hidden.git')).toBe('hidden-git');
    expect(mirror.mirrorConfigured()).toBe(true);
  });

  it('pushes the project with its history and records what was pushed', async () => {
    const st = await mirror.pushProject(PROJECT);
    expect(st.lastError).toBeNull();
    expect(st.lastPushAt).not.toBeNull();
    expect(st.behind).toBe(false);
    expect(existsSync(bare)).toBe(true);
    expect(await bareHead()).toBe(st.head);
    expect(st.lastHead).toBe(st.head);
  });

  it('pushes again only when HEAD moved', async () => {
    const before = await mirror.statusOf(PROJECT);
    await new Promise(r => setTimeout(r, 5));
    const same = await mirror.pushProject(PROJECT);
    expect(same.lastPushAt).toBe(before.lastPushAt);
    writeFileSync(join(ROOT, 'projects', PROJECT, 'main.tex'), '\\documentclass{article}\n\\begin{document}\nHello again.\n\\end{document}\n');
    await gitmod.commitProject(PROJECT, { message: 'edit' });
    expect((await mirror.statusOf(PROJECT)).behind).toBe(true);
    const after = await mirror.pushProject(PROJECT);
    expect(after.lastPushAt).toBeGreaterThan(before.lastPushAt!);
    expect(await bareHead()).toBe(after.head);
    expect(after.head).not.toBe(before.head);
  });

  it('a paused project is left alone until resumed', async () => {
    mirror.setMirrorEnabled(PROJECT, false);
    writeFileSync(join(ROOT, 'projects', PROJECT, 'notes.tex'), 'notes\n');
    await gitmod.commitProject(PROJECT, { message: 'notes' });
    const st = await mirror.pushProject(PROJECT);
    expect(st.enabled).toBe(false);
    expect(st.behind).toBe(true);
    expect(await bareHead()).toBe(st.lastHead);
    mirror.setMirrorEnabled(PROJECT, true);
    const pushed = await mirror.pushProject(PROJECT);
    expect(pushed.behind).toBe(false);
    expect(await bareHead()).toBe(pushed.head);
  });

  it('the sweeper covers every project and a deleted project loses its row', async () => {
    mkdirSync(join(ROOT, 'projects', 'second'), { recursive: true });
    writeFileSync(join(ROOT, 'projects', 'second', 'a.tex'), 'x\n');
    access.adoptProjects();
    await mirror.mirrorAll();
    expect(existsSync(join(ROOT, 'mirrors', 'second.git'))).toBe(true);
    expect(mirror.mirrorRow('second')?.last_head).toBeTruthy();
    await mirror.archiveMirror('second');
    expect(mirror.mirrorRow('second')).toBeUndefined();
  });
});
