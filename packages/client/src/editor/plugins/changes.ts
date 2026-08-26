/**
 * Change tracking (LyX \change_inserted / \change_deleted):
 *  - when tracking is on, typed text gets an "inserted" change mark for the current author;
 *  - Backspace/Delete over unchanged text marks it "deleted" instead of removing it;
 *  - accept/reject all changes.
 */
import { Plugin, PluginKey, TextSelection, type Command, type Transaction } from 'prosemirror-state';
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
