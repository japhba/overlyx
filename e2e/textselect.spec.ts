/**
 * LyX-like mouse selection in the text (plugins/dragselect.ts): a press places the caret (no
 * drag-and-drop of a selection), a drag never dives deeper than the text it started in — a
 * formula, footnote or table the pointer enters is taken whole at its closest edge — and a drag
 * that leaves the inset it started in continues outside with that inset whole (and shrinks back
 * into it when the pointer returns); double / triple click + drag grow by words / paragraphs;
 * dragging into the margins reaches the line ends, dragging past the visible page scrolls it.
 */
import { test, expect, type Page } from '@playwright/test';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { login, openDoc, collectErrors, texDoc, PROJECTS_DIR } from './helpers';

const PROJECT = 'e2e-textselect';
const DIR = `${PROJECTS_DIR}/${PROJECT}`;
const LONG = Array.from({ length: 79 }, (_, i) => `word${i + 1}`).join(' ');
const BODY = `First paragraph ${LONG} end of first paragraph.

Second paragraph has an inline formula $abc+def$ then a footnote\\footnote{Footnote text inside the inset here with several words.} and then more text after the footnote up to the end of this line and beyond it.

Third paragraph before the display equation.
\\begin{equation}
E=mc^{2}
\\end{equation}
Fourth paragraph after the display equation.

\\begin{tabular}{cc}
a & b\\\\
c & d
\\end{tabular}

Fifth paragraph after the table.

` + Array.from({ length: 49 }, (_, i) => `Filler paragraph number ${i + 1} with a few words in it.`).join('\n\n');

test.beforeAll(() => {
  rmSync(DIR, { recursive: true, force: true });
  mkdirSync(DIR, { recursive: true });
  writeFileSync(`${DIR}/doc.tex`, texDoc(BODY));
});
test.afterAll(() => { rmSync(DIR, { recursive: true, force: true }); });

test.beforeEach(async ({ page }) => { await login(page); await openDoc(page, `${PROJECT}/doc.tex`); await page.waitForTimeout(500); });

type Sel = { from: number; to: number; anchor: number; head: number; depth: number; text: string; math: number; insets: number; tables: number; selatoms: number };
const selection = (page: Page): Promise<Sel> => page.evaluate(() => {
  const v = (window as any).overlyx.activeView, s = v.state.selection;
  let math = 0, insets = 0, tables = 0;
  v.state.doc.nodesBetween(s.from, s.to, (n: any, pos: number) => {
    if (pos < s.from || pos + n.nodeSize > s.to) return true;
    if (n.type.name === 'math_inline' || n.type.name === 'math_display') math++;
    if (n.type.name === 'inset') insets++;
    if (n.type.name === 'table') tables++;
    return true;
  });
  return { from: s.from, to: s.to, anchor: s.anchor, head: s.head, depth: Math.min(s.$from.depth, s.$to.depth), text: v.state.doc.textBetween(s.from, s.to, ' | ', '⟨⟩').replace(/^( \| )+/, ''), math, insets, tables, selatoms: document.querySelectorAll('.lyx-editor .ol-selatom').length };
});
const par = (page: Page, i: number) => page.locator('.lyx-editor > .lyx-par').nth(i);
const lineHeight = (page: Page) => page.evaluate(() => parseFloat(getComputedStyle(document.querySelector('.lyx-editor > .lyx-par')!).lineHeight));
async function drag(page: Page, x1: number, y1: number, x2: number, y2: number, release = true) {
  await page.mouse.move(x1, y1); await page.mouse.down();
  await page.mouse.move(x2, y2, { steps: 8 });
  if (release) await page.mouse.up();
  await page.waitForTimeout(80);
}
/** the footnote opened (the server keeps the open state between tests): its whole box and its content's */
async function openFootnote(page: Page) {
  if (await page.locator('.lyx-editor .lyx-inset-foot.collapsed').count()) {
    await page.locator('.lyx-editor .lyx-inset-foot .inset-label').first().click();
    await page.waitForTimeout(300);
  }
  const box = (await page.locator('.lyx-editor .lyx-inset-foot').first().boundingBox())!;
  const content = (await page.locator('.lyx-editor .lyx-inset-foot .inset-content').first().boundingBox())!;
  return { box, content };
}

