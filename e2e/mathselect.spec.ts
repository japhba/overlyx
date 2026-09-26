/**
 * LyX-like mouse selection in and around formulas: dragging inside a field stays robust off the
 * glyph boxes (nearest cell, as in LyX's editXY) and never dives deeper than the anchor (insets
 * taken whole); a drag that leaves the field continues as a document selection with the formula
 * whole; a drag across a display formula takes it whole; and a dead ^ key (Mac / German layouts,
 * arriving as a composition) enters the superscript at the keypress itself. The second formula
 * checks LyX's coordinate model (geometry.ts): clicks land on the nearest boundary or inside the
 * inset under the pointer, the corner markers hug the fraction, double / triple click select the
 * cell / the formula, a drag from inside a fraction takes it whole and comes back into the formula,
 * Shift+click from the text takes the formula whole.
 */
import { test, expect, type Page } from '@playwright/test';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { login, openDoc, collectErrors, texDoc, PROJECTS_DIR } from './helpers';

const PROJECT = 'admin/e2e-mathselect';
const DIR = `${PROJECTS_DIR}/${PROJECT}`;

test.beforeAll(() => {
  rmSync(DIR, { recursive: true, force: true });
  mkdirSync(DIR, { recursive: true });
  writeFileSync(`${DIR}/doc.tex`, texDoc(`Before $abc+\\frac{u}{v}+xyz$ after more text here.

Precision $2\\pi\\frac{1}{2}+x^{2}$ end.

Second paragraph before the display.
\\begin{equation}
E=mc^{2}
\\end{equation}
Third paragraph after the display equation.`));
});
test.afterAll(() => { rmSync(DIR, { recursive: true, force: true }); });

test.beforeEach(async ({ page }) => { await login(page); });

async function inlineField(page: Page): Promise<{ x: number; y: number; width: number; height: number }> {
  const wrap = page.locator('.lyx-editor .lyx-math-inline').first();
  await wrap.hover();                                    // upgrades the static rendering to a field
  await expect(wrap.locator('.lm-field')).toHaveCount(1, { timeout: 5000 });
  return (await wrap.locator('.lm-content').boundingBox())!;
}

const fieldState = (page: Page) => page.evaluate(() => {
  const f = (document.querySelector('.lyx-editor .lyx-math-inline') as any).pmViewDesc.spec.field;
  return {
    selection: !!f.cursor.selection,
    sel: f.cursor.selection ? (f.cursor.grabSelection() as string) : '',
    depth: f.cursor.depth as number,
    inset: (f.cursor.inset?.t as string) ?? null,
    latex: f.latex as string,
  };
});

test('dragging inside a formula tracks off-glyph points and takes insets whole', async ({ page }) => {
  const errors = collectErrors(page);
  await openDoc(page, `${PROJECT}/doc.tex`);
  const box = await inlineField(page);
  const midY = box.y + box.height / 2;
  // from the very start to near the end, finishing slightly ABOVE the glyph boxes (this used to
  // snap the selection end to the start or end of the whole formula)
  await page.mouse.move(box.x + 1, midY);
  await page.mouse.down();
  await page.mouse.move(box.x + box.width * 0.93, box.y - 3, { steps: 8 });
  await page.mouse.up();
  let s = await fieldState(page);
  expect(s.selection).toBe(true);
  expect(s.depth).toBe(1);                               // top level: the drag never dived into insets
  expect(s.sel).toContain('abc');
  expect(s.sel).toContain('\\frac{u}{v}');               // the fraction came along as one unit
  // from the start into the MIDDLE of the fraction: clamped to the anchor's level — either the
  // whole \frac is included or the selection stops before it, never half a numerator
  await page.mouse.move(box.x + 1, midY);
  await page.mouse.down();
  await page.mouse.move(box.x + box.width * 0.5, midY, { steps: 6 });
  await page.mouse.up();
  s = await fieldState(page);
  expect(s.selection).toBe(true);
  expect(s.depth).toBe(1);
  if (s.sel.includes('\\frac')) expect(s.sel).toContain('\\frac{u}{v}');
  expect(errors).toEqual([]);
});

