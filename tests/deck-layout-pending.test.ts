// @vitest-environment jsdom
import { readFileSync } from 'node:fs';
import { URL as FileURL } from 'node:url';
import { createContext, runInContext } from 'node:vm';
import * as ts from 'typescript';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { FromRuntime, Path, SelItem, ToRuntime } from '../packages/client/src/deliverable/protocol';

function source(url: FileURL, kind = ts.ScriptKind.TS) {
  const text = readFileSync(url, 'utf8');
  return { text, ast: ts.createSourceFile(url.pathname, text, ts.ScriptTarget.Latest, true, kind) };
}
const hostSource = source(new FileURL('../packages/client/src/deliverable/DeliverableEditor.tsx', import.meta.url), ts.ScriptKind.TSX);
const envSource = source(new FileURL('../packages/client/src/deliverable/runtime/env.ts', import.meta.url));
const editSource = source(new FileURL('../packages/client/src/deliverable/runtime/edit.ts', import.meta.url));
const protocolSource = source(new FileURL('../packages/client/src/deliverable/protocol.ts', import.meta.url));
const placeholderSource = source(new FileURL('../packages/client/src/deliverable/runtime/placeholders.ts', import.meta.url));
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
const hostCode = compile([
  declaration(protocolSource, 'isFromRuntime', true), declaration(hostSource, 'sameSolo'),
  declaration(hostSource, 'onMessage', true),
].join('\n'));
const runtimeCode = compile([
  ...['link', 'srcPath', 'pathOf', 'liveAt', 'slideOf', 'docRect', 'slideTitle', 'slideBoxes', 'pageSize', 'sendLayout'].map(n => declaration(envSource, n)),
  ...['TEXT_TAGS', 'REPLACED', 'SVG_SHAPES'].map(n => declaration(editSource, n, true)),
  ...['PH', 'MEDIA', 'isPicturePh'].map(n => declaration(placeholderSource, n, true)),
  ...['phRole', 'isEmptyPh'].map(n => declaration(placeholderSource, n)),
  ...['selection', 'selectPaths', 'editTextAt', 'isSvgPart', 'isLocked', 'cs', 'isTextual', 'canType', 'isGroup',
    'movable', 'fixedHeight', 'kindOf', 'label', 'pictureSrc', 'listOf', 'item', 'report'].map(n => declaration(editSource, n)),
].join('\n'));
type Pending = { select?: Path[]; editText?: Path; math?: boolean };
type Layout = Extract<FromRuntime, { ol: 'layout' }>;
const frames: HTMLIFrameElement[] = [];
afterEach(() => { for (const frame of frames.splice(0)) frame.remove(); vi.restoreAllMocks(); });

function setup(pendingValue: Pending | null = null) {
  const frame = () => { const el = document.createElement('iframe'); document.body.append(el); frames.push(el); return el; };
  const canvas = frame(), rail = frame(), present = frame(), foreign = frame();
  const win = canvas.contentWindow! as Window & typeof globalThis, doc = canvas.contentDocument!;
  doc.body.innerHTML = '<section class="slide"><h1>Illustrative slide</h1></section>';
  const slide = doc.querySelector<HTMLElement>('.slide')!;
  Object.defineProperties(slide, { offsetWidth: { value: 1280 }, offsetHeight: { value: 720 } });
  const original = doc.implementation.createHTMLDocument('');
  original.body.innerHTML = '<section class="slide"><h1>Illustrative slide</h1></section>';
  const sourceSlide = original.querySelector<HTMLElement>('.slide')!;
  const srcOf = new WeakMap<Element, Element>(), liveOf = new WeakMap<Element, Element>();
  const state = { src: original, kind: 'deck', version: 0 as number | null };
  const messages: FromRuntime[] = [], commands: ToRuntime[] = [];
  const pending = { current: pendingValue }, version = { current: 7 };
  const setSel = vi.fn<(items: SelItem[]) => void>(), setSelection = vi.fn();
  const beginText = vi.fn();
  let receive: (e: { source: Window | null; data: FromRuntime }) => void;
  const runtime = createContext({
    exports: {}, window: win, document: doc, HTMLElement: win.HTMLElement, SVGElement: win.SVGElement, Node: win.Node,
    getComputedStyle: win.getComputedStyle.bind(win), scrollX: 0, scrollY: 0,
    state, srcOf, liveOf, selected: [], editing: null, layoutHooks: {}, slides: () => [slide],
    revealSlideOf: () => false, draw: vi.fn(), beginText, drawInput: null, drawComposing: false, drawAhead: null,
    // Geometry/paint/clipboard dependencies are outside the version handoff;
    // actual item classification, source paths and selection routing are loaded above.
    styleOf: () => ({}), showGhost: vi.fn(), postClip: vi.fn(), postSequence: vi.fn(), postObjects: vi.fn(),
    post: (message: FromRuntime) => { messages.push(message); receive?.({ source: win, data: message }); },
  });
  runInContext(runtimeCode, runtime);
  runtime.link(slide, sourceSlide);
  runtime.link(slide.firstElementChild, sourceSlide.firstElementChild);
  const host = createContext({
    canvasFrame: { current: canvas }, railFrame: { current: rail }, presentFrame: { current: present },
    pending, version, host: { setSelection }, canvasSelection: { current: null },
    setKind: vi.fn(), setSlides: vi.fn(), setPageW: vi.fn(), setPageH: vi.fn(),
    setSolo: (update: (previous: null) => unknown) => update(null), setSel,
    toCanvas: (message: ToRuntime) => {
      commands.push(message);
      if (message.ol === 'select') runtime.selectPaths(message.paths);
      if (message.ol === 'editText') runtime.editTextAt(message.path, message.selectAll, message.math);
    },
  });
  runInContext(hostCode, host);
  const onMessage = runInContext('onMessage', host) as typeof receive;
  receive = event => onMessage(event);
  const insert = (kind: 'image' | 'text' | 'math' = 'image') => {
    const el = doc.createElement(kind === 'image' ? 'img' : 'p');
    if (kind === 'image') { el.setAttribute('src', 'public-test.png'); el.setAttribute('width', '2'); el.setAttribute('height', '2'); }
    else el.textContent = kind === 'math' ? '$x^2$' : 'New text';
    slide.append(el);
    const src = original.createElement(el.localName);
    for (const attr of el.attributes) src.setAttribute(attr.name, attr.value);
    src.textContent = el.textContent;
    sourceSlide.append(src); runtime.link(el, src); state.version = version.current;
    return el;
  };
  return { canvas, rail, present, foreign, runtime, state, pending, version, messages, commands, setSel, setSelection, beginText, insert, receive };
}
const IMAGE_PATH: Path = [1, 0, 1];
const layouts = (state: ReturnType<typeof setup>) => state.messages.filter((m): m is Layout => m.ol === 'layout');

