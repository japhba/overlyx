/**
 * Copying and pasting rows as in LyX: whole rows selected in a table (a cell selection) paste cell
 * by cell from the cursor's cell — overwriting, with rows added below the table's end — by Ctrl+V,
 * the right-click menu and the toolbar alike (InsetTabular::pasteClipboard); cut empties the
 * cells. Rows of an align formula copy as `x&=1\\y&=2` and paste into the formula as rows
 * (InsetMathGrid LFUN_PASTE), not just their first cell.
 */
import { test, expect, type Page } from '@playwright/test';
import { mkdirSync, rmSync, writeFileSync, readFileSync } from 'node:fs';
import { login, openDoc, collectErrors, texDoc, PROJECTS_DIR } from './helpers';

const PROJECT = 'e2e-tablerows';
const DIR = `${PROJECTS_DIR}/${PROJECT}`;
const BODY = `First paragraph.

\\begin{tabular}{|c|c|}
\\hline
a1 & b1\\\\
\\hline
a2 & b2\\\\
\\hline
a3 & b3\\\\
\\hline
a4 & b4\\\\
\\hline
\\end{tabular}

\\begin{align}
x & =1\\\\
y & =2\\\\
z & =3
\\end{align}

Last paragraph.
`;
const FILES = ['keys', 'menu', 'cut', 'math'];

test.beforeAll(() => {
  rmSync(DIR, { recursive: true, force: true });
  mkdirSync(DIR, { recursive: true });
  for (const f of FILES) writeFileSync(`${DIR}/${f}.tex`, texDoc(BODY, '\\usepackage{amsmath}'));
});
test.afterAll(() => { rmSync(DIR, { recursive: true, force: true }); });

async function open(page: Page, file: string) {
  await page.context().grantPermissions(['clipboard-read', 'clipboard-write']);
  await login(page);
  await openDoc(page, `${PROJECT}/${file}.tex`);
  await page.waitForSelector('.lyx-editor .lyx-tabular td');
  await page.waitForTimeout(800);
}
const rows = (page: Page) => page.evaluate(() => Array.from(document.querySelectorAll('.lyx-editor .lyx-tabular tr')).map(tr => Array.from(tr.children).map(td => (td as HTMLElement).innerText.trim()).join('|')));
const cell = (page: Page, text: string) => page.locator('.lyx-editor .lyx-tabular td', { hasText: new RegExp('^' + text + '$') }).first();
/** a mouse drag from one cell to another: prosemirror-tables' cell selection */
async function dragCells(page: Page, from: string, to: string) {
  const a = (await cell(page, from).boundingBox())!, b = (await cell(page, to).boundingBox())!;
  await page.mouse.move(a.x + 4, a.y + a.height / 2);
  await page.mouse.down();
  await page.mouse.move(a.x + 20, a.y + a.height / 2, { steps: 3 });
  await page.mouse.move(b.x + b.width - 4, b.y + b.height / 2, { steps: 8 });
  await page.mouse.up();
  expect(await page.locator('.lyx-editor .selectedCell').count()).toBe(4);
}
async function clickCell(page: Page, text: string, button: 'left' | 'right' = 'left') {
  const td = cell(page, text);
  const b = (await td.boundingBox())!;
  await page.mouse.click(b.x + 6, b.y + b.height / 2, { button });
  // the browser reports the caret of a click asynchronously (selectionchange): wait until the editor has it
  if (button === 'left') await expect.poll(() => td.evaluate(el => {
    const v = (window as any).overlyx.activeView, start = v.posAtDOM(el, 0), s = v.state.selection;
    return s.empty && s.from >= start && s.from <= start + (el.textContent ?? '').length + 2;
  })).toBe(true);
}
const onDisk = (file: string, re: RegExp) => (readFileSync(`${DIR}/${file}.tex`, 'utf8').match(re) ?? []).length;
const PASTED = ['a1|b1', 'a2|b2', 'a3|b3', 'a1|b1', 'a2|b2'];

test('two whole rows copied with Ctrl+C paste over the cursor row and extend the table (Ctrl+V)', async ({ page }) => {
  const errors = collectErrors(page);
  await open(page, 'keys');
  await dragCells(page, 'a1', 'b2');
  await page.keyboard.press('Control+c');
  expect(await page.evaluate(() => navigator.clipboard.readText())).toBe('a1\n\nb1\n\na2\n\nb2');
  await clickCell(page, 'a4');
  await page.keyboard.press('Control+v');
  await expect.poll(() => rows(page)).toEqual(PASTED);
  await expect.poll(() => onDisk('keys', /a1 & b1/g), { timeout: 15000 }).toBe(2);
  expect(onDisk('keys', /a4 & b4/g)).toBe(0);
  expect(errors).toEqual([]);
});

