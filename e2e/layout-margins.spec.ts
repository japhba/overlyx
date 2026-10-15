/** Fixed template margins are editor-only guides; custom guides remain independently movable. */
import { test, expect, type Page } from '@playwright/test';
import { readFileSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { login, BASE_URL, PROJECTS_DIR, fillDialog, dialogLocator } from './helpers';

const RUN = Date.now().toString(36);
const NAME = `e2e-layout-margins-${RUN}`;
const PROJECT = `admin/${NAME}`;
const FOLDER = 'talk';
const FILE = `${PROJECTS_DIR}/${PROJECT}/${FOLDER}/index.html`;
const fileText = () => readFileSync(FILE, 'utf8');
const DECK = `<!doctype html><html><head><meta charset="utf-8"><meta name="overlyx" content="deck"><title>Layout margins</title>
<style>body{margin:0;background:#dfe3ea;font-family:system-ui,sans-serif}.slide{width:1280px;height:720px;position:relative;overflow:hidden;background:white;margin:0 auto 40px}</style></head>
<body data-ol-layout-margins="72px 96px"><section class="slide"><h1 style="position:absolute;left:200px;top:120px;margin:0">Margin-safe content</h1>
<div id="box" style="position:absolute;left:140px;top:240px;width:120px;height:80px;background:#cce">Box</div></section>
<section class="slide"><h2 style="position:absolute;left:96px;top:72px;margin:0">Second slide</h2></section></body></html>`;

const frame = (page: Page) => page.frameLocator('.dl-frame');
const slide = (page: Page) => frame(page).locator('section.slide').first();

test.afterAll(() => rmSync(`${PROJECTS_DIR}/${PROJECT}`, { recursive: true, force: true }));

test('template margin guides show and snap, are not draggable/resettable, zoom with the canvas, and never enter export', async ({ page }, testInfo) => {
  await login(page);
  await page.request.post(BASE_URL + '/api/projects', { data: { name: NAME } });
  mkdirSync(`${PROJECTS_DIR}/${PROJECT}/${FOLDER}`, { recursive: true });
  writeFileSync(FILE, DECK);
  await page.request.get('/api/projects');
  await page.goto(`/#/${PROJECT}/${FOLDER}/index.html`);
  await expect(slide(page)).toBeVisible({ timeout: 30000 });
  await page.waitForTimeout(800);

  await page.locator('[data-tb="dk-guides"]').click();
  await page.locator('[data-palette="dk-guides"] [data-guides-item="Show guides"]').click();
  expect(fileText()).toContain('<body data-ol-layout-margins="72px 96px">');
  await page.screenshot({ path: testInfo.outputPath('layout-margin-guides.png'), fullPage: true });

  const bounds = (await slide(page).boundingBox())!;
  const k = bounds.width / 1280;
  const at = (x: number, y: number) => ({ x: bounds.x + x * k, y: bounds.y + y * k });
  const initial = at(200, 280), target = at(160, 280); // left edge approaches the 96 px safe margin
  await page.mouse.move(initial.x, initial.y); await page.mouse.down(); await page.mouse.move(target.x, target.y, { steps: 5 }); await page.mouse.up();
  await expect.poll(() => /id="box" style="([^"]*)"/.exec(fileText())?.[1], { timeout: 10000 }).toContain('left: 96px');

  // Pressing and dragging a fixed margin line in blank canvas cannot select it as a draggable guide.
  const lineStart = at(96, 400), lineEnd = at(150, 400);
  await page.mouse.move(lineStart.x, lineStart.y); await page.mouse.down(); await page.mouse.move(lineEnd.x, lineEnd.y, { steps: 5 }); await page.mouse.up();
  expect(fileText()).not.toContain('data-ol-guides');
  await page.locator('.dl-zoom').selectOption('200');
  await page.locator('.dl-zoom').selectOption('fit');

  const pdf = await page.request.get(`${BASE_URL}/api/projects/${encodeURIComponent(PROJECT)}/deliverable-pdf?path=${encodeURIComponent(`${FOLDER}/index.html`)}`);
  expect(pdf.status()).toBe(200);
  const bytes = await pdf.body();
  expect(bytes.subarray(0, 5).toString()).toBe('%PDF-');
  const plain = execFileSync('pdftotext', ['-', '-'], { input: bytes }).toString('utf8');
  expect(plain).toContain('Margin-safe content');
  expect(plain).not.toContain('Fixed layout margin');
  expect(fileText()).toContain('<body data-ol-layout-margins="72px 96px">');
  expect(fileText()).not.toContain('class="uguide');

  // The visible toolbar is also available on touch devices, without a right-click.
  const pick = async (label: string) => {
    await page.locator('[data-tb="dk-guides"]').click();
    await page.locator('[data-palette="dk-guides"]').getByText(label, { exact: true }).click();
  };
  await pick('Layout margins (every slide)…');
  await fillDialog(page, '10% 8%', { submit: false });
  await dialogLocator(page).getByRole('button', { name: 'Set margins', exact: true }).click();
  await expect.poll(fileText).toContain('<body data-ol-layout-margins="10% 8%">');
  await pick('Layout margins (this slide)…');
  await fillDialog(page, '90% 90%', { submit: false });
  await expect(dialogLocator(page).getByRole('button', { name: 'Set margins', exact: true })).toBeDisabled();
  await expect(dialogLocator(page)).toContainText('leave space inside the slide');
  expect(fileText()).not.toContain('90% 90%');
  await fillDialog(page, '48px 64px', { submit: false });
  await dialogLocator(page).getByRole('button', { name: 'Set margins', exact: true }).click();
  await expect.poll(fileText).toContain('<section class="slide" data-ol-layout-margins="48px 64px">');
  await pick('Use master margins on this slide');
  await expect.poll(fileText).not.toContain('data-ol-layout-margins="48px 64px"');
  await pick('Layout margins (this slide)…');
  await fillDialog(page, '', { submit: false });
  await dialogLocator(page).getByRole('button', { name: 'Set margins', exact: true }).click();
  await expect.poll(fileText).toContain('<section class="slide" data-ol-layout-margins="">');
  await pick('Use master margins on this slide');
  await expect.poll(fileText).not.toContain('<section class="slide" data-ol-layout-margins="">');
  await pick('Remove custom guides');
  await expect.poll(fileText).toContain('data-ol-guides=""');
  expect(fileText()).toContain('data-ol-layout-margins="10% 8%"');
  await page.reload();
  await expect(slide(page)).toBeVisible({ timeout: 30000 });
  expect(fileText()).toContain('data-ol-layout-margins="10% 8%"');
});
