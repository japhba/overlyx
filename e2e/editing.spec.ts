/**
 * Editor features on a real multi-file paper (copy of recurrent_feature): macro-argument editing,
 * LyX-like environment markers, formula layout, context menus, cross-reference navigation, tabs,
 * the combined master+child view, the editable source pane and change-tracking info.
 */
import { test, expect, type Page } from '@playwright/test';
import { mkdirSync, copyFileSync, rmSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import { login, collectErrors, PROJECTS_DIR, FIXTURES_DIR, withPreambleOf } from './helpers';

const SRC = `${FIXTURES_DIR}/recurrent_feature`;
const PROJECT = 'e2e-paper';
const DIR = `${PROJECTS_DIR}/${PROJECT}`;
const FILES = ['main.tex', 'appendix.tex', 'lyxmacros.tex', 'macros.tex', 'preamble.tex', 'latexmkrc', 'bib.bib', 'icml2026.sty', 'icml2026.bst', 'icml.layout', 'fancyhdr.sty', 'algorithm.sty', 'algorithmic.sty'];

// a small document for the math-key tests: the paper's header (macro definitions come with it) + one formula
const MATH_LATEX = String.raw`\inv{A}+\left(x+\frac{a}{b}\right)+\text{if }x^{2}+\sqrt{y}+\hat{z}`;
const mathDoc = () => withPreambleOf(`${SRC}/main.tex`, `\\global\\long\\def\\inv#1{\\left(#1\\right)^{-1}}%

Test $${MATH_LATEX}$ end.
`);

test.beforeAll(() => {
  rmSync(DIR, { recursive: true, force: true });
  mkdirSync(DIR, { recursive: true });
  for (const f of FILES) if (existsSync(`${SRC}/${f}`)) copyFileSync(`${SRC}/${f}`, `${DIR}/${f}`);
  // the figures the paper shows (a symlink to the fixture directory would point outside the project: the sandboxed converters cannot read it)
  mkdirSync(`${DIR}/figures`, { recursive: true });
  for (const m of readFileSync(`${SRC}/main.tex`, 'utf8').matchAll(/\\includegraphics(?:\[[^\]]*\])?\{figures\/([^}]+)\}/g)) if (existsSync(`${SRC}/figures/${m[1]}`)) copyFileSync(`${SRC}/figures/${m[1]}`, `${DIR}/figures/${m[1]}`);
  writeFileSync(`${DIR}/math.tex`, mathDoc());
});
test.afterAll(() => { rmSync(DIR, { recursive: true, force: true }); });

async function openPaper(page: Page, file = 'main.tex', minParagraphs = 50) {
  await page.evaluate(() => { localStorage.setItem('ol.tabs', '[]'); localStorage.setItem('ol.combined', '0'); });
  await page.goto(`/#/${PROJECT}/${file}`);
  await page.waitForFunction((n) => document.querySelectorAll('.lyx-editor .lyx-par').length >= n, minParagraphs, { timeout: 90000 });
  await page.waitForTimeout(1500);
}

test.beforeEach(async ({ page }) => { await login(page); });

