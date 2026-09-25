/**
 * The writing area's panes — WYSIWYG, TeX source and PDF side by side in any combination and order
 * (app/panes.ts, the PaneSwitch in the menu bar) —, the PDF pane's age and outdated state,
 * automatic builds, the rebuild that keeps the page and never blanks it (PdfViewer), section
 * folding (editor/plugins/fold.ts) and the dash keys.
 */
import { test, expect, type Page } from '@playwright/test';
import { mkdirSync, rmSync, writeFileSync, readFileSync } from 'node:fs';
import { login, collectErrors, PROJECTS_DIR, texDoc } from './helpers';

const PROJECT = 'e2e-panes';
const DIR = `${PROJECTS_DIR}/${PROJECT}`;
const SHORT = texDoc('\\section{One}\n\nFirst section text.\n\n\\subsection{One a}\n\nSub text.\n\n\\section{Two}\n\nSecond section text with a findme word.\n\n\\section{Three}\n\nThird text.');

test.beforeAll(() => {
  rmSync(DIR, { recursive: true, force: true });
  mkdirSync(DIR, { recursive: true });
  const paras: string[] = ['\\section{Introduction}', ''];
  for (let i = 1; i <= 30; i++) paras.push(`Paragraph ${i} of the introduction with enough words to fill the page: the quick brown fox number ${i} jumps over the lazy dog and keeps running through the meadow.`, '');
  paras.push('\\section{Methods}', '');
  for (let i = 1; i <= 30; i++) paras.push(`Methods paragraph ${i}, describing procedure number ${i} in great and careful detail so that the text runs over several pages.`, '');
  writeFileSync(`${DIR}/long.tex`, texDoc(paras.join('\n')));
  writeFileSync(`${DIR}/short.tex`, SHORT);
  writeFileSync(`${DIR}/dash.tex`, texDoc('Dashes here'));
});
test.afterAll(() => rmSync(DIR, { recursive: true, force: true }));

const prefs = (page: Page, p: Record<string, unknown>) => page.addInitScript(v => { try { localStorage.setItem('ol.prefs', JSON.stringify(v)); } catch { /* ignore */ } }, p);
async function open(page: Page, name: string): Promise<void> {
  await page.goto(`/#/${PROJECT}/${name}`);
  await page.waitForFunction(() => document.querySelectorAll('.lyx-editor .lyx-par').length > 0, null, { timeout: 30000 });
  await page.waitForTimeout(400);
}
/** the panes on screen, left to right */
const shown = (page: Page) => page.evaluate(() => Array.from(document.querySelectorAll<HTMLElement>('.editor-column.panes > [data-pane]'))
  .filter(e => getComputedStyle(e).display !== 'none').sort((a, b) => a.getBoundingClientRect().left - b.getBoundingClientRect().left).map(e => e.dataset.pane));
const widths = (page: Page) => page.evaluate(() => Object.fromEntries(Array.from(document.querySelectorAll<HTMLElement>('.editor-column.panes > [data-pane]'))
  .filter(e => getComputedStyle(e).display !== 'none').map(e => [e.dataset.pane, Math.round(e.getBoundingClientRect().width)])));
const chip = (page: Page, id: string) => page.locator(`[data-pane-chip="${id}"]`);
const noise = (errors: string[]) => errors.filter(e => !/favicon|ResizeObserver|willReadFrequently/.test(e));

