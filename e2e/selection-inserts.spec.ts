/**
 * Inserting with a selection, pasting blocks, captions, layout pages, live metadata, tracked tables
 * and narrow panes (pre-beta findings):
 *  - a comment on selected text keeps the text (the thread is anchored right after it);
 *  - Insert ▸ Float ▸ Figure and Insert ▸ Caption with a clicked image wrap the image in a figure;
 *  - HTML of several blocks pasted into a paragraph splits it into real paragraphs / list items —
 *    never a Note (`%% @note`, missing from the PDF);
 *  - Enter in a caption does not split it (the build would fail);
 *  - Insert ▸ Graphics on an empty layout page places an image object on that page — not in its
 *    speaker notes, not on a new page;
 *  - the first Suggesting by an author names them in the status bar; the TeX pane follows a
 *    settings change; a tracked table is drawn in the change colour; an edit inside an existing
 *    formula while suggesting says that it is not tracked;
 *  - on a tablet (margin ink) the text reflows into a narrow pane beside the PDF.
 * Needs the seeded admin.
 */
import { test, expect, type Page } from '@playwright/test';
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import zlib from 'node:zlib';
import { login, openDoc, texDoc, collectErrors, PROJECTS_DIR } from './helpers';

const PROJECT = 'admin/e2e-selinserts';
const DIR = `${PROJECTS_DIR}/${PROJECT}`;

/** a small grey PNG */
function png(w: number, h: number): Buffer {
  const crcTable = Array.from({ length: 256 }, (_, n) => { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; return c >>> 0; });
  const crc = (b: Buffer) => { let c = 0xffffffff; for (const x of b) c = crcTable[(c ^ x) & 0xff] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; };
  const chunk = (type: string, data: Buffer) => { const len = Buffer.alloc(4); len.writeUInt32BE(data.length); const td = Buffer.concat([Buffer.from(type), data]); const c = Buffer.alloc(4); c.writeUInt32BE(crc(td)); return Buffer.concat([len, td, c]); };
  const raw = Buffer.alloc((w * 3 + 1) * h, 0x80);
  for (let y = 0; y < h; y++) raw[y * (w * 3 + 1)] = 0;
  const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4); ihdr[8] = 8; ihdr[9] = 2;
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]);
}

test.describe.configure({ mode: 'serial' });

test.beforeAll(() => {
  rmSync(DIR, { recursive: true, force: true });
  mkdirSync(`${DIR}/figs`, { recursive: true });
  writeFileSync(`${DIR}/figs/plot.png`, png(120, 80));
  writeFileSync(`${DIR}/pic.png`, png(80, 60));
  writeFileSync(`${DIR}/comment.tex`, texDoc('We want to minimise a function by gradient descent.'));
  writeFileSync(`${DIR}/float.tex`, texDoc('Intro text.\n\n\\includegraphics[width=4cm]{figs/plot.png}\n\nAfter the figure.'));
  writeFileSync(`${DIR}/caption.tex`, texDoc('Intro text.\n\n\\includegraphics[width=4cm]{figs/plot.png}\n\nAfter the figure.'));
  writeFileSync(`${DIR}/paste.tex`, texDoc('Before after.'));
  writeFileSync(`${DIR}/capenter.tex`, texDoc('\\begin{table}\n\\caption{Maximum path lengths per layer}\n\\centering\n\\begin{tabular}{|c|c|}\n\\hline\na & b\\tabularnewline\n\\hline\n\\end{tabular}\n\\end{table}\n\nAfter.'));
  writeFileSync(`${DIR}/track.tex`, texDoc('Remove this word please.'));
  writeFileSync(`${DIR}/settings.tex`, texDoc('Some text.'));
  writeFileSync(`${DIR}/tables.tex`, texDoc('Text \\lyxadded{Carol}{Mon Oct  2 10:00:00 2026}{\\begin{tabular}{|c|c|}\n\\hline\na & b\\tabularnewline\n\\hline\n\\end{tabular}} and an old table \\begin{tabular}{|c|}\n\\hline\nz\\tabularnewline\n\\hline\n\\end{tabular} end.'));
  writeFileSync(`${DIR}/formula.tex`, texDoc('A formula $x$ here.'));
  const long: string[] = [];
  for (let i = 1; i <= 8; i++) long.push(`Paragraph ${i}: compares the error of the three methods on a quadratic objective with enough words to fill the column.`);
  writeFileSync(`${DIR}/narrow.tex`, texDoc(long.join('\n\n')));
});
test.afterAll(() => { rmSync(DIR, { recursive: true, force: true }); });

