/**
 * Phones and tablets (Safari on an iPhone or iPad, Chrome on Android): what the device gets on its
 * first visit. A phone-width screen starts with the documents panel folded away and without the
 * drawing toolbar (a phone's page has no margins to draw in) — the panel took 270 of an iPhone's 393
 * pixels and left the text a column one letter wide; a tablet still gets its drawing toolbar.
 * Tapping a formula opens it for typing, and its hidden input has 16px text (Safari on an iPhone
 * zooms the page into a focused field whose text is smaller).
 */
import { test, expect, devices } from '@playwright/test';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { login, openDoc, texDoc, collectErrors, PROJECTS_DIR, newTouchContext } from './helpers';
import type { Page } from '@playwright/test';

const PROJECT = 'admin/e2e-devices';
const DIR = `${PROJECTS_DIR}/${PROJECT}`;

test.beforeAll(() => {
  rmSync(DIR, { recursive: true, force: true });
  mkdirSync(DIR, { recursive: true });
  writeFileSync(`${DIR}/main.tex`, texDoc('\\section{Intro}\n\nSome text with a formula $a+b=c$ inside it, and a few more words after it.\n\nA second paragraph.'));
  writeFileSync(`${DIR}/long.tex`, texDoc(Array.from({ length: 40 }, (_, i) => `Paragraph ${i + 1}: ${'some words to fill the line and wrap it onto another '.repeat(3)}end.`).join('\n\n')));
});
test.afterAll(() => { rmSync(DIR, { recursive: true, force: true }); });

const PHONE = { viewport: devices['iPhone 15'].viewport, isMobile: true, deviceScaleFactor: 2 };

test('a phone: the text has the width, no drawing toolbar; a tapped formula takes typing without zooming', async ({ browser }) => {
  const ctx = await newTouchContext(browser, PHONE);
  const page = await ctx.newPage();
  try {
    const errors = collectErrors(page);
    await login(page);
    await openDoc(page, `${PROJECT}/main.tex`);
    await expect(page.locator('.docpanel')).toHaveCount(0);
    await expect(page.locator('.toolbar-ink')).toHaveCount(0);
    const widths = await page.evaluate(() => ({ editor: document.querySelector('.lyx-editor')!.getBoundingClientRect().width, view: innerWidth }));
    expect(widths.editor).toBeGreaterThan(widths.view * 0.6);
    // a tap on the formula: its field has the keyboard, the page is not zoomed into it
    const f = (await page.locator('.lyx-editor .lyx-math-inline').first().boundingBox())!;
    await page.touchscreen.tap(f.x + f.width - 2, f.y + f.height / 2);
    await expect.poll(() => page.evaluate(() => document.activeElement?.classList.contains('lm-input'))).toBe(true);
    expect(await page.evaluate(() => parseFloat(getComputedStyle(document.activeElement!).fontSize))).toBeGreaterThanOrEqual(16);
    await page.keyboard.type('+d');
    await expect.poll(() => page.evaluate(() => (document.querySelector('.lyx-editor .lyx-math-inline') as any).pmViewDesc.node.attrs.latex)).toBe('a+b=c+d');
    expect(errors).toEqual([]);
  } finally { await ctx.close(); }
});

test('a tablet keeps the documents panel and turns its drawing toolbar on', async ({ browser }) => {
  const ctx = await newTouchContext(browser, { viewport: { width: 1180, height: 820 }, isMobile: true });
  const page = await ctx.newPage();
  try {
    await login(page);
    await openDoc(page, `${PROJECT}/main.tex`);
    await expect(page.locator('.docpanel')).toHaveCount(1);
    await expect(page.locator('.toolbar-ink')).toBeVisible();
  } finally { await ctx.close(); }
});

/** the text zoom shown (the CSS variable the editor's font size follows) */
const textZoom = (page: Page) => page.evaluate(() => parseFloat(document.documentElement.style.getPropertyValue('--editor-zoom')) || 1);
/** the paragraph under a screen point: its words and its box */
const paraAt = (page: Page, x: number, y: number) => page.evaluate(([x, y]) => {
  const p = document.elementFromPoint(x, y)?.closest('.lyx-editor > *');
  const r = p?.getBoundingClientRect();
  return p && r ? { text: (p.textContent ?? '').slice(0, 14), top: r.top, bottom: r.bottom } : null;
}, [x, y]);

