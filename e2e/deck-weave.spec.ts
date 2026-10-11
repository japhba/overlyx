/**
 * Weaving on the deck canvas (deliverable/runtime/weave.ts): a bar crossing a ring twice — a
 * right-click on one crossing (on an object not selected yet: the object's menu, not the slide's)
 * offers the ring over the bar there; the ring then covers the bar at that crossing only, as a
 * clipped <use> of it right after the bar; a right-click there again undoes it. A click on the
 * drawing's empty area (runtime/edit.ts blankOfDrawing) deselects; a click on or just beside a shape
 * selects the drawing. Needs the seeded admin and the runtime built into the dist.
 */
import { test, expect, type Page, type Frame } from '@playwright/test';
import { readFileSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { login, collectErrors, BASE_URL, PROJECTS_DIR } from './helpers';

const RUN = Date.now().toString(36);
const NAME = `e2e-deckweave-${RUN}`;
const PROJECT = `admin/${NAME}`;
const FILE = `${PROJECTS_DIR}/${PROJECT}/knot/index.html`;
const fileText = () => readFileSync(FILE, 'utf8');

const DECK = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="overlyx" content="deck">
<title>Weave</title>
<style>
  body { margin: 0; background: #e9ebef; }
  .slide { width: 640px; height: 640px; position: relative; overflow: hidden; background: #fff; margin: 0 auto 40px; }
  .slide > svg { position: absolute; left: 0; top: 0; width: 640px; height: 640px; }
</style>
</head>
<body>

<section class="slide">
  <svg viewBox="0 0 64 64" xmlns="http://www.w3.org/2000/svg">
    <circle id="ring" cx="32" cy="32" r="20" fill="none" stroke="#1c1b19" stroke-width="5"/>
    <rect id="bar" x="4" y="30" width="56" height="4" fill="#2152a3"/>
  </svg>
</section>

<section class="slide">
  <h2 style="position: absolute; left: 40px; top: 40px; margin: 0">Two</h2>
</section>

</body>
</html>
`;

test.afterAll(() => rmSync(`${PROJECTS_DIR}/${PROJECT}`, { recursive: true, force: true }));

const editFrame = (page: Page): Frame => page.frames().find(f => /[?&]ol=edit/.test(f.url()))!;
/** a point of the drawing (its units) on the page, and in the frame */
async function at(page: Page, ux: number, uy: number): Promise<{ x: number; y: number; fx: number; fy: number }> {
  const q = await editFrame(page).evaluate(`(() => { const m = document.getElementById('ring').ownerSVGElement.getScreenCTM(); return { x: m.a * ${ux} + m.c * ${uy} + m.e, y: m.b * ${ux} + m.d * ${uy} + m.f, iw: innerWidth }; })()`) as { x: number; y: number; iw: number };
  const fb = (await page.locator('.dl-frame').boundingBox())!;
  const k = fb.width / q.iw;
  return { x: fb.x + q.x * k, y: fb.y + q.y * k, fx: q.x, fy: q.y };
}
/** what is drawn on top at a point of the frame (the weave's patch lets clicks through: counted here) */
const topAt = (page: Page, fx: number, fy: number) => editFrame(page).evaluate(`(() => {
  const ws = [...document.querySelectorAll('[data-ol-weave]')];
  for (const w of ws) w.setAttribute('pointer-events', 'auto');
  const e = document.elementFromPoint(${fx}, ${fy});
  for (const w of ws) w.setAttribute('pointer-events', 'none');
  return e ? e.localName + (e.id ? '#' + e.id : '') : '';
})()`) as Promise<string>;

test('a crossing woven from the right-click menu: the ring over the bar there only; undone again', async ({ page }) => {
  const errors = collectErrors(page);
  await login(page);
  expect((await page.request.post(BASE_URL + '/api/projects', { data: { name: NAME } })).ok()).toBeTruthy();
  mkdirSync(`${PROJECTS_DIR}/${PROJECT}/knot`, { recursive: true });
  writeFileSync(FILE, DECK);
  await page.request.get('/api/projects');
  await page.goto(`/#/${PROJECT}/knot/index.html`);
  await page.frameLocator('.dl-frame').locator('section.slide').first().waitFor({ timeout: 30000 });
  await page.waitForTimeout(900);

  // the bar crosses the ring on the left (x = 12) and on the right (x = 52): on top at both
  const left = await at(page, 12, 32), right = await at(page, 52, 32);
  expect(await topAt(page, left.fx, left.fy)).toBe('rect#bar');
  expect(await topAt(page, right.fx, right.fy)).toBe('rect#bar');

  // nothing selected: the right-click's menu is the object's, with the weave
  await page.mouse.click(left.x, left.y, { button: 'right' });
  const item = page.locator('.ctx-menu').getByText('Weave: ring over bar here');
  await expect(item).toBeVisible();
  await expect(page.locator('.ctx-menu').getByText('Edit points')).toBeVisible();
  await item.click();
  await expect.poll(fileText, { timeout: 15000 }).toContain('data-ol-weave');
  expect(fileText()).toMatch(/<rect id="bar"[^>]*\/?>(<\/rect>)?\s*<g data-ol-weave data-ol-name="ring over bar" pointer-events="none" clip-path="url\(#weave-1\)"><clipPath id="weave-1"><circle cx="[\d.]+" cy="[\d.]+" r="[\d.]+"\/><\/clipPath><use href="#ring"\/><\/g>/);
  await expect.poll(() => topAt(page, left.fx, left.fy)).toBe('use');
  expect(await topAt(page, right.fx, right.fy)).toBe('rect#bar');

  // a right-click there again: undone
  await page.keyboard.press('Escape');
  await page.mouse.click(left.x, left.y, { button: 'right' });
  await page.locator('.ctx-menu').getByText('Undo the weave here').click();
  await expect.poll(fileText, { timeout: 15000 }).not.toContain('data-ol-weave');
  await expect.poll(() => topAt(page, left.fx, left.fy)).toBe('rect#bar');

  expect(errors.filter(e => !/localStorage/.test(e))).toEqual([]);
});

test('a drawing\'s empty area is nothing to a click: it deselects; a click on (or just beside) a shape selects the drawing', async ({ page }) => {
  const errors = collectErrors(page);
  await login(page);
  await page.request.post(BASE_URL + '/api/projects', { data: { name: NAME } });
  // (a deck of its own: the first test's may still be open on the server)
  mkdirSync(`${PROJECTS_DIR}/${PROJECT}/knot2`, { recursive: true });
  writeFileSync(`${PROJECTS_DIR}/${PROJECT}/knot2/index.html`, DECK);
  await page.request.get('/api/projects');
  await page.goto(`/#/${PROJECT}/knot2/index.html`);
  await page.frameLocator('.dl-frame').locator('section.slide').first().waitFor({ timeout: 30000 });
  await page.waitForTimeout(900);
  const selectedNow = () => page.locator('.dl-toolbar [data-tb="dk-delete"]').count();

  // the bar: the drawing selected
  const bar = await at(page, 32, 32);
  await page.mouse.click(bar.x, bar.y);
  await expect.poll(selectedNow).toBe(1);
  // the drawing's empty top (inside its box, nothing painted): deselected — the slide's tools instead
  const blank = await at(page, 32, 4);
  await page.mouse.click(blank.x, blank.y);
  await expect.poll(selectedNow).toBe(0);
  await expect(page.locator('.dl-toolbar [data-tb="dk-bg"]')).toBeVisible();
  // just outside the ring's outline (0.3 units = 3 px of the slide): still the drawing
  const near = await at(page, 32, 32 - 22.5 - 0.3);
  await page.mouse.click(near.x, near.y);
  await expect.poll(selectedNow).toBe(1);
  // and the empty middle of the ring once more: nothing
  const middle = await at(page, 32, 20);
  await page.mouse.click(middle.x, middle.y);
  await expect.poll(selectedNow).toBe(0);
  expect(errors.filter(e => !/localStorage/.test(e))).toEqual([]);
});
