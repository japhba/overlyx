/**
 * The raw view (View ▸ LaTeX source beside the document, hash "raw:<doc>"): the document beside
 * its LaTeX source (app/SourcePane.tsx layout="right") — the same editor instance, the source
 * pane on the right. The two scroll together (top paragraph ↔ its source line) and the cursor is
 * mirrored both ways (caret in the source ↔ cursor in the document); edits in the source are
 * applied to the document as one types (held while the LaTeX is unbalanced); the menubar names
 * the project, not the file.
 */
import { test, expect } from '@playwright/test';
import { mkdirSync, rmSync, writeFileSync, readFileSync } from 'node:fs';
import { login, collectErrors, PROJECTS_DIR, texDoc } from './helpers';

const PROJECT = 'e2e-rawsplit';
const DIR = `${PROJECTS_DIR}/${PROJECT}`;
const ID = `${PROJECT}/long.tex`;

test.beforeAll(() => {
  rmSync(DIR, { recursive: true, force: true });
  mkdirSync(DIR, { recursive: true });
  const paras: string[] = ['\\section{Introduction}'];
  for (let i = 1; i <= 30; i++) paras.push(`Paragraph ${i} of the introduction, with enough words that the document scrolls: the quick brown fox number ${i} jumps over the lazy dog again and again.`, '');
  paras.push('\\section{Methods}', '', 'The methods section starts here and describes the apparatus in detail.', '');
  for (let i = 1; i <= 30; i++) paras.push(`Paragraph ${i} of the methods, more words about the procedure number ${i} and its careful calibration.`, '');
  paras.push('\\section{Results}', '', 'The results are reported at the end.');
  writeFileSync(`${DIR}/long.tex`, texDoc(paras.join('\n')));
  // a master with a child document: the child's source has no \begin{document} (a fragment)
  writeFileSync(`${DIR}/master.tex`, texDoc('\\section{Master}\n\nThe master text.\n\n\\include{child}'));
  writeFileSync(`${DIR}/child.tex`, '\\section{Child section}\n\nChild paragraph one with its words.\n\nChild paragraph two with other words.\n');
});
test.afterAll(() => rmSync(DIR, { recursive: true, force: true }));
test.beforeEach(async ({ page }) => { await login(page); await page.request.get('/api/projects'); });

const openDoc = async (page: import('@playwright/test').Page) => {
  await page.goto('/#/' + ID);
  await page.waitForFunction(() => document.querySelectorAll('.lyx-editor .lyx-par').length > 0, null, { timeout: 30000 });
  await page.waitForTimeout(500);
};

test('View ▸ LaTeX source beside the document opens the raw view with the same editor; the menubar names the project', async ({ page }) => {
  const errors = collectErrors(page);
  await openDoc(page);
  await expect(page.locator('.doc-title')).toHaveText(PROJECT);
  await page.evaluate(() => { (window as any).__ed = document.querySelector('.lyx-editor'); });
  const viewItem = async () => { await page.locator('.menubar .menu button', { hasText: 'View' }).click(); await page.locator('.menu-item', { hasText: 'LaTeX source beside' }).click(); };
  await viewItem();
  await expect(page).toHaveURL(new RegExp(`#/raw:${PROJECT}/long\\.tex$`));
  await expect(page.locator('.docpanel .doc-tab.active .fname')).toHaveText('long.tex');   // the document tab stays the active one
  await expect(page.locator('.editor-column.split .source-pane.right textarea.source')).toHaveValue(/\\section\{Methods\}/, { timeout: 15000 });
  expect(await page.evaluate(() => (window as any).__ed === document.querySelector('.lyx-editor'))).toBe(true);   // the document was not reloaded
  await expect(page.locator('.source-pane .small-btn', { hasText: 'Apply' })).toHaveCount(0);   // edits apply by themselves
  // the same item switches back to the plain view; so does the pane's ✕
  await viewItem();
  await expect(page).toHaveURL(new RegExp(`#/${PROJECT}/long\\.tex$`));
  await expect(page.locator('.editor-column.split')).toHaveCount(0);
  await viewItem();
  await page.locator('.source-pane .bar .close').click();
  await expect(page.locator('.editor-column.split')).toHaveCount(0);
  expect(errors.filter(e => !/favicon|ResizeObserver/.test(e))).toEqual([]);
});

