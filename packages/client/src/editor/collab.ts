/**
 * The editor bound to its document's CRDT (model 2, @overlyx/core collab): the ProseMirror plugins
 * the front ends put first — the sync, the collaborators' cursors, and undo.
 *
 * - sync (collabSync): the editor's changes go into the CRDT with their steps' mapping (typed text
 *   goes exactly where it was typed); changes from elsewhere come in as steps that replace just what
 *   changed, tagged with `ySyncPluginKey` ({ isChangeOrigin: true }) and kept out of the undo history
 *   (an agent's edit excepted: Ctrl+Z reverts it like one's own). The CRDT is the truth: should a
 *   write not read back as written, the editor takes the CRDT's reading.
 * - cursors (cursorPlugin): one's own selection is published in the awareness as two Yjs relative
 *   positions ({ anchor, head }); everybody else's are drawn as decorations.
 * - undo (undoPlugin, undo, redo): ProseMirror's history. Undoing is a local change like any other,
 *   mapped over what others did meanwhile: it never brings back text somebody else has since
 *   joined or moved, and restores deleted text in one piece.
 */
import { Plugin, PluginKey, type EditorState, type Transaction, type Command } from 'prosemirror-state';
import { Decoration, DecorationSet, type EditorView } from 'prosemirror-view';
import type { Node as PMNode } from 'prosemirror-model';
import { history, undo as historyUndo, redo as historyRedo, closeHistory, undoDepth, redoDepth } from 'prosemirror-history';
import * as Y from 'yjs';
import type { Awareness } from 'y-protocols/awareness';
import { schema } from '@overlyx/core';
import { Binding, remoteTransaction, relativePosition, documentPosition, type RemoteChange } from '@overlyx/core/collab/index.ts';

// ---------------------------------------------------------------- sync

export interface SyncState {
  doc: Y.Doc;
  binding: Binding;
  /** the last transaction came from the CRDT (node views ask while it updates them) */
  isChangeOrigin: boolean;
  isUndoRedoOperation: false;
}
export interface SyncMeta { isChangeOrigin: true; isUndoRedoOperation: false; origin: unknown }

/** the sync plugin's key: its state is the CRDT and the binding; changes from the CRDT carry it as meta */
export const ySyncPluginKey = new PluginKey<SyncState>('y-sync');

export interface SyncOptions {
  /** origin of an agent's edits (they go into the undo history) */
  agentOrigin?: unknown;
  /** a binding kept from an earlier view of the same document (VS Code keeps the session when the view is re-created) */
  binding?: Binding;
  /** a write did not read back as written (reported; the editor takes the CRDT's reading) */
  onMismatch?: (wrote: PMNode, reads: PMNode) => void;
}

/**
 * The sync of an editor with `ydoc`: the plugin, and the document to create the editor state with
 * (what the CRDT reads as now).
 */
