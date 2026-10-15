/**
 * Review on HTML slides (core html/review.ts, deliverable/ReviewPane.tsx, runtime/review.ts):
 * Suggesting from the mode switch makes a move, a deletion and retyped words suggestions (marks in
 * index.html, the objects kept), the Review pane accepts and rejects them, a deleted object is not
 * presented, Viewing changes nothing; comments with Ctrl+Alt+M on an object and on words selected
 * while typing, answered, resolved, deleted. What lands in index.html each time. Needs the seeded admin.
 */
import { test, expect, type Page } from '@playwright/test';
import { readFileSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { login, collectErrors, PROJECTS_DIR } from './helpers';

const PROJECT = `admin/e2e-review-${Date.now().toString(36)}`;
const FILE = `${PROJECTS_DIR}/${PROJECT}/talk/index.html`;
const fileText = () => readFileSync(FILE, 'utf8');
/** the start tag of the element with an id */
const tagOf = (id: string) => new RegExp(`<\\w+[^>]*id="${id}"[^>]*>`).exec(fileText())?.[0] ?? '';

const DECK = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="overlyx" content="deck"><title>A</title>
<style>body { margin: 0; background: #dfe3ea; font-family: system-ui, sans-serif; } .slide { width: 1280px; height: 720px; position: relative; overflow: hidden; background: #fff; margin: 0 auto 40px; }</style>
</head><body>
<section class="slide">
  <h1 id="t" style="position: absolute; left: 100px; top: 60px; margin: 0; font-size: 60px">Hello world</h1>
  <p id="p" style="position: absolute; left: 100px; top: 220px; width: 900px; margin: 0; font-size: 40px">The quick brown fox</p>
  <div id="box" style="position: absolute; left: 100px; top: 400px; width: 200px; height: 150px; background: #2a9d8f"></div>
</section>
<section class="slide"><h2 style="position: absolute; left: 100px; top: 80px; margin: 0">Two</h2></section>
</body></html>
`;

test.afterAll(() => rmSync(`${PROJECTS_DIR}/${PROJECT}`, { recursive: true, force: true }));

const slide = (page: Page) => page.frameLocator('.dl-frame').locator('section.slide').first();
/** a point of the first slide (slide px) on the screen */
async function at(page: Page, x: number, y: number): Promise<{ x: number; y: number }> {
  const b = (await slide(page).boundingBox())!;
  const k = b.width / 1280;
  return { x: b.x + x * k, y: b.y + y * k };
}
async function click(page: Page, x: number, y: number): Promise<void> {
  const p = await at(page, x, y);
  await page.mouse.click(p.x, p.y);
  await page.waitForTimeout(250);
}
async function mode(page: Page, m: 'editing' | 'suggesting' | 'viewing'): Promise<void> {
  await page.locator('.dl-toolbar .edit-mode-btn').click();
  await page.locator(`.edit-mode-menu [data-mode="${m}"]`).click();
  await expect(page.locator('.dl-toolbar .edit-mode-btn')).toHaveAttribute('data-edit-mode', m);
}

async function open(page: Page): Promise<void> {
  mkdirSync(`${PROJECTS_DIR}/${PROJECT}/talk`, { recursive: true });
  writeFileSync(FILE, DECK);
  await login(page);
  await page.goto(`/#/${PROJECT}/talk/index.html`);
  await slide(page).waitFor({ timeout: 30000 });
  await page.waitForTimeout(900);
}

test('suggesting on slides: a move, a deletion and retyped words are suggestions, accepted or rejected in the Review pane', async ({ page }) => {
  const errors = collectErrors(page);
  await open(page);

  // Suggesting is a setting of the page
  await mode(page, 'suggesting');
  await expect.poll(fileText, { timeout: 15000 }).toContain('<meta name="overlyx-suggesting" content="on">');

  // the box moved: it records where it was
  const from = await at(page, 200, 475);
  await page.mouse.move(from.x, from.y);
  await page.mouse.down();
  await page.mouse.move(from.x + 60, from.y + 20, { steps: 6 });
  await page.mouse.up();
  await expect.poll(() => tagOf('box'), { timeout: 15000 }).toContain('data-ol-chg="Admin|');
  expect(tagOf('box')).toContain(`data-ol-was='{"style":"position: absolute; left: 100px; top: 400px; width: 200px; height: 150px; background: #2a9d8f"}'`);

  // the title deleted: marked, still there
  await click(page, 200, 95);
  await page.keyboard.press('Delete');
  await expect.poll(() => tagOf('t'), { timeout: 15000 }).toContain('data-ol-del="Admin|');
  expect(fileText()).toContain('Hello world');

  // a word retyped: struck through as it is deleted, the new one underlined
  const p = await at(page, 400, 245);
  await page.mouse.dblclick(p.x, p.y);
  await page.waitForTimeout(400);
  await page.keyboard.press('End');
  await page.keyboard.press('Control+Backspace');
  await page.keyboard.type('cat', { delay: 40 });
  await expect(page.frameLocator('.dl-frame').locator('#p del[data-ol-by]')).toHaveText('fox');
  await page.keyboard.press('Escape');
  await expect.poll(() => /<p id="p"[^>]*>([\s\S]*?)<\/p>/.exec(fileText())?.[1], { timeout: 15000 })
    .toMatch(/^The quick brown <del data-ol-by="Admin\|[^"]+">fox<\/del><ins data-ol-by="Admin\|[^"]+">cat<\/ins>$/);

  // the Review pane lists the three, in the page's order
  await page.locator('[data-dl-review-toggle]').click();
  const cards = page.locator('.dl-rv-card.change');
  await expect(cards).toHaveCount(3);
  await expect(cards.nth(0)).toContainText('Deleted');
  await expect(cards.nth(1)).toContainText('Typed “cat” · Deleted “fox”');
  await expect(cards.nth(2)).toContainText('Moved');
  await expect(page.locator('[data-dl-review-count]')).toHaveText('3');

  // a deleted object is not presented
  await page.keyboard.press('Escape');
  await page.locator('[data-dl-present]').click();
  const shown = page.frameLocator('.dl-presenting iframe').locator('#t');
  await expect(page.frameLocator('.dl-presenting iframe').locator('#p')).toBeVisible({ timeout: 15000 });
  await expect(shown).toBeHidden();
  await page.keyboard.press('Escape');
  await expect(page.locator('.dl-presenting')).toHaveCount(0, { timeout: 10000 });

  // reject the move (the box goes back), accept the words
  await cards.nth(2).locator('[data-rv-reject]').click();
  await expect.poll(() => tagOf('box'), { timeout: 15000 }).toBe('<div id="box" style="position: absolute; left: 100px; top: 400px; width: 200px; height: 150px; background: #2a9d8f">');
  await page.locator('.dl-rv-card.change', { hasText: 'Typed' }).locator('[data-rv-accept]').click();
  await expect.poll(() => /<p id="p"[^>]*>([\s\S]*?)<\/p>/.exec(fileText())?.[1], { timeout: 15000 }).toBe('The quick brown cat');

  // Viewing: nothing changes from here
  await mode(page, 'viewing');
  const before = fileText();
  const b = await at(page, 200, 475);
  await page.mouse.move(b.x, b.y);
  await page.mouse.down();
  await page.mouse.move(b.x + 80, b.y, { steps: 5 });
  await page.mouse.up();
  await page.waitForTimeout(1200);
  expect(fileText()).toBe(before);
  await expect(page.locator('[data-tb="dk-text"]')).toBeDisabled();

  // the deletion selected: the toolbar's Suggestion section accepts it
  await mode(page, 'suggesting');
  await click(page, 200, 95);
  await expect(page.locator('.dl-ctx [data-tb="dk-accept"]')).toBeVisible();
  await page.locator('.dl-ctx [data-tb="dk-accept"]').click();
  await expect.poll(fileText, { timeout: 15000 }).not.toContain('Hello world');
  expect(fileText()).not.toMatch(/data-ol-(ins|del|chg|was|by)\b/);

  // back to Editing: the page's setting gone
  await mode(page, 'editing');
  await expect.poll(fileText, { timeout: 15000 }).not.toContain('overlyx-suggesting');
  expect(errors).toEqual([]);
});

test('comments on slides: Ctrl+Alt+M on an object and on words while typing, answered, resolved, deleted', async ({ page }) => {
  const errors = collectErrors(page);
  await open(page);
  const threadsOf = (id: string) => JSON.parse((/data-ol-comments='([^']*)'/.exec(tagOf(id)) ?? [])[1] ?? '[]');

  // on the box
  await click(page, 200, 475);
  await page.keyboard.press('Control+Alt+KeyM');
  await expect(page.locator('[data-rv-draft]')).toBeVisible();
  // No focus click or wait: the shortcut must hand the next key to its draft.
  expect(await page.evaluate(() => document.activeElement?.matches('[data-rv-comment]') === true)).toBe(true);
  await page.keyboard.type("Isn't this too green?");
  expect(await page.locator('[data-rv-comment]').inputValue()).toBe("Isn't this too green?");
  await page.keyboard.press('Control+Enter');
  await expect.poll(() => threadsOf('box').map((t: { by: string; text: string }) => `${t.by}: ${t.text}`), { timeout: 15000 }).toEqual(["Admin: Isn't this too green?"]);
  // (an apostrophe in the single-quoted attribute is a JSON escape)
  expect(tagOf('box')).toContain('Isn\\u0027t');
  await expect(page.locator('[data-dl-review-count]')).toHaveText('1');

  // answered and resolved
  const card = page.locator('.dl-rv-card.thread').first();
  await card.click();
  await page.locator('[data-rv-reply]').fill('A little');
  await page.keyboard.press('Enter');
  await expect.poll(() => threadsOf('box')[0]?.re?.map((r: { text: string }) => r.text), { timeout: 15000 }).toEqual(['A little']);
  await card.locator('[data-rv-resolve]').click();
  await expect.poll(() => threadsOf('box')[0]?.done, { timeout: 15000 }).toBe(true);
  await expect(page.locator('[data-dl-review-count]')).toHaveCount(0);

  // on words selected while typing: the thread quotes them
  const p = await at(page, 400, 245);
  await page.mouse.dblclick(p.x, p.y);
  await page.waitForTimeout(400);
  await page.keyboard.press('End');
  await page.keyboard.press('Control+Shift+ArrowLeft');
  await page.keyboard.press('Control+Alt+KeyM');
  await expect(page.locator('[data-rv-draft] .dl-rv-quote')).toHaveText('fox');
  const commentTarget = page.locator('[data-rv-draft] .dl-rv-what');
  expect(await commentTarget.textContent()).toBe('On “The quick brown fox”');
  expect(await page.evaluate(() => document.activeElement?.matches('[data-rv-comment]') === true)).toBe(true);
  await page.keyboard.type('Which fox?');
  // Immediate reads catch a wrong owner or a lost first character before submission.
  expect(await page.locator('[data-rv-comment]').inputValue()).toBe('Which fox?');
  expect(await page.locator('[data-rv-draft] .dl-rv-quote').textContent()).toBe('fox');
  expect(await commentTarget.textContent()).toBe('On “The quick brown fox”');
  expect(await page.frameLocator('.dl-frame').locator('#p').textContent()).toBe('The quick brown fox');
  await page.keyboard.press('Control+Enter');
  await expect.poll(() => threadsOf('p').map((t: { quote?: string; text: string }) => `${t.quote}: ${t.text}`), { timeout: 15000 }).toEqual(['fox: Which fox?']);
  // (typing went to the comment, not into the text; the earlier object target stayed intact)
  expect(/<p id="p"[^>]*>([\s\S]*?)<\/p>/.exec(fileText())?.[1]).toBe('The quick brown fox');
  expect(threadsOf('box').map((t: { text: string }) => t.text)).toEqual(["Isn't this too green?"]);

  // the resolved one shown again, then deleted: its attribute goes
  await page.locator('[data-rv-resolved]').check();
  await page.locator('.dl-rv-card.thread.done [data-rv-delete]').click();
  await expect.poll(() => tagOf('box'), { timeout: 15000 }).not.toContain('data-ol-comments');
  expect(errors).toEqual([]);
});
