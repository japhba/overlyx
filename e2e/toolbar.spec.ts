/**
 * LyX toolbars (standard / extra / math / table / review), the delimiter palette with sizes and
 * the ⟪ ⟫ macro, and jumping to another user's cursor by clicking their avatar.
 */
import { test, expect, type Page } from '@playwright/test';
import { mkdirSync, rmSync, readFileSync, writeFileSync } from 'node:fs';
import { login, collectErrors, userCredentials, PROJECTS_DIR, shareProject, acceptDialog } from './helpers';

const DIR = `${PROJECTS_DIR}/admin/e2e-toolbar`;
const FILE = `${DIR}/main.tex`;

const para = (t: string) => `${t}\n\n`;
const body = '\\documentclass{article}\n\\usepackage{amsmath}\n\\begin{document}\n' + para('Hello toolbar.') +
  para('A formula $x+y$ here.') +
  Array.from({ length: 60 }, (_, i) => para(`Filler paragraph number ${i + 1} with some words so that the page scrolls.`)).join('') +
  para('The very last paragraph.') + '\\end{document}\n';

test.beforeAll(async ({ browser }) => {
  rmSync(DIR, { recursive: true, force: true });
  mkdirSync(DIR, { recursive: true });
  writeFileSync(FILE, body);
  await shareProject(browser, 'admin/e2e-toolbar', ['bob']);
  await shareProject(browser, 'admin/e2e-toolbar', ['carol'], 'view');
});
test.afterAll(() => { rmSync(DIR, { recursive: true, force: true }); });

const file = () => readFileSync(FILE, 'utf8');
async function open(page: Page, creds?: { username: string; password: string }) {
  await login(page, creds);
  await page.evaluate(() => { localStorage.setItem('ol.tabs', '[]'); localStorage.setItem('ol.combined', '0'); localStorage.removeItem('ol.toolbars'); });
  await page.goto('/#/admin/e2e-toolbar/main.tex');
  await page.waitForFunction(() => document.querySelectorAll('.lyx-editor .lyx-par').length >= 3, null, { timeout: 60000 });
  await expect(page.locator('.statusbar')).toContainText('connected', { timeout: 20000 });
  await page.waitForTimeout(500);
}
const tb = (page: Page, id: string) => page.locator(`[data-tb="${id}"]`);
const fieldLatex = (page: Page) => page.evaluate(() => (document.querySelector('.lyx-editor .lyx-math-inline') as any)?.pmViewDesc?.spec?.field?.latex ?? null);

