// What an iPad user does (WebKit, devices['iPad Pro 11'], touch): open a document, tap into text and type,
// tap a formula and type, open a menu, scroll; screenshots to $OUT. Env as for Playwright.
import { webkit, chromium, devices } from '@playwright/test';
import { mkdirSync, writeFileSync } from 'node:fs';
import { login, BASE_URL, PROJECTS_DIR, texDoc } from '../../e2e/helpers';
const OUT = process.argv[2] ?? '/tmp/ipad'; const orient = process.argv[3] ?? 'landscape';
mkdirSync(OUT, { recursive: true });
const DIR = `${PROJECTS_DIR}/admin/e2e-ipad`;
mkdirSync(DIR, { recursive: true });
writeFileSync(`${DIR}/main.tex`, texDoc('\\section{Intro}\n\nSome text with a formula $a+b=c$ inside it, and more words here.\n\n\\begin{equation}\nE=mc^{2}\\label{eq:e}\n\\end{equation}\n\nLast paragraph refers to \\ref{eq:e}.\n' + Array.from({ length: 30 }, (_, i) => `\nFiller paragraph ${i} with enough words to wrap across the line on a tablet screen, so that the page scrolls.\n`).join('')));
const browser = await (process.env.ENGINE === 'chromium' ? chromium : webkit).launch();
const dev = { ...(orient === 'landscape' ? devices['iPad Pro 11 landscape'] : orient === 'phone' ? devices['iPhone 15'] : devices['iPad Pro 11']) } as any;
if (process.env.ENGINE === 'chromium') delete dev.defaultBrowserType;
const ctx = await browser.newContext({ ...dev, baseURL: BASE_URL });
// which event is being dispatched when an editable gets the focus: iOS shows its keyboard only for a focus
// inside a touch's own event handlers (touchend / mousedown / click), not one from a timer or a frame
await ctx.addInitScript(() => {
  (window as any).__focusLog = [];
  for (const proto of [HTMLTextAreaElement.prototype, HTMLElement.prototype]) {
    const f = proto.focus;
    proto.focus = function (this: HTMLElement, ...a: any[]) { (window as any).__focusLog.push(`${this.className || this.tagName} during ${(window as any).event?.type ?? 'no event'}`); return f.apply(this, a as []); };
  }
});
const page = await ctx.newPage();
const errors: string[] = [];
page.on('pageerror', e => errors.push('pageerror ' + e.message));
page.on('console', m => { if (m.type() === 'error') errors.push('console ' + m.text()); });
await login(page);
await page.screenshot({ path: `${OUT}/0-projects.png` });
await page.goto('/#/admin/e2e-ipad/main.tex');
await page.waitForFunction(() => document.querySelectorAll('.lyx-editor .lyx-par').length > 3, null, { timeout: 60000 });
await page.waitForTimeout(1500);
await page.screenshot({ path: `${OUT}/1-doc.png` });
const info = await page.evaluate(() => ({ vw: innerWidth, sw: document.documentElement.scrollWidth, bw: document.body.scrollWidth, ua: navigator.userAgent }));
console.log('layout', JSON.stringify(info), JSON.stringify(await page.evaluate(`(() => { const r = s => { const e = document.querySelector(s); return e ? Math.round(e.getBoundingClientRect().width) : null; }; return { editorScroll: r('.editor-scroll'), editor: r('.lyx-editor'), docpanel: r('.docpanel'), left: localStorage.getItem('ol.left'), coarse: matchMedia('(pointer: coarse)').matches }; })()`)));
// tap into the text and type
const par = page.locator('.lyx-editor .lyx-par').nth(1);
const pb = (await par.boundingBox())!;
await page.touchscreen.tap(pb.x + 30, pb.y + 8);
await page.waitForTimeout(300);
await page.keyboard.type('TAP');
await page.waitForTimeout(300);
console.log('after tap+type:', (await par.textContent())?.slice(0, 60), 'active', await page.evaluate(() => document.activeElement?.className));
// tap the formula
const f = page.locator('.lyx-editor .lyx-math-inline').first();
const fb = (await f.boundingBox())!;
await page.touchscreen.tap(fb.x + fb.width - 3, fb.y + fb.height / 2);
await page.waitForTimeout(500);
console.log('focus calls:', JSON.stringify(await page.evaluate(() => (window as any).__focusLog.splice(0))));
console.log('lm-input font-size:', await page.evaluate(() => getComputedStyle(document.querySelector('.lm-input')!).fontSize), 'editor font-size:', await page.evaluate(() => getComputedStyle(document.querySelector('.lyx-editor')!).fontSize));
console.log('formula focused:', await page.evaluate(() => document.activeElement?.className));
await page.keyboard.type('+d');
await page.waitForTimeout(400);
console.log('formula latex:', await page.evaluate(() => (document.querySelector('.lyx-editor .lyx-math-inline') as any).pmViewDesc.node.attrs.latex));
await page.screenshot({ path: `${OUT}/2-formula.png` });
// tap outside to leave, tap the display formula
const d = page.locator('.lyx-editor .lyx-math-display').first();
const db = (await d.boundingBox())!;
await page.touchscreen.tap(db.x + db.width / 2, db.y + db.height / 2);
await page.waitForTimeout(500);
console.log('focus calls:', JSON.stringify(await page.evaluate(() => (window as any).__focusLog.splice(0))));
console.log('display focused:', await page.evaluate(() => document.activeElement?.className));
await page.screenshot({ path: `${OUT}/3-display.png` });
// a menu
const menuBtn = page.locator('.menubar .menu > button').first();
if (await menuBtn.count()) { const mb = (await menuBtn.boundingBox())!; await page.touchscreen.tap(mb.x + mb.width / 2, mb.y + mb.height / 2); await page.waitForTimeout(400); console.log('menu open:', await page.locator('.menu-item').count()); await page.screenshot({ path: `${OUT}/4-menu.png` }); await page.touchscreen.tap(5, info.vw ? 300 : 300); }
console.log('errors', JSON.stringify(errors));
await browser.close();
