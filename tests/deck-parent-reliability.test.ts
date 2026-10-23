import { readFileSync } from 'node:fs';
import { runInContext, createContext } from 'node:vm';
import * as ts from 'typescript';
import { describe, expect, it } from 'vitest';

const source = readFileSync(new URL('../packages/client/src/deliverable/DeliverableEditor.tsx', import.meta.url), 'utf8');
const ast = ts.createSourceFile('DeliverableEditor.tsx', source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);

function actualArrow(name: string): ts.ArrowFunction {
  let found: ts.ArrowFunction | undefined;
  const visit = (node: ts.Node) => {
    if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.name.text === name && node.initializer && ts.isArrowFunction(node.initializer)) {
      found = node.initializer;
    }
    ts.forEachChild(node, visit);
  };
  visit(ast);
  if (!found) throw new Error(`Expected actual arrow function not found: ${name}`);
  return found;
}

function actualFunctions(...names: string[]): string {
  const declarations = names.map(name => `const ${name} = ${actualArrow(name).getText(ast)};`).join('\n');
  return ts.transpileModule(declarations, {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.None },
  }).outputText;
}

function harness(options: {
  ids?: number[];
  gesture?: { kind: string; x: number; y: number; x0: number; y0: number; t0: number; moving?: boolean } | null;
  penDown?: boolean;
} = {}) {
  const reliability: { event: string; detail: Record<string, unknown> }[] = [];
  const operations: { name: string; args: unknown[] }[] = [];
  const captured = new Set(options.ids ?? []);
  const context = createContext({
    canvasFingers: { current: new Map((options.ids ?? []).map((id, i) => [id, { x: 20 + i, y: 30 + i }])) },
    canvasIgnoredPalms: { current: new Set<number>() },
    canvasGesture: { current: options.gesture ?? null },
    canvasBox: { current: {
      getBoundingClientRect: () => ({ left: 10, top: 15, width: 500, height: 400 }),
      hasPointerCapture: (id: number) => captured.has(id),
      releasePointerCapture: (id: number) => { operations.push({ name: 'releasePointerCapture', args: [id] }); captured.delete(id); },
    } },
    penState: { current: { down: options.penDown ?? false, off: -1e9 } },
    soloRef: { current: {} },
    kindRef: { current: 'deck' },
    performance: { now: () => 1000 },
    recordReliability: (event: string, detail: Record<string, unknown>) => reliability.push({ event, detail }),
    slideView: {
      release: (...args: unknown[]) => operations.push({ name: 'release', args }),
      panBy: (...args: unknown[]) => operations.push({ name: 'panBy', args }),
    },
    pinchEnd: (...args: unknown[]) => operations.push({ name: 'pinchEnd', args }),
    pinchStart: (...args: unknown[]) => operations.push({ name: 'pinchStart', args }),
    pinchMove: (...args: unknown[]) => operations.push({ name: 'pinchMove', args }),
    fingerMid: () => ({ x: 20, y: 30 }),
    triGesture: () => null,
    historyGesture: (...args: unknown[]) => operations.push({ name: 'historyGesture', args }),
    // (the slide's part of the canvas: all of it here; a finger's tap while drawing toggles the bars)
    viewEl: { current: null },
    fingerTap: (...args: unknown[]) => operations.push({ name: 'fingerTap', args }),
  });
  runInContext(actualFunctions('cancelCanvasTouch', 'cancel', 'penOnCanvas', 'canvasTouch'), context);
  const handlers = runInContext('({ cancelCanvasTouch, cancel, penOnCanvas, canvasTouch })', context) as Record<string, (...args: any[]) => any>;
  context.cancelCanvasRef = { current: handlers.cancelCanvasTouch };
  return { context, handlers, reliability, operations, captured };
}

function pointer(type: string, id: number, overrides: Record<string, unknown> = {}) {
  const target = { setPointerCapture: (_id: number) => {} };
  return {
    type, pointerId: id, pointerType: 'touch', target, currentTarget: target,
    clientX: 30, clientY: 45, preventDefault: () => {}, ...overrides,
  };
}

