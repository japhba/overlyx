/**
 * Runs inside the VS Code extension host (test/runSyncTest.mjs): the workspace is a clone of a project
 * on a test server, whose project directory is OVERLYX_TEST_SERVER_DIR. The extension syncs it by
 * itself (host/sync.ts): a file written on the server arrives, a file saved here reaches the server,
 * and a file with unsaved changes is not overwritten — once saved, both sides' changes are merged.
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
};
