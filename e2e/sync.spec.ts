/**
 * A synced clone and the browser editor, end to end: `overlyx sync --watch` (the CLI's engine — the
 * VS Code extension runs the same) on a git clone made with the account token; what is saved in the
 * clone appears in the open editor, what is typed in the editor arrives in the clone's file, and the
 * clone's branch follows a commit made in OverLyX. Runs as the admin against an isolated instance;
 * OVERLYX_E2E_SERVER is the API server itself (git and the sync talk to it, not to vite).
 */
import { test, expect } from '@playwright/test';
import { execFileSync, spawn, type ChildProcess } from 'node:child_process';
import { readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { login, apiLogin, openDoc, BASE_URL, PROJECTS_DIR } from './helpers';

const PROJECT = 'admin/e2e-sync';
const DIR = `${PROJECTS_DIR}/${PROJECT}`;
const CLONE = join(tmpdir(), 'overlyx-e2e-sync-clone');
const SERVER = (process.env.OVERLYX_E2E_SERVER ?? BASE_URL).replace(/\/$/, '');
const CLI = fileURLToPath(new URL('../packages/cli/bin/overlyx.js', import.meta.url));
const gitEnv = { ...process.env, GIT_TERMINAL_PROMPT: '0', GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null' };
const git = (dir: string, ...args: string[]) => execFileSync('git', ['-C', dir, ...args], { env: gitEnv, encoding: 'utf8' }).trim();

let watcher: ChildProcess | null = null;

test.beforeAll(async ({ browser }) => {
  const ctx = await browser.newContext();
  await apiLogin(ctx);
  await ctx.request.delete(`${BASE_URL}/api/projects/${encodeURIComponent(PROJECT)}`);
  await ctx.close();
  rmSync(DIR, { recursive: true, force: true });
  rmSync(CLONE, { recursive: true, force: true });
});
test.afterAll(async () => {
  watcher?.kill('SIGTERM');
  rmSync(DIR, { recursive: true, force: true });
  rmSync(CLONE, { recursive: true, force: true });
});

test('a clone kept in step by overlyx sync and the editor see each other\'s changes within seconds', async ({ page }) => {
  test.setTimeout(120_000);
  await login(page);
  expect((await page.request.post(BASE_URL + '/api/projects', { data: { name: PROJECT } })).ok()).toBeTruthy();
  expect((await page.request.post(`${BASE_URL}/api/projects/${PROJECT}/new`, { data: { path: 'main.tex', title: 'Sync test' } })).ok()).toBeTruthy();
  const token = (await (await page.request.post(BASE_URL + '/api/git/tokens')).json()).token as string;
  const auth = 'Authorization: Basic ' + Buffer.from(`admin:${token}`).toString('base64');
  execFileSync('git', ['-c', `http.extraHeader=${auth}`, 'clone', '-q', `${SERVER}/git/${PROJECT}.git`, CLONE], { env: gitEnv });

  let out = '';
  watcher = spawn(process.execPath, [CLI, 'sync', CLONE, '--watch'], {
    env: { ...gitEnv, OVERLYX_USERNAME: 'admin', OVERLYX_TOKEN: token, OVERLYX_CONFIG_DIR: join(tmpdir(), 'overlyx-e2e-sync-config') },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  watcher.stdout!.on('data', d => { out += String(d); });
  watcher.stderr!.on('data', d => { out += String(d); });
  await expect.poll(() => out, { timeout: 15_000 }).toContain('Keeping');

  await openDoc(page, `${PROJECT}/main.tex`);
  const editor = page.locator('.lyx-editor');

  // the clone → the open editor
  const file = join(CLONE, 'main.tex');
  writeFileSync(file, readFileSync(file, 'utf8').replace('\\end{document}', 'Written in the clone.\n\n\\end{document}'));
  await expect(editor).toContainText('Written in the clone.', { timeout: 20_000 });

  // the editor → the clone
  const par = editor.locator('.lyx-par', { hasText: 'Written in the clone.' });
  await par.click();
  await page.keyboard.press('End');
  await page.keyboard.type(' Typed in the browser.');
  await expect.poll(() => readFileSync(file, 'utf8'), { timeout: 20_000 }).toContain('Written in the clone. Typed in the browser.');

  // the branch follows a commit made in OverLyX; the clone has nothing left to commit
  expect((await page.request.post(`${BASE_URL}/api/projects/${PROJECT}/git/commit`, { data: { message: 'Checkpoint from the browser' } })).ok()).toBeTruthy();
  const serverHead = git(DIR, 'rev-parse', 'HEAD');
  await expect.poll(() => git(CLONE, 'rev-parse', 'HEAD'), { timeout: 20_000 }).toBe(serverHead);
  expect(git(CLONE, 'status', '--porcelain')).toBe('');
  expect(git(DIR, 'log', '-1', '--format=%s')).toBe('Checkpoint from the browser');
  expect(out).not.toMatch(/✗|error/i);
});