test('macro arguments are editable in place and written back as macro calls', async ({ page }) => {
  const errors = collectErrors(page);
  await openPaper(page);
  const r = await page.evaluate(async () => {
    const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));
    const wrap = [...document.querySelectorAll('.lyx-math-inline')].find(w => /^\\inv\{/.test(((w as any).pmViewDesc?.node?.attrs?.latex) ?? ''))!;
    wrap.dispatchEvent(new PointerEvent('pointerenter'));      // hovering upgrades the static rendering to a field
    await sleep(100);
    const f = (wrap as any).pmViewDesc.spec.field;
    const before = f.latex as string;                          // the field's (LyX-normalised) form of the formula
    f.focus('start'); await sleep(50);
    f.cursor.mathForward();                                    // enters the macro's argument cell
    f.layout();
    await new Promise(r => requestAnimationFrame(() => setTimeout(r, 60)));
    const marked = f.dom.querySelectorAll('.lm-corner').length >= 4;                  // four corners around the macro
    const active = f.dom.querySelector('.lm-macro-name')?.textContent?.replace(/^\\/, '');
    f.execute('insert', 'Q');
    await sleep(400);
    const after = (wrap as any).pmViewDesc.node.attrs.latex as string;
    f.execute('undo');
    await sleep(400);
    return { before, marked, active, after, restored: (wrap as any).pmViewDesc.node.attrs.latex as string, inArg: f.cursor.inset?.t };
  });
  expect(r.inArg).toBe('macro');                     // the cursor is inside the macro's argument
  expect(r.marked).toBe(true);                       // LyX-like corner markers around the macro being edited
  expect(r.active).toBe('inv');
  const body = (s: string) => s.replace(/^\$|\$$/g, '');
  expect(r.after).toBe(body(r.before).replace(/^\\inv\{/, '\\inv{Q'));   // the argument edit is written back as \inv{...}
  expect(r.restored).toBe(body(r.before));
  expect(errors).toEqual([]);
});

