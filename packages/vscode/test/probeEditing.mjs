/**
 * Editing in the real extension (VS Code under xvfb, driven over CDP like probeProject.mjs), for two
 * reports that only show up with a real TextDocument and a real mouse:
 *  1. drag selection: a drag across a paragraph that holds an inline formula, at zoom 1 and at zoom
 *     1.3, sampling the selection head after every pointer step (it must grow monotonically);
 *  2. deleted text coming back: with auto save on, characters are deleted in bursts separated by
 *     pauses of about a second — auto save, the file watcher and the host's snapshot land in the
 *     middle of the next burst — and the document must never grow back (report.json `edits.regrew`).
 * The workspace is edited: pass a copy.
 *
 *   xvfb-run -a -s "-screen 0 1600x1000x24" node test/probeEditing.mjs <workspace dir> <file.tex> <out dir>
 *   SKIP_DRAG=1 PAUSES=1000,1050,1100,1150 BURST=3 ITER=24 …   # only the deletion loop, tuned
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
if (!ws || !file) { console.error('usage: probeEditing.mjs <workspace dir> <file.tex> [out dir]'); process.exit(2); }
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
  'files.autoSave': 'afterDelay', 'files.autoSaveDelay': 1000,
}, null, 2));
const exe = await downloadAndUnzipVSCode({ cachePath: path.join(pkg, '.vscode-test') });
const PORT = 9342;
const child = spawn(exe, [
  '--no-sandbox', '--disable-gpu', '--disable-dev-shm-usage', '--disable-workspace-trust', '--disable-updates', '--disable-crash-reporter',
  '--skip-welcome', '--skip-release-notes', '--disable-extensions', '--extensionDevelopmentPath=' + pkg,
  '--user-data-dir=' + udd, '--extensions-dir=' + extDir, '--remote-debugging-port=' + PORT, ws, path.resolve(ws, file),
], { detached: true, env: { ...process.env, DONT_PROMPT_WSL_INSTALL: '1' } });
const kill = () => { try { process.kill(-child.pid, 'SIGKILL'); } catch { /* gone */ } };
process.on('exit', kill);