const file = (name: string) => readFileSync(`${DIR}/${name}`, 'utf8');
const saved = (page: Page) => expect(page.locator('.statusbar .save-state')).toHaveText(/All changes saved/, { timeout: 15000 });
const noise = (errors: string[]) => errors.filter(e => !/favicon|ResizeObserver|willReadFrequently|Failed to load resource/.test(e));

test('a comment on selected words keeps them: the thread is anchored after them', async ({ page }) => {
  const errors = collectErrors(page);
  await login(page);
  await openDoc(page, `${PROJECT}/comment.tex`);
  await page.locator('.lyx-editor .lyx-par').first().getByText('We want to minimise').click();
  // select "to" (characters 8–10 of the paragraph)
  // (the click left a text selection: its class makes the range)
  await page.evaluate(() => { const v = (window as any).overlyx.activeView; v.dispatch(v.state.tr.setSelection(v.state.selection.constructor.create(v.state.doc, 9, 11))); });
  await expect(page.locator('.statusbar')).toContainText('2 characters');
  await page.locator('[data-tb="comment"]').first().click();
  await page.keyboard.type('Should this be "needs to"?');
  await saved(page);
  await expect.poll(() => file('comment.tex'), { timeout: 15000 }).toContain('needs to');
  const tex = file('comment.tex');
  expect(tex).toMatch(/We want to ?%\n%% @comment\n%% Admin \(/);
  expect(tex).toContain('minimise a function by gradient descent.');
  expect(tex).not.toContain('lyxdeleted');
  expect(noise(errors)).toEqual([]);
});

test('Insert ▸ Float ▸ Figure and Insert ▸ Caption with a clicked image wrap it into a figure', async ({ page }) => {
  await login(page);
  await openDoc(page, `${PROJECT}/float.tex`);
  await page.locator('.lyx-editor .lyx-graphics img').first().click();
  await expect(page.locator('.lyx-graphics.ProseMirror-selectednode')).toHaveCount(1);
  await page.locator('[data-tb="float"]').first().click();
  await page.keyboard.type('A grey plot');
  await saved(page);
  await expect.poll(() => file('float.tex'), { timeout: 15000 }).toMatch(/\\begin\{figure\}[\s\S]*\\includegraphics\[width=4cm\]\{figs\/plot\.png\}[\s\S]*\\caption\{A grey plot\}[\s\S]*\\end\{figure\}/);

  await openDoc(page, `${PROJECT}/caption.tex`);
  await page.locator('.lyx-editor .lyx-graphics img').first().click();
  await expect(page.locator('.lyx-graphics.ProseMirror-selectednode')).toHaveCount(1);
  await page.locator('.menubar .menu button', { hasText: 'Insert' }).first().click();
  await page.locator('.menu-list .menu-item', { hasText: /^Caption/ }).first().click();
  await page.keyboard.type('Captioned');
  await saved(page);
  await expect.poll(() => file('caption.tex'), { timeout: 15000 }).toMatch(/\\begin\{figure\}[\s\S]*\\includegraphics\[width=4cm\]\{figs\/plot\.png\}[\s\S]*\\caption\{Captioned\}[\s\S]*\\end\{figure\}/);
});

test('HTML blocks pasted into a paragraph become paragraphs and list items, not a Note', async ({ page }) => {
  await login(page);
  await openDoc(page, `${PROJECT}/paste.tex`);
  await page.locator('.lyx-editor .lyx-par').first().click();
  await page.evaluate(() => { const v = (window as any).overlyx.activeView; v.dispatch(v.state.tr.setSelection(v.state.selection.constructor.create(v.state.doc, 8))); });
  await page.evaluate(() => {
    const dt = new DataTransfer();
    dt.setData('text/html', `<html xmlns:o="urn:schemas-microsoft-com:office:office"><body><!--StartFragment--><p class=MsoNormal><b>Results</b></p><p class=MsoNormal>We observed a <i>significant</i> increase.<o:p></o:p></p><ul><li class=MsoNormal>Session A: 3.2 Hz</li><li class=MsoNormal>Session B: 2.8 Hz</li></ul><table border=1><tr><td>Condition</td><td>Mean</td></tr><tr><td>Control</td><td>3.1</td></tr></table><!--EndFragment--></body></html>`);
    dt.setData('text/plain', 'Results\nWe observed a significant increase.\nSession A: 3.2 Hz\nSession B: 2.8 Hz');
    document.querySelector('.lyx-editor')!.dispatchEvent(new ClipboardEvent('paste', { clipboardData: dt, bubbles: true, cancelable: true }));
  });
  await expect(page.locator('.lyx-editor .lyx-inset-note')).toHaveCount(0);
  await saved(page);
  await expect.poll(() => file('paste.tex'), { timeout: 15000 }).toContain('Session B');
  const tex = file('paste.tex');
  expect(tex).not.toContain('@note');
  expect(tex).toMatch(/\\item Session A: 3\.2 Hz\n\\item Session B: 2\.8 Hz/);
  expect(tex).toContain('We observed a \\emph{significant} increase.');
  expect(tex).toContain('\\begin{tabular}');
});

test('Enter in a caption does not split it', async ({ page }) => {
  await login(page);
  await openDoc(page, `${PROJECT}/capenter.tex`);
  const caption = page.locator('.lyx-editor .lyx-inset-caption').first();
  await caption.getByText('Maximum path lengths').click();
  await page.keyboard.press('End');
  await page.keyboard.press('Enter');
  await page.keyboard.type(' and more');
  await expect(page.locator('.statusbar .msg')).toContainText('single paragraph');
  await saved(page);
  await expect.poll(() => file('capenter.tex'), { timeout: 15000 }).toContain('and more');
  expect(file('capenter.tex')).toMatch(/\\caption\{Maximum path lengths per layer and more\}/);
});

test('Insert ▸ Graphics on an empty layout page places an image object on that page', async ({ page }) => {
  await login(page);
  // a new 16:9 deck (File ▸ New slides): a title page and a content page
  const made = await page.request.post(`/api/projects/${encodeURIComponent(PROJECT)}/new`, { data: { path: 'deck.tex', layout: 'slides169', title: 'Test talk' } });
  expect(made.ok()).toBe(true);
  await page.goto(`/#/${PROJECT}/deck.tex`);
  await page.waitForSelector('.lyx-editor.ol-layout .ol-page', { timeout: 30000 });
  const pages = await page.locator('.ol-page').count();
  const frames = file('deck.tex').match(/\\begin\{frame\}/g)?.length;
  const pg = (await page.locator('.ol-page').first().boundingBox())!;
  await page.mouse.click(pg.x + pg.width / 2, pg.y + pg.height - 15);   // the empty canvas of page 1
  await page.locator('.menubar .menu button', { hasText: 'Insert' }).first().click();
  await page.locator('.menu-list .menu-item', { hasText: /^Graphics/ }).first().click();
  const dialog = page.locator('.dialog', { hasText: 'Graphics' }).first();
  await dialog.locator('input[placeholder="figures/plot.pdf"]').fill('pic.png');
  await dialog.locator('button.primary', { hasText: 'Insert' }).click();
  await expect(page.locator('.ol-page').first().locator('.ol-image')).toHaveCount(1, { timeout: 10000 });
  await expect(page.locator('.ol-page')).toHaveCount(pages);
  await saved(page);
  await expect.poll(() => file('deck.tex'), { timeout: 15000 }).toContain('pic.png');
  const tex = file('deck.tex');
  expect(tex.slice(tex.indexOf('\\begin{document}'))).not.toContain('\\note');   // no speaker notes
  expect(tex.match(/\\begin\{frame\}/g)?.length).toBe(frames);
  // on the first page, after its title boxes
  const first = tex.slice(tex.indexOf('\\begin{frame}'), tex.indexOf('\\end{frame}'));
  expect(first).toMatch(/\\olimage\{[^}]*\}\{pic\.png\}/);
});

