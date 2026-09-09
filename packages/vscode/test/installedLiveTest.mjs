/** Smoke-test the normally installed live VSIX in an isolated VS Code profile. */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';
import { spawn, execFileSync } from 'node:child_process';
import { chromium } from '@playwright/test';

const artifacts = fs.mkdtempSync(path.join(os.tmpdir(), 'overlyx-installed-test-'));
const userData = path.join(artifacts, 'profile'), extensions = path.join(artifacts, 'extensions'), workspace = path.join(artifacts, 'workspace');
fs.mkdirSync(path.join(userData, 'User'), { recursive: true });
fs.mkdirSync(workspace);
fs.writeFileSync(path.join(userData, 'User/settings.json'), JSON.stringify({
  'workbench.editorAssociations': { '*.tex': 'overlyx.texEditor' }, 'security.workspace.trust.enabled': false,
  'update.mode': 'none', 'telemetry.telemetryLevel': 'off', 'workbench.startupEditor': 'none', 'overlyx.updates': 'off',
}));
if (process.argv[3]) {
  const dir = path.dirname(process.argv[3]);
  for (const entry of fs.readdirSync(dir)) if (entry.endsWith('.tex')) fs.copyFileSync(path.join(dir, entry), path.join(workspace, entry));
  fs.symlinkSync(path.join(dir, 'figures'), path.join(workspace, 'figures'));
} else fs.writeFileSync(path.join(workspace, 'main.tex'), '\\documentclass{article}\n\\newcommand{\\RR}{\\mathbb R}\n\\begin{document}\n\\section{Live extension}\nA normally installed editor renders $\\RR$.\n\\end{document}\n');
const documentPath = path.join(workspace, process.argv[3] ? path.basename(process.argv[3]) : 'main.tex');
// A separate test driver uses the public openWith command after extension registration.
// OverLyX itself is still installed normally and runs in production extension mode.
const driver = path.join(artifacts, 'driver');
fs.mkdirSync(driver);
fs.writeFileSync(path.join(driver, 'package.json'), JSON.stringify({ name: 'overlyx-test-driver', publisher: 'test', version: '1.0.0', engines: { vscode: '^1.90.0' }, main: './index.cjs', activationEvents: ['onStartupFinished'] }));
fs.writeFileSync(path.join(driver, 'index.cjs'), `exports.activate = async () => { const vscode = require('vscode'); await vscode.commands.executeCommand('vscode.openWith', vscode.Uri.file(${JSON.stringify(documentPath)}), 'overlyx.texEditor'); };`);
const cli = process.env.VSCODE_TEST_CLI || '/usr/share/code/bin/code';
const exe = process.env.VSCODE_TEST_EXE || '/usr/share/code/code';
execFileSync(cli, ['--user-data-dir', userData, '--extensions-dir', extensions, '--install-extension', process.argv[2], '--force'], { stdio: 'inherit' });
const output = fs.openSync(path.join(artifacts, 'vscode.log'), 'a');
const child = spawn(exe, ['--no-sandbox', '--disable-gpu', '--disable-dev-shm-usage', '--disable-updates', '--skip-welcome', '--skip-release-notes',
  '--user-data-dir', userData, '--extensions-dir', extensions, '--extensionDevelopmentPath=' + driver, '--remote-debugging-port=0', workspace], { detached: true, stdio: ['ignore', output, output] });
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
async function until(fn, message) {
  const deadline = Date.now() + 60000;
  while (Date.now() < deadline) { const result = await fn(); if (result) return result; await sleep(250); }
  throw new Error(`Timeout: ${message}. Logs: ${artifacts}`);
}
let browser;
try {
  const endpoint = await until(() => /DevTools listening on (ws:\/\/\S+)/.exec(fs.readFileSync(path.join(artifacts, 'vscode.log'), 'utf8'))?.[1], 'VS Code debugger');
  browser = await chromium.connectOverCDP(endpoint);
  const context = browser.contexts()[0];
  const page = await until(async () => { for (const p of context.pages()) if (await p.locator('.monaco-workbench').count()) return p; }, 'workbench');
  const frame = await until(async () => {
    for (const f of page.frames()) if (await f.locator('.lyx-editor').count()) return f;
  }, 'installed live editor');
  await frame.waitForFunction(() => !!window.overlyx?.activeView);
  await sleep(4000);
  const result = await frame.evaluate(() => ({
    formulas: document.querySelectorAll('.katex').length,
    errors: [...document.querySelectorAll('.katex-error,.lm-error,.lm-unknown')].map(n => n.textContent),
    live: [...document.scripts].some(s => s.src.includes('/@vite/client')),
    iconsLoaded: [...document.querySelectorAll('img.tb-img')].every(i => i.complete && i.naturalWidth > 0),
  }));
  console.log(result);
  assert.ok(result.formulas > 0);
  assert.deepEqual(result.errors, []);
  assert.equal(result.live, true);
  assert.equal(result.iconsLoaded, true);
  await page.screenshot({ path: path.join(artifacts, 'installed.png') });
  console.log('PASS: normal VSIX installation, source loader, real VS Code webview, HTTP bridge and macro rendering. Artifacts:', artifacts);
} finally {
  if (browser) await browser.close();
  process.kill(-child.pid, 'SIGTERM');
  fs.closeSync(output);
}