test('LyX math keys: inset markers, Backspace/Delete dissolve a cell, Space leaves the inset', async ({ page }) => {
  const errors = collectErrors(page);
  await openPaper(page, 'math.tex', 2);
  const wrap = page.locator('.lyx-editor .lyx-math-inline').first();
  await wrap.hover();
  await expect(wrap.locator('.lm-field')).toHaveCount(1, { timeout: 5000 });
  await wrap.click();
  // cursor paths are [cell index, position] per level, like LyX's DocIterator
  const setPath = (path: number[][]) => page.evaluate((path) => {
    const f = (document.querySelector('.lyx-editor .lyx-math-inline') as any).pmViewDesc.spec.field;
    f.focus(); f.cursor.clearSelection(); f.restorePath(path); f.layout();
  }, path);
  const state = () => page.evaluate(() => {
    const f = (document.querySelector('.lyx-editor .lyx-math-inline') as any).pmViewDesc.spec.field;
    f.layout();
    return { latex: f.latex as string, depth: f.cursor.depth as number, pos: f.cursor.pos as number, corners: f.dom.querySelectorAll('.lm-corner').length, label: f.dom.querySelector('.lm-macro-name')?.textContent ?? null, selection: !!f.cursor.selection };
  });
  // atoms of the formula: \inv A (0) + (1) \left( (2) + (3) \text{if } (4) x^2 (5) + (6) \sqrt (7) + (8) \hat (9)
  // caret in the numerator: two lower corners for \left…\right plus four for the fraction
  await setPath([[0, 2], [0, 2], [0, 0]]);
  expect((await state()).corners).toBe(6);
  // caret in the macro argument: four corners and the macro name
  await setPath([[0, 0], [0, 1]]);
  expect(await state()).toMatchObject({ corners: 4, label: '\\inv' });
  // caret at top level: no markers
  await setPath([[0, 10]]);
  expect((await state()).corners).toBe(0);
  // Backspace at the inner left edge of \left( … \right) dissolves it
  await setPath([[0, 2], [0, 0]]);
  await page.keyboard.press('Backspace');
  await page.waitForTimeout(100);
  expect((await state()).latex).toContain('+x+\\frac{a}{b}+');
  await page.keyboard.press('Control+z');
  await page.waitForTimeout(100);
  expect((await state()).latex).toContain('\\left(x+\\frac{a}{b}\\right)');
  // Delete at the inner right edge of the macro argument replaces the macro by the argument
  await setPath([[0, 0], [0, 1]]);
  await page.keyboard.press('Delete');
  await page.waitForTimeout(100);
  expect((await state()).latex.startsWith('$A+')).toBe(true);
  await page.keyboard.press('Control+z');
  await page.waitForTimeout(100);
  expect((await state()).latex.startsWith('$\\inv A+')).toBe(true);
  // Delete at the end of a \text{} cell turns it into math characters
  await setPath([[0, 4], [0, 3]]);
  await page.keyboard.press('Delete');
  await page.waitForTimeout(100);
  expect((await state()).latex).toContain('+if x^{2}');
  await page.keyboard.press('Control+z');
  await page.waitForTimeout(100);
  expect((await state()).latex).toContain('\\text{if }');
  // deleting across a big inset selects it first (LyX confirmDeletion), the second Backspace removes it
  await setPath([[0, 8]]);
  await page.keyboard.press('Backspace');
  await page.waitForTimeout(100);
  expect((await state()).selection).toBe(true);
  expect((await state()).latex).toContain('\\sqrt{y}');
  await page.keyboard.press('Backspace');
  await page.waitForTimeout(100);
  expect((await state()).latex).not.toContain('\\sqrt');
  await page.keyboard.press('Control+z');
  await page.waitForTimeout(100);
  expect((await state()).latex).toContain('\\sqrt{y}');
  // \ starts a command name: shown red until it is a valid command, with LyX's completion in grey; Tab completes, then inserts
  await setPath([[0, 10]]);
  await page.keyboard.type('\\alp');
  await page.waitForTimeout(150);
  expect(await page.evaluate(() => { const f = document.querySelector('.lyx-editor .lyx-math-inline .lm-field')!; return { typing: !!f.querySelector('.lm-mm-typing'), hint: f.querySelector('.lm-mm-hint')?.textContent }; })).toEqual({ typing: true, hint: 'ha' });
  await page.keyboard.press('Tab');
  await page.waitForTimeout(150);
  expect(await page.evaluate(() => { const f = document.querySelector('.lyx-editor .lyx-math-inline .lm-field')!; return { ok: !!f.querySelector('.lm-mm-ok'), text: f.querySelector('.lm-mm')?.textContent }; })).toEqual({ ok: true, text: '\\alpha' });
  await page.keyboard.press('Tab');
  await page.waitForTimeout(150);
  expect((await state()).latex).toContain('\\hat{z}\\alpha');
  for (let i = 0; i < 3; i++) { await page.keyboard.press('Control+z'); await page.waitForTimeout(60); }   // typing, completion, insertion
  await page.waitForTimeout(100);
  expect((await state()).latex.endsWith('\\hat{z}$')).toBe(true);
  // Space leaves the superscript, and at the end of the formula leaves the formula with a text space
  await setPath([[0, 5], [1, 1]]);
  await page.keyboard.press('Space');
  await page.keyboard.type('q');
  await page.waitForTimeout(100);
  expect((await state()).latex).toContain('x^{2}q+');
  await page.keyboard.press('Control+z');
  await setPath([[0, 10]]);
  await page.keyboard.press('Space');
  await page.waitForTimeout(150);
  expect(await page.evaluate(() => document.activeElement?.className)).not.toContain('lm-input');
  const para = await page.locator('.lyx-editor .lyx-par').nth(1).textContent();
  expect(para).toMatch(/  end\.\s*$/);
  expect(errors).toEqual([]);
});

test('formulas: tight inline spacing, no change background, ln|H| via redefined macros', async ({ page }) => {
  await openPaper(page);
  const r = await page.evaluate(() => {
    const st = [...document.querySelectorAll('.lyx-math-inline .lyx-math-static')].find(s => s.textContent && s.textContent.length < 3)!;
    const wrap = st.parentElement!;
    const base = st.querySelector('.katex')!.getBoundingClientRect();
    const w = wrap.getBoundingClientRect();
    const ins = document.querySelector('.lyx-change-inserted');
    const lndet = [...document.querySelectorAll('.lyx-math-inline')].find(x => /\\lndet\{\\HH\}/.test((x as any).pmViewDesc?.node?.attrs?.latex ?? ''));
    const ld = lndet?.querySelector('.lyx-math-static, .lm-field');
    return { left: base.left - w.left, right: w.right - base.right, bg: ins ? getComputedStyle(ins).backgroundColor : null, lndet: ld ? { text: ld.textContent, open: ld.querySelectorAll('.mopen').length, close: ld.querySelectorAll('.mclose').length } : null };
  });
  expect(r.left).toBeLessThan(6);
  expect(r.right).toBeLessThan(6);
  expect(r.bg === null || r.bg === 'rgba(0, 0, 0, 0)').toBe(true);
  // bars surround the argument (\lndet redefined after a stale \det): KaTeX draws sized delimiters as SVG
  expect(r.lndet?.text).toMatch(/^ln/);
  expect(r.lndet?.open).toBeGreaterThan(0); expect(r.lndet?.close).toBeGreaterThan(0);
});

