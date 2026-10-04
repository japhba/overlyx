// An older engine, simulated: Safari < 18.4 (no Iterator global) or < 26.2 (no Map.getOrInsertComputed /
// Math.sumPrecise) — does the app start, does the PDF viewer show a PDF? Usage: oldengine.mts <iterator|upsert> [webkit|chromium]
import { webkit, chromium } from '@playwright/test';
import { login, BASE_URL } from '../../e2e/helpers';
const mode = process.argv[2] ?? 'iterator';
const bt = { webkit, chromium }[process.argv[3] ?? 'webkit']!;
const browser = await bt.launch();
const ctx = await browser.newContext({ baseURL: BASE_URL, viewport: { width: 1400, height: 900 } });
await ctx.addInitScript(mode === 'iterator'
  ? 'delete globalThis.Iterator;'
  : 'delete Map.prototype.getOrInsertComputed; delete Map.prototype.getOrInsert; delete WeakMap.prototype.getOrInsertComputed; delete WeakMap.prototype.getOrInsert; delete Math.sumPrecise; delete Promise.try; delete Uint8Array.prototype.toBase64; delete Uint8Array.fromBase64;');
const page = await ctx.newPage();
const errors: string[] = [];
page.on('pageerror', e => errors.push(e.message));
try { await login(page); console.log('started: yes'); } catch (e) { console.log('started: NO', String(e).split('\n')[0]); }
console.log('errors', JSON.stringify(errors.slice(0, 3)));
await browser.close();
