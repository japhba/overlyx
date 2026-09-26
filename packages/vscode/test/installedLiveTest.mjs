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
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) if (entry.isDirectory()) fs.symlinkSync(path.join(dir, entry.name), path.join(workspace, entry.name));
} else {
  fs.mkdirSync(path.join(workspace, 'sections'));
  fs.writeFileSync(path.join(workspace, 'main.tex'), '\\documentclass{article}\n\\newcommand{\\RR}{\\mathbb R}\n\\input{macros}\n\\begin{document}\n\\section{Live extension}\nA normally installed editor renders $\\RR$.\n\\input{sections/chapter}\n\\input{second.tex}\n\\end{document}\n');
  fs.writeFileSync(path.join(workspace, 'macros.tex'), '\\newcommand{\\initialmacro}{x}\n');
  fs.writeFileSync(path.join(workspace, 'sections/chapter.tex'), '\\section{Child chapter}\nChild text and inherited math $\\RR$.\n\nAn unchanged separator.\n\nAnother unchanged separator.\n\nLocal notes.\n\n\\input{nested.tex}\n');
  fs.writeFileSync(path.join(workspace, 'sections/nested.tex'), '\\subsection{Nested child}\nNested text.\n');
  fs.writeFileSync(path.join(workspace, 'second.tex'), '\\section{Second child}\nSibling text.\n\\subsection{Destination}\nTarget paragraph.\n');
}
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
  page.setDefaultTimeout(60000);
  const webviewErrors = [];
  page.on('pageerror', error => { webviewErrors.push(error.message); console.error('Webview error:', error.stack); });
  let frame = await until(async () => {
    for (const f of page.frames()) if (await f.locator('.lyx-editor').count()) return f;
  }, 'installed live editor');
  await frame.waitForFunction(() => !!window.overlyx?.activeView);
  await sleep(4000);
  // A formula can have valid KaTeX markup while all of its font URLs fail. Check actual
  // font loading in the real webview, including every bundled text face.
  await frame.evaluate(async () => {
    await Promise.all(['400', '700', 'italic 400', 'italic 700'].map(face => document.fonts.load(`${face} 16px "CMU Serif"`, 'Computer Modern')));
    await document.fonts.ready;
  });
  const result = await frame.evaluate(() => ({
    formulas: document.querySelectorAll('.katex').length,
    errors: [...document.querySelectorAll('.katex-error,.lm-error,.lm-unknown')].map(n => n.textContent),
    live: [...document.scripts].some(s => s.src.includes('/@vite/client')),
    iconsLoaded: [...document.querySelectorAll('img.tb-img')].every(i => i.complete && i.naturalWidth > 0),
    textFont: getComputedStyle(document.querySelector('.lyx-editor')).fontFamily,
    fonts: [...document.fonts].filter(f => f.status !== 'unloaded').map(f => ({ family: f.family, style: f.style, weight: f.weight, status: f.status })),
  }));
  console.log(result);
  assert.ok(result.formulas > 0);
  assert.deepEqual(result.errors, []);
  assert.equal(result.live, true);
  assert.equal(result.iconsLoaded, true);
  assert.match(result.textFont, /^"?CMU Serif"?,/);
  assert.ok(result.fonts.every(f => f.status === 'loaded'), 'No font request may fail');
  assert.equal(result.fonts.filter(f => f.family === 'CMU Serif').length, 4, 'All four Computer Modern text faces load');
  assert.ok(result.fonts.some(f => f.family === 'KaTeX_Main'), 'Computer Modern math fonts load');
  const menuTitles = ['File', 'Edit', 'View', 'Insert', 'Navigate', 'Document', 'Tools', 'Help'];
  const compact = await frame.locator('.menu-overflow').count() > 0;
  if (compact) {
    await frame.locator('.menu-overflow > button').click();
    assert.deepEqual(await frame.locator('.menu-overflow-panel [role="menuitem"]').allTextContents(), menuTitles);
    await page.keyboard.press('Escape');
  } else assert.deepEqual(await frame.locator('.menubar .menu > button').allTextContents(), menuTitles);
  const openMenu = async title => {
    if (compact) {
      await frame.locator('.menu-overflow > button').click();
      await frame.locator('.menu-overflow-panel [role="menuitem"]').getByText(title, { exact: true }).click();
    } else await frame.locator('.menubar .menu > button').getByText(title, { exact: true }).click();
  };
  await openMenu('Help');
  await frame.locator('[data-help-search]').fill('statistics');
  assert.ok(await frame.locator('.help-menu').innerText().then(text => text.includes('Statistics')));
  await page.keyboard.press('Escape');
  await openMenu('Tools');
  await frame.locator('.menu-item').getByText('Settings…', { exact: true }).click();
  assert.equal(await frame.locator('[data-pref="autoCorrect"]').count(), 1);
  await page.keyboard.press('Escape');
  const rulerBefore = await frame.locator('.ruler').count();
  await openMenu('View');
  await frame.locator('.menu-item').filter({ hasText: /^Ruler$/ }).click();
  assert.notEqual(await frame.locator('.ruler').count(), rulerBefore);
  await openMenu('View');
  await frame.locator('.menu-item').filter({ hasText: /^Ruler$/ }).click();
  console.log('PASS: shared menus, command search, settings, ruler, and native palette coexistence.');
  if (process.argv[3]) {
    await frame.evaluate(() => window.overlyx.ui.toggleCombined());
    await frame.waitForFunction(() => document.querySelectorAll('.lyx-editor').length > 1);
    await frame.waitForFunction(() => document.querySelectorAll('.lm-image-glyph img').length > 0);
    const glyphs = await frame.evaluate(async () => {
      const imgs = [...document.querySelectorAll('.lm-image-glyph img')];
      await Promise.all(imgs.map(img => img.decode()));
      const first = imgs[0];
      const bitmap = await createImageBitmap(await (await fetch(first.src)).blob());
      const canvas = document.createElement('canvas'); canvas.width = bitmap.width; canvas.height = bitmap.height;
      const ctx = canvas.getContext('2d'); ctx.drawImage(bitmap, 0, 0);
      const rgba = ctx.getImageData(0, 0, canvas.width, canvas.height).data;
      return { count: imgs.length, urls: [...new Set(imgs.map(img => img.src))], transparent: rgba.some((value, i) => i % 4 === 3 && value === 0), ink: rgba.some((value, i) => i % 4 === 3 && value > 0), loaded: imgs.every(img => img.naturalWidth > 0), mask: getComputedStyle(first.parentElement).maskImage };
    });
    console.log('Paper image glyphs:', glyphs);
    assert.ok(glyphs.count > 0 && glyphs.loaded && glyphs.transparent && glyphs.ink);
    assert.ok(glyphs.urls.every(url => url.includes('doublephi.pdf')));
    assert.notEqual(glyphs.mask, 'none');
    await frame.locator('.lm-image-glyph').first().scrollIntoViewIfNeeded();
    await page.screenshot({ path: path.join(artifacts, 'doublephi.png') });
  }
  if (!process.argv[3]) {
    const masterBefore = fs.readFileSync(documentPath, 'utf8');
    await frame.locator('.lyx-include').first().click({ button: 'right' });
    await frame.locator('.ctx-item').filter({ hasText: 'Show master and child documents in one view' }).click();
    await frame.waitForFunction(() => document.querySelectorAll('.lyx-editor').length === 4);
    const ids = await frame.locator('.lyx-editor').evaluateAll(nodes => nodes.map(n => n.dataset.docId.split('/').slice(2).join('/')));
    assert.deepEqual(ids, ['main.tex', 'sections/chapter.tex', 'sections/nested.tex', 'second.tex']);
    assert.deepEqual(await frame.locator('.katex-error,.lm-error,.lm-unknown').allTextContents(), []);
    const childEditor = frame.locator('.lyx-editor[data-doc-id$="/sections/chapter.tex"]');
    await childEditor.locator('p').last().click();
    await frame.evaluate(() => {
      const view = window.overlyx.activeView;
      if (!view.dom.dataset.docId.endsWith('/sections/chapter.tex')) throw new Error('Child did not become the active editor');
      view.dispatch(view.state.tr.insertText(' CHILD EDIT ', 1));
      window.overlyx.ui.save();
    });
    await until(() => fs.readFileSync(path.join(workspace, 'sections/chapter.tex'), 'utf8').includes('CHILD EDIT'), 'child edit saved to its own file');
    assert.equal(fs.readFileSync(documentPath, 'utf8'), masterBefore, 'Child edits leave the master unchanged');
    await frame.getByText('Show this document only', { exact: true }).click();
    await frame.waitForFunction(() => document.querySelectorAll('.lyx-editor').length === 1);
    await frame.locator('.lyx-include').first().click({ button: 'right' });
    await frame.locator('.ctx-item').filter({ hasText: 'Show master and child documents in one view' }).click();
    await frame.waitForFunction(() => document.querySelectorAll('.lyx-editor').length === 4);
    await childEditor.locator('p').first().click();
    await frame.getByTitle('Undo (Ctrl+Z)', { exact: true }).click();
    await frame.waitForFunction(() => !window.overlyx.activeView.state.doc.textContent.includes('CHILD EDIT'));
    await frame.getByTitle('Redo (Ctrl+Y)', { exact: true }).click();
    await frame.waitForFunction(() => window.overlyx.activeView.state.doc.textContent.includes('CHILD EDIT'));
    await frame.evaluate(() => window.overlyx.ui.save());
    await until(() => fs.readFileSync(path.join(workspace, 'sections/chapter.tex'), 'utf8').includes('CHILD EDIT'), 'redo saved');
    fs.appendFileSync(path.join(workspace, 'sections/nested.tex'), '\nExternal nested update.\n');
    await frame.waitForFunction(() => document.querySelector('.lyx-editor[data-doc-id$="/sections/nested.tex"]').textContent.includes('External nested update'));
    await frame.locator('.lyx-editor[data-doc-id$="/main.tex"] .lyx-include').first().click({ button: 'right' });
    await frame.locator('.ctx-item').filter({ hasText: 'Open in new editor tab' }).click();
    let childFrame = await until(async () => {
      for (const candidate of page.frames()) {
        if (candidate !== frame && await candidate.locator('.lyx-editor[data-doc-id$="/sections/chapter.tex"]').count()) return candidate;
      }
    }, 'child opened in a separate VS Code editor tab');
    await childFrame.waitForFunction(() => document.querySelectorAll('.lyx-editor').length === 4);
    assert.equal((await childFrame.locator('.lyx-editor').first().getAttribute('data-doc-id')).split('/').pop(), 'main.tex', 'Combined view opened from a child begins with the master');
    await childFrame.locator('.lyx-editor[data-doc-id$="/sections/chapter.tex"] p').first().click();
    await childFrame.evaluate(() => {
      const view = window.overlyx.activeView;
      view.dispatch(view.state.tr.insertText(' SEPARATE TAB EDIT ', 1));
      window.overlyx.ui.save();
    });
    await frame.waitForFunction(() => document.querySelector('.lyx-editor[data-doc-id$="/sections/chapter.tex"]').textContent.includes('SEPARATE TAB EDIT'));
    await until(() => fs.readFileSync(path.join(workspace, 'sections/chapter.tex'), 'utf8').includes('SEPARATE TAB EDIT'), 'separate tab saved');
    assert.equal(fs.readFileSync(documentPath, 'utf8'), masterBefore, 'Saving from either tab leaves the master unchanged');
    // Closing a separate tab can release the TextDocument still used by the joint view.
    await page.keyboard.press('Control+w');
    await sleep(3000);
    fs.appendFileSync(path.join(workspace, 'sections/chapter.tex'), '\nUpdate after closing the child tab.\n');
    await frame.waitForFunction(() => document.querySelector('.lyx-editor[data-doc-id$="/sections/chapter.tex"]').textContent.includes('Update after closing the child tab'));
    await frame.locator('.lyx-editor[data-doc-id$="/main.tex"] .lyx-include').first().click({ button: 'right' });
    await frame.locator('.ctx-item').filter({ hasText: 'Open in new editor tab' }).click();
    childFrame = await until(async () => {
      for (const candidate of page.frames()) {
        if (candidate !== frame && await candidate.locator('.lyx-editor[data-doc-id$="/sections/chapter.tex"]').count()) return candidate;
      }
    }, 'child tab reopened');
    await childFrame.waitForFunction(() => document.querySelectorAll('.lyx-editor').length === 4);
    await childFrame.locator('.lyx-editor[data-doc-id$="/sections/chapter.tex"] p').first().click();
    // A dirty child buffer used to mask a rewritten file even after reloading webviews.
    await childFrame.evaluate(() => {
      const view = window.overlyx.activeView;
      let position;
      view.state.doc.descendants((node, pos) => { if (node.isTextblock && node.textContent === 'Local notes.') position = pos + node.nodeSize - 1; });
      if (position === undefined) throw new Error('Missing local-note paragraph');
      view.dispatch(view.state.tr.insertText(' UNSAVED NOTE', position));
    });
    await sleep(800);
    const childPath = path.join(workspace, 'sections/chapter.tex');
    assert.ok(!fs.readFileSync(childPath, 'utf8').includes('UNSAVED NOTE'));
    fs.writeFileSync(path.join(workspace, 'macros.tex'), '\\newcommand{\\quh}{q_{\\mathbf{u}\\mathbf{h}}}\n');
    const external = fs.readFileSync(childPath, 'utf8')
      .replace('Child chapter', 'MSRJD appendix')
      .replace('Child text and inherited math $\\RR$.', 'Singular-vector overlap $\\quh$.');
    assert.ok(external.includes('Singular-vector overlap'));
    fs.writeFileSync(childPath, external);
    for (const target of [frame, childFrame]) {
      await target.waitForFunction(() => {
        const editor = document.querySelector('.lyx-editor[data-doc-id$="/sections/chapter.tex"]');
        return editor.textContent.includes('MSRJD appendix') && editor.textContent.includes('UNSAVED NOTE')
          && !editor.querySelector('.katex-error,.lm-error,.lm-unknown');
      });
    }
    assert.equal(fs.readFileSync(childPath, 'utf8'), external, 'External refresh does not save a cached view over the file');
    await childFrame.getByText('Show this document only', { exact: true }).click();
    await childFrame.waitForFunction(() => document.querySelectorAll('.lyx-editor').length === 1);
    await childFrame.evaluate(() => window.overlyx.ui.toggleCombined());
    await childFrame.waitForFunction(() => document.querySelectorAll('.lyx-editor').length === 4);
    assert.equal(fs.readFileSync(childPath, 'utf8'), external, 'Toggling cached views does not overwrite external source');
    await page.keyboard.press('Control+Shift+p');
    await page.locator('.quick-input-widget input[type="text"]').fill('>Developer: Reload Webviews');
    await page.keyboard.press('Enter');
    await until(() => childFrame.isDetached(), 'previous appendix webview closed');
    childFrame = await until(async () => {
      for (const candidate of page.frames()) {
        if (await candidate.locator('.lyx-editor[data-doc-id$="/sections/chapter.tex"]').count()
            && await candidate.evaluate(() => window.__OVERLYX_VSCODE__?.docId.endsWith('/sections/chapter.tex'))) return candidate;
      }
    }, 'refreshed appendix webview');
    await childFrame.waitForFunction(() => {
      const editor = document.querySelector('.lyx-editor[data-doc-id$="/sections/chapter.tex"]');
      return editor.textContent.includes('MSRJD appendix') && editor.textContent.includes('UNSAVED NOTE');
    });
    await childFrame.evaluate(() => window.overlyx.ui.save());
    // Both disk and the unsaved buffer changed: keep VS Code's native confirmation.
    const conflict = page.locator('.notification-list-item').filter({ hasText: "Failed to save 'chapter.tex'" });
    await conflict.getByRole('button', { name: 'Overwrite', exact: true }).click();
    await until(() => fs.readFileSync(childPath, 'utf8').includes('UNSAVED NOTE'), 'merged appendix saved');
    const restored = fs.readFileSync(childPath, 'utf8');
    assert.equal((restored.match(/MSRJD appendix/g) || []).length, 1);
    assert.equal((restored.match(/UNSAVED NOTE/g) || []).length, 1);
    assert.ok(!restored.includes('Child chapter'));
    assert.equal(fs.readFileSync(documentPath, 'utf8'), masterBefore);
    console.log('PASS: dirty appendix buffer, external rewrite, inherited macro refresh, cached view toggles, webview reload, and saving without stale or duplicated sections.');
    console.log('PASS: context menu, separate VS Code tab, master/child/nested views, inherited macros, child save isolation, undo/redo across toggles, external file sync.');
    await childFrame.evaluate(() => window.overlyx.openInTab('local/workspace/second.tex', { heading: 1 }));
    const destination = await until(async () => {
      for (const candidate of page.frames()) if (await candidate.evaluate(() => window.__OVERLYX_VSCODE__?.docId === 'local/workspace/second.tex')) return candidate;
    }, 'heading destination editor');
    await destination.waitForFunction(() => window.overlyx?.activeView?.state.selection.$from.parent.textContent === 'Destination');
    console.log('PASS: cross-document navigation waits for the new editor and selects the requested heading.');

  }
  assert.deepEqual(webviewErrors, [], 'No errors while replacing and reopening editor views');
  await page.screenshot({ path: path.join(artifacts, 'installed.png') });
  console.log('PASS: normal VSIX installation, source loader, real VS Code webview, HTTP bridge and macro rendering. Artifacts:', artifacts);
} catch (error) {
  if (browser) for (const page of browser.contexts()[0].pages()) {
    await page.screenshot({ path: path.join(artifacts, 'failed.png') });
    for (const frame of page.frames()) console.log('Failed view:', await frame.evaluate(() => ({
      editors: [...document.querySelectorAll('.lyx-editor')].map(n => n.dataset.docId),
      errors: [...document.querySelectorAll('.child-doc-error,.notification-list-item-message')].map(n => n.textContent),
    })));
  }
  console.error('Failure artifacts:', artifacts);
  throw error;
} finally {
  // Electron may keep background helpers alive after closing its last test window.
  process.kill(-child.pid, 'SIGKILL');
  if (browser) await browser.close();
  fs.closeSync(output);
}
