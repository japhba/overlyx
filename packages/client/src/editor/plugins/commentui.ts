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
import { getPrefs } from '../../prefs';

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

/** a thread marked resolved (its first message's header says so) */
export const isResolvedThread = (n: PMNode): boolean => isCommentNode(n) && !!parseHeader((n.firstChild?.textContent ?? '').trim())?.resolved;
const hidden = (n: PMNode | null | undefined): n is PMNode => !!n && !getPrefs().showResolvedComments && isResolvedThread(n);

/**
 * Resolved threads are not drawn in the text unless View ▸ Resolved comments in the text is on
 * (`showResolvedComments`: the editor's `show-resolved` class, styles.css): the caret goes past one
 * as past nothing — Backspace and Delete take the character beyond it, an arrow moves one character
 * on — and a cursor put inside one (resolving it, the Comments panel) waits right after it.
 */
export function hiddenThreadsPlugin(): Plugin {
  return new Plugin({
    props: {
      handleKeyDown(view, ev) {
        const dir = ev.key === 'Backspace' || ev.key === 'ArrowLeft' ? -1 : ev.key === 'Delete' || ev.key === 'ArrowRight' ? 1 : 0;
        if (!dir || getPrefs().showResolvedComments) return false;
        const sel = view.state.selection;
        const extend = ev.shiftKey && ev.key.startsWith('Arrow');
        if (!(sel instanceof TextSelection) || (!sel.empty && !extend)) return false;
        let p = sel.head;
        for (;;) {
          const $p = view.state.doc.resolve(p);
          const n = dir < 0 ? $p.nodeBefore : $p.nodeAfter;
          if (!hidden(n)) break;
          p += dir * n.nodeSize;
        }
        if (p === sel.head) return false;
        // past the hidden threads; the key then does what it does there
        view.dispatch(view.state.tr.setSelection(TextSelection.create(view.state.doc, extend ? sel.anchor : p, p)));
        return false;
      },
    },
    appendTransaction(trs, _old, state) {
      if (getPrefs().showResolvedComments || !trs.some(tr => tr.selectionSet || tr.docChanged)) return null;
      const $h = state.selection.$head;
      for (let d = 1; d <= $h.depth; d++) {
        if (hidden($h.node(d))) return state.tr.setSelection(TextSelection.near(state.doc.resolve($h.after(d))));
      }
      return null;
    },
  });
}
