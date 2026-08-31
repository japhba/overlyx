/**
 * LyX-like mouse selection in and around formulas: dragging inside a field stays robust off the
 * glyph boxes (nearest cell, as in LyX's editXY) and never dives deeper than the anchor (insets
 * taken whole); a drag that leaves the field continues as a document selection with the formula
 * whole; a drag across a display formula takes it whole; and a dead ^ key (Mac / German layouts,
 * arriving as a composition) enters the superscript at the keypress itself.
 */
import { test, expect, type Page } from '@playwright/test';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { login, openDoc, collectErrors, texDoc, PROJECTS_DIR } from './helpers';

const PROJECT = 'e2e-mathselect';
const DIR = `${PROJECTS_DIR}/${PROJECT}`;

test.beforeAll(() => {
  rmSync(DIR, { recursive: true, force: true });
  mkdirSync(DIR, { recursive: true });
  writeFileSync(`${DIR}/doc.tex`, texDoc(`Before $abc+\\frac{u}{v}+xyz$ after more text here.

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
