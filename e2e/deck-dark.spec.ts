/**
 * Slides in the dark theme (app/darkpages.ts): the canvas around a deck's slide and a layout
 * document's pages is dark grey (a canvas colour chosen for the document still wins), and smart
 * invert — one switch for every kind of page, on by default — shows the slides light on dark on the
 * canvas and in the rail, never when presenting. Pictures: a photograph keeps its colours, a plot on
 * white goes light on dark with the slide (judged by its pixels; with "Figures too" off every picture
 * keeps its colours). The ◐ button beside the deck's zoom, the canvas's right-click menu and the theme
 * switch's menu switch it. Needs the seeded admin and the runtime built into the server's dist.
 */
import { test, expect, type Page, type Frame } from '@playwright/test';
import { mkdirSync, rmSync, writeFileSync, readFileSync } from 'node:fs';
import { login, PROJECTS_DIR, png } from './helpers';
import { starterDeck } from '../packages/core/src/html/deliverable';

const RUN = Date.now().toString(36);
const PROJECT = `admin/e2e-dark-${RUN}`;
const DARK_GREY = 'rgb(43, 44, 48)';
const INVERTED = 'invert(1) hue-rotate(180deg)';
/** a plot: a dark curve on white */
const PLOT = png(120, 80, (x, y) => (Math.abs(y - (40 + 25 * Math.sin(x / 12))) < 2 ? [20, 40, 160] : [255, 255, 255]));
/** a photograph: colour everywhere, with grain */
const PHOTO = png(120, 80, (x, y) => [(x * 7 + y * 13) % 200 + 40, (x * 3 + y * 29) % 180 + 50, (x * 17 + y * 5) % 160 + 60]);
test.describe.configure({ mode: 'serial' });
test.beforeAll(() => {
  mkdirSync(`${PROJECTS_DIR}/${PROJECT}/talk`, { recursive: true });
  writeFileSync(`${PROJECTS_DIR}/${PROJECT}/talk/plot.png`, PLOT);
  writeFileSync(`${PROJECTS_DIR}/${PROJECT}/talk/photo.png`, PHOTO);
  writeFileSync(`${PROJECTS_DIR}/${PROJECT}/plot.png`, PLOT);
  writeFileSync(`${PROJECTS_DIR}/${PROJECT}/photo.png`, PHOTO);
  // a photograph and a plot on the first slide
  writeFileSync(`${PROJECTS_DIR}/${PROJECT}/talk/index.html`, starterDeck('Dark').replace('</h1>', '</h1>\n  <img class="photo" src="photo.png" style="position: absolute; left: 900px; top: 500px; width: 120px; height: 80px" alt="">\n  <img class="plot" src="plot.png" style="position: absolute; left: 1060px; top: 500px; width: 120px; height: 80px" alt="">'));
  // a web page: white, black words, a photograph
  mkdirSync(`${PROJECTS_DIR}/${PROJECT}/site`, { recursive: true });
  writeFileSync(`${PROJECTS_DIR}/${PROJECT}/site/photo.png`, PHOTO);
  writeFileSync(`${PROJECTS_DIR}/${PROJECT}/site/index.html`, '<!doctype html><html><head><meta charset="utf-8"><meta name="overlyx" content="page"><title>Site</title></head><body style="margin:0;font:20px sans-serif;color:#000"><h1 style="margin:40px">A web page</h1><p style="margin:40px">Black words on white.</p><img class="photo" src="photo.png" style="margin:40px;width:240px;height:160px"></body></html>');
  writeFileSync(`${PROJECTS_DIR}/${PROJECT}/slides.tex`, String.raw`\documentclass[aspectratio=169]{beamer}
\begin{document}
\begin{frame}[plain]
\begin{olbox}{x=20mm,y=20mm,w=100mm,h=20mm,font=20pt}
Layout words
\end{olbox}
\olimage{x=20mm,y=50mm,w=30mm,h=20mm,name=Photo}{photo.png}
\olimage{x=60mm,y=50mm,w=30mm,h=20mm,name=Plot}{plot.png}
\end{frame}
\end{document}
`);
});
test.afterAll(() => rmSync(`${PROJECTS_DIR}/${PROJECT}`, { recursive: true, force: true }));

const frameOf = async (page: Page, sel: string): Promise<Frame> => (await (await page.locator(sel).elementHandle())!.contentFrame())!;
const slideFilter = async (f: Frame): Promise<string> => f.evaluate(`getComputedStyle(document.querySelector('section.slide')).filter`) as Promise<string>;
const imgFilter = async (f: Frame, cls: string): Promise<string> => f.evaluate(`getComputedStyle(document.querySelector('section.slide img.${cls}')).filter`) as Promise<string>;
const prefs = (page: Page) => page.evaluate(() => JSON.parse(localStorage.getItem('ol.prefs') ?? '{}') as Record<string, unknown>);

async function darkPage(page: Page): Promise<void> {
  await page.addInitScript(() => { try { localStorage.setItem('ol.theme', 'dark'); } catch { /* */ } });
  await login(page);
}
async function themeMenu(page: Page, item: string): Promise<void> {
  await page.locator('[data-theme-toggle]').first().click();
  await page.locator('.ctx-menu[data-theme-menu] .ctx-item', { hasText: item }).click();
}

