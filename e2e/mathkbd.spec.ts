/**
 * The touch math keyboard (client editor/mathkbd): on a tablet a formula that takes the cursor
 * gets OverLyX's keyboard instead of the system's (its input asks for inputmode="none"); keys type
 * as LyX does — the fraction key takes the operand before the cursor, Greek, a long-pressed key's
 * variants —; ⌄ folds it into a button and back; a hardware key folds it; on a desktop it stays
 * away. The pen (✎ Write): ink is sent as a PNG with the formula around the cursor (the server's
 * /api/ai/ink is answered here), the readings show as chips, the best one faintly in the formula,
 * and a chip inserts it; a zigzag scratches strokes out.
 */
import { test, expect, type Page, type Locator } from '@playwright/test';
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { login, openDoc, texDoc, PROJECTS_DIR, newTouchContext, BASE_URL } from './helpers';

const PROJECT = 'admin/e2e-mathkbd';
const DIR = `${PROJECTS_DIR}/${PROJECT}`;

test.describe.configure({ mode: 'serial' });

test.beforeAll(() => {
  rmSync(DIR, { recursive: true, force: true });
  mkdirSync(DIR, { recursive: true });
  writeFileSync(`${DIR}/keys.tex`, texDoc('Formula $a$ here.'));
  writeFileSync(`${DIR}/pen.tex`, texDoc('Written $b=$ here.'));
  writeFileSync(`${DIR}/desk.tex`, texDoc('Desk $c$ here.'));
});
test.afterAll(() => { rmSync(DIR, { recursive: true, force: true }); });

const latexOf = (page: Page) => page.evaluate(() => ((document.querySelector('.lyx-editor .lyx-math-inline') as any)?.pmViewDesc?.node?.attrs?.latex ?? null) as string | null);
const key = (page: Page, name: string) => page.locator(`.mk .mk-key[data-mk-key="${name}"]`).first();
/** a key let go (the keyboard acts on pointerup; a mouse click is pointerdown + up) */
const tap = async (k: Locator) => { await k.click(); };

/** the formula's right edge tapped: the cursor after its content */
async function tapFormulaEnd(page: Page): Promise<void> {
  const f = page.locator('.lyx-editor .lyx-math-inline').first();
  const b = (await f.boundingBox())!;
  await page.touchscreen.tap(b.x + b.width - 2, b.y + b.height / 2);
  await expect(page.locator('.lyx-editor .lm-field.focused')).toHaveCount(1);
}

