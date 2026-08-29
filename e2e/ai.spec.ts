/**
 * The right-click menu, the spell-checking switch, the preferences, and — when the server under
 * test talks to the AI stub (scripts/ai-stub.mjs, `OVERLYX_E2E_AI_STUB=1`) — the ⌘K rewrite with
 * its in-place preview and the ghost-text autocomplete in text and formulas.
 */
import { test, expect, type Page } from '@playwright/test';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { login, PROJECTS_DIR, texDoc } from './helpers';

const PROJECT = 'e2e-ai';
const DOC = `${PROJECT}/paper.tex`;
const AI_STUB = !!process.env.OVERLYX_E2E_AI_STUB;
const BODY = `\\section{Introduction}

Recurrent networks with weights $\\bW$ show rich dynamics. We study the Lyapunov exponent $\\lambda$ of such networks.

The variance of the weights is $\\sigma^2$, and the gain $g$ controls the transition to chaos.

\\begin{equation}
\\lambda = \\log g
\\end{equation}

The last paragraph of the paper.`;

test.beforeAll(() => {
  rmSync(join(PROJECTS_DIR, PROJECT), { recursive: true, force: true });
  mkdirSync(join(PROJECTS_DIR, PROJECT), { recursive: true });
  writeFileSync(join(PROJECTS_DIR, PROJECT, 'paper.tex'), texDoc(BODY, '\\newcommand{\\bW}{\\mathbf{W}}'));
});
test.afterAll(() => { rmSync(join(PROJECTS_DIR, PROJECT), { recursive: true, force: true }); });

async function open(page: Page, prefs: Record<string, unknown>) {
  await page.addInitScript((p) => { try { localStorage.setItem('ol.prefs', JSON.stringify(p)); } catch { /* ignore */ } }, prefs);
  await login(page);
  await page.goto('/#/' + DOC);
  await page.waitForFunction(() => document.querySelectorAll('.lyx-editor .lyx-par').length > 3, null, { timeout: 30000 });
  await page.waitForTimeout(500);
}
/** the cursor at the end of top-level paragraph `i` (a click could land in a formula, End on a wrapped line) */
const cursorAtEndOf = (page: Page, i: number) => page.evaluate((i) => {
  const v = (window as any).overlyx.activeView; const doc = v.state.doc;
  let end = 0; for (let k = 0; k <= i; k++) end += doc.child(k).nodeSize;
  v.dispatch(v.state.tr.setSelection(v.state.selection.constructor.create(doc, end - 1)));
}, i);
const selectParagraph = (page: Page, i: number) => page.evaluate((i) => {
  const v = (window as any).overlyx.activeView; const doc = v.state.doc;
  let start = 0; for (let k = 0; k < i; k++) start += doc.child(k).nodeSize;
  v.dispatch(v.state.tr.setSelection(v.state.selection.constructor.create(doc, start + 1, start + 1 + doc.child(i).content.size)));
}, i);

test('the right-click menu: clipboard first, formatting, insert, spell checking; Shift passes to the browser', async ({ page }) => {
  await open(page, { spellcheck: true, aiRewrite: false });
  const par = page.locator('.lyx-editor .lyx-par').nth(2);
  await par.click({ button: 'right', position: { x: 12, y: 8 } });
  const items = (await page.locator('.ctx-menu .ctx-item').allTextContents()).map(t => t.replace(/Ctrl\+\w|⌘\w|▸/g, '').trim());
  expect(items.slice(0, 3)).toEqual(['Cut', 'Copy', 'Paste']);
  expect(items).toContain('Text style');
  expect(items).toContain('Paragraph layout');
  expect(items).toContain('Insert');
  expect(items).toContain('Spell checking');
  expect(items.some(t => t.startsWith('Write here with AI'))).toBe(false);   // off by default
  // the spell-checking entry is a live switch
  await page.locator('.ctx-menu .ctx-item', { hasText: 'Spell checking' }).click();
  await expect(page.locator('.lyx-editor')).toHaveAttribute('spellcheck', 'false');
  // Shift+right-click is left to the browser: no OverLyX menu
  await par.click({ button: 'right', position: { x: 12, y: 8 }, modifiers: ['Shift'] });
  await expect(page.locator('.ctx-menu')).toHaveCount(0);
  // a selection adds "Comment on this" / "Turn into a formula"
  await selectParagraph(page, 2);
  await par.click({ button: 'right', position: { x: 12, y: 8 } });
  await expect(page.locator('.ctx-menu .ctx-item', { hasText: 'Turn into a formula' })).toHaveCount(1);
  await expect(page.locator('.ctx-menu .ctx-item', { hasText: 'Comment on this' })).toHaveCount(1);
  await page.keyboard.press('Escape');
});

