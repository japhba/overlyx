import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

// as in the extension's bundle: importing the CLI does not run its command line
vi.hoisted(() => { process.env.OVERLYX_CLI_LIBRARY = '1'; });
import { attachDetachedHead, enclosingRepo, addProjectSubmodule, ignoreInRepo } from '../packages/cli/bin/overlyx.js';

let dir: string;
const env = { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1', GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t' };
const git = (...args: string[]) => execFileSync('git', args, { cwd: dir, env, encoding: 'utf8' }).trim();
const commit = (text: string) => { fs.writeFileSync(path.join(dir, 'main.tex'), text); git('add', '-A'); git('commit', '-q', '-m', text); return git('rev-parse', 'HEAD'); };
const head = () => { try { return git('symbolic-ref', '-q', 'HEAD'); } catch { return null; } };

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'overlyx-attach-'));
  git('init', '-q', '-b', 'main');
});
afterEach(() => { fs.rmSync(dir, { recursive: true, force: true }); });

describe('a detached HEAD onto the server\'s branch (sync engine, attachDetachedHead)', () => {
  it('attaches when the branch is at HEAD, and keeps uncommitted changes as they are', async () => {
    const b = (commit('a\n'), commit('b\n'));
    git('checkout', '-q', '--detach');
    fs.writeFileSync(path.join(dir, 'main.tex'), 'b\nunsaved\n');
    expect(await attachDetachedHead(dir, 'main')).toBeNull();
    expect(head()).toBe('refs/heads/main');
    expect(git('rev-parse', 'main')).toBe(b);
    expect(fs.readFileSync(path.join(dir, 'main.tex'), 'utf8')).toBe('b\nunsaved\n');
    expect(git('status', '--porcelain')).toBe('M main.tex');
  });

  it('moves a branch that is behind HEAD forward (a submodule updated to a newer commit)', async () => {
    const a = commit('a\n'), b = commit('b\n');
    git('checkout', '-q', '--detach');
    git('branch', '-f', 'main', a);
    expect(await attachDetachedHead(dir, 'main')).toBeNull();
    expect(head()).toBe('refs/heads/main');
    expect(git('rev-parse', 'main')).toBe(b);
    expect(git('reflog', '-1', '--format=%gs', 'main')).toContain('overlyx sync');
  });

  it('makes the branch at HEAD when there is none', async () => {
    const a = commit('a\n');
    git('checkout', '-q', '--detach');
    git('branch', '-q', '-m', 'main', 'other');
    expect(await attachDetachedHead(dir, 'main')).toBeNull();
    expect(head()).toBe('refs/heads/main');
    expect(git('rev-parse', 'main')).toBe(a);
  });

  it('stays detached when the branch has commits HEAD lacks — nothing is lost', async () => {
    const a = commit('a\n'), b = commit('b\n');
    git('checkout', '-q', a);
    expect(await attachDetachedHead(dir, 'main')).toBe('commits');
    expect(head()).toBeNull();
    expect(git('rev-parse', 'main')).toBe(b);
    expect(fs.readFileSync(path.join(dir, 'main.tex'), 'utf8')).toBe('a\n');
  });

  it('leaves a HEAD that is on a branch alone (an unborn one too)', async () => {
    expect(await attachDetachedHead(dir, 'main')).toBe('attached already');
    commit('a\n');
    expect(await attachDetachedHead(dir, 'main')).toBe('attached already');
    expect(head()).toBe('refs/heads/main');
  });
});

describe('a project cloned into a folder of a git repository (enclosingRepo, addProjectSubmodule, ignoreInRepo)', () => {
  // the project's address without a server: host file://<root>, so <root>/git/<owner>/<name>.git is a bare repository
  let srv: string;
  const fileEnv = { GIT_CONFIG_COUNT: '1', GIT_CONFIG_KEY_0: 'protocol.file.allow', GIT_CONFIG_VALUE_0: 'always' };
  beforeEach(() => {
    srv = fs.mkdtempSync(path.join(os.tmpdir(), 'overlyx-srv-'));
    const bare = path.join(srv, 'git', 'ada', 'my-paper.git');
    execFileSync('git', ['init', '-q', '--bare', '-b', 'main', bare], { env });
    const seed = fs.mkdtempSync(path.join(os.tmpdir(), 'overlyx-seed-'));
    execFileSync('git', ['clone', '-q', bare, seed], { env });
    fs.writeFileSync(path.join(seed, 'main.tex'), 'paper\n');
    for (const a of [['add', '-A'], ['commit', '-q', '-m', 'paper'], ['push', '-q', 'origin', 'HEAD:main']]) execFileSync('git', a, { cwd: seed, env });
    fs.rmSync(seed, { recursive: true, force: true });
    commit('code\n');
    fs.mkdirSync(path.join(dir, 'docs'));
    for (const [k, v] of Object.entries({ ...env, ...fileEnv })) vi.stubEnv(k, v as string);
  });
  afterEach(() => { vi.unstubAllEnvs(); fs.rmSync(srv, { recursive: true, force: true }); });

  it('finds the repository a folder is in, and none outside one', async () => {
    expect(await enclosingRepo(path.join(dir, 'docs'))).toBe(fs.realpathSync(dir));
    expect(await enclosingRepo(srv)).toBeNull();
  });

  it('adds the project as a submodule named after it, on its branch, with no account in .gitmodules', async () => {
    const sub = await addProjectSubmodule(`file://${srv}`, null as never, 'ada/my-paper', path.join(dir, 'docs'));
    expect(sub).toBe(path.join(dir, 'docs', 'my-paper'));
    expect(fs.readFileSync(path.join(sub, 'main.tex'), 'utf8')).toBe('paper\n');
    const modules = fs.readFileSync(path.join(dir, '.gitmodules'), 'utf8');
    expect(modules).toContain('path = docs/my-paper');
    expect(modules).toContain(`url = file://${srv}/git/ada/my-paper.git`);
    expect(git('status', '--porcelain')).toMatch(/^A {2}\.gitmodules\nA {2}docs\/my-paper$/m);
    expect(execFileSync('git', ['symbolic-ref', '--short', 'HEAD'], { cwd: sub, env, encoding: 'utf8' }).trim()).toBe('main');
    await expect(addProjectSubmodule(`file://${srv}`, null as never, 'ada/my-paper', path.join(dir, 'docs'))).rejects.toThrow(/exists already/);
  });

  it('puts an ignored clone into .gitignore once', async () => {
    fs.writeFileSync(path.join(dir, '.gitignore'), 'build/');
    const clone = path.join(dir, 'docs', 'my-paper');
    fs.mkdirSync(clone);
    expect(await ignoreInRepo(dir, clone)).toBe(true);
    expect(fs.readFileSync(path.join(dir, '.gitignore'), 'utf8')).toBe('build/\n/docs/my-paper/\n');
    expect(await ignoreInRepo(dir, clone)).toBe(false);
  });
});
