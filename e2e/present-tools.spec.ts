/**
 * The presenting tools (app/presentkit.ts) in both presenters — an HTML deck (deliverable/runtime/
 * present.ts, in its sandboxed frame) and a layout document (editor/layout/present.ts): the laser
 * pointer from L and from the control bar, its tail fading behind the moving dot, a pressed trace
 * that fades once lifted, a drag or a click with the laser on not going on; a pinch (Ctrl + wheel)
 * zooming the slide, a click then not going on, a drag panning, `0` and Escape going back to the
 * whole slide, a second Escape ending the presentation, the arrow keys going on (unzoomed); the
 * bar out of sight until the mouse nears the bottom edge (a tap on a touch screen: the bar, not the
 * next slide); the pen drawing on a slide, its drawing kept with that slide, E clearing it; on a
 * touch screen only the Pencil drawing (fingers swipe and pinch with a tool in hand) unless the bar's
 * "Fingers draw" is on, which the editor keeps for the next presentation; the screen kept on.
 * Needs the seeded admin.
 */
import { test, expect, type Page, type FrameLocator, type Locator } from '@playwright/test';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { login, collectErrors, BASE_URL, PROJECTS_DIR } from './helpers';

const RUN = Date.now().toString(36);
const NAME = `e2e-present-${RUN}`;
const PROJECT = `admin/${NAME}`;
const DIR = `${PROJECTS_DIR}/${PROJECT}`;

test.describe.configure({ mode: 'serial' });
test.afterAll(() => rmSync(DIR, { recursive: true, force: true }));

const LAYOUT = String.raw`\documentclass[aspectratio=169]{beamer}
\begin{document}
\begin{frame}[plain]
\olshape{x=20mm,y=20mm,w=30mm,h=20mm,vb=0 0 30 20,fill=blue,name=Blue}{M 0 0 L 30 0 L 30 20 L 0 20 Z}
\begin{olbox}{x=70mm,y=20mm,w=60mm,h=10mm,font=14pt}
First words
\end{olbox}
\end{frame}

\begin{frame}[plain]
\begin{olbox}{x=10mm,y=10mm,w=100mm,h=20mm,font=24pt}
Second page
\end{olbox}
\end{frame}
\end{document}
`;

/** the page's own errors: MathJax's note that the sandboxed frame has no localStorage is not one */
const real = (errors: string[]) => errors.filter(e => !/localStorage|favicon|ResizeObserver/.test(e));

/** the laser, from L and from the bar; returns once it is off again */
async function laser(page: Page, scope: FrameLocator | Page, surface: Locator, pos: Locator, box: { x: number; y: number; width: number; height: number }): Promise<void> {
  const ui = scope.locator('ol-present-ui');
  const cx = box.x + box.width / 2, cy = box.y + box.height / 2;
  await expect(pos).toHaveText('1 / 2');
  await page.keyboard.press('l');
  await expect(surface).toHaveClass(/olpk-laser-on/);
  // moving: a dot and a tail behind it, which shortens away once the mouse rests
  await page.mouse.move(cx - 120, cy);
  await page.mouse.move(cx + 120, cy + 40, { steps: 12 });
  await expect(ui.locator('svg.laser g.live circle.head')).toHaveCount(1);
  await expect(ui.locator('svg.laser g.live g.trace path.glow').first()).toBeAttached();
  await expect(ui.locator('svg.laser g.live g.trace')).toHaveCount(0, { timeout: 3000 });
  await expect(ui.locator('svg.laser g.live circle.head')).toHaveCount(1);
  // pressed and dragged: a trace as the whiteboard's (app/laser.ts), held, then fading once lifted — the slide stays
  await page.mouse.down();
  await page.mouse.move(cx - 60, cy - 60, { steps: 10 });
  await expect(ui.locator('svg.laser g.mylaser g.trace path.glow')).toHaveCount(1);
  await expect(ui.locator('svg.laser g.mylaser')).toHaveAttribute('opacity', '1');
  await page.mouse.up();
  await expect.poll(() => ui.locator('svg.laser g.mylaser').getAttribute('opacity').then(Number)).toBeLessThan(1);
  await expect(ui.locator('svg.laser g.mylaser g.trace')).toHaveCount(0, { timeout: 6000 });
  await page.mouse.click(cx, cy);
  await page.waitForTimeout(300);
  await expect(pos).toHaveText('1 / 2');
  // the bar (shown by moving the mouse near the bottom edge): its laser button switches it off and on
  await page.mouse.move(cx, box.y + box.height - 40);
  const btn = ui.locator('button[data-k="laser"]');
  await expect(btn).toHaveAttribute('aria-pressed', 'true');
  await btn.click();
  await expect(surface).not.toHaveClass(/olpk-laser-on/);
  await expect(btn).toHaveAttribute('aria-pressed', 'false');
  await btn.click();
  await expect(surface).toHaveClass(/olpk-laser-on/);
  await expect(pos).toHaveText('1 / 2');
  await page.keyboard.press('L');
  await expect(surface).not.toHaveClass(/olpk-laser-on/);
}