test('on a tablet the formula gets the math keyboard; keys type as LyX does', async ({ browser }) => {
  const ctx = await newTouchContext(browser, { baseURL: BASE_URL, viewport: { width: 1024, height: 768 } });
  const page = await ctx.newPage();
  try {
    await login(page);
    await openDoc(page, `${PROJECT}/keys.tex`);
    await tapFormulaEnd(page);
    const kb = page.locator('.mk');
    await expect(kb).toBeVisible();
    // the system keyboard is kept away
    await expect(page.locator('.lyx-editor .lm-field.focused .lm-input')).toHaveAttribute('inputmode', 'none');
    // + 2 x, the fraction key: 2x is the numerator; 3; out of the fraction
    for (const k of ['Plus', '2', 'x', 'Fraction', '3', 'Right']) await tap(key(page, k));
    await expect.poll(() => latexOf(page)).toBe('a+\\frac{2x}{3}');
    // Greek
    await page.locator('.mk [data-mk-tab="greek"]').click();
    await tap(key(page, 'alpha'));
    await expect.poll(() => latexOf(page)).toBe('a+\\frac{2x}{3}\\alpha');
    // a held key offers its variants: = held, then ≠ picked
    await page.locator('.mk [data-mk-tab="123"]').click();
    const eq = key(page, 'Equals');
    const eb = (await eq.boundingBox())!;
    await page.mouse.move(eb.x + eb.width / 2, eb.y + eb.height / 2);
    await page.mouse.down();
    await expect(page.locator('.mk-alts')).toBeVisible();
    const ne = page.locator('.mk-alts .mk-alt[data-mk-key="Not equal"]');
    const nb = (await ne.boundingBox())!;
    await page.mouse.move(nb.x + nb.width / 2, nb.y + nb.height / 2, { steps: 4 });
    await page.mouse.up();
    await expect(page.locator('.mk-alts')).toHaveCount(0);
    await expect.poll(() => latexOf(page)).toBe('a+\\frac{2x}{3}\\alpha\\neq');
    // Backspace (the side column) takes it back; the formula kept the cursor all along
    await tap(key(page, 'Delete'));
    await expect.poll(() => latexOf(page)).toBe('a+\\frac{2x}{3}\\alpha');
    await expect(page.locator('.lyx-editor .lm-field.focused')).toHaveCount(1);
    // ⌄ folds it into the button; the button brings it back
    await page.locator('.mk [data-mk-tool="hide"]').click();
    await expect(kb).toBeHidden();
    await expect(page.locator('.mk-pill')).toBeVisible();
    await page.locator('.mk-pill').click();
    await expect(kb).toBeVisible();
    // leaving the formula: the keyboard goes
    const p = (await page.locator('.lyx-editor > .lyx-par').first().boundingBox())!;
    await page.touchscreen.tap(p.x + 4, p.y + p.height / 2);
    await expect(kb).toBeHidden();
    await expect(page.locator('.mk-pill')).toBeHidden();
    await expect.poll(() => readFileSync(`${DIR}/keys.tex`, 'utf8'), { timeout: 15000 }).toContain('$a+\\frac{2x}{3}\\alpha$');
    // a hardware key folds the keyboard into its button (for the session)
    await tapFormulaEnd(page);
    await expect(kb).toBeVisible();
    await page.keyboard.press('ArrowLeft');
    await expect(kb).toBeHidden();
    await expect(page.locator('.mk-pill')).toBeVisible();
  } finally { await ctx.close(); }
});

test('the pen: ink is read (PNG + context), the best reading shows in the formula, a chip inserts it; a zigzag erases', async ({ browser }) => {
  const ctx = await newTouchContext(browser, { baseURL: BASE_URL, viewport: { width: 1024, height: 768 } });
  const page = await ctx.newPage();
  const sent: any[] = [];
  await page.route('**/api/ai/ink', async route => {
    sent.push(route.request().postDataJSON());
    await route.fulfill({ json: { candidates: ['\\frac{1}{2}', '\\frac{1}{z}'] } });
  });
  try {
    await login(page);
    await openDoc(page, `${PROJECT}/pen.tex`);
    await tapFormulaEnd(page);
    await page.locator('.mk [data-mk-tab="pen"]').click();
    const pad = page.locator('.mk-pad');
    // AI features are off until switched on: the pad asks first
    await expect(pad.locator('.mk-pad-consent')).toBeVisible();
    await pad.locator('[data-mk-pad-btn="consent"]').click();
    await expect(pad.locator('.mk-pad-consent')).toBeHidden();
    const canvas = pad.locator('.mk-pad-canvas');
    const c = (await canvas.boundingBox())!;
    const stroke = async (pts: [number, number][]) => {
      await page.mouse.move(c.x + pts[0][0], c.y + pts[0][1]);
      await page.mouse.down();
      for (const [x, y] of pts.slice(1)) await page.mouse.move(c.x + x, c.y + y, { steps: 3 });
      await page.mouse.up();
    };
    // a "1", a bar, a "2"
    await stroke([[100, 30], [100, 70]]);
    await stroke([[80, 90], [130, 90]]);
    await stroke([[88, 110], [110, 105], [90, 140], [115, 140]]);
    await expect(pad.locator('.mk-cand')).toHaveCount(2);
    expect(sent).toHaveLength(1);
    expect(sent[0].image).toMatch(/^data:image\/png;base64,/);
    expect(sent[0].before).toBe('b=');
    // the best reading faintly at the cursor
    await expect(page.locator('.lyx-editor .lm-field.focused .lm-ghost')).toHaveCount(1);
    await pad.locator('.mk-cand').first().click();
    await expect.poll(() => latexOf(page)).toBe('b=\\frac{1}{2}');
    await expect(pad.locator('.mk-cand')).toHaveCount(0);
    await expect(page.locator('.lyx-editor .lm-field.focused .lm-ghost')).toHaveCount(0);
    // a stroke, then a zigzag over it: both gone, nothing more sent
    await stroke([[300, 40], [300, 110]]);
    await stroke([[280, 70], [320, 74], [282, 78], [322, 82], [281, 86], [321, 90]]);
    await expect(pad.locator('[data-mk-pad-btn="clear"]')).toBeDisabled();
    await page.waitForTimeout(900);
    expect(sent).toHaveLength(1);
    await expect.poll(() => readFileSync(`${DIR}/pen.tex`, 'utf8'), { timeout: 15000 }).toContain('$b=\\frac{1}{2}$');
  } finally { await ctx.close(); }
});

