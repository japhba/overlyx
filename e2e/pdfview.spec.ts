/**
 * The PDF viewer (pdf.js) and SyncTeX: a small multi-page document is built; the PDF panel shows its
 * pages; forward search (Ctrl+Alt+J) from a paragraph on the last page scrolls the viewer there
 * and flashes the box; a double-click on the first page's abstract puts the cursor into that
 * paragraph (inverse search); a PDF file of the project opens in a tab of its own with the viewer;
 * a pinch (Ctrl + wheel) zooms about the pointer, and a huge page (A0) stays sharp where it is in view.
 */
import { test, expect } from '@playwright/test';
import { mkdirSync, rmSync, writeFileSync, copyFileSync, existsSync } from 'node:fs';
import { login, collectErrors, PROJECTS_DIR, FIXTURES_DIR, texDoc } from './helpers';

const PROJECT = 'admin/e2e-pdfview';
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
  writeFileSync(`${DIR}/poster.pdf`, a0Pdf());
});

/** A one-page A0 PDF (a line of text and a diagonal), written by hand */
function a0Pdf(): Buffer {
  const content = 'BT /F1 60 Tf 150 3150 Td (An A0 poster) Tj ET 0 0 1 RG 12 w 100 100 m 2284 3270 l S';
  const objs = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 2384 3370] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>',
    `<< /Length ${content.length} >>\nstream\n${content}\nendstream`,
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
  ];
  let out = '%PDF-1.4\n';
  const offsets: number[] = [];
  objs.forEach((o, i) => { offsets.push(out.length); out += `${i + 1} 0 obj\n${o}\nendobj\n`; });
  const xref = out.length;
  out += `xref\n0 ${objs.length + 1}\n0000000000 65535 f \n` + offsets.map(o => `${String(o).padStart(10, '0')} 00000 n \n`).join('')
    + `trailer\n<< /Size ${objs.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return Buffer.from(out, 'latin1');
}
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
  await expect(page).toHaveURL(/#\/pdf:admin\/e2e-pdfview\/paper\.pdf$/);
  await expect(page.locator('.pdf-tab .pdf-page-box')).toHaveCount(9, { timeout: 30000 });
  await expect(page.locator('.filetree .tree-row.current')).toContainText('paper.pdf');   // the file is marked in the documents panel
  await expect(page.locator('.pdf-tab .pdf-toolbar a', { hasText: 'Download' })).toHaveAttribute('href', /paper\.pdf\?download=1$/);
  // zoom and page navigation
  await page.locator('.pdf-toolbar .small-btn[title="Zoom in"]').click();
  await expect(page.locator('.pdf-toolbar .small-btn[title="Fit the page width"]')).not.toContainText('Fit width');
  await page.locator('.pdf-toolbar .small-btn[title="Next page"]').click();
  await expect(page.locator('.pdf-toolbar .pdf-page')).toHaveValue('2');
  // back to the document tab: the editor is still there
  await page.locator('.docpanel .doc-tab[data-doc="two.tex"] .doc-name').click();
  await expect(page.locator('.lyx-editor .lyx-par').first()).toBeVisible({ timeout: 15000 });
});

test('a pinch (Ctrl + wheel) zooms the viewer about the pointer; an A0 page stays sharp where it is in view', async ({ page }) => {
  const errors = collectErrors(page);
  await page.request.get('/api/projects');
  await page.goto('/#/' + ID);
  await page.waitForFunction(() => document.querySelectorAll('.lyx-editor .lyx-par').length > 0, null, { timeout: 30000 });
  await page.locator('.tree-row.file', { hasText: 'poster.pdf' }).click();
  const pageBox = page.locator('.pdf-tab .pdf-page-box');
  await expect(pageBox).toHaveCount(1, { timeout: 30000 });
  await expect(page.locator('.pdf-tab .pdf-page-box canvas.ready').first()).toBeAttached({ timeout: 15000 });
  const b0 = (await pageBox.boundingBox())!;
  const x = b0.x + b0.width * 0.3, y = b0.y + 200;
  const fx = (x - b0.x) / b0.width, fy = (y - b0.y) / b0.height;
  await page.mouse.move(x, y);
  // a trackpad pinch arrives as Ctrl + wheel: it zooms this viewer, not the whole page
  await page.keyboard.down('Control');
  for (let i = 0; i < 9; i++) { await page.mouse.wheel(0, -100); await page.waitForTimeout(40); }
  await page.keyboard.up('Control');
  await expect(page.locator('.pdf-tab .pdf-toolbar .small-btn[title="Fit the page width"]')).toHaveText(/^\d+%$/);
  const b1 = (await pageBox.boundingBox())!;
  expect(b1.width / b0.width).toBeGreaterThan(6);
  // the spot that was under the pointer still is
  expect(Math.abs((x - b1.x) / b1.width - fx)).toBeLessThan(0.01);
  expect(Math.abs((y - b1.y) / b1.height - fy)).toBeLessThan(0.01);
  expect(await page.evaluate(() => (window.visualViewport?.scale ?? 1))).toBe(1);
  // the page's own canvas is kept within the browser's limits (drawn coarser); a sharp detail canvas covers the part in view
  await expect(page.locator('.pdf-tab canvas.pdf-detail.ready')).toBeVisible({ timeout: 15000 });
  const sizes = await page.locator('.pdf-tab .pdf-page-box canvas').evaluateAll(cs => cs.map(c => ({ detail: c.classList.contains('pdf-detail'), px: (c as HTMLCanvasElement).width * (c as HTMLCanvasElement).height, w: (c as HTMLCanvasElement).width })));
  expect(sizes.find(s => !s.detail)!.px).toBeLessThanOrEqual(2 ** 25);
  const detail = await page.locator('.pdf-tab canvas.pdf-detail').boundingBox();
  const view = (await page.locator('.pdf-tab .pdf-pages').boundingBox())!;
  expect(detail!.x).toBeLessThanOrEqual(view.x + 1);
  expect(detail!.y).toBeLessThanOrEqual(view.y + 1);
  expect(detail!.x + detail!.width).toBeGreaterThanOrEqual(view.x + view.width - 20);   // (less the scroll bar)
  // back to the whole width
  await page.locator('.pdf-tab .pdf-toolbar .small-btn[title="Fit the page width"]').click();
  await expect(page.locator('.pdf-tab .pdf-toolbar .small-btn[title="Fit the page width"]')).toHaveText('Fit width');
  expect(errors.filter(e => !/favicon|ResizeObserver/.test(e))).toEqual([]);
});

test('an older engine (Safari 17, Firefox 130, Chrome 121) starts the app and shows a PDF: pdf.js polyfills what it needs', async ({ page }) => {
  // the APIs pdf.js's default build needs (Safari 26.2 / Firefox 144 / Chrome 147), taken away from a
  // page of the signed-in context and from its pdf.js worker — without the global Iterator the app did
  // not even start
  const OLD = 'delete globalThis.Iterator; for (const M of [Map, WeakMap]) { delete M.prototype.getOrInsertComputed; delete M.prototype.getOrInsert; } delete Math.sumPrecise; delete Promise.try; delete Uint8Array.prototype.toBase64; delete Uint8Array.fromBase64;';
  const old = await page.context().newPage();
  await old.addInitScript(OLD + ' globalThis.__olderEngine = typeof Iterator === "undefined" && !Map.prototype.getOrInsertComputed && !Math.sumPrecise;');
  await old.route(/pdf\.worker[^/]*\.m?js(\?.*)?$/, async route => {
    const res = await route.fetch();
    await route.fulfill({ response: res, body: OLD + '\n' + await res.text() });
  });
  const errors = collectErrors(old);
  await old.request.get('/api/projects');
  await old.goto('/#/' + ID);
  await old.waitForFunction(() => document.querySelectorAll('.lyx-editor .lyx-par').length > 0, null, { timeout: 30000 });
  expect(await old.evaluate(() => (globalThis as any).__olderEngine)).toBe(true);   // (pdf.js's polyfills have put them back since)
  await old.locator('.tree-row.file', { hasText: 'poster.pdf' }).click();
  await expect(old.locator('.pdf-tab .pdf-page-box canvas.ready').first()).toBeAttached({ timeout: 30000 });
  expect(errors.filter(e => !/favicon|ResizeObserver|\[vite\] failed to connect/.test(e))).toEqual([]);   // (the dev server's own reload socket, once in Chromium)
  await old.close();
});
