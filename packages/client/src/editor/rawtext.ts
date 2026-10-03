import type { EditorState } from 'prosemirror-state';

/** Inside raw LaTeX (ERT, listings) or a code-like paragraph, where every character is literal. */
export function inRawText(state: EditorState): boolean {
  const $from = state.selection.$from;
  for (let d = $from.depth; d > 0; d--) {
    const n = $from.node(d);
    if (n.type.name === 'inset' && (n.attrs.name === 'ERT' || n.attrs.name === 'listings')) return true;
    if (n.type.name === 'paragraph' && /^(LyX-Code|Verbatim\*?|Code)$/.test(String(n.attrs.layout))) return true;
  }
  return false;
}
