/** Local document synchronization; editor behaviour is shared with the browser. */
import { EditorState, Plugin, Selection, TextSelection } from 'prosemirror-state';
import { EditorView } from 'prosemirror-view';
import { keymap } from 'prosemirror-keymap';
import * as Y from 'yjs';
import { Awareness } from 'y-protocols/awareness';
import { schema, projectOfDoc, docDirOf } from '@overlyx/core';
import { writeDocument } from '@overlyx/core/collab/index.ts';
import { collabSync, cursorPlugin, undoPlugin, undo, redo } from '@client/editor/collab';
import { assemblePlugins, editorViewProps, editorAttributes, dispatchTransactionProp, installEditorDom } from '@client/editor/assembly';
import { isMarkdownDoc } from '@client/editor/markdown';
import { inkPlugin } from '@client/editor/plugins/ink';
import { getPrefs, subscribePrefs } from '@client/prefs';
import { editorSessions } from './editorSession';
import { documentModel, mergeModels, sameModel, SyncLedger, type DocumentModel, type SyncTag } from '../shared/documentModel';

export interface LocalEditorHandle {
  view: EditorView;
  ydoc: Y.Doc;
  /**
   * Apply content that arrived from the host (as a diff: unchanged paragraphs keep identity), merged
   * against the model of the update it acknowledges so that later local changes survive.
   */
  applyExternal(pmDoc: unknown, headerLines: string[], ack?: SyncTag | null): string[];
  /** Only user changes since the last received/sent model need to be written back; numbered for the host's acknowledgement. */
  takeUpdate(headerLines: string[]): (DocumentModel & { base: DocumentModel; sync: SyncTag }) | null;
  destroy(preserveSession?: boolean): void;
}

export interface LocalEditorOptions {
  docId: string;
  container: HTMLElement;
  pmDoc: unknown;
  headerLines: string[];
  marginMode?: boolean;
  child?: boolean;
  /** the mode switch's Viewing: no edits (checked on every transaction; call view.setProps({}) when it changes) */
  readOnly?: () => boolean;
  onSelectionChange?: (view: EditorView, info: { docChanged: boolean }) => void;
  onDocChange?: (view: EditorView) => void;
}

const EXTERNAL_ORIGIN = 'vscode-file';

export function createLocalEditor(opts: LocalEditorOptions): LocalEditorHandle {
  let session = editorSessions.get(opts.docId);
  if (!session) {
    const ydoc = new Y.Doc();
    ydoc.transact(() => { writeDocument(schema, ydoc, schema.nodeFromJSON(opts.pmDoc)); }, EXTERNAL_ORIGIN);
    const awareness = new Awareness(ydoc);
    awareness.setLocalStateField('user', { name: 'You', color: '#3b6ea5' });
    session = { ydoc, awareness, scrollTop: 0, headerLines: opts.headerLines, ledger: new SyncLedger(documentModel(opts.pmDoc, opts.headerLines)) };
    editorSessions.set(opts.docId, session);
  }
  const { ydoc, awareness } = session;
  // the binding and the editor state (with its undo history) outlive a refreshed view
  const collab = collabSync(ydoc, { binding: session.binding });
  session.binding = collab.binding;
  let viewRef: EditorView | null = null;

  const sync: Plugin[] = [
    collab.plugin,
    cursorPlugin(awareness),
    undoPlugin(),
    keymap({ 'Mod-z': undo, 'Mod-y': redo, 'Mod-Z': redo, 'Shift-Mod-z': redo }),
  ];
  const plugins = assemblePlugins({
    markdown: isMarkdownDoc(opts.docId),
    sync, marginMode: opts.marginMode ?? false,
    ink: opts.child ? null : inkPlugin(awareness), getView: () => viewRef,
    onUpdate: (view, info) => {
      opts.onSelectionChange?.(view, info);
      if (info.docChanged) opts.onDocChange?.(view);
    },
  });

  const state = session.state ? session.state.reconfigure({ plugins }) : EditorState.create({ schema, doc: collab.doc, plugins });
  const readOnly = () => opts.readOnly?.() ?? false;
  const attributes = (prefs: { spellcheck: boolean; spellEngine: string; showResolvedComments?: boolean }) => ({ ...editorAttributes(opts.child ?? false, prefs), 'data-doc-id': opts.docId, 'data-project': projectOfDoc(opts.docId), 'data-doc-dir': docDirOf(opts.docId) });
  const view: EditorView = new EditorView(opts.container, {
    state,
    dispatchTransaction: dispatchTransactionProp(() => view, readOnly),
    attributes: attributes(getPrefs()),
    editable: () => !readOnly(),
    ...editorViewProps({ docId: opts.docId, viewOnly: readOnly, onFocus: view => opts.onSelectionChange?.(view, { docChanged: false }) }),
  });
  viewRef = view;
  const unsubscribePrefs = subscribePrefs(p => { view.setProps({ attributes: attributes(p) }); });
  installEditorDom(view, opts.docId);

  const selection = session.selection ? Selection.fromJSON(view.state.doc, session.selection) : TextSelection.atStart(view.state.doc);
  view.dispatch(view.state.tr.setSelection(selection).setMeta('addToHistory', false));

  return {
    view, ydoc,
    applyExternal(pmDoc: unknown, headerLines: string[], ack?: SyncTag | null) {
      const incoming = documentModel(pmDoc, headerLines);
      const local = documentModel(view.state.doc.toJSON(), session!.headerLines!);
      const merged = mergeModels(session!.ledger.baseFor(ack), local, incoming);
      session!.ledger.applied(incoming);
      session!.headerLines = merged.headerLines;
      ydoc.transact(() => { writeDocument(schema, ydoc, schema.nodeFromJSON(merged.pmDoc)); }, EXTERNAL_ORIGIN);
      return merged.headerLines;
    },
    takeUpdate(headerLines: string[]) {
      const next = documentModel(view.state.doc.toJSON(), headerLines);
      const base = session!.ledger.base;
      if (sameModel(next, base)) return null;
      const sync = session!.ledger.send(next);
      session!.headerLines = next.headerLines;
      return { ...next, base, sync };
    },
    destroy(preserveSession = false) {
      session!.selection = view.state.selection.toJSON();
      session!.state = view.state;
      unsubscribePrefs();
      view.destroy();
      if (!preserveSession) {
        collab.destroy();
        awareness.destroy();
        ydoc.destroy();
        editorSessions.delete(opts.docId);
      }
    },
  };
}
