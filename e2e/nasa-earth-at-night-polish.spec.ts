/** GUI polish pass for native NASA slide text; authoring and export stay in one browser context. */
import { test, expect, type Page } from '@playwright/test';
import { copyFileSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { login, userCredentials, PROJECTS_DIR } from './helpers';

const KEY = 'luna4/earth-at-night-2012-recreation-20261013-gui-triptych-r2';
const FILE = path.join(PROJECTS_DIR, KEY, 'slides', 'index.html');
const EVIDENCE = path.resolve('scratch/slide-audit/evidence/nasa-earth-at-night/20261013-polished');
const frame = (page: Page) => page.frameLocator('.dl-frame');
const slides = (page: Page) => frame(page).locator('section.slide');
const rail = (page: Page) => page.frameLocator('.dl-railframe').locator('section.slide');
const rows = (page: Page) => page.locator('[data-dl-objects] [data-obj-row]');
const source = () => readFileSync(FILE, 'utf8');
const slideHtml = (n: number) => [...source().matchAll(/<section class="slide"[\s\S]*?<\/section>/g)][n]?.[0] ?? '';
const styleFor = (n: number, includes: string) => {
  const block = slideHtml(n);
  for (const match of block.matchAll(/<(p|h1|h2)[^>]*style="([^"]*)"[^>]*>([\s\S]*?)<\/\1>/g)) {
    if (match[3].includes(includes)) return match[2];
  }
  return '';
};

async function gotoSlide(page: Page, n: number) {
  await rail(page).nth(n).click();
  await expect(slides(page).nth(n)).toBeVisible();
}

async function objectPane(page: Page) {
  const button = page.locator('[data-tb="dk-objects"]');
  if (!/(^|\s)on(\s|$)/.test((await button.getAttribute('class')) ?? '')) await button.click();
  await expect(page.locator('[data-dl-objects]')).toBeVisible();
}

