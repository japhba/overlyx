/**
 * GUI test: launches the cached VS Code under xvfb with --remote-debugging-port, connects
 * Playwright over CDP and drives the *rendered* UI — opens a .tex in the OverLyX custom editor,
 * checks the WYSIWYG rendering (headings, KaTeX formulas, toolbar icons), types into the
 * document, saves with Ctrl+S and verifies the text reached the .tex file on disk, opens the
 * Structure view, builds the PDF and waits for pdf.js to paint pages. Screenshots at every step
 * go to test/gui-shots/. Run: `npm run test:gui` (xvfb-run wrapper).
 */
import { downloadAndUnzipVSCode } from '@vscode/test-electron';
import { chromium } from '@playwright/test';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const pkg = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const shots = path.join(pkg, 'test/gui-shots');
fs.rmSync(shots, { recursive: true, force: true });
fs.mkdirSync(shots, { recursive: true });

const log = (...a) => console.log('[gui-test]', ...a);
const fail = (msg) => { console.error('[gui-test] FAIL:', msg); process.exitCode = 1; throw new Error(msg); };
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
async function until(fn, ms, what) {
  const t0 = Date.now();
  let last;
  while (Date.now() - t0 < ms) {
    try { const v = await fn(); if (v) return v; } catch (e) { last = e; }
    await sleep(300);
  }
  fail('timeout waiting for ' + what + (last ? ' — last error: ' + last : ''));
}

/* ---------------------------------------------------------------- fixture workspace */
const MAIN = [
  '\\documentclass{article}',
  '\\usepackage{amsmath,amssymb}',
  '\\newcommand{\\RR}{\\mathbb{R}}',
  '\\begin{document}',
  '',
  '\\section{Introduction}',
  '',
  'Functions on $\\RR$ are studied, see \\eqref{eq:main}.',
  '',
  '\\begin{equation}',
  'f(x)=x^{2}\\label{eq:main}',
  '\\end{equation}',
  '',
  '\\section{Methods}',
  '',
  'Inline math $a+b=c$ inside running text.',
  '',
  '\\end{document}',
  '',
].join('\n');
const ws = fs.mkdtempSync(path.join(os.tmpdir(), 'overlyx-gui-ws-'));
fs.writeFileSync(path.join(ws, 'main.tex'), MAIN);

/* ---------------------------------------------------------------- VS Code launch */
const udd = fs.mkdtempSync(path.join(os.tmpdir(), 'overlyx-gui-udd-'));
const extDir = fs.mkdtempSync(path.join(os.tmpdir(), 'overlyx-gui-ext-'));
fs.mkdirSync(path.join(udd, 'User'), { recursive: true });
fs.writeFileSync(path.join(udd, 'User/settings.json'), JSON.stringify({
  'workbench.editorAssociations': { '*.tex': 'overlyx.texEditor' },
  'security.workspace.trust.enabled': false,
  'update.mode': 'none',
  'telemetry.telemetryLevel': 'off',
  'workbench.startupEditor': 'none',
  'window.restoreWindows': 'none',
  'workbench.colorTheme': 'Default Light Modern',
}, null, 2));

