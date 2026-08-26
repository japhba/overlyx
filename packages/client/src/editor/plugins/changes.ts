/**
 * Change tracking (LyX \change_inserted / \change_deleted):
 *  - when tracking is on, typed text gets an "inserted" change mark for the current author;
 *  - Backspace/Delete over unchanged text marks it "deleted" instead of removing it;
 *  - accept/reject all changes.
 */
import { Plugin, PluginKey, TextSelection, type Command, type Transaction, type EditorState } from 'prosemirror-state';
import type { Node as PMNode } from 'prosemirror-model';
import { schema } from '@overlyx/core';
import { editorContext } from '../context';

export const changesKey = new PluginKey('lyx-changes');

function now(): number { return Math.floor(Date.now() / 1000); }

function changeMark(type: 'inserted' | 'deleted') {
  return schema.marks.change.create({ type, author: editorContext.changeAuthorId ?? 0, time: now() });
}

/** Adds the inserted-mark to text inserted by the user while tracking is active. */
export function changeTrackingPlugin(): Plugin {
  return new Plugin({
    key: changesKey,
    appendTransaction(trs, _old, newState) {
      if (!editorContext.trackChanges || editorContext.changeAuthorId === undefined) return null;
      const holder: { tr: Transaction | null } = { tr: null };
      for (const t of trs) {
        if (!t.docChanged || t.getMeta('lyx-changes') || t.getMeta('y-sync$') || t.getMeta('addToHistory') === false) continue;
        // mark inserted ranges
        t.mapping.maps.forEach((map, i) => {
          map.forEach((_os, _oe, ns, ne) => {
            let from = ns, to = ne;
            for (let j = i + 1; j < t.mapping.maps.length; j++) { from = t.mapping.maps[j].map(from, 1); to = t.mapping.maps[j].map(to, -1); }
            if (to <= from) return;
            holder.tr = holder.tr ?? newState.tr;
            const tr = holder.tr;
            const ins = changeMark('inserted');
            newState.doc.nodesBetween(from, to, (node, pos) => {
              if (node.isText) {
                const existing = node.marks.find(m => m.type === schema.marks.change);
                if (!existing) tr.addMark(Math.max(from, pos), Math.min(to, pos + node.nodeSize), ins);
              }
              return true;
            });
          });
        });
      }
      if (holder.tr && holder.tr.docChanged) { holder.tr.setMeta('lyx-changes', true); return holder.tr; }
      return null;
    },
  });
}

/** Backspace/Delete while tracking: mark as deleted (unless the text was inserted by tracking, then remove). */
export function trackedDelete(dir: -1 | 1): Command {
  return (state, dispatch) => {
    if (!editorContext.trackChanges || editorContext.changeAuthorId === undefined) return false;
    const sel = state.selection;
    let from: number, to: number;
    if (!sel.empty) { from = sel.from; to = sel.to; }
    else {
      const $c = sel.$from;
      if (dir < 0) { if ($c.parentOffset === 0) return false; from = $c.pos - 1; to = $c.pos; }
      else { if ($c.parentOffset === $c.parent.content.size) return false; from = $c.pos; to = $c.pos + 1; }
      // step over a whole inline node
      const n = dir < 0 ? $c.nodeBefore : $c.nodeAfter;
      if (n && !n.isText) { if (dir < 0) from = $c.pos - n.nodeSize; else to = $c.pos + n.nodeSize; }
    }
    if (!dispatch) return true;
    let tr = state.tr;
    // Text inserted by change tracking is simply removed; other text is marked deleted.
    const del = changeMark('deleted');
    const removals: [number, number][] = [];
    state.doc.nodesBetween(from, to, (node, pos) => {
      if (!node.isInline) return true;
      const s = Math.max(from, pos), e = Math.min(to, pos + node.nodeSize);
      const ch = node.marks.find(m => m.type === schema.marks.change);
      if (ch && ch.attrs.type === 'inserted') removals.push([s, e]);
      else if (!(ch && ch.attrs.type === 'deleted')) {
        if (node.isText) tr = tr.addMark(s, e, del);
        else {
          const marks = JSON.parse(node.attrs.marks || '[]').filter((m: any) => m.type !== 'change');
          marks.push({ type: 'change', attrs: del.attrs });
          tr = tr.setNodeMarkup(pos, undefined, { ...node.attrs, marks: JSON.stringify(marks) });
        }
      }
      return false;
    });
    for (const [s, e] of removals.reverse()) tr = tr.delete(s, e);
    tr = tr.setSelection(TextSelection.create(tr.doc, dir < 0 ? tr.mapping.map(from) : tr.mapping.map(to)));
    dispatch(tr.setMeta('lyx-changes', true));
    return true;
  };
}

export function acceptAllChanges(): Command {
  return (state, dispatch) => {
    let tr = state.tr;
    const deletions: [number, number][] = [];
    const unmark: [number, number][] = [];
    const nodeFix: [number, PMNode][] = [];
    state.doc.descendants((node, pos) => {
      if (node.isText) {
        const ch = node.marks.find(m => m.type === schema.marks.change);
        if (ch?.attrs.type === 'deleted') deletions.push([pos, pos + node.nodeSize]);
        else if (ch) unmark.push([pos, pos + node.nodeSize]);
      } else if (node.isInline) {
        const marks: any[] = JSON.parse(node.attrs.marks || '[]');
        const ch = marks.find(m => m.type === 'change');
        if (ch?.attrs.type === 'deleted') deletions.push([pos, pos + node.nodeSize]);
        else if (ch) nodeFix.push([pos, node]);
      } else if (node.type.name === 'paragraph' && node.attrs.endChange) {
        nodeFix.push([pos, node]);
      }
      return true;
    });
    for (const [s, e] of unmark) tr = tr.removeMark(s, e, schema.marks.change);
    for (const [pos, node] of nodeFix) {
      if (node.type.name === 'paragraph') tr = tr.setNodeMarkup(pos, undefined, { ...node.attrs, endChange: null });
      else tr = tr.setNodeMarkup(pos, undefined, { ...node.attrs, marks: JSON.stringify(JSON.parse(node.attrs.marks || '[]').filter((m: any) => m.type !== 'change')) });
    }
    for (const [s, e] of deletions.sort((a, b) => b[0] - a[0])) tr = tr.delete(tr.mapping.map(s), tr.mapping.map(e));
    if (!tr.docChanged) return false;
    dispatch?.(tr.setMeta('lyx-changes', true));
    return true;
  };
}

