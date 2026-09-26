/**
 * Public PDF links: the owner turns one on in the Share dialog, anyone fetches the PDF at that
 * address without an account, and the address dies when the link is turned off.
 */
import { test, expect } from '@playwright/test';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { apiLogin, BASE_URL, PROJECTS_DIR, TOUR_SEEN_SCRIPT } from './helpers';

const PROJECT = 'admin/e2e-pdflink';
const DIR = `${PROJECTS_DIR}/${PROJECT}`;

test.describe.configure({ mode: 'serial' });

test('a public PDF link serves the latest build to anyone, counts the fetches, and stops when turned off', async ({ browser }) => {
  test.setTimeout(240000);
  const admin = await browser.newContext();
  await apiLogin(admin);
  await admin.request.delete(`${BASE_URL}/api/projects/${PROJECT}`).catch(() => {});
  rmSync(DIR, { recursive: true, force: true });
  expect((await admin.request.post(`${BASE_URL}/api/projects`, { data: { name: PROJECT } })).ok()).toBe(true);
  mkdirSync(DIR, { recursive: true });
  writeFileSync(`${DIR}/main.tex`, '\\documentclass{article}\n\\begin{document}\nA public PDF.\n\\end{document}\n');

  const page = await admin.newPage();
  await page.addInitScript(TOUR_SEEN_SCRIPT);
  await page.goto('/');
  await page.locator(`[data-share="${PROJECT}"]`).click();
  const dlg = page.locator('.dialog');
  await expect(dlg).toContainText('Public PDF link', { timeout: 10000 });
  const row = dlg.locator(`[data-pdf-link-doc="main.tex"]`);
  await expect(row.locator('[data-pdf-link-on]')).toBeVisible();
  await row.locator('[data-pdf-link-on]').click();
  const url = await row.locator('input').inputValue();
  expect(url.startsWith(`${BASE_URL}/pdf/`)).toBe(true);
  expect(url).toMatch(new RegExp(`/pdf/[A-Za-z0-9_-]{20,}/${PROJECT.split('/')[1]}\\.pdf$`));   // named after the project, not its owner
  await expect(row).toContainText('Nobody has fetched it yet');

  // anyone: no cookies, no account; the first fetch waits for the build
  const anon = await browser.newContext();
  const r = await anon.request.get(url, { timeout: 180000 });
  expect(r.status()).toBe(200);
  expect(r.headers()['content-type']).toContain('application/pdf');
  expect(r.headers()['content-disposition']).toContain(`inline; filename="${PROJECT.split('/')[1]}.pdf"`);
  expect(r.headers()['x-frame-options']).toBeUndefined();
  expect(r.headers()['access-control-allow-origin']).toBe('*');
  expect((await r.body()).subarray(0, 5).toString()).toBe('%PDF-');
  // a download variant, and a conditional fetch that comes back empty
  const dl = await anon.request.get(url + '?download=1', { timeout: 60000 });
  expect(dl.headers()['content-disposition']).toContain('attachment');
  const again = await anon.request.get(url, { headers: { 'If-None-Match': r.headers()['etag'] }, maxRedirects: 0 });
  expect(again.status()).toBe(304);
  // the owner sees the fetches
  await expect(row).toContainText(/Fetched 2 times/, { timeout: 15000 });

  // the PDF panel of the document offers the link to the owner
  await page.keyboard.press('Escape');
  await page.goto(`/#/${PROJECT}/main.tex`);
  await page.waitForSelector('.lyx-editor', { timeout: 30000 });
  await page.locator('.rail.right [data-rail="pdf"], .sidebar.right [data-tab="pdf"]').first().click();
  await expect(page.locator('[data-pdf-public-link]')).toBeVisible({ timeout: 10000 });
  await page.locator('[data-pdf-public-link]').click();
  await expect(page.locator('.dialog')).toContainText('Public PDF link', { timeout: 10000 });
  // off: the address is dead, a reader sees why
  await page.locator('.dialog [data-pdf-link-doc="main.tex"] [data-pdf-link-off]').click();
  await expect(page.locator('.dialog [data-pdf-link-doc="main.tex"] [data-pdf-link-on]')).toBeVisible();
  const dead = await anon.request.get(url);
  expect(dead.status()).toBe(404);
  expect(await dead.text()).toContain('turned off');
  await page.keyboard.press('Escape');

  // the import routes need an account
  const noAuth = await anon.request.post(`${BASE_URL}/api/import/zip?name=x`, { data: 'zip' });
  expect(noAuth.status()).toBe(401);

  await admin.request.delete(`${BASE_URL}/api/projects/${PROJECT}`);
  await anon.close(); await admin.close();
});
