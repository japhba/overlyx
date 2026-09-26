/**
 * Hyperlinks the Google Docs way (editor/links.ts): Ctrl+K opens the link box under the selection,
 * the link under the cursor shows a bubble (address, Copy, Edit, Remove), the right-click menu has
 * Insert link, an address pasted over selected text links it. Also inside a formula: the text of a
 * table's `\text{Wang24}` cell becomes `\text{\href{…}{Wang24}}` (it used to be impossible — the
 * link landed in the text instead), and the document loads hyperref.
 */
import { test, expect, type Page } from '@playwright/test';
import { mkdirSync, rmSync, readFileSync, writeFileSync } from 'node:fs';
import { login, openDoc, collectErrors, texDoc, PROJECTS_DIR } from './helpers';

const PROJECT = 'admin/e2e-links';
const DIR = `${PROJECTS_DIR}/${PROJECT}`;
const FILE = `${DIR}/doc.tex`;
const TABLE = '\\begin{matrix}\\text{Feature} & \\text{RBMs} & \\text{Wang24}\\\\ \\text{local} & 1 & 0\\end{matrix}';

test.beforeEach(() => {
  rmSync(DIR, { recursive: true, force: true });
  mkdirSync(DIR, { recursive: true });
  writeFileSync(FILE, texDoc(`Before the table, see our notes.\n\n$${TABLE}$\n\nAfter.`, '\\usepackage{amsmath}'));
});
test.afterAll(() => { rmSync(DIR, { recursive: true, force: true }); });

const file = () => readFileSync(FILE, 'utf8');
const field = `document.querySelector('.lyx-editor .lyx-math-inline').pmViewDesc.spec.field`;

/** select `word` of the first paragraph (ProseMirror selection) */
const selectWord = (page: Page, word: string) => page.evaluate(`(() => {
  const v = window.overlyx.activeView; let at = -1;
  v.state.doc.descendants((n, pos) => { if (at < 0 && n.isText && n.text.includes(${JSON.stringify(word)})) at = pos + n.text.indexOf(${JSON.stringify(word)}); });
  v.dispatch(v.state.tr.setSelection(v.state.selection.constructor.create(v.state.doc, at, at + ${word.length}))); v.focus();
})()`);

test('Ctrl+K over the text of a table cell inside a formula makes it a link; the bubble edits and removes it', async ({ page }) => {
  const errors = collectErrors(page);
  await login(page);
  await openDoc(page, `${PROJECT}/doc.tex`);
  const f = page.locator('.lyx-editor .lyx-math-inline').first();
  await f.hover();
  await expect(f.locator('.lm-field')).toHaveCount(1, { timeout: 10000 });
  // a click at the end of "Wang24" (the \text cell of row 1, column 3), Shift+Home selects the cell's text
  const box = await page.evaluate(`(() => { const f = ${field}; const grid = f.hull.rows[0].cells[0][0]; const text = grid.rows[0].cells[2][0]; const g = f.geometry().cell(text, 0); return { x: g.right - 1, y: (g.top + g.bottom) / 2 }; })()`) as { x: number; y: number };
  await page.mouse.click(box.x, box.y);
  await page.keyboard.press('Shift+Home');
  expect(await page.evaluate(`${field}.cursor.grabSelection()`)).toBe('Wang24');
  await page.keyboard.press('Control+k');
  const linkBox = page.locator('.link-box');
  await expect(linkBox).toBeVisible();
  await expect(linkBox.locator('input')).toHaveCount(1);          // the selection is the text: only the address
  await page.keyboard.type('arxiv.org/html/2405.18634');
  await page.keyboard.press('Enter');
  await expect(linkBox).toHaveCount(0);
  await expect(f.locator('.lm-href')).toHaveCount(1);
  await expect.poll(file, { timeout: 15000 }).toContain('\\text{\\href{https://arxiv.org/html/2405.18634}{Wang24}}');
  expect(file()).toContain('\\usepackage{hyperref}');
  // the cursor stays at the link: the bubble shows where it goes
  const bubble = page.locator('.link-bubble');
  await expect(bubble.locator('.link-bubble-url')).toHaveText('https://arxiv.org/html/2405.18634');
  await expect(bubble.locator('.link-bubble-url')).toHaveAttribute('href', 'https://arxiv.org/html/2405.18634');
  // Edit: the box with the address, changed
  await bubble.locator('button[title^="Edit link"]').click();
  await expect(linkBox.locator('input')).toHaveValue('https://arxiv.org/html/2405.18634');
  await page.keyboard.press('Control+a');
  await page.keyboard.type('https://arxiv.org/abs/2405.18634');
  await page.keyboard.press('Enter');
  await expect.poll(file, { timeout: 15000 }).toContain('\\text{\\href{https://arxiv.org/abs/2405.18634}{Wang24}}');
  // Remove: the text stays, the link goes
  await bubble.locator('button[title="Remove link"]').click();
  await expect(f.locator('.lm-href')).toHaveCount(0);
  await expect.poll(file, { timeout: 15000 }).not.toContain('\\href');
  expect(file()).toContain('\\text{Wang24}');
  expect(errors).toEqual([]);
});

