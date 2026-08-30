import { test, expect, type Page } from '@playwright/test';
import { readFileSync, writeFileSync, mkdirSync, existsSync, copyFileSync } from 'node:fs';
import { login, openDoc, collectErrors, PROJECTS_DIR, FIXTURES_DIR, withPreambleOf } from './helpers';

/** Each test works on its own copy of a document inside a scratch project. */
const PROJECT = 'e2e-scratch';
const DIR = `${PROJECTS_DIR}/${PROJECT}`;

function freshDoc(name: string): string {
  mkdirSync(DIR, { recursive: true });
  // a self-contained master document (notes/notes.tex is a child fragment without \begin{document})
  const src = readFileSync(`${FIXTURES_DIR}/bayesian_chaos/notes/spectral_projection.tex`, 'utf8');
  const file = `${DIR}/${name}.tex`;
  writeFileSync(file, src);
  return `${PROJECT}/${name}.tex`;
}

const fileText = (id: string) => readFileSync(PROJECTS_DIR + '/' + id, 'utf8');
/** Put the cursor at the start of the first Standard paragraph (click its top-left corner: no inline insets there). */
async function firstStandard(page: Page) {
  const p = page.locator('.lyx-editor > .lyx-par.lyx-layout-standard').first();
  await p.click({ position: { x: 4, y: 10 } });
  await page.keyboard.press('Home');
  return p;
}

test.beforeEach(async ({ page }) => { await login(page); });

test('inline and display math are edited in place and saved as LaTeX formulas', async ({ page }) => {
  const errors = collectErrors(page);
  const id = freshDoc('math-' + Date.now());
  await openDoc(page, id);
  await firstStandard(page);
  await page.keyboard.type(' MATHTEST ');
  await page.keyboard.press('Control+m');            // inline formula (LyX: math-mode)
  const mf = page.locator('.lm-field.focused');
  await expect(mf).toHaveCount(1, { timeout: 5000 });
  await page.keyboard.type('a^2'); await page.keyboard.press('ArrowRight');   // leave the superscript (as in LyX)
  await page.keyboard.type('+b^2'); await page.keyboard.press('ArrowRight');
  await page.keyboard.type('=c^2');
  await page.keyboard.press('Escape');               // leave the formula
  await page.keyboard.type(' after');
  await expect.poll(() => fileText(id), { timeout: 15000 }).toMatch(/\$a\^\{?2\}?\+b\^\{?2\}?=c\^\{?2\}?\$/);
  // display formula with numbering toggle (Alt+M n inside math)
  await page.keyboard.press('Enter');
  await page.keyboard.press('Control+Shift+m');
  await expect(page.locator('.lm-field.display.focused')).toHaveCount(1, { timeout: 5000 });
  await page.keyboard.type('E=mc^2'); await page.keyboard.press('ArrowRight');
  await expect.poll(() => fileText(id), { timeout: 15000 }).toMatch(/\\\[\nE=mc\^\{?2\}?\n\\\]/);
  await page.keyboard.press('Alt+m');
  await page.keyboard.press('n');
  await expect.poll(() => fileText(id), { timeout: 15000 }).toMatch(/\\begin\{equation\}\nE=mc\^\{?2\}?\n\\end\{equation\}/);
  await expect(page.locator('.lyx-math-display').first()).toHaveAttribute('data-eqnum', '(1)');   // our new equation is the first one
  expect(errors.filter(e => !/favicon|ResizeObserver|Unknown delimiter/.test(e))).toEqual([]);
});

