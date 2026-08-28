/**
 * Offline mode + autosave indicator. Runs against the *built* client served by the server (the
 * service worker only exists in production builds):
 *   OVERLYX_E2E_BASE=http://127.0.0.1:3001 npx playwright test e2e/offline.spec.ts
 */
import { test, expect, type Page } from '@playwright/test';
import { mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { login, collectErrors, adminCredentials, PROJECTS_DIR } from './helpers';

const PROJECT = 'e2e-offline';
const DIR = `${PROJECTS_DIR}/${PROJECT}`;
const DOC = `${PROJECT}/doc.tex`;
const FILE = `${DIR}/doc.tex`;

const LYX = `\\documentclass{article}
\\begin{document}
First paragraph of the offline test.

Second paragraph of the offline test.
\\end{document}
`;

test.describe.configure({ mode: 'serial' });

test.beforeAll(() => { mkdirSync(DIR, { recursive: true }); writeFileSync(FILE, LYX); });
test.afterAll(() => { rmSync(DIR, { recursive: true, force: true }); });

const saveState = (page: Page) => page.locator('.statusbar .save-state');

async function openDoc(page: Page) {
  await page.goto('/#/' + DOC);
  await page.waitForSelector('.lyx-editor .lyx-par', { timeout: 30000 });
}

/** put the caret at the end of the n-th paragraph and type */
async function typeInParagraph(page: Page, n: number, text: string) {
  const par = page.locator('.lyx-editor > .lyx-par').nth(n);
  await par.click();
  await page.keyboard.press('End');
  await page.keyboard.type(text);
}

test('autosave indicator: Saving… → All changes saved, and the file is written', async ({ page }) => {
  const errors = collectErrors(page);
  await login(page);
  await openDoc(page);
  await expect(saveState(page)).toHaveText(/All changes saved/, { timeout: 15000 });
  // there is no Save button any more
  await expect(page.locator('.toolbar [title^="Save"]')).toHaveCount(0);
  await typeInParagraph(page, 0, ' ONLINE-MARK');
  await expect(saveState(page)).toHaveText(/Saving/);
  await expect(saveState(page)).toHaveText(/All changes saved/, { timeout: 15000 });
  expect(readFileSync(FILE, 'utf8')).toContain('ONLINE-MARK');
  expect(errors).toEqual([]);
});

test('edits made offline are kept locally and saved once the connection is back', async ({ page, context }) => {
  await login(page);
  await openDoc(page);
  await expect(saveState(page)).toHaveText(/All changes saved/, { timeout: 15000 });
  // the service worker must be in control before we cut the network (it serves the app shell offline)
  await page.waitForFunction(() => navigator.serviceWorker?.controller != null, null, { timeout: 15000 });

  await context.setOffline(true);
  await expect(saveState(page)).toHaveText(/Offline/, { timeout: 15000 });
  await typeInParagraph(page, 1, ' OFFLINE-MARK');
  await expect(saveState(page)).toHaveText(/kept on this device/, { timeout: 5000 });
  expect(readFileSync(FILE, 'utf8')).not.toContain('OFFLINE-MARK');

  // reloading while offline: app shell from the service worker, document from IndexedDB
  await page.reload();
  await page.waitForSelector('.lyx-editor .lyx-par', { timeout: 30000 });
  await expect(page.locator('.lyx-editor')).toContainText('OFFLINE-MARK');
  await expect(saveState(page)).toHaveText(/Offline/, { timeout: 15000 });
  await typeInParagraph(page, 1, ' OFFLINE-MARK-2');

  await context.setOffline(false);
  await expect(saveState(page)).toHaveText(/All changes saved/, { timeout: 20000 });
  const text = readFileSync(FILE, 'utf8');
  expect(text).toContain('OFFLINE-MARK');
  expect(text).toContain('OFFLINE-MARK-2');
});

test('edits of another user made meanwhile merge with the offline edits', async ({ page, context, browser }) => {
  await login(page);
  await openDoc(page);
  await expect(saveState(page)).toHaveText(/All changes saved/, { timeout: 15000 });
  await page.waitForFunction(() => navigator.serviceWorker?.controller != null, null, { timeout: 15000 });
  await context.setOffline(true);
  await expect(saveState(page)).toHaveText(/Offline/, { timeout: 15000 });
  await typeInParagraph(page, 0, ' MINE-WHILE-OFFLINE');

  const other = await browser.newContext({ viewport: { width: 1200, height: 800 } });
  const page2 = await other.newPage();
  await login(page2);
  await openDoc(page2);
  await expect(saveState(page2)).toHaveText(/All changes saved/, { timeout: 15000 });
  await typeInParagraph(page2, 1, ' THEIRS-MEANWHILE');
  await expect(saveState(page2)).toHaveText(/All changes saved/, { timeout: 15000 });
  expect(readFileSync(FILE, 'utf8')).toContain('THEIRS-MEANWHILE');
  expect(readFileSync(FILE, 'utf8')).not.toContain('MINE-WHILE-OFFLINE');

  await context.setOffline(false);
  await expect(saveState(page)).toHaveText(/All changes saved/, { timeout: 20000 });
  await expect(page.locator('.lyx-editor')).toContainText('THEIRS-MEANWHILE');
  await expect(page2.locator('.lyx-editor')).toContainText('MINE-WHILE-OFFLINE', { timeout: 10000 });
  const text = readFileSync(FILE, 'utf8');
  expect(text).toContain('MINE-WHILE-OFFLINE');
  expect(text).toContain('THEIRS-MEANWHILE');
  await other.close();
});

test('an external save from desktop LyX keeps concurrent edits in other paragraphs', async ({ page }) => {
  await login(page);
  await openDoc(page);
  await expect(saveState(page)).toHaveText(/All changes saved/, { timeout: 15000 });
  // simulate LyX writing the file: change the second paragraph on disk
  const text = readFileSync(FILE, 'utf8').replace('Second paragraph of the offline test.', 'Second paragraph, rewritten in LyX.');
  writeFileSync(FILE, text);
  await expect(page.locator('.lyx-editor')).toContainText('rewritten in LyX', { timeout: 15000 });
  // the first paragraph (untouched by LyX) is still editable and keeps its identity
  await typeInParagraph(page, 0, ' AFTER-EXTERNAL');
  await expect(saveState(page)).toHaveText(/All changes saved/, { timeout: 15000 });
  const now = readFileSync(FILE, 'utf8');
  expect(now).toContain('AFTER-EXTERNAL');
  expect(now).toContain('rewritten in LyX');
});

test('offline edits that cannot be merged (server history re-created) are kept as a version', async ({ page, context, browser }) => {
  await login(page);
  await openDoc(page);
  await expect(saveState(page)).toHaveText(/All changes saved/, { timeout: 15000 });
  await page.waitForFunction(() => navigator.serviceWorker?.controller != null, null, { timeout: 15000 });
  await context.setOffline(true);
  await expect(saveState(page)).toHaveText(/Offline/, { timeout: 15000 });
  await typeInParagraph(page, 0, ' UNMERGEABLE-EDIT');
  await expect(saveState(page)).toHaveText(/kept on this device/, { timeout: 5000 });

  // meanwhile an admin resets the document's collaboration history on the server
  const admin = await browser.newContext();
  const base = process.env.OVERLYX_E2E_BASE ?? 'http://localhost:5173';
  expect((await admin.request.post(base + '/api/auth/login', { data: adminCredentials() })).ok()).toBe(true);
  expect((await admin.request.post(base + `/api/docs/${encodeURIComponent(DOC)}/reset`)).ok()).toBe(true);

  const dialogs: string[] = [];
  page.on('dialog', d => { dialogs.push(d.message()); void d.accept(); });
  await context.setOffline(false);
  await expect.poll(() => dialogs.length, { timeout: 20000 }).toBe(1);
  expect(dialogs[0]).toContain('kept as the version');
  // the document reloads from the server (without the edit) and the edit is available as a version
  await expect(saveState(page)).toHaveText(/All changes saved/, { timeout: 20000 });
  await expect(page.locator('.lyx-editor')).not.toContainText('UNMERGEABLE-EDIT');
  const versions = await (await admin.request.get(base + `/api/docs/${encodeURIComponent(DOC)}/versions`)).json() as { versions: { name: string; kind: string; id: number }[] };
  const v = versions.versions.find(x => x.kind === 'offline');
  expect(v?.name).toContain('offline changes by');
  const content = await (await admin.request.get(base + `/api/docs/${encodeURIComponent(DOC)}/versions/${v!.id}`)).json() as { lyx: string };
  expect(content.lyx).toContain('UNMERGEABLE-EDIT');
  await admin.close();
});