test('the right-click menu and the toolbar paste table rows cell by cell too', async ({ page }) => {
  const errors = collectErrors(page);
  await open(page, 'menu');
  await dragCells(page, 'a1', 'b2');
  await clickCell(page, 'b2', 'right');
  await page.locator('.ctx-menu').getByText('Copy', { exact: true }).first().click();
  await clickCell(page, 'a4');
  await clickCell(page, 'a4', 'right');
  await page.locator('.ctx-menu').getByText('Paste', { exact: true }).first().click();
  await expect.poll(() => rows(page)).toEqual(PASTED);        // not the text "a1 b1 a2 b2" typed into one cell
  await page.keyboard.press('Control+z');
  await expect.poll(() => rows(page)).toEqual(['a1|b1', 'a2|b2', 'a3|b3', 'a4|b4']);
  await clickCell(page, 'a4');
  await page.locator('[title="Paste (Ctrl+V)"]').first().click();
  await expect.poll(() => rows(page)).toEqual(PASTED);
  expect(errors).toEqual([]);
});

test('cut empties the selected cells; the rows paste back elsewhere', async ({ page }) => {
  const errors = collectErrors(page);
  await open(page, 'cut');
  await dragCells(page, 'a2', 'b3');
  await page.keyboard.press('Control+x');
  await expect.poll(() => rows(page)).toEqual(['a1|b1', '|', '|', 'a4|b4']);
  await clickCell(page, 'a4');
  await page.keyboard.press('Control+v');
  await expect.poll(() => rows(page)).toEqual(['a1|b1', '|', '|', 'a2|b2', 'a3|b3']);
  expect(errors).toEqual([]);
});

test('rows of an align formula copy and paste as rows (Ctrl+C / Ctrl+V and the toolbar)', async ({ page }) => {
  const errors = collectErrors(page);
  await open(page, 'math');
  const latex = () => page.evaluate(() => { let out = ''; (window as any).overlyx.activeView.state.doc.descendants((n: any) => { if (n.type.name === 'math_display') out = n.attrs.latex; }); return out; });
  const glyph = (ch: string) => page.locator('.lyx-editor .lyx-math-display .mord', { hasText: new RegExp('^' + ch + '$') }).first();
  const disp = (await page.locator('.lyx-editor .lyx-math-display').first().boundingBox())!;
  await page.mouse.move(disp.x + disp.width / 2, disp.y + disp.height / 2);
  // drag from before x to after the 2: rows one and two
  const x = (await glyph('x').boundingBox())!, two = (await glyph('2').boundingBox())!;
  await page.mouse.move(x.x - 1, x.y + x.height / 2);
  await page.mouse.down();
  await page.mouse.move(x.x + 10, x.y + x.height / 2, { steps: 3 });
  await page.mouse.move(two.x + two.width + 1, two.y + two.height / 2, { steps: 8 });
  await page.mouse.up();
  await page.keyboard.press('Control+c');
  expect(await page.evaluate(() => navigator.clipboard.readText())).toBe('x&=1\\\\y&=2');
  // after the 3: Enter opens an empty row below, ← goes to its first cell, the rows go in there
  const three = (await glyph('3').boundingBox())!;
  await page.mouse.click(three.x + three.width - 1, three.y + three.height / 2);
  await page.keyboard.press('Enter');
  await page.keyboard.press('ArrowLeft');
  await page.keyboard.press('Control+v');
  await page.keyboard.press('Escape');
  await expect.poll(latex).toBe('\\begin{align}\nx & =1\\\\\ny & =2\\\\\nz & =3\\\\\nx & =1\\\\\ny & =2\n\\end{align}');
  // the toolbar's paste inside the formula takes the same way
  await page.evaluate(() => navigator.clipboard.writeText('u&=4\\\\v&=5'));
  const lastTwo = (await page.locator('.lyx-editor .lyx-math-display .mord', { hasText: /^2$/ }).last().boundingBox())!;
  await page.mouse.move(lastTwo.x, lastTwo.y);
  await page.mouse.click(lastTwo.x + lastTwo.width - 1, lastTwo.y + lastTwo.height / 2);
  await page.keyboard.press('Enter');
  await page.keyboard.press('ArrowLeft');
  await page.locator('[title="Paste (Ctrl+V)"]').first().click();
  await page.keyboard.press('Escape');
  await expect.poll(latex).toContain('y & =2\\\\\nu & =4\\\\\nv & =5\n\\end{align}');
  await expect.poll(() => onDisk('math', /v & =5/g), { timeout: 15000 }).toBe(1);
  expect(errors).toEqual([]);
});
