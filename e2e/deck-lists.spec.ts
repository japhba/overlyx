/**
 * A slide's list items move by drag and drop (deliverable/runtime/listdrag.ts): with the text box
 * selected, the grip left of the item under the pointer drags it to another place (one `move` of the
 * source); dragged out of a nested list, the list left empty goes; while retyping, Alt+↑ moves the
 * item the caret is in. The grips live in the runtime's closed shadow root: the tests press where
 * the grip is drawn (left of the bullet, the middle of the first line). Needs the seeded admin and
 * the runtime built into the server's client dist.
 */
import { test, expect, type Page } from '@playwright/test';
import { readFileSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { login, BASE_URL, PROJECTS_DIR } from './helpers';

const NAME = `e2e-decklists-${Date.now().toString(36)}`;
const PROJECT = `admin/${NAME}`;
let deckNo = 0;
let FILE = '';
const fileText = () => readFileSync(FILE, 'utf8');
const order = () => Array.from(fileText().matchAll(/<li>([a-z ]+?)\s*(?:<|$)/gm)).map(m => m[1].trim());

const DECK = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="overlyx" content="deck">
<title>Lists</title>
<style>
  body { margin: 0; background: #dfe3ea; font-family: system-ui, sans-serif; }
  .slide { width: 1280px; height: 720px; position: relative; overflow: hidden; background: #fff; margin: 0 auto 40px; }
</style>
</head>
<body>

<section class="slide">
  <div id="t" style="position: absolute; left: 160px; top: 120px; width: 800px; font-size: 32px; line-height: 1.25">
    <ul>
      <li>one</li>
      <li>two
        <ul>
          <li>two a</li>
        </ul>
      </li>
      <li>three</li>
    </ul>
  </div>
</section>

</body>
</html>
`;

test.describe.configure({ mode: 'serial' });
test.afterAll(() => rmSync(`${PROJECTS_DIR}/${PROJECT}`, { recursive: true, force: true }));

const frameLoc = (page: Page) => page.frameLocator('.dl-frame');
const li = (page: Page, text: string) => frameLoc(page).locator('li', { hasText: new RegExp(`^${text}`) }).first();

async function setup(page: Page): Promise<void> {
  // the project (made by the first test; a test run alone makes it)
  await page.request.post(BASE_URL + '/api/projects', { data: { name: NAME } });
  const folder = `deck${++deckNo}`;
  FILE = `${PROJECTS_DIR}/${PROJECT}/${folder}/index.html`;
  mkdirSync(`${PROJECTS_DIR}/${PROJECT}/${folder}`, { recursive: true });
  writeFileSync(FILE, DECK);
  await page.goto(`/#/${PROJECT}/${folder}/index.html`);
  await frameLoc(page).locator('section.slide').first().waitFor({ timeout: 30000 });
  await page.waitForTimeout(900);
}

/** page px per slide px */
async function k(page: Page): Promise<number> { return (await frameLoc(page).locator('section.slide').first().boundingBox())!.width / 1280; }

/** where the item's grip is drawn (page px): 1.3 em left of the item, 7 screen px more; the middle of the first 40 px line */
async function grip(page: Page, text: string): Promise<{ x: number; y: number }> {
  const b = (await li(page, text).boundingBox())!;
  const s = await k(page);
  return { x: b.x - 1.3 * 32 * s - 7, y: b.y + 20 * s };
}

async function drag(page: Page, text: string, to: { x: number; y: number }): Promise<void> {
  const b = (await li(page, text).boundingBox())!;
  await page.mouse.move(b.x + 10, b.y + 5);
  const g = await grip(page, text);
  await page.mouse.move(g.x, g.y);
  await page.mouse.down();
  for (let i = 1; i <= 8; i++) await page.mouse.move(g.x + ((to.x - g.x) * i) / 8, g.y + ((to.y - g.y) * i) / 8);
  await page.mouse.up();
}

test('the selected box: an item dragged by its grip lands where it is dropped, sub-lists and all', async ({ page }) => {
  await login(page);
  await setup(page);
  const one = (await li(page, 'one').boundingBox())!;
  await page.mouse.click(one.x + 20, one.y + 10);   // the box selected
  await page.waitForTimeout(200);
  expect(order()).toEqual(['one', 'two', 'two a', 'three']);
  // three to the top
  await drag(page, 'three', { x: one.x - 30, y: one.y + 2 });
  await expect.poll(order, { timeout: 15000 }).toEqual(['three', 'one', 'two', 'two a']);
  // one to the end of the outer list (the pointer left of the nested list's bullets)
  const twoA = (await li(page, 'two a').boundingBox())!;
  const outer = (await li(page, 'three').boundingBox())!;
  await drag(page, 'one', { x: outer.x - 30, y: twoA.y + twoA.height - 2 });
  await expect.poll(order, { timeout: 15000 }).toEqual(['three', 'two', 'two a', 'one']);
  await expect.poll(() => /<\/ul>\s*<\/li>\s*<li>one<\/li>\s*<\/ul>/.test(fileText()), { timeout: 15000 }).toBe(true);
  // and into the nested list's end (the pointer right of its bullets)
  const a2 = (await li(page, 'two a').boundingBox())!;
  await drag(page, 'one', { x: a2.x + 10, y: a2.y + a2.height - 2 });
  await expect.poll(() => /<li>two a<\/li>\s*<li>one<\/li>\s*<\/ul>/.test(fileText()), { timeout: 15000 }).toBe(true);
});

test('dragged out of a nested list, the item goes to the outer list and the empty list goes', async ({ page }) => {
  await login(page);
  await setup(page);
  const one = (await li(page, 'one').boundingBox())!;
  await page.mouse.click(one.x + 20, one.y + 10);
  await page.waitForTimeout(200);
  // two a to the very top, at the outer list's depth
  await drag(page, 'two a', { x: one.x - 30, y: one.y + 2 });
  await expect.poll(order, { timeout: 15000 }).toEqual(['two a', 'one', 'two', 'three']);
  expect(fileText()).not.toMatch(/<ul>\s*<\/ul>/);
});

test('retyping: Alt+↑ moves the item the caret is in', async ({ page }) => {
  await login(page);
  await setup(page);
  const three = (await li(page, 'three').boundingBox())!;
  await page.mouse.dblclick(three.x + 30, three.y + 10);
  await expect(frameLoc(page).locator('[data-ol-editing]')).toHaveCount(1);
  await page.keyboard.press('Alt+ArrowUp');
  await page.keyboard.press('Escape');
  await expect.poll(order, { timeout: 15000 }).toEqual(['one', 'three', 'two', 'two a']);
});
