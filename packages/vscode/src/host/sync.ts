/**
 * Clones of OverLyX projects kept in step with the server while VS Code is open: a workspace folder
 * whose git remote is a project on overlyx.app (or a server the CLI is signed in to) is synced both
 * ways — a saved file reaches the project within seconds, what people write there arrives here, the
 * branch follows the server's commits. No pull, commit or push; the history keeps OverLyX's own
 * schedule (a commit made here becomes one there, with its message).
 *
 * The engine is the CLI's (packages/cli/bin/overlyx.js, bundled: `overlyx sync --watch` does the
 * same in a terminal, and the two never run on one clone at once). Here it adds: files with unsaved
 * changes in an editor wait until they are saved, a status bar item, a log, conflict notices, and
 * the browser sign-in. `overlyx.sync.enabled` switches it off; "Pause" holds one folder.
 */
import * as vscode from 'vscode';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';
import { syncEngineFor, syncTarget, knownSyncHosts, describeChanges, signInWithBrowser, type SyncEngine, type SyncStatus, type SyncTarget, type SyncChanges } from '../../../cli/bin/overlyx.js';

interface FolderSync {
  dir: string;
  target: SyncTarget;
  engine: SyncEngine | null;
  item: vscode.StatusBarItem;
  /** why there is no engine (not signed in, …) */
  problem: string | null;
  signin: boolean;
  spin: NodeJS.Timeout | null;
  connecting: Promise<void> | null;
}

const PAUSED = (dir: string) => `overlyx.sync.paused:${dir}`;
const ANNOUNCED = (dir: string) => `overlyx.sync.announced:${dir}`;
const time = (t: number) => new Date(t).toLocaleTimeString();
const projectUrl = (t: SyncTarget) => `${t.host}/#/${t.project.split('/').map(encodeURIComponent).join('/')}`;