test('standard + extra toolbars are there; math toolbar appears in a formula and offers sized delimiters incl. ⟪ ⟫', async ({ page }) => {
  const errors = collectErrors(page);
  await open(page);
  await expect(page.locator('.toolbar-standard')).toBeVisible();
  await expect(page.locator('.toolbar-extra')).toBeVisible();
  for (const id of ['undo', 'cut', 'copy', 'paste', 'emph', 'noun', 'math', 'graphics', 'table', 'outline', 'tb-math', 'tb-table', 'tb-review', 'pdf']) await expect(tb(page, id)).toBeVisible();
  for (const id of ['l-enumerate', 'l-itemize', 'l-section', 'depthin', 'float', 'tablefloat', 'label', 'ref', 'cite', 'index', 'footnote', 'marginal', 'note', 'href', 'ert', 'macro', 'include', 'textstyle', 'paragraph']) await expect(tb(page, id)).toBeVisible();
  await expect(page.locator('.toolbar-math')).toHaveCount(0);

  // click into the formula: the math toolbar (and the panels) appear
  await page.locator('.lyx-editor .lyx-math-inline').first().click();
  await expect(page.locator('.toolbar-math')).toBeVisible();
  await expect(page.locator('.toolbar-mathpanels')).toBeVisible();
  for (const id of ['m-display', 'm-sub', 'm-sup', 'm-sqrt', 'm-frac', 'm-sum', 'm-int', 'm-paren', 'm-bracket', 'm-brace', 'm-abs', 'm-angle', 'm-dangle', 'm-delims', 'm-matrix', 'm-cases', 'm-addrow', 'mp-latex_greek', 'mp-latex_delim']) await expect(tb(page, id)).toBeVisible();
  await page.keyboard.press('End');

  // delimiter palette: rows = pairs, columns = sizes; ⟪ ⟫ auto size
  await tb(page, 'm-delims').click();
  const pal = page.locator('.tb-popup[data-palette="m-delims"]');
  await expect(pal).toBeVisible();
  expect(await pal.locator('thead th').allTextContents()).toEqual(['', 'auto', 'plain', 'big', 'Big', 'bigg', 'Bigg']);
  await expect(pal.locator('tbody tr')).toHaveCount(17);
  await pal.locator('[data-delim="llangle|auto"]').click();
  await expect.poll(() => fieldLatex(page)).toContain('\\left\\llangle');
  await page.keyboard.type('a');
  await expect.poll(() => fieldLatex(page)).toContain('\\left\\llangle a\\right\\rrangle');
  // the macro was added to the preamble, and the file has the LyX-native delimiters
  await expect.poll(() => file().includes('% OverLyX: double angle brackets') && file().includes('\\providecommand{\\llangle}') && file().includes('\\left\\llangle a\\right\\rrangle'), { timeout: 15000 }).toBe(true);
  expect(file().split('% OverLyX: double angle brackets').length).toBe(2);

  // a Bigg-sized brace pair (ArrowRight leaves the delimiter inset; End at the end of a cell leaves the formula, as in LyX)
  await page.keyboard.press('ArrowRight');
  await tb(page, 'm-delims').click();
  await page.locator('.tb-popup[data-palette="m-delims"] [data-delim="{|Bigg"]').click();
  await page.keyboard.type('b');
  await expect.poll(() => fieldLatex(page)).toContain('\\Biggl\\{ b\\Biggr\\}');
  // plain |…| and a quick ( ) button
  await page.keyboard.press('ArrowRight');
  await tb(page, 'm-delims').click();
  await page.locator('.tb-popup[data-palette="m-delims"] [data-delim="||none"]').click();
  await page.keyboard.type('c');
  await expect.poll(() => fieldLatex(page)).toContain('|c|');
  await page.keyboard.press('ArrowRight');
  await tb(page, 'm-paren').click();
  await page.keyboard.type('d');
  await expect.poll(() => fieldLatex(page)).toContain('\\left(d\\right)');
  // a Greek letter from the panels, a fraction button
  await page.keyboard.press('ArrowRight');
  await tb(page, 'mp-latex_greek').click();
  await page.locator('.tb-popup[data-palette="mp-latex_greek"]').getByTitle('\\alpha', { exact: true }).click();
  await expect.poll(() => fieldLatex(page)).toContain('\\alpha');
  await tb(page, 'm-frac').click();
  await page.keyboard.type('n');
  await expect.poll(() => fieldLatex(page)).toContain('\\frac{n}{}');
  // the second ⟪ ⟫ use does not add the snippet again
  await page.keyboard.press('ArrowRight');
  await tb(page, 'm-dangle').click();
  await page.waitForTimeout(500);
  expect(file().split('% OverLyX: double angle brackets').length).toBe(2);
  expect(errors.filter(e => !/favicon|ResizeObserver|404/.test(e))).toEqual([]);
});

