/**
 * `overlyx repo link` (packages/cli/bin/overlyx.js): a clone of an OverLyX project inside another git
 * repository (a paper as a submodule of the code) shares its README.md and AGENTS.md with that
 * repository. The clone is the source of truth: the repository gets relative symlinks, every commit of it
 * carries the files' contents as ordinary blobs (staged by the pre-commit hook `.overlyx/link.sh` installs),
 * `git status` stays clean (skip-worktree entries of a sparse checkout that expects them), checkout / pull
 * / merge / rebase update the index entry only, a change both sides made is resolved with the clone's file
 * (merge driver), existing hooks keep running, a fresh clone reproduces it all with
 * `sh .overlyx/link.sh install`, and `repo unlink` puts ordinary files back. No server is involved.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { existsSync, lstatSync, mkdirSync, readFileSync, readlinkSync, rmSync, writeFileSync, chmodSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';

const ROOT = join(process.env.OVERLYX_SCRATCH ?? tmpdir(), `overlyx-link-test-${process.pid}`);
rmSync(ROOT, { recursive: true, force: true });
mkdirSync(ROOT, { recursive: true });
const CLI = fileURLToPath(new URL('../packages/cli/bin/overlyx.js', import.meta.url));
const execFileP = promisify(execFile);

// git isolated from the developer's configuration (hooks path, sparse settings, identity)
writeFileSync(join(ROOT, 'gitconfig'), '[user]\n\tname = Ada\n\temail = ada@example.org\n[init]\n\tdefaultBranch = main\n[protocol "file"]\n\tallow = always\n');
const env = { ...process.env, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: join(ROOT, 'gitconfig'), GIT_TERMINAL_PROMPT: '0', OVERLYX_CONFIG_DIR: join(ROOT, 'config') };
const run = (cmd: string, args: string[], cwd: string) => execFileP(cmd, args, { cwd, env, encoding: 'utf8' });
const git = async (dir: string, ...args: string[]) => (await run('git', args, dir)).stdout.trim();
/** git with stderr too (hooks and the merge driver report there); throws like execFile on failure */
const gitAll = async (dir: string, ...args: string[]) => { const r = await run('git', args, dir); return r.stdout + r.stderr; };
const cli = (cwd: string, ...args: string[]) => run(process.execPath, [CLI, ...args], cwd);
const commitAll = async (dir: string, message: string) => { await git(dir, 'add', '-A'); await git(dir, 'commit', '-q', '-m', message); };
const isLink = (p: string, target: string) => existsSync(p) && lstatSync(p).isSymbolicLink() && readlinkSync(p) === target;
const isFile = (p: string) => existsSync(p) && lstatSync(p).isFile();
const read = (p: string) => readFileSync(p, 'utf8');
/** `git status --porcelain` without the paths the test does not care about (the submodule, the marker file) */
const status = async (dir: string) => (await run('git', ['status', '--porcelain', '--untracked-files=all'], dir)).stdout.split('\n').filter(l => l && !/ paper$|\.marker$/.test(l));

const upstream = join(ROOT, 'upstream.git');   // the code repository's remote
const project = join(ROOT, 'project.git');     // the OverLyX project's remote (stands in for overlyx.app)
const outer = join(ROOT, 'outer');             // a clone of the code repository, the paper as a submodule
const paper = join(outer, 'paper');

beforeAll(async () => {
  await git(ROOT, 'init', '-q', '--bare', 'upstream.git');
  await git(ROOT, 'init', '-q', '--bare', 'project.git');
  const seed = join(ROOT, 'seed'); mkdirSync(seed);
  await git(seed, 'init', '-q');
  writeFileSync(join(seed, 'AGENTS.md'), 'project agents\n');
  writeFileSync(join(seed, 'main.tex'), '\\documentclass{article}\\begin{document}x\\end{document}\n');
  await commitAll(seed, 'the paper');
  await git(seed, 'push', '-q', project, 'HEAD:main');
  await git(ROOT, 'clone', '-q', upstream, 'outer');
  writeFileSync(join(outer, 'README.md'), 'outer readme\n');
  writeFileSync(join(outer, 'train.py'), 'print(1)\n');
  await commitAll(outer, 'code');
  await git(outer, 'submodule', 'add', '-q', project, 'paper');
  await commitAll(outer, 'the paper as a submodule');
  await git(outer, 'push', '-q', 'origin', 'main');
  // a hook of the repository's own, which must keep running
  writeFileSync(join(outer, '.git', 'hooks', 'pre-commit'), '#!/bin/sh\necho ran > .marker\n');
  chmodSync(join(outer, '.git', 'hooks', 'pre-commit'), 0o755);
});

