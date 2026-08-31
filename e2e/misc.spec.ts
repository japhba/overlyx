/**
 * Small editor features: the find bar's case / whole-word options, word deletion, the source pane
 * shortcut, the statistics dialog.
 */
import { test, expect, type Page } from '@playwright/test';
import { mkdirSync, rmSync, readFileSync, writeFileSync, copyFileSync, existsSync } from 'node:fs';
import { login, collectErrors, PROJECTS_DIR, FIXTURES_DIR, withPreambleOf } from './helpers';

const SRC = `${FIXTURES_DIR}/recurrent_feature`;
const PROJECT = 'e2e-misc';
const DIR = `${PROJECTS_DIR}/${PROJECT}`;

const doc = () => withPreambleOf(`${SRC}/main.tex`, `The cat sat on the Cat mat; concatenate cats.

Delete these words please.
`);

test.beforeAll(() => {
  rmSync(DIR, { recursive: true, force: true });
  mkdirSync(DIR, { recursive: true });
  for (const f of ['lyxmacros.tex', 'macros.tex', 'preamble.tex']) if (existsSync(`${SRC}/${f}`)) copyFileSync(`${SRC}/${f}`, `${DIR}/${f}`);
  writeFileSync(`${DIR}/misc.tex`, doc());
});
test.afterAll(() => { rmSync(DIR, { recursive: true, force: true }); });

async function open(page: Page) {
  await page.evaluate(() => { localStorage.setItem('ol.tabs', '[]'); });
  await page.goto(`/#/${PROJECT}/misc.tex`);
  await page.waitForFunction(() => document.querySelectorAll('.lyx-editor .lyx-par').length >= 2, null, { timeout: 60000 });
  await page.waitForTimeout(1500);
}

test('find: case-sensitive and whole-word options change the matches', async ({ page }) => {
  await login(page);
  await open(page);
  await page.locator('.lyx-editor .lyx-par').first().click();
  await page.keyboard.press('Control+f');
  const bar = page.locator('.find-bar');
  await bar.locator('input[type="text"], input:not([type])').first().fill('cat');
  await expect(bar).toContainText('4 matches');            // cat, Cat, concatenate, cats
  await bar.locator('label:has-text("Aa") input').check();
  await expect(bar).toContainText('3 matches');            // Cat drops out
  await bar.locator('label:has-text("Word") input').check();
  await expect(bar).toContainText('1 matches');            // only "cat"
  await bar.locator('label:has-text("Aa") input').uncheck();
  await expect(bar).toContainText('2 matches');            // cat, Cat
  await page.keyboard.press('Escape');
});

test('Ctrl+Backspace deletes a word; Ctrl+Alt+S toggles the source pane; statistics count words', async ({ page }) => {
  const errors = collectErrors(page);
  await login(page);
  await open(page);
  const second = page.locator('.lyx-editor .lyx-par').nth(1);
  await second.click();
  await page.keyboard.press('End');
  await page.keyboard.press('Control+Backspace');           // "please."
  await page.keyboard.press('Control+Backspace');           // "words "
  await expect(second).toHaveText(/^Delete these ?$/);
  await expect.poll(() => /Delete these ?\n\n\\end\{document\}/.test(readFileSync(`${DIR}/misc.tex`, 'utf8')), { timeout: 15000 }).toBe(true);
  await page.keyboard.press('Control+Alt+s');
  await expect(page.locator('.source-pane')).toBeVisible();
  await page.keyboard.press('Control+Alt+s');
  await expect(page.locator('.source-pane')).toHaveCount(0);
  await page.getByRole('button', { name: 'Document', exact: true }).first().click();
  await page.getByText('Statistics (word count)…').click();
  const dialog = page.locator('.dialog');
  await expect(dialog).toContainText('Statistics');
  const row = dialog.locator('table.stats tbody tr', { hasText: 'Document' });
  await expect(row.locator('td').nth(1)).toHaveText('11');   // 9 + 2 words
  await expect(errors).toEqual([]);
});

