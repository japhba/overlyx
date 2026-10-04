/**
 * The slide rail of layout decks (editor/layout/rail.ts), PowerPoint's thumbnail pane: live
 * thumbnails, "+ New slide" with the caret in the new title (typed text gets the deck's title
 * formatting), the layout picker, dragging a thumbnail to reorder (the canvas renumbers its pages),
 * the right-click menu, Delete and Ctrl+Z on the focused rail, folding the rail away, speaker notes
 * (shown from the rail, added under a slide, typed with letters that are tool keys on the canvas), and
 * what lands in the .tex file. Needs the seeded admin.
 */
import { test, expect, type Page } from '@playwright/test';
import { readFileSync, rmSync } from 'node:fs';
import { login, collectErrors, BASE_URL, PROJECTS_DIR } from './helpers';

// a fresh project per run: the server keeps a project's row after its folder is removed
const RUN = Date.now().toString(36);
const PROJECT = `admin/e2e-rail-${RUN}`;
const DOC = `${PROJECT}/talk.tex`;

test.afterAll(() => { rmSync(`${PROJECTS_DIR}/${PROJECT}`, { recursive: true, force: true }); });

const items = (page: Page) => page.locator('.ol-slide-rail .ol-rail-item');
/** the first line of text on each canvas page, in page order */
const pageTitles = (page: Page) => page.locator('.lyx-editor .ol-page-wrap > .ol-page').evaluateAll(els => els.map(e => (e.querySelector('.ol-box-content')?.textContent ?? '').trim()));

