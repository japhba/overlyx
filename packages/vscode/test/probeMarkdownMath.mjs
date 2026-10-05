/**
 * Typing formulas into a markdown document in the real extension (VS Code under xvfb, driven over
 * CDP like probeEditing.mjs). Report of 5 Oct 2026: while math is typed into a .md file, OverLyX
 * reports a conflicting (concurrent) formula edit, and `<em>` tags appear in the file. The probe
 * types a sentence with inline formulas key by key, with auto save on, and records after every step
 * what the editor holds (formulas, comments, emphasis) and what the file holds. The workspace is
 * edited: pass a copy.
 *
 *   xvfb-run -a -s "-screen 0 1600x1000x24" node test/probeMarkdownMath.mjs <workspace dir> <file.md> <out dir>
 *   SCRIPT=italic,one KEY=140 AUTOSAVE=afterDelay …   # scenarios, ms per key, files.autoSave
 *
 * The file needs a paragraph containing "intro" (the typing starts at its end). report.json lists, per
 * step, the formulas, comments and emphasised text in the editor and the file's text; a healthy run
 * has no "messages" (no concurrent-edit notice), no `<em>` in the file and no "preserved an unsaved
 * draft" lines in the console.
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
if (!ws || !file) { console.error('usage: probeMarkdownMath.mjs <workspace dir> <file.md> [out dir]'); process.exit(2); }
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
  'workbench.editorAssociations': { '*.md': 'overlyx.texEditor', '*.tex': 'overlyx.texEditor' },
  'security.workspace.trust.enabled': false, 'update.mode': 'none', 'telemetry.telemetryLevel': 'off',
  'workbench.startupEditor': 'none', 'window.restoreWindows': 'none', 'workbench.colorTheme': 'Default Light Modern',
  'files.autoSave': process.env.AUTOSAVE ?? 'afterDelay', 'files.autoSaveDelay': 1000,
}, null, 2));
const exe = await downloadAndUnzipVSCode({ cachePath: path.join(pkg, '.vscode-test') });
const PORT = 9343;
const child = spawn(exe, [
  '--no-sandbox', '--disable-gpu', '--disable-dev-shm-usage', '--disable-workspace-trust', '--disable-updates', '--disable-crash-reporter',
  '--skip-welcome', '--skip-release-notes', '--disable-extensions', '--extensionDevelopmentPath=' + pkg,
  '--user-data-dir=' + udd, '--extensions-dir=' + extDir, '--remote-debugging-port=' + PORT, ws, path.resolve(ws, file),
], { detached: true, env: { ...process.env, DONT_PROMPT_WSL_INSTALL: '1' } });
const kill = () => { try { process.kill(-child.pid, 'SIGKILL'); } catch { /* gone */ } };
process.on('exit', kill);

