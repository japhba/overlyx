/**
 * Several sync engines for one clone (packages/cli/bin/overlyx.js SyncEngine): every VS Code window
 * restores every clone accepted on the computer (host/sync.ts restoreClones), and a terminal may run
 * `overlyx sync --watch` too. One holds the clone at a time (the lock in .git/overlyx-sync); the
 * others wait. An engine that takes over must start from the merge bases the other one left in
 * state.json — before 21 Nov 2026 it kept the ones it had read when it started, so a local edit
 * went to the server against an old base: a conflict, the user's file put back to the server's
 * version and their edit moved to a conflict copy (the owner's clone logged such conflicts on 19–20 Nov).
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import http from 'node:http';
import express from 'express';

vi.hoisted(() => { process.env.OVERLYX_CLI_LIBRARY = '1'; });
const ROOT = join(process.env.OVERLYX_SCRATCH ?? tmpdir(), `overlyx-sync-engines-${process.pid}`);
rmSync(ROOT, { recursive: true, force: true });
mkdirSync(join(ROOT, 'projects'), { recursive: true });
mkdirSync(join(ROOT, 'clones'), { recursive: true });
process.env.OVERLYX_DATA_DIR = join(ROOT, 'data');
process.env.OVERLYX_PROJECTS_DIR = join(ROOT, 'projects');
process.env.OVERLYX_GIT_COMMIT_MS = String(3600_000);
process.env.OVERLYX_SYNC_WAIT_MS = '1500';
delete process.env.OVERLYX_GIT;   // (an instance's environment may switch git off)
writeFileSync(join(ROOT, 'gitconfig'), '');
process.env.GIT_CONFIG_NOSYSTEM = '1';
process.env.GIT_CONFIG_GLOBAL = join(ROOT, 'gitconfig');
process.env.GIT_TERMINAL_PROMPT = '0';

const { config } = await import('../packages/server/src/config.ts');
if (config.projectsDir !== join(ROOT, 'projects')) throw new Error('the test would reach the real projects');
const gitmod = await import('../packages/server/src/git.ts');
const { syncRouter } = await import('../packages/server/src/sync.ts');
const { createUser } = await import('../packages/server/src/auth.ts');
const { createOwnedProject } = await import('../packages/server/src/projectCreate.ts');
const { SyncEngine } = await import('../packages/cli/bin/overlyx.js');

const execFileP = promisify(execFile);
const ada = createUser('ada', 'Ada Lovelace', 'password');
const auth = { username: 'ada', token: gitmod.createToken(ada.id, 'sync test').token };
const app = express();
app.use('/git/api/sync', syncRouter());
app.use('/git', gitmod.gitRouter());
const server = http.createServer(app);
let host = '';
const basic = (u: string, t: string) => 'Basic ' + Buffer.from(`${u}:${t}`).toString('base64');

async function project(name: string, files: Record<string, string>) {
  const key = createOwnedProject(name, ada.id).name;
  const dir = join(ROOT, 'projects', key);
  for (const [rel, content] of Object.entries(files)) { mkdirSync(join(dir, rel, '..'), { recursive: true }); writeFileSync(join(dir, rel), content); }
  await gitmod.ensureRepo(key);
  const clone = join(ROOT, 'clones', name);
  await execFileP('git', ['-c', `http.extraHeader=Authorization: ${basic(auth.username, auth.token)}`, 'clone', '-q', `${host}/git/${key}.git`, clone]).catch(e => { throw new Error(`git clone: ${e.stderr}`); });
  const engine = (client: string) => new SyncEngine({ dir: clone, host, project: key, remote: 'origin', auth, client, app: 'vscode' });
  return { key, dir, clone, engine, server: (rel: string) => readFileSync(join(dir, rel), 'utf8'), local: (rel: string) => readFileSync(join(clone, rel), 'utf8') };
}

const lines = (n: number, change: Record<number, string> = {}) => Array.from({ length: n }, (_, i) => change[i] ?? `line ${i}`).join('\n') + '\n';
const copies = (dir: string) => readdirSync(dir).filter(n => n.includes('(conflict'));

beforeAll(async () => {
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  host = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
});
afterAll(async () => {
  await new Promise<void>(resolve => server.close(() => resolve()));
  rmSync(ROOT, { recursive: true, force: true });
});

describe('several engines for one clone', () => {
  it('an engine that takes over starts from the bases the other one left, not from its own old ones', async () => {
    const p = await project('takeover', { 'notes.py': lines(8) });
    const a = p.engine('window A'), b = p.engine('window B');
    await b.sync();                      // window B started first, then handed the clone over (its window lost the lock, or slept)
    b.unlock();
    await a.sync();
    writeFileSync(join(p.dir, 'notes.py'), lines(8, { 2: 'line 2, from the server' }));
    await a.sync();                      // A brings the server's change here
    expect(p.local('notes.py')).toBe(lines(8, { 2: 'line 2, from the server' }));
    a.unlock();                          // A's window closes
    writeFileSync(join(p.clone, 'notes.py'), lines(8, { 2: 'line 2, from the server', 3: 'line 3, typed here' }));
    const c = await b.sync();            // B takes over
    expect(c.conflicts).toEqual([]);
    expect(p.server('notes.py')).toBe(lines(8, { 2: 'line 2, from the server', 3: 'line 3, typed here' }));
    expect(p.local('notes.py')).toBe(lines(8, { 2: 'line 2, from the server', 3: 'line 3, typed here' }));
    expect(copies(p.clone)).toEqual([]);
  });

  it('two engines in one process do not both run (one VS Code window with the clone found twice)', async () => {
    const p = await project('samepid', { 'notes.py': lines(4) });
    const a = p.engine('window A'), b = p.engine('window A, again');
    await a.sync();
    expect(a.status.state).toBe('idle');
    await b.sync();
    expect(b.status.state).toBe('paused');
    a.stop();
    await b.sync();
    expect(b.status.state).toBe('idle');
    b.stop();
    expect(existsSync(join(p.clone, '.git', 'overlyx-sync', 'lock'))).toBe(false);
  });
});

describe('a checkout git moved to an older commit', () => {
  const git = async (dir: string, ...args: string[]) => (await execFileP('git', ['-C', dir, ...args], { encoding: 'utf8' })).stdout.trim();

  it('is not sent back to the server as changes (git checkout <old commit>, a submodule on its recorded commit)', async () => {
    const p = await project('detached', { 'a.txt': 'a, first version\n', 'b.txt': 'b, first version\n' });
    const first = await git(p.dir, 'rev-parse', 'HEAD');
    const e = p.engine('window A');
    await e.sync();
    writeFileSync(join(p.dir, 'a.txt'), 'a, second version\n');
    await gitmod.commitProject(p.key, { message: 'Second version' });
    writeFileSync(join(p.dir, 'b.txt'), 'b, written since the last commit\n');   // not committed yet (the server commits minutes later)
    await e.sync();
    expect(p.local('a.txt')).toBe('a, second version\n');
    expect(p.local('b.txt')).toBe('b, written since the last commit\n');

    await git(p.clone, 'checkout', '-q', first);   // to look at the first version
    expect(p.local('a.txt')).toBe('a, first version\n');
    await e.sync();
    expect(p.server('a.txt')).toBe('a, second version\n');
    expect(e.status.state).toBe('paused');
    expect(e.status.message).toMatch(/older commit/);

    await git(p.clone, 'switch', '-q', '-');   // back on the branch: the files are in step again, nothing is sent
    await e.sync();
    expect(e.status.state).toBe('idle');
    expect(p.server('a.txt')).toBe('a, second version\n');
    expect(p.server('b.txt')).toBe('b, written since the last commit\n');
    e.stop();
  });
});

describe('a clone on a file system that ignores case (macOS, Windows)', () => {
  /** the clone's paths looked up as such a file system does: a name matches an entry of any case */
  async function ignoringCase<T>(clone: string, run: () => Promise<T>): Promise<T> {
    const fs = (await import('node:fs')).default;
    const pathm = (await import('node:path')).default;
    const real = { lstatSync: fs.lstatSync, statSync: fs.statSync, readFileSync: fs.readFileSync, existsSync: fs.existsSync, rmSync: fs.rmSync, renameSync: fs.renameSync, writeFileSync: fs.writeFileSync, chmodSync: fs.chmodSync, readdirSync: fs.readdirSync };
    const ci = (p: unknown): unknown => {
      if (typeof p !== 'string' || !p.startsWith(clone + pathm.sep) || p.includes(`${pathm.sep}.git${pathm.sep}`)) return p;
      let cur = clone;
      const parts = p.slice(clone.length + 1).split(pathm.sep);
      for (let i = 0; i < parts.length; i++) {
        let names: string[];
        try { names = real.readdirSync.call(fs, cur) as unknown as string[]; } catch { return pathm.join(cur, ...parts.slice(i)); }
        cur = pathm.join(cur, names.find(n => n === parts[i]) ?? names.find(n => n.toLowerCase() === parts[i].toLowerCase()) ?? parts[i]);
      }
      return cur;
    };
    const spies = [
      vi.spyOn(fs, 'lstatSync').mockImplementation(((p: string, ...a: unknown[]) => (real.lstatSync as Function).call(fs, ci(p), ...a)) as never),
      vi.spyOn(fs, 'statSync').mockImplementation(((p: string, ...a: unknown[]) => (real.statSync as Function).call(fs, ci(p), ...a)) as never),
      vi.spyOn(fs, 'readFileSync').mockImplementation(((p: string, ...a: unknown[]) => (real.readFileSync as Function).call(fs, ci(p), ...a)) as never),
      vi.spyOn(fs, 'existsSync').mockImplementation(((p: string) => real.existsSync.call(fs, ci(p) as string)) as never),
      vi.spyOn(fs, 'rmSync').mockImplementation(((p: string, ...a: unknown[]) => (real.rmSync as Function).call(fs, ci(p), ...a)) as never),
      vi.spyOn(fs, 'chmodSync').mockImplementation(((p: string, ...a: unknown[]) => (real.chmodSync as Function).call(fs, ci(p), ...a)) as never),
      vi.spyOn(fs, 'writeFileSync').mockImplementation(((p: string, ...a: unknown[]) => (real.writeFileSync as Function).call(fs, ci(p), ...a)) as never),
      // the target's directory as the file system finds it; its name as given (a rename that changes only the case keeps the file)
      vi.spyOn(fs, 'renameSync').mockImplementation(((a: string, b: string) => real.renameSync.call(fs, ci(a) as string, pathm.join(ci(pathm.dirname(b)) as string, pathm.basename(b)))) as never),
    ];
    try { return await run(); } finally { for (const s of spies) s.mockRestore(); }
  }

  it('a file renamed on the server only in case stays, here and there', async () => {
    const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0, 1, 2, 3]);
    const p = await project('casefold', { 'notes.txt': 'notes\n' });
    writeFileSync(join(p.dir, 'Plot.png'), png);
    const e = p.engine('a Mac');
    await ignoringCase(p.clone, async () => {
      await e.sync();
      expect(readFileSync(join(p.clone, 'Plot.png'))).toEqual(png);
      // renamed in the browser (or by a co-author on Linux): only the case changes
      const { renameSync } = await import('node:fs');
      renameSync(join(p.dir, 'Plot.png'), join(p.dir, 'plot.png'));
      await e.sync();
      await e.sync();
    });
    expect(readFileSync(join(p.dir, 'plot.png'))).toEqual(png);
    expect(readdirSync(p.clone).filter(n => n.toLowerCase() === 'plot.png')).toHaveLength(1);
    e.stop();
  });
});

