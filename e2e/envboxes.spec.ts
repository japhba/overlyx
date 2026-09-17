/** The scaffolding of tables and formulas — the dotted cell grid, the boxes of empty cells — shows only while editing inside them. */
import { test, expect, type Page } from '@playwright/test';
import { mkdirSync, rmSync, writeFileSync, copyFileSync, existsSync } from 'node:fs';
import { login, PROJECTS_DIR, FIXTURES_DIR, withPreambleOf } from './helpers';

const SRC = `${FIXTURES_DIR}/recurrent_feature`;
const PROJECT = 'e2e-envboxes';
const DIR = `${PROJECTS_DIR}/${PROJECT}`;
const TRANSPARENT = 'rgba(0, 0, 0, 0)';

test.beforeAll(() => {
  rmSync(DIR, { recursive: true, force: true });
  mkdirSync(DIR, { recursive: true });
  for (const f of ['lyxmacros.tex', 'macros.tex', 'preamble.tex']) if (existsSync(`${SRC}/${f}`)) copyFileSync(`${SRC}/${f}`, `${DIR}/${f}`);
  writeFileSync(`${DIR}/boxes.tex`, withPreambleOf(`${SRC}/main.tex`, `Before the fraction $\\frac{}{x}$ and on.

\\begin{tabular}{cc}
a & \\\\
 & d
\\end{tabular}

After the table.
`));
});
test.afterAll(() => { rmSync(DIR, { recursive: true, force: true }); });

const borderOf = (page: Page, sel: string) => page.evaluate(s => getComputedStyle(document.querySelector(s)!).borderTopColor, sel);

test('empty-cell boxes and the table grid appear only while editing inside', async ({ page }) => {
  await login(page);
  await page.evaluate(() => { localStorage.setItem('ol.tabs', '[]'); });
  await page.goto(`/#/${PROJECT}/boxes.tex`);
  await page.waitForFunction(() => document.querySelectorAll('.lyx-editor .lyx-tabular .lyx-cell').length >= 4 && document.querySelectorAll('.lyx-editor .lyx-math-inline .lm-empty').length >= 1, null, { timeout: 60000 });
  await page.locator('.lyx-editor .lyx-par', { hasText: 'After the table.' }).click();
  await page.waitForTimeout(500);

  // the formula at rest (a field or the static rendering — on-screen formulas are upgraded lazily):
  // the empty numerator keeps its room but shows no box
  expect(await borderOf(page, '.lyx-math-inline .lm-empty')).toBe(TRANSPARENT);
  const room = await page.evaluate(() => document.querySelector('.lyx-math-inline .lm-empty')!.getBoundingClientRect().width);
  expect(room).toBeGreaterThan(3);
  // editing the formula: the box is there
  await page.locator('.lyx-math-inline .katex').first().click();
  await page.waitForSelector('.lyx-math-inline .lm-field.focused .lm-empty', { timeout: 10000 });
  expect(await borderOf(page, '.lyx-math-inline .lm-field.focused .lm-empty')).not.toBe(TRANSPARENT);
  // leaving it: gone again
  await page.locator('.lyx-editor .lyx-par', { hasText: 'After the table.' }).click();
  await expect(page.locator('.lyx-math-inline .lm-field.focused')).toHaveCount(0);
  expect(await borderOf(page, '.lyx-math-inline .lm-empty')).toBe(TRANSPARENT);

  // the table at rest: no dotted grid (its cells have no lines)
  await page.locator('.lyx-editor .lyx-par', { hasText: 'After the table.' }).click();
  await expect(page.locator('.lyx-tabular')).not.toHaveClass(/ol-editing/);
  expect(await borderOf(page, '.lyx-tabular .lyx-cell')).toBe(TRANSPARENT);
  // the cursor in a cell: the grid shows, and the layout has not moved
  const before = await page.evaluate(() => document.querySelector('.lyx-tabular')!.getBoundingClientRect().width);
  await page.locator('.lyx-tabular .lyx-cell').first().click();
  await expect(page.locator('.lyx-tabular')).toHaveClass(/ol-editing/);
  expect(await borderOf(page, '.lyx-tabular .lyx-cell')).not.toBe(TRANSPARENT);
  expect(await page.evaluate(() => document.querySelector('.lyx-tabular')!.getBoundingClientRect().width)).toBe(before);
  // a formula outside the table takes the keyboard: the table is no longer where one works
  await page.locator('.lyx-math-inline .katex').first().click();
  await page.waitForSelector('.lyx-math-inline .lm-field.focused', { timeout: 10000 });
  await expect(page.locator('.lyx-tabular')).not.toHaveClass(/ol-editing/);
  // and away again
  await page.locator('.lyx-editor .lyx-par', { hasText: 'After the table.' }).click();
  await expect(page.locator('.lyx-tabular')).not.toHaveClass(/ol-editing/);
  expect(await borderOf(page, '.lyx-tabular .lyx-cell')).toBe(TRANSPARENT);
});
