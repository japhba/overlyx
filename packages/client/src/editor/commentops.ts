/**
 * Comment threads in the editor (Note Comment insets, see core/comments.ts for the convention):
 * finding them, jumping to one, marking one resolved / reopening it. Used by the inset node view
 * (the card's buttons) and by the Comments panel (app/Comments.tsx).
 */
import type { Node as PMNode } from 'prosemirror-model';
import { TextSelection } from 'prosemirror-state';
import type { EditorView } from 'prosemirror-view';
import { parseHeader, commentHeader, formatTimestamp } from '@overlyx/core';
import { editorContext } from './context';

export interface CommentInfo {
  view: EditorView;
  /** position of the inset node */
  pos: number;
  author: string;
  time: string;
  resolved: boolean;
  /** the first message (plain text, trimmed) */
  text: string;
  /** number of replies (header paragraphs after the first) */
  replies: number;
}

export const isCommentNode = (n: PMNode): boolean => n.type.name === 'inset' && n.attrs.name === 'Note' && n.attrs.arg === 'Comment';

/** every comment thread of a view, in document order */
export function collectComments(view: EditorView): CommentInfo[] {
  const out: CommentInfo[] = [];
  view.state.doc.descendants((n, pos) => {
    if (!isCommentNode(n)) return true;
    const paras: string[] = [];
    n.forEach(p => paras.push(p.textContent));
    const h = paras.length ? parseHeader(paras[0].trim()) : null;
    let text = '';
    let replies = 0;
    for (let i = h ? 1 : 0; i < paras.length; i++) {
      if (parseHeader(paras[i].trim())) { replies++; continue; }
      if (!replies && paras[i].trim()) text += (text ? ' ' : '') + paras[i].trim();
    }
    out.push({ view, pos, author: h?.author ?? '', time: h?.time ?? '', resolved: !!h?.resolved, text, replies });
    return false;   // threads do not nest
  });
  return out;
}

/** put the cursor into the thread and show it (the card flashes) */
export function gotoComment(view: EditorView, pos: number): void {
  const n = view.state.doc.nodeAt(pos);
  if (!n || !isCommentNode(n)) return;
  view.dispatch(view.state.tr.setSelection(TextSelection.near(view.state.doc.resolve(pos + 2))).scrollIntoView());
  view.focus();
  const dom = view.nodeDOM(pos) as HTMLElement | null;
  if (dom) {
    dom.classList.add('highlight');
    setTimeout(() => dom.classList.remove('highlight'), 1200);
    (dom.querySelector(':scope > .inset-box') as HTMLElement | null)?.scrollIntoView?.({ block: 'center', inline: 'nearest' });
  }
}

/** mark the thread at `pos` resolved / open again (a plain LyX comment first gets a header, so it becomes a thread) */
export function setCommentResolved(view: EditorView, pos: number, resolved: boolean): void {
  const cur = view.state.doc.nodeAt(pos);
  if (!cur || !isCommentNode(cur) || !cur.firstChild) return;
  const first = cur.firstChild;
  const h = parseHeader(first.textContent.trim());
  const schema = view.state.schema;
  const user = editorContext.user?.name ?? 'Anonymous';
  if (!h) {
    const header = schema.nodes.paragraph.create({ layout: 'Plain Layout' }, schema.text(commentHeader(user, formatTimestamp(), resolved)));
    view.dispatch(view.state.tr.insert(pos + 1, header));
    return;
  }
  if (h.resolved === resolved) return;
  const para = schema.nodes.paragraph.create(first.attrs, schema.text(commentHeader(h.author, h.time, resolved)));
  view.dispatch(view.state.tr.replaceWith(pos + 1, pos + 1 + first.nodeSize, para));
}
export function toggleCommentResolved(view: EditorView, pos: number): void {
  const cur = view.state.doc.nodeAt(pos);
  if (!cur || !cur.firstChild) return;
  const h = parseHeader(cur.firstChild.textContent.trim());
  setCommentResolved(view, pos, !(h?.resolved ?? false));
}
