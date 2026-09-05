/**
 * Margin ink: the Draw toolbar, drawing a stroke in the margin beside a paragraph (which anchors
 * an invisible \olsketch command there), the sidecar SVG written by the server, persistence
 * across a reload, and the eraser. Draw mode adds side gutters (pan + snap-back) and the ruler
 * stays. Then the lasso, the per-pen colour / width presets (a click on the selected one opens
 * its picker, Goodnotes-style), the laser pointer (a trace over the text that fades after the
 * lift, seen live by a second client) and canvas paste. Needs the seeded admin.
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
  writeFileSync(`${DIR}/lasso.tex`, texDoc('Alpha paragraph for the lasso.\n\nBeta paragraph below it.\n\nGamma paragraph at the end.'));
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

  // switching the pen off removes the gutters, the drawings stay visible — and the page scrolls
  // back to the column: the canvas must not hold the old (centred) offset open, or the text
  // vanishes off the left edge until a reload
  const scroller = page.locator('.editor-scroll');
  expect(await scroller.evaluate(el => el.scrollLeft)).toBeGreaterThan(0);   // centred in the gutters
  await page.click('[data-tb="ink"]');
  await expect(page.locator('.editor-scroll.ink-pan')).toHaveCount(0);
  await expect(page.locator('.ink-canvas')).toBeVisible();
  await expect.poll(() => scroller.evaluate(el => [el.scrollLeft, el.scrollWidth - el.clientWidth])).toEqual([0, 0]);
  const sc = (await scroller.boundingBox())!, col = (await page.locator('.lyx-editor').boundingBox())!;
  expect(col.x).toBeGreaterThan(sc.x);
  expect(col.x + col.width).toBeLessThan(sc.x + sc.width);
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

test('the lasso selects strokes for moving, resizing and deleting', async ({ page }) => {
  await login(page);
  await openDoc(page, `${PROJECT}/lasso.tex`);
  await page.click('[data-tb="ink"]');
  await expect(page.locator('.ink-canvas.draw')).toBeVisible();

  const par = page.locator('.lyx-editor .lyx-par').first();
  const box = (await par.boundingBox())!;
  const sx = box.x + box.width + 60, sy = box.y + 10;
  await squiggle(page, sx, sy);
  await expect(page.locator('.lyx-editor .lyx-sketch')).toHaveCount(1);

  // encircle the squiggle with the lasso: a selection box with handles appears
  await page.click('[data-tb="i-lasso"]');
  await page.mouse.move(sx - 18, sy - 18);
  await page.mouse.down();
  for (const [x, y] of [[sx + 60, sy - 18], [sx + 60, sy + 28], [sx - 18, sy + 28], [sx - 18, sy - 18]] as const) await page.mouse.move(x, y, { steps: 4 });
  await page.mouse.up();
  const sel = page.locator('.ink-sel');
  await expect(sel).toBeVisible();
  const before = (await sel.boundingBox())!;

  // drag inside the box: the selection moves
  await page.mouse.move(before.x + before.width / 2, before.y + before.height / 2);
  await page.mouse.down();
  await page.mouse.move(before.x + before.width / 2 + 45, before.y + before.height / 2 + 20, { steps: 5 });
  await page.mouse.up();
  await expect(sel).toBeVisible();
  const moved = (await sel.boundingBox())!;
  expect(moved.x).toBeGreaterThan(before.x + 25);

  // the south-east handle resizes it
  const handle = page.locator('.ink-handle.se');
  const hb = (await handle.boundingBox())!;
  await page.mouse.move(hb.x + hb.width / 2, hb.y + hb.height / 2);
  await page.mouse.down();
  await page.mouse.move(hb.x + hb.width / 2 + 40, hb.y + hb.height / 2 + 25, { steps: 5 });
  await page.mouse.up();
  const grown = (await sel.boundingBox())!;
  expect(grown.width).toBeGreaterThan(moved.width + 20);

  // Delete removes the selected stroke — and with it the emptied anchor
  await page.keyboard.press('Delete');
  await expect(page.locator('.lyx-editor .lyx-sketch')).toHaveCount(0);
  await expect(sel).toBeHidden();
});

test('the lasso closes itself and selects what it touches; pen and highlighter keep their own colour and width', async ({ page }) => {
  await login(page);
  await openDoc(page, `${PROJECT}/lasso.tex`);
  await page.click('[data-tb="ink"]');
  await expect(page.locator('.ink-canvas.draw')).toBeVisible();
  await page.click('[data-tb="i-pen"]');

  // two squiggles beside the first paragraph, one well to the right of the other
  const par = page.locator('.lyx-editor .lyx-par').first();
  const box = (await par.boundingBox())!;
  const sx = box.x + box.width + 40, sy = box.y + 12;
  await squiggle(page, sx, sy);
  await squiggle(page, sx + 120, sy);
  await expect(page.locator('.lyx-editor .lyx-sketch')).toHaveCount(1);

  // an OPEN lasso path (three sides of a box) over the left third of the first squiggle: it closes
  // itself, and touching the stroke is enough — Goodnotes semantics, not "most points inside"
  await page.click('[data-tb="i-lasso"]');
  await page.mouse.move(sx - 12, sy - 22);
  await page.mouse.down();
  for (const [x, y] of [[sx + 12, sy - 22], [sx + 12, sy + 26], [sx - 12, sy + 26]] as const) await page.mouse.move(x, y, { steps: 4 });
  await page.mouse.up();
  const sel = page.locator('.ink-sel');
  await expect(sel).toBeVisible();
  const r = (await sel.boundingBox())!;
  expect(r.x).toBeLessThan(sx + 4);           // the first stroke is selected…
  expect(r.x + r.width).toBeLessThan(sx + 100);   // …and the far one is not
  await page.keyboard.press('Escape');
  await expect(sel).toBeHidden();

  // the highlighter has its own palette and colour: yellow by default; give it pink
  await page.click('[data-tb="i-hl"]');
  await expect(page.locator('[data-tb="i-c-0"]')).toHaveClass(/active/);
  await expect(page.locator('[data-tb="i-c-0"] .tb-ink-swatch')).toHaveAttribute('data-color', '#fbbc04');
  await expect(page.locator('.toolbar-ink .tb-ink-swatch[data-color="#1a73e8"]')).toHaveCount(0);   // the pen's blue is not offered here
  await page.click('[data-tb="i-c-2"]');   // pink
  await page.click('[data-tb="i-w-2"]');   // thick
  await expect(page.locator('[data-tb="i-c-2"]')).toHaveClass(/active/);
  // back to the pen: its blue and medium width are untouched
  await page.click('[data-tb="i-pen"]');
  await expect(page.locator('[data-tb="i-c-1"]')).toHaveClass(/active/);
  await expect(page.locator('[data-tb="i-c-1"] .tb-ink-swatch')).toHaveAttribute('data-color', '#1a73e8');
  await expect(page.locator('[data-tb="i-w-1"]')).toHaveClass(/active/);
  // and the highlighter remembers pink + thick
  await page.click('[data-tb="i-hl"]');
  await expect(page.locator('[data-tb="i-c-2"]')).toHaveClass(/active/);
  await expect(page.locator('[data-tb="i-w-2"]')).toHaveClass(/active/);
  // picking a colour while erasing takes the last pen (the highlighter) up again
  await page.click('[data-tb="i-eraser"]');
  await expect(page.locator('.ink-canvas[data-tool="eraser"]')).toBeVisible();
  await page.click('[data-tb="i-c-0"]');
  await expect(page.locator('.ink-canvas[data-tool="highlighter"]')).toBeVisible();
  await expect(page.locator('[data-tb="i-c-0"]')).toHaveClass(/active/);
  // the settings survive a reload (per browser)
  await page.reload();
  await page.waitForSelector('.lyx-editor .lyx-par');
  await expect(page.locator('[data-tb="i-hl"]')).toHaveClass(/active/);
  await expect(page.locator('[data-tb="i-w-2"]')).toHaveClass(/active/);
  await page.click('[data-tb="i-pen"]');
  await expect(page.locator('[data-tb="i-c-1"]')).toHaveClass(/active/);
  // clean up the strokes for the tests that follow on this document (the page scrolled on reload: re-measure)
  await page.click('[data-tb="i-lasso"]');
  const box2 = (await page.locator('.lyx-editor .lyx-par').first().boundingBox())!;
  const tx = box2.x + box2.width + 40, ty = box2.y + 12;
  await page.mouse.move(tx - 30, ty - 40);
  await page.mouse.down();
  for (const [x, y] of [[tx + 200, ty - 40], [tx + 200, ty + 40], [tx - 30, ty + 40]] as const) await page.mouse.move(x, y, { steps: 3 });
  await page.mouse.up();
  await expect(sel).toBeVisible();
  await page.keyboard.press('Delete');
  await expect(page.locator('.lyx-editor .lyx-sketch')).toHaveCount(0);
});

test('clicking the selected colour or width again opens a picker that replaces that preset (Goodnotes)', async ({ page }) => {
  await login(page);
  await openDoc(page, `${PROJECT}/lasso.tex`);
  await page.click('[data-tb="ink"]');
  await expect(page.locator('.ink-canvas.draw')).toBeVisible();
  await page.click('[data-tb="i-pen"]');

  // the first click on a swatch only selects it — no popup; the second one opens the colour picker
  await page.click('[data-tb="i-c-2"]');
  await expect(page.locator('[data-tb="i-c-2"]')).toHaveClass(/active/);
  await expect(page.locator('.tb-popup')).toHaveCount(0);
  await page.click('[data-tb="i-c-2"]');
  const pop = page.locator('.tb-popup[data-palette="i-c-2"]');
  await expect(pop.locator('[data-ink-picker="color"]')).toBeVisible();
  await pop.locator('[data-ink-color="#12b5cb"]').click();
  await expect(page.locator('[data-tb="i-c-2"] .tb-ink-swatch')).toHaveAttribute('data-color', '#12b5cb');   // the preset itself changed…
  await expect(page.locator('[data-tb="i-c-2"]')).toHaveClass(/active/);                                     // …and is what the pen draws with
  await expect(page.locator('[data-tb="i-w-1"] .tb-ink-width')).toHaveCSS('background-color', 'rgb(34, 34, 34)');   // the width dots stay ink-black (--ui-fg), whatever the colour
  await page.keyboard.press('Escape');
  await expect(pop).toBeHidden();

  // widths likewise: select, then click again for the slider
  await page.click('[data-tb="i-w-2"]');
  await expect(page.locator('[data-tb="i-w-2"]')).toHaveClass(/active/);
  await expect(page.locator('.tb-popup')).toHaveCount(0);
  await page.click('[data-tb="i-w-2"]');
  const wpop = page.locator('.tb-popup[data-palette="i-w-2"]');
  await expect(wpop.locator('input[data-ink-width]')).toBeVisible();
  await wpop.locator('input[data-ink-width]').fill('2');   // mm on the page, as Goodnotes counts
  await expect(page.locator('[data-tb="i-w-2"] .tb-ink-width')).toHaveAttribute('data-width', '2');
  await expect(wpop).toContainText('2 mm');
  await page.keyboard.press('Escape');
  await expect(wpop).toBeHidden();

  // a stroke drawn now carries the custom colour and width (2 mm = 7.56 px at 96 dpi) into the saved SVG
  const par = page.locator('.lyx-editor .lyx-par').first();
  const box = (await par.boundingBox())!;
  await squiggle(page, box.x + box.width + 60, box.y + 10);
  await expect(page.locator('.lyx-editor .lyx-sketch')).toHaveCount(1);
  await expect.poll(() => {
    const files = existsSync(`${DIR}/figures`) ? readdirSync(`${DIR}/figures`) : [];
    return files.filter(f => f.startsWith('ink-') && f.endsWith('.svg')).map(f => readFileSync(`${DIR}/figures/${f}`, 'utf8')).join('\n');
  }, { timeout: 15000 }).toMatch(/"color":"#12b5cb","w":7\.56/);

  // the presets survive a reload; the other pen's are untouched
  await page.reload();
  await page.waitForSelector('.lyx-editor .lyx-par');
  await expect(page.locator('[data-tb="i-c-2"] .tb-ink-swatch')).toHaveAttribute('data-color', '#12b5cb');
  await expect(page.locator('[data-tb="i-w-2"] .tb-ink-width')).toHaveAttribute('data-width', '2');
  await page.click('[data-tb="i-hl"]');
  await expect(page.locator('[data-tb="i-c-2"] .tb-ink-swatch')).toHaveAttribute('data-color', '#e8467c');
  await expect(page.locator('[data-tb="i-w-2"] .tb-ink-width')).toHaveAttribute('data-width', '5');

  // clean up the stroke for the tests that follow on this document
  await page.click('[data-tb="i-lasso"]');
  const box2 = (await page.locator('.lyx-editor .lyx-par').first().boundingBox())!;
  const tx = box2.x + box2.width + 60, ty = box2.y + 10;
  await page.mouse.move(tx - 30, ty - 40);
  await page.mouse.down();
  for (const [x, y] of [[tx + 90, ty - 40], [tx + 90, ty + 40], [tx - 30, ty + 40]] as const) await page.mouse.move(x, y, { steps: 3 });
  await page.mouse.up();
  await expect(page.locator('.ink-sel')).toBeVisible();
  await page.keyboard.press('Delete');
  await expect(page.locator('.lyx-editor .lyx-sketch')).toHaveCount(0);
});

/** The RGBA of the ink canvas at a viewport point. */
const canvasPixel = (page: Page, x: number, y: number) => page.evaluate(([px, py]) => {
  const c = document.querySelector('.ink-canvas') as HTMLCanvasElement;
  const r = c.getBoundingClientRect();
  const dpr = c.width / r.width;
  const d = c.getContext('2d')!.getImageData(Math.round((px - r.left) * dpr), Math.round((py - r.top) * dpr), 1, 1).data;
  return [d[0], d[1], d[2], d[3]];
}, [x, y]);

