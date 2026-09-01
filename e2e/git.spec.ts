/**
 * Every project is a git repository: the Git dialog (clone URL, access tokens, history, commit
 * now), and a real clone / push / pull from "a local machine" (this test process) with a token
 * created in the dialog. Runs as the admin against an isolated instance (see README, "Tests").
 */
import { test, expect, type Page } from '@playwright/test';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { login, BASE_URL, PROJECTS_DIR } from './helpers';

const PROJECT = 'e2e-git';
const DIR = `${PROJECTS_DIR}/${PROJECT}`;
const CLONE = join(tmpdir(), 'overlyx-e2e-git-clone');
const git = (dir: string, ...args: string[]) => execFileSync('git', ['-C', dir, ...args], {
  env: { ...process.env, GIT_TERMINAL_PROMPT: '0', GIT_AUTHOR_NAME: 'Laptop', GIT_AUTHOR_EMAIL: 'l@x', GIT_COMMITTER_NAME: 'Laptop', GIT_COMMITTER_EMAIL: 'l@x', GIT_CONFIG_COUNT: '1', GIT_CONFIG_KEY_0: 'safe.directory', GIT_CONFIG_VALUE_0: '*' },
  encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'],
}).toString();

test.describe.configure({ mode: 'serial' });

let token = '';
let cloneUrl = '';

test.beforeAll(() => {
  rmSync(DIR, { recursive: true, force: true });
  rmSync(CLONE, { recursive: true, force: true });
});
test.afterAll(() => {
  rmSync(DIR, { recursive: true, force: true });
  rmSync(CLONE, { recursive: true, force: true });
});

async function openGitDialog(page: Page) {
  await page.locator(`.home-card[data-project="${PROJECT}"] button[data-git]`).click();
  const dlg = page.locator('.dialog');
  await expect(dlg).toContainText('Clone to your computer', { timeout: 15000 });
  await expect(dlg.locator('.git-copy input').first()).toHaveValue(new RegExp(`/git/${PROJECT}\\.git$`), { timeout: 15000 });
  return dlg;
}

test('a new project is a repository; the dialog shows the clone URL and creates a token', async ({ page }) => {
  await login(page);
  const r = await page.request.post(BASE_URL + '/api/projects', { data: { name: PROJECT } });
  expect(r.ok()).toBeTruthy();
  await page.request.post(`${BASE_URL}/api/projects/${PROJECT}/new`, { data: { path: 'main.tex', title: 'Git test' } });
  await page.goto('/');
  await page.waitForSelector(`.home-card[data-project="${PROJECT}"]`, { timeout: 20000 });
  const dlg = await openGitDialog(page);
  cloneUrl = await dlg.locator('.git-copy input').first().inputValue();
  expect(cloneUrl).toContain(`/git/${PROJECT}.git`);
  await expect(dlg).toContainText('Username admin');
  // the repository exists on disk with an initial commit
  await expect.poll(() => existsSync(join(DIR, '.git'))).toBe(true);
  await expect(dlg.locator('[data-git-log]')).toContainText('Import "e2e-git" into OverLyX', { timeout: 15000 });
  // a token
  await dlg.locator('.share-add input').first().fill('e2e laptop');        // the first .share-add row is the access tokens (the MCP tokens have their own)
  await dlg.locator('.share-add button', { hasText: 'New token' }).first().click();
  await expect(dlg.locator('.git-newtoken')).toContainText('e2e laptop', { timeout: 10000 });
  token = await dlg.locator('.git-newtoken input').inputValue();
  expect(token).toMatch(/^olx_/);
  await expect(dlg.locator('.git-token')).toHaveCount(1);
  await expect(dlg.locator('.git-token')).toContainText('never used');
});

