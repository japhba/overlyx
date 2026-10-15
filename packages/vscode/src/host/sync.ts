/**
 * Clones of OverLyX projects kept in step with the server while VS Code is open: a workspace folder
 * whose git remote is a project on overlyx.app (or a server the CLI is signed in to) is synced both
 * ways — a saved file reaches the project within seconds, what people write there arrives here, the
 * branch follows the server's commits. No pull, commit or push; the history keeps OverLyX's own
 * schedule (a commit made here becomes one there, with its message).
 *
 * A clone inside a workspace folder is synced too, without adding it to the workspace (a paper in a
 * subdirectory or submodule of its code's repository): the folders are searched NEST_DEPTH levels
 * down (at most NEST_DIRS directories, hidden and SKIP ones left out, a clone's inside not searched),
 * again when the window gets the focus (at most every RESCAN_MS); a clone deeper than that is found
 * when a file of it is opened; one made with *Clone Project from OverLyX…* inside the workspace at
 * once. A clone inside a synced clone is left alone (its files belong to the outer one's folder).
 * A clone found that way that was never synced asks first (once per workspace: "Keep in Step" /
 * "Not Now"), since nobody opened it on purpose and its first sync merges what changed on both sides;
 * until then it is paused, and its status bar item starts it. A submodule's detached HEAD is put on
 * the server's branch by the engine (attachDetachedHead) when that changes no file and loses no commit.
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
 * environment header, never in .git/config), into a folder named after the project; into a folder of
 * a git repository (one that is not a clone of a project itself) as a submodule of it or as a clone
 * it ignores (.gitignore), the user's choice; *Sign Out…* forgets the sign-in.
 */
import * as vscode from 'vscode';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';
import { syncEngineFor, syncTarget, syncCredentials, knownSyncHosts, describeChanges, signInWithBrowser, signedInHosts, signOutOf, remoteProjects, cloneProject, enclosingRepo, addProjectSubmodule, ignoreInRepo, type SyncEngine, type SyncStatus, type SyncTarget, type SyncChanges, type SyncAuth } from '../../../cli/bin/overlyx.js';

