/**
 * Typing right after an inset that ends its paragraph (a footnote at the end of a sentence, a note …).
 * After Escape (or a click past the inset) the editor state has the cursor after the inset, but the
 * browser canonicalises a caret between an editable inline inset and the paragraph's trailing <br>
 * into the inset's inner paragraph — so the next characters would land inside the footnote (and every
 * later command would work on the wrong paragraph). When the two disagree that way, the text is
 * inserted through a transaction at the state's cursor instead; the new text node then anchors the
 * caret outside the inset and the browser follows.
 */
import { Plugin } from 'prosemirror-state';
import type { EditorView } from 'prosemirror-view';

/** The inset DOM the browser caret is in while the state cursor is directly after that inset (else null). */
function strayInset(view: EditorView): HTMLElement | null {
  const sel = view.state.selection;
  if (!sel.empty) return null;
  const before = sel.$from.nodeBefore;
  if (!before || before.type.name !== 'inset') return null;
  const dom = view.nodeDOM(sel.$from.pos - before.nodeSize) as HTMLElement | null;
  const ds = view.dom.ownerDocument.getSelection();
  return dom && ds?.anchorNode && dom.contains(ds.anchorNode) ? dom : null;
}

export function insetCaretPlugin(): Plugin {
  return new Plugin({
    props: {
      handleDOMEvents: {
        beforeinput(view, ev: InputEvent) {
          if (ev.inputType !== 'insertText' || !ev.data || !strayInset(view)) return false;
          ev.preventDefault();
          view.dispatch(view.state.tr.insertText(ev.data).scrollIntoView());
          return true;
        },
      },
    },
  });
}