test('wide display formulas are centred on the column and equation numbers never overlap', async ({ page }) => {
  await openPaper(page);
  // a paragraph of prose (the first ones hold the class's raw title code)
  const p = page.locator('.lyx-editor > .lyx-par.lyx-layout-standard').filter({ hasText: /neural network/i }).first();
  await p.click({ position: { x: 4, y: 8 } });
  await page.keyboard.press('End');
  await page.keyboard.press('Control+Shift+m');
  await expect(page.locator('.lm-field.focused')).toHaveCount(1, { timeout: 5000 });
  await page.waitForTimeout(500);
  await page.keyboard.type('W=' + 'A_1 B_1 C_1 +'.repeat(20));   // LyX style: Space leaves the subscript
  await page.waitForTimeout(600);
  const r = await page.evaluate(() => {
    const d = document.querySelector('.lm-field.focused')!.closest('.lyx-math-display') as HTMLElement;
    const ed = document.querySelector('.lyx-editor')!.getBoundingClientRect();
    const m = d.querySelector('.lm-field')!.getBoundingClientRect();
    const eq = [...document.querySelectorAll('.lyx-math-display')].filter(x => x.querySelector('.eq-number')?.textContent).slice(0, 8).map(x => {
      const c = (x.querySelector('.lm-field') ?? x.querySelector('.lyx-math-static'))!.getBoundingClientRect();
      const n = x.querySelector('.eq-number')!.getBoundingClientRect();
      return n.left >= c.right - 1;
    });
    return { shifted: d.style.marginLeft !== '', leftOverflow: ed.left - m.left, width: m.width, numbersClear: eq.every(Boolean), numbered: eq.length };
  });
  expect(r.width).toBeGreaterThan(900);
  expect(r.shifted).toBe(true);                     // overflows symmetrically into the margin ...
  expect(r.leftOverflow).toBeGreaterThan(20);
  expect(r.leftOverflow).toBeLessThan(60);          // ... but never past the page edge
  expect(r.numbered).toBeGreaterThan(0);
  expect(r.numbersClear).toBe(true);
  await page.keyboard.press('Escape');
  // remove the test formula again
  await page.keyboard.press('Backspace');
});

test('right-click menus and go-to-label for cross-references', async ({ page }) => {
  await openPaper(page);
  const ref = page.locator('.lyx-command-ref', { hasText: 'eq:weight-model-RNN' }).first();
  await ref.scrollIntoViewIfNeeded();
  await ref.click({ button: 'right' });
  const menu = page.locator('.ctx-menu').first();
  await expect(menu).toBeVisible();
  await expect(menu.locator('.ctx-item', { hasText: 'Go to label' })).toHaveCount(1);
  await expect(menu.locator('.ctx-item', { hasText: 'Reference format' })).toHaveCount(1);
  await menu.locator('.ctx-item', { hasText: 'Go to label' }).click();
  await expect(page.locator('.lyx-math-display.ProseMirror-selectednode')).toHaveCount(1);
  expect(await page.locator('.lyx-math-display.ProseMirror-selectednode .eq-labels').textContent()).toContain('eq:weight-model-RNN');
  // Ctrl+click does the same
  await page.evaluate(() => document.querySelector('.editor-scroll')!.scrollTo(0, 0));
  await ref.scrollIntoViewIfNeeded();
  await ref.click({ modifiers: ['Control'] });
  await expect(page.locator('.lyx-math-display.ProseMirror-selectednode')).toHaveCount(1);
  // a formula context menu
  const disp = page.locator('.lyx-math-display.ProseMirror-selectednode');
  await disp.hover();
  await disp.locator('.lm-field').click({ button: 'right' });
  await expect(page.locator('.ctx-menu .ctx-item', { hasText: 'Numbered' })).toHaveCount(1);
  await page.keyboard.press('Escape');
});

