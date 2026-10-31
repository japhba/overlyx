// @vitest-environment jsdom
import { readFileSync } from 'node:fs';
import { URL as FileURL } from 'node:url';
import { createContext, runInContext } from 'node:vm';
import * as ts from 'typescript';
import { afterEach, describe, expect, it, vi } from 'vitest';

function source(url: FileURL) {
  const text = readFileSync(url, 'utf8');
  return { text, ast: ts.createSourceFile(url.pathname, text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS) };
}
const editingSource = source(new FileURL('../packages/client/src/deliverable/runtime/edit.ts', import.meta.url));
const messageSource = source(new FileURL('../packages/client/src/deliverable/runtime/index.ts', import.meta.url));
const mathSource = source(new FileURL('../packages/client/src/deliverable/runtime/mathedit.ts', import.meta.url));
const cropSource = source(new FileURL('../packages/client/src/deliverable/runtime/crop.ts', import.meta.url));
const nodeSource = source(new FileURL('../packages/client/src/deliverable/runtime/pathedit.ts', import.meta.url));

function functionSource(file: ReturnType<typeof source>, name: string, optional = false): string {
  let found: ts.FunctionDeclaration | undefined;
  const visit = (node: ts.Node) => {
    if (ts.isFunctionDeclaration(node) && node.name?.text === name) found = node;
    ts.forEachChild(node, visit);
  };
  visit(file.ast);
  if (!found) {
    if (optional) return '';
    throw new Error('Missing runtime function: ' + name);
  }
  return file.text.slice(found.getStart(file.ast), found.end);
}

function variableSource(file: ReturnType<typeof source>, name: string, owner?: string): string {
  let scope: ts.Node = file.ast;
  if (owner) {
    const visit = (node: ts.Node) => {
      if (ts.isFunctionDeclaration(node) && node.name?.text === owner) scope = node;
      ts.forEachChild(node, visit);
    };
    visit(file.ast);
    if (scope === file.ast) throw new Error('Missing variable owner: ' + owner);
  }
  let found: ts.VariableDeclaration | undefined;
  const visit = (node: ts.Node) => {
    if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.name.text === name) found = node;
    ts.forEachChild(node, visit);
  };
  visit(scope);
  if (!found) throw new Error('Missing runtime variable: ' + name);
  return 'const ' + file.text.slice(found.getStart(file.ast), found.end) + ';';
}

const compile = (text: string) => ts.transpileModule(text, {
  compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS },
}).outputText;
const generalHandlers = compile([
  functionSource(editingSource, 'onKeyDown'),
  functionSource(editingSource, 'selectParent'),
  // The old message dispatcher does not call this new entry point. Keeping it
  // optional lets the same behavioral tests show the old routing failures.
  functionSource(editingSource, 'escapeCanvas', true),
  variableSource(mathSource, 'keyPress'),
  variableSource(mathSource, 'isModifierKey'),
].join('\n'));
const messageHandler = compile(functionSource(messageSource, 'onMessage'));
const disposers: (() => void)[] = [];

afterEach(() => {
  for (const dispose of disposers.splice(0).reverse()) dispose();
  document.body.replaceChildren();
  vi.restoreAllMocks();
});

function runtime(options: { editing?: boolean; math?: 'opening' | 'closing'; owner?: 'crop' | 'nodes'; mode?: string } = {}) {
  const group = document.createElement('div');
  const text = document.createElement('div');
  text.tabIndex = 0;
  text.textContent = 'Known citation';
  if (options.editing) text.contentEditable = 'true';
  group.append(text);
  document.body.append(group);
  text.focus();
  const events: KeyboardEvent[] = [];
  const pendingMath = vi.fn();
  const closingMath = vi.fn();
  const stopped = vi.fn();
  const context = createContext({
    exports: {}, window, document, KeyboardEvent, HTMLElement, Node,
    MODE: options.mode ?? 'edit',
    editing: options.editing ? text : null,
    selected: [text],
    srcOf: new WeakMap([[group, group.cloneNode(false)]]),
    drawAhead: null, drawComposing: false, tool: 'select', svgTyping: null, themeView: false,
    isCropping: () => options.owner === 'crop',
    isNodeEditing: () => options.owner === 'nodes',
    isPenDrawing: () => false, isOrdering: () => false,
    chipOpening: () => options.math === 'opening',
    openChipEl: () => options.math === 'closing' ? text : null,
    holdKey: pendingMath, holdAfter: closingMath,
    recoverChipCaret: vi.fn(() => false),
    stopText: () => { stopped(); context.editing = null; },
    report: vi.fn(), draw: vi.fn(),
  });
  runInContext(generalHandlers, context);
  context.edit = {
    escapeCanvas: context.escapeCanvas,
    selectParent: context.selectParent,
  };
  runInContext(messageHandler, context);
  const key = context.onKeyDown as EventListener;
  const observe = (event: Event) => events.push(event as KeyboardEvent);
  window.addEventListener('keydown', key, true);
  window.addEventListener('keydown', observe, true);
  disposers.push(() => {
    window.removeEventListener('keydown', key, true);
    window.removeEventListener('keydown', observe, true);
  });
  const forward = (shift = false) => context.onMessage({
    source: window.parent, data: { ol: 'canvasKey', key: 'Escape', shift },
  });
  return { context, group, text, events, pendingMath, closingMath, stopped, forward };
}