afterAll(() => rmSync(ROOT, { recursive: true, force: true }));

describe('overlyx repo link: a clone inside another repository', () => {
  it('moves the files into the clone, links them, keeps git status clean; a commit carries their contents as files; the existing hook keeps running', async () => {
    const r = await cli(outer, 'repo', 'link', 'paper');
    expect(r.stdout).toContain('Linked README.md, AGENTS.md');
    expect(read(join(paper, 'README.md'))).toBe('outer readme\n');      // adopted by the clone, which lacked it
    expect(isLink(join(outer, 'README.md'), 'paper/README.md')).toBe(true);
    expect(isLink(join(outer, 'AGENTS.md'), 'paper/AGENTS.md')).toBe(true);
    expect(read(join(outer, '.overlyx', 'links'))).toBe('README.md paper/README.md\nAGENTS.md paper/AGENTS.md\n');
    expect(read(join(outer, '.overlyx', 'link.sh'))).toMatch(/^#!\/bin\/sh\n# overlyx-link script v\d+/);
    expect(await git(outer, 'ls-files', '-t', 'README.md', 'AGENTS.md')).toBe('S AGENTS.md\nS README.md');
    // the new file is staged (an index entry is what carries the skip-worktree bit); nothing else about the two paths
    expect(await status(outer)).toEqual(['A  AGENTS.md', '?? .overlyx/link.sh', '?? .overlyx/links']);
    expect(isFile(join(outer, '.git', 'hooks', 'pre-commit.before-overlyx-link'))).toBe(true);

    await commitAll(paper, 'readme in the project');
    await commitAll(outer, 'link');
    expect(await git(outer, 'ls-tree', 'HEAD', 'README.md', 'AGENTS.md')).toMatch(/^100644 blob \w+\tAGENTS.md\n100644 blob \w+\tREADME.md$/);
    expect(await git(outer, 'show', 'HEAD:README.md')).toBe('outer readme');
    expect(await git(outer, 'show', 'HEAD:AGENTS.md')).toBe('project agents');
    expect(read(join(outer, '.marker'))).toBe('ran\n');                 // the hook that was there before
    expect(await status(outer)).toEqual([]);
    expect(isLink(join(outer, 'README.md'), 'paper/README.md')).toBe(true);
    // idempotent
    await cli(outer, 'repo', 'link', 'paper');
    expect(await status(outer)).toEqual([]);
  });

  it('an edit in the clone shows nothing here and reaches the next commit — commit -a and a commit of chosen paths alike', async () => {
    writeFileSync(join(paper, 'README.md'), 'readme v2\n');
    writeFileSync(join(outer, 'train.py'), 'print(2)\n');
    expect(await status(outer)).toEqual([' M train.py']);
    await git(outer, 'commit', '-q', '-am', 'v2');
    expect(await git(outer, 'show', 'HEAD:README.md')).toBe('readme v2');
    expect(await status(outer)).toEqual([]);
    writeFileSync(join(paper, 'README.md'), 'readme v3\n');
    writeFileSync(join(outer, 'train.py'), 'print(3)\n');
    await git(outer, 'commit', '-q', '-m', 'v3', '--', 'train.py');
    expect(await git(outer, 'show', 'HEAD:README.md')).toBe('readme v3');
    expect(await status(outer)).toEqual([]);                            // the post-commit hook re-synced the index
    expect(await git(outer, 'diff', '--cached', '--stat')).toBe('');
    await git(outer, 'push', '-q', 'origin', 'main');
  });

  it('a checkout and a pull update the index entry only: the symlinks stay; a received change the clone lacks is pointed out; changed on both sides, the clone wins', async () => {
    // somebody edits README.md on GitHub, on a branch
    const other = join(ROOT, 'other'); await git(ROOT, 'clone', '-q', upstream, 'other');
    await git(other, 'checkout', '-q', '-b', 'docs');
    writeFileSync(join(other, 'README.md'), 'edited on github\n');
    await commitAll(other, 'docs: readme');
    await git(other, 'push', '-q', 'origin', 'docs');
    await git(outer, 'fetch', '-q');
    const out = await gitAll(outer, 'checkout', 'docs');
    expect(out).toContain('README.md changed in the commits just received, differently from paper/README.md');
    expect(isLink(join(outer, 'README.md'), 'paper/README.md')).toBe(true);
    expect(await git(outer, 'show', 'HEAD:README.md')).toBe('edited on github');
    expect(read(join(paper, 'README.md'))).toBe('readme v3\n');
    expect(await status(outer)).toEqual([]);
    expect(await gitAll(outer, 'checkout', 'main')).not.toContain('differently');   // main's README.md is the clone's
    // the branch merged on GitHub, meanwhile the clone changed too: the merge driver takes the clone's file, no conflict
    await git(other, 'checkout', '-q', 'main'); await git(other, 'merge', '-q', 'docs'); await git(other, 'push', '-q', 'origin', 'main');
    writeFileSync(join(paper, 'README.md'), 'readme v4\n');
    await git(outer, 'commit', '-q', '--allow-empty', '-m', 'v4');
    const pulled = await gitAll(outer, 'pull', '--no-rebase', '-q', 'origin', 'main');
    expect(pulled).toContain('README.md: changed on both sides; resolved with paper/README.md');
    expect(await git(outer, 'show', 'HEAD:README.md')).toBe('readme v4');
    expect(isLink(join(outer, 'README.md'), 'paper/README.md')).toBe(true);
    expect(await status(outer)).toEqual([]);
    // the same with a rebase
    writeFileSync(join(other, 'README.md'), 'edited on github again\n'); await commitAll(other, 'again');
    await git(other, 'push', '-q', 'origin', 'main');
    writeFileSync(join(paper, 'README.md'), 'readme v5\n');
    await git(outer, 'commit', '-q', '--allow-empty', '-m', 'v5');
    expect(await gitAll(outer, 'pull', '--rebase', '-q', 'origin', 'main')).toContain('resolved with paper/README.md');
    expect(await git(outer, 'show', 'HEAD:README.md')).toBe('readme v5');
    expect(isLink(join(outer, 'README.md'), 'paper/README.md')).toBe(true);
    expect(await status(outer)).toEqual([]);
    await git(outer, 'push', '-q', 'origin', 'main');
  });

  it('stash, reset --hard and a branch without the file leave or restore the symlink; check repairs what was replaced', async () => {
    writeFileSync(join(outer, 'train.py'), 'print(4)\n');
    await git(outer, 'stash', '-q'); await git(outer, 'stash', 'pop', '-q'); await git(outer, 'reset', '-q', '--hard'); await git(outer, 'checkout', '-qf', 'main');
    expect(isLink(join(outer, 'README.md'), 'paper/README.md')).toBe(true);
    expect(isLink(join(outer, 'AGENTS.md'), 'paper/AGENTS.md')).toBe(true);
    expect(await status(outer)).toEqual([]);
    // every commit carries the clone's files, so a branch without one needs a commit past the hook
    await git(outer, 'checkout', '-q', '-b', 'no-agents'); await git(outer, 'rm', '-q', '--sparse', 'AGENTS.md');
    await git(outer, 'commit', '-q', '-m', 'without AGENTS.md?');
    expect(await git(outer, 'show', 'HEAD:AGENTS.md')).toBe('project agents');
    await git(outer, 'rm', '-q', '--sparse', 'AGENTS.md'); await git(outer, 'commit', '-q', '--no-verify', '-m', 'without AGENTS.md');
    expect(await git(outer, 'ls-tree', 'HEAD', 'AGENTS.md')).toBe('');
    await git(outer, 'checkout', '-q', 'main');
    await git(outer, 'checkout', '-q', 'no-agents');
    expect(existsSync(join(outer, 'AGENTS.md'))).toBe(false);          // git removed the symlink with the entry; nothing was lost
    expect(await status(outer)).toEqual([]);
    await git(outer, 'checkout', '-q', 'main');
    expect(isLink(join(outer, 'AGENTS.md'), 'paper/AGENTS.md')).toBe(true);   // the post-checkout hook put it back
    expect(await status(outer)).toEqual([]);
    rmSync(join(outer, 'README.md')); writeFileSync(join(outer, 'AGENTS.md'), read(join(paper, 'AGENTS.md')));   // a copy instead of the link
    await run('sh', ['.overlyx/link.sh', 'check'], outer);
    expect(isLink(join(outer, 'README.md'), 'paper/README.md')).toBe(true);
    expect(isLink(join(outer, 'AGENTS.md'), 'paper/AGENTS.md')).toBe(true);
    rmSync(join(outer, 'AGENTS.md')); writeFileSync(join(outer, 'AGENTS.md'), 'something else\n');   // a file of its own instead of the link: refused, kept
    await expect(run('sh', ['.overlyx/link.sh', 'check'], outer)).rejects.toThrow(/regular file with content that is neither committed nor in paper\/AGENTS.md/);
    expect(read(join(outer, 'AGENTS.md'))).toBe('something else\n');
    rmSync(join(outer, 'AGENTS.md')); await run('sh', ['.overlyx/link.sh', 'check'], outer);
    expect(await status(outer)).toEqual([]);
  });

  it('a fresh clone has ordinary files and sets itself up with sh .overlyx/link.sh install', async () => {
    await git(paper, 'push', '-q', project, 'HEAD:main');
    const fresh = join(ROOT, 'fresh');
    await git(ROOT, 'clone', '-q', '--recurse-submodules', upstream, 'fresh');
    expect(isFile(join(fresh, 'README.md'))).toBe(true);
    expect(read(join(fresh, 'README.md'))).toBe('readme v5\n');
    await run('sh', ['.overlyx/link.sh', 'install'], fresh);
    expect(isLink(join(fresh, 'README.md'), 'paper/README.md')).toBe(true);
    expect(isLink(join(fresh, 'AGENTS.md'), 'paper/AGENTS.md')).toBe(true);
    expect(await status(fresh)).toEqual([]);
    writeFileSync(join(fresh, 'paper', 'README.md'), 'fresh edit\n');
    await git(fresh, 'commit', '-q', '--allow-empty', '-m', 'from the fresh clone');
    expect(await git(fresh, 'show', 'HEAD:README.md')).toBe('fresh edit');
    // without the submodule checked out, install refuses rather than treating the empty directory as the clone
    const bare = join(ROOT, 'bare-clone');
    await git(ROOT, 'clone', '-q', upstream, 'bare-clone');
    await expect(run('sh', ['.overlyx/link.sh', 'install'], bare)).rejects.toThrow(/paper is not a checked-out repository/);
    expect(isFile(join(bare, 'README.md'))).toBe(true);
  });

  it('refuses uncommitted changes that differ from the clone, a directory that is not inside another repository, and a name that is nowhere', async () => {
    const r = join(ROOT, 'refuse'); mkdirSync(r);
    await git(r, 'init', '-q');
    writeFileSync(join(r, 'README.md'), 'committed\n'); await commitAll(r, 'c');
    mkdirSync(join(r, 'doc')); await git(join(r, 'doc'), 'init', '-q'); writeFileSync(join(r, 'doc', 'README.md'), 'the clone\n'); await commitAll(join(r, 'doc'), 'd');
    writeFileSync(join(r, '.git', 'info', 'exclude'), 'doc/\n');
    writeFileSync(join(r, 'README.md'), 'local, uncommitted\n');
    await expect(cli(r, 'repo', 'link', 'doc')).rejects.toThrow(/README.md has uncommitted changes that differ from doc\/README.md/);
    expect(read(join(r, 'README.md'))).toBe('local, uncommitted\n');
    expect(existsSync(join(r, '.git', 'hooks', 'post-commit'))).toBe(false);
    await expect(cli(r, 'repo', 'link', 'doc', '--files', 'nowhere.md')).rejects.toThrow(/nowhere.md: neither/);
    const alone = join(ROOT, 'alone'); mkdirSync(alone); await git(alone, 'init', '-q');
    await expect(cli(ROOT, 'repo', 'link', 'alone')).rejects.toThrow(/not inside another git repository/);
    await expect(cli(ROOT, 'repo', 'link', join(r, 'doc', 'nothing'))).rejects.toThrow(/not a directory/);
  });

  it('unlink puts ordinary files back and restores the hooks and the configuration', async () => {
    const r = await cli(outer, 'repo', 'unlink', 'paper');
    expect(r.stdout).toContain('Unlinked');
    expect(isFile(join(outer, 'README.md'))).toBe(true);
    expect(read(join(outer, 'README.md'))).toBe('readme v5\n');
    expect(isFile(join(outer, 'AGENTS.md'))).toBe(true);
    expect(existsSync(join(outer, '.overlyx'))).toBe(false);
    expect(await git(outer, 'ls-files', '-t', 'README.md', 'AGENTS.md')).toBe('H AGENTS.md\nH README.md');
    expect(await status(outer)).toEqual([' D .overlyx/link.sh', ' D .overlyx/links']);
    expect(read(join(outer, '.git', 'hooks', 'pre-commit'))).toBe('#!/bin/sh\necho ran > .marker\n');
    expect(existsSync(join(outer, '.git', 'hooks', 'post-commit'))).toBe(false);
    expect(existsSync(join(outer, '.git', 'info', 'sparse-checkout'))).toBe(false);
    await expect(git(outer, 'config', '--get', 'core.sparseCheckout')).rejects.toThrow();
    await expect(git(outer, 'config', '--get', 'merge.overlyx-link.driver')).rejects.toThrow();
    await commitAll(outer, 'unlinked');
    expect(await status(outer)).toEqual([]);
  });
});
