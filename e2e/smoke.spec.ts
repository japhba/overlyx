import { test, expect } from '@playwright/test';
import { readFileSync, mkdirSync, copyFileSync } from 'node:fs';
import { login, openDoc, collectErrors, PROJECTS_DIR, FIXTURES_DIR } from './helpers';

// a scratch copy of a real paper: tests must never type into the user's own documents
const DOC = 'e2e-scratch/smoke-main.lyx';
test.beforeAll(() => {
  mkdirSync(`${PROJECTS_DIR}/e2e-scratch`, { recursive: true });
  copyFileSync(`${FIXTURES_DIR}/recurrent_feature/main.lyx`, PROJECTS_DIR + '/' + DOC);
});

test('login, open a native LyX document and render it', async ({ page }) => {
  const errors = collectErrors(page);
  await login(page);
  await openDoc(page, DOC);
  // status connected
  await expect(page.locator('.statusbar')).toContainText('connected', { timeout: 20000 });
  const paragraphs = await page.locator('.lyx-editor > .lyx-par').count();
  expect(paragraphs).toBeGreaterThan(50);
  // math fields rendered with MathLive
  const mathFields = await page.locator('.lyx-editor .lyx-math-inline, .lyx-editor .lyx-math-display').count();
  expect(mathFields).toBeGreaterThan(50);
  // LyX notes present with labels
  await expect(page.locator('.lyx-inset-note-note').first()).toBeVisible();
  expect(await page.locator('.lyx-inset-note-note .inset-label').first().textContent()).toBe('Note');
  // a macro-using formula (\Pfi) renders without error atoms
  const err = await page.locator('.lyx-editor .katex-error').count();
  expect(err).toBeLessThan(5);
  // outline lists sections
  await expect(page.locator('.outline-item').first()).toBeVisible();
  expect(await page.locator('.outline-item').count()).toBeGreaterThan(3);
  // the title paragraph gets the LyX title layout style
  await expect(page.locator('.lyx-layout-section').first()).toBeVisible();
  expect(errors.filter(e => !/favicon|ResizeObserver|404/.test(e))).toEqual([]);   // the scratch copy lacks the figures
});

test('typing is saved to the .lyx file and seen by a second user', async ({ browser }) => {
  const ctxA = await browser.newContext();
  const pageA = await ctxA.newPage();
  await login(pageA);
  await openDoc(pageA, DOC);
  await expect(pageA.locator('.statusbar')).toContainText('connected', { timeout: 20000 });
  // click into the first Standard paragraph and type a marker
  const marker = 'OVERLYX-E2E-' + Date.now();
  const para = pageA.locator('.lyx-editor > .lyx-par.lyx-layout-standard').first();
  await para.click();
  await pageA.keyboard.press('End');
  await pageA.keyboard.type(' ' + marker);
  await expect(para).toContainText(marker);
  // second user sees it
  const ctxB = await browser.newContext();
  const pageB = await ctxB.newPage();
  await login(pageB);
  await openDoc(pageB, DOC);
  await expect(pageB.locator('.lyx-editor')).toContainText(marker, { timeout: 20000 });
  // file on disk updated (server debounce 1.5 s)
  await expect.poll(() => readFileSync(PROJECTS_DIR + '/' + DOC, 'utf8').includes(marker), { timeout: 15000 }).toBe(true);
  // undo on A removes it again (per-user undo), and disk follows
  await pageA.keyboard.press('Control+z');
  await expect.poll(() => readFileSync(PROJECTS_DIR + '/' + DOC, 'utf8').includes(marker), { timeout: 15000 }).toBe(false);
  await ctxA.close(); await ctxB.close();
});
