/**
 * Reading a model-2 CRDT (model.ts) as a ProseMirror document.
 *
 * A Reader keeps what it read last: each paragraph by its marker (the implicit first paragraph of a
 * flow by the flow), each embedded node, row, cell, page and object by its Y.Map. Reading again
 * after a transaction rebuilds only what the transaction touched — a paragraph is read again when
 * an item in it was inserted or deleted, when one of its embeds changed, when it ends at another
 * marker than before or begins with other formatting in effect — and gives back the same node
 * objects for everything else, so that a ProseMirror view sees exactly which nodes changed. The
 * caches must see every transaction that changes the document (`read(tr)` after each), or nothing:
 * `read()` without a transaction reads everything afresh.
 */
import { Fragment, Mark, type Node as PMNode, type NodeType, type Schema } from 'prosemirror-model';
import * as Y from 'yjs';
import {
  BODY, PAGES, PAGE_ORDER, K_BODY, K_ROWS, K_CELLS, K_OBJECTS, K_ORDER, K_NOTES, K_TYPE, PARAGRAPH,
  shapeOf, attrsFrom, typeOfMap, embedded, isMarkerItem, effectiveOrder,
} from './model.ts';

/** a paragraph as last read: its node, where it ended, the formatting at its start, its embeds' maps in order */
interface ParEntry { node: PMNode; end: Y.Item | null; attrs: string; embeds: Y.Map<unknown>[] }
/** a node as last read, and the maps of its children in order (rows, cells; a page's objects) */
interface NodeEntry { node: PMNode; children: Y.Map<unknown>[] }
/** a flow as last read: its paragraphs' keys and nodes */
interface FlowEntry { keys: Y.AbstractType<any>[]; nodes: PMNode[] }

/** one paragraph of a flow as found by the walk */
interface Seg {
  key: Y.AbstractType<any>;
  marker: Y.Map<unknown> | null;
  first: Y.Item | null;
  end: Y.Item | null;
  dirty: boolean;
  attrs: Map<string, unknown>;
  attrsKey: string;
  content: boolean;
}

/** a paragraph's inline nodes (not text) */
const countInline = (p: PMNode): number => { let n = 0; p.forEach(c => { if (!c.isText) n++; }); return n; };

const attrsKeyOf = (attrs: Map<string, unknown>): string => {
  if (attrs.size === 0) return '';
  return JSON.stringify([...attrs.entries()].sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0)));
};

export class Reader {
  private pars = new WeakMap<Y.AbstractType<any>, ParEntry>();
  private nodes = new WeakMap<Y.Map<unknown>, NodeEntry>();
  private flows = new WeakMap<Y.Text, FlowEntry>();
  /** the pages of the last reading (their maps, in order) */
  private pageMaps: Y.Map<unknown>[] = [];
  private markCache = new Map<string, readonly Mark[]>();
  private tr: Y.Transaction | null = null;
  private full = true;
  private emptyPar: PMNode;
  private pending: PMNode;

  constructor(readonly schema: Schema, readonly ydoc: Y.Doc) {
    this.emptyPar = schema.nodes[PARAGRAPH].create();
    this.pending = schema.nodes.collab_pending.create();
  }

  get body(): Y.Text { return this.ydoc.getText(BODY); }

  /** the node a map (an embed, a row, a cell, an object, a page) stood for in the last reading */
  nodeOf(map: Y.Map<unknown>): PMNode | undefined { return this.nodes.get(map)?.node; }
  get pages(): Y.Map<Y.Map<unknown>> { return this.ydoc.getMap(PAGES); }
  get pageOrder(): Y.Array<string> { return this.ydoc.getArray(PAGE_ORDER); }

  /**
   * The document. With `tr` (the transaction just applied; the reader has read the state before
   * it), only what the transaction touched is read again; without, everything.
   */
  read(tr?: Y.Transaction | null): PMNode {
    this.tr = tr ?? null;
    this.full = !tr;
    try {
      const pages = this.readPages();
      return pages.length
        ? this.schema.topNodeType.create(null, pages)
        : this.schema.topNodeType.create(null, this.readFlow(this.body));
    } finally { this.tr = null; this.full = true; }
  }

