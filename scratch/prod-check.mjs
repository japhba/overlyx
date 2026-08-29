import { chromium } from '@playwright/test';
import { readFileSync } from 'node:fs';
const BASE = 'http://127.0.0.1:8080';
const [username, password] = readFileSync('/root/lyx/overlyx/data/credentials.txt', 'utf8').split('\n').filter(l => l.startsWith('admin\t')).pop().split('\t');
const browser = await chromium.launch(); const ctx = await browser.newContext({ viewport: { width: 1280, height: 860 } });
await ctx.addInitScript(() => { localStorage.setItem('ol.tour', 'e2e'); localStorage.setItem('ol.prefs', JSON.stringify({ spellcheck: true, aiRewrite: true, aiCompleteText: true, aiCompleteMath: true, aiCompleteDelay: 450 })); });
const page = await ctx.newPage();
page.on('pageerror', e => console.log('pageerror', e.message));
page.on('console', m => { if (m.type() === 'error' || m.type() === 'warning') console.log('console:', m.type(), m.text().slice(0, 200)); });
page.on('response', async r => { if (r.url().includes('/ai/')) { let t = ''; try { t = (await r.text()).slice(0, 160); } catch {} console.log('response', r.status(), t); } });
await page.goto(BASE + '/'); await page.locator('[data-password-login], input[placeholder="Username"]').first().waitFor();
if (await page.locator('[data-password-login]').count()) await page.locator('[data-password-login]').click();
await page.getByPlaceholder('Username').fill(username); await page.getByPlaceholder('Password').fill(password); await page.getByRole('button', { name: 'Sign in' }).click(); await page.waitForSelector('.menubar');
await page.goto(BASE + '/#/welcome-admin/welcome.tex');
await page.waitForFunction(() => document.querySelectorAll('.lyx-editor .lyx-par').length > 3, null, { timeout: 30000 }); await page.waitForTimeout(1500);
console.log('ai ctx:', await page.evaluate(() => JSON.stringify(window.overlyx.ai)), 'prefs:', await page.evaluate(() => localStorage.getItem('ol.prefs')));
// cursor at the end of the 3rd top-level paragraph
await page.locator('.lyx-editor .lyx-par').nth(2).click({ position: { x: 12, y: 8 } });
await page.evaluate(() => { const v = window.overlyx.activeView; const doc = v.state.doc; let end = 0; for (let k = 0; k <= 2; k++) end += doc.child(k).nodeSize; v.dispatch(v.state.tr.setSelection(v.state.selection.constructor.create(doc, end - 1))); });
console.log('paragraph:', (await page.locator('.lyx-editor .lyx-par').nth(2).textContent()).slice(0, 120));
await page.keyboard.type(' In this document we', { delay: 60 });
for (let i = 0; i < 8; i++) { await page.waitForTimeout(500); const n = await page.locator('.ai-ghost').count(); const busy = await page.locator('[data-ai-busy]').count(); console.log(`t=${(i + 1) * 0.5}s ghost=${n} busy=${busy}`); if (n) break; }
console.log('ghost text:', await page.locator('.ai-ghost').textContent().catch(() => '(none)'));
await page.screenshot({ path: '/root/.claude/jobs/9387b0c1/tmp/shots/prod-ghost.png' });
// continuous typing scenario: keep typing while requests are in flight, then pause
await page.keyboard.press('Escape');
await page.keyboard.type(' and then we will show', { delay: 120 });
for (let i = 0; i < 8; i++) { await page.waitForTimeout(500); const n = await page.locator('.ai-ghost').count(); console.log(`t=${(i + 1) * 0.5}s ghost=${n}`); if (n) break; }
console.log('ghost text 2:', await page.locator('.ai-ghost').textContent().catch(() => '(none)'));
// undo the typing so the welcome document stays as it was
await page.evaluate(() => { const v = window.overlyx.activeView; const doc = v.state.doc; let start = 0; for (let k = 0; k < 2; k++) start += doc.child(k).nodeSize; const par = doc.child(2); const txt = par.textContent; const i = txt.indexOf(' In this document we'); if (i >= 0) v.dispatch(v.state.tr.delete(start + 1 + i, start + 1 + par.content.size)); });
await page.waitForTimeout(500);
console.log('paragraph after cleanup:', (await page.locator('.lyx-editor .lyx-par').nth(2).textContent()).slice(-60));
await browser.close();
