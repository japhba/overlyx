/**
 * A transaction of the CRDT as ProseMirror steps at the exact positions it changed.
 *
 * The Yjs events say precisely what happened in each flow: which characters, markers and inline
 * nodes went (by their index before the transaction) and what came where — a delta. Turned into
 * replace steps between the corresponding document positions (a marker inserted is a paragraph
 * split, one deleted a join), mark steps for formatting, and node-markup steps for attributes, the
 * editor learns the change exactly as it was made: the selection, decorations and the undo history
 * map through it correctly. (A diff of the two documents is ambiguous next to repeated letters —
 * "foo " typed before "bar" reads the same as " foo" after the word before — and an undo mapped
 * through the wrong one lands a letter off: a paragraph break restored inside a word.)
 *
 * What this cannot place (the pages and objects of slides, table rows and cells, flows inside them)
 * is left to the caller's diff of what is left (binding.ts remoteTransaction).
 */
import type { MarkType, Node as PMNode, Schema } from 'prosemirror-model';
import { AddMarkStep, AddNodeMarkStep, RemoveMarkStep, RemoveNodeMarkStep, ReplaceStep, type Transform } from 'prosemirror-transform';
import * as Y from 'yjs';
import { BODY, K_BODY, K_NOTES, K_TYPE, PAGES, PARAGRAPH, embedded } from './model.ts';

type Side = 'old' | 'new';

/** what the transaction did to an item's visibility */
function visible(item: Y.Item, side: Side, tr: Y.Transaction): boolean {
  if (side === 'new') return !item.deleted;
  if (item.id.clock >= (tr.beforeState.get(item.id.client) ?? 0)) return false;   // made in it
  return !item.deleted || Y.isDeleted(tr.deleteSet, item.id);                        // deleted in it: was there
}

/** the index of `item` among a flow's countable items visible on `side` */
function indexIn(flow: Y.Text, item: Y.Item, side: Side, tr: Y.Transaction): number {
  let i = 0;
  for (let it = flow._start; it; it = it.right) {
    if (it === item) return i;
    if (it.countable && visible(it, side, tr)) i += it.length;
  }
  return -1;
}

/**
 * The node type an embedded map has on `side`: before the transaction, the entry that was there (one
 * set in it was not; one of a map deleted in it is deleted too, but was there), read from its item.
 */
function typeName(map: Y.Map<unknown>, side: Side, tr: Y.Transaction): unknown {
  if (side === 'new') return map.get(K_TYPE);
  for (let it: Y.Item | null = map._map.get(K_TYPE) ?? null; it; it = it.left as Y.Item | null) {
    if (!visible(it, 'old', tr)) continue;
    const content = it.content.getContent();
    return content[content.length - 1];
  }
  return undefined;
}

/** the item is a paragraph marker on `side` */
function markerOn(item: Y.Item, side: Side, tr: Y.Transaction): boolean {
  const t = embedded(item);
  return t instanceof Y.Map && typeName(t as Y.Map<unknown>, side, tr) === PARAGRAPH;
}

/** the first paragraph of a flow has no marker on `side` */
function implicitOn(flow: Y.Text, side: Side, tr: Y.Transaction): boolean {
  for (let it = flow._start; it; it = it.right) {
    if (!it.countable || !visible(it, side, tr)) continue;
    return !markerOn(it, side, tr);
  }
  return true;
}

const inlineLength = (p: PMNode): number => { let n = 0; p.forEach(c => { n += c.isText ? c.text!.length : 1; }); return n; };

/**
 * The document position of index `t` of a flow whose paragraphs are `container`'s children (its
 * content starting at `start`): inside a paragraph, or — for the index just before a paragraph's
 * marker — at the end of the paragraph before it (before the first paragraph: the container's start).
 */
function indexToPos(container: PMNode, start: number, implicit: boolean, t: number): number | null {
  let y = 0, pos = start;
  for (let i = 0; i < container.childCount; i++) {
    const par = container.child(i);
    const marker = i === 0 && implicit ? 0 : 1;
    const len = inlineLength(par) + marker;
    if (marker && t === y) return i === 0 ? pos : pos - 1;
    if (t <= y + len) {
      let rest = t - y - marker, p = pos + 1;
      for (let j = 0; j < par.childCount && rest > 0; j++) {
        const c = par.child(j);
        if (c.isText) { const take = Math.min(rest, c.text!.length); p += take; rest -= take; }
        else { p += c.nodeSize; rest -= 1; }
      }
      return rest === 0 ? p : null;
    }
    y += len;
    pos += par.nodeSize;
  }
  return t === y ? pos - 1 : null;
}

interface Place { node: PMNode; start: number; implicit: boolean }

