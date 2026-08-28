import { chromium } from '@playwright/test';
import fs from 'node:fs';
const S = '/root/lyx/overlyx/scratch/iso';
const BASE = 'http://127.0.0.1:3001';
const creds = { username: 'admin', password: fs.readFileSync(S + '/data/credentials.txt', 'utf8').split('\n').filter(l => l.startsWith('admin\t')).pop().split('\t')[1] };
const browser = await chromium.launch();
const ctx = await browser.newContext();
await ctx.addInitScript(() => { try { localStorage.setItem('ol.tour', 'e2e'); } catch {} });
const page = await ctx.newPage();
await page.goto(BASE + '/');
await page.getByPlaceholder('Username').fill(creds.username);
await page.getByPlaceholder('Password').fill(creds.password);
await page.getByRole('button', { name: 'Sign in' }).click();
await page.waitForSelector('.menubar', { timeout: 20000 });
await page.goto(BASE + '/#/recurrent_feature/main.tex');
await page.waitForSelector('.statusbar .save-state.saved', { timeout: 30000 });
await page.waitForTimeout(6000);
console.log('hint in steady state (must be 0):', await page.locator('.update-hint').count());
const idx = S + '/dist/index.html';
const orig = fs.readFileSync(idx, 'utf8');
fs.writeFileSync(idx, orig.replace(/index-([A-Za-z0-9_-]+)\.css/, 'index-NEWBUILD.css'));
try {
  await page.waitForTimeout(75000);   // the check is rate-limited to once a minute (first one ran ~3 s after connecting)
  await page.evaluate(() => document.dispatchEvent(new Event('visibilitychange')));
  await page.waitForSelector('.update-hint', { timeout: 10000 });
  console.log('hint after a new build:', await page.locator('.update-hint').textContent());
} finally { fs.writeFileSync(idx, orig); }
await browser.close();