test('the pane switch shows WYSIWYG, TeX and PDF in any combination and order; widths are dragged; the layout is kept', async ({ page }) => {
  const errors = collectErrors(page);
  await prefs(page, { autoBuild: 'off' });
  await login(page);
  await open(page, 'long.tex');
  expect(await shown(page)).toEqual(['doc']);
  await chip(page, 'tex').click();
  expect(await shown(page)).toEqual(['doc', 'tex']);
  await expect(page).toHaveURL(new RegExp(`#/raw:${PROJECT}/long\\.tex$`));   // the source pane is in the address (links, Back)
  await chip(page, 'pdf').click();
  expect(await shown(page)).toEqual(['doc', 'tex', 'pdf']);
  await expect(page.locator('.pdf-panel')).toBeVisible();
  await chip(page, 'doc').click();
  expect(await shown(page)).toEqual(['tex', 'pdf']);
  await chip(page, 'pdf').dblclick();   // double-click: this one alone
  await expect.poll(() => shown(page)).toEqual(['pdf']);
  await chip(page, 'pdf').click();   // the last pane stays
  expect(await shown(page)).toEqual(['pdf']);
  await expect(chip(page, 'pdf')).toHaveAttribute('aria-pressed', 'true');

  // ▾: every arrangement as a picture
  await page.locator('[data-pane-menu]').click();
  await expect(page.locator('.pane-menu .pane-preset')).toHaveCount(15);
  await page.locator('[data-preset="pdf-doc"]').click();
  expect(await shown(page)).toEqual(['pdf', 'doc']);
  await expect(page).toHaveURL(new RegExp(`#/${PROJECT}/long\\.tex$`));
  await expect(page.locator('.pane-menu')).toHaveCount(0);

  // dragging a chip moves its pane: PDF from the left to the right end
  const from = (await chip(page, 'pdf').boundingBox())!, to = (await chip(page, 'tex').boundingBox())!;
  await page.mouse.move(from.x + from.width / 2, from.y + from.height / 2);
  await page.mouse.down();
  await page.mouse.move(from.x + from.width / 2 + 12, from.y + from.height / 2, { steps: 3 });
  await page.mouse.move(to.x + to.width + 8, from.y + from.height / 2, { steps: 8 });
  await page.mouse.up();
  expect(await chip(page, 'pdf').evaluate(e => Array.from(e.parentElement!.children).indexOf(e))).toBe(2);
  expect(await shown(page)).toEqual(['doc', 'pdf']);

  // the divider between them
  const before = await widths(page);
  const grip = (await page.locator('.pane-grip').first().boundingBox())!;
  await page.mouse.move(grip.x + grip.width / 2, grip.y + 200);
  await page.mouse.down();
  await page.mouse.move(grip.x + grip.width / 2 - 160, grip.y + 200, { steps: 6 });
  await page.mouse.up();
  const after = await widths(page);
  expect(after.doc).toBeLessThan(before.doc - 120);
  expect(after.pdf).toBeGreaterThan(before.pdf + 120);

  // kept in this browser
  await page.reload();
  await page.waitForFunction(() => document.querySelectorAll('.lyx-editor .lyx-par').length > 0, null, { timeout: 30000 });
  expect(await shown(page)).toEqual(['doc', 'pdf']);
  const kept = await widths(page);
  expect(Math.abs(kept.doc - after.doc)).toBeLessThan(4);

  // the View menu and Ctrl+Alt+S still switch the source; the rail / panel tabs toggle the PDF
  await page.locator('.menubar .menu button', { hasText: 'View' }).click();
  await page.locator('.menu-item', { hasText: 'LaTeX source beside' }).click();
  expect(await shown(page)).toEqual(['doc', 'tex', 'pdf']);
  await page.locator('.lyx-editor .lyx-par').first().click();
  await page.keyboard.press('Control+Alt+s');
  expect(await shown(page)).toEqual(['doc', 'pdf']);
  await page.locator('.rail.right [data-rail="pdf"]').click();
  expect(await shown(page)).toEqual(['doc']);
  expect(noise(errors)).toEqual([]);
});

test('on a phone-width screen the switch shows one pane at a time', async ({ page }) => {
  await page.setViewportSize({ width: 600, height: 800 });
  await prefs(page, { autoBuild: 'off' });
  await login(page);
  await open(page, 'short.tex');
  await chip(page, 'pdf').click();
  expect(await shown(page)).toEqual(['pdf']);
  await chip(page, 'doc').click();
  expect(await shown(page)).toEqual(['doc']);
  await expect(page.locator('.pane-grip')).toHaveCount(0);
});