/** the nodes the CRDT's maps stood for before the transaction and stand for after it (the reader's) */
export interface NodesOfMaps {
  before(map: Y.Map<unknown>): PMNode | undefined;
  after(map: Y.Map<unknown>): PMNode | undefined;
}

class Locator {
  private cache = new Map<Y.AbstractType<any>, Place | null>();
  private placed = new Map<Y.Map<unknown>, { pos: number; node: PMNode } | null>();
  constructor(readonly ydoc: Y.Doc, readonly doc: PMNode, readonly side: Side, readonly tr: Y.Transaction, readonly schema: Schema, private nodeOf?: (map: Y.Map<unknown>) => PMNode | undefined) {}

  /** where a flow's paragraphs are in the document (null: not a flow this can place) */
  flow(flow: Y.Text): Place | null {
    if (this.cache.has(flow)) return this.cache.get(flow)!;
    let place: Place | null = null;
    try { place = this.findFlow(flow); } catch { place = null; }
    this.cache.set(flow, place);
    return place;
  }

  private findFlow(flow: Y.Text): Place | null {
    const implicit = implicitOn(flow, this.side, this.tr);
    if (flow === this.ydoc.getText(BODY)) {
      if (this.doc.firstChild?.type.name === 'ol_page') return null;
      return { node: this.doc, start: 0, implicit };
    }
    // a nested flow: the body of a node (an inset, a table cell, a text box) or a page's notes
    const holder = flow._item;
    if (!holder || !visible(holder, this.side, this.tr)) return null;
    const map = holder.parent as Y.AbstractType<any>;
    if (!(map instanceof Y.Map)) return null;
    const at = this.node(map as Y.Map<unknown>);
    if (!at) return null;
    if (holder.parentSub === K_BODY) return { node: at.node, start: at.pos + 1, implicit };
    if (holder.parentSub === K_NOTES) {
      const notes = at.node.lastChild;
      if (notes?.type.name !== 'ol_notes') return null;
      return { node: notes, start: at.pos + at.node.nodeSize - notes.nodeSize, implicit };
    }
    return null;
  }

  /**
   * The node a map stands for on this side, and its position: an embed by its index in its flow; a
   * page, an object, a table row or cell by identity (the reader's node for it) — a page among the
   * document's, the others inside the node of the map they belong to (page, table, row).
   */
  node(map: Y.Map<unknown>): { pos: number; node: PMNode } | null {
    if (this.placed.has(map)) return this.placed.get(map)!;
    let at: { pos: number; node: PMNode } | null = null;
    try { at = this.findNode(map); } catch { at = null; }
    this.placed.set(map, at);
    return at;
  }

  private findNode(map: Y.Map<unknown>): { pos: number; node: PMNode } | null {
    const item = map._item;
    if (!item || !visible(item, this.side, this.tr)) return null;
    const parent = item.parent;
    if (parent instanceof Y.Text) return this.embed(map);
    const want = this.nodeOf?.(map);
    if (!want) return null;
    if (parent === this.ydoc.getMap(PAGES)) {
      let pos = 0;
      for (let i = 0; i < this.doc.childCount; i++) {
        const c = this.doc.child(i);
        if (c === want) return { pos, node: c };
        pos += c.nodeSize;
      }
      return null;
    }
    // an object (in its page's map), a row (in its table's list), a cell (in its row's)
    const container = (parent as Y.AbstractType<any>)._item?.parent;
    if (!(container instanceof Y.Map)) return null;
    const outer = this.node(container as Y.Map<unknown>);
    if (!outer) return null;
    let found = -1;
    outer.node.descendants((n, p) => {
      if (found >= 0) return false;
      if (n === want) { found = outer.pos + 1 + p; return false; }
      return !n.isTextblock;
    });
    return found >= 0 ? { pos: found, node: want } : null;
  }

  /** an inline node embedded in a flow: its position and node */
  embed(map: Y.Map<unknown>): { pos: number; node: PMNode; flow: Y.Text; index: number } | null {
    const item = map._item;
    if (!item || item.parentSub !== null || !visible(item, this.side, this.tr)) return null;
    const parent = item.parent;
    if (!(parent instanceof Y.Text)) return null;
    const place = this.flow(parent);
    if (!place) return null;
    const index = indexIn(parent, item, this.side, this.tr);
    if (index < 0) return null;
    const pos = indexToPos(place.node, place.start, place.implicit, index);
    if (pos === null) return null;
    const node = this.doc.nodeAt(pos);
    // (an embed whose type had not arrived yet read as the placeholder)
    if (!node || (node.type.name !== typeName(map, this.side, this.tr) && node.type.name !== 'collab_pending')) return null;
    return { pos, node, flow: parent, index };
  }

