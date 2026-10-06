/**
 * An AI agent's edit arriving in an open OverLyX editor (VS Code under xvfb, driven over CDP like
 * probeEditing.mjs): the document gets an unsaved edit typed into the editor, then the local tool
 * server (dist/agents.cjs — what Claude Code / Codex start) edits the same file as a tracked change
 * and comments on it. The editor must show the agent's change (author, insertion and deletion) and
 * the comment, and keep the typed text. The file has no OverLyX block, so the edit is only allowed
 * because the window lists it as open (agents/openDocuments.ts). The workspace is edited: pass a copy.
 *
 *   npm run build -w packages/vscode
 *   xvfb-run -a -s "-screen 0 1600x1000x24" node test/probeAgentEdit.mjs <workspace dir> <file.tex> <out dir>
 *
 * The file must contain the words "compute" and "odd spacing" (see the calls below).
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
if (!ws || !file) { console.error('usage: probeAgentEdit.mjs <workspace dir> <file.tex> [out dir]'); process.exit(2); }
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

/** one MCP session with the local tool server, as an agent holds it */
async function agentSession(cwd, agentsDir, calls) {
  const child = spawn(process.execPath, [path.join(pkg, 'dist/agents.cjs')], { cwd, env: { ...process.env, OVERLYX_AGENTS_DIR: agentsDir }, stdio: ['pipe', 'pipe', 'inherit'] });
  let buf = '';
  const waiting = new Map();
  child.stdout.on('data', d => { buf += d; for (let i; (i = buf.indexOf('\n')) >= 0;) { const m = JSON.parse(buf.slice(0, i)); buf = buf.slice(i + 1); waiting.get(m.id)?.(m); } });
  let id = 0;
  const rpc = (method, params) => new Promise(r => { const n = ++id; waiting.set(n, r); child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: n, method, params }) + '\n'); });
  await rpc('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'claude-code', version: 'probe' } });
  child.stdin.write(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }) + '\n');
  const results = [];
  for (const c of calls) results.push((await rpc('tools/call', c)).result);
  child.stdin.end();
  return results;
}

const udd = fs.mkdtempSync(path.join(os.tmpdir(), 'overlyx-probe-udd-'));
const extDir = fs.mkdtempSync(path.join(os.tmpdir(), 'overlyx-probe-ext-'));
fs.mkdirSync(path.join(udd, 'User'), { recursive: true });
fs.writeFileSync(path.join(udd, 'User/settings.json'), JSON.stringify({
  'workbench.editorAssociations': { '*.tex': 'overlyx.texEditor' },
  'security.workspace.trust.enabled': false, 'update.mode': 'none', 'telemetry.telemetryLevel': 'off',
  'workbench.startupEditor': 'none', 'window.restoreWindows': 'none', 'workbench.colorTheme': 'Default Light Modern',
  'files.autoSave': 'off',
}, null, 2));
const agentsDir = path.join(udd, 'User/globalStorage/overlyx.overlyx-vscode/agents');
const exe = await downloadAndUnzipVSCode({ cachePath: path.join(pkg, '.vscode-test') });
const PORT = 9343;
const child = spawn(exe, [
  '--no-sandbox', '--disable-gpu', '--disable-dev-shm-usage', '--disable-workspace-trust', '--disable-updates', '--disable-crash-reporter',
  '--skip-welcome', '--skip-release-notes', '--disable-extensions', '--extensionDevelopmentPath=' + pkg,
  '--user-data-dir=' + udd, '--extensions-dir=' + extDir, '--remote-debugging-port=' + PORT, ws, path.resolve(ws, file),
], { detached: true, env: { ...process.env, DONT_PROMPT_WSL_INSTALL: '1' } });
const kill = () => { try { process.kill(-child.pid, 'SIGKILL'); } catch { /* gone */ } };
process.on('exit', kill);