test('the first Suggesting of an author names them in the change description', async ({ page }) => {
  await login(page);
  await openDoc(page, `${PROJECT}/track.tex`);
  await page.locator('.lyx-editor .lyx-par').first().getByText('Remove this word').dblclick({ position: { x: 70, y: 6 } });
  await page.keyboard.press('Control+Shift+e');
  await expect(page.locator('.statusbar .tracking')).toHaveText(/tracking changes as Admin/);
  await page.keyboard.press('Delete');
  await expect(page.locator('.lyx-editor .lyx-change-deleted')).toHaveCount(1);
  await page.locator('.lyx-editor .lyx-change-deleted').first().click();
  await expect(page.locator('.statusbar .change-info')).toHaveText(/Deleted by Admin on /);
});

test('the TeX pane follows a change of the document settings', async ({ page }) => {
  await login(page);
  await openDoc(page, `${PROJECT}/settings.tex`);
  await page.locator('[data-pane-chip="tex"]').click();
  const ta = page.locator('textarea.source').first();
  await expect(ta).toHaveValue(/\\documentclass\{article\}/, { timeout: 15000 });
  const r = await page.request.post(`/api/docs/${encodeURIComponent(`${PROJECT}/settings.tex`)}/header`, { data: { set: { textclass: 'report' } } });
  expect(r.ok()).toBe(true);
  await expect(ta).toHaveValue(/\\documentclass\{report\}/, { timeout: 10000 });
});

