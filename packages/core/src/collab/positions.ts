/**
 * Positions between a ProseMirror document and the model-2 CRDT it was read from (read.ts): a
 * document position as a place in a flow (or in a list of rows, cells or ids), and back. Cursors,
 * selections and anchors kept as Yjs relative positions stay with the text they are next to, through
 * anybody's edits; a paragraph split or join moves no text, so they move with nothing either.
 *
 * Both directions need `doc` to be exactly what the CRDT reads as.
 */
import type { Node as PMNode, Schema } from 'prosemirror-model';
import * as Y from 'yjs';
import {
  BODY, PAGES, PAGE_ORDER, K_BODY, K_ROWS, K_CELLS, K_NOTES, K_TYPE, K_OBJECTS,
  shapeOf, typeOfMap, embedded, leadsWithMarker, effectiveOrder, pageObjectIds,
} from './model.ts';

/** a place in the CRDT: an index into a flow (Y.Text) or into a list (Y.Array) */
export interface YPlace { type: Y.Text | Y.Array<unknown>; index: number }

const inlineLength = (p: PMNode): number => { let n = 0; p.forEach(c => { n += c.isText ? c.text!.length : 1; }); return n; };

/** the live index in a Y.Text / Y.Array of the item `item` (a child of it) */
function indexOf(parent: Y.AbstractType<any>, item: Y.Item): number {
  let i = 0;
  for (let it = parent._start; it; it = it.right) {
    if (it === item) return i;
    if (!it.deleted && it.countable) i += it.length;
  }
  return -1;
}

/** the map embedded at a flow index */
function mapAt(flow: Y.Text, index: number): Y.Map<unknown> | null {
  let i = 0;
  for (let it = flow._start; it; it = it.right) {
    if (it.deleted || !it.countable) continue;
    if (i === index) { const t = embedded(it); return t instanceof Y.Map ? t as Y.Map<unknown> : null; }
    i += it.length;
    if (i > index) return null;
  }
  return null;
}

/** raw indices of a list's entries that the reading uses (Y.Maps of an accepted type) */
function validEntries(schema: Schema, list: Y.Array<unknown>, role: (r: unknown) => boolean): number[] {
  const out: number[] = [];
  list.toArray().forEach((m, i) => { if (m instanceof Y.Map) { const t = typeOfMap(schema, m); if (t && role(t.spec.tableRole)) out.push(i); } });
  return out;
}
const isRow = (r: unknown) => r === 'row';
const isCell = (r: unknown) => r === 'cell' || r === 'header_cell';

/**
 * Where document position `pos` is in the CRDT. Positions inside a flow are exact; positions between
 * the pages or objects of a slide (no text there) are given in the nearest flow or list.
 */
export function yPlace(schema: Schema, ydoc: Y.Doc, doc: PMNode, pos: number): YPlace | null {
  const $pos = doc.resolve(Math.max(0, Math.min(pos, doc.content.size)));
  const layout = doc.firstChild?.type.name === 'ol_page';
  if (!layout) return inFlow(schema, ydoc.getText(BODY), doc, $pos, 0);
  // a layout document: page → (object → …)
  if ($pos.depth === 0) return { type: ydoc.getArray(PAGE_ORDER), index: rawOrderIndex(ydoc.getArray(PAGE_ORDER), pageIds(ydoc), $pos.index(0)) };
  const pages = ydoc.getMap<Y.Map<unknown>>(PAGES);
  const pid = pageIds(ydoc)[$pos.index(0)];
  const page = pid ? pages.get(pid) : undefined;
  if (!page) return null;
  const pageNode = $pos.node(1);
  if ($pos.depth === 1) return null;   // between objects: no text there
  const first = pageNode.child($pos.index(1));
  if (first.type.name === 'ol_notes') {
    const notes = page.get(K_NOTES);
    return notes instanceof Y.Text ? inFlow(schema, notes, first, $pos, 2) : null;
  }
  // the object the position is in: down through groups to a text box
  let k = 0, node = pageNode, depth = 1;
  for (;;) {
    const i = $pos.index(depth);
    for (let j = 0; j < i; j++) k += objectCount(node.child(j));
    const c = node.child(i);
    if (shapeOf(c.type) === 'objects' && $pos.depth > depth + 1) { k += 1; node = c; depth++; continue; }
    if (shapeOf(c.type) !== 'flow' || $pos.depth <= depth + 1 - 1) return null;
    const id = pageObjectIds(schema, page)[k];
    const m = id ? (page.get(K_OBJECTS) as Y.Map<Y.Map<unknown>> | undefined)?.get(id) : undefined;
    const body = m?.get(K_BODY);
    if (!(body instanceof Y.Text) || $pos.depth < depth + 1) return null;
    return inFlow(schema, body, c, $pos, depth + 1);
  }
}

