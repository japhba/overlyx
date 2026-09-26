/** Real Vite/Preact HMR in two independent editor webviews. The host transport is stubbed;
 * all parsing, rendering, editing and undo use the extension's actual implementation. */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from '@playwright/test';
import { parseDocumentText } from '../src/host/texdoc';
import { buildMeta } from '../src/host/meta';
import { lyxToPm } from '../../core/src/index';

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const artifacts = fs.mkdtempSync(path.join(os.tmpdir(), 'overlyx-live-test-'));
const input = process.argv[2] || path.join(artifacts, 'main.tex');
if (!process.argv[2]) fs.writeFileSync(input, '\\documentclass{article}\n\\newcommand{\\RR}{\\mathbb R}\n\\begin{document}\n\\section{Introduction}\nThis is a paragraph for live editing, with a formula $\\RR$.\n\\end{document}\n');
const ctx = { root: path.dirname(input), layoutDir: path.join(repo, 'lyx/lib/layouts') };
const relPath = path.basename(input), fileText = fs.readFileSync(input, 'utf8');
const parsed = parseDocumentText(fileText, ctx, relPath);
const fixture = { pmDoc: lyxToPm(parsed.doc), headerLines: parsed.doc.header.lines,
  meta: buildMeta({ ctx, project: 'local/test', relPath, lyx: parsed.doc, isChild: parsed.fragment, fileText }) };
const server = process.env.OVERLYX_TEST_SERVER || 'http://127.0.0.1:18765';
const source = path.join(repo, 'packages/vscode/src/webview/EditorShell.tsx');
const original = fs.readFileSync(source, 'utf8');
const edited = original.replace('data-vscode="1"', 'data-vscode="1" data-live-test="updated"');
assert.notEqual(edited, original);
const browser = await chromium.launch({ executablePath: process.env.CHROME_PATH || '/usr/bin/google-chrome', args: ['--no-sandbox'] });
const errors: string[] = [];
let mutated = false;
try {
  const pages = await Promise.all([0, 1].map(async i => {
    const page = await browser.newPage();
    page.on('pageerror', e => errors.push(String(e)));
    await page.addInitScript(({ fixture, server, i }) => {
      const w = window as any;
      w.__OVERLYX_VSCODE__ = { page: 'editor', docId: `local/test/${i}.tex`, base: server, assetBase: server + '/', dark: false };
      w.__messages = [];
      w.__OVERLYX_VSCAPI = { postMessage(m: any) {
        w.__messages.push(m);
        if (m.type === 'update') { fixture.pmDoc = m.pmDoc; fixture.headerLines = m.headerLines; }
        if (m.type === 'ready') setTimeout(() => window.dispatchEvent(new MessageEvent('message', { data: { type: 'init', ...w.__OVERLYX_VSCODE__, pmDoc: fixture.pmDoc, headerLines: fixture.headerLines, fragment: false } })), 0);
      }, getState() { return null; }, setState() {} };
    }, { fixture, server, i });
    await page.route('**/api/**', route => route.fulfill({ json: route.request().url().endsWith('/meta') ? fixture.meta : { available: false, models: [] } }));
    await page.goto(server + '/editor.html');
    await page.waitForFunction(() => !!(window as any).overlyx?.activeView, { timeout: 60000 });
    await page.evaluate(i => {
      const w = window as any, view = w.overlyx.activeView;
      let position = -1;
      view.state.doc.descendants((n: any, pos: number) => { if (position < 0 && n.isTextblock && n.textContent.length > 30) position = pos + 1; });
      if (position < 0) throw new Error('No text paragraph for test');
      view.dispatch(view.state.tr.insertText(`Live edit ${i}. `, position));
      w.__beforeView = view;
      w.__beforeDoc = JSON.stringify(view.state.doc.toJSON());
      w.__beforeSelection = JSON.stringify(view.state.selection.toJSON());
    }, i);
    return page;
  }));
  // Change code while edits may still be in the 300 ms send debounce.
  fs.writeFileSync(source, edited);
  mutated = true;
  for (const [i, page] of pages.entries()) {
    await page.waitForSelector('[data-live-test="updated"]', { timeout: 60000 });
    await page.waitForFunction(() => (window as any).overlyx.activeView !== (window as any).__beforeView);
    assert.deepEqual(await page.evaluate(() => {
      const w = window as any, view = w.overlyx.activeView;
      return { document: JSON.stringify(view.state.doc.toJSON()) === w.__beforeDoc, selection: JSON.stringify(view.state.selection.toJSON()) === w.__beforeSelection };
    }), { document: true, selection: true });
    await page.evaluate(() => (window as any).overlyx.activeView.focus());
    await page.keyboard.press('Control+z');
    await page.waitForFunction(i => !(window as any).overlyx.activeView.state.doc.textContent.includes(`Live edit ${i}.`), i);
    await page.keyboard.press('Control+Shift+z');
    await page.waitForFunction(i => (window as any).overlyx.activeView.state.doc.textContent.includes(`Live edit ${i}.`), i);
    await page.screenshot({ path: path.join(artifacts, `window-${i}.png`) });
    console.log(`Window ${i}: UI updated; document, cursor, undo and redo preserved.`);
  }
  assert.equal(fs.readFileSync(source, 'utf8'), edited, 'Source changed concurrently; refusing to overwrite it');
  fs.writeFileSync(source, original);
  mutated = false;
  for (const page of pages) {
    await page.waitForSelector('[data-live-test="updated"]', { state: 'detached', timeout: 60000 });
    await page.waitForFunction(() => !document.querySelector('.lyx-math-display[data-pending="true"]'));
    const failures = await page.locator('.lm-error:not(.lm-pending),.lm-undefined,.lm-unknown').allTextContents();
    assert.deepEqual(failures, [], 'Every formula renders without an error or unknown command');
  }
  // Reopening uses the same service and fresh host initialization, without restarting the service.
  await pages[0].reload();
  await pages[0].waitForSelector('.lyx-editor');
  assert.deepEqual(errors, []);
  console.log(`PASS: two-window HMR, reverse update, reconnect and formula rendering. Artifacts: ${artifacts}`);
} finally {
  if (mutated && fs.readFileSync(source, 'utf8') === edited) fs.writeFileSync(source, original);
  await browser.close();
}
