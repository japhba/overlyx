/** Presentation pauses must retain the slide and its animation step without changing its source. */
import { test, expect } from '@playwright/test';
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { login, PROJECTS_DIR } from './helpers';

const run = Date.now().toString(36);
const projects: string[] = [];
const source = `<!doctype html><html><head><meta name="overlyx" content="deck"><title>Screen pauses</title>
<style>body{margin:0}.slide{position:relative;width:1280px;height:720px;background:#edf6ff;color:#123;font:36px sans-serif}.slide h1{margin:0;padding:80px}.slide p{margin:0;padding:40px}</style></head><body>
<section class="slide"><h1>First slide</h1><p data-step="2">Revealed evidence</p></section>
<section class="slide"><h1>Second slide</h1></section>
<section class="slide"><h1>Third slide</h1></section>
</body></html>`;

test.afterAll(() => { for (const project of projects) rmSync(`${PROJECTS_DIR}/${project}`, { recursive: true, force: true }); });

for (const dim of [false, true]) test(`black and white screens resume the same slide and animation step${dim ? ' with dimmed future steps' : ''}`, async ({ page }, testInfo) => {
  const project = `admin/e2e-screen-${run}-${dim ? 'dim' : 'hide'}`;
  projects.push(project);
  const file = `${PROJECTS_DIR}/${project}/talk/index.html`;
  const html = dim ? source.replace('<title>', '<meta name="overlyx-steps" content="dim"><title>') : source;
  mkdirSync(`${PROJECTS_DIR}/${project}/talk`, { recursive: true });
  writeFileSync(file, html);
  await login(page);
  await page.goto(`/#/${project}/talk/index.html`);
  await page.frameLocator('.dl-frame').locator('section.slide').first().waitFor();
  await page.locator('[data-dl-present]').click();
  const frame = page.frameLocator('.dl-presenting iframe');
  const root = frame.locator('html');
  const slides = frame.locator('section.slide');
  const title = slides.first().locator('h1');
  const evidence = slides.first().locator('p');
  await expect(slides.first()).toHaveAttribute('data-ol-current');
  await expect(evidence).toHaveAttribute('data-ol-unshown');
  await page.keyboard.press('ArrowRight');
  await expect(evidence).toBeVisible();

  await page.keyboard.press('b');
  await expect(root).toHaveClass(/ol-present-blank/);
  await expect(title).toBeHidden();
  await expect(slides.first()).toHaveCSS('opacity', '0');
  await expect(frame.locator('body')).toHaveCSS('background-color', 'rgb(0, 0, 0)');
  await page.screenshot({ path: testInfo.outputPath('black-screen.png') });
  await page.keyboard.press('Control+b');
  await expect(root).toHaveClass(/ol-present-blank/);
  await page.keyboard.press('b');
  await expect(title).toBeVisible();
  await expect(evidence).toBeVisible();
  await expect(slides.first()).toHaveAttribute('data-ol-current');

  await page.keyboard.press('w');
  await expect(title).toBeHidden();
  await expect(frame.locator('body')).toHaveCSS('background-color', 'rgb(255, 255, 255)');
  await page.screenshot({ path: testInfo.outputPath('white-screen.png') });
  await page.keyboard.press('Space');
  await expect(title).toBeVisible();
  await expect(evidence).toBeVisible();
  await expect(slides.first()).toHaveAttribute('data-ol-current');
  await page.keyboard.press('ArrowRight');
  await expect(slides.nth(1)).toHaveAttribute('data-ol-current');

  await page.keyboard.press('.');
  await expect(slides.nth(1).locator('h1')).toBeHidden();
  await page.keyboard.press('ArrowLeft');
  await expect(slides.nth(1).locator('h1')).toBeVisible();
  await expect(slides.nth(1)).toHaveAttribute('data-ol-current');
  await page.keyboard.press('+');
  await expect(root).toHaveClass(/olpk-zoomed/);
  await page.keyboard.press(',');
  await expect(frame.locator('body')).toHaveCSS('background-color', 'rgb(255, 255, 255)');
  await page.mouse.click(200, 200);
  await expect(slides.nth(1).locator('h1')).toBeVisible();
  await expect(slides.nth(1)).toHaveAttribute('data-ol-current');
  await expect(root).toHaveClass(/olpk-zoomed/);

  await page.keyboard.press('w');
  await page.keyboard.press('Home');
  await expect(title).toBeVisible();
  await expect(evidence).toHaveAttribute('data-ol-unshown');
  await page.keyboard.press('b');
  await page.keyboard.press('Escape');
  await expect(page.locator('.dl-presenting')).toHaveCount(0);
  expect(readFileSync(file, 'utf8')).toBe(html);
});