const result = { console: [], drags: {}, edits: null };
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
  await sleep(6000);
  const fr = await frame.frameElement().then(e => e.boundingBox());
  log('frame at', JSON.stringify(fr));

  // ---- 1. drags -------------------------------------------------------------------------------
  /** a paragraph holding an inline formula: start on its 3rd character, end after the formula */
  const measure = () => frame.evaluate(() => {
    const view = window.overlyx.activeView;
    const paras = [...document.querySelectorAll('.lyx-editor > *')].filter(p => p.querySelector('.lyx-math-inline') && p.innerText.length > 120);
    const p = paras[1] ?? paras[0];
    if (!p) return null;
    p.scrollIntoView({ block: 'center' });
    const walker = document.createTreeWalker(p, NodeFilter.SHOW_TEXT);
    const texts = [];
    let n; while ((n = walker.nextNode())) if (n.nodeValue.trim().length > 3 && !n.parentElement.closest('.lyx-math-inline, mjx-container')) texts.push(n);
    const math = p.querySelector('.lyx-math-inline');
    const after = texts.find(t => (math.compareDocumentPosition(t) & Node.DOCUMENT_POSITION_FOLLOWING) && t.nodeValue.trim().length > 8);
    const rectOf = (t, i) => { const r = document.createRange(); r.setStart(t, i); r.setEnd(t, i + 1); return r.getBoundingClientRect(); };
    const s = rectOf(texts[0], 2), e = rectOf(after, Math.min(after.nodeValue.length - 2, 6));
    const pr = p.getBoundingClientRect();
    const mr = math.getBoundingClientRect();
    const startPos = view.posAtCoords({ left: s.left + 1, top: s.top + s.height / 2 })?.pos;
    return { start: { x: s.left + 1, y: s.top + s.height / 2 }, end: { x: e.left + 1, y: e.top + e.height / 2 }, para: { x: pr.x, y: pr.y, w: pr.width, h: pr.height }, math: { x: mr.x, y: mr.y, w: mr.width, h: mr.height }, startPos, zoom: getComputedStyle(document.querySelector('.editor-scroll')).zoom, fontSize: getComputedStyle(document.querySelector('.lyx-editor')).fontSize };
  });
  const state = () => frame.evaluate(() => {
    const view = window.overlyx.activeView;
    const sel = view.state.selection;
    const ds = document.getSelection();
    const rects = ds.rangeCount ? [...ds.getRangeAt(0).getClientRects()].filter(r => r.width > 0).map(r => ({ x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height) })) : [];
    return { from: sel.from, to: sel.to, head: sel.head, text: view.state.doc.textBetween(sel.from, sel.to, ' ', '□').slice(0, 200), domRanges: ds.rangeCount, domRects: rects, selatoms: document.querySelectorAll('.ol-selatom').length, yjsSel: document.querySelectorAll('.ProseMirror-yjs-selection').length, focus: view.hasFocus(), active: document.activeElement?.className?.slice(0, 60) };
  });
  const drag = async (name) => {
    const m = await measure();
    if (!m) { result.drags[name] = { error: 'no paragraph with an inline formula' }; return; }
    await sleep(300);
    const m2 = await measure();
    const sx = fr.x + m2.start.x, sy = fr.y + m2.start.y, ex = fr.x + m2.end.x, ey = fr.y + m2.end.y;
    await page.mouse.move(sx, sy);
    await page.mouse.down();
    await sleep(60);
    const heads = [];
    const N = 14;
    for (let i = 1; i <= N; i++) {
      await page.mouse.move(sx + (ex - sx) * i / N, sy + (ey - sy) * i / N);
      await sleep(40);
      const s = await state();
      heads.push(s.head);
    }
    await sleep(100);
    const during = await state();
    await page.mouse.up();
    await sleep(300);
    const after = await state();
    const clip = { x: Math.max(0, fr.x + m2.para.x - 10), y: Math.max(0, fr.y + m2.para.y - 10), width: Math.min(m2.para.w + 20, 1580), height: Math.min(m2.para.h + 20, 980) };
    await page.screenshot({ path: path.join(out, name + '.png'), clip });
    const jumps = heads.filter((h, i) => i > 0 && h < heads[i - 1]).length;
    result.drags[name] = { measure: m2, heads, backwardSteps: jumps, during, after };
    log(name, JSON.stringify({ zoom: m2.zoom, fontSize: m2.fontSize, heads, backwardSteps: jumps, from: after.from, to: after.to, domRects: after.domRects.length, selatoms: after.selatoms, yjsSel: after.yjsSel, text: after.text.slice(0, 80) }));
    // click to clear the selection
    await page.mouse.click(sx, sy);
    await sleep(200);
  };
  if (!process.env.SKIP_DRAG) {
  await drag('drag-zoom1');
  await frame.evaluate(() => { window.overlyx.ui.zoom(3); });
  await sleep(800);
  await drag('drag-zoom1.3');
  await frame.evaluate(() => { window.overlyx.ui.zoom(0); });
  await sleep(800);
  }

  // ---- 2. deleted text coming back ---------------------------------------------------------
  const edits = { steps: [], regrew: 0 };
  const textLen = () => frame.evaluate(() => window.overlyx.activeView.state.doc.textContent.length);
  const m = await measure();
  await page.mouse.click(fr.x + m.end.x, fr.y + m.end.y);
  await sleep(300);
  await frame.evaluate(() => {
    const v = window.overlyx.activeView;
    let end = -1;
    v.state.doc.descendants((n, pos) => { if (end < 0 && n.isTextblock && n.textContent.length > 120) end = pos + 1 + n.content.size; return end < 0; });
    const $p = v.state.doc.resolve(end);
    v.dispatch(v.state.tr.setSelection(v.state.selection.constructor.near ? v.state.selection.constructor.near($p) : v.state.selection.constructor.between($p, $p)).scrollIntoView());
    v.focus();
  });
  await sleep(200);
  const focus0 = await state();
  log('focus before edits', JSON.stringify({ focus: focus0.focus, active: focus0.active, from: focus0.from }));
  let before = await textLen();
  const startText = await frame.evaluate(() => window.overlyx.activeView.state.doc.textContent);
  const PAUSES = (process.env.PAUSES ?? '1200,1430,1660,1890').split(',').map(Number);
  const BURST = Number(process.env.BURST ?? 4), ITER = Number(process.env.ITER ?? 10);
  for (let i = 0; i < ITER; i++) {
    const perKey = [];
    for (let k = 0; k < BURST; k++) { await page.keyboard.press('Backspace'); await sleep(35); perKey.push(await textLen()); }
    const right = await textLen();
    const st = await state();
    // pauses of 1.2–1.9 s: long enough for auto save (1 s) and the watcher; the next burst then
    // starts while the host may still be computing the snapshot it pushes for that save
    const pause = PAUSES[i % PAUSES.length];
    await sleep(pause);
    const later = await textLen();
    const step = { i, before, perKey, afterDelete: right, afterPause: later, pause, regrew: later > right, focus: st.focus, active: st.active, at: st.from };
    if (later > right) edits.regrew++;
    edits.steps.push(step);
    log('edit', JSON.stringify(step));
    before = later;
  }
  await sleep(2500);
  const endText = await frame.evaluate(() => window.overlyx.activeView.state.doc.textContent);
  const fileText = fs.readFileSync(path.resolve(ws, file), 'utf8');
  edits.finalLen = endText.length; edits.startLen = startText.length; edits.expectedLen = startText.length - BURST * ITER;
  // the removed characters, roughly: which of them are still on disk?
  edits.diskHasOriginal = fileText.length;
  result.edits = edits;
  await page.screenshot({ path: path.join(out, 'edits.png') });
  fs.writeFileSync(path.join(out, 'report.json'), JSON.stringify(result, null, 2));
  log('done', JSON.stringify({ regrew: edits.regrew, startLen: edits.startLen, finalLen: edits.finalLen, expected: edits.expectedLen }));
} catch (e) {
  console.error(e);
  fs.writeFileSync(path.join(out, 'report.json'), JSON.stringify({ ...result, error: String(e) }, null, 2));
  process.exitCode = 1;
} finally {
  kill();
}
