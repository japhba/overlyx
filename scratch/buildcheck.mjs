// Checks the background PDF build (server stays responsive, job phases, cancel) and the ruler.
import { chromium } from '@playwright/test';
import fs from 'node:fs';

const BASE = process.env.BASE ?? 'http://localhost:5174';
const DOC = process.env.DOC ?? 'recurrent_feature/main.lyx';
const SHOT = process.env.SHOT ?? '/tmp/claude-0/-root-lyx/26b4c45d-bc72-457f-b17d-1167bb6b6240/scratchpad';
const password = fs.readFileSync(process.env.CREDS, 'utf8').trim().split('\n').filter(l => l.startsWith('admin\t')).pop().split('\t')[1];

const browser = await chromium.launch();
const ctx = await browser.newContext({ viewport: { width: 1500, height: 900 } });
const r = await ctx.request.post(BASE + '/api/auth/login', { data: { username: 'admin', password } });
if (!r.ok()) throw new Error('login failed');
const page = await ctx.newPage();
page.on('pageerror', e => console.log('pageerror', e.message));
page.on('console', m => { if (m.type() === 'error') console.log('console', m.text().slice(0, 160)); });
await page.goto(BASE + '/#/' + DOC);
await page.waitForSelector('.lyx-editor .lyx-par', { timeout: 60000 });
await page.waitForFunction(() => document.querySelector('.save-state')?.textContent?.includes('saved'), null, { timeout: 30000 });

// ---- ruler: drag the right handle, check the width setting follows
const before = await page.evaluate(() => ({ w: localStorage.getItem('ol.textWidth'), band: document.querySelector('.ruler-band')?.getBoundingClientRect().width }));
const handle = page.locator('.ruler .handle.right');
const hb = await handle.boundingBox();
await page.mouse.move(hb.x + hb.width / 2, hb.y + hb.height / 2);
await page.mouse.down();
await page.mouse.move(hb.x + 80, hb.y + 4, { steps: 8 });
await page.screenshot({ path: SHOT + '/ruler-drag.png', clip: { x: 260, y: 60, width: 1000, height: 260 } });
await page.mouse.up();
const after = await page.evaluate(() => ({ w: localStorage.getItem('ol.textWidth'), band: document.querySelector('.ruler-band')?.getBoundingClientRect().width, editor: document.querySelector('.lyx-editor')?.getBoundingClientRect().width }));
console.log('ruler: before', JSON.stringify(before), 'after drag', JSON.stringify(after));
await page.dblclick('.ruler-band', { position: { x: 200, y: 12 } });
console.log('after double-click reset:', await page.evaluate(() => localStorage.getItem('ol.textWidth')));

// ---- background build: start it, measure API latency while it runs, watch the phases
await page.locator('.tb-btn[title^="View PDF"]').click();
const t0 = Date.now();
const phases = new Set();
let latencies = [];
while (Date.now() - t0 < 300000) {
  const tl = Date.now();
  const res = await ctx.request.get(BASE + '/api/docs/' + encodeURIComponent(DOC) + '/build');
  latencies.push(Date.now() - tl);
  const j = await res.json();
  if (j.job) phases.add(j.job.status);
  const txt = await page.locator('.pdf-panel .build-progress').textContent().catch(() => null);
  if (j.job && ['ok', 'error', 'cancelled'].includes(j.job.status)) { console.log('build finished:', j.job.status, 'after', Math.round((Date.now() - t0) / 1000), 's; panel says:', await page.locator('.pdf-panel .bar span').textContent()); break; }
  if (latencies.length % 5 === 1) console.log('  ', Math.round((Date.now() - t0) / 1000) + 's', j.job?.status, '| panel:', (txt ?? '').slice(0, 90));
  await new Promise(r => setTimeout(r, 1000));
}
latencies.sort((a, b) => a - b);
console.log('phases seen:', [...phases].join(' → '), '| API latency during build: median', latencies[Math.floor(latencies.length / 2)], 'ms, max', latencies[latencies.length - 1], 'ms');
await page.screenshot({ path: SHOT + '/pdf-panel.png' });
console.log('iframe present:', await page.locator('.pdf-panel iframe').count());

// ---- cancel: start again and cancel right away
await page.locator('.pdf-panel .bar button', { hasText: 'View PDF' }).click();
await page.waitForSelector('.pdf-panel .bar button:has-text("Cancel")', { timeout: 10000 });
await page.locator('.pdf-panel .bar button', { hasText: 'Cancel' }).click();
await page.waitForFunction(() => !document.querySelector('.pdf-panel .bar button:disabled'), null, { timeout: 30000 });
const st = await (await ctx.request.get(BASE + '/api/docs/' + encodeURIComponent(DOC) + '/build')).json();
console.log('after cancel: job status', st.job?.status);
await browser.close();
