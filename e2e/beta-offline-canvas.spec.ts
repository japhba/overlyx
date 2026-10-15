/** A cold offline reopening must render and edit the latest local source,
 * not just mount an empty iframe or replay an older server snapshot. */
import { test, expect } from '@playwright/test';
import { readFileSync, rmSync } from 'node:fs';
import path from 'node:path';
import { login, userCredentials, PROJECTS_DIR } from './helpers';

test('GUI deck with local pictures and math remains editable across two cold offline reloads', async ({ page, context, browserName }) => {
  test.skip(['OVERLYX_E2E_BASE', 'OVERLYX_PROJECTS_DIR', 'OVERLYX_E2E_CREDENTIALS'].some(key => !process.env[key]), 'Requires an isolated GUI test instance');
  test.skip(browserName === 'webkit', 'Playwright WebKit fails emulated-offline navigation before consulting the service worker');
  const name = `cold-offline-${Date.now().toString(36)}`;
  const dir = path.join(PROJECTS_DIR, 'luna4', name);
  const file = path.join(dir, 'slides', 'index.html');
  const source = () => readFileSync(file, 'utf8');
  const slides = () => page.frameLocator('.dl-frame').locator('section.slide');
  const rail = () => page.frameLocator('.dl-railframe').locator('section.slide');
  const title = () => slides().first().locator('h1');
  const errors: string[] = [];
  page.on('pageerror', error => errors.push(error.name));
  const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAACAAAAAYCAIAAAAUMWhjAAAAJElEQVR4nGMwqlhFU8QwasGoBaMWjFowasGoBaMWjFowNCwAAIDL/C6gW050AAAAAElFTkSuQmCC', 'base64');
  try {
    await login(page, userCredentials('luna4'), { ui: 'default' });
    await page.locator('[data-new-project]').click();
    await page.locator('[data-new-kind="deck"]').click();
    await page.locator('[data-new-name]').fill(name);
    await page.locator('[data-new-create]').click();
    await expect(slides()).toHaveCount(2);
    await title().dblclick();
    await page.keyboard.press('Control+a');
    await page.keyboard.type('Cold offline canvas');
    await page.keyboard.press('Escape');
    for (const image of ['first-local.png', 'second-local.png']) {
      const chooser = page.waitForEvent('filechooser');
      await page.locator('[data-tb="dk-image"]').click();
      await (await chooser).setFiles({ name: image, mimeType: 'image/png', buffer: png });
      await expect.poll(source).toContain(image);
    }
    await expect(slides().first().locator('img')).toHaveCount(2);
    await expect(page.locator('.dl-status')).toHaveText('Saved', { timeout: 20_000 });
    await rail().nth(1).click();
    await expect(slides().nth(1).locator('mjx-container')).toHaveCount(1);
    await expect(slides().nth(1).locator('mjx-container')).toBeVisible();
    const onlineSvgCount = await slides().nth(1).locator('mjx-container > svg').count();
    expect(onlineSvgCount).toBeGreaterThan(0);
    await rail().first().click();
    await page.waitForFunction(() => navigator.serviceWorker?.controller != null);
    await page.waitForFunction(async () => {
      const names = await caches.keys();
      return names.some(name => name.startsWith('overlyx-runtime-') && name !== 'overlyx-runtime-manifest');
    });
    await context.setOffline(true);
    await page.reload({ waitUntil: 'domcontentloaded' });
    await expect(title()).toHaveText('Cold offline canvas', { timeout: 30_000 });
    await expect.poll(async () => slides().first().locator('img').evaluateAll(images => images.every(image => (image as HTMLImageElement).complete && (image as HTMLImageElement).naturalWidth > 0))).toBe(true);
    await expect(page.locator('.dl-frame')).toHaveAttribute('sandbox', 'allow-scripts allow-modals allow-popups allow-forms');
    await rail().nth(1).click();
    await expect(slides().nth(1).locator('mjx-container')).toHaveCount(1, { timeout: 20_000 });
    await expect(slides().nth(1).locator('mjx-container > svg')).toHaveCount(onlineSvgCount, { timeout: 20_000 });
    const math = slides().nth(1).locator('mjx-container');
    await math.dblclick();
    await expect(page.locator('[data-dl-mathedit] .lm-field')).toBeVisible();
    await page.keyboard.press('Control+a');
    await page.keyboard.press('Backspace');
    await page.keyboard.type('\\alpha+\\beta+\\Omega', { delay: 20 });
    // Tab commits the final TeX command; Escape then leaves the formula.
    await page.keyboard.press('Tab');
    await page.keyboard.press('Escape');
    await expect(page.locator('[data-dl-mathedit]')).toHaveCount(0);
    await page.keyboard.press('Escape');
    await expect(math).toBeVisible();
    await expect(math.locator('use')).not.toHaveCount(0);
    await rail().first().click();
    await title().dblclick();
    await page.keyboard.press('Control+a');
    await page.keyboard.type('Latest local source Ω survives');
    await page.keyboard.press('Escape');
    await expect(page.locator('.dl-status')).toHaveText('Offline — saved in this browser', { timeout: 10_000 });
    expect(source()).not.toContain('Latest local source');
    // The presentation is built only when requested and must use current local
    // edits, even though the latest server snapshot still has the older title.
    await page.locator('[data-dl-present]').click();
    const present = page.frameLocator('.dl-presenting iframe');
    await expect(present.locator('h1').first()).toHaveText('Latest local source Ω survives', { timeout: 30_000 });
    await expect.poll(async () => present.locator('section.slide').first().locator('img').evaluateAll(images => images.length === 2 && images.every(image => (image as HTMLImageElement).naturalWidth > 0))).toBe(true);
    await page.keyboard.press('Escape');
    await expect(page.locator('.dl-presenting')).toHaveCount(0);
    await page.reload({ waitUntil: 'domcontentloaded' });
    await expect(title()).toHaveText('Latest local source Ω survives', { timeout: 30_000 });
    await expect.poll(async () => slides().first().locator('img').evaluateAll(images => images.length === 2 && images.every(image => (image as HTMLImageElement).naturalWidth > 0))).toBe(true);
    await context.setOffline(false);
    await expect(page.locator('.dl-status')).toHaveText('Saved', { timeout: 25_000 });
    await expect.poll(source).toContain('Latest local source Ω survives');
    expect(source()).toContain('\\alpha');
    expect(source()).toContain('first-local.png');
    expect(source()).toContain('second-local.png');
    expect(source()).not.toContain('data:image/');
    await title().dblclick();
    await page.keyboard.press('Control+End');
    await page.keyboard.type(' and saves online');
    await page.keyboard.press('Escape');
    await expect.poll(source).toContain('and saves online');
    expect(errors).toEqual([]);
  } finally {
    await context.setOffline(false);
    rmSync(dir, { recursive: true, force: true });
  }
});
