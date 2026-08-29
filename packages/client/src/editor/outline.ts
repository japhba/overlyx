/**
 * LyX's outline operations (outline-up / outline-down / outline-in / outline-out): a section is a
 * heading paragraph together with everything up to the next heading of the same or a higher
 * level. Up / down swap it with its previous / next sibling section (never leaving its parent);
 * demote / promote change the level of its heading and of every sub-heading in it by one.
 * The commands work on the section that contains a document position (the cursor, or an outline
 * item's heading).
 */
import { TextSelection, type Command, type EditorState, type Transaction } from 'prosemirror-state';
import type { Node as PMNode } from 'prosemirror-model';
import { sectionLevel, shiftLayout } from './layouts';
import type { LayoutInfo } from '../api';

const levelOf = (n: PMNode): number | null => (n.type.name === 'paragraph' ? sectionLevel(String(n.attrs.layout)) : null);

/** the top-level child index that contains `pos` */
function childIndexAt(doc: PMNode, pos: number): number {
  const $p = doc.resolve(Math.max(0, Math.min(pos, doc.content.size)));
  return $p.depth === 0 ? Math.min($p.index(), doc.childCount - 1) : $p.index(0);
}
/** document offset of top-level child `i` */
function childPos(doc: PMNode, i: number): number {
  let pos = 0;
  for (let k = 0; k < i; k++) pos += doc.child(k).nodeSize;
  return pos;
}

export interface Section { /** heading child index */ start: number; /** exclusive child index */ end: number; level: number }

/** the section a position is in (the nearest heading at or above it), or null when there is none */
export function sectionAt(doc: PMNode, pos: number): Section | null {
  const idx = childIndexAt(doc, pos);
  for (let i = idx; i >= 0; i--) {
    const level = levelOf(doc.child(i));
    if (level === null) continue;
    return { start: i, end: sectionEnd(doc, i, level), level };
  }
  return null;
}
function sectionEnd(doc: PMNode, start: number, level: number): number {
  for (let i = start + 1; i < doc.childCount; i++) { const l = levelOf(doc.child(i)); if (l !== null && l <= level) return i; }
  return doc.childCount;
}

/** the previous sibling section (same level, same parent), or null */
function previousSibling(doc: PMNode, s: Section): Section | null {
  for (let i = s.start - 1; i >= 0; i--) {
    const l = levelOf(doc.child(i));
    if (l === null || l > s.level) continue;
    if (l < s.level) return null;      // the parent's heading: no sibling before us
    return { start: i, end: s.start, level: l };
  }
  return null;
}
function nextSibling(doc: PMNode, s: Section): Section | null {
  if (s.end >= doc.childCount) return null;
  const l = levelOf(doc.child(s.end));
  if (l !== s.level) return null;      // the next heading is the parent's sibling (or none)
  return { start: s.end, end: sectionEnd(doc, s.end, l), level: l };
}

/** a move / level change is possible for the section at `pos` (the outline buttons' enabled state) */
export function canMoveSection(state: EditorState, pos: number, dir: -1 | 1): boolean {
  const s = sectionAt(state.doc, pos);
  return !!s && !!(dir < 0 ? previousSibling(state.doc, s) : nextSibling(state.doc, s));
}
export function canShiftSection(state: EditorState, pos: number, delta: -1 | 1, layouts?: LayoutInfo[] | null): boolean {
  const s = sectionAt(state.doc, pos);
  if (!s) return false;
  for (let i = s.start; i < s.end; i++) {
    const n = state.doc.child(i);
    const l = levelOf(n);
    if (l !== null && shiftLayout(String(n.attrs.layout), delta, layouts) === null) return false;
  }
  return true;
}

/** Move the section at `pos` (default: the cursor's) before its previous / after its next sibling. */
export function moveSection(dir: -1 | 1, pos?: number): Command {
  return (state, dispatch) => {
    const at = pos ?? state.selection.from;
    const s = sectionAt(state.doc, at);
    if (!s) return false;
    const sib = dir < 0 ? previousSibling(state.doc, s) : nextSibling(state.doc, s);
    if (!sib) return false;
    if (!dispatch) return true;
    const doc = state.doc;
    const from = childPos(doc, s.start), to = childPos(doc, s.end);
    const slice = doc.slice(from, to);
    const sel = state.selection;
    const inside = sel.from >= from && sel.from < to;
    let tr: Transaction;
    let newFrom: number;
    if (dir < 0) {
      const dest = childPos(doc, sib.start);
      tr = state.tr.delete(from, to).insert(dest, slice.content);
      newFrom = inside ? dest + (sel.from - from) : dest;
    } else {
      const sibEnd = childPos(doc, sib.end);
      tr = state.tr.delete(from, to).insert(sibEnd - (to - from), slice.content);
      newFrom = inside ? sel.from + (sibEnd - to) : sibEnd - (to - from);
    }
    tr.setSelection(TextSelection.near(tr.doc.resolve(Math.min(newFrom, tr.doc.content.size))));
    dispatch(tr.scrollIntoView());
    return true;
  };
}

/** Promote (delta -1) / demote (delta +1) the section at `pos`: its heading and every sub-heading change level. */
export function shiftSection(delta: -1 | 1, pos?: number, layouts?: LayoutInfo[] | null): Command {
  return (state, dispatch) => {
    const at = pos ?? state.selection.from;
    if (!canShiftSection(state, at, delta, layouts)) return false;
    const s = sectionAt(state.doc, at)!;
    if (!dispatch) return true;
    const tr = state.tr;
    for (let i = s.start; i < s.end; i++) {
      const n = state.doc.child(i);
      const l = levelOf(n);
      if (l === null) continue;
      tr.setNodeMarkup(childPos(state.doc, i), undefined, { ...n.attrs, layout: shiftLayout(String(n.attrs.layout), delta, layouts) });
    }
    dispatch(tr);
    return true;
  };
}