export function setupSync(context: vscode.ExtensionContext, report: (e: unknown, area: string) => void): void {
  const out = vscode.window.createOutputChannel('OverLyX Sync');
  const syncs = new Map<string, FolderSync>();
  const config = () => vscode.workspace.getConfiguration('overlyx');
  const enabled = () => config().get<boolean>('sync.enabled') ?? true;
  const paused = (dir: string) => context.workspaceState.get<boolean>(PAUSED(dir)) ?? false;
  const log = (dir: string, line: string) => out.appendLine(`[${time(Date.now())}]${syncs.size > 1 ? ` ${path.basename(dir)}:` : ''} ${line}`);

  /** a file of `dir` with unsaved changes in an editor: the sync neither overwrites nor sends it until it is saved */
  const busy = (dir: string) => (rel: string) => vscode.workspace.textDocuments.some(d => d.isDirty && d.uri.scheme === 'file' && path.relative(dir, d.uri.fsPath).split(path.sep).join('/') === rel);

  function render(f: FolderSync): void {
    const s: SyncStatus | undefined = f.engine?.status;
    const name = syncs.size > 1 ? ` ${f.target.project.split('/').pop()}` : '';
    const where = `**${f.target.project}** on ${new URL(f.target.host).host}`;
    let text: string, detail: string;
    if (!enabled() || paused(f.dir)) { text = `$(debug-pause) OverLyX${name}`; detail = 'Sync paused — click to resume.'; }
    else if (f.signin) { text = `$(account) OverLyX${name}: sign in`; detail = 'Not signed in — click to sign in through the browser.'; }
    else if (f.problem || !s) { text = `$(sync) OverLyX${name}`; detail = f.problem ?? 'Starting…'; }
    else {
      const icon = s.state === 'syncing' ? (f.spin ? 'sync' : 'sync~spin') : s.state === 'offline' ? 'cloud-offline' : s.state === 'error' ? 'error' : s.state === 'paused' ? 'debug-pause'
        : s.state === 'signin' ? 'account' : s.conflicts.length ? 'warning' : s.waiting.length ? 'sync' : 'check';
      text = `$(${icon}) OverLyX${name}`;
      const lines = [
        s.state === 'idle' ? `In step${s.lastSync ? ` (${time(s.lastSync)})` : ''}: files you save reach the server, its changes come here.` : s.state === 'syncing' ? 'Syncing…' : s.message,
        ...s.waiting.map(w => `· ${w} waits until it is saved`),
        ...[...new Set(s.notSent)].map(n => `· ${n} changed here — not sent (view only)`),
        ...s.conflicts.map(c => c.kind === 'copy' ? `⚠ ${c.path}: changed on both sides, yours is "${c.copy}"` : c.kind === 'tracked' ? `⚠ ${c.path}: ${c.count} paragraph(s) changed on both sides — yours are tracked changes` : `⚠ ${c.path}: changed on the server, not removed`),
      ];
      if (s.state === 'idle' && s.message) lines.push(s.message);
      detail = lines.filter(Boolean).join('\n\n');
    }
    f.item.text = text;
    f.item.tooltip = new vscode.MarkdownString(`${where}\n\n${detail}`);
    f.item.show();
  }

  /** "syncing" shows only when a round takes a moment (it runs after every save and every change on the server) */
  function onStatus(f: FolderSync, s: SyncStatus): void {
    if (s.state === 'syncing') {
      if (!f.spin) f.spin = setTimeout(() => { f.spin = null; render(f); }, 600);
      return;
    }
    if (f.spin) { clearTimeout(f.spin); f.spin = null; }
    render(f);
  }

  function noticeConflicts(f: FolderSync, c: SyncChanges): void {
    for (const k of c.conflicts) {
      if (k.kind === 'copy' && k.copy) {
        const copy = k.copy;
        void vscode.window.showWarningMessage(`OverLyX: ${k.path} was changed here and on the server. The server's version is in ${k.path} now; yours is "${copy}".`, 'Compare').then(a => {
          if (a) void vscode.commands.executeCommand('vscode.diff', vscode.Uri.file(path.join(f.dir, copy)), vscode.Uri.file(path.join(f.dir, k.path)), `${path.basename(copy)} ↔ ${path.basename(k.path)} (server)`);
        });
      } else if (k.kind === 'tracked') {
        void vscode.window.showInformationMessage(`OverLyX: in ${k.path}, ${k.count === 1 ? 'a paragraph was' : `${k.count} paragraphs were`} changed here and on the server. The server's text stays; yours is a tracked change over it — accept or reject it in the editor.`);
      } else if (k.kind === 'restored') {
        void vscode.window.showInformationMessage(`OverLyX: ${k.path} was changed on the server, so removing it here was undone.`);
      }
    }
  }

  function connect(f: FolderSync): Promise<void> {
    f.connecting ??= start(f).finally(() => { f.connecting = null; });
    return f.connecting;
  }

  async function start(f: FolderSync): Promise<void> {
    if (f.engine || !enabled() || paused(f.dir) || !syncs.has(f.dir)) { render(f); return; }
    const r = await syncEngineFor(f.dir, {
      client: os.hostname(),
      isBusy: busy(f.dir),
      log: line => log(f.dir, line),
    });
    if (!r.engine) { f.problem = r.error ?? null; f.signin = !!r.signin; render(f); return; }
    f.problem = null; f.signin = false;
    const engine = r.engine;
    engine.o.onStatus = s => onStatus(f, s);
    const round = engine.round.bind(engine);
    engine.round = async () => {
      const c = await round();
      for (const l of describeChanges(c)) log(f.dir, l);
      noticeConflicts(f, c);
      return c;
    };
    f.engine = engine;
    const stateDir = (() => { try { return fs.existsSync(path.join(f.dir, '.git', 'overlyx-sync')); } catch { return true; } })();
    if (!stateDir && !context.workspaceState.get<boolean>(ANNOUNCED(f.dir))) {
      void context.workspaceState.update(ANNOUNCED(f.dir), true);
      void vscode.window.showInformationMessage(`OverLyX keeps this folder in step with ${f.target.project} on ${new URL(f.target.host).host}: files you save go there within seconds, and changes made there arrive here — no pull or push needed.`, 'Pause for this folder').then(a => { if (a) void setPaused(f, true); });
    }
    log(f.dir, `syncing ${f.dir} with ${f.target.project} on ${f.target.host}`);
    render(f);
    void engine.watch({ watchFiles: true }).catch(e => { report(e, 'sync.watch'); log(f.dir, `stopped: ${String(e)}`); });
  }

  function disconnect(f: FolderSync): void {
    f.engine?.stop();
    f.engine = null;
    render(f);
  }

  async function setPaused(f: FolderSync, on: boolean): Promise<void> {
    await context.workspaceState.update(PAUSED(f.dir), on || undefined);
    if (on) { disconnect(f); log(f.dir, 'paused'); }
    else await connect(f);
  }

  async function addFolder(folder: vscode.WorkspaceFolder): Promise<void> {
    if (folder.uri.scheme !== 'file' || syncs.has(folder.uri.fsPath)) return;
    const dir = folder.uri.fsPath;
    const target = await syncTarget(dir);
    if (!target) return;
    const servers = [...knownSyncHosts(), ...(config().get<string[]>('sync.servers') ?? []).map(h => h.replace(/\/$/, ''))];
    if (!servers.includes(target.host)) return;
    const item = vscode.window.createStatusBarItem(`overlyx.sync:${dir}`, vscode.StatusBarAlignment.Left, 40);
    item.name = 'OverLyX Sync';
    item.command = { command: 'overlyx.syncMenu', title: 'OverLyX Sync', arguments: [dir] };
    const f: FolderSync = { dir, target, engine: null, item, problem: null, signin: false, spin: null, connecting: null };
    syncs.set(dir, f);
    await connect(f);
  }

  function removeFolder(dir: string): void {
    const f = syncs.get(dir);
    if (!f) return;
    disconnect(f);
    f.item.dispose();
    syncs.delete(dir);
  }

  async function signIn(f: FolderSync): Promise<void> {
    try {
      await vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, title: `Signing in to ${new URL(f.target.host).host} — authorize in the browser`, cancellable: false }, () => signInWithBrowser(f.target.host, {
        project: f.target.project,
        // a remote window (SSH, a container): the browser is on another computer, so the page shows a code to paste
        manual: !!vscode.env.remoteName,
        open: url => Promise.resolve(vscode.env.openExternal(vscode.Uri.parse(url))),
        askCode: () => Promise.resolve(vscode.window.showInputBox({ prompt: 'Paste the code the OverLyX page shows', ignoreFocusOut: true })),
      }));
      f.signin = false;
      await connect(f);
    } catch (e) {
      void vscode.window.showErrorMessage(`OverLyX: signing in failed — ${(e as Error).message}`);
    }
  }

  const pick = (dir?: string): FolderSync | undefined => {
    if (dir) return syncs.get(dir);
    const active = vscode.window.activeTextEditor?.document.uri;
    const folder = active ? vscode.workspace.getWorkspaceFolder(active) : undefined;
    return (folder && syncs.get(folder.uri.fsPath)) ?? [...syncs.values()][0];
  };
  const none = () => void vscode.window.showInformationMessage('OverLyX: no folder here is a clone of an OverLyX project (git clone https://overlyx.app/git/<owner>/<project>.git).');

  context.subscriptions.push(
    out,
    { dispose: () => { for (const dir of [...syncs.keys()]) removeFolder(dir); } },
    vscode.commands.registerCommand('overlyx.syncNow', async (dir?: string) => {
      const f = pick(dir);
      if (!f) return none();
      if (f.signin) return signIn(f);
      if (!f.engine) { await setPaused(f, false); return; }
      try { await f.engine.sync(); } catch (e) { void vscode.window.showErrorMessage(`OverLyX sync: ${(e as Error).message}`); }
    }),
    vscode.commands.registerCommand('overlyx.syncPause', (dir?: string) => { const f = pick(dir); return f ? setPaused(f, true) : none(); }),
    vscode.commands.registerCommand('overlyx.syncResume', (dir?: string) => { const f = pick(dir); return f ? setPaused(f, false) : none(); }),
    vscode.commands.registerCommand('overlyx.syncShowLog', () => out.show(true)),
    vscode.commands.registerCommand('overlyx.syncMenu', async (dir?: string) => {
      const f = pick(dir);
      if (!f) return none();
      if (f.signin) return signIn(f);
      type Item = vscode.QuickPickItem & { run: () => unknown };
      const isPaused = paused(f.dir) || !enabled();
      const items: Item[] = [
        ...(isPaused ? [] : [{ label: '$(sync) Sync now', run: () => vscode.commands.executeCommand('overlyx.syncNow', f.dir) }]),
        isPaused
          ? { label: '$(play) Resume syncing', description: enabled() ? '' : 'overlyx.sync.enabled is off', run: () => enabled() ? setPaused(f, false) : vscode.commands.executeCommand('workbench.action.openSettings', 'overlyx.sync') }
          : { label: '$(debug-pause) Pause syncing this folder', run: () => setPaused(f, true) },
        { label: '$(output) Show the sync log', run: () => out.show(true) },
        { label: `$(globe) Open ${f.target.project} on ${new URL(f.target.host).host}`, run: () => vscode.env.openExternal(vscode.Uri.parse(projectUrl(f.target))) },
        ...(f.engine?.status.conflicts ?? []).filter(c => c.kind === 'copy' && c.copy).map(c => ({
          label: `$(warning) ${c.path}`, description: `compare with your copy "${c.copy}"`,
          run: () => vscode.commands.executeCommand('vscode.diff', vscode.Uri.file(path.join(f.dir, c.copy!)), vscode.Uri.file(path.join(f.dir, c.path)), `${path.basename(c.copy!)} ↔ ${path.basename(c.path)} (server)`),
        })),
      ];
      const choice = await vscode.window.showQuickPick(items, { title: `OverLyX Sync — ${f.target.project}`, placeHolder: f.engine?.status.message || undefined });
      await choice?.run();
    }),
    // a save is sent at once (the file watcher would notice it too, a moment later)
    vscode.workspace.onDidSaveTextDocument(d => { for (const f of syncs.values()) if (d.uri.fsPath.startsWith(f.dir + path.sep)) f.engine?.poke?.(); }),
    vscode.window.onDidChangeWindowState(s => { if (s.focused) for (const f of syncs.values()) { if (f.engine) f.engine.poke?.(); else if (!f.signin) void connect(f); } }),
    vscode.workspace.onDidChangeWorkspaceFolders(e => {
      for (const r of e.removed) removeFolder(r.uri.fsPath);
      for (const a of e.added) void addFolder(a).catch(err => report(err, 'sync.folder'));
    }),
    vscode.workspace.onDidChangeConfiguration(e => {
      if (!e.affectsConfiguration('overlyx.sync')) return;
      for (const f of syncs.values()) { if (enabled()) void connect(f); else disconnect(f); }
      for (const folder of vscode.workspace.workspaceFolders ?? []) void addFolder(folder).catch(err => report(err, 'sync.folder'));
    }),
  );
  for (const folder of vscode.workspace.workspaceFolders ?? []) void addFolder(folder).catch(e => report(e, 'sync.folder'));
}