test('table toolbar appears in a table; add row / column and lines work', async ({ page }) => {
  await open(page);
  await page.locator('.lyx-editor > .lyx-par').first().click();
  await page.keyboard.press('End');
  await page.keyboard.press('Enter');
  await expect(page.locator('.toolbar-table')).toHaveCount(0);
  await tb(page, 'table').click();
  const cells = page.locator('.tb-popup[data-palette="table"] .tb-grid-cell');
  await cells.nth(1 * 10 + 2).hover();   // row 2, column 3
  await expect(page.locator('.tb-grid-label')).toHaveText('2 × 3 table');
  await cells.nth(1 * 10 + 2).click();
  await expect(page.locator('.lyx-editor .lyx-tabular')).toHaveCount(1);
  await expect(page.locator('.toolbar-table')).toBeVisible();
  const body = () => file().slice(file().indexOf('\\begin{document}'));
  const rows = () => (body().match(/\\tabularnewline/g) ?? []).length;
  const cols = () => ((body().match(/\\begin\{tabular\}\{([^}]*)\}/) ?? [, ''])[1].match(/[lcr]/g) ?? []).length;
  await expect.poll(rows).toBe(2);
  await tb(page, 't-addrow').click();
  await expect.poll(rows).toBe(3);
  await tb(page, 't-addcol').click();
  await expect.poll(cols, { timeout: 10000 }).toBe(4);
  await expect(page.locator('.lyx-editor .lyx-tabular td')).toHaveCount(12);
  await tb(page, 't-delrow').click();
  await expect.poll(rows).toBe(2);
  // lines (LyX: on the selected cells, here the cursor cell): unset, then set again
  const count = (re: RegExp) => (file().match(re) ?? []).length;
  // a full row line is \hline, a partial one \cline (LyX writes \hline only when every cell of the row has the line)
  const lines = () => (body().match(/\\hline/g) ?? []).length * 2 + (body().match(/\\cline/g) ?? []).length + (body().match(/\|/g) ?? []).length;
  const linesBefore = lines();
  await tb(page, 't-none').click();
  await expect.poll(lines).toBeLessThan(linesBefore);
  await tb(page, 't-all').click();
  await expect.poll(lines).toBeGreaterThanOrEqual(linesBefore - 2);
});

test('review toolbar appears with change tracking', async ({ page }) => {
  await open(page);
  await expect(page.locator('.toolbar-review')).toHaveCount(0);
  await page.locator('.lyx-editor > .lyx-par').first().click();
  await page.keyboard.press('Control+Shift+e');
  await expect(page.locator('.toolbar-review')).toBeVisible();
  for (const id of ['r-track', 'r-output', 'r-prev', 'r-next', 'r-accept', 'r-reject', 'r-acceptall', 'r-rejectall']) await expect(tb(page, id)).toBeVisible();
  // the first paragraph starts with the table inserted above: End would stay on the table's line
  await page.evaluate(() => {
    const v = (window as any).overlyx.activeView;
    const end = v.state.selection.$from.end(1);
    v.dispatch(v.state.tr.setSelection(v.state.selection.constructor.create(v.state.doc, end)));
  });
  await page.keyboard.type(' tracked');
  await expect.poll(() => file().includes('\\lyxadded{')).toBe(true);
  await tb(page, 'r-next').click();
  const sel = await page.evaluate(() => { const v = (window as any).overlyx.activeView; return v.state.doc.textBetween(v.state.selection.from, v.state.selection.to); });
  expect(sel).toBe(' tracked');
  await tb(page, 'r-accept').click();
  await expect.poll(() => file().includes('\\lyxadded{')).toBe(false);
  expect(file().replace(/\n/g, ' ')).toContain('Hello toolbar. tracked');
});

