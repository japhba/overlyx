// @vitest-environment jsdom
import { readFileSync } from 'node:fs';
import { URL as FileURL } from 'node:url';
import { createContext, runInContext } from 'node:vm';
import * as ts from 'typescript';
import { h, render } from 'preact';
import { useEffect, useLayoutEffect, useRef, useState } from 'preact/hooks';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// Execute the production hook and ready transition with Preact's own scheduler.
// The fixture supplies iframe load and ready events; it does not reimplement the watchdog.
const text = readFileSync(new FileURL('../packages/client/src/deliverable/DeliverableEditor.tsx', import.meta.url), 'utf8');
const ast = ts.createSourceFile('DeliverableEditor.tsx', text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
let watchdog: ts.CallExpression | undefined;
let ready: ts.Block | undefined;
const visit = (node: ts.Node) => {
  if (ts.isCallExpression(node) && ts.isIdentifier(node.expression)
    && ['useEffect', 'useLayoutEffect'].includes(node.expression.text)
    && node.arguments[0] && ts.isArrowFunction(node.arguments[0])
    && node.arguments[0].body.getText(ast).includes('canvasOpeningAt.current = Date.now()')) watchdog = node;
  if (ts.isCaseClause(node) && ts.isStringLiteral(node.expression) && node.expression.text === 'ready') {
    const branch = node.statements[0];
    if (ts.isIfStatement(branch) && ts.isBlock(branch.thenStatement)) ready = branch.thenStatement;
  }
  ts.forEachChild(node, visit);
};
visit(ast);
if (!watchdog || !ready) throw new Error('Missing production canvas opening hook or ready handler');
const readyEnd = ready.statements.findIndex(s => ts.isExpressionStatement(s) && ts.isCallExpression(s.expression)
  && ts.isIdentifier(s.expression.expression) && s.expression.expression.text === 'setCanvasState');
if (readyEnd < 0) throw new Error('Missing production ready state transition');
const compile = (code: string) => ts.transpileModule(code, {
  compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS },
}).outputText;
const watchdogCode = compile(watchdog.getText(ast) + ';');
const readyCode = compile('function receiveReady(m: { kind: string }) {\n'
  + ready.statements.slice(0, readyEnd + 1).map(s => s.getText(ast)).join('\n') + '\n}');

type Frame = { linked: boolean; synced?: boolean; base?: string; revision?: number };
type State = {
  status: string; canvasReady: { current: boolean }; canvasOpeningAt: { current: number };
  canvasHadFailure: { current: boolean }; receiveReady: (m: { kind: string }) => void;
};
let root: HTMLDivElement;
const disposers: (() => void)[] = [];
beforeEach(() => {
  vi.useFakeTimers();
  root = document.createElement('div'); document.body.append(root);
});
afterEach(() => {
  render(null, root);
  for (const dispose of disposers.splice(0)) dispose();
  root.remove();
  vi.clearAllTimers(); vi.useRealTimers(); vi.restoreAllMocks();
});

function canvas() {
  const host = {};
  const frameElement = document.createElement('iframe');
  const canvasFrame = { current: frameElement };
  const reliability = vi.fn();
  let current!: State;
  function Harness(frame: Frame) {
    const [status, setCanvasState] = useState('opening');
    const canvasReady = useRef(false), canvasOpeningAt = useRef(Date.now()), canvasHadFailure = useRef(false);
    const scope = createContext({
      useEffect, useLayoutEffect, host, link: frame.linked ? {} : null, synced: frame.synced ?? true,
      frameLink: frame.linked ? { base: frame.base ?? 'first-frame' } : null,
      offlineRevisions: { edit: frame.revision ?? 0 },
      canvasReady, canvasOpeningAt, canvasHadFailure, canvasFrame, kindRef: { current: 'deck' },
      recordReliability: reliability, setCanvasState, Date, setTimeout, clearTimeout,
    });
    runInContext(watchdogCode, scope);
    runInContext(readyCode, scope);
    current = { status, canvasReady, canvasOpeningAt, canvasHadFailure, receiveReady: scope.receiveReady };
    return h('div', { 'data-canvas-state': status });
  }
  // In the app the listener is installed before async link resolution creates
  // the iframe. This fixture starts without a frame, then commits that frame.
  const listener = (event: MessageEvent) => {
    if (event.data?.ol === 'ready') current.receiveReady(event.data);
  };
  window.addEventListener('message', listener);
  disposers.push(() => window.removeEventListener('message', listener));
  const show = (frame: Frame) => render(h(Harness, frame), root);
  const sendReady = () => window.dispatchEvent(new MessageEvent('message', { data: { ol: 'ready', kind: 'deck' } }));
  const sendLoad = () => frameElement.dispatchEvent(new Event('load'));
  return { show, sendReady, sendLoad, reliability, state: () => current };
}

