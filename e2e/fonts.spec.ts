/**
 * Fonts, chosen separately for the editor (Settings ▸ Editor ▸ Text font / Math font, per browser)
 * and for the PDF (Document ▸ Settings ▸ Fonts, in the file). The editor's fonts come with the client
 * (fonts/web for the text, MathJax's font packages for formulas): checked are the fonts the text and
 * the formulas are drawn in, that they load, and that nothing is requested from anywhere else.
 */
import { test, expect, type Page } from '@playwright/test';
import { mkdirSync, rmSync, readFileSync, writeFileSync } from 'node:fs';
import { login, collectErrors, PROJECTS_DIR, texDoc } from './helpers';

const DIR = `${PROJECTS_DIR}/admin/e2e-fonts`;
const FILE = `${DIR}/main.tex`;

test.beforeEach(() => {
  rmSync(DIR, { recursive: true, force: true });
  mkdirSync(DIR, { recursive: true });
  writeFileSync(FILE, texDoc('Text with $\\alpha + x_i^2 \\le \\sum_k y_k$ inside.\n\nMore text.', '\\usepackage{amsmath}\n\\usepackage{amssymb}'));
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
const openDialog = (page: Page, name: string) => page.evaluate((n) => (window as any).overlyx.openDialog(n), name);
const style = (page: Page, sel: string, prop: string) => page.locator(sel).first().evaluate((e, p) => getComputedStyle(e).getPropertyValue(p), prop);
/** the MathJax font a formula is drawn in: the class of its mjx-math (the font's CSS prefix) */
const mathClass = (page: Page, sel = '.lyx-editor .lyx-math-inline mjx-math') => page.locator(sel).first().getAttribute('class');

test('Settings ▸ Editor ▸ Text font and Math font: text and formulas switch face independently; the sample shows them', async ({ page }) => {
  const errors = collectErrors(page);
  const foreign = await open(page);
  expect(await style(page, '.lyx-editor', 'font-family')).toMatch(/^"CMU Serif"/);
  // MathJax with New Computer Modern, its woff2 files served with the client
  expect(await page.evaluate(() => document.documentElement.dataset.mathFont)).toBe('newcm');
  expect(await mathClass(page)).toBe('NCM-N');
  await expect.poll(() => loaded(page)).toEqual(expect.arrayContaining([expect.stringMatching(/^MJX-NCM-/)]));
  await openDialog(page, 'preferences');
  const dlg = page.locator('.dialog');
  await expect(dlg.locator('[data-pref="editorMathFont"]')).toHaveValue('match');
  // the sample: the test document of tex.stackexchange.com/q/425098, with accents
  const sample = dlg.locator('[data-font-sample]');
  await expect(sample).toContainText('Residue theorem');
  await expect(sample).toContainText('Maximum modulus');
  expect(await sample.locator('.sample-display mjx-container').count()).toBe(3);
  expect(await sample.locator('mjx-mover').count()).toBeGreaterThanOrEqual(10);
  await dlg.locator('[data-pref="editorFont"]').selectOption('libertinus');
  await expect.poll(() => style(page, '.lyx-editor', 'font-family')).toMatch(/^"OLT libertinus"/);
  // matching: the formulas in STIX Two, the MathJax font closest to Libertinus; the sample too
  await expect.poll(() => mathClass(page)).toBe('STX-N');
  expect(await mathClass(page, '[data-font-sample] mjx-math')).toBe('STX-N');
  expect(await style(page, '[data-font-sample]', 'font-family')).toMatch(/^"OLT libertinus"/);
  await expect.poll(() => loaded(page)).toEqual(expect.arrayContaining(['OLT libertinus', expect.stringMatching(/^MJX-STX-/)]));
  // the math font on its own: Euler's letters over New Computer Modern
  await dlg.locator('[data-pref="editorMathFont"]').selectOption('euler');
  await expect.poll(() => mathClass(page)).toBe('NCM-N');
  await expect.poll(() => loaded(page)).toEqual(expect.arrayContaining([expect.stringMatching(/^MJX-NE-/)]));
  expect(await style(page, '.lyx-editor', 'font-family')).toMatch(/^"OLT libertinus"/);
  const prefs = JSON.parse((await page.evaluate(() => localStorage.getItem('ol.prefs')))!);
  expect([prefs.editorFont, prefs.editorMathFont]).toEqual(['libertinus', 'euler']);
  // the PDF's fonts are untouched
  expect(readFileSync(FILE, 'utf8')).not.toMatch(/libertinus|euler/);
  await dlg.locator('[data-pref="editorFont"]').selectOption('cm');
  await dlg.locator('[data-pref="editorMathFont"]').selectOption('match');
  await expect.poll(() => style(page, '.lyx-editor', 'font-family')).toMatch(/^"CMU Serif"/);
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
  await expect(dlg.locator('[data-font-set]')).toHaveValue('cm');
  await dlg.locator('[data-font-set]').selectOption('times');
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
  await expect(dlg.locator('[data-font-set]')).toHaveValue('times');
  await dlg.locator('.row', { hasText: 'Math' }).locator('input').fill('"auto" "auto"');
  await expect(dlg.locator('[data-font-set]')).toHaveValue('');
  // with non-TeX fonts (fontspec) the TeX font sets step aside
  await dlg.locator('.row', { hasText: 'Non-TeX fonts' }).locator('input[type=checkbox]').check();
  await expect(dlg.locator('[data-font-set]')).toBeDisabled();
  expect(errors).toEqual([]);
});

test('the sans-serif face: San Francisco where the system has it, formulas in Fira Math; a saved "Noto Sans" becomes it', async ({ page }) => {
  const errors = collectErrors(page);
  const foreign = await open(page, { editorFont: 'noto' });
  expect(await page.evaluate(() => document.documentElement.dataset.editorFont)).toBe('sans');
  expect(await style(page, '.lyx-editor', 'font-family')).toMatch(/^-apple-system, BlinkMacSystemFont, "SF Pro Text", "SF Pro", "SF Pro Display", "OLT fira", sans-serif/);
  await expect.poll(() => mathClass(page)).toBe('FIRA-N');
  // no San Francisco on the test machine: the text is Fira Sans, the formulas Fira Math, both served with the client
  await expect.poll(() => loaded(page)).toEqual(expect.arrayContaining(['OLT fira', expect.stringMatching(/^MJX-FIRA-/)]));
  await openDialog(page, 'preferences');
  await expect(page.locator('.dialog [data-pref="editorFont"]')).toHaveValue('sans');
  await expect(page.locator('.dialog [data-pref="editorMathFont"] option').first()).toContainText('Matching the text font (now Fira Math)');
  expect(foreign).toEqual([]);
  expect(errors).toEqual([]);
});