test('the mode switch at the top right: Editing · Suggesting · Viewing, and which changes are shown', async ({ page, browser }) => {
  const errors = collectErrors(page);
  await open(page);
  const sw = page.locator('.tb-toprow .edit-mode-btn');
  await expect(sw).toBeVisible();
  // it ends the standard toolbar's row, as in Google Docs
  const row = (await page.locator('.tb-toprow').boundingBox())!, btn = (await sw.boundingBox())!;
  expect(row.x + row.width - (btn.x + btn.width)).toBeLessThan(20);
  expect(btn.y - row.y).toBeLessThan(10);
  const pick = async (sel: string) => { await sw.click(); await page.locator(`.edit-mode-menu ${sel}`).click(); await expect(page.locator('.edit-mode-menu')).toHaveCount(0); };
  // at the end of the first paragraph (it starts with the table inserted above)
  const typeAtEnd = async (text: string) => {
    await page.locator('.lyx-editor > .lyx-par').first().click();
    await page.evaluate(() => {
      const v = (window as any).overlyx.activeView;
      const end = v.state.selection.$from.end(1);
      v.dispatch(v.state.tr.setSelection(v.state.selection.constructor.create(v.state.doc, end)));
    });
    await page.keyboard.type(text);
  };
  await page.locator('.lyx-editor > .lyx-par').first().click();
  // the review test left change tracking on: Editing switches it off
  if (await sw.getAttribute('data-edit-mode') !== 'editing') await pick('[data-mode="editing"]');
  await expect(sw).toHaveAttribute('data-edit-mode', 'editing');

  // Suggesting = change tracking: typed text is tracked, the review toolbar says so
  await pick('[data-mode="suggesting"]');
  await expect(sw).toHaveAttribute('data-edit-mode', 'suggesting');
  await expect(sw).toContainText('Suggesting');
  await expect(tb(page, 'r-track')).toHaveClass(/active/);
  await typeAtEnd(' suggested');
  await expect.poll(() => /\\lyxadded\{[^}]*\}\{[^}]*\}\{ ?suggested\}/.test(file())).toBe(true);

  // Show changes: only deletions folds the insertion away (the review toolbar's switch follows)
  await sw.click();
  await expect(page.locator('.edit-mode-menu [data-changes="all"]')).toHaveAttribute('aria-checked', 'true');
  await page.locator('.edit-mode-menu [data-changes="deletions"]').click();
  await expect(page.locator('.lyx-editor .lyx-change-hidden')).not.toHaveCount(0);
  await expect(tb(page, 'r-show-ins')).not.toHaveClass(/active/);
  await expect(tb(page, 'r-show-del')).toHaveClass(/active/);
  await sw.click();
  await expect(page.locator('.edit-mode-menu [data-changes="deletions"]')).toHaveAttribute('aria-checked', 'true');
  await page.locator('.edit-mode-menu [data-changes="all"]').click();
  await expect(page.locator('.lyx-editor .lyx-change-hidden')).toHaveCount(0);

  // Viewing: read-only here, the document keeps tracking on
  await pick('[data-mode="viewing"]');
  await expect(sw).toHaveAttribute('data-edit-mode', 'viewing');
  await expect(page.locator('.lyx-editor').first()).toHaveAttribute('contenteditable', 'false');
  const before = file();
  await page.locator('.lyx-editor > .lyx-par').first().click();
  await page.keyboard.type('zzz');
  await page.waitForTimeout(1500);
  expect(file()).toBe(before);
  await expect(tb(page, 'r-track')).toHaveClass(/active/);

  // back to Editing: editable again, untracked; rejecting the suggestion leaves the plain edit
  await pick('[data-mode="editing"]');
  await expect(sw).toHaveAttribute('data-edit-mode', 'editing');
  await expect(page.locator('.lyx-editor').first()).toHaveAttribute('contenteditable', 'true');
  await expect(tb(page, 'r-track')).not.toHaveClass(/active/);
  await typeAtEnd(' plain');
  await expect.poll(() => file().includes(' plain')).toBe(true);
  await tb(page, 'r-rejectall').click();
  await acceptDialog(page);
  await expect.poll(() => file().includes('\\lyxadded{')).toBe(false);
  expect(file()).not.toContain('suggested');
  expect(file()).toContain(' plain');
  expect(file()).not.toContain('zzz');
  expect(errors).toEqual([]);

  // with view access only, Viewing is all there is
  const ctx = await browser.newContext(); const carol = await ctx.newPage();
  await open(carol, userCredentials('carol'));
  const csw = carol.locator('.edit-mode-btn');
  await expect(csw).toHaveAttribute('data-edit-mode', 'viewing');
  await csw.click();
  await expect(carol.locator('.edit-mode-menu [data-mode="editing"]')).toBeDisabled();
  await expect(carol.locator('.edit-mode-menu [data-mode="suggesting"]')).toBeDisabled();
  await expect(carol.locator('.edit-mode-menu [data-mode="viewing"]')).toHaveAttribute('aria-checked', 'true');
  await ctx.close();
});

