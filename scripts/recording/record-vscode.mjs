/**
 * Records the landing-page VS Code clip (packages/client/public/landing/vscode-<theme>.*): launches
 * the cached VS Code under xvfb with the OverLyX extension (packages/vscode, built), drives it over
 * CDP like test/guiTest.mjs, and captures the workbench as a JPEG frame stream (CDP has no video),
 * assembled by ffmpeg with the true frame timings. Run from the repo root, once per theme:
 *
 *   xvfb-run -a node scripts/recording/record-vscode.mjs light
 *   xvfb-run -a node scripts/recording/record-vscode.mjs dark
 */
import { downloadAndUnzipVSCode } from '@vscode/test-electron';
import { chromium } from '@playwright/test';
import { spawn, spawnSync, execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const theme = process.argv[2];
if (theme !== 'light' && theme !== 'dark') { console.error('usage: record-vscode.mjs light|dark'); process.exit(2); }

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const pkg = path.join(root, 'packages/vscode');
const DEST = path.join(root, 'packages/client/public/landing');
const fdir = fs.mkdtempSync(path.join(os.tmpdir(), 'overlyx-vscode-frames-'));

const log = (...a) => console.log('[record-vscode]', ...a);
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
async function until(fn, ms, what) {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) {
    try { const v = await fn(); if (v) return v; } catch { /* retry */ }
    await sleep(250);
  }
  throw new Error('timeout waiting for ' + what);
}

/* ---------------- fixture workspace (prewarmed so the on-camera build is quick) ---------------- */
const MAIN = [
  '\\documentclass{article}',
  '\\usepackage{amsmath,amssymb}',
  '\\begin{document}',
  '',
  '\\section{Kernel ridge regression}',
  '',
  'Given samples drawn from an unknown distribution, the estimator solves a regularized least-squares problem over a reproducing kernel Hilbert space.',
  '',
  '\\begin{equation}',
  '\\hat{f}(x)=\\sum_{i=1}^{n}\\alpha_{i}k(x_{i},x)\\label{eq:krr}',
  '\\end{equation}',
  '',
  '\\section{Spectral view}',
  '',
  'The eigenvalues of the kernel operator set the rate at which each mode of the target is learned.',
  '',
  '\\end{document}',
  '',
].join('\n');
// the folder name shows in the window title and the Explorer header — keep it presentable
const ws = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'overlyx-vscode-demo-')), 'kernel-paper');
fs.mkdirSync(ws);
fs.writeFileSync(path.join(ws, 'main.tex'), MAIN);
log('prewarming latexmk…');
spawnSync('latexmk', ['-pdf', '-interaction=nonstopmode', 'main.tex'], { cwd: ws, stdio: 'ignore' });

/* ---------------- VS Code launch (as in test/guiTest.mjs) ---------------- */
const udd = fs.mkdtempSync(path.join(os.tmpdir(), 'overlyx-vscode-demo-udd-'));
const extDir = fs.mkdtempSync(path.join(os.tmpdir(), 'overlyx-vscode-demo-ext-'));
fs.mkdirSync(path.join(udd, 'User'), { recursive: true });
fs.writeFileSync(path.join(udd, 'User/settings.json'), JSON.stringify({
  'workbench.editorAssociations': { '*.tex': 'overlyx.texEditor' },
  'workbench.colorTheme': theme === 'dark' ? 'Default Dark Modern' : 'Default Light Modern',
  'security.workspace.trust.enabled': false,
  'update.mode': 'none',
  'telemetry.telemetryLevel': 'off',
  'workbench.startupEditor': 'none',
  'window.restoreWindows': 'none',
  'chat.commandCenter.enabled': false,
  // a native title bar renders nothing under xvfb (no WM): the forced "[Extension Development
  // Host]" prefix stays out of the clip while the menu bar keeps its own row
  'window.titleBarStyle': 'native',
}, null, 2));

const exe = await downloadAndUnzipVSCode({ cachePath: path.join(pkg, '.vscode-test') });
const PORT = 9341;
const child = spawn(exe, [
  '--no-sandbox', '--disable-gpu', '--disable-dev-shm-usage', '--disable-workspace-trust',
  '--disable-updates', '--disable-crash-reporter', '--skip-welcome', '--skip-release-notes',
  '--extensionDevelopmentPath=' + pkg,   // extDir is empty, so no "extensions disabled" notification
  '--user-data-dir=' + udd, '--extensions-dir=' + extDir,
  '--remote-debugging-port=' + PORT, ws, path.join(ws, 'main.tex'),
], { detached: true, env: { ...process.env, DONT_PROMPT_WSL_INSTALL: '1' } });
const kill = () => { try { process.kill(-child.pid, 'SIGKILL'); } catch { /* gone */ } };
process.on('exit', kill);