/** a node and the objects inside it, depth first (notes are none) */
function objectCount(node: PMNode): number {
  if (node.type.name === 'ol_notes') return 0;
  let n = 1;
  if (shapeOf(node.type) === 'objects') node.forEach(c => { n += objectCount(c); });
  return n;
}

/** a position inside a flow whose container node is `container` at depth `depth` of `$pos` */
function inFlow(schema: Schema, flow: Y.Text, container: PMNode, $pos: import('prosemirror-model').ResolvedPos, depth: number): YPlace | null {
  const implicit = !leadsWithMarker(flow);
  const parIdx = $pos.index(depth);
  let start = 0;
  for (let i = 0; i < parIdx && i < container.childCount; i++) start += inlineLength(container.child(i)) + (i === 0 && implicit ? 0 : 1);
  if ($pos.depth === depth) return { type: flow, index: start };
  const par = container.child(parIdx);
  const marker = parIdx === 0 && implicit ? 0 : 1;
  // inside the paragraph: count its content up to the position (or the inline node it is inside)
  const off = $pos.depth === depth + 1 ? $pos.parentOffset : $pos.posAtIndex($pos.index(depth + 1), depth + 1) - $pos.start(depth + 1);
  let y = 0, o = 0;
  for (let i = 0; i < par.childCount && o < off; i++) {
    const c = par.child(i);
    if (c.isText) { const take = Math.min(c.nodeSize, off - o); y += take; o += take; }
    else { y += 1; o += c.nodeSize; }
  }
  const index = start + marker + y;
  if ($pos.depth === depth + 1) return { type: flow, index };
  // inside an inline node (an inset, a table): into its own flow or rows
  const node = $pos.node(depth + 2);
  const map = mapAt(flow, index);
  if (!map || typeOfMap(schema, map) !== node.type) return { type: flow, index };
  return inNode(schema, map, node, $pos, depth + 2) ?? { type: flow, index };
}

/** a position inside an embedded node (inset, table) at depth `depth` */
function inNode(schema: Schema, map: Y.Map<unknown>, node: PMNode, $pos: import('prosemirror-model').ResolvedPos, depth: number): YPlace | null {
  switch (shapeOf(node.type)) {
    case 'flow': { const body = map.get(K_BODY); return body instanceof Y.Text ? inFlow(schema, body, node, $pos, depth) : null; }
    case 'rows': case 'cells': {
      const list = map.get(shapeOf(node.type) === 'rows' ? K_ROWS : K_CELLS);
      if (!(list instanceof Y.Array)) return null;
      const valid = validEntries(schema, list, shapeOf(node.type) === 'rows' ? isRow : isCell);
      const i = $pos.index(depth);
      if ($pos.depth === depth) return { type: list, index: i < valid.length ? valid[i] : list.length };
      const child = list.get(valid[i]);
      return child instanceof Y.Map ? inNode(schema, child as Y.Map<unknown>, $pos.node(depth + 1), $pos, depth + 1) : null;
    }
    default: return null;
  }
}