test('the PDF pane: its age, outdated after an edit, automatic builds, and a rebuild that keeps the page without blanking it', async ({ page }) => {
  test.setTimeout(240000);
  const errors = collectErrors(page);
  await prefs(page, { autoBuild: 'off' });
  await login(page);
  await open(page, 'long.tex');
  await page.locator('.tb-btn[title^="View PDF"]').click();
  await expect(page.locator('.pdf-panel .build-progress')).toBeVisible({ timeout: 15000 });
  await expect(page.locator('.pdf-panel .build-progress')).toHaveCount(0, { timeout: 180000 });
  await expect(page.locator('.pdf-panel .bar span')).toContainText('built');
  await expect(page.locator('.pdf-panel [data-pdf-age="current"]')).toContainText(/built (just now|\d+ min ago)/);
  await expect(page.locator('.statusbar [data-pdf-status="current"]')).toContainText('PDF');
  await expect(page.locator('.pdf-panel .pdf-page-box').nth(1)).toBeAttached({ timeout: 30000 });

  // an edit makes it outdated; with auto-build off nothing is built
  const par = page.locator('.lyx-editor .lyx-par', { hasText: 'Paragraph 2 of the introduction' });
  await par.click(); await page.keyboard.press('End'); await page.keyboard.type(' Edited once.');
  await expect(page.locator('.pdf-panel [data-pdf-age="outdated"]')).toContainText('outdated', { timeout: 20000 });
  await expect(page.locator('.statusbar [data-pdf-status="outdated"]')).toBeVisible();
  await page.waitForTimeout(3000);
  await expect(page.locator('.pdf-panel .build-progress')).toHaveCount(0);

  // auto-build on (the ▾ beside View PDF): the outdated PDF is rebuilt by itself
  await page.locator('[data-pdf-build-menu]').click();
  await page.locator('[data-auto-build="shown"] input').check();
  await page.keyboard.press('Escape');
  await expect(page.locator('.pdf-panel .build-progress')).toBeVisible({ timeout: 20000 });
  await expect(page.locator('.pdf-panel .build-progress')).toHaveCount(0, { timeout: 180000 });
  await expect(page.locator('.pdf-panel [data-pdf-age="current"]')).toBeVisible({ timeout: 15000 });

  // on page 2, a rebuild after another edit: the page never blanks, the view stays on page 2
  await page.locator('.pdf-toolbar .pdf-page').fill('2');
  await page.keyboard.press('Enter');
  await page.waitForTimeout(800);
  await expect(page.locator('.pdf-toolbar .pdf-page')).toHaveValue('2');
  const top0 = await page.locator('.pdf-pages').evaluate(e => e.scrollTop);
  await page.evaluate(() => {
    const w = window as any;
    w.__blank = 0; w.__samples = 0;
    w.__iv = setInterval(() => {
      const c = document.querySelector<HTMLCanvasElement>('.pdf-page-box[data-page="2"] canvas');
      if (!c) return;
      w.__samples++;
      if (!c.width) { w.__blank++; return; }
      const d = c.getContext('2d', { willReadFrequently: true })!.getImageData(0, Math.floor(c.height * 0.2), c.width, 4).data;
      let ink = 0;
      for (let i = 0; i < d.length; i += 4) if (d[i + 3] > 0 && d[i] < 120) ink++;
      if (!ink) w.__blank++;
    }, 40);
  });
  await par.click(); await page.keyboard.press('End'); await page.keyboard.type(' Edited twice.');
  await expect(page.locator('.pdf-panel .build-progress')).toBeVisible({ timeout: 20000 });
  await expect(page.locator('.pdf-panel .build-progress')).toHaveCount(0, { timeout: 180000 });
  await page.waitForTimeout(1500);   // the new PDF loads and is drawn
  const r = await page.evaluate(() => { const w = window as any; clearInterval(w.__iv); return { blank: w.__blank, samples: w.__samples }; });
  expect(r.samples).toBeGreaterThan(20);
  expect(r.blank).toBe(0);
  await expect(page.locator('.pdf-toolbar .pdf-page')).toHaveValue('2');
  expect(Math.abs(await page.locator('.pdf-pages').evaluate(e => e.scrollTop) - top0)).toBeLessThan(40);

  // hidden PDF + "while shown": no build; the status bar still tells the age, a click shows it again
  await chip(page, 'pdf').click();
  await par.click(); await page.keyboard.press('End'); await page.keyboard.type(' Edited thrice.');
  await expect(page.locator('.statusbar [data-pdf-status="outdated"]')).toBeVisible({ timeout: 20000 });
  await page.locator('.statusbar [data-pdf-status="outdated"]').click();   // shows the pane and rebuilds
  await expect.poll(() => shown(page)).toContain('pdf');
  await expect(page.locator('.pdf-panel [data-pdf-age="current"]')).toBeVisible({ timeout: 180000 });
  expect(noise(errors)).toEqual([]);
});