test('a drag leaving the formula continues in the text with the formula selected whole', async ({ page }) => {
  const errors = collectErrors(page);
  await openDoc(page, `${PROJECT}/doc.tex`);
  const box = await inlineField(page);
  await page.mouse.move(box.x + 4, box.y + box.height / 2);
  await page.mouse.down();
  await page.mouse.move(box.x + box.width + 80, box.y + box.height / 2, { steps: 10 });
  await page.mouse.up();
  const r = await page.evaluate(() => {
    const v = (window as any).overlyx.activeView, s = v.state.selection;
    let math = 0;
    v.state.doc.nodesBetween(s.from, s.to, (n: any) => { if (n.type.name === 'math_inline') math++; });
    const f = (document.querySelector('.lyx-editor .lyx-math-inline') as any).pmViewDesc.spec.field;
    return { empty: s.empty as boolean, math, text: v.state.doc.textBetween(s.from, s.to, ' ', ' ') as string, fieldSel: !!f.cursor.selection };
  });
  expect(r.empty).toBe(false);
  expect(r.math).toBe(1);                                // the formula is inside the selection, whole
  expect(r.text).toContain('aft');                       // ... and the drag went on into " after"
  expect(r.fieldSel).toBe(false);                        // the field's own selection was handed over
  expect(await page.locator('.lyx-editor .lyx-math-inline.ol-selatom').count()).toBe(1);   // visibly selected whole
  expect(errors).toEqual([]);
});

test('a drag across a display formula takes it whole and does not stall on it', async ({ page }) => {
  const errors = collectErrors(page);
  await openDoc(page, `${PROJECT}/doc.tex`);
  // the display formula is an inline node of one paragraph: "Second …" is the line above it,
  // "Third …" the line below — drag from the first line across the equation row to the last
  const par = page.locator('.lyx-editor .lyx-par', { hasText: 'Second paragraph' }).first();
  const b = (await par.boundingBox())!;
  const eq = (await page.locator('.lyx-editor .lyx-math-display').first().boundingBox())!;
  await page.mouse.move(b.x + 5, (b.y + eq.y) / 2);                                 // middle of the first text line
  await page.mouse.down();
  await page.mouse.move(eq.x + eq.width / 2, eq.y + eq.height / 2, { steps: 6 });   // straight over the KaTeX widget
  await page.mouse.move(b.x + 100, (eq.y + eq.height + b.y + b.height) / 2, { steps: 6 });   // middle of the last line
  await page.mouse.up();
  const r = await page.evaluate(() => {
    const v = (window as any).overlyx.activeView, s = v.state.selection;
    let math = 0;
    v.state.doc.nodesBetween(s.from, s.to, (n: any) => { if (n.type.name === 'math_display') math++; });
    return { math, text: v.state.doc.textBetween(s.from, s.to, ' ', ' ') as string };
  });
  expect(r.math).toBe(1);
  expect(r.text).toContain('Second');
  expect(r.text).toContain('Third');
  expect(await page.locator('.lyx-editor .lyx-math-display.ol-selatom').count()).toBe(1);  // visibly selected whole
  expect(errors).toEqual([]);
});

test('a dead ^ (composed on Mac / German layouts) enters the superscript immediately', async ({ page }) => {
  const errors = collectErrors(page);
  await openDoc(page, `${PROJECT}/doc.tex`);
  const box = await inlineField(page);
  await page.mouse.click(box.x + box.width - 1, box.y + box.height / 2);   // caret at the end
  const compose = (type: string, data: string) => page.evaluate(([t, d]) => {
    const input = document.querySelector('.lyx-editor .lyx-math-inline .lm-input')!;
    input.dispatchEvent(new CompositionEvent(t, { data: d }));
  }, [type, data]);
  // the browser's dead-key sequence: the ^ keypress opens a composition
  await compose('compositionstart', '');
  await compose('compositionupdate', '^');
  let s = await fieldState(page);
  expect(s.inset).toBe('script');                        // superscript entered at the keypress itself
  const before = s.latex;
  // ^ then a arrives as the composed â: compositionend contributes only the a
  await compose('compositionend', 'â');
  s = await fieldState(page);
  expect(s.latex).not.toBe(before);
  expect(s.latex).toMatch(/\^\{?a\}?/);
  expect(s.latex).not.toContain('â');
  // ^ committed alone (^ followed by space): nothing is typed twice
  await compose('compositionstart', '');
  await compose('compositionupdate', '^');
  const mid = (await fieldState(page)).latex;
  await compose('compositionend', '^');
  s = await fieldState(page);
  expect(s.latex).toBe(mid);
  expect(errors).toEqual([]);
});