try {
  await until(async () => (await fetch('http://127.0.0.1:' + PORT + '/json/version')).ok, 60000, 'the CDP endpoint');
  const browser = await chromium.connectOverCDP('http://127.0.0.1:' + PORT);
  const ctx = browser.contexts()[0];
  const page = await until(async () => {
    for (const p of ctx.pages()) { try { if (await p.$('.monaco-workbench')) return p; } catch { /* not ready */ } }
    return null;
  }, 60000, 'the workbench page');
  page.setDefaultTimeout(30000);
  try { await page.setViewportSize({ width: 1424, height: 840 }); } catch (e) { log('viewport override failed, keeping the window size:', String(e).split('\n')[0]); }

  // off-camera tidying: notification toasts (running as root, …) never show, and the chat side
  // bar is toggled away (Ctrl+Alt+B) so the editor and the PDF get the width
  await page.addStyleTag({ content: '.notifications-toasts { display: none !important; }' });
  for (let i = 0; i < 3; i++) {
    const aux = await page.$('.part.auxiliarybar');
    if (!aux || !(await aux.evaluate(el => el.offsetWidth > 0))) break;
    await page.keyboard.press('Control+Alt+b');
    await sleep(600);
  }

  const findEditorFrame = async () => {
    for (const f of page.frames()) { try { if (await f.$('.lyx-editor')) return f; } catch { /* frame gone */ } }
    return null;
  };
  const editorFrame = await until(findEditorFrame, 60000, 'the OverLyX editor webview');
  await until(async () => (await editorFrame.evaluate(() => document.body.innerText)).includes('least-squares'), 60000, 'the rendered document');
  await sleep(1200);   // icons, KaTeX settle
  const text = await editorFrame.evaluate(() => document.body.innerText);
  if (text.includes('Notifications') || !text.includes('least-squares')) throw new Error('stray keystrokes reached the document — aborting the recording');

  /* ---------------- frame capture ---------------- */
  const frames = [];
  let capturing = true;
  const capture = (async () => {
    let i = 0;
    while (capturing) {
      const t = Date.now();
      try {
        const buf = await page.screenshot({ type: 'jpeg', quality: 85 });
        fs.writeFileSync(path.join(fdir, `f${String(i).padStart(4, '0')}.jpg`), buf);
        frames.push({ i, t });
        i++;
      } catch { /* window busy */ }
      const dt = Date.now() - t;
      await sleep(Math.max(0, 130 - dt));
    }
  })();

  /* ---------------- the scripted beats ---------------- */
  await sleep(1400);
  // a sentence typed at the end of §1's paragraph, saved to disk with Ctrl+S
  const par = editorFrame.locator('.lyx-editor > .lyx-par.lyx-layout-standard').first();
  const box = await par.boundingBox();
  await page.mouse.click(box.x + box.width - 8, box.y + box.height - 8);
  await sleep(400);
  await page.keyboard.press('End');
  await sleep(250);
  await page.keyboard.type(' The coefficients follow from a linear system.', { delay: 30 });
  await sleep(400);
  await page.keyboard.press('Control+s');
  await until(() => fs.readFileSync(path.join(ws, 'main.tex'), 'utf8').includes('linear system'), 15000, 'the save');
  await sleep(900);
  // the display formula upgrades to an editable math field; a bias term typed at its end
  // (clicking just right of the last glyph lands the caret at the formula's top level, not
  // inside the k(...) argument)
  const eq = await editorFrame.locator('.lyx-math-display .katex').first().boundingBox();
  await page.mouse.click(eq.x + eq.width + 22, eq.y + eq.height / 2);
  await until(() => editorFrame.evaluate(() => {
    const a = document.activeElement;
    return !!(a && (a.closest('.lyx-math-display') || (a.tagName || '').toLowerCase().includes('math')));
  }), 15000, 'the math field focus');
  await sleep(600);
  await page.keyboard.type('+b', { delay: 120 });
  await sleep(700);
  await page.keyboard.press('Escape');
  await sleep(400);
  await page.keyboard.press('Control+s');   // so the PDF built next matches the document
  await sleep(600);
  // build the PDF via the editor-title button; pdf.js paints beside the document
  await page.click('.editor-actions [aria-label*="Build"]');
  const pdfFrame = await until(async () => {
    for (const f of page.frames()) { try { if (await f.$('.pdf-panel')) return f; } catch { /* gone */ } }
    return null;
  }, 60000, 'the PDF panel webview');
  await until(() => pdfFrame.evaluate(() => [...document.querySelectorAll('canvas')].some(c => c.width > 100 && c.height > 100)), 120000, 'pdf.js to paint');
  await sleep(2400);
  capturing = false;
  await capture;
  await browser.close().catch(() => {});
  log('captured', frames.length, 'frames');

  /* ---------------- assemble with the true frame timings ---------------- */
  const lines = ['ffconcat version 1.0'];
  for (let j = 0; j < frames.length; j++) {
    const dur = j + 1 < frames.length ? (frames[j + 1].t - frames[j].t) / 1000 : 1.2;
    lines.push(`file 'f${String(frames[j].i).padStart(4, '0')}.jpg'`, `duration ${dur.toFixed(3)}`);
  }
  const list = path.join(fdir, 'list.txt');
  fs.writeFileSync(list, lines.join('\n') + '\n');
  fs.mkdirSync(DEST, { recursive: true });
  const base = path.join(DEST, `vscode-${theme}`);
  const vf = 'crop=iw:ih-36:0:36,fps=24,scale=1280:-2';   // the VS Code title bar (dev-host / superuser labels) stays out of the clip
  const run = (args) => execFileSync('ffmpeg', ['-y', '-loglevel', 'error', ...args], { stdio: 'inherit' });
  run(['-f', 'concat', '-safe', '0', '-i', list, '-vf', vf, '-c:v', 'libvpx-vp9', '-crf', '42', '-b:v', '0', '-cpu-used', '4', '-row-mt', '1', '-an', base + '.webm']);
  run(['-f', 'concat', '-safe', '0', '-i', list, '-vf', vf, '-c:v', 'libx264', '-crf', '27', '-preset', 'medium', '-pix_fmt', 'yuv420p', '-movflags', '+faststart', '-an', base + '.mp4']);
  run(['-i', base + '.mp4', '-frames:v', '1', '-q:v', '4', base + '.jpg']);
  log('wrote', base + '.{webm,mp4,jpg}');
} finally {
  kill();
  fs.rmSync(ws, { recursive: true, force: true });
  fs.rmSync(udd, { recursive: true, force: true });
  fs.rmSync(extDir, { recursive: true, force: true });
  fs.rmSync(fdir, { recursive: true, force: true });
}
