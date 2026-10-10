/**
 * The deck canvas's tools (deliverable/decktoolbar.tsx, runtime/edit.ts, runtime/arrange.ts,
 * runtime/view.ts, runtime/crop.ts): the contextual toolbar (what shows depends on what is
 * selected), fill, distribute, group / ungroup, flip, the rotation handle, new shapes and a line
 * drawn backwards, an SVG dropped in (inline, sanitised, its shapes editable), a crop preset, the
 * canvas's checkerboard from its right-click menu, "Back to the slide" when zoomed in, and moving a
 * text box with a finger on a touch screen (the ⌖ select tool). What lands in index.html each time.
 * Needs the seeded admin.
 */
import { test, expect, type Page, type Frame } from '@playwright/test';
import { readFileSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { login, collectErrors, BASE_URL, PROJECTS_DIR } from './helpers';

const RUN = Date.now().toString(36);
const NAME = `e2e-decktools-${RUN}`;
const PROJECT = `admin/${NAME}`;
const DIR = `${PROJECTS_DIR}/${PROJECT}/talk`;
const FILE = `${DIR}/index.html`;
const fileText = () => readFileSync(FILE, 'utf8');

const DECK = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="overlyx" content="deck">
<title>Tools</title>
<style>
  body { margin: 0; background: #dfe3ea; font-family: system-ui, sans-serif; }
  .slide { width: 1280px; height: 720px; position: relative; overflow: hidden; background: #fff; margin: 0 auto 40px; }
</style>
</head>
<body>

<section class="slide">
  <h1 style="position: absolute; left: 100px; top: 100px; width: 800px; margin: 0; font-size: 64px">Title</h1>
  <div id="a" style="position: absolute; left: 100px; top: 400px; width: 100px; height: 100px; background: #ff0000"></div>
  <div id="b" style="position: absolute; left: 300px; top: 400px; width: 100px; height: 100px; background: #00ff00"></div>
  <div id="c" style="position: absolute; left: 800px; top: 400px; width: 100px; height: 100px; background: #0000ff"></div>
</section>

<section class="slide">
  <h2 style="position: absolute; left: 100px; top: 80px; margin: 0">Two</h2>
</section>

</body>
</html>
`;

const SVG = `<?xml version="1.0"?><svg xmlns="http://www.w3.org/2000/svg" width="200" height="100" viewBox="0 0 200 100"><script>alert(1)</script><rect id="r1" x="10" y="10" width="80" height="80" fill="#123456" onclick="alert(2)"/><circle cx="150" cy="50" r="40" fill="url(#g)"/><defs><linearGradient id="g"><stop offset="0" stop-color="#f00"/><stop offset="1" stop-color="#00f"/></linearGradient></defs></svg>`;
// a 2×2 PNG
const PNG = 'iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAIAAAD91JpzAAAAFklEQVR4nGP4z8DwHwyBNANDzP///wEA8wgD/Y0vVUQAAAAASUVORK5CYII=';

test.describe.configure({ mode: 'serial' });
test.afterAll(() => rmSync(`${PROJECTS_DIR}/${PROJECT}`, { recursive: true, force: true }));

const frameLoc = (page: Page) => page.frameLocator('.dl-frame');
const slides = (page: Page) => frameLoc(page).locator('section.slide');
const editFrame = (page: Page): Frame => page.frames().find(f => /[?&]ol=edit/.test(f.url()))!;
const real = (errors: string[]) => errors.filter(e => !/localStorage/.test(e));

async function setup(page: Page, deck = DECK): Promise<void> {
  mkdirSync(DIR, { recursive: true });
  writeFileSync(FILE, deck);
  await page.goto(`/#/${PROJECT}/talk/index.html`);
  await slides(page).first().waitFor({ timeout: 30000 });
  await page.waitForTimeout(900);
}

/** a point of the first slide (slide px) on the page */
async function at(page: Page, x: number, y: number, n = 0): Promise<{ x: number; y: number }> {
  const b = (await slides(page).nth(n).boundingBox())!;
  const k = b.width / 1280;
  return { x: b.x + x * k, y: b.y + y * k };
}
const styleOf = (id: string) => new RegExp(`id="${id}" style="([^"]*)"`).exec(fileText())?.[1] ?? '';

async function dropFile(page: Page, name: string, type: string, base64: string, x: number, y: number): Promise<void> {
  const p = await at(page, x, y);
  const fb = (await page.locator('.dl-frame').boundingBox())!;
  const fr = editFrame(page);
  const k = await fr.evaluate(() => innerWidth);
  const fx = (p.x - fb.x) * k / fb.width, fy = (p.y - fb.y) * k / fb.width;
  await fr.evaluate(({ name, type, base64, fx, fy }) => {
    const bin = atob(base64); const u = new Uint8Array(bin.length); for (let i = 0; i < bin.length; i++) u[i] = bin.charCodeAt(i);
    const dt = new DataTransfer(); dt.items.add(new File([u], name, { type }));
    const t = document.elementFromPoint(fx, fy) ?? document.body;
    for (const ev of ['dragenter', 'dragover', 'drop']) t.dispatchEvent(new DragEvent(ev, { dataTransfer: dt, bubbles: true, cancelable: true, clientX: fx, clientY: fy }));
  }, { name, type, base64, fx, fy });
}

test('the contextual toolbar, fill, distribute, group, flip and the rotation handle', async ({ page }) => {
  const errors = collectErrors(page);
  await login(page);
  expect((await page.request.post(BASE_URL + '/api/projects', { data: { name: NAME } })).ok()).toBeTruthy();
  await setup(page);

  // nothing selected: the slide's background and the canvas, no text tools
  await expect(page.locator('[data-tb="dk-canvas"]')).toBeVisible();
  await expect(page.locator('[data-tb="dk-b"]')).toHaveCount(0);

  // a text box: the text menu
  const h1 = await at(page, 300, 130);
  await page.mouse.click(h1.x, h1.y);
  await expect(page.locator('[data-tb="dk-b"]')).toBeVisible();
  await expect(page.locator('[data-dk-size] input')).toHaveValue('64');
  await expect(page.locator('[data-tb="dk-fill"]')).toHaveCount(0);

  // a shape: fill and border; a colour from the palette
  const a = await at(page, 150, 450);
  await page.mouse.click(a.x, a.y);
  await expect(page.locator('[data-tb="dk-fill"]')).toBeVisible();
  await page.locator('[data-tb="dk-fill"]').click();
  await page.locator('[data-palette="dk-fill"] [data-color="#ffff00"]').click();
  await expect.poll(() => styleOf('a'), { timeout: 15000 }).toContain('background: #ffff00');

  // three objects: distributed with equal gaps (100…900 holds 300 px of boxes: gaps of 250)
  const b = await at(page, 350, 450), c = await at(page, 850, 450);
  await page.mouse.click(a.x, a.y);
  await page.keyboard.down('Shift');
  await page.mouse.click(b.x, b.y);
  await page.mouse.click(c.x, c.y);
  await page.keyboard.up('Shift');
  await page.locator('[data-tb="dk-arrange"]').click();
  await page.locator('[data-palette="dk-arrange"] .tb-pal-item', { hasText: 'Distribute horizontally' }).click();
  await expect.poll(() => styleOf('b'), { timeout: 15000 }).toContain('left: 450px');

  // grouped and ungrouped (Ctrl+G, Ctrl+Shift+G): the positions come back as they were
  await page.keyboard.press('Control+g');
  await expect.poll(fileText, { timeout: 15000 }).toContain('class="ol-group"');
  await page.keyboard.press('Control+Shift+g');
  await expect.poll(fileText, { timeout: 15000 }).not.toContain('ol-group');
  expect(styleOf('c')).toContain('left: 800px');
  expect(styleOf('b')).toContain('left: 450px');

  // flipped (Arrange ▸ Flip horizontally)
  await page.mouse.click(a.x, a.y);
  await page.locator('[data-tb="dk-arrange"]').click();
  await page.locator('[data-palette="dk-arrange"] .tb-pal-item', { hasText: 'Flip horizontally' }).click();
  await expect.poll(() => styleOf('a'), { timeout: 15000 }).toContain('scale: -1 1');

  // rotated by the round handle above it: dragged level with the centre, to the right — a quarter turn
  const c0 = await at(page, 150, 450);
  const top = await at(page, 150, 400);
  await page.mouse.move(top.x, top.y - 18);
  await page.mouse.down();
  await page.mouse.move(c0.x + 60, c0.y - 40, { steps: 5 });
  await page.mouse.move(c0.x + 120, c0.y, { steps: 5 });
  await page.mouse.up();
  await expect.poll(() => styleOf('a'), { timeout: 15000 }).toContain('rotate: 90deg');
  expect(real(errors)).toEqual([]);
});

test('new shapes, a line drawn backwards, an SVG dropped in and a crop preset', async ({ page }) => {
  const errors = collectErrors(page);
  await login(page);
  await setup(page);

  // a star from the Shapes palette
  await page.locator('[data-tb="dk-shapes"]').click();
  await page.locator('[data-palette="dk-shapes"] .tb-pal-item[title="Star"]').click();
  const s0 = await at(page, 1000, 100), s1 = await at(page, 1150, 250);
  await page.mouse.move(s0.x, s0.y); await page.mouse.down(); await page.mouse.move(s1.x, s1.y, { steps: 6 }); await page.mouse.up();
  await expect.poll(fileText, { timeout: 15000 }).toMatch(/<polygon points="50,4/);

  // an arrow drawn from the lower right to the upper left keeps that direction
  await page.locator('[data-tb="dk-lines"]').click();
  await page.locator('[data-palette="dk-lines"] .tb-pal-item[title="Arrow"]').click();
  const l0 = await at(page, 700, 650), l1 = await at(page, 500, 550);
  await page.mouse.move(l0.x, l0.y); await page.mouse.down(); await page.mouse.move(l1.x, l1.y, { steps: 6 }); await page.mouse.up();
  await expect.poll(fileText, { timeout: 15000 }).toMatch(/<line x1="(\d+(\.\d)?)" y1="\d+(\.\d)?" x2="0" y2="0"/);

  // an SVG dropped on the slide: a drawing in the page, without its script and handlers, ids made its own
  await dropFile(page, 'shapes.svg', 'image/svg+xml', Buffer.from(SVG).toString('base64'), 640, 300);
  await expect.poll(fileText, { timeout: 15000 }).toContain('fill="#123456"');
  const t = fileText();
  expect(t).not.toContain('<script>alert(1)');
  expect(t).not.toContain('onclick');
  expect(t).toMatch(/<linearGradient id="s[a-z0-9]+-g">/);
  expect(t).toMatch(/fill="url\(#s[a-z0-9]+-g\)"/);
  // one of its shapes selected through the drawing (Ctrl+click) and dragged: a translate of its own
  const r = await at(page, 640 - 100 + 50, 300 - 50 + 50);
  await page.keyboard.down('Control');
  await page.mouse.click(r.x, r.y);
  await page.keyboard.up('Control');
  await page.mouse.move(r.x, r.y); await page.mouse.down(); await page.mouse.move(r.x + 40, r.y + 20, { steps: 5 }); await page.mouse.up();
  await expect.poll(fileText, { timeout: 15000 }).toMatch(/<rect id="s[a-z0-9]+-r1"[^>]*transform="translate\(/);

  // a picture dropped in, cropped to a square from the toolbar
  await dropFile(page, 'dot.png', 'image/png', PNG, 300, 600);
  await expect.poll(fileText, { timeout: 15000 }).toContain('src="images/dot.png"');
  await page.waitForTimeout(500);
  await page.locator('[data-tb="dk-cropshape"]').click();
  await page.locator('[data-palette="dk-cropshape"] .tb-pal-item', { hasText: 'Square 1:1' }).click();
  await expect.poll(fileText, { timeout: 15000 }).toContain('class="ol-crop"');
  expect(real(errors)).toEqual([]);
});

test('the canvas: a checkerboard from its menu, Back to the slide when zoomed in', async ({ page }) => {
  const errors = collectErrors(page);
  await login(page);
  await setup(page);
  // the canvas around the frame takes the page's own colour
  await expect.poll(() => page.locator('.dl-canvas').evaluate(e => getComputedStyle(e).backgroundColor)).toBe('rgb(223, 227, 234)');
  // right-click between the slides: the canvas menu
  const s1 = (await slides(page).first().boundingBox())!;
  await page.mouse.click(s1.x + s1.width / 2, s1.y + s1.height + 8, { button: 'right' });
  await page.locator('.ctx-menu').getByText('Checkerboard canvas').click();
  await expect.poll(() => page.locator('.dl-canvas').evaluate(e => getComputedStyle(e).backgroundImage)).toContain('conic-gradient');
  // zoomed in far: a way back to the whole slide
  for (let i = 0; i < 5; i++) await page.locator('.dl-zoomgroup button[title^="Zoom in"]').click();
  await expect(page.locator('[data-dl-refocus]')).toBeVisible();
  await page.locator('[data-dl-refocus]').click();
  await expect(page.locator('[data-dl-refocus]')).toHaveCount(0);
  expect(real(errors)).toEqual([]);
});

test('a finger moves a text box on a touch screen', async ({ browser }) => {
  const ctx = await browser.newContext({ baseURL: BASE_URL, hasTouch: true, viewport: { width: 1280, height: 900 } });
  const page = await ctx.newPage();
  const errors = collectErrors(page);
  await login(page);
  await setup(page);
  const cdp = await ctx.newCDPSession(page);
  const touch = async (type: string, x: number, y: number) => cdp.send('Input.dispatchTouchEvent', { type, touchPoints: type === 'touchEnd' ? [] : [{ x, y, id: 1 }] });
  const p = await at(page, 300, 135), q = await at(page, 300 + 120, 135 + 80);
  // a tap selects it, a drag moves it — the page must not scroll instead
  await touch('touchStart', p.x, p.y); await touch('touchEnd', p.x, p.y);
  await page.waitForTimeout(300);
  await touch('touchStart', p.x, p.y);
  for (let i = 1; i <= 10; i++) { await touch('touchMove', p.x + (q.x - p.x) * i / 10, p.y + (q.y - p.y) * i / 10); await page.waitForTimeout(16); }
  await touch('touchEnd', q.x, q.y);
  await expect.poll(() => /<h1 style="([^"]*)"/.exec(fileText())?.[1] ?? '', { timeout: 15000 }).toMatch(/left: 2[12]\dpx; top: 1[78]\dpx/);
  expect(real(errors)).toEqual([]);
  await ctx.close();
});