test('Shift+ArrowRight selects LyX chunks and continues out of the formula', async ({ page }) => {
  const errors = collectErrors(page);
  await openDoc(page, `${PROJECT}/doc.tex`);
  const box = await inlineField(page);
  await page.mouse.click(box.x + 1, box.y + box.height / 2);      // caret at the very start
  for (let i = 0; i < 5; i++) await page.keyboard.press('Shift+ArrowRight');   // a, b, c, +, \frac
  const s = await fieldState(page);
  expect(s.selection).toBe(true);
  expect(s.depth).toBe(1);
  expect(s.sel).toContain('abc+');
  expect(s.sel).toContain('\\frac{u}{v}');                        // the fraction came as ONE chunk
  for (let i = 0; i < 4; i++) await page.keyboard.press('Shift+ArrowRight');   // +, x, y, z → at the edge
  await page.keyboard.press('Shift+ArrowRight');                   // pops out: formula selected whole in the document
  const r = await page.evaluate(() => {
    const v = (window as any).overlyx.activeView, s2 = v.state.selection;
    let math = 0;
    v.state.doc.nodesBetween(s2.from, s2.to, (n: any) => { if (n.type.name === 'math_inline') math++; });
    const f = (document.querySelector('.lyx-editor .lyx-math-inline') as any).pmViewDesc.spec.field;
    return { math, span: (s2.to - s2.from) as number, fieldSel: !!f.cursor.selection, lit: document.querySelectorAll('.lyx-editor .lyx-math-inline.ol-selatom').length };
  });
  expect(r.math).toBe(1);
  expect(r.span).toBe(1);                                          // exactly the formula node
  expect(r.fieldSel).toBe(false);
  expect(r.lit).toBe(1);                                           // ... and it is visibly highlighted
  await page.keyboard.press('Shift+ArrowRight');                   // keeps going into the text after it
  await page.waitForTimeout(150);                                  // the browser's own extension arrives through selectionchange
  expect(await page.evaluate(() => { const s2 = (window as any).overlyx.activeView.state.selection; return s2.to - s2.from; })).toBeGreaterThan(1);
  expect(errors).toEqual([]);
});

test('Shift+Arrow from the text beside a formula takes it whole and lights it up', async ({ page }) => {
  const errors = collectErrors(page);
  await openDoc(page, `${PROJECT}/doc.tex`);
  await page.locator('.lyx-editor .lyx-par').first().click({ position: { x: 5, y: 8 } });   // focus the editor away from the formula
  await page.evaluate(() => {
    const v = (window as any).overlyx.activeView;
    let pos = -1;
    v.state.doc.descendants((n: any, p: number) => { if (pos < 0 && n.type.name === 'math_inline') pos = p; });
    v.dispatch(v.state.tr.setSelection(v.state.selection.constructor.create(v.state.doc, pos)));
    v.focus();
  });
  await page.keyboard.press('Shift+ArrowRight');
  const r = await page.evaluate(() => {
    const s = (window as any).overlyx.activeView.state.selection;
    return { span: (s.to - s.from) as number, lit: document.querySelectorAll('.lyx-editor .ol-selatom').length };
  });
  expect(r.span).toBe(1);                                          // one keypress, one whole formula
  expect(r.lit).toBe(1);
  await page.keyboard.press('Shift+ArrowLeft');
  const r2 = await page.evaluate(() => {
    const s = (window as any).overlyx.activeView.state.selection;
    return { span: (s.to - s.from) as number, lit: document.querySelectorAll('.lyx-editor .ol-selatom').length };
  });
  expect(r2.span).toBe(0);
  expect(r2.lit).toBe(0);
  expect(errors).toEqual([]);
});