test("a pinch zooms a document's text, not the page: the line under the fingers stays there, it stops at 100 % and holds; a mouse wheel's notch steps 10 %", async ({ page }) => {
  const errors = collectErrors(page);
  await login(page);
  await openDoc(page, `${PROJECT}/long.tex`);
  const sc = (await page.locator('.editor-scroll').boundingBox())!;
  await page.locator('.editor-scroll').evaluate(e => { e.scrollTop = 900; });
  const x = sc.x + sc.width / 2, y = sc.y + sc.height / 2;
  const p0 = (await paraAt(page, x, y))!;
  expect(p0).not.toBeNull();
  await page.mouse.move(x, y);
  // a small pinch at 100 %: held there (said as 100 %), and settled back on it once let go
  await page.keyboard.down('Control');
  for (let i = 0; i < 4; i++) { await page.mouse.wheel(0, -5); await page.waitForTimeout(30); }
  await expect(page.locator('[data-text-zoomhud]')).toHaveText('100 %');
  await page.keyboard.up('Control');
  await expect.poll(() => textZoom(page), { timeout: 3000 }).toBe(1);
  await expect(page.locator('.zoom-select')).toHaveValue('100');
  // pinched well past it: the text grows, the same paragraph under the pointer (each step past the hold on its own: a loaded machine's steps may come apart as separate pinches)
  await page.waitForTimeout(300);
  await page.keyboard.down('Control');
  for (let i = 0; i < 5; i++) { await page.mouse.wheel(0, -30); await page.waitForTimeout(30); }
  await page.keyboard.up('Control');
  await expect.poll(() => page.locator('.zoom-select').inputValue(), { timeout: 3000 }).not.toBe('100');
  const z1 = await textZoom(page);
  expect(z1).toBeGreaterThan(1.5);
  const p1 = (await paraAt(page, x, y))!;
  expect(p1.text).toBe(p0.text);
  await expect(page.locator('[data-text-zoomhud]')).toHaveText(/^\d+ %$/);
  // the browser's own zoom stayed as it was
  expect(await page.evaluate(() => visualViewport?.scale ?? 1)).toBe(1);
  // a mouse wheel's notch: 10 % out
  await page.keyboard.down('Control');
  await page.mouse.wheel(0, 100);
  await page.keyboard.up('Control');
  await expect.poll(() => textZoom(page)).toBeCloseTo(z1 - 0.1, 2);
  // pinched back out past 100 %: it stops there again
  await page.waitForTimeout(300);
  await page.keyboard.down('Control');
  for (let i = 0; i < 40 && (await page.locator('[data-text-zoomhud]').textContent()) !== '100 %'; i++) { await page.mouse.wheel(0, 8); await page.waitForTimeout(30); }
  await page.keyboard.up('Control');
  await expect.poll(() => textZoom(page), { timeout: 3000 }).toBe(1);
  expect(errors).toEqual([]);
});

test("two fingers pinch a document's text on a touch screen, not the page", async ({ browser }) => {
  const ctx = await newTouchContext(browser, { viewport: { width: 1180, height: 820 }, isMobile: true });
  const page = await ctx.newPage();
  try {
    await login(page);
    await openDoc(page, `${PROJECT}/long.tex`);
    const sc = (await page.locator('.editor-scroll').boundingBox())!;
    const x = sc.x + sc.width / 2, y = sc.y + sc.height / 2;
    const p0 = (await paraAt(page, x, y))!;
    const cdp = await ctx.newCDPSession(page);
    const touches = (type: string, pts: { x: number; y: number }[]) => cdp.send('Input.dispatchTouchEvent', { type, touchPoints: pts.map((p, i) => ({ x: p.x, y: p.y, id: i + 1 })) });
    await touches('touchStart', [{ x: x - 40, y }, { x: x + 40, y }]);
    for (let i = 1; i <= 12; i++) { await touches('touchMove', [{ x: x - 40 - 10 * i, y }, { x: x + 40 + 10 * i, y }]); await page.waitForTimeout(20); }
    await touches('touchEnd', []);
    await expect.poll(() => textZoom(page), { timeout: 3000 }).toBeGreaterThan(1.4);
    expect(await page.evaluate(() => visualViewport?.scale ?? 1)).toBe(1);
    expect((await paraAt(page, x, y))!.text).toBe(p0.text);
  } finally { await ctx.close(); }
});