const result = { console: [], steps: [], messages: [] };
try {
  await until(async () => (await fetch('http://127.0.0.1:' + PORT + '/json/version')).ok, 60000, 'the CDP endpoint');
  const browser = await chromium.connectOverCDP('http://127.0.0.1:' + PORT);
  const ctx = browser.contexts()[0];
  const page = await until(async () => {
    for (const p of ctx.pages()) { try { if (await p.$('.monaco-workbench')) return p; } catch { /* not ready */ } }
    return null;
  }, 60000, 'the workbench page');
  page.setDefaultTimeout(30000);
  page.on('console', m => { if (m.type() === 'error' || m.type() === 'warning' || /OverLyX/.test(m.text())) result.console.push(`${m.type()}: ${m.text().slice(0, 300)}`); });
  await sleep(4000);
  const frame = await until(async () => {
    for (const f of page.frames()) { try { if (await f.$('.lyx-editor')) return f; } catch { /* frame gone */ } }
    return null;
  }, 90000, 'the OverLyX editor webview');
  await sleep(5000);

  // status bar messages and notifications, sampled
  const seen = new Set();
  const sampleMessages = async () => {
    const texts = await page.evaluate(() => [
      ...[...document.querySelectorAll('.statusbar-item')].map(e => e.textContent ?? ''),
      ...[...document.querySelectorAll('.notification-toast, .notifications-list-container .notification-list-item')].map(e => e.textContent ?? ''),
    ].filter(t => /OverLyX|onflict|oncurrent|newer/i.test(t)));
    for (const t of texts) if (!seen.has(t)) { seen.add(t); result.messages.push({ at: Date.now(), text: t.slice(0, 300) }); log('message:', t.slice(0, 200)); }
  };
  const ticker = setInterval(() => { void sampleMessages().catch(() => {}); }, 150);

  const editorState = () => frame.evaluate(() => {
    const v = window.overlyx.activeView;
    const formulas = [], notes = [], em = [];
    v.state.doc.descendants(n => {
      if (n.type.name === 'math_inline' || n.type.name === 'math_display') formulas.push(n.attrs.latex);
      if (n.type.name === 'inset' && n.attrs.name === 'Note') notes.push(n.textContent.slice(0, 120));
      if (n.isText && n.marks.some(m => m.type.name === 'emph')) em.push(n.text);
      return true;
    });
    return { formulas, notes, em, text: v.state.doc.textContent.slice(0, 400), focus: document.activeElement?.className?.slice(0, 60) };
  });
  const fileText = () => fs.readFileSync(path.resolve(ws, file), 'utf8');
  const record = async (what) => {
    const s = await editorState();
    const f = fileText();
    const step = { what, ...s, file: f.slice(0, 600), fileEm: /<em>/.test(f), fileComment: /@comment/.test(f) };
    result.steps.push(step);
    log(what, JSON.stringify({ formulas: s.formulas, notes: s.notes, em: s.em, fileEm: step.fileEm, fileComment: step.fileComment }));
  };

  // the cursor at the end of the first long paragraph
  await frame.evaluate(() => {
    const v = window.overlyx.activeView;
    let end = -1;
    v.state.doc.descendants((n, pos) => { if (end < 0 && n.isTextblock && /intro/.test(n.textContent)) end = pos + 1 + n.content.size; return end < 0; });
    const Sel = v.state.selection.constructor;
    v.dispatch(v.state.tr.setSelection(Sel.near(v.state.doc.resolve(end))).scrollIntoView());
    v.focus();
  });
  await sleep(300);
  await record('start');
  const KEY = Number(process.env.KEY ?? 140);
  const type = async (keys) => { for (const k of keys) { if (k.length > 1) await page.keyboard.press(k); else await page.keyboard.type(k); await sleep(KEY + Math.random() * 80); } };
  const chars = (s) => [...s];

  // a sentence with formulas, typed as a person would: $ opens a formula, → leaves it
  const script = (process.env.SCRIPT ?? 'italic,one,empty,space,sub,cmd').split(',');
  for (const name of script) {
    if (name === 'one') {
      await type(chars(' The value '));
      await type(['$']); await sleep(400);
      await type(chars('x+y=2'));
      await sleep(1600); await record('formula 1 typed, pause');
      await type(['ArrowRight']);
      await type(chars(' and the product '));
      await type(['$']); await sleep(400);
      await type(chars('a*b')); await sleep(1300); await record('formula 2 partly');
      await type(chars('+c'));
      await type(['ArrowRight']);
      await type(chars(' is known.'));
      await sleep(2500); await record('sentence done');
    }
    if (name === 'sub') {
      await type(chars(' Then '));
      await type(['$']); await sleep(400);
      await type(chars('x_1')); await type(['ArrowRight']); await type(chars('+y_2')); await type(['ArrowRight']);
      await sleep(1500); await record('subscripts');
      await type(['ArrowRight']);
      await type(chars(' holds.'));
      await sleep(2500); await record('sub done');
    }
    if (name === 'empty') {
      // an empty formula left for a moment (as when thinking), then filled
      await type(chars(' Then '));
      await type(['$']); await sleep(1500); await record('empty formula, pause');
      await type(chars('q')); await sleep(1500); await record('q typed');
      await type(['ArrowRight']); await type(chars(' ok.')); await sleep(1500); await record('empty done');
    }
    if (name === 'space') {
      // a space at the end of the paragraph, a pause, then the next word (after a formula was edited)
      await type(chars(' and')); await type([' ']); await sleep(1500); await record('trailing space, pause');
      await type(chars('more')); await sleep(1500); await record('word after the pause');
      await type([' ']); await sleep(1500);
      await type(['$']); await type(chars('z_')); await sleep(900); await record('subscript open, pause');
      await type(chars('k')); await type(['ArrowRight']); await type(chars('+w')); await type(['ArrowRight']); await sleep(1500); await record('space done');
    }
    if (name === 'italic') {
      // italic text, then a formula typed in it (it takes the font at the cursor), with pauses inside
      await type(chars(' Here ')); await type(['Control+i']); await type(chars('the value '));
      await type(['$']); await type(chars('x+y')); await sleep(900); await record('italic formula, pause');
      await type(chars('=2')); await sleep(900); await record('italic formula, more');
      await type(['ArrowRight']); await type(chars(' is')); await type(['Control+i']); await type(chars(' known.'));
      await sleep(2000); await record('italic done');
    }
    if (name === 'cmd') {
      await type(chars(' With '));
      await type(['$']); await sleep(400);
      await type(chars('\\alpha'));
      await sleep(1500); await record('command typed');
      await type([' ']);
      await type(chars('+1'));
      await type(['ArrowRight']);
      await type(chars(' too.'));
      await sleep(2500); await record('cmd done');
    }
  }
  await sleep(1500);
  await sampleMessages();
  clearInterval(ticker);
  await record('end');
  await page.screenshot({ path: path.join(out, 'md-math.png') });
  result.finalFile = fileText();
  fs.writeFileSync(path.join(out, 'report.json'), JSON.stringify(result, null, 2));
  log('final file:\n' + result.finalFile);
} catch (e) {
  console.error(e);
  fs.writeFileSync(path.join(out, 'report.json'), JSON.stringify({ ...result, error: String(e) }, null, 2));
  process.exitCode = 1;
} finally {
  kill();
}