test('spell checking: toolbar button and Tools menu, remembered per browser', async ({ page }) => {
  await open(page, { spellcheck: true });
  await expect(page.locator('.lyx-editor')).toHaveAttribute('spellcheck', 'true');
  await expect(page.locator('[data-tb="spellcheck"]')).toHaveClass(/active/);
  await page.click('[data-tb="spellcheck"]');
  await expect(page.locator('.lyx-editor')).toHaveAttribute('spellcheck', 'false');
  await expect(page.locator('[data-tb="spellcheck"]')).not.toHaveClass(/active/);
  expect(JSON.parse(await page.evaluate(() => localStorage.getItem('ol.prefs')!)).spellcheck).toBe(false);
  await page.click('.menubar .menu button:has-text("Tools")');
  await page.click('.menu-item:has-text("Spell checking")');
  await expect(page.locator('.lyx-editor')).toHaveAttribute('spellcheck', 'true');
});

test('AI switches live in Tools ▸ AI assistance and the preferences; the palette finds them', async ({ page }) => {
  await open(page, { aiRewrite: false, aiCompleteText: false });
  await page.click('.menubar .menu button:has-text("Tools")');
  await page.click('.menu-item:has-text("Preferences")');
  const dlg = page.locator('.dialog');
  await expect(dlg).toContainText('AI assistance');
  await dlg.locator('[data-pref="aiRewrite"]').check();
  await dlg.locator('[data-pref="aiCompleteText"]').check();
  await page.keyboard.press('Escape');
  const prefs = JSON.parse(await page.evaluate(() => localStorage.getItem('ol.prefs')!));
  expect(prefs.aiRewrite).toBe(true);
  expect(prefs.aiCompleteText).toBe(true);
  // the command palette lists the switches (checked state included)
  await page.keyboard.press('Control+Shift+p');
  await page.locator('[data-help-search]').fill('autocomplete');
  await expect(page.locator('[data-help-result]', { hasText: 'Autocomplete text' })).toHaveCount(1);
  await expect(page.locator('[data-help-result]', { hasText: 'Autocomplete text' })).toHaveClass(/checked/);
  await page.keyboard.press('Escape');
  // with rewriting on, the context menu and the toolbar button offer it
  await page.locator('.lyx-editor .lyx-par').nth(2).click({ button: 'right', position: { x: 12, y: 8 } });
  await expect(page.locator('.ctx-menu .ctx-item', { hasText: 'with AI' })).toHaveCount(1);
  await page.keyboard.press('Escape');
  await expect(page.locator('[data-tb="ai"]')).toHaveClass(/active/);
});

