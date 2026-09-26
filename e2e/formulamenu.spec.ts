/**
 * The right-click menu on a selected formula: a formula that lies inside the document's selection
 * (an equation selected whole, text dragged across one) keeps that selection on a right-click and
 * its menu offers the selection's Cut / Copy / Paste next to the formula's own entries; a right-click
 * on a display formula's margin selects it whole (a left click there enters it, as before); an
 * inline formula inside a text selection behaves the same.
 */
import { test, expect, type Page } from '@playwright/test';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { login, openDoc, collectErrors, texDoc, PROJECTS_DIR } from './helpers';

const PROJECT = 'admin/e2e-formulamenu';
const DIR = `${PROJECTS_DIR}/${PROJECT}`;

test.beforeAll(() => {
  rmSync(DIR, { recursive: true, force: true });
  mkdirSync(DIR, { recursive: true });
  writeFileSync(`${DIR}/doc.tex`, texDoc(`First paragraph with some plain words.

Second paragraph before the display.
\\begin{equation}
E=mc^{2}
\\end{equation}
Third paragraph after the display equation with $a+b$ inline formula.

Fourth paragraph at the end.`));
});
test.afterAll(() => { rmSync(DIR, { recursive: true, force: true }); });

const selection = (page: Page) => page.evaluate(() => {
  const s = (window as any).overlyx.activeView.state.selection;
  return { type: s.constructor.name.replace(/^_/, ''), from: s.from as number, to: s.to as number, empty: s.empty as boolean, inField: document.activeElement?.classList.contains('lm-input') ?? false };
});
const menuLabels = (page: Page) => page.locator('.ctx-menu .ctx-item').evaluateAll(rows => rows.map(r => r.querySelector('.ctx-label')!.textContent + (r.classList.contains('disabled') ? ' [disabled]' : '')));

async function open(page: Page) {
  await login(page);
  await openDoc(page, `${PROJECT}/doc.tex`);
  await page.waitForTimeout(1200);
}

test('a display equation inside a dragged selection: right-click keeps the selection, the menu cuts it, Ctrl+V brings it back', async ({ page }) => {
  const errors = collectErrors(page);
  await open(page);
  const eq = page.locator('.lyx-editor .lyx-math-display').first();
  const par = page.locator('.lyx-editor .lyx-par').nth(1);
  const pb = (await par.boundingBox())!, eb = (await eq.boundingBox())!;
  // drag from the first line of the paragraph, through the equation, into the line after it
  await page.mouse.move(pb.x + 30, pb.y + 10);
  await page.mouse.down();
  await page.mouse.move(pb.x + 60, eb.y + eb.height + 10, { steps: 10 });
  await page.mouse.up();
  const before = await selection(page);
  expect(before.empty).toBe(false);
  const eqPos = await page.evaluate(() => { let p = -1; (window as any).overlyx.activeView.state.doc.descendants((n: any, pos: number) => { if (n.type.name === 'math_display' && p < 0) p = pos; }); return p; });
  expect(before.from).toBeLessThanOrEqual(eqPos);
  expect(before.to).toBeGreaterThan(eqPos);
  // right-click on the formula itself (its field, upgraded on hover)
  await eq.hover();
  await expect(eq.locator('.lm-field')).toHaveCount(1, { timeout: 5000 });
  await eq.locator('.lm-field').click({ button: 'right' });
  const after = await selection(page);
  expect([after.from, after.to]).toEqual([before.from, before.to]);
  const labels = await menuLabels(page);
  expect(labels).toContain('Numbered');          // the formula's own entries…
  expect(labels).toContain('Cut');               // …and the selection's clipboard
  expect(labels).toContain('Copy');
  expect(labels).toContain('Paste');
  expect(labels).not.toContain('Fraction');      // not the field's editing entries: it has no cursor
  // Cut takes the whole selection, equation included; Ctrl+V brings it back
  await page.locator('.ctx-menu .ctx-item', { hasText: /^Cut/ }).click();
  await expect(page.locator('.lyx-editor .lyx-math-display')).toHaveCount(0, { timeout: 5000 });
  await page.keyboard.press('Control+v');
  await expect(page.locator('.lyx-editor .lyx-math-display')).toHaveCount(1, { timeout: 5000 });
  await expect(par).toContainText('Second paragraph before the display.');
  expect(errors).toEqual([]);
});

test('a right-click on the equation’s margin selects it whole for the menu; a left click there still enters it', async ({ page }) => {
  const errors = collectErrors(page);
  await open(page);
  const eq = page.locator('.lyx-editor .lyx-math-display').first();
  await page.locator('.lyx-editor .lyx-par').first().click();
  const eb = (await eq.boundingBox())!;
  await page.mouse.click(eb.x + 4, eb.y + eb.height / 2, { button: 'right' });
  await expect(page.locator('.lyx-math-display.ProseMirror-selectednode')).toHaveCount(1);
  const sel = await selection(page);
  expect(sel.type).toBe('NodeSelection');
  expect(sel.inField).toBe(false);               // the right-click did not put the cursor into the formula
  const labels = await menuLabels(page);
  expect(labels).toContain('Numbered');
  expect(labels).toContain('Cut');
  expect(labels).not.toContain('Cut [disabled]');
  expect(labels).not.toContain('Turn into a formula');
  await page.keyboard.press('Escape');
  // the same click with the left button enters the formula
  await page.mouse.click(eb.x + 4, eb.y + eb.height / 2);
  await expect.poll(async () => (await selection(page)).inField).toBe(true);
  expect(errors).toEqual([]);
});

test('an inline formula inside a text selection: right-click keeps the selection and offers Copy', async ({ page }) => {
  const errors = collectErrors(page);
  await open(page);
  const inl = page.locator('.lyx-editor .lyx-math-inline').first();
  // select from a few characters before the formula to a few after it
  await page.evaluate(() => {
    const v = (window as any).overlyx.activeView;
    let p = -1; v.state.doc.descendants((n: any, pos: number) => { if (n.type.name === 'math_inline' && p < 0) p = pos; });
    v.dispatch(v.state.tr.setSelection(v.state.selection.constructor.create(v.state.doc, p - 5, p + 8)));
    v.focus();
  });
  const before = await selection(page);
  await inl.hover();
  await expect(inl.locator('.lm-field')).toHaveCount(1, { timeout: 5000 });
  await inl.locator('.lm-field').click({ button: 'right' });
  const after = await selection(page);
  expect([after.from, after.to]).toEqual([before.from, before.to]);
  const labels = await menuLabels(page);
  expect(labels).toContain('Inline formula');
  expect(labels).toContain('Copy');
  expect(labels).toContain('Copy LaTeX');
  await page.keyboard.press('Escape');
  expect(errors).toEqual([]);
});