  /**
   * Take `doc`, equal to the last reading, as that reading: its node objects stand for what they
   * equal from now on, so that the next readings give them back where nothing changed (a view's
   * document: ProseMirror then sees which of its own nodes changed).
   */
  adopt(doc: PMNode): void {
    if (this.pageMaps.length && doc.childCount === this.pageMaps.length && doc.firstChild?.type.name === 'ol_page') {
      doc.forEach((v, _o, i) => this.adoptNode(this.pageMaps[i], v));
    } else this.adoptFlow(this.body, doc);
  }

  // ---------------------------------------------------------------- dirtiness

  private typeDirty(t: Y.AbstractType<any>): boolean {
    const tr = this.tr;
    return this.full || !tr || tr.changed.has(t) || tr.changedParentTypes.has(t);
  }

  private itemDirty(it: Y.Item): boolean {
    const tr = this.tr;
    if (this.full || !tr) return true;
    if (it.id.clock >= (tr.beforeState.get(it.id.client) ?? 0)) return true;
    return Y.isDeleted(tr.deleteSet, it.id);
  }

  // ---------------------------------------------------------------- flows

  private marksOf(attrs: Map<string, unknown>, key: string): readonly Mark[] {
    let m = this.markCache.get(key);
    if (m) return m;
    const list: Mark[] = [];
    for (const [k, v] of attrs) {
      const type = this.schema.marks[k];
      if (!type) continue;
      try { list.push(type.create(v && typeof v === 'object' ? v as Record<string, unknown> : null)); } catch { /* invalid attributes: dropped */ }
    }
    m = Mark.setFrom(list);
    if (this.markCache.size > 2000) this.markCache.clear();
    this.markCache.set(key, m);
    return m;
  }

  /** The paragraphs of a flow (at least one). */
  readFlow(flow: Y.Text): PMNode[] {
    if (!this.typeDirty(flow)) { const c = this.flows.get(flow); if (c) return c.nodes; }
    const segs: Seg[] = [];
    const attrs = new Map<string, unknown>();
    let cur: Seg = { key: flow, marker: null, first: flow._start, end: null, dirty: false, attrs: new Map(), attrsKey: '', content: false };
    for (let it = flow._start; it; it = it.right) {
      if (!cur.dirty && this.itemDirty(it)) cur.dirty = true;
      if (it.deleted) continue;
      const c = it.content;
      if (c instanceof Y.ContentFormat) {
        if (c.value === null) attrs.delete(c.key); else attrs.set(c.key, c.value);
        continue;
      }
      if (isMarkerItem(it)) {
        cur.end = it;
        if (cur.marker || cur.content) segs.push(cur);
        const marker = embedded(it) as Y.Map<unknown>;
        cur = { key: marker, marker, first: it.right, end: null, dirty: this.typeDirty(marker), attrs: new Map(attrs), attrsKey: attrsKeyOf(attrs), content: false };
        continue;
      }
      if (!it.countable) continue;
      cur.content = true;
      if (!cur.dirty) { const t = embedded(it); if (t && this.typeDirty(t)) cur.dirty = true; }
    }
    if (cur.marker || cur.content || segs.length === 0) segs.push(cur);
    const keys: Y.AbstractType<any>[] = [];
    const nodes: PMNode[] = [];
    for (const seg of segs) {
      keys.push(seg.key);
      const known = this.pars.get(seg.key);
      if (known && !seg.dirty && known.end === seg.end && known.attrs === seg.attrsKey) { nodes.push(known.node); continue; }
      const entry = this.buildPar(seg);
      this.pars.set(seg.key, entry);
      nodes.push(entry.node);
    }
    this.flows.set(flow, { keys, nodes });
    return nodes;
  }

  private buildPar(seg: Seg): ParEntry {
    const type = this.schema.nodes[PARAGRAPH];
    const attrs = seg.marker ? attrsFrom(type, seg.marker) : null;
    const content: PMNode[] = [];
    const embeds: Y.Map<unknown>[] = [];
    const cur = new Map(seg.attrs);
    let key = seg.attrsKey;
    let text = '';
    let textMarks: readonly Mark[] = Mark.none;
    const flush = () => { if (text) { content.push(this.schema.text(text, textMarks)); text = ''; } };
    for (let it = seg.first; it && it !== seg.end; it = it.right) {
      if (it.deleted) continue;
      const c = it.content;
      if (c instanceof Y.ContentFormat) {
        if (c.value === null) cur.delete(c.key); else cur.set(c.key, c.value);
        key = attrsKeyOf(cur);
        continue;
      }
      if (c instanceof Y.ContentString) {
        const marks = this.marksOf(cur, key);
        if (text && !Mark.sameSet(marks, textMarks)) flush();
        textMarks = marks;
        text += c.str;
        continue;
      }
      if (!it.countable) continue;
      // every other item is one inline node (what cannot be read yet: a placeholder holding its place)
      const t = embedded(it);
      const marks = this.marksOf(cur, key);
      flush();
      const pending = marks.length ? this.pending.mark(marks) : this.pending;
      if (t instanceof Y.Map) {
        content.push(this.readInline(t as Y.Map<unknown>, marks) ?? pending);
        embeds.push(t as Y.Map<unknown>);
      } else for (let k = 0; k < it.length; k++) content.push(pending);
    }
    flush();
    let node: PMNode;
    try { node = type.create(attrs, content); } catch { node = type.create(attrs); }
    return { node, end: seg.end, attrs: seg.attrsKey, embeds };
  }

