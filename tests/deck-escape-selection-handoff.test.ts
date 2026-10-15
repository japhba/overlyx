// @vitest-environment jsdom
// These are controlled routing tests, not formula paint or physical-device proof.
import { readFileSync } from 'node:fs';
import { URL as FileURL } from 'node:url';
import { createContext, runInContext } from 'node:vm';
import * as ts from 'typescript';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Path, ToRuntime } from '../packages/client/src/deliverable/protocol';

function source(name: string, kind = ts.ScriptKind.TS) {
  const file = new FileURL('../packages/client/src/deliverable/' + name, import.meta.url);
  const text = readFileSync(file, 'utf8');
  return { text, ast: ts.createSourceFile(file.pathname, text, ts.ScriptTarget.Latest, true, kind) };
}
function declaration(file: ReturnType<typeof source>, name: string, variable = false) {
  const matches: ts.Node[] = [];
  const visit = (node: ts.Node) => {
    if (variable ? ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.name.text === name
      : ts.isFunctionDeclaration(node) && node.name?.text === name) matches.push(node);
    ts.forEachChild(node, visit);
  };
  visit(file.ast);
  if (matches.length !== 1) throw new Error('Expected one actual declaration: ' + name);
  const text = file.text.slice(matches[0].getStart(file.ast), matches[0].end);
  return variable ? 'const ' + text + ';' : text;
}
const compile = (text: string) => ts.transpileModule(text, {
  compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS },
}).outputText;
const parentSource = source('DeliverableEditor.tsx', ts.ScriptKind.TSX);
const editSource = source('runtime/edit.ts'), envSource = source('runtime/env.ts');
const protocolSource = source('protocol.ts'), runtimeSource = source('runtime/index.ts');
const cropSource = source('runtime/crop.ts'), nodeSource = source('runtime/pathedit.ts');
const parentCode = compile([
  declaration(protocolSource, 'isFromRuntime', true), declaration(parentSource, 'sameSolo'),
  ...['holdForText', 'onKey', 'onMessage'].map(name => declaration(parentSource, name, true)),
].join('\n'));
const runtimeCode = compile([
  declaration(envSource, 'liveAt'),
  ...['selectPaths', 'selectParent', 'onKeyDown', 'escapeCanvas'].map(name => declaration(editSource, name)),
  declaration(runtimeSource, 'onMessage'),
  // Rename only the declaration to keep three actual key owners in one context.
  declaration(cropSource, 'key', true).replace('const key =', 'const cropKey ='),
  declaration(nodeSource, 'onKey').replace('function onKey(', 'function onNodesKey('),
].join('\n'));

type Pending = { select?: Path[]; editText?: Path; math?: boolean };
const IMAGE_PATH: Path = [1, 0, 1];
const TEXT_PATH: Path = [1, 0, 0];
const disposers: (() => void)[] = [];
afterEach(() => { for (const dispose of disposers.splice(0).reverse()) dispose(); vi.restoreAllMocks(); });