  pos(flow: Y.Text, index: number): number | null {
    const place = this.flow(flow);
    return place ? indexToPos(place.node, place.start, place.implicit, index) : null;
  }

  /** a flow position is between its paragraphs (0) or inside one (1) */
  level(flow: Y.Text, pos: number): number {
    const place = this.flow(flow)!;
    return this.doc.resolve(pos).depth - this.doc.resolve(place.start).depth;
  }
}

/**
 * The ends of a region in the old and the new document at the same depth. Only index 0 can be
 * between paragraphs (before a leading marker); where the other side has an implicit first
 * paragraph there, its position inside that paragraph moves out over the paragraph's edge (the
 * region then takes the whole paragraph, opening or closing it). Null: they cannot be matched.
 */
function align(before: Locator, after: Locator, flow: Y.Text, o: number, n: number, end: 'from' | 'to'): [number, number] | null {
  const lo = before.level(flow, o), ln = after.level(flow, n);
  if (lo === ln) return [o, n];
  const out = (doc: PMNode, pos: number): number | null => {
    const $p = doc.resolve(pos);
    if (end === 'from') return $p.parentOffset === 0 ? pos - 1 : null;
    return $p.parentOffset === $p.parent.content.size ? pos + 1 : null;
  };
  if (lo > ln) { const p = out(before.doc, o); return p === null ? null : [p, n]; }
  const p = out(after.doc, n);
  return p === null ? null : [o, p];
}

/**
 * Apply to `tr` (on the document `old`, what the CRDT read as before `ytr`) the steps that bring it
 * as far as they can towards `next` (what it reads as after). Returns whether any step was made.
 */
export function preciseSteps(tr: Transform, old: PMNode, next: PMNode, ytr: Y.Transaction, ydoc: Y.Doc, schema: Schema, nodes?: NodesOfMaps): boolean {
  const before = new Locator(ydoc, old, 'old', ytr, schema, nodes && (m => nodes.before(m)));
  const after = new Locator(ydoc, next, 'new', ytr, schema, nodes && (m => nodes.after(m)));
  let made = false;
  // the flows the transaction changed, outer ones first (an inner change inside a replaced outer range is skipped)
  const flows: { flow: Y.Text; depth: number; event: Y.YTextEvent }[] = [];
  for (const type of ytr.changed.keys()) {
    if (!(type instanceof Y.Text)) continue;
    const item = type._item;
    if (item && (!visible(item, 'old', ytr) || item.deleted)) continue;   // a new or deleted flow: part of an outer change
    const event = ytr.changedParentTypes.get(type as Y.AbstractType<any>)?.find(e => e.target === type) as Y.YTextEvent | undefined;
    if (!event) continue;
    let depth = 0;
    for (let t: Y.AbstractType<any> | null = type; t?._item; t = t._item.parent as Y.AbstractType<any>) depth++;
    flows.push({ flow: type, depth, event });
  }
  flows.sort((a, b) => a.depth - b.depth);
  for (const { flow, event } of flows) {
    if (!before.flow(flow) || !after.flow(flow)) continue;
    // the delta as regions: old [a0, a1) became new [b0, b1); formatting of old [a0, a1)
    type Region = { a0: number; a1: number; b0: number; b1: number; attrs?: Record<string, unknown> };
    const regions: Region[] = [];
    let oi = 0, ni = 0;
    let open: Region | null = null;
    for (const op of event.delta as { insert?: unknown; retain?: number; delete?: number; attributes?: Record<string, unknown> }[]) {
      if (op.retain !== undefined) {
        if (open) { regions.push(open); open = null; }
        if (op.attributes) regions.push({ a0: oi, a1: oi + op.retain, b0: ni, b1: ni + op.retain, attrs: op.attributes });
        oi += op.retain; ni += op.retain;
      } else if (op.delete !== undefined) {
        if (!open) open = { a0: oi, a1: oi, b0: ni, b1: ni };
        oi += op.delete; open.a1 = oi;
      } else if (op.insert !== undefined) {
        const len = typeof op.insert === 'string' ? op.insert.length : 1;
        if (!open) open = { a0: oi, a1: oi, b0: ni, b1: ni };
        ni += len; open.b1 = ni;
      }
    }
    if (open) regions.push(open);
    // from the last: what comes before a region keeps its positions
    for (let k = regions.length - 1; k >= 0; k--) {
      const r = regions[k];
      let from = before.pos(flow, r.a0), to = before.pos(flow, r.a1);
      if (from === null || to === null) continue;
      let nf: number | null = null, nt: number | null = null;
      if (!r.attrs) {
        nf = after.pos(flow, r.b0); nt = after.pos(flow, r.b1);
        if (nf === null || nt === null) continue;
        const af = align(before, after, flow, from, nf, 'from'), at = align(before, after, flow, to, nt, 'to');
        if (!af || !at) continue;
        [from, nf] = af; [to, nt] = at;
      }
      const mf = tr.mapping.mapResult(from, 1), mt = tr.mapping.mapResult(to, -1);
      if (mf.deleted || mt.deleted) continue;
      try {
        if (r.attrs) {
          for (const [key, value] of Object.entries(r.attrs)) {
            const type = schema.marks[key];
            if (type && format(tr, mf.pos, mt.pos, type, value as Record<string, unknown> | null)) made = true;
          }
          continue;
        }
        if (nf === null || nt === null || nt < nf) continue;
        const res = tr.maybeStep(new ReplaceStep(mf.pos, Math.max(mf.pos, mt.pos), next.slice(nf, nt)));
        if (!res.failed) made = true;
      } catch { /* left to the diff */ }
    }
  }
  // attributes of paragraphs (markers) and nodes changed in place
  for (const [type, keys] of ytr.changed) {
    if (!(type instanceof Y.Map) || !keys.size) continue;
    const map = type as Y.Map<unknown>;
    const name = map.get(K_TYPE);
    if (typeof name !== 'string') continue;
    const item = map._item;
    if (!item || !visible(item, 'old', ytr) || item.deleted) continue;
    try {
      if (name === PARAGRAPH && item.parent instanceof Y.Text) {
        const flow = item.parent as Y.Text;
        const oi = indexIn(flow, item, 'old', ytr), ni = indexIn(flow, item, 'new', ytr);
        const oc = before.pos(flow, oi + 1), nc = after.pos(flow, ni + 1);
        if (oc === null || nc === null) continue;
        const m = tr.mapping.mapResult(oc - 1, 1);
        if (m.deleted) continue;
        const target = tr.doc.nodeAt(m.pos), wanted = next.resolve(nc).parent;
        if (!target || target.type.name !== PARAGRAPH || wanted.type.name !== PARAGRAPH) continue;
        if (!sameAttrs(target.attrs, wanted.attrs)) { tr.setNodeMarkup(m.pos, undefined, wanted.attrs); made = true; }
      } else {
        const o = before.node(map), n = after.node(map);
        if (!o || !n) continue;
        const m = tr.mapping.mapResult(o.pos, 1);
        if (m.deleted) continue;
        const target = tr.doc.nodeAt(m.pos);
        if (!target) continue;
        // a placeholder whose node has fully arrived: the node in its place
        if (target.type.name === 'collab_pending' && n.node.type !== target.type) { tr.replaceWith(m.pos, m.pos + target.nodeSize, n.node); made = true; continue; }
        if (target.type !== n.node.type) continue;
        if (!sameAttrs(target.attrs, n.node.attrs)) { tr.setNodeMarkup(m.pos, undefined, n.node.attrs, target.marks); made = true; }
      }
    } catch { /* left to the diff */ }
  }
  return made;
}

