// @vitest-environment jsdom
import { readFileSync } from 'node:fs';
import { URL as FileURL } from 'node:url';
import { createContext, runInContext } from 'node:vm';
import * as ts from 'typescript';
import { describe, expect, it, vi } from 'vitest';

// Execute the actual production effect. Only native observer/frame scheduling
// and state setters are controlled; the measurement/lifecycle code is not copied.
const url = new FileURL('../packages/client/src/deliverable/DeliverableEditor.tsx', import.meta.url);
const source = readFileSync(url, 'utf8');
const ast = ts.createSourceFile(url.pathname, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
const effects: ts.CallExpression[] = [];
const visit = (node: ts.Node) => {
  if (ts.isCallExpression(node) && ts.isIdentifier(node.expression) && node.expression.text === 'useEffect'
      && node.arguments[0] && ts.isArrowFunction(node.arguments[0])) {
    const body = node.arguments[0].getText(ast);
    if (body.includes('new ResizeObserver') && body.includes('canvasBox.current') && body.includes('railBox.current')) effects.push(node);
  }
  ts.forEachChild(node, visit);
};
visit(ast);
if (effects.length !== 1) throw new Error('Expected one actual canvas/rail measurement effect');
const effect = effects[0];
const code = ts.transpileModule('(' + effect.arguments[0].getText(ast) + ')', {
  compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS },
}).outputText;

function element(size: { w: number; h: number }) {
  const el = document.createElement('div');
  Object.defineProperties(el, { clientWidth: { get: () => size.w }, clientHeight: { get: () => size.h } });
  return el;
}
function setup(initialBox = { w: 100, h: 100 }, withRail = true) {
  const canvasSize = { w: 800, h: 600 }, railSize = { w: 170, h: 500 };
  const canvasBox = { current: element(canvasSize) as HTMLElement | null };
  const railBox = { current: withRail ? element(railSize) as HTMLElement | null : null };
  let box = initialBox, nextFrame = 0;
  const frames = new Map<number, FrameRequestCallback>();
  const request = vi.fn((callback: FrameRequestCallback) => { const id = ++nextFrame; frames.set(id, callback); return id; });
  const cancel = vi.fn((id: number) => { frames.delete(id); });
  const setBox = vi.fn((update: (previous: typeof box) => typeof box) => { box = update(box); });
  const setRailH = vi.fn();
  const observers: { callback: () => void; observe: ReturnType<typeof vi.fn>; disconnect: ReturnType<typeof vi.fn> }[] = [];
  class NativeObserverBoundary {
    observe = vi.fn();
    disconnect = vi.fn();
    constructor(readonly callback: () => void) { observers.push(this); }
  }
  const context = createContext({ canvasBox, railBox, RAIL_HEAD: 28, setBox, setRailH,
    ResizeObserver: NativeObserverBoundary, requestAnimationFrame: request, cancelAnimationFrame: cancel });
  const cleanup = (runInContext(code, context) as () => () => void)();
  if (observers.length !== 1) throw new Error('Expected one actual observer subscription');
  const deliver = () => observers[0].callback();
  const flush = () => { const queued = [...frames.values()]; frames.clear(); for (const cb of queued) cb(0); };
  return { canvasSize, railSize, canvasBox, railBox, observers, cleanup, deliver, flush,
    frames, request, cancel, setBox, setRailH, box: () => box };
}

describe('canvas/rail ResizeObserver measurement scheduling', () => {
  it('defers state writes and coalesces repeated native deliveries into one frame', () => {
    const state = setup(); state.deliver(); state.deliver(); state.deliver();
    expect(state.setBox).not.toHaveBeenCalled(); expect(state.setRailH).not.toHaveBeenCalled();
    expect(state.request).toHaveBeenCalledTimes(1); expect(state.frames.size).toBe(1);
    state.flush();
    expect(state.setBox).toHaveBeenCalledTimes(1); expect(state.box()).toEqual({ w: 800, h: 600 });
    expect(state.setRailH).toHaveBeenCalledExactlyOnceWith(472);
    state.cleanup();
  });

  it('measures the latest refs and dimensions instead of retaining the first delivery values', () => {
    const state = setup(); state.deliver();
    state.canvasSize.w = 900;
    state.canvasBox.current = element({ w: 1050, h: 740 });
    state.railBox.current = element({ w: 170, h: 610 });
    state.flush();
    expect(state.box()).toEqual({ w: 1050, h: 740 });
    expect(state.setRailH).toHaveBeenCalledExactlyOnceWith(582);
    state.cleanup();
  });

  it('retains the existing box object when dimensions have not changed', () => {
    const original = { w: 800, h: 600 }, state = setup(original);
    state.deliver(); state.flush();
    expect(state.box()).toBe(original);
    state.cleanup();
  });

  it('cancels pending work on cleanup and rejects already-dequeued or stale observer callbacks', () => {
    const state = setup(); state.deliver();
    const queued = [...state.frames.entries()][0]; expect(queued).toBeDefined();
    state.cleanup();
    expect(state.observers[0].disconnect).toHaveBeenCalledTimes(1);
    expect(state.cancel).toHaveBeenCalledExactlyOnceWith(queued[0]); expect(state.frames.size).toBe(0);
    queued[1](0); state.deliver(); state.flush();
    expect(state.setBox).not.toHaveBeenCalled(); expect(state.setRailH).not.toHaveBeenCalled();
    expect(state.request).toHaveBeenCalledTimes(1);
  });

  it('allows a fresh measurement frame after the previous one completes', () => {
    const state = setup(); state.deliver(); state.flush();
    state.canvasSize.w = 957; state.canvasSize.h = 809; state.railSize.h = 809;
    state.deliver(); state.deliver();
    expect(state.request).toHaveBeenCalledTimes(2);
    state.flush();
    expect(state.box()).toEqual({ w: 957, h: 809 }); expect(state.setRailH).toHaveBeenLastCalledWith(781);
    state.cleanup();
  });

  it('observes mounted targets and handles absent or short rails', () => {
    const state = setup(undefined, false);
    expect(state.observers[0].observe).toHaveBeenCalledExactlyOnceWith(state.canvasBox.current);
    state.deliver(); state.flush(); expect(state.setRailH).not.toHaveBeenCalled();
    state.railBox.current = element({ w: 170, h: 10 }); state.deliver(); state.flush();
    expect(state.setRailH).toHaveBeenCalledExactlyOnceWith(0);
    state.cleanup();
  });
});