function pageIds(ydoc: Y.Doc): string[] {
  const pages = ydoc.getMap<Y.Map<unknown>>(PAGES);
  return effectiveOrder(ydoc.getArray(PAGE_ORDER), id => { const p = pages.get(id); return p instanceof Y.Map && p.get(K_TYPE) === 'ol_page'; });
}

function rawOrderIndex(order: Y.Array<string>, ids: string[], i: number): number {
  if (i >= ids.length) return order.length;
  const raw = order.toArray();
  const at = raw.indexOf(ids[i]);
  return at < 0 ? order.length : at;
}

/** A relative position for document position `pos` (assoc as Yjs: ≥ 0 sticks to what follows, < 0 to what precedes). */
export function relativePosition(schema: Schema, ydoc: Y.Doc, doc: PMNode, pos: number, assoc = 0): Y.RelativePosition | null {
  const p = yPlace(schema, ydoc, doc, pos);
  return p ? Y.createRelativePositionFromTypeIndex(p.type, p.index, assoc) : null;
}

/** The document position of a relative position (null: in content that is gone or not shown). */
export function documentPosition(schema: Schema, ydoc: Y.Doc, doc: PMNode, rel: Y.RelativePosition): number | null {
  const abs = Y.createAbsolutePositionFromRelativePosition(rel, ydoc);
  if (!abs) return null;
  return placeToPos(schema, ydoc, doc, abs.type, abs.index);
}

/** The document position of a place in the CRDT (null: not part of what the document shows). */
export function placeToPos(schema: Schema, ydoc: Y.Doc, doc: PMNode, type: Y.AbstractType<any>, index: number): number | null {
  // the chain of containers from the root down to `type`
  const chain: { type: Y.AbstractType<any>; via: Y.Item | null }[] = [];
  let t: Y.AbstractType<any> = type;
  for (let guard = 0; guard < 200; guard++) {
    const item = t._item;
    chain.unshift({ type: t, via: item });
    if (!item) break;
    if (item.deleted) return null;
    t = item.parent as Y.AbstractType<any>;
  }
  const root = chain[0].type;
  const layout = doc.firstChild?.type.name === 'ol_page';
  if (!layout) {
    if (root !== ydoc.getText(BODY)) return null;
    return descendFlow(schema, chain, 0, doc, 0, index);
  }
  if (root === ydoc.getArray(PAGE_ORDER)) {
    // between pages: the index-th raw entry's page
    const ids = pageIds(ydoc);
    const raw = (root as Y.Array<string>).toArray();
    let n = 0;
    for (let i = 0; i < index && i < raw.length; i++) if (ids.includes(raw[i]) && raw.indexOf(raw[i]) === i) n++;
    let pos = 0;
    for (let i = 0; i < n && i < doc.childCount; i++) pos += doc.child(i).nodeSize;
    return pos;
  }
  if (root !== ydoc.getMap(PAGES)) return null;
  // root map → page map (key: id) → objects map / notes → …
  const pageMap = chain[1]?.type as Y.Map<unknown> | undefined;
  const pid = chain[1]?.via?.parentSub;
  if (!pageMap || !pid) return null;
  const pi = pageIds(ydoc).indexOf(pid);
  if (pi < 0 || pi >= doc.childCount) return null;
  let pagePos = 0;
  for (let i = 0; i < pi; i++) pagePos += doc.child(i).nodeSize;
  const pageNode = doc.child(pi);
  const next = chain[2];
  if (!next) return pagePos + 1;
  if (next.via?.parentSub === K_NOTES) {
    const notes = pageNode.lastChild;
    if (!notes || notes.type.name !== 'ol_notes') return null;
    return descendFlow(schema, chain, 2, notes, pagePos + 1 + pageNode.content.size - notes.nodeSize + 1, index);
  }
  if (next.via?.parentSub !== K_OBJECTS) return null;
  const obj = chain[3];
  const oid = obj?.via?.parentSub;
  if (!obj || !oid) return null;
  const ids = pageObjectIds(schema, pageMap);
  const k = ids.indexOf(oid);
  if (k < 0) return null;
  // the k-th object depth first
  let n = 0;
  let hit: { node: PMNode; pos: number } | null = null;
  const walk = (node: PMNode, start: number) => {
    node.forEach((c, off) => {
      if (hit || c.type.name === 'ol_notes') return;
      if (n++ === k) { hit = { node: c, pos: start + off }; return; }
      if (shapeOf(c.type) === 'objects') walk(c, start + off + 1);
    });
  };
  walk(pageNode, pagePos + 1);
  if (!hit) return null;
  const h = hit as { node: PMNode; pos: number };
  if (chain.length === 4) return h.pos;
  if (chain[4].via?.parentSub !== K_BODY) return h.pos;
  return descendFlow(schema, chain, 4, h.node, h.pos + 1, index);
}

