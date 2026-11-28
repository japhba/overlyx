import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const mock = vi.hoisted(() => ({
  folders: [] as any[], targets: new Map<string, any>(), engines: [] as any[], items: [] as any[],
  commands: new Map<string, (...args: any[]) => any>(),
  foldersChanged: (_e: any) => {}, saved: (_d: any) => {},
}));
vi.mock('vscode', () => ({
  Uri: { file: (fsPath: string) => ({ scheme: 'file', fsPath }) },
  StatusBarAlignment: { Left: 1 },
  MarkdownString: class { constructor(public value: string) {} },
  commands: {
    executeCommand: vi.fn(),
    registerCommand: (name: string, cb: (...args: any[]) => any) => { mock.commands.set(name, cb); return { dispose() {} }; },
  },
  window: {
    createOutputChannel: () => ({ appendLine() {}, dispose() {} }),
    createStatusBarItem: () => {
      const item = { text: '', tooltip: null, show() {}, dispose: vi.fn() };
      mock.items.push(item); return item;
    },
    showInformationMessage: vi.fn(async () => undefined),
    showWarningMessage: vi.fn(async () => undefined),
    setStatusBarMessage: vi.fn(),
    tabGroups: { activeTabGroup: {}, onDidChangeTabs: () => ({ dispose() {} }) },
    onDidChangeActiveTextEditor: () => ({ dispose() {} }),
    onDidChangeWindowState: () => ({ dispose() {} }),
  },
  workspace: {
    get workspaceFolders() { return mock.folders; },
    textDocuments: [],
    getConfiguration: () => ({ get: (key: string) => key === 'sync.enabled' ? true : [] }),
    getWorkspaceFolder: (uri: { fsPath: string }) => mock.folders.find(f => uri.fsPath === f.uri.fsPath || uri.fsPath.startsWith(f.uri.fsPath + path.sep)),
    asRelativePath: (dir: string) => dir,
    onDidSaveTextDocument: (cb: typeof mock.saved) => { mock.saved = cb; return { dispose() {} }; },
    onDidChangeWorkspaceFolders: (cb: typeof mock.foldersChanged) => { mock.foldersChanged = cb; return { dispose() {} }; },
    onDidOpenTextDocument: () => ({ dispose() {} }),
    onDidChangeConfiguration: () => ({ dispose() {} }),
  },
}));
vi.mock('../packages/cli/bin/overlyx.js', () => ({
  syncTarget: async (dir: string) => mock.targets.get(dir) ?? null,
  knownSyncHosts: () => ['https://overlyx.app'],
  describeChanges: () => [],
  syncEngineFor: vi.fn(async (_dir: string, o: any) => {
    const engine = {
      o, status: { state: 'idle', message: '', conflicts: [], waiting: [], notSent: [] },
      round: vi.fn(), inner: null as any,
      watch: vi.fn(() => new Promise<void>(() => {})), stop: vi.fn(), poke: vi.fn(),
    };
    engine.inner = engine.round;   // (setupSync wraps round: this is the engine's own)
    mock.engines.push(engine); return { engine };
  }),
}));
import * as vscode from 'vscode';
import { setupSync, STOP_NOTICE_MS } from '../packages/vscode/src/host/sync.ts';

/**
 * A synced folder out of step for a while (offline, an error, paused by git or another branch) is
 * said once in a notification, not only in the status bar (21 Nov 2026) — not when another window
 * syncs the clone (it is in step there), and again only after it was back in step.
 */
const memento = () => {
  const data = new Map<string, unknown>();
  return { get: (key: string) => data.get(key), keys: () => [...data.keys()], update: async (key: string, value: unknown) => { if (value === undefined) data.delete(key); else data.set(key, value); } };
};
let root: string;
const contexts: any[] = [];

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval', 'setTimeout', 'clearTimeout', 'Date'] });
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'overlyx-sync-stopped-'));
  mock.folders = []; mock.targets.clear(); mock.engines = []; mock.items = []; mock.commands.clear();
});
afterEach(() => {
  for (const ctx of contexts.splice(0)) for (const sub of ctx.subscriptions.splice(0)) sub.dispose();
  vi.useRealTimers();
  fs.rmSync(root, { recursive: true, force: true });
});

