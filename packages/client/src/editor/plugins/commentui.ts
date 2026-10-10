/**
 * Comment threads while writing: the thread that holds the cursor is marked `cm-active` (its card
 * opens — a popover under its chip in the text, the highlighted card in the margin; styles.css,
 * plugins/margin.ts places it), Ctrl+Enter leaves the thread as Escape does, and a message left
 * empty goes away when the cursor leaves the thread: the reply just started, or the whole thread
 * when nothing was written into a new comment. Only the user's own messages are taken away, and
 * only by a move of their own cursor (a remote update never deletes anything here).
 */
import type { Node as PMNode } from 'prosemirror-model';
import { Plugin, PluginKey, TextSelection, type EditorState, type Transaction } from 'prosemirror-state';
import { Decoration, DecorationSet } from 'prosemirror-view';
import { parseHeader } from '@overlyx/core';
import { isCommentNode } from '../commentops';
import { editorContext } from '../context';

export const commentUiKey = new PluginKey('ol-comment-ui');

/** the comment thread around a position (the innermost; threads do not nest) */
export function threadAt(state: EditorState, pos: number): { pos: number; node: PMNode } | null {
  const $p = state.doc.resolve(pos);
  for (let d = $p.depth; d > 0; d--) {
    const n = $p.node(d);
    if (isCommentNode(n)) return { pos: $p.before(d), node: n };
  }
  return null;
}

/**
 * What to take away from a thread the cursor left: its last message when that is the user's own and
 * empty — the whole thread when it was the only one. null: nothing.
 */
export function emptyTail(node: PMNode, me: string): { from: number; to: number } | 'thread' | null {
  const paras: { node: PMNode; offset: number }[] = [];
  node.forEach((p, offset) => paras.push({ node: p, offset }));
  let last = -1;
  for (let i = paras.length - 1; i >= 0; i--) if (parseHeader(paras[i].node.textContent.trim())) { last = i; break; }
  if (last < 0) return null;
  const h = parseHeader(paras[last].node.textContent.trim())!;
  if (h.author !== me) return null;
  if (paras.slice(last + 1).some(p => p.node.content.size > 0)) return null;
  if (!paras.slice(0, last).some(p => parseHeader(p.node.textContent.trim()))) return 'thread';
  // positions inside the inset: +1 for its opening token
  return { from: 1 + paras[last].offset, to: node.content.size + 1 };
}

export function commentUiPlugin(): Plugin {
  return new Plugin({
    key: commentUiKey,
    props: {
      decorations(state) {
        const t = threadAt(state, state.selection.head);
        return t ? DecorationSet.create(state.doc, [Decoration.node(t.pos, t.pos + t.node.nodeSize, { class: 'cm-active' })]) : null;
      },
      handleKeyDown(view, ev) {
        if (ev.key !== 'Enter' || !(ev.ctrlKey || ev.metaKey) || ev.altKey || ev.shiftKey) return false;
        const t = threadAt(view.state, view.state.selection.head);
        if (!t) return false;
        // Ctrl+Enter: done — back into the text, right after the thread's marker
        view.dispatch(view.state.tr.setSelection(TextSelection.near(view.state.doc.resolve(t.pos + t.node.nodeSize))).scrollIntoView());
        return true;
      },
    },
    appendTransaction(trs: readonly Transaction[], oldState, newState) {
      if (!trs.some(tr => tr.selectionSet) || trs.some(tr => tr.getMeta('y-sync$'))) return null;
      const before = threadAt(oldState, oldState.selection.head);
      if (!before) return null;
      let pos = before.pos;
      for (const tr of trs) {
        const r = tr.mapping.mapResult(pos, 1);
        if (r.deleted) return null;
        pos = r.pos;
      }
      if (threadAt(newState, newState.selection.head)?.pos === pos) return null;   // still inside
      const node = newState.doc.nodeAt(pos);
      if (!node || !isCommentNode(node)) return null;
      const me = editorContext.user?.name;
      if (!me) return null;
      const cut = emptyTail(node, me);
      if (!cut) return null;
      const tr = newState.tr;
      if (cut === 'thread') tr.delete(pos, pos + node.nodeSize);
      else tr.delete(pos + cut.from, pos + cut.to);
      return tr;
    },
  });
}
