/**
 * The OverLyX editor without a server: the web client's editor assembly (@client/editor/assembly —
 * plugins, node views, view props) on a purely local Y.Doc — no WebSocket provider, no IndexedDB,
 * no presence. The document comes in as ProseMirror JSON from the extension host (which parsed
 * the .tex file) and leaves as ProseMirror JSON after each change; external file changes are
 * applied as a Yjs diff so the cursor and unsynced edits survive.
 *
 * Nothing about editing itself is defined here: what the editor does is assembly.ts's business,
 * so that the web client and this extension cannot drift apart (tests/parity.test.ts).
 */
import { EditorState, TextSelection } from 'prosemirror-state';
import { EditorView } from 'prosemirror-view';
import * as Y from 'yjs';
import { Awareness } from 'y-protocols/awareness';
import { ySyncPlugin, yCursorPlugin, yUndoPlugin, initProseMirrorDoc, prosemirrorJSONToYXmlFragment } from 'y-prosemirror';
import { schema } from '@overlyx/core';
import { assemblePlugins, editorViewProps, editorAttributes, dispatchTransactionProp, installEditorDom } from '@client/editor/assembly';
import { getPrefs, subscribePrefs } from '@client/prefs';

export interface LocalEditorHandle {
  view: EditorView;
  ydoc: Y.Doc;
  /** apply new content that arrived from the file (as a diff: unchanged paragraphs keep identity) */
  applyExternal(pmDoc: unknown): void;
  destroy(): void;
}

export interface LocalEditorOptions {
  docId: string;
  container: HTMLElement;
  pmDoc: unknown;
  marginMode?: boolean;
  onSelectionChange?: (view: EditorView, info: { docChanged: boolean }) => void;
  onDocChange?: (view: EditorView, info: { external: boolean }) => void;
}

const EXTERNAL_ORIGIN = 'vscode-file';

export function createLocalEditor(opts: LocalEditorOptions): LocalEditorHandle {
  const ydoc = new Y.Doc();
  const fragment = ydoc.getXmlFragment('prosemirror');
  ydoc.transact(() => { prosemirrorJSONToYXmlFragment(schema, opts.pmDoc, fragment); }, EXTERNAL_ORIGIN);
  const awareness = new Awareness(ydoc);
  awareness.setLocalStateField('user', { name: 'You', color: '#3b6ea5' });

  const { doc: initialDoc, mapping } = initProseMirrorDoc(fragment, schema);
  let viewRef: EditorView | null = null;
  let applyingExternal = false;

  const plugins = assemblePlugins({
    sync: [ySyncPlugin(fragment, { mapping }), yCursorPlugin(awareness), yUndoPlugin()],
    marginMode: opts.marginMode ?? false,
    ink: null,   // margin ink lives in the collaboration awareness; there is none here
    getView: () => viewRef,
    onUpdate: (view, info) => {
      opts.onSelectionChange?.(view, { docChanged: info.docChanged });
      if (info.docChanged) opts.onDocChange?.(view, { external: applyingExternal });
    },
  });

  const state = EditorState.create({ schema, doc: initialDoc, plugins });
  const view: EditorView = new EditorView(opts.container, {
    state,
    dispatchTransaction: dispatchTransactionProp(() => view, () => false),
    attributes: editorAttributes(false, getPrefs()),
    ...editorViewProps({ docId: opts.docId }),
  });
  viewRef = view;
  const unsubscribePrefs = subscribePrefs(p => { view.setProps({ attributes: editorAttributes(false, p) }); });
  installEditorDom(view, opts.docId);

  // start with the cursor at the beginning
  try { view.dispatch(view.state.tr.setSelection(TextSelection.atStart(view.state.doc)).setMeta('addToHistory', false)); } catch { /* empty */ }

  return {
    view, ydoc,
    applyExternal(pmDoc: unknown) {
      applyingExternal = true;
      try { ydoc.transact(() => { prosemirrorJSONToYXmlFragment(schema, pmDoc, fragment); }, EXTERNAL_ORIGIN); }
      finally { applyingExternal = false; }
    },
    destroy() {
      unsubscribePrefs();
      view.destroy();
      awareness.destroy();
      ydoc.destroy();
    },
  };
}