test('child documents open in tabs; the combined view shows master and children together', async ({ page }) => {
  await openPaper(page);
  await page.locator('.lyx-include-link').first().dblclick();
  await expect(page).toHaveURL(/lyxmacros\.tex$/);
  await expect(page.locator('.tab')).toHaveCount(2);
  await expect(page.locator('.tab.active')).toHaveText(/lyxmacros\.tex/);
  // close the tab → back to the master
  await page.locator('.tab.active .tab-close').click();
  await expect(page).toHaveURL(/main\.tex$/);
  await expect(page.locator('.tab')).toHaveCount(1);
  // combined view
  await page.evaluate(() => localStorage.setItem('ol.combined', '1'));
  await page.reload();
  await page.waitForFunction(() => document.querySelectorAll('.child-doc .lyx-editor .lyx-par').length > 20, null, { timeout: 90000 });
  await expect(page.locator('.doc-title')).toHaveText(/main\.tex \+ lyxmacros\.tex \+ appendix\.tex/);
  await expect(page.locator('.child-doc-header .name')).toHaveCount(3);
  // editing inside the child updates the status bar's document label and the source pane target
  const childPar = page.locator('.child-doc').nth(1).locator('.lyx-editor > .lyx-par.lyx-layout-standard').first();
  await childPar.click({ position: { x: 4, y: 8 } });
  await expect(page.locator('.statusbar .doclabel')).toHaveText('appendix.tex');
  await page.evaluate(() => localStorage.setItem('ol.combined', '0'));
});