test('the slide rail: thumbnails, new slides in the deck\'s style, reordering, the menu, undo and the saved file', async ({ page }) => {
  const errors = collectErrors(page);
  await login(page);
  expect((await page.request.post(BASE_URL + '/api/projects', { data: { name: `e2e-rail-${RUN}` } })).ok()).toBeTruthy();
  expect((await page.request.post(`${BASE_URL}/api/projects/${encodeURIComponent(PROJECT)}/new`, { data: { path: 'talk.tex', title: 'Rail test', layout: 'slides169' } })).ok()).toBeTruthy();
  await page.evaluate(() => { try { localStorage.removeItem('ol.slides'); localStorage.removeItem('ol.notes'); } catch { /* */ } });
  await page.goto('/#/' + DOC);
  await page.waitForSelector('.lyx-editor .ol-page', { timeout: 30000 });

  // the template's two slides, as live copies of the canvas pages
  await expect(items(page)).toHaveCount(2, { timeout: 10000 });
  await expect(items(page).nth(1).locator('.ol-rail-page')).toContainText('First point');
  await expect(page.locator('.ol-rail-count')).toHaveText(/1 \/ 2/);

  // + New slide: after the current one, the caret in its title; typed text is bold like the deck's titles
  await page.locator('[data-rail-new]').click();
  await expect(items(page)).toHaveCount(3);
  await expect(page.locator('.lyx-editor .ol-page-wrap').nth(1).locator('.ol-box-prompt:visible')).toHaveText('Click to add text');
  await page.keyboard.type('Results');
  const typed = page.locator('.lyx-editor .ol-page-wrap').nth(1).locator('.ol-box-content', { hasText: 'Results' });
  await expect(typed).toHaveCount(1);
  expect(await typed.locator('span[data-series="bold"]').count()).toBe(1);
  await expect(items(page).nth(1).locator('.ol-rail-page')).toContainText('Results', { timeout: 5000 });
  // the canvas numbers its pages again
  await expect(page.locator('.lyx-editor .ol-page-label')).toHaveText(['1', '2', '3']);

  // drag the last thumbnail above the first
  const from = await items(page).nth(2).boundingBox(), to = await items(page).nth(0).boundingBox();
  await page.mouse.move(from!.x + 60, from!.y + 30);
  await page.mouse.down();
  await page.mouse.move(to!.x + 60, to!.y + 25, { steps: 8 });
  await page.mouse.move(to!.x + 60, to!.y + 10, { steps: 4 });
  await page.mouse.up();
  await expect.poll(() => pageTitles(page)).toEqual(['First point', 'Rail test', 'Results']);
  await expect(page.locator('.lyx-editor .ol-page-label')).toHaveText(['1', '2', '3']);
  await expect(page.locator('.ol-rail-item.current .ol-rail-num')).toHaveText('1');

  // right-click ▸ Duplicate slide; then Delete and Ctrl+Z on the focused rail
  await items(page).nth(2).click({ button: 'right' });
  await page.locator('.ctx-menu .ctx-item', { hasText: 'Duplicate slide' }).click();
  await expect(items(page)).toHaveCount(4);
  await expect(page.locator('.ol-rail-item.current .ol-rail-num')).toHaveText('4');
  await page.keyboard.press('Delete');
  await expect(items(page)).toHaveCount(3);
  await page.keyboard.press('Control+z');
  await expect(items(page)).toHaveCount(4);
  await page.keyboard.press('Delete');
  await expect(items(page)).toHaveCount(3);

  // the layout picker: a section header (title, a rule, a subtitle), prompts on the canvas only
  await page.locator('[data-rail-layouts]').click();
  await page.locator('[data-rail-layout-picker] [data-layout="section"]').click();
  await expect(items(page)).toHaveCount(4);
  const section = page.locator('.lyx-editor .ol-page-wrap').nth(3);
  await expect(section.locator('.ol-shape')).toHaveCount(1);
  await expect(section.locator('.ol-box-prompt:visible')).toHaveText(['Click to add subtitle']);
  expect(await page.locator('.ol-slide-rail .ol-box-prompt').count()).toBe(0);

  // folded away: the page gets the room
  const wide = async () => (await page.locator('.lyx-editor .ol-page').first().boundingBox())!.width;
  const before = await wide();
  await page.locator('.ol-rail-hide').click();
  await expect(page.locator('.ol-slide-rail')).toHaveClass(/collapsed/);
  await expect.poll(wide).toBeGreaterThan(before + 50);
  await page.locator('.ol-rail-show').click();
  await expect(page.locator('.ol-slide-rail')).not.toHaveClass(/collapsed/);

  // speaker notes: the rail shows them; a slide without notes offers to add some, and typing there is typing
  await page.locator('[data-rail-notes]').click();
  await expect(page.locator('.lyx-editor.ol-show-notes')).toHaveCount(1);
  await page.locator('.lyx-editor .ol-page-wrap').nth(0).locator('.ol-notes-add').click();
  await page.keyboard.type('Start with the result.');   // s, t, r, e, a: tool letters on the canvas
  await expect(page.locator('.lyx-editor .ol-page-wrap').nth(0).locator('.ol-notes')).toContainText('Start with the result.');
  await expect(page.locator('.lyx-editor .ol-page-wrap').nth(1).locator('.ol-notes-add')).toBeVisible();
  await page.locator('[data-rail-notes]').click();
  await expect(page.locator('.lyx-editor .ol-notes-add:visible')).toHaveCount(0);

  // the file: the slides in the rail's order, the new boxes named (an empty one writes no text)
  await expect(page.locator('.statusbar')).toContainText('All changes saved', { timeout: 15000 });
  const tex = readFileSync(`${PROJECTS_DIR}/${DOC}`, 'utf8');
  const order = ['First point', 'Rail test', 'Results'].map(t => tex.indexOf(t));
  expect(order.every(i => i > 0)).toBeTruthy();
  expect(order).toEqual([...order].sort((a, b) => a - b));
  expect(tex).toMatch(/name=Title/);
  expect(tex).toContain('\\note{Start with the result.}');
  expect((tex.match(/\\begin\{frame\}/g) ?? []).length).toBe(4);
  expect(errors).toEqual([]);
});
