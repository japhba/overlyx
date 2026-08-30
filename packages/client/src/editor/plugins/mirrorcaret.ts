/**
 * A visible stand-in for the document cursor while the keyboard is elsewhere: the source pane
 * mirrors the caret of its LaTeX text into the document (cursor sync), but a blurred editor does
 * not draw its selection — so a thin bar is drawn at that position instead. It maps through
 * edits, disappears when the editor gets the focus back, and is set with `setMirrorCaret`.
 */
import { Plugin, PluginKey } from 'prosemirror-state';
import { Decoration, DecorationSet, type EditorView } from 'prosemirror-view';

export const mirrorCaretKey = new PluginKey<number | null>('mirrorCaret');

export function mirrorCaretPlugin(): Plugin<number | null> {
  return new Plugin<number | null>({
    key: mirrorCaretKey,
    state: {
      init: () => null,
      apply(tr, prev) {
        const m = tr.getMeta(mirrorCaretKey) as number | null | undefined;
        if (m !== undefined) return m;
        if (prev === null) return null;
        return tr.docChanged ? tr.mapping.map(prev) : prev;
      },
    },
    props: {
      decorations(state) {
        const pos = this.getState(state);
        if (pos === null || pos === undefined) return null;
        const at = Math.min(pos, state.doc.content.size);
        return DecorationSet.create(state.doc, [Decoration.widget(at, () => { const el = document.createElement('span'); el.className = 'mirror-caret'; return el; }, { side: -1, key: 'mirror-caret-' + at })]);
      },
      handleDOMEvents: {
        focus: (view) => { if (mirrorCaretKey.getState(view.state) !== null) setMirrorCaret(view, null); return false; },
      },
    },
  });
}

/** show the mirror caret at `pos` (null hides it); no history entry, no cursor change */
export function setMirrorCaret(view: EditorView, pos: number | null): void {
  if (mirrorCaretKey.getState(view.state) === pos) return;
  view.dispatch(view.state.tr.setMeta(mirrorCaretKey, pos).setMeta('addToHistory', false));
}
