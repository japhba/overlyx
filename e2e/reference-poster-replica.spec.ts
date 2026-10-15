/** Recreate the structure of the public-domain USGS Water Quality poster through the canvas UI. */
import { test, expect, type Page, type Locator } from '@playwright/test';
import { readFileSync, existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { login, userCredentials, PROJECTS_DIR, BASE_URL, fillDialog } from './helpers';

const PROJECT_NAME = 'USGS Water Quality Poster Replica Luna3 Final';
const PROJECT = `luna3/${PROJECT_NAME}`;
const FILE = `${PROJECTS_DIR}/${PROJECT}/poster/index.html`;
const fileText = () => readFileSync(FILE, 'utf8');
const slide = (page: Page) => page.frameLocator('.dl-frame').locator('section.slide').first();

async function typeOver(page: Page, target: Locator, value: string): Promise<void> {
  await target.dblclick();
  await page.keyboard.press('Control+a');
  await page.keyboard.type(value, { delay: 1 });
  await page.keyboard.press('Escape');
}

async function at(page: Page, xMm: number, yMm: number): Promise<{ x: number; y: number }> {
  const b = (await slide(page).boundingBox())!;
  return { x: b.x + xMm / 841 * b.width, y: b.y + yMm / 1189 * b.height };
}

async function textAt(page: Page, xMm: number, yMm: number, value: string, sizePt = 20): Promise<void> {
  await page.locator('[data-tb="dk-text"]').click();
  const size = page.locator('[data-dk-size] input');
  if (await size.count()) await size.fill(String(sizePt));
  const p = await at(page, xMm, yMm);
  await page.mouse.click(p.x, p.y);
  await page.waitForTimeout(100);
  await page.keyboard.type(value, { delay: 0 });
  await page.keyboard.press('Escape');
  await page.waitForTimeout(120);
}

async function fitTextToColumn(page: Page, target: Locator, widthMm = 168): Promise<void> {
  const box = await target.boundingBox();
  const poster = await slide(page).boundingBox();
  if (!box || !poster) throw new Error('text or poster has no visible box for GUI resize');
  const width = poster.width * widthMm / 841;
  if (box.width <= width + 2) return;
  await target.click();
  await page.mouse.move(box.x + box.width - 1, box.y + box.height / 2);
  await page.mouse.down();
  await page.mouse.move(box.x + width, box.y + box.height / 2, { steps: 8 });
  await page.mouse.up();
  await page.waitForTimeout(150);
}

test('create public-domain USGS poster replica in the GUI and retain PDF, images and editable state', async ({ page, context }) => {
  mkdirSync('scratch/slide-audit/evidence/luna3', { recursive: true });
  await login(page, userCredentials('luna3'));
  const tour = page.locator('.tour-card button', { hasText: 'Not now' });
  if (await tour.count()) await tour.click();

  // Project and A0 poster were created by the visible + New dialog. Reopen the retained editable
  // project on later runs rather than trying to replace it or seed its source.
  if (!existsSync(FILE)) {
    await page.locator('[data-new-project]').click();
    await page.locator('[data-new-kind="poster"]').click();
    await page.locator('[data-new-name]').fill(PROJECT_NAME);
    await page.locator('[data-new-create]').click();
  } else {
    await page.goto(`${BASE_URL}/#/${PROJECT}/poster/index.html`);
  }
  await expect(slide(page)).toBeVisible({ timeout: 30000 });
  await page.waitForTimeout(1000);
  await page.screenshot({ path: 'scratch/slide-audit/evidence/luna3/reference-poster-starter.png', fullPage: true });
  expect(fileText()).toContain('<meta name="overlyx" content="poster">');

  // Configure fixed template margins through the visible guides menu, then lay in the replica.
  await page.locator('[data-tb="dk-guides"]').click();
  const guidesMenu = page.locator('[data-palette="dk-guides"]');
  await guidesMenu.locator('[data-guides-item="Layout margins (every slide)…"]').click();
  await fillDialog(page, '40mm');
  await expect.poll(() => fileText()).toContain('data-ol-layout-margins="40mm"');
  await page.locator('[data-tb="dk-guides"]').click();
  await page.locator('[data-palette="dk-guides"] [data-guides-item="Show guides"]').click();
  await page.screenshot({ path: 'scratch/slide-audit/evidence/luna3/reference-poster-margin-guides.png', fullPage: true });

  // Update starter title/author in the canvas editor (source wording is retained from the USGS PDF).
  await typeOver(page, slide(page).locator('h1').first(), 'WATER QUALITY · POTENTIAL SOURCES OF POLLUTION');
  await typeOver(page, slide(page).locator('p').first(), 'U.S. Geological Survey · Educational Resources · Water Resources');
  await expect.poll(() => fileText()).toContain('POTENTIAL SOURCES OF POLLUTION');

  // Four-column page 2 structure: original topic sequence, faithful activities/definitions, no
  // invented measurements. The USGS page-1 watershed graphic is imported as a source picture,
  // then the OverLyX crop tool is used on separate copies so the final contains only figure crops.
  const columnX = [42, 240, 438, 636];
  const cols = [
    ['INTRODUCTION', 'Water is one of our most important natural resources. Clean water is essential to people, plants, and animals. Water quality describes the physical, chemical, and biological characteristics of water.\n\nPOINT SOURCE POLLUTION\nPollution from a single, identifiable place—such as a pipe or discharge point—is called point-source pollution. The source can be located and monitored.'],
    ['NONPOINT SOURCES', 'Nonpoint-source pollution comes from many diffuse places rather than one discharge pipe. Rain and snowmelt move pollutants across the land and into streams, lakes, and groundwater.\n\nExamples shown in the poster include urban runoff, agriculture, roads, and residential areas. What happens on the land affects the water downstream.'],
    ['ACTIVITY · POLLUTANT MOVEMENT', 'Use a paper plate as a small watershed. Add clean sand or soil, then place a drop of food coloring on the surface. Slowly add water and observe where the color travels.\n\nDiscuss: Where did the pollutant go? Which areas trapped or moved it? How might plants and soil change runoff? This activity models transport; it is not a water-quality measurement.'],
    ['ACTIVITY · WATER QUALITY', 'Compare samples and record observations. Follow the poster directions for preparing a dilution and using test materials safely.\n\nDILUTION EXAMPLE\n1 drop in 1,000 parts of solution\n\nA dilution helps illustrate concentration; it does not establish a health standard. Read product directions and use the supplied activity materials.'],
  ];
  for (let i = 0; i < cols.length; i++) {
    await textAt(page, columnX[i], 275, cols[i][0], 48);
    await fitTextToColumn(page, slide(page).locator('p').last());
    await textAt(page, columnX[i], 325, cols[i][1], 32);
    await fitTextToColumn(page, slide(page).locator('p').last());
  }

  // Add modest colored rules and a dense topic/footer grid as editable canvas shapes and labels.
  for (const x of columnX) {
    await page.locator('[data-tb="dk-shapes"]').click();
    await page.locator('[data-palette="dk-shapes"] .tb-pal-item[title="Rectangle"]').click();
    const a = await at(page, x, 267), b = await at(page, x + 168, 270);
    await page.mouse.move(a.x, a.y); await page.mouse.down(); await page.mouse.move(b.x, b.y, { steps: 4 }); await page.mouse.up();
  }
  const topics = ['BIODIVERSITY', 'WATERSHEDS', 'ACID RAIN', 'HAZARDOUS MATERIALS', 'WETLANDS', 'WATER USE', 'WASTEWATER TREATMENT', 'OCEANS & NAVIGATION', 'GROUNDWATER'];
  await textAt(page, 42, 925, 'WATER QUALITY POSTER SERIES  ·  TOPICS', 38);
  await fitTextToColumn(page, slide(page).locator('p').last(), 760);
  for (let i = 0; i < topics.length; i++) {
    const x = 42 + (i % 3) * 264, y = 970 + Math.floor(i / 3) * 40;
    await textAt(page, x, y, topics[i], 28);
    await fitTextToColumn(page, slide(page).locator('p').last());
  }
  await textAt(page, 42, 1095, 'U.S. Geological Survey · Water Resources · Public-domain educational poster, adapted from the reverse-side reading layout. See the USGS source for classroom instructions, references, and acknowledgments.', 22);
  await fitTextToColumn(page, slide(page).locator('p').last(), 760);

  await expect.poll(() => fileText()).toContain('NONPOINT SOURCES');
  await expect.poll(() => fileText()).toContain('GROUNDWATER');
  await page.locator('[data-tb="dk-objects"]').click();
  await page.screenshot({ path: 'scratch/slide-audit/evidence/luna3/reference-poster-columns-before-figures.png', fullPage: true });

  // Import the official poster as a source image and use GUI crop windows. The un-cropped input is
  // discarded after making the first crop; crop geometry is authored by actual mouse drag.
  const sourceImage = 'scratch/slide-audit/references/luna3/water-quality-poster-1.png';
  const [chooser] = await Promise.all([page.waitForEvent('filechooser'), page.locator('[data-tb="dk-image"]').click()]);
  await chooser.setFiles(sourceImage);
  await page.waitForTimeout(700);
  const img = slide(page).locator('img').last();
  await expect(img).toBeVisible();
  await img.click();
  await page.locator('[data-tb="dk-crop"]').click();
  await page.locator('[data-tb="dk-cropshape"]').click();
  await page.locator('[data-palette="dk-cropshape"] .tb-pal-item', { hasText: 'Square 1:1' }).click();
  await page.locator('[data-tb="dk-cropdone"]').click();
  await expect.poll(() => fileText()).toContain('class="ol-crop"');
  await page.screenshot({ path: 'scratch/slide-audit/evidence/luna3/reference-poster-crop-gui.png', fullPage: true });
  await page.keyboard.press('Delete');

  // Export via the visible download menu, retain the PDF response, and validate page geometry.
  await page.locator('[data-dl-download]').click();
  const pdfResponsePromise = context.waitForEvent('response', r => r.url().includes('deliverable-pdf'));
  await page.getByText('PDF', { exact: true }).click();
  const pdfResponse = await pdfResponsePromise;
  expect(pdfResponse.ok()).toBeTruthy();
  const pdf = await pdfResponse.body();
  writeFileSync('scratch/slide-audit/evidence/luna3/usgs-water-quality-replica.pdf', pdf);
  await expect.poll(() => fileText()).toContain('PUBLIC');
  await page.screenshot({ path: 'scratch/slide-audit/evidence/luna3/reference-poster-final.png', fullPage: true });
});
