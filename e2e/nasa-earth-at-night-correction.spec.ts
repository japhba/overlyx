/** Correct the retained NASA recreation using only visible editor controls. */
import { test, expect, type Page } from '@playwright/test';
import { copyFileSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { login, userCredentials, PROJECTS_DIR } from './helpers';

const KEY = 'luna4/earth-at-night-2012-recreation-20261013-gui-triptych-r2';
const FILE = path.join(PROJECTS_DIR, KEY, 'slides', 'index.html');
const EVIDENCE = path.resolve('scratch/slide-audit/evidence/nasa-earth-at-night/20261013-corrective-gui');
const FINAL_EVIDENCE = path.resolve('scratch/slide-audit/evidence/nasa-earth-at-night/20261013-corrective-gui-final');
const frame = (page: Page) => page.frameLocator('.dl-frame');
const slides = (page: Page) => frame(page).locator('section.slide');
const rail = (page: Page) => page.frameLocator('.dl-railframe').locator('section.slide');
const source = () => readFileSync(FILE, 'utf8');
const slidesSource = (html: string, n: number) => [...html.matchAll(/<section class="slide"[\s\S]*?<\/section>/g)][n]?.[0] ?? '';

async function gotoSlide(page: Page, n: number) {
  await rail(page).nth(n).click();
  await expect(slides(page).nth(n)).toBeVisible();
}

async function objectRows(page: Page) {
  const button = page.locator('[data-tb="dk-objects"]');
  if (!/(^|\s)on(\s|$)/.test((await button.getAttribute('class')) ?? '')) await button.click();
  return page.locator('[data-dl-objects] [data-obj-row]');
}

async function moveAndFitImage(page: Page, n: number, tag: string, target: { x: number; y: number; width: number; height: number }) {
  await gotoSlide(page, n);
  const img = slides(page).nth(n).locator('img').first();
  await expect(img).toBeVisible();
  const rows = await objectRows(page);
  const row = rows.filter({ hasText: 'Picture' });
  await expect(row).toHaveCount(1);
  await row.click();
  await expect(row).toHaveClass(/sel/);
  const slide = (await slides(page).nth(n).boundingBox())!;
  let box = (await img.boundingBox())!;
  // The Objects pane selection routes key nudges to the picture even where old template objects
  // cover the canvas. Use deliberate 30 ms GUI key intervals; read the actual saved bounds again.
  const scale = slide.width / 1280;
  const logical = { x: (box.x - slide.x) / scale, y: (box.y - slide.y) / scale };
  const nx = Math.round((target.x - logical.x) / 10), ny = Math.round((target.y - logical.y) / 10);
  for (let i = 0; i < Math.abs(nx); i++) { await page.keyboard.press(nx < 0 ? 'Shift+ArrowLeft' : 'Shift+ArrowRight'); await page.waitForTimeout(30); }
  for (let i = 0; i < Math.abs(ny); i++) { await page.keyboard.press(ny < 0 ? 'Shift+ArrowUp' : 'Shift+ArrowDown'); await page.waitForTimeout(30); }
  box = (await img.boundingBox())!;
  const targetRight = slide.x + (target.x + target.width) * scale;
  const targetBottom = slide.y + (target.y + target.height) * scale;
  // Resize from the selected picture's visible south-east handle to an aspect-matched target.
  await page.mouse.move(box.x + box.width, box.y + box.height);
  await page.mouse.down();
  await page.mouse.move(targetRight, targetBottom, { steps: 10 });
  await page.mouse.up();
  const fitted = (await img.boundingBox())!;
  writeFileSync(path.join(EVIDENCE, `image-${n + 1}-geometry.json`), JSON.stringify({ tag, slide, before: box, fitted, target, targetScreen: { right: targetRight, bottom: targetBottom }, nudgeCount: { x: nx, y: ny }, savedCSS: source().match(new RegExp(`<img src="images/${tag}"[^>]*style="([^"]+)"`))?.[1] }, null, 2));
  await expect.poll(() => source(), { timeout: 20000 }).toContain(tag);
}

async function deleteVisibleObject(page: Page, n: number, label: string) {
  await gotoSlide(page, n);
  const rows = await objectRows(page);
  const row = rows.filter({ hasText: label }).first();
  if (await row.count()) {
    await row.click();
    await page.keyboard.press('Delete');
  }
}

test('GUI-correct the retained NASA triptych, reopen and export 3-page PDF', async ({ page, context }) => {
  test.setTimeout(240000);
  page.setDefaultTimeout(10000);
  mkdirSync(EVIDENCE, { recursive: true });
  const errors: string[] = [];
  page.on('pageerror', e => errors.push(`pageerror: ${e.message}`));
  page.on('console', m => { if (m.type() === 'error') errors.push(`console: ${m.text()}`); });
  await page.setViewportSize({ width: 1600, height: 1000 });
  await login(page, userCredentials('luna4'), { ui: 'default' });
  await page.goto(`/#/${KEY}/slides/index.html`);
  await expect(slides(page).first()).toBeVisible({ timeout: 30000 });
  await page.locator('[data-dl-zoom]').selectOption('fit');

  if (process.env.OVERLYX_NASA_EXPORT_ONLY === '1') {
    mkdirSync(FINAL_EVIDENCE, { recursive: true });
    const html = source();
    expect((html.match(/<section class="slide"/g) ?? []).length).toBe(3);
    for (const name of ['earth-global-nasa.jpg', 'earth-us-nasa.jpg', 'earth-europe-nasa.jpg']) expect(html).toContain(name);
    expect(html).not.toContain('width: 400px; height: 400px; border-radius: 24px');
    expect(html).not.toContain('One message per slide');
    expect(html).toContain('NOAA National Geophysical Data Center');
    copyFileSync(FILE, path.join(FINAL_EVIDENCE, 'editable-deck.html'));
    for (let n = 0; n < 3; n++) {
      await gotoSlide(page, n);
      await expect(slides(page).nth(n).locator('img')).toHaveCount(1);
      await slides(page).nth(n).screenshot({ path: path.join(FINAL_EVIDENCE, `slide-${n + 1}.png`) });
      const image = /<img src="images\/([^"]+)"[^>]*style="([^"]+)"/.exec(slidesSource(html, n));
      writeFileSync(path.join(FINAL_EVIDENCE, `image-${n + 1}-readback.json`), JSON.stringify({ image: image?.[1], savedStyle: image?.[2] }, null, 2));
    }
    await gotoSlide(page, 0);
    await page.locator('[data-dl-present]').click();
    const presenter = page.frameLocator('.dl-presenting iframe');
    await expect(presenter.locator('section.slide[data-ol-current]')).toContainText('Earth at Night, 2012');
    await page.keyboard.press('ArrowRight');
    await expect(presenter.locator('section.slide[data-ol-current]')).toContainText('United States');
    await page.keyboard.press('Escape');
    await expect(page.locator('.dl-presenting')).toHaveCount(0, { timeout: 10000 });

    // Buffer the real GUI export response before the popup navigation can invalidate CDP bodies.
    let pdfBytes: Buffer | undefined;
    let pdfStatus = 0;
    let finishCapture!: () => void;
    const captured = new Promise<void>(resolve => { finishCapture = resolve; });
    await context.route('**/deliverable-pdf*', async route => {
      const response = await route.fetch();
      pdfStatus = response.status();
      pdfBytes = await response.body();
      finishCapture();
      await route.fulfill({ response, body: pdfBytes });
    });
    await page.locator('[data-dl-download]').click();
    await page.locator('.ctx-menu').getByText('PDF', { exact: true }).click();
    await Promise.race([captured, page.waitForTimeout(45000).then(() => { throw new Error('Timed out waiting for the GUI PDF response'); })]);
    expect(pdfStatus).toBe(200);
    expect(pdfBytes?.subarray(0, 4).toString('ascii')).toBe('%PDF');
    const pdfPath = path.join(FINAL_EVIDENCE, 'earth-at-night-2012-triptych.pdf');
    writeFileSync(pdfPath, pdfBytes!);
    const info = execFileSync('pdfinfo', [pdfPath], { encoding: 'utf8' });
    expect(info).toMatch(/Pages:\s+3/);
    const pdfText = execFileSync('pdftotext', [pdfPath, '-'], { encoding: 'utf8' });
    for (const text of ['Earth at Night, 2012', 'United States', 'PO VALLEY', 'NOAA']) expect(pdfText).toContain(text);
    writeFileSync(path.join(FINAL_EVIDENCE, 'pdfinfo.txt'), info);
    writeFileSync(path.join(FINAL_EVIDENCE, 'pdf-text.txt'), pdfText);
    execFileSync('pdftoppm', ['-png', '-r', '120', pdfPath, path.join(FINAL_EVIDENCE, 'pdf-slide')], { stdio: 'ignore' });

    await page.reload();
    await expect(slides(page).first()).toBeVisible({ timeout: 30000 });
    for (const [n, label] of [[0, 'Earth at Night, 2012'], [1, 'GREAT LAKES'], [2, 'PO VALLEY']] as const) {
      await gotoSlide(page, n);
      await expect(slides(page).nth(n)).toContainText(label);
      await expect(slides(page).nth(n).locator('img')).toHaveCount(1);
    }
    expect(errors).toEqual([]);
    await page.screenshot({ path: path.join(FINAL_EVIDENCE, 'editor-after-reopen.png') });
    return;
  }

  // Enlarge and align the three separately uploaded official figure objects without stretching.
  await moveAndFitImage(page, 0, 'earth-global-nasa.jpg', { x: 40, y: 65, width: 1200, height: 600 });
  await moveAndFitImage(page, 1, 'earth-us-nasa.jpg', { x: 40, y: 24, width: 1200, height: 675 });
  await moveAndFitImage(page, 2, 'earth-europe-nasa.jpg', { x: 40, y: 24, width: 1200, height: 675 });

  // Remove only the unused template copy and card; retain the authored labels and arrows.
  await deleteVisibleObject(page, 0, 'Your name');
  for (const label of ['One message per slide', 'Math is TeX', 'Pictures carry the argument', 'Shape']) {
    await deleteVisibleObject(page, 2, label);
  }
  await expect.poll(() => source(), { timeout: 20000 }).not.toContain('Your name · Venue · Date');
  await expect.poll(() => source(), { timeout: 20000 }).not.toContain('One message per slide');
  await expect.poll(() => source(), { timeout: 20000 }).not.toContain('width: 400px; height: 400px; border-radius: 24px');

  // Visually verify after these GUI edits, and preserve unique evidence before export/reload.
  for (let n = 0; n < 3; n++) await gotoSlide(page, n);
  await gotoSlide(page, 0); await slides(page).nth(0).screenshot({ path: path.join(EVIDENCE, 'slide-1-global.png') });
  await gotoSlide(page, 1); await slides(page).nth(1).screenshot({ path: path.join(EVIDENCE, 'slide-2-us.png') });
  await gotoSlide(page, 2); await slides(page).nth(2).screenshot({ path: path.join(EVIDENCE, 'slide-3-europe.png') });
  await expect.poll(() => source(), { timeout: 20000 }).toContain('NOAA National Geophysical Data Center');
  copyFileSync(FILE, path.join(EVIDENCE, 'editable-deck.html'));

  await gotoSlide(page, 0);
  await page.locator('[data-dl-present]').click();
  const presenter = page.frameLocator('.dl-presenting iframe');
  await expect(presenter.locator('section.slide[data-ol-current]')).toContainText('Earth at Night, 2012');
  await page.keyboard.press('ArrowRight');
  await expect(presenter.locator('section.slide[data-ol-current]')).toContainText('United States');
  await page.keyboard.press('Escape');
  await expect(page.locator('.dl-presenting')).toHaveCount(0, { timeout: 10000 });

  // Listen at context scope before the menu opens a new PDF page.
  const pdfResponsePromise = context.waitForEvent('response', r => r.url().includes('/deliverable-pdf') && r.status() === 200, { timeout: 45000 });
  await page.locator('[data-dl-download]').click();
  await page.locator('.ctx-menu').getByText('PDF', { exact: true }).click();
  const pdfResponse = await pdfResponsePromise;
  const pdfPath = path.join(EVIDENCE, 'earth-at-night-2012-triptych.pdf');
  writeFileSync(pdfPath, await pdfResponse.body());
  const info = execFileSync('pdfinfo', [pdfPath], { encoding: 'utf8' });
  expect(info).toMatch(/Pages:\s+3/);
  const pdfText = execFileSync('pdftotext', [pdfPath, '-'], { encoding: 'utf8' });
  expect(pdfText).toContain('Earth at Night, 2012');
  expect(pdfText).toContain('United States');
  expect(pdfText).toContain('PO VALLEY');
  expect(pdfText).toContain('NOAA');
  writeFileSync(path.join(EVIDENCE, 'pdfinfo.txt'), info);
  writeFileSync(path.join(EVIDENCE, 'pdf-text.txt'), pdfText);
  execFileSync('pdftoppm', ['-png', '-r', '120', pdfPath, path.join(EVIDENCE, 'pdf-slide')], { stdio: 'ignore' });

  await page.reload();
  await expect(slides(page).first()).toBeVisible({ timeout: 30000 });
  for (const [n, label, image] of [[0, 'Earth at Night, 2012', 'earth-global-nasa.jpg'], [1, 'GREAT LAKES', 'earth-us-nasa.jpg'], [2, 'PO VALLEY', 'earth-europe-nasa.jpg']] as const) {
    await gotoSlide(page, n);
    await expect(slides(page).nth(n)).toContainText(label);
    await expect(slides(page).nth(n).locator('img')).toHaveCount(1);
    await expect.poll(() => source()).toContain(image);
  }
  expect(errors).toEqual([]);
  await page.screenshot({ path: path.join(EVIDENCE, 'editor-after-reopen.png') });
});
