/**
 * The "[raw]" tab: a right-click on a .tex tab opens the document beside its LaTeX source
 * (app/SourcePane.tsx layout="right") in a tab of its own — the same editor instance, the source
 * pane on the right. The two scroll together (top paragraph ↔ its source line); edits in the
 * source are applied to the document as one types (held while the LaTeX is unbalanced); the
 * menubar names the project, not the file.
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
});
test.afterAll(() => rmSync(DIR, { recursive: true, force: true }));
test.beforeEach(async ({ page }) => { await login(page); await page.request.get('/api/projects'); });

const openDoc = async (page: import('@playwright/test').Page) => {
  await page.goto('/#/' + ID);
  await page.waitForFunction(() => document.querySelectorAll('.lyx-editor .lyx-par').length > 0, null, { timeout: 30000 });
  await page.waitForTimeout(500);
};

test('right-click on the tab opens the [raw] split tab with the same editor; the menubar names the project', async ({ page }) => {
  const errors = collectErrors(page);
  await openDoc(page);
  await expect(page.locator('.doc-title')).toHaveText(PROJECT);
  await page.evaluate(() => { (window as any).__ed = document.querySelector('.lyx-editor'); });
  await page.locator('.tabbar .tab', { hasText: 'long.tex' }).click({ button: 'right' });
  await expect(page.locator('.tab-menu')).toBeVisible();
  await page.locator('.tab-menu .menu-item', { hasText: 'Open LaTeX source beside' }).click();
  await expect(page).toHaveURL(new RegExp(`#/raw:${PROJECT}/long\\.tex$`));
  await expect(page.locator('.tabbar .tab.active')).toContainText('long.tex [raw]');
  await expect(page.locator('.tabbar .tab')).toHaveCount(2);
  await expect(page.locator('.editor-column.split .source-pane.right textarea.source')).toHaveValue(/\\section\{Methods\}/, { timeout: 15000 });
  expect(await page.evaluate(() => (window as any).__ed === document.querySelector('.lyx-editor'))).toBe(true);   // the document was not reloaded
  await expect(page.locator('.source-pane .small-btn', { hasText: 'Apply' })).toHaveCount(0);   // edits apply by themselves
  // back to the plain tab: no split; the raw tab's context menu can close it
  await page.locator('.tabbar .tab', { hasText: /^long\.tex\s*×$/ }).click();
  await expect(page.locator('.editor-column.split')).toHaveCount(0);
  await page.locator('.tabbar .tab', { hasText: 'long.tex [raw]' }).click({ button: 'right' });
  await page.locator('.tab-menu .menu-item', { hasText: 'Close tab' }).click();
  await expect(page.locator('.tabbar .tab')).toHaveCount(1);
  expect(errors.filter(e => !/favicon|ResizeObserver/.test(e))).toEqual([]);
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
  await page.keyboard.type('}');
  await expect(page.locator('.source-pane [data-apply-state="ok"]')).toBeVisible({ timeout: 10000 });
  // the other direction still works: typing in the document regenerates the source once the pane loses the focus
  await page.locator('.lyx-editor > .lyx-par', { hasText: 'The results are reported' }).click();
  await page.keyboard.press('End');
  await page.keyboard.type(' Really.');
  await expect(ta).toHaveValue(/reported at the end\. Really\./, { timeout: 15000 });
  expect(errors.filter(e => !/favicon|ResizeObserver/.test(e))).toEqual([]);
});
