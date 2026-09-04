/**
 * Whiteboard documents (.board): creating one from the file browser, drawing, sticky notes,
 * moving/resizing, the JSON file written by the server, and live sync between two clients.
 * Needs the seeded admin.
 */
import { test, expect, type Page } from '@playwright/test';
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { login, texDoc, collectErrors, PROJECTS_DIR } from './helpers';

const PROJECT = 'e2e-board';
const DIR = `${PROJECTS_DIR}/${PROJECT}`;
const BOARD = `${DIR}/plan.board`;
const LASSO_BOARD = `${DIR}/lasso.board`;
const LASER_BOARD = `${DIR}/laser.board`;

test.describe.configure({ mode: 'serial' });

test.beforeAll(() => {
  rmSync(DIR, { recursive: true, force: true });
  mkdirSync(DIR, { recursive: true });
  writeFileSync(`${DIR}/main.tex`, texDoc('A project with a whiteboard.'));
  writeFileSync(BOARD, '{"overlyx":"board","v":1,"objects":{\n}}\n');
  writeFileSync(LASSO_BOARD, '{"overlyx":"board","v":1,"objects":{\n}}\n');
  writeFileSync(LASER_BOARD, '{"overlyx":"board","v":1,"objects":{\n}}\n');
});
test.afterAll(() => { rmSync(DIR, { recursive: true, force: true }); });

async function openBoard(page: Page, file = 'plan.board'): Promise<void> {
  await page.goto(`/#/${PROJECT}/${file}`);
  await page.waitForSelector('.board-tools', { timeout: 30000 });
  await expect(page.locator('.board-conn')).toContainText(/live|view/, { timeout: 20000 });
}

test('drawing and sticky notes land in the board file and survive a reload', async ({ page }) => {
  const errors = collectErrors(page);
  await login(page);
  await openBoard(page);

  // pen: a squiggle
  await page.click('[data-tool="pen"]');
  const vp = (await page.locator('.board').boundingBox())!;
  const cx = vp.x + vp.width / 2, cy = vp.y + vp.height / 2;
  await page.mouse.move(cx, cy);
  await page.mouse.down();
  for (let i = 1; i <= 8; i++) await page.mouse.move(cx + i * 10, cy + (i % 2 ? 8 : -8), { steps: 2 });
  await page.mouse.up();
  await expect(page.locator('.board-stroke:not(.live)')).toHaveCount(1);

  // sticky note with text
  await page.click('[data-tool="note"]');
  await page.mouse.click(cx - 150, cy - 100);
  await page.locator('.board-note-edit').fill('Sketch the intro figure');
  await page.locator('.board-note-edit').blur();
  await expect(page.locator('.board-note')).toContainText('Sketch the intro figure');

  // the server writes the JSON file on its save debounce
  await expect.poll(() => readFileSync(BOARD, 'utf8'), { timeout: 15000 }).toContain('Sketch the intro figure');
  const json = JSON.parse(readFileSync(BOARD, 'utf8'));
  const objs = Object.values(json.objects) as { t: string }[];
  expect(objs.some(o => o.t === 'stroke')).toBe(true);
  expect(objs.some(o => o.t === 'note')).toBe(true);

  // move the note and resize it via the corner handle
  await page.click('[data-tool="select"]');
  const note = page.locator('.board-note');
  const nb = (await note.boundingBox())!;
  await page.mouse.move(nb.x + nb.width / 2, nb.y + 10);
  await page.mouse.down();
  await page.mouse.move(nb.x + nb.width / 2 + 80, nb.y + 90, { steps: 5 });
  await page.mouse.up();
  const handle = page.locator('.board-handle.se');
  await expect(handle).toBeVisible();
  const hb = (await handle.boundingBox())!;
  await page.mouse.move(hb.x + hb.width / 2, hb.y + hb.height / 2);
  await page.mouse.down();
  await page.mouse.move(hb.x + 70, hb.y + 40, { steps: 5 });
  await page.mouse.up();
  const grown = (await note.boundingBox())!;
  expect(grown.width).toBeGreaterThan(nb.width + 30);

  // reload: everything is back
  await page.reload();
  await page.waitForSelector('.board-tools');
  await expect(page.locator('.board-stroke:not(.live)')).toHaveCount(1);
  await expect(page.locator('.board-note')).toContainText('Sketch the intro figure');
  expect(errors.filter(e => !/favicon|ResizeObserver/.test(e))).toEqual([]);
});

