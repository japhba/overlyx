/**
 * Saving keeps the file's own LaTeX (core tex/preserve.ts): a word typed into a hard-wrapped
 * paragraph of a file brought from elsewhere changes that paragraph in the file, nothing else —
 * no reformatting, no managed block it does not need. And a heading typed after a table that ends
 * the document is a paragraph of its own (editor/commands.ts setLayout): the table stays out of
 * \section{…}, and deleting the heading's line leaves it alone.
 */
import { test, expect, type Page } from '@playwright/test';
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { login, openDoc, collectErrors, PROJECTS_DIR } from './helpers';

const PROJECT = 'admin/e2e-savekeeps';
const DIR = `${PROJECTS_DIR}/${PROJECT}`;

const PAPER = `% A paper from Overleaf
\\documentclass[11pt]{article}
\\usepackage{amsmath}
\\newcommand{\\R}{\\mathbb{R}}   % reals

\\begin{document}

\\section{Introduction}

Recent work on things has focused on
their size. We show that the size of a thing
in $x^2$ is bounded by its volume.
% TODO: cite more papers here

The second paragraph has
several lines, too.

\\end{document}
`;

const TABLE_LAST = `\\documentclass{article}
\\begin{document}
Intro paragraph before the table.

\\begin{tabular}{|c|c|c|}
\\hline
A1 & A2 & A3\\tabularnewline
\\hline
B1 & B2 & B3\\tabularnewline
\\hline
\\end{tabular}
\\end{document}
`;

test.describe.configure({ mode: 'serial' });
test.beforeAll(() => {
  rmSync(DIR, { recursive: true, force: true });
  mkdirSync(DIR, { recursive: true });
  writeFileSync(`${DIR}/paper.tex`, PAPER);
  writeFileSync(`${DIR}/table.tex`, TABLE_LAST);
});
test.afterAll(() => { rmSync(DIR, { recursive: true, force: true }); });

const saveState = (page: Page) => page.locator('.statusbar .save-state');

test('a typed word changes its paragraph in the file, and nothing else', async ({ page }) => {
  const errors = collectErrors(page);
  await login(page);
  await openDoc(page, `${PROJECT}/paper.tex`);
  await expect(saveState(page)).toHaveText(/All changes saved/, { timeout: 15000 });
  const par = page.locator('.lyx-editor > .lyx-par', { hasText: 'second paragraph' }).first();
  await par.click();
  await page.keyboard.press('End');
  await page.keyboard.type(' Typed here.');
  await expect(saveState(page)).toHaveText(/Saving/);
  await expect(saveState(page)).toHaveText(/All changes saved/, { timeout: 15000 });
  const text = readFileSync(`${DIR}/paper.tex`, 'utf8');
  // the edited paragraph is the writer's one line; every other byte is the file's own
  expect(text).toBe(PAPER.replace('The second paragraph has\nseveral lines, too.', 'The second paragraph has several lines, too. Typed here.'));
  expect(errors).toEqual([]);
});

test('a heading typed after a table that ends the document is its own paragraph; deleting it keeps the table', async ({ page }) => {
  const errors = collectErrors(page);
  await login(page);
  await openDoc(page, `${PROJECT}/table.tex`);
  await page.waitForSelector('.lyx-editor .lyx-tabular td');
  const last = page.locator('.lyx-editor > .lyx-par').last();
  const box = (await last.boundingBox())!;
  await page.mouse.click(box.x + 4, box.y + box.height - 4);
  await page.keyboard.press('Control+End');
  await page.keyboard.press('Alt+p');
  await page.keyboard.press('2');
  await page.keyboard.type('Conclusion');
  await page.keyboard.press('Enter');
  await page.keyboard.type('Body text after the heading.');
  await expect(saveState(page)).toHaveText(/All changes saved/, { timeout: 15000 });
  let text = readFileSync(`${DIR}/table.tex`, 'utf8');
  expect(text).toMatch(/\\end\{tabular\}\s*\\section\{Conclusion\}/);
  expect(text).not.toMatch(/\\section\{[^}]*\\begin\{tabular\}/);
  await expect(page.locator('.lyx-editor > .lyx-par')).toHaveCount(4);
  // the heading's line selected (Home, Shift+End) and deleted: the table stays
  const heading = page.locator('.lyx-editor > .lyx-par', { hasText: 'Conclusion' }).first();
  await heading.click();
  await page.keyboard.press('Home');
  await page.keyboard.press('Shift+End');
  await page.keyboard.press('Delete');
  await expect(saveState(page)).toHaveText(/All changes saved/, { timeout: 15000 });
  await expect(page.locator('.lyx-editor .lyx-tabular td', { hasText: 'B3' })).toHaveCount(1);
  text = readFileSync(`${DIR}/table.tex`, 'utf8');
  expect(text).toContain('B1 & B2 & B3');
  expect(text).not.toContain('Conclusion');
  expect(errors).toEqual([]);
});
