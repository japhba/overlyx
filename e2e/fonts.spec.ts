/**
 * Fonts, chosen separately for the editor (Settings ▸ Editor ▸ Font, per browser) and for the PDF
 * (Document ▸ Settings ▸ Fonts, in the file). Google Fonts is stubbed: what is checked is which faces
 * the editor asks for and what the file says, not the network.
 */
import { test, expect, type Page } from '@playwright/test';
import { mkdirSync, rmSync, readFileSync, writeFileSync } from 'node:fs';
import { login, collectErrors, PROJECTS_DIR, texDoc } from './helpers';

const DIR = `${PROJECTS_DIR}/e2e-fonts`;
const FILE = `${DIR}/main.tex`;

test.beforeEach(() => {
  rmSync(DIR, { recursive: true, force: true });
  mkdirSync(DIR, { recursive: true });
  writeFileSync(FILE, texDoc('Text with $\\alpha + x_i^2 \\le \\sum_k y_k$ inside.\n\nMore text.', '\\usepackage{amsmath}\n\\usepackage{amssymb}'));
});
test.afterAll(() => { rmSync(DIR, { recursive: true, force: true }); });

async function open(page: Page, editorFont?: string) {
  const requested: string[] = [];
  await page.route('https://fonts.googleapis.com/**', r => { requested.push(r.request().url()); return r.fulfill({ contentType: 'text/css', body: '' }); });
  await page.addInitScript((f) => { if (f && !sessionStorage.getItem('fonts-e2e')) { sessionStorage.setItem('fonts-e2e', '1'); localStorage.setItem('ol.prefs', JSON.stringify({ autoBuild: 'off', editorFont: f })); } }, editorFont ?? '');
  await login(page);
  await page.evaluate(() => { localStorage.setItem('ol.tabs', '[]'); localStorage.setItem('ol.combined', '0'); });
  await page.goto('/#/e2e-fonts/main.tex');
  await page.waitForFunction(() => document.querySelectorAll('.lyx-editor .lyx-math-inline .katex').length >= 1, null, { timeout: 60000 });
  return requested;
}
const openDialog = (page: Page, name: string) => page.evaluate((n) => (window as any).overlyx.openDialog(n), name);
const style = (page: Page, sel: string, prop: string) => page.locator(sel).first().evaluate((e, p) => getComputedStyle(e).getPropertyValue(p), prop);

test('Settings ▸ Editor ▸ Font: the text and the formulas switch face; Computer Modern needs no web font', async ({ page }) => {
  const errors = collectErrors(page);
  const requested = await open(page);
  expect(await style(page, '.lyx-editor', 'font-family')).toMatch(/^"CMU Serif"/);
  expect(await style(page, '.lyx-editor .katex .mathnormal', 'font-family')).toMatch(/^KaTeX_Math/);
  expect(requested).toEqual([]);
  await openDialog(page, 'preferences');
  const dlg = page.locator('.dialog');
  await dlg.locator('[data-pref="editorFont"]').selectOption('libertinus');
  await expect.poll(() => style(page, '.lyx-editor', 'font-family')).toMatch(/^"Libertinus Serif"/);
  // variables in the face's italic, symbols from its math font, KaTeX's own after that
  expect(await style(page, '.lyx-editor .katex .mathnormal', 'font-family')).toMatch(/^"Libertinus Serif", KaTeX_Math/);
  expect(await style(page, '.lyx-editor .katex', 'font-family')).toMatch(/^"Libertinus Serif", "Libertinus Math", KaTeX_Main/);
  expect(await style(page, '[data-font-sample]', 'font-family')).toMatch(/^"Libertinus Serif"/);
  expect(requested.some(u => u.includes('family=Libertinus+Serif') && u.includes('family=Libertinus+Math'))).toBe(true);
  expect(JSON.parse((await page.evaluate(() => localStorage.getItem('ol.prefs')))!).editorFont).toBe('libertinus');
  // the PDF's fonts are untouched
  expect(readFileSync(FILE, 'utf8')).not.toContain('libertinus');
  await dlg.locator('[data-pref="editorFont"]').selectOption('cm');
  await expect.poll(() => style(page, '.lyx-editor', 'font-family')).toMatch(/^"CMU Serif"/);
  expect(await page.locator('#ol-editor-fonts').count()).toBe(0);
  expect(errors).toEqual([]);
});

test('Document ▸ Settings ▸ Fonts: a font set writes its text and math fonts; "As in the document" follows it', async ({ page }) => {
  const errors = collectErrors(page);
  await open(page, 'document');
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
  await expect.poll(() => page.evaluate(() => document.documentElement.dataset.editorFont ?? 'cm')).toBe('stix');
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
