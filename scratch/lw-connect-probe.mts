// File ▸ LessWrong ▸ Connect against scratch/lw-oauth-fake.mjs (a server started with
// OVERLYX_LESSWRONG_URL=http://localhost:3005): LessWrong's consent page, Allow (a form POST
// answered with a 307), back in OverLyX connected.
import { chromium } from 'playwright';
import { login, BASE_URL } from '../e2e/helpers';
const browser = await chromium.launch();
const ctx = await browser.newContext({ baseURL: BASE_URL, viewport: { width: 1300, height: 900 } });
const page = await ctx.newPage();
await login(page);
await page.goto(BASE_URL + '/#/admin/lwtest/post.md');
await page.waitForSelector('.lyx-editor', { timeout: 30000 });
await page.locator('.menubar >> text=File').first().click();
await page.getByText('LessWrong (sync, comments)…').click();
await page.click('[data-lw-connect]');
await page.waitForSelector('text=Authorize OverLyX', { timeout: 20000 });
console.log('consent page:', page.url().replace(/\?.*/, ''));
await page.click('button[value=allow]');
await page.waitForURL(u => u.toString().startsWith(BASE_URL), { timeout: 20000 }).catch(() => undefined);
await page.waitForTimeout(2500);
console.log('back at:', page.url());
console.log('page says:', (await page.locator('body').innerText()).slice(0, 160).replace(/\n+/g, ' | '));
console.log('dialog link field shown (connected):', await page.locator('[data-lw-url]').count());
await page.screenshot({ path: '/mnt/HC_Volume_107166861/jan/lw-e2e/connected.png' });
await browser.close();
