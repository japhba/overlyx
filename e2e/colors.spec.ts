/**
 * Colours: seaborn's palette in the colour pickers (app/seaborn.tsx — muted by default, right-click
 * for deep / pastel / bright / dark / colorblind / tab10, remembered), and people's colours (server
 * db.ts USER_COLORS: LyX's blue, red, amber first) with readable cursor labels (app/contrast.ts).
 */
import { test, expect } from '@playwright/test';
import { mkdirSync, rmSync, writeFileSync, readFileSync } from 'node:fs';
import { login, collectErrors, PROJECTS_DIR, texDoc, apiLogin, userCredentials, BASE_URL, TOUR_SEEN_SCRIPT, shareProject } from './helpers';

const PROJECT = 'admin/e2e-colors';
const DIR = `${PROJECTS_DIR}/${PROJECT}`;
test.beforeAll(() => {
  rmSync(DIR, { recursive: true, force: true });
  mkdirSync(DIR, { recursive: true });
  writeFileSync(`${DIR}/c.tex`, texDoc('A paragraph to colour.\n\nAnother paragraph, where the collaborator waits.'));
});
test.afterAll(() => rmSync(DIR, { recursive: true, force: true }));
const noise = (errors: string[]) => errors.filter(e => !/favicon|ResizeObserver|willReadFrequently/.test(e));

test('the colour picker has seaborn\'s palette: muted first, the other variants on a right-click, remembered; a pick colours the text', async ({ page }) => {
  const errors = collectErrors(page);
  await login(page);
  await page.goto(`/#/${PROJECT}/c.tex`);
  await page.waitForFunction(() => document.querySelectorAll('.lyx-editor .lyx-par').length > 0, null, { timeout: 30000 });
  // the word "colour", double-clicked
  const at = await page.evaluate(() => {
    const walker = document.createTreeWalker(document.querySelector('.lyx-editor')!, NodeFilter.SHOW_TEXT);
    for (let n = walker.nextNode(); n; n = walker.nextNode()) {
      const i = n.textContent!.indexOf('colour');
      if (i < 0) continue;
      const range = document.createRange(); range.setStart(n, i); range.setEnd(n, i + 6);
      const b = range.getBoundingClientRect(); return { x: b.x + b.width / 2, y: b.y + b.height / 2 };
    }
    return null;
  });
  await page.mouse.dblclick(at!.x, at!.y);
  await page.locator('[data-tb="textcolor"]').first().click();
  const row = page.locator('[data-palette="textcolor"] [data-seaborn]');
  await expect(row).toHaveAttribute('data-seaborn', 'muted');
  await expect(row.locator('[data-color]')).toHaveCount(10);
  await row.locator('[data-color]').first().click({ button: 'right' });
  await expect(row.locator('[data-seaborn-variant]')).toHaveCount(7);
  await row.locator('[data-seaborn-variant="deep"]').click();
  await expect(row).toHaveAttribute('data-seaborn', 'deep');
  await row.locator('[data-color="#4c72b0"]').click();
  await expect(page.locator('.lyx-editor .lyx-color-custom')).toHaveText('colour');
  await expect(page.locator('.lyx-editor .lyx-color-custom')).toHaveCSS('color', 'rgb(76, 114, 176)');
  await expect.poll(() => readFileSync(`${DIR}/c.tex`, 'utf8'), { timeout: 15000 }).toMatch(/\\textcolor\[HTML\]\{4C72B0\}\{colour\}/i);
  // remembered: the next picker opens on deep
  await page.locator('[data-tb="textcolor"]').first().click();
  await expect(page.locator('[data-palette="textcolor"] [data-seaborn]')).toHaveAttribute('data-seaborn', 'deep');
  await page.keyboard.press('Escape');
  expect(noise(errors)).toEqual([]);
});

test('people get LyX\'s colours, and a light one (amber) gets a dark cursor label', async ({ page, browser }) => {
  await shareProject(browser, PROJECT, ['carol'], 'edit');
  const ctx = await browser.newContext();
  await ctx.addInitScript(TOUR_SEEN_SCRIPT);
  await apiLogin(ctx, userCredentials('carol'));
  const carol = await ctx.newPage();
  const me = await (await carol.request.get(BASE_URL + '/api/auth/me')).json();
  expect(['#2152a3', '#d6402b', '#e0a40c', '#55a868', '#8172b3', '#64b5cd', '#da8bc3', '#937860', '#12711c', '#a23582', '#ccb974', '#006374']).toContain(me.user.color);
  await carol.goto(`${BASE_URL}/#/${PROJECT}/c.tex`);
  await carol.waitForFunction(() => document.querySelectorAll('.lyx-editor .lyx-par').length > 0, null, { timeout: 30000 });
  await carol.locator('.lyx-editor .lyx-par').nth(1).click();
  await login(page);
  await page.goto(`/#/${PROJECT}/c.tex`);
  const label = page.locator('.ProseMirror-yjs-cursor > div').first();
  await expect(label).toBeVisible({ timeout: 15000 });
  const { bg, fg } = await label.evaluate(e => ({ bg: getComputedStyle(e).backgroundColor, fg: getComputedStyle(e).color }));
  const lum = (css: string) => { const [r, g, b] = css.match(/\d+/g)!.map(Number); return (0.299 * r + 0.587 * g + 0.114 * b) / 255; };
  expect(Math.abs(lum(bg) - lum(fg))).toBeGreaterThan(0.4);   // the name reads on its colour, whichever it is
  await ctx.close();
});
