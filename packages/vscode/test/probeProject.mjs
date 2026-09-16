/**
 * Open a real project in the extension (VS Code under xvfb, driven over CDP like guiTest.mjs) and
 * report what the OverLyX editor made of it: notifications, broken node views, KaTeX errors, raw
 * LaTeX left in the rendered text, webview console errors, and screenshots. For reproducing a
 * "this document does not work in the extension" report without guessing.
 *
 *   xvfb-run -a -s "-screen 0 1600x1000x24" node test/probeProject.mjs <workspace dir> <file.tex> [out dir]
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
if (!ws || !file) { console.error('usage: probeProject.mjs <workspace dir> <file.tex> [out dir]'); process.exit(2); }
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
}, null, 2));
const exe = await downloadAndUnzipVSCode({ cachePath: path.join(pkg, '.vscode-test') });
const PORT = 9341;
const child = spawn(exe, [
  '--no-sandbox', '--disable-gpu', '--disable-dev-shm-usage', '--disable-workspace-trust', '--disable-updates', '--disable-crash-reporter',
  '--skip-welcome', '--skip-release-notes', '--disable-extensions', '--extensionDevelopmentPath=' + pkg,
  '--user-data-dir=' + udd, '--extensions-dir=' + extDir, '--remote-debugging-port=' + PORT, ws, path.resolve(ws, file),
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
  const consoleLines = [];
  page.on('console', m => { if (m.type() === 'error' || m.type() === 'warning') consoleLines.push(`${m.type()}: ${m.text().slice(0, 300)}`); });
  page.on('pageerror', e => consoleLines.push('pageerror: ' + String(e).slice(0, 300)));
  const shot = async (name) => { await page.screenshot({ path: path.join(out, name + '.png') }); log('screenshot', path.join(out, name + '.png')); };

  await sleep(4000);
  await shot('00-open');
  const editorFrame = await until(async () => {
    for (const f of page.frames()) { try { if (await f.$('.lyx-editor')) return f; } catch { /* frame gone */ } }
    return null;
  }, 60000, 'the OverLyX editor webview');
  await sleep(6000);   // metadata, macros, formulas
  await shot('01-editor');
  const report = await editorFrame.evaluate(() => {
    const text = document.querySelector('.lyx-editor')?.innerText ?? '';
    const raw = [...text.matchAll(/\\[A-Za-z]+(\{[^}]*\})?/g)].map(m => m[0]);
    const counts = {};
    for (const r of raw) counts[r] = (counts[r] ?? 0) + 1;
    return {
      chars: text.length,
      paragraphs: document.querySelectorAll('.lyx-editor > *').length,
      katex: document.querySelectorAll('.katex').length,
      katexErrors: [...document.querySelectorAll('.katex-error')].map(n => n.textContent?.slice(0, 80)),
      broken: [...document.querySelectorAll('.lyx-broken')].map(n => n.title.slice(0, 160)),
      rawLatexInText: Object.entries(counts).sort((a, b) => b[1] - a[1]).slice(0, 25),
      images: [...document.querySelectorAll('.lyx-graphics img')].map(i => ({ src: i.getAttribute('src')?.slice(-60), ok: i.complete && i.naturalWidth > 0 })),
      // image glyphs inside formulas (\includegraphics in a macro → KaTeX <img>): are they there, loaded, and how are they placed?
      mathImages: [...document.querySelectorAll('.katex img')].slice(0, 6).map(i => { const cs = getComputedStyle(i); const p = i.parentElement; const pcs = p ? getComputedStyle(p) : null; return { src: i.getAttribute('src')?.slice(0, 120), ok: i.complete && i.naturalWidth > 0, height: cs.height, verticalAlign: cs.verticalAlign, parentClass: p?.className, parentStyle: p?.getAttribute('style'), parentVAlign: pcs?.verticalAlign, parentPosition: pcs?.position, parentTop: pcs?.top }; }),
      mathImageCount: document.querySelectorAll('.katex img').length,
      firstGlyphChain: (() => { const img = document.querySelector('.katex img'); const out = []; for (let e = img, n = 0; e && n < 5; e = e.parentElement, n++) out.push({ tag: e.tagName.toLowerCase(), cls: e.className, style: e.getAttribute('style'), va: getComputedStyle(e).verticalAlign, pos: getComputedStyle(e).position, top: getComputedStyle(e).top, h: getComputedStyle(e).height }); return out; })(),
      macros: Object.keys(window.overlyx?.meta?.macros ?? {}).length,
      health: window.overlyx?.meta?.health ?? null,
      layouts: window.overlyx?.meta?.layouts?.length ?? null,
      textclass: window.overlyx?.meta?.textclass ?? null,
      messages: [...document.querySelectorAll('.statusbar .message, .message')].map(n => n.textContent?.slice(0, 200)),
      head: text.slice(0, 1200),
    };
  });
  const notes = await page.$$eval('.notification-list-item-message', els => els.map(e => e.textContent)).catch(() => []);
  const result = { notifications: notes, console: consoleLines.slice(0, 40), ...report };
  fs.writeFileSync(path.join(out, 'report.json'), JSON.stringify(result, null, 2));
  // a close-up of the first formula that carries an image glyph
  const glyphBox = await editorFrame.evaluate(() => { const img = document.querySelector('.katex img'); const host = img?.closest('.lyx-math-inline, .lyx-math-display, .katex'); if (!host) return null; host.scrollIntoView({ block: 'center' }); const r = host.getBoundingClientRect(); return { x: r.x, y: r.y, w: r.width, h: r.height }; });
  if (glyphBox) {
    await sleep(500);
    const fr = await editorFrame.frameElement().then(e => e.boundingBox()).catch(() => null);
    const box = await editorFrame.evaluate(() => { const img = document.querySelector('.katex img'); const host = img?.closest('.lyx-math-inline, .lyx-math-display, .katex'); const r = host.getBoundingClientRect(); return { x: r.x, y: r.y, w: r.width, h: r.height }; });
    const clip = { x: Math.max(0, (fr?.x ?? 0) + box.x - 40), y: Math.max(0, (fr?.y ?? 0) + box.y - 30), width: box.w + 80, height: box.h + 60 };
    await page.screenshot({ path: path.join(out, '02-glyph.png'), clip });
    log('screenshot', path.join(out, '02-glyph.png'), JSON.stringify(box));
  }

  // formulas whose source puts a script on one of the paper's macros: how were they rendered?
  const SCRIPTED = /\\(quh|qvphi|qhphi|quv|bh|bphi)\s*[\^_]/;
  const scripted = await editorFrame.evaluate((re) => {
    const view = window.overlyx?.activeView;
    if (!view) return { error: 'no active view' };
    const rx = new RegExp(re);
    const out = [];
    view.state.doc.descendants((node, pos) => {
      if (out.length >= 4) return false;
      if ((node.type.name === 'math_inline' || node.type.name === 'math_display') && rx.test(node.attrs.latex)) {
        const dom = view.nodeDOM(pos);
        const html = dom?.innerHTML ?? '';
        const i = html.indexOf('lm-macro');
        out.push({ pos, latex: node.attrs.latex.slice(0, 160), hasMacroClass: i >= 0, hasUnknown: html.includes('lm-unknown'), html: i >= 0 ? html.slice(Math.max(0, i - 400), i + 700) : html.slice(0, 500) });
      }
      return true;
    });
    const m = window.overlyx?.meta;
    const table = {};
    for (const n of ['quh', 'qvphi', 'bu', 'bh', 'bphi']) table[n] = m?.macros?.[n] ?? null;
    const list = (m?.macroList ?? []).filter(x => ['quh', 'qvphi', 'bu', 'bh', 'bphi'].includes(x.name));
    return { formulas: out, macros: table, macroList: list, macroCount: Object.keys(m?.macros ?? {}).length };
  }, SCRIPTED.source);
  fs.writeFileSync(path.join(out, 'scripted.json'), JSON.stringify(scripted, null, 2));
  console.log('---- scripted macros ----\n' + JSON.stringify({ ...scripted, formulas: scripted.formulas?.map(f => ({ pos: f.pos, latex: f.latex, hasMacroClass: f.hasMacroClass, hasUnknown: f.hasUnknown })) }, null, 1));
  if (scripted.formulas?.[0]) {
    const box = await editorFrame.evaluate((pos) => { const view = window.overlyx.activeView; const dom = view.nodeDOM(pos); dom.scrollIntoView({ block: 'center' }); const r = dom.getBoundingClientRect(); return { x: r.x, y: r.y, w: r.width, h: r.height }; }, scripted.formulas[0].pos);
    await new Promise(r => setTimeout(r, 500));
    const box2 = await editorFrame.evaluate((pos) => { const view = window.overlyx.activeView; const r = view.nodeDOM(pos).getBoundingClientRect(); return { x: r.x, y: r.y, w: r.width, h: r.height }; }, scripted.formulas[0].pos);
    const fr = (await editorFrame.frameElement().then(e => e.boundingBox()).catch(() => null)) ?? { x: 0, y: 0 };
    await page.screenshot({ path: path.join(out, 'scripted-formula.png'), clip: { x: Math.max(0, fr.x + box2.x - 30), y: Math.max(0, fr.y + box2.y - 30), width: box2.w + 60, height: box2.h + 60 } });
    console.log('scripted formula screenshot', path.join(out, 'scripted-formula.png'), JSON.stringify(box));
  }
  // click into the first scripted formula: the static KaTeX becomes an editable field (atom markers) — same rendering?
  if (scripted.formulas?.[0]) {
    const target = scripted.formulas.find(f => f.latex.length < 40) ?? scripted.formulas[0];
    const clicked = await editorFrame.evaluate(async (pos) => {
      const view = window.overlyx.activeView;
      const dom = view.nodeDOM(pos);
      dom.scrollIntoView({ block: 'center' });
      const k = dom.querySelector('.katex') ?? dom;
      const r = k.getBoundingClientRect();
      const ev = (type) => new MouseEvent(type, { bubbles: true, cancelable: true, clientX: r.x + 4, clientY: r.y + r.height / 2, button: 0 });
      k.dispatchEvent(ev('mousedown')); k.dispatchEvent(ev('mouseup')); k.dispatchEvent(ev('click'));
      await new Promise(r2 => setTimeout(r2, 1500));
      const html = view.nodeDOM(pos)?.innerHTML ?? '';
      return { latex: '', field: html.includes('lm-a'), html: html.slice(html.indexOf('lm-c0') - 20, html.indexOf('lm-c0') + 900) };
    }, target.pos);
    fs.writeFileSync(path.join(out, 'scripted-field.json'), JSON.stringify(clicked, null, 2));
    console.log('---- after clicking into the formula (field mode: ' + clicked.field + ') ----');
  }
  log('report written to', path.join(out, 'report.json'));
  console.log(JSON.stringify({ ...result, head: undefined }, null, 1));
  console.log('---- rendered text (start) ----\n' + report.head);
  // the extension host log: activation errors and host-side exceptions
  const walk = (d) => { for (const x of fs.readdirSync(d, { withFileTypes: true })) { const p2 = path.join(d, x.name); if (x.isDirectory()) walk(p2); else if (/exthost.*\.log$/i.test(x.name)) { const t = fs.readFileSync(p2, 'utf8'); const errs = t.split('\n').filter(l => /error|exception|fail/i.test(l)).slice(-15); if (errs.length) log('exthost log ' + p2 + ':\n' + errs.join('\n')); } } };
  try { walk(path.join(udd, 'logs')); } catch { /* none */ }
  browser.close().catch(() => {});
} finally {
  kill();
}