test('an empty formula dissolves when the cursor leaves it with an arrow key (a filled one stays)', async ({ page }) => {
  const id = freshDoc('mathempty-' + Date.now());
  await openDoc(page, id);
  const par = await firstStandard(page);
  const inline = page.locator('.lyx-editor .lyx-math-inline');
  const display = page.locator('.lyx-editor .lyx-math-display');
  const nInline = await inline.count();
  const nDisplay = await display.count();
  await page.keyboard.type(' EMPTYTEST');
  // Ctrl+M, → : the empty formula is gone and the cursor is where it was
  await page.keyboard.press('Control+m');
  await expect(page.locator('.lm-field.focused')).toHaveCount(1, { timeout: 5000 });
  await page.keyboard.press('ArrowRight');
  await expect(page.locator('.lm-field.focused')).toHaveCount(0);
  await expect(inline).toHaveCount(nInline);
  await page.keyboard.type('X');
  await expect(par).toContainText('EMPTYTESTX');
  // the same with ←
  await page.keyboard.press('Control+m');
  await expect(page.locator('.lm-field.focused')).toHaveCount(1, { timeout: 5000 });
  await page.keyboard.press('ArrowLeft');
  await expect(inline).toHaveCount(nInline);
  await page.keyboard.type('Y');
  await expect(par).toContainText('EMPTYTESTXY');
  // and for a display formula
  await page.keyboard.press('Control+Shift+m');
  await expect(page.locator('.lm-field.display.focused')).toHaveCount(1, { timeout: 5000 });
  await page.keyboard.press('ArrowRight');
  await expect(page.locator('.lm-field.focused')).toHaveCount(0);
  await expect(display).toHaveCount(nDisplay);
  // a formula with content is left, not removed
  await page.keyboard.press('Control+m');
  await expect(page.locator('.lm-field.focused')).toHaveCount(1, { timeout: 5000 });
  await page.keyboard.type('a');
  await page.keyboard.press('ArrowRight');
  await expect(inline).toHaveCount(nInline + 1);
  await page.keyboard.type('Z');
  await expect.poll(() => fileText(id), { timeout: 15000 }).toMatch(/EMPTYTESTXY\$a\$Z/);
  expect(fileText(id)).not.toMatch(/\$\$|\\\[\s*\\\]/);
});

test('the cursor comes back to where it was when the document is reopened', async ({ page }) => {
  const id = freshDoc('cursor-' + Date.now());
  await openDoc(page, id);
  // freshly opened: at the start
  const head = () => page.evaluate(() => (window as any).overlyx.activeView.state.selection.head as number);
  await expect.poll(head).toBe(1);
  // go somewhere further down and leave a mark
  const p = page.locator('.lyx-editor > .lyx-par.lyx-layout-standard').nth(3);
  await p.click({ position: { x: 4, y: 10 } });
  await page.keyboard.press('End');
  await page.keyboard.type(' CURSORMARK');
  const pos = await head();
  expect(pos).toBeGreaterThan(50);
  await expect.poll(() => page.evaluate((k) => localStorage.getItem(k), 'ol.cursor:' + id)).toContain('CURSORMARK');
  await expect.poll(() => fileText(id), { timeout: 15000 }).toContain('CURSORMARK');

  await page.reload();
  await page.waitForFunction(() => document.querySelectorAll('.lyx-editor .lyx-par').length > 0, null, { timeout: 30000 });
  await expect.poll(head, { timeout: 10000 }).toBe(pos);
  expect(await page.evaluate(() => (window as any).overlyx.activeView.state.selection.$head.parent.textContent)).toContain('CURSORMARK');
  // the paragraph is scrolled into view
  await expect(p).toBeInViewport();

  // the document changed meanwhile (the saved offset is stale): the text before the cursor finds the place again
  await page.evaluate((k) => { const v = JSON.parse(localStorage.getItem(k)!); v.pos += 37; localStorage.setItem(k, JSON.stringify(v)); }, 'ol.cursor:' + id);
  await page.reload();
  await page.waitForFunction(() => document.querySelectorAll('.lyx-editor .lyx-par').length > 0, null, { timeout: 30000 });
  await expect.poll(head, { timeout: 10000 }).toBe(pos);
  // ... and the editor has the keyboard again (once the metadata arrived and editing is allowed)
  await expect.poll(() => page.evaluate(() => { const a = document.activeElement; return !!a && a.classList.contains('lyx-editor') && a.getAttribute('contenteditable') === 'true'; }), { timeout: 10000 }).toBe(true);
  await page.keyboard.type('!');
  await expect.poll(() => fileText(id), { timeout: 15000 }).toContain('CURSORMARK!');
});

