/** Right-click on the sun/moon switch: the dark theme's text tone (white / sepia / grey), remembered per browser. */
import { test, expect, type Page } from '@playwright/test';
import { mkdirSync, rmSync, writeFileSync, copyFileSync, existsSync } from 'node:fs';
import { login, PROJECTS_DIR, FIXTURES_DIR, withPreambleOf } from './helpers';

const SRC = `${FIXTURES_DIR}/recurrent_feature`;
const PROJECT = 'e2e-darktone';
const DIR = `${PROJECTS_DIR}/${PROJECT}`;

test.beforeAll(() => {
  rmSync(DIR, { recursive: true, force: true });
  mkdirSync(DIR, { recursive: true });
  for (const f of ['lyxmacros.tex', 'macros.tex', 'preamble.tex']) if (existsSync(`${SRC}/${f}`)) copyFileSync(`${SRC}/${f}`, `${DIR}/${f}`);
  writeFileSync(`${DIR}/tone.tex`, withPreambleOf(`${SRC}/main.tex`, 'Warm text and a formula $x^{2}$ at night.\n'));
});
test.afterAll(() => { rmSync(DIR, { recursive: true, force: true }); });

const textColor = (page: Page) => page.evaluate(() => getComputedStyle(document.querySelector('.lyx-editor')!).color);
const formulaColor = (page: Page) => page.evaluate(() => getComputedStyle(document.querySelector('.lyx-editor .katex')!).color);
async function open(page: Page) {
  await page.goto(`/#/${PROJECT}/tone.tex`);
  await page.waitForFunction(() => document.querySelectorAll('.lyx-editor .katex').length >= 1, null, { timeout: 60000 });
  await page.waitForTimeout(500);
}

test('right-click on the theme switch picks a sepia tone for the dark theme; it is remembered and leaves the light theme alone', async ({ page }) => {
  await login(page);
  await page.evaluate(() => { localStorage.setItem('ol.tabs', '[]'); localStorage.removeItem('ol.prefs'); localStorage.removeItem('ol.theme'); });
  await open(page);
  if (await page.locator('html').getAttribute('data-theme') !== 'dark') await page.locator('[data-theme-toggle]').click();
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');
  await expect(page.locator('html')).toHaveAttribute('data-tone', 'white');
  expect(await textColor(page)).toBe('rgb(255, 255, 255)');

  await page.locator('[data-theme-toggle]').click({ button: 'right' });
  const menu = page.locator('.ctx-menu');
  await expect(menu).toContainText('Text in the dark theme');
  await expect(menu.locator('.ctx-item.checked')).toHaveText(/White/);
  await menu.locator('.ctx-item', { hasText: 'Sepia' }).click();
  await expect(page.locator('html')).toHaveAttribute('data-tone', 'sepia');
  expect(await textColor(page)).toBe('rgb(232, 217, 189)');
  expect(await formulaColor(page)).toBe('rgb(232, 217, 189)');   // formulas follow the text
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');   // the right-click did not flip the theme

  // remembered in this browser
  await open(page);
  await expect(page.locator('html')).toHaveAttribute('data-tone', 'sepia');
  expect(await textColor(page)).toBe('rgb(232, 217, 189)');
  await page.locator('[data-theme-toggle]').click({ button: 'right' });
  await expect(page.locator('.ctx-menu .ctx-item.checked')).toHaveText(/Sepia/);
  await page.keyboard.press('Escape');

  // the tone is a dark-theme setting: the light theme keeps its colours
  await page.locator('[data-theme-toggle]').click();
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'light');
  expect(await textColor(page)).not.toBe('rgb(232, 217, 189)');
  expect(await textColor(page)).not.toBe('rgb(255, 255, 255)');
});
