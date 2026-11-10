/**
 * Typing and Ctrl+Z in the real extension (VS Code under xvfb, driven over CDP like probeEditing.mjs):
 * a sentence is typed at the end of the first long paragraph in bursts, then undone and redone with
 * the keyboard. The paragraph is sampled every 100 ms after each key — an undo that leaves text behind,
 * text that comes back on its own, or characters that go missing while typing show up in the samples
 * (report.json `steps`). The file is saved at the end and compared with the editor.
 * VS Code's own Undo / Redo commands (the Edit menu's) are run on Ctrl+Alt+U / Ctrl+Alt+R.
 * The workspace is edited: pass a copy.
 *
 *   xvfb-run -a -s "-screen 0 1600x1000x24" node test/probeUndo.mjs <workspace dir> <file.tex> <out dir>
 *   AUTOSAVE=1 …   # files.autoSave afterDelay 1000
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
if (!ws || !file) { console.error('usage: probeUndo.mjs <workspace dir> <file.tex> [out dir]'); process.exit(2); }
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
  'workbench.editorAssociations': { '*.tex': 'overlyx.texEditor' },
  'security.workspace.trust.enabled': false, 'update.mode': 'none', 'telemetry.telemetryLevel': 'off',
  'workbench.startupEditor': 'none', 'window.restoreWindows': 'none', 'workbench.colorTheme': 'Default Light Modern',
  ...(process.env.AUTOSAVE ? { 'files.autoSave': 'afterDelay', 'files.autoSaveDelay': 1000 } : {}),
}, null, 2));
// VS Code's own Undo / Redo commands on keys the editor leaves alone (as the Edit menu runs them)
fs.writeFileSync(path.join(udd, 'User/keybindings.json'), JSON.stringify([{ key: 'ctrl+alt+u', command: 'undo' }, { key: 'ctrl+alt+r', command: 'redo' }]));
const exe = await downloadAndUnzipVSCode({ cachePath: path.join(pkg, '.vscode-test') });
const PORT = 9343;
const child = spawn(exe, [
  '--no-sandbox', '--disable-gpu', '--disable-dev-shm-usage', '--disable-workspace-trust', '--disable-updates', '--disable-crash-reporter',
  '--skip-welcome', '--skip-release-notes', '--disable-extensions', '--extensionDevelopmentPath=' + pkg,
  '--user-data-dir=' + udd, '--extensions-dir=' + extDir, '--remote-debugging-port=' + PORT, ws, path.resolve(ws, file),
], { detached: true, env: { ...process.env, DONT_PROMPT_WSL_INSTALL: '1' } });
const kill = () => { try { process.kill(-child.pid, 'SIGKILL'); } catch { /* gone */ } };
process.on('exit', kill);

const result = { console: [], steps: [] };
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
  await sleep(4000);
  const frame = await until(async () => {
    for (const f of page.frames()) { try { if (await f.$('.lyx-editor')) return f; } catch { /* frame gone */ } }
    return null;
  }, 90000, 'the OverLyX editor webview');
  await sleep(5000);

  /** the first long paragraph's text */
  const para = () => frame.evaluate(() => {
    let t = '';
    window.overlyx.activeView.state.doc.descendants(n => { if (!t && n.isTextblock && n.textContent.length > 100) t = n.textContent; return !t; });
    return t;
  });
  await frame.evaluate(() => {
    const v = window.overlyx.activeView;
    let end = -1;
    v.state.doc.descendants((n, pos) => { if (end < 0 && n.isTextblock && n.textContent.length > 100) end = pos + 1 + n.content.size; return end < 0; });
    v.dispatch(v.state.tr.setSelection(v.state.selection.constructor.near(v.state.doc.resolve(end))).scrollIntoView());
    v.focus();
  });
  await sleep(300);
  const original = await para();
  const tail = s => s.slice(original.length - 12);
  /** the paragraph every 100 ms for `ms`: the distinct values in order */
  const watch = async (ms) => {
    const seen = [];
    for (let t = 0; t < ms; t += 100) { const p = tail(await para()); if (seen[seen.length - 1] !== p) seen.push(p); await sleep(100); }
    return seen;
  };
  const step = async (name, act, ms = 2500) => {
    await act();
    const seen = await watch(ms);
    result.steps.push({ name, seen });
    log(name, JSON.stringify(seen));
  };

  const typeWords = async (words, delay) => { for (const ch of words) { await page.keyboard.type(ch); await sleep(delay); } };
  await step('type " alpha beta gamma" (90 ms per key)', () => typeWords(' alpha beta gamma', 90));
  await step('type " delta" after a pause', () => typeWords(' delta', 90));
  await step('Ctrl+Z', () => page.keyboard.press('Control+z'));
  await step('Ctrl+Z', () => page.keyboard.press('Control+z'));
  await step('Ctrl+Z', () => page.keyboard.press('Control+z'));
  await step('Ctrl+Shift+Z', () => page.keyboard.press('Control+Shift+z'));
  await step('type " epsilon" right after an undo', async () => { await page.keyboard.press('Control+z'); await sleep(150); await typeWords(' epsilon', 90); }, 3000);
  await step('type " zeta"', () => typeWords(' zeta', 90));
  await step("VS Code's Undo command", () => page.keyboard.press('Control+Alt+u'));
  await step("VS Code's Redo command", () => page.keyboard.press('Control+Alt+r'));
  await step('Ctrl+S', () => page.keyboard.press('Control+s'), 2000);
  // a plain textarea (a comment, the find box): the browser's own undo
  await frame.evaluate(() => { const t = document.createElement('textarea'); t.id = 'probe-ta'; t.style.cssText = 'position:fixed;top:10px;left:10px;z-index:99999'; document.body.append(t); t.focus(); });
  await page.keyboard.type('one two', { delay: 60 });
  await sleep(700);
  await page.keyboard.type(' three', { delay: 60 });
  await sleep(300);
  await page.keyboard.press('Control+z');
  await sleep(300);
  result.textarea = await frame.evaluate(() => { const t = document.getElementById('probe-ta'); const v = t.value; t.remove(); return v; });
  log('textarea after Ctrl+Z', JSON.stringify(result.textarea));
  const editorText = await para();
  const disk = fs.readFileSync(path.resolve(ws, file), 'utf8');
  result.final = { editor: tail(editorText), diskHasIt: disk.includes(editorText.slice(-40)) };
  log('final', JSON.stringify(result.final));
  await page.screenshot({ path: path.join(out, 'undo.png') });
  fs.writeFileSync(path.join(out, 'report.json'), JSON.stringify(result, null, 2));
} catch (e) {
  console.error(e);
  fs.writeFileSync(path.join(out, 'report.json'), JSON.stringify({ ...result, error: String(e) }, null, 2));
  process.exitCode = 1;
} finally {
  kill();
}
