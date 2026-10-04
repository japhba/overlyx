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

const PROJECT = 'admin/e2e-devices';
const DIR = `${PROJECTS_DIR}/${PROJECT}`;

test.beforeAll(() => {
  rmSync(DIR, { recursive: true, force: true });
  mkdirSync(DIR, { recursive: true });
  writeFileSync(`${DIR}/main.tex`, texDoc('\\section{Intro}\n\nSome text with a formula $a+b=c$ inside it, and a few more words after it.\n\nA second paragraph.'));
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
