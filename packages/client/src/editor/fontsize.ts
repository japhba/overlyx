/**
 * Font sizes everywhere — text, table cells, formulas (a formula takes a size as a whole: LaTeX
 * writes `{\small $…$}`, sizes do not work inside math), text boxes of layout pages. Sizes are
 * LaTeX's: the named ones (\tiny … \Huge) wherever a point size matches one at the document's
 * base size, `\fontsize{N}{1.2N}\selectfont` otherwise (the size mark's "Npt" value, core
 * latex/text.ts). The toolbar's size box (app/fontsize.tsx) shows and sets them in points.
 */
import type { EditorView } from 'prosemirror-view';
import { NodeSelection, type Transaction } from 'prosemirror-state';
import type { Node as PMNode } from 'prosemirror-model';
import { CellSelection } from 'prosemirror-tables';
import { schema } from '@overlyx/core';
import { activeMathField } from './lyxmath/field';
import { isLayoutObject } from './layout/geom';
import { isLayoutDoc } from './layout/commands';

export const NAMED_SIZES = ['tiny', 'scriptsize', 'footnotesize', 'small', 'normal', 'large', 'larger', 'largest', 'huge', 'giant'] as const;
export const NAMED_LABELS: Record<string, string> = { tiny: 'Tiny', scriptsize: 'Script', footnotesize: 'Footnote', small: 'Small', normal: 'Normal', large: 'Large', larger: 'Larger', largest: 'Largest', huge: 'Huge', giant: 'Giant' };

/** LaTeX's size table (the standard classes) at a base size of 10, 11 or 12 pt. */
const TABLES: Record<number, number[]> = {
  10: [5, 7, 8, 9, 10, 12, 14.4, 17.28, 20.74, 24.88],
  11: [6, 8, 9, 10, 10.95, 12, 14.4, 17.28, 20.74, 24.88],
  12: [6, 8, 10, 10.95, 12, 14.4, 17.28, 20.74, 24.88, 24.88],
};
export function sizeTable(base: number): number[] {
  if (TABLES[base]) return TABLES[base];
  // another base (a custom class): the 10pt table scaled
  return TABLES[10].map(v => Math.round(v * base / 10 * 100) / 100);
}

/** A size mark's value in points ("25pt", "25pt/30pt", a named size); null for no size. */
export function sizeToPt(value: string | null | undefined, base: number): number | null {
  if (!value) return null;
  const abs = /^(\d+(?:\.\d+)?)pt/.exec(value);
  if (abs) return Number(abs[1]);
  const i = (NAMED_SIZES as readonly string[]).indexOf(value);
  return i >= 0 ? sizeTable(base)[i] : null;
}

/** The value to write for a point size: the named size that has it at `base` (not in layout text), else "Npt". */
export function ptToSize(pt: number, base: number, preferNamed: boolean): string | null {
  const table = sizeTable(base);
  const normal = table[4];
  if (Math.abs(pt - normal) < 0.05) return null;
  if (preferNamed) {
    const i = table.findIndex(v => Math.abs(v - pt) < 0.06);
    if (i >= 0) return NAMED_SIZES[i];
  }
  return `${Math.round(pt * 100) / 100}pt`;
}

/** The document's base font size (the class option / \paperfontsize; beamer's 11pt). */
export function baseSize(view: EditorView): number {
  const v = Number(getComputedStyle(view.dom).getPropertyValue('--ol-basept'));
  return v > 0 ? v : 10;
}

/** The formula node the active math field edits (its position), if the field belongs to this view. */
export function activeFormula(view: EditorView): { node: PMNode; pos: number } | null {
  const f = activeMathField();
  const el = f?.dom.closest('.lyx-math-inline, .lyx-math-display') as HTMLElement | null;
  if (!el || !view.dom.contains(el)) return null;
  let pos: number;
  try { pos = view.posAtDOM(el, 0); } catch { return null; }
  for (const p of [pos, pos - 1]) {
    const n = p >= 0 ? view.state.doc.nodeAt(p) : null;
    if (n && (n.type.name === 'math_inline' || n.type.name === 'math_display')) return { node: n, pos: p };
  }
  return null;
}

function markList(node: PMNode): { type: string; attrs?: Record<string, unknown> }[] {
  try { return JSON.parse(node.attrs.marks || '[]'); } catch { return []; }
}

/** An inline node's `marks` attr with the value mark `name` set (null: removed). */
export function withNodeMark(node: PMNode, name: string, value: string | null): Record<string, unknown> {
  const list = markList(node).filter(m => m.type !== name);
  if (value) list.push({ type: name, attrs: { value } });
  return { ...node.attrs, marks: JSON.stringify(list) };
}

