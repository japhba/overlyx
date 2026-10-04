/**
 * File ▸ Google Docs…: connect Google Drive, create a Google Doc from a markdown document, and
 * sync — a collaborator's comment and edit in Google Docs come back as a comment card and a
 * tracked change; a comment written here goes to Google Docs.
 *
 * Needs a server started with OVERLYX_E2E_GOOGLE_STUB=1 (the Google APIs simulated: server
 * gdocs/fake.ts; the test plays the collaborator through /api/gdocs/e2e/*).
 */
import { test, expect } from '@playwright/test';
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { login, PROJECTS_DIR, collectErrors } from './helpers';

const PROJECT = 'admin/e2e-gdocs';
const DIR = `${PROJECTS_DIR}/${PROJECT}`;
const ID = `${PROJECT}/draft.md`;

test.beforeAll(() => {
  rmSync(DIR, { recursive: true, force: true });
  mkdirSync(DIR, { recursive: true });
  writeFileSync(`${DIR}/draft.md`, '# Draft\n\nThe method converges quickly.\n\nA second paragraph.\n');
});
test.afterAll(() => { rmSync(DIR, { recursive: true, force: true }); });

test('a markdown document synced with Google Docs: comments and edits come back, a comment goes there', async ({ page }) => {
  const errors = collectErrors(page);
  await login(page);
  const stub = await page.request.get('/api/gdocs/status?doc=' + encodeURIComponent(ID));
  test.skip(!(await stub.json()).configured, 'the server runs without OVERLYX_E2E_GOOGLE_STUB=1');
  await page.request.get('/api/projects');
  // (a connection and a link left from an earlier run)
  await page.request.post('/api/gdocs/disconnect');
  await page.request.post('/api/docs/' + encodeURIComponent(ID) + '/gdocs/unlink');
  await page.goto('/#/' + ID);
  await page.waitForFunction(() => document.querySelectorAll('.lyx-editor .lyx-par').length >= 3, null, { timeout: 30000 });

  await page.click('.menubar .menu button:has-text("File")');
  await page.click('.menu-item:has-text("Google Docs")');
  const dlg = page.locator('[data-gdocs]');
  await dlg.locator('[data-gdocs-connect]').click();
  // (back from "Google": the dialog opens again)
  await expect(page.locator('[data-gdocs-create]')).toBeVisible({ timeout: 20000 });
  await page.locator('[data-gdocs-create]').click();
  await expect(page.locator('[data-gdocs-open]')).toBeVisible({ timeout: 20000 });
  const google = async () => (await (await page.request.get('/api/gdocs/e2e/doc?doc=' + encodeURIComponent(ID))).json()) as { text: string; comments: { content: string; replies: unknown[] }[] };
  expect((await google()).text).toBe('Draft\nThe method converges quickly.\nA second paragraph.');

  // the collaborator: a comment and an edit
  await page.request.post('/api/gdocs/e2e/comment', { data: { doc: ID, quote: 'converges', content: 'Cite the proof?' } });
  await page.request.post('/api/gdocs/e2e/edit', { data: { doc: ID, from: 'quickly', to: 'very quickly' } });
  await page.locator('[data-gdocs-sync]').click();
  await expect(page.locator('[data-gdocs-sync]')).toHaveText('Sync now', { timeout: 20000 });
  await page.keyboard.press('Escape');
  const ed = page.locator('.lyx-editor');
  await expect(ed.locator('.lyx-inset-note-comment')).toContainText('Cite the proof?', { timeout: 15000 });
  await expect(ed.locator('.lyx-change-inserted', { hasText: 'very' })).toHaveCount(1);
  await expect.poll(() => readFileSync(`${DIR}/draft.md`, 'utf8'), { timeout: 15000 }).toMatch(/converges<!-- @comment[\s\S]*Kirsten[\s\S]*Cite the proof\?[\s\S]*-->.*<ins author="Kirsten \(Google Docs\)"/);

  // a comment written here goes to Google Docs
  await ed.locator('.lyx-par', { hasText: 'A second paragraph.' }).click();
  await page.keyboard.press('End');
  await page.keyboard.press('Control+Alt+c');
  await page.keyboard.type('Expand this', { delay: 10 });
  await page.waitForTimeout(2500);   // (the save)
  await page.click('.menubar .menu button:has-text("File")');
  await page.click('.menu-item:has-text("Google Docs")');
  await page.locator('[data-gdocs-sync]').click();
  await expect.poll(async () => (await google()).comments.map(c => c.content), { timeout: 20000 }).toContain('Admin: Expand this');
  expect(errors).toEqual([]);
});
