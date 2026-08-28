/**
 * Text style: the usual Ctrl+I / Ctrl+B / Ctrl+U keys, and the text colour palette (named LyX
 * colours and a custom colour, written as \textcolor[HTML]{…}).
 */
import { test, expect, type Page } from '@playwright/test';
import { mkdirSync, rmSync, writeFileSync, readFileSync } from 'node:fs';
import { login, openDoc, collectErrors, PROJECTS_DIR, texDoc } from './helpers';

const PROJECT = 'e2e-textstyle';
const DIR = `${PROJECTS_DIR}/${PROJECT}`;
const FILE = `${DIR}/s.tex`;

/** Double-click the centre of a word of the first paragraph (the paragraph is one text node, so getByText cannot address a word). */
async function selectWord(page: Page, w: string) {
  const r = await page.evaluate((w) => {
    const walker = document.createTreeWalker(document.querySelector('.lyx-editor')!, NodeFilter.SHOW_TEXT);
    for (let n = walker.nextNode(); n; n = walker.nextNode()) {
      const i = n.textContent!.indexOf(w);
      if (i < 0) continue;
      const range = document.createRange(); range.setStart(n, i); range.setEnd(n, i + w.length);
      const b = range.getBoundingClientRect(); return { x: b.x + b.width / 2, y: b.y + b.height / 2 };
    }
    return null;
  }, w);
  if (!r) throw new Error('word not found: ' + w);
  await page.mouse.dblclick(r.x, r.y);
}

test.beforeAll(() => {
  rmSync(DIR, { recursive: true, force: true });
  mkdirSync(DIR, { recursive: true });
  writeFileSync(FILE, texDoc('alpha beta gamma delta epsilon zeta.'));
});
test.afterAll(() => { rmSync(DIR, { recursive: true, force: true }); });

test('Ctrl+I / Ctrl+B / Ctrl+U and the colour palette', async ({ page }) => {
  const errors = collectErrors(page);
  await login(page);
  await openDoc(page, `${PROJECT}/s.tex`);
  const par = page.locator('.lyx-editor .lyx-par').first();
  const word = (w: string) => ({ dblclick: () => selectWord(page, w) });

  await word('alpha').dblclick();
  await page.keyboard.press('Control+i');
  await expect(par.locator('.lyx-shape-italic')).toHaveText('alpha');
  await word('beta').dblclick();
  await page.keyboard.press('Control+b');
  await expect(par.locator('.lyx-series-bold')).toHaveText('beta');
  await word('gamma').dblclick();
  await page.keyboard.press('Control+u');
  await expect(par.locator('.lyx-bar-under')).toHaveText('gamma');
  await expect(page.locator('[data-tb="italic"]')).not.toHaveClass(/active/);   // the cursor is on the underlined word

  // a named colour from the palette
  await word('delta').dblclick();
  await page.click('[data-tb="textcolor"]');
  await page.click('[data-color-palette] [data-color="red"]');
  await expect(par.locator('.lyx-color-red')).toHaveText('delta');
  await expect(page.locator('[data-tb="textcolor"]')).toHaveAttribute('title', 'Text colour: red');
  // a custom one from the native picker
  await word('epsilon').dblclick();
  await page.click('[data-tb="textcolor"]');
  await page.locator('[data-color-palette] input[type="color"]').fill('#ff8800');
  await expect(par.locator('.lyx-color-custom')).toHaveText('epsilon');
  await expect(par.locator('.lyx-color-custom')).toHaveCSS('color', 'rgb(255, 136, 0)');
  // back to the default
  await word('delta').dblclick();
  await page.click('[data-tb="textcolor"]');
  await page.click('[data-color-palette] [data-color="none"]');
  await expect(par.locator('.lyx-color-red')).toHaveCount(0);

  await expect.poll(() => readFileSync(FILE, 'utf8'), { timeout: 15000 }).toContain('\\textcolor[HTML]{FF8800}{epsilon}');
  const tex = readFileSync(FILE, 'utf8');
  expect(tex).toContain('\\textit{alpha}');
  expect(tex).toContain('\\textbf{beta}');
  expect(tex).toContain('\\uline{gamma}');
  expect(tex).not.toContain('textcolor{red}');
  expect(errors).toEqual([]);
});
