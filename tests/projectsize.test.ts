/**
 * A project's size limit (packages/server/src/projectsize.ts), here 1 MB: the files count, the
 * version history does not; a write that would cross the limit is refused, one that shrinks the
 * project goes through; a batch is counted as it goes; a synced clone's file and a git push that
 * do not fit are refused, small ones still come in.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { randomBytes } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import http from 'node:http';
import express from 'express';

const ROOT = join(process.env.OVERLYX_SCRATCH ?? tmpdir(), `overlyx-projectsize-test-${process.pid}`);
rmSync(ROOT, { recursive: true, force: true });
mkdirSync(join(ROOT, 'projects'), { recursive: true });
process.env.OVERLYX_DATA_DIR = join(ROOT, 'data');
process.env.OVERLYX_PROJECTS_DIR = join(ROOT, 'projects');
process.env.OVERLYX_GIT_COMMIT_MS = String(3600_000);
process.env.OVERLYX_PROJECT_MAX_MB = '1';
writeFileSync(join(ROOT, 'gitconfig'), '');

const { config } = await import('../packages/server/src/config.ts');
if (config.projectsDir !== join(ROOT, 'projects')) throw new Error('the test would reach the real projects');
const size = await import('../packages/server/src/projectsize.ts');
const gitmod = await import('../packages/server/src/git.ts');
const { syncRouter } = await import('../packages/server/src/sync.ts');
const { createUser } = await import('../packages/server/src/auth.ts');
const { createOwnedProject } = await import('../packages/server/src/projectCreate.ts');

const execFileP = promisify(execFile);
const KB = 1024;
const ada = createUser('ada', 'Ada Lovelace', 'password');
const token = gitmod.createToken(ada.id, 'size test').token;
const basic = 'Basic ' + Buffer.from(`ada:${token}`).toString('base64');
const env = {
  ...process.env, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: join(ROOT, 'gitconfig'), GIT_TERMINAL_PROMPT: '0',
  GIT_AUTHOR_NAME: 'Ada', GIT_AUTHOR_EMAIL: 'ada@example.org', GIT_COMMITTER_NAME: 'Ada', GIT_COMMITTER_EMAIL: 'ada@example.org',
};
const git = async (dir: string, ...args: string[]) => (await execFileP('git', ['-C', dir, '-c', `http.extraHeader=Authorization: ${basic}`, ...args], { encoding: 'utf8', env })).stdout.trim();

const app = express();
app.use('/git/api/sync', syncRouter());
app.use('/git', gitmod.gitRouter());
const server = http.createServer(app);
let host = '';
beforeAll(async () => {
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  host = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
});
afterAll(async () => {
  await new Promise<void>(resolve => server.close(() => resolve()));
  rmSync(ROOT, { recursive: true, force: true });
});

/** a project of Ada's holding `bytes` of data (incompressible, so a git pack is as large) */
async function project(name: string, bytes: number) {
  const key = createOwnedProject(name, ada.id).name;
  const dir = join(ROOT, 'projects', key);
  writeFileSync(join(dir, 'data.bin'), randomBytes(bytes));
  await gitmod.ensureRepo(key);
  return { key, dir };
}

describe('project size limit', () => {
  it('counts the files, not the history, and counts a batch as it goes', async () => {
    const { key, dir } = await project('unit', 600 * KB);
    mkdirSync(join(dir, '.git', 'big'), { recursive: true });
    writeFileSync(join(dir, '.git', 'big', 'pack'), randomBytes(2048 * KB));
    size.noteWritten(key, null);
    expect(size.projectBytes(key)).toBeGreaterThanOrEqual(600 * KB);
    expect(size.projectBytes(key)).toBeLessThan(700 * KB);
    expect(() => size.assertRoom(key, 300 * KB)).not.toThrow();
    // the 300 KB just allowed count: another 300 KB do not fit
    expect(() => size.assertRoom(key, 300 * KB, 0, 'figures/b.png')).toThrow(/figures\/b\.png would take the project past its 1 MB limit/);
    // replacing a file by a smaller one, and deleting, always go through
    expect(() => size.assertRoom(key, 500 * KB, 600 * KB)).not.toThrow();
  });

  it("refuses a synced clone's file that does not fit, and takes small ones", async () => {
    const { key } = await project('synced', 700 * KB);
    const push = async (rel: string, data: Buffer) => {
      const r = await fetch(`${host}/git/api/sync/push`, {
        method: 'POST', headers: { authorization: basic, 'content-type': 'application/json' },
        body: JSON.stringify({ project: key, files: [{ path: rel, data: data.toString('base64'), base: null }] }),
      });
      return (await r.json() as { results: { status: string; error?: string }[] }).results[0];
    };
    const big = await push('more.bin', randomBytes(400 * KB));
    expect(big.status).toBe('error');
    expect(big.error).toMatch(/past its 1 MB limit/);
    expect((await push('notes.txt', Buffer.from('a small file\n'))).status).toBe('applied');
  });

  it('refuses a git push that does not fit, and takes a small one', async () => {
    const { key } = await project('pushed', 500 * KB);
    const clone = join(ROOT, 'clone');
    await git(ROOT, 'clone', '-q', `${host}/git/${key}.git`, clone);
    writeFileSync(join(clone, 'big.bin'), randomBytes(900 * KB));
    await git(clone, 'add', 'big.bin');
    await git(clone, 'commit', '-qm', 'big');
    await expect(git(clone, 'push', '-q', 'origin', 'HEAD')).rejects.toThrow(/maximum allowed size/);
    await git(clone, 'reset', '-q', '--hard', 'HEAD~1');
    writeFileSync(join(clone, 'notes.txt'), 'a small file\n');
    await git(clone, 'add', 'notes.txt');
    await git(clone, 'commit', '-qm', 'small');
    await git(clone, 'push', '-q', 'origin', 'HEAD');
  });
});