test('the caret in the source and the cursor in the document follow each other', async ({ page }) => {
  await openDoc(page);
  await page.goto('/#/raw:' + ID);
  const ta = page.locator('.source-pane.right textarea.source');
  await expect(ta).toHaveValue(/\\section\{Methods\}/, { timeout: 15000 });
  await page.waitForTimeout(500);
  // document → source: the cursor before the "7" of paragraph 7 of the methods marks that character in the source
  const par = page.locator('.lyx-editor > .lyx-par', { hasText: 'Paragraph 7 of the methods' });
  await par.scrollIntoViewIfNeeded();
  await par.click({ position: { x: 4, y: 8 } });
  await page.keyboard.press('Home');
  for (let i = 0; i < 'Paragraph '.length; i++) await page.keyboard.press('ArrowRight');
  const caret = () => page.evaluate(() => {
    const c = document.querySelector('.source-pane pre.hl .hl-caret, .source-pane pre.hl .hl-caret-after') as HTMLElement | null;
    if (!c) return null;
    const line = c.closest('.l') as HTMLElement;
    const r = document.createRange(); r.setStart(line, 0); r.setEnd(c, 0);
    const col = r.toString().length + (c.classList.contains('hl-caret-after') ? (c.textContent ?? '').length : 0);
    return { line: line.textContent ?? '', col, sel: (document.querySelector('.source-pane textarea.source') as HTMLTextAreaElement).selectionStart };
  });
  // the caret mark settles a moment after the arrow keys (the doc → source sync is debounced): poll on the column, not just the line
  await expect.poll(async () => { const c = await caret(); return c ? c.line.slice(c.col) : ''; }, { timeout: 10000 }).toMatch(/^7 of the methods/);
  const c1 = (await caret())!;
  expect(await ta.evaluate((el: HTMLTextAreaElement, s: number) => el.value.slice(s, s + 16), c1.sel)).toBe('7 of the methods');   // the textarea's caret went there too
  // source → document: a click in the source puts the document cursor at that word; the blurred editor shows it as a mirror caret
  await page.evaluate(() => { const ta = document.querySelector('.source-pane textarea.source') as HTMLTextAreaElement; const i = ta.value.indexOf('procedure number 3'); ta.focus(); ta.setSelectionRange(i, i); ta.dispatchEvent(new Event('click', { bubbles: true })); });
  await expect.poll(() => page.evaluate(() => { const v = (window as any).overlyx.activeView; const $f = v.state.selection.$from; return $f.parent.textContent.slice($f.parentOffset, $f.parentOffset + 18); }), { timeout: 5000 }).toBe('procedure number 3');
  await expect(page.locator('.lyx-editor .mirror-caret')).toHaveCount(1);
  expect(await ta.evaluate(el => document.activeElement === el)).toBe(true);   // the keyboard stayed in the source
  // the marked line follows the source caret at once (no echo from the document)
  const c2 = (await caret())!;
  expect(c2.line).toContain('Paragraph 3 of the methods');
  expect(c2.line.slice(c2.col)).toMatch(/^procedure number 3/);
});

test('the document and its source scroll together, both ways', async ({ page }) => {
  await openDoc(page);
  await page.goto('/#/raw:' + ID);
  const ta = page.locator('.source-pane.right textarea.source');
  await expect(ta).toHaveValue(/\\section\{Methods\}/, { timeout: 15000 });
  await page.waitForTimeout(500);
  // document → source: scroll the document to the Methods heading
  await page.locator('.lyx-editor > .lyx-par.lyx-layout-section', { hasText: 'Methods' }).evaluate(el => { const sc = el.closest('.editor-scroll')!; sc.scrollTop += el.getBoundingClientRect().top - sc.getBoundingClientRect().top - 4; });
  const topSourceLine = () => page.evaluate(() => { const ta = document.querySelector('.source-pane textarea.source') as HTMLTextAreaElement; const lines = Array.from(document.querySelectorAll('.source-pane pre.hl .l')) as HTMLElement[]; const i = lines.findIndex(l => l.offsetTop + l.offsetHeight > ta.scrollTop + 1); return lines.slice(i, i + 3).map(l => l.textContent ?? '').join('|'); });
  await expect.poll(topSourceLine, { timeout: 5000 }).toMatch(/\\section\{Methods\}/);
  // source → document: scroll the source to the 10th paragraph of the methods (a place both panes can put at their top;
  // a scroll within ~350 ms of a synchronized one counts as the sync's own, so let that window pass first)
  await page.waitForTimeout(600);
  await page.evaluate(() => { const ta = document.querySelector('.source-pane textarea.source') as HTMLTextAreaElement; const lines = Array.from(document.querySelectorAll('.source-pane pre.hl .l')) as HTMLElement[]; const i = lines.findIndex(l => (l.textContent ?? '').startsWith('Paragraph 10 of the methods')); ta.scrollTop = lines[i].offsetTop - 6; });
  const topParagraph = () => page.evaluate(() => { const sc = document.querySelector('.editor-scroll')!; const top = sc.getBoundingClientRect().top + 4; const pars = Array.from(document.querySelectorAll('.lyx-editor > .lyx-par')); return pars.find(e => e.getBoundingClientRect().bottom > top)?.textContent ?? ''; });
  await expect.poll(topParagraph, { timeout: 5000 }).toMatch(/^Paragraph (9|10|11) of the methods/);
});

