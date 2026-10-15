// @vitest-environment jsdom
import { readFileSync } from 'node:fs';
import { URL as FileURL } from 'node:url';
import { createContext, runInContext } from 'node:vm';
import * as ts from 'typescript';
import * as Y from 'yjs';
import { h, render, type ComponentProps } from 'preact';
import { act } from 'preact/test-utils';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ReviewPane } from '../packages/client/src/deliverable/ReviewPane';
import { opSplices, parseSource, type HtmlOp } from '../packages/core/src/html/source.ts';
import type { CommentDraft } from '../packages/client/src/deliverable/ReviewPane';
import type { FromRuntime } from '../packages/client/src/deliverable/protocol';

function source(url: FileURL) {
  const text = readFileSync(url, 'utf8');
  return { text, ast: ts.createSourceFile(url.pathname, text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS) };
}
const editingSource = source(new FileURL('../packages/client/src/deliverable/runtime/edit.ts', import.meta.url));
const reviewSource = source(new FileURL('../packages/client/src/deliverable/runtime/review.ts', import.meta.url));
const environmentSource = source(new FileURL('../packages/client/src/deliverable/runtime/env.ts', import.meta.url));
const messageSource = source(new FileURL('../packages/client/src/deliverable/runtime/index.ts', import.meta.url));

function functionSource(file: ReturnType<typeof source>, name: string): string {
  let found: ts.FunctionDeclaration | undefined;
  const visit = (node: ts.Node) => {
    if (ts.isFunctionDeclaration(node) && node.name?.text === name) found = node;
    ts.forEachChild(node, visit);
  };
  visit(file.ast);
  if (!found) throw new Error('Missing runtime function: ' + name);
  return file.text.slice(found.getStart(file.ast), found.end);
}
function variableSource(file: ReturnType<typeof source>, name: string): string {
  let found: ts.VariableDeclaration | undefined;
  const visit = (node: ts.Node) => {
    if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.name.text === name) found = node;
    ts.forEachChild(node, visit);
  };
  visit(file.ast);
  if (!found) throw new Error('Missing runtime variable: ' + name);
  return 'const ' + file.text.slice(found.getStart(file.ast), found.end) + ';';
}
const compile = (text: string) => ts.transpileModule(text, {
  compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS },
}).outputText;
// Exercise the shipped handoff and finish-edit functions against real DOM ownership.
const handlers = compile([
  functionSource(reviewSource, 'captureCommentTarget'),
  functionSource(environmentSource, 'srcPath'),
  functionSource(environmentSource, 'pathOf'),
  functionSource(environmentSource, 'slideOf'),
  functionSource(editingSource, 'selection'),
  functionSource(editingSource, 'pastePlain'),
  functionSource(editingSource, 'onBeforeInput'),
  functionSource(editingSource, 'scheduleCommit'),
  functionSource(editingSource, 'cleanHtml'),
  variableSource(editingSource, 'PHRASING_BOXES'),
  variableSource(editingSource, 'BLOCK_INSIDE'),
  functionSource(editingSource, 'commitText'),
  functionSource(editingSource, 'stopText'),
  functionSource(editingSource, 'newComment'),
  functionSource(editingSource, 'typeKeys'),
].join('\n'));

const ORIGINAL = 'The quick brown fox';
const SOURCE = '<!doctype html><html><head></head><body><section class="slide"><p id="p">' + ORIGINAL + '</p><div id="box"></div></section></body></html>';
type Comment = Extract<FromRuntime, { ol: 'comment' }>;
const disposers: (() => void)[] = [];
const roots: HTMLDivElement[] = [];
afterEach(async () => {
  for (const root of roots.splice(0)) { await act(() => render(null, root)); root.remove(); }
  for (const dispose of disposers.splice(0).reverse()) dispose();
  document.body.replaceChildren();
  getSelection()?.removeAllRanges();
  vi.restoreAllMocks();
});

