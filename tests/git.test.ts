/**
 * Projects as git repositories (packages/server/src/git.ts): initialisation with a .gitignore and
 * an initial commit, OverLyX's own commits (attributed to the editors), access tokens, and the
 * smart-HTTP remote — a real `git clone` / `push` / `pull` against the router with Basic auth,
 * the project's roles (viewers cannot push), a push updating the working tree in place while
 * uncommitted changes in other files survive, and an open document absorbing a pushed change.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import http from 'node:http';
import express from 'express';

const ROOT = join(process.env.OVERLYX_SCRATCH ?? tmpdir(), 'overlyx-git-test');
rmSync(ROOT, { recursive: true, force: true });
mkdirSync(join(ROOT, 'projects', 'paper', 'figures'), { recursive: true });
mkdirSync(join(ROOT, 'clones'), { recursive: true });
process.env.OVERLYX_DATA_DIR = join(ROOT, 'data');
process.env.OVERLYX_PROJECTS_DIR = join(ROOT, 'projects');
process.env.OVERLYX_OWNER_EMAIL = 'owner@example.com';
process.env.OVERLYX_GIT_COMMIT_MS = '300';

const gitmod = await import('../packages/server/src/git.ts');
const access = await import('../packages/server/src/access.ts');
const { createUser, toSessionUser } = await import('../packages/server/src/auth.ts');
const { manager } = await import('../packages/server/src/docs.ts');
const { parseLyx } = await import('../packages/core/src/lyx/parser.ts');

const HEAD = `#LyX 2.5 created this file. For more info see https://www.lyx.org/
\\lyxformat 643
\\begin_document
\\begin_header
\\textclass article
\\end_header

\\begin_body
`;
const TAIL = `
\\end_body
\\end_document
`;
const par = (t: string) => `\n\\begin_layout Standard\n${t}\n\\end_layout\n`;
const docText = (...pars: string[]) => HEAD + pars.map(par).join('') + TAIL;
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));

const jan = toSessionUser(createUser('jan', 'Jan Bauer', null, { email: 'owner@example.com', googleSub: 'g-jan' }));
const bob = toSessionUser(createUser('bob', 'Bob Builder', 'bobs-password'));
const vera = toSessionUser(createUser('vera', 'Vera Viewer', 'veras-password'));

const PROJECT = join(ROOT, 'projects', 'paper');
/** git on the server's working tree / a clone (same environment rules as the server) */
/** (asynchronous: the test process is also the server — a blocking git would deadlock a clone) */
const execFileP = promisify(execFile);
const g = async (dir: string, ...args: string[]): Promise<string> => (await execFileP('git', ['-C', dir, ...args], {
  env: { ...process.env, GIT_CONFIG_COUNT: '1', GIT_CONFIG_KEY_0: 'safe.directory', GIT_CONFIG_VALUE_0: '*', GIT_TERMINAL_PROMPT: '0', GIT_AUTHOR_NAME: 'Local', GIT_AUTHOR_EMAIL: 'l@x', GIT_COMMITTER_NAME: 'Local', GIT_COMMITTER_EMAIL: 'l@x', HOME: ROOT },
  encoding: 'utf8',
})).stdout;

let server: http.Server;
let base = '';
let bobToken = '';
const url = (user: string, secret: string, project = 'paper') => `${base.replace('http://', `http://${user}:${encodeURIComponent(secret)}@`)}/git/${encodeURIComponent(project)}.git`;