test('accept / reject in the text: a bar with the author and the date over a tracked change', async ({ page }) => {
  const errors = collectErrors(page);
  await open(page);
  const sw = page.locator('.tb-toprow .edit-mode-btn');
  const pick = async (mode: string) => { await sw.click(); await page.locator(`.edit-mode-menu [data-mode="${mode}"]`).click(); await expect(sw).toHaveAttribute('data-edit-mode', mode); };
  // select `part` of the (unique) text `needle`
  const select = (needle: string, part: string) => page.evaluate(([needle, part]) => {
    const v = (window as any).overlyx.activeView;
    let at = -1;
    v.state.doc.descendants((n: any, pos: number) => { if (at < 0 && n.isText && n.text.includes(needle)) at = pos + n.text.indexOf(needle) + needle.indexOf(part); return at < 0; });
    v.dispatch(v.state.tr.setSelection(v.state.selection.constructor.create(v.state.doc, at, at + part.length)));
    v.focus();
  }, [needle, part]);
  const bar = page.locator('.change-actions');
  await page.locator('.lyx-editor > .lyx-par').first().click();
  if (await sw.getAttribute('data-edit-mode') !== 'editing') await pick('editing');

  // suggest a replacement and a deletion; while typing, no bar comes up
  await pick('suggesting');
  await select('number 5 with', 'number');
  await page.keyboard.type('count');
  await expect.poll(() => /\\lyxdeleted\{[^}]*\}\{[^}]*\}\{number\}\\lyxadded\{[^}]*\}\{[^}]*\}\{count\}/.test(file())).toBe(true);
  await expect(bar).toHaveCount(0);
  await select('number 6 with some words', 'some ');
  await page.keyboard.press('Backspace');
  await expect.poll(() => /\\lyxdeleted\{[^}]*\}\{[^}]*\}\{some ?\}/.test(file())).toBe(true);
  await pick('editing');

  // the pointer on the deleted word: the bar over it names the author and the date
  const gone = page.locator('.lyx-editor .lyx-change-deleted', { hasText: 'number' });
  await gone.hover();
  await expect(bar).toBeVisible();
  await expect(bar.locator('.change-actions-author')).toHaveText('Admin');
  await expect(bar.locator('.change-actions-date')).not.toBeEmpty();
  const b = (await bar.boundingBox())!, g = (await gone.boundingBox())!;
  expect(b.y + b.height).toBeLessThanOrEqual(g.y + 1);
  expect(Math.abs(b.x - g.x)).toBeLessThan(40);
  // ✓ shades what it settles: the deletion and its insertion, one replacement
  await bar.locator('.change-action.accept').hover();
  await expect(page.locator('.change-actions-shade')).not.toHaveCount(0);
  await bar.locator('.change-action.accept').click();
  await expect(bar).toHaveCount(0);
  await expect(page.locator('.change-actions-shade')).toHaveCount(0);
  await expect.poll(() => file().replace(/\n/g, ' ')).toContain('Filler paragraph count 5 with');
  expect(file()).not.toMatch(/\{number\}|\{count\}/);

  // the caret in a change brings the bar up as well, and it stays while the pointer goes elsewhere
  await page.locator('.lyx-editor .lyx-change-deleted', { hasText: 'some' }).click();
  await expect(bar).toBeVisible();
  await page.mouse.move(5, 300);
  await page.waitForTimeout(700);
  await expect(bar).toBeVisible();
  await bar.locator('.change-action.reject').click();
  await expect.poll(() => file().replace(/\n/g, ' ')).toContain('Filler paragraph number 6 with some words');
  expect(file()).not.toContain('\\lyxdeleted');
  await expect(bar).toHaveCount(0);
  expect(errors).toEqual([]);
});

