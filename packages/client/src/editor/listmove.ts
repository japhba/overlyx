/**
 * Moving a list item together with its sub-items — the deeper paragraphs right after it (nested
 * items, and the text, formulas and figures nested in it: what fold.ts folds away) — by drag and
 * drop (plugins/listdrag.ts) and by Alt+↑ / Alt+↓ (LyX binds M-Up to "outline-up; paragraph-move-up":
 * an outline unit moves whole, so does a list item here).
 *
 * A LyX list is flat: paragraphs with a depth. A place for an item is a gap between two paragraphs of
 * its container (the document, an inset, a table cell, a layout box) and a depth. The depths a gap
 * allows keep the structure around it: no deeper than the paragraph before allows (LyX's
 * getMaxDepthAfter), no shallower than the paragraph after — else that paragraph, and whatever is
 * nested in it, would become the moved item's sub-items.
 *
 * A move is a deletion and an insertion in one transaction: one undo step, and with change tracking
 * on, the change-tracking plugin records it as LyX does — struck through where it was, inserted where
 * it went. Dropped back at its own place with another depth it is a depth change only (as Tab), which
 * is not tracked.
 */
import { NodeSelection, Selection, TextSelection, type Command, type EditorState, type Transaction } from 'prosemirror-state';
import { Fragment, type Node as PMNode } from 'prosemirror-model';
import { isListLayout, sectionLevel, isEnvironmentLayout } from './layouts';
import { editorContext } from './context';

/** a list item and its sub-items: children [from, to) of a container whose content starts at `start` */
export interface ListUnit { parent: PMNode; start: number; from: number; to: number; depth: number }
/** a place for a unit: before the container's child `gap` (childCount: at its end), at `depth` */
export interface ListPlace { gap: number; depth: number }

export const depthOf = (n: PMNode | null | undefined): number => (n ? Number(n.attrs.depth) || 0 : 0);
export const isListItem = (n: PMNode | null | undefined): boolean => !!n && n.type.name === 'paragraph' && isListLayout(String(n.attrs.layout));
const isHeading = (n: PMNode): boolean => n.type.name === 'paragraph' && sectionLevel(String(n.attrs.layout)) !== null;

/** the end (exclusive child index) of the unit of the item at `index`: the deeper paragraphs after it (a heading ends them) */
export function unitEnd(parent: PMNode, index: number): number {
  const d = depthOf(parent.child(index));
  let j = index + 1;
  while (j < parent.childCount) {
    const n = parent.child(j);
    if (n.type.name !== 'paragraph' || depthOf(n) <= d || isHeading(n)) break;
    j++;
  }
  return j;
}

/** the unit of the list item that contains position `pos` (a position inside its paragraph) */
export function listUnitAt(doc: PMNode, pos: number): ListUnit | null {
  const $p = doc.resolve(Math.max(0, Math.min(pos, doc.content.size)));
  for (let d = $p.depth; d > 0; d--) {
    const n = $p.node(d);
    if (n.type.name !== 'paragraph') continue;
    if (!isListItem(n)) return null;
    const parent = $p.node(d - 1), index = $p.index(d - 1);
    return { parent, start: $p.start(d - 1), from: index, to: unitEnd(parent, index), depth: depthOf(n) };
  }
  return null;
}

/** the document position of the container's child `index` (its end for childCount) */
export function childPos(u: { parent: PMNode; start: number }, index: number): number {
  let p = u.start;
  for (let i = 0; i < index; i++) p += u.parent.child(i).nodeSize;
  return p;
}

/** LyX Paragraph::getMaxDepthAfter: one step deeper after an environment paragraph (a list item), else as deep as it */
export function maxDepthAfter(prev: PMNode | null | undefined): number {
  if (!prev || prev.type.name !== 'paragraph') return 0;
  return depthOf(prev) + (isEnvironmentLayout(String(prev.attrs.layout), editorContext.meta?.layouts) ? 1 : 0);
}

/** a gap the unit can go to: not inside itself */
export const canDropAt = (u: ListUnit, gap: number): boolean => gap >= 0 && gap <= u.parent.childCount && (gap <= u.from || gap >= u.to);

/** the paragraphs that would be right before and right after the unit dropped at `gap` (the unit itself gone) */
function neighbours(u: ListUnit, gap: number): { prev: PMNode | null; next: PMNode | null } {
  const p = u.parent;
  const prevIdx = gap === u.to ? u.from - 1 : gap - 1;
  const nextIdx = gap === u.from ? u.to : gap;
  return { prev: prevIdx >= 0 ? p.child(prevIdx) : null, next: nextIdx < p.childCount ? p.child(nextIdx) : null };
}

/** the depths the unit's item may take at `gap`: [min, max] */
export function depthRange(u: ListUnit, gap: number): [number, number] {
  const { prev, next } = neighbours(u, gap);
  const max = maxDepthAfter(prev);
  const min = next && next.type.name === 'paragraph' && !isHeading(next) ? depthOf(next) : 0;
  return [Math.min(min, max), max];
}

export const clampDepth = (d: number, [lo, hi]: [number, number]): number => Math.max(lo, Math.min(hi, d));

