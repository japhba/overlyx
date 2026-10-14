/**
 * Runs inside the VS Code extension host (test/runSyncTest.mjs): the workspace is a clone of a project
 * on a test server, whose project directory is OVERLYX_TEST_SERVER_DIR. The extension syncs it by
 * itself (host/sync.ts): a file written on the server arrives, a file saved here reaches the server,
 * and a file with unsaved changes is not overwritten — once saved, both sides' changes are merged.
 * The second workspace folder is a plain folder with clones inside it (OVERLYX_TEST_NESTED two levels
 * down, OVERLYX_TEST_DEEP four): they are synced without being workspace folders themselves — once
 * the user says so (found, never synced: the extension asks and waits; the test answers with the
 * status bar item's Resume, `overlyx.syncResume` with the clone's folder).
 */
const assert = require('assert');
const path = require('path');
const fs = require('fs');

exports.run = async function run() {
  const vscode = require('vscode');
  const ws = process.env.OVERLYX_TEST_WS, serverDir = process.env.OVERLYX_TEST_SERVER_DIR;
  const log = (...a) => console.log('[overlyx-sync-test]', ...a);
  const until = async (fn, ms, what) => {
    const t0 = Date.now();
    while (Date.now() - t0 < ms) { try { if (await fn()) return; } catch { /* not yet */ } await new Promise(r => setTimeout(r, 250)); }
    throw new Error('timeout waiting for ' + what);
  };
  const read = (f) => fs.readFileSync(f, 'utf8');

  const ext = vscode.extensions.getExtension('overlyx.overlyx-vscode');
  assert.ok(ext, 'extension is present');
  await ext.activate();

  // 1. the clone is synced without being asked
  await until(() => fs.existsSync(path.join(ws, '.git', 'overlyx-sync', 'state.json')), 30000, 'the first sync');
  log('first sync done');

  // 2. a file written on the server arrives
  fs.writeFileSync(path.join(serverDir, 'notes.txt'), 'from the server\n');
  await until(() => read(path.join(ws, 'notes.txt')) === 'from the server\n', 20000, 'the server\'s file here');
  log('server → clone');

  // 3. a file saved here reaches the server
  const uri = vscode.Uri.file(path.join(ws, 'notes.txt'));
  const doc = await vscode.workspace.openTextDocument(uri);
  const editor = await vscode.window.showTextDocument(doc);
  await editor.edit(e => e.insert(new vscode.Position(1, 0), 'typed in VS Code\n'));
  await doc.save();
  await until(() => read(path.join(serverDir, 'notes.txt')) === 'from the server\ntyped in VS Code\n', 20000, 'the saved file on the server');
  log('clone → server');

  // 4. unsaved changes here: the server's change waits (the file is not overwritten under the editor) …
  await editor.edit(e => e.insert(new vscode.Position(0, 0), 'unsaved line\n'));
  assert.ok(doc.isDirty, 'the document has unsaved changes');
  fs.writeFileSync(path.join(serverDir, 'notes.txt'), 'from the server\ntyped in VS Code\nserver line\n');
  await new Promise(r => setTimeout(r, 4000));
  assert.strictEqual(read(path.join(ws, 'notes.txt')), 'from the server\ntyped in VS Code\n', 'the file under the dirty editor is untouched');
  assert.ok(doc.isDirty && doc.getText().startsWith('unsaved line\n'), 'the editor keeps its unsaved text');
  // … and once saved, both changes are merged, on the server, on disk and in the editor
  await doc.save();
  const both = 'unsaved line\nfrom the server\ntyped in VS Code\nserver line\n';
  await until(() => read(path.join(serverDir, 'notes.txt')) === both, 20000, 'the merge on the server');
  await until(() => read(path.join(ws, 'notes.txt')) === both, 20000, 'the merge here');
  await until(() => doc.getText() === both && !doc.isDirty, 20000, 'the editor to show the merge');
  log('dirty file waited, then merged');

  // 5. the commands run
  await vscode.commands.executeCommand('overlyx.syncNow');
  await vscode.commands.executeCommand('overlyx.syncPause');
  fs.writeFileSync(path.join(serverDir, 'paused.txt'), 'x\n');
  await new Promise(r => setTimeout(r, 3000));
  assert.ok(!fs.existsSync(path.join(ws, 'paused.txt')), 'nothing arrives while paused');
  await vscode.commands.executeCommand('overlyx.syncResume');
  await until(() => fs.existsSync(path.join(ws, 'paused.txt')), 20000, 'the file after resuming');
  log('pause / resume');

  // 6. a clone two levels inside a workspace folder: found by itself, but not synced before the user
  // says so (the question waits unanswered here) — then synced both ways
  const nested = process.env.OVERLYX_TEST_NESTED, nestedServer = process.env.OVERLYX_TEST_NESTED_SERVER_DIR;
  const synced = (dir) => fs.existsSync(path.join(dir, '.git', 'overlyx-sync', 'state.json'));
  const start = async (dir, what) => until(async () => { await vscode.commands.executeCommand('overlyx.syncResume', dir); return synced(dir); }, 30000, what);
  assert.ok(!synced(nested), 'the nested clone waits for the user\'s answer');
  await start(nested, 'the nested clone\'s first sync after Resume');
  fs.writeFileSync(path.join(nestedServer, 'nested.txt'), 'to the nested clone\n');
  await until(() => read(path.join(nested, 'nested.txt')) === 'to the nested clone\n', 20000, 'the server\'s file in the nested clone');
  const ndoc = await vscode.workspace.openTextDocument(vscode.Uri.file(path.join(nested, 'nested.txt')));
  const ned = await vscode.window.showTextDocument(ndoc);
  await ned.edit(e => e.insert(new vscode.Position(1, 0), 'saved in the nested clone\n'));
  await ndoc.save();
  await until(() => read(path.join(nestedServer, 'nested.txt')) === 'to the nested clone\nsaved in the nested clone\n', 20000, 'the nested clone\'s save on the server');
  log('nested clone synced both ways');

  // 7. a clone deeper than the scan: synced once a file of it is opened
  const deep = process.env.OVERLYX_TEST_DEEP;
  await new Promise(r => setTimeout(r, 2000));
  assert.ok(!fs.existsSync(path.join(deep, '.git', 'overlyx-sync')), 'the deep clone is not synced before a file of it is opened');
  await vscode.workspace.openTextDocument(vscode.Uri.file(path.join(deep, 'main.tex')));
  await new Promise(r => setTimeout(r, 3000));
  assert.ok(!synced(deep), 'the deep clone, found through the opened file, waits for the user\'s answer too');
  await start(deep, 'the deep clone\'s first sync after Resume');
  log('deep clone found through an opened file, synced after Resume');

  // 8. Clone Project from OverLyX… into a workspace folder: the server, then the project, then the folder (the pickers answered here)
  const server = process.env.OVERLYX_TEST_SERVER, project = process.env.OVERLYX_TEST_PROJECT, clones = process.env.OVERLYX_TEST_CLONES;
  fs.mkdirSync(clones, { recursive: true });
  const w = vscode.window;
  const real = { showQuickPick: w.showQuickPick, showOpenDialog: w.showOpenDialog, showInformationMessage: w.showInformationMessage };
  const picked = [];
  try {
    w.showQuickPick = async (items) => { const list = await items; const it = list.find(i => i.host === server) || list.find(i => i.label === project); picked.push(it && it.label); return it; };
    w.showOpenDialog = async () => [vscode.Uri.file(clones)];
    w.showInformationMessage = async () => undefined;   // "Open in New Window": no
    await Promise.race([vscode.commands.executeCommand('overlyx.cloneProject'), new Promise((_, rej) => setTimeout(() => rej(new Error('the clone command waited for input the test did not give')), 60000))]);
  } finally { Object.assign(w, real); }
  const cloned = path.join(clones, project.split('/').pop());
  assert.ok(fs.existsSync(path.join(cloned, 'main.tex')), 'the project is cloned: ' + JSON.stringify(picked));
  assert.ok(!fs.readFileSync(path.join(cloned, '.git', 'config'), 'utf8').includes('olx'), 'no credential in .git/config');
  // cloned inside the second workspace folder on purpose: in step at once (no question), without being added to the workspace
  await until(() => fs.existsSync(path.join(cloned, '.git', 'overlyx-sync', 'state.json')), 30000, 'the cloned project\'s first sync');
  assert.strictEqual(vscode.workspace.workspaceFolders.length, 2, 'no workspace folder added');
  log('clone command:', picked.join(' → '), '— synced in place');
};
