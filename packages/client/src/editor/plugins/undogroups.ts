/**
 * Undo steps that follow what one did, as in VS Code and Google Docs — not the clock. Yjs's undo
 * manager put everything done without a half-second pause into one step: a whole typed sentence, or
 * a formula with the words typed after it, went with one ⌘Z (11 Oct 2026, the user: "cmd z is not
 * working well"). A step now ends after each word (the space or punctuation that ends it belongs to
 * it), and whenever the kind of edit changes: typing, deleting, Enter, formatting, pasting, a
 * formula (all of one formula's edits are one step here — inside it, its own undo goes keystroke
 * group by keystroke group, lyxmath/field.ts). A pause still ends a step too.
 */
import { Plugin, type Transaction } from 'prosemirror-state';
import { ReplaceStep } from 'prosemirror-transform';
import { yUndoPluginKey, ySyncPluginKey } from 'y-prosemirror';

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
  return new Plugin({
    appendTransaction(trs, _old, state) {
      for (const tr of trs) {
        if (!tr.docChanged) continue;
        // the other side's edits (and the agents') are not this person's steps
        if (tr.getMeta(ySyncPluginKey)?.isChangeOrigin || tr.getMeta('addToHistory') === false) continue;
        const k = kindOf(tr);
        // a word and the space after it are one step; anything else that differs from the step so far
        // starts a new one — before this transaction reaches Yjs (the sync runs after the state update)
        const together = k === last && k !== 'other' || (last === 'word' && k === 'gap');
        if (last !== null && !together) {
          try { (yUndoPluginKey.getState(state) as { undoManager?: { stopCapturing(): void } } | undefined)?.undoManager?.stopCapturing(); } catch { /* no undo manager */ }
        }
        last = k;
      }
      return null;
    },
  });
}
