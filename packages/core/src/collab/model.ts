/**
 * How a document lives in its Yjs CRDT (model 2: flows).
 *
 * Every place that holds paragraphs — the body of a linear document, the body of an inset, a table
 * cell, a slide's text box, a slide's speaker notes — is one *flow*: a single Y.Text holding the
 * paragraphs one after the other, the way LyX itself stores them. A paragraph begins with a
 * *marker*, an embedded Y.Map holding its attributes (layout, depth, …); its text follows as
 * characters whose formatting (the marks) are Y.Text attributes, and its inline nodes (formulas,
 * citations, insets, tables, …) are embedded Y.Maps holding their attributes and, for insets and
 * tables, their own flows. So pressing Enter inserts a marker and joining two paragraphs deletes
 * one: no text is ever copied, and whatever a co-author typed meanwhile — online, offline, before or
 * after the split — stays exactly where they typed it. (Model 1 kept every paragraph as an element
 * of its own; a split deleted the second half and inserted a copy, and a server-side repair had to
 * move late edits after the copies.)
 *
 * Pages and positioned objects of a layout document (slides, posters) are Y.Maps under stable ids;
 * their order is a Y.Array of ids per container (the pages; a page's or a group's objects). Moving a
 * slide, bringing an object forward or grouping objects moves the id, never the content, so
 * concurrent edits inside it survive. Table rows and cells are Y.Arrays of Y.Maps.
 *
 * The reading (read.ts) is total: any state of the CRDT, including the ones concurrent edits make
 * (a paragraph's marker deleted while somebody typed in it, an id ordered twice, a group whose
 * objects all went elsewhere), reads as a valid document, the same on every replica:
 *  - text before the first marker of a flow is a first paragraph with default attributes (an
 *    *implicit* paragraph; an empty flow reads as one empty paragraph);
 *  - an id ordered more than once counts where it is first ordered; ids of pages or objects that do
 *    not exist are skipped; objects no container orders come last at the top of their page;
 *  - content a node cannot hold is dropped from the reading (it stays in the CRDT).
 *
 * Attributes equal to the schema's default are not stored (an absent key reads as the default).
 */
import type { NodeType, Node as PMNode, Schema } from 'prosemirror-model';
import * as Y from 'yjs';

/** the model this module reads and writes (stored in the `meta` map under MODEL_KEY) */
export const MODEL = 2;
export const MODEL_KEY = 'model';

/** root Y.Text: the flow of a linear document */
export const BODY = 'body';
/** root Y.Map: a layout document's pages by id */
export const PAGES = 'pages';
/** root Y.Array: the order of the pages (ids) */
export const PAGE_ORDER = 'pageOrder';

/** the node type of a marker or embed (`paragraph`, `math_inline`, `ol_page`, …) */
export const K_TYPE = '$t';
/** an inset's, a table cell's or a text box's flow (Y.Text) */
export const K_BODY = '$body';
/** a table's rows (Y.Array of Y.Map) */
export const K_ROWS = '$rows';
/** a table row's cells (Y.Array of Y.Map) */
export const K_CELLS = '$cells';
/** a page's objects by id (Y.Map of Y.Map), its own and its groups' */
export const K_OBJECTS = '$objects';
/** the order of a page's or a group's objects (Y.Array of ids) */
export const K_ORDER = '$order';
/** a page's speaker notes (Y.Text flow; absent: no notes) */
export const K_NOTES = '$notes';

/** the paragraph node type (the only block in a flow) */
export const PARAGRAPH = 'paragraph';

/** What a node type holds in the CRDT. */
export type Shape = 'flow' | 'rows' | 'cells' | 'objects' | 'page' | 'atom';

const shapes = new WeakMap<NodeType, Shape>();
/** A node type's shape: what its content is stored as. */
export function shapeOf(type: NodeType): Shape {
  let s = shapes.get(type);
  if (s) return s;
  const content = String(type.spec.content ?? '').trim();
  if (!content) s = 'atom';
  else if (/^block[+*]$/.test(content)) s = 'flow';
  else if (type.name === 'ol_page') s = 'page';
  else if (/^ol_object[+*]$/.test(content)) s = 'objects';
  else if (/table_row/.test(content)) s = 'rows';
  else if (/table_cell|table_header/.test(content)) s = 'cells';
  else s = 'atom';
  shapes.set(type, s);
  return s;
}

/** values are compared as JSON (attributes are JSON values) */
export function sameValue(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (a === null || b === null || typeof a !== 'object' || typeof b !== 'object') return false;
  return JSON.stringify(a) === JSON.stringify(b);
}

/** A node's attributes as stored: the type, and every attribute that differs from its default. */
export function storedAttrs(node: PMNode): Record<string, unknown> {
  const out: Record<string, unknown> = { [K_TYPE]: node.type.name };
  const specs = node.type.spec.attrs ?? {};
  for (const [k, v] of Object.entries(node.attrs)) {
    const spec = specs[k] as { default?: unknown } | undefined;
    if (spec && 'default' in spec && sameValue(spec.default, v)) continue;
    if (v === undefined) continue;
    out[k] = v;
  }
  return out;
}