test('a formula on a slide: the canvas is fitted above the keyboard, the keys type into it (needs the runtime in the dist)', async ({ browser }) => {
  const ctx = await newTouchContext(browser, { baseURL: BASE_URL, viewport: { width: 1024, height: 768 } });
  const page = await ctx.newPage();
  try {
    await login(page);
    await page.request.post(BASE_URL + '/api/projects', { data: { name: 'e2e-mathkbd' } });
    mkdirSync(`${DIR}/talk`, { recursive: true });
    writeFileSync(`${DIR}/talk/index.html`, `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="overlyx" content="deck"><title>T</title>
<style>body { margin: 0; background: #dfe3ea; font-family: system-ui, sans-serif; } .slide { width: 1280px; height: 720px; position: relative; overflow: hidden; background: #fff; margin: 0 auto 40px; }</style></head>
<body><section class="slide">
<h1 style="position: absolute; left: 100px; top: 80px; margin: 0; font-size: 60px">Energy</h1>
<p id="t" style="position: absolute; left: 100px; top: 560px; width: 900px; margin: 0; font-size: 40px">It is \\(E = m\\) here</p>
</section></body></html>
`);
    await page.goto(`/#/${PROJECT}/talk/index.html`);
    const formula = page.frameLocator('.dl-frame').locator('#t mjx-container').first();
    await formula.waitFor({ timeout: 30000 });
    await page.waitForTimeout(900);
    const b = (await formula.boundingBox())!;
    await page.mouse.dblclick(b.x + b.width - 3, b.y + b.height / 2);
    await expect(page.locator('[data-dl-mathedit] .lm-field')).toBeVisible();
    const kb = page.locator('.mk');
    await expect(kb).toBeVisible();
    // the canvas ends where the keyboard begins: the formula is above it
    const kTop = (await kb.boundingBox())!.y;
    await expect.poll(async () => { const r = await page.locator('[data-dl-mathedit] .lm-field').boundingBox(); return r ? r.y + r.height <= kTop : false; }).toBe(true);
    for (const k of ['Square', 'Plus', '1']) await key(page, k).click();
    await expect(page.locator('[data-dl-mathedit]')).toHaveCount(1);
    await page.keyboard.press('Escape');
    await expect(page.locator('[data-dl-mathedit]')).toHaveCount(0);
    await page.keyboard.press('Escape');
    await expect.poll(() => /<p id="t"[^>]*>([^<]*)</.exec(readFileSync(`${DIR}/talk/index.html`, 'utf8'))?.[1] ?? '', { timeout: 15000 }).toBe('It is \\(E=m^{2}+1\\) here');
  } finally { await ctx.close(); }
});

test('on a desktop the keyboard stays away (the system keyboard is asked for)', async ({ page }) => {
  await login(page);
  await openDoc(page, `${PROJECT}/desk.tex`);
  const f = page.locator('.lyx-editor .lyx-math-inline').first();
  await f.click();
  await expect(page.locator('.lyx-editor .lm-field.focused')).toHaveCount(1);
  await page.keyboard.type('+1');
  await expect.poll(() => latexOf(page)).toMatch(/\+1/);
  await expect(page.locator('.mk')).toHaveCount(0);
  await expect(page.locator('.lyx-editor .lm-field.focused .lm-input')).toHaveAttribute('inputmode', 'text');
});
