/**
 * Fonts continue across inline insets. Marks on non-text nodes (formulas, citations, references …) live in
 * their `marks` attr (y-prosemirror drops real marks on them), so ProseMirror reports no marks right after
 * such a node and typing there would fall out of an \emph{…} run. When the cursor comes to rest directly
 * after an inline node carrying font marks, those become the stored marks — as in LyX, where the cursor
 * takes the font of what is before it.
 */
import { Plugin } from 'prosemirror-state';
import { fontMarksOf } from '../commands';

export function fontCarryPlugin(): Plugin {
  return new Plugin({
    appendTransaction(trs, _old, state) {
      if (!trs.some(tr => tr.selectionSet) || state.storedMarks || !state.selection.empty) return null;
      const $from = state.selection.$from;
      if (!$from.parent.isTextblock || $from.textOffset) return null;
      const before = $from.nodeBefore;
      if (!before || before.isText) return null;
      const marks = fontMarksOf(before);
      return marks.length ? state.tr.setStoredMarks(marks) : null;
    },
  });
}