/** the pen from the bar (brought by the mouse near the bottom edge, not by pointing at the slide): a stroke, kept with its slide, E clears it, Escape puts the pen away */
async function draw(page: Page, scope: FrameLocator | Page, surface: Locator, pos: Locator, box: { x: number; y: number; width: number; height: number }): Promise<void> {
  const ui = scope.locator('ol-present-ui');
  const bar = ui.locator('.bar');
  const strokes = ui.locator('svg.laser g.strokes path');
  const cx = box.x + box.width / 2, cy = box.y + box.height / 2;
  await expect(pos).toHaveText('1 / 2');
  await page.mouse.move(cx, cy);
  await page.mouse.move(cx + 60, cy + 30, { steps: 5 });
  await page.waitForTimeout(150);
  await expect(bar).not.toHaveClass(/show/);
  await page.mouse.move(cx, box.y + box.height - 40, { steps: 3 });
  await expect(bar).toHaveClass(/show/);
  await ui.locator('button[data-k="pen"]').click();
  await expect(surface).toHaveClass(/olpk-drawing/);
  await expect(ui.locator('.colors')).toBeVisible();
  await page.mouse.move(cx - 120, cy - 60);
  await page.mouse.down();
  await page.mouse.move(cx + 120, cy + 40, { steps: 12 });
  await page.mouse.up();
  await expect(strokes).toHaveCount(1);
  // the stroke sent the bar away; drawing did not go on
  await expect(bar).not.toHaveClass(/show/);
  await page.waitForTimeout(300);
  await expect(pos).toHaveText('1 / 2');
  // the drawing belongs to its slide
  await page.keyboard.press('ArrowRight');
  await expect(pos).toHaveText('2 / 2');
  await expect(strokes).toHaveCount(0);
  await page.keyboard.press('ArrowLeft');
  await expect(pos).toHaveText('1 / 2');
  await expect(strokes).toHaveCount(1);
  await page.keyboard.press('e');
  await expect(strokes).toHaveCount(0);
  // Escape puts the pen away first (still presenting)
  await page.keyboard.press('Escape');
  await expect(surface).not.toHaveClass(/olpk-drawing/);
  await expect(pos).toHaveText('1 / 2');
}

