import { readFileSync } from 'node:fs';
import { runInContext, createContext } from 'node:vm';
import { performance } from 'node:perf_hooks';
import * as ts from 'typescript';
import { describe, expect, it } from 'vitest';

const runtimePath = new URL('../packages/client/src/deliverable/runtime/edit.ts', import.meta.url);
const runtimeText = readFileSync(runtimePath, 'utf8');
const sourceFile = ts.createSourceFile('runtime-edit.ts', runtimeText, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);

function actualFunctionSource(name: string): string {
  let match: ts.FunctionDeclaration | undefined;
  const visit = (node: ts.Node) => {
    if (ts.isFunctionDeclaration(node) && node.name?.text === name) match = node;
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);
  if (!match) throw new Error(`Expected runtime function declaration not found: ${name}`);
  return runtimeText.slice(match.getStart(sourceFile), match.end);
}

const actualHandlers = ts.transpileModule(`${actualFunctionSource('endTri')}\n${actualFunctionSource('postGestureReliability')}\n${actualFunctionSource('onTouchUp')}`, {
  compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.None },
}).outputText;

type PointerLike = { type: string; pointerId: number; pointerType: string };
type State = {
  touches: Map<number, { x: number; y: number; sx: number; sy: number }>;
  palms: Set<number>;
  tri: { t0: number; x0: number; y0: number; x: number; y: number } | null;
  pinch: object | null;
  pinch0: object | null;
  penOn: number | null;
  penOffAt: number;
  messages: unknown[];
  telemetry: unknown[];
  handler: (event: PointerLike) => void;
  context: { tri: State['tri']; pinch: object | null; pinch0: object | null };
};

function makeState(touchIds: number[], options: { tri?: boolean; pinch?: boolean } = {}): State {
  const messages: unknown[] = [];
  const telemetry: unknown[] = [];
  const context = createContext({
    drag: null,
    touches: new Map(touchIds.map(id => [id, { x: id, y: id, sx: id, sy: id }])),
    palms: new Set<number>(),
    tri: options.tri ? { t0: 1, x0: 0, y0: 0, x: 20, y: 30 } : null,
    twoTap: null,
    pinch: options.pinch ? { active: true } : null,
    pinch0: options.pinch ? { active: true } : null,
    penOn: null as number | null,
    penOffAt: -1e9,
    post: (message: unknown) => {
      if (message && typeof message === 'object' && (message as { ol?: unknown }).ol === 'reliability') telemetry.push(message);
      else messages.push(message);
    },
    isSolo: () => true,
    triGesture: () => 'undo',
    performance,
  });
  runInContext(actualHandlers, context);
  return {
    touches: context.touches,
    palms: context.palms,
    tri: context.tri,
    pinch: context.pinch,
    pinch0: context.pinch0,
    penOn: context.penOn,
    penOffAt: context.penOffAt,
    messages,
    telemetry,
    handler: context.onTouchUp,
    context,
  };
}

const pointer = (type: string, pointerId: number): PointerLike => ({ type, pointerId, pointerType: 'touch' });

describe('runtime touch-up cancellation semantics (actual source handlers)', () => {
  it.each(['pointercancel', 'lostpointercapture'])('%s rolls an owned solo-canvas pinch back and clears all contacts', kind => {
    const state = makeState([10, 11], { pinch: true });
    state.handler(pointer(kind, 10));
    expect(state.messages).toContainEqual({ ol: 'pinch', phase: 'cancel', pts: [] });
    expect(state.touches.size).toBe(0);
    expect(state.context.pinch).toBeNull();
    expect(state.context.pinch0).toBeNull();
    expect(state.context.tri).toBeNull();
  });

  it('cancelling one owned contact in a three-finger gesture discards all contacts without history', () => {
    const state = makeState([10, 11, 12], { tri: true });
    state.handler(pointer('pointercancel', 10));
    expect(state.touches.size).toBe(0);
    expect(state.context.tri).toBeNull();
    expect(state.messages).not.toContainEqual(expect.objectContaining({ ol: 'history' }));
    expect(state.messages).not.toContainEqual(expect.objectContaining({ ol: 'pinch', phase: 'end' }));
  });

  it('cancelling every contact never turns an interrupted three-finger gesture into Undo', () => {
    const state = makeState([10, 11, 12], { tri: true });
    for (const id of [10, 11, 12]) state.handler(pointer('pointercancel', id));
    expect(state.messages).toEqual([]);
    expect(state.touches.size).toBe(0);
    expect(state.context.tri).toBeNull();
  });

  it('normal first pinch lift still commits the current view and retains the remaining contact', () => {
    const state = makeState([10, 11], { pinch: true });
    state.handler(pointer('pointerup', 10));
    expect(state.messages).toContainEqual({ ol: 'pinch', phase: 'end', pts: [] });
    expect([...state.touches.keys()]).toEqual([11]);
    expect(state.context.pinch).toBeNull();
    expect(state.context.pinch0).toBeNull();
  });

  it('two fingers tapped together undo; moved, they do not', () => {
    const tap = makeState([10, 11], { pinch: true });
    (tap.context as unknown as { twoTap: unknown }).twoTap = { t0: performance.now(), at: new Map(), moved: false };
    tap.handler(pointer('pointerup', 10));
    tap.handler(pointer('pointerup', 11));
    expect(tap.messages).toContainEqual({ ol: 'history', redo: false });
    const moved = makeState([10, 11], { pinch: true });
    (moved.context as unknown as { twoTap: unknown }).twoTap = { t0: performance.now(), at: new Map(), moved: true };
    moved.handler(pointer('pointerup', 10));
    moved.handler(pointer('pointerup', 11));
    expect(moved.messages).not.toContainEqual({ ol: 'history', redo: false });
  });

  it('normal three-finger final lift still completes the history gesture exactly once', () => {
    const state = makeState([10, 11, 12], { tri: true });
    state.handler(pointer('pointerup', 10));
    state.handler(pointer('pointerup', 11));
    expect(state.messages).toEqual([]);
    state.handler(pointer('pointerup', 12));
    expect(state.messages).toEqual([{ ol: 'history', redo: false }]);
    expect(state.touches.size).toBe(0);
    expect(state.context.tri).toBeNull();
  });

  it('a stale lost-capture after normal up does not interrupt a newer owned pinch', () => {
    const state = makeState([20, 21], { pinch: true });
    state.handler(pointer('lostpointercapture', 10));
    expect(state.messages).toEqual([]);
    expect([...state.touches.keys()]).toEqual([20, 21]);
    expect(state.context.pinch).toEqual({ active: true });
    expect(state.context.pinch0).toEqual({ active: true });
  });
});