export function rejectAllChanges(): Command {
  return (state, dispatch) => {
    let tr = state.tr;
    const deletions: [number, number][] = [];
    const unmark: [number, number][] = [];
    const nodeFix: [number, PMNode][] = [];
    state.doc.descendants((node, pos) => {
      if (node.isText) {
        const ch = node.marks.find(m => m.type === schema.marks.change);
        if (ch?.attrs.type === 'inserted') deletions.push([pos, pos + node.nodeSize]);
        else if (ch) unmark.push([pos, pos + node.nodeSize]);
      } else if (node.isInline) {
        const marks: any[] = JSON.parse(node.attrs.marks || '[]');
        const ch = marks.find(m => m.type === 'change');
        if (ch?.attrs.type === 'inserted') deletions.push([pos, pos + node.nodeSize]);
        else if (ch) nodeFix.push([pos, node]);
      } else if (node.type.name === 'paragraph' && node.attrs.endChange) nodeFix.push([pos, node]);
      return true;
    });
    for (const [s, e] of unmark) tr = tr.removeMark(s, e, schema.marks.change);
    for (const [pos, node] of nodeFix) {
      if (node.type.name === 'paragraph') tr = tr.setNodeMarkup(pos, undefined, { ...node.attrs, endChange: null });
      else tr = tr.setNodeMarkup(pos, undefined, { ...node.attrs, marks: JSON.stringify(JSON.parse(node.attrs.marks || '[]').filter((m: any) => m.type !== 'change')) });
    }
    for (const [s, e] of deletions.sort((a, b) => b[0] - a[0])) tr = tr.delete(tr.mapping.map(s), tr.mapping.map(e));
    if (!tr.docChanged) return false;
    dispatch?.(tr.setMeta('lyx-changes', true));
    return true;
  };
}

export function hasChanges(doc: PMNode): boolean {
  let found = false;
  doc.descendants((node) => {
    if (found) return false;
    if (node.isText && node.marks.some(m => m.type === schema.marks.change)) found = true;
    else if (node.isInline && (node.attrs.marks || '').includes('"change"')) found = true;
    return !found;
  });
  return found;
}

/* ------------------------------------------------ single change at the cursor */

export interface ChangeRange { from: number; to: number; type: 'inserted' | 'deleted'; author: number; time: number }

function changeOf(node: PMNode): { type: 'inserted' | 'deleted'; author: number; time: number } | null {
  if (node.isText) {
    const m = node.marks.find(x => x.type === schema.marks.change);
    return m ? { type: m.attrs.type, author: Number(m.attrs.author), time: Number(m.attrs.time) } : null;
  }
  if (node.isInline) {
    try {
      const ch = JSON.parse(node.attrs.marks || '[]').find((x: any) => x.type === 'change');
      return ch ? { type: ch.attrs.type, author: Number(ch.attrs.author), time: Number(ch.attrs.time) } : null;
    } catch { return null; }
  }
  return null;
}

/** The tracked change (contiguous run with the same author/type) at a position, if any. */
export function changeAt(state: EditorState, pos: number): ChangeRange | null {
  const $p = state.doc.resolve(pos);
  const parent = $p.parent, base = $p.start();
  if (!parent.isTextblock) return null;
  // find the child at pos (prefer the one after the cursor, then before)
  let idx = $p.index();
  let child = parent.maybeChild(idx);
  let ch = child ? changeOf(child) : null;
  if (!ch && idx > 0) { idx--; child = parent.child(idx); ch = changeOf(child); }
  if (!ch || !child) return null;
  const same = (n: PMNode) => { const c = changeOf(n); return !!c && c.type === ch!.type && c.author === ch!.author; };
  let a = idx, b = idx;
  while (a > 0 && same(parent.child(a - 1))) a--;
  while (b + 1 < parent.childCount && same(parent.child(b + 1))) b++;
  let from = base, to = base;
  for (let i = 0; i < a; i++) from += parent.child(i).nodeSize;
  to = from;
  for (let i = a; i <= b; i++) to += parent.child(i).nodeSize;
  return { from, to, ...ch };
}

/** Accept (keep insertions / drop deletions) or reject one change range. */
export function resolveChange(range: ChangeRange, accept: boolean): Command {
  return (state, dispatch) => {
    let tr = state.tr;
    const remove = accept ? range.type === 'deleted' : range.type === 'inserted';
    if (remove) tr = tr.delete(range.from, range.to);
    else {
      tr = tr.removeMark(range.from, range.to, schema.marks.change);
      state.doc.nodesBetween(range.from, range.to, (node, pos) => {
        if (node.isInline && !node.isText && (node.attrs.marks || '').includes('"change"')) {
          tr = tr.setNodeMarkup(pos, undefined, { ...node.attrs, marks: JSON.stringify(JSON.parse(node.attrs.marks || '[]').filter((m: any) => m.type !== 'change')) });
        }
        return true;
      });
    }
    if (!tr.docChanged) return false;
    dispatch?.(tr.setMeta('lyx-changes', true));
    return true;
  };
}
