/** Rebuild three NASA Earth-at-Night 2012 reference slides using visible OverLyX canvas tools only. */
import { test, expect, type Page, type Locator } from '@playwright/test';
import { copyFileSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { login, userCredentials, PROJECTS_DIR } from './helpers';

const RUN = process.env.OVERLYX_NASA_RUN ?? new Date().toISOString().replace(/[-:.TZ]/g, '').slice(0, 14);
const NAME = `earth-at-night-2012-recreation-${RUN}`;
const PROJECT = `luna4/${NAME}`;
const FILE = path.join(PROJECTS_DIR, 'luna4', NAME, 'slides', 'index.html');
const EVIDENCE = path.resolve(`scratch/slide-audit/evidence/nasa-earth-at-night/${RUN}`);
const REFS = path.resolve('scratch/slide-audit/reference');
const CREDIT = 'NASA Earth Observatory image by Robert Simmon, using Suomi NPP VIIRS data provided courtesy of Chris Elvidge (NOAA National Geophysical Data Center). Suomi NPP is the result of a partnership between NASA, NOAA, and the Department of Defense.';
const frame = (page: Page) => page.frameLocator('.dl-frame');
const slides = (page: Page) => frame(page).locator('section.slide');
const rail = (page: Page) => page.frameLocator('.dl-railframe').locator('section.slide');
const source = () => readFileSync(FILE, 'utf8');

async function gotoSlide(page: Page, n: number): Promise<void> {
  await rail(page).nth(n).click();
  await expect(slides(page).nth(n)).toBeVisible();
}

async function point(page: Page, n: number, x: number, y: number): Promise<{ x: number; y: number }> {
  const b = (await slides(page).nth(n).boundingBox())!;
  const k = b.width / 1280;
  return { x: b.x + x * k, y: b.y + y * k };
}

async function chooseColor(page: Page, button: string, color: string): Promise<void> {
  await page.locator(`[data-tb="${button}"]`).click();
  await page.locator(`[data-color-grid] [data-color="${color}"]`).last().click();
}

async function typeOver(target: Locator, page: Page, text: string): Promise<void> {
  await target.dblclick();
  await page.keyboard.press('Control+a');
  await page.keyboard.type(text, { delay: 0 });
  await page.keyboard.press('Escape');
}

async function styleText(page: Page, target: Locator, color: string, sizePt?: number): Promise<void> {
  await page.locator('[data-tb="dk-select"]').click();
  await target.click();
  if (sizePt !== undefined) {
    const size = page.locator('[data-dk-size] input').last();
    if (await size.count()) { await size.fill(String(sizePt)); await size.press('Enter'); }
  }
  await chooseColor(page, 'dk-color', color);
}

async function setSlideBackground(page: Page, color = '#073763'): Promise<void> {
  await page.locator('[data-tb="dk-bg"]').click();
  await page.locator(`[data-color-grid] [data-color="${color}"]`).click();
}

async function addText(page: Page, n: number, x: number, y: number, text: string, opts: { color?: string; size?: number } = {}): Promise<void> {
  await page.locator('[data-tb="dk-text"]').click();
  const p = await point(page, n, x, y);
  await page.mouse.click(p.x, p.y);
  await page.keyboard.type(text, { delay: 0 });
  await page.keyboard.press('Escape');
  const item = frame(page).getByText(text, { exact: true }).last();
  await expect(item).toBeVisible();
  await styleText(page, item, opts.color ?? '#ffffff', opts.size);
}

async function addArrow(page: Page, n: number, from: [number, number], to: [number, number]): Promise<void> {
  await page.locator('[data-tb="dk-lines"]').click();
  await page.locator('[data-palette="dk-lines"] .tb-pal-item[title="Arrow"]').click();
  const a = await point(page, n, from[0], from[1]), b = await point(page, n, to[0], to[1]);
  await page.mouse.move(a.x, a.y); await page.mouse.down(); await page.mouse.move(b.x, b.y, { steps: 6 }); await page.mouse.up();
  await expect(page.locator('[data-tb="dk-linecolor"]')).toBeVisible();
  await chooseColor(page, 'dk-linecolor', '#ffd966');
}

async function uploadFigure(page: Page, n: number, file: string, height = 720): Promise<void> {
  await gotoSlide(page, n);
  const [chooser] = await Promise.all([
    page.waitForEvent('filechooser'),
    page.locator('[data-tb="dk-image"]').click(),
  ]);
  await chooser.setFiles(path.join(REFS, file));
  const img = slides(page).nth(n).locator('img').last();
  await expect(img).toBeVisible({ timeout: 15000 });
  await img.click();

  // Place and resize the selected image with real pointer gestures. Each source figure's aspect
  // ratio matches its intended region (global 2:1; US/Europe 16:9); images remain individual files.
  // Do this before sending it behind existing text, otherwise the old starter text can intercept
  // the move gesture even though the picture itself is selected.
  let b = (await img.boundingBox())!;
  const s = (await slides(page).nth(n).boundingBox())!;
  const scale = s.width / 1280;
  const target = { x: s.x, y: s.y + (720 - height) * scale / 2, width: 1280 * scale, height: height * scale };
  const dx = target.x - b.x, dy = target.y - b.y;
  await page.mouse.move(b.x + b.width / 2, b.y + b.height / 2);
  await page.mouse.down();
  await page.mouse.move(b.x + b.width / 2 + dx, b.y + b.height / 2 + dy, { steps: 6 });
  await page.mouse.up();
  b = (await img.boundingBox())!;
  const end = { x: target.x + target.width, y: target.y + target.height };
  await page.mouse.move(b.x + b.width - 1, b.y + b.height - 1);
  await page.mouse.down();
  await page.mouse.move(end.x, end.y, { steps: 12 });
  await page.mouse.up();
  const fitted = (await img.boundingBox())!;
  writeFileSync(path.join(EVIDENCE, `image-${n + 1}-geometry.json`), JSON.stringify({ source: file, slide: s, fitted, target, scale }, null, 2));
  await expect(page.locator('[data-tb="dk-arrange"]')).toBeVisible();
  await page.locator('[data-tb="dk-arrange"]').click();
  await page.locator('[data-palette="dk-arrange"] .tb-pal-item', { hasText: 'Send to back' }).click();
  await page.keyboard.press('Escape');
  await expect.poll(() => source(), { timeout: 20000 }).toContain(path.basename(file, '.jpg'));
}

async function notesFor(page: Page, text: string): Promise<void> {
  const notes = page.locator('[data-dl-notes]');
  const show = page.locator('[data-dl-notes-show]');
  if (!(await notes.isVisible()) && await show.count()) await show.click();
  await expect(notes).toBeVisible();
  await notes.fill(text);
  await notes.blur();
  await expect.poll(() => source(), { timeout: 15000 }).toContain('NOAA National Geophysical Data Center');
}

test('GUI-create editable NASA Earth at Night 2012 triptych and retain PDF/native state', async ({ page, context }, testInfo) => {
  test.setTimeout(300_000);
  page.setDefaultTimeout(10000);
  page.setDefaultNavigationTimeout(30000);
  mkdirSync(EVIDENCE, { recursive: true });
  const browserErrors: string[] = [];
  page.on('pageerror', e => browserErrors.push(`pageerror: ${e.message}`));
  page.on('console', m => { if (m.type() === 'error') browserErrors.push(`console: ${m.text()}`); });
  await page.setViewportSize({ width: 1600, height: 1000 });
  await login(page, userCredentials('luna4'), { ui: 'default' });

  // Create a genuinely new deck through the visible New workflow; no HTML/code view or API seed.
  await page.locator('[data-new-project]').click();
  await page.locator('[data-new-kind="deck"]').click();
  await page.locator('[data-new-name]').fill(NAME);
  await page.locator('[data-new-create]').click();
  await slides(page).first().waitFor({ timeout: 30000 });
  await expect(rail(page)).toHaveCount(2);
  await expect.poll(() => source(), { timeout: 20000 }).toContain('<meta name="overlyx" content="deck">');
  await page.locator('[data-dl-zoom]').selectOption('fit');

  // Extend the deck using the slide-rail toolbar.
  await page.locator('[data-dl-newslide]').click();
  await expect(rail(page)).toHaveCount(3);

  // Prepare shared dark NASA-night palette, then upload official regional figures one at a time.
  for (let n = 0; n < 3; n++) { await gotoSlide(page, n); await setSlideBackground(page); }
  await uploadFigure(page, 0, 'earth-global-nasa.jpg', 640);
  await uploadFigure(page, 1, 'earth-us-nasa.jpg', 720);
  await uploadFigure(page, 2, 'earth-europe-nasa.jpg', 720);

  // Give each slide an editable title and a compact visible source line, then add native labels,
  // arrows and a three-step method rail as ordinary OverLyX objects.
  await gotoSlide(page, 0);
  const title0 = slides(page).nth(0).locator('h1').first();
  await typeOver(title0, page, 'Earth at Night, 2012');
  await styleText(page, title0, '#ffffff', 30);
  await addText(page, 0, 56, 575, 'VIIRS DAY/NIGHT BAND  →  9 APRIL + 13 OCTOBER 2012  →  COMPOSITE ON MODIS BLUE MARBLE', { color: '#ffd966', size: 13 });
  await addText(page, 0, 56, 685, 'NASA Earth Observatory · Robert Simmon · VIIRS data: Chris Elvidge / NOAA NGDC · NASA / NOAA / DoD partnership', { color: '#ffffff', size: 9 });
  await gotoSlide(page, 0);
  await notesFor(page, `${CREDIT} Source facts: Suomi NPP VIIRS Day/Night Band; data collected over nine days in April 2012 and thirteen days in October 2012; 312 orbits and 2.5 terabytes; mapped over MODIS Blue Marble imagery. Reconstruction, not the complete original deck.`);
  await slides(page).nth(0).screenshot({ path: path.join(EVIDENCE, 'slide-1-global.png') });

  await gotoSlide(page, 1);
  const title1 = slides(page).nth(1).locator('h1,h2').first();
  await typeOver(title1, page, 'United States · coastlines and corridors');
  await styleText(page, title1, '#ffffff', 28);
  await addText(page, 1, 875, 105, 'GREAT LAKES', { color: '#ffd966', size: 16 });
  await addArrow(page, 1, [925, 145], [810, 250]);
  await addText(page, 1, 945, 405, 'ATLANTIC COAST', { color: '#ffd966', size: 16 });
  await addArrow(page, 1, [1080, 438], [1130, 365]);
  await addText(page, 1, 55, 670, 'U.S. regional view · VIIRS composite, 2012 · Bright clusters are a visual reading, not an energy measurement.', { color: '#ffffff', size: 12 });
  await gotoSlide(page, 1);
  await notesFor(page, `${CREDIT} This slide labels visible clusters as geographic orientation only; it does not quantify population, electricity use, or emissions.`);
  await slides(page).nth(1).screenshot({ path: path.join(EVIDENCE, 'slide-2-us.png') });

  await gotoSlide(page, 2);
  const title2 = slides(page).nth(2).locator('h1,h2').first();
  await typeOver(title2, page, 'Europe · a closely linked nightscape');
  await styleText(page, title2, '#ffffff', 28);
  await addText(page, 2, 60, 150, 'NORTH SEA', { color: '#ffd966', size: 16 });
  await addArrow(page, 2, [185, 180], [510, 265]);
  await addText(page, 2, 780, 310, 'CENTRAL EUROPE', { color: '#ffd966', size: 16 });
  await addArrow(page, 2, [780, 345], [680, 380]);
  await addText(page, 2, 495, 555, 'PO VALLEY', { color: '#ffd966', size: 16 });
  await addArrow(page, 2, [570, 565], [615, 500]);
  await addText(page, 2, 55, 670, 'Europe’s dense clusters contrast with the U.S. corridors shown before; a qualitative reading of this composite.', { color: '#ffffff', size: 12 });
  await gotoSlide(page, 2);
  await notesFor(page, `${CREDIT} The comparison is a qualitative visual interpretation of this 2012 composite, not a measured comparison of energy or population.`);
  await slides(page).nth(2).screenshot({ path: path.join(EVIDENCE, 'slide-3-europe.png') });

  // Confirm saved editable state through the server-backed file, while retaining a native HTML copy.
  await expect.poll(() => source(), { timeout: 20000 }).toContain('PO VALLEY');
  const html = source();
  expect((html.match(/<section class="slide"/g) ?? []).length).toBe(3);
  expect(html).toContain('earth-global-nasa.jpg');
  expect(html).toContain('earth-us-nasa.jpg');
  expect(html).toContain('earth-europe-nasa.jpg');
  expect(html).toContain('VIIRS DAY/NIGHT BAND');
  expect(html).toContain('Robert Simmon');
  expect(html).not.toContain('<script>alert');
  copyFileSync(FILE, path.join(EVIDENCE, 'editable-deck.html'));

  // Present through the product's visible control, verify navigation, then exit to edit mode.
  await gotoSlide(page, 0);
  await page.locator('[data-dl-present]').click();
  const presenter = page.frameLocator('.dl-presenting iframe');
  await expect(presenter.locator('section.slide[data-ol-current]')).toHaveCount(1, { timeout: 15000 });
  await expect(presenter.locator('section.slide[data-ol-current]')).toContainText('Earth at Night, 2012');
  await page.keyboard.press('ArrowRight');
  await expect(presenter.locator('section.slide[data-ol-current]')).toContainText('United States');
  await page.keyboard.press('Escape');
  await expect(page.locator('.dl-presenting')).toHaveCount(0, { timeout: 10000 });

  // Export with the visible Download > PDF command; retain the returned PDF and rendered pages.
  await page.locator('[data-dl-download]').click();
  const pdfOption = page.locator('.ctx-menu').getByText('PDF', { exact: true });
  const [pdfResponse] = await Promise.all([
    page.waitForResponse(r => r.url().includes('/deliverable-pdf') && r.status() === 200),
    pdfOption.click(),
  ]);
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

  // Reopen the retained project and verify object count, notes, images and titles remain editable.
  await page.reload();
  await expect(slides(page).first()).toBeVisible({ timeout: 30000 });
  await expect(rail(page)).toHaveCount(3);
  await gotoSlide(page, 0);
  await expect(slides(page).nth(0)).toContainText('Earth at Night, 2012');
  await expect(slides(page).nth(0).locator('img')).toHaveCount(1);
  await gotoSlide(page, 1);
  await expect(slides(page).nth(1)).toContainText('GREAT LAKES');
  await expect(slides(page).nth(1).locator('img')).toHaveCount(1);
  await gotoSlide(page, 2);
  await expect(slides(page).nth(2)).toContainText('PO VALLEY');
  await expect(slides(page).nth(2).locator('img')).toHaveCount(1);
  expect(browserErrors).toEqual([]);
  await page.screenshot({ path: path.join(EVIDENCE, 'editor-after-reopen.png') });
  await testInfo.attach('nasa-triptych-project-path', { body: Buffer.from(`${PROJECT}\n${FILE}\n${pdfPath}\n`), contentType: 'text/plain' });
});