/** a pinch zooms; zoomed, a click does not go on, a drag pans; 0 and Escape go back; returns unzoomed */
async function zoom(page: Page, scope: FrameLocator | Page, slide: Locator, pos: Locator, at: { x: number; y: number }, zoomed: () => Promise<boolean>): Promise<void> {
  const cx = at.x, cy = at.y;
  const w0 = (await slide.boundingBox())!.width;
  const pinch = async () => {
    await page.mouse.move(cx, cy);
    await page.keyboard.down('Control');
    for (let i = 0; i < 6; i++) { await page.mouse.wheel(0, -40); await page.waitForTimeout(30); }
    await page.keyboard.up('Control');
    await page.waitForTimeout(200);
  };
  await pinch();
  expect(await zoomed()).toBe(true);
  const z1 = (await slide.boundingBox())!;
  expect(z1.width).toBeGreaterThan(w0 * 1.5);
  await expect(scope.locator('ol-present-ui button[data-k="zoom"]')).toBeVisible();
  // a click: no next slide
  await page.mouse.click(cx, cy);
  await page.waitForTimeout(300);
  await expect(pos).toHaveText('1 / 2');
  // a drag pans
  await page.mouse.move(cx, cy);
  await page.mouse.down();
  await page.mouse.move(cx + 80, cy + 50, { steps: 6 });
  await page.mouse.up();
  const z2 = (await slide.boundingBox())!;
  expect(Math.abs(z2.x - z1.x) + Math.abs(z2.y - z1.y)).toBeGreaterThan(20);
  await expect(pos).toHaveText('1 / 2');
  // 0: the whole slide again
  await page.keyboard.press('0');
  await expect.poll(zoomed).toBe(false);
  expect(Math.abs((await slide.boundingBox())!.width - w0)).toBeLessThan(2);
  // zoomed, the arrow key goes on and shows the next slide whole
  await pinch();
  expect(await zoomed()).toBe(true);
  await page.keyboard.press('ArrowRight');
  await expect(pos).toHaveText('2 / 2');
  await expect.poll(zoomed).toBe(false);
  await page.keyboard.press('ArrowLeft');
  await expect(pos).toHaveText('1 / 2');
  // Escape: first back to the whole slide (still presenting)
  await pinch();
  expect(await zoomed()).toBe(true);
  await page.keyboard.press('Escape');
  await expect.poll(zoomed).toBe(false);
}

test('an HTML deck: the laser and the zoom while presenting', async ({ page }) => {
  const errors = collectErrors(page);
  await login(page);
  expect((await page.request.post(BASE_URL + '/api/projects', { data: { name: NAME } })).ok()).toBeTruthy();
  expect((await page.request.post(BASE_URL + `/api/projects/${encodeURIComponent(PROJECT)}/deliverables`, { data: { dir: 'talk', kind: 'deck', title: 'Tools' } })).ok()).toBeTruthy();
  await page.goto(`/#/${PROJECT}/talk/index.html`);
  await page.frameLocator('.dl-frame').locator('section.slide').first().waitFor({ timeout: 30000 });
  await page.waitForTimeout(800);
  await page.locator('[data-dl-present]').click();
  const pres = page.frameLocator('.dl-presenting iframe');
  const pos = pres.locator('ol-present-ui .pos');
  await expect(pos).toHaveText('1 / 2', { timeout: 20000 });
  await page.waitForTimeout(400);
  const box = (await page.locator('.dl-presenting iframe').boundingBox())!;
  await laser(page, pres, pres.locator('html'), pos, box);
  await draw(page, pres, pres.locator('html'), pos, box);
  await expect(page.locator('.dl-presenting')).toHaveCount(1);
  const slide = pres.locator('section.slide[data-ol-current]');
  // (headless Chromium hands synthetic wheel events over the slide's empty background in this sandboxed
  // frame to nobody — not even to a full-window overlay's listener; over its title they arrive)
  const h1 = (await pres.locator('section.slide[data-ol-current] h1').boundingBox())!;
  await zoom(page, pres, slide, pos, { x: h1.x + Math.min(h1.width / 2, 60), y: h1.y + h1.height / 2 }, async () => (await pres.locator('html').evaluate(e => parseFloat((e as HTMLElement).style.getPropertyValue('--ol-zs')) || 1)) > 1.01);
  await expect(page.locator('.dl-presenting')).toHaveCount(1);
  // the second Escape ends it
  await page.keyboard.press('Escape');
  await expect(page.locator('.dl-presenting')).toHaveCount(0, { timeout: 10000 });
  expect(real(errors)).toEqual([]);
});

