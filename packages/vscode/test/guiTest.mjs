/**
 * GUI test: launches the cached VS Code under xvfb with --remote-debugging-port, connects
 * Playwright over CDP and drives the *rendered* UI — opens a .tex in the OverLyX custom editor,
 * checks the WYSIWYG rendering (headings, MathJax formulas, toolbar icons), types into the
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
  '\\usepackage{amsmath,amssymb,graphicx}',
  '\\newcommand{\\RR}{\\mathbb{R}}',
  '\\input{macros.tex}',
  '\\begin{document}',
  '',
  '\\section{Introduction}',
  '',
  'Functions on $\\RR$ are studied, see \\eqref{eq:main}. Vector $\\bx$.',
  '',
  '\\includegraphics[width=16pt]{../figures/parent.png}',
  '\\includegraphics[width=16pt]{../../figures/grandparent.png}',
  '\\includegraphics[width=16pt]{../figures/parent-pdf}',
  '',
  '\\begin{equation}',
  'f(x)=x^{2}\\label{eq:main}',
  '\\end{equation}',
  '',
  '\\include{chapter}',
  '',
  '\\section{Methods}',
  '',
  'Inline math $a+b=c$ inside running text.',
  '',
  '\\end{document}',
  '',
].join('\n');
const fixtureRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'overlyx-gui-ws-'));
const ws = path.join(fixtureRoot, 'paper', 'submission');
fs.mkdirSync(ws, { recursive: true });
fs.mkdirSync(path.join(fixtureRoot, 'paper', 'figures'));
fs.mkdirSync(path.join(fixtureRoot, 'figures'));
fs.copyFileSync(path.join(pkg, 'test/fixtures/graphics.png'), path.join(fixtureRoot, 'paper/figures/parent.png'));
fs.copyFileSync(path.join(pkg, 'test/fixtures/graphics.png'), path.join(fixtureRoot, 'figures/grandparent.png'));
fs.copyFileSync(path.join(pkg, 'test/fixtures/graphics.pdf'), path.join(fixtureRoot, 'paper/figures/parent-pdf.pdf'));
fs.writeFileSync(path.join(ws, 'main.tex'), MAIN);
fs.writeFileSync(path.join(ws, 'chapter.tex'), '\\section{Details}\n\nChild paragraph with $a+b$.\n');
fs.writeFileSync(path.join(ws, 'macros.tex'), String.raw`\newcommand{\bx}{\boldsymbol{x}}`);
fs.writeFileSync(path.join(ws, 'notes.md'), '# Notes heading\n\nA *markdown* paragraph.\n\n* a star bullet\n');

/* ---------------------------------------------------------------- VS Code launch */
const udd = fs.mkdtempSync(path.join(os.tmpdir(), 'overlyx-gui-udd-'));
const extDir = fs.mkdtempSync(path.join(os.tmpdir(), 'overlyx-gui-ext-'));
fs.mkdirSync(path.join(udd, 'User'), { recursive: true });
fs.writeFileSync(path.join(udd, 'User/settings.json'), JSON.stringify({
  'workbench.editorAssociations': { '*.tex': 'overlyx.texEditor', '*.md': 'overlyx.texEditor' },
  'security.workspace.trust.enabled': false,
  'update.mode': 'none',
  'telemetry.telemetryLevel': 'off',
  'workbench.startupEditor': 'none',
  'window.restoreWindows': 'none',
  'workbench.colorTheme': 'Default Light Modern',
  // the save dialog of New Slide Deck as VS Code's own quick input (a native one is out of Playwright's reach)
  'files.simpleDialog.enable': true,
}, null, 2));