function runtime(options: { changed?: boolean; idle?: 'object' | 'slide'; pendingKeys?: boolean } = {}) {
  const frame = document.createElement('iframe');
  document.body.append(frame);
  const canvasWindow = frame.contentWindow!;
  const canvasDocument = frame.contentDocument!;
  canvasDocument.body.innerHTML = '<section class="slide"><p id="p">' + ORIGINAL + '</p><div id="box"></div></section>';
  const paragraph = canvasDocument.querySelector<HTMLParagraphElement>('#p')!;
  const object = canvasDocument.querySelector<HTMLDivElement>('#box')!;
  const slide = canvasDocument.querySelector<HTMLElement>('.slide')!;
  const sourceDocument = canvasDocument.implementation.createHTMLDocument('');
  sourceDocument.body.innerHTML = '<section class="slide"><p id="p">' + ORIGINAL + '</p><div id="box"></div></section>';
  const sourceParagraph = sourceDocument.querySelector<HTMLParagraphElement>('#p')!;
  const sourceObject = sourceDocument.querySelector<HTMLDivElement>('#box')!;
  const sourceSlide = sourceDocument.querySelector<HTMLElement>('.slide')!;
  const srcOf = new WeakMap<Element, Element>([[paragraph, sourceParagraph], [object, sourceObject], [slide, sourceSlide]]);
  paragraph.tabIndex = 0;
  if (!options.idle) {
    paragraph.setAttribute('contenteditable', 'true');
    paragraph.setAttribute('data-ol-editing', '');
    paragraph.focus();
    if (options.changed) paragraph.append(' plus');
    const range = canvasDocument.createRange();
    range.setStart(paragraph.firstChild!, ORIGINAL.indexOf('fox'));
    range.setEnd(paragraph.firstChild!, ORIGINAL.length);
    canvasWindow.getSelection()!.removeAllRanges();
    canvasWindow.getSelection()!.addRange(range);
  }
  const ydoc = new Y.Doc();
  const text = ydoc.getText('source');
  text.insert(0, SOURCE);
  const origin = {};
  const history = new Y.UndoManager(text, { trackedOrigins: new Set([origin]) });
  const messages: FromRuntime[] = [];
  const comments: Comment[] = [];
  const ownershipAtComment: { receiver: boolean; editable: boolean; rangeCount: number; source: string }[] = [];
  const operations: HtmlOp[][] = [];
  let releaseKeys: (() => void) | undefined;
  const leaving = options.pendingKeys ? new Promise<void>(resolve => { releaseKeys = resolve; }) : Promise.resolve();
  const typeKeysHere = vi.fn();
  const paragraphFocus = vi.spyOn(paragraph, 'focus');
  const context = createContext({
    exports: {}, window: canvasWindow, document: canvasDocument, getSelection: () => canvasWindow.getSelection(),
    Node, HTMLElement, WeakMap, Set, setTimeout, clearTimeout, MODE: 'edit',
    state: { src: sourceDocument }, srcOf,
    selected: options.idle === 'object' ? [object] : options.idle === 'slide' ? [] : [paragraph],
    editing: options.idle ? null : paragraph, guard: { editing: options.idle ? null : paragraph },
    editStartHtml: ORIGINAL, editTimer: null, promotedTextStyles: new WeakMap(),
    slides: () => [slide], visibleSlideEl: () => slide,
    restoreMappedAssets: vi.fn(), mapAssets: vi.fn(), unchip: vi.fn(), closeChip: vi.fn(),
    linkTree: vi.fn(), renderCites: vi.fn(), refreshCites: vi.fn(),
    typeset: vi.fn(() => Promise.resolve()), sendCaret: vi.fn(), chosenWords: vi.fn(), draw: vi.fn(),
    redrawSoon: vi.fn(), wordsMoved: vi.fn(), trackInput: () => false,
    drawAhead: null, holdIfLeaving: () => false, leaving, typeKeysHere,
    post: (message: FromRuntime) => {
      messages.push(message);
      if (message.ol === 'comment') {
        comments.push(message);
        ownershipAtComment.push({
          receiver: context.editing !== null,
          editable: paragraph.hasAttribute('contenteditable'),
          rangeCount: canvasWindow.getSelection()!.rangeCount,
          source: text.toString(),
        });
      }
    },
    commit: (ops: HtmlOp[]) => {
      operations.push(ops);
      const current = parseSource(text.toString());
      const splices = ops.flatMap(op => opSplices(current, op)).sort((a, b) => b.from - a.from);
      ydoc.transact(() => {
        for (const splice of splices) {
          text.delete(splice.from, splice.to - splice.from);
          text.insert(splice.from, splice.insert);
        }
      }, origin);
      // Model the existing source pairing updated by the committed HTML delta.
      for (const op of ops) if (op.t === 'inner') sourceParagraph.innerHTML = op.html;
    },
  });
  runInContext(handlers, context);
  if (!options.idle) {
    paragraph.addEventListener('input', context.scheduleCommit);
    paragraph.addEventListener('beforeinput', context.onBeforeInput);
    paragraph.addEventListener('paste', context.pastePlain);
  }
  disposers.push(() => { releaseKeys?.(); history.destroy(); ydoc.destroy(); frame.remove(); });
  return { context, paragraph, object, slide, canvasWindow, sourceParagraph, text, history, operations, messages, comments, ownershipAtComment, typeKeysHere, paragraphFocus, releaseKeys: () => releaseKeys?.() };
}

