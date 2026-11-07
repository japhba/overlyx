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
  syncEngineFor: vi.fn(async (_dir: string, o: any) => {
    const engine = {
      o, status: { state: 'idle', message: '', conflicts: [], waiting: [], notSent: [] },
      round: vi.fn(),
      watch: vi.fn(() => new Promise<void>(() => {})), stop: vi.fn(), poke: vi.fn(),
    };
    mock.engines.push(engine); return { engine };
  }),
}));
import { setupSync } from '../packages/vscode/src/host/sync.ts';

const memento = () => {
  const data = new Map<string, unknown>();
  return { get: (key: string) => data.get(key), keys: () => [...data.keys()], update: async (key: string, value: unknown) => { if (value === undefined) data.delete(key); else data.set(key, value); } };
};
let root: string, globalState: ReturnType<typeof memento>;
let contexts: any[];
const dispose = (ctx: any) => { for (const sub of ctx.subscriptions.splice(0)) sub.dispose(); };
const activate = () => {
  const ctx = { globalState, workspaceState: memento(), subscriptions: [] };
  contexts.push(ctx);
  setupSync(ctx as never, e => { throw e; });
  return ctx;
};
const clone = (rel: string, synced = true) => {
  const dir = path.join(root, rel);
  fs.mkdirSync(path.join(dir, '.git', ...(synced ? ['overlyx-sync'] : [])), { recursive: true });
  mock.targets.set(dir, { host: 'https://overlyx.app', project: 'example/paper', remote: 'origin' });
  return dir;
};
const folder = (dir: string) => ({ uri: { scheme: 'file', fsPath: dir } });
const started = async (count: number) => vi.waitFor(() => {
  expect(mock.engines).toHaveLength(count);
  expect(mock.engines[count - 1].watch).toHaveBeenCalledOnce();
});

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'overlyx-sync-lifecycle-'));
  globalState = memento(); contexts = [];
  mock.folders = []; mock.targets.clear(); mock.engines = []; mock.items = []; mock.commands.clear();
});
afterEach(() => {
  for (const ctx of contexts) dispose(ctx);
  fs.rmSync(root, { recursive: true, force: true });
});

it('keeps a nested clone syncing when its workspace folder is removed, including subsequent saves', async () => {
  const dir = clone('code/paper');
  const parent = folder(path.dirname(dir));
  mock.folders = [parent];
  activate();
  await started(1);
  mock.folders = [];
  mock.foldersChanged({ removed: [parent], added: [] });
  expect(mock.engines[0].stop).not.toHaveBeenCalled();
  mock.saved({ uri: { scheme: 'file', fsPath: path.join(dir, 'notes.md') } });
  expect(mock.engines[0].poke).toHaveBeenCalledOnce();
  expect(mock.items[0].tooltip.value).toContain('outside this workspace');
});

it('resumes remembered clones after the window restarts in another workspace, and preserves Pause', async () => {
  const dir = clone('paper');
  mock.folders = [folder(dir)];
  const first = activate();
  await started(1);
  dispose(first);
  expect(mock.engines[0].stop).toHaveBeenCalledOnce();

  mock.folders = [folder(path.join(root, 'other-workspace'))];
  const second = activate();
  await started(2);
  await mock.commands.get('overlyx.syncPause')!(dir);
  expect(mock.engines[1].stop).toHaveBeenCalledOnce();
  dispose(second);

  activate();
  await vi.waitFor(() => expect(mock.items).toHaveLength(3));
  expect(mock.items[2].text).toContain('debug-pause');
  expect(mock.engines).toHaveLength(2);
  await mock.commands.get('overlyx.syncResume')!(dir);
  await started(3);
});

it('does not restore a different project placed at a remembered path', async () => {
  const dir = clone('paper');
  mock.folders = [folder(dir)];
  const first = activate();
  await started(1);
  dispose(first);
  mock.folders = [];
  mock.targets.get(dir).project = 'example/different-project';
  activate();
  // Drain the asynchronous restore and scan without waiting for any real engine or server.
  await new Promise(resolve => setImmediate(resolve));
  expect(mock.engines).toHaveLength(1);
  expect(mock.items).toHaveLength(1);
});

it('leaves a never-accepted nested clone behind when its workspace is removed', async () => {
  const dir = clone('code/paper', false), parent = folder(path.dirname(dir));
  mock.folders = [parent];
  activate();
  await vi.waitFor(() => expect(mock.items[0]?.text).toContain('debug-pause'));
  mock.folders = [];
  mock.foldersChanged({ removed: [parent], added: [] });
  expect(mock.items[0].dispose).toHaveBeenCalledOnce();
  expect(globalState.keys()).toHaveLength(0);
  expect(mock.engines).toHaveLength(0);
});
