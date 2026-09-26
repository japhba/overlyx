/**
 * Tables on a line of their own (editor/plugins/widetables.ts): a tabular or a matrix formula alone
 * in its paragraph is centred on the text column, one wider than the column spills into both margins
 * by the same amount (never past the page's left edge), a table amid text stays in the text. Tables
 * are as wide as LaTeX sets them: l / c / r columns are never wrapped, a p{…} column wraps at its width.
 * Editing a cell keeps working, and a table that grows while typing stays centred.
 */
import { test, expect, type Page } from '@playwright/test';
import { mkdirSync, rmSync, writeFileSync, readFileSync } from 'node:fs';
import { login, openDoc, collectErrors, texDoc, PROJECTS_DIR } from './helpers';

const PROJECT = 'admin/e2e-tablelayout';
const DIR = `${PROJECTS_DIR}/${PROJECT}`;
const FILE = `${DIR}/main.tex`;
/** a tabular a little wider than the column (it spills evenly), a formula wider than column and both margins (it stops at the page's edge) */
const WIDE = Array.from({ length: 8 }, (_, i) => `column header ${i + 1}`);
const HUGE = Array.from({ length: 10 }, (_, i) => `a very wide column header ${i + 1}`);
const BODY = `Some text before the tables, long enough to wrap onto a second line of the column.

\\begin{tabular}{|l|c|r|}
\\hline
a & b & c\\\\
\\hline
dd & ee & ff\\\\
\\hline
\\end{tabular}

\\begin{table}
\\centering
\\begin{tabular}{lcc}
Model & Error & Time\\\\
VAE & 0.1 & 3\\\\
\\end{tabular}
\\caption{A table in a float}
\\end{table}

\\begin{tabular}{|${'l|'.repeat(8)}}
\\hline
${WIDE.join(' & ')}\\\\
\\hline
${WIDE.map((_, i) => i + 1).join(' & ')}\\\\
\\hline
\\end{tabular}

\\begin{tabular}{|l|p{3cm}|p{0.3\\textwidth}|}
\\hline
key & a paragraph column whose text wraps at three centimetres like in the PDF & and one at three tenths of the text width, which wraps as well\\\\
\\hline
\\end{tabular}

Text with a small matrix $\\begin{matrix}a & b\\\\ c & d\\end{matrix}$ inside a sentence.

$\\begin{matrix}\\text{\\textbf{Feature}} & \\text{\\textbf{RBMs}} & \\text{\\textbf{VAE}}\\\\ \\text{weight sharing} & 1 & 0\\end{matrix}$

$\\begin{matrix}${HUGE.map(h => `\\text{${h}}`).join(' & ')}\\\\ ${HUGE.map((_, i) => i + 1).join(' & ')}\\end{matrix}$

The last paragraph.
`;

test.beforeAll(() => {
  rmSync(DIR, { recursive: true, force: true });
  mkdirSync(DIR, { recursive: true });
  writeFileSync(FILE, texDoc(BODY, '\\usepackage{amsmath}'));
});
test.afterAll(() => { rmSync(DIR, { recursive: true, force: true }); });

async function open(page: Page) {
  await login(page);
  await page.evaluate(() => { localStorage.setItem('ol.tabs', '[]'); localStorage.setItem('ol.margin', '0'); });
  await page.setViewportSize({ width: 1500, height: 1000 });
  await openDoc(page, `${PROJECT}/main.tex`);
  await page.waitForSelector('.lyx-editor .lyx-tabular td');
  await expect(page.locator('.lyx-editor .ol-solo-table')).toHaveCount(6, { timeout: 10000 });
  await page.waitForFunction(() => !document.querySelector('.lyx-editor .lyx-math-static.pending'), null, { timeout: 20000 });
  await page.waitForTimeout(600);
}

/** where the n-th table (a tabular, or a formula alone in its paragraph) sits against the text column and the page */
const place = (page: Page, sel: string, i = 0) => page.evaluate(([s, n]) => {
  const col = document.querySelector('.lyx-editor')!.getBoundingClientRect();
  const el = document.querySelectorAll(s)[n as number] as HTMLElement;
  const r = el.getBoundingClientRect();
  const page = document.querySelector('.editor-scroll')!.getBoundingClientRect();
  return { left: r.left - col.left, right: col.right - r.right, width: r.width, colWidth: col.width, pastPageEdge: page.left - r.left, solo: !!el.parentElement!.closest('.ol-solo-table') };
}, [sel, i] as const);
const TABULAR = '.lyx-editor .lyx-tabular';
const SOLO_FORMULA = '.lyx-editor .ol-solo-table > .lyx-math-inline';