export function collabSync(ydoc: Y.Doc, opts: SyncOptions = {}): { plugin: Plugin; doc: PMNode; binding: Binding; destroy(): void } {
  let view: EditorView | null = null;
  /** a change that came before the view existed: applied once it does */
  let missed: { reading: PMNode; origin: unknown } | null = null;
  const apply = (reading: PMNode, origin: unknown, change: RemoteChange | null = null) => {
    if (!view || view.isDestroyed) { missed = { reading, origin }; return; }
    const tr = remoteTransaction(view.state, reading, origin, change);
    const meta: SyncMeta = { isChangeOrigin: true, isUndoRedoOperation: false, origin };
    tr.setMeta(ySyncPluginKey, meta);
    if (opts.agentOrigin !== undefined && origin === opts.agentOrigin) tr.setMeta('addToHistory', true);
    view.dispatch(tr);
  };
  const handlers = {
    onRemote: (reading: PMNode, change: RemoteChange) => apply(reading, change.ytr.origin, change),
    onMismatch: (wrote: PMNode, reads: PMNode) => {
      console.error('[collab] a change did not read back as written; the document follows the shared state');
      opts.onMismatch?.(wrote, reads);
    },
  };
  const binding = opts.binding ?? new Binding(schema, ydoc, { origin: ySyncPluginKey });
  binding.setHandlers(handlers);
  const plugin = new Plugin<SyncState>({
    key: ySyncPluginKey,
    state: {
      init: () => ({ doc: ydoc, binding, isChangeOrigin: false, isUndoRedoOperation: false }),
      apply: (tr, v) => {
        const remote = !!(tr.getMeta(ySyncPluginKey) as SyncMeta | undefined)?.isChangeOrigin;
        if (remote === v.isChangeOrigin || (!remote && !tr.docChanged)) return v;
        return { ...v, isChangeOrigin: remote };
      },
    },
    appendTransaction(trs) { binding.noteTransactions(trs); return null; },
    view(v) {
      view = v;
      // the CRDT changed between reading the document and creating the view (the local copy loading)
      if (missed) queueMicrotask(() => { const m = missed; missed = null; if (m && view && binding.latest) apply(binding.latest, m.origin); });
      return {
        update: (v2) => { if (v2.state.doc !== binding.doc) binding.flush(v2.state.doc); },
        // the binding stays (the editor's handle destroys it; a kept session reuses it)
        destroy: () => { if (view === v) view = null; },
      };
    },
  });
  return { plugin, doc: binding.doc, binding, destroy: () => binding.destroy() };
}

/** the CRDT and binding of an editor (null: not a synced editor) */
export function syncOf(state: EditorState): SyncState | null {
  return ySyncPluginKey.getState(state) ?? null;
}

/** the transaction came from the CRDT (somebody else, an agent, a reload) */
export const isRemote = (tr: Transaction): boolean => !!(tr.getMeta(ySyncPluginKey) as SyncMeta | undefined)?.isChangeOrigin;

// ---------------------------------------------------------------- undo

/** ProseMirror's history, as the editors' undo */
export function undoPlugin(): Plugin {
  return history({ newGroupDelay: 500 });
}

const undoListeners = new Set<(kind: 'undo' | 'redo') => void>();
/** called after each undo / redo (usage statistics) */
export function onUndoRedo(f: (kind: 'undo' | 'redo') => void): () => void { undoListeners.add(f); return () => undoListeners.delete(f); }

export const undo: Command = (state, dispatch, view) => {
  const ok = historyUndo(state, dispatch, view);
  if (ok && dispatch) for (const f of undoListeners) f('undo');
  return ok;
};
export const redo: Command = (state, dispatch, view) => {
  const ok = historyRedo(state, dispatch, view);
  if (ok && dispatch) for (const f of undoListeners) f('redo');
  return ok;
};
export { undoDepth, redoDepth };

/** The next change is an undo step of its own. */
export function closeUndoGroup(view: EditorView): void {
  if (!view.isDestroyed) view.dispatch(closeHistory(view.state.tr));
}

// ---------------------------------------------------------------- cursors

export const yCursorPluginKey = new PluginKey<DecorationSet>('yjs-cursor');

export interface CursorOptions {
  cursorBuilder?: (user: { name: string; color: string; agent?: unknown }, clientId: number) => HTMLElement;
  selectionBuilder?: (user: { name: string; color: string }, clientId: number) => Record<string, string>;
}

function defaultCursor(user: { name: string; color: string }): HTMLElement {
  const cursor = document.createElement('span');
  cursor.className = 'ProseMirror-yjs-cursor';
  cursor.style.borderColor = user.color;
  const label = document.createElement('div');
  label.style.backgroundColor = user.color;
  label.textContent = user.name;
  cursor.appendChild(label);
  return cursor;
}