/**
 * The list type the item takes at a place: dropped among the items of a numbered list a bulleted
 * item is numbered, and the other way round (as in Google Docs) — the nearest item at that depth
 * before the place (not past a shallower paragraph), else the one right after it. Only bullets and
 * numbers trade (a description's label is part of its text).
 */
export function layoutAt(u: ListUnit, place: ListPlace): string | null {
  const own = String(u.parent.child(u.from).attrs.layout);
  const trade = (l: string) => l === 'Itemize' || l === 'Enumerate';
  // (dropped back at its own place it never changes its type)
  if (!trade(own) || place.gap === u.from || place.gap === u.to) return null;
  const p = u.parent;
  const pick = (n: PMNode | null): string | null => {
    if (!n || !isListItem(n) || depthOf(n) !== place.depth) return null;
    const l = String(n.attrs.layout);
    return trade(l) && l !== own ? l : null;
  };
  for (let i = place.gap - 1; i >= 0; i--) {
    if (i >= u.from && i < u.to) continue;
    const n = p.child(i);
    if (n.type.name !== 'paragraph' || isHeading(n) || depthOf(n) < place.depth) break;
    if (depthOf(n) === place.depth) return pick(n);
  }
  return pick(neighbours(u, place.gap).next);
}

/**
 * The transaction that moves the unit to `place` (null when nothing would change). `layout`: the
 * item's new layout (layoutAt), if any. The selection inside the unit goes with it.
 */
export function moveUnit(state: EditorState, u: ListUnit, place: ListPlace, layout: string | null = null): Transaction | null {
  const { gap, depth } = place;
  if (!canDropAt(u, gap)) return null;
  const delta = depth - u.depth;
  const first = u.parent.child(u.from);
  const relayout = layout && layout !== first.attrs.layout ? layout : null;
  const same = gap === u.from || gap === u.to;
  if (same && !delta && !relayout) return null;
  const olds: PMNode[] = [];
  for (let i = u.from; i < u.to; i++) olds.push(u.parent.child(i));
  const attrsOf = (n: PMNode, k: number) => ({ ...n.attrs, depth: Math.max(0, depthOf(n) + delta), ...(k === 0 && relayout ? { layout: relayout } : {}) });
  const from = childPos(u, u.from), to = childPos(u, u.to);
  const tr = state.tr;
  if (same) {
    // back at its own place, deeper or shallower: the depths change (as Tab / Shift+Tab), nothing moves
    let p = from;
    olds.forEach((n, k) => { tr.setNodeMarkup(p, undefined, attrsOf(n, k)); p += n.nodeSize; });
    return tr;
  }
  const nodes = olds.map((n, k) => n.type.create(attrsOf(n, k), n.content, n.marks));
  const at = childPos(u, gap);
  const dest = gap > u.to ? at - (to - from) : at;
  const sel = state.selection;
  tr.delete(from, to).insert(dest, Fragment.from(nodes));
  if (sel.from >= from && sel.to <= to) {
    const shift = dest - from;
    try {
      if (sel instanceof NodeSelection) tr.setSelection(NodeSelection.create(tr.doc, sel.from + shift));
      else if (sel instanceof TextSelection) tr.setSelection(TextSelection.create(tr.doc, sel.anchor + shift, sel.head + shift));
      else tr.setSelection(Selection.near(tr.doc.resolve(dest + 1)));
    } catch { tr.setSelection(Selection.near(tr.doc.resolve(dest + 1))); }
  }
  return tr;
}

/**
 * Where Alt+↑ / Alt+↓ take the unit: past its previous / next sibling (with that one's sub-items);
 * the first sub-item up goes above the item it is nested in, the last one down below the paragraph
 * after it (the first sub-item of the next item, Workflowy-style), each at the nearest depth allowed.
 */
export function stepPlace(u: ListUnit, dir: -1 | 1): ListPlace | null {
  const p = u.parent;
  if (dir < 0) {
    if (u.from === 0) return null;
    let k = u.from - 1;
    while (k > 0 && p.child(k).type.name === 'paragraph' && depthOf(p.child(k)) > u.depth && !isHeading(p.child(k))) k--;
    const n = p.child(k);
    if (depthOf(n) === u.depth && isListItem(n)) return { gap: k, depth: u.depth };
    const gap = depthOf(n) > u.depth ? u.from - 1 : k;
    return { gap, depth: clampDepth(u.depth, depthRange(u, gap)) };
  }
  if (u.to >= p.childCount) return null;
  const n = p.child(u.to);
  if (depthOf(n) === u.depth && isListItem(n)) return { gap: unitEnd(p, u.to), depth: u.depth };
  const gap = u.to + 1;
  return { gap, depth: clampDepth(u.depth, depthRange(u, gap)) };
}

/** Alt+↑ / Alt+↓ in a list item: the item moves with its sub-items (else false: the paragraph alone moves) */
export function moveListItem(dir: -1 | 1): Command {
  return (state, dispatch) => {
    const sel = state.selection;
    const u = listUnitAt(state.doc, sel.from);
    if (!u || sel.to > childPos(u, u.to)) return false;
    const place = stepPlace(u, dir);
    if (!place) return false;
    const tr = moveUnit(state, u, place);
    if (!tr) return false;
    dispatch?.(tr.scrollIntoView());
    return true;
  };
}
