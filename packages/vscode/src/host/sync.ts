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
 *
 * Signing in and cloning need no CLI and no token: *OverLyX: Sign In…* (also offered as soon as a
 * clone of a server it has no sign-in for turns up) authorizes in the browser — the CLI's own PKCE
 * flow, bundled, with `app=vscode` so the page says "OverLyX for VS Code" — and keeps the credential
 * where the CLI keeps its sign-ins (~/.config/overlyx/hosts.json: one sign-in per computer for both);
 * *Clone Project from OverLyX…* lists the account's projects and clones one (the credential in an
 * environment header, never in .git/config); *Sign Out…* forgets the sign-in.
 */
import * as vscode from 'vscode';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';
import { syncEngineFor, syncTarget, syncCredentials, knownSyncHosts, describeChanges, signInWithBrowser, signedInHosts, signOutOf, remoteProjects, cloneProject, type SyncEngine, type SyncStatus, type SyncTarget, type SyncChanges, type SyncAuth } from '../../../cli/bin/overlyx.js';

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

const DEFAULT_HOST = 'https://overlyx.app';
const hostName = (h: string) => new URL(h).host;
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
    if (s.state === 'signin') {
      // the credential stopped working (revoked, expired): sign in again
      disconnect(f);
      f.signin = true; f.problem = s.message;
      render(f);
      offerSignIn(f.target);
      return;
    }
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
    if (!r.engine) { f.problem = r.error ?? null; f.signin = !!r.signin; render(f); if (f.signin) offerSignIn(f.target); return; }
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

  /** Sign in to `host` through the browser; then every folder waiting for it syncs. Null when it did not work out. */
  async function signInTo(host: string, project?: string): Promise<SyncAuth | null> {
    try {
      const auth = await vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, title: `Signing in to ${hostName(host)} — authorize OverLyX for VS Code in the browser`, cancellable: false }, () => signInWithBrowser(host, {
        app: 'vscode',
        project,
        // a remote window (SSH, a container): the browser is on another computer, so the page shows a code to paste
        manual: !!vscode.env.remoteName,
        open: url => Promise.resolve(vscode.env.openExternal(vscode.Uri.parse(url))),
        askCode: () => Promise.resolve(vscode.window.showInputBox({ prompt: 'Paste the code the OverLyX page shows', ignoreFocusOut: true })),
      }));
      void vscode.window.showInformationMessage(`OverLyX: signed in to ${hostName(host)} as ${auth.username}.`);
      for (const f of syncs.values()) if (f.target.host === host && f.signin) { f.signin = false; f.problem = null; void connect(f); }
      rescan();
      return auth;
    } catch (e) {
      void vscode.window.showErrorMessage(`OverLyX: signing in to ${hostName(host)} failed — ${(e as Error).message}`);
      return null;
    }
  }
  const signIn = (f: FolderSync) => signInTo(f.target.host, f.target.project);

  /** once per server and window: a clone turned up that the sync cannot reach without a sign-in */
  const offered = new Set<string>();
  function offerSignIn(t: SyncTarget): void {
    if (offered.has(t.host)) return;
    offered.add(t.host);
    void vscode.window.showWarningMessage(`OverLyX: sign in to ${hostName(t.host)} to keep this folder in step with ${t.project} — no pull or push needed after that.`, 'Sign in').then(a => { if (a) void signInTo(t.host, t.project); });
  }

  /** the servers to offer: overlyx.app, the ones signed in to, the ones in the settings */
  function servers(): string[] {
    return [...new Set([DEFAULT_HOST, ...signedInHosts().map(h => h.host), ...(config().get<string[]>('sync.servers') ?? []).map(h => h.replace(/\/$/, ''))])];
  }

  async function chooseServer(title: string, always: boolean): Promise<string | undefined> {
    const list = servers();
    if (list.length === 1 && !always) return list[0];
    const signed = new Map(signedInHosts().map(h => [h.host, h.username]));
    const items = [
      ...list.map(h => ({ label: hostName(h), description: signed.has(h) ? `signed in as ${signed.get(h)}` : '', host: h })),
      { label: '$(add) Another OverLyX server…', description: '', host: '' },
    ];
    const pickd = await vscode.window.showQuickPick(items, { title });
    if (!pickd) return undefined;
    if (pickd.host) return pickd.host;
    const typed = await vscode.window.showInputBox({ title, prompt: 'The address of the OverLyX server', placeHolder: 'https://latex.example.org', ignoreFocusOut: true, validateInput: v => /^https?:\/\/[^/\s]+/.test(v.trim()) ? null : 'an http(s) address' });
    return typed?.trim().replace(/\/+$/, '') || undefined;
  }

  /** The sign-in for `host` (the CLI's, git's), or a new one through the browser. */
  async function authFor(host: string): Promise<SyncAuth | null> {
    return (await syncCredentials(host, os.homedir())) ?? await signInTo(host);
  }

  async function cloneCommand(): Promise<void> {
    const host = await chooseServer('Clone a project from which OverLyX server?', false);
    if (!host) return;
    const auth = await authFor(host);
    if (!auth) return;
    let projects: Awaited<ReturnType<typeof remoteProjects>>;
    try { projects = await vscode.window.withProgress({ location: vscode.ProgressLocation.Window, title: 'OverLyX: listing projects' }, () => remoteProjects(host, auth)); }
    catch (e) { void vscode.window.showErrorMessage(`OverLyX: cannot list the projects on ${hostName(host)} — ${(e as Error).message}`); return; }
    if (!projects.length) { void vscode.window.showInformationMessage(`OverLyX: ${auth.username} has no projects on ${hostName(host)} yet.`); return; }
    const choice = await vscode.window.showQuickPick(projects.map(p => ({ label: p.name, description: p.title ?? '', detail: p.role === 'view' ? 'view only: changes arrive here, yours are not sent' : undefined, p })), { title: `Clone a project from ${hostName(host)}`, matchOnDescription: true, placeHolder: 'kept in step with the server while it is open in VS Code' });
    if (!choice) return;
    const last = context.globalState.get<string>('overlyx.clone.parent');
    const parents = await vscode.window.showOpenDialog({ canSelectFolders: true, canSelectFiles: false, canSelectMany: false, openLabel: 'Clone here', title: `Folder to clone ${choice.p.name} into`, defaultUri: vscode.Uri.file(last && fs.existsSync(last) ? last : os.homedir()) });
    if (!parents?.length) return;
    const parent = parents[0].fsPath;
    let dir: string;
    try { dir = await vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, title: `Cloning ${choice.p.name}…` }, () => cloneProject(host, auth, choice.p.name, parent)); }
    catch (e) { void vscode.window.showErrorMessage(`OverLyX: cloning ${choice.p.name} failed — ${(e as Error).message}`); return; }
    await context.globalState.update('overlyx.clone.parent', parent);
    const uri = vscode.Uri.file(dir);
    const open = await vscode.window.showInformationMessage(`OverLyX: cloned ${choice.p.name} into ${dir}. While it is open in VS Code it stays in step with the server.`, 'Open', 'Open in New Window', 'Add to Workspace');
    if (open === 'Open') await vscode.commands.executeCommand('vscode.openFolder', uri, { forceNewWindow: false });
    else if (open === 'Open in New Window') await vscode.commands.executeCommand('vscode.openFolder', uri, { forceNewWindow: true });
    else if (open === 'Add to Workspace') vscode.workspace.updateWorkspaceFolders(vscode.workspace.workspaceFolders?.length ?? 0, 0, { uri });
  }

  async function signOutCommand(): Promise<void> {
    const hosts = signedInHosts();
    if (!hosts.length) { void vscode.window.showInformationMessage('OverLyX: not signed in to any server.'); return; }
    const choice = hosts.length === 1 ? { h: hosts[0] } : await vscode.window.showQuickPick(hosts.map(h => ({ label: hostName(h.host), description: h.username, h })), { title: 'Sign out of which OverLyX server?' });
    if (!choice) return;
    const ok = await vscode.window.showWarningMessage(`Sign out of ${hostName(choice.h.host)} (${choice.h.username})?`, { modal: true, detail: 'The OverLyX CLI on this computer shares this sign-in, so it is signed out too. Synced folders stop syncing until you sign in again. (The credential stays valid until you revoke it in OverLyX under File ▸ Git repository.)' }, 'Sign Out');
    if (ok !== 'Sign Out') return;
    signOutOf(choice.h.host);
    for (const f of syncs.values()) if (f.target.host === choice.h.host) { disconnect(f); f.signin = true; f.problem = 'Signed out.'; render(f); }
  }

  function rescan(): void {
    for (const folder of vscode.workspace.workspaceFolders ?? []) void addFolder(folder).catch(e => report(e, 'sync.folder'));
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
    vscode.commands.registerCommand('overlyx.cloneProject', () => cloneCommand()),
    vscode.commands.registerCommand('overlyx.signIn', async () => { const host = await chooseServer('Sign in to which OverLyX server?', true); if (host) await signInTo(host); }),
    vscode.commands.registerCommand('overlyx.signOut', () => signOutCommand()),
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
      rescan();
    }),
  );
  rescan();
}
