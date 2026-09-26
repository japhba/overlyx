/**
 * Long display formulas break into lines to fit the text column (MathJax's display line breaking,
 * editor/nodeviews/math.ts breakWidth): the lines stay inside the column, a click lands on the line
 * under the pointer, ↑/↓ go from line to line, the formula breaks anew when the window narrows, and
 * the file keeps the formula as it was written (the breaking is only how it is shown).
 */
import { test, expect, type Page } from '@playwright/test';
import { mkdirSync, rmSync, readFileSync, writeFileSync } from 'node:fs';
import { login, openDoc, collectErrors, texDoc, PROJECTS_DIR } from './helpers';

const PROJECT = 'admin/e2e-mathbreak';
const DIR = `${PROJECTS_DIR}/${PROJECT}`;
const LONG = 'E=\\sum_{i=1}^{N}\\left(a_{i}+b_{i}\\right)+\\int_{0}^{1}f(x)\\,dx+\\alpha\\beta\\gamma+x^{2}+y^{2}+z^{2}+\\frac{p}{q}+\\sqrt{u+v}+\\cos\\theta+\\sin\\phi+c_{1}+c_{2}+c_{3}+c_{4}';

test.beforeAll(() => {
  rmSync(DIR, { recursive: true, force: true });
  mkdirSync(DIR, { recursive: true });
  writeFileSync(`${DIR}/doc.tex`, texDoc(`Before.\n\\begin{equation}\n${LONG}\\label{eq:long}\n\\end{equation}\nMiddle.\n\\[\nx+y=z\n\\]\nAfter.`, '\\usepackage{amsmath}'));
});
test.afterAll(() => { rmSync(DIR, { recursive: true, force: true }); });

/** the display formulas: their lines, and whether each line stays inside the formula's column */
const layout = (page: Page) => page.evaluate(`(() => [...document.querySelectorAll('.lyx-editor .lyx-math-display')].map(d => {
  const col = d.getBoundingClientRect();
  const lines = [...d.querySelectorAll('mjx-linebox')].map(l => { const rs = [...l.querySelectorAll(':scope > *')].map(k => k.getBoundingClientRect()).filter(r => r.width); return { left: Math.min(...rs.map(r => r.left)), right: Math.max(...rs.map(r => r.right)) }; });
  return { lines: lines.length, inside: lines.every(l => l.left >= col.left - 1 && l.right <= col.right + 1) };
}))()`) as Promise<{ lines: number; inside: boolean }[]>;
const caret = (page: Page) => page.evaluate(`(() => { const f = document.querySelector('.lyx-editor .lyx-math-display').pmViewDesc.spec.field; const c = document.querySelector('.lm-field.focused .lm-caret'); return { depth: f.cursor.depth, pos: f.cursor.pos, y: c ? c.getBoundingClientRect().top : null }; })()`) as Promise<{ depth: number; pos: number; y: number | null }>;

test('a long display formula breaks into lines inside the column; clicks and ↑/↓ follow the lines', async ({ page }) => {
  const errors = collectErrors(page);
  await page.setViewportSize({ width: 1000, height: 900 });
  await login(page);
  await openDoc(page, `${PROJECT}/doc.tex`);
  await page.waitForFunction(() => document.querySelectorAll('.lyx-editor .lyx-math-display mjx-container').length >= 2, null, { timeout: 60000 });
  await expect.poll(async () => (await layout(page))[0].lines).toBeGreaterThanOrEqual(2);
  let l = await layout(page);
  expect(l[0].inside).toBe(true);
  expect(l[1].lines).toBeLessThanOrEqual(1);        // x+y=z fits on one line
  // a click on the second line puts the cursor there, at the top level of the formula
  const disp = page.locator('.lyx-editor .lyx-math-display').first();
  const plus = (await disp.locator('mjx-linebox').nth(1).locator('mjx-mrow.lm-c0 > mjx-mo.lm-a').nth(1).boundingBox())!;
  await page.mouse.click(plus.x + 1, plus.y + plus.height / 2);
  const onSecond = await caret(page);
  expect(onSecond.depth).toBe(1);
  expect(onSecond.y).not.toBeNull();
  // ↑: the first line, ↓: back to the second
  await page.keyboard.press('ArrowUp');
  const onFirst = await caret(page);
  expect(onFirst.depth).toBe(1);
  expect(onFirst.y!).toBeLessThan(onSecond.y! - 10);
  expect(onFirst.pos).toBeLessThan(onSecond.pos);
  await page.keyboard.press('ArrowDown');
  const back = await caret(page);
  expect(Math.abs(back.y! - onSecond.y!)).toBeLessThan(3);
  await page.keyboard.press('Escape');
  // a narrower window: more lines, still inside the column
  await page.setViewportSize({ width: 760, height: 900 });
  await expect.poll(async () => (await layout(page))[0].lines).toBeGreaterThan(l[0].lines);
  l = await layout(page);
  expect(l[0].inside).toBe(true);
  // the file has the formula as written
  expect(readFileSync(`${DIR}/doc.tex`, 'utf8')).toContain(LONG);
  expect(errors).toEqual([]);
});