test('LyX layouts via Alt+P chords, lists and depth', async ({ page }) => {
  const id = freshDoc('layout-' + Date.now());
  await openDoc(page, id);
  await firstStandard(page);
  await page.keyboard.press('Enter');                // split: an empty Standard paragraph above
  await page.keyboard.press('ArrowUp');
  await page.keyboard.type('My new section');
  await page.keyboard.press('Alt+p');
  await page.keyboard.press('2');                    // layout Section
  await expect(page.locator('.lyx-layout-section', { hasText: 'My new section' })).toHaveCount(1);
  await expect(page.locator('.toolbar select')).toHaveValue('Section');
  await page.keyboard.press('Enter');                // after a heading: Standard
  await expect(page.locator('.toolbar select')).toHaveValue('Standard');
  await page.keyboard.type('first item');
  await page.keyboard.press('Alt+p'); await page.keyboard.press('i');   // Itemize
  await page.keyboard.press('Enter');
  await page.keyboard.type('nested item');
  await page.keyboard.press('Alt+Shift+ArrowRight');  // depth-increment
  await expect.poll(() => fileText(id), { timeout: 15000 }).toMatch(/\\section\{My new section\}[\s\S]*\\begin\{itemize\}\n\\item first item\n\\begin\{itemize\}\n\\item nested item\n\\end\{itemize\}\n\\end\{itemize\}/);
});

test('comment threads and LyX notes, shown in the margin', async ({ page }) => {
  const id = freshDoc('comment-' + Date.now());
  await openDoc(page, id);
  await firstStandard(page);
  await page.keyboard.press('Control+Alt+c');         // new comment thread
  await page.keyboard.type('Please check this claim.');
  const comment = page.locator('.lyx-inset-note-comment', { hasText: 'Please check this claim.' }).first();
  await expect(comment).toContainText('Please check this claim.');
  await expect(comment.locator('.comment-header').first()).toContainText('Admin (');
  // reply
  await comment.locator('.inset-action', { hasText: 'Reply' }).click();
  await page.keyboard.type('Looks fine to me.');
  await expect(comment.locator('.comment-header')).toHaveCount(2);
  // resolve
  await comment.locator('.inset-action', { hasText: 'Resolve' }).click();
  await expect(comment).toHaveClass(/resolved/);
  await expect.poll(() => fileText(id), { timeout: 15000 }).toMatch(/%% @comment\n%% Admin \(\d{4}-\d{2}-\d{2} \d{2}:\d{2}\) \{\[\}resolved\{\]\}:\n%%\n%% Please check this claim\./);
  // LyX note + margin mode
  await page.keyboard.press('Escape');
  await page.keyboard.press('Control+Alt+Shift+n');
  await page.keyboard.type('a lyx note');
  await expect(page.locator('.lyx-inset-note-note', { hasText: 'a lyx note' })).toHaveCount(1);
  await page.locator('.tb-btn[title^="Show notes"]').click();
  // the note goes to the margin; the resolved thread is not shown at all (it lives in the Comments panel's archive)
  await expect.poll(() => page.locator('.lyx-inset-note.in-margin').count(), { timeout: 5000 }).toBe(1);
  const box = page.locator('.lyx-inset-note.in-margin', { hasText: 'a lyx note' }).locator('> .inset-box');
  const pageBox = await page.locator('.editor-page').boundingBox();
  const b = await box.boundingBox();
  expect(b!.x).toBeGreaterThan(pageBox!.x + pageBox!.width - 400);   // in the right margin column
  await expect.poll(() => fileText(id)).toContain('%% @note\n%% a lyx note');
});

test('tables are inserted as tabulars', async ({ page }) => {
  const id = freshDoc('table-' + Date.now());
  await openDoc(page, id);
  await firstStandard(page);
  await page.keyboard.press('Enter');
  await page.keyboard.press('Control+Alt+t');
  await page.locator('.dialog .btn.primary').click();
  await page.keyboard.type('cell A');
  await expect(page.locator('.lyx-tabular', { hasText: 'cell A' }).locator('td')).toHaveCount(9);
  await expect.poll(() => fileText(id), { timeout: 15000 }).toMatch(/\\begin\{tabular\}\{\|c\|c\|c\|\}\n\\hline[\s\S]*cell A[\s\S]*\\end\{tabular\}/);
});