async function styleExistingText(page: Page, n: number, label: string, matchText: string, pt: number) {
  await gotoSlide(page, n);
  await objectPane(page);
  const row = rows(page).filter({ hasText: matchText }).first();
  await expect(row).toBeVisible();
  await row.click();
  await expect(row).toHaveClass(/sel/);

  const size = page.locator('.dl-toolbar [data-dk-size] input');
  await expect(size).toBeVisible();
  await size.fill(String(pt));
  await size.press('Enter');
  const colorButton = page.locator('.dl-toolbar [data-tb="dk-color"]').last();
  await colorButton.click();
  const swatch = page.locator('[data-palette="dk-color"] [data-color="#ffd966"]');
  await expect(swatch).toBeVisible();
  await swatch.click();

  const live = await slides(page).nth(n).locator('p').filter({ hasText: matchText }).evaluate(el => ({
    color: getComputedStyle(el).color,
    fontSize: getComputedStyle(el).fontSize,
  }));
  expect(live.color).toBe('rgb(255, 217, 102)');
  expect(parseFloat(live.fontSize)).toBeCloseTo(pt * 4 / 3, 0);
  await expect.poll(() => styleFor(n, label), { timeout: 15000 }).toMatch(/font-size:\s*\d+(?:\.\d+)?pt/);
  const saved = styleFor(n, label);
  expect(saved).toMatch(/font-size:\s*\d+(?:\.\d+)?pt/);
  expect(saved).toMatch(/color:\s*#ffd966/i);
  writeFileSync(path.join(EVIDENCE, `style-${label.toLowerCase().replace(/[^a-z0-9]+/g, '-')}.json`), JSON.stringify({ slide: n + 1, label, expectedPt: pt, live, savedStyle: saved }, null, 2));
}

test('select existing native captions in Objects pane, set legible styling, reload and export', async ({ page, context }) => {
  test.setTimeout(240000);
  page.setDefaultTimeout(12000);
  mkdirSync(EVIDENCE, { recursive: true });
  const errors: string[] = [];
  page.on('pageerror', e => errors.push(`pageerror: ${e.message}`));
  page.on('console', m => { if (m.type() === 'error') errors.push(`console: ${m.text()}`); });
  await page.setViewportSize({ width: 1600, height: 1000 });
  await login(page, userCredentials('luna4'), { ui: 'default' });
  await page.goto(`/#/${KEY}/slides/index.html`);
  await expect(slides(page).first()).toBeVisible({ timeout: 30000 });
  await page.locator('[data-dl-zoom]').selectOption('fit');

  const targets = [
    { n: 0, label: 'VIIRS DAY/NIGHT BAND', match: 'VIIRS DAY/NIGHT BAND', pt: 13 },
    { n: 1, label: 'GREAT LAKES', match: 'GREAT LAKES', pt: 16 },
    { n: 1, label: 'ATLANTIC COAST', match: 'ATLANTIC COAST', pt: 16 },
    { n: 2, label: 'NORTH SEA', match: 'NORTH SEA', pt: 16 },
    { n: 2, label: 'CENTRAL EUROPE', match: 'CENTRAL EUROPE', pt: 16 },
    { n: 2, label: 'PO VALLEY', match: 'PO VALLEY', pt: 16 },
  ];
  for (const target of targets) await styleExistingText(page, target.n, target.label, target.match, target.pt);

  await expect.poll(() => source(), { timeout: 20000 }).toContain('NOAA National Geophysical Data Center');
  copyFileSync(FILE, path.join(EVIDENCE, 'editable-deck.html'));
  for (let n = 0; n < 3; n++) {
    await gotoSlide(page, n);
    await slides(page).nth(n).screenshot({ path: path.join(EVIDENCE, `slide-${n + 1}.png`) });
  }

  await gotoSlide(page, 0);
  await page.locator('[data-dl-present]').click();
  const presenter = page.frameLocator('.dl-presenting iframe');
  await expect(presenter.locator('section.slide[data-ol-current]')).toContainText('Earth at Night, 2012');
  await page.keyboard.press('ArrowRight');
  await expect(presenter.locator('section.slide[data-ol-current]')).toContainText('United States');
  await page.keyboard.press('Escape');
  await expect(page.locator('.dl-presenting')).toHaveCount(0);

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
  await Promise.race([captured, page.waitForTimeout(45000).then(() => { throw new Error('GUI PDF response timed out'); })]);
  expect(pdfStatus).toBe(200);
  expect(pdfBytes?.subarray(0, 4).toString('ascii')).toBe('%PDF');
  const pdfPath = path.join(EVIDENCE, 'earth-at-night-2012-polished.pdf');
  writeFileSync(pdfPath, pdfBytes!);
  const info = execFileSync('pdfinfo', [pdfPath], { encoding: 'utf8' });
  expect(info).toMatch(/Pages:\s+3/);
  const pdfText = execFileSync('pdftotext', [pdfPath, '-'], { encoding: 'utf8' });
  for (const text of ['Earth at Night, 2012', 'United States', 'GREAT LAKES', 'ATLANTIC COAST', 'NORTH SEA', 'CENTRAL EUROPE', 'PO VALLEY', 'NOAA']) expect(pdfText).toContain(text);
  writeFileSync(path.join(EVIDENCE, 'pdfinfo.txt'), info);
  writeFileSync(path.join(EVIDENCE, 'pdf-text.txt'), pdfText);
  execFileSync('pdftoppm', ['-png', '-r', '120', pdfPath, path.join(EVIDENCE, 'pdf-slide')], { stdio: 'ignore' });

  await page.reload();
  await expect(slides(page).first()).toBeVisible({ timeout: 30000 });
  for (const target of targets) {
    await gotoSlide(page, target.n);
    const style = styleFor(target.n, target.label);
    expect(style).toMatch(/font-size:\s*\d+(?:\.\d+)?pt/);
    expect(style).toMatch(/color:\s*#ffd966/i);
  }
  expect(errors).toEqual([]);
  await page.screenshot({ path: path.join(EVIDENCE, 'editor-after-reopen.png') });
});