test('a layout document: the laser and the zoom while presenting', async ({ page }) => {
  const errors = collectErrors(page);
  mkdirSync(DIR, { recursive: true });
  writeFileSync(`${DIR}/present.tex`, LAYOUT);
  await login(page);
  await page.goto(`/#/${PROJECT}/present.tex`);
  await page.waitForSelector('.lyx-editor.ol-layout .ol-page', { timeout: 30000 });
  await page.waitForTimeout(800);
  const pg = (await page.locator('.lyx-editor .ol-page').first().boundingBox())!;
  await page.mouse.click(pg.x + pg.width - 8, pg.y + pg.height - 8);   // empty page: focus, nothing selected
  await page.keyboard.press('F5');
  await expect(page.locator('.ol-present')).toBeVisible();
  const pos = page.locator('.ol-present ol-present-ui .pos');
  const box = { x: 0, y: 0, ...page.viewportSize()! } as { x: number; y: number; width: number; height: number };
  await laser(page, page, page.locator('.ol-present'), pos, box);
  await draw(page, page, page.locator('.ol-present'), pos, box);
  await expect(page.locator('.ol-present')).toHaveCount(1);
  const stage = page.locator('.ol-present-stage');
  await zoom(page, page, stage, pos, { x: box.width * 0.4, y: box.height * 0.4 }, async () => /scale\((?!1\))/.test(await stage.evaluate(e => (e as HTMLElement).style.transform)));
  await expect(page.locator('.ol-present')).toHaveCount(1);
  await page.keyboard.press('Escape');
  await expect(page.locator('.ol-present')).toHaveCount(0);
  expect(real(errors)).toEqual([]);
});

