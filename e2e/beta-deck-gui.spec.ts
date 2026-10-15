/** GUI regressions found while designing an original deck from + New, with trusted mouse input. */
import { test, expect, type Page } from '@playwright/test';
import { readFileSync } from 'node:fs';
import { login, userCredentials, PROJECTS_DIR, png } from './helpers';

const canvas = (page: Page) => page.frameLocator('.dl-frame').locator('section.slide').first();
const RUN = Date.now().toString(36);
const USER = process.env.OVERLYX_BETA_DECK_USER ?? 'betadeck';

async function create(page: Page, suffix: string): Promise<string> {
  await login(page, userCredentials(USER), { ui: 'default' });
  await page.locator('[data-new-project]').click();
  await page.locator('[data-new-kind="deck"]').click();
  const name = `beta-deck-gui-${suffix}-${RUN}`;
  await page.locator('[data-new-name]').fill(name);
  await page.locator('[data-new-create]').click();
  await expect(canvas(page)).toBeVisible();
  return `${PROJECTS_DIR}/${USER}/${name}/slides/index.html`;
}

test('typing immediately after drawing a text box retains every character, in order, after reload', async ({ page }) => {
  const file = await create(page, 'immediate-text');
  await page.locator('[data-tb="dk-text"]').click();
  const b = (await canvas(page).boundingBox())!;
  await page.mouse.move(b.x + b.width * .1, b.y + b.height * .75);
  await page.mouse.down();
  await page.mouse.move(b.x + b.width * .9, b.y + b.height * .84, { steps: 8 });
  await page.mouse.up();
  const copy = 'Every action keeps a traceable link to its observations.';
  // No settling sleep: a user starts typing when the mouse is released.
  await page.keyboard.type(copy, { delay: 30 });
  await page.keyboard.press('Escape');
  await expect(canvas(page).locator('p').last()).toHaveText(copy);
  await expect.poll(() => readFileSync(file, 'utf8')).toContain(copy);
  await page.locator('[data-tb="dk-text"]').click();
  await page.mouse.move(b.x + b.width * .1, b.y + b.height * .55);
  await page.mouse.down();
  await page.mouse.move(b.x + b.width * .9, b.y + b.height * .64, { steps: 8 });
  await page.mouse.up();
  const fastCopy = 'Every action follows a track, radar analysis, and an alert.';
  // A fast burst exercises ordering across the frame focus transition as well.
  await page.keyboard.type(fastCopy, { delay: 0 });
  await page.keyboard.press('Escape');
  await expect(canvas(page).locator('p').last()).toHaveText(fastCopy);
  await expect.poll(() => readFileSync(file, 'utf8')).toContain(fastCopy);
  await page.reload();
  await expect(canvas(page).locator('p').filter({ hasText: copy })).toHaveText(copy);
  await expect(canvas(page).locator('p').last()).toHaveText(fastCopy);
});

test('an uploaded picture resizes through its actual corner handle and preserves that size on reload', async ({ page }) => {
  const file = await create(page, 'picture-resize');
  const [chooser] = await Promise.all([
    page.waitForEvent('filechooser'),
    page.locator('[data-tb="dk-image"]').click(),
  ]);
  await chooser.setFiles({ name: 'illustrative-heat-map.png', mimeType: 'image/png', buffer: png(400, 200, (x, y) => [40 + x % 180, 70 + y % 150, 200]) });
  const image = canvas(page).locator('img');
  await expect(image).toBeVisible();
  await page.keyboard.press('Escape');
  await image.click();
  const before = (await image.boundingBox())!;
  await page.mouse.move(before.x + before.width - .5, before.y + before.height - .5);
  await page.mouse.down();
  await page.mouse.move(before.x + before.width * .6, before.y + before.height * .6, { steps: 12 });
  await page.mouse.up();
  await expect.poll(async () => (await image.boundingBox())!.width).toBeLessThan(before.width * .7);
  const width = await image.evaluate(el => getComputedStyle(el).width);
  await expect.poll(() => readFileSync(file, 'utf8')).toContain(`width: ${width}`);
  await page.reload();
  await expect(image).toBeVisible();
  expect(await image.evaluate(el => getComputedStyle(el).width)).toBe(width);
});

test('Formula creates one expression without retaining its empty display placeholder', async ({ page }) => {
  const file = await create(page, 'single-formula');
  await page.locator('[data-tb="dk-formula"]').click();
  const b = (await canvas(page).boundingBox())!;
  await page.mouse.click(b.x + b.width * .5, b.y + b.height * .75);
  await expect(page.locator('[data-dl-mathedit]:not(.pending) .lm-field')).toBeVisible();
  await page.keyboard.type('E=\\sum_{i=1}^{n} H_i t_i', { delay: 20 });
  await page.keyboard.press('Escape');
  await expect(page.locator('[data-dl-mathedit]')).toHaveCount(0);
  await expect(canvas(page).locator('mjx-container')).toHaveCount(1);
  await expect.poll(() => readFileSync(file, 'utf8')).toContain('E=\\sum');
  const firstSlide = readFileSync(file, 'utf8').split('<section class="slide">')[1].split('</section>')[0];
  expect(firstSlide.match(/\\\[/g)).toHaveLength(1);
  expect(firstSlide).not.toMatch(/\\\[\s*\\\]/);
  await page.reload();
  await expect(canvas(page).locator('mjx-container')).toHaveCount(1);
});