test('links in the text: the right-click menu’s Insert link, Ctrl+K on a link, pasting an address over a selection', async ({ page, context }) => {
  const errors = collectErrors(page);
  await context.grantPermissions(['clipboard-read', 'clipboard-write']);
  await login(page);
  await openDoc(page, `${PROJECT}/doc.tex`);
  const par = page.locator('.lyx-editor .lyx-par').first();
  await par.click({ position: { x: 3, y: 8 } });
  await selectWord(page, 'notes');
  // the menu, Google Docs' order
  const sel = await page.evaluate(`(() => { const v = window.overlyx.activeView; const r = v.coordsAtPos(v.state.selection.from + 2); return { x: r.left, y: (r.top + r.bottom) / 2 }; })()`) as { x: number; y: number };
  await page.mouse.click(sel.x, sel.y, { button: 'right' });
  const labels = await page.locator('.ctx-menu .ctx-item .ctx-label').allTextContents();
  expect(labels.slice(0, 7)).toEqual(['Cut', 'Copy', 'Paste', 'Paste without formatting', 'Delete', 'Comment', 'Insert link']);
  await page.locator('.ctx-menu .ctx-item', { hasText: 'Insert link' }).click();
  const linkBox = page.locator('.link-box');
  await expect(linkBox.locator('input')).toHaveCount(1);
  await page.keyboard.type('example.org');
  await page.keyboard.press('Enter');
  await expect(par.locator('.lyx-href')).toHaveText('notes');
  await expect.poll(file, { timeout: 15000 }).toContain('\\href{https://example.org}{notes}');
  await expect(page.locator('.link-bubble .link-bubble-url')).toHaveText('https://example.org');
  // Ctrl+K right behind the link: text and address, both editable
  await page.keyboard.press('Control+k');
  await expect(linkBox.locator('input')).toHaveCount(2);
  await expect(linkBox.locator('input').first()).toHaveValue('notes');
  await linkBox.locator('input').first().fill('our notes');
  await linkBox.locator('input').nth(1).fill('https://example.org/notes');
  await page.keyboard.press('Enter');
  await expect.poll(file, { timeout: 15000 }).toContain('\\href{https://example.org/notes}{our notes}');
  // an address pasted over selected text links it
  await selectWord(page, 'Before');
  await page.evaluate(() => navigator.clipboard.writeText('https://overlyx.app'));
  await page.keyboard.press('Control+v');
  await expect.poll(file, { timeout: 15000 }).toContain('\\href{https://overlyx.app}{Before}');
  // the menu's Remove link on a link
  await par.locator('.lyx-href', { hasText: 'Before' }).click({ button: 'right' });
  await page.locator('.ctx-menu .ctx-item', { hasText: 'Remove link' }).click();
  await expect.poll(file, { timeout: 15000 }).not.toContain('{Before}');
  expect(file()).toContain('Before the table');
  expect(errors).toEqual([]);
});

test('the right-click menu works from the keyboard: ↓ chooses, Enter runs', async ({ page }) => {
  await login(page);
  await openDoc(page, `${PROJECT}/doc.tex`);
  const par = page.locator('.lyx-editor .lyx-par').first();
  await par.click({ position: { x: 3, y: 8 } });
  await selectWord(page, 'table');
  const sel = await page.evaluate(`(() => { const v = window.overlyx.activeView; const r = v.coordsAtPos(v.state.selection.from + 2); return { x: r.left, y: (r.top + r.bottom) / 2 }; })()`) as { x: number; y: number };
  await page.mouse.click(sel.x, sel.y, { button: 'right' });
  const menu = page.locator('.ctx-menu');
  await expect(menu).toHaveCount(1);
  for (let i = 0; i < 7; i++) await page.keyboard.press('ArrowDown');   // Cut, Copy, Paste, Paste w/o formatting, Delete, Comment, Insert link
  await expect(menu.locator('.ctx-item.active .ctx-label')).toHaveText('Insert link');
  await page.keyboard.press('Enter');
  await expect(menu).toHaveCount(0);
  await expect(page.locator('.link-box')).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(page.locator('.link-box')).toHaveCount(0);
  expect(file()).not.toContain('\\href');
});