test.describe('on a touch screen', () => {
  test.use({ hasTouch: true });
  test('an HTML deck: a tap brings the bar and does not go on; another sends it away', async ({ page }) => {
    const errors = collectErrors(page);
    await login(page);
    await page.goto(`/#/${PROJECT}/talk/index.html`);
    await page.frameLocator('.dl-frame').locator('section.slide').first().waitFor({ timeout: 30000 });
    await page.waitForTimeout(800);
    await page.locator('[data-dl-present]').click();
    const pres = page.frameLocator('.dl-presenting iframe');
    const pos = pres.locator('ol-present-ui .pos');
    const bar = pres.locator('ol-present-ui .bar');
    await expect(pos).toHaveText('1 / 2', { timeout: 20000 });
    await page.waitForTimeout(400);
    const box = (await page.locator('.dl-presenting iframe').boundingBox())!;
    const cx = box.x + box.width / 2, cy = box.y + box.height / 2;
    await expect(bar).not.toHaveClass(/show/);
    await page.touchscreen.tap(cx, cy);
    await expect(bar).toHaveClass(/show/);
    await page.waitForTimeout(400);
    await expect(pos).toHaveText('1 / 2');
    await page.touchscreen.tap(cx, cy);
    await expect(bar).not.toHaveClass(/show/);
    await page.waitForTimeout(400);
    await expect(pos).toHaveText('1 / 2');
    // the keys still go on
    await page.keyboard.press('ArrowRight');
    await expect(pos).toHaveText('2 / 2');
    await page.keyboard.press('Escape');
    await expect(page.locator('.dl-presenting')).toHaveCount(0, { timeout: 10000 });
    expect(real(errors)).toEqual([]);
  });

  test('an HTML deck: only the Pencil draws — fingers swipe on and pinch with a tool in hand — unless "Fingers draw", which is kept; the screen kept on', async ({ page }) => {
    const errors = collectErrors(page);
    // the wake lock, recorded (headless Chromium refuses the real one)
    await page.addInitScript(() => {
      const rec = { asked: 0, released: 0 };
      (window as unknown as { __wl: typeof rec }).__wl = rec;
      Object.defineProperty(navigator, 'wakeLock', { configurable: true, value: { request: async () => {
        rec.asked++;
        const s = Object.assign(new EventTarget(), { released: false, type: 'screen', release: async () => { if (!s.released) { s.released = true; rec.released++; } } });
        return s;
      } } });
    });
    const wl = () => page.evaluate(() => (window as unknown as { __wl: { asked: number; released: number } }).__wl);
    await login(page);
    await page.goto(`/#/${PROJECT}/talk/index.html`);
    await page.frameLocator('.dl-frame').locator('section.slide').first().waitFor({ timeout: 30000 });
    await page.waitForTimeout(800);
    const pres = page.frameLocator('.dl-presenting iframe');
    const ui = pres.locator('ol-present-ui');
    const pos = ui.locator('.pos'), bar = ui.locator('.bar');
    const strokes = ui.locator('svg.laser g.strokes path');
    const fingers = ui.locator('button[data-k="fingers"]');
    const zs = async () => (await pres.locator('html').evaluate(e => parseFloat((e as HTMLElement).style.getPropertyValue('--ol-zs')) || 1));
    const cdp = await page.context().newCDPSession(page);
    const touches = (type: string, pts: { x: number; y: number }[]) => cdp.send('Input.dispatchTouchEvent', { type, touchPoints: pts.map((p, i) => ({ x: p.x, y: p.y, id: i + 1 })) });
    const finger = async (x0: number, y0: number, dx: number, dy: number) => {
      await touches('touchStart', [{ x: x0, y: y0 }]);
      for (let i = 1; i <= 6; i++) await touches('touchMove', [{ x: x0 + dx * i / 6, y: y0 + dy * i / 6 }]);
      await touches('touchEnd', []);
    };
    const pen = (type: string, x: number, y: number) => cdp.send('Input.dispatchMouseEvent', { type, x, y, button: 'left', buttons: type === 'mouseReleased' ? 0 : 1, clickCount: 1, force: 0.5, pointerType: 'pen' });
    const present = async () => {
      await page.locator('[data-dl-present]').click();
      await expect(pos).toHaveText('1 / 2', { timeout: 20000 });
      await page.waitForTimeout(400);
    };
    await present();
    await expect.poll(async () => (await wl()).asked).toBeGreaterThan(0);
    const box = (await page.locator('.dl-presenting iframe').boundingBox())!;
    const cx = box.x + box.width / 2, cy = box.y + box.height / 2;
    // the pen from the bar (a tap brings it)
    await page.touchscreen.tap(cx, cy);
    await expect(bar).toHaveClass(/show/);
    await expect(fingers).toBeVisible();
    await expect(fingers).toHaveAttribute('aria-pressed', 'false');
    await ui.locator('button[data-k="pen"]').tap();
    await expect(pres.locator('html')).toHaveClass(/olpk-drawing/);
    // a finger's swipe goes on and back, drawing nothing
    await finger(cx + 150, cy, -300, 4);
    await expect(pos).toHaveText('2 / 2');
    await finger(cx - 150, cy, 300, 4);
    await expect(pos).toHaveText('1 / 2');
    await expect(strokes).toHaveCount(0);
    // two fingers zoom
    await touches('touchStart', [{ x: cx - 50, y: cy }, { x: cx + 50, y: cy }]);
    for (let i = 1; i <= 8; i++) await touches('touchMove', [{ x: cx - 50 - i * 15, y: cy }, { x: cx + 50 + i * 15, y: cy }]);
    await touches('touchEnd', []);
    await expect.poll(zs).toBeGreaterThan(1.5);
    await expect(strokes).toHaveCount(0);
    await page.keyboard.press('0');
    await expect.poll(zs).toBe(1);
    // the Pencil draws, and does not go on
    await pen('mousePressed', cx - 100, cy - 40);
    for (let i = 1; i <= 10; i++) await pen('mouseMoved', cx - 100 + i * 20, cy - 40 + i * 6);
    await pen('mouseReleased', cx + 100, cy + 20);
    await expect(strokes).toHaveCount(1);
    await page.waitForTimeout(500);
    await expect(pos).toHaveText('1 / 2');
    // "Fingers draw": now a finger draws with the pen in hand
    await page.touchscreen.tap(cx, cy + 100);
    await expect(bar).toHaveClass(/show/);
    await fingers.tap();
    await expect(fingers).toHaveAttribute('aria-pressed', 'true');
    await finger(cx - 100, cy + 80, 200, 30);
    await expect(strokes).toHaveCount(2);
    await expect(pos).toHaveText('1 / 2');
    await page.keyboard.press('Escape');
    await expect(pres.locator('html')).not.toHaveClass(/olpk-drawing/);
    await page.keyboard.press('Escape');
    await expect(page.locator('.dl-presenting')).toHaveCount(0, { timeout: 10000 });
    await expect.poll(async () => (await wl()).released).toBeGreaterThan(0);
    // the next presentation: still on (the frame has no storage: the editor kept it)
    await present();
    await expect(fingers).toHaveAttribute('aria-pressed', 'true');
    await page.keyboard.press('Escape');
    await expect(page.locator('.dl-presenting')).toHaveCount(0, { timeout: 10000 });
    expect(real(errors)).toEqual([]);
  });
});