test.describe('with the AI stub', () => {
  test.skip(!AI_STUB, 'start the server with OPENROUTER_API_URL=http://127.0.0.1:3999 OPENROUTER_API_KEY=test-key and `node scripts/ai-stub.mjs`, then OVERLYX_E2E_AI_STUB=1');

  test('⌘K rewrites a selection: preview in place (formula and citation rendered), Enter applies, Esc rejects', async ({ page }) => {
    await open(page, { aiRewrite: true, aiCompleteText: false, aiCompleteMath: false });
    const par = page.locator('.lyx-editor .lyx-par').nth(2);
    await par.click({ position: { x: 12, y: 8 } });
    await selectParagraph(page, 2);
    await page.keyboard.press('Control+k');
    const panel = page.locator('.ai-panel[data-ai-panel="text"]');
    await expect(panel).toBeVisible();
    await page.keyboard.type('make it crisper');
    await page.keyboard.press('Enter');
    await expect(page.locator('.ai-new')).toBeVisible({ timeout: 10000 });
    await expect(page.locator('.ai-old').first()).toBeVisible();
    await expect(page.locator('.ai-new .katex')).toHaveCount(1);              // the proposal's $g$ is rendered in the preview
    // the document is untouched while the proposal is on show
    expect(await par.evaluate(el => el.textContent)).toContain('The variance of the weights');
    await page.keyboard.press('Escape');
    await expect(panel).toHaveCount(0);
    await expect(page.locator('.ai-new')).toHaveCount(0);
    expect(await par.evaluate(el => el.textContent)).toContain('The variance of the weights');
    // again, and accept this time
    await selectParagraph(page, 2);
    await page.keyboard.press('Control+k');
    await page.keyboard.type('make it crisper');
    await page.keyboard.press('Enter');
    await expect(page.locator('.ai-new')).toBeVisible({ timeout: 10000 });
    await page.keyboard.press('Enter');
    await expect(panel).toHaveCount(0);
    await expect(par).toContainText('Rewritten (make it crisper)');
    await expect(par.locator('.lyx-math-inline')).toHaveCount(1);
    await expect(par.locator('.lyx-command-citation')).toHaveCount(1);
    // an empty selection writes at the cursor; a two-paragraph reply becomes two paragraphs
    await cursorAtEndOf(page, 4);
    await page.keyboard.press('Control+k');
    await page.keyboard.type('two paragraphs please');
    await page.keyboard.press('Enter');
    await expect(page.locator('.ai-new.block')).toBeVisible({ timeout: 10000 });
    await page.keyboard.press('Enter');
    await expect(page.locator('.lyx-editor .lyx-par').nth(-2)).toHaveText('The last paragraph of the paper.First proposed paragraph with x2.');
    await expect(page.locator('.lyx-editor .lyx-par').last()).toHaveText('Second proposed paragraph.');
  });

  test('autocomplete: ghost text with a rendered formula after a pause, Tab inserts it, Esc dismisses it', async ({ page }) => {
    await open(page, { aiRewrite: false, aiCompleteText: true, aiCompleteMath: false, aiCompleteDelay: 200 });
    const p = page.locator('.lyx-editor .lyx-par').nth(1);
    await p.click({ position: { x: 12, y: 8 } });
    await cursorAtEndOf(page, 1);
    await page.keyboard.type(' The chaos');
    const ghost = page.locator('.ai-ghost');
    await expect(ghost).toBeVisible({ timeout: 10000 });
    await expect(ghost).toContainText('is governed by the largest Lyapunov exponent');
    await expect(ghost.locator('.katex')).toHaveCount(1);
    await page.keyboard.press('Tab');
    await expect(ghost).toHaveCount(0);
    await expect(p).toContainText('The chaos is governed by the largest Lyapunov exponent');
    await expect(p.locator('.lyx-math-inline')).toHaveCount(3);   // \bW, \lambda, and the inserted \lambda_1
    await page.keyboard.type(' More');
    await expect(ghost).toBeVisible({ timeout: 10000 });
    await page.keyboard.press('Escape');
    await expect(ghost).toHaveCount(0);
    expect(await p.textContent()).not.toContain('More is governed');
    // IDE mechanics: typing the suggestion's beginning keeps it (shorter); ⌘/Ctrl+→ takes the next word
    await page.keyboard.type(' x');
    await expect(ghost).toBeVisible({ timeout: 10000 });
    await page.keyboard.type(' is gov', { delay: 40 });
    await expect(ghost).toHaveText(/^erned by the largest/);
    await page.keyboard.press('Control+ArrowRight');
    await expect(ghost).toHaveText(/^by the largest/);
    expect(await p.textContent()).toContain('More x is governed by the largest');
    // a different character ends it; a reply that arrives while typing its beginning is shown trimmed
    await page.keyboard.type('Q');
    await expect(ghost).toHaveCount(0);
    await page.keyboard.type(' and');
    await page.waitForTimeout(250);                       // the request is now in flight (stub: 300 ms)
    await page.keyboard.type(' is gove', { delay: 30 });  // typed meanwhile = the reply's beginning
    await expect(ghost).toBeVisible({ timeout: 10000 });
    await expect(ghost).toHaveText(/^rned by the largest/);
  });

  test('formulas: ghost continuation at the caret (Tab inserts) and ⌘K rewrite with a rendered proposal', async ({ page }) => {
    await open(page, { aiRewrite: true, aiCompleteText: false, aiCompleteMath: true, aiCompleteDelay: 200 });
    const disp = page.locator('.lyx-editor .lyx-math-display').first();
    await disp.click();
    await expect(page.locator('.lyx-math-display .lm-field.focused')).toHaveCount(1);
    await page.keyboard.press('End');
    await page.keyboard.type('+1');
    await expect(page.locator('.lm-ghost')).toBeVisible({ timeout: 10000 });
    await page.keyboard.press('Tab');
    const latex = () => page.evaluate(() => { let l = ''; (window as any).overlyx.activeView.state.doc.descendants((n: any) => { if (n.type.name === 'math_display') l = n.attrs.latex; }); return l; });
    expect(await latex()).toContain('\\log g+1+\\frac{\\sigma^{2}}{2}g^{2}');
    await expect(page.locator('.lm-ghost')).toHaveCount(0);
    await page.keyboard.press('Control+k');
    await expect(page.locator('.ai-panel[data-ai-panel="math"]')).toBeVisible();
    await page.keyboard.type('as a fraction');
    await page.keyboard.press('Enter');
    await expect(page.locator('.ai-preview .katex')).toBeVisible({ timeout: 10000 });
    await page.keyboard.press('Enter');
    await expect(page.locator('.ai-panel')).toHaveCount(0);
    expect(await latex()).toContain('\\frac{\\alpha}{\\beta}+\\sqrt{x}');
  });
});
