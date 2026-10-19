/**
 * Undo steps that follow what one did, as in VS Code and Google Docs — not the clock. An undo that
 * groups by time put everything done without a half-second pause into one step: a whole typed
 * sentence, or a formula with the words typed after it, went with one ⌘Z (11 Oct 2026, the user:
 * "cmd z is not working well"). A step now ends after each word (the space or punctuation that ends
 * it belongs to it), and whenever the kind of edit changes: typing, deleting, Enter, formatting,
 * pasting, a formula (all of one formula's edits are one step here — inside it, its own undo goes
 * keystroke group by keystroke group, lyxmath/field.ts). A pause still ends a step too.
 *
 * The undo is ProseMirror's history (editor/collab.ts); a transaction that starts a new step is
 * marked (closeHistory) before the history records it — in filterTransaction, which sees every
 * transaction before any plugin applies it.
 */
import { Plugin, type Transaction } from 'prosemirror-state';
import type { EditorView } from 'prosemirror-view';
import { ReplaceStep } from 'prosemirror-transform';
import { closeHistory } from 'prosemirror-history';
import { isRemote } from '../collab';

/** meta of the transaction a formula field commits (nodeviews/math.ts): the formula's position */
export const FORMULA_EDIT = 'lyx-formula-edit';

type Kind = 'word' | 'gap' | 'delete' | `formula:${number}` | 'other';

function kindOf(tr: Transaction): Kind {
  const f = tr.getMeta(FORMULA_EDIT);
  if (typeof f === 'number') return `formula:${f}`;
  if (tr.steps.length === 1 && tr.steps[0] instanceof ReplaceStep) {
    const st = tr.steps[0] as ReplaceStep & { from: number; to: number };
    const ins = st.slice.content;
    if (st.to === st.from && ins.childCount === 1 && ins.firstChild!.isText) {
      const t = ins.firstChild!.text!;
      if ([...t].length === 1) return /[\s.,;:!?)\]}"'”’»]/u.test(t) ? 'gap' : 'word';
    }
    if (st.to > st.from && st.slice.size === 0) return 'delete';
  }
  return 'other';
}

export function undoGroupsPlugin(): Plugin {
  let last: Kind | null = null;
  let editor: EditorView | null = null;
  return new Plugin({
    view(v) { editor = v; return { destroy: () => { if (editor === v) editor = null; } }; },
    filterTransaction(tr, state) {
      // a plugin's transaction appended to one is undone with it: it is filtered against the state
      // that one made, which the editor does not show yet (its appendedTransaction meta comes later)
      if (!tr.docChanged || (editor && state !== editor.state)) return true;
      // the other side's edits (and the agents') are not this person's steps
      if (isRemote(tr) || tr.getMeta('addToHistory') === false) return true;
      const k = kindOf(tr);
      // a word and the space after it are one step; anything else that differs from the step so far starts a new one
      const together = k === last && k !== 'other' || (last === 'word' && k === 'gap');
      if (last !== null && !together) closeHistory(tr);
      last = k;
      return true;
    },
  });
}
