/**
 * Change tracking (LyX \change_inserted / \change_deleted):
 *  - when tracking is on, typed text gets an "inserted" change mark for the current author;
 *  - Backspace/Delete over unchanged text marks it "deleted" instead of removing it;
 *  - accept/reject all changes.
 */
import { Plugin, PluginKey, TextSelection, type Command, type Transaction, type EditorState } from 'prosemirror-state';
import { Decoration, DecorationSet, type EditorView } from 'prosemirror-view';
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

export function changeOf(node: PMNode): { type: 'inserted' | 'deleted'; author: number; time: number } | null {
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

/* ------------------------------------------------ navigation (LyX change-next / change-previous) */

/** All tracked change runs of the document in document order (adjacent same author/type merged). */
export function allChanges(doc: PMNode): ChangeRange[] {
  const out: ChangeRange[] = [];
  doc.descendants((node, pos) => {
    if (!node.isInline) return true;
    const c = changeOf(node);
    if (!c) return false;
    const last = out[out.length - 1];
    if (last && last.to === pos && last.type === c.type && last.author === c.author) last.to = pos + node.nodeSize;
    else out.push({ from: pos, to: pos + node.nodeSize, ...c });
    return false;
  });
  return out;
}

/** Move the cursor to the next / previous tracked change (wraps around); selects it. */
export function gotoChange(dir: 1 | -1): Command {
  return (state, dispatch) => {
    const all = allChanges(state.doc);
    if (!all.length) return false;
    const { from, to } = state.selection;
    let target: ChangeRange | undefined;
    if (dir > 0) target = all.find(c => c.from >= to || (c.from > from && c.to > to)) ?? all[0];
    else { for (let i = all.length - 1; i >= 0; i--) if (all[i].to <= from || (all[i].from < from && all[i].to < to)) { target = all[i]; break; } target = target ?? all[all.length - 1]; }
    if (!target) return false;
    if (dispatch) {
      const tr = state.tr.setSelection(TextSelection.create(state.doc, target.from, target.to)).scrollIntoView();
      dispatch(tr.setMeta('addToHistory', false));
    }
    return true;
  };
}

/** Accept or reject every change touching the selection (LyX change-accept / change-reject); with an
 *  empty selection, the change under the cursor. */
export function resolveSelectionChanges(accept: boolean): Command {
  return (state, dispatch) => {
    const { from, to, empty } = state.selection;
    const ranges = empty ? [changeAt(state, from)].filter((c): c is ChangeRange => !!c) : allChanges(state.doc).filter(c => c.from < to && c.to > from);
    if (!ranges.length) return false;
    if (!dispatch) return true;
    let tr = state.tr;
    for (const r of ranges.sort((a, b) => b.from - a.from)) {
      const remove = accept ? r.type === 'deleted' : r.type === 'inserted';
      if (remove) tr = tr.delete(r.from, r.to);
      else {
        tr = tr.removeMark(r.from, r.to, schema.marks.change);
        tr.doc.nodesBetween(r.from, r.to, (node, pos) => {
          if (node.isInline && !node.isText && (node.attrs.marks || '').includes('"change"')) tr = tr.setNodeMarkup(pos, undefined, { ...node.attrs, marks: JSON.stringify(JSON.parse(node.attrs.marks || '[]').filter((m: any) => m.type !== 'change')) });
          return true;
        });
      }
    }
    if (!tr.docChanged) return false;
    dispatch(tr.setMeta('lyx-changes', true));
    return true;
  };
}

/* ------------------------------------------------ display filter (insertions / deletions) */

/**
 * Purely a *view* filter: which tracked-change types are drawn. Independent of the document
 * itself — insertions and deletions can each be hidden (both, either, or neither), e.g. to read
 * the text as it will look once deletions are accepted while still seeing what was inserted.
 * A hidden run does not vanish without a trace: a small caret with a triangle stands where it is
 * (like a folded region), and clicking it unfolds just that run — the toolbar switches then act
 * as fold / unfold *all* (flipping one clears the per-run exceptions).
 */
export interface ChangesFilterState { showInsertions: boolean; showDeletions: boolean; unfolded: ReadonlySet<string> }
export const changesFilterKey = new PluginKey<ChangesFilterState>('lyx-changes-filter');
export type ChangesFilterPatch = Partial<Pick<ChangesFilterState, 'showInsertions' | 'showDeletions'>> & { toggleRun?: string };

/** one edit's identity: stable across position shifts (an agent or user edit shares author+time) */
const runKeyOf = (c: { type: string; author: number; time: number }) => `${c.type}:${c.author}:${c.time}`;

const foldMarker = (key: string, type: string, folded: boolean) => () => {
  const el = document.createElement('span');
  el.className = `ol-change-fold ${type}${folded ? '' : ' open'}`;
  el.setAttribute('data-fold', key);
  el.title = folded ? 'A hidden tracked change — click to show it' : 'Click to hide this tracked change again';
  el.contentEditable = 'false';
  return el;
};

export function changesFilterPlugin(): Plugin<ChangesFilterState> {
  return new Plugin<ChangesFilterState>({
    key: changesFilterKey,
    state: {
      init: () => ({ showInsertions: true, showDeletions: true, unfolded: new Set<string>() }),
      apply(tr, prev) {
        const meta = tr.getMeta(changesFilterKey) as ChangesFilterPatch | undefined;
        if (!meta) return prev;
        let unfolded: ReadonlySet<string> = prev.unfolded;
        if (meta.toggleRun) {
          const next = new Set(unfolded);
          next.has(meta.toggleRun) ? next.delete(meta.toggleRun) : next.add(meta.toggleRun);
          unfolded = next;
        }
        // the toolbar switches mean fold / unfold ALL: flipping one resets the per-run exceptions
        if (meta.showInsertions !== undefined || meta.showDeletions !== undefined) unfolded = new Set();
        return { showInsertions: meta.showInsertions ?? prev.showInsertions, showDeletions: meta.showDeletions ?? prev.showDeletions, unfolded };
      },
    },
    props: {
      decorations(state) {
        const f = changesFilterKey.getState(state)!;
        if (f.showInsertions && f.showDeletions) return null;
        const decos: Decoration[] = [];
        let runKey: string | null = null;   // the filtered run the walker is currently inside
        let runEnd = -1;
        state.doc.descendants((node, pos) => {
          if (!node.isInline) { runKey = null; return true; }
          const c = changeOf(node);
          const hit = c && ((c.type === 'inserted' && !f.showInsertions) || (c.type === 'deleted' && !f.showDeletions));
          if (!hit) { runKey = null; return true; }
          const key = runKeyOf(c);
          const folded = !f.unfolded.has(key);
          if (key !== runKey || pos > runEnd) {
            runKey = key;
            decos.push(Decoration.widget(pos, foldMarker(key, c.type, folded), { side: -1, key: `fold:${key}:${folded}` }));
          }
          runEnd = pos + node.nodeSize;
          const cls = folded ? 'lyx-change-hidden' : 'lyx-change-unfolded';
          decos.push(node.isText ? Decoration.inline(pos, pos + node.nodeSize, { class: cls }) : Decoration.node(pos, pos + node.nodeSize, { class: cls }));
          return true;
        });
        return decos.length ? DecorationSet.create(state.doc, decos) : null;
      },
      handleDOMEvents: {
        mousedown(view, ev) {
          const fold = (ev.target as HTMLElement).closest?.('.ol-change-fold');
          if (!fold) return false;
          ev.preventDefault();
          setChangesFilter(view, { toggleRun: fold.getAttribute('data-fold') ?? '' });
          return true;
        },
      },
    },
  });
}

export function setChangesFilter(view: EditorView, patch: ChangesFilterPatch): void {
  view.dispatch(view.state.tr.setMeta(changesFilterKey, patch));
}
