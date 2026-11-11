/**
 * How long opening a document takes in the extension (VS Code under xvfb, driven over CDP like
 * probeProject.mjs): the file is opened through Quick Open, then closed and opened again (RUNS
 * openings), and for each opening the probe samples the webview until its formulas are all typeset
 * (none `.pending` — queued for background typesetting, nodeviews/math.ts) and stay put, or nothing
 * changed for 10 s. It prints a timeline (editor mounted, metadata there, formulas typeset, how many
 * still untypeset on screen) and the webview's slowest requests. PROFILE=1 writes a CPU profile of
 * the webview per opening, TRACE=1 a Chrome trace of every process (chrome://tracing, Perfetto).
 *
 *   xvfb-run -a -s "-screen 0 1600x1000x24" node test/probeOpenTiming.mjs <workspace dir> <file.tex> [out dir]
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
if (!ws || !file) { console.error('usage: probeOpenTiming.mjs <workspace dir> <file.tex> [out dir]'); process.exit(2); }
const out = outArg ?? path.join(pkg, 'test/probe-shots');
fs.mkdirSync(out, { recursive: true });
const RUNS = Number(process.env.RUNS ?? 2);
const log = (...a) => console.log('[probe]', ...a);
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
async function until(fn, ms, what) {
  const t0 = Date.now();
  let last;
  while (Date.now() - t0 < ms) {
    try { const v = await fn(); if (v) return v; } catch (e) { last = e; }
    await sleep(100);
  }
  throw new Error('timeout waiting for ' + what + (last ? ' — last error: ' + last : ''));
}

const udd = fs.mkdtempSync(path.join(os.tmpdir(), 'overlyx-probe-udd-'));
const extDir = fs.mkdtempSync(path.join(os.tmpdir(), 'overlyx-probe-ext-'));
fs.mkdirSync(path.join(udd, 'User'), { recursive: true });
fs.writeFileSync(path.join(udd, 'User/settings.json'), JSON.stringify({
  'workbench.editorAssociations': { '*.tex': 'overlyx.texEditor', '*.md': 'overlyx.texEditor' },
  'security.workspace.trust.enabled': false, 'update.mode': 'none', 'telemetry.telemetryLevel': 'off',
  'workbench.startupEditor': 'none', 'window.restoreWindows': 'none', 'workbench.colorTheme': 'Default Light Modern',
}, null, 2));
const exe = await downloadAndUnzipVSCode({ cachePath: path.join(pkg, '.vscode-test') });
const PORT = 9343;
const child = spawn(exe, [
  '--no-sandbox', '--disable-gpu', '--disable-dev-shm-usage', '--disable-workspace-trust', '--disable-updates', '--disable-crash-reporter',
  '--skip-welcome', '--skip-release-notes', '--disable-extensions', '--extensionDevelopmentPath=' + pkg,
  '--user-data-dir=' + udd, '--extensions-dir=' + extDir, '--remote-debugging-port=' + PORT, ws,
], { detached: true, env: { ...process.env, DONT_PROMPT_WSL_INSTALL: '1' } });
const kill = () => { try { process.kill(-child.pid, 'SIGKILL'); } catch { /* gone */ } };
process.on('exit', kill);

/** the webview frame holding the editor, if one is there */
async function editorFrame(page) {
  for (const f of page.frames()) { try { if (await f.$('.lyx-editor')) return f; } catch { /* frame gone */ } }
  return null;
}

