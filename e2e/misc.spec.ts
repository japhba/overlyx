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