test('edits in the source are applied to the document as one types; unbalanced LaTeX is held back', async ({ page }) => {
  const errors = collectErrors(page);
  await openDoc(page);
  await page.goto('/#/raw:' + ID);
  const ta = page.locator('.source-pane.right textarea.source');
  await expect(ta).toHaveValue(/\\section\{Methods\}/, { timeout: 15000 });
  await page.waitForTimeout(500);
  await ta.click();
  await page.evaluate(() => { const ta = document.querySelector('.source-pane textarea.source') as HTMLTextAreaElement; const i = ta.value.indexOf('\\section{Methods') + '\\section{Methods'.length; ta.focus(); ta.setSelectionRange(i, i); });
  await page.keyboard.type(' and materials');
  await expect(page.locator('.lyx-editor .lyx-layout-section', { hasText: 'Methods and materials' })).toHaveCount(1, { timeout: 15000 });
  await expect(page.locator('.source-pane [data-apply-state="ok"]')).toBeVisible({ timeout: 10000 });
  await expect.poll(() => readFileSync(`${DIR}/long.tex`, 'utf8').includes('\\section{Methods and materials}'), { timeout: 15000 }).toBe(true);
  // delete the heading's closing brace: the source is unbalanced, the edit is held until it is fixed
  await page.keyboard.press('Delete');
  await expect(page.locator('.source-pane [data-apply-state="held"]')).toBeVisible({ timeout: 10000 });
  await expect(page.locator('.source-pane [data-apply-state="held"]')).toContainText(/not applied/);
  // the foot of the pane names the problem in full and "go to line" puts the caret at the unclosed brace
  await expect(page.locator('.source-pane .hint.problem')).toContainText(/Unbalanced braces \(1 unclosed\)/);
  const braceLine = await ta.evaluate(el => el.value.slice(0, el.value.indexOf('\\section{Methods')).split('\n').length);
  await expect(page.locator('.source-pane .hint.problem .goto')).toHaveText(`go to line ${braceLine}`);
  await page.locator('.source-pane .hint.problem .goto').click();
  expect(await ta.evaluate(el => el.value.slice(el.selectionStart, el.selectionStart + 9))).toBe('{Methods ');
  await page.keyboard.press('End');
  await page.keyboard.type('}');
  await expect(page.locator('.source-pane [data-apply-state="ok"]')).toBeVisible({ timeout: 10000 });
  // the other direction still works: typing in the document regenerates the source once the pane loses the focus
  await page.locator('.lyx-editor > .lyx-par', { hasText: 'The results are reported' }).click();
  await page.keyboard.press('End');
  await page.keyboard.type(' Really.');
  await expect(ta).toHaveValue(/reported at the end\. Really\./, { timeout: 15000 });
  expect(errors.filter(e => !/favicon|ResizeObserver/.test(e))).toEqual([]);
});