describe('deliverable canvas parent gesture reliability', () => {
  it('reports an owned pointer cancellation exactly once and still clears/releases the gesture', () => {
    const h = harness({ ids: [12], gesture: { kind: 'pan', x: 4, y: 5, x0: 1, y0: 2, t0: 0, moving: true } });
    h.handlers.canvasTouch(pointer('pointercancel', 12));
    h.handlers.cancelCanvasTouch('gesture.cancelled');
    expect(h.reliability).toEqual([{ event: 'gesture.cancelled', detail: { pointer: 'touch', context: 'deck' } }]);
    expect(h.context.canvasFingers.current.size).toBe(0);
    expect(h.context.canvasGesture.current).toBeNull();
    expect(h.operations).toContainEqual({ name: 'release', args: [true] });
    expect(h.operations).toContainEqual({ name: 'releasePointerCapture', args: [12] });
  });

  it('ignores stale lost capture when no contact is owned', () => {
    const h = harness();
    h.handlers.canvasTouch(pointer('lostpointercapture', 99));
    h.handlers.cancelCanvasTouch('gesture.capture-lost');
    expect(h.reliability).toEqual([]);
    expect(h.context.canvasFingers.current.size).toBe(0);
    expect(h.context.canvasGesture.current).toBeNull();
  });

  it('keeps a normal pointerup unreported while committing and clearing the ordinary pan', () => {
    const h = harness({ ids: [21], gesture: { kind: 'pan', x: 4, y: 5, x0: 1, y0: 2, t0: 0, moving: true } });
    h.handlers.canvasTouch(pointer('pointerup', 21));
    expect(h.reliability).toEqual([]);
    expect(h.context.canvasFingers.current.size).toBe(0);
    expect(h.context.canvasGesture.current).toBeNull();
    expect(h.operations).toContainEqual({ name: 'release', args: [] });
  });

  it('reports a palm once per contact and drops the ignored contact on its ordinary up', () => {
    const h = harness({ penDown: true });
    h.handlers.canvasTouch(pointer('pointerdown', 33));
    h.handlers.canvasTouch(pointer('pointerdown', 33));
    expect(h.reliability).toEqual([{ event: 'gesture.palm-ignored', detail: { pointer: 'touch', context: 'deck' } }]);
    expect(h.context.canvasIgnoredPalms.current.has(33)).toBe(true);
    h.handlers.canvasTouch(pointer('pointerup', 33));
    expect(h.context.canvasIgnoredPalms.current.size).toBe(0);
    expect(h.context.canvasFingers.current.size).toBe(0);
    expect(h.reliability).toHaveLength(1);
  });

  it('uses the actual blur callback to interrupt an owned parent gesture once without losing cleanup', () => {
    const h = harness({ ids: [41, 42], gesture: { kind: 'pan', x: 4, y: 5, x0: 1, y0: 2, t0: 0, moving: true } });
    // The actual useEffect wires this callback to window blur, resize, visibility-hidden and cleanup.
    expect(source).toContain('const cancel = () => cancelCanvasRef.current();');
    expect(source).toContain("window.addEventListener('blur', cancel);");
    h.handlers.cancel();
    h.handlers.cancel();
    expect(h.reliability).toEqual([{ event: 'gesture.interrupted', detail: { pointer: 'touch', context: 'deck' } }]);
    expect(h.context.canvasFingers.current.size).toBe(0);
    expect(h.context.canvasGesture.current).toBeNull();
    expect(h.operations).toContainEqual({ name: 'release', args: [true] });
    expect(h.operations.filter(op => op.name === 'releasePointerCapture')).toHaveLength(2);
  });

  it('interrupts a live parent gesture when pen arrives but does not report the later normal touchup', () => {
    const h = harness({ ids: [51], gesture: { kind: 'pan', x: 4, y: 5, x0: 1, y0: 2, t0: 0, moving: true } });
    h.handlers.penOnCanvas(true);
    expect(h.reliability).toEqual([{ event: 'gesture.interrupted', detail: { pointer: 'touch', context: 'deck' } }]);
    expect(h.context.canvasGesture.current.kind).toBe('done');
    expect(h.operations).toContainEqual({ name: 'release', args: [true] });
    h.handlers.canvasTouch(pointer('pointerup', 51));
    expect(h.reliability).toHaveLength(1);
    expect(h.context.canvasFingers.current.size).toBe(0);
    expect(h.context.canvasGesture.current).toBeNull();
  });
});
