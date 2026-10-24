/**
 * An HTML article in the real extension (VS Code under xvfb, driven over CDP like probeEditing.mjs):
 * it opens in the document editor (not on the slide canvas), the pane switch reads
 * WYSIWYM · HTML · Page, the Page pane shows the page running, its HTML blocks run in the editor,
 * and an edit reaches the page. The workspace is edited (not saved): pass a copy.
 *
 *   xvfb-run -a -s "-screen 0 1600x1000x24" node test/probeArticle.mjs <workspace dir> <article.html> [out dir]
 *
 * Screenshots and report.json go to the out dir.
 */
import { downloadAndUnzipVSCode } from '@vscode/test-electron';
import { chromium } from '@playwright/test';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const pkg = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const [ws, file, outArg] = process.argv.slice(2);
if (!ws || !file) { console.error('usage: probeArticle.mjs <workspace dir> <article.html> [out dir]'); process.exit(2); }
const out = outArg ?? path.join(pkg, 'test/probe-shots');
fs.mkdirSync(out, { recursive: true });
const log = (...a) => console.log('[probe]', ...a);
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
async function until(fn, ms, what) {
  const t0 = Date.now();
  let last;
  while (Date.now() - t0 < ms) {
    try { const v = await fn(); if (v) return v; } catch (e) { last = e; }
    await sleep(300);
  }
  throw new Error('timeout waiting for ' + what + (last ? ' — last error: ' + last : ''));
}

const udd = fs.mkdtempSync(path.join(os.tmpdir(), 'overlyx-probe-udd-'));
const extDir = fs.mkdtempSync(path.join(os.tmpdir(), 'overlyx-probe-ext-'));
fs.mkdirSync(path.join(udd, 'User'), { recursive: true });
fs.writeFileSync(path.join(udd, 'User/settings.json'), JSON.stringify({
  'workbench.editorAssociations': { '*.html': 'overlyx.htmlEditor' },
  'security.workspace.trust.enabled': false, 'update.mode': 'none', 'telemetry.telemetryLevel': 'off',
  'workbench.startupEditor': 'none', 'window.restoreWindows': 'none', 'workbench.colorTheme': 'Default Light Modern',
}, null, 2));
const exe = await downloadAndUnzipVSCode({ cachePath: path.join(pkg, '.vscode-test') });
const PORT = 9344;
const child = spawn(exe, [
  '--no-sandbox', '--disable-gpu', '--disable-dev-shm-usage', '--disable-workspace-trust', '--disable-updates', '--disable-crash-reporter',
  '--skip-welcome', '--skip-release-notes', '--disable-extensions', '--extensionDevelopmentPath=' + pkg,
  '--user-data-dir=' + udd, '--extensions-dir=' + extDir, '--remote-debugging-port=' + PORT, ws, path.resolve(ws, file),
], { detached: true, env: { ...process.env, DONT_PROMPT_WSL_INSTALL: '1' } });
const kill = () => { try { process.kill(-child.pid, 'SIGKILL'); } catch { /* gone */ } };
process.on('exit', kill);

const result = { console: [] };
try {
  await until(async () => (await fetch('http://127.0.0.1:' + PORT + '/json/version')).ok, 60000, 'the CDP endpoint');
  const browser = await chromium.connectOverCDP('http://127.0.0.1:' + PORT);
  const ctx = browser.contexts()[0];
  const page = await until(async () => {
    for (const p of ctx.pages()) { try { if (await p.$('.monaco-workbench')) return p; } catch { /* not ready */ } }
    return null;
  }, 60000, 'the workbench page');
  page.setDefaultTimeout(30000);
  page.on('console', m => { if (m.type() === 'error' || m.type() === 'warning') result.console.push(`${m.type()}: ${m.text().slice(0, 300)}`); });
  ctx.on('response', r => { if (r.status() >= 400) result.console.push(`HTTP ${r.status()} ${r.url().replace(/\/(t|d)\/[0-9a-f]+\//, '/$1/…/').slice(0, 200)}`); });
  const frame = await until(async () => {
    for (const f of page.frames()) { try { if (await f.$('.lyx-editor')) return f; } catch { /* frame gone */ } }
    return null;
  }, 90000, 'the OverLyX document editor (an article must not open on the slide canvas)');
  await sleep(5000);
  result.chips = await frame.$$eval('[data-pane-chip]', els => els.map(e => e.textContent?.trim()));
  result.articleClass = await frame.$eval('.lyx-editor', el => el.classList.contains('ol-article'));
  result.htmlBlocks = await frame.$$eval('.lyx-editor iframe', els => els.map(e => e.getAttribute('src')?.replace(/\/d\/[0-9a-f]+\//, '/d/…/')));
  log('chips', result.chips, 'article look', result.articleClass, 'block frames', result.htmlBlocks.length);
  await page.screenshot({ path: path.join(out, 'article-1-editor.png') });

  // the Page pane
  await frame.click('[data-pane-chip="pdf"]');
  const pageFrame = await until(async () => frame.$('[data-article-page] iframe'), 20000, 'the Page pane frame');
  result.pageSrc = (await pageFrame.getAttribute('src'))?.replace(/\/d\/[0-9a-f]+\//, '/d/…/');
  await sleep(4000);
  const inner = await pageFrame.contentFrame();
  result.pageTitle = inner ? await inner.$eval('h1', h => h.textContent).catch(e => 'unreadable: ' + e.message.slice(0, 80)) : 'no frame';
  log('page', result.pageSrc, 'h1', result.pageTitle);
  await page.screenshot({ path: path.join(out, 'article-2-page.png') });

  // an edit reaches the page (a moment after it reached the file)
  await frame.click('.outline-panel .hide').catch(() => {});
  await frame.locator('.lyx-editor').getByText('What was found.').click();
  await page.keyboard.press('End');
  await page.keyboard.type(' Probe edit arrives.', { delay: 30 });
  await sleep(4500);
  const inner2 = await (await frame.$('[data-article-page] iframe'))?.contentFrame();
  result.pageHasEdit = inner2 ? await inner2.evaluate(() => document.body.innerText.includes('Probe edit arrives.')).catch(e => 'unreadable: ' + e.message.slice(0, 80)) : 'no frame';
  result.fileDirty = await page.$eval('.tab.active', t => t.classList.contains('dirty')).catch(() => null);
  log('edit on the page', result.pageHasEdit, 'tab dirty', result.fileDirty);
  await page.screenshot({ path: path.join(out, 'article-3-edited.png') });
} catch (e) {
  result.error = String(e?.stack ?? e);
  log('FAILED', result.error);
} finally {
  fs.writeFileSync(path.join(out, 'report.json'), JSON.stringify(result, null, 2));
  kill();
  process.exit(0);
}
