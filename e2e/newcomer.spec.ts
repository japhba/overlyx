/**
 * What a newcomer trips over (the usability waves of 11 Oct 2026): making slides from the start page
 * (+ New, app/Home.tsx), the paragraph style control that changed the paragraph on a typed letter or
 * an arrow key (Toolbar.tsx StylePicker; plain names in the Modern interface, stylenames.ts), files
 * dropped on the files panel below its last row (they vanished), and the PDF pane squeezing the
 * writing into a strip on a laptop (App.tsx folds the side panels while it is beside the document).
 */
import { test, expect, type Page } from '@playwright/test';
import { mkdirSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import { login, collectErrors, PROJECTS_DIR, texDoc, stylePicker } from './helpers';

const RUN = Date.now().toString(36);
const PROJECT = 'admin/e2e-newcomer';
const DIR = `${PROJECTS_DIR}/${PROJECT}`;
const SLIDES = `e2e-new-slides-${RUN}`, DOC = `e2e-new-doc-${RUN}`;

test.beforeAll(() => {
  rmSync(DIR, { recursive: true, force: true });
  mkdirSync(DIR, { recursive: true });
  writeFileSync(`${DIR}/styles.tex`, texDoc('\\section{A heading}\n\nA body paragraph to restyle.\n\nAnother paragraph.'));
});
test.afterAll(() => {
  for (const p of [DIR, `${PROJECTS_DIR}/admin/${SLIDES}`, `${PROJECTS_DIR}/admin/${DOC}`]) rmSync(p, { recursive: true, force: true });
});

const noise = (errors: string[]) => errors.filter(e => !/favicon|ResizeObserver|willReadFrequently/.test(e));
const prefs = (page: Page) => page.addInitScript(() => { try { localStorage.setItem('ol.prefs', JSON.stringify({ autoBuild: 'off' })); } catch { /* ignore */ } });

test('+ New on the start page makes slides or a document, each in a project of its own, and opens it', async ({ page }) => {
  const errors = collectErrors(page);
  await login(page);
  await page.goto('/');
  await page.locator('[data-new-project]').click();
  await expect(page.locator('[data-new-kind]')).toHaveCount(4);
  await expect(page.locator('[data-new-kind="doc"]')).toHaveAttribute('aria-checked', 'true');
  await page.locator('[data-new-kind="deck"]').click();
  await expect(page.locator('[data-new-name]')).toHaveAttribute('placeholder', 'Untitled slides');
  await page.locator('[data-new-name]').fill('bad/name');
  await expect(page.locator('[data-new-create]')).toBeDisabled();
  await page.locator('[data-new-name]').fill(SLIDES);
  await page.locator('[data-new-create]').click();
  await expect(page).toHaveURL(new RegExp(`#/admin/${SLIDES}/slides/`), { timeout: 15000 });
  expect(existsSync(`${PROJECTS_DIR}/admin/${SLIDES}/slides/index.html`)).toBe(true);

  await page.goto('/');
  await page.locator('[data-new-project]').click();
  await page.locator('[data-new-name]').fill(DOC);
  await page.keyboard.press('Enter');
  await expect(page).toHaveURL(new RegExp(`#/admin/${DOC}/main\\.tex$`), { timeout: 15000 });
  await page.waitForFunction(() => document.querySelectorAll('.lyx-editor .lyx-par').length > 0, null, { timeout: 30000 });
  expect(noise(errors)).toEqual([]);
});

test('the paragraph style picker: letters search, arrows only move the highlight, Enter applies, Escape gives the keyboard back', async ({ page }) => {
  const errors = collectErrors(page);
  await prefs(page);
  await login(page);
  await page.goto(`/#/${PROJECT}/styles.tex`);
  await page.waitForFunction(() => document.querySelectorAll('.lyx-editor .lyx-par').length > 0, null, { timeout: 30000 });
  await page.locator('.lyx-editor .lyx-par', { hasText: 'A body paragraph' }).click();
  const picker = stylePicker(page);
  await expect(picker).toHaveAttribute('data-style-picker', 'Standard');
  await expect(picker).toContainText('Standard');   // Classic: LyX's names

  await picker.click();
  await expect(page.locator('[data-style-search]')).toBeFocused();
  await page.keyboard.type('sub');   // a native <select> jumped to the first match and applied it
  await expect(page.locator('[data-style-list] [data-style]').first()).toContainText('Sub');
  await expect(picker).toHaveAttribute('data-style-picker', 'Standard');
  await page.keyboard.press('ArrowDown');
  await page.keyboard.press('ArrowDown');
  await expect(picker).toHaveAttribute('data-style-picker', 'Standard');
  await page.keyboard.press('Escape');
  await expect(page.locator('[data-style-list]')).toHaveCount(0);
  await expect(page.locator('.lyx-editor')).toBeFocused();
  await expect(picker).toHaveAttribute('data-style-picker', 'Standard');

  await picker.click();
  await page.keyboard.type('section');
  await page.keyboard.press('Enter');
  await expect(picker).toHaveAttribute('data-style-picker', 'Section');
  await expect(page.locator('.lyx-layout-section', { hasText: 'A body paragraph' })).toHaveCount(1);
  await expect(page.locator('.lyx-editor')).toBeFocused();
  await page.keyboard.type(' again');   // typing goes on in the text
  await expect(page.locator('.lyx-layout-section', { hasText: 'again' })).toHaveCount(1);

  // the Modern interface calls the styles what Google Docs would; LyX's name stays findable
  await page.evaluate(() => { localStorage.setItem('ol.ui', 'modern'); });
  await page.reload();
  await page.waitForFunction(() => document.querySelectorAll('.lyx-editor .lyx-par').length > 0, null, { timeout: 30000 });
  await page.locator('.lyx-editor .lyx-par', { hasText: 'Another paragraph' }).click();
  if (await page.evaluate(() => document.documentElement.dataset.ui) === 'modern') {
    await expect(stylePicker(page)).toContainText('Normal text');
    await stylePicker(page).click();
    await page.keyboard.type('itemize');
    await expect(page.locator('[data-style-list] [data-style="Itemize"]')).toContainText('Bullet list');
    await page.keyboard.press('Escape');
  }
  await page.evaluate(() => { localStorage.setItem('ol.ui', 'classic'); });
  expect(noise(errors)).toEqual([]);
});

test('a file dropped anywhere on the files panel is uploaded, also below the last row; the panel has no git button', async ({ page }) => {
  await prefs(page);
  await login(page);
  await page.goto(`/#/${PROJECT}/styles.tex`);
  await page.waitForFunction(() => document.querySelectorAll('.lyx-editor .lyx-par').length > 0, null, { timeout: 30000 });
  const panel = page.locator('.sidebar.left .panel-body');
  await expect(panel.locator('.filetree')).toBeVisible();
  await expect(page.locator('.sidebar.left [data-git]')).toHaveCount(0);   // Git… is on the project card and in the File menu
  const box = (await panel.boundingBox())!;
  const below = await panel.evaluate((el, y) => {
    const t = document.elementFromPoint(el.getBoundingClientRect().left + 60, y)!;
    const dt = new DataTransfer();
    dt.items.add(new File(['@book{knuth1984, title={The TeXbook}, author={Knuth, Donald}, year={1984}}\n'], 'refs.bib', { type: 'text/x-bibtex' }));
    for (const type of ['dragenter', 'dragover', 'drop']) t.dispatchEvent(new DragEvent(type, { bubbles: true, cancelable: true, dataTransfer: dt }));
    return t.closest('.filetree') !== null;
  }, box.y + box.height - 30);
  expect(below).toBe(true);
  await expect.poll(() => existsSync(`${DIR}/refs.bib`), { timeout: 10000 }).toBe(true);
  await expect(panel.locator('.filetree', { hasText: 'refs.bib' })).toHaveCount(1);
});

test('the PDF beside the document on a laptop folds the side panels away and brings them back when it is hidden', async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 800 });
  await prefs(page);
  await page.addInitScript(() => { try { localStorage.setItem('ol.files', '1'); localStorage.removeItem('ol.panes'); } catch { /* ignore */ } });
  await login(page);
  await page.goto(`/#/${PROJECT}/styles.tex`);
  await page.waitForFunction(() => document.querySelectorAll('.lyx-editor .lyx-par').length > 0, null, { timeout: 30000 });
  await expect(page.locator('.sidebar.left')).toBeVisible();
  const docWidth = () => page.locator('.editor-column.panes > [data-pane="doc"]').evaluate(e => Math.round(e.getBoundingClientRect().width));
  await page.locator('[data-pane-chip="pdf"]').click();
  await expect(page.locator('.sidebar.left')).toHaveCount(0);
  expect(await docWidth()).toBeGreaterThanOrEqual(600);
  // opened again by hand, the panel stays
  await page.locator('[data-rail="outline"]').click();
  await expect(page.locator('.sidebar.left')).toBeVisible();
  await page.waitForTimeout(300);
  await expect(page.locator('.sidebar.left')).toBeVisible();
  await page.locator('.sidebar.left button.hide').click();
  await page.locator('[data-pane-chip="pdf"]').click();   // PDF hidden: the panel comes back only if it was folded for the PDF
  await expect(page.locator('.sidebar.left')).toHaveCount(0);
  await page.locator('[data-pane-chip="pdf"]').click();
  await page.locator('[data-pane-chip="pdf"]').click();
  await expect(page.locator('.sidebar.left')).toHaveCount(0);
});