test('a tracked table is drawn in the change colour; an accepted one in the text colour', async ({ page }) => {
  await login(page);
  await openDoc(page, `${PROJECT}/tables.tex`);
  await expect(page.locator('.lyx-editor .lyx-tabular')).toHaveCount(2);
  const colours = await page.evaluate(() => Array.from(document.querySelectorAll<HTMLElement>('.lyx-editor .lyx-tabular')).map(t => ({
    tracked: t.classList.contains('lyx-change-inserted'),
    rule: getComputedStyle(t.querySelector('.lyx-cell.topline')!).borderTopColor,
    outline: getComputedStyle(t.querySelector('table')!).outlineStyle,
    text: getComputedStyle(t.querySelector('.lyx-cell')!).color,
    fg: getComputedStyle(document.querySelector('.lyx-editor')!).color,
  })));
  const [tracked, plain] = colours;
  expect(tracked.tracked).toBe(true);
  expect(plain.tracked).toBe(false);
  expect(tracked.rule).toBe(tracked.text);   // the rules in the change colour, like the text in it
  expect(tracked.rule).not.toBe(plain.rule);
  expect(tracked.outline).toBe('solid');
  expect(plain.rule).toBe(plain.fg);
});

test('suggesting: an edit inside an existing formula says once that it is not tracked', async ({ page }) => {
  await login(page);
  await openDoc(page, `${PROJECT}/formula.tex`);
  await page.locator('.lyx-editor .lyx-par').first().getByText('here').click();
  await page.keyboard.press('Control+Shift+e');
  await expect(page.locator('.statusbar .tracking')).toHaveText(/tracking changes as Admin/);
  await page.locator('.lyx-editor .lyx-math-inline').first().click();
  await expect(page.locator('.lyx-math-inline .lm-field.focused')).toHaveCount(1);
  await page.keyboard.press('End');
  await page.keyboard.type('+1');
  await page.keyboard.press('Escape');
  await expect(page.locator('.statusbar .msg')).toContainText('not tracked', { timeout: 5000 });
  await saved(page);
  await expect.poll(() => file('formula.tex'), { timeout: 15000 }).toContain('$x+1$');
});

test('on a tablet, the text reflows into a narrow pane beside the PDF instead of being cut off', async ({ browser }) => {
  for (const viewport of [{ width: 1024, height: 1366 }, { width: 1366, height: 1024 }]) {
    const ctx = await browser.newContext({ viewport, hasTouch: true });
    const page = await ctx.newPage();
    await page.addInitScript(() => { try { localStorage.setItem('ol.ink', '1'); localStorage.setItem('ol.prefs', JSON.stringify({ autoBuild: 'off' })); } catch { /* ignore */ } });
    await login(page);
    await openDoc(page, `${PROJECT}/narrow.tex`);
    await page.locator('[data-pane-chip="pdf"]').click();
    await expect(page.locator('.pdf-pane')).toBeVisible();
    await page.waitForTimeout(600);
    const fit = await page.evaluate(() => {
      const sc = document.querySelector('.editor-scroll')!.getBoundingClientRect();
      const ed = document.querySelector('.lyx-editor')!.getBoundingClientRect();
      return { left: ed.left - sc.left, right: sc.right - ed.right, width: ed.width, pane: sc.width };
    });
    expect(fit.width).toBeLessThan(fit.pane);
    expect(fit.left).toBeGreaterThanOrEqual(0);
    expect(fit.right).toBeGreaterThanOrEqual(0);
    await ctx.close();
  }
});