test('the source pane follows the cursor and applies edits back to the document', async ({ page }) => {
  await openPaper(page);
  await page.locator('.panel-tabs button', { hasText: 'Source' }).click();
  const ta = page.locator('.source-pane textarea');
  await expect(ta).toHaveValue(/\\documentclass/, { timeout: 15000 });
  await expect(ta).toHaveValue(/\\section\{/);
  // edit the source: add a paragraph at the start of the body and apply
  await ta.evaluate((el: HTMLTextAreaElement) => {
    const v = el.value; const i = v.indexOf('\\begin{document}\n') + '\\begin{document}\n'.length;
    const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!;
    setter.call(el, v.slice(0, i) + 'SOURCEEDIT paragraph.\n\n' + v.slice(i));
    el.dispatchEvent(new Event('input', { bubbles: true }));
  });
  await page.locator('.source-pane button', { hasText: 'Apply' }).click();
  await expect(page.locator('.lyx-editor')).toContainText('SOURCEEDIT', { timeout: 15000 });
  await expect.poll(() => readFileSync(`${DIR}/main.tex`, 'utf8').includes('SOURCEEDIT'), { timeout: 15000 }).toBe(true);
});

test('status bar names the change author and shows the change under the cursor', async ({ page }) => {
  await openPaper(page);
  await page.locator('.lyx-editor > .lyx-par.lyx-layout-standard').first().click({ position: { x: 4, y: 8 } });
  await page.keyboard.press('Control+Shift+e');            // turn change tracking on (LyX binding)
  await expect(page.locator('.statusbar .tracking')).toHaveText(/tracking changes as Admin/);
  // a visible tracked insertion with real text (many are inside collapsed notes or are whitespace-only)
  const box = await page.evaluate(() => {
    for (const el of document.querySelectorAll<HTMLElement>('.lyx-editor .lyx-change-inserted')) {
      if (!/[A-Za-z]{3}/.test(el.textContent ?? '') || el.closest('.lyx-inset.collapsed')) continue;
      el.scrollIntoView({ block: 'center' });
      const r = el.getBoundingClientRect();
      if (r.width > 10 && r.height > 5) return { x: r.left + Math.min(8, r.width / 2), y: r.top + r.height / 2 };
    }
    return null;
  });
  expect(box).not.toBeNull();
  await page.mouse.click(box!.x, box!.y);
  await expect(page.locator('.statusbar .change-info')).toHaveText(/Inserted by .* on /);
  await page.mouse.click(box!.x, box!.y, { button: 'right' });
  await expect(page.locator('.ctx-menu .ctx-item', { hasText: 'Accept change' })).toHaveCount(1);
  await page.keyboard.press('Escape');
});

test('Ctrl+Alt+← / → go back and forward through jumps, also across tabs', async ({ page }) => {
  await openPaper(page);
  const ref = page.locator('.lyx-command-ref', { hasText: 'eq:weight-model-RNN' }).first();
  await ref.scrollIntoViewIfNeeded();
  // a cursor next to the reference, then follow it
  await ref.click();
  const cursorPos = () => page.evaluate(() => (window as any).overlyx.activeView.state.selection.$head.pos as number);
  const p0 = await cursorPos();
  await ref.click({ modifiers: ['Control'] });
  await expect(page.locator('.lyx-math-display.ProseMirror-selectednode')).toHaveCount(1);
  const p1 = await cursorPos();
  expect(Math.abs(p1 - p0)).toBeGreaterThan(50);
  // back: where the reference was; forward: the formula again
  await page.keyboard.press('Control+Alt+ArrowLeft');
  await expect.poll(cursorPos).toBe(p0);
  await page.keyboard.press('Control+Alt+ArrowRight');
  await expect.poll(cursorPos).toBe(p1);
  // the outline is a jump too
  const rail = page.locator('.rail.right [data-rail="outline"]');
  if (await rail.count()) await rail.click(); else await page.locator('.panel-tabs [data-tab="outline"]').click();
  await page.locator('.outline-item').nth(3).click();
  const p2 = await cursorPos();
  expect(p2).not.toBe(p1);
  await page.keyboard.press('Control+Alt+ArrowLeft');
  await expect.poll(cursorPos).toBe(p1);
  // another document: back returns to the master at the same place, forward to the child again
  await page.locator('.lyx-include-link').first().dblclick();
  await expect(page).toHaveURL(/lyxmacros\.tex$/);
  await page.waitForFunction(() => document.querySelectorAll('.lyx-editor .lyx-par').length > 5, null, { timeout: 60000 });
  await page.keyboard.press('Control+Alt+ArrowLeft');
  await expect(page).toHaveURL(/main\.tex$/);
  await page.waitForFunction(() => document.querySelectorAll('.lyx-editor .lyx-par').length > 50, null, { timeout: 60000 });
  // the click on the include link was a jump of its own: first back to it, then to the formula
  await expect.poll(cursorPos, { timeout: 15000 }).not.toBe(p1);
  const pInclude = await cursorPos();
  await page.keyboard.press('Control+Alt+ArrowLeft');
  await expect.poll(cursorPos).toBe(p1);
  await page.keyboard.press('Control+Alt+ArrowRight');
  await expect.poll(cursorPos).toBe(pInclude);
  await page.keyboard.press('Control+Alt+ArrowRight');
  await expect(page).toHaveURL(/lyxmacros\.tex$/);
  // the Navigate menu shows the commands
  await page.locator('.menubar .menu > button', { hasText: 'Navigate' }).first().click();
  await expect(page.locator('.menu-item', { hasText: 'Back' })).toBeVisible();
  await page.keyboard.press('Escape');
});
