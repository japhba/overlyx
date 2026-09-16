import { editorClipboard } from '@client/editor/clipboard';
import { editorPlugins } from '@client/editor/plugins';
import { editorTransactions } from '@client/editor/transactions';
/**
 * The OverLyX editor without a server: the same ProseMirror assembly as the web client's
 * createEditor (editor.ts), but on a purely local Y.Doc — no WebSocket provider, no IndexedDB,
 * no presence. The document comes in as ProseMirror JSON from the extension host (which parsed
 * the .tex file) and leaves as ProseMirror JSON after each change; external file changes are
 * applied as a Yjs diff so the cursor and unsynced edits survive.
 */
import { EditorState, Plugin, Selection, TextSelection } from 'prosemirror-state';
import { EditorView, type NodeView } from 'prosemirror-view';
import { type Node as PMNode } from 'prosemirror-model';
import { keymap } from 'prosemirror-keymap';
import * as Y from 'yjs';
import { Awareness } from 'y-protocols/awareness';
import { ySyncPlugin, yCursorPlugin, yUndoPlugin, ySyncPluginKey, yUndoPluginKey, defaultDeleteFilter, undo, redo, initProseMirrorDoc, prosemirrorJSONToYXmlFragment } from 'y-prosemirror';
import { editorSessions } from './editorSession';
import { documentModel, mergeModels, sameModel, type DocumentModel } from '../shared/documentModel';
import { schema, unquote, paramMap } from '@overlyx/core';
import { MathInlineView, MathDisplayView, MacroView } from '@client/editor/nodeviews/math';
import { InsetView } from '@client/editor/nodeviews/inset';
import { GraphicsView, CommandView, LeafView } from '@client/editor/nodeviews/leaf';
import { editorContext, viewDocDir, viewProject } from '@client/editor/context';
import { sliceText } from '@client/editor/cliptext';
import { showContextMenu } from '@client/editor/contextmenu';
import { editorContextMenu } from '@client/editor/editormenu';
import { includeTarget } from '@client/editor/commands';
import { misspelledAt, spellSuggest } from '@client/editor/spell/plugin';
import { macroDefsPlugin, describeChange } from '@client/editor/editor';
import { getPrefs, subscribePrefs } from '@client/prefs';

function guarded(node: PMNode, make: () => NodeView): NodeView {
  let v: NodeView;
  try { v = make(); }
  catch (e) {
    console.error(`node view for ${node.type.name} failed`, e, node.toJSON());
    const dom = document.createElement(node.isInline ? 'span' : 'div');
    dom.className = 'lyx-broken';
    dom.title = `This ${node.type.name} could not be displayed: ${String(e)}`;
    dom.textContent = `⚠ ${node.type.name}`;
    dom.contentEditable = 'false';
    return { dom, update: () => false };
  }
  const update = v.update?.bind(v);
  if (update) v.update = (n, decos, inner) => { try { return update(n, decos, inner); } catch (e) { console.error(`node view update for ${node.type.name} failed`, e); return false; } };
  return v;
}

function editorAttributes(p: { spellcheck: boolean; spellEngine: string }): Record<string, string> {
  return { class: 'lyx-editor', spellcheck: p.spellcheck && p.spellEngine === 'browser' ? 'true' : 'false' };
}

export interface LocalEditorHandle {
  view: EditorView;
  ydoc: Y.Doc;
  /** apply new content that arrived from the file (as a diff: unchanged paragraphs keep identity) */
  applyExternal(pmDoc: unknown, headerLines: string[]): string[];
  /** Only user changes since the last received/sent model need to be written back. */
  takeUpdate(headerLines: string[]): (DocumentModel & { base: DocumentModel }) | null;
  destroy(preserveSession?: boolean): void;
}

export interface LocalEditorOptions {
  docId: string;
  container: HTMLElement;
  pmDoc: unknown;
  headerLines: string[];
  marginMode?: boolean;
  child?: boolean;
  onSelectionChange?: (view: EditorView, info: { docChanged: boolean }) => void;
  onDocChange?: (view: EditorView) => void;
}

const EXTERNAL_ORIGIN = 'vscode-file';

