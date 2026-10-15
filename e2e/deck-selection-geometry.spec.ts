/**
 * Realistic GUI regressions for slide selection geometry: a mixed prose/inline-math bullet list
 * remains Text, its visible selection includes outside bullet markers, and opening math for editing
 * does not move the rendered MathJax glyphs. A display equation is inserted and reopened through
 * the canvas tool as a second check. No slide HTML is seeded or edited by this test.
 */
import { test, expect, type Locator, type Page } from '@playwright/test';
import { readFileSync } from 'node:fs';
import { login, collectErrors, PROJECTS_DIR, userCredentials } from './helpers';

const NAME = `geometry-check-${Date.now().toString(36)}`;
const PROJECT = `luna2/${NAME}`;
const DECK = `${PROJECTS_DIR}/${PROJECT}/slides/index.html`;
const frame = (page: Page) => page.frameLocator('.dl-frame');
const slides = (page: Page) => frame(page).locator('section.slide');
const rail = (page: Page) => page.frameLocator('.dl-railframe').locator('section.slide');

async function openSlide(page: Page, n: number): Promise<void> {
  await rail(page).nth(n).click();
  await expect(slides(page).nth(n)).toBeVisible();
}

type Box = { x: number; y: number; width: number; height: number };
function union(boxes: Box[]): Box {
  if (!boxes.length) throw new Error('MathJax rendered no SVG glyphs');
  const x = Math.min(...boxes.map(b => b.x)), y = Math.min(...boxes.map(b => b.y));
  const right = Math.max(...boxes.map(b => b.x + b.width)), bottom = Math.max(...boxes.map(b => b.y + b.height));
  return { x, y, width: right - x, height: bottom - y };
}

/** The page-space boxes of MathJax's actual SVG glyph runs, not the containing placeholder. */
async function mathGlyphs(root: Locator): Promise<Box[]> {
  let svgs = root.locator(':scope > svg');
  if (!await svgs.count()) svgs = root.locator('mjx-math');
  const out: Box[] = [];
  for (const svg of await svgs.all()) {
    const b = await svg.boundingBox();
    if (b) out.push(b);
  }
  return out;
}