const report = { console: [] };
let failed = false;
try {
  await until(async () => (await fetch('http://127.0.0.1:' + PORT + '/json/version')).ok, 60000, 'the CDP endpoint');
  const browser = await chromium.connectOverCDP('http://127.0.0.1:' + PORT);
  const ctx = browser.contexts()[0];
  const page = await until(async () => {
    for (const p of ctx.pages()) { try { if (await p.$('.monaco-workbench')) return p; } catch { /* not ready */ } }
    return null;
  }, 60000, 'the workbench page');
  page.setDefaultTimeout(30000);
  page.on('console', m => { if (m.type() === 'error') report.console.push(m.text().slice(0, 300)); });
  const frame = await until(async () => {
    for (const f of page.frames()) { try { if (await f.$('.lyx-editor')) return f; } catch { /* frame gone */ } }
    return null;
  }, 90000, 'the OverLyX editor webview');
  await sleep(4000);

  // the window lists the file as open in an OverLyX editor
  report.openList = await until(() => { try { return fs.readdirSync(path.join(agentsDir, 'open')).map(n => JSON.parse(fs.readFileSync(path.join(agentsDir, 'open', n), 'utf8'))); } catch { return null; } }, 20000, 'the open-documents list');
  log('open documents:', JSON.stringify(report.openList));

  // an unsaved edit: typed at the start of the first paragraph that has text
  await frame.evaluate(() => {
    const view = window.overlyx.activeView;
    let at = -1;
    view.state.doc.descendants((n, pos) => { if (at < 0 && n.isTextblock && n.textContent.includes('quick')) at = pos + 1; return at < 0; });
    view.dispatch(view.state.tr.setSelection(view.state.selection.constructor.near(view.state.doc.resolve(at))));
    view.focus();
  });
  await page.keyboard.type('Typed first. ');
  await sleep(1500);
  report.dirtyTab = await page.evaluate(() => !!document.querySelector('.tab.dirty'));

  // the agent's edits, through the files
  const results = await agentSession(ws, agentsDir, [
    { name: 'edit_document', arguments: { path: file, old_text: 'compute', new_text: 'estimate' } },
    { name: 'add_comment', arguments: { path: file, text: 'The spacing looks accidental.', at: 'odd spacing' } },
  ]);
  report.tools = results.map(r => ({ error: !!r.isError, text: r.content[0].text.slice(0, 300) }));
  log('tools:', JSON.stringify(report.tools));

  report.editor = await until(() => frame.evaluate(() => {
    const ed = document.querySelector('.lyx-editor');
    const added = [...ed.querySelectorAll('.lyx-change-inserted')].map(e => e.textContent);
    const deleted = [...ed.querySelectorAll('.lyx-change-deleted')].map(e => e.textContent);
    if (!added.some(t => t.includes('estimate'))) return null;
    const doc = window.overlyx.activeView.state.doc;
    return { added, deleted, typedKept: doc.textContent.includes('Typed first.'), comment: doc.textContent.includes('The spacing looks accidental.'), text: doc.textContent.slice(0, 400) };
  }), 30000, 'the agent\'s change in the editor').catch(async e => {
    report.editorAtTimeout = await frame.evaluate(() => ({ text: window.overlyx.activeView.state.doc.textContent.slice(0, 400), classes: [...new Set([...document.querySelectorAll('.lyx-editor [class*=change]')].map(x => x.className))] }));
    throw e;
  });
  log('editor:', JSON.stringify(report.editor));
  await frame.evaluate(() => document.querySelector('.lyx-editor .lyx-change-inserted')?.scrollIntoView({ block: 'center' }));
  await sleep(800);
  await page.screenshot({ path: path.join(out, 'agent-edit.png') });
  // the change bar with the author over the agent's change (once the metadata, which names the authors, has been reloaded: 1.5 s debounce)
  await sleep(3000);
  await frame.locator('.lyx-editor .lyx-change-inserted', { hasText: 'estimate' }).first().hover();
  await sleep(600);
  report.changeBar = await frame.evaluate(() => document.querySelector('.change-actions-author')?.textContent ?? null);
  log('change bar:', report.changeBar);
  await page.screenshot({ path: path.join(out, 'agent-edit-hover.png') });
  report.file = fs.readFileSync(path.resolve(ws, file), 'utf8');
  if (!report.editor.typedKept) { failed = true; log('FAIL: the typed text is gone'); }
  if (!report.editor.comment) { failed = true; log('FAIL: the comment did not arrive'); }
  if (!report.changeBar?.includes('Claude Code')) { failed = true; log('FAIL: the change bar does not name the agent'); }
  if (report.tools.some(t => t.error)) { failed = true; log('FAIL: a tool call failed'); }
} catch (e) {
  failed = true;
  log('FAIL:', e.message);
} finally {
  fs.writeFileSync(path.join(out, 'agent-edit-report.json'), JSON.stringify(report, null, 2));
  kill();
}
log(failed ? 'FAILED' : 'ok', '— report and screenshots in', out);
process.exit(failed ? 1 : 0);
