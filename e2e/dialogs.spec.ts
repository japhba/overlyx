/**
 * LyX-style settings dialogs: paragraph, table, document (page/margins, branches), graphics,
 * and the math delimiter / matrix insertion. Everything is checked against the .lyx file on disk.
 */
import { test, expect, type Page } from '@playwright/test';
import { mkdirSync, rmSync, readFileSync, writeFileSync } from 'node:fs';
import { login, collectErrors } from './helpers';

const SRC = '/root/projects/recurrent_feature/main.lyx';
const DIR = '/root/projects/e2e-dialogs';
const FILE = `${DIR}/main.lyx`;

const body = `\\begin_body

\\begin_layout Standard
Hello dialogs.
\\end_layout

\\begin_layout Standard
\\begin_inset Graphics
	filename figures/x.png
	width 50col%

\\end_inset


\\end_layout

\\end_body
\\end_document
`;

test.beforeAll(() => {
  rmSync(DIR, { recursive: true, force: true });
  mkdirSync(DIR, { recursive: true });
  writeFileSync(FILE, readFileSync(SRC, 'utf8').split('\\begin_body')[0] + body);
});
test.afterAll(() => { rmSync(DIR, { recursive: true, force: true }); });

const file = () => readFileSync(FILE, 'utf8');
async function open(page: Page) {
  await login(page);
  await page.evaluate(() => { localStorage.setItem('ol.tabs', '[]'); localStorage.setItem('ol.combined', '0'); });
  await page.goto('/#/e2e-dialogs/main.lyx');
  await page.waitForFunction(() => document.querySelectorAll('.lyx-editor .lyx-par').length >= 2, null, { timeout: 60000 });
  await page.waitForTimeout(800);
}
const openDialog = (page: Page, name: string) => page.evaluate((n) => (window as any).overlyx.openDialog(n), name);
const row = (page: Page, label: string) => page.locator('.dialog .row', { hasText: label });
const apply = (page: Page) => page.locator('.dialog button.btn.primary').click();

test('paragraph settings: alignment and line spacing are written as paragraph params', async ({ page }) => {
  const errors = collectErrors(page);
  await open(page);
  await page.locator('.lyx-editor .lyx-par').first().click();
  await openDialog(page, 'paragraph');
  await row(page, 'Alignment').locator('select').selectOption('center');
  await row(page, 'Line spacing').locator('select').first().selectOption('double');
  await apply(page);
  await expect.poll(() => file().includes('\\paragraph_spacing double') && file().includes('\\align center'), { timeout: 10000 }).toBe(true);
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
  await expect.poll(() => /<cell alignment="right"/.test(file()) && file().includes('booktabs="true"'), { timeout: 10000 }).toBe(true);
  // all three cells of the row lost their bottom line, the other rows kept theirs
  const cells = [...file().matchAll(/<cell [^>]*>/g)].map(m => m[0]);
  expect(cells.filter(c => /bottomline="true"/.test(c)).length).toBe(6);
});

test('document settings: custom margins and a new branch land where LyX writes them', async ({ page }) => {
  await open(page);
  await openDialog(page, 'settings');
  await page.locator('.dialog .panel-tabs button', { hasText: 'Page & margins' }).click();
  await row(page, 'Custom margins').locator('input[type=checkbox]').check();
  await row(page, 'Top / bottom').locator('input').first().fill('3cm');
  await page.locator('.dialog .panel-tabs button', { hasText: 'Branches' }).click();
  await row(page, 'New branch').locator('input').fill('draft');
  await row(page, 'New branch').locator('button').click();
  await apply(page);
  await expect.poll(() => file().includes('\\use_geometry true') && file().includes('\\topmargin 3cm'), { timeout: 15000 }).toBe(true);
  const f = file();
  expect(f.indexOf('\\topmargin 3cm')).toBeLessThan(f.indexOf('\\secnumdepth'));
  expect(f).toContain('\\branch draft\n\\selected 1\n\\filename_suffix 0\n\\color #faf0e6 #faf0e6\n\\end_branch\n');
  expect(f.indexOf('\\branch draft')).toBeLessThan(f.indexOf('\\index Index'));
  expect(f.indexOf('\\branch draft')).toBeGreaterThan(f.indexOf('\\boxbgcolor'));
});

test('graphics settings: height, aspect ratio and rotation are written in LyX order', async ({ page }) => {
  await open(page);
  await page.locator('.lyx-editor .lyx-graphics').first().click();
  await openDialog(page, 'inset');
  await expect(page.locator('.dialog')).toContainText('Graphics');
  await row(page, 'Height').locator('input').fill('5cm');
  await row(page, 'Maintain aspect ratio').locator('input[type=checkbox]').check();
  await row(page, 'Rotation angle').locator('input[type=text]').fill('90');
  await apply(page);
  await expect.poll(() => file().includes('\twidth 50col%\n\theight 5cm\n\tkeepAspectRatio\n\trotateAngle 90\n'), { timeout: 10000 }).toBe(true);
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
  await expect.poll(() => /\\begin\{bmatrix\}[^$]*&[^$]*\\\\[^$]*\\end\{bmatrix\}/.test(file()), { timeout: 10000 }).toBe(true);
});
