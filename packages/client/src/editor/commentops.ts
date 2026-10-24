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
import { allowCommentEdit, isMe } from './plugins/commentguard';

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

/** "Jan Bauer" → "JB", "kirsten" → "K": the avatar letters of a comment's author */
export function authorInitials(name: string): string {
  const words = name.trim().split(/[\s._-]+/).filter(Boolean);
  if (!words.length) return '?';
  const first = [...words[0]][0] ?? '?';
  const last = words.length > 1 ? [...words[words.length - 1]][0] ?? '' : '';
  return (first + last).toUpperCase();
}

/** a stable hue (0–359) for an author's avatar, the same on every machine */
export function authorHue(name: string): number {
  let h = 0;
  for (const ch of name.trim().toLowerCase()) h = (h * 31 + ch.codePointAt(0)!) >>> 0;
  return h % 360;
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

/** put the cursor into the thread (its card opens) and show it (the card flashes) */
export function gotoComment(view: EditorView, pos: number): void {
  const n = view.state.doc.nodeAt(pos);
  if (!n || !isCommentNode(n)) return;
  // the end of the thread's last message: its card opens (plugins/commentui.ts), ready to read on or reply
  view.dispatch(view.state.tr.setSelection(TextSelection.near(view.state.doc.resolve(pos + n.nodeSize - 2), -1)).scrollIntoView());
  view.focus();
  const dom = view.nodeDOM(pos) as HTMLElement | null;
  if (dom) {
    dom.classList.add('highlight');
    setTimeout(() => dom.classList.remove('highlight'), 1200);
    (dom.querySelector(':scope > .inset-box') as HTMLElement | null)?.scrollIntoView?.({ block: 'center', inline: 'nearest' });
  }
}

/**
 * This person's reply to the thread at `pos`: their header and an empty line at its end, the cursor
 * there — or, when the thread's last message is their own and still empty, the cursor goes to it.
 * 'unchanged' / 'changed': what happened; null: no thread there.
 */
export function replyToThread(view: EditorView, pos: number): 'unchanged' | 'changed' | null {
  const cur = view.state.doc.nodeAt(pos);
  if (!cur || !isCommentNode(cur)) return null;
  // the last message still has no text (a new thread's first one): the cursor goes there — a reply
  // below it left the first message blank, an empty "U1 13:41" above the comment (live co-editing test)
  const last = cur.lastChild;
  let lastHeader: string | null = null;
  cur.forEach(p => { const h = parseHeader(p.textContent.trim()); if (h) lastHeader = h.author; });
  if (last && cur.childCount > 1 && !last.textContent.trim() && lastHeader !== null && isMe(lastHeader)) {
    view.dispatch(view.state.tr.setSelection(TextSelection.create(view.state.doc, pos + cur.nodeSize - 1 - last.nodeSize + 1)));
    return 'unchanged';
  }
  const schema = view.state.schema;
  const user = editorContext.user?.name ?? 'Anonymous';
  const header = schema.nodes.paragraph.create({ layout: 'Plain Layout' }, schema.text(commentHeader(user, formatTimestamp())));
  const body = schema.nodes.paragraph.create({ layout: 'Plain Layout' });
  const end = pos + cur.nodeSize - 1; // before the closing token of the inset
  let tr = view.state.tr.insert(end, [header, body]);
  if (cur.attrs.status === 'collapsed') tr = tr.setNodeMarkup(pos, undefined, { ...cur.attrs, status: 'open' });
  view.dispatch(tr.setSelection(TextSelection.create(tr.doc, end + header.nodeSize + 1)));
  return 'changed';
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
  const para = schema.nodes.paragraph.create(first.attrs, schema.text(commentHeader(h.author, h.time, resolved, h.reactions)));
  // anyone may resolve a thread: its first header (often someone else's) changes with it
  view.dispatch(allowCommentEdit(view.state.tr.replaceWith(pos + 1, pos + 1 + first.nodeSize, para)));
}
export function toggleCommentResolved(view: EditorView, pos: number): void {
  const cur = view.state.doc.nodeAt(pos);
  if (!cur || !cur.firstChild) return;
  const h = parseHeader(cur.firstChild.textContent.trim());
  setCommentResolved(view, pos, !(h?.resolved ?? false));
}
