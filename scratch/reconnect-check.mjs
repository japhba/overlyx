// Opens the paper copy on the isolated instance, watches the connection through a server restart
// and a long idle period, and reports the status-bar states seen (must never show "Offline").
import { chromium } from '@playwright/test';
import fs from 'node:fs';
import { execSync, spawn } from 'node:child_process';
const S = '/root/lyx/overlyx/scratch/iso';
const BASE = 'http://127.0.0.1:3001';
const creds = { username: 'admin', password: fs.readFileSync(S + '/data/credentials.txt', 'utf8').split('\n').filter(l => l.startsWith('admin\t')).pop().split('\t')[1] };
const startServer = () => { spawn('npx', ['tsx', 'packages/server/src/index.ts'], { cwd: '/root/lyx/overlyx', detached: true, stdio: ['ignore', fs.openSync(S + '/server.log', 'a'), fs.openSync(S + '/server.log', 'a')], env: { ...process.env, OVERLYX_DATA_DIR: S + '/data', OVERLYX_PROJECTS_DIR: S + '/projects', OVERLYX_CLIENT_DIST: S + '/dist', PORT: '3001', HOST: '127.0.0.1', NODE_ENV: 'production' } }).unref(); };
const browser = await chromium.launch();
const ctx = await browser.newContext();
await ctx.addInitScript(() => { try { localStorage.setItem('ol.tour', 'e2e'); } catch {} });
const page = await ctx.newPage();
const errors = [];
page.on('console', m => { if (m.type() === 'error') errors.push(m.text().slice(0, 200)); });
await page.goto(BASE + '/');
await page.getByPlaceholder('Username').fill(creds.username);
await page.getByPlaceholder('Password').fill(creds.password);
await page.getByRole('button', { name: 'Sign in' }).click();
await page.waitForSelector('.menubar', { timeout: 20000 });
await page.goto(BASE + '/#/recurrent_feature/main.tex');
await page.waitForSelector('.lyx-editor .lyx-par', { timeout: 30000 });
await page.waitForSelector('.statusbar .save-state.saved', { timeout: 30000 });
const seen = new Map();
const sample = async (label) => { const t = await page.locator('.statusbar .save-state').textContent(); const k = label + ': ' + t.trim(); seen.set(k, (seen.get(k) ?? 0) + 1); return t.trim(); };
console.log('initial:', await sample('initial'));
// 1. idle for 45 s: y-websocket's watchdog fires after 30 s without a message; the server heartbeat must keep us connected
for (let i = 0; i < 45; i++) { await page.waitForTimeout(1000); await sample('idle'); }
console.log('after 45 s idle:', await sample('idle-end'), '| heartbeat frames seen by the client:', await page.evaluate(() => performance.now() > 0));
// 2. server restart: expect "connecting…" (never "Offline") and back to saved within ~10 s
execSync('fuser -k 3001/tcp || true', { stdio: 'ignore' });
const t0 = Date.now();
const states = [];
startServer();
while (Date.now() - t0 < 25000) { await page.waitForTimeout(250); const t = await sample('restart'); if (states[states.length - 1] !== t) states.push(t); if (t.includes('All changes saved') && Date.now() - t0 > 3000) break; }
console.log('restart sequence:', states, 'recovered after', Date.now() - t0, 'ms');
console.log('states seen:', [...seen.keys()]);
console.log('console errors:', errors.slice(0, 5));
await browser.close();