  /** An inline node embedded in a flow (null: not one of this schema's inline nodes). */
  private readInline(map: Y.Map<unknown>, marks: readonly Mark[]): PMNode | null {
    const type = typeOfMap(this.schema, map);
    if (!type || !type.isInline || type.isText) return null;
    const node = this.readNode(map, type);
    if (!node) return null;
    return Mark.sameSet(node.marks, marks) ? node : node.mark(marks);
  }

  // ---------------------------------------------------------------- nodes with structure

  /** The node a map stands for (embeds, rows, cells, objects); cached by the map. */
  private readNode(map: Y.Map<unknown>, type: NodeType): PMNode | null {
    if (!this.typeDirty(map)) { const n = this.nodes.get(map); if (n) return n.node; }
    const entry = this.buildNode(map, type);
    if (entry) this.nodes.set(map, entry); else this.nodes.delete(map);
    return entry?.node ?? null;
  }

  private buildNode(map: Y.Map<unknown>, type: NodeType): NodeEntry | null {
    const attrs = attrsFrom(type, map);
    let content: PMNode[] = [];
    const children: Y.Map<unknown>[] = [];
    switch (shapeOf(type)) {
      case 'atom': break;
      case 'flow': { const body = map.get(K_BODY); content = body instanceof Y.Text ? this.readFlow(body) : [this.emptyPar]; break; }
      case 'rows': content = this.readList(map.get(K_ROWS), t => t.spec.tableRole === 'row', children); break;
      case 'cells': content = this.readList(map.get(K_CELLS), t => t.spec.tableRole === 'cell' || t.spec.tableRole === 'header_cell', children); break;
      default: return null;   // pages and groups are read with their page
    }
    const node = this.make(type, attrs, content);
    return node ? { node, children } : null;
  }

  private make(type: NodeType, attrs: Record<string, unknown> | null, content: PMNode[]): PMNode | null {
    const frag = Fragment.from(content);
    try {
      if (type.validContent(frag)) return type.create(attrs, frag);
      return type.createAndFill(attrs, frag);
    } catch { return null; }
  }

  private readList(list: unknown, ok: (t: NodeType) => boolean, used: Y.Map<unknown>[]): PMNode[] {
    if (!(list instanceof Y.Array)) return [];
    const out: PMNode[] = [];
    for (const m of list.toArray()) {
      if (!(m instanceof Y.Map)) continue;
      const type = typeOfMap(this.schema, m);
      if (!type || !ok(type)) continue;
      const node = this.readNode(m, type);
      if (node) { out.push(node); used.push(m); }
    }
    return out;
  }

  // ---------------------------------------------------------------- pages and objects

  /** The pages of a layout document, in order (none: a linear document). */
  readPages(): PMNode[] {
    const pages = this.pages;
    this.pageMaps = [];
    if (pages.size === 0) return [];
    const ids = effectiveOrder(this.pageOrder, id => { const p = pages.get(id); return p instanceof Y.Map && p.get(K_TYPE) === 'ol_page'; });
    const out: PMNode[] = [];
    for (const id of ids) {
      const map = pages.get(id)!;
      let entry = this.typeDirty(map) ? undefined : this.nodes.get(map);
      if (!entry) { entry = this.buildPage(map) ?? undefined; if (entry) this.nodes.set(map, entry); }
      if (entry) { out.push(entry.node); this.pageMaps.push(map); }
    }
    return out;
  }

