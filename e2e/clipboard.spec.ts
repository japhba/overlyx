/**
 * Copy & paste: insets survive a copy/paste inside the editor (citations, cross-references,
 * formulas, quotes); the plain-text clipboard carries LaTeX-ish text; foreign HTML pastes as
 * LyX content.
 */
import { test, expect, type Page } from '@playwright/test';
import { mkdirSync, copyFileSync, rmSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import { login, collectErrors, PROJECTS_DIR, FIXTURES_DIR, withPreambleOf } from './helpers';

const SRC = `${FIXTURES_DIR}/recurrent_feature`;
const PROJECT = 'e2e-clip';
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
  await context.grantPermissions(['clipboard-read', 'clipboard-write']);
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
  const plain = await page.evaluate(() => navigator.clipboard.readText());
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
  expect(count(text, /``quoted''/g)).toBe(2);
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
    document.querySelector('.lyx-editor')!.dispatchEvent(new ClipboardEvent('paste', { clipboardData: dt, bubbles: true, cancelable: true }));
  });
  await expect(page.locator('.lyx-editor .lyx-layout-subsection')).toHaveCount(1, { timeout: 5000 });
  await expect.poll(() => readFileSync(`${DIR}/clip.tex`, 'utf8').includes('\\subsection{Pasted title}'), { timeout: 15000 }).toBe(true);
  const text = readFileSync(`${DIR}/clip.tex`, 'utf8');
  expect(text).toContain('\\textbf{bold}');
  expect(text).toContain('\\emph{italic}');
});