beforeAll(async () => {
  writeFileSync(join(PROJECT, 'main.lyx'), docText('one', 'two', 'three'));
  writeFileSync(join(PROJECT, 'refs.bib'), '@article{a, title={A}}\n');
  writeFileSync(join(PROJECT, 'main.aux'), 'aux junk\n');
  writeFileSync(join(PROJECT, 'main.lyx~'), 'backup\n');
  writeFileSync(join(PROJECT, 'figures', 'plot.txt'), 'not really a plot\n');
  access.adoptProjects();                                   // paper -> jan
  access.addMember('paper', 'bob', 'edit', jan);
  access.addMember('paper', 'vera', 'view', jan);
  const app = express();
  app.use('/git', gitmod.gitRouter());
  server = http.createServer(app);
  await new Promise<void>(r => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
});
afterAll(async () => {
  await new Promise<void>(r => server.close(() => r()));
});

describe('repository', () => {
  it('is initialised with a .gitignore and an initial commit that skips build products and backups', async () => {
    await gitmod.ensureRepo('paper');
    expect(existsSync(join(PROJECT, '.git'))).toBe(true);
    expect(readFileSync(join(PROJECT, '.gitignore'), 'utf8')).toContain('*.aux');
    const files = (await g(PROJECT, 'ls-files')).trim().split('\n').sort();
    expect(files).toEqual(['.gitignore', 'figures/plot.txt', 'main.lyx', 'refs.bib']);
    expect(await g(PROJECT, 'log', '--format=%s')).toContain('Import "paper" into OverLyX');
    expect((await g(PROJECT, 'config', 'receive.denyCurrentBranch')).trim()).toBe('updateInstead');
    expect(existsSync(join(PROJECT, '.git', 'hooks', 'push-to-checkout'))).toBe(true);
    // idempotent, also for all projects
    await gitmod.ensureAllRepos();
    expect((await g(PROJECT, 'rev-list', '--count', 'HEAD')).trim()).toBe('1');
  });

  it('commits OverLyX writes, attributed to the people who edited', async () => {
    const doc = await manager.open('paper/main.lyx');
    doc.editors.add(bob.id);
    doc.loadFromLyx(parseLyx(docText('one', 'two edited by bob', 'three')), 'test');
    expect(await doc.saveToFile()).toBe(true);              // -> fileWrittenListeners -> touchProject (300 ms)
    for (let i = 0; i < 60 && (await g(PROJECT, 'rev-list', '--count', 'HEAD')).trim() === '1'; i++) await sleep(100);
    expect((await g(PROJECT, 'rev-list', '--count', 'HEAD')).trim()).toBe('2');
    expect((await g(PROJECT, 'log', '-1', '--format=%an <%ae>%n%cn%n%s%n%b')).trim()).toBe('Bob Builder <bob@overlyx.local>\nOverLyX\nUpdate main.lyx\nEdited in OverLyX by Bob Builder\n\nFiles:\n  main.lyx');
    expect((await g(PROJECT, 'status', '--porcelain')).trim()).toBe('');
    // nothing to commit: no commit
    expect(await gitmod.commitProject('paper')).toBe(false);
    const info = await gitmod.repoInfo('paper');
    expect(info.branch).toBe('main');
    expect(info.commits.length).toBe(2);
    expect(info.pending).toBe(0);
    // an explicit commit with a message, by a user
    writeFileSync(join(PROJECT, 'notes.tex'), '% notes\n');
    expect((await gitmod.repoInfo('paper')).pendingFiles).toEqual(['notes.tex']);
    expect(await gitmod.commitProject('paper', { message: 'Add notes', by: jan.id })).toBe(true);
    expect((await g(PROJECT, 'log', '-1', '--format=%an|%s')).trim()).toBe('Jan Bauer|Add notes');
  });
});

describe('access tokens', () => {
  it('are checked before the password; a revoked token stops working', () => {
    const t = gitmod.createToken(bob.id, 'laptop');
    bobToken = t.token;
    expect(t.token).toMatch(/^olx_[A-Za-z0-9_-]{30,}$/);
    expect(gitmod.listTokens(bob.id).map(x => x.name)).toEqual(['laptop']);
    expect(gitmod.userForCredentials('bob', t.token)?.username).toBe('bob');
    expect(gitmod.userForCredentials('bob', 'bobs-password')?.username).toBe('bob');
    expect(gitmod.userForCredentials('jan', t.token)).toBeNull();       // somebody else's token
    expect(gitmod.userForCredentials('bob', 'wrong')).toBeNull();
    expect(gitmod.userForCredentials('bob', '')).toBeNull();
    expect(gitmod.userForCredentials('nobody', t.token)).toBeNull();
    const t2 = gitmod.createToken(bob.id, 'old phone');
    expect(gitmod.deleteToken(bob.id, t2.id)).toBe(true);
    expect(gitmod.userForCredentials('bob', t2.token)).toBeNull();
    expect(gitmod.deleteToken(jan.id, t.id)).toBe(false);               // not yours
    // Google accounts have no password: only a token works
    const tj = gitmod.createToken(jan.id, 'jan laptop');
    expect(gitmod.userForCredentials('jan', tj.token)?.username).toBe('jan');
    expect(gitmod.userForCredentials('jan', 'anything')).toBeNull();
  });
});

describe('git over HTTP', () => {
  const clone = join(ROOT, 'clones', 'bob');

  it('refuses without credentials, with wrong ones, and for people without access', async () => {
    const r = await fetch(`${base}/git/paper.git/info/refs?service=git-upload-pack`);
    expect(r.status).toBe(401);
    expect(r.headers.get('www-authenticate')).toMatch(/^Basic/);
    const bad = await fetch(`${base}/git/paper.git/info/refs?service=git-upload-pack`, { headers: { authorization: 'Basic ' + Buffer.from('bob:nope').toString('base64') } });
    expect(bad.status).toBe(401);
    const stranger = toSessionUser(createUser('eve', 'Eve', 'eves-password'));
    void stranger;
    const no = await fetch(`${base}/git/paper.git/info/refs?service=git-upload-pack`, { headers: { authorization: 'Basic ' + Buffer.from('eve:eves-password').toString('base64') } });
    expect(no.status).toBe(403);
    const missing = await fetch(`${base}/git/nope.git/info/refs?service=git-upload-pack`, { headers: { authorization: 'Basic ' + Buffer.from('bob:bobs-password').toString('base64') } });
    expect(missing.status).toBe(404);
    const dumb = await fetch(`${base}/git/paper.git/HEAD`, { headers: { authorization: 'Basic ' + Buffer.from('bob:bobs-password').toString('base64') } });
    expect(dumb.status).toBe(404);
  });

  it('clones with a token and pushes; the push updates the working tree', async () => {
    await g(ROOT, 'clone', '-q', url('bob', bobToken), clone);
    expect(readFileSync(join(clone, 'main.lyx'), 'utf8')).toBe(docText('one', 'two edited by bob', 'three'));
    expect(existsSync(join(clone, 'main.aux'))).toBe(false);
    expect((await g(clone, 'log', '--format=%s')).trim().split('\n')).toEqual(['Add notes', 'Update main.lyx', 'Import "paper" into OverLyX']);
    writeFileSync(join(clone, 'refs.bib'), '@article{a, title={A}}\n@article{b, title={B}}\n');
    await g(clone, 'add', '-A');
    await g(clone, 'commit', '-q', '-m', 'Add reference b');
    await g(clone, 'push', '-q', 'origin', 'main');
    expect(readFileSync(join(PROJECT, 'refs.bib'), 'utf8')).toContain('title={B}');
    expect((await g(PROJECT, 'log', '-1', '--format=%s')).trim()).toBe('Add reference b');
    expect((await g(PROJECT, 'status', '--porcelain')).trim()).toBe('');
  });

  it('what OverLyX had not committed yet is committed before a push, which then has to pull first', async () => {
    writeFileSync(join(PROJECT, 'notes.tex'), '% notes, edited on the server but not committed yet\n');
    writeFileSync(join(clone, 'figures', 'plot.txt'), 'a better plot\n');
    await g(clone, 'commit', '-q', '-am', 'Better plot');
    await expect(g(clone, 'push', '-q', 'origin', 'main')).rejects.toThrow(/fetch first|rejected/);
    expect((await g(PROJECT, 'log', '-1', '--format=%s')).trim()).toBe('Update notes.tex');
    expect((await g(PROJECT, 'status', '--porcelain')).trim()).toBe('');
    await g(clone, 'pull', '-q', '--no-rebase', 'origin', 'main');
    await g(clone, 'push', '-q', 'origin', 'main');
    expect(readFileSync(join(PROJECT, 'figures', 'plot.txt'), 'utf8')).toBe('a better plot\n');
    expect(readFileSync(join(clone, 'notes.tex'), 'utf8')).toContain('not committed yet');
    const subjects = (await g(PROJECT, 'log', '--format=%s')).trim().split('\n');
    expect(subjects[0]).toMatch(/^Merge branch 'main' of /);
    expect(subjects.slice(1, 3)).toEqual(['Better plot', 'Update notes.tex']);
  });

  it('the push-to-checkout hook keeps uncommitted changes in files a push does not touch, and refuses a clash', async () => {
    // straight into the working tree (file transport): nothing commits the server side first, as when a
    // save slips in between the server's pre-push commit and receive-pack
    writeFileSync(join(PROJECT, 'notes.tex'), '% changed on the server, not committed\n');
    writeFileSync(join(clone, 'figures', 'plot.txt'), 'the best plot\n');
    await g(clone, 'commit', '-q', '-am', 'Best plot');
    await g(clone, 'push', '-q', PROJECT, 'main');
    expect(readFileSync(join(PROJECT, 'figures', 'plot.txt'), 'utf8')).toBe('the best plot\n');
    expect(readFileSync(join(PROJECT, 'notes.tex'), 'utf8')).toBe('% changed on the server, not committed\n');
    expect((await g(PROJECT, 'status', '--porcelain')).trimEnd()).toBe(' M notes.tex');
    // the same file changed on both sides: refused, nothing lost
    writeFileSync(join(clone, 'notes.tex'), '% changed locally too\n');
    await g(clone, 'commit', '-q', '-am', 'Notes');
    await expect(g(clone, 'push', '-q', PROJECT, 'main')).rejects.toThrow(/rejected|push-to-checkout/);
    expect(readFileSync(join(PROJECT, 'notes.tex'), 'utf8')).toBe('% changed on the server, not committed\n');
    await g(clone, 'reset', '-q', '--hard', 'HEAD~1');
    expect(await gitmod.commitProject('paper')).toBe(true);   // the server side gets committed as usual
    await g(clone, 'pull', '-q', '--no-rebase', 'origin', 'main');
    expect(readFileSync(join(clone, 'notes.tex'), 'utf8')).toBe('% changed on the server, not committed\n');
  });

  it('a viewer can clone but not push', async () => {
    const vclone = join(ROOT, 'clones', 'vera');
    await g(ROOT, 'clone', '-q', url('vera', 'veras-password'), vclone);
    writeFileSync(join(vclone, 'refs.bib'), 'broken\n');
    await g(vclone, 'commit', '-q', '-am', 'vandalism');
    await expect(g(vclone, 'push', '-q', 'origin', 'main')).rejects.toThrow(/403|editor access|rejected|failed/);
    expect(readFileSync(join(PROJECT, 'refs.bib'), 'utf8')).toContain('title={B}');
  });

  it('pull gets what OverLyX wrote since; a pushed document change reaches the open document', async () => {
    const doc = await manager.open('paper/main.lyx');
    doc.loadFromLyx(parseLyx(docText('one', 'two edited by bob', 'three', 'four from the browser')), 'test');
    // not even written yet: the fetch saves and commits first
    await g(clone, 'pull', '-q', '--no-rebase', 'origin', 'main');
    expect(readFileSync(join(clone, 'main.lyx'), 'utf8')).toBe(docText('one', 'two edited by bob', 'three', 'four from the browser'));
    // now the other way: a paragraph edited locally and pushed shows up in the open document
    writeFileSync(join(clone, 'main.lyx'), docText('one (local)', 'two edited by bob', 'three', 'four from the browser'));
    await g(clone, 'commit', '-q', '-am', 'Local edit of paragraph one');
    await g(clone, 'push', '-q', 'origin', 'main');
    for (let i = 0; i < 80 && !doc.toLyxText().includes('one (local)'); i++) await sleep(100);
    expect(doc.toLyxText()).toBe(docText('one (local)', 'two edited by bob', 'three', 'four from the browser'));
  });

  it('a project name with spaces works, and an unborn repository can be pushed to', async () => {
    mkdirSync(join(ROOT, 'projects', 'my paper'), { recursive: true });
    access.adoptProjects();
    await gitmod.ensureRepo('my paper');
    const c = join(ROOT, 'clones', 'my-paper');
    const tj = gitmod.createToken(jan.id, 'x');
    await g(ROOT, 'clone', '-q', url('jan', tj.token, 'my paper'), c);
    expect((await g(c, 'ls-files')).trim()).toBe('.gitignore');
    writeFileSync(join(c, 'main.lyx'), docText('hello'));
    await g(c, 'add', '-A'); await g(c, 'commit', '-q', '-m', 'first');
    await g(c, 'push', '-q', 'origin', 'main');
    expect(readFileSync(join(ROOT, 'projects', 'my paper', 'main.lyx'), 'utf8')).toBe(docText('hello'));
  });
});