  /** a page: its objects (in the order their containers give), then its notes */
  private buildPage(map: Y.Map<unknown>): NodeEntry | null {
    const type = this.schema.nodes.ol_page;
    const objects = map.get(K_OBJECTS);
    const all = objects instanceof Y.Map ? objects as Y.Map<Y.Map<unknown>> : null;
    const content: PMNode[] = [];
    const children: Y.Map<unknown>[] = [];
    if (all) {
      const exists = (id: string) => {
        const o = all.get(id);
        const t = o instanceof Y.Map ? typeOfMap(this.schema, o) : null;
        return !!t && t.isInGroup('ol_object');
      };
      const seen = new Set<string>();
      const visit = (order: unknown, depth: number, used: Y.Map<unknown>[]): PMNode[] => {
        const nodes: PMNode[] = [];
        for (const id of effectiveOrder(order instanceof Y.Array ? order : undefined, exists, seen)) {
          const m = all.get(id)!;
          const node = this.readObject(m, depth, visit);
          if (node) { nodes.push(node); used.push(m); }
        }
        return nodes;
      };
      content.push(...visit(map.get(K_ORDER), 0, children));
      // objects no container orders (their group was deleted as they were put in it): last, at the top
      for (const id of [...all.keys()].sort()) {
        if (seen.has(id) || !exists(id)) continue;
        seen.add(id);
        const m = all.get(id)!;
        const node = this.readObject(m, 0, visit);
        if (node) { content.push(node); children.push(m); }
      }
    }
    const notes = map.get(K_NOTES);
    if (notes instanceof Y.Text) {
      const n = this.make(this.schema.nodes.ol_notes, null, this.readFlow(notes));
      if (n) content.push(n);
    }
    const node = this.make(type, attrsFrom(type, map), content);
    return node ? { node, children } : null;
  }

  private readObject(map: Y.Map<unknown>, depth: number, visit: (order: unknown, depth: number, used: Y.Map<unknown>[]) => PMNode[]): PMNode | null {
    const type = typeOfMap(this.schema, map)!;
    if (shapeOf(type) !== 'objects') return this.readNode(map, type);
    // a group is read whenever its page is: its objects are the page's, not the group map's
    if (depth > 32) return null;
    const children: Y.Map<unknown>[] = [];
    const nodes = visit(map.get(K_ORDER), depth + 1, children);
    if (!nodes.length) return null;
    const node = this.make(type, attrsFrom(type, map), nodes);
    if (node) this.nodes.set(map, { node, children });
    return node;
  }

  // ---------------------------------------------------------------- adopting a view's nodes

  private adoptFlow(flow: Y.Text, container: PMNode): void {
    const f = this.flows.get(flow);
    if (!f || f.nodes.length !== container.childCount) return;
    // a fresh array: the old one is the content of nodes already handed out
    const nodes = f.nodes.slice();
    f.nodes = nodes;
    container.forEach((v, _o, i) => {
      const p = nodes[i];
      if (p === v) return;
      nodes[i] = v;
      const e = this.pars.get(f.keys[i]);
      if (!e || e.node !== p) return;
      e.node = v;
      // its embeds, in order (placeholders of items that are no maps have none)
      if (e.embeds.length !== countInline(v)) return;
      let k = 0;
      v.forEach((vc, _o2, j) => {
        if (vc.isText) return;
        const m = e.embeds[k++];
        const pc = p.maybeChild(j);
        if (m && pc && pc !== vc && vc.type.name !== 'collab_pending') this.adoptNode(m, vc);
      });
    });
  }

  private adoptNode(map: Y.Map<unknown>, v: PMNode): void {
    const e = this.nodes.get(map);
    if (!e || e.node === v) return;
    const p = e.node;
    e.node = v;
    switch (shapeOf(v.type)) {
      case 'flow': { const body = map.get(K_BODY); if (body instanceof Y.Text) this.adoptFlow(body, v); break; }
      case 'page': {
        // its objects first; the notes (if any) are its last child
        e.children.forEach((m, i) => { const c = v.maybeChild(i); if (c && c !== p.maybeChild(i)) this.adoptNode(m, c); });
        const notes = map.get(K_NOTES);
        if (notes instanceof Y.Text && v.lastChild?.type.name === 'ol_notes') this.adoptFlow(notes, v.lastChild);
        break;
      }
      default:
        e.children.forEach((m, i) => { const c = v.maybeChild(i); if (c && c !== p.maybeChild(i)) this.adoptNode(m, c); });
    }
  }
}
