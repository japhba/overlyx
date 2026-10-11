/**
 * List items move by drag and drop, with their sub-items (editor/plugins/listdrag.ts, listmove.ts):
 * the grip beside the bullet on hover; dragged up or down the item lands where the line shows, one
 * undo step; dragged right it nests deeper; Esc cancels; a finger gets the grip of the item it
 * tapped into; Alt+↑ moves the item with its sub-items; markdown lists too. Needs the seeded admin.
 */
import { test, expect, type Page } from '@playwright/test';
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { login, openDoc, texDoc, PROJECTS_DIR } from './helpers';

const PROJECT = 'admin/e2e-listdrag';
const DIR = `${PROJECTS_DIR}/${PROJECT}`;
const LIST = ['\\begin{itemize}', '\\item alpha', '\\begin{itemize}', '\\item alpha one', '\\item alpha two', '\\end{itemize}', '\\item beta', '\\item gamma', '\\end{itemize}', '', 'After the list.'].join('\n');

test.describe.configure({ mode: 'serial' });

test.beforeAll(() => {
  rmSync(DIR, { recursive: true, force: true });
  mkdirSync(DIR, { recursive: true });
  for (const n of ['mouse', 'nest', 'esc', 'touch', 'keys']) writeFileSync(`${DIR}/${n}.tex`, texDoc(LIST));
  writeFileSync(`${DIR}/notes.md`, '# Notes\n\n- one\n- two\n- three\n');
});
test.afterAll(() => { rmSync(DIR, { recursive: true, force: true }); });

const pars = (page: Page) => page.locator('.lyx-editor > .lyx-par');
const outline = async (page: Page) => {
  const out: string[] = [];
  for (const p of await pars(page).all()) out.push('  '.repeat(Number(await p.getAttribute('data-depth') ?? 0)) + (await p.innerText()).trim());
  return out;
};
const par = (page: Page, text: string) => pars(page).filter({ hasText: new RegExp(`^${text}$`) });

/** hover the item, press its grip, move to (x, y) in steps, release (or not) */
async function dragItem(page: Page, text: string, to: { x?: number; dy?: number; y?: number }, release = true): Promise<void> {
  const item = par(page, text);
  const box = (await item.boundingBox())!;
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  const grip = page.locator('.lyx-list-grip');
  await expect(grip).toBeVisible();
  const g = (await grip.boundingBox())!;
  const x0 = g.x + g.width / 2, y0 = g.y + g.height / 2;
  await page.mouse.move(x0, y0);
  await page.mouse.down();
  const x1 = x0 + (to.x ?? 0), y1 = to.y ?? y0 + (to.dy ?? 0);
  for (let k = 1; k <= 8; k++) await page.mouse.move(x0 + ((x1 - x0) * k) / 8, y0 + ((y1 - y0) * k) / 8);
  await expect(page.locator('.lyx-list-drop')).toBeVisible();
  if (release) await page.mouse.up();
}

test('dragging the grip moves an item; one undo puts it back; the .tex follows', async ({ page }) => {
  await login(page);
  await openDoc(page, `${PROJECT}/mouse.tex`);
  expect(await outline(page)).toEqual(['alpha', '  alpha one', '  alpha two', 'beta', 'gamma', 'After the list.']);
  // gamma to the top
  const top = (await par(page, 'alpha').boundingBox())!;
  await dragItem(page, 'gamma', { y: top.y + 2 });
  await expect.poll(() => outline(page)).toEqual(['gamma', 'alpha', '  alpha one', '  alpha two', 'beta', 'After the list.']);
  await expect.poll(() => readFileSync(`${DIR}/mouse.tex`, 'utf8'), { timeout: 15000 }).toMatch(/\\item gamma\s*\\item alpha/);
  // the item and its sub-items go together: alpha below beta
  const beta = (await par(page, 'beta').boundingBox())!;
  await dragItem(page, 'alpha', { y: beta.y + beta.height - 2 });
  await expect.poll(() => outline(page)).toEqual(['gamma', 'beta', 'alpha', '  alpha one', '  alpha two', 'After the list.']);
  // one undo step per move
  await page.keyboard.press('Control+z');
  await expect.poll(() => outline(page)).toEqual(['gamma', 'alpha', '  alpha one', '  alpha two', 'beta', 'After the list.']);
  // a plain paragraph has no grip
  const after = (await par(page, 'After the list.').boundingBox())!;
  await page.mouse.move(after.x + 30, after.y + after.height / 2);
  await expect(page.locator('.lyx-list-grip')).toBeHidden();
});

