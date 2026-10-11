/**
 * Dark mode: follows the system by default; the menu-bar switch picks Light or Dark (remembered)
 * or Default again, as does View ▸ Theme. Text and formulas are white in the dark theme.
 */
import { test, expect } from '@playwright/test';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { login, openDoc, collectErrors, PROJECTS_DIR, texDoc, pickTheme } from './helpers';

const PROJECT = 'admin/e2e-theme';
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
  await page.waitForSelector('.lyx-editor mjx-container');
  // the OS prefers dark and nothing is stored: dark
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');
  expect(await page.evaluate(() => localStorage.getItem('ol.theme'))).toBeNull();
  expect(await page.evaluate(() => getComputedStyle(document.querySelector('.lyx-editor')!).color)).toBe('rgb(255, 255, 255)');
  expect(await page.evaluate(() => getComputedStyle(document.querySelector('.lyx-editor mjx-container')!).color)).toBe('rgb(255, 255, 255)');
  const pageBg = await page.evaluate(() => getComputedStyle(document.querySelector('.editor-page')!).backgroundColor);
  expect(pageBg).not.toBe('rgb(255, 255, 255)');

  // the switch shows Default; Light is picked and stored
  await expect(page.locator('[data-theme-toggle]')).toHaveAttribute('data-pref', 'system');
  await page.click('[data-theme-toggle]');
  await expect(page.locator('.ctx-menu[data-theme-menu] .ctx-item.checked')).toHaveCount(4);   // the theme, smart invert of pages and of figures, the dark text tone
  await expect(page.locator('.ctx-menu[data-theme-menu] .ctx-item.checked').first()).toHaveText(/^Default \(follows the system\)/);
  await page.keyboard.press('Escape');
  await pickTheme(page, 'Light');
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'light');
  await expect(page.locator('[data-theme-toggle]')).toHaveAttribute('data-pref', 'light');
  expect(await page.evaluate(() => localStorage.getItem('ol.theme'))).toBe('light');
  expect(await page.evaluate(() => getComputedStyle(document.querySelector('.lyx-editor')!).color)).toBe('rgb(17, 17, 17)');
  await page.reload();
  await page.waitForSelector('.menubar');
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'light');

  // Default in the switch: dark again (the system's), nothing stored
  await pickTheme(page, 'Default');
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');
  await expect(page.locator('[data-theme-toggle]')).toHaveAttribute('data-pref', 'system');
  expect(await page.evaluate(() => localStorage.getItem('ol.theme'))).toBeNull();

  // and View ▸ Theme: Light, then Default (follows the system)
  const viewTheme = async (label: string, sub = 'Theme ▸') => {
    await page.locator('.menubar .menu > button', { hasText: 'View' }).click();
    await page.getByRole('menuitem', { name: sub, exact: true }).hover();
    await page.locator('.menu-item:not(.menu-sub)', { hasText: label }).click();
  };
  await viewTheme('Light');
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'light');
  await viewTheme('Default (follows the system)');
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');
  expect(await page.evaluate(() => localStorage.getItem('ol.theme'))).toBeNull();
  // View ▸ Dark theme: smart invert of the pages (app/darkpages.ts) — off, the page is white paper in the dark interface
  await viewTheme('Smart invert pages', 'Dark theme ▸');
  await expect.poll(() => page.evaluate(() => getComputedStyle(document.querySelector('.editor-page')!).backgroundColor)).toBe('rgb(255, 255, 255)');
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');
  await viewTheme('Smart invert pages', 'Dark theme ▸');
  await expect.poll(() => page.evaluate(() => getComputedStyle(document.querySelector('.editor-page')!).backgroundColor)).toBe(pageBg);
  expect(errors).toEqual([]);
});
