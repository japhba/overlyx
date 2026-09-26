/** View ▸ Presentation mode: the document alone (Shift+F11 toggles, Esc leaves); the text stays editable. */
import { test, expect } from '@playwright/test';
import { mkdirSync, rmSync, writeFileSync, copyFileSync, existsSync } from 'node:fs';
import { login, PROJECTS_DIR, FIXTURES_DIR, withPreambleOf } from './helpers';

const SRC = `${FIXTURES_DIR}/recurrent_feature`;
const PROJECT = 'admin/e2e-presentation';
const DIR = `${PROJECTS_DIR}/${PROJECT}`;

test.beforeAll(() => {
  rmSync(DIR, { recursive: true, force: true });
  mkdirSync(DIR, { recursive: true });
  for (const f of ['lyxmacros.tex', 'macros.tex', 'preamble.tex']) if (existsSync(`${SRC}/${f}`)) copyFileSync(`${SRC}/${f}`, `${DIR}/${f}`);
  writeFileSync(`${DIR}/talk.tex`, withPreambleOf(`${SRC}/main.tex`, 'A slide with a formula $E = mc^{2}$ on it.\n'));
});
test.afterAll(() => { rmSync(DIR, { recursive: true, force: true }); });

test('Shift+F11 hides the chrome, Esc brings it back, the View menu shows the state', async ({ page }) => {
  await login(page);
  await page.evaluate(() => { localStorage.setItem('ol.tabs', '[]'); });
  await page.goto(`/#/${PROJECT}/talk.tex`);
  await page.waitForFunction(() => document.querySelectorAll('.lyx-editor .katex').length >= 1, null, { timeout: 60000 });
  await page.locator('.lyx-editor .lyx-par').first().click();
  await expect(page.locator('.menubar')).toBeVisible();
  await expect(page.locator('.toolbar').first()).toBeVisible();
  await expect(page.locator('.statusbar')).toBeVisible();
  const pageWidth = () => page.evaluate(() => document.querySelector('.editor-page')!.getBoundingClientRect().width);
  const before = await pageWidth();

  await page.keyboard.press('Shift+F11');
  await expect(page.locator('html')).toHaveAttribute('data-presenting', '1');
  await expect(page.locator('.menubar')).toBeHidden();
  await expect(page.locator('.statusbar')).toBeHidden();
  expect(await page.locator('.toolbar:visible').count()).toBe(0);
  expect(await page.locator('.sidebar:visible, .rail:visible, .ruler:visible').count()).toBe(0);
  // the document is still there and editable, and takes the room the panels left
  expect(await pageWidth()).toBeGreaterThanOrEqual(before);
  await page.locator('.lyx-editor .lyx-par').first().click();
  await page.keyboard.press('End');
  await page.keyboard.type(' Typed while presenting.');
  await expect(page.locator('.lyx-editor')).toContainText('Typed while presenting.');
  // the math toolbar would dock at the bottom in a formula: not now
  await page.locator('.lyx-math-inline .katex').first().click();
  await page.waitForSelector('.lyx-math-inline .lm-field.focused', { timeout: 10000 });
  expect(await page.locator('.toolbar:visible').count()).toBe(0);
  // Esc: first out of the formula, then out of the presentation
  await page.keyboard.press('Escape');
  await expect(page.locator('html')).toHaveAttribute('data-presenting', '1');
  await page.keyboard.press('Escape');
  await expect(page.locator('html')).not.toHaveAttribute('data-presenting', '1');
  await expect(page.locator('.menubar')).toBeVisible();
  await expect(page.locator('.statusbar')).toBeVisible();

  // the menu entry toggles it too and shows the state
  await page.locator('.menubar .menu', { hasText: 'View' }).first().click();
  const item = page.locator('.menu-list .menu-item, .menu-list [role=menuitem]', { hasText: 'Presentation mode' }).first();
  await expect(item).toBeVisible();
  await item.click();
  await expect(page.locator('html')).toHaveAttribute('data-presenting', '1');
  await page.keyboard.press('Escape');
  await expect(page.locator('html')).not.toHaveAttribute('data-presenting', '1');
});