test('dragged right it nests under the item before; the drop line shows the depth', async ({ page }) => {
  await login(page);
  await openDoc(page, `${PROJECT}/nest.tex`);
  // gamma one step right, staying where it is: under beta
  await dragItem(page, 'gamma', { x: 40, dy: 0 }, false);
  const line = (await page.locator('.lyx-list-drop').boundingBox())!;
  const gamma = (await par(page, 'gamma').boundingBox())!;
  expect(line.x).toBeGreaterThan(gamma.x + 10);
  await page.mouse.up();
  await expect.poll(() => outline(page)).toEqual(['alpha', '  alpha one', '  alpha two', 'beta', '  gamma', 'After the list.']);
  // beta (with gamma under it) dropped between alpha's sub-items: it can only be their sibling there
  const two = (await par(page, 'alpha two').boundingBox())!;
  await dragItem(page, 'beta', { x: -60, y: two.y + 2 });
  await expect.poll(() => outline(page)).toEqual(['alpha', '  alpha one', '  beta', '    gamma', '  alpha two', 'After the list.']);
  await expect.poll(() => readFileSync(`${DIR}/nest.tex`, 'utf8'), { timeout: 15000 }).toMatch(/\\item alpha one\s*\\item beta\s*\\begin\{itemize\}\s*\\item gamma/);
});

test('Esc cancels a drag', async ({ page }) => {
  await login(page);
  await openDoc(page, `${PROJECT}/esc.tex`);
  const top = (await par(page, 'alpha').boundingBox())!;
  await dragItem(page, 'beta', { y: top.y + 2 }, false);
  await page.keyboard.press('Escape');
  await expect(page.locator('.lyx-list-drop')).toHaveCount(0);
  await page.mouse.up();
  expect(await outline(page)).toEqual(['alpha', '  alpha one', '  alpha two', 'beta', 'gamma', 'After the list.']);
});

test('a finger: the item tapped into shows its grip, which drags', async ({ page, context }) => {
  await login(page);
  await openDoc(page, `${PROJECT}/touch.tex`);
  const cdp = await context.newCDPSession(page);
  const touch = (type: string, x: number, y: number) => cdp.send('Input.dispatchTouchEvent', { type, touchPoints: type === 'touchEnd' ? [] : [{ x, y, id: 1 }] });
  const beta = (await par(page, 'beta').boundingBox())!;
  await touch('touchStart', beta.x + 60, beta.y + beta.height / 2);
  await touch('touchEnd', beta.x + 60, beta.y + beta.height / 2);
  const grip = page.locator('.lyx-list-grip');
  await expect(grip).toBeVisible();
  const g = (await grip.boundingBox())!;
  expect(Math.abs(g.y + g.height / 2 - (beta.y + beta.height / 2))).toBeLessThan(12);
  const top = (await par(page, 'alpha').boundingBox())!;
  const x = g.x + g.width / 2;
  await touch('touchStart', x, g.y + g.height / 2);
  for (let k = 1; k <= 8; k++) await touch('touchMove', x, g.y + g.height / 2 + ((top.y + 2 - g.y - g.height / 2) * k) / 8);
  await touch('touchEnd', x, top.y + 2);
  await expect.poll(() => outline(page)).toEqual(['beta', 'alpha', '  alpha one', '  alpha two', 'gamma', 'After the list.']);
});

test('Alt+↑ / Alt+↓ move an item with its sub-items', async ({ page }) => {
  await login(page);
  await openDoc(page, `${PROJECT}/keys.tex`);
  await par(page, 'beta').click();
  await page.keyboard.press('Alt+ArrowUp');
  await expect.poll(() => outline(page)).toEqual(['beta', 'alpha', '  alpha one', '  alpha two', 'gamma', 'After the list.']);
  await par(page, 'alpha').click();
  await page.keyboard.press('Alt+ArrowDown');
  await expect.poll(() => outline(page)).toEqual(['beta', 'gamma', 'alpha', '  alpha one', '  alpha two', 'After the list.']);
  // the caret came along: typing goes into alpha
  await page.keyboard.type('X');
  await expect(pars(page).nth(2)).toContainText('X');
});

test('markdown lists reorder too', async ({ page }) => {
  await login(page);
  await openDoc(page, `${PROJECT}/notes.md`);
  const one = (await par(page, 'one').boundingBox())!;
  await dragItem(page, 'three', { y: one.y + 2 });
  await expect.poll(() => readFileSync(`${DIR}/notes.md`, 'utf8'), { timeout: 15000 }).toContain('- three\n- one\n- two');
});
