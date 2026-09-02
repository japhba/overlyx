/**
 * Runs inside the VS Code extension host. Exercises the whole pipeline: custom editor opens, the
 * webview boots and posts the outline (proves the editor rendered the parsed document), the
 * bridge answers, a host->webview command round-trips through the webview and the bridge back
 * into the TextDocument, an external file change reaches the webview, and latexmk builds a PDF
 * with SyncTeX.
 */
const assert = require('assert');
const path = require('path');
const fs = require('fs');

exports.run = async function run() {
  const vscode = require('vscode');
  const ws = process.env.OVERLYX_TEST_WS;
  const log = (...a) => console.log('[overlyx-test]', ...a);
  const until = async (fn, ms, what) => {
    const t0 = Date.now();
    let last;
    while (Date.now() - t0 < ms) {
      try { const v = await fn(); if (v) return v; } catch (e) { last = e; }
      await new Promise(r => setTimeout(r, 250));
    }
    throw new Error('timeout waiting for ' + what + (last ? ' — last error: ' + last : ''));
  };

  const ext = vscode.extensions.getExtension('overlyx.overlyx-vscode');
  assert.ok(ext, 'extension is present');
  const api = await ext.activate();
  assert.ok(api && api.registry, 'activate() returns the test API');

  const mainUri = vscode.Uri.file(path.join(ws, 'main.tex'));
  await vscode.commands.executeCommand('vscode.openWith', mainUri, 'overlyx.texEditor');
  const entry = await until(() => api.registry.all()[0], 30000, 'the editor to register');
  log('editor registered:', entry.session.docId);
  // diagnostic tap on everything the webview sends
  entry.panel.webview.onDidReceiveMessage(m => log('webview →', m && m.type, m && m.type === 'notify' ? m.text : ''));

  // 1. webview booted, parsed document rendered, outline posted back
  await until(() => entry.outline.length >= 1 && entry.outline.some(o => /Introduction/.test(o.text)), 90000, 'the outline from the webview');
  log('outline:', JSON.stringify(entry.outline.map(o => `${o.num ?? ''} ${o.text}`.trim())));

  // 2. the bridge serves metadata
  const base = api.bridgeBase();
  const enc = encodeURIComponent(entry.session.docId);
  const meta = await (await fetch(`${base}/api/docs/${enc}/meta`)).json();
  assert.strictEqual(meta.textclass, 'article');
  assert.ok(Object.keys(meta.macros).includes('RR'), 'preamble macro in meta');
  assert.ok(meta.labels.some(l => l.name === 'eq:main'), 'label in meta');
  log('meta ok:', meta.labels.length, 'labels,', Object.keys(meta.macros).length, 'macros');

  // 3. full loop: host command → webview → bridge POST header → session → TextDocument
  const before = entry.session.document.getText();
  void entry.panel.webview.postMessage({ type: 'command', name: 'toggleTracking' });
  await until(async () => {
    const h = await (await fetch(`${base}/api/docs/${enc}/header`)).json();
    return h.headerLines.some(l => l === '\\tracking_changes true');
  }, 30000, 'tracking_changes to reach the header (webview round trip)');
  await until(() => entry.session.document.getText() !== before, 15000, 'the TextDocument to change');
  log('toggleTracking round trip ok (document text updated)');

  // 4. an external change on disk reaches the webview and comes back as a new outline
  await entry.session.document.save();
  const p = path.join(ws, 'main.tex');
  fs.writeFileSync(p, fs.readFileSync(p, 'utf8').replace('\\section{Introduction}', '\\section{Renamed Heading}'));
  await until(() => entry.outline.some(o => /Renamed Heading/.test(o.text)), 45000, 'the external change to reach the webview');
  log('external change merged into the editor');

  // 5. latexmk build + SyncTeX through the bridge
  await vscode.commands.executeCommand('overlyx.buildPdf');
  const finished = await until(async () => {
    const b = await (await fetch(`${base}/api/docs/${enc}/build`)).json();
    return b.job && ['ok', 'error', 'cancelled'].includes(b.job.status) ? b : null;
  }, 240000, 'the latexmk build to finish');
  if (finished.job.status !== 'ok') {
    console.log('[overlyx-test] BUILD LOG START\n' + String(finished.build && finished.build.log).slice(0, 20000) + '\n[overlyx-test] BUILD LOG END');
  }
  assert.strictEqual(finished.job.status, 'ok', 'build failed — log above');
  assert.ok(finished.build.pdf, 'build result carries a PDF URL');
  const pdfResp = await fetch(finished.build.pdf);
  assert.strictEqual(pdfResp.status, 200, 'PDF is served');
  assert.strictEqual(pdfResp.headers.get('content-type'), 'application/pdf');
  log('pdf built and served:', finished.build.pdf);
  const sync = await (await fetch(`${base}/api/docs/${enc}/synctex/view?line=5`)).json();
  assert.ok(Array.isArray(sync.boxes) && sync.boxes.length > 0, 'synctex forward search returns boxes');
  log('synctex ok:', sync.boxes.length, 'boxes');

  // 5b. document symbols: the built-in Outline/breadcrumbs path for .tex text editors
  const symbols = await vscode.commands.executeCommand('vscode.executeDocumentSymbolProvider', mainUri);
  assert.ok(Array.isArray(symbols) && symbols.some(sy => /Renamed Heading|Introduction/.test(sy.name)), 'document symbols for .tex: ' + JSON.stringify((symbols || []).map(sy => sy.name)));
  assert.strictEqual(symbols.length, 1, 'exactly one top-level symbol (no doubled providers): ' + JSON.stringify(symbols.map(sy => sy.name)));
  log('document symbols ok:', symbols.map(sy => sy.name).join(', '));

  // 6. self-update pipeline against a stubbed release endpoint (dry run: stops after download)
  const http = require('http');
  const stubVsix = Buffer.alloc(20000, 7);
  const stub = http.createServer((req, res) => {
    if (req.url === '/latest') {
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify({ tag_name: 'v99.0.0', html_url: 'http://stub/rel', body: 'test release',
        assets: [{ name: 'overlyx-vscode-99.0.0.vsix', browser_download_url: `http://127.0.0.1:${stub.address().port}/asset.vsix` }] }));
    } else if (req.url === '/asset.vsix') { res.end(stubVsix); }
    else { res.statusCode = 404; res.end(); }
  });
  await new Promise(r => stub.listen(0, '127.0.0.1', r));
  try {
    const r = await api.checkForUpdates({ interactive: false, dryRun: true, apiOverride: `http://127.0.0.1:${stub.address().port}/latest` });
    assert.strictEqual(r.status, 'dry-run-downloaded', 'updater found and downloaded the stub release: ' + JSON.stringify(r));
    assert.strictEqual(r.latest, '99.0.0');
    assert.ok(r.vsixPath && fs.statSync(r.vsixPath).size === stubVsix.length, 'vsix downloaded to disk');
    log('self-update pipeline ok (dry run):', r.vsixPath);
  } finally { stub.close(); }

  log('ALL INTEGRATION CHECKS PASSED');
};
