/** Narrow/touch viewport layout: panel drawers, fit/zoom, toolbar reachability and rotation. */
import { test, expect, type Page } from '@playwright/test';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { login, newTouchContext, PROJECTS_DIR } from './helpers';

const RUN = Date.now().toString(36);
const PROJECT = `admin/e2e-mobile-${RUN}`;
const DIR = `${PROJECTS_DIR}/${PROJECT}/talk`;
const FILE = `${DIR}/index.html`;
const source = `<!doctype html><html><head><meta name="overlyx" content="deck"><title>Mobile layout</title>
<style>html,body{margin:0}.slide{position:relative;width:1280px;height:720px;background:#eef5fa;color:#163349;font:32px sans-serif}.slide h1{margin:0;padding:72px}.slide p{margin:0;padding:28px}</style></head><body>
<section class="slide"><h1>Community energy</h1><p>Neighborhood-scale generation and storage.</p></section>
<section class="slide"><h1>Shared resilience</h1><p>Microgrids keep essential services online.</p></section></body></html>`;

test.afterAll(() => rmSync(`${PROJECTS_DIR}/${PROJECT}`, { recursive: true, force: true }));

async function assertFrameFits(page: Page, width: number, minimumCanvasWidth = width - 28) {
  const canvas = await page.locator('.dl-canvas').boundingBox();
  // The host iframe has a deliberate 48 px design margin either side; assert the actual
  // slide viewport, not that padded iframe, stays in the canvas and browser viewport.
  const frame = await page.frameLocator('.dl-frame').locator('section.slide').first().boundingBox();
  expect(canvas, 'canvas exists').not.toBeNull();
  expect(frame, 'slide frame exists').not.toBeNull();
  expect(canvas!.x).toBeGreaterThanOrEqual(-1);
  expect(canvas!.x + canvas!.width).toBeLessThanOrEqual(width + 1);
  expect(canvas!.width).toBeGreaterThan(minimumCanvasWidth);
  expect(frame!.x).toBeGreaterThanOrEqual(canvas!.x - 1);
  expect(frame!.x + frame!.width).toBeLessThanOrEqual(canvas!.x + canvas!.width + 1);
}

async function fit(page: Page) {
  await page.locator('[data-dl-zoom]').selectOption('fit');
  await expect(page.locator('[data-dl-zoom]')).toHaveValue('fit');
}

async function toggleFiles(page: Page) {
  if (await page.locator('.sidebar.left').count()) {
    await page.locator('.sidebar.left button.hide').click();
  } else {
    await page.locator('.statusbar-corner [data-rail="outline"]').click();
  }
}

test('phone/tablet drawers preserve the fitted slide through open, close, rotation and reload', async ({ browser }, testInfo) => {
  mkdirSync(DIR, { recursive: true });
  writeFileSync(FILE, source);
  const context = await newTouchContext(browser, { viewport: { width: 390, height: 844 } });
  const page = await context.newPage();
  try {
    page.setDefaultTimeout(7000);
    page.setDefaultNavigationTimeout(30000);
    await page.setViewportSize({ width: 390, height: 844 });
    await login(page);
    await page.goto(`/#/${PROJECT}/talk/index.html`);
    await page.frameLocator('.dl-frame').locator('section.slide').first().waitFor();
    await fit(page);
    await assertFrameFits(page, 390);

    // The main tool strip can be swiped, while the important view controls remain on-screen.
    const zoom = await page.locator('[data-dl-zoom]').boundingBox();
    const present = await page.locator('[data-dl-present]').boundingBox();
    expect(zoom).not.toBeNull();
    expect(present).not.toBeNull();
    expect(zoom!.x + zoom!.width).toBeLessThanOrEqual(390);
    expect(present!.x + present!.width).toBeLessThanOrEqual(390);

    // Exercise a non-fit zoom then return to Fit with both panels open.
    await page.locator('[data-dl-zoom]').selectOption('75');
    await expect(page.locator('[data-dl-zoom]')).toHaveValue('75');
    await fit(page);
    await toggleFiles(page);
    await expect(page.locator('.sidebar.left')).toBeVisible();
    await assertFrameFits(page, 390);
    await page.locator('[data-dl-rail-show]').click();
    await expect(page.locator('.dl-rail')).toBeVisible();
    await assertFrameFits(page, 390);
    await page.screenshot({ path: testInfo.outputPath('390x844-files-and-slides-open.png') });

    // Persist both open states through a reload; neither may push the canvas off-screen.
    await page.reload();
    await page.frameLocator('.dl-frame').locator('section.slide').first().waitFor();
    await expect(page.locator('.sidebar.left')).toBeVisible();
    await expect(page.locator('.dl-rail')).toBeVisible();
    await fit(page);
    await assertFrameFits(page, 390);

    // With both left-side drawers open the Files drawer is in front, so close it first.
    await toggleFiles(page);
    await expect(page.locator('.sidebar.left')).toHaveCount(0);
    await page.locator('[data-dl-rail-hide]').click();
    await expect(page.locator('.dl-rail')).toHaveCount(0);
    await assertFrameFits(page, 390);

    // iPad portrait and landscape rotation. At tablet widths, open drawers remain within
    // the viewport; fit is reapplied after each resize so the slide cannot retain stale pan.
    for (const size of [{ width: 768, height: 1024 }, { width: 1024, height: 768 }]) {
      await page.setViewportSize(size);
      await fit(page);
      await assertFrameFits(page, size.width, size.width > 900 ? 500 : undefined);
      await page.screenshot({ path: testInfo.outputPath(`${size.width}x${size.height}-files-and-slides-open.png`) });
      await toggleFiles(page);
      await expect(page.locator('.sidebar.left')).toBeVisible();
      await page.locator('[data-dl-rail-show]').click();
      await expect(page.locator('.dl-rail')).toBeVisible();
      await fit(page);
      await assertFrameFits(page, size.width, size.width > 900 ? 500 : undefined);
      await toggleFiles(page);
      await expect(page.locator('.sidebar.left')).toHaveCount(0);
      await page.locator('[data-dl-rail-hide]').click();
      await expect(page.locator('.dl-rail')).toHaveCount(0);
      await assertFrameFits(page, size.width);
    }

    // The original 800 px toolbar case: key view/output actions must be physically on-screen.
    await page.setViewportSize({ width: 800, height: 600 });
    await fit(page);
    await assertFrameFits(page, 800);
    for (const selector of ['[data-dl-zoom]', '[data-dl-code]', '[data-dl-download]', '[data-dl-present]']) {
      const rect = await page.locator(selector).boundingBox();
      expect(rect, `${selector} is rendered`).not.toBeNull();
      expect(rect!.x).toBeGreaterThanOrEqual(0);
      expect(rect!.x + rect!.width).toBeLessThanOrEqual(800);
      expect(rect!.y + rect!.height).toBeLessThanOrEqual(600);
    }
  } finally {
    await context.close();
  }
});
