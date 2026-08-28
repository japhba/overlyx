/**
 * LyX-style settings dialogs: paragraph, table, document (page/margins, branches), graphics,
 * and the math delimiter / matrix insertion. Everything is checked against the .tex file on disk.
 */
import { test, expect, type Page } from '@playwright/test';
import { mkdirSync, rmSync, readFileSync, writeFileSync } from 'node:fs';
import { login, collectErrors, PROJECTS_DIR, FIXTURES_DIR, withPreambleOf } from './helpers';

const SRC = `${FIXTURES_DIR}/recurrent_feature/main.tex`;
const DIR = `${PROJECTS_DIR}/e2e-dialogs`;
const FILE = `${DIR}/main.tex`;

const body = `Hello dialogs.

\\includegraphics[width=0.5\\columnwidth]{figures/x.png}
`;

test.beforeAll(() => {
  rmSync(DIR, { recursive: true, force: true });
  mkdirSync(DIR, { recursive: true });
  writeFileSync(FILE, withPreambleOf(SRC, body));
  for (const f of ['macros.tex', 'preamble.tex']) writeFileSync(`${DIR}/${f}`, readFileSync(`${FIXTURES_DIR}/recurrent_feature/${f}`, 'utf8'));
});
test.afterAll(() => { rmSync(DIR, { recursive: true, force: true }); });

const file = () => readFileSync(FILE, 'utf8');
async function open(page: Page) {
  await login(page);
  await page.evaluate(() => { localStorage.setItem('ol.tabs', '[]'); localStorage.setItem('ol.combined', '0'); });
  await page.goto('/#/e2e-dialogs/main.tex');
  await page.waitForFunction(() => document.querySelectorAll('.lyx-editor .lyx-par').length >= 2, null, { timeout: 60000 });
  await page.waitForTimeout(800);
}
const openDialog = (page: Page, name: string) => page.evaluate((n) => (window as any).overlyx.openDialog(n), name);
const row = (page: Page, label: string) => page.locator('.dialog .row', { hasText: label });
const apply = (page: Page) => page.locator('.dialog button.btn.primary').click();

test('paragraph settings: alignment and line spacing are written as LaTeX environments', async ({ page }) => {
  const errors = collectErrors(page);
  await open(page);
  await page.locator('.lyx-editor .lyx-par').first().click();
  await openDialog(page, 'paragraph');
  await row(page, 'Alignment').locator('select').selectOption('center');
  await row(page, 'Line spacing').locator('select').first().selectOption('double');
  await apply(page);
  await expect.poll(() => file().includes('\\begin{doublespace}') && file().includes('\\begin{center}'), { timeout: 10000 }).toBe(true);
  expect(errors.filter(e => !/404/.test(e))).toEqual([]);   // the scratch copy lacks figures/x.png
});

test('table settings: cell alignment, row lines and table features', async ({ page }) => {
  await open(page);
  await page.locator('.lyx-editor .lyx-par').first().click();
  await page.keyboard.press('End');
  await page.keyboard.press('Control+Alt+t');
  await apply(page);                          // Insert Table dialog: 3×3 default
  await expect(page.locator('.lyx-editor .lyx-cell')).toHaveCount(9, { timeout: 5000 });
  await page.locator('.lyx-editor .lyx-cell').first().click();
  await openDialog(page, 'tablesettings');
  await expect(page.locator('.dialog')).toContainText('row 1 of 3, column 1 of 3');
  await row(page, 'Horizontal alignment').locator('select').selectOption('right');
  await page.locator('.dialog .panel-tabs button', { hasText: 'This row' }).click();
  await row(page, 'Lines').locator('input[type=checkbox]').nth(1).uncheck();     // bottom line off for the whole row (LyX's new table has all lines)
  await page.locator('.dialog .panel-tabs button', { hasText: 'Table' }).click();
  await row(page, 'Booktabs').locator('input[type=checkbox]').check();
  await apply(page);
  // a right-aligned cell in a centred column is a \multicolumn{1}{r}{...}; booktabs rules replace \hline
  await expect.poll(() => /\\multicolumn\{1\}\{[^}]*r[^}]*\}/.test(file()) && file().includes('\\toprule'), { timeout: 10000 }).toBe(true);
  // the first row lost its bottom line: only the top rule and the rules of the other rows remain
  expect((file().match(/\\(top|mid|bottom)rule/g) ?? []).length).toBe(3);
});

test('document settings: a new branch is kept in the settings line', async ({ page }) => {
  await open(page);
  await openDialog(page, 'settings');
  await page.locator('.dialog .panel-tabs button', { hasText: 'Branches' }).click();
  await row(page, 'New branch').locator('input').fill('draft');
  await row(page, 'New branch').locator('button').click();
  await apply(page);
  await expect.poll(() => file().includes('\\\\branch draft'), { timeout: 15000 }).toBe(true);
  const f = file();
  expect(f).toMatch(/%% overlyx-settings: \{.*"branches":\["\\\\branch draft","\\\\selected 1"/);
});

test('graphics settings: height, aspect ratio and rotation are written as \\includegraphics options', async ({ page }) => {
  await open(page);
  await page.locator('.lyx-editor .lyx-graphics').first().click();
  await openDialog(page, 'inset');
  await expect(page.locator('.dialog')).toContainText('Graphics');
  await row(page, 'Height').locator('input').fill('5cm');
  await row(page, 'Maintain aspect ratio').locator('input[type=checkbox]').check();
  await row(page, 'Rotation angle').locator('input[type=text]').fill('90');
  await apply(page);
  await expect.poll(() => file().includes('\\includegraphics[angle=90,width=0.5\\columnwidth,totalheight=5cm,keepaspectratio]{figures/x.png}'), { timeout: 10000 }).toBe(true);
});

test('math delimiters and matrix dialogs insert into a formula', async ({ page }) => {
  await open(page);
  await page.locator('.lyx-editor .lyx-par').first().click();
  await page.keyboard.press('End');
  await openDialog(page, 'delimiters');
  await page.locator('.dialog .row', { hasText: 'Left' }).locator('button', { hasText: '[' }).click();
  await apply(page);
  await expect.poll(() => file().includes('\\left[') && file().includes('\\right]'), { timeout: 10000 }).toBe(true);
  await page.keyboard.press('Escape');
  await page.keyboard.press('End');
  await openDialog(page, 'matrix');
  await row(page, 'Decoration').locator('select').selectOption('bmatrix');
  await apply(page);
  // LyX drops trailing empty cells when writing, so an empty 2×2 matrix is written as \begin{bmatrix}\\\end{bmatrix}
  await expect.poll(() => /\\begin\{bmatrix\}[\s\S]*\\\\[\s\S]*\\end\{bmatrix\}/.test(file()), { timeout: 10000 }).toBe(true);
});