test('fonts, footnote, label/ref and citation insets', async ({ page }) => {
  const id = freshDoc('insets-' + Date.now());
  await openDoc(page, id);
  await firstStandard(page);
  await page.keyboard.type(' ');
  await page.keyboard.press('Control+e'); await page.keyboard.type('emphasized'); await page.keyboard.press('Control+e');
  await page.keyboard.type(' ');
  await page.keyboard.press('Control+b'); await page.keyboard.type('bold'); await page.keyboard.press('Control+b');
  await page.keyboard.press('Control+Alt+f'); await page.keyboard.type('a footnote'); await page.keyboard.press('Escape');
  await page.keyboard.press('Control+Alt+l');
  await page.locator('.dialog input[type=text]').fill('sec:e2e');
  await page.locator('.dialog .btn.primary').click();
  await page.keyboard.press('Control+Shift+i');
  await page.locator('.dialog .list b', { hasText: 'sec:e2e' }).click();
  await page.locator('.dialog .btn.primary').click();
  await expect.poll(() => fileText(id), { timeout: 15000 }).toMatch(/\\emph\{emphasized\}\s+\\textbf\{bold\}\\footnote\{a footnote\}\\label\{sec:e2e\}\\ref\{sec:e2e\}/);
});

test('external edits (git, another editor) are picked up live', async ({ page }) => {
  const id = freshDoc('external-' + Date.now());
  await openDoc(page, id);
  await expect(page.locator('.statusbar')).toContainText('connected');
  const text = fileText(id);
  const marker = 'EXTERNAL-EDIT-' + Date.now();
  writeFileSync(PROJECTS_DIR + '/' + id, text.replace('\\begin{document}\n', `\\begin{document}\n${marker} paragraph.\n\n`));
  await expect(page.locator('.lyx-editor')).toContainText(marker, { timeout: 15000 });
});

test('versions can be created, listed and restored', async ({ page }) => {
  const id = freshDoc('versions-' + Date.now());
  await openDoc(page, id);
  await firstStandard(page);
  await page.keyboard.type(' before-version');
  await expect.poll(() => fileText(id), { timeout: 15000 }).toContain('before-version');
  page.once('dialog', d => d.accept('v1'));
  const vRail = page.locator('.rail.right [data-rail="versions"]');
  if (await vRail.count()) await vRail.click(); else await page.locator('.panel-tabs button', { hasText: 'Versions' }).click();
  await page.locator('.small-btn', { hasText: '+ Save version' }).click();
  await expect(page.locator('.version .name', { hasText: 'v1' })).toHaveCount(1);
  await firstStandard(page);
  await page.keyboard.type(' after-version');
  await expect.poll(() => fileText(id), { timeout: 15000 }).toContain('after-version');
  page.once('dialog', d => d.accept());
  await page.locator('.version', { hasText: 'v1' }).locator('.small-btn', { hasText: 'Restore' }).click();
  await expect(page.locator('.lyx-editor')).not.toContainText('after-version', { timeout: 15000 });
  await expect.poll(() => fileText(id), { timeout: 15000 }).not.toContain('after-version');
});

test('PDF export builds a PDF for a revtex document', async ({ page, request }) => {
  test.skip(!existsSync(`${PROJECTS_DIR}/bayesian_chaos/main.tex`), 'the revtex paper is not in the projects directory under test');
  test.setTimeout(400000);
  await openDoc(page, 'bayesian_chaos/main.tex');
  await page.locator('.tb-btn[title^="View PDF"]').click();
  // builds run in the background: wait for this one (progress shown, then gone), not a previous PDF
  await expect(page.locator('.pdf-panel .build-progress')).toBeVisible({ timeout: 15000 });
  await expect(page.locator('.pdf-panel .build-progress')).toHaveCount(0, { timeout: 360000 });
  await expect(page.locator('.pdf-panel .pdf-viewer .pdf-page-box').first()).toBeVisible({ timeout: 30000 });   // the pdf.js viewer shows the pages
  await expect(page.locator('.pdf-panel .bar span')).toContainText('built');
});