/** The attributes of a node of `type` stored in `map` (absent ones: the defaults; unknown keys ignored). */
export function attrsFrom(type: NodeType, map: Y.Map<unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  const specs = type.spec.attrs ?? {};
  for (const k of Object.keys(specs)) {
    const v = map.get(k);
    if (v !== undefined) out[k] = v;
  }
  return out;
}

/** Bring `map`'s attributes from `from`'s to `to`'s (both nodes of the map's type). */
export function updateAttrs(map: Y.Map<unknown>, from: PMNode | null, to: PMNode): void {
  const specs = to.type.spec.attrs ?? {};
  for (const k of Object.keys(specs)) {
    const v = to.attrs[k];
    if (from && sameValue(from.attrs[k], v)) continue;
    const spec = specs[k] as { default?: unknown };
    if ('default' in spec && sameValue(spec.default, v)) { if (map.has(k)) map.delete(k); }
    else if (!sameValue(map.get(k), v)) map.set(k, v);
  }
}

/** The node type an embed or marker stands for (null: not a node of this schema). */
export function typeOfMap(schema: Schema, map: Y.Map<unknown>): NodeType | null {
  const t = map.get(K_TYPE);
  return typeof t === 'string' ? schema.nodes[t] ?? null : null;
}

/** an item's content type, if it embeds one */
export const embedded = (item: Y.Item): Y.AbstractType<any> | null => (item.content instanceof Y.ContentType ? item.content.type : null);

/** the item is a paragraph marker */
export function isMarkerItem(item: Y.Item): boolean {
  const t = embedded(item);
  return t instanceof Y.Map && t.get(K_TYPE) === PARAGRAPH;
}

/** The flow begins with a marker (else its first paragraph is implicit: default attributes, no marker). */
export function leadsWithMarker(flow: Y.Text): boolean {
  for (let it = flow._start; it; it = it.right) {
    if (it.deleted || !it.countable) continue;
    return isMarkerItem(it);
  }
  return false;
}

/** A fresh id for a page or an object. */
export function newId(): string {
  const bytes = new Uint8Array(9);
  const c = (globalThis as { crypto?: { getRandomValues?(a: Uint8Array): Uint8Array } }).crypto;
  if (c?.getRandomValues) c.getRandomValues(bytes);
  else for (let i = 0; i < bytes.length; i++) bytes[i] = Math.floor(Math.random() * 256);
  let s = '';
  for (const b of bytes) s += 'abcdefghijklmnopqrstuvwxyz0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ_-'[b & 63];
  return s;
}

/**
 * The effective order of a container: each id where it is first ordered, if it exists (has() true).
 * The reading and the writing agree on it.
 */
export function effectiveOrder(order: Y.Array<any> | undefined, has: (id: string) => boolean, seen = new Set<string>()): string[] {
  const out: string[] = [];
  if (!order) return out;
  for (const id of order.toArray()) {
    if (typeof id !== 'string' || seen.has(id) || !has(id)) continue;
    seen.add(id);
    out.push(id);
  }
  return out;
}

/** The document is stored in model 2. */
export function isModel2(ydoc: Y.Doc): boolean {
  return ydoc.getMap('meta').get(MODEL_KEY) === String(MODEL);
}

/** Mark the document as stored in model 2. */
export function markModel2(ydoc: Y.Doc): void {
  const meta = ydoc.getMap<string>('meta');
  if (meta.get(MODEL_KEY) !== String(MODEL)) meta.set(MODEL_KEY, String(MODEL));
}

/** The document holds content in model 1 (y-prosemirror's `prosemirror` XmlFragment). */
export function hasModel1Content(ydoc: Y.Doc): boolean {
  return ydoc.share.has('prosemirror') && ydoc.getXmlFragment('prosemirror').length > 0;
}

/**
 * The ids of a page's objects in the order its reading gives them: depth first, each group before
 * its objects (a group none of whose objects is read is not read either), the objects no container
 * orders last. read.ts, write.ts and positions.ts agree on it through this.
 */
export function pageObjectIds(schema: Schema, page: Y.Map<unknown>): string[] {
  const all = page.get(K_OBJECTS);
  if (!(all instanceof Y.Map)) return [];
  const ids: string[] = [];
  const exists = (id: string) => { const o = all.get(id); const t = o instanceof Y.Map ? typeOfMap(schema, o) : null; return !!t && t.isInGroup('ol_object'); };
  const seen = new Set<string>();
  const one = (id: string, depth: number) => {
    const m = all.get(id) as Y.Map<unknown>;
    if (shapeOf(typeOfMap(schema, m)!) !== 'objects') { ids.push(id); return; }
    if (depth > 32) return;
    const at = ids.length;
    ids.push(id);
    visit(m.get(K_ORDER), depth + 1);
    if (ids.length === at + 1) ids.pop();
  };
  const visit = (order: unknown, depth: number) => {
    for (const id of effectiveOrder(order instanceof Y.Array ? order : undefined, exists, seen)) one(id, depth);
  };
  visit(page.get(K_ORDER), 0);
  for (const id of [...all.keys()].sort()) {
    if (seen.has(id) || !exists(id)) continue;
    seen.add(id);
    one(id, 0);
  }
  return ids;
}