/** The size at the cursor, in points, and where it comes from. */
export function currentSize(view: EditorView): { pt: number; mixed: boolean } {
  const base = baseSize(view);
  const state = view.state;
  const f = activeFormula(view);
  if (f) {
    const m = markList(f.node).find(x => x.type === 'size');
    return { pt: sizeToPt(m?.attrs?.value as string | undefined, base) ?? boxBase(view, f.pos) ?? sizeTable(base)[4], mixed: false };
  }
  const sel = state.selection;
  if (sel instanceof NodeSelection) {
    const n = sel.node;
    if (n.type.name === 'ol_box') return { pt: n.attrs.font ?? base, mixed: false };
    if (n.attrs.marks !== undefined) { const m = markList(n).find(x => x.type === 'size'); return { pt: sizeToPt(m?.attrs?.value as string | undefined, base) ?? boxBase(view, sel.from) ?? sizeTable(base)[4], mixed: false }; }
  }
  const marks = sel.empty ? state.storedMarks ?? sel.$from.marks() : sel.$from.nodeAfter?.marks ?? sel.$from.marks();
  const size = marks.find(m => m.type.name === 'size')?.attrs.value as string | undefined;
  const inBox = boxBase(view, sel.from);
  return { pt: sizeToPt(size, inBox ?? base) ?? inBox ?? sizeTable(base)[4], mixed: false };
}

/** the base size of the layout text box containing `pos` (its `font`, else the document's), or null outside boxes */
function boxBase(view: EditorView, pos: number): number | null {
  const $p = view.state.doc.resolve(Math.min(pos, view.state.doc.content.size));
  for (let d = $p.depth; d > 0; d--) if ($p.node(d).type.name === 'ol_box') return $p.node(d).attrs.font ?? baseSize(view);
  return null;
}

/**
 * Set the font size (points) of the selection: a formula being edited as a whole, a selected text
 * box's base size, table cells, or the selected text (inline nodes in it — formulas, insets — too).
 */
export function applyFontSize(view: EditorView, pt: number): boolean {
  if (!(pt > 0) || pt > 400) return false;
  const base = baseSize(view);
  const layout = isLayoutDoc(view.state.doc);
  const state = view.state;
  const f = activeFormula(view);
  if (f) {
    const inBox = boxBase(view, f.pos);
    view.dispatch(state.tr.setNodeMarkup(f.pos, undefined, withNodeMark(f.node, 'size', ptToSize(pt, inBox ?? base, !layout))));
    activeMathField()?.focus();
    return true;
  }
  const sel = state.selection;
  if (sel instanceof NodeSelection && isLayoutObject(sel.node)) {
    // a text box as an object: its base size, and the sizes set inside it go
    let tr = state.tr;
    const apply = (pos: number, n: PMNode) => {
      if (n.type.name === 'ol_group') { n.forEach((c, off) => apply(pos + 1 + off, c)); return; }
      if (n.type.name !== 'ol_box') return;
      tr = tr.setNodeMarkup(pos, undefined, { ...n.attrs, font: Math.abs(pt - base) < 0.01 ? null : pt });
      tr = setSizeIn(tr, pos + 1, pos + n.nodeSize - 1, null);
    };
    apply(sel.from, sel.node);
    view.dispatch(tr.setSelection(NodeSelection.create(tr.doc, sel.from)));
    return true;
  }
  const inBox = boxBase(view, sel.from);
  const value = ptToSize(pt, inBox ?? base, !layout && inBox === null);
  const { empty } = sel;
  if (empty && !(sel instanceof CellSelection)) {
    const type = schema.marks.size;
    const marks = (state.storedMarks ?? sel.$from.marks()).filter(m => m.type !== type);
    view.dispatch(state.tr.setStoredMarks(value ? marks.concat([type.create({ value })]) : marks));
    return true;
  }
  let tr = state.tr;
  for (const r of sel.ranges) tr = setSizeIn(tr, r.$from.pos, r.$to.pos, value);
  view.dispatch(tr);
  return true;
}

/** Set (or clear) the size mark in [from, to): text through the mark, inline nodes through their `marks` attr. */
export function setSizeIn(tr: Transaction, from: number, to: number, value: string | null): Transaction {
  return setValueMarkIn(tr, from, to, 'size', value);
}

/** A value mark over a range — text through ProseMirror marks, inline nodes (formulas, insets) through their `marks` attr. */
export function setValueMarkIn(tr: Transaction, from: number, to: number, name: string, value: string | null): Transaction {
  const type = schema.marks[name];
  tr = tr.removeMark(from, to, type);
  if (value) tr = tr.addMark(from, to, type.create({ value }));
  tr.doc.nodesBetween(from, to, (node, pos) => {
    if (node.isInline && !node.isText && node.attrs.marks !== undefined && pos >= from && pos + node.nodeSize <= to) {
      tr.setNodeMarkup(pos, undefined, withNodeMark(node, name, value), node.marks.filter(m => m.type !== type));
    }
    return true;
  });
  return tr;
}

/** The next size up or down: LaTeX's named sizes in documents, a point ladder on layout pages. */
export function stepSize(view: EditorView, current: number, dir: 1 | -1): number {
  const layout = isLayoutDoc(view.state.doc);
  const ladder = layout ? LAYOUT_LADDER : sizeTable(baseSize(view));
  if (dir > 0) return ladder.find(v => v > current + 0.01) ?? Math.round(current * 1.2);
  return [...ladder].reverse().find(v => v < current - 0.01) ?? Math.max(1, Math.round(current / 1.2));
}

/** point sizes offered on layout pages (slides and posters) */
export const LAYOUT_LADDER = [6, 7, 8, 9, 10, 11, 12, 14, 16, 18, 20, 24, 28, 32, 36, 40, 44, 48, 54, 60, 66, 72, 80, 88, 96, 110, 120, 144];
