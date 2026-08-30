/**
 * The PDF viewer (pdf.js) and SyncTeX: a small multi-page document is built; the PDF panel shows its
 * pages; forward search (Ctrl+Alt+J) from a paragraph on the last page scrolls the viewer there
 * and flashes the box; a double-click on the first page's abstract puts the cursor into that
 * paragraph (inverse search); a PDF file of the project opens in a tab of its own with the viewer.
 */
import { test, expect } from '@playwright/test';
import { mkdirSync, rmSync, writeFileSync, copyFileSync, existsSync } from 'node:fs';
import { login, collectErrors, PROJECTS_DIR, FIXTURES_DIR, texDoc } from './helpers';

const PROJECT = 'e2e-pdfview';
const DIR = `${PROJECTS_DIR}/${PROJECT}`;
const ID = `${PROJECT}/two.tex`;

test.beforeAll(() => {
  rmSync(DIR, { recursive: true, force: true });
  mkdirSync(DIR, { recursive: true });
  const paras: string[] = ['\\section{First}'];
  for (let i = 1; i <= 40; i++) paras.push(`Paragraph number ${i} of the first section talks about topic ${i} at some length so that the pages fill up with text and the second section starts on the second page.`, '');
  paras.push('\\section{Second}', 'The second section begins here with a sentence that is easy to find: the marmot sleeps under the larch tree.', '', 'A closing paragraph of the second section.');
  writeFileSync(`${DIR}/two.tex`, texDoc(paras.join('\n')));
  const fixture = `${FIXTURES_DIR}/example-gan/arxiv-1406.2661.pdf`;
  if (existsSync(fixture)) copyFileSync(fixture, `${DIR}/paper.pdf`);
});
test.afterAll(() => rmSync(DIR, { recursive: true, force: true }));
test.beforeEach(async ({ page }) => { await login(page); });

test('the built PDF is shown by the viewer; SyncTeX forward and inverse search', async ({ page }) => {
  test.setTimeout(300000);
  const errors = collectErrors(page);
  await page.request.get('/api/projects');
  await page.goto('/#/' + ID);
  await page.waitForFunction(() => document.querySelectorAll('.lyx-editor .lyx-par').length > 0, null, { timeout: 30000 });
  await page.locator('.tb-btn[title^="View PDF"]').click();
  await expect(page.locator('.pdf-panel .build-progress')).toBeVisible({ timeout: 15000 });
  await expect(page.locator('.pdf-panel .build-progress')).toHaveCount(0, { timeout: 240000 });
  await expect(page.locator('.pdf-panel .bar span')).toContainText('built');
  await expect(page.locator('.pdf-panel .pdf-viewer .pdf-page-box').nth(1)).toBeAttached({ timeout: 30000 });   // more than one page
  const pages = await page.locator('.pdf-panel .pdf-viewer .pdf-page-box').count();
  await expect(page.locator('.pdf-toolbar .pdf-count')).toContainText(`/ ${pages}`);

  // forward search from the second section's sentence (the last page): the viewer goes there and flashes the box
  await page.locator('.lyx-editor .lyx-par', { hasText: 'the marmot sleeps' }).click();
  await page.keyboard.press('Control+Alt+j');
  await expect(page.locator('.pdf-flash')).toHaveCount(1, { timeout: 15000 });
  expect(await page.locator('.pdf-flash').evaluate(e => e.parentElement?.getAttribute('data-page'))).toBe(String(pages));
  await expect(page.locator('.pdf-toolbar .pdf-page')).toHaveValue(String(pages));
  // the Sync button does the same
  await page.locator('.lyx-editor .lyx-par', { hasText: 'Paragraph number 3 of' }).click();
  await page.locator('[data-pdf-sync]').click();
  await expect.poll(async () => page.locator('.pdf-flash').evaluate(e => e.parentElement?.getAttribute('data-page')).catch(() => null), { timeout: 15000 }).toBe('1');

  // inverse search: a double-click near the top of page 1 lands in the first paragraphs
  await page.locator('.pdf-toolbar .pdf-page').fill('1');
  await page.keyboard.press('Enter');
  await page.waitForTimeout(600);
  const box = (await page.locator('.pdf-page-box[data-page="1"]').boundingBox())!;
  await page.mouse.dblclick(box.x + box.width * 0.5, box.y + box.height * 0.5);
  await expect.poll(() => page.evaluate(() => { const v = (window as any).overlyx?.activeView; return v ? v.state.selection.$from.parent.textContent.slice(0, 40) : ''; }), { timeout: 15000 }).toMatch(/^Paragraph number \d+ of the first section/);
  expect(errors.filter(e => !/favicon|ResizeObserver/.test(e))).toEqual([]);
});

test('a PDF file of the project opens in a tab with the viewer', async ({ page }) => {
  test.skip(!existsSync(`${DIR}/paper.pdf`), 'no PDF fixture (example-gan/arxiv-1406.2661.pdf)');
  await page.request.get('/api/projects');
  await page.goto('/#/' + ID);
  await page.waitForFunction(() => document.querySelectorAll('.lyx-editor .lyx-par').length > 0, null, { timeout: 30000 });
  await page.locator('.tree-row.file', { hasText: 'paper.pdf' }).click();
  await expect(page).toHaveURL(/#\/pdf:e2e-pdfview\/paper\.pdf$/);
  await expect(page.locator('.pdf-tab .pdf-page-box')).toHaveCount(9, { timeout: 30000 });
  await expect(page.locator('.tabbar .tab')).toHaveCount(2);
  await expect(page.locator('.tabbar .tab.active')).toContainText('paper.pdf');
  await expect(page.locator('.pdf-tab .pdf-toolbar a', { hasText: 'Download' })).toHaveAttribute('href', /paper\.pdf\?download=1$/);
  // zoom and page navigation
  await page.locator('.pdf-toolbar .small-btn[title="Zoom in"]').click();
  await expect(page.locator('.pdf-toolbar .small-btn[title="Fit the page width"]')).not.toContainText('Fit width');
  await page.locator('.pdf-toolbar .small-btn[title="Next page"]').click();
  await expect(page.locator('.pdf-toolbar .pdf-page')).toHaveValue('2');
  // back to the document tab: the editor is still there
  await page.locator('.tabbar .tab', { hasText: 'two.tex' }).click();
  await expect(page.locator('.lyx-editor .lyx-par').first()).toBeVisible({ timeout: 15000 });
});
