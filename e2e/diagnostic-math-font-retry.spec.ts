/**
 * Opt-in GUI fault injection for a genuine MathJax SVG dynamic-font retry. This is not an iPad or
 * physical-device result, and deliberately is not included in the release matrix. A route pauses
 * one real self-hosted MathJax font chunk; the page continues to be authored only through the UI.
 */
import { test, expect, type Page } from '@playwright/test';
import { mkdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { login, PROJECTS_DIR } from './helpers';

const RUN = process.env.OVERLYX_MATH_FONT_RETRY_RUN ?? Date.now().toString(36);
const NAME = `math-font-retry-${RUN}`;
const SOURCE = path.join(PROJECTS_DIR, 'admin', NAME, 'slides', 'index.html');
const EVIDENCE = path.resolve('scratch/slide-audit/evidence/math-font-retry', RUN);
const DYNAMIC_CHUNK = '**/mathjax-newcm-font/svg/dynamic/greek.js';

function position(page: Page, ratioX: number, ratioY: number): Promise<{ x: number; y: number }> {
  return page.frameLocator('.dl-frame').locator('section.slide').first().boundingBox().then(box => {
    if (!box) throw new Error('Visible slide canvas has no bounds');
    return { x: box.x + box.width * ratioX, y: box.y + box.height * ratioY };
  });
}

async function waitSaved(page: Page): Promise<void> {
  await expect(page.locator('.dl-status')).toHaveText('Saved', { timeout: 30_000 });
}

async function createInlineMath(page: Page, x: number, y: number, before: string, tex: string, after = '') {
  await page.locator('[data-tb="dk-text"]').click();
  const slideBox = await page.frameLocator('.dl-frame').locator('section.slide').first().boundingBox();
  if (!slideBox) throw new Error('Visible slide canvas has no bounds');
  await page.mouse.move(x, y);
  await page.mouse.down();
  await page.mouse.move(Math.min(slideBox.x + slideBox.width * 0.9, x + slideBox.width * 0.72), y + 18, { steps: 6 });
  await page.mouse.up();
  const slide = page.frameLocator('.dl-frame').locator('section.slide').first();
  const editor = slide.locator('[contenteditable="true"]').last();
  await expect(editor).toBeVisible();
  await page.keyboard.type(before, { delay: 12 });
  await page.keyboard.press('Control+m');
  const field = page.locator('[data-dl-mathedit] .lm-field');
  await expect(field).toBeVisible({ timeout: 15_000 });
  await page.keyboard.type(tex, { delay: 20 });
  await page.keyboard.press('Escape');
  await expect(page.locator('[data-dl-mathedit]')).toHaveCount(0, { timeout: 30_000 });
  if (after) await page.keyboard.type(after, { delay: 15 });
  await page.keyboard.press('Escape');
  await waitSaved(page);
}

test('a paused real SVG font chunk cannot restore stale math over GUI retyping or lose following prose', async ({ page }) => {
  mkdirSync(EVIDENCE, { recursive: true });
  const errors: string[] = [];
  page.on('pageerror', error => errors.push(error.message));
  page.on('console', message => { if (message.type() === 'error') errors.push(message.text()); });
  await login(page, undefined, { ui: 'default' });

  // Create the deck through New, not by seeding or writing its HTML source.
  await page.locator('[data-new-project]').click();
  await page.locator('[data-new-kind="deck"]').click();
  await page.locator('[data-new-name]').fill(NAME);
  await page.locator('[data-new-create]').click();
  const slide = page.frameLocator('.dl-frame').locator('section.slide').first();
  await expect(slide.locator('h1').first()).toBeVisible({ timeout: 30_000 });
  const oldPoint = await position(page, 0.1, 0.67);
  const newPoint = await position(page, 0.1, 0.82);
  await createInlineMath(page, oldPoint.x, oldPoint.y, 'Before ', 'x+1', ' after-old');
  await createInlineMath(page, newPoint.x, newPoint.y, 'Second box ', 'y+1', ' after-second');
  await waitSaved(page);
  const renderedMath = slide.locator('mjx-container');
  await expect(renderedMath).toHaveCount(2);

  // Genuine first network request is held. Greek U+03DD (ϝ) is listed in the bundled New Computer
  // Modern SVG font's lazy `greek` range, unlike the already-used basic Latin in the newer formula.
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  let signalRequest!: () => void;
  const requestStarted = new Promise<void>(resolve => { signalRequest = resolve; });
  let signalSettled!: () => void;
  const requestSettled = new Promise<void>(resolve => { signalSettled = resolve; });
  let pausedPath = '';
  let heldRequests = 0;
  let pageClosing = false;
  page.on('close', () => { pageClosing = true; release(); });
  await page.route(DYNAMIC_CHUNK, async route => {
    heldRequests++;
    if (heldRequests > 1) { await route.continue(); return; }
    // Retain only the path for evidence; do not record query strings or signed URLs.
    pausedPath = new URL(route.request().url()).pathname;
    signalRequest();
    await gate;
    if (pageClosing) { await route.abort(); signalSettled(); return; }
    try {
      const response = await route.fetch();
      await route.fulfill({ response });
    } finally { signalSettled(); }
  });

  // Chips are transient to a live text-edit session, so use stable authored objects and their
  // visible MathJax roots outside edit mode; IDs are read only while a particular chip is active.
  const oldMath = renderedMath.nth(0);
  const oldBox = await oldMath.boundingBox();
  if (!oldBox) throw new Error('Old formula chip is not on screen');
  await page.mouse.dblclick(oldBox.x + oldBox.width / 2, oldBox.y + oldBox.height / 2);
  const field = page.locator('[data-dl-mathedit] .lm-field');
  await expect(field).toBeVisible({ timeout: 15_000 });
  await page.keyboard.press('Control+a');
  await page.keyboard.type('ϝ', { delay: 40 });
  await requestStarted;
  expect(pausedPath).toMatch(/mathjax-newcm-font\/svg\/dynamic\/greek\.js$/);
  expect(heldRequests).toBe(1);
  const activeOld = page.frameLocator('.dl-frame').locator('.ol-mathchip[data-ol-mathediting]');
  const oldId = await activeOld.getAttribute('data-ol-chip');
  expect(oldId).toBeTruthy();
  expect(await activeOld.getAttribute('data-ol-tex')).not.toBe('x+1');

  // The editor's normal close affordance has an 800 ms UI fallback while runtime work settles.
  // Let it close with the real font fetch still held, then reopen on another chip.
  await page.keyboard.press('Escape');
  await expect(page.locator('[data-dl-mathedit]')).toHaveCount(0, { timeout: 2_000 });
  const secondMath = renderedMath.nth(1);
  const secondBox = await secondMath.boundingBox();
  if (!secondBox) throw new Error('Second formula chip is not on screen');
  await page.mouse.dblclick(secondBox.x + secondBox.width / 2, secondBox.y + secondBox.height / 2);
  const activeChip = page.frameLocator('.dl-frame').locator('.ol-mathchip[data-ol-mathediting]');
  await expect(activeChip).toHaveCount(1, { timeout: 15_000 });
  const newId = await activeChip.getAttribute('data-ol-chip');
  expect(newId).toBeTruthy();
  expect(newId).not.toBe(oldId);
  expect(await activeChip.getAttribute('data-ol-src')).toContain('y+1');
  await expect(field).toBeVisible();
  await page.keyboard.press('Control+a');
  await page.keyboard.type('u+2', { delay: 35 });

  // This is the test's decisive precondition: the exact real request is still paused while the UI
  // has reopened on a different chip and the user has typed into that target.
  expect(heldRequests).toBe(1);
  const beforeRelease = readFileSync(SOURCE, 'utf8');
  expect(beforeRelease).toContain('Before');
  expect(beforeRelease).toContain('after-second');
  await page.screenshot({ path: path.join(EVIDENCE, 'during-paused-retry.png') });
  release();
  await requestSettled;

  // The old runtime close reply arrives only after the delayed font settles. It must neither close
  // nor replace the newly opened field, even though MathJax serializes the queued typeset calls.
  await expect.poll(async () => page.frameLocator('.dl-frame').locator('.ol-mathchip[data-ol-mathediting]').getAttribute('data-ol-chip'), { timeout: 30_000 }).toBe(newId);
  await expect(field).toBeVisible();
  const activeTex = await activeChip.getAttribute('data-ol-tex');
  expect(activeTex).toContain('u+2');
  expect(await activeChip.getAttribute('data-ol-chip')).toBe(newId);

  await page.keyboard.press('Escape');
  await expect(page.locator('[data-dl-mathedit]')).toHaveCount(0, { timeout: 30_000 });
  // Ordinary prose immediately after leaving the retargeted formula tests the final caret handoff.
  await page.keyboard.type(' newest-tail', { delay: 18 });
  await page.keyboard.press('Escape');
  await waitSaved(page);

  const saved = readFileSync(SOURCE, 'utf8');
  expect(saved).toContain('after-old');
  expect(saved).toContain('newest-tail');
  expect(saved).toContain('u+2');
  // The delayed old formula legitimately saves its latest entered glyph, but may not roll back the
  // newer independent box or duplicate/misplace the prose around either chip.
  expect(saved.match(/after-old/g) ?? []).toHaveLength(1);
  expect(saved.match(/newest-tail/g) ?? []).toHaveLength(1);
  expect(saved.indexOf('Second box')).toBeLessThan(saved.indexOf('after-second'));
  expect(saved.indexOf('after-second')).toBeLessThan(saved.indexOf('newest-tail'));
  await expect(renderedMath).toHaveCount(2);
  await expect(page.locator('[data-dl-mathedit]')).toHaveCount(0);
  await page.screenshot({ path: path.join(EVIDENCE, 'after-retry-saved.png') });

  // Reload is the round-trip check for the delivered source rather than only the in-memory canvas.
  await page.reload();
  await expect(page.frameLocator('.dl-frame').locator('section.slide').first()).toBeVisible({ timeout: 30_000 });
  const reopened = readFileSync(SOURCE, 'utf8');
  expect(reopened).toContain('newest-tail');
  expect(reopened.match(/after-old/g) ?? []).toHaveLength(1);
  expect(reopened.match(/newest-tail/g) ?? []).toHaveLength(1);
  await expect(page.frameLocator('.dl-frame').locator('section.slide mjx-container')).toHaveCount(2);
  await expect(page.frameLocator('.dl-frame').locator('section.slide')).toContainText('after-old');
  await expect(page.frameLocator('.dl-frame').locator('section.slide')).toContainText('newest-tail');
  expect(errors).toEqual([]);
});
