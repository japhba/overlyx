/**
 * Fonts, chosen separately for the editor (Settings ▸ Fonts ▸ Text font / Math font, per browser)
 * and for the PDF (Document ▸ Settings ▸ Fonts, in the file). The editor's fonts come with the client
 * (fonts/web for the text, MathJax's font packages for formulas): checked are the fonts the text and
 * the formulas are drawn in, that they load, and that nothing is requested from anywhere else.
 */
import { test, expect, type Page, type Locator } from '@playwright/test';
import { mkdirSync, rmSync, readFileSync, writeFileSync } from 'node:fs';
import { login, collectErrors, PROJECTS_DIR, texDoc } from './helpers';

const DIR = `${PROJECTS_DIR}/admin/e2e-fonts`;
const FILE = `${DIR}/main.tex`;

test.beforeEach(() => {
  rmSync(DIR, { recursive: true, force: true });
  mkdirSync(DIR, { recursive: true });
  writeFileSync(FILE, texDoc('Text with $\\alpha + x_i^2 \\le \\sum_k y_k$ inside.\n\nMore text with $\\theta\\,\\mathcal{L}\\,\\mathfrak{g}$.', '\\usepackage{amsmath}\n\\usepackage{amssymb}'));
});
test.afterAll(() => { rmSync(DIR, { recursive: true, force: true }); });