export function createLocalEditor(opts: LocalEditorOptions): LocalEditorHandle {
  let session = editorSessions.get(opts.docId);
  if (!session) {
    const ydoc = new Y.Doc();
    const fragment = ydoc.getXmlFragment('prosemirror');
    ydoc.transact(() => { prosemirrorJSONToYXmlFragment(schema, opts.pmDoc, fragment); }, EXTERNAL_ORIGIN);
    const awareness = new Awareness(ydoc);
    awareness.setLocalStateField('user', { name: 'You', color: '#3b6ea5' });
    const undoManager = new Y.UndoManager(fragment, {
      trackedOrigins: new Set([ySyncPluginKey]),
      deleteFilter: item => defaultDeleteFilter(item, new Set(['paragraph'])),
      captureTransaction: tr => tr.meta.get('addToHistory') !== false,
    });
    session = { ydoc, awareness, undoManager, scrollTop: 0, headerLines: opts.headerLines, base: documentModel(opts.pmDoc, opts.headerLines) };
    editorSessions.set(opts.docId, session);
  }
  const { ydoc, awareness, undoManager } = session;
  const fragment = ydoc.getXmlFragment('prosemirror');

  const { doc: initialDoc, mapping } = initProseMirrorDoc(fragment, schema);
  let viewRef: EditorView | null = null;

  const plugins: Plugin[] = [
    ySyncPlugin(fragment, { mapping }),
    yCursorPlugin(awareness),
    new Plugin({
      ...yUndoPlugin({ undoManager }).spec,
      view: view => {
        const binding = ySyncPluginKey.getState(view.state).binding;
        for (const item of [...undoManager.undoStack, ...undoManager.redoStack]) {
          if (session!.binding && item.meta.has(session!.binding)) {
            item.meta.set(binding, item.meta.get(session!.binding));
            item.meta.delete(session!.binding);
          }
        }
        session!.binding = binding;
        type StackItem = Y.UndoManager['undoStack'][number];
        const added = ({ stackItem }: { stackItem: StackItem }) => { stackItem.meta.set(binding, yUndoPluginKey.getState(view.state)!.prevSel); };
        const popped = ({ stackItem }: { stackItem: StackItem }) => { binding.beforeTransactionSelection = stackItem.meta.get(binding) || binding.beforeTransactionSelection; };
        undoManager.on('stack-item-added', added);
        undoManager.on('stack-item-popped', popped);
        return { destroy() { undoManager.off('stack-item-added', added); undoManager.off('stack-item-popped', popped); } };
      },
    }),
    ...editorPlugins({ awareness, marginMode: opts.marginMode ?? false, child: opts.child ?? false, history: [keymap({ 'Mod-z': undo, 'Mod-y': redo, 'Mod-Z': redo, 'Shift-Mod-z': redo })] }),
    macroDefsPlugin(() => viewRef),
    new Plugin({
      view: () => ({
        update: (view, prev) => {
          if (!prev.selection.eq(view.state.selection) || prev.doc !== view.state.doc) opts.onSelectionChange?.(view, { docChanged: prev.doc !== view.state.doc });
          if (prev.doc !== view.state.doc) opts.onDocChange?.(view);
        },
      }),
    }),
  ];

  const state = EditorState.create({ schema, doc: initialDoc, plugins });
  const attributes = (prefs: { spellcheck: boolean; spellEngine: string }) => ({ ...editorAttributes(prefs), 'data-doc-id': opts.docId, 'data-project': opts.docId.split('/')[0], 'data-doc-dir': opts.docId.split('/').slice(1, -1).join('/') });
  const view = new EditorView(opts.container, {
    state,
    dispatchTransaction: editorTransactions(() => false),
    nodeViews: {
      math_inline: (node, view, getPos) => guarded(node, () => new MathInlineView(node, view, getPos as () => number | undefined)),
      math_display: (node, view, getPos) => guarded(node, () => new MathDisplayView(node, view, getPos as () => number | undefined)),
      macro: (node, view, getPos) => guarded(node, () => new MacroView(node, view, getPos as () => number | undefined)),
      inset: (node, view, getPos) => guarded(node, () => new InsetView(node, view, getPos as () => number | undefined)),
      graphics: (node, view, getPos) => guarded(node, () => new GraphicsView(node, view, getPos as () => number | undefined)),
      command: (node, view, getPos) => guarded(node, () => new CommandView(node, view, getPos as () => number | undefined)),
      leaf: (node, view, getPos) => guarded(node, () => new LeafView(node, view, getPos as () => number | undefined)),
    },
    attributes: attributes(getPrefs()),
    clipboardTextSerializer: sliceText,
    handleDoubleClickOn(view, _pos, node, nodePos) {
      if (node.type.name === 'command' && node.attrs.cmd === 'include') {
        const id = includeTarget(node, viewProject(view), viewDocDir(view));
        if (id) editorContext.openInTab?.(id);
        return true;
      }
      if (node.type.name === 'command' && (node.attrs.cmd === 'ref' || node.attrs.cmd === 'citation')) {
        editorContext.openDialog?.(node.attrs.cmd === 'ref' ? 'ref' : 'cite', { pos: nodePos, node });
        return true;
      }
      return false;
    },
    handleClickOn(view, _pos, node, nodePos, event) {
      if (node.type.name === 'math_inline' || node.type.name === 'math_display') {
        const nv = (view.nodeDOM(nodePos) as any)?.pmViewDesc?.spec;
        if (nv && !nv.mf && nv.ensureField) { const mf = nv.ensureField(); requestAnimationFrame(() => mf.focus()); return true; }
        return false;
      }
      if (!(event.metaKey || event.ctrlKey) || node.type.name !== 'command') return false;
      let p: Map<string, string>;
      try { p = paramMap(JSON.parse(node.attrs.params || '[]')); } catch { return false; }
      const cmd = node.attrs.cmd as string;
      if (cmd === 'ref') { editorContext.gotoLabel?.(unquote(p.get('reference')).split(',')[0].trim(), view); return true; }
      if (cmd === 'href') { const t = unquote(p.get('target')); window.open(/^[a-z]+:/i.test(t) ? t : 'https://' + t, '_blank', 'noopener'); return true; }
      if (cmd === 'include') { const id = includeTarget(node, viewProject(view), viewDocDir(view)); if (id) editorContext.openInTab?.(id); return true; }
      return false;
    },
    handleDOMEvents: {
      focus(view) { editorContext.activeView = view; opts.onSelectionChange?.(view, { docChanged: false }); return false; },
      contextmenu(view, ev) {
        const t = ev.target as HTMLElement;
        if (t.closest?.('math-field')) return false;
        if (ev.shiftKey) return false;
        ev.preventDefault();
        const coords = view.posAtCoords({ left: ev.clientX, top: ev.clientY });
        const bad = coords ? misspelledAt(view.state, coords.pos) : null;
        if (bad) {
          const { clientX, clientY } = ev;
          void spellSuggest(bad.word).then(list => { showContextMenu(clientX, clientY, editorContextMenu(view, ev, { ...bad, suggestions: list })); });
        } else showContextMenu(ev.clientX, ev.clientY, editorContextMenu(view, ev));
        return true;
      },
    },
    ...editorClipboard(opts.docId, () => false),
  });
  viewRef = view;
  const unsubscribePrefs = subscribePrefs(p => { view.setProps({ attributes: attributes(p) }); });
  view.dom.dataset.docId = opts.docId;
  view.dom.dataset.project = opts.docId.split('/')[0];
  view.dom.dataset.docDir = opts.docId.split('/').slice(1, -1).join('/');

  view.dom.addEventListener('mouseover', (ev) => {
    const el = (ev.target as HTMLElement).closest?.('.lyx-change, .lyx-inset[data-change]') as HTMLElement | null;
    if (!el || el.title) return;
    el.title = describeChange(el.dataset.change, Number(el.dataset.author), Number(el.dataset.time));
  });

  const selection = session.selection ? Selection.fromJSON(view.state.doc, session.selection) : TextSelection.atStart(view.state.doc);
  view.dispatch(view.state.tr.setSelection(selection).setMeta('addToHistory', false));

  return {
    view, ydoc,
    applyExternal(pmDoc: unknown, headerLines: string[]) {
      const incoming = documentModel(pmDoc, headerLines);
      const local = documentModel(view.state.doc.toJSON(), session!.headerLines!);
      const merged = mergeModels(session!.base, local, incoming);
      session!.base = incoming;
      session!.headerLines = merged.headerLines;
      ydoc.transact(() => { prosemirrorJSONToYXmlFragment(schema, merged.pmDoc, fragment); }, EXTERNAL_ORIGIN);
      return merged.headerLines;
    },
    takeUpdate(headerLines: string[]) {
      const next = documentModel(view.state.doc.toJSON(), headerLines);
      const base = session!.base;
      if (sameModel(next, base)) return null;
      session!.base = next;
      session!.headerLines = next.headerLines;
      return { ...next, base };
    },
    destroy(preserveSession = false) {
      session!.selection = view.state.selection.toJSON();
      unsubscribePrefs();
      view.destroy();
      if (!preserveSession) {
        undoManager.destroy();
        awareness.destroy();
        ydoc.destroy();
        editorSessions.delete(opts.docId);
      }
    },
  };
}
