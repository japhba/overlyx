/**
 * Usage statistics inside the editor (src/usage.ts): a modifier combination that reached the end
 * of the plugin chain unhandled ("key-unbound" — the person expected something to happen and
 * nothing did), and undo / redo from the Yjs undo manager however they were triggered, so that an
 * action undone right away can be counted. Last in assembly.ts's plugin order on purpose.
 */
import { Plugin, NodeSelection } from 'prosemirror-state';
import type { EditorView } from 'prosemirror-view';
import type { Node as PMNode } from 'prosemirror-model';
import { onUndoRedo } from '../collab';
import { recordUsage, unboundKeyLabel, recordInteraction, usageEnabled } from '../../usage';
import { editorContext } from '../context';
import type { InteractionAction, InteractionState, InteractionTarget } from '@overlyx/core/interactions.ts';

/** Snapshot categories only. Neither the note text nor its position is sent to the collector. */
export function editorInteractionState(view: EditorView): InteractionState & { target: InteractionTarget; notePos?: number; note?: PMNode } {
  const { selection, doc } = view.state;
  let found: { node: PMNode; pos: number } | null = null;
  const isNote = (n: PMNode | null | undefined) => n?.type.name === 'inset' && n.attrs.name === 'Note';
  for (let d = selection.$from.depth; d > 0; d--) if (isNote(selection.$from.node(d))) { found = { node: selection.$from.node(d), pos: selection.$from.before(d) }; break; }
  if (!found && isNote(selection.$from.nodeAfter)) found = { node: selection.$from.nodeAfter!, pos: selection.from };
  if (!found && isNote(selection.$from.nodeBefore)) found = { node: selection.$from.nodeBefore!, pos: selection.from - selection.$from.nodeBefore!.nodeSize };
  if (!found && !selection.empty) doc.nodesBetween(selection.from, selection.to, (n, pos) => { if (!found && isNote(n)) found = { node: n, pos }; return !found; });
  const node = (found as { node: PMNode; pos: number } | null)?.node;
  const target = node ? node.attrs.arg === 'Comment' ? 'comment' : node.attrs.arg === 'Greyedout' ? 'greyedout' : 'note' : 'text';
  return { target, selection: selection instanceof NodeSelection ? 'node' : selection.empty ? 'caret' : 'range',
    content: node ? node.content.size <= 2 ? 'empty' : 'filled' : 'none',
    display: node?.attrs.status === 'collapsed' ? 'collapsed' : node && view.dom.closest('.margin-mode') ? 'margin' : node ? 'inline' : 'none',
    access: view.editable ? 'edit' : 'view', tracking: editorContext.trackChanges ? 'on' : 'off',
    ...(node && found ? { note: node, notePos: (found as { pos: number }).pos } : {}) };
}

function observeAction(view: EditorView, action: InteractionAction): void {
  if (!usageEnabled()) return;
  const before = view.state.doc;
  const { note, notePos, ...state } = editorInteractionState(view);
  queueMicrotask(() => {
    if (view.isDestroyed) return;
    let outcome: 'denied' | 'unchanged' | 'changed' | 'removed' | 'emptied' = state.access === 'view' ? 'denied' : before.eq(view.state.doc) ? 'unchanged' : 'changed';
    if (outcome === 'changed' && note && notePos !== undefined) {
      const after = notePos <= view.state.doc.content.size ? view.state.doc.nodeAt(notePos) : null;
      if (after?.type.name !== 'inset' || after.attrs.name !== 'Note') outcome = 'removed';
      else if (state.content === 'filled' && after.content.size <= 2) outcome = 'emptied';
    }
    recordInteraction(action, outcome, state);
  });
}

export function usagePlugin(): Plugin {
  return new Plugin({
    props: {
      handleKeyDown(_view, ev) {
        const label = unboundKeyLabel(ev);
        if (label) recordUsage('key-unbound', label);
        return false;
      },
    },
    view(view) {
      const key = (ev: KeyboardEvent) => {
        const action = ev.key === 'Backspace' ? 'backspace' : ev.key === 'Delete' ? 'delete' : ev.key === 'Enter' ? 'enter' : ev.key === 'Escape' ? 'escape' : null;
        if (action) observeAction(view, action);
      };
      const paste = () => observeAction(view, 'paste'), cut = () => observeAction(view, 'cut'), drop = () => observeAction(view, 'drop');
      view.dom.addEventListener('keydown', key, true);
      view.dom.addEventListener('paste', paste, true);
      view.dom.addEventListener('cut', cut, true);
      view.dom.addEventListener('drop', drop, true);
      const off = onUndoRedo(kind => recordUsage(kind));
      return { destroy() {
        off();
        view.dom.removeEventListener('keydown', key, true); view.dom.removeEventListener('paste', paste, true);
        view.dom.removeEventListener('cut', cut, true); view.dom.removeEventListener('drop', drop, true);
      } };
    },
  });
}
