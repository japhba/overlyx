/**
 * OverLyX's own spell checker: misspelt words are underlined soon after a document opens (no
 * click, no wait for the browser), formulas and code are left alone, the right-click menu offers
 * corrections and "add to dictionary", and the browser engine can be chosen instead.
 */
import { test, expect } from '@playwright/test';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { login, PROJECTS_DIR, texDoc } from './helpers';

const PROJECT = 'e2e-spell';
const DOC = `${PROJECT}/paper.tex`;

test.beforeAll(() => {
  rmSync(join(PROJECTS_DIR, PROJECT), { recursive: true, force: true });
  mkdirSync(join(PROJECTS_DIR, PROJECT), { recursive: true });
  writeFileSync(join(PROJECTS_DIR, PROJECT, 'paper.tex'), texDoc(`\\section{Introduction}

Recurent networks with weights $\\bW$ show rich dynamcs, as RNNs and \\texttt{codeword} do.

\\begin{equation}
\\lambda = \\log g
\\end{equation}

The last paragraph.`, '\\newcommand{\\bW}{\\mathbf{W}}'));
});
test.afterAll(() => { rmSync(join(PROJECTS_DIR, PROJECT), { recursive: true, force: true }); });

test('misspelt words are underlined on load; formulas, acronyms and code are not; the menu corrects them', async ({ page }) => {
  await page.addInitScript(() => { try { localStorage.setItem('ol.prefs', JSON.stringify({ spellcheck: true, spellEngine: 'overlyx' })); localStorage.removeItem('ol.spell.words'); } catch { /* ignore */ } });
  await login(page);
  await page.goto('/#/' + DOC);
  await page.waitForFunction(() => document.querySelectorAll('.lyx-editor .lyx-par').length > 2, null, { timeout: 30000 });
  const errors = page.locator('.lyx-editor .spell-error');
  await expect(errors).toHaveCount(2, { timeout: 15000 });
  expect(await errors.allTextContents()).toEqual(['Recurent', 'dynamcs']);
  await expect(page.locator('.lyx-editor')).toHaveAttribute('spellcheck', 'false');   // no second set of underlines from the browser
  // the menu: suggestions, then the replacement
  await errors.first().click({ button: 'right' });
  const menu = page.locator('.ctx-menu');
  await expect(menu.locator('.ctx-item.info').first()).toContainText('“Recurent” is not in the dictionary');
  await menu.locator('.ctx-item', { hasText: /^Recurrent$/ }).click();
  await expect(page.locator('.lyx-editor .lyx-par').nth(1)).toContainText('Recurrent networks');
  await expect(errors).toHaveCount(1, { timeout: 5000 });
  // add to the dictionary: gone, and remembered per browser
  await errors.first().click({ button: 'right' });
  await menu.locator('.ctx-item', { hasText: 'Add “dynamcs” to the dictionary' }).click();
  await expect(errors).toHaveCount(0, { timeout: 5000 });
  expect(JSON.parse(await page.evaluate(() => localStorage.getItem('ol.spell.words')!))).toContain('dynamcs');
  // typing: the word under the caret is left alone until the caret moves on
  await page.locator('.lyx-editor .lyx-par').last().click({ position: { x: 12, y: 8 } });
  await page.keyboard.press('End');
  await page.keyboard.type(' Anothr');
  await page.waitForTimeout(600);
  await expect(errors).toHaveCount(0);
  await page.keyboard.type(' word');
  await expect(errors).toHaveCount(1, { timeout: 5000 });
  expect(await errors.first().textContent()).toBe('Anothr');
});

test('the browser engine can be chosen instead (no OverLyX underlines, spellcheck attribute on)', async ({ page }) => {
  await page.addInitScript(() => { try { localStorage.setItem('ol.prefs', JSON.stringify({ spellcheck: true, spellEngine: 'browser' })); } catch { /* ignore */ } });
  await login(page);
  await page.goto('/#/' + DOC);
  await page.waitForFunction(() => document.querySelectorAll('.lyx-editor .lyx-par').length > 2, null, { timeout: 30000 });
  await page.waitForTimeout(1500);
  await expect(page.locator('.lyx-editor .spell-error')).toHaveCount(0);
  await expect(page.locator('.lyx-editor')).toHaveAttribute('spellcheck', 'true');
  await page.click('.menubar .menu button:has-text("Tools")');
  await page.click('.menu-item:has-text("Settings")');
  await page.locator('[data-pref="spellEngine"]').selectOption('overlyx');
  await page.keyboard.press('Escape');
  await expect(page.locator('.lyx-editor .spell-error')).toHaveCount(2, { timeout: 15000 });
  await expect(page.locator('.lyx-editor')).toHaveAttribute('spellcheck', 'false');
});

// runs last: it types typos into the shared fixture, which the counts above rely on
test('autocorrect: a minor typo snaps into place after the word, Backspace puts it back', async ({ page }) => {
  await page.addInitScript(() => { try { localStorage.setItem('ol.prefs', JSON.stringify({ spellcheck: true, spellEngine: 'overlyx', autoCorrect: true })); localStorage.removeItem('ol.spell.words'); } catch { /* ignore */ } });
  await login(page);
  await page.goto('/#/' + DOC);
  await page.waitForFunction(() => document.querySelectorAll('.lyx-editor .lyx-par').length > 2, null, { timeout: 30000 });
  const par = page.locator('.lyx-editor .lyx-par').last();
  await par.click({ position: { x: 12, y: 8 } });
  await page.keyboard.press('End');
  // give the dictionary a moment (the worker loads on demand), then type a classic typo
  await page.waitForSelector('.lyx-editor .spell-error', { timeout: 15000 });
  await page.keyboard.type(' I recieve teh');
  await page.keyboard.type(' ');
  // every finished word is looked at: the space after 'recieve' fixed it, the one after 'teh' fixed that
  await expect(par).toContainText('I receive the ', { timeout: 10000 });
  // Backspace right after: the last correction comes back and that word stays (this session)
  await page.keyboard.press('Backspace');
  await expect(par).toContainText('I receive teh', { timeout: 5000 });
  await page.keyboard.press('End');
  await page.keyboard.type(' and teh');
  await page.keyboard.type(' ');
  await page.waitForTimeout(800);
  await expect(par).toContainText('and teh ');                                 // reverted words are left alone
  // …and inside a formula nothing is ever corrected (typing goes through the math field)
  await page.keyboard.press('Control+m');
  await page.keyboard.type('teh ');
  await page.waitForTimeout(600);
  const formula = par.locator('.lyx-math-inline').last();
  await expect(formula).toBeVisible();
  expect((await formula.textContent()) ?? '').not.toContain('the');
});