describe('canvas opening owns the iframe ready transition', () => {
  it('keeps a fast ready sent after frame commit but before deferred effects', async () => {
    const app = canvas();
    app.show({ linked: false });
    await vi.advanceTimersByTimeAsync(100);
    app.show({ linked: true });
    app.sendReady();
    app.sendLoad();
    await vi.advanceTimersByTimeAsync(100);
    expect(app.state().canvasReady.current).toBe(true);
    expect(app.state().status).toBe('ready');
    expect(root.querySelector('[data-canvas-state="ready"]')).not.toBeNull();
    await vi.advanceTimersByTimeAsync(20_000);
    expect(app.reliability.mock.calls.map(c => c[0])).toEqual(['canvas.ready']);
  });

  it('keeps a slow download waiting and accepts ready after more than twenty seconds', async () => {
    const app = canvas();
    app.show({ linked: true });
    await vi.advanceTimersByTimeAsync(30_000);
    expect(app.state().status).toBe('slow');
    expect(app.state().canvasHadFailure.current).toBe(false);
    expect(app.reliability).not.toHaveBeenCalled();
    app.sendReady();
    app.sendLoad();
    await vi.advanceTimersByTimeAsync(21_000);
    expect(app.state().status).toBe('ready');
    expect(app.reliability).toHaveBeenCalledExactlyOnceWith('canvas.ready', { context: 'deck', durationMs: 30_000 });
  });

  it('gives a slow download twenty seconds after load before reporting a missing ready', async () => {
    const app = canvas();
    app.show({ linked: true });
    await vi.advanceTimersByTimeAsync(30_000);
    app.sendLoad();
    await vi.advanceTimersByTimeAsync(19_999);
    expect(app.state().status).toBe('slow');
    expect(app.reliability).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(app.state().status).toBe('failed');
    expect(app.state().canvasHadFailure.current).toBe(true);
    expect(app.reliability).toHaveBeenCalledExactlyOnceWith('canvas.timeout', { context: 'deck', durationMs: 50_000 });
  });

  it('does not time an absent or unsynchronized frame', async () => {
    const app = canvas();
    app.show({ linked: false });
    await vi.advanceTimersByTimeAsync(21_000);
    app.show({ linked: true, synced: false });
    await vi.advanceTimersByTimeAsync(21_000);
    expect(app.reliability).not.toHaveBeenCalled();
    app.show({ linked: true, synced: true });
    await vi.advanceTimersByTimeAsync(100);
    app.sendReady();
    await vi.advanceTimersByTimeAsync(21_000);
    expect(app.state().status).toBe('ready');
    expect(app.reliability.mock.calls.map(c => c[0])).toEqual(['canvas.ready']);
  });

  it('cancels the previous frame deadline when a new frame owns opening', async () => {
    const app = canvas();
    app.show({ linked: true, revision: 1 });
    app.sendLoad();
    await vi.advanceTimersByTimeAsync(10_000);
    app.show({ linked: true, revision: 2 });
    await vi.advanceTimersByTimeAsync(10_001);
    expect(app.state().status).toBe('opening');
    expect(app.reliability).not.toHaveBeenCalled();
    app.sendLoad();
    app.sendReady();
    await vi.advanceTimersByTimeAsync(21_000);
    expect(app.state().status).toBe('ready');
    expect(app.reliability.mock.calls.map(c => c[0])).toEqual(['canvas.ready']);
  });

  it('cleans up its deadline when the editor is unmounted', async () => {
    const app = canvas();
    app.show({ linked: true });
    app.sendLoad();
    await vi.advanceTimersByTimeAsync(100);
    render(null, root);
    app.sendLoad();
    await vi.advanceTimersByTimeAsync(21_000);
    expect(app.reliability).not.toHaveBeenCalled();
  });

  it('retains late-ready recovery telemetry after a real timeout', async () => {
    const app = canvas();
    app.show({ linked: true });
    app.sendLoad();
    await vi.advanceTimersByTimeAsync(20_100);
    expect(app.state().status).toBe('failed');
    app.sendReady();
    await vi.advanceTimersByTimeAsync(100);
    expect(app.state().status).toBe('ready');
    expect(app.state().canvasHadFailure.current).toBe(false);
    expect(app.reliability.mock.calls.map(c => c[0])).toEqual(['canvas.timeout', 'canvas.recovered']);
  });
});
