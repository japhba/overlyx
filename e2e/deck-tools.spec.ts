/**
 * The deck canvas's tools (deliverable/decktoolbar.tsx, runtime/edit.ts, runtime/arrange.ts,
 * runtime/view.ts, runtime/crop.ts): the contextual toolbar (what shows depends on what is
 * selected), fill, distribute, group / ungroup (Ctrl+click moves an object inside a group, which fits
 * around it; a group resized as one; a drawing's parts into a <g>, resized and turned with handles of
 * their own), the Objects pane (select at any depth, rename, lock, restack), sizes and line weights in points,
 * flip, the rotation handle, new shapes and a line
 * drawn backwards, an SVG dropped in (inline, sanitised, its shapes editable), a crop preset, the
 * canvas's checkerboard from its right-click menu, "Back to the slide" when zoomed in, the zoom said
 * over the canvas while a pinch changes it (which stops at Fit), and moving a
 * text box with a finger on a touch screen (the ⌖ select tool; swiped over an object not selected,
 * the slide turns), Draw (pen, highlighter, eraser), the
 * rail and the notes folded away. What lands in index.html each time.
 * Needs the seeded admin.
 */
import { test, expect, type Page, type Frame } from '@playwright/test';
import { readFileSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { login, collectErrors, fillDialog, BASE_URL, PROJECTS_DIR } from './helpers';

const RUN = Date.now().toString(36);
const NAME = `e2e-decktools-${RUN}`;
const PROJECT = `admin/${NAME}`;
// each test its own deck (a folder of its own): the same file written again for the next test could
// still be open on the server with the last test's text, and the next test would see that
let deckNo = 0;
let FOLDER = 'talk';
let FILE = `${PROJECTS_DIR}/${PROJECT}/${FOLDER}/index.html`;
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
/** the canvas shows one slide at a time: slide `n` by its thumbnail in the rail, as a person would */
async function gotoSlide(page: Page, n: number): Promise<void> {
  await page.frameLocator('.dl-railframe').locator('section.slide').nth(n).click();
  await expect(slides(page).nth(n)).toBeVisible();
  await page.waitForTimeout(300);
}
const editFrame = (page: Page): Frame => page.frames().find(f => /[?&]ol=edit/.test(f.url()))!;
const real = (errors: string[]) => errors.filter(e => !/localStorage/.test(e));

async function setup(page: Page, deck = DECK): Promise<void> {
  FOLDER = `talk${++deckNo}`;
  FILE = `${PROJECTS_DIR}/${PROJECT}/${FOLDER}/index.html`;
  mkdirSync(`${PROJECTS_DIR}/${PROJECT}/${FOLDER}`, { recursive: true });
  writeFileSync(FILE, deck);
  // (the server takes a new folder on as a project when it lists them: before the page asks for the deck, or that is refused)
  await page.request.get('/api/projects');
  await page.goto(`/#/${PROJECT}/${FOLDER}/index.html`);
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

test('the contextual toolbar, fill, distribute, group, flip and rotation (a second click: the arrows)', async ({ page }) => {
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
  await expect(page.locator('.dl-toolbar [data-dk-size] input')).toHaveValue('48');   // 64 px, in points
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

  // rotated as in Inkscape: a click on the selected object again turns its handles into rotation arrows
  // off the corners; the top right one (on the square's diagonal) dragged round to the bottom right — a quarter turn
  const c0 = await at(page, 150, 450);
  await page.mouse.click(c0.x, c0.y);
  await page.waitForTimeout(200);
  const ne = await at(page, 200, 400);
  await page.mouse.move(ne.x + 6.4, ne.y - 6.4);
  await page.mouse.down();
  await page.mouse.move(c0.x + 90, c0.y, { steps: 5 });
  await page.mouse.move(c0.x + 60, c0.y + 60, { steps: 5 });
  await page.mouse.up();
  await expect.poll(() => styleOf('a'), { timeout: 15000 }).toContain('rotate: 90deg');
  expect(real(errors)).toEqual([]);
});

test('the quick menu beside the selection: the toolbar\'s main buttons, out of the way while dragging, duplicate', async ({ page }) => {
  const errors = collectErrors(page);
  await login(page);
  await page.request.post(BASE_URL + '/api/projects', { data: { name: NAME } });
  await setup(page);
  const quick = page.locator('[data-dl-quick]');
  await expect(quick).toHaveCount(0);   // nothing selected
  // a shape: fill and border among its buttons, beside it (above its top edge)
  const c = await at(page, 150, 450);
  await page.mouse.click(c.x, c.y);
  await expect(quick).toBeVisible();
  await expect(quick.locator('[data-tb="q-fill"]')).toHaveCount(1);
  await expect(quick.locator('[data-tb="q-delete"]')).toHaveCount(1);
  await expect(page.locator('[data-tb="dk-fill"]')).toHaveCount(1);   // the toolbar's own button stays one of a kind
  const qb = (await quick.boundingBox())!, top = await at(page, 150, 400);
  expect(qb.y + qb.height).toBeLessThanOrEqual(top.y);
  // its fill acts as the toolbar's
  await quick.locator('[data-tb="q-fill"]').click();
  await page.locator('[data-palette="q-fill"] [data-color="#ffff00"]').click();
  await expect.poll(() => styleOf('a'), { timeout: 15000 }).toContain('#ffff00');
  // while the shape is dragged the menu steps aside, then follows it
  await page.mouse.move(c.x, c.y);
  await page.mouse.down();
  await page.mouse.move(c.x + 40, c.y + 10, { steps: 6 });
  await expect(quick).toHaveCount(0);
  await page.mouse.up();
  await expect(quick).toBeVisible();
  // duplicate from the menu: a copy of the shape
  await quick.locator('[data-tb="q-dup"]').click();
  await expect.poll(() => (fileText().match(/background: #ffff00/g) ?? []).length, { timeout: 15000 }).toBe(2);
  expect(real(errors)).toEqual([]);
});

const WORDS_DECK = DECK.replace(/<section class="slide">[\s\S]*?<\/section>/, `<section class="slide">
  <div id="t" style="position: absolute; left: 100px; top: 120px; width: 900px; font-size: 32px"><p style="margin: 0 0 140px">First line of the box</p><p style="margin: 0">Words to pick here</p></div>
  <div class="ol-group" style="position: absolute; left: 100px; top: 440px; width: 700px; height: 240px">
    <p id="g1" style="position: absolute; left: 0px; top: 0px; width: 700px; margin: 0; font-size: 28px">Grouped heading</p>
    <p id="g2" style="position: absolute; left: 0px; top: 200px; width: 700px; margin: 0; font-size: 28px">Grouped words below</p>
  </div>
</section>`);

test('the quick menu goes over the words selected while typing — in a text box, in a text inside a group — with the word tools', async ({ page }) => {
  const errors = collectErrors(page);
  await login(page);
  await page.request.post(BASE_URL + '/api/projects', { data: { name: NAME } });
  await setup(page, WORDS_DECK);
  const quick = page.locator('[data-dl-quick]');
  const k = (await slides(page).first().boundingBox())!.width / 1280;
  // typing in the box, nothing selected: the menu is the box's, above it
  const line2 = await at(page, 140, 315);
  await page.mouse.dblclick(line2.x, line2.y);
  await expect(quick).toBeVisible();
  await expect(quick.locator('[data-tb="q-dup"]')).toHaveCount(1);
  const boxTop = (await at(page, 100, 120)).y;
  expect((await quick.boundingBox())!.y + (await quick.boundingBox())!.height).toBeLessThanOrEqual(boxTop);
  // words selected (the keys): the menu over them, far below the box's top — font, size, bold … link, comment; no Delete
  await page.keyboard.press('End');
  await page.keyboard.press('Control+Shift+ArrowLeft');
  await page.keyboard.press('Control+Shift+ArrowLeft');
  await expect(quick.locator('[data-tb="q-font"]')).toHaveCount(1);
  for (const id of ['q-size', 'q-b', 'q-i', 'q-u', 'q-color', 'q-hl', 'q-href', 'q-comment']) await expect(quick.locator(`[data-tb="${id}"]`)).toHaveCount(1);
  for (const id of ['q-delete', 'q-dup', 'q-align']) await expect(quick.locator(`[data-tb="${id}"]`)).toHaveCount(0);
  const wordsTop = (await at(page, 0, 298)).y;   // (the second line's top: 120 + 38 + 140)
  await expect.poll(async () => { const q = (await quick.boundingBox())!; return q.y + q.height; }).toBeGreaterThan(wordsTop - 30 * k - 20);
  const qb = (await quick.boundingBox())!;
  expect(qb.y + qb.height).toBeLessThanOrEqual(wordsTop + 2);
  // its Bold makes those words bold, and then shows them bold
  await quick.locator('[data-tb="q-b"]').click();
  await expect(quick.locator('[data-tb="q-b"]')).toHaveClass(/\bactive\b/);
  await expect(page.locator('.dl-toolbar [data-tb="dk-b"]')).toHaveClass(/\bactive\b/);
  await page.keyboard.press('Escape');
  await expect.poll(fileText, { timeout: 15000 }).toMatch(/Words to <span style="font-weight: bold;">pick here<\/span>|Words to <b>pick here<\/b>/);
  await expect(quick.locator('[data-tb="q-dup"]')).toHaveCount(1);   // back beside the box

  // a text inside a group, its words chosen with the pointer: the menu waits until the pointer is lifted, then sits over them
  const g = await at(page, 300, 460);
  await page.mouse.click(g.x, g.y);
  const w0 = await at(page, 102, 656), w1 = await at(page, 230, 656);
  await page.mouse.dblclick(w1.x, w1.y);
  await expect(quick).toBeVisible();
  await page.mouse.move(w0.x, w0.y);
  await page.mouse.down();
  await page.mouse.move(w1.x, w1.y, { steps: 6 });
  await expect(quick).toHaveCount(0);
  await page.mouse.up();
  await expect(quick.locator('[data-tb="q-font"]')).toHaveCount(1);
  // (the words are on the text's first line: the menu stays clear of its name tag)
  const gb = (await quick.boundingBox())!, gTop = (await at(page, 0, 640)).y;
  expect(gb.y + gb.height).toBeLessThanOrEqual(gTop - 24);
  expect(gb.y + gb.height).toBeGreaterThan(gTop - 40);
  expect(Math.abs(gb.x - w0.x)).toBeLessThan(30);
  await page.keyboard.press('Escape');
  expect(real(errors)).toEqual([]);
});

const GROUP_DECK = DECK.replace(/<section class="slide">[\s\S]*?<\/section>/, `<section class="slide">
  <div id="a" style="position: absolute; left: 100px; top: 100px; width: 100px; height: 100px; background: #ff0000"></div>
  <div id="b" style="position: absolute; left: 300px; top: 100px; width: 100px; height: 100px; background: #00ff00"></div>
  <p id="t" style="position: absolute; left: 100px; top: 400px; width: 600px; margin: 0; font-size: 32px">Text</p>
  <svg id="s" style="position: absolute; left: 800px; top: 400px; width: 300px; height: 150px" viewBox="0 0 150 75"><rect id="r" x="0" y="0" width="60" height="60" fill="#112233" stroke="#000000" stroke-width="2"/><circle id="o" cx="110" cy="30" r="30" fill="#445566"/></svg>
</section>`);

const num = (style: string, prop: string) => Number(new RegExp(`(?:^|; )${prop}: (-?[\\d.]+)px`).exec(style)?.[1] ?? NaN);
const groupStyle = () => /class="ol-group" style="([^"]*)"/.exec(fileText())?.[1] ?? '';

test('groups: from the quick menu, Ctrl+click moves an object inside (the group fits around it), resized as one; a drawing\'s parts in a <g>; points', async ({ page }) => {
  const errors = collectErrors(page);
  await login(page);
  await page.request.post(BASE_URL + '/api/projects', { data: { name: NAME } });
  await setup(page, GROUP_DECK);
  const quick = page.locator('[data-dl-quick]');
  // two shapes: Group in the quick menu (and the toolbar)
  const a = await at(page, 150, 150), b = await at(page, 350, 150);
  await page.mouse.click(a.x, a.y);
  await page.keyboard.down('Shift'); await page.mouse.click(b.x, b.y); await page.keyboard.up('Shift');
  await expect(page.locator('.dl-toolbar [data-tb="dk-group"]')).toHaveCount(1);
  await quick.locator('[data-tb="q-group"]').click();
  await expect.poll(groupStyle, { timeout: 15000 }).toBe('position: absolute; left: 100px; top: 100px; width: 300px; height: 100px');
  expect(styleOf('b')).toContain('left: 200px; top: 0px');
  // the group selected, as one: Ungroup offered, no text tools
  await expect(quick.locator('[data-tb="q-ungroup"]')).toHaveCount(1);
  await expect(quick.locator('[data-tb="q-b"]')).toHaveCount(0);

  // Ctrl+drag: the green square alone, inside the group (no snapping); the group grows to hold it
  const b1 = await at(page, 350, 150), b2 = await at(page, 450, 200);
  await page.keyboard.down('Control');
  await page.mouse.move(b1.x, b1.y); await page.mouse.down();
  await page.mouse.move((b1.x + b2.x) / 2, (b1.y + b2.y) / 2, { steps: 4 }); await page.mouse.move(b2.x, b2.y, { steps: 4 });
  await page.mouse.up();
  await page.keyboard.up('Control');
  await expect.poll(() => num(groupStyle(), 'width'), { timeout: 15000 }).toBeGreaterThan(395);
  let g = groupStyle();
  expect(Math.abs(num(g, 'width') - 400)).toBeLessThan(3);
  expect(Math.abs(num(g, 'height') - 150)).toBeLessThan(3);
  expect(num(g, 'left')).toBe(100);
  expect(Math.abs(num(styleOf('b'), 'left') - 300)).toBeLessThan(3);
  expect(styleOf('a')).toContain('left: 0px; top: 0px');
  // a plain click on the other square: it alone (still inside the group)
  await page.mouse.click(a.x, a.y);
  await expect(quick.locator('[data-tb="q-ungroup"]')).toHaveCount(0);
  // Escape: a level up, the group; the arrows move it (the keyboard is still in the editor)
  await page.keyboard.press('Escape');
  await expect(quick.locator('[data-tb="q-ungroup"]')).toHaveCount(1);
  await page.keyboard.press('Shift+ArrowRight');
  await expect.poll(() => num(groupStyle(), 'left'), { timeout: 15000 }).toBe(110);

  // resized by a corner: its objects scale with it, in proportion
  g = groupStyle();
  const w0 = num(g, 'width'), h0 = num(g, 'height');
  const se = await at(page, 110 + w0, 100 + h0), to = await at(page, 110 + w0 + 100, 100 + h0 + 20);
  await page.mouse.move(se.x, se.y); await page.mouse.down();
  await page.mouse.move((se.x + to.x) / 2, (se.y + to.y) / 2, { steps: 4 }); await page.mouse.move(to.x, to.y, { steps: 4 });
  await page.mouse.up();
  await expect.poll(() => num(groupStyle(), 'width'), { timeout: 15000 }).toBeGreaterThan(w0 + 90);
  g = groupStyle();
  const k = num(g, 'width') / w0;
  expect(Math.abs(num(g, 'height') - h0 * k)).toBeLessThan(3);
  expect(Math.abs(num(styleOf('b'), 'width') - 100 * k)).toBeLessThan(3);
  expect(Math.abs(num(styleOf('b'), 'left') - 300 * k)).toBeLessThan(4);
  // ungrouped: back on the slide where they are
  await page.keyboard.press('Control+Shift+g');
  await expect.poll(fileText, { timeout: 15000 }).not.toContain('ol-group');
  expect(Math.abs(num(styleOf('b'), 'left') - (110 + 300 * k))).toBeLessThan(5);

  // font sizes in points (32 px = 24 pt), written in points
  const t = await at(page, 200, 420);
  await page.mouse.click(t.x, t.y);
  const size = page.locator('.dl-toolbar [data-dk-size] input');
  await expect(size).toHaveValue('24');
  await page.locator('.dl-toolbar [data-dk-size] button').last().click();
  await expect.poll(() => styleOf('t'), { timeout: 15000 }).toContain('font-size: 28pt');
  await expect(size).toHaveValue('28');

  // a part of a drawing (Ctrl+click): its line weight in points of the slide — 2 units of a drawing shown twice its size: 3 pt
  const r = await at(page, 860, 460);
  await page.keyboard.down('Control'); await page.mouse.click(r.x, r.y); await page.keyboard.up('Control');
  await page.locator('.dl-toolbar [data-tb="dk-weight"]').click();
  await expect(page.locator('[data-palette="dk-weight"] .tb-pal-item.active')).toHaveText('3 pt');
  await page.locator('[data-palette="dk-weight"] .tb-pal-item', { hasText: '1½ pt' }).click();
  await expect.poll(fileText, { timeout: 15000 }).toContain('stroke-width="1"');
  // two parts grouped: a <g> in the drawing; ungrouped again
  const o = await at(page, 1020, 460);
  await page.keyboard.down('Control'); await page.keyboard.down('Shift'); await page.mouse.click(o.x, o.y); await page.keyboard.up('Shift'); await page.keyboard.up('Control');
  await page.keyboard.press('Control+g');
  await expect.poll(fileText, { timeout: 15000 }).toMatch(/<g><rect id="r"[^<]*(<\/rect>)?<circle id="o"[^<]*(<\/circle>)?<\/g>/);
  await page.keyboard.press('Control+Shift+g');
  await expect.poll(fileText, { timeout: 15000 }).not.toContain('<g>');
  expect(real(errors)).toEqual([]);
});

const LOGO_DECK = DECK.replace(/<section class="slide">[\s\S]*?<\/section>/, `<section class="slide">
  <svg id="logo" style="position: absolute; left: 320px; top: 40px; width: 640px; height: 640px" viewBox="0 0 64 64">
    <circle id="ring" cx="32" cy="32" r="21" fill="none" stroke="#1c1b19" stroke-width="5"/>
    <path id="glyph-A" fill="#2152a3" transform="translate(16 32) rotate(-12) scale(0.03) translate(-250 -350)" d="M0 0H500V700H0Z"/>
    <path id="glyph-B" fill="#efb21a" transform="translate(0 1) translate(32 32) scale(0.03) translate(-250 -350)" d="M0 0H500V700H0Z"/>
    <g id="pair"><rect x="42" y="26" width="5" height="12" fill="#d6402b"/><rect x="49" y="26" width="5" height="12" fill="#d6402b"/></g>
  </svg>
</section>`);

test('the parts of a drawing resized and turned with handles; the Objects pane selects, renames, locks and restacks them', async ({ page }) => {
  const errors = collectErrors(page);
  await login(page);
  await page.request.post(BASE_URL + '/api/projects', { data: { name: NAME } });
  await setup(page, LOGO_DECK);
  const transformOf = (id: string) => new RegExp(`id="${id}"[^>]*transform="([^"]*)"`).exec(fileText())?.[1] ?? '';
  /** a corner (fx, fy in 0…1) of a part's own box, on the page */
  const corner = async (id: string, fx: number, fy: number) => {
    const fb = (await page.locator('.dl-frame').boundingBox())!;
    const p = await editFrame(page).evaluate(`(() => { const el = document.getElementById(${JSON.stringify(id)}); const b = el.getBBox(); const pt = new DOMPoint(b.x + b.width * ${fx}, b.y + b.height * ${fy}).matrixTransform(el.getScreenCTM()); return { x: pt.x, y: pt.y, w: innerWidth }; })()`) as { x: number; y: number; w: number };
    return { x: fb.x + p.x * fb.width / p.w, y: fb.y + p.y * fb.width / p.w };
  };
  // the Objects pane: the drawing opened up, front first
  await page.locator('[data-tb="dk-objects"]').click();
  const rows = page.locator('[data-dl-objects] [data-obj-row]');
  await expect(rows).toHaveText([/logo/, /pair/, /Rectangle/, /Rectangle/, /glyph-B/, /glyph-A/, /ring/]);
  // a letter selected from it: resize handles on its turned box; the se one dragged out
  await rows.filter({ hasText: 'glyph-A' }).click();
  await expect(rows.filter({ hasText: 'glyph-A' })).toHaveClass(/sel/);
  const se = await corner('glyph-A', 1, 1);
  await page.mouse.move(se.x, se.y); await page.mouse.down();
  await page.mouse.move(se.x + 20, se.y + 15, { steps: 4 }); await page.mouse.move(se.x + 40, se.y + 30, { steps: 4 });
  await page.mouse.up();
  await expect.poll(() => transformOf('glyph-A'), { timeout: 15000 }).not.toContain('scale(0.03)');
  expect(transformOf('glyph-A')).toMatch(/^translate\([\d.]+ [\d.]+\) rotate\(-12\) scale\([\d.]+ [\d.]+\) translate\(-250 -350\)$/);
  // a click on it again: rotation arrows; the ne one dragged round clockwise
  const c = await corner('glyph-A', 0.5, 0.5);
  await page.mouse.click(c.x, c.y);
  await page.waitForTimeout(200);
  const ne = await corner('glyph-A', 1, 0);
  const l = Math.hypot(ne.x - c.x, ne.y - c.y), ax = ne.x + (ne.x - c.x) / l * 9, ay = ne.y + (ne.y - c.y) / l * 9;
  await page.mouse.move(ax, ay); await page.mouse.down();
  await page.mouse.move(ax + 30, ay + 40, { steps: 5 }); await page.mouse.move(ax + 40, ay + 90, { steps: 5 });
  await page.mouse.up();
  await expect.poll(() => transformOf('glyph-A'), { timeout: 15000 }).not.toContain('rotate(-12)');
  expect(Number(/rotate\((-?[\d.]+)\)/.exec(transformOf('glyph-A'))![1])).toBeGreaterThan(0);
  // another part moved: its chain of transforms tidied into one
  await rows.filter({ hasText: 'glyph-B' }).click();
  await page.keyboard.press('Shift+ArrowDown');
  await expect.poll(() => transformOf('glyph-B'), { timeout: 15000 }).toBe('translate(32 34) scale(0.03) translate(-250 -350)');
  // dragged onto glyph-B's upper half: glyph-A in front of it (after it in the drawing)
  await rows.filter({ hasText: 'glyph-A' }).dragTo(rows.filter({ hasText: 'glyph-B' }), { targetPosition: { x: 30, y: 3 } });
  await expect.poll(() => fileText().indexOf('id="glyph-A"') > fileText().indexOf('id="glyph-B"'), { timeout: 15000 }).toBe(true);
  // renamed by a double click: in the file, the pane and the canvas's tag
  await rows.filter({ hasText: 'ring' }).dblclick();
  await page.locator('[data-obj-rename]').fill('The ring');
  await page.keyboard.press('Enter');
  await expect.poll(fileText, { timeout: 15000 }).toContain('data-ol-name="The ring"');
  await expect(rows.filter({ hasText: 'The ring' })).toHaveCount(1);
  // locked from the pane: it holds on the canvas at once (an arrow does not move it)
  const pair = rows.filter({ hasText: 'pair' });
  await pair.hover();
  await pair.locator('[data-obj-lock]').click();
  await expect.poll(fileText, { timeout: 15000 }).toMatch(/id="pair"[^>]*data-ol-locked/);
  await pair.click();
  const before = fileText();
  await page.keyboard.press('Shift+ArrowRight');
  await page.waitForTimeout(1200);
  expect(fileText()).toBe(before);
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

test('Draw: strokes one after the other in the pen\'s colour, the highlighter, the eraser; the rail and the notes fold away', async ({ page }) => {
  const errors = collectErrors(page);
  await login(page);
  await setup(page);
  const strokes = () => (fileText().match(/<svg class="ol-ink"/g) ?? []).length;
  const stroke = async (x0: number, y0: number, x1: number, y1: number) => {
    const a = await at(page, x0, y0), b = await at(page, x1, y1);
    await page.mouse.move(a.x, a.y); await page.mouse.down(); await page.mouse.move(b.x, b.y, { steps: 12 }); await page.mouse.up();
  };
  const fr = () => editFrame(page);
  // Draw: its own row — pen, highlighter, eraser, the colours and widths
  await page.locator('[data-tb="dk-draw"]').click();
  await expect(page.locator('[data-tb="dk-ink-pen"]')).toBeVisible();
  // the stroke is in the slide while it is drawn, in its ink (no preview of another colour), stroked with round ends
  const a0 = await at(page, 100, 600), a1 = await at(page, 400, 640);
  await page.mouse.move(a0.x, a0.y); await page.mouse.down(); await page.mouse.move(a1.x, a1.y, { steps: 12 });
  await page.waitForTimeout(100);
  expect(await fr().evaluate(`(() => { const g = document.querySelector('section.slide svg.ol-ink[data-ol-runtime] g'); return g ? [g.getAttribute('stroke'), g.getAttribute('stroke-linecap'), Array.from(g.querySelectorAll('path')).map(p => p.getAttribute('d')).join('').length].join(' ') : null; })()`)).toMatch(/^#[0-9a-f]{6} round \d{2,}/);
  await page.mouse.up();
  await expect.poll(strokes, { timeout: 15000 }).toBe(1);
  // once the page has it, the stroke drawn is not shown twice
  await expect.poll(() => fr().evaluate(`document.querySelectorAll('svg.ol-ink[data-ol-runtime]').length`), { timeout: 5000 }).toBe(0);
  expect(await fr().evaluate(`document.querySelectorAll('section.slide svg.ol-ink').length`)).toBe(1);
  // the pen stays in hand (the stroke is not selected): the next one, red
  await page.locator('[data-tb="dk-ink-c2"]').click();
  await stroke(100, 680, 400, 690);
  await expect.poll(fileText, { timeout: 15000 }).toContain('stroke="#d93025"');
  expect(strokes()).toBe(2);
  await expect(page.locator('[data-tb="dk-draw"]')).toHaveClass(/active/);
  // the highlighter over the title: translucent, multiplied over the text
  await page.locator('[data-tb="dk-ink-hl"]').click();
  await stroke(100, 140, 700, 140);
  await expect.poll(fileText, { timeout: 15000 }).toContain('mix-blend-mode: multiply');
  expect(strokes()).toBe(3);
  // the eraser across the two pen strokes: both go, the highlighter and the shapes stay; one undo brings both back
  await page.locator('[data-tb="dk-ink-eraser"]').click();
  await stroke(250, 570, 250, 720);
  await expect.poll(strokes, { timeout: 15000 }).toBe(1);
  expect(fileText()).toContain('mix-blend-mode: multiply');
  expect(fileText()).toContain('id="a"');
  await page.keyboard.press('Control+z');
  await expect.poll(strokes, { timeout: 15000 }).toBe(3);
  // Esc puts the pen away
  await page.keyboard.press('Escape');
  await expect(page.locator('[data-tb="dk-ink-pen"]')).toHaveCount(0);
  await expect(page.locator('[data-tb="dk-draw"]')).not.toHaveClass(/active/);
  // a stroke selected: its ink colour changes (its runs' stroke, never a fill)
  const s2 = await at(page, 250, 685);
  await page.mouse.click(s2.x, s2.y);
  await page.locator('[data-tb="dk-inkcolor"]').click();
  await page.locator('[data-palette="dk-inkcolor"] [data-color="#ffff00"]').click();
  await expect.poll(fileText, { timeout: 15000 }).toContain('stroke="#ffff00"');
  expect(fileText()).not.toContain('fill="#ffff00"');
  await page.keyboard.press('Escape');

  // the slide rail and the speaker notes fold away, stay so after a reload, and come back
  await page.locator('[data-dl-rail-hide]').click();
  await expect(page.locator('.dl-railframe')).toHaveCount(0);
  await page.locator('[data-dl-notes-hide]').click();
  await expect(page.locator('[data-dl-notes]')).toHaveCount(0);
  await page.reload();
  await slides(page).first().waitFor({ timeout: 30000 });
  await expect(page.locator('[data-dl-rail-show]')).toBeVisible();
  await expect(page.locator('[data-dl-notes-show]')).toBeVisible();
  // folded away, neither the slides, the notes nor the files panel takes room beside or under the slide,
  // and nothing of them lies over it: their buttons are in the screen's bottom-left corner (the status bar)
  await page.locator('.docpanel .hide').click();
  await expect(page.locator('[data-rail="outline"]')).toBeVisible();
  await expect.poll(async () => { const m = (await page.locator('.main').boundingBox())!, cv = (await page.locator('.dl-canvas').boundingBox())!; return [Math.round(cv.x - m.x), Math.round(m.y + m.height - cv.y - cv.height)].join(); }).toBe('0,0');
  const cv0 = (await page.locator('.dl-canvas').boundingBox())!;
  for (const sel of ['[data-rail="outline"]', '[data-dl-rail-show]', '[data-dl-notes-show]']) {
    const b = (await page.locator(sel).boundingBox())!;
    expect(b.y).toBeGreaterThanOrEqual(cv0.y + cv0.height);
    expect(b.x).toBeLessThan(400);
    await expect(page.locator(`.statusbar ${sel}`)).toBeVisible();
  }
  await expect(page.locator('.dl-canvas button, .dl-canvas [role="button"]')).toHaveCount(0);
  await page.locator('[data-rail="outline"]').click();
  await expect(page.locator('.sidebar.left .docpanel')).toBeVisible();
  await page.locator('[data-dl-rail-show]').click();
  await expect(page.frameLocator('.dl-railframe').locator('section.slide')).toHaveCount(2);
  await page.locator('[data-dl-notes-show]').click();
  await expect(page.locator('[data-dl-notes]')).toBeVisible();
  expect(real(errors)).toEqual([]);
});

test("Draw: the pen's settings (GoodNotes'), a ball pen kept for the next visit; a scribble over strokes erases them, over nothing it stays", async ({ page, context }) => {
  const errors = collectErrors(page);
  await login(page);
  await setup(page);
  const strokes = () => (fileText().match(/<svg class="ol-ink"/g) ?? []).length;
  const cdp = await context.newCDPSession(page);
  const pen = (type: string, x: number, y: number, force: number) => cdp.send('Input.dispatchMouseEvent', { type, x, y, button: 'left', buttons: type === 'mouseReleased' ? 0 : 1, clickCount: 1, force, pointerType: 'pen' });
  const mouseLine = async (pts: [number, number][]) => {
    const ps = await Promise.all(pts.map(([x, y]) => at(page, x, y)));
    await page.mouse.move(ps[0].x, ps[0].y); await page.mouse.down();
    for (const p of ps.slice(1)) await page.mouse.move(p.x, p.y, { steps: 6 });
    await page.mouse.up();
  };
  await page.locator('[data-tb="dk-draw"]').click();
  // the pen clicked again: its settings — a fountain pen, round tip, a quarter of the pressure, as drawn
  await page.locator('[data-tb="dk-ink-pen"]').click();
  const ps = page.locator('[data-pen-settings]');
  await expect(ps).toBeVisible();
  await expect(ps.locator('[data-pen-kind="fountain"]')).toHaveAttribute('aria-checked', 'true');
  for (const [k, v] of [['sharpness', '0%'], ['sensitivity', '25%'], ['flatness', '0%'], ['stabilization', '0%']]) await expect(ps.locator(`[data-pen-level="${k}"] .pen-set-val`)).toHaveText(v);
  await expect(ps.locator('[data-pen-scribble]')).toBeChecked();
  // a ball pen: no pressure, tip or flatness to set, stabilization still
  await ps.locator('[data-pen-kind="ball"]').click();
  await expect(ps.locator('[data-pen-level="sensitivity"]')).toHaveCount(0);
  await expect(ps.locator('[data-pen-level="stabilization"]')).toHaveCount(1);
  await expect(page.locator('[data-tb="dk-ink-pen"]')).toHaveAttribute('title', /^Ball pen/);
  await page.locator('.dl-zoom').click();
  await expect(ps).toHaveCount(0);
  // drawn with the Pencil, pressed lightly then hard: one even line
  const p0 = await at(page, 300, 260);
  await pen('mousePressed', p0.x, p0.y, 0.1);
  for (let i = 1; i <= 20; i++) await pen('mouseMoved', p0.x + i * 10, p0.y + Math.sin(i / 3) * 8, 0.1 + 0.8 * i / 20);
  await pen('mouseReleased', p0.x + 200, p0.y, 0.9);
  await expect.poll(strokes, { timeout: 15000 }).toBe(1);
  expect((fileText().match(/<svg class="ol-ink"[\s\S]*?<\/svg>/)![0].match(/<path /g) ?? []).length).toBe(1);
  // kept in this browser
  await page.reload();
  await slides(page).first().waitFor({ timeout: 30000 });
  await page.locator('[data-tb="dk-draw"]').click();
  await expect(page.locator('[data-tb="dk-ink-pen"]')).toHaveAttribute('title', /^Ball pen/);
  // a line, then a scribble across it: both go (one undo brings the line back)
  await mouseLine([[300, 640], [700, 640]]);
  await expect.poll(strokes, { timeout: 15000 }).toBe(2);
  const scribble = (y0: number, y1: number) => Array.from({ length: 13 }, (_, i) => [380 + i * 12, i % 2 ? y0 : y1] as [number, number]);
  await mouseLine(scribble(620, 660));
  await expect.poll(strokes, { timeout: 15000 }).toBe(1);
  await page.keyboard.press('Control+z');
  await expect.poll(strokes, { timeout: 15000 }).toBe(2);
  // a zig-zag struck through it (legs at ±55°, five of them): gone too
  await mouseLine(Array.from({ length: 6 }, (_, i) => [420 + i * 18, i % 2 ? 615 : 665] as [number, number]));
  await expect.poll(strokes, { timeout: 15000 }).toBe(1);
  await page.keyboard.press('Control+z');
  await expect.poll(strokes, { timeout: 15000 }).toBe(2);
  // a scribble over nothing: kept as drawn
  await mouseLine(scribble(530, 590));
  await expect.poll(strokes, { timeout: 15000 }).toBe(3);
  expect(real(errors)).toEqual([]);
});

test('touch: a pinch zooms smoothly about the fingers, two fingers that pan do not zoom, fingers beside the slide move it too, three fingers undo, a Pencil draws and fingers then move the slide, the resting hand does nothing, a swipe turns the page', async ({ browser }) => {
  const ctx = await browser.newContext({ baseURL: BASE_URL, hasTouch: true, viewport: { width: 1280, height: 900 } });
  const page = await ctx.newPage();
  const errors = collectErrors(page);
  await login(page);
  await setup(page);
  const cdp = await ctx.newCDPSession(page);
  const touches = (type: string, pts: { x: number; y: number }[]) => cdp.send('Input.dispatchTouchEvent', { type, touchPoints: pts.map((p, i) => ({ x: p.x, y: p.y, id: i + 1 })) });
  /** the frame's scale and the slide point under a canvas point */
  const view = () => page.evaluate(() => {
    const f = document.querySelector('.dl-frame') as HTMLElement;
    const m = /scale\(([\d.]+)/.exec(f.style.transform);
    return { s: m ? Number(m[1]) : 1, box: f.getBoundingClientRect().toJSON() as { x: number; y: number } };
  });
  const c = await at(page, 640, 360);

  // at Fit, a small pinch holds there — the slide gives a little — and settles back on it once the fingers lift
  const vFit = await view(), fitText = (await page.locator('.dl-zoom').textContent())!;
  await touches('touchStart', [{ x: c.x - 60, y: c.y }, { x: c.x + 60, y: c.y }]);
  for (let i = 1; i <= 6; i++) { await touches('touchMove', [{ x: c.x - 60 - 3 * i, y: c.y }, { x: c.x + 60 + 3 * i, y: c.y }]); await page.waitForTimeout(20); }
  expect((await view()).s).toBeGreaterThan(vFit.s * 1.01);
  await expect(page.locator('[data-dl-zoomhud]')).toHaveText(/^Fit · \d+ %$/);
  await touches('touchEnd', []);
  await expect.poll(async () => Math.abs((await view()).s - vFit.s), { timeout: 3000 }).toBeLessThan(0.002);
  await expect(page.locator('.dl-zoom')).toHaveText(fitText);
  await page.waitForTimeout(500);

  // past Fit (125 %), a pinch: the scale follows the fingers' distance (once they have clearly spread), step by step, never back; what is under their middle stays
  await page.locator('.dl-zoomgroup button[title^="Zoom in"]').click();
  await page.waitForTimeout(500);
  const v0 = await view();
  const under0 = { x: (c.x - v0.box.x) / v0.s, y: (c.y - v0.box.y) / v0.s };
  // (the scales the page hears: it draws its handles for them)
  const canvas = (await page.locator('.dl-frame').elementHandle())!;
  const inFrame = (await canvas.contentFrame())!;
  await inFrame.evaluate(() => {
    const w = window as unknown as { olScales: number[] };
    w.olScales = [];
    addEventListener('message', e => { if (e.data?.ol === 'scale') w.olScales.push(e.data.scale); });
  });
  await touches('touchStart', [{ x: c.x - 60, y: c.y }, { x: c.x + 60, y: c.y }]);
  const seen: number[] = [];
  for (let i = 1; i <= 12; i++) {
    const d = 60 + 90 * i / 12;
    await touches('touchMove', [{ x: c.x - d, y: c.y }, { x: c.x + d, y: c.y }]);
    await page.waitForTimeout(20);
    seen.push((await view()).s);
  }
  // the fingers still down, the page knows the scale it is shown at: its handles keep their size on the screen (they grew with the pinch, then shrank)
  await page.waitForTimeout(50);
  const heard = await inFrame.evaluate(() => (window as unknown as { olScales: number[] }).olScales);
  expect(heard.length).toBeGreaterThan(2);
  expect(Math.abs(heard[heard.length - 1] / seen[seen.length - 1] - 1)).toBeLessThan(0.01);
  await touches('touchEnd', []);
  for (let i = 1; i < seen.length; i++) expect(seen[i]).toBeGreaterThanOrEqual(seen[i - 1] - 1e-6);
  // (×2.5 apart, less the first ~12 % they spread before it zoomed)
  expect(seen[seen.length - 1] / v0.s).toBeGreaterThan(2.1);
  expect(seen[seen.length - 1] / v0.s).toBeLessThan(2.35);
  const v1 = await view();
  expect(Math.abs((c.x - v1.box.x) / v1.s - under0.x)).toBeLessThan(4);
  expect(Math.abs((c.y - v1.box.y) / v1.s - under0.y)).toBeLessThan(4);
  // the zoom is the editor's once the fingers are up
  await expect(page.locator('.dl-zoom')).toHaveText(new RegExp(`^${Math.round(v1.s * 100)}%$`), { timeout: 3000 });
  await page.locator('.dl-zoom').click();
  await expect.poll(async () => Math.abs((await view()).s - vFit.s), { timeout: 3000 }).toBeLessThan(0.002);
  await page.waitForTimeout(700);

  // two fingers that pan, never quite as far apart: the slide follows them, its scale stays (zoomed in: within its range, no rubber band's stretch)
  for (let i = 0; i < 3; i++) await page.locator('.dl-zoomgroup button[title^="Zoom in"]').click();
  await page.waitForTimeout(400);
  const vp = await view();
  await touches('touchStart', [{ x: c.x - 60, y: c.y }, { x: c.x + 60, y: c.y }]);
  let panned = 0;
  for (let i = 1; i <= 10; i++) {
    const h = 60 + (i % 2 ? 6 : -5), mx = c.x - i * 12;
    await touches('touchMove', [{ x: mx - h, y: c.y + i * 3 }, { x: mx + h, y: c.y + i * 3 }]);
    await page.waitForTimeout(16);
    const v = await view();
    expect(Math.abs(v.s - vp.s)).toBeLessThan(1e-4);
    panned = Math.max(panned, vp.box.x - v.box.x);
  }
  await touches('touchEnd', []);
  expect(panned).toBeGreaterThan(60);
  await page.locator('.dl-zoom').click();
  await page.waitForTimeout(700);

  // beside the slide (zoomed out, the canvas all round it): a pinch zooms the slide, a finger pulls it
  for (let i = 0; i < 3; i++) await page.locator('.dl-zoomgroup button[title^="Zoom out"]').click();
  await page.waitForTimeout(400);
  const cb = (await page.locator('.dl-canvas').boundingBox())!, fb = (await view()).box as unknown as { x: number; y: number; width: number; height: number };
  expect(fb.x - cb.x).toBeGreaterThan(120);
  const gx = cb.x + (fb.x - cb.x) / 2, gy = fb.y + fb.height / 2, sOut = (await view()).s;
  await touches('touchStart', [{ x: gx, y: gy - 50 }, { x: gx, y: gy + 50 }]);
  for (let i = 1; i <= 10; i++) { const d = 50 + 70 * i / 10; await touches('touchMove', [{ x: gx, y: gy - d }, { x: gx, y: gy + d }]); await page.waitForTimeout(16); }
  await touches('touchEnd', []);
  expect((await view()).s / sOut).toBeGreaterThan(1.8);
  await page.locator('.dl-zoom').click();
  await page.waitForTimeout(700);
  for (let i = 0; i < 3; i++) await page.locator('.dl-zoomgroup button[title^="Zoom out"]').click();
  await page.waitForTimeout(400);
  const before = (await view()).box.x;
  await touches('touchStart', [{ x: gx, y: gy }]);
  for (let i = 1; i <= 8; i++) { await touches('touchMove', [{ x: gx + i * 10, y: gy }]); await page.waitForTimeout(16); }
  expect((await view()).box.x - before).toBeGreaterThan(30);
  await touches('touchEnd', []);
  await page.locator('.dl-zoom').click();
  await page.waitForTimeout(700);

  // three fingers tap: undo (and it says so)
  const b = await at(page, 150, 450);
  await page.mouse.click(b.x, b.y);
  await page.locator('.dl-toolbar [data-tb="dk-delete"]').click();
  await expect.poll(fileText, { timeout: 15000 }).not.toContain('id="a"');
  const e = await at(page, 640, 250);
  await touches('touchStart', [{ x: e.x - 50, y: e.y }, { x: e.x, y: e.y - 20 }, { x: e.x + 50, y: e.y }]);
  await page.waitForTimeout(80);
  await touches('touchEnd', []);
  await expect(page.locator('[data-dl-hud]')).toHaveText(/Undo/);
  await expect.poll(fileText, { timeout: 15000 }).toContain('id="a"');

  // a Pencil draws, with its pressure; a finger then moves the slide instead of drawing
  await page.locator('[data-tb="dk-draw"]').click();
  const strokes = () => (fileText().match(/<svg class="ol-ink"/g) ?? []).length;
  const p0 = await at(page, 200, 620);
  const pen = (type: string, x: number, y: number, force: number) => cdp.send('Input.dispatchMouseEvent', { type, x, y, button: 'left', buttons: type === 'mouseReleased' ? 0 : 1, clickCount: 1, force, pointerType: 'pen' });
  await pen('mousePressed', p0.x, p0.y, 0.2);
  for (let i = 1; i <= 16; i++) await pen('mouseMoved', p0.x + i * 12, p0.y + Math.sin(i / 3) * 10, 0.2 + 0.7 * Math.sin(i / 16 * Math.PI));
  await pen('mouseReleased', p0.x + 192, p0.y, 0.1);
  await expect.poll(strokes, { timeout: 15000 }).toBe(1);
  const t0 = (await view()).box;
  const f0 = await at(page, 700, 600);
  await touches('touchStart', [f0]);
  for (let i = 1; i <= 8; i++) { await touches('touchMove', [{ x: f0.x, y: f0.y - i * 10 }]); await page.waitForTimeout(16); }
  // (the slide follows the finger; let go, it springs back into place)
  expect(t0.y - (await view()).box.y).toBeGreaterThan(20);
  await touches('touchEnd', []);
  await page.waitForTimeout(600);
  expect(strokes()).toBe(1);

  // the hand resting on the screen as the Pencil writes (two touches): no pinch, no zoom, the stroke drawn whole
  const s0 = (await view()).s;
  const p1 = await at(page, 200, 300);
  await pen('mousePressed', p1.x, p1.y, 0.3);
  for (let i = 1; i <= 8; i++) await pen('mouseMoved', p1.x + i * 12, p1.y, 0.4);
  await touches('touchStart', [{ x: p1.x + 150, y: p1.y + 120 }, { x: p1.x + 210, y: p1.y + 140 }]);
  for (let i = 9; i <= 16; i++) { await pen('mouseMoved', p1.x + i * 12, p1.y, 0.4); await touches('touchMove', [{ x: p1.x + 150 + i * 3, y: p1.y + 120 }, { x: p1.x + 210 - i * 4, y: p1.y + 140 }]); }
  await pen('mouseReleased', p1.x + 192, p1.y, 0.1);
  await touches('touchEnd', []);
  await expect.poll(strokes, { timeout: 15000 }).toBe(2);
  expect(Math.abs((await view()).s - s0)).toBeLessThan(1e-3);
  await page.waitForTimeout(600);
  // the palm landing first (three touches), then the Pencil: the stroke, and no undo
  const p2 = await at(page, 200, 360);
  await touches('touchStart', [{ x: p2.x + 150, y: p2.y + 100 }, { x: p2.x + 190, y: p2.y + 110 }, { x: p2.x + 230, y: p2.y + 130 }]);
  await page.waitForTimeout(60);
  await pen('mousePressed', p2.x, p2.y, 0.3);
  for (let i = 1; i <= 12; i++) await pen('mouseMoved', p2.x + i * 12, p2.y, 0.4);
  await pen('mouseReleased', p2.x + 144, p2.y, 0.1);
  await page.waitForTimeout(50);
  await touches('touchEnd', []);
  await expect.poll(strokes, { timeout: 15000 }).toBe(3);
  await page.waitForTimeout(800);
  expect(strokes()).toBe(3);
  await expect(page.locator('[data-dl-hud]')).toHaveCount(0);

  // a finger swiped sideways: the next slide
  const shown = () => editFrame(page).evaluate(() => Array.from(document.querySelectorAll('section.slide')).map(s => ((s as HTMLElement).offsetHeight > 0 ? 1 : 0)).join(''));
  expect(await shown()).toBe('10');
  const f1 = await at(page, 900, 300);
  await touches('touchStart', [f1]);
  for (let i = 1; i <= 6; i++) await touches('touchMove', [{ x: f1.x - i * 25, y: f1.y + i }]);
  await touches('touchEnd', []);
  await expect.poll(shown).toBe('01');
  expect(real(errors)).toEqual([]);
  await ctx.close();
});

test('the canvas: a checkerboard from its menu, Back to the slide when zoomed in', async ({ page }) => {
  const errors = collectErrors(page);
  await login(page);
  await setup(page);
  // the canvas around the frame takes the page's own colour
  await expect.poll(() => page.locator('.dl-canvas').evaluate(e => getComputedStyle(e).backgroundColor)).toBe('rgb(223, 227, 234)');
  // right-click beside the slide (zoomed out a little: fitted, it fills the canvas): the canvas menu
  await page.locator('.dl-zoomgroup button[title^="Zoom out"]').click();
  await page.waitForTimeout(400);
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

test('the zoom is said over the canvas while it changes: a pinch (Ctrl + wheel) as it goes, Fit, − / +; a pinch stops at Fit and holds there', async ({ page }) => {
  const errors = collectErrors(page);
  await login(page);
  await setup(page);
  const hud = page.locator('[data-dl-zoomhud]');
  await expect(hud).not.toHaveClass(/\bon\b/);
  // a trackpad pinch over the slide: the zoom as it goes (the toolbar's figure waits till it rests)
  const c = await at(page, 640, 360);
  await page.mouse.move(c.x, c.y);
  await page.keyboard.down('Control');
  const seen: string[] = [];
  for (let i = 0; i < 6; i++) { await page.mouse.wheel(0, -20); await page.waitForTimeout(50); seen.push((await hud.textContent()) ?? ''); }
  await page.keyboard.up('Control');
  await expect(hud).toHaveClass(/\bon\b/);
  expect(new Set(seen.filter(Boolean)).size).toBeGreaterThan(2);
  expect(seen[seen.length - 1]).toMatch(/^\d+ %$/);
  // at rest it fades, the toolbar saying the same
  await expect(hud).not.toHaveClass(/\bon\b/, { timeout: 3000 });
  await expect(page.locator('.dl-zoomgroup .dl-zoom')).toHaveText((await hud.textContent())!.replace(' %', '%'));
  // Fit (the figure's button): said as Fit
  await page.locator('.dl-zoomgroup .dl-zoom').click();
  await expect(hud).toHaveText(/^Fit · \d+ %$/);
  await expect(hud).toHaveClass(/\bfit\b/);
  const fitText = (await page.locator('.dl-zoomgroup .dl-zoom').textContent())!;
  // − : a percentage again
  await page.locator('.dl-zoomgroup button[title^="Zoom out"]').click();
  await expect(hud).toHaveText(/^\d+ %$/);
  await expect(hud).toHaveClass(/\bon\b/);
  // + : a step stops at Fit on its way
  await page.locator('.dl-zoomgroup button[title^="Zoom in"]').click();
  await expect(page.locator('.dl-zoomgroup .dl-zoom')).toHaveText(fitText);
  await page.locator('.dl-zoomgroup button[title^="Zoom out"]').click();
  await expect(page.locator('.dl-zoomgroup .dl-zoom')).not.toHaveText(fitText);
  // a pinch in, on past Fit: it stops there and holds (said as Fit, the slide giving a little), and settles on it once let go
  await page.mouse.move(c.x, c.y);
  await page.keyboard.down('Control');
  for (let i = 0; i < 8; i++) { await page.mouse.wheel(0, -5); await page.waitForTimeout(30); }
  await expect(hud).toHaveText(/^Fit · \d+ %$/);
  await page.keyboard.up('Control');
  await expect(page.locator('.dl-zoomgroup .dl-zoom')).toHaveText(fitText, { timeout: 3000 });
  // pinched well past it, it lets go
  await page.waitForTimeout(400);
  await page.keyboard.down('Control');
  for (let i = 0; i < 12; i++) { await page.mouse.wheel(0, -5); await page.waitForTimeout(30); }
  await page.keyboard.up('Control');
  await expect(hud).toHaveText(/^\d+ %$/);
  await expect(page.locator('.dl-zoomgroup .dl-zoom')).not.toHaveText(fitText, { timeout: 3000 });
  expect(real(errors)).toEqual([]);
});

test('one slide per canvas: fitted edge to edge; the rail, Page Down and a swipe sideways move between them, a scroll springs back or pulled further sets the slide loose, the rail widens, the selection is named', async ({ page }) => {
  const errors = collectErrors(page);
  await login(page);
  await setup(page);
  const shownSlides = () => editFrame(page).evaluate(() => Array.from(document.querySelectorAll('section.slide')).map(s => ((s as HTMLElement).offsetHeight > 0 ? 1 : 0)).join(''));
  const transform = () => page.locator('.dl-frame').evaluate(e => (e as HTMLElement).style.transform);
  // only the first slide is on the canvas, the whole of it, in the middle — edge to edge with the canvas, no room around it
  await expect.poll(shownSlides).toBe('10');
  const c = (await page.locator('.dl-canvas').boundingBox())!;
  const s1 = (await slides(page).first().boundingBox())!;
  expect(s1.y).toBeGreaterThanOrEqual(c.y - 0.5);
  expect(s1.y + s1.height).toBeLessThanOrEqual(c.y + c.height + 0.5);
  expect(Math.abs((s1.x + s1.width / 2) - (c.x + c.width / 2))).toBeLessThan(3);
  expect(Math.min(Math.abs(s1.x - c.x), Math.abs(s1.y - c.y))).toBeLessThan(1.5);
  // a short scroll pulls the slide, and it springs back into the middle
  const rest = await transform();
  const refocus = page.locator('[data-dl-refocus]');
  await page.mouse.move(s1.x + s1.width / 2, s1.y + s1.height / 2);
  for (let i = 0; i < 3; i++) await page.mouse.wheel(0, 30);
  expect(await transform()).not.toBe(rest);
  await expect.poll(transform, { timeout: 3000 }).toBe(rest);
  await expect(refocus).toHaveCount(0);
  // a little further: it comes loose and stays where it is let go
  for (let i = 0; i < 8; i++) await page.mouse.wheel(0, 30);
  await expect(refocus).toHaveText(/Centre slide/);
  await page.waitForTimeout(900);
  const loose = await transform();
  expect(loose).not.toBe(rest);
  await page.waitForTimeout(300);
  expect(await transform()).toBe(loose);
  // scrolled back near its place: let go, it snaps back in
  const off = async () => {
    const [a, b] = [rest, await transform()].map(t => /translate\(([-\d.]+)px, ([-\d.]+)px/.exec(t)!.slice(1).map(Number));
    return { x: b[0] - a[0], y: b[1] - a[1] };
  };
  for (let i = 0; i < 40; i++) {
    const o = await off();
    if (Math.hypot(o.x, o.y) < 20) break;
    await page.mouse.wheel(Math.round(o.x * 0.15), Math.round(o.y * 0.15) || Math.sign(o.y));
  }
  expect(await transform()).not.toBe(rest);
  await expect.poll(transform, { timeout: 3000 }).toBe(rest);
  await expect(refocus).toHaveCount(0);
  // loose again: Centre slide brings it back
  for (let i = 0; i < 8; i++) await page.mouse.wheel(0, -30);
  await refocus.click();
  await expect.poll(transform, { timeout: 3000 }).toBe(rest);
  await expect(refocus).toHaveCount(0);
  await expect.poll(shownSlides).toBe('10');
  // the four-way arrows over an object; selected, it is named at its corner and in the toolbar
  const a = await at(page, 150, 450);
  await page.mouse.move(a.x, a.y);
  await expect.poll(() => editFrame(page).evaluate(() => document.documentElement.classList.contains('ol-over-obj'))).toBe(true);
  await page.mouse.click(a.x, a.y);
  await expect(page.locator('.dl-ctx .tb-label').first()).toHaveText(/shape/i);
  // Ctrl+A with the keyboard in the editor (after a toolbar click): the slide's objects, not the page's text
  await page.locator('[data-tb="dk-select"]').click();
  await page.keyboard.press('Control+a');
  await expect.poll(() => page.$$eval('.dl-ctx .tb-label', els => els.map(e => e.textContent ?? ''))).toEqual(expect.arrayContaining([expect.stringMatching(/shape/i), expect.stringMatching(/arrange/i)]));
  expect(await page.evaluate(() => String(getSelection()))).toBe('');
  // the title selected and typed over with the keyboard in the editor: retyped, the letters are not the tools' (L drew a line)
  await page.keyboard.press('Escape');
  const h = await at(page, 150, 130);
  await page.mouse.click(h.x, h.y);
  await page.locator('[data-tb="dk-select"]').click();
  await page.keyboard.type('Lola', { delay: 90 });   // (at a person's pace: at machine speed the first letter can overtake the next)
  await page.keyboard.press('Escape');
  await expect.poll(fileText, { timeout: 15000 }).toContain('>Lola</h1>');
  expect(fileText()).not.toMatch(/<svg[^>]*><line/);
  // Page Down: the next slide; the rail: back to the first
  await page.keyboard.press('PageDown');
  await expect.poll(shownSlides).toBe('01');
  await gotoSlide(page, 0);
  await expect.poll(shownSlides).toBe('10');
  // a swipe sideways (a trackpad's two fingers): the next slide, and back; up and down it pans as before
  await page.mouse.move(c.x + c.width / 2, c.y + c.height / 2);
  for (let i = 0; i < 4; i++) await page.mouse.wheel(40, 0);
  await expect.poll(shownSlides).toBe('01');
  await page.waitForTimeout(500);
  for (let i = 0; i < 4; i++) await page.mouse.wheel(-40, 0);
  await expect.poll(shownSlides).toBe('10');
  await page.waitForTimeout(500);
  // the rail's right edge dragged: wider thumbnails, kept for the next visit
  const g = (await page.locator('[data-dl-railgrip]').boundingBox())!;
  await page.mouse.move(g.x + 3, g.y + 200);
  await page.mouse.down();
  await page.mouse.move(g.x + 103, g.y + 200, { steps: 5 });
  await page.mouse.up();
  await expect.poll(() => page.locator('.dl-rail').evaluate(e => (e as HTMLElement).getBoundingClientRect().width)).toBeGreaterThan(260);
  expect(await page.evaluate(() => localStorage.getItem('ol.deckRail'))).toMatch(/^2\d\d$/);
  await page.locator('[data-dl-railgrip]').dblclick();
  await expect.poll(() => page.evaluate(() => localStorage.getItem('ol.deckRail'))).toBeNull();
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

test('a finger swiped over an object turns the page, as in Keynote on an iPad: a tap selects it, held still a moment it is picked up', async ({ browser }) => {
  const ctx = await browser.newContext({ baseURL: BASE_URL, hasTouch: true, viewport: { width: 1280, height: 900 } });
  const page = await ctx.newPage();
  const errors = collectErrors(page);
  await login(page);
  await setup(page);
  const cdp = await ctx.newCDPSession(page);
  const touch = async (type: string, x: number, y: number) => cdp.send('Input.dispatchTouchEvent', { type, touchPoints: type === 'touchEnd' ? [] : [{ x, y, id: 1 }] });
  const swipe = async (p: { x: number; y: number }, dx: number) => {
    await touch('touchStart', p.x, p.y);
    for (let i = 1; i <= 8; i++) { await touch('touchMove', p.x + dx * i / 8, p.y + i); await page.waitForTimeout(16); }
    await touch('touchEnd', 0, 0);
  };
  const shown = () => editFrame(page).evaluate(() => Array.from(document.querySelectorAll('section.slide')).map(s => ((s as HTMLElement).offsetHeight > 0 ? 1 : 0)).join(''));
  const h1 = () => /<h1 style="([^"]*)"/.exec(fileText())?.[1] ?? '';
  const quick = page.locator('[data-dl-quick]');
  const title = h1();
  expect(await shown()).toBe('10');
  // swiped left over the title, which is not selected: the next slide, the title where it was, nothing selected
  await swipe(await at(page, 400, 135), -260);
  await expect.poll(shown).toBe('01');
  await expect(quick).toHaveCount(0);
  // swiped right over the next slide's heading: back
  await swipe(await at(page, 140, 100, 1), 260);
  await expect.poll(shown).toBe('10');
  await page.waitForTimeout(600);
  expect(h1()).toBe(title);
  // a tap on it selects it
  const p = await at(page, 300, 135);
  await touch('touchStart', p.x, p.y); await touch('touchEnd', p.x, p.y);
  await expect(quick).toBeVisible();
  // a square not selected, touched and held still a moment, then dragged: it moves, the slide stays
  const a = await at(page, 150, 450), b = await at(page, 150 + 100, 450 + 50);
  await touch('touchStart', a.x, a.y);
  await page.waitForTimeout(600);
  for (let i = 1; i <= 10; i++) { await touch('touchMove', a.x + (b.x - a.x) * i / 10, a.y + (b.y - a.y) * i / 10); await page.waitForTimeout(16); }
  await touch('touchEnd', b.x, b.y);
  await expect.poll(() => /id="a" style="([^"]*)"/.exec(fileText())?.[1] ?? '', { timeout: 15000 }).toMatch(/left: 19\d|left: 20\d/);
  expect(await shown()).toBe('10');
  expect(real(errors)).toEqual([]);
  await ctx.close();
});

const MATHDECK = DECK.replace('<section class="slide">\n  <h2', `<section class="slide">
  <div id="f" style="position: absolute; left: 100px; top: 250px; width: 500px; font-size: 40px; text-align: center">\\[ x^{2} \\]</div>
  <p id="t" style="position: absolute; left: 100px; top: 500px; width: 900px; margin: 0; font-size: 32px">Energy</p>
  <h2`);

/** every frame from now on: the TeX of a formula visible on the slide (it never should be: hidden until typeset) */
async function watchRawTex(page: Page): Promise<void> {
  await editFrame(page).evaluate(`(() => {
    window.__rawTex = [];
    const tick = () => {
      const w = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
      for (let n = w.nextNode(); n; n = w.nextNode()) {
        const el = n.parentElement;
        if (!/\\\\\\(|\\\\\\[|\\$\\$/.test(n.nodeValue || '') || !el || el.closest('script, style, aside') || el.closest('[contenteditable=true]:not(.ol-mathchip)')) continue;
        const s = getComputedStyle(el);
        if (s.visibility !== 'hidden' && s.display !== 'none' && !el.closest('[data-ol-texwait]') && el.getBoundingClientRect().width) window.__rawTex.push(n.nodeValue.trim().slice(0, 40));
      }
      requestAnimationFrame(tick);
    };
    tick();
  })()`);
}
const rawTexSeen = (page: Page) => editFrame(page).evaluate('window.__rawTex') as Promise<string[]>;

/** LyX's formula editor lies exactly over the slide's formula: the same size, on its baseline (frame px) */
async function expectOverFormula(page: Page): Promise<void> {
  await expect(page.locator('[data-dl-mathedit]:not(.pending) .lm-content mjx-container')).toBeVisible();
  const fr = editFrame(page);
  const chip = JSON.parse(await fr.evaluate(`(() => {
    const c = document.querySelector('.ol-mathchip[data-ol-mathediting]');
    const svgs = Array.from(c.querySelectorAll('mjx-container > svg')), rs = svgs.map(s => s.getBoundingClientRect());
    const vb = svgs[0].viewBox.baseVal;
    return JSON.stringify({ left: Math.min(...rs.map(r => r.left)), right: Math.max(...rs.map(r => r.right)), base: rs[0].top - vb.y / vb.height * rs[0].height, w: innerWidth });
  })()`) as string) as { left: number; right: number; base: number; w: number };
  const fb = (await page.locator('.dl-frame').boundingBox())!;
  const k = fb.width / chip.w;
  const ov = await page.evaluate(() => {
    const o = document.querySelector('[data-dl-mathedit]')!;
    const m = o.querySelector('.lm-content mjx-container')!.getBoundingClientRect(), b = o.querySelector('.dl-mathedit-base')!.getBoundingClientRect();
    return { left: m.left, right: m.right, base: b.top };
  });
  expect(Math.abs((ov.left - fb.x) / k - chip.left)).toBeLessThan(2.5);
  expect(Math.abs((ov.right - fb.x) / k - chip.right)).toBeLessThan(2.5);
  expect(Math.abs((ov.base - fb.y) / k - chip.base)).toBeLessThan(1);
}

test("formulas on a slide are edited with LyX's formula editor", async ({ page }) => {
  const errors = collectErrors(page);
  await login(page);
  await setup(page, MATHDECK);
  await page.locator('[data-tb="dk-select"]').click();
  // (the second slide)
  await gotoSlide(page, 1);
  await page.waitForTimeout(400);
  await watchRawTex(page);
  // a double-click on a formula: LyX's math field over it — the same font, size and baseline as the
  // slide's (WYSIWYG: nothing moves or changes size), the math row in the toolbar
  const f = await at(page, 338, 285, 1);
  await page.mouse.dblclick(f.x, f.y);
  await expect(page.locator('[data-dl-mathedit] .lm-field')).toBeVisible();
  await expectOverFormula(page);
  await expect(page.locator('[data-tb="m-frac"]')).toBeVisible();
  // (where the cursor is depends on the point: at the end, End would leave the formula, as in LyX)
  await page.keyboard.type('y');
  await page.keyboard.press('Escape');
  await expect(page.locator('[data-dl-mathedit]')).toHaveCount(0);
  await page.keyboard.press('Escape');
  await expect.poll(fileText, { timeout: 15000 }).toMatch(/>\\\[ [^<]*y[^<]* \\\]<\/div>/);

  // Ctrl+M while typing a text: an inline formula, the arrow keys out of it and back into it
  const t = await at(page, 160, 520, 1);
  await page.mouse.dblclick(t.x, t.y);
  await page.keyboard.press('End');
  await page.keyboard.type(' ');
  await page.keyboard.press('Control+m');
  await expect(page.locator('[data-dl-mathedit] .lm-field')).toBeVisible();
  await page.keyboard.type('E=mc^2');
  await page.keyboard.press('ArrowRight');
  await page.keyboard.press('ArrowRight');
  await expect(page.locator('[data-dl-mathedit]')).toHaveCount(0);
  await page.keyboard.type(' holds');
  await page.keyboard.press('Escape');
  await expect.poll(fileText, { timeout: 15000 }).toContain('Energy \\(E=mc^{2}\\) holds</p>');

  // $ typed opens a formula, as in documents (typed fast: the keys before the field has the keyboard
  // are the formula's), the closing $ leaves it; an inline formula's editor lies over it too
  await page.mouse.dblclick(t.x, t.y);
  await page.keyboard.press('End');
  await page.keyboard.type(' $x^2$ ok');
  await page.keyboard.press('Escape');
  await expect.poll(fileText, { timeout: 15000 }).toContain('holds \\(x^{2}\\) ok</p>');
  const xf = await at(page, 160, 520, 1);
  await page.mouse.dblclick(xf.x + 20, xf.y);
  await page.keyboard.press('End');
  await page.keyboard.press('Control+ArrowLeft');
  await page.keyboard.press('ArrowLeft');
  await page.keyboard.press('ArrowLeft');
  await expect(page.locator('[data-dl-mathedit] .lm-field')).toBeVisible();
  await expectOverFormula(page);
  await page.keyboard.press('Escape');
  await page.keyboard.press('Escape');
  // Backspace in the empty formula $ opened gives the dollar back
  await page.mouse.dblclick(t.x, t.y);
  await page.keyboard.press('End');
  await page.keyboard.type(' $');
  await expect(page.locator('[data-dl-mathedit]:not(.pending)')).toBeVisible();
  await page.keyboard.press('Backspace');
  await expect(page.locator('[data-dl-mathedit]')).toHaveCount(0);
  await page.keyboard.type('5');
  await page.keyboard.press('Escape');
  await expect.poll(fileText, { timeout: 15000 }).toContain('ok $5</p>');

  // the formula tool: a new formula, typed at once; left empty, it goes again
  await page.locator('[data-tb="dk-formula"]').click();
  const n = await at(page, 900, 300, 1);
  await page.mouse.click(n.x, n.y);
  await expect(page.locator('[data-dl-mathedit] .lm-field')).toBeVisible();
  await page.keyboard.type('a^2');
  await page.keyboard.press('Escape');
  await page.keyboard.press('Escape');
  await expect.poll(fileText, { timeout: 15000 }).toContain('\\[ a^{2} \\]');
  const before = (fileText().match(/<div/g) ?? []).length;
  await page.locator('[data-tb="dk-formula"]').click();
  const e = await at(page, 900, 150, 1);
  await page.mouse.click(e.x, e.y);
  await expect(page.locator('[data-dl-mathedit] .lm-field')).toBeVisible();
  await page.keyboard.press('Escape');
  await expect.poll(() => (fileText().match(/<div/g) ?? []).length, { timeout: 15000 }).toBe(before);
  expect(fileText()).not.toContain('\\[ \\]');
  // and never a formula's TeX on the slide meanwhile
  expect(await rawTexSeen(page)).toEqual([]);
  expect(real(errors)).toEqual([]);
});

const LATEXDECK = DECK.replace('<title>Tools</title>', '<title>Tools</title>\n<link rel="overlyx-macros" href="../macros.tex">').replace('<section class="slide">\n  <h2', `<section class="slide">
  <div id="f" style="position: absolute; left: 100px; top: 250px; width: 500px; font-size: 40px; text-align: center">\\[ a+b \\]</div>
  <p id="t" style="position: absolute; left: 100px; top: 500px; width: 900px; margin: 0; font-size: 32px">Known</p>
  <p id="m" style="position: absolute; left: 700px; top: 250px; width: 400px; margin: 0; font-size: 32px">In \\(\\R^n\\)</p>
  <ul id="l" style="position: absolute; left: 700px; top: 380px; width: 400px; margin: 0; font-size: 28px"><li>One</li><li>Two</li></ul>
  <h2`);

test("LaTeX on slides: a citation from the project's .bib, a numbered equation with a label and \\eqref, references, steps, macros", async ({ page }) => {
  const errors = collectErrors(page);
  mkdirSync(`${PROJECTS_DIR}/${PROJECT}`, { recursive: true });
  writeFileSync(`${PROJECTS_DIR}/${PROJECT}/refs.bib`, '@book{knuth84, author = {Knuth, Donald E.}, title = {The TeXbook}, publisher = {Addison-Wesley}, year = 1984}\n');
  writeFileSync(`${PROJECTS_DIR}/${PROJECT}/macros.tex`, '\\newcommand{\\R}{\\mathbb{R}}\n');
  await login(page);
  await setup(page, LATEXDECK);
  await page.locator('[data-tb="dk-select"]').click();
  await gotoSlide(page, 1);
  await page.waitForTimeout(400);
  const fr = editFrame(page);
  // the macros of the linked .tex file: \R typesets (no error)
  await expect.poll(() => fr.evaluate(`document.querySelectorAll('#m mjx-container').length`)).toBe(1);
  expect(await fr.evaluate(`document.querySelectorAll('#m [data-mjx-error], #m mjx-merror').length`)).toBe(0);

  // Cite while typing: the project's bibliography searched, the citation put in as \citep and shown as [1]
  const t = await at(page, 160, 520, 1);
  await page.mouse.dblclick(t.x, t.y);
  await page.keyboard.press('End');
  await page.keyboard.type(' ');
  await page.locator('[data-tb="dk-cite"]').click();
  await page.locator('.dialog input[placeholder^="author"]').fill('knuth');
  await page.locator('.dialog .list div', { hasText: 'knuth84' }).click();
  await page.locator('[data-cite-insert]').click();
  await page.keyboard.press('Escape');
  await expect.poll(fileText, { timeout: 15000 }).toContain('Known \\citep{knuth84}</p>');
  await expect.poll(() => fr.evaluate(`document.querySelector('#t ol-cite')?.textContent`)).toBe('[1]');

  // the formula numbered and labelled in its toolbar: an equation environment, (1) on the slide
  const f = await at(page, 338, 285, 1);
  await page.mouse.dblclick(f.x, f.y);
  await expect(page.locator('[data-dl-mathedit]:not(.pending)')).toBeVisible();
  await page.locator('[data-tb="m-label"]').click();
  await fillDialog(page, 'eq:sum');
  await expect.poll(() => fr.evaluate(`document.querySelector('#f')?.textContent ?? ''`)).not.toContain('\\label');
  await page.keyboard.press('Escape');
  await expect(page.locator('[data-dl-mathedit]')).toHaveCount(0);
  await page.keyboard.press('Escape');
  await expect.poll(fileText, { timeout: 15000 }).toMatch(/\\begin\{equation\}\s*a\+b\s*\\label\{eq:sum\}\s*\\end\{equation\}/);

  // Ref while typing: the page's labels; \eqref{eq:sum} shows (1)
  await page.mouse.dblclick(t.x, t.y);
  await page.keyboard.press('End');
  await page.locator('[data-tb="dk-ref"]').click();
  await page.locator('.dk-ref-item', { hasText: 'eq:sum' }).click();
  await page.keyboard.press('Escape');
  await expect.poll(fileText, { timeout: 15000 }).toMatch(/\\citep\{knuth84\}(?: |&nbsp;)*\\eqref\{eq:sum\}/);

  // the References tool: the works cited, listed
  await page.locator('[data-tb="dk-references"]').click();
  const r = await at(page, 640, 120, 1);
  await page.mouse.click(r.x, r.y);
  await expect.poll(fileText, { timeout: 15000 }).toContain('class="ol-bibliography"');
  await expect.poll(() => fr.evaluate(`document.querySelector('.ol-bibliography')?.textContent ?? ''`)).toContain('The TeXbook');

  // steps (the Animation pane, e2e/deck-animate.spec.ts): the list's items one by one, an object
  // appearing after them, then moved up to come with the second item
  const l = await at(page, 760, 400, 1);
  await page.mouse.click(l.x, l.y);
  await page.locator('[data-tb="dk-step"]').click();
  await page.locator('[data-anim-list]').click();
  await expect.poll(fileText, { timeout: 15000 }).toMatch(/<ul id="l"[^>]* data-steps="1"/);
  const m = await at(page, 720, 270, 1);
  // (the quick menu above the list is where m is: a click on the slide's empty corner first)
  const empty = await at(page, 1240, 700, 1);
  await page.mouse.click(empty.x, empty.y);
  await expect(page.locator('[data-dl-quick]')).toHaveCount(0);
  await page.mouse.click(m.x, m.y);
  await page.locator('[data-anim-add="appear"]').click();
  await expect.poll(fileText, { timeout: 15000 }).toMatch(/<p id="m"[^>]* data-step="3"/);
  await page.locator('[data-anim-row]', { hasText: 'In' }).locator('[data-anim-up]').click();
  await expect.poll(fileText, { timeout: 15000 }).toMatch(/<p id="m"[^>]* data-step="2"/);

  // presenting: the slide's steps (the list item by item, the paragraph at step 2) before the slides go on; back through them
  const present = await page.context().newPage();
  await present.setViewportSize({ width: 1280, height: 720 });
  await present.goto(editFrame(page).url().replace(/ol=edit/, 'ol=present').replace(/#.*$/, '') + '#1');
  const shown = () => present.evaluate(`['#l li:nth-child(1)', '#l li:nth-child(2)', '#m'].map(s => getComputedStyle(document.querySelector(s)).visibility === 'visible' ? 1 : 0).join('')`);
  await expect.poll(() => present.evaluate('location.hash')).toBe('#1');
  await present.keyboard.press('ArrowRight');
  await expect.poll(() => present.evaluate('location.hash')).toBe('#2');
  await expect.poll(shown).toBe('100');
  await present.keyboard.press('ArrowRight');
  await expect.poll(shown).toBe('111');
  await present.keyboard.press('ArrowLeft');
  await expect.poll(shown).toBe('100');
  await present.keyboard.press('ArrowLeft');
  await expect.poll(() => present.evaluate('location.hash')).toBe('#1');
  await present.close();
  expect(real(errors)).toEqual([]);
});

const PATHDECK = DECK.replace('<div id="b" style="position: absolute; left: 300px; top: 400px;', '<div id="b" style="position: absolute; left: 150px; top: 450px;');

test('Inkscape: union, editing the points of a path, the Bézier pen', async ({ page }) => {
  const errors = collectErrors(page);
  await login(page);
  await setup(page, PATHDECK);
  await page.locator('[data-tb="dk-select"]').click();

  // two overlapping squares: Path ▸ Union — one path where the bottom one was, in its colour
  const a = await at(page, 120, 420), b = await at(page, 230, 530);
  await page.mouse.click(a.x, a.y);
  await page.keyboard.down('Shift');
  await page.mouse.click(b.x, b.y);
  await page.keyboard.up('Shift');
  await page.locator('[data-tb="dk-path"]').click();
  await page.locator('[data-palette="dk-path"] .tb-pal-item', { hasText: 'Union' }).click();
  await expect.poll(fileText, { timeout: 15000 }).not.toContain('id="b"');
  expect(fileText()).not.toContain('id="a"');
  expect(fileText()).toMatch(/<svg style="position: absolute; left: 100px; top: 400px; width: 151px; height: 151px; overflow: visible" viewBox="0 0 151 151"><path d="M[^"]+Z" fill="rgb\(255, 0, 0\)" fill-rule="evenodd"\/><\/svg>/);
  // its eight corners, straight edges
  const d = /viewBox="0 0 151 151"><path d="([^"]+)"/.exec(fileText())![1];
  expect(d).not.toContain('C');
  for (const pt of ['0 0', '100 0', '100 50', '150 50', '150 150', '50 150', '50 100', '0 100']) expect(d).toMatch(new RegExp(`[ML]${pt}(?=[LZ])`));

  // double-click: its nodes; the top left one dragged up and left, then Esc — the drawing's box follows
  const u = await at(page, 130, 430);
  await page.mouse.dblclick(u.x, u.y);
  await expect(page.locator('[data-tb="dk-node-done"]')).toBeVisible();
  const n0 = await at(page, 100, 400), n1 = await at(page, 60, 360);
  await page.mouse.move(n0.x, n0.y); await page.mouse.down(); await page.mouse.move(n1.x, n1.y, { steps: 6 }); await page.mouse.up();
  await expect.poll(fileText, { timeout: 15000 }).toMatch(/[ML]-40 -40[LZ]/);
  await page.keyboard.press('Escape');
  await expect(page.locator('[data-tb="dk-node-done"]')).toHaveCount(0);
  await expect.poll(fileText, { timeout: 15000 }).toMatch(/left: 59\.5px; top: 359\.5px; width: 191px; height: 191px; overflow: visible" viewBox="-40\.5 -40\.5 191 191"/);

  // a right-click on the drawing: named "SVG" (at its corner, in the toolbar), its menu edits its points
  await page.mouse.click(u.x, u.y, { button: 'right' });
  await expect(page.locator('.dl-ctx .tb-label').first()).toHaveText(/svg/i);
  await page.locator('.ctx-menu .ctx-item', { hasText: 'Edit points' }).click();
  await expect(page.locator('[data-tb="dk-node-done"]')).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(page.locator('[data-tb="dk-node-done"]')).toHaveCount(0);

  // the Bézier pen (B): two clicks and a drag, Enter — an open path with a curve in it
  await page.locator('[data-tb="dk-lines"]').click();
  await page.locator('[data-palette="dk-lines"] .tb-pal-item[title^="Path"]').click();
  const p0 = await at(page, 600, 300), p1 = await at(page, 800, 200), p2 = await at(page, 900, 350);
  await page.mouse.click(p0.x, p0.y);
  await page.mouse.move(p1.x, p1.y); await page.mouse.down(); await page.mouse.move(p1.x + 60, p1.y, { steps: 5 }); await page.mouse.up();
  await page.mouse.click(p2.x, p2.y);
  await page.keyboard.press('Enter');
  await expect.poll(fileText, { timeout: 15000 }).toMatch(/<path d="M0 [\d.]+C[^"]*" fill="none" stroke="#1d2433"/);
  expect(real(errors)).toEqual([]);
});