test('clicking a user avatar jumps to that user\'s cursor', async ({ browser }) => {
  const ctxA = await browser.newContext(); const pageA = await ctxA.newPage();
  const ctxB = await browser.newContext(); const pageB = await ctxB.newPage();
  await open(pageA);
  await open(pageB, userCredentials('bob'));
  // B works at the end of the document
  const lastB = pageB.locator('.lyx-editor > .lyx-par').last();
  await lastB.scrollIntoViewIfNeeded();
  await lastB.click();
  await pageB.keyboard.press('End');
  await pageB.keyboard.type(' (Bob was here)');
  // A is at the top and sees Bob in the status bar
  await pageA.locator('.lyx-editor > .lyx-par').first().click();
  const bob = pageA.locator('.menubar .users .avatar[data-username="bob"]');
  await expect(bob).toBeVisible({ timeout: 15000 });
  await expect(bob).toHaveClass(/has-cursor/, { timeout: 15000 });
  const beforeTop = await pageA.evaluate(() => document.querySelector('.editor-scroll')!.scrollTop);
  await bob.click();
  await expect.poll(() => pageA.evaluate(() => { const v = (window as any).overlyx.activeView; return v.state.selection.$from.parent.textContent; })).toContain('The very last paragraph.');
  const afterTop = await pageA.evaluate(() => document.querySelector('.editor-scroll')!.scrollTop);
  expect(afterTop).toBeGreaterThan(beforeTop);
  // Bob's cursor label is in view
  const inView = await pageA.evaluate(() => { const el = document.querySelector('.ProseMirror-yjs-cursor'); if (!el) return false; const r = el.getBoundingClientRect(); return r.top >= 0 && r.bottom <= window.innerHeight; });
  expect(inView).toBe(true);
  await expect(pageA.locator('.statusbar')).toContainText(/Jumped to Bob[^']*'s cursor/);   // bob's display name depends on the seed
  await ctxA.close(); await ctxB.close();
});

test('shortcut tips: from the third mouse use on, the shortcut shows under the button; pressing it or "Don\'t show again" ends them', async ({ page }) => {
  const errors = collectErrors(page);
  await open(page);
  await page.evaluate(() => { localStorage.removeItem('ol.shortcutTips'); });
  await page.locator('.lyx-editor .lyx-par', { hasText: 'Hello toolbar.' }).click();
  const tip = page.locator('.shortcut-tip');

  // Emphasis (Ctrl+E) from the toolbar: nothing twice, the tip the third time — below the button, the editor keeps the keyboard
  for (let i = 0; i < 2; i++) { await tb(page, 'emph').click(); await page.waitForTimeout(150); await expect(tip).toHaveCount(0); }
  await tb(page, 'emph').click();
  await expect(tip).toBeVisible();
  await expect(tip.locator('kbd')).toHaveText('Ctrl+E');
  await expect(tip).toContainText('Emphasis');
  const [btn, box] = [await tb(page, 'emph').boundingBox(), await tip.boundingBox()];
  expect(box!.y).toBeGreaterThanOrEqual(btn!.y + btn!.height);
  expect(Math.abs(box!.x - btn!.x)).toBeLessThan(40);
  await expect(page.locator('.lyx-editor')).toBeFocused();
  // pressing the shortcut: the tip goes, and does not come back for it
  await page.keyboard.press('Control+e');
  await expect(tip).toHaveCount(0);
  await tb(page, 'emph').click();
  await page.waitForTimeout(150);
  await expect(tip).toHaveCount(0);

  // a menu entry counts too: the tip stands where the entry was
  for (let i = 0; i < 3; i++) {
    await page.locator('.menubar .menu button', { hasText: 'Navigate' }).click();
    await page.locator('.menu-item', { hasText: 'Outline pane' }).click();
  }
  await expect(tip).toBeVisible();
  await expect(tip.locator('kbd')).toHaveText('Ctrl+Alt+O');
  // a click beside it closes it (the text lets the click through)
  await page.locator('.editor-scroll').click({ position: { x: 5, y: 300 } });
  await expect(tip).toHaveCount(0);

  // "Don't show again" switches every tip off
  for (let i = 0; i < 3; i++) await tb(page, 'italic').click();
  await expect(tip.locator('kbd')).toHaveText('Ctrl+I');
  await tip.locator('.shortcut-tip-off').click();
  await expect(tip).toHaveCount(0);
  expect(await page.evaluate(() => JSON.parse(localStorage.getItem('ol.prefs') ?? '{}').shortcutTips)).toBe(false);
  for (let i = 0; i < 3; i++) await tb(page, 'noun').click();
  await page.waitForTimeout(150);
  await expect(tip).toHaveCount(0);
  await page.evaluate(() => { const p = JSON.parse(localStorage.getItem('ol.prefs') ?? '{}'); p.shortcutTips = true; localStorage.setItem('ol.prefs', JSON.stringify(p)); localStorage.removeItem('ol.shortcutTips'); });
  expect(errors).toEqual([]);
});
