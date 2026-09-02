/**
 * Images pasted or dropped into the editor land in figures/ and appear as graphics insets:
 * clipboard image data (a screenshot), SVG markup on the text clipboard, and image files
 * dragged in from the computer (dropped where the pointer is; a name clash counts up,
 * nothing is replaced).
 */
import { test, expect, type Page } from '@playwright/test';
import { mkdirSync, rmSync, readFileSync, writeFileSync, readdirSync, existsSync } from 'node:fs';
import { login, collectErrors, PROJECTS_DIR, texDoc } from './helpers';

const PROJECT = 'e2e-imgpaste';
const DIR = `${PROJECTS_DIR}/${PROJECT}`;

// a 1×1 red PNG
const PNG_B64 = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';

const figs = () => (existsSync(`${DIR}/figures`) ? readdirSync(`${DIR}/figures`) : []);

test.beforeAll(() => {
  rmSync(DIR, { recursive: true, force: true });
  mkdirSync(DIR, { recursive: true });
  writeFileSync(`${DIR}/img.tex`, texDoc('First paragraph.\n\nSecond paragraph.\n\nLast paragraph.'));
});
test.afterAll(() => { rmSync(DIR, { recursive: true, force: true }); });

async function open(page: Page) {
  await page.evaluate(() => { localStorage.setItem('ol.tabs', '[]'); });
  await page.goto(`/#/${PROJECT}/img.tex`);
  await page.waitForFunction(() => document.querySelectorAll('.lyx-editor .lyx-par').length >= 3, null, { timeout: 60000 });
  await page.waitForTimeout(1500);
}

test('a pasted screenshot is uploaded into figures/ and inserted as a graphics inset', async ({ page }) => {
  const errors = collectErrors(page);
  await login(page);
  await open(page);
  await page.locator('.lyx-editor .lyx-par').nth(0).click();
  await page.keyboard.press('End');
  await page.evaluate((b64) => {
    const bytes = Uint8Array.from(atob(b64), c => c.charCodeAt(0));
    const dt = new DataTransfer();
    dt.items.add(new File([bytes], 'image.png', { type: 'image/png' }));   // the name browsers give clipboard images
    document.querySelector('.lyx-editor')!.dispatchEvent(new ClipboardEvent('paste', { clipboardData: dt, bubbles: true, cancelable: true }));
  }, PNG_B64);
  await expect(page.locator('.lyx-editor .lyx-graphics img')).toHaveCount(1, { timeout: 10000 });
  expect(figs().filter(f => /^pasted-\d{8}-\d{6}\.png$/.test(f))).toHaveLength(1);
  // …and the .tex on disk references it at the dialog's default width
  await expect.poll(() => readFileSync(`${DIR}/img.tex`, 'utf8'), { timeout: 15000 }).toMatch(/\\includegraphics\[width=1\\columnwidth\]\{figures\/pasted-[^}]+\.png\}/);
  expect(errors).toEqual([]);
});

test('pasted SVG markup becomes an .svg file in figures/ and a graphics inset', async ({ page }) => {
  await login(page);
  await open(page);
  const before = await page.locator('.lyx-editor .lyx-graphics').count();
  await page.locator('.lyx-editor .lyx-par').nth(1).click();
  await page.keyboard.press('End');
  await page.evaluate(() => {
    const dt = new DataTransfer();
    dt.setData('text/plain', '<?xml version="1.0"?>\n<svg xmlns="http://www.w3.org/2000/svg" width="20" height="20"><circle cx="10" cy="10" r="9" fill="tomato"/></svg>');
    document.querySelector('.lyx-editor')!.dispatchEvent(new ClipboardEvent('paste', { clipboardData: dt, bubbles: true, cancelable: true }));
  });
  await expect(page.locator('.lyx-editor .lyx-graphics')).toHaveCount(before + 1, { timeout: 10000 });
  const svg = figs().find(f => f.endsWith('.svg'));
  expect(svg).toBeTruthy();
  expect(readFileSync(`${DIR}/figures/${svg}`, 'utf8')).toContain('<circle');
  await expect.poll(() => readFileSync(`${DIR}/img.tex`, 'utf8'), { timeout: 15000 }).toContain(`{figures/${svg!.slice(0, -4)}.svg}`);
});

test('an image file dropped on a paragraph is inserted there; dropping the same name again counts up', async ({ page }) => {
  await login(page);
  await open(page);
  const before = await page.locator('.lyx-editor .lyx-graphics').count();
  const par = page.locator('.lyx-editor .lyx-par').nth(2);
  const box = (await par.boundingBox())!;
  const drop = (x: number, y: number) => page.evaluate(({ b64, x, y }) => {
    const bytes = Uint8Array.from(atob(b64), c => c.charCodeAt(0));
    const dt = new DataTransfer();
    dt.items.add(new File([bytes], 'diagram.png', { type: 'image/png' }));
    const el = document.elementFromPoint(x, y) ?? document.querySelector('.lyx-editor')!;
    el.dispatchEvent(new DragEvent('dragover', { bubbles: true, cancelable: true, clientX: x, clientY: y, dataTransfer: dt }));
    el.dispatchEvent(new DragEvent('drop', { bubbles: true, cancelable: true, clientX: x, clientY: y, dataTransfer: dt }));
  }, { b64: PNG_B64, x, y });
  await drop(box.x + 40, box.y + 8);
  await expect(page.locator('.lyx-editor .lyx-graphics')).toHaveCount(before + 1, { timeout: 10000 });
  // it landed in the paragraph under the pointer, with the file's own name
  await expect(par.locator('.lyx-graphics')).toHaveCount(1);
  expect(existsSync(`${DIR}/figures/diagram.png`)).toBe(true);
  // the same name again: diagram-2.png appears, diagram.png is untouched
  await drop(box.x + 40, box.y + 8);
  await expect(page.locator('.lyx-editor .lyx-graphics')).toHaveCount(before + 2, { timeout: 10000 });
  expect(existsSync(`${DIR}/figures/diagram-2.png`)).toBe(true);
  await expect.poll(() => readFileSync(`${DIR}/img.tex`, 'utf8'), { timeout: 15000 }).toContain('figures/diagram-2');
});
