/**
 * Master pages of layout decks (editor/layout/masters.ts): the master view from the slide rail, a new
 * master with its placeholders, an object drawn on it showing on the slides of that master, a slide
 * made from it (its placeholders empty, the caret in the title), a placeholder moved on the master and
 * the slide's title following it, a master made of a slide, and what lands in the .tex file
 * (\begin{olmaster}, \olpage{master=…}, ph=). Needs the seeded admin.
 */
import { test, expect, type Page } from '@playwright/test';
import { readFileSync, rmSync } from 'node:fs';
import { login, collectErrors, BASE_URL, PROJECTS_DIR } from './helpers';

const RUN = Date.now().toString(36);
const PROJECT = `admin/e2e-masters-${RUN}`;
const DOC = `${PROJECT}/talk.tex`;
const fileText = () => readFileSync(`${PROJECTS_DIR}/${DOC}`, 'utf8');

test.afterAll(() => rmSync(`${PROJECTS_DIR}/${PROJECT}`, { recursive: true, force: true }));

const items = (page: Page) => page.locator('.ol-slide-rail .ol-rail-item');
const shown = (page: Page) => page.locator('.lyx-editor .ol-page-wrap.ol-shown');

test('masters: the master view, placeholders, master objects on the slides, following, a master made of a slide', async ({ page }) => {
  const errors = collectErrors(page);
  await login(page);
  expect((await page.request.post(BASE_URL + '/api/projects', { data: { name: `e2e-masters-${RUN}` } })).ok()).toBeTruthy();
  expect((await page.request.post(`${BASE_URL}/api/projects/${encodeURIComponent(PROJECT)}/new`, { data: { path: 'talk.tex', title: 'Masters test', layout: 'slides169' } })).ok()).toBeTruthy();
  await page.evaluate(() => { try { localStorage.removeItem('ol.slides'); localStorage.removeItem('ol.objects'); } catch { /* */ } });
  await page.goto('/#/' + DOC);
  await page.waitForSelector('.lyx-editor .ol-page-wrap.ol-shown .ol-page', { timeout: 30000 });
  await expect(items(page)).toHaveCount(2, { timeout: 10000 });

  // the master view: no masters yet; "+ New master" makes one with a title and a text placeholder
  await page.locator('[data-rail-masters]').click();
  await expect(page.locator('.lyx-editor')).toHaveClass(/ol-master-view/);
  await expect(items(page)).toHaveCount(0);
  await expect(page.locator('[data-rail-new]')).toHaveText('+ New master');
  await page.locator('[data-rail-new]').click();
  await expect(items(page)).toHaveCount(1);
  await expect(shown(page)).toHaveAttribute('data-role', 'master');
  await expect(shown(page).locator('.ol-box[data-ph]')).toHaveCount(2);
  await expect(shown(page).locator('.ol-box[data-ph="title"] .ol-box-prompt')).toHaveText('Click to add title');

  // a rectangle drawn on the master
  const pg = (await shown(page).locator('section.ol-page').boundingBox())!;
  const mm = pg.width / 160;
  await page.locator('.lyx-editor').press('r');
  await page.mouse.move(pg.x + 140 * mm, pg.y + 75 * mm);
  await page.mouse.down();
  await page.mouse.move(pg.x + 155 * mm, pg.y + 86 * mm, { steps: 5 });
  await page.mouse.up();
  await expect(shown(page).locator(':scope > section.ol-page > .ol-shape')).toHaveCount(1);
  await expect.poll(fileText, { timeout: 15000 }).toMatch(/\\begin\{olmaster\}\{[^}]*name=Title and content\}[\s\S]*\\olshape\{x=140/);

  // back to the slides; a new slide of that master: its object drawn behind, its placeholders empty, the caret in the title
  await page.locator('[data-rail-masters]').click();
  await expect(items(page)).toHaveCount(2);
  await page.locator('[data-rail-layouts]').click();
  await page.locator('[data-rail-layout-picker] button[data-master="Title and content"]').click();
  await expect(items(page)).toHaveCount(3);
  await expect(shown(page).locator('.ol-master-layer .ol-shape')).toHaveCount(1);
  await expect(shown(page).locator(':scope > section.ol-page > .ol-box[data-ph]')).toHaveCount(2);
  await page.keyboard.type('Hello master');
  await expect(shown(page).locator('.ol-box[data-ph="title"]')).toContainText('Hello master');
  await expect.poll(fileText, { timeout: 15000 }).toMatch(/\\olpage\{master=Title and content\}\n\\begin\{olbox\}\{[^}]*ph=title\}\n[^\n]*Hello master/);
  // the thumbnail shows the master's object too
  await expect(page.locator('.ol-slide-rail .ol-rail-item.current .ol-master-layer .ol-shape')).toHaveCount(1, { timeout: 5000 });
  const titleY = () => Number(/\\begin\{olbox\}\{x=[\d.]+mm,y=([\d.]+)mm[^}]*ph=title\}\n[^\n]*Hello master/.exec(fileText())?.[1]);
  const y0 = titleY();

  // the title placeholder moved down 10 mm on the master: the slide's title follows
  await page.locator('[data-rail-masters]').click();
  await expect(shown(page)).toHaveAttribute('data-role', 'master');
  const ph = (await shown(page).locator('.ol-box[data-ph="title"]').boundingBox())!;
  await page.mouse.click(ph.x + ph.width / 2, ph.y + ph.height / 2);
  await expect(page.locator('.lyx-editor .ol-page-wrap.ol-shown .ol-selframe')).toHaveCount(1);
  await page.keyboard.press('Shift+ArrowDown');
  await expect.poll(titleY, { timeout: 15000 }).toBeCloseTo(y0 + 10, 1);
  await page.locator('[data-rail-masters]').click();

  // a master made of the first slide: the slide uses it, its boxes are placeholders
  await items(page).nth(0).click({ button: 'right' });
  await page.locator('.ctx-menu .ctx-item', { hasText: /^Master/ }).first().hover();
  await page.locator('.ctx-menu .ctx-item', { hasText: 'Make a master of this slide' }).click();
  await expect.poll(() => (fileText().match(/\\begin\{olmaster\}/g) ?? []).length, { timeout: 15000 }).toBe(2);
  await page.locator('[data-rail-masters]').click();
  await expect(items(page)).toHaveCount(2);
  await page.locator('[data-rail-masters]').click();

  // the file compiles as a definition before the frames, and parses back with the masters
  const text = fileText();
  expect(text.indexOf('\\begin{olmaster}')).toBeLessThan(text.indexOf('\\begin{frame}'));
  expect(text).toContain('\\NewDocumentEnvironment{olmaster}');
  expect(errors).toEqual([]);
});