test('clone with the token, push a change, pull what OverLyX committed', async ({ page }) => {
  const withAuth = cloneUrl.replace('://', `://admin:${encodeURIComponent(token)}@`);
  git(tmpdir(), 'clone', '-q', withAuth, CLONE);
  expect(existsSync(join(CLONE, 'main.tex'))).toBe(true);
  expect(readFileSync(join(CLONE, '.gitignore'), 'utf8')).toContain('*.aux');
  // push a new file: it appears in the project (and the file browser)
  writeFileSync(join(CLONE, 'notes.tex'), '% pushed from the laptop\n');
  git(CLONE, 'add', '-A');
  git(CLONE, 'commit', '-q', '-m', 'Notes from the laptop');
  git(CLONE, 'push', '-q', 'origin', 'main');
  expect(readFileSync(join(DIR, 'notes.tex'), 'utf8')).toBe('% pushed from the laptop\n');
  await login(page);
  await page.goto('/');
  await page.waitForSelector(`.home-card[data-project="${PROJECT}"]`, { timeout: 20000 });
  const dlg = await openGitDialog(page);
  await expect(dlg.locator('[data-git-log]')).toContainText('Notes from the laptop', { timeout: 15000 });
  await expect(dlg.locator('.git-token')).toContainText('last used', { timeout: 15000 });
  // something changed in OverLyX (a text file saved): "Commit now" commits it, and the clone can pull it
  const put = await page.request.put(`${BASE_URL}/api/projects/${PROJECT}/text/refs.bib`, { data: { text: '@article{k, title={From OverLyX}}\n' } });
  expect(put.ok()).toBeTruthy();
  await expect(dlg.locator('.git-pending')).toContainText('refs.bib', { timeout: 15000 });
  await dlg.locator('.git-pending input').fill('Add refs.bib');
  await dlg.locator('button[data-git-commit]').click();
  await expect(dlg.locator('[data-git-log]')).toContainText('Add refs.bib', { timeout: 15000 });
  await expect(dlg).toContainText('Everything is committed');
  git(CLONE, 'pull', '-q', '--no-rebase', 'origin', 'main');
  expect(readFileSync(join(CLONE, 'refs.bib'), 'utf8')).toContain('From OverLyX');
  // the token can be revoked
  page.on('dialog', d => d.accept());
  await dlg.locator('.git-token button', { hasText: 'Revoke' }).click();
  await expect(dlg.locator('.git-token')).toHaveCount(0, { timeout: 10000 });
  expect(() => git(CLONE, 'fetch', '-q', 'origin')).toThrow(/401|Authentication|failed/);
});

test('with token re-copy enabled for the account, agent tokens can be copied again later', async ({ page }) => {
  await login(page);
  page.on('dialog', d => d.accept());
  // switch the account setting on (what Settings ▸ Account does)
  const me = await (await page.request.get(BASE_URL + '/api/auth/me')).json();
  const en = await page.request.post(`${BASE_URL}/api/admin/users/${me.user.id}/settings`, { data: { allowRecopyTokens: true } });
  expect(en.ok()).toBeTruthy();
  const dlg = await openGitDialog(page);
  await dlg.locator('.share-add input').nth(1).fill('recopy bot');            // the second .share-add row is the MCP agent tokens
  await dlg.locator('.share-add button', { hasText: 'New agent token' }).click();
  await expect(dlg.locator('.git-newtoken')).toContainText('recopy bot', { timeout: 10000 });
  // reopen from scratch — normally the token would be gone for good; with the setting on, the row offers Copy
  await page.reload();
  const dlg2 = await openGitDialog(page);
  const row = dlg2.locator('.git-token', { hasText: 'recopy bot' });
  await expect(row.locator('[data-token-copy]')).toBeVisible({ timeout: 10000 });
  // what that button copies: the API hands the plaintext back to this account
  const listed = await (await page.request.get(`${BASE_URL}/api/mcp-tokens`)).json();
  expect(listed.tokens.find((t: { name: string }) => t.name === 'recopy bot').token).toMatch(/^olxmcp_/);
  // clean up: revoke, and the setting back off
  await row.locator('button', { hasText: 'Revoke' }).click();
  await expect(dlg2.locator('.git-token', { hasText: 'recopy bot' })).toHaveCount(0, { timeout: 10000 });
  await page.request.post(`${BASE_URL}/api/admin/users/${me.user.id}/settings`, { data: { allowRecopyTokens: false } });
});
