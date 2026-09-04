/**
 * Google-Docs-style paragraph keys and markdown triggers, and tracked changes on formulas:
 *  - Ctrl+0…6 set the heading layouts (LyX's Alt+P digits), Ctrl+Alt+digit the * variants;
 *    a level the class lacks (Chapter in an article) leaves the paragraph alone;
 *  - `- ` at a paragraph start starts a bullet list, `1. ` a numbered one, `## ` a subsection;
 *    Backspace right after brings the marker back;
 *  - a formula inserted (or pasted from LaTeX) while tracking changes is coloured like inserted
 *    text, and the .tex carries it inside \lyxadded. Needs the seeded admin.
 */
import { test, expect } from '@playwright/test';
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { login, openDoc, texDoc, PROJECTS_DIR } from './helpers';

const PROJECT = 'e2e-layoutkeys';
const DIR = `${PROJECTS_DIR}/${PROJECT}`;

test.describe.configure({ mode: 'serial' });

test.beforeAll(() => {
  rmSync(DIR, { recursive: true, force: true });
  mkdirSync(DIR, { recursive: true });
  writeFileSync(`${DIR}/keys.tex`, texDoc('First paragraph.\n\nSecond paragraph.\n\nThird paragraph.'));
  writeFileSync(`${DIR}/md.tex`, texDoc('Intro paragraph.\n\n'));
  writeFileSync(`${DIR}/ct.tex`, texDoc('Tracked paragraph with words.'));
});
test.afterAll(() => { rmSync(DIR, { recursive: true, force: true }); });

test('Ctrl+digit sets the heading level, Ctrl+Alt+digit the unnumbered one; unknown levels do nothing', async ({ page }) => {
  await login(page);
  await openDoc(page, `${PROJECT}/keys.tex`);
  const pars = page.locator('.lyx-editor > .lyx-par');
  await pars.nth(0).click({ position: { x: 4, y: 8 } });
  await page.keyboard.press('Control+2');
  await expect(pars.nth(0)).toHaveAttribute('data-layout', 'Section');
  await page.keyboard.press('Control+3');
  await expect(pars.nth(0)).toHaveAttribute('data-layout', 'Subsection');
  await page.keyboard.press('Control+Alt+3');
  await expect(pars.nth(0)).toHaveAttribute('data-layout', 'Subsection*');
  await page.keyboard.press('Control+0');
  await expect(pars.nth(0)).toHaveAttribute('data-layout', 'Part');
  // an article has no Chapter: the key is swallowed, the paragraph keeps its layout
  await page.keyboard.press('Control+1');
  await expect(pars.nth(0)).toHaveAttribute('data-layout', 'Part');
  // the menu lists the styles with their keys (rebindable in the palette)
  await page.locator('.menubar .menu button', { hasText: 'Edit' }).click();
  await page.locator('.menu-item.menu-sub', { hasText: 'Paragraph style' }).hover();
  await expect(page.locator('.menu-item:not(.menu-sub):has(span:text-is("Section"))').locator('.shortcut')).toHaveText(/Ctrl\+2|⌘2/);
  await expect(page.locator('.menu-item:not(.menu-sub):has(span:text-is("Subparagraph* (unnumbered)"))').locator('.shortcut')).toHaveText(/Ctrl\+Alt\+6|⌥⌘6/);
  await page.keyboard.press('Escape');
  // written as LaTeX sectioning
  await expect.poll(() => readFileSync(`${DIR}/keys.tex`, 'utf8'), { timeout: 15000 }).toContain('\\part{First paragraph.}');
});