test('a drag takes an inline formula or a footnote whole, by the pointer side, instead of diving into it', async ({ page }) => {
  const errors = collectErrors(page);
  const lh = await lineHeight(page);
  const b1 = (await par(page, 1).boundingBox())!;
  const f = (await page.locator('.lyx-editor .lyx-math-inline').first().boundingBox())!;
  await drag(page, b1.x + 5, b1.y + lh / 2, f.x + 4, f.y + f.height / 2);
  let s = await selection(page);
  expect(s.text).toBe('Second paragraph has an inline formula ');
  expect(s.math).toBe(0);                                  // pointer on the left quarter: before the formula
  await drag(page, b1.x + 5, b1.y + lh / 2, f.x + f.width - 4, f.y + f.height / 2);
  s = await selection(page);
  expect(s.math).toBe(1);                                  // right quarter: the formula, whole
  expect(s.selatoms).toBe(1);                              // ... and painted as selected
  const fn = await openFootnote(page);
  await drag(page, b1.x + 5, b1.y + lh / 2, fn.content.x + 10, fn.content.y + fn.content.height / 2);
  s = await selection(page);
  expect(s.depth).toBe(1);                                 // never half a footnote
  expect(s.insets).toBe(0);
  expect(s.text).toContain('then a footnote');
  await drag(page, b1.x + 5, b1.y + lh / 2, fn.box.x + fn.box.width * 0.92, fn.box.y + fn.box.height / 2);
  s = await selection(page);
  expect(s.depth).toBe(1);
  expect(s.insets).toBe(1);                                // the pointer past its middle: the footnote whole
  expect(s.text).toContain('Footnote text inside the inset');
  expect(await page.locator('.lyx-editor .lyx-inset-foot.ol-selatom').count()).toBe(1);
  expect(errors).toEqual([]);
});

test('a drag leaving the footnote it started in continues outside with the footnote whole, and shrinks back into it', async ({ page }) => {
  const errors = collectErrors(page);
  const lh = await lineHeight(page);
  const { content: fn } = await openFootnote(page);
  const b2 = (await par(page, 2).boundingBox())!;
  await drag(page, fn.x + fn.width * 0.3, fn.y + fn.height / 2, fn.x + fn.width * 0.6, fn.y + fn.height / 2);
  let s = await selection(page);
  expect(s.depth).toBe(3);                                 // inside the footnote: an ordinary text selection there
  expect(s.text).toMatch(/^[a-z ]+$/);
  await drag(page, fn.x + fn.width * 0.3, fn.y + fn.height / 2, b2.x + 80, b2.y + lh / 2, false);
  s = await selection(page);
  expect(s.depth).toBe(1);
  expect(s.insets).toBe(1);                                // the footnote came along whole
  expect(s.text).toContain('Footnote text inside the inset');
  expect(s.text).toContain('Third');
  await page.mouse.move(fn.x + fn.width * 0.7, fn.y + fn.height / 2, { steps: 6 });   // back inside: the selection is inside again
  await page.waitForTimeout(80);
  s = await selection(page);
  expect(s.depth).toBe(3);
  expect(s.insets).toBe(0);
  await page.mouse.up();
  expect(errors).toEqual([]);
});

test('a press inside the selection places the caret and drags a new selection — no drag-and-drop of the text', async ({ page }) => {
  const errors = collectErrors(page);
  const lh = await lineHeight(page);
  const b0 = (await par(page, 0).boundingBox())!;
  const before = await page.evaluate(() => (window as any).overlyx.activeView.state.doc.textContent);
  await drag(page, b0.x + 60, b0.y + lh / 2, b0.x + 300, b0.y + lh / 2);
  const s1 = await selection(page);
  expect(s1.text).toMatch(/^paragraph word1 /);
  await drag(page, b0.x + 150, b0.y + lh / 2, b0.x + 250, b0.y + lh * 1.5);
  const s2 = await selection(page);
  expect(s2.from).toBeGreaterThan(s1.from);
  expect(s2.to).toBeGreaterThan(s1.to);
  expect(s2.text.length).toBeGreaterThan(40);
  expect(await page.evaluate(() => (window as any).overlyx.activeView.state.doc.textContent)).toBe(before);
  // a plain click inside the selection: just the caret there
  await page.mouse.click(b0.x + 200, b0.y + lh / 2);
  await page.waitForTimeout(80);
  const s3 = await selection(page);
  expect(s3.from).toBe(s3.to);
  expect(s3.from).toBeGreaterThan(s2.from);
  expect(await page.evaluate(() => (window as any).overlyx.activeView.state.doc.textContent)).toBe(before);
  expect(errors).toEqual([]);
});

test('double click selects the word and a drag grows by words; triple click the paragraph, growing by paragraphs', async ({ page }) => {
  const errors = collectErrors(page);
  const lh = await lineHeight(page);
  const b0 = (await par(page, 0).boundingBox())!;
  await page.mouse.move(b0.x + 60, b0.y + lh / 2);
  await page.mouse.down(); await page.mouse.up();
  await page.mouse.down({ clickCount: 2 });
  await page.waitForTimeout(80);
  let s = await selection(page);
  expect(s.text).toBe('paragraph');
  await page.mouse.move(b0.x + 260, b0.y + lh / 2, { steps: 6 });
  await page.mouse.up();
  await page.waitForTimeout(80);
  s = await selection(page);
  expect(s.text).toMatch(/^paragraph( word\d+)+$/);      // whole words only
  expect(s.text.split(' ').length).toBeGreaterThan(2);
  // backwards, too
  await page.mouse.move(b0.x + 260, b0.y + lh / 2);
  await page.mouse.down(); await page.mouse.up();
  await page.mouse.down({ clickCount: 2 });
  await page.mouse.move(b0.x + 60, b0.y + lh / 2, { steps: 6 });
  await page.mouse.up();
  await page.waitForTimeout(80);
  s = await selection(page);
  expect(s.text).toMatch(/^paragraph( word\d+)+$/);
  // triple click: the paragraph; dragging into the next one takes it whole as well
  const b1 = (await par(page, 1).boundingBox())!;
  await page.mouse.move(b0.x + 60, b0.y + lh / 2);
  await page.mouse.down(); await page.mouse.up(); await page.mouse.down({ clickCount: 2 }); await page.mouse.up();
  await page.mouse.down({ clickCount: 3 });
  await page.waitForTimeout(80);
  s = await selection(page);
  expect(s.text).toMatch(/^First paragraph .* end of first paragraph\.$/);
  await page.mouse.move(b1.x + 40, b1.y + lh / 2, { steps: 6 });
  await page.mouse.up();
  await page.waitForTimeout(80);
  s = await selection(page);
  expect(s.text).toMatch(/^First paragraph .*beyond it\.$/);
  expect(errors).toEqual([]);
});

