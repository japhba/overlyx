// Opens a document, measures time to first paint of paragraphs and to "settled", and captures a CPU profile.
import { chromium } from '@playwright/test';
import fs from 'node:fs';

const BASE = process.env.BASE ?? 'http://127.0.0.1:3001';
const DOC = process.env.DOC ?? 'recurrent_feature/main.lyx';
const CREDS = { username: 'admin', password: process.env.PASS ?? fs.readFileSync(process.env.CREDS, 'utf8').trim().split('\n').filter(l => l.startsWith('admin\t')).pop().split('\t')[1] };
const OUT = process.env.OUT ?? 'profile.cpuprofile';
const CPU = process.env.CPU !== '0';

const browser = await chromium.launch();
const ctx = await browser.newContext({ viewport: { width: 1400, height: 900 } });
const r = await ctx.request.post(BASE + '/api/auth/login', { data: CREDS });
if (!r.ok()) throw new Error('login failed ' + r.status());
const page = await ctx.newPage();
page.on('pageerror', e => console.log('pageerror', e.message));
page.on('console', m => { if (m.type() === 'error' || m.text().startsWith('[perf]')) console.log('console', m.text()); });
const timings = [];
page.on('response', async (res) => {
  const u = res.url();
  if (u.includes('/api/')) timings.push({ url: u.replace(BASE, ''), status: res.status(), t: Date.now() });
});
page.on('websocket', ws => { const t = Date.now(); ws.on('framereceived', f => console.log('  ws recv', Date.now() - t0, 'ms', f.payload.length, 'bytes')); ws.on('framesent', f => console.log('  ws sent', Date.now() - t0, 'ms', f.payload.length, 'bytes')); });
await page.goto(BASE + '/');
await page.waitForSelector('.menubar', { timeout: 20000 });
await page.evaluate(() => { performance.mark('open'); });
if (process.env.STYLE) await page.addStyleTag({ content: process.env.STYLE });

const t0 = Date.now();
const cdp = await ctx.newCDPSession(page);
if (CPU) { await cdp.send('Profiler.enable'); await cdp.send('Profiler.setSamplingInterval', { interval: 500 }); await cdp.send('Profiler.start'); }
await page.evaluate((id) => { location.hash = '#/' + id; }, DOC);
await page.waitForSelector('.lyx-editor .lyx-par', { timeout: 120000 });
const tFirst = Date.now() - t0;
const pendingAtFirst = await page.evaluate(() => ({ pending: document.querySelectorAll('.lyx-math-static.pending').length, visiblePending: [...document.querySelectorAll('.lyx-math-static.pending')].filter(e => { const r = e.getBoundingClientRect(); return r.bottom > 0 && r.top < innerHeight; }).length }));
if (process.env.SHOT) await page.screenshot({ path: process.env.SHOT + '-first.png' });
// settled: no DOM mutation for 800ms and no long task
const tSettled = await page.evaluate(() => new Promise((resolve) => {
  const start = performance.now();
  let last = performance.now();
  const mo = new MutationObserver(() => { last = performance.now(); });
  mo.observe(document.body, { subtree: true, childList: true, attributes: true, characterData: true });
  const tick = () => { if (performance.now() - last > 800) { mo.disconnect(); resolve(Math.round(last - start)); } else setTimeout(tick, 100); };
  tick();
}));
const total = Date.now() - t0;
const pendingAtEnd = await page.evaluate(() => document.querySelectorAll('.lyx-math-static.pending').length);
if (process.env.SHOT) await page.screenshot({ path: process.env.SHOT + '-settled.png' });
// re-open the same document in this browser (local IndexedDB copy present)
await page.evaluate(() => { location.hash = ''; });
await page.waitForFunction(() => !document.querySelector('.lyx-editor'));
const t1 = Date.now();
await page.evaluate((id) => { location.hash = '#/' + id; }, DOC);
await page.waitForSelector('.lyx-editor .lyx-par', { timeout: 120000 });
const reopen = Date.now() - t1;
const marks = await page.evaluate(() => performance.getEntriesByType('mark').filter(m => m.name.startsWith('ol:')).map(m => m.name + '@' + Math.round(m.startTime)).join(' '));
console.log('reopen first paragraph', reopen, 'ms; marks:', marks);
const saveText = await page.evaluate(() => document.querySelector('.save-state')?.textContent);
console.log('save indicator:', saveText);
console.log('pending at first paint', JSON.stringify(pendingAtFirst), 'pending at end', pendingAtEnd);
let prof = null;
if (CPU) { prof = (await cdp.send('Profiler.stop')).profile; fs.writeFileSync(OUT, JSON.stringify(prof)); }
const counts = await page.evaluate(() => ({
  pars: document.querySelectorAll('.lyx-editor .lyx-par').length,
  mathStatic: document.querySelectorAll('.lyx-math-static').length,
  mathFields: document.querySelectorAll('.lyx-math-field, math-field').length,
  insets: document.querySelectorAll('.lyx-inset').length,
  nodes: document.querySelectorAll('.lyx-editor *').length,
  images: document.images.length,
}));
const longTasks = await page.evaluate(() => performance.getEntriesByType('longtask').length);
console.log(JSON.stringify({ doc: DOC, firstParagraphMs: tFirst, settledAfterFirstMs: tSettled, totalMs: total, counts, longTasks }, null, 1));
for (const t of timings) console.log('  api', t.t - t0, 'ms', t.status, t.url.slice(0, 90));
await browser.close();

if (prof) {
  // summarize self time by function
  const nodes = new Map(prof.nodes.map(n => [n.id, n]));
  const self = new Map();
  const dt = prof.timeDeltas; const samples = prof.samples;
  const byId = new Map();
  for (let i = 0; i < samples.length; i++) byId.set(samples[i], (byId.get(samples[i]) ?? 0) + (dt[i] ?? 0));
  for (const [id, t] of byId) {
    const n = nodes.get(id); const cf = n.callFrame;
    const key = `${cf.functionName || '(anon)'} ${cf.url.split('/').pop()}:${cf.lineNumber}`;
    self.set(key, (self.get(key) ?? 0) + t);
  }
  const totalT = [...self.values()].reduce((a, b) => a + b, 0);
  console.log('\nprofile total', Math.round(totalT / 1000), 'ms; top self time:');
  for (const [k, t] of [...self.entries()].sort((a, b) => b[1] - a[1]).slice(0, 40)) console.log(String(Math.round(t / 1000)).padStart(6), 'ms', k);
  // inclusive time for interesting functions
  const parent = new Map();
  for (const n of prof.nodes) for (const c of n.children ?? []) parent.set(c, n.id);
  const incl = new Map();
  for (const [id, t] of byId) {
    const seen = new Set();
    let cur = id;
    while (cur !== undefined) {
      const cf = nodes.get(cur).callFrame; const key = `${cf.functionName || '(anon)'} ${cf.url.split('/').pop()}:${cf.lineNumber}`;
      if (!seen.has(key)) { seen.add(key); incl.set(key, (incl.get(key) ?? 0) + t); }
      cur = parent.get(cur);
    }
  }
  console.log('\ntop inclusive time:');
  for (const [k, t] of [...incl.entries()].sort((a, b) => b[1] - a[1]).slice(0, 60)) console.log(String(Math.round(t / 1000)).padStart(6), 'ms', k);
}
