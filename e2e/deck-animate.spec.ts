/**
 * Animations on HTML slides (deliverable/AnimationPane.tsx, runtime/animate.ts, core html/steps.ts):
 * the Animation pane from the slide's toolbar; Appear for a selection in the order its objects were
 * Shift+clicked; click-in-order mode with an SVG's paths (Ctrl+click) and Shift for the same click;
 * Disappear; a list's items one by one; ↑ in the pane; then presenting step by step. What lands in
 * index.html each time. Needs the seeded admin.
 */
import { test, expect, type Page } from '@playwright/test';
import { readFileSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { login, collectErrors, PROJECTS_DIR } from './helpers';

const PROJECT = `admin/e2e-animate-${Date.now().toString(36)}`;
const FILE = `${PROJECTS_DIR}/${PROJECT}/talk/index.html`;
const fileText = () => readFileSync(FILE, 'utf8');
/** id=data-step of every object that has one, in the page's order (a list: its data-steps) */
const steps = () => [...fileText().matchAll(/<(\w+)([^>]*?) data-steps?="([^"]*)"/g)].map(m => `${/id="(\w+)"/.exec(m[2])?.[1] ?? m[1]}=${m[3]}`).join(' ');

const DECK = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="overlyx" content="deck"><title>A</title>
<style>body { margin: 0; background: #dfe3ea; font-family: system-ui, sans-serif; } .slide { width: 1280px; height: 720px; position: relative; overflow: hidden; background: #fff; margin: 0 auto 40px; }</style>
</head><body>
<section class="slide">
  <div id="a" style="position: absolute; left: 100px; top: 220px; width: 120px; height: 120px; background: #e63946"></div>
  <div id="b" style="position: absolute; left: 300px; top: 220px; width: 120px; height: 120px; background: #2a9d8f"></div>
  <div id="c" style="position: absolute; left: 500px; top: 220px; width: 120px; height: 120px; background: #457b9d"></div>
  <svg id="d" style="position: absolute; left: 700px; top: 200px" width="480" height="200" viewBox="0 0 480 200">
    <path id="p1" d="M20 180 L120 20 L220 180 Z" fill="#f4a261"/>
    <path id="p2" d="M260 180 h180 v-160 h-180 Z" fill="#264653"/>
  </svg>
  <ul id="l" style="position: absolute; left: 100px; top: 440px; width: 500px; margin: 0; font-size: 30px"><li>One</li><li>Two</li></ul>
</section>
<section class="slide"><h2 style="position: absolute; left: 100px; top: 80px; margin: 0">Two</h2></section>
</body></html>
`;

test.afterAll(() => rmSync(`${PROJECTS_DIR}/${PROJECT}`, { recursive: true, force: true }));

const slides = (page: Page) => page.frameLocator('.dl-frame').locator('section.slide');
async function click(page: Page, x: number, y: number, mods: ('Shift' | 'Control')[] = []): Promise<void> {
  const b = (await slides(page).first().boundingBox())!;
  const k = b.width / 1280;
  for (const m of mods) await page.keyboard.down(m);
  await page.mouse.click(b.x + x * k, b.y + y * k);
  for (const m of mods) await page.keyboard.up(m);
}
const rows = (page: Page) => page.locator('[data-anim-row]').evaluateAll(els => els.map(e =>
  `${e.closest('[data-anim-step]')!.getAttribute('data-anim-step')}${e.getAttribute('data-anim-row') === 'appear' ? '+' : '-'}${(e.querySelector('.dl-anim-label') as HTMLElement).innerText}`).join(' | '));

test('animations: Appear in the order clicked, click-in-order with an SVG\'s paths, Disappear, a list one by one, ↑, presenting', async ({ page }) => {
  const errors = collectErrors(page);
  mkdirSync(`${PROJECTS_DIR}/${PROJECT}/talk`, { recursive: true });
  writeFileSync(FILE, DECK);
  await login(page);
  await page.goto(`/#/${PROJECT}/talk/index.html`);
  await slides(page).first().waitFor({ timeout: 30000 });
  await page.waitForTimeout(900);
  await page.locator('[data-tb="dk-select"]').click();

  // the pane from the slide's toolbar (nothing selected): nothing animated yet
  await page.locator('[data-tb="dk-step"]').click();
  await expect(page.locator('[data-dl-anim]')).toBeVisible();
  await expect(page.locator('.dl-anim-empty')).toBeVisible();

  // c, then a (Shift+click): Appear puts them on clicks 1 and 2 in that order
  await click(page, 560, 280);
  await click(page, 160, 280, ['Shift']);
  await page.locator('[data-anim-add="appear"]').click();
  await expect.poll(steps, { timeout: 15000 }).toBe('a=3 c=2');
  await expect.poll(() => rows(page)).toBe('2+Shape “c” | 3+Shape “a”');

  // click in order: b, the SVG's square (Ctrl: the part), then its triangle on the same click (Ctrl+Shift); Escape ends
  await page.locator('[data-anim-order]').click();
  await expect(page.locator('[data-anim-ordering]')).toBeVisible();
  await click(page, 360, 280);
  await click(page, 1050, 300, ['Control']);
  await click(page, 820, 330, ['Control', 'Shift']);
  await expect.poll(steps, { timeout: 15000 }).toBe('a=3 b=4 c=2 p1=5 p2=5');
  await page.keyboard.press('Escape');
  await expect(page.locator('[data-anim-ordering]')).toHaveCount(0);
  // (the mode is off: a click selects again, nothing is added)
  await click(page, 360, 280);
  await page.waitForTimeout(500);
  expect(steps()).toBe('a=3 b=4 c=2 p1=5 p2=5');

  // c disappears on the next click; the list's items one by one after that
  await click(page, 560, 280);
  await page.locator('[data-anim-add="disappear"]').click();
  await expect.poll(steps, { timeout: 15000 }).toBe('a=3 b=4 c=2-5 p1=5 p2=5');
  await click(page, 200, 480);
  await page.locator('[data-anim-list]').click();
  await expect.poll(steps, { timeout: 15000 }).toBe('a=3 b=4 c=2-5 p1=5 p2=5 l=7');
  await expect.poll(() => rows(page)).toBe('2+Shape “c” | 3+Shape “a” | 4+Shape “b” | 5+Drawing ▸ path “p1” | 5+Drawing ▸ path “p2” | 6-Shape “c” | 7+• One | 8+• Two');

  // ↑ on b (step 4): with the step before (a's), then before it
  const up = page.locator('[data-anim-row]', { hasText: 'Shape “b”' }).locator('[data-anim-up]');
  await up.click();
  await expect.poll(steps, { timeout: 15000 }).toBe('a=3 b=3 c=2-4 p1=4 p2=4 l=6');
  await up.click();
  await expect.poll(steps, { timeout: 15000 }).toBe('a=4 b=3 c=2-5 p1=5 p2=5 l=7');

  // presenting: each click one step, the slide's steps before the next slide
  const editUrl = page.frames().find(f => /[?&]ol=edit/.test(f.url()))!.url();
  const present = await page.context().newPage();
  await present.setViewportSize({ width: 1280, height: 720 });
  await present.goto(editUrl.replace(/ol=edit/, 'ol=present').replace(/#.*$/, '') + '#1');
  const shown = () => present.evaluate(`['a','b','c','p1','p2'].map(i => getComputedStyle(document.getElementById(i)).visibility === 'visible' ? 1 : 0).join('') + ' ' + [...document.querySelectorAll('#l li')].map(e => getComputedStyle(e).visibility === 'visible' ? 1 : 0).join('')`);
  const seen: string[] = [];
  await expect.poll(shown).toBe('00000 00');
  for (let k = 1; k <= 7; k++) { seen.push(await shown()); await present.keyboard.press('ArrowRight'); await present.waitForTimeout(100); }
  expect(seen).toEqual(['00000 00', '00100 00', '01100 00', '11100 00', '11111 00', '11011 00', '11011 10']);
  await expect.poll(shown).toBe('11011 11');
  expect(await present.evaluate('location.hash')).toBe('#1');
  await present.keyboard.press('ArrowRight');
  await expect.poll(() => present.evaluate('location.hash')).toBe('#2');
  await present.keyboard.press('ArrowLeft');
  await expect.poll(shown).toBe('11011 11');
  await present.close();
  expect(errors.filter(e => !/favicon|ResizeObserver/.test(e))).toEqual([]);
});
