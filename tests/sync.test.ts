/**
 * `overlyx sync` (packages/cli/bin/overlyx.js, the engine the VS Code extension bundles too) against
 * the real server routes (packages/server/src/sync.ts): a git clone of a project stays in step with
 * the server both ways — local saves reach the files and the open documents, the editors' changes
 * (unsaved ones included) reach the clone — without a commit per sync; concurrent edits merge
 * (documents paragraph by paragraph, the clone's text as a tracked change where both changed the same
 * paragraph; text by lines; binary files as conflict copies); deletions, viewers, the local branch
 * following the server's commits, a local commit recorded on the server, links in the clone, the
 * watcher with its lock, and the clones at work as the web interface hears of them (syncPeers.ts).
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { existsSync, mkdirSync, readFileSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir, hostname } from 'node:os';
import { execFile, spawn, type ChildProcess } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import http from 'node:http';
import express from 'express';
import * as Y from 'yjs';

const ROOT = join(process.env.OVERLYX_SCRATCH ?? tmpdir(), `overlyx-sync-test-${process.pid}`);
rmSync(ROOT, { recursive: true, force: true });
mkdirSync(join(ROOT, 'projects'), { recursive: true });
mkdirSync(join(ROOT, 'clones'), { recursive: true });
process.env.OVERLYX_DATA_DIR = join(ROOT, 'data');
process.env.OVERLYX_PROJECTS_DIR = join(ROOT, 'projects');
process.env.OVERLYX_GIT_COMMIT_MS = String(3600_000);   // no automatic commits during the tests: every commit is one a test made
process.env.OVERLYX_SYNC_WAIT_MS = '1500';
process.env.OVERLYX_SYNC_PEER_TTL_MS = '2500';
writeFileSync(join(ROOT, 'gitconfig'), '');

const { config } = await import('../packages/server/src/config.ts');
if (config.projectsDir !== join(ROOT, 'projects')) throw new Error('the test would reach the real projects');
const gitmod = await import('../packages/server/src/git.ts');
const { syncRouter } = await import('../packages/server/src/sync.ts');
const { createUser, toSessionUser } = await import('../packages/server/src/auth.ts');
const { createOwnedProject } = await import('../packages/server/src/projectCreate.ts');
const { addMember } = await import('../packages/server/src/access.ts');
const { manager } = await import('../packages/server/src/docs.ts');
const { db } = await import('../packages/server/src/db.ts');
const { clonesOf, externalSyncOf } = await import('../packages/server/src/syncPeers.ts');

const CLI = fileURLToPath(new URL('../packages/cli/bin/overlyx.js', import.meta.url));
const execFileP = promisify(execFile);

const ada = createUser('ada', 'Ada Lovelace', 'password');
const adaToken = gitmod.createToken(ada.id, 'sync test').token;
const bob = createUser('bob', 'Bob Viewer', 'password');
const bobToken = gitmod.createToken(bob.id, 'sync test').token;

const app = express();
let syncRequests = 0;
app.use('/git/api/sync', (_req, _res, next) => { syncRequests++; next(); }, syncRouter());
app.use('/git', gitmod.gitRouter());
const server = http.createServer(app);
let host = '';

const basic = (u: string, t: string) => 'Basic ' + Buffer.from(`${u}:${t}`).toString('base64');
const env = (user = 'ada', token = adaToken) => ({
  ...process.env,
  OVERLYX_CONFIG_DIR: join(ROOT, 'config'),
  OVERLYX_USERNAME: user, OVERLYX_TOKEN: token,
  GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: join(ROOT, 'gitconfig'), GIT_TERMINAL_PROMPT: '0',
  GIT_AUTHOR_NAME: 'Ada', GIT_AUTHOR_EMAIL: 'ada@example.org', GIT_COMMITTER_NAME: 'Ada', GIT_COMMITTER_EMAIL: 'ada@example.org',
});
const git = async (dir: string, ...args: string[]) => (await execFileP('git', ['-C', dir, ...args], { encoding: 'utf8', env: env() })).stdout.trim();
const sync = async (dir: string, user = 'ada', token = adaToken) => {
  const r = await execFileP(process.execPath, [CLI, 'sync', dir], { encoding: 'utf8', env: env(user, token) }).catch(e => { throw new Error(`overlyx sync failed: ${e.stderr || e.message}`); });
  return r.stdout;
};

const doc = (...pars: string[]) => `\\documentclass{article}\n\\begin{document}\n${pars.join('\n\n')}\n\\end{document}\n`;
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));
async function until(check: () => boolean, ms = 10_000): Promise<void> {
  const end = Date.now() + ms;
  while (!check()) { if (Date.now() > end) throw new Error('timed out'); await sleep(100); }
}

/** A project of Ada's with `files`, committed, and a clone of it (as `user`). */
async function project(name: string, files: Record<string, string | Buffer>, user = 'ada', token = adaToken) {
  const key = createOwnedProject(name, ada.id).name;
  const dir = join(ROOT, 'projects', key);
  for (const [rel, content] of Object.entries(files)) { mkdirSync(join(dir, rel, '..'), { recursive: true }); writeFileSync(join(dir, rel), content); }
  await gitmod.ensureRepo(key);
  const clone = join(ROOT, 'clones', `${name}-${user}`);
  await execFileP('git', ['-c', `http.extraHeader=Authorization: ${basic(user, token)}`, 'clone', '-q', `${host}/git/${key}.git`, clone], { env: env(user, token) });
  return {
    key, dir, clone,
    server: (rel: string) => readFileSync(join(dir, rel), 'utf8'),
    local: (rel: string) => readFileSync(join(clone, rel), 'utf8'),
    commits: async () => Number(await git(dir, 'rev-list', '--count', 'HEAD')),
  };
}