async function mountDraft(message: Comment, submitted = vi.fn(), cancelled = vi.fn()) {
  const root = document.createElement('div');
  document.body.append(root); roots.push(root);
  let draft: CommentDraft | null = { path: message.path, quote: message.quote, slide: message.slide, what: '“' + ORIGINAL + '”' };
  const props: ComponentProps<typeof ReviewPane> = {
    review: { changes: [], threads: [] }, slideTitles: ['Illustrative slide'], current: 0, kind: 'deck', me: 'Example Reviewer',
    canEdit: true, focus: null, draft,
    submitDraft: submitted,
    cancelDraft: () => { cancelled(); draft = null; show(); },
    select: vi.fn(), reply: vi.fn(), resolve: vi.fn(), remove: vi.fn(),
    accept: vi.fn(), reject: vi.fn(), acceptAll: vi.fn(), rejectAll: vi.fn(), close: vi.fn(),
  };
  const show = () => render(h(ReviewPane, { ...props, draft }), root);
  await act(show);
  return { root, textarea: root.querySelector<HTMLTextAreaElement>('[data-rv-comment]')!, submitted, cancelled };
}

function enterTextAtCurrentOwner(text: string): void {
  const target = document.activeElement;
  expect(target).toBeInstanceOf(HTMLTextAreaElement);
  const textarea = target as HTMLTextAreaElement;
  // jsdom has no browser editing default action. Apply input only to the actual
  // focused DOM owner; the rendered Preact handlers receive its native value.
  textarea.setRangeText(text, textarea.selectionStart, textarea.selectionEnd, 'end');
  textarea.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertText', data: text }));
}