test('a dead-key ^ (German/French layouts: a composition) makes exactly one superscript', async ({ page }) => {
  const errors = collectErrors(page);
  await login(page);
  await open(page);
  await page.locator('.lyx-editor .lyx-par').nth(1).click();
  await page.keyboard.press('End');
  await page.keyboard.press('Control+m');
  await page.keyboard.type('x');
  // what Chrome sends for a dead ^ followed by a non-composable key: a composition of "^" that is
  // committed (input event while composing, then compositionend), then the next key as plain text
  await page.evaluate(() => {
    const ta = document.activeElement as HTMLTextAreaElement;
    if (!ta || !ta.classList.contains('lm-input')) throw new Error('math field not focused');
    ta.dispatchEvent(new CompositionEvent('compositionstart', { data: '' }));
    ta.value = '^';
    ta.dispatchEvent(new InputEvent('input', { inputType: 'insertCompositionText', data: '^', isComposing: true, bubbles: true }));
    ta.dispatchEvent(new CompositionEvent('compositionend', { data: '^' }));
  });
  await page.keyboard.type('2');
  const latex = await page.evaluate(() => (document.querySelector('.lyx-editor .lyx-math-inline') as any).pmViewDesc.spec.field.latex as string);
  expect(latex).toBe('$x^{2}$');
  // the plain (US-layout) ^ keeps working the same way
  await page.keyboard.press('Escape');
  await page.keyboard.type('^3');
  expect(await page.evaluate(() => (document.querySelector('.lyx-editor .lyx-math-inline') as any).pmViewDesc.spec.field.latex as string)).toBe('$x^{2}$');
  expect(errors).toEqual([]);
});

test('sections can be reordered and re-levelled from the outline', async ({ page }) => {
  writeFileSync(`${DIR}/sections.tex`, withPreambleOf(`${SRC}/main.tex`, '\\section{Alpha}\n\nfirst\n\n\\subsection{Alpha one}\n\nnested\n\n\\section{Beta}\n\nsecond\n'));
  await login(page);
  await page.evaluate(() => { localStorage.setItem('ol.tabs', '[]'); localStorage.setItem('ol.right', 'outline'); });
  await page.goto(`/#/${PROJECT}/sections.tex`);
  await page.waitForFunction(() => document.querySelectorAll('.lyx-editor .lyx-par').length >= 6, null, { timeout: 60000 });
  await page.waitForTimeout(1000);
  const items = page.locator('.outline-item');
  const texts = page.locator('.outline-item .outline-text');   // (the row's text without its buttons)
  await expect(texts).toHaveText([/Alpha$/, /Alpha one/, /Beta/]);
  // Alpha ▼: Beta comes first, Alpha keeps its subsection
  await items.nth(0).hover();
  await items.nth(0).locator('[data-outline="down"]').click();
  await expect(texts).toHaveText([/Beta/, /Alpha$/, /Alpha one/]);
  await expect(texts.nth(0)).toContainText('1');
  await expect(texts.nth(1)).toContainText('2');
  // Alpha one ◀: promoted to a section, numbered 3
  await items.nth(2).hover();
  await items.nth(2).locator('[data-outline="out"]').click();
  await expect(items.nth(2)).toHaveClass(new RegExp('\\b' + /\bl\d\b/.exec((await items.nth(0).getAttribute('class')) ?? '')![0] + '\\b'));   // same level class as the sections
  await expect(texts.nth(2)).toContainText('3');
  await expect(items.nth(2).locator('[data-outline="up"]')).toBeEnabled();
  await expect(items.nth(0).locator('[data-outline="up"]')).toBeDisabled();
  // it is written to the file in the new order and level
  await expect.poll(() => readFileSync(`${DIR}/sections.tex`, 'utf8').replace(/\s+/g, ' '), { timeout: 15000 }).toMatch(/\\section\{Beta\} second \\section\{Alpha\} first \\section\{Alpha one\} nested/);
  // the Edit menu works on the cursor's section: move Alpha one up again
  await page.locator('.lyx-editor .lyx-par', { hasText: 'nested' }).click();
  await page.locator('.menubar .menu > button', { hasText: 'Edit' }).click();
  await page.locator('.menu-item', { hasText: 'Paragraph' }).first().hover();
  await page.locator('.menu-item:not(.menu-sub)', { hasText: 'Move section up' }).click();
  await expect(texts).toHaveText([/Beta/, /Alpha one/, /Alpha$/]);
});