test('a deck in the dark theme: dark grey canvas, slides smart-inverted (photo in its colours, plot with the slide), never when presenting', async ({ page }) => {
  await darkPage(page);
  await page.goto(`/#/${PROJECT}/talk/index.html`);
  await page.frameLocator('.dl-frame').locator('section.slide').first().waitFor({ timeout: 30000 });
  await page.frameLocator('.dl-railframe').locator('section.slide').first().waitFor({ timeout: 30000 });
  await page.waitForTimeout(800);
  // the canvas, inside the frame and around it, and the rail: dark grey
  await expect.poll(() => page.locator('.dl-canvas').evaluate(e => getComputedStyle(e).backgroundColor)).toBe(DARK_GREY);
  const canvas = await frameOf(page, '.dl-frame');
  const rail = await frameOf(page, '.dl-railframe');
  await expect.poll(() => canvas.evaluate('getComputedStyle(document.documentElement).backgroundColor')).toBe(DARK_GREY);
  await expect.poll(() => rail.evaluate('getComputedStyle(document.body).backgroundColor')).toBe(DARK_GREY);
  // smart invert is on by default: light on dark, on the canvas and in the rail
  await expect(page.locator('[data-dl-invert]')).toHaveAttribute('aria-pressed', 'true');
  await expect.poll(() => slideFilter(canvas)).toBe(INVERTED);
  await expect.poll(() => slideFilter(rail)).toBe(INVERTED);
  // the photograph back in its colours; the plot inverted with the slide (judged by its pixels)
  await expect.poll(() => imgFilter(canvas, 'photo')).toBe(INVERTED);
  await expect.poll(() => imgFilter(canvas, 'plot'), { timeout: 10000 }).toBe('none');
  await expect.poll(() => imgFilter(rail, 'plot'), { timeout: 10000 }).toBe('none');
  // "Figures too" off in the theme switch's menu: every picture keeps its colours
  await themeMenu(page, 'Figures too');
  await expect.poll(() => imgFilter(canvas, 'plot')).toBe(INVERTED);
  expect((await prefs(page)).invertFigures).toBe(false);
  await themeMenu(page, 'Figures too');
  await expect.poll(() => imgFilter(canvas, 'plot')).toBe('none');
  // ◐: the slides' own colours — one preference with the documents' and PDFs' pages
  await page.locator('[data-dl-invert]').click();
  await expect(page.locator('[data-dl-invert]')).toHaveAttribute('aria-pressed', 'false');
  await expect.poll(() => slideFilter(canvas)).toBe('none');
  await expect.poll(() => slideFilter(rail)).toBe('none');
  expect(await imgFilter(canvas, 'photo')).toBe('none');
  expect((await prefs(page)).darkPages).toBe(false);
  await page.locator('[data-dl-invert]').click();
  await expect.poll(() => slideFilter(canvas)).toBe(INVERTED);
  // presenting: as designed
  await page.locator('[data-dl-present]').click();
  const pres = page.frameLocator('.dl-presenting iframe');
  await expect(pres.locator('section.slide[data-ol-current]')).toHaveCount(1, { timeout: 15000 });
  const present = await frameOf(page, '.dl-presenting iframe');
  expect(await slideFilter(present)).toBe('none');
  await page.keyboard.press('Escape');
  await expect(page.locator('.dl-presenting')).toHaveCount(0, { timeout: 10000 });
  // a canvas colour chosen for the document wins over the dark grey; "Automatic" brings it back
  const box = (await page.locator('.dl-canvas').boundingBox())!;
  await page.mouse.click(box.x + 20, box.y + box.height - 20, { button: 'right' });
  await page.locator('.ctx-menu').first().getByText('Canvas colour').hover();
  await page.locator('.ctx-menu').last().getByText('White', { exact: true }).click();
  await expect.poll(() => page.locator('.dl-canvas').evaluate(e => getComputedStyle(e).backgroundColor)).toBe('rgb(255, 255, 255)');
  await page.mouse.click(box.x + 20, box.y + box.height - 20, { button: 'right' });
  // the right-click menu switches smart invert too
  await page.locator('.ctx-menu').last().getByText('Smart invert pages (dark theme)').click();
  await expect.poll(() => slideFilter(canvas)).toBe('none');
  await page.mouse.click(box.x + 20, box.y + box.height - 20, { button: 'right' });
  await page.locator('.ctx-menu').first().getByText('Canvas colour').hover();
  await page.locator('.ctx-menu').last().getByText('Automatic (dark grey in the dark theme)').click();
  await expect.poll(() => page.locator('.dl-canvas').evaluate(e => getComputedStyle(e).backgroundColor)).toBe(DARK_GREY);
  // the file has no trace of the runtime's judgement
  expect(readFileSync(`${PROJECTS_DIR}/${PROJECT}/talk/index.html`, 'utf8')).not.toContain('data-ol-lineart');
});

