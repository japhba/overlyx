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