test('"- ", "1. " and "## " at a paragraph start become a bullet, a numbered item and a heading; Backspace undoes the trigger', async ({ page }) => {
  await login(page);
  await openDoc(page, `${PROJECT}/md.tex`);
  await page.waitForTimeout(500);   // the sync's cursor restore (start of the document) must not undo the End below
  const pars = page.locator('.lyx-editor > .lyx-par');
  await pars.nth(0).click({ position: { x: 4, y: 8 } });
  await page.keyboard.press('End');
  await page.waitForTimeout(100);   // Chromium reports the caret move (selectionchange) asynchronously; Enter must see it
  await page.keyboard.press('Enter');
  await page.keyboard.type('- first point');
  await expect(pars.nth(1)).toHaveAttribute('data-layout', 'Itemize');
  await expect(pars.nth(1)).toHaveText(/^first point$/);
  await page.keyboard.press('Enter');
  await page.keyboard.type('second point');   // Enter in a list continues it
  await expect(pars.nth(2)).toHaveAttribute('data-layout', 'Itemize');
  // out of the list with Alt+Enter (LyX: a new Standard paragraph) — then a numbered list
  await page.keyboard.press('Alt+Enter');
  await expect(pars.nth(3)).toHaveAttribute('data-layout', 'Standard');
  await page.keyboard.type('1. numbered');
  await expect(pars.nth(3)).toHaveAttribute('data-layout', 'Enumerate');
  await expect(pars.nth(3)).toHaveText(/^numbered$/);
  await page.keyboard.press('Alt+Enter');
  await page.keyboard.type('## Heading here');
  await expect(pars.nth(4)).toHaveAttribute('data-layout', 'Subsection');
  await expect(pars.nth(4)).toHaveText(/^Heading here$/);
  // Backspace right after the trigger restores the typed marker
  await page.keyboard.press('Enter');
  await page.keyboard.type('- ');
  await expect(pars.nth(5)).toHaveAttribute('data-layout', 'Itemize');
  await page.keyboard.press('Backspace');
  await expect(pars.nth(5)).toHaveAttribute('data-layout', 'Standard');
  await expect(pars.nth(5)).toHaveText('- ');
  // "2. " and a dash mid-sentence are left alone
  await page.keyboard.type('and - not a list');
  await expect(pars.nth(5)).toHaveAttribute('data-layout', 'Standard');
  await expect.poll(() => readFileSync(`${DIR}/md.tex`, 'utf8'), { timeout: 15000 }).toMatch(/\\begin\{itemize\}\n\\item first point\n\\item second point\n\\end\{itemize\}/);
  expect(readFileSync(`${DIR}/md.tex`, 'utf8')).toContain('\\subsection{Heading here}');
});

test('a formula inserted while tracking changes is coloured as an insertion and lands in \\lyxadded', async ({ page, context }) => {
  await context.grantPermissions(['clipboard-read', 'clipboard-write']);
  await login(page);
  await openDoc(page, `${PROJECT}/ct.tex`);
  await page.waitForTimeout(500);
  const par = page.locator('.lyx-editor > .lyx-par').first();
  await par.click({ position: { x: 4, y: 8 } });
  await page.keyboard.press('Control+Shift+e');
  await expect(page.locator('.statusbar .tracking')).toHaveText(/tracking changes as/);
  await page.keyboard.press('End');
  await page.waitForTimeout(100);
  await page.keyboard.type(' plus ');
  await page.keyboard.press('Control+m');
  await page.keyboard.type('x^2');
  await page.keyboard.press('Escape');
  const math = page.locator('.lyx-editor .lyx-math-inline');
  await expect(math).toHaveCount(1);
  await expect(math).toHaveClass(/lyx-change-inserted/);
  await expect(math).toHaveAttribute('data-changed', 'inserted');
  // the formula takes the same colour as the inserted text beside it (the author's colour)
  const colours = await page.evaluate(() => {
    const text = document.querySelector('.lyx-editor .lyx-change-inserted:not(.lyx-math-inline)')!;
    const m = document.querySelector('.lyx-editor .lyx-math-inline')!;
    const glyph = m.querySelector('.katex, .lm-field') ?? m;
    return { text: getComputedStyle(text).color, math: getComputedStyle(glyph).color, plain: getComputedStyle(document.querySelector('.lyx-editor > .lyx-par')!).color };
  });
  expect(colours.math).toBe(colours.text);
  expect(colours.math).not.toBe(colours.plain);
  // pasted LaTeX with a formula is tracked too, node included
  await page.keyboard.press('End');
  await page.waitForTimeout(100);
  await page.evaluate(() => navigator.clipboard.writeText(' and $y_1$ too').catch(() => {}));
  await page.keyboard.press('Control+v');
  await expect(page.locator('.lyx-editor .lyx-math-inline.lyx-change-inserted')).toHaveCount(2, { timeout: 10000 });
  await expect.poll(() => readFileSync(`${DIR}/ct.tex`, 'utf8'), { timeout: 15000 }).toMatch(/\\lyxadded\{[^}]*\}\{[^}]*\}\{ plus \$x\^\{?2\}?\$/);
});
