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

test.describe.configure({ mode: 'serial' });

test.beforeAll(() => {
  rmSync(DIR, { recursive: true, force: true });
  mkdirSync(DIR, { recursive: true });
  writeFileSync(`${DIR}/main.tex`, texDoc('A project with a whiteboard.'));
  writeFileSync(BOARD, '{"overlyx":"board","v":1,"objects":{\n}}\n');
});
test.afterAll(() => { rmSync(DIR, { recursive: true, force: true }); });

async function openBoard(page: Page): Promise<void> {
  await page.goto(`/#/${PROJECT}/plan.board`);
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