test('tables alone on their line are centred; a wide one spills into both margins; a table amid text stays put', async ({ page }) => {
  const errors = collectErrors(page);
  await open(page);

  // a narrow tabular: as wide as its content, centred in the column
  const narrow = await place(page, TABULAR, 0);
  expect(narrow.solo).toBe(true);
  expect(narrow.width).toBeLessThan(200);
  expect(Math.abs(narrow.left - narrow.right)).toBeLessThanOrEqual(2);
  // the tabular of a table float (with its caption beside it in the same paragraph): centred too
  const float = await place(page, TABULAR, 1);
  expect(float.solo).toBe(true);
  const floatBox = await page.locator('.lyx-editor .lyx-inset-float').first().evaluate(el => { const b = el.querySelector('.inset-content')!.getBoundingClientRect(); const t = el.querySelector('.lyx-tabular')!.getBoundingClientRect(); return { l: t.left - b.left, r: b.right - t.right }; });
  expect(Math.abs(floatBox.l - floatBox.r)).toBeLessThanOrEqual(2);
  // a tabular wider than the column: its l columns are not wrapped, and it overflows both sides by the same amount
  const wide = await place(page, TABULAR, 2);
  expect(wide.width).toBeGreaterThan(wide.colWidth + 40);
  expect(wide.left).toBeLessThan(-20);
  expect(Math.abs(wide.left - wide.right)).toBeLessThanOrEqual(2);
  expect(wide.pastPageEdge).toBeLessThanOrEqual(0);
  expect(await page.locator(TABULAR).nth(2).locator('tr').first().locator('td').first().evaluate(td => td.getBoundingClientRect().height)).toBeLessThan(40);   // one line
  // a p{3cm} column wraps at its width (3cm ≈ 113px)
  const pcell = page.locator(TABULAR).nth(3).locator('td').nth(1);
  const pw = await pcell.evaluate(td => td.getBoundingClientRect().width);
  expect(pw).toBeGreaterThan(100);
  expect(pw).toBeLessThan(140);
  expect(await pcell.evaluate(td => td.getBoundingClientRect().height)).toBeGreaterThan(60);
  // p{0.3\textwidth}: three tenths of the text column
  const rel = await page.locator(TABULAR).nth(3).locator('td').nth(2).evaluate(td => td.getBoundingClientRect().width);
  expect(Math.abs(rel - 0.3 * narrow.colWidth)).toBeLessThan(16);

  // formulas: a matrix amid text stays in the text; a matrix alone in its paragraph is centred, a wide one spills evenly
  const inText = page.locator('.lyx-editor .lyx-par', { hasText: 'inside a sentence' });
  await expect(inText).not.toHaveClass(/ol-solo-table/);
  const small = await place(page, SOLO_FORMULA, 0);
  expect(small.width).toBeLessThan(small.colWidth);
  expect(Math.abs(small.left - small.right)).toBeLessThanOrEqual(2);
  // wider than the column and both margins: it starts at the page's left edge, the rest overflows to the right
  const huge = await place(page, SOLO_FORMULA, 1);
  expect(huge.left).toBeLessThan(-20);
  expect(huge.pastPageEdge).toBeLessThanOrEqual(0);
  expect(huge.pastPageEdge).toBeGreaterThan(-12);
  expect(huge.right).toBeLessThan(huge.left);
  expect(errors).toEqual([]);
});

test('editing a centred table: typing in a cell reaches the file, the growing table stays centred', async ({ page }) => {
  const errors = collectErrors(page);
  await open(page);
  const cell = page.locator(TABULAR).first().locator('td').nth(4);   // ee
  await expect(cell).toHaveText('ee');
  await cell.click();
  await page.keyboard.press('End');
  await page.keyboard.type(' grows much wider now');
  await expect(cell).toHaveText('ee grows much wider now');
  await page.waitForTimeout(400);
  const after = await place(page, TABULAR, 0);
  expect(after.width).toBeGreaterThan(200);
  expect(Math.abs(after.left - after.right)).toBeLessThanOrEqual(2);
  await expect.poll(() => readFileSync(FILE, 'utf8'), { timeout: 15000 }).toContain('ee grows much wider now');
  // the cursor keeps working across the cells: Tab moves to the next one
  await page.keyboard.press('Tab');
  await page.keyboard.type('Z');
  await expect(page.locator(TABULAR).first().locator('td').nth(5)).toContainText('Z');
  expect(errors).toEqual([]);
});
