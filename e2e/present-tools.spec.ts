/**
 * The presenting tools (app/presentkit.ts) in both presenters — an HTML deck (deliverable/runtime/
 * present.ts, in its sandboxed frame) and a layout document (editor/layout/present.ts): the laser
 * pointer from L and from the control bar, its tail fading behind the moving dot, a pressed trace
 * that fades once lifted, a drag or a click with the laser on not going on; a pinch (Ctrl + wheel)
 * zooming the slide, a click then not going on, a drag panning, `0` and Escape going back to the
 * whole slide, a second Escape ending the presentation, the arrow keys going on (unzoomed).
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
  // moving: a dot and a tail behind it, which fades once the mouse rests
  await page.mouse.move(cx - 120, cy);
  await page.mouse.move(cx + 120, cy + 40, { steps: 12 });
  await expect(ui.locator('svg.laser g.live circle.head')).toHaveCount(1);
  await expect(ui.locator('svg.laser g.live g.tail line').first()).toBeAttached();
  await expect(ui.locator('svg.laser g.live g.tail line')).toHaveCount(0, { timeout: 3000 });
  await expect(ui.locator('svg.laser g.live circle.head')).toHaveCount(1);
  // pressed and dragged: a trace like the whiteboard's, held, then fading once lifted — the slide stays
  await page.mouse.down();
  await page.mouse.move(cx - 60, cy - 60, { steps: 10 });
  await expect(ui.locator('svg.laser g.live g.held path.glow')).toHaveCount(1);
  await expect(ui.locator('svg.laser g.live g.held path.core')).toHaveCount(1);
  await page.mouse.up();
  await expect(ui.locator('svg.laser g.trace.fade')).toHaveCount(1);
  await expect(ui.locator('svg.laser g.trace.fade')).toHaveCount(0, { timeout: 3000 });
  await page.mouse.click(cx, cy);
  await page.waitForTimeout(300);
  await expect(pos).toHaveText('1 / 2');
  // the bar (shown by moving the mouse): its laser button switches it off and on
  await page.mouse.move(cx, cy + 10);
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
  const stage = page.locator('.ol-present-stage');
  await zoom(page, page, stage, pos, { x: box.width * 0.4, y: box.height * 0.4 }, async () => /scale\((?!1\))/.test(await stage.evaluate(e => (e as HTMLElement).style.transform)));
  await expect(page.locator('.ol-present')).toHaveCount(1);
  await page.keyboard.press('Escape');
  await expect(page.locator('.ol-present')).toHaveCount(0);
  expect(real(errors)).toEqual([]);
});
