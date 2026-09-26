// Settings ▸ Editor ▸ Text font / Math font in the running app: screenshots of the dialog (with its sample) and of
// a real document for each "text:math" pair given, then a click into a formula and an arrow key (the caret must
// stay inside it). Env as for Playwright (OVERLYX_E2E_BASE, credentials). Usage:
//   npx tsx scratch/mathfont-app.mts <outdir> <project/doc.tex> stix:match garamond:euler sans:match
import { chromium } from '@playwright/test';
import { login, BASE_URL } from '../e2e/helpers';
const [OUT, DOC, ...pairs] = process.argv.slice(2);
const browser = await chromium.launch();
const ctx = await browser.newContext({ baseURL: BASE_URL, viewport: { width: 1280, height: 900 }, deviceScaleFactor: 1.5 });
const page = await ctx.newPage();
const errors: string[] = [];
page.on('console', m => { if (m.type() === 'error') errors.push(m.text()); });
await page.addInitScript(() => { if (!sessionStorage.getItem('mf')) { sessionStorage.setItem('mf', '1'); localStorage.setItem('ol.prefs', JSON.stringify({ autoBuild: 'off' })); } });
await login(page);
await page.evaluate(() => { localStorage.setItem('ol.tabs', '[]'); localStorage.setItem('ol.combined', '0'); });
await page.goto('/#/' + DOC);
await page.waitForFunction(() => document.querySelectorAll('.lyx-editor .katex').length >= 3, null, { timeout: 60000 });
for (const pair of pairs) {
  const [text, math] = pair.split(':');
  await page.evaluate(() => (window as any).overlyx.openDialog('preferences'));
  const dlg = page.locator('.dialog');
  await dlg.locator('[data-pref="editorFont"]').selectOption(text);
  await dlg.locator('[data-pref="editorMathFont"]').selectOption(math);
  await page.evaluate(() => document.fonts.ready);
  await page.waitForTimeout(800);
  await dlg.screenshot({ path: `${OUT}/dialog-${text}-${math}.png` });
  await page.keyboard.press('Escape');
  await page.waitForTimeout(300);
  await page.locator('.editor-scroll').screenshot({ path: `${OUT}/doc-${text}-${math}.png` });
  const f = page.locator('.lyx-editor .lyx-math-display .katex').first();
  if (await f.count()) {
    await f.scrollIntoViewIfNeeded();
    const b = (await f.boundingBox())!;
    await page.mouse.click(b.x + b.width * 0.3, b.y + b.height / 2);
    await page.keyboard.press('ArrowRight');
    await page.waitForTimeout(200);
    const caret = await page.evaluate(() => { const c = document.querySelector('.lm-field.focused .lm-caret, .lm-field .lm-caret') as HTMLElement | null; return c ? c.getBoundingClientRect().toJSON() : null; });
    console.log(pair, 'caret', JSON.stringify(caret), 'formula', JSON.stringify(b));
    await page.locator('.lyx-editor .lyx-math-display').first().screenshot({ path: `${OUT}/edit-${text}-${math}.png` });
    await page.keyboard.press('Escape');
  }
}
console.log('console errors:', errors.filter(e => !/favicon/.test(e)).slice(0, 10));
await browser.close();
