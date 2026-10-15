import { readFileSync } from 'node:fs';
import { runInContext, createContext } from 'node:vm';
import * as ts from 'typescript';
import { describe, expect, it } from 'vitest';

const runtimeText = readFileSync(new URL('../packages/client/src/deliverable/runtime/edit.ts', import.meta.url), 'utf8');
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

const actualFunctions = (...names: string[]) => ts.transpileModule(names.map(actualFunctionSource).join('\n'), {
  compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.None },
}).outputText;

const reliability = (messages: unknown[]) => messages.filter(m => !!m && typeof m === 'object' && (m as { ol?: unknown }).ol === 'reliability');
const json = (value: unknown) => JSON.parse(JSON.stringify(value));

function runTouchUp(kind: string, ids = [10, 11]) {
  const messages: unknown[] = [];
  const context = createContext({
    drag: null,
    palms: new Set<number>(), touches: new Map(ids.map(id => [id, { x: id, y: id, sx: id, sy: id }])),
    pinch: { active: true }, pinch0: { active: true }, tri: { t0: 1, x0: 0, y0: 0, x: 1, y: 1 }, penOn: null,
    penOffAt: -1e9, performance: { now: () => 50 }, isSolo: () => true,
    post: (m: unknown) => messages.push(m), endTri: () => { messages.push({ ol: 'history', redo: false }); },
  });
  runInContext(actualFunctions('postGestureReliability', 'onTouchUp'), context);
  context.onTouchUp({ type: kind, pointerId: ids[0], pointerType: 'touch' });
  return { messages, context };
}

function runDragEnd(kind: string, pointerType = 'pen', pointerId = 7) {
  const messages: unknown[] = [];
  let dropped = 0, released = 0;
  const context = createContext({
    drag: { kind: 'pen', pointerId, pointerType, moved: true, els: [] },
    endingInterruptedDrag: false, guides: [], drawBox: null, state: { version: 1 },
    post: (m: unknown) => messages.push(m), postGestureReliability: (event: string, pointer: string) => messages.push({ ol: 'reliability', event, pointer }),
    release: () => { released++; }, dropInk: () => { dropped++; }, endInk: () => {}, draw: () => {},
  });
  runInContext(actualFunctions('onDragEnd'), context);
  context.onDragEnd({ type: kind, pointerId, pointerType, isTrusted: true });
  return { messages, context, dropped: () => dropped, released: () => released };
}