interface FolderSync {
  dir: string;
  /** inside a workspace folder, not one itself */
  nested: boolean;
  /** found by the search and never synced: paused until the user says to keep it in step */
  unasked: boolean;
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
const ASKED = (dir: string) => `overlyx.sync.asked:${dir}`;
const time = (t: number) => new Date(t).toLocaleTimeString();
const projectUrl = (t: SyncTarget) => `${t.host}/#/${t.project.split('/').map(encodeURIComponent).join('/')}`;
const inside = (file: string, dir: string) => file.startsWith(dir + path.sep);

/** a clone's git directory: .git, or where the .git file of a submodule or worktree points */
function gitDirOf(dir: string): string {
  const dotgit = path.join(dir, '.git');
  try {
    if (fs.statSync(dotgit).isFile()) {
      const m = /^gitdir:\s*(.+)$/m.exec(fs.readFileSync(dotgit, 'utf8'));
      if (m) return path.resolve(dir, m[1].trim());
    }
  } catch { /* no .git: the caller's existsSync says no */ }
  return dotgit;
}
/** synced before (by the extension or `overlyx sync`): the engine keeps its state in the git directory */
const syncedBefore = (dir: string) => { try { return fs.existsSync(path.join(gitDirOf(dir), 'overlyx-sync')); } catch { return true; } };

/** directories never searched for clones: dependencies, environments, build output */
const SKIP = new Set(['node_modules', '__pycache__', 'venv', 'env', 'site-packages', 'dist', 'build', '_build', 'target', 'out']);
const NEST_DEPTH = 3, NEST_DIRS = 2000, RESCAN_MS = 120_000;

/** The git clones below `root` (not `root` itself): directories with a .git (a directory, or a file
 *  for submodules and worktrees) at most NEST_DEPTH levels down, breadth first, at most NEST_DIRS
 *  directories read; hidden and SKIP directories and a clone's inside are not searched, symlinks are
 *  not followed. A directory that cannot be read is passed over. */
export async function nestedClones(root: string): Promise<string[]> {
  const found: string[] = [];
  let level = [root], budget = NEST_DIRS;
  for (let depth = 0; depth <= NEST_DEPTH && level.length; depth++) {
    const next: string[] = [];
    for (const dir of level) {
      if (budget-- <= 0) return found;
      let entries: fs.Dirent[];
      try { entries = await fs.promises.readdir(dir, { withFileTypes: true }); } catch { continue; }
      if (depth > 0 && entries.some(e => e.name === '.git')) { found.push(dir); continue; }
      if (depth < NEST_DEPTH) for (const e of entries) if (e.isDirectory() && !e.name.startsWith('.') && !SKIP.has(e.name)) next.push(path.join(dir, e.name));
    }
    level = next;
  }
  return found;
}

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
    if (!enabled() || paused(f.dir)) { text = `$(debug-pause) OverLyX${name}`; detail = f.unasked ? 'Not kept in step with the server yet — click to start.' : 'Sync paused — click to resume.'; }
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
      app: 'vscode',
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
    f.unasked = false;
    if (!syncedBefore(f.dir) && !context.workspaceState.get<boolean>(ASKED(f.dir)) && !context.workspaceState.get<boolean>(ANNOUNCED(f.dir))) {
      void context.workspaceState.update(ANNOUNCED(f.dir), true);
      const what = f.nested ? `${vscode.workspace.asRelativePath(f.dir, true)} (a clone in this window's folder)` : 'this folder';
      void vscode.window.showInformationMessage(`OverLyX keeps ${what} in step with ${f.target.project} on ${new URL(f.target.host).host}: files you save go there within seconds, and changes made there arrive here — no pull or push needed.`, 'Pause for this folder').then(a => { if (a) void setPaused(f, true); });
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

  /** clones being looked at (their remote read), so that two scans do not add one twice */
  const adding = new Set<string>();

  /** A clone found inside a workspace folder that was never synced: ask before its first sync (once per
   *  workspace; it stays paused until then, and on "Not Now" — its status bar item starts it later). */
  async function ask(f: FolderSync): Promise<void> {
    await context.workspaceState.update(ASKED(f.dir), true);
    await context.workspaceState.update(PAUSED(f.dir), true);
    f.unasked = true;
    render(f);
    const rel = vscode.workspace.asRelativePath(f.dir, true);
    const a = await vscode.window.showInformationMessage(
      `OverLyX: ${rel} is a clone of ${f.target.project} on ${hostName(f.target.host)}. Keep it in step with the server while this window is open? Files you save there reach the project within seconds and changes made there arrive here; the first sync merges what changed on both sides since the clone was last in step.`,
      'Keep in Step', 'Not Now');
    if (a === 'Keep in Step') await setPaused(f, false);
    else log(f.dir, `not kept in step (${a ? 'not now' : 'no answer'}) — the status bar item starts it`);
  }

  /** `dir` synced if its git remote is a project on a known server; false when it is not a clone of one.
   *  `found`: by the search of a workspace folder (not opened or cloned on purpose), so a first sync asks. */
  async function addClone(dir: string, nested: boolean, found = false): Promise<boolean> {
    if (syncs.has(dir)) return true;
    if (adding.has(dir) || [...syncs.keys()].some(d => inside(dir, d))) return false;
    adding.add(dir);
    try {
      const target = await syncTarget(dir);
      if (!target) return false;
      const servers = [...knownSyncHosts(), ...(config().get<string[]>('sync.servers') ?? []).map(h => h.replace(/\/$/, ''))];
      if (!servers.includes(target.host) || syncs.has(dir)) return false;
      const item = vscode.window.createStatusBarItem(`overlyx.sync:${dir}`, vscode.StatusBarAlignment.Left, 40);
      item.name = 'OverLyX Sync';
      item.command = { command: 'overlyx.syncMenu', title: 'OverLyX Sync', arguments: [dir] };
      const f: FolderSync = { dir, nested, unasked: false, target, engine: null, item, problem: null, signin: false, spin: null, connecting: null };
      syncs.set(dir, f);
      // a nested clone found before the folder it sits in (two scans racing) gives way to it
      for (const d of [...syncs.keys()]) if (inside(d, dir)) removeFolder(d);
      if (found && enabled() && !paused(dir) && !context.workspaceState.get<boolean>(ASKED(dir)) && !syncedBefore(dir)) { void ask(f); return true; }
      f.unasked = found && paused(dir) && !syncedBefore(dir);
      await connect(f);
      return true;
    } finally { adding.delete(dir); }
  }

  /** a workspace folder: the folder itself if it is a clone, else the clones inside it */
  async function addFolder(folder: vscode.WorkspaceFolder): Promise<void> {
    if (folder.uri.scheme !== 'file') return;
    const root = folder.uri.fsPath;
    if (await addClone(root, false)) return;
    for (const dir of await nestedClones(root)) await addClone(dir, true, true);
  }

  /** an opened file in a clone the scan did not reach (deeper than NEST_DEPTH): the nearest
   *  directory with a .git between the file and its workspace folder */
  const looked = new Set<string>();
  async function addCloneOf(uri: vscode.Uri): Promise<void> {
    if (uri.scheme !== 'file' || !enabled()) return;
    const root = vscode.workspace.getWorkspaceFolder(uri)?.uri.fsPath;
    if (!root || syncs.has(root)) return;
    const file = uri.fsPath;
    if ([...syncs.keys()].some(d => inside(file, d))) return;
    for (let dir = path.dirname(file); inside(dir, root); dir = path.dirname(dir)) {
      if (looked.has(dir)) return;
      looked.add(dir);
      if (fs.existsSync(path.join(dir, '.git'))) { await addClone(dir, true, true); return; }
    }
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
    // a folder of a git repository (the code's): the paper as its submodule, or as a clone it ignores
    const top = await enclosingRepo(parent);
    const repo = top && !(await syncTarget(top)) ? top : null;
    let how: 'clone' | 'submodule' | 'ignored' = 'clone';
    if (repo) {
      const name = path.basename(repo);
      const pickHow = await vscode.window.showQuickPick([
        { label: `$(repo) As a submodule of ${name}`, description: 'the repository records which version of the paper goes with its code', how: 'submodule' as const },
        { label: `$(eye-closed) As a clone ${name} ignores`, description: `its folder goes into ${name}'s .gitignore`, how: 'ignored' as const },
      ], { title: `${choice.p.name} into ${vscode.workspace.asRelativePath(parent, true)}, a folder of the git repository ${name}` });
      if (!pickHow) return;
      how = pickHow.how;
    }
    let dir: string;
    try {
      dir = await vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, title: `Cloning ${choice.p.name}…` },
        () => how === 'submodule' ? addProjectSubmodule(host, auth, choice.p.name, parent) : cloneProject(host, auth, choice.p.name, parent));
      if (how === 'ignored') await ignoreInRepo(repo!, dir);
    } catch (e) { void vscode.window.showErrorMessage(`OverLyX: cloning ${choice.p.name} failed — ${(e as Error).message}`); return; }
    await context.globalState.update('overlyx.clone.parent', parent);
    const uri = vscode.Uri.file(dir);
    const note = how === 'submodule' ? ` It is a submodule of ${path.basename(repo!)} now (staged: commit .gitmodules and ${path.relative(repo!, dir)} there to record it).`
      : how === 'ignored' ? ` ${path.basename(repo!)}'s .gitignore leaves it out.` : '';
    // cloned into this window's folders: in step from now on, no need to open it or add it
    if (vscode.workspace.getWorkspaceFolder(uri) && await addClone(dir, true)) {
      const open = await vscode.window.showInformationMessage(`OverLyX: cloned ${choice.p.name} into ${vscode.workspace.asRelativePath(uri, true)}.${note} It is in this window's folder, so it stays in step with the server while the window is open.`, 'Open in New Window');
      if (open) await vscode.commands.executeCommand('vscode.openFolder', uri, { forceNewWindow: true });
      return;
    }
    const open = await vscode.window.showInformationMessage(`OverLyX: cloned ${choice.p.name} into ${dir}.${note} While it is open in VS Code it stays in step with the server.`, 'Open', 'Open in New Window', 'Add to Workspace');
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