const exe = await downloadAndUnzipVSCode({ cachePath: path.join(pkg, '.vscode-test') });
// another port when two runs share the machine (two checkouts, two sessions): they would drive each other's VS Code
const PORT = Number(process.env.OVERLYX_GUI_PORT) || 9339;
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
/** a screenshot of the state a failure was found in (set once the page exists) */
let shotOnFail = async () => {};
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
  shotOnFail = () => shot('99-fail');
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
  await until(() => editorFrame.evaluate(() => {
    const images = [...document.querySelectorAll('.lyx-graphics img')];
    return images.length === 3 && images.every(img => img.complete && img.naturalWidth > 0);
  }), 10000, 'PNG and PDF figures from parent directories');
  log('parent and grandparent graphics paths rendered, including extensionless PDF');

  /* ---- 2. WYSIWYG rendering checks ---- */
  const checks = await editorFrame.evaluate(() => {
    const text = document.body.innerText;
    const icons = [...document.querySelectorAll('img.tb-img')];
    return {
      hasIntro: /Introduction/.test(text),
      hasMethods: /Methods/.test(text),
      formulas: document.querySelectorAll('mjx-container').length,
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
  if (checks.formulas < 2) fail('formulas not rendered (found ' + checks.formulas + ')');
  if (checks.displayMath < 1 || checks.inlineMath < 1) fail('math nodes missing');
  if (!checks.statusbar) fail('status bar missing');
  if (checks.icons < 20) fail('toolbar icons missing (found ' + checks.icons + ')');
  if (checks.iconsLoaded < checks.icons) fail('only ' + checks.iconsLoaded + '/' + checks.icons + ' toolbar icons loaded');
  if (checks.rawLatexVisible) fail('raw LaTeX visible — document not WYSIWYG-rendered');
  const rawMacro = await editorFrame.evaluate(() => document.body.innerText.indexOf('\\RR') >= 0);
  if (rawMacro) fail('the \\RR macro is shown as raw LaTeX — document macros not applied to formulas');
  await shot('01-editor');

  const macroState = await editorFrame.evaluate(() => ({ macros: window.overlyx?.meta?.macros, errors: [...document.querySelectorAll('.lm-error:not(.lm-pending), .lm-undefined')].map(n => n.textContent), math: [...document.querySelectorAll('.lyx-math-inline')].map(n => n.innerText) }));
  log('macro state', JSON.stringify(macroState));
  if (!macroState.macros?.bx || macroState.math.some(t => t.includes('\\bx'))) fail('imported bx macro did not render');
  await editorFrame.getByRole('button', { name: 'Split', exact: true }).click();
  await editorFrame.locator('textarea.source').waitFor({ state: 'visible' });
  await until(() => editorFrame.locator('textarea.source').inputValue().then(s => s.includes('Introduction')), 15000, 'source text');
  await editorFrame.getByRole('button', { name: 'TeX', exact: true }).click();
  if (await editorFrame.locator('.editor-scroll').isVisible()) fail('TeX mode did not hide the writing area');
  await editorFrame.getByRole('button', { name: 'WYSIWYG', exact: true }).click();
  if (!await editorFrame.locator('.ruler').isVisible()) fail('ruler missing');
  fs.writeFileSync(path.join(ws, 'macros.tex'), String.raw`\newcommand{\bx}{\boldsymbol{y}}`);
  await until(() => editorFrame.evaluate(() => window.overlyx?.meta?.macros?.bx?.def === String.raw`\boldsymbol{y}`), 15000, 'macro dependency refresh');
  const rulerHandle = editorFrame.getByRole('slider', { name: 'Text width, right handle' });
  const widthBefore = Number(await rulerHandle.getAttribute('aria-valuenow'));
  await rulerHandle.focus(); await page.keyboard.press('ArrowLeft');
  await until(async () => Number(await rulerHandle.getAttribute('aria-valuenow')) === widthBefore - 20, 5000, 'ruler resizing');
  await editorFrame.getByRole('button', { name: 'TeX', exact: true }).click();
  const sourceBox = editorFrame.locator('textarea.source');
  await until(() => sourceBox.inputValue().then(s => s.includes('Inline math')), 15000, 'source text after reopening TeX mode');
  await sourceBox.fill((await sourceBox.inputValue()).replace('Inline math', 'Source edit: inline math'));
  await sourceBox.press('Control+s');
  await until(() => fs.readFileSync(path.join(ws, 'main.tex'), 'utf8').includes('Source edit: inline math'), 15000, 'saving directly from TeX mode');
  await sleep(750); // let a delayed visual-editor echo, if any, arrive after the save
  if (await page.locator('.tabs-container .tab.dirty').count()) fail('TeX save was followed by another unsaved visual-editor rewrite');
  await editorFrame.getByRole('button', { name: 'WYSIWYG', exact: true }).click();
  await until(() => editorFrame.locator('.lyx-editor').innerText().then(t => t.includes('Source edit: inline math')), 10000, 'source edit in WYSIWYG mode');
  log('view modes, ruler and imported macro refresh OK');

  /* ---- 3. type into the document, save with Ctrl+S, verify the .tex on disk ---- */
  await editorFrame.locator('.lyx-par', { hasText: 'are studied' }).first().click({ position: { x: 4, y: 8 } });
  await page.keyboard.press('End');
  await page.keyboard.type(' Typed via the GUI test.');
  await until(async () => (await editorFrame.evaluate(() => document.body.innerText)).includes('Typed via the GUI test.'), 15000, 'typed text in the editor');
  await page.keyboard.press('Control+s');
  await until(() => fs.readFileSync(path.join(ws, 'main.tex'), 'utf8').includes('Typed via the GUI test.'), 20000, 'the typed text in the saved .tex file');
  const saved = fs.readFileSync(path.join(ws, 'main.tex'), 'utf8');
  if (saved.indexOf('\\section{Introduction}') < 0) fail('saved file lost its structure');
  log('typing reached the .tex file on disk through Ctrl+S');
  await shot('02-typed-and-saved');

  /* ---- 3b. the mode switch (top bar): Viewing makes the editor read-only, Editing gives it back ---- */
  const editable = () => editorFrame.locator('.lyx-editor').first().getAttribute('contenteditable');
  const docText = () => editorFrame.evaluate(() => window.overlyx.activeView.state.doc.textContent);
  await editorFrame.locator('.editor-topbar .edit-mode-btn').click();
  await editorFrame.locator('.edit-mode-menu [data-mode="viewing"]').click();
  await until(() => editable().then(v => v === 'false'), 5000, 'Viewing: a read-only editor');
  const textBefore = await docText();
  await editorFrame.locator('.lyx-par', { hasText: 'are studied' }).first().click({ position: { x: 4, y: 8 } });
  await page.keyboard.type('zzz');
  // a command (a toolbar button) is refused as well
  await editorFrame.evaluate(() => { const v = window.overlyx.activeView; v.dispatch(v.state.tr.insertText('yyy', 2)); });
  await sleep(300);
  if (await docText() !== textBefore) fail('Viewing mode let an edit through');
  await editorFrame.locator('.editor-topbar .edit-mode-btn').click();
  await editorFrame.locator('.edit-mode-menu [data-mode="editing"]').click();
  await until(() => editable().then(v => v === 'true'), 5000, 'Editing: editable again');
  log('mode switch: Viewing is read-only, Editing is editable again');

  /* ---- 3c. the theme switch: Default follows VS Code, Light / Dark override it ---- */
  const themeOf = () => editorFrame.evaluate(() => document.documentElement.dataset.theme);
  const vscodeTheme = await themeOf();
  const pickTheme = async (choice) => {
    await editorFrame.locator('.editor-topbar [data-theme-toggle]').click();
    await editorFrame.locator('.ctx-menu[data-theme-menu] .ctx-item:not(.info)', { hasText: new RegExp('^' + choice) }).click();
  };
  if (await editorFrame.locator('.editor-topbar [data-theme-toggle]').getAttribute('data-pref') !== 'system') fail('the theme switch does not start on Default');
  await editorFrame.locator('.editor-topbar [data-theme-toggle]').click();
  if (!/^Default \(follows VS Code\)/.test(await editorFrame.locator('.ctx-menu[data-theme-menu] .ctx-item.checked').first().innerText())) fail('the theme menu does not offer Default (follows VS Code) as the current choice');
  await page.keyboard.press('Escape');
  const other = vscodeTheme === 'dark' ? 'Light' : 'Dark';
  await pickTheme(other);
  await until(() => themeOf().then(t => t === other.toLowerCase()), 5000, `the ${other} theme`);
  await pickTheme('Default');
  await until(() => themeOf().then(t => t === vscodeTheme), 5000, "VS Code's theme again");
  log(`theme switch: ${other} overrides VS Code's ${vscodeTheme} theme, Default follows it again`);

  /* ---- 3a. Ctrl+K: the link box (VS Code must not take the key as the start of its Ctrl+K chord) ---- */
  await editorFrame.evaluate(() => {
    const v = window.overlyx.activeView; let at = -1;
    v.state.doc.descendants((n, pos) => { if (at < 0 && n.isText && n.text.includes('Typed')) at = pos + n.text.indexOf('Typed'); });
    v.dispatch(v.state.tr.setSelection(v.state.selection.constructor.create(v.state.doc, at, at + 5))); v.focus();
  });
  await page.keyboard.press('Control+k');
  await editorFrame.locator('.link-box input').waitFor({ state: 'visible', timeout: 5000 });
  await sleep(300);
  // VS Code hears every key of the webview; without the extension's own Ctrl+K binding it waits for the second key of its chord
  if (/second key of chord/i.test(await page.locator('.statusbar').innerText())) fail('Ctrl+K in the editor started VS Code\'s Ctrl+K chord');
  await page.keyboard.type('example.org');
  await page.keyboard.press('Enter');
  await until(() => editorFrame.locator('.lyx-editor .lyx-href').count().then(n => n === 1), 5000, 'the link inset');
  await page.keyboard.press('Control+s');
  await until(() => fs.readFileSync(path.join(ws, 'main.tex'), 'utf8').includes('\\href{https://example.org}{Typed}'), 20000, 'the link in the saved .tex file');
  log('Ctrl+K made a link over the selection (no VS Code chord)');

  /* ---- 3b. the combined view: the \include'd child is edited below the master and saved to its own file ---- */
  await page.keyboard.press('Control+Shift+p');
  await page.waitForSelector('.quick-input-widget input', { timeout: 15000 });
  await page.keyboard.type('OverLyX: Show Master and Child');
  await sleep(500);
  await page.keyboard.press('Enter');
  await until(() => editorFrame.evaluate(() => [...document.querySelectorAll('.child-doc .lyx-editor')].some(e => (e.textContent || '').includes('Child paragraph'))), 20000, 'the child document below the master');
  await editorFrame.click('.child-doc .lyx-editor >> text=Child paragraph');
  await page.keyboard.press('End');
  await page.keyboard.type(' Typed into the child.');
  await page.keyboard.press('Control+s');
  await until(() => fs.readFileSync(path.join(ws, 'chapter.tex'), 'utf8').includes('Typed into the child.'), 20000, 'the child edit in chapter.tex on disk');
  if (fs.readFileSync(path.join(ws, 'main.tex'), 'utf8').includes('Typed into the child.')) fail('the child edit leaked into the master file');
  log('combined view: child document edited below the master and saved to chapter.tex');
  await shot('02b-combined');
  await page.keyboard.press('Control+Shift+p');
  await page.waitForSelector('.quick-input-widget input', { timeout: 15000 });
  await page.keyboard.type('OverLyX: Show Master and Child');
  await sleep(500);
  await page.keyboard.press('Enter');
  await until(() => editorFrame.evaluate(() => document.querySelectorAll('.child-doc').length === 0), 10000, 'the combined view to switch off again');
  /* ---- 4. click into a formula: the static rendering upgrades to an editable math field ---- */
  await editorFrame.click('.lyx-math-display mjx-container');
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
  for (const figure of ['../figures/parent.png', '../../figures/grandparent.png', '../figures/parent-pdf']) {
    if (!finalTex.includes('{' + figure + '}')) fail('relative figure path changed on save: ' + figure);
  }
  if (finalTex.indexOf('\\section{Methods}') < 0) fail('document structure corrupted during the GUI run');
  if (finalTex.indexOf('\\include{chapter}') < 0) fail('the \\include of the child document was lost');
  if (/Ove[A-Z]/.test(finalTex)) fail('stray palette keystrokes leaked into the document');
  const pdfText = await pdfFrame.evaluate(() => document.body.innerText);
  if (pdfText.indexOf('✗') >= 0) fail('PDF panel reports build errors');

  /* ---- 7. a markdown file in the same editor: typed markdown is saved as markdown ---- */
  await page.keyboard.press('Control+p');
  await page.waitForSelector('.quick-input-widget input', { timeout: 15000 });
  await page.keyboard.type('notes.md');
  await sleep(600);
  await page.keyboard.press('Enter');
  const mdFrame = await until(async () => {
    for (const f of page.frames()) { try { if (await f.$('.lyx-editor .lyx-layout-section') && (await f.evaluate(() => document.body.innerText)).includes('Notes heading')) return f; } catch { /* gone */ } }
    return null;
  }, 60000, 'the markdown file in the OverLyX editor');
  await sleep(1500);   // the editor settles (meta, fonts) before the click
  // (the column is narrow here — the PDF panel is open beside it — so the paragraph wraps: click its last line)
  const mdPar = mdFrame.locator('.lyx-par', { hasText: 'paragraph.' }).first();
  const box = await mdPar.boundingBox();
  await mdPar.click({ position: { x: Math.max(4, (box?.width ?? 20) - 3), y: Math.max(4, (box?.height ?? 16) - 6) } });
  await sleep(300);
  await page.keyboard.press('End');
  await sleep(200);
  await page.keyboard.type(' Now **bold** too.');
  await until(() => mdFrame.evaluate(() => !!document.querySelector('.lyx-series-bold')), 10000, 'the **bold** markup made bold while typing');
  await page.keyboard.press('Control+s');
  await until(() => fs.readFileSync(path.join(ws, 'notes.md'), 'utf8').includes('Now **bold** too.'), 20000, 'the typed markdown in notes.md');
  const md = fs.readFileSync(path.join(ws, 'notes.md'), 'utf8');
  if (!md.startsWith('# Notes heading\n\nA *markdown* paragraph. Now **bold** too.\n\n* a star bullet')) fail('notes.md was rewritten beyond the edit: ' + JSON.stringify(md));
  log('markdown file edited in the OverLyX editor and saved as markdown');
  await shot('06-markdown');
  // Ctrl+B in a document is the editor's bold, not VS Code's Toggle Side Bar
  const sideBar = page.locator('#workbench\\.parts\\.sidebar');
  if (!await sideBar.isVisible()) fail('the side bar should be open before the Ctrl+B check');
  await page.keyboard.press('Control+b');
  await sleep(1000);
  if (!await sideBar.isVisible()) fail('Ctrl+B in a document toggled VS Code\'s side bar');
  log('Ctrl+B in a document left the side bar open');

  /* ---- 8. File ▸ New File… ▸ Slide Deck: a 16:9 deck saved beside the open file, opened as slides ---- */
  await page.keyboard.press('Control+Shift+p');
  await page.waitForSelector('.quick-input-widget input', { timeout: 15000 });
  await page.keyboard.type('Create: New File');
  await sleep(500);
  await page.keyboard.press('Enter');
  await until(() => page.locator('.quick-input-widget .monaco-list-row', { hasText: 'Slide Deck' }).count(), 15000, 'Slide Deck in File ▸ New File…');
  await shot('07-new-file-entries');
  await page.locator('.quick-input-widget .monaco-list-row', { hasText: 'Slide Deck' }).first().click();
  await until(() => page.locator('.quick-input-widget .monaco-list-row', { hasText: 'Slides 16:9' }).count(), 15000, 'the aspect ratios');
  await page.keyboard.press('Enter');
  // the save dialog offers slides.tex in the folder of the active file
  await until(() => page.locator('.quick-input-widget input').inputValue().then(v => v.endsWith('/submission/slides.tex')), 15000, 'slides.tex offered in the save dialog');
  await page.keyboard.press('Enter');
  const deck = path.join(ws, 'slides.tex');
  await until(() => fs.existsSync(deck), 15000, 'slides.tex on disk');
  const deckTex = fs.readFileSync(deck, 'utf8');
  if (!deckTex.startsWith('\\documentclass[aspectratio=169]{beamer}') || !deckTex.includes('\\begin{olbox}') || !deckTex.includes('Title of the talk')) fail('the new deck is not a 16:9 layout document: ' + deckTex.slice(0, 300));
  const deckFrame = await until(async () => {
    for (const f of page.frames()) { try { if (await f.locator('.lyx-editor .ol-page').count() === 2) return f; } catch { /* gone */ } }
    return null;
  }, 60000, 'the new deck in the OverLyX editor (two slides)');
  await until(() => deckFrame.evaluate(() => (document.querySelector('.lyx-editor')?.textContent || '').includes('Title of the talk')), 15000, 'the title slide');
  log('File ▸ New File… ▸ Slide Deck created slides.tex and opened it as slides');
  await shot('08-new-slide-deck');
  // an object shows the four-way move cursor (a drag moves it)
  // (the text of the unselected author box; in the narrow column its middle can lie outside the viewport, so no elementFromPoint)
  const objCursor = await deckFrame.evaluate(() => { const b = document.querySelectorAll('.lyx-editor .ol-box')[1]; return getComputedStyle(b.querySelector('.lyx-par') || b).cursor; });
  if (objCursor !== 'move') fail('a slide object shows the ' + objCursor + ' cursor, not move');
  // Ctrl+B in slides is the editor's bold, not VS Code's Toggle Side Bar
  if (!await sideBar.isVisible()) fail('the side bar should be open before the Ctrl+B check in the deck');
  await deckFrame.locator('.lyx-editor .ol-box').first().click();
  await sleep(400);
  await page.keyboard.press('Control+b');
  await sleep(1000);
  if (!await sideBar.isVisible()) fail('Ctrl+B in the slide deck toggled VS Code\'s side bar');
  log('Ctrl+B in the slide deck left the side bar open');
  // Ctrl+M in a text box: the formula field, drawn on paper even in the dark theme; VS Code's Ctrl+M (Tab moves focus) stays off
  const themeBefore = await deckFrame.evaluate(() => { const t = document.documentElement.dataset.theme; document.documentElement.dataset.theme = 'dark'; return t; });
  await deckFrame.locator('.lyx-editor .ol-box').nth(1).dblclick();
  await sleep(400);
  await page.keyboard.press('End');
  await page.keyboard.press('Control+m');
  await until(() => deckFrame.evaluate(() => !!document.querySelector('.lyx-editor .ol-box .lm-field.focused')), 10000, 'the formula field in the text box');
  const fieldBg = await deckFrame.evaluate(() => getComputedStyle(document.querySelector('.lyx-editor .ol-box .lm-field.focused')).backgroundColor);
  const lum = (fieldBg.match(/\d+/g) || []).slice(0, 3).map(Number).reduce((a, b) => a + b, 0) / 3;
  if (lum < 200) fail('the formula being edited on a slide is drawn dark: ' + fieldBg);
  if (await page.locator('.statusbar-item', { hasText: 'Tab Moves Focus' }).count()) fail('Ctrl+M also switched VS Code to Tab Moves Focus');
  await page.keyboard.type('a^2');
  await page.keyboard.press('Escape');
  await deckFrame.evaluate(t => { document.documentElement.dataset.theme = t; }, themeBefore);
  log('Ctrl+M in a slide text box opened a light formula field; the move cursor shows over objects');

  log('ALL GUI CHECKS PASSED');
  await browser.close().catch(() => {});
} catch (e) {
  failed = true;
  await shotOnFail().catch(() => {});
  throw e;
} finally {
  kill();
  fs.rmSync(fixtureRoot, { recursive: true, force: true });
  if (!failed) { fs.rmSync(udd, { recursive: true, force: true }); fs.rmSync(extDir, { recursive: true, force: true }); }
  else log('kept user-data-dir for inspection:', udd);
}