/**
 * Set a mark on the inline nodes between `from` and `to` (or, `attrs` null, remove the one of its
 * type) at the flow's own level, as the CRDT's formatting does: an inset in the range carries the
 * mark itself, the text inside it is another flow's (Transform.addMark would do the reverse).
 */
function format(tr: Transform, from: number, to: number, type: MarkType, attrs: Record<string, unknown> | null): boolean {
  const steps: (AddMarkStep | RemoveMarkStep | AddNodeMarkStep | RemoveNodeMarkStep)[] = [];
  const mark = attrs ? type.create(attrs) : null;
  tr.doc.nodesBetween(from, to, (node, pos, parent) => {
    if (!node.isInline) return true;
    if (!node.isText) {
      if (pos < from) return true;   // the inset whose text the range is in
      const has = type.isInSet(node.marks);
      if (mark) { if (!mark.isInSet(node.marks) && parent?.type.allowsMarkType(type)) steps.push(new AddNodeMarkStep(pos, mark)); }
      else if (has) steps.push(new RemoveNodeMarkStep(pos, has));
      return false;
    }
    const a = Math.max(pos, from), b = Math.min(pos + node.nodeSize, to);
    if (a >= b) return false;
    const has = type.isInSet(node.marks);
    if (mark) { if (!mark.isInSet(node.marks) && parent?.type.allowsMarkType(type)) steps.push(new AddMarkStep(a, b, mark)); }
    else if (has) steps.push(new RemoveMarkStep(a, b, has));
    return false;
  });
  // none of them moves a position
  let made = false;
  for (const step of steps) if (!tr.maybeStep(step).failed) made = true;
  return made;
}

const sameAttrs = (a: Record<string, unknown>, b: Record<string, unknown>) => JSON.stringify(a) === JSON.stringify(b);