test('a display formula and a table are passed at their middle and taken whole across', async ({ page }) => {
  const errors = collectErrors(page);
  const lh = await lineHeight(page);
  const b2 = (await par(page, 2).boundingBox())!;
  const eq = (await page.locator('.lyx-editor .lyx-math-display').first().boundingBox())!;
  await drag(page, b2.x + 5, b2.y + lh / 2, eq.x + eq.width / 2, eq.y + 3);
  let s = await selection(page);
  expect(s.text).toBe('Third paragraph before the display equation.');
  expect(s.math).toBe(0);
  await drag(page, b2.x + 5, b2.y + lh / 2, eq.x + eq.width / 2, eq.y + eq.height - 3);
  s = await selection(page);
  expect(s.math).toBe(1);
  expect(s.depth).toBe(1);
  const tb = (await page.locator('.lyx-editor .lyx-tabular').first().boundingBox())!;
  const b4 = (await page.locator('.lyx-editor > .lyx-par', { hasText: 'Fifth paragraph' }).boundingBox())!;
  await drag(page, b2.x + 5, b2.y + lh / 2, tb.x + tb.width / 2, tb.y + tb.height - 3);
  s = await selection(page);
  expect(s.tables).toBe(1);                                // the lower half: the table whole, never a cell selection
  expect(s.depth).toBe(1);
  await drag(page, b2.x + 5, b2.y + lh / 2, b4.x + 150, b4.y + lh / 2);
  s = await selection(page);
  expect(s.tables).toBe(1);
  expect(s.math).toBe(1);
  expect(s.text).toContain('Fifth paragraph');
  expect(errors).toEqual([]);
});

test('dragging into the margins reaches the line ends and the start of the document; past the bottom the page scrolls', async ({ page }) => {
  const errors = collectErrors(page);
  const lh = await lineHeight(page);
  const b0 = (await par(page, 0).boundingBox())!;
  const ed = (await page.locator('.lyx-editor').boundingBox())!;
  await drag(page, b0.x + 60, b0.y + lh / 2, b0.x + b0.width + 150, b0.y + lh * 1.5);
  const right = await selection(page);
  expect(right.text).toMatch(/word\d+ $/);              // the end of the second line (its trailing space)
  await drag(page, b0.x + 60, b0.y + lh / 2, b0.x - 150, b0.y + lh * 2.5);
  const left = await selection(page);
  expect(Math.abs(left.to - right.to)).toBeLessThanOrEqual(1);   // the start of the third line
  await drag(page, b0.x + 200, b0.y + lh * 1.5, b0.x + 100, ed.y - 40);
  const top = await selection(page);
  expect(top.from).toBe(1);
  expect(top.text).toMatch(/^First paragraph/);
  // autoscroll: hold the pointer below the visible page
  const before = await page.evaluate(() => (window as any).overlyx.activeView.state.doc.textContent);
  const sc = (await page.locator('.editor-scroll').boundingBox())!;
  const b4 = (await page.locator('.lyx-editor > .lyx-par', { hasText: 'Fifth paragraph' }).boundingBox())!;
  const st0 = await page.evaluate(() => document.querySelector('.editor-scroll')!.scrollTop);
  await page.mouse.move(b4.x + 5, b4.y + lh / 2); await page.mouse.down();
  await page.mouse.move(b4.x + 100, sc.y + sc.height + 20, { steps: 5 });
  await page.waitForTimeout(2500);
  const st1 = await page.evaluate(() => document.querySelector('.editor-scroll')!.scrollTop);
  await page.mouse.up();
  expect(st1).toBeGreaterThan(st0 + 200);
  const s = await selection(page);
  expect(s.text).toMatch(/^Fifth paragraph/);
  expect(s.text).toContain('Filler paragraph number 49');
  expect(errors).toEqual([]);
  expect(await page.evaluate(() => (window as any).overlyx.activeView.state.doc.textContent)).toBe(before);   // nothing but selections happened
});
