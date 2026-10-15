/** Pointer cancellation must release transient drawing gestures instead of leaving a node armed. */
import { test, expect, type Page } from '@playwright/test';
import { readFileSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { login, BASE_URL, PROJECTS_DIR } from './helpers';

const RUN = Date.now().toString(36);
const NAME = `e2e-touch-recovery-${RUN}`;
const PROJECT = `admin/${NAME}`;
const FOLDER = 'talk';
const FILE = `${PROJECTS_DIR}/${PROJECT}/${FOLDER}/index.html`;
const fileText = () => readFileSync(FILE, 'utf8');
const DECK = `<!doctype html><html><head><meta charset="utf-8"><meta name="overlyx" content="deck"><title>Recovery</title>
<style>body{margin:0;background:#dfe3ea}.slide{width:1280px;height:720px;position:relative;overflow:hidden;background:white;margin:0 auto 40px}</style></head>
<body><section class="slide"><div id="box" style="position:absolute;left:100px;top:240px;width:200px;height:100px;background:#ddd"></div></section></body></html>`;

const frame = (page: Page) => page.frameLocator('.dl-frame');
const slide = (page: Page) => frame(page).locator('section.slide').first();
async function dispatchPointer(page: Page, type: string, point: { x: number; y: number }, id: number): Promise<void> {
  const f = page.frames().find(x => /[?&]ol=edit/.test(x.url()))!;
  const iframe = (await page.locator('.dl-frame').boundingBox())!;
  await f.evaluate(({ type, x, y, id }) => {
    const target = document.elementFromPoint(x, y) ?? document.body;
    target.dispatchEvent(new PointerEvent(type, { bubbles: true, cancelable: true, composed: true, pointerId: id, pointerType: 'touch', isPrimary: true,
      button: 0, buttons: type === 'pointerup' || type === 'pointercancel' ? 0 : 1, clientX: x, clientY: y, pressure: 0.5 }));
  }, { type, x: point.x - iframe.x, y: point.y - iframe.y, id });
}
async function localPoint(page: Page, point: { x: number; y: number }) {
  const iframe = (await page.locator('.dl-frame').boundingBox())!;
  return { x: point.x - iframe.x, y: point.y - iframe.y };
}

test('Bézier pointercancel and lost capture release the active node drag', async ({ page }) => {
  await login(page);
  await page.request.post(BASE_URL + '/api/projects', { data: { name: NAME } });
  mkdirSync(`${PROJECTS_DIR}/${PROJECT}/${FOLDER}`, { recursive: true });
  writeFileSync(FILE, DECK);
  await page.request.get('/api/projects');
  await page.goto(`/#/${PROJECT}/${FOLDER}/index.html`);
  await expect(slide(page)).toBeVisible({ timeout: 30000 });
  await page.waitForTimeout(800);

  await page.locator('[data-tb="dk-lines"]').click();
  await page.locator('[data-palette="dk-lines"] .tb-pal-item[title^="Path"]').click();
  const box = (await slide(page).boundingBox())!;
  const k = box.width / 1280;
  const p = (x: number, y: number) => ({ x: box.x + x * k, y: box.y + y * k });
  const start = p(500, 300), after = p(760, 180), end = p(900, 320);
  const editingFrame = page.frames().find(f => /[?&]ol=edit/.test(f.url()))!;
  await page.mouse.click(start.x, start.y);

  // Synthetic PointerEvents are used only for the otherwise hard-to-produce cancel edge case;
  // the tool switch and subsequent normal click/Enter are actual GUI actions.
  await editingFrame.evaluate(({ x, y }) => {
    const target = document.elementFromPoint(x, y) ?? document.body;
    const init = { bubbles: true, cancelable: true, pointerId: 73, pointerType: 'pen', isPrimary: true, button: 0, buttons: 1, clientX: x, clientY: y, pressure: 0.5 };
    target.dispatchEvent(new PointerEvent('pointerdown', init));
    target.dispatchEvent(new PointerEvent('pointercancel', { ...init, buttons: 0, pressure: 0 }));
    target.dispatchEvent(new PointerEvent('pointermove', { ...init, clientX: x + 100, clientY: y + 70 }));
  }, await localPoint(page, start));
  await page.mouse.click(end.x, end.y);
  await page.keyboard.press('Enter');
  await expect.poll(fileText, { timeout: 15000 }).toContain('<path d=');
  expect(fileText()).not.toMatch(/<path d="[^"]*C[^"]*"/);
  await expect(frame(page).locator('.nodes')).toHaveCount(0);

  // A second path checks lost capture independently, including pointer identity cleanup.
  await page.mouse.click(start.x, start.y);
  await editingFrame.evaluate(({ x, y }) => {
    const target = document.elementFromPoint(x, y) ?? document.body;
    const init = { bubbles: true, cancelable: true, pointerId: 74, pointerType: 'pen', isPrimary: true, button: 0, buttons: 1, clientX: x, clientY: y, pressure: 0.5 };
    target.dispatchEvent(new PointerEvent('pointerdown', init));
    target.dispatchEvent(new PointerEvent('lostpointercapture', { ...init, buttons: 0, pressure: 0 }));
    target.dispatchEvent(new PointerEvent('pointermove', { ...init, clientX: x + 100, clientY: y + 70 }));
  }, await localPoint(page, after));
  await page.mouse.click(end.x, end.y);
  await page.keyboard.press('Enter');
  await expect.poll(fileText, { timeout: 15000 }).toContain('<path d=');
  expect(fileText()).not.toMatch(/<path d="[^"]*C[^"]*"/);
  await expect(frame(page).locator('.nodes')).toHaveCount(0);
});

test('canceled touch move/resize/draw, tool changes, and frame blur restore a usable canvas', async ({ page }, info) => {
  test.skip(info.project.name !== 'chromium', 'Trusted multi-touch cancellation uses Chromium CDP; physical Safari/Firefox touch remains a separate gate.');
  await login(page);
  await page.request.post(BASE_URL + '/api/projects', { data: { name: NAME } });
  mkdirSync(`${PROJECTS_DIR}/${PROJECT}/${FOLDER}`, { recursive: true });
  writeFileSync(FILE, DECK);
  await page.request.get('/api/projects');
  await page.goto(`/#/${PROJECT}/${FOLDER}/index.html`);
  await expect(slide(page)).toBeVisible({ timeout: 30000 });
  await page.waitForTimeout(800);

  const b = (await slide(page).boundingBox())!;
  const k = b.width / 1280;
  const at = (x: number, y: number) => ({ x: b.x + x * k, y: b.y + y * k });
  const object = frame(page).locator('#box');
  const original = await object.getAttribute('style');
  const originalGeometry = [100, 240, 200, 100];
  const geometry = () => object.evaluate(el => [el.style.left, el.style.top, el.style.width, el.style.height].map(s => parseFloat(s)));
  const cdp = await page.context().newCDPSession(page);
  const touches = (type: string, points: { x: number; y: number; id: number }[]) => cdp.send('Input.dispatchTouchEvent', { type, touchPoints: points });
  const dragging = () => page.frames().find(f => /[?&]ol=edit/.test(f.url()))!.evaluate(() => document.documentElement.classList.contains('ol-dragging'));

  // A second finger interrupts an object hold; the hold never becomes a stale move gesture.
  await page.mouse.click(at(200, 280).x, at(200, 280).y);
  await touches('touchStart', [{ ...at(200, 280), id: 80 }]);
  await touches('touchStart', [{ ...at(200, 280), id: 80 }, { ...at(300, 280), id: 86 }]);
  await expect.poll(geometry).toEqual(originalGeometry);
  expect(await dragging()).toBe(false);
  await touches('touchMove', [{ ...at(170, 280), id: 80 }, { ...at(330, 280), id: 86 }]);
  await touches('touchCancel', []);
  await expect.poll(geometry).toEqual(originalGeometry);
  await page.locator('.dl-zoom').selectOption('fit');

  // A touch move is live while held, but cancellation restores its exact inline geometry.
  const center = at(200, 280);
  await page.mouse.click(center.x, center.y);
  await touches('touchStart', [{ ...at(200, 280), id: 81 }]);
  await touches('touchMove', [{ ...at(260, 330), id: 81 }]);
  await expect.poll(() => object.getAttribute('style')).not.toBe(original);
  await touches('touchCancel', []);
  await expect.poll(geometry).toEqual(originalGeometry);
  expect(await dragging()).toBe(false);

  // Resize cancellation reverts the frame rather than leaving the object stretched.
  await page.mouse.click(center.x, center.y);
  await page.mouse.click(center.x, center.y);
  const ob = (await object.boundingBox())!;
  const hp = { x: ob.x + ob.width, y: ob.y + ob.height };
  await touches('touchStart', [{ ...hp, id: 82 }]);
  await touches('touchMove', [{ x: hp.x + 30, y: hp.y + 30, id: 82 }]);
  await expect.poll(() => object.getAttribute('style')).not.toBe(original);
  await touches('touchCancel', []);
  await expect.poll(geometry).toEqual(originalGeometry);
  expect(await dragging()).toBe(false);
  const sourceBeforeDraw = fileText();

  // Drawing is provisional: cancel, switch tools, or blur clears it without creating source objects.
  await page.locator('[data-tb="dk-shapes"]').click();
  await page.locator('[data-palette="dk-shapes"] .tb-pal-item[title="Rectangle"]').click();
  await dispatchPointer(page, 'pointerdown', at(500, 400), 83);
  await dispatchPointer(page, 'pointermove', at(650, 500), 83);
  await expect.poll(dragging).toBe(true);
  await dispatchPointer(page, 'pointercancel', at(650, 500), 83);
  expect(await dragging()).toBe(false);
  expect(fileText()).toBe(sourceBeforeDraw);

  await dispatchPointer(page, 'pointerdown', at(500, 400), 84);
  await dispatchPointer(page, 'pointermove', at(650, 500), 84);
  await page.locator('[data-tb="dk-select"]').click();
  await expect.poll(dragging).toBe(false);
  expect(fileText()).toBe(sourceBeforeDraw);

  await page.locator('[data-tb="dk-shapes"]').click();
  await page.locator('[data-palette="dk-shapes"] .tb-pal-item[title="Rectangle"]').click();
  await dispatchPointer(page, 'pointerdown', at(500, 400), 85);
  await dispatchPointer(page, 'pointermove', at(650, 500), 85);
  const editor = page.frames().find(f => /[?&]ol=edit/.test(f.url()))!;
  await editor.evaluate(() => window.dispatchEvent(new Event('blur')));
  await expect.poll(dragging).toBe(false);
  expect(await dragging()).toBe(false);
  expect(fileText()).toBe(sourceBeforeDraw);
});

test.afterAll(() => rmSync(`${PROJECTS_DIR}/${PROJECT}`, { recursive: true, force: true }));