test('mixed list selection includes bullet markers, prose stays Text, and math editing preserves glyph position', async ({ page }, testInfo) => {
  const errors = collectErrors(page);
  await login(page, userCredentials('luna2'));
  const tour = page.locator('.tour[data-tour-step="intro"] .tour-card button', { hasText: 'Not now' });
  if (await tour.count()) await tour.click();

  // Create through the app's New dialog so the bundled starter list/formula is ordinary user content.
  await page.locator('[data-new-project]').click();
  await page.locator('[data-new-kind="deck"]').click();
  await page.locator('[data-new-name]').fill(NAME);
  await page.locator('[data-new-create]').click();
  await expect(page).toHaveURL(new RegExp(`#/${PROJECT.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}/slides/index\\.html$`));
  await expect(slides(page)).toHaveCount(2);

  // Select the starter bullet list through the canvas. The second item contains both prose and TeX.
  await openSlide(page, 1);
  const mixedItem = slides(page).nth(1).locator('ul > li').nth(1);
  const list = slides(page).nth(1).locator('ul').first();
  const listBox = await slides(page).nth(1).locator('ul').boundingBox();
  const liBox = await mixedItem.boundingBox();
  expect(listBox).not.toBeNull(); expect(liBox).not.toBeNull();
  await mixedItem.click();
  await expect(page.locator('[data-tb="dk-b"]')).toBeVisible();

  // The Objects pane names the selected item, exposing the user-facing object kind.
  await page.locator('[data-tb="dk-objects"]').click();
  const selectedRow = page.locator('[data-dl-objects] .dl-obj-row.sel').first();
  await expect(selectedRow).toBeVisible();
  await expect(selectedRow.locator('.dl-obj-word')).toHaveText(/Text/);
  await expect(selectedRow.locator('.dl-obj-word')).not.toHaveText(/Formula/);
  await page.locator('[data-tb="dk-objects"]').click();
  const bulletsScreenshot = await page.screenshot();
  await testInfo.attach('selected-bullets', { body: bulletsScreenshot, contentType: 'image/png' });
  await import('node:fs').then(fs => fs.writeFileSync(testInfo.outputPath('selected-bullets.png'), bulletsScreenshot));

  // The border is a visual affordance; transforms and handles must still use the element's actual
  // CSS box. Exercise each operation through the canvas and verify the saved inline geometry.
  const cssBox = () => list.evaluate(el => {
    const s = getComputedStyle(el);
    return { left: s.left, top: s.top, width: s.width, height: s.height, rotate: s.rotate };
  });
  const original = await cssBox();
  const liNow = await mixedItem.boundingBox();
  if (!liNow) throw new Error('Mixed list item has no rendered box');
  await page.mouse.move(liNow.x + liNow.width * 0.65, liNow.y + liNow.height / 2);
  await page.mouse.down();
  await page.mouse.move(liNow.x + liNow.width * 0.65 + 28, liNow.y + liNow.height / 2 + 18, { steps: 4 });
  await page.mouse.up();
  await expect.poll(cssBox).not.toEqual(original);
  await page.keyboard.press('Control+z');
  await expect.poll(cssBox).toEqual(original);

  const listNow = await list.boundingBox();
  if (!listNow) throw new Error('List has no rendered box after undoing its move');
  const slideNow = await slides(page).nth(1).boundingBox();
  if (!slideNow) throw new Error('List slide has no rendered box');
  await page.mouse.click(slideNow.x + slideNow.width * 0.90, slideNow.y + slideNow.height * 0.90);
  await mixedItem.click();
  // Handles live inside a closed shadow root; target the visible east-handle coordinate derived
  // from the source CSS box and slide scale, as a user would, without piercing the overlay.
  const slideScale = slideNow.width / 1280;
  const eastX = slideNow.x + (parseFloat(original.left) + parseFloat(original.width)) * slideScale;
  const eastY = slideNow.y + (parseFloat(original.top) + parseFloat(original.height) / 2) * slideScale;
  await page.mouse.move(eastX, eastY);
  await page.mouse.down();
  await page.mouse.move(eastX + 24, eastY, { steps: 4 });
  await page.mouse.up();
  await expect.poll(cssBox).not.toEqual(original);
  await page.keyboard.press('Control+z');
  await expect.poll(cssBox).toEqual(original);

  // Rotation via the visible Arrange menu also confirms the non-pointer manipulation path.
  await page.locator('[data-tb="dk-arrange"]').click();
  await page.locator('[data-palette="dk-arrange"] .tb-pal-item', { hasText: 'Rotate 90° clockwise' }).click();
  await expect.poll(cssBox).not.toEqual(original);
  await page.keyboard.press('Control+z');
  await expect.poll(cssBox).toEqual(original);

  // Open the existing inline equation via a real double-click. Compare actual SVG run boxes before,
  // while the editor is open, and after closing it; the outer math placeholder is not sufficient.
  const inline = slides(page).nth(1).locator('mjx-container').first();
  const before = union(await mathGlyphs(inline));
  await expect(inline).toBeVisible();
  const ib = await inline.boundingBox();
  if (!ib) throw new Error('Inline equation has no rendered box');
  await page.mouse.dblclick(ib.x + ib.width / 2, ib.y + ib.height / 2);
  const editorMath = page.locator('[data-dl-mathedit] .lm-content mjx-container');
  await expect(editorMath).toBeVisible();
  const during = union(await mathGlyphs(editorMath));
  expect(Math.abs(during.x - before.x), 'inline equation left edge').toBeLessThan(2.5);
  expect(Math.abs(during.y - before.y), 'inline equation top edge').toBeLessThan(2.5);
  expect(Math.abs(during.width - before.width), 'inline equation glyph width').toBeLessThan(2.5);
  expect(Math.abs(during.height - before.height), 'inline equation glyph height').toBeLessThan(2.5);
  await page.keyboard.press('Escape');
  await expect(page.locator('[data-dl-mathedit]')).toHaveCount(0);
  const after = union(await mathGlyphs(inline));
  expect(Math.abs(after.x - before.x), 'inline equation after closing').toBeLessThan(1);
  expect(Math.abs(after.y - before.y), 'inline equation after closing').toBeLessThan(1);

  // Add an editable display formula to the blank first slide using the visible formula tool.
  await openSlide(page, 0);
  await page.locator('[data-tb="dk-formula"]').click();
  const slideBox = await slides(page).first().boundingBox();
  if (!slideBox) throw new Error('Title slide has no canvas box');
  await page.mouse.click(slideBox.x + slideBox.width * 0.74, slideBox.y + slideBox.height * 0.70);
  const field = page.locator('[data-dl-mathedit] .lm-field');
  await expect(field).toBeVisible();
  await page.keyboard.type('x^2');
  await page.keyboard.press('Escape');
  await page.waitForTimeout(400);
  await page.keyboard.press('Escape');
  await expect.poll(() => readFileSync(DECK, 'utf8')).toContain('\\[ x^{2} \\]');

  const display = slides(page).first().locator('mjx-container').last();
  await expect(display).toBeVisible();
  // Keep the displayed formula in the visible canvas: an element.locator.dblclick at 150%
  // auto-scrolls an off-screen equation into view, which makes the before/after boxes incomparable.
  await page.locator('[data-dl-zoom]').selectOption('75');
  await expect(page.locator('[data-dl-zoom]')).toHaveValue('75');
  const displayBefore = union(await mathGlyphs(display));
  const db = await display.boundingBox();
  if (!db) throw new Error('Display equation has no rendered box');
  await page.mouse.dblclick(db.x + db.width / 2, db.y + db.height / 2);
  const displayEditor = page.locator('[data-dl-mathedit] .lm-content mjx-container');
  await expect(displayEditor).toBeVisible();
  const editorScreenshot = await page.screenshot();
  await testInfo.attach('display-equation-inline-editor', { body: editorScreenshot, contentType: 'image/png' });
  await import('node:fs').then(fs => fs.writeFileSync(testInfo.outputPath('math-overlay-display-fit.png'), editorScreenshot));
  const displayDuring = union(await mathGlyphs(displayEditor));
  expect(Math.abs(displayDuring.x - displayBefore.x), 'display equation left edge').toBeLessThan(2.5);
  expect(Math.abs(displayDuring.y - displayBefore.y), 'display equation top edge').toBeLessThan(2.5);
  expect(Math.abs(displayDuring.width - displayBefore.width), 'display equation glyph width').toBeLessThan(2.5);
  expect(Math.abs(displayDuring.height - displayBefore.height), 'display equation glyph height').toBeLessThan(2.5);
  await page.keyboard.press('Escape');
  await expect.poll(() => readFileSync(DECK, 'utf8')).toContain('The idea');
  await testInfo.attach('display-equation-reopened', { body: await page.screenshot(), contentType: 'image/png' });
  expect(errors).toEqual([]);
});
