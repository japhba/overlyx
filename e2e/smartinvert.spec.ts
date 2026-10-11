/**
 * Smart invert in the theme switch's menu (MenuBar.tsx themeMenuItems, app/darkpages.ts): one switch
 * for the pages of every kind — here a document's: dark in the dark theme, white paper inside the
 * dark interface when it is off — and one for their figures (a plot on white goes light on dark with
 * the page); the Settings' Appearance section has the same switches.
 */
import { test, expect, type Page } from '@playwright/test';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { login, PROJECTS_DIR, texDoc, png } from './helpers';

const PROJECT = 'admin/e2e-smartinvert';
const DIR = `${PROJECTS_DIR}/${PROJECT}`;
const FIGURE = 'invert(0.93) hue-rotate(180deg)';

test.beforeAll(() => {
  rmSync(DIR, { recursive: true, force: true });
  mkdirSync(DIR, { recursive: true });
  writeFileSync(`${DIR}/plot.png`, png(160, 100, (x, y) => (Math.abs(y - (50 + 30 * Math.sin(x / 15))) < 2 ? [20, 40, 160] : [255, 255, 255])));
  writeFileSync(`${DIR}/main.tex`, texDoc([
    'Smart invert: black text and \\textcolor{blue}{blue text}.',
    '',
    '\\begin{figure}[h]\\centering\\includegraphics[width=0.5\\linewidth]{plot.png}\\caption{A plot.}\\end{figure}',
  ].join('\n'), '\\usepackage{graphicx}\n\\usepackage{xcolor}'));
});
test.afterAll(() => { rmSync(DIR, { recursive: true, force: true }); });

const look = (page: Page) => page.evaluate(() => {
  const pg = document.querySelector('.editor-page')!, ed = pg.querySelector('.lyx-editor')!;
  const fig = pg.querySelector('.lyx-graphics img'), blue = pg.querySelector('.lyx-color-blue');
  return {
    page: getComputedStyle(pg).backgroundColor, text: getComputedStyle(ed).color,
    figure: fig ? getComputedStyle(fig).filter : null, blue: blue ? getComputedStyle(blue).color : null,
    chrome: getComputedStyle(document.querySelector('.menubar')!).backgroundColor,
  };
});
const menuItem = (page: Page, text: string) => page.locator('.ctx-menu[data-theme-menu] .ctx-item', { hasText: text });
async function openMenu(page: Page) {
  await page.locator('[data-theme-toggle]').first().click();
  await expect(page.locator('.ctx-menu[data-theme-menu]')).toBeVisible();
}

test('the theme switch’s menu: smart invert of the pages and their figures — a document turns white paper in the dark interface', async ({ page }) => {
  await page.addInitScript(() => { try { const p = JSON.parse(localStorage.getItem('ol.prefs') || '{}'); delete p.darkPages; delete p.invertFigures; p.autoBuild = 'off'; localStorage.setItem('ol.prefs', JSON.stringify(p)); localStorage.setItem('ol.theme', 'dark'); } catch { /* */ } });
  await login(page);
  await page.goto(`/#/${PROJECT}/main.tex`);
  await page.waitForFunction(() => !!document.querySelector('.lyx-editor .lyx-graphics.smart-invert img'), null, { timeout: 30000 });
  const dark = await look(page);
  expect(dark.page).toBe('rgb(18, 18, 22)');
  expect(dark.text).toBe('rgb(255, 255, 255)');
  expect(dark.figure).toBe(FIGURE);
  expect(dark.blue).toBe('rgb(127, 159, 255)');

  // the menu: the theme, smart invert of pages and figures, the text tone, the settings
  await openMenu(page);
  const menu = page.locator('.ctx-menu[data-theme-menu]');
  await expect(menu).toContainText('Smart invert in the dark theme');
  await expect(menuItem(page, 'Pages — documents, PDFs, slides')).toHaveClass(/checked/);
  await expect(menuItem(page, 'Figures too — photos keep their colours')).toHaveClass(/checked/);
  await expect(menu).toContainText('Text in the dark theme');
  await expect(menuItem(page, 'Appearance settings…')).toBeVisible();

  // figures off: the plot keeps its white, the page stays dark
  await menuItem(page, 'Figures too').click();
  await expect.poll(async () => (await look(page)).figure).toBe('none');
  expect((await look(page)).page).toBe('rgb(18, 18, 22)');
  await openMenu(page);
  await menuItem(page, 'Figures too').click();
  await expect.poll(async () => (await look(page)).figure).toBe(FIGURE);

  // pages off: white paper with the light theme's colours, the interface around it stays dark
  await openMenu(page);
  await menuItem(page, 'Pages — documents, PDFs, slides').click();
  await expect.poll(async () => (await look(page)).page).toBe('rgb(255, 255, 255)');
  const paper = await look(page);
  expect(paper.text).toBe('rgb(17, 17, 17)');
  expect(paper.figure).toBe('none');
  expect(paper.blue).toBe('rgb(0, 0, 221)');
  expect(paper.chrome).toBe(dark.chrome);
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');
  await openMenu(page);
  await expect(menuItem(page, 'Pages — documents, PDFs, slides')).not.toHaveClass(/checked/);
  await expect(menuItem(page, 'Figures too')).toHaveClass(/disabled/);

  // the settings: Appearance, the same switches
  await menuItem(page, 'Appearance settings…').click();
  const dialog = page.locator('.dialog');
  await expect(dialog.locator('.settings-nav button.active')).toHaveText('Appearance');
  await expect(dialog.locator('[data-pref="darkPages"]')).not.toBeChecked();
  await expect(dialog.locator('[data-pref="invertFigures"]')).toBeDisabled();
  await dialog.locator('[data-pref="darkPages"]').check();
  await expect.poll(async () => (await look(page)).page).toBe('rgb(18, 18, 22)');
  await expect(dialog.locator('[data-pref="invertFigures"]')).toBeEnabled();
  await dialog.locator('[data-pref-tone="sepia"]').check();
  await expect(page.locator('html')).toHaveAttribute('data-tone', 'sepia');
  await dialog.locator('[data-pref-tone="white"]').check();
  // kept in this browser
  expect(await page.evaluate(() => JSON.parse(localStorage.getItem('ol.prefs') || '{}').darkPages)).toBe(true);
});