async function open(page: Page, prefs?: Record<string, string>) {
  const foreign: string[] = [];
  page.on('request', r => { const u = new URL(r.url()); if (/\.(woff2?|otf|ttf)$/.test(u.pathname) && !/^(localhost|127\.0\.0\.1)$/.test(u.hostname)) foreign.push(r.url()); });
  await page.addInitScript((p) => { if (p && !sessionStorage.getItem('fonts-e2e')) { sessionStorage.setItem('fonts-e2e', '1'); localStorage.setItem('ol.prefs', JSON.stringify({ autoBuild: 'off', ...JSON.parse(p) })); } }, prefs ? JSON.stringify(prefs) : '');
  await login(page);
  await page.evaluate(() => { localStorage.setItem('ol.tabs', '[]'); localStorage.setItem('ol.combined', '0'); });
  await page.goto('/#/admin/e2e-fonts/main.tex');
  await page.waitForFunction(() => document.querySelectorAll('.lyx-editor .lyx-math-inline mjx-container').length >= 1, null, { timeout: 60000 });
  return foreign;
}
/** the families of the page's fonts that have loaded */
const loaded = (page: Page) => page.evaluate(async () => { await document.fonts.ready; return [...document.fonts].filter(f => f.status === 'loaded').map(f => f.family.replace(/"/g, '')); });
const openDialog = (page: Page, name: string, arg?: string) => page.evaluate(([n, a]) => (window as any).overlyx.openDialog(n, a), [name, arg] as const);
/** a font button (app/FontPicker.tsx FontChooser): open its list and pick the row that says `label` */
const choose = async (dlg: Locator, button: string, label: string | RegExp) => {
  await dlg.locator(button).click();
  await dlg.locator('.ff-choose-pop .ff-item', { hasText: label }).first().click();
};
// font families without their quotes: WebKit leaves them out where a name needs none (CMU Serif, serif), Chromium and Firefox keep them
const style = (page: Page, sel: string, prop: string) => page.locator(sel).first().evaluate((e, p) => getComputedStyle(e).getPropertyValue(p), prop).then(v => prop === 'font-family' ? v.replace(/"/g, '') : v);
/** the MathJax font a formula is drawn in: the class of its mjx-math (the font's CSS prefix) */
const mathClass = (page: Page, sel = '.lyx-editor .lyx-math-inline mjx-math') => page.locator(sel).first().getAttribute('class');

test('Settings ▸ Fonts ▸ Text font and Math font: text and formulas switch face independently; the sample shows them', async ({ page }) => {
  const errors = collectErrors(page);
  const foreign = await open(page);
  expect(await style(page, '.lyx-editor', 'font-family')).toMatch(/^CMU Serif,/);
  // MathJax with New Computer Modern, its woff2 files served with the client
  expect(await page.evaluate(() => document.documentElement.dataset.mathFont)).toBe('newcm');
  expect(await mathClass(page)).toBe('NCM-N');
  await expect.poll(() => loaded(page)).toEqual(expect.arrayContaining([expect.stringMatching(/^MJX-NCM-/)]));
  await openDialog(page, 'preferences', 'fonts');
  const dlg = page.locator('.dialog');
  await expect(dlg.locator('[data-pref="editorMathFont"]')).toHaveAttribute('data-value', 'match');
  // the sample: the test document of tex.stackexchange.com/q/425098, with accents
  const sample = dlg.locator('[data-font-sample]');
  await expect(sample).toContainText('Residue theorem');
  await expect(sample).toContainText('Maximum modulus');
  expect(await sample.locator('.sample-display mjx-container').count()).toBe(3);
  expect(await sample.locator('mjx-mover').count()).toBeGreaterThanOrEqual(10);
  await choose(dlg, '[data-pref="editorFont"]', /^Libertinus/);
  await expect.poll(() => style(page, '.lyx-editor', 'font-family')).toMatch(/^OLT libertinus,/);
  // matching: the formulas in STIX Two, the MathJax font closest to Libertinus; the sample too
  await expect.poll(() => mathClass(page)).toBe('STX-N');
  expect(await mathClass(page, '[data-font-sample] mjx-math')).toBe('STX-N');
  expect(await style(page, '[data-font-sample]', 'font-family')).toMatch(/^OLT libertinus,/);
  await expect.poll(() => loaded(page)).toEqual(expect.arrayContaining(['OLT libertinus', expect.stringMatching(/^MJX-STX-/)]));
  // the math font on its own: Euler's letters over New Computer Modern — also the Greek, calligraphic
  // and fraktur letters of its blocks loaded on demand (choosing Euler used to hang the page on those)
  await choose(dlg, '[data-pref="editorMathFont"]', /^Euler/);
  await expect.poll(() => mathClass(page)).toBe('NCM-N');
  await expect.poll(() => loaded(page)).toEqual(expect.arrayContaining([expect.stringMatching(/^MJX-NE-/)]));
  await expect.poll(() => page.locator('.lyx-editor .lyx-math-inline').nth(1).locator('mjx-c[class*="NE-"]').count(), { timeout: 10000 }).toBe(3);
  expect(await page.locator('.lyx-editor .lm-error').count()).toBe(0);
  expect(await style(page, '.lyx-editor', 'font-family')).toMatch(/^OLT libertinus,/);
  const prefs = JSON.parse((await page.evaluate(() => localStorage.getItem('ol.prefs')))!);
  expect([prefs.editorFont, prefs.editorMathFont]).toEqual(['libertinus', 'euler']);
  // the PDF's fonts are untouched
  expect(readFileSync(FILE, 'utf8')).not.toMatch(/libertinus|euler/);
  await choose(dlg, '[data-pref="editorFont"]', /^Computer Modern/);
  await choose(dlg, '[data-pref="editorMathFont"]', /^Matching the text font/);
  await expect.poll(() => style(page, '.lyx-editor', 'font-family')).toMatch(/^CMU Serif,/);
  await expect.poll(() => page.evaluate(() => document.documentElement.dataset.mathFont)).toBe('newcm');
  expect(foreign).toEqual([]);
  expect(errors).toEqual([]);
});

test('Document ▸ Settings ▸ Fonts: a font set writes its text and math fonts; "As in the document" follows it', async ({ page }) => {
  const errors = collectErrors(page);
  await open(page, { editorFont: 'document' });
  expect(await page.evaluate(() => document.documentElement.dataset.editorFont ?? 'cm')).toBe('cm');
  await openDialog(page, 'settings');
  const dlg = page.locator('.dialog');
  await dlg.locator('.panel-tabs button:has-text("Fonts")').click();
  await expect(dlg.locator('[data-font-set]')).toHaveAttribute('data-font-set', 'cm');
  await choose(dlg, '[data-font-set]', /^Times/);
  // (the LyX fields under LaTeX details)
  await dlg.locator('.ds-latex > summary').click();
  await expect(dlg.locator('.row', { hasText: 'Math' }).locator('input')).toHaveValue('"newtxmath" "auto"');
  await dlg.locator('button.btn.primary').click();
  await expect.poll(() => readFileSync(FILE, 'utf8'), { timeout: 15000 }).toContain('\\usepackage{newtxmath}');
  const tex = readFileSync(FILE, 'utf8');
  expect(tex).toContain('\\renewcommand{\\rmdefault}{ptm}');
  expect(tex).toMatch(/\\usepackage\[scaled=0\.92\]\{helvet\}/);
  await expect.poll(() => page.evaluate(() => document.documentElement.dataset.editorFont ?? 'cm')).toBe('termes');
  expect(await page.evaluate(() => document.documentElement.dataset.mathFont)).toBe('termes');
  // reopened, the dialog recognises the set; a hand-edited math font makes it custom
  await openDialog(page, 'settings');
  await dlg.locator('.panel-tabs button:has-text("Fonts")').click();
  await expect(dlg.locator('[data-font-set]')).toHaveAttribute('data-font-set', 'times');
  await dlg.locator('.ds-latex > summary').click();
  await dlg.locator('.row', { hasText: 'Math' }).locator('input').fill('"auto" "auto"');
  await expect(dlg.locator('[data-font-set]')).toHaveAttribute('data-font-set', '');
  await expect(dlg.locator('[data-font-set]')).toContainText('Custom');
  expect(errors).toEqual([]);
});

test('no San Francisco: a saved "Sans-serif (this computer’s)" or "Noto Sans" becomes Fira Sans, formulas in Fira Math', async ({ page }) => {
  const errors = collectErrors(page);
  const foreign = await open(page, { editorFont: 'sans' });
  expect(await page.evaluate(() => document.documentElement.dataset.editorFont)).toBe('fira');
  expect(await style(page, '.lyx-editor', 'font-family')).toMatch(/^OLT fira, /);
  await expect.poll(() => mathClass(page)).toBe('FIRA-N');
  await expect.poll(() => loaded(page)).toEqual(expect.arrayContaining(['OLT fira', expect.stringMatching(/^MJX-FIRA-/)]));
  await openDialog(page, 'preferences', 'fonts');
  await expect(page.locator('.dialog [data-pref="editorFont"]')).toHaveAttribute('data-value', 'fira');
  await expect(page.locator('.dialog [data-pref="editorMathFont"]')).toContainText('Matching the text font (Fira Math)');
  expect(foreign).toEqual([]);
  expect(errors).toEqual([]);
});