test('the laser pointer traces over the text while the button is held, fades after the lift, and shows on the other client', async ({ browser }) => {
  const a = await browser.newContext(), b = await browser.newContext();
  try {
    const pa = await a.newPage(), pb = await b.newPage();
    await login(pa); await login(pb);
    await openDoc(pa, `${PROJECT}/lasso.tex`); await openDoc(pb, `${PROJECT}/lasso.tex`);
    const sketches = await pa.locator('.lyx-editor .lyx-sketch').count();
    await pa.click('[data-tb="ink"]');
    await pa.click('[data-tb="i-laser"]');
    await expect(pa.locator('.ink-canvas.draw[data-tool="laser"]')).toBeVisible();
    // no keyhole for the laser: the canvas covers the text column too
    await expect.poll(() => pa.evaluate(() => (document.querySelector('.ink-canvas') as HTMLElement).style.clipPath)).toBe('none');

    // a stroke straight across the second paragraph's text
    const boxA = (await pa.locator('.lyx-editor .lyx-par').nth(1).boundingBox())!;
    const yA = boxA.y + boxA.height / 2;
    await pa.mouse.move(boxA.x + 20, yA);
    await pa.mouse.down();
    for (let i = 1; i <= 10; i++) await pa.mouse.move(boxA.x + 20 + i * 10, yA, { steps: 2 });
    // held: the trace is there, red
    await expect.poll(() => canvasPixel(pa, boxA.x + 70, yA).then(([r, g, , al]) => al > 150 && r > 180 && g < 150)).toBe(true);
    // the other client sees it in place (anchored to the same paragraph, in the pointer's presence colour)
    const boxB = (await pb.locator('.lyx-editor .lyx-par').nth(1).boundingBox())!;
    await expect.poll(() => canvasPixel(pb, boxB.x + 70, boxB.y + boxB.height / 2).then(([, , , al]) => al > 100), { timeout: 5000 }).toBe(true);
    // lifted: gone within the second, on both sides — and nothing was written to the document
    await pa.mouse.up();
    await expect.poll(() => canvasPixel(pa, boxA.x + 70, yA).then(([, , , al]) => al), { timeout: 3000 }).toBe(0);
    await expect.poll(() => canvasPixel(pb, boxB.x + 70, boxB.y + boxB.height / 2).then(([, , , al]) => al), { timeout: 3000 }).toBe(0);
    expect(await pa.locator('.lyx-editor .lyx-sketch').count()).toBe(sketches);
    // back to the pen: the text column is a hole again
    await pa.click('[data-tb="i-pen"]');
    await expect.poll(() => pa.evaluate(() => (document.querySelector('.ink-canvas') as HTMLElement).style.clipPath)).toContain('polygon');
  } finally { await a.close(); await b.close(); }
});