describe('git writing the files of a synced clone', () => {
  const git = async (dir: string, ...args: string[]) => (await execFileP('git', ['-C', dir, ...args], { encoding: 'utf8' })).stdout.trim();

  it('the first sync of a clone made before the server\'s last commits takes them in, and sends only what was changed here', async () => {
    const p = await project('behind', { 'a.txt': 'a, first\n', 'b.txt': lines(6) });
    // cloned at the first commit; since then the server committed a change, and the clone's owner edited b.txt
    writeFileSync(join(p.dir, 'a.txt'), 'a, second\n');
    await gitmod.commitProject(p.key, { message: 'Second' });
    writeFileSync(join(p.clone, 'b.txt'), lines(6, { 4: 'line 4, typed here' }));
    const e = p.engine('a laptop');
    await e.sync();
    expect(p.server('a.txt')).toBe('a, second\n');
    expect(p.local('a.txt')).toBe('a, second\n');
    expect(p.server('b.txt')).toBe(lines(6, { 4: 'line 4, typed here' }));
    e.stop();
  });

  it('files git put back (stash, reset --hard, checkout -- .) wait instead of undoing the server\'s newer versions; sent when the user says so', async () => {
    const p = await project('restore', { 'a.txt': lines(6), 'b.txt': 'b\n' });
    const e = p.engine('a laptop');
    await e.sync();
    writeFileSync(join(p.dir, 'a.txt'), lines(6, { 1: 'line 1, written on the server' }));   // not committed yet
    await e.sync();
    expect(p.local('a.txt')).toContain('written on the server');

    await git(p.clone, 'stash', '-q');
    expect(p.local('a.txt')).toBe(lines(6));
    const held = await e.sync();
    expect(held.held).toEqual(['a.txt']);
    expect(e.status.held).toEqual(['a.txt']);
    expect(p.server('a.txt')).toContain('written on the server');

    await git(p.clone, 'stash', 'pop', '-q');   // back: nothing waits, nothing was sent
    await e.sync();
    expect(e.status.held).toEqual([]);
    expect(p.server('a.txt')).toContain('written on the server');

    await git(p.clone, 'reset', '-q', '--hard');
    await e.sync();
    expect(e.status.held).toEqual(['a.txt']);
    await e.sendHeld();                          // the user meant it
    expect(p.server('a.txt')).toBe(lines(6));
    expect(e.status.held).toEqual([]);

    writeFileSync(join(p.clone, 'b.txt'), 'b, typed here\n');   // an ordinary edit goes at once
    await e.sync();
    expect(p.server('b.txt')).toBe('b, typed here\n');
    e.stop();
  });
});