test('section folding: the arrow beside a heading, fold all / expand all, remembered, and unfolded by find', async ({ page }) => {
  const errors = collectErrors(page);
  await prefs(page, { autoBuild: 'off' });
  await login(page);
  await open(page, 'short.tex');
  const heading = (t: string) => page.locator('.lyx-editor > .lyx-par', { hasText: new RegExp(`^${t}$`) });
  const text = (t: string) => page.locator('.lyx-editor > .lyx-par', { hasText: t });
  await heading('One').hover();
  const toggle = heading('One').locator('.lyx-fold-toggle');
  await expect(toggle).toBeVisible();
  await toggle.click();
  await expect(text('First section text.')).toBeHidden();
  await expect(text('Sub text.')).toBeHidden();      // the subsection goes with its section
  await expect(text('Second section text')).toBeVisible();
  await expect(toggle).toHaveAttribute('aria-expanded', 'false');
  await page.waitForTimeout(2500);
  expect(readFileSync(`${DIR}/short.tex`, 'utf8')).toBe(SHORT);   // a way of looking at the document, not a change of it

  // remembered in this browser
  await page.reload();
  await page.waitForFunction(() => document.querySelectorAll('.lyx-editor .lyx-par').length > 0, null, { timeout: 30000 });
  await expect(text('First section text.')).toBeHidden({ timeout: 10000 });
  await expect(heading('One').locator('.lyx-fold-toggle.closed')).toBeVisible();

  // View ▸ Expand all / Fold all
  const viewItem = async (label: string) => { await page.locator('.menubar .menu button', { hasText: 'View' }).click(); await page.locator('.menu-item', { hasText: label }).click(); };
  await viewItem('Expand all sections');
  await expect(text('First section text.')).toBeVisible();
  await viewItem('Fold all sections');
  expect(await page.locator('.lyx-editor > .lyx-par:visible').allTextContents()).toEqual(['One', 'Two', 'Three']);

  // find puts the cursor into folded text: that section opens, the others stay folded
  await page.keyboard.press('Control+f');
  await page.locator('.find-bar input').first().fill('findme');
  await page.keyboard.press('Enter');
  await expect(text('Second section text')).toBeVisible();
  await expect(text('First section text.')).toBeHidden();
  await page.keyboard.press('Escape');

  // the right-click menu
  await heading('One').click({ button: 'right' });
  await page.locator('.ctx-item', { hasText: 'Sections' }).hover();
  await page.locator('.ctx-item', { hasText: 'Expand this section' }).click();
  await expect(text('First section text.')).toBeVisible();
  await expect(text('Sub text.')).toBeHidden();    // One a is still folded itself
  expect(noise(errors)).toEqual([]);
});

test('Alt+- types an em dash (written as --- in the file), Alt+Shift+- an en dash', async ({ page }) => {
  await prefs(page, { autoBuild: 'off' });
  await login(page);
  await open(page, 'dash.tex');
  const par = page.locator('.lyx-editor .lyx-par').first();
  await par.click(); await page.keyboard.press('End');
  await page.keyboard.press('Alt+Minus');
  await page.keyboard.type('em');
  await page.keyboard.press('Alt+Shift+Minus');
  await page.keyboard.type('en');
  await expect(par).toHaveText('Dashes here\u2014em\u2013en');
  await expect.poll(() => readFileSync(`${DIR}/dash.tex`, 'utf8'), { timeout: 15000 }).toContain('Dashes here---em--en');
});
