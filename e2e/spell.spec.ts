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
  await page.click('.menu-item:has-text("Preferences")');
  await page.locator('[data-pref="spellEngine"]').selectOption('overlyx');
  await page.keyboard.press('Escape');
  await expect(page.locator('.lyx-editor .spell-error')).toHaveCount(2, { timeout: 15000 });
  await expect(page.locator('.lyx-editor')).toHaveAttribute('spellcheck', 'false');
});