/** Everybody else's carets and selections, and one's own published. */
export function cursorPlugin(awareness: Awareness, opts: CursorOptions = {}): Plugin<DecorationSet> {
  const build = opts.cursorBuilder ?? defaultCursor;
  const selection = opts.selectionBuilder ?? ((user: { color: string }) => ({ style: `background-color: ${user.color}70`, class: 'ProseMirror-yjs-selection' }));
  const decorations = (state: EditorState): DecorationSet => {
    const sync = syncOf(state);
    if (!sync) return DecorationSet.empty;
    const { doc } = state;
    const out: Decoration[] = [];
    awareness.getStates().forEach((st, clientId) => {
      if (clientId === sync.doc.clientID) return;
      const cursor = st?.cursor as { anchor?: unknown; head?: unknown } | null | undefined;
      const user = st?.user as { name: string; color: string; agent?: unknown } | undefined;
      if (!cursor || !user) return;
      let anchor: number | null, head: number | null;
      try {
        anchor = documentPosition(schema, sync.doc, doc, Y.createRelativePositionFromJSON(cursor.anchor));
        head = documentPosition(schema, sync.doc, doc, Y.createRelativePositionFromJSON(cursor.head));
      } catch { return; }
      if (anchor === null || head === null) return;
      const max = doc.content.size;
      anchor = Math.min(anchor, max); head = Math.min(head, max);
      out.push(Decoration.widget(head, () => build(user, clientId), { key: String(clientId), side: 10 }));
      if (anchor !== head) {
        const from = Math.min(anchor, head), to = Math.max(anchor, head);
        out.push(Decoration.inline(from, to, selection(user, clientId), { inclusiveEnd: true, inclusiveStart: false }));
      }
    });
    return DecorationSet.create(doc, out);
  };
  return new Plugin<DecorationSet>({
    key: yCursorPluginKey,
    state: {
      init: (_c, state) => decorations(state),
      apply: (tr, prev, _old, state) => (tr.docChanged || tr.getMeta(yCursorPluginKey) ? decorations(state) : prev),
    },
    props: { decorations: state => yCursorPluginKey.getState(state) },
    view(view) {
      let last = '';
      const publish = () => {
        if (view.isDestroyed) return;
        const sync = syncOf(view.state);
        if (!sync) return;
        const current = awareness.getLocalState()?.cursor ?? null;
        if (!view.hasFocus()) {
          if (current !== null) { last = ''; awareness.setLocalStateField('cursor', null); }
          return;
        }
        const { anchor, head } = view.state.selection;
        const a = relativePosition(schema, sync.doc, view.state.doc, anchor, anchor > head ? -1 : 0);
        const h = relativePosition(schema, sync.doc, view.state.doc, head, head > anchor ? -1 : 0);
        if (!a || !h) return;
        const next = { anchor: Y.relativePositionToJSON(a), head: Y.relativePositionToJSON(h) };
        const key = JSON.stringify(next);
        if (key === last && current) return;
        last = key;
        awareness.setLocalStateField('cursor', next);
      };
      // others' states changed: draw them again (not inside a dispatch)
      let scheduled = false;
      const changed = ({ added, updated, removed }: { added: number[]; updated: number[]; removed: number[] }) => {
        const own = awareness.clientID;
        if (![...added, ...updated, ...removed].some(id => id !== own) || scheduled) return;
        scheduled = true;
        setTimeout(() => { scheduled = false; if (!view.isDestroyed) view.dispatch(view.state.tr.setMeta(yCursorPluginKey, true)); }, 0);
      };
      awareness.on('change', changed);
      view.dom.addEventListener('focusin', publish);
      view.dom.addEventListener('focusout', publish);
      return {
        update: (_v, prev) => { if (prev.selection !== view.state.selection || prev.doc !== view.state.doc) publish(); },
        destroy: () => {
          awareness.off('change', changed);
          view.dom.removeEventListener('focusin', publish);
          view.dom.removeEventListener('focusout', publish);
        },
      };
    },
  });
}

/** Another client's caret position in this editor's document (null: none, or not in this document). */
export function cursorPosition(state: EditorState, awareness: Awareness, clientId: number): number | null {
  const sync = syncOf(state);
  const st = awareness.getStates().get(clientId) as { cursor?: { head?: unknown } } | undefined;
  if (!sync || !st?.cursor?.head) return null;
  try {
    const pos = documentPosition(schema, sync.doc, state.doc, Y.createRelativePositionFromJSON(st.cursor.head));
    return pos === null ? null : Math.min(pos, state.doc.content.size);
  } catch { return null; }
}
