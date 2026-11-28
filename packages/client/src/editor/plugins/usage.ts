/**
 * Usage statistics inside the editor (src/usage.ts): a modifier combination that reached the end
 * of the plugin chain unhandled ("key-unbound" — the person expected something to happen and
 * nothing did), and undo / redo from the Yjs undo manager however they were triggered, so that an
 * action undone right away can be counted. Last in assembly.ts's plugin order on purpose.
 */
import { Plugin, NodeSelection, type Transaction } from 'prosemirror-state';
import type { EditorView } from 'prosemirror-view';
import type { Node as PMNode } from 'prosemirror-model';
import { onUndoRedo, isRemote } from '../collab';
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

/**
 * One editing key or clipboard event whose effect on the document is not known yet. It cannot be
 * read off right after the event: ProseMirror handles a key in a later listener of the same event,
 * most Backspaces in a text are the browser's own deletion (ProseMirror reads the DOM mutation that
 * follows the event), on iOS Enter is answered up to 200 ms later (prosemirror-view's lastIOSEnter
 * fallback), and a paste of LaTeX or of an image changes the document when the server has answered.
 * (Decided in a microtask of the capture listener, as until 28 Nov 2026, every key the browser
 * dispatched read "unchanged": the checkpoint comes before the next listener runs.)
 */
interface Observation {
  action: InteractionAction;
  state: InteractionState & { target: InteractionTarget };
  note?: PMNode;
  notePos?: number;
  /** asynchronous work of this action that is still running (awaitOutcome) */
  holds: number;
  timer: ReturnType<typeof setTimeout> | null;
}

/**
 * How long an action may take to show in the document before it counts as having done nothing:
 * above prosemirror-view's 200 ms iOS Enter fallback, the slowest synchronous path there is.
 */
const OUTCOME_GRACE_MS = 250;

interface Observer { observe(action: InteractionAction): void; hold(work: Promise<unknown>): void }
const observers = new WeakMap<EditorView, Observer>();

/**
 * The action being handled changes the document when `work` settles (a paste parsed on the server,
 * an image uploading): its outcome is recorded then, not when the grace period ends.
 */
export function awaitOutcome<T>(view: EditorView, work: Promise<T>): Promise<T> {
  observers.get(view)?.hold(work);
  return work;
}

/**
 * The outcomes of a view's editing actions: "changed" (for a note also "removed" / "emptied") with
 * the editor's own next change of the document — the plugin passes every transaction to `applied` —
 * and "unchanged" when the person goes on to the next action, or the grace period ends, without one.
 */
function outcomeObserver(view: EditorView): Observer & { applied(trs: readonly Transaction[], doc: PMNode): void; destroy(): void } {
  const open = new Set<Observation>();
  const conclude = (o: Observation, outcome: 'denied' | 'unchanged' | 'changed' | 'removed' | 'emptied') => {
    if (!open.delete(o)) return;
    if (o.timer) clearTimeout(o.timer);
    recordInteraction(o.action, outcome, o.state);
  };
  const expire = (o: Observation) => { o.timer = null; if (!o.holds) conclude(o, 'unchanged'); };
  return {
    observe(action) {
      if (!usageEnabled()) return;
      // the next action: whatever is still open (and not waiting for the server) did nothing
      for (const o of [...open]) if (!o.holds) conclude(o, 'unchanged');
      const { note, notePos, ...state } = editorInteractionState(view);
      const o: Observation = { action, state, note, notePos, holds: 0, timer: null };
      open.add(o);
      if (state.access === 'view') { conclude(o, 'denied'); return; }
      o.timer = setTimeout(() => expire(o), OUTCOME_GRACE_MS);
    },
    hold(work) {
      const o = [...open].at(-1);
      if (!o) return;
      o.holds++;
      const done = () => { o.holds--; if (!o.holds && !o.timer) conclude(o, 'unchanged'); };
      work.then(done, done);
    },
    applied(trs, doc) {
      if (!open.size || !trs.some(tr => tr.docChanged)) return;
      const own = trs.some(tr => tr.docChanged && !isRemote(tr));
      for (const o of [...open]) {
        if (o.notePos !== undefined) for (const tr of trs) o.notePos = tr.mapping.map(o.notePos, 1);
        if (!own) continue;   // somebody else's change is not this action's
        let outcome: 'changed' | 'removed' | 'emptied' = 'changed';
        if (o.note && o.notePos !== undefined) {
          const after = o.notePos < doc.content.size ? doc.nodeAt(o.notePos) : null;
          if (after?.type.name !== 'inset' || after.attrs.name !== 'Note') outcome = 'removed';
          else if (o.state.content === 'filled' && after.content.size <= 2) outcome = 'emptied';
        }
        conclude(o, outcome);
      }
    },
    destroy() { for (const o of open) if (o.timer) clearTimeout(o.timer); open.clear(); },
  };
}

export function usagePlugin(): Plugin {
  let observer: ReturnType<typeof outcomeObserver> | null = null;
  return new Plugin({
    props: {
      handleKeyDown(_view, ev) {
        const label = unboundKeyLabel(ev);
        if (label) recordUsage('key-unbound', label);
        return false;
      },
    },
    // (sees every transaction that was applied, the ones other plugins appended included)
    appendTransaction(trs, _old, state) { observer?.applied(trs, state.doc); return null; },
    view(view) {
      const o = observer = outcomeObserver(view);
      observers.set(view, o);
      const key = (ev: KeyboardEvent) => {
        // a key the input method takes (it composes, or confirms a composition) is not an editing key
        if (ev.isComposing || ev.keyCode === 229) return;
        const action = ev.key === 'Backspace' ? 'backspace' : ev.key === 'Delete' ? 'delete' : ev.key === 'Enter' ? 'enter' : ev.key === 'Escape' ? 'escape' : null;
        if (action) o.observe(action);
      };
      const paste = () => o.observe('paste'), cut = () => o.observe('cut'), drop = () => o.observe('drop');
      view.dom.addEventListener('keydown', key, true);
      view.dom.addEventListener('paste', paste, true);
      view.dom.addEventListener('cut', cut, true);
      view.dom.addEventListener('drop', drop, true);
      const off = onUndoRedo(kind => recordUsage(kind));
      return { destroy() {
        off();
        o.destroy(); observers.delete(view); if (observer === o) observer = null;
        view.dom.removeEventListener('keydown', key, true); view.dom.removeEventListener('paste', paste, true);
        view.dom.removeEventListener('cut', cut, true); view.dom.removeEventListener('drop', drop, true);
      } };
    },
  });
}