describe('canvas-to-comment keyboard ownership', () => {
  it('captures selected words and a stable source path before DOM ranges or targets change', () => {
    const state = runtime();
    state.context.newComment();
    const captured = state.comments[0];
    expect(captured.quote).toBe('fox');
    expect(captured.path).toEqual([1, 0, 0]);
    state.canvasWindow.getSelection()!.removeAllRanges();
    state.sourceParagraph.remove();
    state.paragraph.textContent = 'Replaced after capture';
    expect(captured.quote).toBe('fox');
    expect(captured.path).toEqual([1, 0, 0]);
  });

  it('releases the actual editable receiver and native selection before the comment reaches its host', () => {
    const state = runtime();
    state.context.newComment();
    expect(state.ownershipAtComment).toEqual([{ receiver: false, editable: false, rangeCount: 0, source: SOURCE }]);
    expect(state.context.guard.editing).toBeNull();
    expect(state.paragraph.hasAttribute('data-ol-editing')).toBe(false);
    const finished = state.messages.findIndex(m => m.ol === 'editing' && m.path === null);
    const draft = state.messages.findIndex(m => m.ol === 'comment');
    expect(finished).toBeGreaterThanOrEqual(0);
    expect(finished).toBeLessThan(draft);
    expect(state.operations).toEqual([]);
    expect(state.paragraph.innerHTML).toBe(ORIGINAL);
  });

  it('gives the rendered draft immediate typing and Ctrl+Enter without changing the quoted paragraph', async () => {
    const state = runtime();
    state.context.newComment();
    expect(state.context.editing).toBeNull();
    const pane = await mountDraft(state.comments[0]);
    expect(document.activeElement).toBe(pane.textarea);
    expect(pane.root.querySelector('.dl-rv-quote')?.textContent).toBe('fox');
    await act(() => {
      enterTextAtCurrentOwner('Which fox?');
      // Submit before a separate render can refresh the component's state closure.
      pane.textarea.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', ctrlKey: true, bubbles: true, cancelable: true }));
    });
    expect(pane.textarea.value).toBe('Which fox?');
    expect(pane.submitted).toHaveBeenCalledExactlyOnceWith('Which fox?');
    expect(state.paragraph.innerHTML).toBe(ORIGINAL);
    expect(state.text.toString()).toBe(SOURCE);
    expect(state.operations).toEqual([]);
  });

  it('finishes previously typed writing before opening the comment and preserves real Undo and Redo', () => {
    const state = runtime({ changed: true });
    state.context.newComment();
    const written = SOURCE.replace(ORIGINAL, ORIGINAL + ' plus');
    expect(state.comments[0].quote).toBe('fox');
    expect(state.comments[0].path).toEqual([1, 0, 0]);
    expect(state.ownershipAtComment[0].source).toBe(written);
    expect(state.operations).toHaveLength(1);
    expect(state.operations[0][0]).toMatchObject({ t: 'inner', path: [1, 0, 0], before: ORIGINAL, html: ORIGINAL + ' plus' });
    state.history.undo();
    expect(state.text.toString()).toBe(SOURCE);
    state.history.redo();
    expect(state.text.toString()).toBe(written);
  });

  it('does not let a previously queued text callback reclaim the keyboard from the comment', async () => {
    const state = runtime({ pendingKeys: true });
    state.context.typeKeys([{ key: 'x' }]);
    state.context.newComment();
    const pane = await mountDraft(state.comments[0]);
    expect(document.activeElement).toBe(pane.textarea);
    state.paragraphFocus.mockClear();
    state.releaseKeys();
    await Promise.resolve();
    expect(state.typeKeysHere).not.toHaveBeenCalled();
    expect(state.paragraphFocus).not.toHaveBeenCalled();
    expect(document.activeElement).toBe(pane.textarea);
    expect(state.paragraph.innerHTML).toBe(ORIGINAL);
  });

  it.each(['object', 'slide'] as const)('keeps the %s comment target when no text receiver owns the keyboard', async idle => {
    const state = runtime({ idle });
    state.context.newComment();
    expect(state.comments).toHaveLength(1);
    expect(state.comments[0]).toEqual({ ol: 'comment', path: idle === 'object' ? [1, 0, 1] : [1, 0], quote: undefined, slide: 0, open: false });
    expect(state.operations).toEqual([]);
    const pane = await mountDraft(state.comments[0]);
    expect(document.activeElement).toBe(pane.textarea);
    expect(state.text.toString()).toBe(SOURCE);
  });

  it('cancelling the actual rendered draft creates no thread or body edit', async () => {
    const state = runtime(); state.context.newComment();
    const pane = await mountDraft(state.comments[0]);
    await act(() => {
      enterTextAtCurrentOwner('An unsent comment');
      pane.textarea.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }));
    });
    expect(pane.cancelled).toHaveBeenCalledOnce();
    expect(pane.submitted).not.toHaveBeenCalled();
    expect(pane.root.querySelector('[data-rv-draft]')).toBeNull();
    expect(state.text.toString()).toBe(SOURCE);
    expect(state.operations).toEqual([]);
  });

  it('does not finish editing or open a draft from a non-edit runtime mode', () => {
    const state = runtime();
    state.context.edit = { newComment: state.context.newComment };
    runInContext(compile(functionSource(messageSource, 'onMessage')), state.context);
    for (const mode of ['view', 'thumb', 'present']) {
      state.context.MODE = mode;
      state.context.onMessage({ source: state.canvasWindow.parent, data: { ol: 'newComment' } });
    }
    expect(state.comments).toEqual([]);
    expect(state.operations).toEqual([]);
    expect(state.context.editing).toBe(state.paragraph);
    expect(state.paragraph.hasAttribute('contenteditable')).toBe(true);
  });
});