/** A document with a figure (caption + label), an equation with a label, and a ref/eqref to each. */
function labelDoc(name: string): string {
  mkdirSync(DIR, { recursive: true });
  const body = [
    'See Fig \\ref{fig:demo} and \\eqref{eq:demo}.', '',
    '\\begin{figure}', '\\caption{A demo figure.}\\label{fig:demo}', '\\end{figure}', '',
    '\\begin{equation}', 'E=mc^{2}\\label{eq:demo}', '\\end{equation}', '',
  ].join('\n');
  const file = `${DIR}/${name}.tex`;
  writeFileSync(file, withPreambleOf(`${FIXTURES_DIR}/bayesian_chaos/notes/spectral_projection.tex`, body));
  return `${PROJECT}/${name}.tex`;
}

test('figure and equation labels are edited through the same dialog and rename updates references', async ({ page }) => {
  const errors = collectErrors(page);
  const id = labelDoc('labels-' + Date.now());
  await openDoc(page, id);
  await page.waitForTimeout(500);
  // figure label: double-click the chip opens the Label Settings dialog
  await page.locator('.lyx-command-label').first().dblclick();
  await expect(page.locator('.dialog')).toContainText('Label Settings');
  await expect(page.locator('.dialog')).toContainText('Used by 1 cross-reference');
  await page.locator('.dialog input[type=text]').first().fill('fig:renamed');
  await page.locator('.dialog button.primary').click();
  await expect.poll(() => fileText(id), { timeout: 15000 }).toContain('\\label{fig:renamed}');
  expect(fileText(id)).toContain('\\ref{fig:renamed}');      // the \ref was updated
  expect(fileText(id)).not.toContain('fig:demo');
  // equation label: clicking the equation label chip opens the same dialog
  const disp = page.locator('.lyx-math-display').first();
  await disp.scrollIntoViewIfNeeded();
  await disp.locator('.eq-labels').click();
  await expect(page.locator('.dialog')).toContainText('Label Settings');
  await expect(page.locator('.dialog input[type=text]').first()).toHaveValue('eq:demo');
  await page.locator('.dialog input[type=text]').first().fill('eq:renamed');
  await page.locator('.dialog button.primary').click();
  await expect.poll(() => fileText(id), { timeout: 15000 }).toContain('\\label{eq:renamed}');
  expect(fileText(id)).toContain('\\eqref{eq:renamed}');       // the \eqref was updated
  // remove the equation label via the dialog
  await disp.locator('.eq-labels').click();
  await page.locator('.dialog button', { hasText: 'Remove label' }).click();
  await expect.poll(() => fileText(id), { timeout: 15000 }).not.toContain('\\label{eq:renamed}');
  expect(errors).toEqual([]);
});

test('the label dialog opens focused: Backspace clears the name and Enter removes the label', async ({ page }) => {
  const errors = collectErrors(page);
  const id = labelDoc('labelkbd-' + Date.now());
  await openDoc(page, id);
  await page.waitForTimeout(500);
  const disp = page.locator('.lyx-math-display').first();
  await disp.scrollIntoViewIfNeeded();
  await disp.locator('.eq-labels').click();
  const input = page.locator('.dialog input[type=text]').first();
  await expect(input).toBeFocused();              // no extra click needed — keys go to the dialog
  await expect(input).toHaveValue('eq:demo');
  await page.keyboard.press('Backspace');         // the name is selected: one Backspace clears it
  await expect(input).toHaveValue('');
  await expect(page.locator('.dialog button.primary')).toHaveText('Remove');
  await page.keyboard.press('Enter');             // an emptied name removes the label
  await expect(page.locator('.dialog')).toHaveCount(0);
  await expect.poll(() => fileText(id), { timeout: 15000 }).not.toContain('\\label{eq:demo}');
  expect(errors).toEqual([]);
});
