import { beforeEach, expect, it, vi } from 'vitest';
import { PdfEditorProvider } from '../packages/vscode/src/host/pdfEditor.ts';

const state = vi.hoisted(() => ({
  html: vi.fn(), copy: vi.fn(), save: vi.fn(), error: vi.fn(),
  changes: new Set<(uri: URL) => void>(), creates: new Set<(uri: URL) => void>(), deletes: new Set<(uri: URL) => void>(),
  themes: new Set<(theme: { kind: number }) => void>(), watcherDisposed: false,
}));
vi.mock('vscode', async () => {
  const path = await import('node:path');
  const event = (listeners: Set<any>) => (listener: any) => { listeners.add(listener); return { dispose: () => listeners.delete(listener) }; };
  return {
    Uri: { joinPath: (uri: URL, ...parts: string[]) => { const u = new URL(uri.toString()); u.pathname = path.posix.join(u.pathname, ...parts); return u; } },
    RelativePattern: class { constructor(public baseUri: URL, public pattern: string) {} },
    Disposable: class { constructor(public dispose: () => void) {} },
    ColorThemeKind: { Dark: 2, HighContrast: 3 },
    window: {
      activeColorTheme: { kind: 2 }, onDidChangeActiveColorTheme: event(state.themes),
      showSaveDialog: state.save, showErrorMessage: state.error, showInformationMessage: vi.fn(),
    },
    workspace: {
      fs: { copy: state.copy },
      createFileSystemWatcher: () => ({
        onDidChange: event(state.changes), onDidCreate: event(state.creates), onDidDelete: event(state.deletes),
        dispose: () => { state.watcherDisposed = true; },
      }),
    },
  };
});
vi.mock('../packages/vscode/src/host/webviewHtml.ts', () => ({ webviewHtml: state.html }));

beforeEach(() => {
  vi.clearAllMocks();
  for (const events of [state.changes, state.creates, state.deletes, state.themes]) events.clear();
  state.watcherDisposed = false;
  state.html.mockResolvedValue('<pdf viewer>');
  state.save.mockResolvedValue(undefined);
  state.copy.mockResolvedValue(undefined);
});

const remote = () => new URL('vscode-remote://ssh-remote+example/paper/plot%20%231.PDF');
const fixture = (base = async () => 'http://127.0.0.1:123/t/token') => {
  let message: (msg: any) => void = () => {};
  let close: () => void = () => {};
  const panel = {
    webview: {
      html: '', options: {}, postMessage: vi.fn(),
      asWebviewUri: (uri: URL) => new URL('https://remote.vscode-resource.test' + uri.pathname),
      onDidReceiveMessage: (listener: typeof message) => { message = listener; return { dispose: vi.fn() }; },
    },
    onDidDispose: (listener: typeof close) => { close = listener; },
  };
  const report = vi.fn();
  const provider = new PdfEditorProvider(new URL('file:///extension') as any, base, report);
  const document = provider.openCustomDocument(remote() as any);
  return { panel, document, report, provider, send: (msg: any) => message(msg), close: () => close(), open: () => provider.resolveCustomEditor(document, panel as any) };
};

it('opens a remote PDF as a read-only binary resource without creating a text document', async () => {
  const f = fixture();
  await f.open();
  const globals = state.html.mock.calls[0][3];
  expect(globals.pdfUrl).toBe('https://remote.vscode-resource.test/paper/plot%20%231.PDF?v=0');
  expect(globals.docId).toBe('');
  expect(globals.dark).toBe(true);
  expect((f.panel.webview.options as any).localResourceRoots.map(String)).toEqual(['file:///extension/dist', 'vscode-remote://ssh-remote+example/paper']);
  expect(f.panel.webview.html).toBe('<pdf viewer>');
  expect(f.document.uri).toEqual(remote());
  f.close();
});

it('refreshes only this PDF after changes or replacement and releases watchers on close', async () => {
  const f = fixture();
  await f.open();
  for (const change of state.changes) change(new URL('vscode-remote://ssh-remote+example/paper/other.pdf'));
  expect(f.panel.webview.postMessage).not.toHaveBeenCalled();
  for (const events of [state.changes, state.creates, state.deletes]) for (const change of events) change(remote());
  f.send({ type: 'ready' });
  f.send({ type: 'refreshPdf' });
  expect(f.panel.webview.postMessage.mock.calls.map(([msg]) => msg.url)).toEqual([1, 2, 3, 3, 4].map(v => `https://remote.vscode-resource.test/paper/plot%20%231.PDF?v=${v}`));
  for (const theme of state.themes) theme({ kind: 1 });
  expect(f.panel.webview.postMessage).toHaveBeenLastCalledWith({ type: 'theme', dark: false });
  f.close();
  expect(state.watcherDisposed).toBe(true);
  for (const events of [state.changes, state.creates, state.deletes, state.themes]) expect(events.size).toBe(0);
});

it('saves the original PDF bytes through the file service and handles cancellation', async () => {
  const f = fixture();
  await f.open();
  f.send({ type: 'savePdfCopy' });
  await vi.waitFor(() => expect(state.save).toHaveBeenCalledOnce());
  expect(state.copy).not.toHaveBeenCalled();
  const target = new URL('file:///exports/copy.pdf');
  state.save.mockResolvedValue(target);
  f.send({ type: 'savePdfCopy' });
  await vi.waitFor(() => expect(state.copy).toHaveBeenCalledWith(f.document.uri, target, { overwrite: true }));
  state.copy.mockRejectedValue(new Error('Permission denied'));
  f.send({ type: 'savePdfCopy' });
  await vi.waitFor(() => expect(f.report).toHaveBeenCalledWith(expect.any(Error), 'pdf.file'));
  f.close();
});

it('does not write HTML after the tab closes while its connection is opening', async () => {
  let connect!: (base: string) => void;
  const f = fixture(() => new Promise(resolve => { connect = resolve; }));
  const opening = f.open();
  f.close();
  connect('http://127.0.0.1:123/t/token');
  await opening;
  expect(state.html).not.toHaveBeenCalled();
  expect(state.watcherDisposed).toBe(true);
});