test('resolved comments leave the text and live in the Comments panel archive, from where they can be reopened', async ({ page }) => {
  writeFileSync(`${DIR}/threads.tex`, withPreambleOf(`${SRC}/main.tex`, 'Some text %\n%% @comment\n%% Jan Bauer (2026-08-26 14:03):\n%%\n%% Please check this claim.\n%% @end\nwith an open comment, and %\n%% @comment\n%% Kirsten Fischer (2026-08-27 09:10) [resolved]:\n%%\n%% Done already.\n%% @end\na resolved one.\n'));
  await login(page);
  await page.evaluate(() => { localStorage.setItem('ol.tabs', '[]'); localStorage.setItem('ol.right', 'comments'); localStorage.setItem('ol.margin', '0'); });
  await page.goto(`/#/${PROJECT}/threads.tex`);
  await page.waitForFunction(() => document.querySelectorAll('.lyx-editor .lyx-inset-note-comment').length === 2, null, { timeout: 60000 });
  await page.waitForTimeout(800);
  const rail = page.locator('.rail.right [data-rail="comments"]');
  if (await rail.count()) await rail.click(); else await page.locator('.panel-tabs [data-tab="comments"]').click();
  const cards = page.locator('.lyx-editor .lyx-inset-note-comment');
  // the resolved thread shows no card in the text, only its marker
  await expect(cards.nth(0).locator('> .inset-box')).toBeVisible();
  await expect(cards.nth(1)).toHaveClass(/resolved/);
  await expect(cards.nth(1).locator('> .inset-box')).toBeHidden();
  await expect(cards.nth(1).locator('> .inset-anchor')).toBeVisible();
  // the panel lists both, in their sections
  const panel = page.locator('.comments-panel');
  await expect(panel.locator('[data-comment="open"]')).toHaveCount(1);
  await expect(panel.locator('[data-comment="resolved"]')).toHaveCount(1);
  await expect(panel.locator('[data-comment="open"]')).toContainText('Jan Bauer');
  await expect(panel.locator('[data-comment="resolved"]')).toContainText('Done already.');
  // resolve the open one from the panel: it leaves the text and joins the archive
  await panel.locator('[data-comment="open"] [data-action="resolve"]').click();
  await expect(panel.locator('[data-comment="open"]')).toHaveCount(0);
  await expect(panel.locator('[data-comment="resolved"]')).toHaveCount(2);
  await expect(cards.nth(0).locator('> .inset-box')).toBeHidden();
  // (the writer escapes the brackets LaTeX-style; the parser reads both forms)
  await expect.poll(() => readFileSync(`${DIR}/threads.tex`, 'utf8'), { timeout: 15000 }).toMatch(/Jan Bauer \(2026-08-26 14:03\) (\[|\{\[\})resolved(\]|\{\]\}):/);
  // reopen the other one from the archive: its card is back, the panel jumps to it
  await panel.locator('[data-comment="resolved"]', { hasText: 'Kirsten' }).locator('[data-action="reopen"]').click();
  await expect(panel.locator('[data-comment="open"]')).toHaveCount(1);
  await expect(cards.nth(1).locator('> .inset-box')).toBeVisible();
  await panel.locator('[data-comment="open"]').click();
  await expect(cards.nth(1)).toHaveClass(/highlight/);
});

test('a window resize after leaving the document does not crash (margin plugin cleanup)', async ({ page }) => {
  const errors = collectErrors(page);
  await login(page);
  await open(page);
  await page.locator('.menubar .brand').click();
  await page.waitForSelector('.home', { timeout: 20000 });
  await page.setViewportSize({ width: 1200, height: 800 });
  await page.waitForTimeout(300);
  await page.setViewportSize({ width: 1380, height: 880 });
  await page.waitForTimeout(500);
  expect(errors.filter(e => !/favicon|ERR_INTERNET|net::/.test(e))).toEqual([]);
});
