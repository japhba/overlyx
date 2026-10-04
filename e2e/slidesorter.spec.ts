/**
 * The slide sorter of decks (editor/layout/sorter.ts), PowerPoint's Slide Sorter: opened from the slide
 * rail, a range and a toggle selection, dragging several slides at once, Ctrl+D / Delete / Ctrl+Z,
 * the arrow keys and Enter back into the canvas on that slide, a transition for the selection from the
 * right-click menu, the size slider, and the order in the saved .tex file. Needs the seeded admin.
 */
import { test, expect, type Page } from '@playwright/test';
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { login, collectErrors, BASE_URL, PROJECTS_DIR } from './helpers';

// a fresh project per run: the server keeps a project's row after its folder is removed
const RUN = Date.now().toString(36);
const PROJECT = `admin/e2e-sorter-${RUN}`;
const DOC = `${PROJECT}/talk.tex`;
const NAMES = ['One', 'Two', 'Three', 'Four', 'Five'];
const DECK = String.raw`\documentclass[aspectratio=169]{beamer}
\begin{document}
` + NAMES.map(n => String.raw`\begin{frame}[plain]
\olpage{name=${n}}
\begin{olbox}{x=10mm,y=10mm,w=140mm,h=12mm,font=24pt}
Slide ${n}
\end{olbox}
\end{frame}
`).join('\n') + '\\end{document}\n';

test.afterAll(() => { rmSync(`${PROJECTS_DIR}/${PROJECT}`, { recursive: true, force: true }); });

const cards = (page: Page) => page.locator('.ol-sorter .ol-sorter-card');
const names = (page: Page) => page.locator('.ol-sorter .ol-sorter-name').allTextContents();
const info = (page: Page) => page.locator('.ol-sorter-info');

test('the slide sorter: select, drag several, duplicate, delete, undo, keys, transitions, size, the saved order', async ({ page }) => {
  const errors = collectErrors(page);
  await login(page);
  expect((await page.request.post(BASE_URL + '/api/projects', { data: { name: `e2e-sorter-${RUN}` } })).ok()).toBeTruthy();
  mkdirSync(`${PROJECTS_DIR}/${PROJECT}`, { recursive: true });
  writeFileSync(`${PROJECTS_DIR}/${DOC}`, DECK);
  await page.evaluate(() => { try { localStorage.removeItem('ol.slides'); localStorage.removeItem('ol.sorter'); } catch { /* */ } });
  await page.goto('/#/' + DOC);
  await page.waitForSelector('.ol-slide-rail .ol-rail-item', { timeout: 30000 });

  // opened from the rail: every slide, the current one selected
  await page.locator('[data-rail-sorter]').click();
  await expect(cards(page)).toHaveCount(5);
  await expect(names(page)).resolves.toEqual(NAMES);
  await expect(cards(page).nth(0)).toHaveClass(/selected/);
  await expect(cards(page).nth(1).locator('.ol-rail-page')).toContainText('Slide Two');

  // Two and Three (a click, a Shift+click) dragged before One
  await cards(page).nth(1).click();
  await cards(page).nth(2).click({ modifiers: ['Shift'] });
  await expect(info(page)).toHaveText('5 slides · 2 selected');
  const from = (await cards(page).nth(2).boundingBox())!, to = (await cards(page).nth(0).boundingBox())!;
  await page.mouse.move(from.x + from.width / 2, from.y + from.height / 3);
  await page.mouse.down();
  await page.mouse.move(to.x + 15, to.y + to.height / 3, { steps: 10 });
  await expect(page.locator('.ol-sorter-drop')).toBeVisible();
  await page.mouse.up();
  await expect.poll(() => names(page)).toEqual(['Two', 'Three', 'One', 'Four', 'Five']);
  await expect(info(page)).toHaveText('5 slides · 2 selected');   // the moved slides stay selected

  // Ctrl+click adds Five; Ctrl+D duplicates the three after the last; Delete takes the copies away; Ctrl+Z brings them back
  await cards(page).nth(4).click({ modifiers: ['Control'] });
  await expect(info(page)).toHaveText('5 slides · 3 selected');
  await page.keyboard.press('Control+d');
  await expect.poll(() => names(page)).toEqual(['Two', 'Three', 'One', 'Four', 'Five', 'Two', 'Three', 'Five']);
  await expect(info(page)).toHaveText('8 slides · 3 selected');
  await page.keyboard.press('Delete');
  await expect.poll(() => names(page)).toEqual(['Two', 'Three', 'One', 'Four', 'Five']);
  await page.keyboard.press('Control+z');
  await expect(cards(page)).toHaveCount(8);
  await page.keyboard.press('Control+y');
  await expect(cards(page)).toHaveCount(5);

  // a transition for the selection, from the right-click menu
  await cards(page).nth(3).click();
  await cards(page).nth(3).click({ button: 'right' });
  await page.locator('.ctx-menu .ctx-item', { hasText: 'Transition' }).hover();
  await page.locator('.ctx-menu .ctx-item', { hasText: /^fade$/ }).click();
  await expect(cards(page).nth(3).locator('.ol-sorter-badges')).toContainText('fade');

  // the size slider
  const w0 = (await cards(page).nth(0).boundingBox())!.width;
  await page.locator('.ol-sorter-size input').fill('320');
  await expect.poll(async () => (await cards(page).nth(0).boundingBox())!.width).toBeGreaterThan(w0 + 60);

  // the keys: Home, →, Enter opens that slide in the canvas
  await cards(page).nth(0).click();
  await page.keyboard.press('End');
  await expect(cards(page).nth(4)).toHaveClass(/selected/);
  await page.keyboard.press('Home');
  await page.keyboard.press('ArrowRight');
  await expect(cards(page).nth(1)).toHaveClass(/selected/);
  await page.keyboard.press('Enter');
  await expect(page.locator('.ol-sorter')).toHaveCount(0);
  await expect(page.locator('.ol-rail-item.current .ol-rail-num')).toHaveText('2');

  // a double click opens that slide too
  await page.locator('[data-rail-sorter]').click();
  await cards(page).nth(3).dblclick();
  await expect(page.locator('.ol-sorter')).toHaveCount(0);
  await expect(page.locator('.ol-rail-item.current .ol-rail-num')).toHaveText('4');
  await expect(page.locator('.lyx-editor .ol-page-wrap.ol-shown')).toContainText('Slide Four');

  // the file: the new order, the transition
  await expect(page.locator('.statusbar')).toContainText('All changes saved', { timeout: 15000 });
  const tex = readFileSync(`${PROJECTS_DIR}/${DOC}`, 'utf8');
  const order = ['Slide Two', 'Slide Three', 'Slide One', 'Slide Four', 'Slide Five'].map(t => tex.indexOf(t));
  expect(order.every(i => i > 0)).toBeTruthy();
  expect(order).toEqual([...order].sort((a, b) => a - b));
  expect((tex.match(/\\begin\{frame\}/g) ?? []).length).toBe(5);
  expect(tex).toMatch(/\\olpage\{[^}]*name=Four[^}]*transition=fade|\\olpage\{[^}]*transition=fade[^}]*name=Four/);
  expect(errors).toEqual([]);
});
