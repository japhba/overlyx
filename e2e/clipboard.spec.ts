/**
 * Copy & paste: insets survive a copy/paste inside the editor (citations, cross-references,
 * formulas, quotes); the plain-text clipboard carries LaTeX-ish text; foreign HTML pastes as
 * LyX content.
 */
import { test, expect, type Page } from '@playwright/test';
import { mkdirSync, copyFileSync, rmSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import { login, collectErrors, PROJECTS_DIR, FIXTURES_DIR, withPreambleOf, grantClipboard, readClipboard, browserName } from './helpers';

const SRC = `${FIXTURES_DIR}/recurrent_feature`;
const PROJECT = 'admin/e2e-clip';
const DIR = `${PROJECTS_DIR}/${PROJECT}`;

const doc = () => withPreambleOf(`${SRC}/main.tex`, `\\section{Intro}\\label{sec:intro}

Cite \\citep{Hubel59} ref \\ref{sec:intro} math $E=mc^{2}$ \`\`quoted'' end

Last paragraph.
`);

test.beforeAll(() => {
  rmSync(DIR, { recursive: true, force: true });
  mkdirSync(DIR, { recursive: true });
  for (const f of ['bib.bib', 'lyxmacros.tex', 'macros.tex', 'preamble.tex']) if (existsSync(`${SRC}/${f}`)) copyFileSync(`${SRC}/${f}`, `${DIR}/${f}`);
  writeFileSync(`${DIR}/clip.tex`, doc());
});
test.afterAll(() => { rmSync(DIR, { recursive: true, force: true }); });

async function open(page: Page) {
  await page.evaluate(() => { localStorage.setItem('ol.tabs', '[]'); });
  await page.goto(`/#/${PROJECT}/clip.tex`);
  await page.waitForFunction(() => document.querySelectorAll('.lyx-editor .lyx-par').length >= 3, null, { timeout: 60000 });
  await page.waitForFunction(() => !document.querySelector('.lyx-editor')?.closest('[aria-busy="true"]'), null, { timeout: 10000 }).catch(() => {});
  await page.waitForTimeout(1500);
}

const count = (text: string, re: RegExp) => (text.match(re) ?? []).length;

test('copying a paragraph and pasting it keeps citations, references, formulas and quotes', async ({ page, context }) => {
  await grantClipboard(context);
  const errors = collectErrors(page);
  await login(page);
  await open(page);
  // select the whole second paragraph (the one with the insets) and copy it
  const par = page.locator('.lyx-editor .lyx-par').nth(1);
  await par.click({ position: { x: 5, y: 8 } });
  // select the paragraph's content (a keyboard Shift+End is not reliable in headless Chromium)
  await page.evaluate(() => {
    const v = (window as any).overlyx.activeView;
    const $p = v.state.selection.$from;
    const start = $p.start(1), end = $p.end(1);
    v.dispatch(v.state.tr.setSelection(v.state.selection.constructor.create(v.state.doc, start, end)));
  });
  await page.keyboard.press('Control+c');
  // the text/plain form is LaTeX-ish
  const plain = await readClipboard(page);
  expect(plain).toContain('\\citep{Hubel59}');
  expect(plain).toContain('\\ref{sec:intro}');
  expect(plain).toContain('$E=mc^{2}$');
  expect(plain).toContain('“quoted”');
  // paste it into the last paragraph
  const last = page.locator('.lyx-editor .lyx-par').nth(2);
  await last.click();
  await page.keyboard.press('End');
  await page.keyboard.press('Enter');
  await page.keyboard.press('Control+v');
  await expect(page.locator('.lyx-editor .lyx-command-citation')).toHaveCount(2, { timeout: 5000 });
  await expect(page.locator('.lyx-editor .lyx-command-ref')).toHaveCount(2);
  // …and the file on disk has both copies, as proper insets
  await expect.poll(() => count(readFileSync(`${DIR}/clip.tex`, 'utf8'), /\\citep\{Hubel59\}/g), { timeout: 15000 }).toBe(2);
  const text = readFileSync(`${DIR}/clip.tex`, 'utf8');
  expect(count(text, /\\ref\{sec:intro\}/g)).toBe(2);
  expect(count(text, /\$E=mc\^\{2\}\$/g)).toBe(2);
  // Playwright's WebKit keeps only text/plain on its pasteboard (Safari keeps the HTML as well): there the paste
  // takes the LaTeX-ish plain text, whose quotes are typographic characters rather than quote insets
  expect(count(text, browserName(page) === 'webkit' ? /``quoted''|“quoted”/g : /``quoted''/g)).toBe(2);
  expect(errors).toEqual([]);
});

test('a section with a comment thread, a note box and a table keeps them whole through copy, cut and paste', async ({ page, context }) => {
  await grantClipboard(context);
  const errors = collectErrors(page);
  const FILE = `${DIR}/notes.tex`;
  writeFileSync(FILE, withPreambleOf(`${SRC}/main.tex`, `\\section{Alpha}

Alpha first paragraph with a comment here.
%% @comment
%% Admin (2026-10-05 10:00):
%%
%% Comment on alpha.
%% @end
And more alpha text.

Alpha second paragraph with a note box.
%% @note
%% A yellow note inside alpha.
%% @end

\\begin{tabular}{cc}
a & b\\tabularnewline
c & d\\tabularnewline
\\end{tabular}

\\section{Beta}

Beta paragraph.
`));
  await login(page);
  await page.evaluate(() => { localStorage.setItem('ol.tabs', '[]'); });
  await page.goto(`/#/${PROJECT}/notes.tex`);
  await page.waitForFunction(() => document.querySelectorAll('.lyx-editor > .lyx-par').length >= 5, null, { timeout: 60000 });
  await page.waitForTimeout(1500);
  // select from the start of the "Alpha" heading to the end of its last paragraph (the table's)
  const selectAlpha = () => page.evaluate(() => {
    const v = (window as any).overlyx.activeView;
    let from = -1, to = -1, seen = false;
    v.state.doc.forEach((n: any, off: number) => {
      if (n.attrs.layout === 'Section') seen = n.textContent === 'Alpha' && from < 0;
      if (seen && from < 0) from = off + 1;
      if (seen) to = off + n.nodeSize - 1;
    });
    v.dispatch(v.state.tr.setSelection(v.state.selection.constructor.create(v.state.doc, from, to)));
    v.focus();
  });
  const pasteAtEnd = async () => {
    await page.evaluate(() => {
      const v = (window as any).overlyx.activeView;
      v.dispatch(v.state.tr.setSelection(v.state.selection.constructor.create(v.state.doc, v.state.doc.content.size - 1)));
      v.focus();
    });
    await page.keyboard.press('Enter');
    await page.keyboard.press('Control+v');
  };
  const file = () => readFileSync(FILE, 'utf8');
  await selectAlpha();
  await page.keyboard.press('Control+c');
  await pasteAtEnd();
  await expect.poll(() => count(file(), /\\section\{Alpha\}/g), { timeout: 15000 }).toBe(2);
  // the copy: a heading, the thread with its header and text, the note's text, the table — inside their insets
  await expect.poll(() => count(file(), /%% @comment\n%% Admin \(2026-10-05 10:00\):\n%%\n%% Comment on alpha\.\n%% @end/g)).toBe(2);
  expect(count(file(), /%% @note\n%% A yellow note inside alpha\.\n%% @end/g)).toBe(2);
  expect(count(file(), /\\begin\{tabular\}/g)).toBe(2);
  expect(count(file(), /^Comment on alpha\.|^A yellow note inside alpha\./gm)).toBe(0);
  await expect(page.locator('.lyx-editor .lyx-inset-note-comment')).toHaveCount(2);
  await expect(page.locator('.lyx-editor .lyx-inset-note-note')).toHaveCount(2);
  // cut the first Alpha and paste it at the end: moved, nothing lost
  await selectAlpha();
  await page.keyboard.press('Control+x');
  await pasteAtEnd();
  await expect.poll(() => file().indexOf('\\section{Beta}') < file().indexOf('\\section{Alpha}'), { timeout: 15000 }).toBe(true);
  await expect.poll(() => count(file(), /%% @comment\n%% Admin \(2026-10-05 10:00\):\n%%\n%% Comment on alpha\.\n%% @end/g)).toBe(2);
  expect(count(file(), /\\section\{Alpha\}/g)).toBe(2);
  expect(count(file(), /%% @note\n%% A yellow note inside alpha\.\n%% @end/g)).toBe(2);
  expect(count(file(), /\\begin\{tabular\}/g)).toBe(2);
  expect(errors).toEqual([]);
});

test('foreign HTML pastes as document content (bold, italics, a heading)', async ({ page }) => {
  await login(page);
  await open(page);
  const last = page.locator('.lyx-editor .lyx-par').nth(2);
  await last.click();
  await page.keyboard.press('End');
  await page.keyboard.press('Enter');
  await page.evaluate(() => {
    const dt = new DataTransfer();
    dt.setData('text/html', '<h2>Pasted title</h2><p>Some <b>bold</b> and <i>italic</i> words</p>');
    dt.setData('text/plain', 'Pasted title\nSome bold and italic words');
    document.querySelector('.lyx-editor')!.dispatchEvent(Object.defineProperty(new ClipboardEvent('paste', { clipboardData: dt, bubbles: true, cancelable: true }), 'clipboardData', { value: dt }));
  });
  await expect(page.locator('.lyx-editor .lyx-layout-subsection')).toHaveCount(1, { timeout: 5000 });
  await expect.poll(() => readFileSync(`${DIR}/clip.tex`, 'utf8').includes('\\subsection{Pasted title}'), { timeout: 15000 }).toBe(true);
  const text = readFileSync(`${DIR}/clip.tex`, 'utf8');
  expect(text).toContain('\\textbf{bold}');
  expect(text).toContain('\\emph{italic}');
});

test('plain-text LaTeX pastes as real structure: a section, a formula, bold text and a reference', async ({ page }) => {
  await login(page);
  await open(page);
  const last = page.locator('.lyx-editor .lyx-par').nth(2);
  await last.click();
  await page.keyboard.press('End');
  await page.keyboard.press('Enter');
  const refsBefore = await page.locator('.lyx-editor .lyx-command-ref').count();   // the earlier tests of this file paste ref copies of their own
  await page.evaluate(() => {
    const dt = new DataTransfer();
    dt.setData('text/plain', '\\subsection{LaTeX paste}\n\nWith $a^{2}+b$ inline, \\textbf{bold words} and \\ref{sec:intro}.');
    document.querySelector('.lyx-editor')!.dispatchEvent(Object.defineProperty(new ClipboardEvent('paste', { clipboardData: dt, bubbles: true, cancelable: true }), 'clipboardData', { value: dt }));
  });
  await expect(page.locator('.lyx-editor .lyx-layout-subsection', { hasText: 'LaTeX paste' })).toHaveCount(1, { timeout: 10000 });
  await expect(page.locator('.lyx-editor .lyx-command-ref')).toHaveCount(refsBefore + 1);
  await expect.poll(() => readFileSync(`${DIR}/clip.tex`, 'utf8').includes('\\subsection{LaTeX paste}'), { timeout: 15000 }).toBe(true);
  const text = readFileSync(`${DIR}/clip.tex`, 'utf8');
  expect(text).toContain('$a^{2}+b$');
  expect(text).toContain('\\textbf{bold words}');
  expect(text).toContain('\\ref{sec:intro}');
  // plain prose without LaTeX still pastes as plain paragraphs
  await page.keyboard.press('Enter');
  await page.evaluate(() => {
    const dt = new DataTransfer();
    dt.setData('text/plain', 'Just ordinary words.');
    document.querySelector('.lyx-editor')!.dispatchEvent(Object.defineProperty(new ClipboardEvent('paste', { clipboardData: dt, bubbles: true, cancelable: true }), 'clipboardData', { value: dt }));
  });
  await expect.poll(() => readFileSync(`${DIR}/clip.tex`, 'utf8').includes('Just ordinary words.'), { timeout: 15000 }).toBe(true);
});