describe('taking the server\'s version', () => {
  it('replaces what differs here, keeps the versions here (Undo puts them back), leaves new local files alone', async () => {
    const p = await project('takeserver', { 'a.txt': 'a, server\n', 'b.txt': 'b\n', 'gone.txt': 'gone\n' });
    const e = p.engine('a laptop');
    await e.sync();
    // the clone went wrong: a.txt holds what must not reach the server, gone.txt was removed on the
    // server but changed here, new.txt is a new file of this clone
    writeFileSync(join(p.clone, 'a.txt'), 'a, broken here\n');
    writeFileSync(join(p.clone, 'gone.txt'), 'gone, changed here\n');
    rmSync(join(p.dir, 'gone.txt'));
    writeFileSync(join(p.clone, 'new.txt'), 'new here\n');
    const plan = await e.takeServer({ dryRun: true });
    expect(plan).toMatchObject({ replace: ['a.txt'], remove: ['gone.txt'], busy: [] });
    expect(p.local('a.txt')).toBe('a, broken here\n');   // a dry run changes nothing

    const done = await e.takeServer();
    expect(p.local('a.txt')).toBe('a, server\n');
    expect(existsSync(join(p.clone, 'gone.txt'))).toBe(false);
    expect(p.local('new.txt')).toBe('new here\n');
    expect(readFileSync(join(done.kept!, 'a.txt'), 'utf8')).toBe('a, broken here\n');
    expect(readFileSync(join(done.kept!, 'gone.txt'), 'utf8')).toBe('gone, changed here\n');
    await e.sync();
    expect(p.server('a.txt')).toBe('a, server\n');
    expect(existsSync(join(p.dir, 'gone.txt'))).toBe(false);

    await e.restoreKept(done.kept!);                 // Undo
    expect(p.local('a.txt')).toBe('a, broken here\n');
    expect(p.server('a.txt')).toBe('a, broken here\n');
    expect(p.server('gone.txt')).toBe('gone, changed here\n');
    e.stop();
  });

  it('takes the server\'s version of files git put back, which then wait no more', async () => {
    const p = await project('takeheld', { 'a.txt': lines(4) });
    const e = p.engine('a laptop');
    await e.sync();
    writeFileSync(join(p.dir, 'a.txt'), lines(4, { 2: 'line 2, written on the server' }));
    await e.sync();
    await execFileP('git', ['-C', p.clone, 'reset', '-q', '--hard']);
    await e.sync();
    expect(e.status.held).toEqual(['a.txt']);
    await e.takeServer({ paths: e.status.held });
    expect(p.local('a.txt')).toContain('written on the server');
    await e.sync();
    expect(e.status.held).toEqual([]);
    e.stop();
  });
});
