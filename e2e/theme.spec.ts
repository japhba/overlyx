/**
 * Dark mode: follows the system by default, the menu-bar button flips it and the choice is
 * remembered, View ▸ Theme ▸ Follow the system goes back to the OS setting. Text and formulas are
 * white in the dark theme.
 */
import { test, expect } from '@playwright/test';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { login, openDoc, collectErrors, PROJECTS_DIR, texDoc } from './helpers';

const PROJECT = 'e2e-theme';
const DIR = `${PROJECTS_DIR}/${PROJECT}`;

test.beforeAll(() => {
  rmSync(DIR, { recursive: true, force: true });
  mkdirSync(DIR, { recursive: true });
  writeFileSync(`${DIR}/t.tex`, texDoc('A formula $E = mc^2$ in a paragraph.'));
});
test.afterAll(() => { rmSync(DIR, { recursive: true, force: true }); });

test.use({ colorScheme: 'dark' });

test('dark theme follows the system, the toggle overrides it and is remembered', async ({ page }) => {
  const errors = collectErrors(page);
  await login(page);
  await openDoc(page, `${PROJECT}/t.tex`);
  await page.waitForSelector('.lyx-editor .katex');
  // the OS prefers dark and nothing is stored: dark
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');
  expect(await page.evaluate(() => localStorage.getItem('ol.theme'))).toBeNull();
  expect(await page.evaluate(() => getComputedStyle(document.querySelector('.lyx-editor')!).color)).toBe('rgb(255, 255, 255)');
  expect(await page.evaluate(() => getComputedStyle(document.querySelector('.lyx-editor .katex')!).color)).toBe('rgb(255, 255, 255)');
  const pageBg = await page.evaluate(() => getComputedStyle(document.querySelector('.editor-page')!).backgroundColor);
  expect(pageBg).not.toBe('rgb(255, 255, 255)');

  // the toggle flips to light and stores the choice
  await page.click('[data-theme-toggle]');
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'light');
  expect(await page.evaluate(() => localStorage.getItem('ol.theme'))).toBe('light');
  expect(await page.evaluate(() => getComputedStyle(document.querySelector('.lyx-editor')!).color)).toBe('rgb(17, 17, 17)');
  await page.reload();
  await page.waitForSelector('.menubar');
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'light');

  // View ▸ Theme ▸ Follow the system: dark again, nothing stored
  await page.locator('.menubar .menu > button', { hasText: 'View' }).click();
  await page.locator('.menu-item', { hasText: 'Theme' }).hover();
  await page.locator('.menu-item:not(.menu-sub)', { hasText: 'Follow the system' }).click();
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');
  expect(await page.evaluate(() => localStorage.getItem('ol.theme'))).toBeNull();
  expect(errors).toEqual([]);
});