test('a selection in the document is mirrored into the source, and one in the source into the document', async ({ page }) => {
  const errors = collectErrors(page);
  await openDoc(page);
  await page.goto('/#/raw:' + ID);
  const ta = page.locator('.source-pane.right textarea.source');
  await expect(ta).toHaveValue(/\\section\{Methods/, { timeout: 15000 });   // (an earlier test may have renamed the heading)
  await page.waitForTimeout(500);
  // document → source: select "Paragraph 5" at the start of paragraph 5 of the methods
  const par = page.locator('.lyx-editor > .lyx-par', { hasText: 'Paragraph 5 of the methods' });
  await par.scrollIntoViewIfNeeded();
  await par.click({ position: { x: 4, y: 8 } });
  await page.keyboard.press('Home');
  for (let i = 0; i < 'Paragraph 5'.length; i++) await page.keyboard.press('Shift+ArrowRight');
  await expect.poll(() => ta.evaluate(el => el.value.slice(el.selectionStart, el.selectionEnd)), { timeout: 10000 }).toBe('Paragraph 5');
  await expect(page.locator('.source-pane pre.selhl .selrange')).toHaveText('Paragraph 5');
  // source → document: a selection in the source selects those words in the document, tinted while the editor has no focus
  await page.evaluate(() => { const ta = document.querySelector('.source-pane textarea.source') as HTMLTextAreaElement; const i = ta.value.indexOf('procedure number 3'); ta.focus(); ta.setSelectionRange(i, i + 'procedure number 3'.length); ta.dispatchEvent(new Event('select', { bubbles: true })); });
  await expect.poll(() => page.evaluate(() => { const v = (window as any).overlyx.activeView; const s = v.state.selection; return v.state.doc.textBetween(s.from, s.to); }), { timeout: 5000 }).toBe('procedure number 3');
  await expect(page.locator('.lyx-editor .mirror-selection')).toHaveText('procedure number 3');
  await expect(page.locator('.source-pane pre.selhl')).toHaveCount(0);   // the textarea paints its own selection while it has the focus
  expect(errors.filter(e => !/favicon|ResizeObserver/.test(e))).toEqual([]);
});

test('the source of a child document (no \\begin{document}) is applied live as well', async ({ page }) => {
  const errors = collectErrors(page);
  await page.goto('/#/' + PROJECT + '/child.tex');
  await page.waitForFunction(() => document.querySelectorAll('.lyx-editor .lyx-par').length > 0, null, { timeout: 30000 });
  await page.goto('/#/raw:' + PROJECT + '/child.tex');
  const ta = page.locator('.source-pane.right textarea.source');
  await expect(ta).toHaveValue(/Child paragraph one/, { timeout: 15000 });
  expect(await ta.evaluate(el => el.value.includes('\\begin{document}'))).toBe(false);
  await page.waitForTimeout(500);
  await ta.click();
  await page.evaluate(() => { const ta = document.querySelector('.source-pane textarea.source') as HTMLTextAreaElement; const i = ta.value.indexOf('Child section') + 'Child section'.length; ta.focus(); ta.setSelectionRange(i, i); });
  await page.keyboard.type(' two');
  await expect(page.locator('.lyx-editor .lyx-layout-section', { hasText: 'Child section two' })).toHaveCount(1, { timeout: 15000 });
  await expect(page.locator('.source-pane [data-apply-state="ok"]')).toBeVisible({ timeout: 10000 });
  await expect.poll(() => readFileSync(`${DIR}/child.tex`, 'utf8').includes('\\section{Child section two}'), { timeout: 15000 }).toBe(true);
  expect(errors.filter(e => !/favicon|ResizeObserver/.test(e))).toEqual([]);
});

test('the caret of the source survives a regeneration: it stays with the document cursor', async ({ page }) => {
  await openDoc(page);
  await page.goto('/#/raw:' + ID);
  const ta = page.locator('.source-pane.right textarea.source');
  await expect(ta).toHaveValue(/\\section\{Methods/, { timeout: 15000 });   // (an earlier test may have renamed the heading)
  await page.waitForTimeout(500);
  // type in the document: the source regenerates (the pane has no focus) with the caret at the document cursor
  const par = page.locator('.lyx-editor > .lyx-par', { hasText: 'The results are reported' });
  await par.click({ position: { x: 4, y: 8 } });
  await page.keyboard.press('End');   // (a one-line paragraph even in the narrower split view: End is the paragraph's end)
  await page.keyboard.type(' Again.');
  await expect(ta).toHaveValue(/reported at the end\.( Really\.)? Again\./, { timeout: 15000 });
  await expect.poll(() => ta.evaluate(el => el.value.slice(el.selectionStart - 7, el.selectionStart)), { timeout: 10000 }).toBe(' Again.');
  await expect(ta).toHaveValue(/^\\documentclass/);   // regenerated, not just patched locally
});