/**
 * chain[ci] is a flow whose container node is `container` with content starting at `start`; the
 * place is `index` in chain[last] (or deeper down the chain).
 */
function descendFlow(schema: Schema, chain: { type: Y.AbstractType<any>; via: Y.Item | null }[], ci: number, container: PMNode, start: number, index: number): number | null {
  const flow = chain[ci].type as Y.Text;
  const deeper = ci + 1 < chain.length;
  // the index in this flow we are after: the place itself, or the embed the chain goes through
  let target = index;
  if (deeper) {
    // chain[ci+1] is the embedded map (its item is in this flow)
    const item = chain[ci + 1].via!;
    target = indexOf(flow, item);
    if (target < 0) return null;
  }
  const implicit = !leadsWithMarker(flow);
  // index t is in paragraph i when y_i + marker_i ≤ t ≤ y_i + len_i: the index right before a marker is
  // the end of the paragraph before it
  let y = 0, pos = start;
  for (let i = 0; i < container.childCount; i++) {
    const par = container.child(i);
    const marker = i === 0 && implicit ? 0 : 1;
    const len = inlineLength(par) + marker;
    if (target > y + len && i < container.childCount - 1) { y += len; pos += par.nodeSize; continue; }
    let rest = Math.max(0, target - y - marker);
    let p = pos + 1;
    for (let j = 0; j < par.childCount; j++) {
      const c = par.child(j);
      if (c.isText) {
        const n = c.text!.length;
        if (rest < n || (rest === n && !deeper)) { if (deeper) return null; return p + rest; }
        rest -= n; p += c.nodeSize;
      } else {
        if (rest === 0) return deeper ? descendNode(schema, chain, ci + 1, c, p, index) : p;
        rest -= 1; p += c.nodeSize;
      }
    }
    return deeper ? null : p;
  }
  return deeper ? null : pos;
}

/** chain[ci] is the map of node `node` at position `pos` */
function descendNode(schema: Schema, chain: { type: Y.AbstractType<any>; via: Y.Item | null }[], ci: number, node: PMNode, pos: number, index: number): number | null {
  const next = chain[ci + 1];
  if (!next) return pos;
  const key = next.via?.parentSub;
  if (key === K_BODY && shapeOf(node.type) === 'flow') return descendFlow(schema, chain, ci + 1, node, pos + 1, index);
  if ((key === K_ROWS || key === K_CELLS) && (shapeOf(node.type) === 'rows' || shapeOf(node.type) === 'cells')) {
    const list = next.type as Y.Array<unknown>;
    const valid = validEntries(schema, list, key === K_ROWS ? isRow : isCell);
    const deeper = ci + 2 < chain.length;
    const rawIdx = deeper ? indexOf(list, chain[ci + 2].via!) : index;
    let k = 0;
    while (k < valid.length && valid[k] < rawIdx) k++;
    let p = pos + 1;
    for (let i = 0; i < k && i < node.childCount; i++) p += node.child(i).nodeSize;
    if (!deeper) return p;
    if (valid[k] !== rawIdx || k >= node.childCount) return null;
    return descendNode(schema, chain, ci + 2, node.child(k), p, index);
  }
  return pos;
}
