/**
 * Helpers for the "a user writes a paper" simulations (paperwriting*.spec.ts): typing real papers
 * from scratch through the editor UI — layouts, formulas keystroke by keystroke, citations pasted
 * as BibTeX, equation labels, cross-references, the bibliography inset.
 *
 * Math-field keystroke semantics that these helpers encode (found empirically, see the comments on
 * each): a bare Space at a formula's top level leaves the field; Tab accepts LyX's completion
 * suggestion (needed for commands with an argument, wrong for a command that is the prefix of
 * another one); ArrowRight while a \command name is being typed only closes the name, it does not
 * move the cursor.
 */
import { expect, type Page } from '@playwright/test';

/** What "New document" (server projects.ts newDocumentText) writes for a titled, empty article. */
export function blankArticle(title: string): string {
  return `\\documentclass[11pt]{article}\n\\usepackage[T1]{fontenc}\n\\usepackage[utf8]{inputenc}\n\\usepackage{amsmath}\n\\usepackage{amssymb}\n\\usepackage{graphicx}\n\n\\begin{document}\n\\title{${title}}\n\\author{Admin}\n\\maketitle\n\n\n\\end{document}\n`;
}

export async function openPaper(page: Page, project: string, file: string) {
  await page.evaluate(() => { localStorage.setItem('ol.tabs', '[]'); });
  await page.goto(`/#/${project}/${file}`);
  await page.waitForFunction(() => document.querySelectorAll('.lyx-editor .lyx-par').length > 0, null, { timeout: 30000 });
  await page.waitForTimeout(1000);
}

/** Click the end of the (only, so far) Author paragraph and press Enter: a fresh Standard paragraph follows. */
export async function afterAuthor(page: Page) {
  await page.locator('.lyx-editor > .lyx-par.lyx-layout-author').first().click({ position: { x: 4, y: 8 } });
  await page.waitForTimeout(200);
  await page.keyboard.press('End');
  await page.keyboard.press('Enter');
  await page.waitForTimeout(200);
}

/** Alt+P chord: `key` as in LyX (a Abstract, 2 Section, 3 Subsection, i Itemize, e Enumerate, s Standard ...). */
export async function setLayout(page: Page, key: string) {
  await page.keyboard.press('Alt+p');
  await page.waitForTimeout(80);
  await page.keyboard.press(key);
  await page.waitForTimeout(150);
}

/** End of the current paragraph, then a new one (same layout as before, or Standard after a heading). */
export async function newParagraph(page: Page) {
  await page.keyboard.press('End');
  await page.keyboard.press('Enter');
  await page.waitForTimeout(100);
}

/** Paste a BibTeX entry via "Find online / paste BibTeX" and insert the citation at the cursor. */
export async function citeFromPastedBibtex(page: Page, bibtex: string, surname: string) {
  await page.keyboard.press('Control+Shift+c');
  const dialog = page.locator('.dialog');
  await expect(dialog).toContainText('Citation');
  await page.locator('[data-cite-online]').click();
  await expect(dialog).toContainText('Google Scholar');
  await page.locator('[data-cite-paste]').fill(bibtex);
  await page.locator('[data-cite-add-paste]').click();
  await expect(page.locator('[data-cite-status]')).toContainText('Added', { timeout: 15000 });
  await page.locator('[data-cite-insert]').click();
  await expect(page.locator('.lyx-editor .lyx-command-citation').last()).toContainText(surname);
}

/** \frac{num}{den}: num/den typed by the caller via the two callbacks; leaves the field back at top level. */
export async function typeFrac(page: Page, num: () => Promise<void>, den: () => Promise<void>) {
  await page.keyboard.type('\\frac'); await page.waitForTimeout(60);
  await page.keyboard.press('Tab'); await page.waitForTimeout(60);
  await num();
  await page.keyboard.press('Tab'); await page.waitForTimeout(60);
  await den();
  await page.keyboard.press('ArrowRight'); await page.waitForTimeout(60);   // out of the denominator, back to top level
}

export async function typeSqrt(page: Page, body: () => Promise<void>) {
  await page.keyboard.type('\\sqrt'); await page.waitForTimeout(60);
  await page.keyboard.press('Tab'); await page.waitForTimeout(60);
  await body();
  await page.keyboard.press('ArrowRight'); await page.waitForTimeout(60);
}

/** A superscript/subscript with (possibly multi-char) content, back out to the base afterwards. */
export async function typeScript(page: Page, mark: '^' | '_', content: string) {
  await page.keyboard.type(mark); await page.waitForTimeout(40);
  await page.keyboard.type(content); await page.waitForTimeout(40);
  await page.keyboard.press('ArrowRight'); await page.waitForTimeout(40);
}