test('the lasso selects several things at once: group move and group delete', async ({ page }) => {
  await login(page);
  await openBoard(page, 'lasso.board');   // a fresh board: no zoom-to-fit surprises from earlier tests
  const vp = (await page.locator('.board').boundingBox())!;
  const cx = vp.x + vp.width / 2, cy = vp.y + vp.height / 2;

  // two quick strokes near each other
  await page.click('[data-tool="pen"]');
  for (const dy of [-140, -110]) {
    await page.mouse.move(cx - 40, cy + dy);
    await page.mouse.down();
    await page.mouse.move(cx + 40, cy + dy + 10, { steps: 5 });
    await page.mouse.up();
  }
  const count0 = await page.locator('.board-stroke:not(.live)').count();

  // lasso around both: one selection box
  await page.click('[data-tool="lasso"]');
  await page.mouse.move(cx - 70, cy - 170);
  await page.mouse.down();
  for (const [x, y] of [[cx + 70, cy - 170], [cx + 70, cy - 80], [cx - 70, cy - 80], [cx - 70, cy - 170]] as const) await page.mouse.move(x, y, { steps: 4 });
  await page.mouse.up();
  const selbox = page.locator('.board-selbox');
  await expect(selbox).toBeVisible();
  const before = (await selbox.boundingBox())!;

  // drag the box: both strokes move together
  await page.mouse.move(before.x + before.width / 2, before.y + before.height / 2);
  await page.mouse.down();
  await page.mouse.move(before.x + before.width / 2 + 60, before.y + before.height / 2 + 30, { steps: 5 });
  await page.mouse.up();
  const after = (await selbox.boundingBox())!;
  expect(after.x).toBeGreaterThan(before.x + 40);

  // Delete removes them both
  await page.keyboard.press('Delete');
  await expect(page.locator('.board-stroke:not(.live)')).toHaveCount(count0 - 2);
  await expect(selbox).toBeHidden();
});

test('the laser pointer leaves a fading trace and writes nothing; the selected preset opens its editor on a second click', async ({ page }) => {
  await login(page);
  await openBoard(page, 'laser.board');
  const vp = (await page.locator('.board').boundingBox())!;
  const cx = vp.x + vp.width / 2, cy = vp.y + vp.height / 2;

  await page.click('[data-tool="laser"]');
  await page.mouse.move(cx - 60, cy);
  await page.mouse.down();
  for (let i = 1; i <= 8; i++) await page.mouse.move(cx - 60 + i * 15, cy + (i % 2 ? 6 : -6), { steps: 2 });
  await expect(page.locator('.board-laser[data-laser="mine"]:not(.fade)')).toBeVisible();
  await page.mouse.up();
  // lifted: the trace fades out and is gone; no stroke object was created
  await expect(page.locator('.board-laser.fade')).toBeVisible();
  await expect(page.locator('.board-laser')).toHaveCount(0, { timeout: 3000 });
  await expect(page.locator('.board-stroke:not(.live)')).toHaveCount(0);
  await expect.poll(() => readFileSync(LASER_BOARD, 'utf8')).toBe('{"overlyx":"board","v":1,"objects":{\n}}\n');

  // presets (the same pen case as the margin ink): select a colour, click it again → picker
  await page.click('[data-tool="pen"]');
  await page.click('[data-slot="c3"]');
  await expect(page.locator('[data-slot="c3"]')).toHaveClass(/active/);
  await expect(page.locator('.board-pop')).toHaveCount(0);
  await page.click('[data-slot="c3"]');
  await expect(page.locator('.board-pop [data-ink-picker="color"]')).toBeVisible();
  await page.click('.board-pop [data-ink-color="#795548"]');
  await expect(page.locator('[data-slot="c3"]')).toHaveAttribute('data-color', '#795548');
  await page.click('[data-slot="w0"]');
  await expect(page.locator('.board-pop')).toHaveCount(0);   // picking another preset closes the editor
  await page.click('[data-slot="w0"]');
  await page.locator('.board-pop input[data-ink-width]').fill('1');
  await expect(page.locator('[data-slot="w0"]')).toHaveAttribute('data-width', '1');
  await page.keyboard.press('Escape');
  await expect(page.locator('.board-pop')).toHaveCount(0);
  // a stroke drawn now uses them
  await page.mouse.move(cx, cy + 80);
  await page.mouse.down();
  await page.mouse.move(cx + 60, cy + 90, { steps: 5 });
  await page.mouse.up();
  await expect.poll(() => readFileSync(LASER_BOARD, 'utf8'), { timeout: 15000 }).toMatch(/"color":"#795548"[^\n]*"sw":1[,}]/);
});

test('two clients see each other: an edit appears live on the other side', async ({ browser }) => {
  const a = await browser.newContext(), b = await browser.newContext();
  try {
    const pa = await a.newPage(), pb = await b.newPage();
    await login(pa); await login(pb);
    await openBoard(pa); await openBoard(pb);
    await pa.click('[data-tool="note"]');
    const vp = (await pa.locator('.board').boundingBox())!;
    await pa.mouse.click(vp.x + vp.width / 2 + 120, vp.y + vp.height / 2 + 60);
    await pa.locator('.board-note-edit').fill('Seen by both');
    await pa.locator('.board-note-edit').blur();
    await expect(pb.locator('.board-note').filter({ hasText: 'Seen by both' })).toBeVisible({ timeout: 10000 });
  } finally { await a.close(); await b.close(); }
});

test('a board can be created from the file browser', async ({ page }) => {
  await login(page);
  await page.goto(`/#/${PROJECT}/main.tex`);
  await page.waitForSelector('.lyx-editor');
  page.once('dialog', d => void d.accept('scratchpad'));
  await page.click('.filetree .actions button:has-text("+ Board")');
  await page.waitForSelector('.board-tools', { timeout: 20000 });
  await expect(page).toHaveURL(new RegExp(`${PROJECT}/scratchpad\\.board`));
});
