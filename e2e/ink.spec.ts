/**
 * Margin ink: the Draw toolbar, drawing a stroke in the margin beside a paragraph (which anchors
 * an invisible \olsketch command there), the sidecar SVG written by the server, persistence
 * across a reload, and the eraser. Draw mode adds side gutters (pan + snap-back) and the ruler
 * stays. Needs the seeded admin.
 */
import { test, expect, type Page } from '@playwright/test';
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { login, openDoc, texDoc, collectErrors, PROJECTS_DIR } from './helpers';

const PROJECT = 'e2e-ink';
const DIR = `${PROJECTS_DIR}/${PROJECT}`;

test.describe.configure({ mode: 'serial' });

test.beforeAll(() => {
  rmSync(DIR, { recursive: true, force: true });
  mkdirSync(DIR, { recursive: true });
  writeFileSync(`${DIR}/main.tex`, texDoc('First paragraph with enough words to have a body.\n\nSecond paragraph, also with several words in it.\n\nThird paragraph closes the document.'));
});
test.afterAll(() => { rmSync(DIR, { recursive: true, force: true }); });

/** Draw a short squiggle with the mouse from (x, y), in viewport coordinates. */
async function squiggle(page: Page, x: number, y: number): Promise<void> {
  await page.mouse.move(x, y);
  await page.mouse.down();
  for (let i = 1; i <= 6; i++) await page.mouse.move(x + i * 6, y + (i % 2 ? 5 : -5), { steps: 2 });
  await page.mouse.up();
}

test('drawing in the margin anchors a sketch, saves an SVG next to the document, and survives a reload', async ({ page }) => {
  const errors = collectErrors(page);
  await login(page);
  await openDoc(page, `${PROJECT}/main.tex`);

  // switch the pen on: gutters + snap appear, the canvas accepts input, the Draw row docks at the bottom
  await page.click('[data-tb="ink"]');
  await expect(page.locator('.ink-canvas.draw')).toBeVisible();
  await expect(page.locator('.toolbar-ink')).toBeVisible();
  await expect(page.locator('.editor-scroll.ink-pan')).toBeVisible();
  await expect(page.locator('.ruler')).toBeVisible();   // the width ruler stays available

  // draw beside the first paragraph, in the right margin
  const par = page.locator('.lyx-editor .lyx-par').first();
  const box = (await par.boundingBox())!;
  await squiggle(page, box.x + box.width + 60, box.y + 10);
  await expect(page.locator('.lyx-editor .lyx-sketch')).toHaveCount(1);

  // the server writes the .tex (anchor command) and the sidecar SVG on the save debounce
  await expect.poll(() => readFileSync(`${DIR}/main.tex`, 'utf8'), { timeout: 15000 }).toContain('\\olsketch{figures/ink-');
  expect(readFileSync(`${DIR}/main.tex`, 'utf8')).toContain('\\newcommand{\\olsketch}[1]{}');
  await expect.poll(() => (existsSync(`${DIR}/figures`) ? readdirSync(`${DIR}/figures`) : []).filter(f => f.startsWith('ink-')).length, { timeout: 15000 }).toBe(1);
  const svgName = readdirSync(`${DIR}/figures`).find(f => f.startsWith('ink-'))!;
  const svg = readFileSync(`${DIR}/figures/${svgName}`, 'utf8');
  expect(svg).toContain('overlyx-ink');
  expect(svg).toContain('<path d=');

  // a second stroke beside the same paragraph joins the same sketch (still one anchor)
  await squiggle(page, box.x + box.width + 60, box.y + 26);
  await expect(page.locator('.lyx-editor .lyx-sketch')).toHaveCount(1);

  // …and one beside the third paragraph makes a second anchor
  const par3 = page.locator('.lyx-editor .lyx-par').nth(2);
  const box3 = (await par3.boundingBox())!;
  await squiggle(page, box3.x - 60, box3.y + 8);   // left margin this time
  await expect(page.locator('.lyx-editor .lyx-sketch')).toHaveCount(2);

  // reload: the strokes come back from the document
  await page.reload();
  await page.waitForSelector('.lyx-editor .lyx-par');
  await expect(page.locator('.lyx-editor .lyx-sketch')).toHaveCount(2);

  // the eraser removes a whole stroke; an emptied sketch loses its anchor
  await expect(page.locator('.ink-canvas.draw')).toBeVisible();   // draw mode was remembered
  await page.click('[data-tb="i-eraser"]');
  const b3 = (await page.locator('.lyx-editor .lyx-par').nth(2).boundingBox())!;
  await page.mouse.move(b3.x - 60 + 12, b3.y + 8);
  await page.mouse.down();
  await page.mouse.move(b3.x - 60 + 24, b3.y + 8, { steps: 4 });
  await page.mouse.up();
  await expect(page.locator('.lyx-editor .lyx-sketch')).toHaveCount(1);

  // switching the pen off removes the gutters, the drawings stay visible
  await page.click('[data-tb="ink"]');
  await expect(page.locator('.editor-scroll.ink-pan')).toHaveCount(0);
  await expect(page.locator('.ink-canvas')).toBeVisible();
  expect(errors.filter(e => !/favicon|ResizeObserver/.test(e))).toEqual([]);
});

test('clicks in the text column still edit text while draw mode is on (the column is a hole in the canvas)', async ({ page }) => {
  await login(page);
  await openDoc(page, `${PROJECT}/main.tex`);
  await page.click('[data-tb="ink"]');
  await expect(page.locator('.ink-canvas.draw')).toBeVisible();
  const par = page.locator('.lyx-editor .lyx-par').first();
  await par.click();
  await page.keyboard.type('Typed with the pen on. ');
  await expect(par).toContainText('Typed with the pen on.');
});

test('the drawing toolbar activates itself on tablet clients', async ({ browser }) => {
  const ctx = await browser.newContext({ viewport: { width: 1180, height: 820 }, hasTouch: true, isMobile: true });
  const page = await ctx.newPage();
  try {
    await login(page);
    await openDoc(page, `${PROJECT}/main.tex`);
    await expect(page.locator('.toolbar-ink')).toBeVisible();
    await expect(page.locator('.ink-canvas.draw')).toBeVisible();
  } finally { await ctx.close(); }
});
