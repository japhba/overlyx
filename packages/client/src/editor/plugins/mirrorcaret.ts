/**
 * A visible stand-in for the document selection while the keyboard is elsewhere: the source pane
 * mirrors the caret (or the selected range) of its LaTeX text into the document (cursor sync),
 * but a blurred editor does not draw its selection — so a thin bar is drawn at the head and the
 * range is tinted instead. It maps through edits, disappears when the editor gets the focus back,
 * and is set with `setMirrorCaret`.
 */
import { Plugin, PluginKey } from 'prosemirror-state';
import { Decoration, DecorationSet, type EditorView } from 'prosemirror-view';

/** the mirrored selection: `from`..`to` tinted (equal for a bare caret), the bar at `head` */
export interface MirrorSelection { from: number; to: number; head: number }
type MirrorState = MirrorSelection | null;

export const mirrorCaretKey = new PluginKey<MirrorState>('mirrorCaret');

export function mirrorCaretPlugin(): Plugin<MirrorState> {
  return new Plugin<MirrorState>({
    key: mirrorCaretKey,
    state: {
      init: () => null,
      apply(tr, prev) {
        const m = tr.getMeta(mirrorCaretKey) as MirrorState | undefined;
        if (m !== undefined) return m;
        if (prev === null) return null;
        if (!tr.docChanged) return prev;
        return { from: tr.mapping.map(prev.from, -1), to: tr.mapping.map(prev.to, 1), head: tr.mapping.map(prev.head) };
      },
    },
    props: {
      decorations(state) {
        const m = this.getState(state);
        if (!m) return null;
        const size = state.doc.content.size;
        const head = Math.min(m.head, size), from = Math.min(m.from, size), to = Math.min(m.to, size);
        const decos = [Decoration.widget(head, () => { const el = document.createElement('span'); el.className = 'mirror-caret'; return el; }, { side: -1, key: 'mirror-caret-' + head })];
        if (to > from) decos.push(Decoration.inline(from, to, { class: 'mirror-selection' }));
        return DecorationSet.create(state.doc, decos);
      },
      handleDOMEvents: {
        focus: (view) => { if (mirrorCaretKey.getState(view.state) !== null) setMirrorCaret(view, null); return false; },
      },
    },
  });
}

/** show the mirror caret at `pos` — a number for a bare caret, a range with its head for a selection; null hides it. No history entry, no cursor change. */
export function setMirrorCaret(view: EditorView, pos: number | MirrorSelection | null): void {
  const next: MirrorState = pos === null ? null : typeof pos === 'number' ? { from: pos, to: pos, head: pos } : pos;
  const cur = mirrorCaretKey.getState(view.state);
  if (cur === next || (cur && next && cur.from === next.from && cur.to === next.to && cur.head === next.head)) return;
  view.dispatch(view.state.tr.setMeta(mirrorCaretKey, next).setMeta('addToHistory', false));
}
