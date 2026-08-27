// Opens a scratch document on the live site in headless Chromium (fresh profile) and reports timings + errors.
import { chromium } from '@playwright/test';
import fs from 'node:fs';
const BASE = 'https://overlyx.app';
const DOC = process.env.DOC ?? 'e2e-scratch/chrome-test.lyx';
const password = fs.readFileSync('/root/lyx/overlyx/data/credentials.txt', 'utf8').trim().split('\n').filter(l => l.startsWith('admin\t')).pop().split('\t')[1];
const browser = await chromium.launch();
const ctx = await browser.newContext({ viewport: { width: 1400, height: 900 } });
const page = await ctx.newPage();
page.on('pageerror', e => console.log('pageerror', e.message));
page.on('console', m => { if (m.type() === 'error' || m.type() === 'warning') console.log('console', m.type(), m.text().slice(0, 200)); });
page.on('requestfailed', r => console.log('requestfailed', r.url().slice(0, 120), r.failure()?.errorText));
const t0 = Date.now();
await page.goto(BASE + '/');
await page.getByPlaceholder('Username').fill('admin');
await page.getByPlaceholder('Password').fill(password);
await page.getByRole('button', { name: 'Sign in' }).click();
await page.waitForSelector('.menubar', { timeout: 20000 });
console.log('logged in after', Date.now() - t0, 'ms');
for (const round of [1, 2]) {
  const t1 = Date.now();
  await page.evaluate((id) => { location.hash = '#/' + id; }, DOC);
  await page.waitForSelector('.lyx-editor .lyx-par', { timeout: 60000 });
  const first = Date.now() - t1;
  await page.waitForFunction(() => document.querySelector('.save-state')?.textContent?.includes('All changes saved'), null, { timeout: 30000 }).catch(async () => console.log('save state never became saved:', await page.evaluate(() => document.querySelector('.save-state')?.textContent)));
  const info = await page.evaluate(() => ({
    marks: performance.getEntriesByType('mark').filter(m => m.name.startsWith('ol:')).map(m => m.name + '@' + Math.round(m.startTime)).join(' '),
    pending: document.querySelectorAll('.lyx-math-static.pending').length,
    pars: document.querySelectorAll('.lyx-editor .lyx-par').length,
    sw: !!navigator.serviceWorker?.controller,
    save: document.querySelector('.save-state')?.textContent,
  }));
  console.log(`round ${round}: first paragraph ${first} ms, total ${Date.now() - t1} ms`, JSON.stringify(info));
  await page.evaluate(() => { location.hash = ''; });
  await page.waitForFunction(() => !document.querySelector('.lyx-editor'));
}
// reload (normal) with the SW in control
const t2 = Date.now();
await page.goto(BASE + '/#/' + DOC);
await page.waitForSelector('.lyx-editor .lyx-par', { timeout: 60000 });
console.log('full page load + open with SW:', Date.now() - t2, 'ms');
// can Chromium load a Google avatar from a page on this origin (service worker in control)?
const avatar = await page.evaluate(() => new Promise(res => { const img = new Image(); img.referrerPolicy = 'no-referrer'; img.onload = () => res('loaded ' + img.naturalWidth + 'px'); img.onerror = () => res('ERROR'); img.src = 'https://lh3.googleusercontent.com/a/ACg8ocK0_ffsRKAxeh8-mBSKv0DZjx9Gk2mN0-XFjUsGhQNPqZOuYw=s96-c'; }));
console.log('avatar image:', avatar);
await page.screenshot({ path: process.env.SHOT ?? '/tmp/claude-0/-root-lyx/26b4c45d-bc72-457f-b17d-1167bb6b6240/scratchpad/prod.png' });
await browser.close();