describe('canvas gesture reliability telemetry', () => {
  it('emits only fixed event/pointer fields and maps unknown pointer types to none', () => {
    const messages: unknown[] = [];
    const context = createContext({ post: (m: unknown) => messages.push(m) });
    runInContext(actualFunctions('postGestureReliability'), context);
    context.postGestureReliability('gesture.cancelled', 'object-path/private text');
    const events = reliability(messages);
    expect(json(events)).toEqual([{ ol: 'reliability', event: 'gesture.cancelled', pointer: 'none' }]);
    expect(Object.keys(events[0] as object).sort()).toEqual(['event', 'ol', 'pointer']);
  });

  it('reports a palm once per contact, and never includes a pointer id or content', () => {
    const messages: unknown[] = [];
    const context = createContext({ post: (m: unknown) => messages.push(m), palms: new Set<number>() });
    runInContext(actualFunctions('postGestureReliability', 'ignorePalmContact'), context);
    context.ignorePalmContact(31); context.ignorePalmContact(31); context.ignorePalmContact(32);
    const events = reliability(messages);
    expect(json(events)).toEqual([
      { ol: 'reliability', event: 'gesture.palm-ignored', pointer: 'touch' },
      { ol: 'reliability', event: 'gesture.palm-ignored', pointer: 'touch' },
    ]);
    for (const e of events) expect(Object.keys(e as object).sort()).toEqual(['event', 'ol', 'pointer']);
  });

  it('keeps normal touch lift unreported while a matching canceled touch interrupts and clears contacts', () => {
    const normal = runTouchUp('pointerup');
    expect(reliability(normal.messages)).toEqual([]);
    expect(normal.context.touches.size).toBe(1);

    const cancelled = runTouchUp('pointercancel');
    expect(json(reliability(cancelled.messages))).toEqual([{ ol: 'reliability', event: 'gesture.cancelled', pointer: 'touch' }]);
    expect(cancelled.context.touches.size).toBe(0);
    expect(cancelled.context.pinch).toBeNull();
    expect(cancelled.context.pinch0).toBeNull();
    expect(cancelled.context.tri).toBeNull();
    expect(cancelled.messages).toContainEqual({ ol: 'pinch', phase: 'cancel', pts: [] });
  });

  it('distinguishes lost capture from cancellation and ignores stale nonmatching pointers', () => {
    const lost = runTouchUp('lostpointercapture');
    expect(json(reliability(lost.messages))).toEqual([{ ol: 'reliability', event: 'gesture.capture-lost', pointer: 'touch' }]);
    const stale = runTouchUp('lostpointercapture', [10, 11]);
    stale.context.onTouchUp({ type: 'lostpointercapture', pointerId: 999, pointerType: 'touch' });
    expect(reliability(stale.messages)).toHaveLength(1); // only the first owned id was interrupted
  });

  it('preserves drag rollback on native cancel/capture loss and emits no event on normal up', () => {
    const normal = runDragEnd('pointerup');
    expect(reliability(normal.messages)).toEqual([]);
    expect(normal.dropped()).toBe(0);

    const cancelled = runDragEnd('pointercancel');
    expect(json(reliability(cancelled.messages))).toEqual([{ ol: 'reliability', event: 'gesture.cancelled', pointer: 'pen' }]);
    expect(cancelled.dropped()).toBe(1);
    expect(cancelled.context.drag).toBeNull();

    const lost = runDragEnd('lostpointercapture');
    expect(json(reliability(lost.messages))).toEqual([{ ol: 'reliability', event: 'gesture.capture-lost', pointer: 'pen' }]);
    expect(lost.dropped()).toBe(1);
  });

  it('reports one terminal event when the early touch handler and later drag capture see the same cancellation', () => {
    // These listeners run at window capture: the touch lifecycle handler is installed at
    // module init; the drag handler is installed later when this pointer begins its drag.
    const touchRegistration = runtimeText.indexOf("addEventListener('pointercancel', onTouchUp, true)");
    const dragRegistration = runtimeText.indexOf("addEventListener('pointercancel', onDragEnd, true)");
    expect(touchRegistration).toBeGreaterThanOrEqual(0);
    expect(dragRegistration).toBeGreaterThan(touchRegistration);

    const messages: unknown[] = [];
    const context = createContext({
      palms: new Set<number>(), touches: new Map([[41, { x: 1, y: 1, sx: 1, sy: 1 }]]),
      pinch: null, pinch0: null, tri: null, penOn: null, penOffAt: -1e9,
      drag: { kind: 'pen', pointerId: 41, pointerType: 'touch', moved: true, els: [] },
      endingInterruptedDrag: false, guides: [], drawBox: null, state: { version: 1 },
      performance: { now: () => 50 }, isSolo: () => true,
      post: (m: unknown) => messages.push(m), release: () => {}, dropInk: () => {}, draw: () => {},
    });
    runInContext(actualFunctions('postGestureReliability', 'onTouchUp', 'onDragEnd'), context);
    const cancelled = { type: 'pointercancel', pointerId: 41, pointerType: 'touch' };
    context.onTouchUp(cancelled);
    context.onDragEnd(cancelled);
    expect(json(reliability(messages))).toEqual([{ ol: 'reliability', event: 'gesture.cancelled', pointer: 'touch' }]);
    expect(context.touches.size).toBe(0);
    expect(context.drag).toBeNull();
  });

  it('ignores cancellation when the drag capture has no active owner', () => {
    const messages: unknown[] = [];
    let released = 0;
    const context = createContext({ drag: null, endingInterruptedDrag: false, post: (m: unknown) => messages.push(m), release: () => { released++; } });
    runInContext(actualFunctions('onDragEnd'), context);
    context.onDragEnd({ type: 'pointercancel', pointerId: 41, pointerType: 'touch' });
    expect(reliability(messages)).toEqual([]);
    expect(released).toBe(0);
  });

  it('labels programmatic tool/blur drag shutdown interrupted, not browser-canceled', () => {
    const messages: unknown[] = [];
    let dropped = 0;
    const context = createContext({
      drag: { kind: 'pen', pointerId: 9, pointerType: 'pen', moved: true, els: [] },
      endingInterruptedDrag: false, guides: [], drawBox: null, state: { version: 1 },
      PointerEvent: class { type: string; pointerId: number; constructor(type: string, init: { pointerId: number }) { this.type = type; this.pointerId = init.pointerId; } },
      post: (m: unknown) => messages.push(m), release: () => {}, dropInk: () => { dropped++; }, draw: () => {},
    });
    runInContext(actualFunctions('postGestureReliability', 'onDragEnd', 'cancelDrag'), context);
    context.cancelDrag();
    expect(json(reliability(messages))).toEqual([{ ol: 'reliability', event: 'gesture.interrupted', pointer: 'pen' }]);
    expect(dropped).toBe(1);
    expect(context.drag).toBeNull();
  });

  it('labels a live single-finger drag dropped by multitouch as interrupted and still cancels its pan', () => {
    const messages: unknown[] = [];
    const context = createContext({
      drag: { kind: 'pan', pointerId: 21, pointerType: 'touch', moved: true, els: [] },
      guides: [], drawBox: null,
      post: (m: unknown) => messages.push(m),
      postGestureReliability: (event: string, pointer: string) => messages.push({ ol: 'reliability', event, pointer }),
      dropInk: () => {}, revertLive: () => {}, release: () => {}, draw: () => {},
    });
    runInContext(actualFunctions('dropDrag'), context);
    context.dropDrag();
    expect(json(reliability(messages))).toEqual([{ ol: 'reliability', event: 'gesture.interrupted', pointer: 'touch' }]);
    expect(messages).toContainEqual({ ol: 'panEnd', cancel: true });
    expect(context.drag).toBeNull();
  });
});