/** Type into a paragraph of the live document, the way an editor's update arrives (not saved). */
function type(d: Awaited<ReturnType<typeof manager.open>>, index: number, text: string): void {
  d.ydoc.transact(() => {
    const p = d.fragment.get(index) as Y.XmlElement;
    const t = p.toArray().find(x => x instanceof Y.XmlText) as Y.XmlText;
    t.insert(0, text);
  });
}

beforeAll(async () => {
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  host = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
});

afterAll(async () => {
  await new Promise<void>(resolve => server.close(() => resolve()));
  rmSync(ROOT, { recursive: true, force: true });
});

describe('overlyx sync: a clone in step with the server', () => {
  it('sends local saves and receives the server\'s changes, without a commit per sync', async () => {
    const p = await project('basic', { 'main.tex': doc('First paragraph.', 'Second paragraph.'), 'refs.bib': '@book{a,\n  title={A}\n}\n' });
    const commits = await p.commits();
    expect(await sync(p.clone)).toMatch(/In step with/);

    writeFileSync(join(p.clone, 'main.tex'), doc('First paragraph, from the clone.', 'Second paragraph.'));
    mkdirSync(join(p.clone, 'figures'));
    writeFileSync(join(p.clone, 'figures', 'data.csv'), 'x,y\n1,2\n');
    const out = await sync(p.clone);
    expect(out).toContain('↑ main.tex');
    expect(out).toContain('↑ figures/data.csv');
    expect(p.server('main.tex')).toContain('First paragraph, from the clone.');
    expect(p.server('figures/data.csv')).toBe('x,y\n1,2\n');

    // a change on the server (another editor, an upload) comes here
    writeFileSync(join(p.dir, 'refs.bib'), '@book{a,\n  title={A, revised}\n}\n');
    expect(await sync(p.clone)).toContain('↓ refs.bib');
    expect(p.local('refs.bib')).toContain('A, revised');

    // no commits: the history is OverLyX's own schedule
    expect(await p.commits()).toBe(commits);
    expect(await sync(p.clone)).toMatch(/In step with/);
  });

  it('an open document takes a synced file in at once, and its unsaved edits reach the clone', async () => {
    const p = await project('live', { 'main.tex': doc('Alpha paragraph.', 'Beta paragraph.', 'Gamma paragraph.') });
    const d = await manager.open(`${p.key}/main.tex`);
    await sync(p.clone);
    writeFileSync(join(p.clone, 'main.tex'), doc('Alpha paragraph, synced.', 'Beta paragraph.', 'Gamma paragraph.'));
    await sync(p.clone);
    expect(d.toText()).toContain('Alpha paragraph, synced.');

    type(d, 2, 'Typed in the browser. ');          // not saved yet
    await sync(p.clone);
    expect(p.local('main.tex')).toContain('Typed in the browser. Gamma paragraph.');
  });

  it('concurrent edits of different paragraphs merge; the same paragraph keeps the live text with the clone\'s as a tracked change', async () => {
    const p = await project('merge', { 'main.tex': doc('One paragraph.', 'Two paragraph.', 'Three paragraph.') });
    await sync(p.clone);
    const d = await manager.open(`${p.key}/main.tex`);

    type(d, 2, 'Browser: ');
    writeFileSync(join(p.clone, 'main.tex'), doc('One paragraph, edited here.', 'Two paragraph.', 'Three paragraph.'));
    expect(await sync(p.clone)).toMatch(/↑ main\.tex \(merged/);
    for (const text of [p.server('main.tex'), p.local('main.tex'), d.toText()]) {
      expect(text).toContain('One paragraph, edited here.');
      expect(text).toContain('Browser: Three paragraph.');
      expect(text).not.toContain('\\lyxadded');
    }

    type(d, 1, 'Live ');
    writeFileSync(join(p.clone, 'main.tex'), p.local('main.tex').replace('Two paragraph.', 'Two paragraph, rewritten in the clone.'));
    expect(await sync(p.clone)).toMatch(/1 paragraph changed on both sides: yours are tracked changes there/);
    const merged = p.server('main.tex');
    expect(merged).toContain('\\lyxadded');
    expect(merged).toContain('Ada Lovelace');
    expect(merged).toContain('rewritten in the clone');
    expect(merged).toContain('Live');
    expect(p.local('main.tex')).toBe(merged);
    expect(d.toText()).toBe(merged);
    expect(await sync(p.clone)).toMatch(/In step with/);
  });

  it('text files merge by lines; overlapping lines and binary files keep the server\'s version and a conflict copy here', async () => {
    const lines = (n: number, change: Record<number, string> = {}) => Array.from({ length: n }, (_, i) => change[i] ?? `line ${i}`).join('\n') + '\n';
    const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0, 1, 2, 3]);
    const p = await project('text', { 'notes.txt': lines(10), 'fig.png': png });
    await sync(p.clone);

    writeFileSync(join(p.dir, 'notes.txt'), lines(10, { 8: 'line 8 on the server' }));
    writeFileSync(join(p.clone, 'notes.txt'), lines(10, { 1: 'line 1 here' }));
    expect(await sync(p.clone)).toMatch(/↑ notes\.txt \(merged/);
    expect(p.server('notes.txt')).toBe(lines(10, { 1: 'line 1 here', 8: 'line 8 on the server' }));
    expect(p.local('notes.txt')).toBe(p.server('notes.txt'));

    writeFileSync(join(p.dir, 'notes.txt'), lines(10, { 1: 'line 1 here', 8: 'line 8 on the server', 4: 'line 4: server' }));
    writeFileSync(join(p.clone, 'notes.txt'), lines(10, { 1: 'line 1 here', 8: 'line 8 on the server', 4: 'line 4: clone' }));
    writeFileSync(join(p.dir, 'fig.png'), Buffer.concat([png, Buffer.from([9])]));
    writeFileSync(join(p.clone, 'fig.png'), Buffer.concat([png, Buffer.from([7])]));
    const out = await sync(p.clone);
    expect(out).toMatch(/! notes\.txt: changed on both sides — the server's version is here now, yours is "notes \(conflict, .+\)\.txt"/);
    expect(out).toMatch(/! fig\.png: changed on both sides/);
    expect(p.local('notes.txt')).toContain('line 4: server');
    const copy = out.match(/"(notes \(conflict, [^"]+\)\.txt)"/)![1];
    expect(p.local(copy)).toContain('line 4: clone');
    expect(readFileSync(join(p.clone, 'fig.png')).at(-1)).toBe(9);
    // the copies are ordinary new files: they reach the server with the next sync
    await sync(p.clone);
    expect(p.server(copy)).toContain('line 4: clone');
    expect(await sync(p.clone)).toMatch(/In step with/);
  });

  it('removals go both ways; a file changed on the server is not removed by the clone', async () => {
    const p = await project('remove', { 'a.txt': 'a\n', 'b.txt': 'b\n', 'c.txt': 'c\n' });
    await sync(p.clone);
    unlinkSync(join(p.clone, 'a.txt'));
    unlinkSync(join(p.dir, 'b.txt'));
    unlinkSync(join(p.clone, 'c.txt'));
    writeFileSync(join(p.dir, 'c.txt'), 'c, changed on the server\n');
    const out = await sync(p.clone);
    expect(out).toContain('↑ a.txt (removed)');
    expect(out).toContain('↓ b.txt (removed)');
    expect(out).toContain('! c.txt: changed on the server, so it was not removed — it is back');
    expect(existsSync(join(p.dir, 'a.txt'))).toBe(false);
    expect(existsSync(join(p.clone, 'b.txt'))).toBe(false);
    expect(p.local('c.txt')).toBe('c, changed on the server\n');
  });

  it('a viewer receives, but sends nothing', async () => {
    const p = await project('viewer', { 'main.tex': doc('Shared paragraph.') }, 'ada');
    addMember(p.key, 'bob', 'view', toSessionUser(db.prepare('SELECT * FROM users WHERE id = ?').get(ada.id) as never));
    const clone = join(ROOT, 'clones', 'viewer-bob');
    await execFileP('git', ['-c', `http.extraHeader=Authorization: ${basic('bob', bobToken)}`, 'clone', '-q', `${host}/git/${p.key}.git`, clone], { env: env('bob', bobToken) });
    writeFileSync(join(p.dir, 'main.tex'), doc('Shared paragraph, updated.'));
    expect(await sync(clone, 'bob', bobToken)).toContain('↓ main.tex');
    writeFileSync(join(clone, 'main.tex'), doc('Bob was here.'));
    expect(await sync(clone, 'bob', bobToken)).toContain('main.tex: changed here, not sent (you can only view this project)');
    expect(p.server('main.tex')).toContain('Shared paragraph, updated.');
  });

  it('the branch follows the server\'s commits; a commit made here becomes one there, with its message', async () => {
    const p = await project('branch', { 'main.tex': doc('Intro.') });
    await sync(p.clone);
    writeFileSync(join(p.dir, 'main.tex'), doc('Intro, from the browser.'));
    await sync(p.clone);
    await gitmod.commitProject(p.key, { message: 'Checkpoint' });
    await sync(p.clone);
    expect(await git(p.clone, 'rev-parse', 'HEAD')).toBe(await git(p.dir, 'rev-parse', 'HEAD'));
    expect(await git(p.clone, 'status', '--porcelain')).toBe('');

    writeFileSync(join(p.clone, 'main.tex'), doc('Intro, rewritten here.'));
    await git(p.clone, 'commit', '-qam', 'Rewrite the intro');
    await sync(p.clone);
    expect(await git(p.dir, 'log', '-1', '--format=%s')).toBe('Rewrite the intro');
    expect(await git(p.dir, 'log', '-1', '--format=%an')).toBe('Ada Lovelace');
    expect(await git(p.clone, 'rev-parse', 'HEAD')).toBe(await git(p.dir, 'rev-parse', 'HEAD'));
    expect(await git(p.clone, 'status', '--porcelain')).toBe('');
    expect(p.server('main.tex')).toContain('Intro, rewritten here.');
  });

  it('a synced fetch does not make the server commit; a plain one still does', async () => {
    const p = await project('fetch', { 'main.tex': doc('Text.') });
    const before = await p.commits();
    writeFileSync(join(p.dir, 'main.tex'), doc('Text, changed.'));
    const auth = `http.extraHeader=Authorization: ${basic('ada', adaToken)}`;
    await execFileP('git', ['-C', p.clone, '-c', auth, '-c', 'http.extraHeader=X-OverLyX-Sync: 1', 'fetch', '-q', 'origin'], { env: env() });
    expect(await p.commits()).toBe(before);
    await execFileP('git', ['-C', p.clone, '-c', auth, 'fetch', '-q', 'origin'], { env: env() });
    expect(await p.commits()).toBe(before + 1);
  });

  it('never writes through a link in the clone', async () => {
    const p = await project('links', { 'main.tex': doc('Text.') });
    await sync(p.clone);
    const outside = join(ROOT, 'outside');
    mkdirSync(outside, { recursive: true });
    symlinkSync(outside, join(p.clone, 'docs'));
    mkdirSync(join(p.dir, 'docs'));
    writeFileSync(join(p.dir, 'docs', 'x.txt'), 'from the server\n');
    await sync(p.clone);
    expect(existsSync(join(outside, 'x.txt'))).toBe(false);
  });

  it('--watch keeps it in step both ways within seconds, and holds the clone for itself', async () => {
    const p = await project('watch', { 'notes.txt': 'start\n' });
    let child: ChildProcess | null = null;
    try {
      child = spawn(process.execPath, [CLI, 'sync', p.clone, '--watch'], { env: env(), stdio: ['ignore', 'pipe', 'pipe'] });
      let out = '';
      child.stdout!.on('data', d => { out += String(d); });
      child.stderr!.on('data', d => { out += String(d); });
      await until(() => out.includes('Keeping'));
      await sleep(500);
      writeFileSync(join(p.dir, 'notes.txt'), 'from the server\n');
      await until(() => p.local('notes.txt') === 'from the server\n');
      writeFileSync(join(p.clone, 'notes.txt'), 'from the clone\n');
      await until(() => p.server('notes.txt') === 'from the clone\n');
      // the web interface hears of it: the CLI's clone, on this computer (said to its own account only)
      expect(clonesOf(p.key, toSessionUser(ada))).toMatchObject([{ app: 'cli', host: hostname(), mine: true }]);
      expect(clonesOf(p.key, toSessionUser(bob))).toMatchObject([{ app: 'cli', host: null, mine: false, name: 'Ada Lovelace' }]);
      // a second sync of the same clone waits for the first — a second watcher too, quietly (no request after request)
      await expect(sync(p.clone)).rejects.toThrow(/synced by another process/);
      const second = spawn(process.execPath, [CLI, 'sync', p.clone, '--watch'], { env: env(), stdio: 'ignore' });
      await sleep(1500);
      const before = syncRequests;
      await sleep(3000);
      second.kill('SIGTERM');
      await new Promise(r => second.once('exit', r));
      expect(syncRequests - before).toBeLessThan(6);   // the first watcher's long poll (1.5 s here), nothing from the second
    } finally {
      child?.kill('SIGTERM');
      await new Promise(r => child?.once('exit', r));
    }
    expect(existsSync(join(p.clone, '.git', 'overlyx-sync', 'lock'))).toBe(false);
  }, 30_000);

  it('the web interface hears which clones are at work, and forgets them a while after they stop', async () => {
    const p = await project('peers', { 'main.tex': doc('One.') });
    const state = (auth: string, headers: Record<string, string> = {}) => fetch(`${host}/git/api/sync/state?project=${encodeURIComponent(p.key)}`, { headers: { Authorization: auth, ...headers } }).then(r => r.json());
    const as = toSessionUser(ada);
    expect(externalSyncOf(`${p.key}/main.tex`, p.key, as)).toEqual({ clones: [], google: null });
    await state(basic('ada', adaToken), { 'X-OverLyX-Sync-App': 'vscode', 'X-OverLyX-Sync-Host': encodeURIComponent('Ada’s Mac') });
    expect(externalSyncOf(`${p.key}/main.tex`, p.key, as).clones).toMatchObject([{ app: 'vscode', host: 'Ada’s Mac', mine: true, username: 'ada' }]);
    // an engine from before the headers: its credential's name tells
    const old = gitmod.createToken(ada.id, 'OverLyX CLI on old-laptop').token;
    await state(basic('ada', old));
    expect(clonesOf(p.key, as).map(c => [c.app, c.host])).toEqual([['vscode', 'Ada’s Mac'], ['cli', 'old-laptop']]);
    // once nothing asks for a while, they are gone
    await sleep(2800);
    expect(clonesOf(p.key, as)).toEqual([]);
  }, 20_000);
});