function setup() {
  const root = document.createElement('div'); root.className = 'dl-editor';
  const button = document.createElement('button'); button.textContent = 'Picture';
  const box = document.createElement('div'), frame = document.createElement('iframe');
  box.append(frame); root.append(button, box); document.body.append(root);
  const win = frame.contentWindow! as Window & typeof globalThis, doc = frame.contentDocument!;
  doc.body.innerHTML = '<section class="slide"><h1>Illustrative deck</h1><img src="public-test.png"></section>';
  const image = doc.querySelector('img')!, slide = doc.querySelector('.slide')!;
  const src = doc.implementation.createHTMLDocument('Illustrative source'); src.body.innerHTML = doc.body.innerHTML;
  const srcOf = new WeakMap<Element, Element>([[image, src.querySelector('img')!], [slide, src.querySelector('.slide')!]]);
  const liveOf = new WeakMap<Element, Element>([[src.querySelector('img')!, image], [src.querySelector('.slide')!, slide]]);
  const commands: ToRuntime[] = [], pending = { current: null as Pending | null };
  const selRef = { current: [{ path: IMAGE_PATH, kind: 'image' }] as unknown[] }, setToolState = vi.fn(), stopText = vi.fn(), holdKey = vi.fn(), holdAfter = vi.fn();
  const editTextAt = vi.fn(), nodeCommand = vi.fn();
  let runtime: ReturnType<typeof createContext>;
  const endCrop = vi.fn(() => { runtime.active = null; });
  const endNodes = vi.fn(() => { runtime.ed = null; });
  runtime = createContext({
    exports: {}, window: win, document: doc, KeyboardEvent: win.KeyboardEvent, Node: win.Node, MODE: 'edit',
    state: { src, kind: 'deck', version: 7 }, srcOf, liveOf, selected: [image], editing: null,
    drawAhead: null, drawComposing: false, tool: 'select', active: null, ed: null,
    isCropping: () => !!runtime.active, isNodeEditing: () => !!runtime.ed,
    isPenDrawing: () => false, isOrdering: () => false, chipOpening: () => false, openChipEl: () => null,
    isModifierKey: () => false, recoverChipCaret: vi.fn(), stopText, holdKey, holdAfter,
    revealSlideOf: () => false, report: vi.fn(), draw: vi.fn(), editTextAt, nodeCommand, endCrop, endNodes,
  });
  runInContext(runtimeCode, runtime);
  runtime.edit = { escapeCanvas: runtime.escapeCanvas, selectPaths: runtime.selectPaths, editTextAt };
  win.addEventListener('keydown', runtime.onKeyDown, true);
  win.addEventListener('keydown', runInContext('cropKey', runtime), true);
  win.addEventListener('keydown', runtime.onNodesKey, true);
  // Routing ownership is actual code; rendering and owner-end operations are
  // deliberately scoped seams. No synthetic selection or resize oracle is used.
  const host = createContext({
    document, canvasBox: { current: box }, canvasFrame: { current: frame }, railFrame: { current: null }, presentFrame: { current: null },
    pending, version: { current: 7 }, selRef, tool: 'select', presenting: false,
    typeAhead: { current: null }, textAhead: { current: false }, editingTextRef: { current: false },
    nodeEdRef: { current: null }, readOnlyRef: { current: false }, setToolState,
    setKind: vi.fn(), setSlides: vi.fn(), setPageW: vi.fn(), setPageH: vi.fn(),
    setSolo: (update: (before: null) => unknown) => update(null),
    toCanvas: (message: ToRuntime) => {
      commands.push(message);
      runtime.onMessage({ source: win.parent, data: message });
    },
  });
  runInContext(parentCode, host);
  const onKey = runInContext('onKey', host) as (event: KeyboardEvent) => void;
  window.addEventListener('keydown', onKey);
  disposers.push(() => { window.removeEventListener('keydown', onKey); root.remove(); });
  button.focus();
  const escape = (target: HTMLElement = button, consumed = false) => {
    target.focus();
    const event = new KeyboardEvent('keydown', { key: 'Escape', code: 'Escape', bubbles: true, cancelable: true });
    if (consumed) event.preventDefault(); target.dispatchEvent(event); return event;
  };
  const layout = (version = 7) => {
    runInContext('onMessage', host)({ source: win, data: { ol: 'layout', kind: 'deck', version, slides: [], width: 1280, height: 720 } });
  };
  const selection = () => [...runtime.selected] as Element[];
  return { root, box, button, frame, win, doc, image, slide, src, srcOf, liveOf, host, runtime, pending, selRef, commands,
    escape, layout, selection, setToolState, stopText, holdKey, holdAfter, editTextAt, endCrop, endNodes };
}
const ESCAPE: ToRuntime = { ol: 'canvasKey', key: 'Escape', shift: false };

