/**
 * Other people's comments are theirs: in a comment thread (a Note Comment inset, core comments.ts)
 * a message someone else wrote — their "Name (time):" header and the paragraphs up to the next
 * header — cannot be changed in this editor. Replying, resolving or reopening the thread, reacting
 * to a message and taking a whole thread out (with the text around it) still work. Edits that
 * arrive from elsewhere (co-authors, agents, the TeX source) and undo / redo are not this editor's
 * to refuse. A plain LyX comment without headers has no known author and stays open to everyone.
 */
import type { Node as PMNode } from 'prosemirror-model';
import { Plugin, PluginKey, type Transaction } from 'prosemirror-state';
import { isHistoryTransaction } from 'prosemirror-history';
import { parseHeader } from '@overlyx/core';
import { isCommentNode } from '../commentops';
import { editorContext } from '../context';
import { isRemote } from '../collab';

export const commentGuardKey = new PluginKey('ol-comment-guard');

/** a change of this editor's own that may touch other people's messages (resolving rewrites the thread's first header; reactions) */
export const allowCommentEdit = (tr: Transaction): Transaction => tr.setMeta(commentGuardKey, true);

/** a comment author this person writes as: their account's name (and in VS Code git's user.name besides "You") */
export function isMe(author: string): boolean {
  const me = editorContext.user?.name;
  return !!me && (author === me || !!editorContext.myNames?.includes(author));
}

/** the messages of the thread at `pos` that someone else wrote (document positions: their header to the next header) */
export function othersMessages(thread: PMNode, pos: number): { from: number; to: number; author: string }[] {
  const out: { from: number; to: number; author: string }[] = [];
  let cur: { from: number; to: number; author: string } | null = null;
  thread.forEach((p, offset) => {
    const from = pos + 1 + offset, to = from + p.nodeSize;
    const h = parseHeader(p.textContent.trim());
    if (h) { cur = h.author && !isMe(h.author) ? { from, to, author: h.author } : null; if (cur) out.push(cur); }
    else if (cur) cur.to = to;
  });
  return out;
}

/**
 * Whose message the range [from, to] changes, if it changes one that is not this person's (null:
 * none). An insertion (from = to) changes a message when it lands inside it, not at its edges;
 * a range that takes a whole thread changes none of its messages.
 */
export function lockedAuthor(doc: PMNode, from: number, to: number): string | null {
  if (!editorContext.user?.name) return null;
  let who: string | null = null;
  doc.nodesBetween(Math.max(0, Math.min(from, doc.content.size - 1)), Math.min(doc.content.size, Math.max(to, from + 1)), (n, pos) => {
    if (who !== null) return false;
    if (!isCommentNode(n)) return true;
    if (from <= pos && to >= pos + n.nodeSize) return false;
    for (const m of othersMessages(n, pos)) {
      if (from === to ? m.from < from && from < m.to : from < m.to && to > m.from) { who = m.author; break; }
    }
    return false;
  });
  return who;
}

/** the ranges a step changes, in the document before it (mark and attribute steps have no step map) */
function stepRanges(step: Transaction['steps'][number]): [number, number][] {
  const out: [number, number][] = [];
  step.getMap().forEach((a, b) => { out.push([a, b]); });
  const s = step as unknown as { from?: number; to?: number; pos?: number };
  if (typeof s.from === 'number' && typeof s.to === 'number') out.push([s.from, s.to]);
  else if (typeof s.pos === 'number') out.push([s.pos, s.pos + 1]);
  return out;
}

export function commentGuardPlugin(): Plugin {
  let toldAt = 0;
  return new Plugin({
    key: commentGuardKey,
    filterTransaction(tr) {
      if (!tr.docChanged || tr.getMeta(commentGuardKey) || isRemote(tr) || isHistoryTransaction(tr)) return true;
      for (let i = 0; i < tr.steps.length; i++) {
        for (const [a, b] of stepRanges(tr.steps[i])) {
          const who = lockedAuthor(tr.docs[i], a, b);
          if (who === null) continue;
          if (Date.now() - toldAt > 3000) {
            toldAt = Date.now();
            editorContext.notify?.(`This is ${who}’s comment — only they can change it. Reply below it instead.`);
          }
          return false;
        }
      }
      return true;
    },
  });
}
