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
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { deflateSync } from 'node:zlib';
import { PROJECTS_DIR } from './helpers';

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

/**
 * Put the caret at the very end of an existing document (a later writing session continues there).
 * The click's selectionchange can arrive after the Control+End keypress and pull the caret back to
 * the click point — typing then splits the clicked paragraph mid-line — so Control+End is pressed
 * again until the selection verifiably sits in the last top-level paragraph. When the document
 * ends in an inset (a table cell, a float's caption), `escapes` Escapes then step out to the
 * paragraph holding it; the caller opens its own paragraph afterwards.
 */
export async function resumeAtEnd(page: Page, escapes = 0) {
  await page.locator('.lyx-editor > .lyx-par').last().click();
  await page.waitForTimeout(300);
  let atEnd = false;
  for (let i = 0; i < 5 && !atEnd; i++) {
    await page.keyboard.press('Control+End');
    await page.waitForTimeout(200);
    atEnd = await page.evaluate(() => {
      const pars = document.querySelectorAll('.lyx-editor > .lyx-par');
      const sel = document.getSelection();
      if (!pars.length || !sel || !sel.rangeCount) return false;
      return pars[pars.length - 1].contains(sel.getRangeAt(0).startContainer);
    });
  }
  if (!atEnd) throw new Error('Control+End never reached the last paragraph');
  for (let i = 0; i < escapes; i++) { await page.keyboard.press('Escape'); await page.waitForTimeout(120); }
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

/**
 * Insert a cross-reference at the cursor through the dialog (Ctrl+Shift+I), picking the label and the
 * format. A label that does not exist yet (a figure or section further down the paper — a forward
 * reference) is typed into the dialog's "Selected" field instead.
 */
export async function insertRef(page: Page, label: string, kind: 'ref' | 'eqref' | 'pageref' = 'ref') {
  await page.keyboard.press('Control+Shift+i');
  const dialog = page.locator('.dialog');
  await expect(dialog).toContainText('Cross-reference');
  const row = dialog.locator('.list b', { hasText: new RegExp(`^${label.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`) });
  if (await row.count()) await row.click();
  else await dialog.locator('.row', { hasText: 'Selected' }).locator('input').fill(label);
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

/* ------------------------------------------------------------------ full papers (paperwriting-gan / -adam) */

/** Commands with one argument cell entered with Tab (the name is finalized as typed, then the cursor sits in the argument). */
const ONE_ARG = new Set(['hat', 'bar', 'tilde', 'vec', 'dot', 'ddot', 'overline', 'underline', 'widehat', 'widetilde', 'sqrt', 'mathbb', 'mathrm', 'mathcal', 'mathbf', 'mathit', 'mathsf', 'mathtt', 'boldsymbol', 'operatorname']);
const TWO_ARGS = new Set(['frac', 'dfrac', 'tfrac', 'binom']);

/**
 * Type a formula given as LaTeX, keystroke by keystroke, the way an author would in the LyX math
 * field: `\name` without an argument is confirmed with ArrowRight (Tab would take a completion),
 * `\frac{}{}` / `\sqrt{}` / `\hat{}` … are entered with Tab and their cells left with ArrowRight,
 * `_{…}` / `^{…}` become scripts left with ArrowRight, `\left( … \right)` is typed literally (the
 * field pairs the delimiters), `&` is Tab (next align column) and `\\` Enter + Shift+Tab (next row,
 * first column). Spaces are skipped (a bare Space would leave the field); bare braces are not
 * supported (use \lbrace / \rbrace for the literal ones).
 */
export async function typeLatex(page: Page, latex: string): Promise<void> {
  const s = latex;
  let i = 0;
  const key = async (k: string) => { await page.keyboard.press(k); await page.waitForTimeout(25); };
  const bare = async (name: string) => { await page.keyboard.type(name); await page.waitForTimeout(30); await key('ArrowRight'); };
  const readArg = (): string => {
    while (s[i] === ' ') i++;
    if (s[i] === '{') {
      let depth = 0;
      for (let j = i; j < s.length; j++) {
        if (s[j] === '{') depth++;
        else if (s[j] === '}') { depth--; if (depth === 0) { const a = s.slice(i + 1, j); i = j + 1; return a; } }
      }
      throw new Error('unbalanced braces in ' + s);
    }
    if (s[i] === '\\') { const m = /^\\[A-Za-z]+/.exec(s.slice(i)); if (m) { i += m[0].length; return m[0]; } }
    return s[i++];
  };
  while (i < s.length) {
    const ch = s[i];
    if (ch === ' ') { i++; continue; }
    if (ch === '\\') {
      if (s[i + 1] === '\\') { i += 2; await key('Enter'); await key('Shift+Tab'); continue; }
      const m = /^\\([A-Za-z]+)/.exec(s.slice(i));
      if (!m) { await page.keyboard.type(s.slice(i, i + 2)); i += 2; await page.waitForTimeout(40); continue; }   // \, \; …
      const name = m[1];
      i += m[0].length;
      if (name === 'left' || name === 'right') {
        while (s[i] === ' ') i++;
        const d = s[i++];
        if (!'([|.)]'.includes(d)) throw new Error(`\\${name}${d}: only ( [ | . ) ] delimiters are supported`);
        await page.keyboard.type('\\' + name + d); await page.waitForTimeout(60);
        continue;
      }
      if (TWO_ARGS.has(name)) {
        const a = readArg(), b = readArg();
        await typeSymbol(page, '\\' + name); await typeLatex(page, a); await key('Tab'); await typeLatex(page, b); await key('ArrowRight');
        continue;
      }
      if (ONE_ARG.has(name)) {
        const a = readArg();
        await typeSymbol(page, '\\' + name); await typeLatex(page, a); await key('ArrowRight');
        continue;
      }
      await bare('\\' + name);
      continue;
    }
    if (ch === '_' || ch === '^') {
      i++;
      const a = readArg();
      await page.keyboard.type(ch); await page.waitForTimeout(25);
      await typeLatex(page, a);
      await key('ArrowRight');
      continue;
    }
    if (ch === '&') { i++; await key('Tab'); continue; }
    if (ch === '{' || ch === '}') throw new Error('bare braces are not supported in typeLatex: ' + s);
    await page.keyboard.type(ch); i++;
  }
}

/** An inline formula typed from LaTeX (Ctrl+M … Escape). */
export const inlineLatex = (page: Page, latex: string) => inlineMath(page, () => typeLatex(page, latex));

/**
 * A display formula in its own paragraph typed from LaTeX; `numbered` toggles the equation number
 * (Alt+M N) and `label` names it through the label chip. Rows separated by `\\` (and `&` columns)
 * make it an align (Alt+M T A). Ends outside the formula.
 */
export async function displayLatex(page: Page, latex: string, opts: { numbered?: boolean; label?: string } = {}): Promise<void> {
  if (latex.includes('\\\\') || latex.includes('&')) await startAlign(page); else await startDisplayMath(page);
  await typeLatex(page, latex);
  if (opts.numbered && !latex.includes('&')) { await page.keyboard.press('Alt+m'); await page.keyboard.press('n'); }
  await page.keyboard.press('Escape');
  await page.waitForTimeout(60);
  if (opts.label) await labelLastEquation(page, opts.label);
}

/**
 * Canonical form of LaTeX math for comparing what was typed with what the writer saved: no
 * whitespace, and a superscript/subscript pair in subscript-first order (the writer keeps the
 * order the scripts were typed in).
 */
export const canonMath = (s: string) => s.replace(/\s+/g, '').replace(/\^\{((?:[^{}]|\{[^{}]*\})*)\}_\{((?:[^{}]|\{[^{}]*\})*)\}/g, '_{$2}^{$1}');

/** Document ▸ Settings…: set the LyX modules (comma separated) and apply; waits until the layout list has the module's layouts. */
export async function setModules(page: Page, modules: string, expectLayout: string) {
  await page.locator('.menubar .menu button', { hasText: 'Document' }).first().click();
  await page.locator('.menu-list .menu-item', { hasText: 'Settings' }).click();
  await expect(page.locator('.dialog')).toContainText('Document Settings');
  await page.locator('.dialog input[placeholder^="e.g. theorems-ams"]').fill(modules);
  await page.locator('.dialog .btn.primary').click();
  await expect(page.locator('select[title^="Paragraph layout"] option', { hasText: new RegExp(`^${expectLayout}$`) })).toHaveCount(1, { timeout: 10000 });
}

/** Pick a paragraph layout from the toolbar's layout list (for the ones without an Alt+P key: Theorem, Proposition, Proof …). */
export async function selectLayout(page: Page, name: string) {
  await page.locator('select[title^="Paragraph layout"]').selectOption(name);
  await page.waitForTimeout(150);
}

/** Insert ▸ Float ▸ Figure / Table / Algorithm at the cursor; the cursor ends up in the float's first paragraph. */
export async function insertFloat(page: Page, kind: 'Figure' | 'Table' | 'Algorithm') {
  const before = await page.locator('.lyx-editor .lyx-inset-float').count();
  await page.locator('.menubar .menu button', { hasText: 'Insert' }).first().click();
  await page.locator('.menu-list .menu-item', { hasText: 'Float' }).hover();
  await page.waitForTimeout(250);
  await page.locator('.menu-list .menu-item', { hasText: new RegExp(`^${kind}$`) }).click();
  await expect(page.locator('.lyx-editor .lyx-inset-float')).toHaveCount(before + 1);
  await page.waitForTimeout(150);
}

/** Ctrl+Shift+G, Upload… (the browser's file chooser), Insert: the image lands in figures/ and an \includegraphics at the cursor. */
export async function uploadGraphics(page: Page, path: string) {
  const before = await page.locator('.lyx-editor .lyx-graphics').count();
  await page.keyboard.press('Control+Shift+g');
  await expect(page.locator('.dialog')).toContainText('Graphics');
  const [chooser] = await Promise.all([page.waitForEvent('filechooser'), page.locator('.dialog button', { hasText: 'Upload' }).click()]);
  await chooser.setFiles(path);
  await expect(page.locator('.dialog .btn.primary')).toBeEnabled({ timeout: 10000 });
  await page.waitForTimeout(300);
  await page.locator('.dialog .btn.primary').click();
  await expect(page.locator('.lyx-editor .lyx-graphics')).toHaveCount(before + 1, { timeout: 10000 });
}

/** Ctrl+Alt+L at the cursor: a \label with the given name (the dialog suggests one from the context). */
export async function insertLabel(page: Page, name: string) {
  await page.keyboard.press('Control+Alt+l');
  await expect(page.locator('.dialog')).toContainText('Label');
  await page.locator('.dialog input[type=text]').first().fill(name);
  await page.locator('.dialog .btn.primary').click();
  await expect(page.locator('.lyx-editor .lyx-command-label', { hasText: name })).toHaveCount(1);
}

/** With the cursor in a float's caption: type the caption (text or a callback for text with formulas) and label it. */
export async function typeCaption(page: Page, caption: string | (() => Promise<void>), label: string) {
  if (typeof caption === 'string') await page.keyboard.type(caption); else await caption();
  await insertLabel(page, label);
}

/** Escape out of the caption and the float: the cursor is back in the paragraph holding the float, right after it. */
export async function leaveFloat(page: Page, levels = 2) {
  for (let i = 0; i < levels; i++) { await page.keyboard.press('Escape'); await page.waitForTimeout(80); }
}

/** Cite an entry that is already in the project's bibliography (picked from the dialog's "In this project" list by author/key text). */
export async function citeExisting(page: Page, needle: string | string[]) {
  await page.keyboard.press('Control+Shift+c');
  const dialog = page.locator('.dialog');
  await expect(dialog).toContainText('Citation');
  for (const n of Array.isArray(needle) ? needle : [needle]) await dialog.locator('.list > div', { hasText: n }).first().click();
  await dialog.locator('[data-cite-insert]').click();
  await expect(page.locator('.dialog')).toHaveCount(0);
}

/** Several BibTeX entries pasted in one dialog session: a single \cite{a,b,…} at the cursor. */
export async function citeFromPastedBibtexMany(page: Page, entries: { bibtex: string; surname: string }[]): Promise<string[]> {
  await page.keyboard.press('Control+Shift+c');
  const dialog = page.locator('.dialog');
  await expect(dialog).toContainText('Citation');
  await page.locator('[data-cite-online]').click();
  const keys: string[] = [];
  for (const e of entries) {
    await page.locator('[data-cite-paste]').fill(e.bibtex);
    await page.locator('[data-cite-add-paste]').click();
    const status = page.locator('[data-cite-status]');
    await expect(status).toContainText(/(Added|Already in the project as) \[/, { timeout: 15000 });
    keys.push(/\[([^\]]+)\]/.exec(await status.innerText())![1]);   // the key the server derived (surname + year + first title word)
  }
  await page.locator('[data-cite-insert]').click();
  await expect(page.locator('.lyx-editor .lyx-command-citation').last()).toContainText(entries[0].surname);
  return keys;
}

/**
 * A blank "New document" article for a paper typed from scratch. The server is told to forget any
 * earlier copy of the document first (an instance that still has it open from a previous run would
 * merge the old paragraphs back into the fresh file a moment later and wipe what was typed in
 * between), then the project is listed so that a directory created by the spec is adopted.
 */
export async function freshPaper(page: Page, project: string, file: string, title: string, opts: { resetBib?: boolean } = {}) {
  const dir = `${PROJECTS_DIR}/${project}`;
  mkdirSync(dir, { recursive: true });
  await page.request.post(`/api/docs/${encodeURIComponent(`${project}/${file}`)}/reset`).catch(() => {});
  writeFileSync(`${dir}/${file}`, blankArticle(title));
  if (opts.resetBib) rmSync(`${dir}/cited.bib`, { force: true });
  await page.request.get('/api/projects');
}

/** A small valid PNG (solid colour with a darker frame) to upload as a figure — no image tools needed. */
export function placeholderPng(path: string, width = 320, height = 200, rgb: [number, number, number] = [70, 130, 180]) {
  const raw = Buffer.alloc((width * 3 + 1) * height);
  for (let y = 0; y < height; y++) {
    raw[y * (width * 3 + 1)] = 0;   // filter: none
    for (let x = 0; x < width; x++) {
      const edge = x < 4 || y < 4 || x >= width - 4 || y >= height - 4;
      const o = y * (width * 3 + 1) + 1 + x * 3;
      raw[o] = edge ? rgb[0] >> 1 : rgb[0]; raw[o + 1] = edge ? rgb[1] >> 1 : rgb[1]; raw[o + 2] = edge ? rgb[2] >> 1 : rgb[2];
    }
  }
  const crcTable = Array.from({ length: 256 }, (_, n) => { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; return c >>> 0; });
  const crc32 = (buf: Buffer) => { let c = 0xffffffff; for (const b of buf) c = crcTable[(c ^ b) & 0xff] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; };
  const chunk = (type: string, data: Buffer) => {
    const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
    const td = Buffer.concat([Buffer.from(type, 'ascii'), data]);
    const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(td));
    return Buffer.concat([len, td, crc]);
  };
  const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(width, 0); ihdr.writeUInt32BE(height, 4); ihdr[8] = 8; ihdr[9] = 2; ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0;
  writeFileSync(path, Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk('IHDR', ihdr), chunk('IDAT', deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]));
}