const exe = await downloadAndUnzipVSCode({ cachePath: path.join(pkg, '.vscode-test') });
const PORT = 9339;
const child = spawn(exe, [
  '--no-sandbox', '--disable-gpu', '--disable-dev-shm-usage', '--disable-workspace-trust',
  '--disable-updates', '--disable-crash-reporter', '--skip-welcome', '--skip-release-notes',
  '--disable-extensions', '--extensionDevelopmentPath=' + pkg,
  '--user-data-dir=' + udd, '--extensions-dir=' + extDir,
  '--remote-debugging-port=' + PORT, ws, path.join(ws, 'main.tex'),
], { detached: true, env: { ...process.env, DONT_PROMPT_WSL_INSTALL: '1' } });
const kill = () => { try { process.kill(-child.pid, 'SIGKILL'); } catch { /* gone */ } };
process.on('exit', kill);

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
  const shot = async (name) => { await page.screenshot({ path: path.join(shots, name + '.png') }); log('screenshot', name); };
  log('workbench up');

  const dumpState = async () => {
    log('frames:', JSON.stringify(page.frames().map(f => f.url()).filter(u => u && u !== 'about:blank')));
    try {
      const t = await (await fetch('http://127.0.0.1:' + PORT + '/json/list')).json();
      log('cdp targets:', JSON.stringify(t.map(x => x.type + ' ' + String(x.url || '').slice(0, 80))));
    } catch (e) { log('target list failed', String(e)); }
    try {
      const notes = await page.$$eval('.notification-list-item-message', els => els.map(e => e.textContent));
      if (notes.length) log('notifications:', JSON.stringify(notes));
    } catch { /* none */ }
    try {
      const tabs = await page.$$eval('.tabs-container .tab', els => els.map(e => e.getAttribute('aria-label')));
      log('tabs:', JSON.stringify(tabs));
    } catch { /* none */ }
  };

  /* ---- 1. main.tex was passed on the command line; the association opens it in OverLyX ---- */
  await sleep(4000);
  await shot('00-after-open');
  await dumpState();
  const findEditorFrame = async () => {
    for (const f of page.frames()) { try { if (await f.$('.lyx-editor')) return f; } catch { /* frame gone */ } }
    return null;
  };
  let editorFrame;
  try {
    editorFrame = await until(findEditorFrame, 60000, 'the OverLyX editor webview');
  } catch (e) {
    await dumpState();
    await shot('00-fail');
    // extension host log often says why activation failed
    const logsDir = path.join(udd, 'logs');
    const walk = (d) => { for (const x of fs.readdirSync(d, { withFileTypes: true })) { const p2 = path.join(d, x.name); if (x.isDirectory()) walk(p2); else if (/exthost.*\.log$/i.test(x.name)) log('exthost log ' + p2 + ':\n' + fs.readFileSync(p2, 'utf8').slice(-3000)); } };
    try { walk(logsDir); } catch { /* none */ }
    throw e;
  }
  await until(async () => (await editorFrame.evaluate(() => document.body.innerText)).includes('Functions on'), 60000, 'the rendered document text');
  log('custom editor opened and rendered the document');

  /* ---- 2. WYSIWYG rendering checks ---- */
  const checks = await editorFrame.evaluate(() => {
    const text = document.body.innerText;
    const icons = [...document.querySelectorAll('img.tb-img')];
    return {
      hasIntro: /Introduction/.test(text),
      hasMethods: /Methods/.test(text),
      katex: document.querySelectorAll('.katex').length,
      displayMath: document.querySelectorAll('.lyx-math-display').length,
      inlineMath: document.querySelectorAll('.lyx-math-inline').length,
      icons: icons.length,
      iconsLoaded: icons.filter(i => i.complete && i.naturalWidth > 0).length,
      statusbar: !!document.querySelector('.statusbar'),
      rawLatexVisible: text.indexOf('\\section{Introduction}') >= 0,
    };
  });
  log('render checks:', JSON.stringify(checks));
  if (!checks.hasIntro || !checks.hasMethods) fail('headings not rendered');
  if (checks.katex < 2) fail('KaTeX formulas not rendered (found ' + checks.katex + ')');
  if (checks.displayMath < 1 || checks.inlineMath < 1) fail('math nodes missing');
  if (!checks.statusbar) fail('status bar missing');
  if (checks.icons < 20) fail('toolbar icons missing (found ' + checks.icons + ')');
  if (checks.iconsLoaded < checks.icons) fail('only ' + checks.iconsLoaded + '/' + checks.icons + ' toolbar icons loaded');
  if (checks.rawLatexVisible) fail('raw LaTeX visible — document not WYSIWYG-rendered');
  const rawMacro = await editorFrame.evaluate(() => document.body.innerText.indexOf('\\RR') >= 0);
  if (rawMacro) fail('the \\RR macro is shown as raw LaTeX — document macros not applied to formulas');
  await shot('01-editor');

  /* ---- 3. type into the document, save with Ctrl+S, verify the .tex on disk ---- */
  await editorFrame.click('text=are studied');
  await page.keyboard.press('End');
  await page.keyboard.type(' Typed via the GUI test.');
  await until(async () => (await editorFrame.evaluate(() => document.body.innerText)).includes('Typed via the GUI test.'), 15000, 'typed text in the editor');
  await page.keyboard.press('Control+s');
  await until(() => fs.readFileSync(path.join(ws, 'main.tex'), 'utf8').includes('Typed via the GUI test.'), 20000, 'the typed text in the saved .tex file');
  const saved = fs.readFileSync(path.join(ws, 'main.tex'), 'utf8');
  if (saved.indexOf('\\section{Introduction}') < 0) fail('saved file lost its structure');
  log('typing reached the .tex file on disk through Ctrl+S');
  await shot('02-typed-and-saved');

  /* ---- 4. click into a formula: the static KaTeX upgrades to an editable math field ---- */
  await editorFrame.click('.lyx-math-display .katex');
  await until(() => editorFrame.evaluate(() => {
    const a = document.activeElement;
    return !!(a && (a.closest('.lyx-math-display') || (a.tagName || '').toLowerCase().indexOf('math') >= 0));
  }), 15000, 'the math field to take focus');
  log('display formula upgraded to an editable field');
  await page.keyboard.press('Escape');
  await shot('03-math-field');

  /* ---- 5. Structure view in the activity bar ---- */
  await page.click('.activitybar [aria-label*="OverLyX"]');
  await until(async () => {
    const rows = await page.$$eval('.pane-body .monaco-list-row', els => els.map(e => e.textContent || ''));
    return rows.some(r => /Introduction/.test(r)) && rows.some(r => /Methods/.test(r));
  }, 30000, 'outline rows in the Structure view');
  log('Structure view shows the outline');
  await shot('04-structure');
  const rows = await page.$$('.pane-body .monaco-list-row');
  for (const r of rows) { if (/Methods/.test((await r.textContent()) || '')) { await r.click(); break; } }
  await sleep(800);

  /* ---- 6. build the PDF from the command palette; pdf.js paints pages ---- */
  await page.keyboard.press('Control+Shift+p');
  await page.waitForSelector('.quick-input-widget input', { timeout: 15000 });
  await page.keyboard.type('OverLyX: Build');
  await sleep(500);
  await page.keyboard.press('Enter');
  const pdfFrame = await until(async () => {
    for (const f of page.frames()) { try { if (await f.$('.pdf-panel')) return f; } catch { /* gone */ } }
    return null;
  }, 60000, 'the PDF panel webview');
  try {
    await until(() => pdfFrame.evaluate(() => {
      const c = [...document.querySelectorAll('canvas')];
      return c.some(x => x.width > 100 && x.height > 100);
    }), 180000, 'pdf.js to paint a page');
  } catch (e) {
    log('pdf panel text:', JSON.stringify(await pdfFrame.evaluate(() => document.body.innerText).catch(() => '?')));
    await shot('05-fail');
    throw e;
  }
  log('PDF built and painted by pdf.js');
  await sleep(1000);
  await shot('05-pdf');

  const finalTex = fs.readFileSync(path.join(ws, 'main.tex'), 'utf8');
  if (finalTex.indexOf('\\section{Methods}') < 0) fail('document structure corrupted during the GUI run');
  if (/Ove[A-Z]/.test(finalTex)) fail('stray palette keystrokes leaked into the document');
  const pdfText = await pdfFrame.evaluate(() => document.body.innerText);
  if (pdfText.indexOf('✗') >= 0) fail('PDF panel reports build errors');

  log('ALL GUI CHECKS PASSED');
  await browser.close().catch(() => {});
} catch (e) {
  failed = true;
  throw e;
} finally {
  kill();
  fs.rmSync(ws, { recursive: true, force: true });
  if (!failed) { fs.rmSync(udd, { recursive: true, force: true }); fs.rmSync(extDir, { recursive: true, force: true }); }
  else log('kept user-data-dir for inspection:', udd);
}