test('with the canvas focused (caret deactivated), a pasted image lands in the margin, not as a LaTeX figure', async ({ page }) => {
  await login(page);
  await openDoc(page, `${PROJECT}/lasso.tex`);
  await page.click('[data-tb="ink"]');
  await expect(page.locator('.ink-canvas.draw')).toBeVisible();

  // click into the margin with the lasso: the text caret goes away, the canvas is the paste target
  await page.click('[data-tb="i-lasso"]');
  const par = page.locator('.lyx-editor .lyx-par').nth(1);
  const box = (await par.boundingBox())!;
  await page.mouse.click(box.x + box.width + 80, box.y + 6);
  await expect.poll(() => page.evaluate(() => document.activeElement === document.body || !document.activeElement)).toBe(true);

  // paste a small PNG from the clipboard
  await page.evaluate(() => {
    const b64 = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';
    const bytes = Uint8Array.from(atob(b64), c => c.charCodeAt(0));
    const dt = new DataTransfer();
    dt.items.add(new File([bytes], 'shot.png', { type: 'image/png' }));
    document.dispatchEvent(new ClipboardEvent('paste', { clipboardData: dt, bubbles: true, cancelable: true }));
  });

  // the image becomes a margin object: an anchor appears, it is selected, no graphics inset is inserted
  await expect(page.locator('.lyx-editor .lyx-sketch')).toHaveCount(1, { timeout: 15000 });
  await expect(page.locator('.ink-sel')).toBeVisible();
  await expect(page.locator('.lyx-editor .lyx-graphics')).toHaveCount(0);

  // the document carries it in the sketch data and the sidecar SVG references the file
  await expect.poll(() => readFileSync(`${DIR}/lasso.tex`, 'utf8'), { timeout: 15000 }).toContain('\\olsketch{figures/ink-');
  await expect.poll(() => {
    const files = existsSync(`${DIR}/figures`) ? readdirSync(`${DIR}/figures`) : [];
    // several ink-*.svg files can exist (earlier tests leave orphans): any of them may carry the image
    return files.filter(f => f.startsWith('ink-') && f.endsWith('.svg')).map(f => readFileSync(`${DIR}/figures/${f}`, 'utf8')).join('\n');
  }, { timeout: 15000 }).toContain('<image href="shot');
  expect(readdirSync(`${DIR}/figures`).some(f => f.startsWith('shot'))).toBe(true);
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