describe('pending canvas actions belong to the applied source version', () => {
  it('runtime layout reports its exact applied version, including an initial null version', () => {
    const state = setup();
    for (const version of [0, 7, null]) {
      state.state.version = version; state.runtime.sendLayout();
      const message = layouts(state).at(-1)!;
      expect(message.version).toBe(version);
      expect(message.width).toBe(1280); expect(message.height).toBe(720);
      expect(message.slides[0].path).toEqual([1, 0]);
    }
  });

  it('retains image selection through old, future and null layouts, then selects its actual DOM image once', () => {
    const pending = { select: [IMAGE_PATH] };
    const state = setup(pending);
    for (const version of [0, 8, null]) {
      state.state.version = version; state.runtime.sendLayout();
      expect(state.pending.current).toBe(pending);
      expect(state.commands).toEqual([]);
      expect(state.setSel).not.toHaveBeenCalled();
      expect(state.setSelection).not.toHaveBeenCalled();
    }
    const image = state.insert(); state.runtime.sendLayout();
    expect(state.pending.current).toBeNull();
    expect(state.commands).toEqual([{ ol: 'select', paths: [IMAGE_PATH] }]);
    expect(state.runtime.selection()).toEqual([image]);
    expect(image.localName).toBe('img'); expect(image.getAttribute('width')).toBe('2'); expect(image.getAttribute('height')).toBe('2');
    expect(state.setSel).toHaveBeenCalledTimes(1);
    expect(state.setSel.mock.calls[0][0]).toEqual([expect.objectContaining({ path: IMAGE_PATH, kind: 'image', label: 'Picture', src: 'public-test.png' })]);
    expect(state.setSelection).toHaveBeenCalledExactlyOnceWith([IMAGE_PATH]);
  });

  it('does not repeat selection for duplicate current layouts or layouts with no pending action', () => {
    const state = setup(); state.state.version = 7; state.runtime.sendLayout();
    expect(state.commands).toEqual([]);
    state.pending.current = { select: [IMAGE_PATH] };
    const image = state.insert(); state.runtime.sendLayout(); state.runtime.sendLayout(); state.runtime.sendLayout();
    expect(state.commands).toHaveLength(1);
    expect(state.setSel).toHaveBeenCalledTimes(1);
    expect(state.runtime.selection()).toEqual([image]);
  });

  it('never consumes canvas pending actions from rail, presentation or unrelated frame replies', () => {
    const state = setup(); state.state.version = 7; state.runtime.sendLayout();
    const message = layouts(state).at(-1)!;
    const pending = { select: [IMAGE_PATH] }; state.pending.current = pending;
    for (const frame of [state.rail, state.present, state.foreign]) state.receive({ source: frame.contentWindow, data: message });
    expect(state.pending.current).toBe(pending);
    expect(state.commands).toEqual([]);
    expect(state.setSel).not.toHaveBeenCalled();
    expect(state.setSelection).not.toHaveBeenCalled();
  });

  it.each(['text', 'math'] as const)('preserves pending %s editing until its source version and DOM receiver exist', kind => {
    const pending = { editText: IMAGE_PATH, ...(kind === 'math' ? { math: true } : {}) };
    const state = setup(pending); state.runtime.sendLayout();
    expect(state.pending.current).toBe(pending);
    expect(state.commands).toEqual([]);
    expect(state.beginText).not.toHaveBeenCalled();
    const receiver = state.insert(kind); state.runtime.sendLayout();
    expect(state.pending.current).toBeNull();
    expect(state.commands).toEqual([{ ol: 'editText', path: IMAGE_PATH, selectAll: true, math: kind === 'math' ? true : undefined }]);
    expect(state.runtime.selection()).toEqual([receiver]);
    expect(state.beginText).toHaveBeenCalledExactlyOnceWith(receiver, null, kind !== 'math', kind === 'math');
    state.runtime.sendLayout(); expect(state.beginText).toHaveBeenCalledTimes(1);
  });
});
