/**
 * Copy, cut and paste on the deck canvas (deliverable/runtime/clip.ts; the editor's clipboard events
 * in DeliverableEditor.tsx — a click on the canvas leaves the keyboard in the editor, so Ctrl+C / X / V
 * arrive there): the parts of a drawing (shapes inside an SVG, as in the favicon deck) copied to
 * another slide — into the drawing selected there, or as a drawing of their own — at the place on the
 * slide where they were; beside the original on its own slide; cut and pasted; words as a text box.
 * What lands in index.html each time. Needs the seeded admin and the runtime built into the dist.
 */
import { test, expect, type Page, type Frame } from '@playwright/test';
import { readFileSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { login, collectErrors, grantClipboard, BASE_URL, PROJECTS_DIR } from './helpers';

const RUN = Date.now().toString(36);
const NAME = `e2e-deckclip-${RUN}`;
const PROJECT = `admin/${NAME}`;
const FILE = `${PROJECTS_DIR}/${PROJECT}/icon/index.html`;
const fileText = () => readFileSync(FILE, 'utf8');
/** the source of slide `n` (0-based) */
const slideText = (n: number) => fileText().split('<section').slice(1)[n] ?? '';

const DECK = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="overlyx" content="deck">
<title>Clipboard</title>
<style>
  body { margin: 0; background: #e9ebef; }
  .slide { width: 640px; height: 640px; position: relative; overflow: hidden; background: #fff; margin: 0 auto 40px; }
  .slide > svg { position: absolute; left: 0; top: 0; width: 640px; height: 640px; }
</style>
</head>
<body>

<section class="slide">
  <svg viewBox="0 0 64 64" xmlns="http://www.w3.org/2000/svg">
    <g transform="translate(2 0)" stroke-linecap="square">
      <path id="bar" fill="none" stroke="#2152a3" stroke-width="4" d="M16 20 V40 H24"/>
    </g>
    <circle id="dot" cx="44" cy="30" r="6" fill="#d6402b"/>
  </svg>
</section>

<section class="slide">
  <svg viewBox="0 0 64 64" xmlns="http://www.w3.org/2000/svg" style="left: -30px; top: 40px">
    <rect id="sq" x="10" y="10" width="20" height="20" fill="#efb21a"/>
  </svg>
</section>

</body>
</html>
`;

test.afterAll(() => rmSync(`${PROJECTS_DIR}/${PROJECT}`, { recursive: true, force: true }));

const editFrame = (page: Page): Frame => page.frames().find(f => /[?&]ol=edit/.test(f.url()))!;
async function gotoSlide(page: Page, n: number): Promise<void> {
  await page.frameLocator('.dl-railframe').locator('section.slide').nth(n).click();
  await expect(page.frameLocator('.dl-frame').locator('section.slide').nth(n)).toBeVisible();
  await page.waitForTimeout(300);
}
/** an element's box in its slide's own px (the slide must be shown) */
const boxOnSlide = (page: Page, sel: string) => editFrame(page).evaluate(`(() => {
  const el = document.querySelector(${JSON.stringify(sel)}); if (!el) return null;
  const s = el.closest('section.slide'), q = s.getBoundingClientRect(), r = el.getBoundingClientRect(), k = q.width / s.offsetWidth;
  return { x: (r.left - q.left) / k, y: (r.top - q.top) / k, w: r.width / k, h: r.height / k };
})()`) as Promise<{ x: number; y: number; w: number; h: number } | null>;
/** a point of a part on the page where a click hits it: on its outline (at that length), or its middle (a filled shape) */
async function onPart(page: Page, sel: string, at: number | 'middle' = 4): Promise<{ x: number; y: number }> {
  const q = await editFrame(page).evaluate(`(() => { const p = document.querySelector(${JSON.stringify(sel)}); const b = p.getBBox(); const pt = ${JSON.stringify(at)} === 'middle' ? { x: b.x + b.width / 2, y: b.y + b.height / 2 } : p.getPointAtLength(${JSON.stringify(at)}); const m = p.getScreenCTM(); return { x: m.a * pt.x + m.c * pt.y + m.e, y: m.b * pt.x + m.d * pt.y + m.f, iw: innerWidth }; })()`) as { x: number; y: number; iw: number };
  const fb = (await page.locator('.dl-frame').boundingBox())!;
  const k = fb.width / q.iw;
  return { x: fb.x + q.x * k, y: fb.y + q.y * k };
}
async function ctrlClick(page: Page, p: { x: number; y: number }): Promise<void> {
  await page.keyboard.down('Control'); await page.mouse.click(p.x, p.y); await page.keyboard.up('Control');
  await page.waitForTimeout(300);
}
const near = (a: { x: number; y: number; w: number; h: number } | null, b: { x: number; y: number; w: number; h: number }, dx = 0, dy = 0) =>
  !!a && Math.abs(a.x - b.x - dx) < 0.6 && Math.abs(a.y - b.y - dy) < 0.6 && Math.abs(a.w - b.w) < 0.6 && Math.abs(a.h - b.h) < 0.6;

test('parts of a drawing copied to another slide (into its drawing, or a drawing of their own), beside the original, cut and pasted; words as a text box', async ({ page }) => {
  const errors = collectErrors(page);
  await grantClipboard(page.context());
  await login(page);
  expect((await page.request.post(BASE_URL + '/api/projects', { data: { name: NAME } })).ok()).toBeTruthy();
  mkdirSync(`${PROJECTS_DIR}/${PROJECT}/icon`, { recursive: true });
  writeFileSync(FILE, DECK);
  await page.request.get('/api/projects');
  await page.goto(`/#/${PROJECT}/icon/index.html`);
  await page.frameLocator('.dl-frame').locator('section.slide').first().waitFor({ timeout: 30000 });
  await page.waitForTimeout(900);

  // the L-shaped bar of slide 1 (Ctrl+click: the part, not the drawing) copied
  const bar = (await boxOnSlide(page, '#bar'))!;
  await ctrlClick(page, await onPart(page, '#bar', 6));
  await page.keyboard.press('Control+c');

  // slide 2, its drawing selected: the bar goes into it, where it was on the slide (that drawing sits 30 px left, 40 px down)
  await gotoSlide(page, 1);
  const sq = await onPart(page, '#sq', 'middle');
  await page.mouse.click(sq.x, sq.y);
  await page.waitForTimeout(300);
  await page.keyboard.press('Control+v');
  await expect.poll(() => slideText(1), { timeout: 15000 }).toContain('id="bar-2"');
  // the group's transform and paint went with it, the drawing's offset before them (in its units)
  expect(slideText(1)).toMatch(/<path id="bar-2"[^>]*transform="translate\(3 -4\) translate\(2 0\)"/);
  expect(slideText(1)).toMatch(/<path id="bar-2"[^>]*stroke-linecap="square"/);
  expect((slideText(1).match(/<svg/g) ?? []).length).toBe(1);
  await expect.poll(() => boxOnSlide(page, '#bar-2').then(b => near(b, bar))).toBe(true);

  // nothing selected: a drawing of its own, fitted around it (the second paste here: a step further)
  // (Escape: from the part up to its drawing, then nothing)
  await page.keyboard.press('Escape'); await page.keyboard.press('Escape');
  await page.keyboard.press('Control+v');
  await expect.poll(() => slideText(1), { timeout: 15000 }).toContain('id="bar-3"');
  expect((slideText(1).match(/<svg/g) ?? []).length).toBe(2);
  expect(slideText(1)).not.toContain('data-ol-clip');
  expect(slideText(1)).toMatch(/<svg xmlns="http:\/\/www.w3.org\/2000\/svg" viewBox="[\d. ]+" style="position: absolute; left: \d+px; top: \d+px; width: \d+px; height: \d+px; overflow: visible;?">/);
  await expect.poll(() => boxOnSlide(page, '#bar-3').then(b => near(b, bar, 24, 24))).toBe(true);

  // back on slide 1: the dot copied and pasted beside itself, in its drawing (24 px = 2.4 of its units)
  await gotoSlide(page, 0);
  const dot = (await boxOnSlide(page, '#dot'))!;
  await ctrlClick(page, await onPart(page, '#dot', 'middle'));
  await page.keyboard.press('Control+c');
  await page.keyboard.press('Control+v');
  await expect.poll(() => slideText(0), { timeout: 15000 }).toMatch(/<circle id="dot-2"[^>]*transform="translate\(2.4 2.4\)"/);
  await expect.poll(() => boxOnSlide(page, '#dot-2').then(b => near(b, dot, 24, 24))).toBe(true);

  // the new dot (selected) cut, pasted on slide 2 where it was
  const dot2 = (await boxOnSlide(page, '#dot-2'))!;
  await page.keyboard.press('Control+x');
  await expect.poll(() => slideText(0), { timeout: 15000 }).not.toContain('dot-2');
  await gotoSlide(page, 1);
  await page.keyboard.press('Escape'); await page.keyboard.press('Escape');
  await page.keyboard.press('Control+v');
  await expect.poll(() => slideText(1), { timeout: 15000 }).toContain('id="dot-2"');
  await expect.poll(() => boxOnSlide(page, '#dot-2').then(b => near(b, dot2))).toBe(true);

  // words: a text box with them on the slide shown
  await page.evaluate(() => navigator.clipboard.writeText('Two\nlines <b>'));
  await page.keyboard.press('Escape'); await page.keyboard.press('Escape');
  await page.keyboard.press('Control+v');
  await expect.poll(() => slideText(1), { timeout: 15000 }).toContain('>Two<br>lines &lt;b&gt;</p>');

  expect(errors.filter(e => !/localStorage/.test(e))).toEqual([]);
});