  let scanned = 0;
  function rescan(): void {
    scanned = Date.now();
    looked.clear();
    for (const folder of vscode.workspace.workspaceFolders ?? []) void addFolder(folder).catch(e => report(e, 'sync.folder'));
    for (const d of vscode.workspace.textDocuments) void addCloneOf(d.uri).catch(e => report(e, 'sync.folder'));
  }

  /** the synced clone a file belongs to (the innermost one: a nested clone is not its folder's) */
  const owner = (file: string): FolderSync | undefined => [...syncs.values()].filter(f => inside(file, f.dir)).sort((a, b) => b.dir.length - a.dir.length)[0];

  const pick = (dir?: string): FolderSync | undefined => {
    if (dir) return syncs.get(dir);
    const active = vscode.window.activeTextEditor?.document.uri;
    return (active?.scheme === 'file' ? owner(active.fsPath) : undefined) ?? [...syncs.values()][0];
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
    vscode.workspace.onDidSaveTextDocument(d => { if (d.uri.scheme === 'file') owner(d.uri.fsPath)?.engine?.poke?.(); }),
    vscode.window.onDidChangeWindowState(s => {
      if (!s.focused) return;
      for (const f of syncs.values()) { if (f.engine) f.engine.poke?.(); else if (!f.signin) void connect(f); }
      // a clone made meanwhile (git clone in a terminal) inside a workspace folder
      if (enabled() && Date.now() - scanned > RESCAN_MS) rescan();
    }),
    vscode.workspace.onDidOpenTextDocument(d => void addCloneOf(d.uri).catch(e => report(e, 'sync.folder'))),
    vscode.workspace.onDidChangeWorkspaceFolders(e => {
      for (const r of e.removed) for (const d of [...syncs.keys()]) if (d === r.uri.fsPath || inside(d, r.uri.fsPath)) removeFolder(d);
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