try {
  await until(async () => (await fetch('http://127.0.0.1:' + PORT + '/json/version')).ok, 60000, 'the CDP endpoint');
  const browser = await chromium.connectOverCDP('http://127.0.0.1:' + PORT);
  const ctx = browser.contexts()[0];
  const page = await until(async () => {
    for (const p of ctx.pages()) { try { if (await p.$('.monaco-workbench')) return p; } catch { /* not ready */ } }
    return null;
  }, 60000, 'the workbench page');
  page.setDefaultTimeout(30000);
  await sleep(6000);   // the extension activates (onStartupFinished)

  const results = [];
  for (let run = 0; run < RUNS; run++) {
    const timeline = [];
    let session = null;
    // TRACE=1: a Chrome trace of the whole opening (every process), summarised per renderer below
    const tracer = process.env.TRACE ? await browser.newBrowserCDPSession() : null;
    if (tracer) await tracer.send('Tracing.start', { categories: 'devtools.timeline,disabled-by-default-devtools.timeline,blink.user_timing', transferMode: 'ReturnAsStream' });
    await page.keyboard.press('Control+P');
    await page.waitForSelector('.quick-input-widget input');
    await page.keyboard.type(file);
    await sleep(800);
    const t0 = Date.now();
    await page.keyboard.press('Enter');
    const mark = (what, extra = {}) => { timeline.push({ t: Date.now() - t0, what, ...extra }); log(`run ${run}: ${((Date.now() - t0) / 1000).toFixed(2)} s  ${what}`, Object.keys(extra).length ? JSON.stringify(extra) : ''); };
    // the webview frame appears before the editor mounts: profile from its first moment when asked
    let frame = null;
    if (process.env.PROFILE) {
      // the outer webview frame (index.html) holds the content frame (fake.html) once it is filled
      frame = await until(async () => page.frames().find(f => f.url().startsWith('vscode-webview:') && f.parentFrame()?.url().startsWith('vscode-webview:')), 30000, 'the webview frame').catch(() => null);
      if (!frame) log('frames:', page.frames().map(f => f.url().slice(0, 100)).join(' | '));
      if (frame) {
        try {
          // (the content frame shares its process with the outer webview frame, which is the out-of-process one)
          session = await ctx.newCDPSession(frame).catch(() => ctx.newCDPSession(frame.parentFrame()));
          await session.send('Profiler.enable');
          await session.send('Profiler.setSamplingInterval', { interval: 500 });
          await session.send('Profiler.start');
          mark('profiling ' + frame.url().slice(0, 80));
        } catch (e) { log('no profile:', String(e).slice(0, 200)); session = null; }
      }
    }
    frame = await until(() => editorFrame(page), 120000, 'the OverLyX editor');
    mark('editor mounted');
    let metaAt = null, stableSince = null, last = '';
    const deadline = Date.now() + 180000;
    while (Date.now() < deadline) {
      const s = await frame.evaluate(() => {
        const ed = document.querySelector('.lyx-editor');
        const h = window.innerHeight;
        const queued = [...document.querySelectorAll('.lyx-editor .pending')];
        return {
          paragraphs: ed?.children.length ?? 0,
          formulas: document.querySelectorAll('.lyx-editor mjx-container').length,
          queued: queued.length,
          onScreen: queued.filter(e => { const r = e.getBoundingClientRect(); return r.bottom > 0 && r.top < h; }).length,
          pending: document.querySelectorAll('.lyx-editor .lm-pending').length,
          meta: !!window.overlyx?.meta,
        };
      }).catch(() => null);
      if (!s) { await sleep(100); continue; }
      if (s.meta && metaAt === null) { metaAt = Date.now() - t0; mark('metadata'); }
      const key = JSON.stringify(s);
      if (key !== last) { mark('state', s); last = key; stableSince = Date.now(); }
      else if (s.meta && ((s.pending === 0 && s.queued === 0 && Date.now() - stableSince > 1500) || Date.now() - stableSince > 10000)) break;
      await sleep(100);
    }
    const settled = stableSince - t0;
    log(`run ${run}: settled at ${(settled / 1000).toFixed(2)} s`);
    const perf = await frame.evaluate(() => {
      const nav = performance.getEntriesByType('navigation')[0];
      const res = performance.getEntriesByType('resource').map(r => ({ name: r.name.replace(/^.*\/(t\/[0-9a-f]+\/)?/, ''), start: Math.round(r.startTime), dur: Math.round(r.duration), size: r.transferSize || r.encodedBodySize }));
      return {
        sinceNavigationStart: Math.round(performance.now()),
        domContentLoaded: nav ? Math.round(nav.domContentLoadedEventEnd) : null,
        load: nav ? Math.round(nav.loadEventEnd) : null,
        resources: res.length,
        slowest: res.sort((a, b) => b.dur - a.dur).slice(0, 15),
        api: res.filter(r => /api\//.test(r.name) || /docs\//.test(r.name)).slice(0, 30),
      };
    });
    log(`run ${run}: webview`, JSON.stringify(perf, null, 1));
    if (session) {
      const { profile } = await session.send('Profiler.stop');
      const f = path.join(out, `open-${run}.cpuprofile`);
      fs.writeFileSync(f, JSON.stringify(profile));
      log('profile', f);
    }
    if (tracer) {
      const done = new Promise(r => tracer.once('Tracing.tracingComplete', r));
      await tracer.send('Tracing.end');
      const { stream } = await done;
      let data = '';
      for (;;) { const c = await tracer.send('IO.read', { handle: stream, size: 1 << 20 }); data += c.base64Encoded ? Buffer.from(c.data, 'base64').toString() : c.data; if (c.eof) break; }
      await tracer.send('IO.close', { handle: stream });
      const f = path.join(out, `open-${run}.trace.json`);
      fs.writeFileSync(f, data);
      log('trace', f);
    }
    await page.screenshot({ path: path.join(out, `open-${run}.png`) });
    results.push({ run, settled, timeline, perf });
    // close it (focus the workbench first: the webview takes keys otherwise)
    await page.keyboard.press('Escape');
    await page.click('.tabs-container .tab.active .tab-actions .codicon-close').catch(async () => { await page.keyboard.press('Control+W'); });
    await sleep(2500);
    if (await editorFrame(page)) log('editor still open after close');
  }
  fs.writeFileSync(path.join(out, 'timing.json'), JSON.stringify(results, null, 2));
  log('wrote', path.join(out, 'timing.json'));
} finally {
  kill();
}
process.exit(0);