it('says once that a folder has been out of step for a while, not for another window syncing it, again only after it was back', async () => {
  const dir = path.join(root, 'paper');
  fs.mkdirSync(path.join(dir, '.git', 'overlyx-sync'), { recursive: true });
  mock.targets.set(dir, { host: 'https://overlyx.app', project: 'example/paper', remote: 'origin' });
  mock.folders = [{ uri: { scheme: 'file', fsPath: dir } }];
  const ctx = { globalState: memento(), workspaceState: memento(), subscriptions: [] };
  contexts.push(ctx);
  setupSync(ctx as never, e => { throw e; });
  await vi.waitFor(() => expect(mock.engines[0]?.watch).toHaveBeenCalledOnce());
  const e = mock.engines[0];
  const warn = vscode.window.showWarningMessage as unknown as ReturnType<typeof vi.fn>;
  const status = (patch: Record<string, unknown>) => { e.status = { ...e.status, ...patch }; e.o.onStatus(e.status); };

  status({ state: 'paused', cause: 'lock', message: 'synced by another process (another window)' });
  await vi.advanceTimersByTimeAsync(2 * STOP_NOTICE_MS);
  expect(warn).not.toHaveBeenCalled();

  status({ state: 'offline', cause: null, message: 'cannot reach https://overlyx.app: getaddrinfo ENOTFOUND' });
  await vi.advanceTimersByTimeAsync(STOP_NOTICE_MS - 120_000);
  expect(warn).not.toHaveBeenCalled();
  status({ state: 'syncing' });                     // a retry that fails again: the same spell
  status({ state: 'error', message: '502 Bad Gateway' });
  await vi.advanceTimersByTimeAsync(180_000);
  expect(warn).toHaveBeenCalledOnce();
  expect(String(warn.mock.calls[0][0])).toMatch(/example\/paper has not been in step with overlyx\.app since .* What you save stays on this computer/);
  await vi.advanceTimersByTimeAsync(3 * STOP_NOTICE_MS);
  expect(warn).toHaveBeenCalledOnce();

  status({ state: 'idle', message: '' });           // back in step: a quiet word in the status bar
  expect(vscode.window.setStatusBarMessage).toHaveBeenCalledWith(expect.stringMatching(/in step again/), expect.any(Number));
  status({ state: 'paused', cause: 'branch', message: 'on branch draft — the sync runs on main' });
  await vi.advanceTimersByTimeAsync(STOP_NOTICE_MS + 60_000);
  expect(warn).toHaveBeenCalledTimes(2);
});

/**
 * The usage statistics hear of the sync's changes of state and of the rounds that moved files — not
 * of every round: one runs each minute and after every change on either side, and "extension-sync
 * success" per round was 83,351 of a week's 100,797 events (28 Nov 2026).
 */
it('counts what the sync did and when it went out of step and came back, never one event per round', async () => {
  const dir = path.join(root, 'paper');
  fs.mkdirSync(path.join(dir, '.git', 'overlyx-sync'), { recursive: true });
  mock.targets.set(dir, { host: 'https://overlyx.app', project: 'example/paper', remote: 'origin' });
  mock.folders = [{ uri: { scheme: 'file', fsPath: dir } }];
  const ctx = { globalState: memento(), workspaceState: memento(), subscriptions: [] };
  contexts.push(ctx);
  const events: [string, number | undefined][] = [];
  setupSync(ctx as never, e => { throw e; }, (outcome, ms) => events.push([outcome, ms]));
  await vi.waitFor(() => expect(mock.engines[0]?.watch).toHaveBeenCalledOnce());
  const e = mock.engines[0];
  const status = (patch: Record<string, unknown>) => { e.status = { ...e.status, ...patch }; e.o.onStatus(e.status); };
  const quiet = { sent: [], received: [], conflicts: [], waiting: [], notSent: [], held: [], errors: [] };
  const round = async (c: Record<string, unknown> = {}) => { e.inner.mockResolvedValueOnce({ ...quiet, ...c }); status({ state: 'syncing' }); await e.round(); status({ state: 'idle', message: '' }); };

  for (let i = 0; i < 5; i++) await round();                    // in step, nothing to do: said once
  expect(events.map(x => x[0])).toEqual(['online']);
  await round({ sent: [{ path: 'main.tex', status: 'applied' }] });
  await round({ received: [{ path: 'refs.bib' }] });
  await round({ sent: [{ path: 'main.tex', status: 'conflict', conflicts: 1 }], conflicts: [{ path: 'main.tex', kind: 'tracked', count: 1 }] });
  expect(events.map(x => x[0])).toEqual(['online', 'changed', 'changed', 'conflict']);
  expect(typeof events[1][1]).toBe('number');

  events.length = 0;
  status({ state: 'paused', cause: 'lock', message: 'synced by another process' });   // in step, by another window: nothing to count
  status({ state: 'idle', message: '' });
  expect(events).toEqual([]);

  status({ state: 'offline', message: 'cannot reach https://overlyx.app' });
  for (let i = 0; i < 4; i++) {                                   // retries that fail: the same spell
    e.inner.mockRejectedValueOnce(new Error('cannot reach https://overlyx.app'));
    status({ state: 'syncing' });
    await e.round().catch(() => undefined);
    status({ state: i % 2 ? 'error' : 'offline', message: 'cannot reach https://overlyx.app' });
  }
  await vi.advanceTimersByTimeAsync(40_000);
  await round();
  expect(events.map(x => x[0])).toEqual(['offline', 'online']);
  expect(events[1][1]).toBeGreaterThanOrEqual(40_000);              // how long it was out of step

  events.length = 0;
  status({ state: 'signin', message: '401 Unauthorized' });         // the sign-in stopped working
  expect(events.map(x => x[0])).toEqual(['denied']);
});