/* ---------------------------------------------------------------- LyX's coordinate model */

type Rect = { x: number; y: number; width: number; height: number };
const second = (page: Page) => page.locator('.lyx-editor .lyx-math-inline').nth(1);

/** the second formula, upgraded, with the boxes of its top-level atoms (2, π, the fraction, +, x²) */
async function precisionField(page: Page): Promise<{ atoms: Rect[]; num: Rect; frac: Rect; sup: Rect }> {
  const wrap = second(page);
  await wrap.hover();
  await expect(wrap.locator('.lm-field')).toHaveCount(1, { timeout: 5000 });
  await page.waitForTimeout(100);
  const atoms = await wrap.locator('.lm-c0 > .lm-a').evaluateAll(els => els.map(e => { const r = e.getBoundingClientRect(); return { x: r.left, y: r.top, width: r.width, height: r.height }; }));
  expect(atoms.length).toBe(5);
  const num = (await wrap.locator('.lm-c1').boundingBox())!;
  const frac = (await wrap.locator('.lm-c0 .mfrac .vlist-t').first().boundingBox())!;   // the visible fraction
  const sup = (await wrap.locator('.lm-c4').boundingBox())!;
  return { atoms, num, frac, sup };
}

const secondState = (page: Page) => page.evaluate(async () => {
  await new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r)));   // the overlay is redrawn on the next frame
  const f = (document.querySelectorAll('.lyx-editor .lyx-math-inline')[1] as any).pmViewDesc.spec.field;
  const corners = [...document.querySelectorAll('.lyx-editor .lyx-math-inline .lm-corner')].map(e => { const r = e.getBoundingClientRect(); return { x: r.left, y: r.top, right: r.right, bottom: r.bottom }; });
  return { depth: f.cursor.depth as number, idx: f.cursor.idx as number, pos: f.cursor.pos as number, inset: (f.cursor.inset?.t as string) ?? null, sel: f.cursor.selection ? (f.cursor.grabSelection() as string) : '', corners };
});

const docSelection = (page: Page) => page.evaluate(() => {
  const v = (window as any).overlyx.activeView, s = v.state.selection;
  let math = 0;
  v.state.doc.nodesBetween(s.from, s.to, (n: any) => { if (n.type.name === 'math_inline') math++; });
  return { span: (s.to - s.from) as number, math, text: v.state.doc.textBetween(s.from, s.to, ' ', ' ') as string };
});

test('clicks land on the nearest boundary, inside the inset under the pointer, and the markers hug the fraction', async ({ page }) => {
  const errors = collectErrors(page);
  await openDoc(page, `${PROJECT}/doc.tex`);
  const { atoms, num, frac, sup } = await precisionField(page);
  const [two, pi] = atoms;
  const midY = two.y + two.height / 2;
  // "2π" is one text run for KaTeX — every character still has its own box: the left quarter of π
  // puts the caret before it, the right quarter behind it
  await page.mouse.click(pi.x + pi.width * 0.25, midY);
  let s = await secondState(page);
  expect([s.depth, s.pos]).toEqual([1, 1]);
  await page.mouse.click(pi.x + pi.width * 0.75, midY);
  s = await secondState(page);
  expect([s.depth, s.pos]).toEqual([1, 2]);
  await page.mouse.click(two.x + 1, midY);
  s = await secondState(page);
  expect([s.depth, s.pos]).toEqual([1, 0]);
  // into the numerator: the slice above points at the fraction, the fraction gets all four corners,
  // one pixel outside its visible box (MathRow::drawMarkers) — not around KaTeX's null delimiters,
  // not at the height of the text line
  await page.mouse.click(num.x + num.width / 2, num.y + num.height / 2);
  s = await secondState(page);
  expect([s.depth, s.inset, s.idx]).toEqual([2, 'frac', 0]);
  expect(s.corners.length).toBe(4);
  const xs = s.corners.map(c => c.x).sort((a, b) => a - b), ys = s.corners.map(c => c.y).sort((a, b) => a - b);
  expect(Math.abs(xs[0] - (frac.x - 1))).toBeLessThan(1.5);
  expect(Math.abs(s.corners.map(c => c.right).sort((a, b) => b - a)[0] - (frac.x + frac.width + 1))).toBeLessThan(1.5);
  expect(Math.abs(ys[0] - (frac.y - 1))).toBeLessThan(2);
  expect(Math.abs(s.corners.map(c => c.bottom).sort((a, b) => b - a)[0] - (frac.y + frac.height + 2))).toBeLessThan(2.5);
  // the superscript: a script inset, marked below only
  await page.mouse.click(sup.x + sup.width / 2, sup.y + sup.height / 2);
  s = await secondState(page);
  expect([s.depth, s.inset, s.idx]).toEqual([2, 'script', 1]);
  expect(s.corners.length).toBe(2);
  expect(errors).toEqual([]);
});

