/**
 * The start page (app/Home.tsx): a brand-new project with 0 documents must be openable from its
 * dashboard tile and from the project switcher — it used to be a dead end, with only a URL hack
 * recovering (persona-p3 F5 / persona-p8 F4, CONFIRMED in verify-vbuild). Every project also offers
 * to download itself as a whole .zip, excluding LaTeX build byproducts (persona-p7 F6). And the
 * example card's welcome blurb must read as one sentence, not run two together for want of a space.
 */
import { test, expect } from '@playwright/test';
import { login, BASE_URL, fillDialog, PROJECTS_DIR } from './helpers';
import { rmSync } from 'node:fs';

// a fresh suffix per run: the server keeps a project's row after its folder is removed, so a fixed name would answer 409 on the next run
const RUN = Date.now().toString(36);
const TILE_PROJECT = `admin/e2e-dash-tile-${RUN}`;
const SWITCH_PROJECT = `admin/e2e-dash-switch-${RUN}`;
const ZIP_PROJECT = `admin/e2e-dash-zip-${RUN}`;

test.beforeAll(() => {
  for (const p of [TILE_PROJECT, SWITCH_PROJECT, ZIP_PROJECT]) rmSync(`${PROJECTS_DIR}/${p}`, { recursive: true, force: true });
});
test.afterAll(() => {
  for (const p of [TILE_PROJECT, SWITCH_PROJECT, ZIP_PROJECT]) rmSync(`${PROJECTS_DIR}/${p}`, { recursive: true, force: true });
});

test('a brand-new project with 0 documents opens from its dashboard tile, and offers to create the first document', async ({ page }) => {
  await login(page);
  expect((await page.request.post(BASE_URL + '/api/projects', { data: { name: `e2e-dash-tile-${RUN}` } })).ok()).toBeTruthy();
  await page.goto('/');
  const card = page.locator(`.home-card[data-project="${TILE_PROJECT}"]`);
  await expect(card).toBeVisible({ timeout: 15000 });
  await expect(card).toContainText('No documents yet');
  const open = card.locator('button', { hasText: 'Open' });
  await expect(open).toHaveCount(1);   // used to render no button at all for a 0-doc project
  await open.click();
  await expect(page).toHaveURL(new RegExp(TILE_PROJECT.replace('/', '\\/') + '$'));
  // the project landing: no "Could not save: not found" error, an explicit "create the first one" offer
  await expect(page.locator('.home h1')).toContainText(`e2e-dash-tile-${RUN}`);
  await expect(page.locator('body')).not.toContainText('Could not save');
  await page.locator('.home button', { hasText: '+ New document' }).click();
  await fillDialog(page, 'main.tex');
  await page.waitForSelector('.lyx-editor .lyx-par', { timeout: 30000 });
  await expect(page).toHaveURL(new RegExp(TILE_PROJECT.replace('/', '\\/') + '\\/main\\.tex'));
});

test('the project switcher also opens an empty project, instead of silently staying put', async ({ page }) => {
  await login(page);
  expect((await page.request.post(BASE_URL + '/api/projects', { data: { name: `e2e-dash-switch-${RUN}` } })).ok()).toBeTruthy();
  await page.goto('/');
  await page.waitForSelector('.docpanel .project-switch', { timeout: 15000 });
  await page.locator('.docpanel .project-switch').selectOption(SWITCH_PROJECT);
  await expect(page).toHaveURL(new RegExp(SWITCH_PROJECT.replace('/', '\\/') + '$'), { timeout: 10000 });
  await expect(page.locator('.home h1')).toContainText(`e2e-dash-switch-${RUN}`);
  await expect(page.locator('body')).not.toContainText('Could not save');
});

test('a project can be downloaded as a whole .zip, excluding LaTeX build byproducts', async ({ page }) => {
  await login(page);
  expect((await page.request.post(BASE_URL + '/api/projects', { data: { name: `e2e-dash-zip-${RUN}` } })).ok()).toBeTruthy();
  expect((await page.request.post(`${BASE_URL}/api/projects/${encodeURIComponent(ZIP_PROJECT)}/new`, { data: { path: 'main.tex', title: 'Zip test' } })).ok()).toBeTruthy();
  expect((await page.request.put(`${BASE_URL}/api/projects/${encodeURIComponent(ZIP_PROJECT)}/text/main.aux`, { data: { text: '% a build byproduct, not a source file' } })).ok()).toBeTruthy();
  await page.goto('/');
  const card = page.locator(`.home-card[data-project="${ZIP_PROJECT}"]`);
  await expect(card).toBeVisible({ timeout: 15000 });
  const link = card.locator('a[data-download-zip]');
  await expect(link).toBeVisible();
  const href = await link.getAttribute('href');
  const res = await page.request.get(href!);
  expect(res.ok()).toBeTruthy();
  expect(res.headers()['content-type']).toContain('zip');
  expect(res.headers()['content-disposition']).toContain('attachment');
  expect(res.headers()['content-disposition']).toContain('.zip');
  const buf = Buffer.from(await res.body());
  expect(buf.subarray(0, 2).toString('latin1')).toBe('PK');   // the zip local-file-header magic
  const raw = buf.toString('latin1');
  expect(raw).toContain('main.tex');
  expect(raw).not.toContain('main.aux');
  // the Git dialog offers the same download, for people who go looking for a backup there
  await page.locator(`.home-card[data-project="${ZIP_PROJECT}"] button[data-git]`).click();
  await expect(page.locator('.dialog a[data-download-zip]')).toBeVisible({ timeout: 15000 });
});

test('the example project\'s welcome text reads as one sentence ("...when you are done. Start the tour...")', async ({ page }) => {
  await login(page);
  await page.goto('/');
  const blurb = page.locator('.home-card.example .blurb');
  await expect(blurb).toBeVisible({ timeout: 15000 });
  const text = (await blurb.innerText()).replace(/\s+/g, ' ');
  expect(text).toContain('when you are done. Start the tour');
  expect(text).not.toContain('done.Start the tour');
});
