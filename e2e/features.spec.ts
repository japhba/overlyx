import { test, expect, type Page } from '@playwright/test';
import { readFileSync, writeFileSync, mkdirSync, existsSync, copyFileSync } from 'node:fs';
import { login, openDoc, collectErrors, PROJECTS_DIR, FIXTURES_DIR } from './helpers';

/** Each test works on its own copy of a document inside a scratch project. */
const PROJECT = 'e2e-scratch';
const DIR = `${PROJECTS_DIR}/${PROJECT}`;

function freshDoc(name: string): string {
  mkdirSync(DIR, { recursive: true });
  const src = readFileSync(`${FIXTURES_DIR}/bayesian_chaos/notes/notes.lyx`, 'utf8');
  const file = `${DIR}/${name}.lyx`;
  writeFileSync(file, src);
  if (!existsSync(`${DIR}/translation_table.png`)) copyFileSync(`${FIXTURES_DIR}/bayesian_chaos/notes/translation_table.png`, `${DIR}/translation_table.png`);
  return `${PROJECT}/${name}.lyx`;
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

test('inline and display math are edited in place and saved as LyX formulas', async ({ page }) => {
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
  await expect.poll(() => fileText(id), { timeout: 15000 }).toMatch(/\\begin_inset Formula \$a\^\{?2\}?\+b\^\{?2\}?=c\^\{?2\}?\$/);
  // display formula with numbering toggle (Alt+M n inside math)
  await page.keyboard.press('Enter');
  await page.keyboard.press('Control+Shift+m');
  await expect(page.locator('.lm-field.display.focused')).toHaveCount(1, { timeout: 5000 });
  await page.keyboard.type('E=mc^2'); await page.keyboard.press('ArrowRight');
  await expect.poll(() => fileText(id), { timeout: 15000 }).toMatch(/\\begin_inset Formula \n\\\[\nE=mc\^\{?2\}?\n\\\]/);
  await page.keyboard.press('Alt+m');
  await page.keyboard.press('n');
  await expect.poll(() => fileText(id), { timeout: 15000 }).toMatch(/\\begin\{equation\}\nE=mc\^\{?2\}?\n\\end\{equation\}/);
  await expect(page.locator('.lyx-math-display').first()).toHaveAttribute('data-eqnum', '(1)');   // our new equation is the first one
  expect(errors.filter(e => !/favicon|ResizeObserver|Unknown delimiter/.test(e))).toEqual([]);
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
  await expect.poll(() => fileText(id), { timeout: 15000 }).toMatch(/\\begin_layout Section\nMy new section\n\\end_layout[\s\S]*\\begin_layout Itemize\nfirst item\n\\end_layout\n\n\\begin_deeper\n\\begin_layout Itemize\nnested item\n\\end_layout\n\n\\end_deeper/);
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
  await expect.poll(() => fileText(id), { timeout: 15000 }).toMatch(/\\begin_inset Note Comment\nstatus open\n\n\\begin_layout Plain Layout\nAdmin \(\d{4}-\d{2}-\d{2} \d{2}:\d{2}\) \[resolved\]:\n\\end_layout\n\n\\begin_layout Plain Layout\nPlease check this claim\.\n\\end_layout/);
  // LyX note + margin mode
  await page.keyboard.press('Escape');
  await page.keyboard.press('Control+Alt+Shift+n');
  await page.keyboard.type('a lyx note');
  await expect(page.locator('.lyx-inset-note-note', { hasText: 'a lyx note' })).toHaveCount(1);
  await page.locator('.tb-btn[title^="Show notes"]').click();
  expect(await page.locator('.lyx-inset-note.in-margin').count()).toBeGreaterThan(1);
  const box = page.locator('.lyx-inset-note.in-margin', { hasText: 'a lyx note' }).locator('> .inset-box');
  const pageBox = await page.locator('.editor-page').boundingBox();
  const b = await box.boundingBox();
  expect(b!.x).toBeGreaterThan(pageBox!.x + pageBox!.width - 400);   // in the right margin column
  await expect.poll(() => fileText(id)).toContain('\\begin_inset Note Note\nstatus open\n\n\\begin_layout Plain Layout\na lyx note');
});

test('tables are inserted as LyX tabulars', async ({ page }) => {
  const id = freshDoc('table-' + Date.now());
  await openDoc(page, id);
  await firstStandard(page);
  await page.keyboard.press('Enter');
  await page.keyboard.press('Control+Alt+t');
  await page.locator('.dialog .btn.primary').click();
  await page.keyboard.type('cell A');
  await expect(page.locator('.lyx-tabular', { hasText: 'cell A' }).locator('td')).toHaveCount(9);
  await expect.poll(() => fileText(id), { timeout: 15000 }).toMatch(/<lyxtabular version="3" rows="3" columns="3">[\s\S]*<cell alignment="center" valignment="top" topline="true" bottomline="true" leftline="true" rightline="true" usebox="none">\n\\begin_inset Text\n\n\\begin_layout Plain Layout\ncell A\n\\end_layout/);
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
  await expect.poll(() => fileText(id), { timeout: 15000 }).toMatch(/\\emph on\nemphasized\n\\emph default\n \n\\series bold\nbold\n\\series default\n\n\\begin_inset Foot\nstatus open\n\n\\begin_layout Plain Layout\na footnote\n\\end_layout\n\n\\end_inset\n\n\n\\begin_inset CommandInset label\nLatexCommand label\nname "sec:e2e"\n\n\\end_inset\n\n\n\\begin_inset CommandInset ref\nLatexCommand ref\nreference "sec:e2e"/);
});

test('external edits (e.g. saved from LyX) are picked up live', async ({ page }) => {
  const id = freshDoc('external-' + Date.now());
  await openDoc(page, id);
  await expect(page.locator('.statusbar')).toContainText('connected');
  const text = fileText(id);
  const marker = 'EXTERNAL-EDIT-' + Date.now();
  writeFileSync(PROJECTS_DIR + '/' + id, text.replace('\\begin_layout Standard\n', `\\begin_layout Standard\n${marker} `));
  await expect(page.locator('.lyx-editor')).toContainText(marker, { timeout: 15000 });
});

test('versions can be created, listed and restored', async ({ page }) => {
  const id = freshDoc('versions-' + Date.now());
  await openDoc(page, id);
  await firstStandard(page);
  await page.keyboard.type(' before-version');
  await expect.poll(() => fileText(id), { timeout: 15000 }).toContain('before-version');
  page.once('dialog', d => d.accept('v1'));
  await page.locator('.panel-tabs button', { hasText: 'Versions' }).click();
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
  test.skip(!existsSync('/root/lyx/overlyx/packages/core/src/latex/index.ts'), 'exporter not available');
  test.setTimeout(400000);
  await openDoc(page, 'bayesian_chaos/main.lyx');
  await page.locator('.tb-btn[title^="View PDF"]').click();
  // builds run in the background: wait for this one (progress shown, then gone), not a previous PDF
  await expect(page.locator('.pdf-panel .build-progress')).toBeVisible({ timeout: 15000 });
  await expect(page.locator('.pdf-panel .build-progress')).toHaveCount(0, { timeout: 360000 });
  await expect(page.locator('.pdf-panel iframe')).toHaveCount(1);
  await expect(page.locator('.pdf-panel .bar span')).toContainText('built');
});

/** A document with a figure (caption + label), an equation with a label, and a ref/eqref to each. */
function labelDoc(name: string): string {
  mkdirSync(DIR, { recursive: true });
  const head = readFileSync(`${FIXTURES_DIR}/bayesian_chaos/notes/notes.lyx`, 'utf8').split('\\begin_body')[0];
  const body = [
    '\\begin_body', '',
    '\\begin_layout Standard', 'See Fig ',
    '\\begin_inset CommandInset ref', 'LatexCommand ref', 'reference "fig:demo"', 'plural "false"', 'caps "false"', 'noprefix "false"', 'nolink "false"', '', '\\end_inset', '',
    ' and ',
    '\\begin_inset CommandInset ref', 'LatexCommand eqref', 'reference "eq:demo"', 'plural "false"', 'caps "false"', 'noprefix "false"', 'nolink "false"', '', '\\end_inset', '', '.', '\\end_layout', '',
    '\\begin_layout Standard',
    '\\begin_inset Float figure', 'wide false', 'sideways false', 'status open', '',
    '\\begin_layout Plain Layout',
    '\\begin_inset Caption Standard', '',
    '\\begin_layout Plain Layout', 'A demo figure.',
    '\\begin_inset CommandInset label', 'LatexCommand label', 'name "fig:demo"', '', '\\end_inset', '', '', '\\end_layout', '',
    '\\end_inset', '', '', '\\end_layout', '',
    '\\end_inset', '', '', '\\end_layout', '',
    '\\begin_layout Standard',
    '\\begin_inset Formula ', '\\begin{equation}', 'E=mc^{2}\\label{eq:demo}', '\\end{equation}', '', '\\end_inset', '', '', '\\end_layout', '',
    '\\end_body', '\\end_document', '',
  ].join('\n');
  const file = `${DIR}/${name}.lyx`;
  writeFileSync(file, head + body);
  return `${PROJECT}/${name}.lyx`;
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
  await expect.poll(() => fileText(id), { timeout: 15000 }).toContain('name "fig:renamed"');
  expect(fileText(id)).toContain('reference "fig:renamed"');      // the \ref was updated
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
  expect(fileText(id)).toContain('reference "eq:renamed"');       // the \eqref was updated
  // remove the equation label via the dialog
  await disp.locator('.eq-labels').click();
  await page.locator('.dialog button', { hasText: 'Remove label' }).click();
  await expect.poll(() => fileText(id), { timeout: 15000 }).not.toContain('\\label{eq:renamed}');
  expect(errors).toEqual([]);
});