/** A script whose content is typed by the caller (nested commands, further scripts); back out afterwards. */
export async function typeScriptWith(page: Page, mark: '^' | '_', content: () => Promise<void>) {
  await page.keyboard.type(mark); await page.waitForTimeout(40);
  await content();
  await page.keyboard.press('ArrowRight'); await page.waitForTimeout(40);
}

/** A one-argument command (\mathrm{...}, same shape as \sqrt): Tab both confirms the name and enters the argument cell. */
export async function typeSymbol(page: Page, name: string) {
  await page.keyboard.type(name); await page.waitForTimeout(60);
  await page.keyboard.press('Tab'); await page.waitForTimeout(60);
}

/** \cmd{arg} for a one-argument command with plain-text argument (\mathbb{E}, \hat{m}, \mathrm{softmax}); back at the level of the command afterwards. */
export async function typeCommandArg(page: Page, name: string, arg: string) {
  await typeSymbol(page, name);
  await page.keyboard.type(arg); await page.waitForTimeout(40);
  await page.keyboard.press('ArrowRight'); await page.waitForTimeout(40);
}

/**
 * A named symbol with no arguments (\alpha, \Theta, \gamma, \leq, ...). ArrowRight (not Tab) confirms it
 * as typed: Tab instead accepts the greyed completion suggestion, which for a command that is itself a
 * prefix of another real command (e.g. \leq / \leqq) silently over-completes to the longer one. While a
 * command name is being typed ArrowRight only closes it — the cursor stays where it is (also inside a
 * script or a fraction cell).
 */
export async function typeBareSymbol(page: Page, name: string) {
  await page.keyboard.type(name); await page.waitForTimeout(60);
  await page.keyboard.press('ArrowRight'); await page.waitForTimeout(60);
}

/** An inline formula in running text: Ctrl+M, the content typed by `body`, Escape back to the text. */
export async function inlineMath(page: Page, body: () => Promise<void>) {
  await page.keyboard.press('Control+m');
  await expect(page.locator('.lm-field.focused')).toHaveCount(1, { timeout: 5000 });
  await body();
  await page.keyboard.press('Escape');
  await page.waitForTimeout(60);
}

/** A display formula in its own paragraph (the caller is at the end of the previous paragraph). Stays inside the field. */
export async function startDisplayMath(page: Page) {
  await newParagraph(page);
  await page.keyboard.press('Control+Shift+m');
  await expect(page.locator('.lm-field.display.focused')).toHaveCount(1, { timeout: 5000 });
}

/** Alt+M T A inside a paragraph: a display formula with an AMS align environment (two columns per row). */
export async function startAlign(page: Page) {
  await newParagraph(page);
  await page.keyboard.press('Alt+m'); await page.waitForTimeout(80);
  await page.keyboard.press('t'); await page.waitForTimeout(80);
  await page.keyboard.press('a'); await page.waitForTimeout(150);
  await expect(page.locator('.lm-field.display.focused')).toHaveCount(1, { timeout: 5000 });
}

/** Give the last display formula a label through its label chip (shown once the formula is numbered). */
export async function labelLastEquation(page: Page, name: string) {
  const disp = page.locator('.lyx-math-display').last();
  await disp.locator('.eq-labels').click();
  await expect(page.locator('.dialog')).toContainText('Label');
  await page.locator('.dialog input[type=text]').fill(name);
  await page.locator('.dialog .btn.primary').click();
  await expect(disp.locator('.eq-labels')).toContainText(name);
}

/** Insert a cross-reference at the cursor through the dialog (Ctrl+Shift+I), picking the label and the format. */
export async function insertRef(page: Page, label: string, kind: 'ref' | 'eqref' | 'pageref' = 'ref') {
  await page.keyboard.press('Control+Shift+i');
  const dialog = page.locator('.dialog');
  await expect(dialog).toContainText('Cross-reference');
  await dialog.locator('.list b', { hasText: label }).click();
  await dialog.locator('select').selectOption(kind);
  await dialog.locator('.btn.primary').click();
  await expect(page.locator('.lyx-editor .lyx-command-ref').last()).toContainText(label);
}

/** Insert ▸ BibTeX bibliography… (two prompt()s: the .bib files without extension, the style). */
export async function insertBibliography(page: Page, files: string, style = 'plain') {
  const answers = [files, style];
  const onDialog = (d: import('@playwright/test').Dialog) => { void d.accept(answers.shift() ?? ''); };
  page.on('dialog', onDialog);
  await page.locator('.menubar .menu button', { hasText: 'Insert' }).first().click();
  await page.locator('.menu-list .menu-item', { hasText: 'BibTeX bibliography' }).click();
  await expect(page.locator('.lyx-editor .lyx-command-bibtex')).toHaveCount(1, { timeout: 5000 });
  page.off('dialog', onDialog);
}