test('double click selects the cell, triple click the whole formula (LFUN_MOUSE_DOUBLE / TRIPLE)', async ({ page }) => {
  const errors = collectErrors(page);
  await openDoc(page, `${PROJECT}/doc.tex`);
  const { num, atoms } = await precisionField(page);
  await page.mouse.dblclick(num.x + num.width / 2, num.y + num.height / 2);
  let s = await secondState(page);
  expect([s.depth, s.sel]).toEqual([2, '1']);
  await page.mouse.click(atoms[1].x + 1, atoms[1].y + atoms[1].height / 2, { clickCount: 3 });
  s = await secondState(page);
  expect([s.depth, s.sel]).toEqual([1, '2\\pi\\frac{1}{2}+x^{2}']);
  expect(errors).toEqual([]);
});

test('a drag from inside a fraction takes it whole, goes out into the text and comes back into the formula', async ({ page }) => {
  const errors = collectErrors(page);
  await openDoc(page, `${PROJECT}/doc.tex`);
  const { atoms, num } = await precisionField(page);
  const midY = atoms[0].y + atoms[0].height / 2;
  // from the numerator to the end: the anchor stays inside, the selection is the fraction whole and what follows
  await page.mouse.move(num.x + 2, num.y + num.height / 2);
  await page.mouse.down();
  await page.mouse.move(atoms[4].x + atoms[4].width - 1, midY, { steps: 5 });
  await page.mouse.up();
  let s = await secondState(page);
  expect([s.depth, s.sel]).toEqual([1, '\\frac{1}{2}+x^{2}']);
  // out into the text: the document selects, formula whole; back onto the "+": the formula's own
  // selection again, from the same anchor, the document selection collapsed
  await page.mouse.move(num.x + 2, num.y + num.height / 2);
  await page.mouse.down();
  await page.mouse.move(atoms[4].x + atoms[4].width + 120, midY, { steps: 5 });
  const out = await docSelection(page);
  expect(out.math).toBe(1);
  expect(out.text).toContain('end');
  await page.mouse.move(atoms[3].x + 1, midY, { steps: 5 });
  await page.mouse.up();
  s = await secondState(page);
  expect([s.depth, s.sel]).toEqual([1, '\\frac{1}{2}']);
  expect((await docSelection(page)).span).toBe(0);
  expect(await page.locator('.lyx-editor .ol-selatom').count()).toBe(0);
  expect(errors).toEqual([]);
});

test('Shift+click from the text into a formula takes it whole', async ({ page }) => {
  const errors = collectErrors(page);
  await openDoc(page, `${PROJECT}/doc.tex`);
  const { num } = await precisionField(page);
  const par = page.locator('.lyx-editor .lyx-par', { hasText: 'Precision' }).first();
  await par.click({ position: { x: 3, y: 8 } });
  await page.keyboard.down('Shift');
  await page.mouse.click(num.x + num.width / 2, num.y + num.height / 2);
  await page.keyboard.up('Shift');
  const r = await docSelection(page);
  expect(r.math).toBe(1);
  expect(r.text).toContain('Precision');
  expect(await page.locator('.lyx-editor .lyx-math-inline.ol-selatom').count()).toBe(1);
  expect(errors).toEqual([]);
});