describe('Escape owns selection at the canvas, not a delayed host reply', () => {
  it('clears the actual selected image even when the host selection reply is still empty', () => {
    const s = setup(); s.selRef.current = []; expect(s.selRef.current).toEqual([]); expect(s.selection()).toEqual([s.image]);
    expect(s.escape().defaultPrevented).toBe(true);
    expect(s.commands).toEqual([ESCAPE]); expect(s.selection()).toEqual([]);
  });

  it('cancels a queued automatic object selection so later current layouts cannot reselect after Escape', () => {
    const s = setup(); s.runtime.selected = []; s.selRef.current = []; s.pending.current = { select: [IMAGE_PATH] };
    s.escape(); expect(s.pending.current).toBeNull();
    for (const version of [0, 7, 7, 8]) s.layout(version);
    expect(s.commands).toEqual([ESCAPE]); expect(s.selection()).toEqual([]);
  });

  it('routes repeated Escape once per key without waiting for a host selection response', () => {
    const s = setup(); s.selRef.current = []; s.escape(); s.escape();
    expect(s.commands).toEqual([ESCAPE, ESCAPE]); expect(s.selection()).toEqual([]);
  });

  it('preserves a pending text edit and its actual later layout handoff', () => {
    const s = setup(), pending = { editText: TEXT_PATH }; s.pending.current = pending;
    s.escape(); expect(s.pending.current).toBe(pending); s.layout();
    expect(s.commands).toEqual([ESCAPE, { ol: 'editText', path: TEXT_PATH, selectAll: true, math: undefined }]);
    expect(s.editTextAt).toHaveBeenCalledExactlyOnceWith(TEXT_PATH, true, undefined);
  });

  it('preserves a pending formula edit and its actual later layout handoff', () => {
    const s = setup(), pending = { editText: TEXT_PATH, math: true }; s.pending.current = pending;
    s.escape(); expect(s.pending.current).toBe(pending); s.layout();
    expect(s.editTextAt).toHaveBeenCalledExactlyOnceWith(TEXT_PATH, true, true);
  });

  it('first returns a drawing tool to Select without changing its contextual selection', () => {
    const s = setup(); s.host.tool = 'text'; s.pending.current = { select: [IMAGE_PATH] };
    s.escape(); expect(s.setToolState).toHaveBeenCalledExactlyOnceWith('select');
    expect(s.commands).toEqual([]); expect(s.pending.current).toEqual({ select: [IMAGE_PATH] });
  });

  it('leaves presentation Escape and pending selection to the presentation owner', () => {
    const s = setup(); s.host.presenting = true; s.pending.current = { select: [IMAGE_PATH] };
    s.escape(); expect(s.commands).toEqual([]); expect(s.pending.current).toEqual({ select: [IMAGE_PATH] });
  });

  it('does not take a formula or popup Escape that its more specific owner already consumed', () => {
    const s = setup(); s.pending.current = { select: [IMAGE_PATH] };
    s.escape(s.button, true); expect(s.commands).toEqual([]); expect(s.selection()).toEqual([s.image]);
    expect(s.pending.current).toEqual({ select: [IMAGE_PATH] });
  });

  it.each(['input', 'textarea', 'contenteditable'])('preserves real parent field ownership (%s)', kind => {
    const s = setup(); const field = document.createElement(kind === 'contenteditable' ? 'div' : kind);
    if (kind === 'contenteditable') {
      field.contentEditable = 'true'; field.tabIndex = 0;
      // jsdom omits this native DOM capability; model only the ownership getter.
      Object.defineProperty(field, 'isContentEditable', { value: true });
    }
    s.root.append(field); s.pending.current = { select: [IMAGE_PATH] };
    s.escape(field); expect(s.commands).toEqual([]); expect(s.pending.current).toEqual({ select: [IMAGE_PATH] });
  });

  it('does not steal Escape from a field outside this editor', () => {
    const s = setup(), outside = document.createElement('button'); document.body.append(outside);
    disposers.push(() => outside.remove()); s.escape(outside);
    expect(s.commands).toEqual([]); expect(s.selection()).toEqual([s.image]);
  });

  it('uses the more specific parent node-editor command instead of clearing object selection', () => {
    const s = setup(); s.host.nodeEdRef.current = { selected: 1, total: 2 }; s.pending.current = { select: [IMAGE_PATH] };
    s.escape(); expect(s.commands).toEqual([{ ol: 'nodes', cmd: 'done' }]);
    expect(s.pending.current).toEqual({ select: [IMAGE_PATH] });
  });

  it('also forwards Escape when the parent body owns the keyboard', () => {
    const s = setup(); s.selRef.current = []; s.button.blur();
    document.body.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }));
    expect(s.commands).toEqual([ESCAPE]); expect(s.selection()).toEqual([]);
  });

  it('keeps the actual runtime level-up behavior for an object inside a group', () => {
    const s = setup(), group = s.doc.createElement('div'), original = s.src.createElement('div');
    s.slide.append(group); group.append(s.image); s.src.querySelector('.slide')!.append(original);
    s.srcOf.set(group, original); s.liveOf.set(original, group);
    s.escape(); expect(s.selection()).toEqual([group]);
    s.escape(); expect(s.selection()).toEqual([]);
  });

  it('finishes actual runtime text context without clearing the selected object', () => {
    const s = setup(); s.runtime.editing = s.doc.querySelector('h1');
    s.escape(); expect(s.stopText).toHaveBeenCalledTimes(1); expect(s.selection()).toEqual([s.image]);
  });

  it('passes Escape to the formula opening inbox rather than the object-selection branch', () => {
    const s = setup(); s.runtime.editing = s.doc.querySelector('h1'); s.runtime.chipOpening = () => true;
    s.runtime.keyPress = (event: KeyboardEvent) => ({ key: event.key });
    s.escape(); expect(s.holdKey).toHaveBeenCalledExactlyOnceWith({ key: 'Escape' });
    expect(s.stopText).not.toHaveBeenCalled(); expect(s.selection()).toEqual([s.image]);
  });

  it('passes Escape to an open formula handoff instead of object selection', () => {
    const s = setup(); s.runtime.editing = s.doc.querySelector('h1'); s.runtime.openChipEl = () => s.image;
    s.runtime.keyPress = (event: KeyboardEvent) => ({ key: event.key });
    s.escape(); expect(s.holdAfter).toHaveBeenCalledExactlyOnceWith({ key: 'Escape' });
    expect(s.stopText).not.toHaveBeenCalled(); expect(s.selection()).toEqual([s.image]);
  });

  it('uses the actual crop key owner to cancel crop rather than clear selection', () => {
    const s = setup(); s.runtime.active = { illustrative: true };
    s.escape(); expect(s.endCrop).toHaveBeenCalledExactlyOnceWith(false); expect(s.selection()).toEqual([s.image]);
  });

  it('uses the actual runtime node key owner to end nodes without clearing selection', () => {
    const s = setup(); s.runtime.ed = { illustrative: true };
    s.escape(); expect(s.endNodes).toHaveBeenCalledTimes(1); expect(s.selection()).toEqual([s.image]);
  });

  it('preserves an actual canvas input owner when the parent forwards Escape', () => {
    const s = setup(), input = s.doc.createElement('input'); s.doc.body.append(input); input.focus();
    s.runtime.escapeCanvas(); expect(s.selection()).toEqual([s.image]); expect(s.commands).toEqual([]);
  });

  it('ignores a canvas key message sent to an actual presentation runtime', () => {
    const s = setup(); s.runtime.MODE = 'present';
    s.runtime.onMessage({ source: s.win.parent, data: ESCAPE });
    expect(s.selection()).toEqual([s.image]); expect(s.stopText).not.toHaveBeenCalled();
  });
});
