// the built app (service worker) on the server's port: offline reload / goto in each engine
import { webkit, firefox, chromium } from '@playwright/test';
import { login } from '../../e2e/helpers';
const which = process.argv[2] ?? 'webkit';
const bt = { webkit, firefox, chromium }[which]!;
const BASE = 'http://127.0.0.1:3037';
const browser = await bt.launch();
const ctx = await browser.newContext({ baseURL: BASE, viewport: { width: 1200, height: 800 } });
const page = await ctx.newPage();
page.on('pageerror', e => console.log('pageerror', e.message));
await login(page);
await page.goto('/#/admin/e2e-probe/main.tex');
await page.waitForSelector('.lyx-editor .lyx-par', { timeout: 60000 });
await page.waitForFunction(() => navigator.serviceWorker?.controller != null, null, { timeout: 30000 });
console.log('controlled');
await ctx.setOffline(true);
await page.waitForTimeout(1000);
for (const how of ['reload', 'goto', 'evaluate-reload']) {
  try {
    if (how === 'reload') await page.reload();
    else if (how === 'goto') await page.goto('/#/admin/e2e-probe/main.tex');
    else await Promise.all([page.waitForEvent('load', { timeout: 20000 }), page.evaluate(() => location.reload())]);
    await page.waitForSelector('.lyx-editor .lyx-par', { timeout: 30000 });
    console.log(how, 'ok');
  } catch (e) {
    console.log(how, 'FAILED', String(e).split('\n')[0].slice(0, 150));
    await page.waitForTimeout(3000);
    console.log('  page now:', page.url(), await page.evaluate(() => document.querySelectorAll('.lyx-editor .lyx-par').length).catch(e => 'eval failed ' + e));
  }
}
await browser.close();