describe('host-forwarded canvas Escape uses the native focused context', () => {
  it('ends plain text editing exactly once through its native window handler', () => {
    const state = runtime({ editing: true });
    state.forward();
    expect(state.stopped).toHaveBeenCalledOnce();
    expect(state.context.editing).toBeNull();
    expect(state.events).toHaveLength(1);
    expect(state.events[0].target).toBe(state.text);
    expect(state.events[0].defaultPrevented).toBe(true);
  });

  it('selects the existing group while idle and carries the forwarded modifier', () => {
    const state = runtime();
    state.forward(true);
    expect(state.context.selected).toEqual([state.group]);
    expect(state.stopped).not.toHaveBeenCalled();
    expect(state.events).toHaveLength(1);
    expect(state.events[0].shiftKey).toBe(true);
    expect(state.events[0].code).toBe('Escape');
    expect(state.events[0].defaultPrevented).toBe(true);
  });

  it('queues Escape in an opening math field without closing its text', () => {
    const state = runtime({ editing: true, math: 'opening' });
    state.forward();
    expect(state.pendingMath).toHaveBeenCalledWith({ key: 'Escape', shift: undefined, ctrl: undefined, alt: undefined, meta: undefined });
    expect(state.pendingMath).toHaveBeenCalledOnce();
    expect(state.closingMath).not.toHaveBeenCalled();
    expect(state.stopped).not.toHaveBeenCalled();
    expect(state.context.editing).toBe(state.text);
  });

  it('keeps Escape behind a closing math field until its caret handoff', () => {
    const state = runtime({ editing: true, math: 'closing' });
    state.forward();
    expect(state.closingMath).toHaveBeenCalledWith({ key: 'Escape', shift: undefined, ctrl: undefined, alt: undefined, meta: undefined });
    expect(state.closingMath).toHaveBeenCalledOnce();
    expect(state.pendingMath).not.toHaveBeenCalled();
    expect(state.stopped).not.toHaveBeenCalled();
    expect(state.context.editing).toBe(state.text);
  });

  it('preserves the actual focused input target and leaves canvas selection alone', () => {
    const state = runtime();
    const input = document.createElement('input');
    document.body.append(input);
    input.focus();
    state.forward();
    expect(state.context.selected).toEqual([state.text]);
    expect(state.events).toHaveLength(1);
    expect(state.events[0].target).toBe(input);
    expect(state.events[0].defaultPrevented).toBe(false);
    expect(document.activeElement).toBe(input);
  });

  it('reaches the independently installed crop and path-node Escape handlers', () => {
    for (const owner of ['crop', 'nodes'] as const) {
      const state = runtime({ owner });
      const completed = vi.fn();
      state.context.active = owner === 'crop' ? {} : null;
      state.context.ed = owner === 'nodes' ? {} : null;
      state.context.endCrop = completed;
      state.context.endNodes = completed;
      const actual = owner === 'crop'
        ? compile(variableSource(cropSource, 'key', 'startCrop'))
        : compile(functionSource(nodeSource, 'onKey'));
      runInContext(actual, state.context);
      const handler = (owner === 'crop' ? runInContext('key', state.context) : state.context.onKey) as EventListener;
      window.addEventListener('keydown', handler, true);
      const remove = () => window.removeEventListener('keydown', handler, true);
      disposers.push(remove);
      state.forward();
      expect(completed).toHaveBeenCalledOnce();
      if (owner === 'crop') expect(completed).toHaveBeenCalledWith(false);
      expect(state.context.selected).toEqual([state.text]);
      expect(state.stopped).not.toHaveBeenCalled();
      expect(state.events[0].defaultPrevented).toBe(true);
      remove();
      // Close this runtime before installing the next independent owner.
      for (const dispose of disposers.splice(0).reverse()) dispose();
    }
  });

  it('does not dispatch a canvas editing key in view, thumbnail or presenter mode', () => {
    for (const mode of ['view', 'thumb', 'present']) {
      const state = runtime({ editing: true, mode });
      state.forward();
      expect(state.events).toEqual([]);
      expect(state.stopped).not.toHaveBeenCalled();
      expect(state.context.editing).toBe(state.text);
      for (const dispose of disposers.splice(0).reverse()) dispose();
    }
  });
});