test('a layout document in the dark theme: dark grey canvas, pages smart-inverted, the plot with the page', async ({ page }) => {
  await darkPage(page);
  await page.goto(`/#/${PROJECT}/slides.tex`);
  await page.locator('.lyx-editor .ol-box').first().waitFor({ timeout: 30000 });
  await expect.poll(() => page.locator('.editor-page').first().evaluate(e => getComputedStyle(e).backgroundColor)).toBe(DARK_GREY);
  const pageFilter = () => page.locator('.lyx-editor .ol-page').first().evaluate(e => getComputedStyle(e).filter);
  const picFilter = (n: number) => page.locator('.lyx-editor .ol-page .ol-image img').nth(n).evaluate(e => getComputedStyle(e).filter);
  // on by default (one switch with the documents and PDFs); the photograph back in its colours, the plot with the page
  await expect.poll(pageFilter).toBe(INVERTED);
  await expect.poll(() => picFilter(0)).toBe(INVERTED);
  await expect.poll(() => picFilter(1), { timeout: 10000 }).toBe('none');
  // the rail's thumbnails too, not the presentation's pages
  await expect.poll(() => page.locator('.ol-rail-holder .ol-page').first().evaluate(e => getComputedStyle(e).filter)).toBe(INVERTED);
  expect(await page.evaluate(`(() => { const s = document.createElement('div'); s.className = 'ol-present-stage'; s.innerHTML = '<section class="ol-page"></section>'; document.body.append(s); const f = getComputedStyle(s.firstChild).filter; s.remove(); return f; })()`)).toBe('none');
  // the canvas's right-click menu switches it off: the pages as designed, the canvas still dark grey
  const p = (await page.locator('.lyx-editor .ol-page').first().boundingBox())!;
  await page.mouse.click(p.x - 15, p.y + 40, { button: 'right' });
  await page.locator('.ctx-menu').last().getByText('Smart invert pages (dark theme)').click();
  await expect.poll(pageFilter).toBe('none');
  await expect.poll(() => picFilter(0)).toBe('none');
  expect(await page.locator('.editor-page').first().evaluate(e => getComputedStyle(e).backgroundColor)).toBe(DARK_GREY);
  await page.mouse.click(p.x - 15, p.y + 40, { button: 'right' });
  await page.locator('.ctx-menu').last().getByText('Smart invert pages (dark theme)').click();
  await expect.poll(pageFilter).toBe(INVERTED);
  // light theme: nothing inverted, the canvas as the page
  await page.evaluate(() => { document.documentElement.dataset.theme = 'light'; });
  await expect.poll(pageFilter).toBe('none');
  await expect.poll(() => page.locator('.editor-page').first().evaluate(e => getComputedStyle(e).backgroundColor)).toBe('rgb(255, 255, 255)');
});

/** the frame's pixel at (x, y) CSS px from its top left, as shown */
async function shownPixel(page: Page, sel: string, x: number, y: number): Promise<number[]> {
  const shot = (await page.locator(sel).screenshot()).toString('base64');
  return page.evaluate(async ([b64, x, y]) => {
    // Decode the screenshot locally: the production CSP intentionally forbids
    // data: fetches through connect-src, while permitting data: images.
    const bytes = Uint8Array.from(atob(String(b64)), char => char.charCodeAt(0));
    const bmp = await createImageBitmap(new Blob([bytes], { type: 'image/png' }));
    const c = document.createElement('canvas'); c.width = bmp.width; c.height = bmp.height;
    const g = c.getContext('2d')!; g.drawImage(bmp, 0, 0);
    const k = devicePixelRatio || 1;
    return Array.from(g.getImageData(Math.round(Number(x) * k), Math.round(Number(y) * k), 1, 1).data.slice(0, 3));
  }, [shot, x, y] as const);
}

test('a web page in the dark theme: inverted as a whole, its background too; the photograph and the frames in their colours', async ({ page }) => {
  await darkPage(page);
  await page.goto(`/#/${PROJECT}/site/index.html`);
  await page.frameLocator('.dl-frame').locator('h1').waitFor({ timeout: 30000 });
  const canvas = await frameOf(page, '.dl-frame');
  const rootFilter = () => canvas.evaluate('getComputedStyle(document.documentElement).filter') as Promise<string>;
  await expect.poll(rootFilter).toBe(INVERTED);
  await expect.poll(() => canvas.evaluate(`getComputedStyle(document.querySelector('img.photo')).filter`)).toBe(INVERTED);
  expect(await canvas.evaluate(`getComputedStyle(document.querySelector('ol-overlay')).filter`)).toBe(INVERTED);
  // what is shown: the white page dark, all of it
  const bg = await shownPixel(page, '.dl-frame', 600, 20);
  expect(Math.max(...bg)).toBeLessThan(40);
  // its own colours with smart invert off
  await page.locator('[data-dl-invert]').click();
  await expect.poll(rootFilter).toBe('none');
  await expect.poll(async () => Math.min(...await shownPixel(page, '.dl-frame', 600, 20))).toBeGreaterThan(240);
  await page.locator('[data-dl-invert]').click();
  await expect.poll(rootFilter).toBe(INVERTED);
});
