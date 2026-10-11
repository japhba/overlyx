/**
 * Slides in the dark theme (app/darkslides.ts): the canvas around a deck's slide and a layout
 * document's pages is dark grey (a canvas colour chosen for the document still wins), and the
 * "Invert slides in the dark theme" preference — off by default, as designed slides change colour;
 * the PDF's dark pages stay on by default — shows the slides light on dark on the canvas and in the
 * rail, pictures in their own colours, but never when presenting. The ◐ button beside the deck's
 * zoom and the canvas's right-click menu switch it. Needs the seeded admin.
 */
import { test, expect, type Page, type Frame } from '@playwright/test';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { login, PROJECTS_DIR } from './helpers';
import { starterDeck } from '../packages/core/src/html/deliverable';

const RUN = Date.now().toString(36);
const PROJECT = `admin/e2e-dark-${RUN}`;
const DARK_GREY = 'rgb(43, 44, 48)';
const INVERTED = 'invert(1) hue-rotate(180deg)';
test.describe.configure({ mode: 'serial' });
test.beforeAll(() => {
  mkdirSync(`${PROJECTS_DIR}/${PROJECT}/talk`, { recursive: true });
  // a picture on the first slide: inverted back to its own colours
  writeFileSync(`${PROJECTS_DIR}/${PROJECT}/talk/index.html`, starterDeck('Dark').replace('</h1>', '</h1>\n  <img src="data:image/gif;base64,R0lGODlhAQABAIAAAP8AAP///yH5BAAAAAAALAAAAAABAAEAAAICRAEAOw==" style="position: absolute; left: 900px; top: 500px; width: 100px; height: 100px" alt="">'));
  writeFileSync(`${PROJECTS_DIR}/${PROJECT}/slides.tex`, String.raw`\documentclass[aspectratio=169]{beamer}
\begin{document}
\begin{frame}[plain]
\begin{olbox}{x=20mm,y=20mm,w=100mm,h=20mm,font=20pt}
Layout words
\end{olbox}
\end{frame}
\end{document}
`);
});
test.afterAll(() => rmSync(`${PROJECTS_DIR}/${PROJECT}`, { recursive: true, force: true }));

const frameOf = async (page: Page, sel: string): Promise<Frame> => (await (await page.locator(sel).elementHandle())!.contentFrame())!;
const slideFilter = async (f: Frame): Promise<string> => f.evaluate(`getComputedStyle(document.querySelector('section.slide')).filter`) as Promise<string>;

async function darkPage(page: Page): Promise<void> {
  await page.addInitScript(() => { try { localStorage.setItem('ol.theme', 'dark'); } catch { /* */ } });
  await login(page);
}

test('a deck in the dark theme: dark grey canvas, slides inverted on request, never when presenting', async ({ page }) => {
  await darkPage(page);
  await page.goto(`/#/${PROJECT}/talk/index.html`);
  await page.frameLocator('.dl-frame').locator('section.slide').first().waitFor({ timeout: 30000 });
  await page.frameLocator('.dl-railframe').locator('section.slide').first().waitFor({ timeout: 30000 });
  await page.waitForTimeout(800);
  // the canvas, inside the frame and around it, and the rail: dark grey; the slides as designed (the default)
  await expect.poll(() => page.locator('.dl-canvas').evaluate(e => getComputedStyle(e).backgroundColor)).toBe(DARK_GREY);
  const canvas = await frameOf(page, '.dl-frame');
  const rail = await frameOf(page, '.dl-railframe');
  await expect.poll(() => canvas.evaluate('getComputedStyle(document.documentElement).backgroundColor')).toBe(DARK_GREY);
  await expect.poll(() => rail.evaluate('getComputedStyle(document.body).backgroundColor')).toBe(DARK_GREY);
  expect(await slideFilter(canvas)).toBe('none');
  // ◐: light on dark, on the canvas and in the rail; the picture back in its colours
  await page.locator('[data-dl-invert]').click();
  await expect(page.locator('[data-dl-invert]')).toHaveAttribute('aria-pressed', 'true');
  await expect.poll(() => slideFilter(canvas)).toBe(INVERTED);
  await expect.poll(() => slideFilter(rail)).toBe(INVERTED);
  expect(await canvas.evaluate(`getComputedStyle(document.querySelector('section.slide img')).filter`)).toBe(INVERTED);
  // the preference is remembered
  expect(await page.evaluate(() => JSON.parse(localStorage.getItem('ol.prefs') ?? '{}').invertSlides)).toBe(true);
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
  // the right-click menu switches the inversion too
  await page.locator('.ctx-menu').last().getByText('Invert slides in the dark theme').click();
  await expect.poll(() => slideFilter(canvas)).toBe('none');
  await page.mouse.click(box.x + 20, box.y + box.height - 20, { button: 'right' });
  await page.locator('.ctx-menu').first().getByText('Canvas colour').hover();
  await page.locator('.ctx-menu').last().getByText('Automatic (dark grey in the dark theme)').click();
  await expect.poll(() => page.locator('.dl-canvas').evaluate(e => getComputedStyle(e).backgroundColor)).toBe(DARK_GREY);
});

test('a layout document in the dark theme: dark grey canvas, pages inverted on request', async ({ page }) => {
  await darkPage(page);
  await page.goto(`/#/${PROJECT}/slides.tex`);
  await page.locator('.lyx-editor .ol-box').first().waitFor({ timeout: 30000 });
  await expect.poll(() => page.locator('.editor-page').first().evaluate(e => getComputedStyle(e).backgroundColor)).toBe(DARK_GREY);
  const pageFilter = () => page.locator('.lyx-editor .ol-page').first().evaluate(e => getComputedStyle(e).filter);
  expect(await pageFilter()).toBe('none');
  // the canvas's right-click menu
  const p = (await page.locator('.lyx-editor .ol-page').first().boundingBox())!;
  await page.mouse.click(p.x - 15, p.y + 40, { button: 'right' });
  await page.locator('.ctx-menu').last().getByText('Invert slides in the dark theme').click();
  await expect.poll(pageFilter).toBe(INVERTED);
  // the rail's thumbnails too, not the presentation's pages
  await expect.poll(() => page.locator('.ol-rail-holder .ol-page').first().evaluate(e => getComputedStyle(e).filter)).toBe(INVERTED);
  expect(await page.evaluate(`(() => { const s = document.createElement('div'); s.className = 'ol-present-stage'; s.innerHTML = '<section class="ol-page"></section>'; document.body.append(s); const f = getComputedStyle(s.firstChild).filter; s.remove(); return f; })()`)).toBe('none');
  // light theme: nothing inverted, the canvas as the page
  await page.evaluate(() => { document.documentElement.dataset.theme = 'light'; });
  await expect.poll(pageFilter).toBe('none');
  await expect.poll(() => page.locator('.editor-page').first().evaluate(e => getComputedStyle(e).backgroundColor)).toBe('rgb(255, 255, 255)');
});
