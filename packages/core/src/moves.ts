/**
 * Moves: what Yjs cannot do. y-prosemirror keeps each paragraph as a Y.XmlElement whose children are
 * text runs (Y.XmlText) and inline nodes (formulas, insets — Y.XmlElements). A paragraph split
 * cannot move the second half into a new element: it deletes it and inserts a copy, and a join
 * does the same with the paragraph that is merged into the other. Whatever a co-author who had
 * not seen the split yet (offline, or simply before the sync) typed into the original, deleted
 * there or formatted there targets the deleted original: it ended up at the split point, inside a
 * deleted run (lost), or a deleted word came back with the copy.
 *
 * So every copy is recorded. The editor that makes it (and the server for its own diffs) writes a
 * *move record* in the same Yjs transaction into the document's `moves` map: which source units
 * (characters, inline nodes) were copied to which new ones, and which deleted runs, nodes and
 * paragraphs hold the sources. Runs that lose or receive copied units are re-created whole (the
 * run is deleted, its units copied into a new one): a run that is alive never contains a moved
 * unit, so whatever lands inside a deleted run, a deleted inline node or a deleted paragraph that
 * a record names came from somebody who had not seen the move. The server (server/moves.ts) adopts
 * the records, keeps the deleted originals from Yjs' garbage collection for a while, and moves such
 * late edits after the copy; the editors use the records to keep cursors on moved text.
 *
 * Units are addressed by Yjs ids (client, clock): one character of a text item, or the item of an
 * inline node. A record's entries are ranges: `len` consecutive source clocks → as many consecutive
 * copy clocks.
 */
import * as Y from 'yjs';
import * as encoding from 'lib0/encoding';
import * as decoding from 'lib0/decoding';
import { schema } from './schema';

/** the top-level Y.Map holding the records (key → encoded record) */
export const MOVES_MAP = 'moves';
/** the origin of the server's repairs */
export const MOVES_ORIGIN = 'moves';

/** the copy stayed in the source's paragraph (a re-created run) */
export const KEPT = 0;
/** the copy is in another paragraph */
export const MOVED = 1;
/** no copy: a formatting mark or attribute value that was taken into account */
export const HANDLED = 2;
/** moved by the server next to the copy of its neighbour (a late edit): follows that neighbour, never competes */
export const PLACED = 3;

/** element names whose children are inline content: text runs and inline nodes */
export const CONTAINERS: ReadonlySet<string> = new Set(Object.values(schema.nodes).filter(n => n.isTextblock).map(n => n.name));

export interface MoveRecord {
  key: string;
  /** when it was written (seconds) */
  t: number;
  /** written by the server: overrides what editors recorded */
  server: boolean;
  /** moved units (the smaller of two competing copies wins) */
  size: number;
  /** deleted runs, inline nodes and paragraphs that hold sources: kept from garbage collection */
  protect: Y.ID[];
  /** client records this (server) record restates: they are deleted from the map */
  adopt: string[];
  /** flat: srcClient, srcClock, len, side, dstClient (−1: none), dstClock */
  entries: number[];
}

const VERSION = 1;
export const idKey = (id: { client: number; clock: number }) => `${id.client}:${id.clock}`;

export function encodeRecord(r: Omit<MoveRecord, 'key'>): Uint8Array {
  const clients: number[] = [];
  const index = new Map<number, number>();
  const ci = (c: number) => { let i = index.get(c); if (i === undefined) { i = clients.length; clients.push(c); index.set(c, i); } return i; };
  for (const p of r.protect) ci(p.client);
  const e = r.entries;
  for (let i = 0; i < e.length; i += 6) { ci(e[i]); if (e[i + 4] >= 0) ci(e[i + 4]); }
  const enc = encoding.createEncoder();
  encoding.writeVarUint(enc, VERSION);
  encoding.writeVarUint(enc, r.t);
  encoding.writeVarUint(enc, r.server ? 1 : 0);
  encoding.writeVarUint(enc, r.size);
  encoding.writeVarUint(enc, clients.length);
  for (const c of clients) encoding.writeVarUint(enc, c);
  encoding.writeVarUint(enc, r.protect.length);
  for (const p of r.protect) { encoding.writeVarUint(enc, ci(p.client)); encoding.writeVarUint(enc, p.clock); }
  encoding.writeVarUint(enc, r.adopt.length);
  for (const k of r.adopt) encoding.writeVarString(enc, k);
  encoding.writeVarUint(enc, e.length / 6);
  for (let i = 0; i < e.length; i += 6) {
    encoding.writeVarUint(enc, ci(e[i]));
    encoding.writeVarUint(enc, e[i + 1]);
    encoding.writeVarUint(enc, e[i + 2]);
    encoding.writeVarUint(enc, e[i + 3]);
    if (e[i + 4] < 0) encoding.writeVarUint(enc, 0);
    else { encoding.writeVarUint(enc, ci(e[i + 4]) + 1); encoding.writeVarUint(enc, e[i + 5]); }
  }
  return encoding.toUint8Array(enc);
}

export function decodeRecord(key: string, bytes: unknown): MoveRecord | null {
  if (!(bytes instanceof Uint8Array)) return null;
  try {
    const dec = decoding.createDecoder(bytes);
    if (decoding.readVarUint(dec) !== VERSION) return null;
    const t = decoding.readVarUint(dec);
    const server = decoding.readVarUint(dec) === 1;
    const size = decoding.readVarUint(dec);
    const clients: number[] = [];
    for (let n = decoding.readVarUint(dec); n > 0; n--) clients.push(decoding.readVarUint(dec));
    const protect: Y.ID[] = [];
    for (let n = decoding.readVarUint(dec); n > 0; n--) { const c = clients[decoding.readVarUint(dec)]; protect.push(Y.createID(c, decoding.readVarUint(dec))); }
    const adopt: string[] = [];
    for (let n = decoding.readVarUint(dec); n > 0; n--) adopt.push(decoding.readVarString(dec));
    const entries: number[] = [];
    for (let n = decoding.readVarUint(dec); n > 0; n--) {
      const sc = clients[decoding.readVarUint(dec)], sk = decoding.readVarUint(dec), len = decoding.readVarUint(dec), side = decoding.readVarUint(dec);
      const d = decoding.readVarUint(dec);
      if (d === 0) entries.push(sc, sk, len, side, -1, 0);
      else entries.push(sc, sk, len, side, clients[d - 1], decoding.readVarUint(dec));
    }
    if (entries.some(v => v === undefined)) return null;
    return { key, t, server, size, protect, adopt, entries };
  } catch { return null; }
}

/* ------------------------------------------------------------------------------ id ranges */

/** sorted, merged clock ranges per client */
export class Ranges {
  private m = new Map<number, number[]>();
  private dirty = new Set<number>();
  static of(ds: { clients: Map<number, { clock: number; len: number }[]> }): Ranges {
    const r = new Ranges();
    ds.clients.forEach((items, client) => { for (const d of items) r.add(client, d.clock, d.len); });
    return r;
  }
  add(client: number, clock: number, len: number): void {
    if (len <= 0) return;
    let l = this.m.get(client);
    if (!l) this.m.set(client, l = []);
    l.push(clock, clock + len);
    this.dirty.add(client);
  }
  private list(client: number): number[] | undefined {
    const l = this.m.get(client);
    if (l && this.dirty.has(client)) {
      const pairs: [number, number][] = [];
      for (let i = 0; i < l.length; i += 2) pairs.push([l[i], l[i + 1]]);
      pairs.sort((a, b) => a[0] - b[0]);
      const out: number[] = [];
      for (const [a, b] of pairs) {
        if (out.length && a <= out[out.length - 1]) out[out.length - 1] = Math.max(out[out.length - 1], b);
        else out.push(a, b);
      }
      this.m.set(client, out);
      this.dirty.delete(client);
      return out;
    }
    return l;
  }
  has(client: number, clock: number): boolean {
    const l = this.list(client);
    if (!l) return false;
    let lo = 0, hi = l.length / 2 - 1;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      if (l[2 * mid + 1] <= clock) lo = mid + 1;
      else if (l[2 * mid] > clock) hi = mid - 1;
      else return true;
    }
    return false;
  }
  hasId(id: Y.ID): boolean { return this.has(id.client, id.clock); }
  forEach(f: (client: number, clock: number, len: number) => void): void {
    for (const client of [...this.m.keys()]) { const l = this.list(client)!; for (let i = 0; i < l.length; i += 2) f(client, l[i], l[i + 1] - l[i]); }
  }
  get empty(): boolean { return [...this.m.values()].every(l => l.length === 0); }
}

/* ------------------------------------------------------------------------------ the index */

interface Span { k: number; n: number; dc: number; dk: number; side: number; rec: MoveRecord }
const cut = (s: Span, a: number, b: number): Span => ({ k: a, n: b - a, dc: s.dc, dk: s.dc >= 0 ? s.dk + (a - s.k) : 0, side: s.side, rec: s.rec });

/** clock ranges of one client → what they map to; non-overlapping, sorted */
class SpanMap {
  private m = new Map<number, Span[]>();
  clear() { this.m.clear(); }
  private first(list: Span[], clock: number): number {
    let lo = 0, hi = list.length;
    while (lo < hi) { const mid = (lo + hi) >> 1; if (list[mid].k + list[mid].n <= clock) lo = mid + 1; else hi = mid; }
    return lo;
  }
  find(client: number, clock: number): Span | null {
    const list = this.m.get(client);
    if (!list) return null;
    const s = list[this.first(list, clock)];
    return s && s.k <= clock ? s : null;
  }
  overlapping(client: number, clock: number, len: number): Span[] {
    const list = this.m.get(client);
    if (!list) return [];
    const out: Span[] = [];
    for (let i = this.first(list, clock); i < list.length && list[i].k < clock + len; i++) out.push(list[i]);
    return out;
  }
  /** `s` over what is there (`override`), or only into the gaps, reporting the overlaps */
  set(client: number, s: Span, override: boolean, conflict?: (k: number, n: number, old: Span) => void): void {
    let list = this.m.get(client);
    if (!list) this.m.set(client, list = []);
    const end = s.k + s.n;
    const lo = this.first(list, s.k);
    let hi = lo;
    while (hi < list.length && list[hi].k < end) hi++;
    const pieces: Span[] = [];
    let cur = s.k;
    for (let i = lo; i < hi; i++) {
      const o = list[i], oEnd = o.k + o.n;
      if (o.k < s.k) pieces.push(cut(o, o.k, s.k));
      const a = Math.max(o.k, s.k), b = Math.min(oEnd, end);
      if (cur < a) pieces.push(cut(s, cur, a));
      if (override) pieces.push(cut(s, a, b));
      else { pieces.push(cut(o, a, b)); conflict?.(a, b - a, o); }
      cur = b;
      if (oEnd > end) pieces.push(cut(o, end, oEnd));
    }
    if (cur < end) pieces.push(cut(s, cur, end));
    list.splice(lo, hi - lo, ...pieces.filter(p => p.n > 0));
  }
}

export interface Mapped { dst: Y.ID | null; side: number; rec: MoveRecord }
export interface Conflict { rec: MoveRecord; client: number; clock: number; len: number; old: { dst: Y.ID | null; side: number; rec: MoveRecord } }

/**
 * The records of one document: source unit → copy, copy → source, the protected deleted types.
 * Editors' records only fill gaps (an overlap is a conflict the server resolves); the server's
 * override, in the order of their keys.
 */
export class MoveIndex {
  readonly records = new Map<string, MoveRecord>();
  private src = new SpanMap();
  private dst = new SpanMap();
  /** every copy ever recorded of a source range (the source map keeps only the one that counts) */
  private all = new Map<number, Span[]>();
  readonly protectedTypes = new Set<string>();
  /** overlaps found while adding editors' records (the server takes and resolves them) */
  conflicts: Conflict[] = [];
  get empty(): boolean { return this.records.size === 0; }

  add(rec: MoveRecord): void {
    if (this.records.has(rec.key)) return;
    this.records.set(rec.key, rec);
    for (const k of rec.adopt) this.records.delete(k);
    for (const p of rec.protect) this.protectedTypes.add(idKey(p));
    const e = rec.entries;
    for (let i = 0; i < e.length; i += 6) this.entry(rec, e[i], e[i + 1], e[i + 2], e[i + 3], e[i + 4], e[i + 5]);
  }

  /** one more entry of `rec` (the server adds its own as it makes them) */
  entry(rec: MoveRecord, sc: number, sk: number, len: number, side: number, dc: number, dk: number): void {
    const s: Span = { k: sk, n: len, side, dc, dk, rec };
    this.src.set(sc, s, rec.server, (k, n, old) => this.conflicts.push({ rec, client: sc, clock: k, len: n, old: { dst: old.dc >= 0 ? Y.createID(old.dc, old.dk + (k - old.k)) : null, side: old.side, rec: old.rec } }));
    if (dc >= 0) {
      // a copy's source is the first one recorded (a losing copy mapped onto it later is not)
      this.dst.set(dc, { k: dk, n: len, dc: sc, dk: sk, side, rec }, false);
      let l = this.all.get(sc);
      if (!l) this.all.set(sc, l = []);
      l.push(s);
    }
  }

  /** every copy recorded of the source unit (client, clock) */
  copiesOf(client: number, clock: number): Y.ID[] {
    const out: Y.ID[] = [];
    for (const s of this.all.get(client) ?? []) if (clock >= s.k && clock < s.k + s.n) out.push(Y.createID(s.dc, s.dk + (clock - s.k)));
    return out;
  }

  protect(id: Y.ID): void { this.protectedTypes.add(idKey(id)); }

  /** what the source unit (client, clock) was copied to */
  lookup(client: number, clock: number): Mapped | null {
    const s = this.src.find(client, clock);
    return s ? { dst: s.dc >= 0 ? Y.createID(s.dc, s.dk + (clock - s.k)) : null, side: s.side, rec: s.rec } : null;
  }
  /** the source of a copy unit */
  sourceOf(client: number, clock: number): { src: Y.ID; side: number; rec: MoveRecord } | null {
    const s = this.dst.find(client, clock);
    return s ? { src: Y.createID(s.dc, s.dk + (clock - s.k)), side: s.side, rec: s.rec } : null;
  }
  /** the mapped parts of the source range: [clock, len, mapped] */
  overlapping(client: number, clock: number, len: number): [number, number, Mapped][] {
    return this.src.overlapping(client, clock, len).map(s => {
      const a = Math.max(s.k, clock), b = Math.min(s.k + s.n, clock + len);
      return [a, b - a, { dst: s.dc >= 0 ? Y.createID(s.dc, s.dk + (a - s.k)) : null, side: s.side, rec: s.rec }] as [number, number, Mapped];
    });
  }

  /** the item lies in a protected deleted type (or is one) */
  keeps(item: Y.Item): boolean {
    if (this.protectedTypes.size === 0) return false;
    let it: Y.Item | null = item;
    while (it) {
      if (it.content instanceof Y.ContentType && this.protectedTypes.has(idKey(it.id))) return true;
      const p = it.parent as Y.AbstractType<any> | null;
      it = p instanceof Y.AbstractType ? p._item : null;
    }
    return false;
  }

  /** everything again from the map: editors' records first, then the server's in key order */
  load(map: Y.Map<unknown>): void {
    this.records.clear(); this.src.clear(); this.dst.clear(); this.all.clear(); this.protectedTypes.clear();
    const keys = [...map.keys()].sort((a, b) => (a[0] === b[0] ? (a < b ? -1 : a > b ? 1 : 0) : a[0] === 'c' ? -1 : 1));
    for (const k of keys) { const r = decodeRecord(k, map.get(k)); if (r) this.add(r); }
    this.conflicts = [];
  }

  /** the map's keys `changed` were added or removed */
  sync(map: Y.Map<unknown>, changed: Set<string>): void {
    const removed = [...changed].filter(k => !map.has(k));
    const added = [...changed].filter(k => map.has(k)).sort((a, b) => (a[0] === b[0] ? (a < b ? -1 : a > b ? 1 : 0) : a[0] === 'c' ? -1 : 1));
    const adopted = new Set<string>();
    for (const k of added) { const r = decodeRecord(k, map.get(k)); if (r) for (const a of r.adopt) adopted.add(a); }
    // a removed record that a server record restates changes nothing; any other removal (pruning): from scratch
    if (removed.some(k => !adopted.has(k) && ![...this.records.values()].some(r => r.adopt.includes(k)))) { this.load(map); return; }
    for (const k of added) { const r = decodeRecord(k, map.get(k)); if (r) this.add(r); }
  }
}

/**
 * The records of `ydoc`, kept up to date with its map, and its garbage collection told to keep the
 * deleted types the records name (the server's document and its workers' mirrors).
 */
export function protectMoves(ydoc: Y.Doc): MoveIndex {
  const index = new MoveIndex();
  const map = ydoc.getMap<unknown>(MOVES_MAP);
  index.load(map);
  // observers run before the transaction's garbage collection
  map.observe(ev => index.sync(map, ev.keysChanged));
  const prev = ydoc.gcFilter;
  ydoc.gcFilter = item => !index.keeps(item) && prev(item);
  return index;
}

/* ------------------------------------------------------------------------------ Yjs structure */

export const typeOf = (item: Y.Item): Y.AbstractType<any> | null => item.content instanceof Y.ContentType ? item.content.type : null;
export const isContainer = (t: unknown, containers: ReadonlySet<string> = CONTAINERS): t is Y.XmlElement => t instanceof Y.XmlElement && containers.has(t.nodeName);
/** a live type: not deleted, nor inside something deleted */
export const isLive = (t: Y.AbstractType<any> | null): boolean => !!t && (t._item === null || !t._item.deleted);

/** the paragraph whose inline content `item` is: one of its children, or an item of one of its runs */
export function containerOf(item: Y.Item, containers: ReadonlySet<string> = CONTAINERS): Y.XmlElement | null {
  if (item.parentSub !== null) return null;
  let p = item.parent as unknown;
  if (p instanceof Y.XmlText) { const r = p._item; if (!r || r.parentSub !== null) return null; p = r.parent; }
  return isContainer(p, containers) ? p : null;
}

/** the value of an attribute item */
export const valueOf = (item: Y.Item): unknown => { const c = item.content.getContent(); return c[c.length - 1]; };

/** an inline node's name and attributes, as a key for comparing copies */
function elementKey(el: Y.XmlElement): string {
  const a: [string, unknown][] = [];
  el._map.forEach((it, k) => { if (!(it.content instanceof Y.ContentDeleted)) a.push([k, valueOf(it)]); });
  a.sort((x, y) => (x[0] < y[0] ? -1 : 1));
  return '\u0000' + el.nodeName + JSON.stringify(a);
}

/** the structs of `client` from `clock` (inclusive) to `end` (exclusive) */
export function forEachStruct(doc: Y.Doc, client: number, clock: number, end: number, f: (s: Y.Item) => void): void {
  const structs = doc.store.clients.get(client);
  if (!structs || clock >= end) return;
  const last = structs[structs.length - 1];
  if (clock >= last.id.clock + last.length) return;
  for (let i = Y.findIndexSS(structs, clock); i < structs.length && structs[i].id.clock < end; i++) {
    const s = structs[i];
    if (s instanceof Y.Item) f(s);
  }
}

/* ------------------------------------------------------------------------------ matching */

/**
 * Pairs of equal elements of `a` and `b` along a shortest edit script (Myers), common prefix and
 * suffix first. Gives up (prefix and suffix only) beyond `maxD` edits.
 */
export function matchSequences(a: string[], b: string[], maxD = 600): [number, number][] {
  const out: [number, number][] = [];
  let p = 0;
  while (p < a.length && p < b.length && a[p] === b[p]) { out.push([p, p]); p++; }
  let s = 0;
  while (s < a.length - p && s < b.length - p && a[a.length - 1 - s] === b[b.length - 1 - s]) s++;
  const A = a.slice(p, a.length - s), B = b.slice(p, b.length - s);
  const N = A.length, M = B.length;
  if (N && M) {
    const max = Math.min(N + M, maxD), off = max + 1;
    const trace: Int32Array[] = [];
    let v = new Int32Array(2 * max + 3);
    let found = -1;
    for (let d = 0; d <= max && found < 0; d++) {
      const nv = v.slice();
      for (let k = -d; k <= d; k += 2) {
        let x = k === -d || (k !== d && v[off + k - 1] < v[off + k + 1]) ? v[off + k + 1] : v[off + k - 1] + 1;
        let y = x - k;
        while (x < N && y < M && A[x] === B[y]) { x++; y++; }
        nv[off + k] = x;
        if (x >= N && y >= M) { found = d; break; }
      }
      trace.push(nv);
      v = nv;
    }
    if (found >= 0) {
      const mid: [number, number][] = [];
      let x = N, y = M;
      for (let d = found; d > 0; d--) {
        const pv = trace[d - 1], k = x - y;
        const down = k === -d || (k !== d && pv[off + k - 1] < pv[off + k + 1]);
        const prevK = down ? k + 1 : k - 1;
        const px = pv[off + prevK], py = px - prevK;
        // the snake from the end of that move to (x, y)
        const sx = down ? px : px + 1, sy = down ? py + 1 : py;
        while (x > sx && y > sy) { x--; y--; mid.push([p + x, p + y]); }
        x = px; y = py;
      }
      while (x > 0 && y > 0) { x--; y--; mid.push([p + x, p + y]); }
      out.push(...mid.reverse());
    }
  }
  for (let i = s; i > 0; i--) out.push([a.length - i, b.length - i]);
  return out;
}

/* ------------------------------------------------------------------------------ the editor's side */

/** an inline unit: one character of a text item, or an inline node's item */
interface Unit { key: string; item: Y.Item; off: number; cont: Y.XmlElement }

/** a run's text with its formatting (live items only), item by item */
function liveSegments(run: Y.XmlText): { item: Y.Item; text: string; attrs: Record<string, unknown> }[] {
  const out: { item: Y.Item; text: string; attrs: Record<string, unknown> }[] = [];
  const attrs: Record<string, unknown> = {};
  for (let it = run._start; it; it = it.right) {
    if (it.deleted) continue;
    if (it.content instanceof Y.ContentFormat) { const { key, value } = it.content; if (value === null) delete attrs[key]; else attrs[key] = value; }
    else if (it.content instanceof Y.ContentString) out.push({ item: it, text: it.content.str, attrs: { ...attrs } });
  }
  return out;
}

/**
 * Insert nodes into a paragraph behind a deleted separator: y-prosemirror merges a text run into the
 * live run right before it when its own client made it (a copy nobody records), so a run made here
 * never directly follows another one.
 */
export function insertSeparated(parent: Y.XmlElement, at: number, nodes: (Y.XmlText | Y.XmlElement)[]): void {
  parent.insert(at, [new Y.XmlText(), ...nodes]);
  parent.delete(at, 1);
}

/** the visible child index of `child` in `parent` */
export function childIndex(parent: Y.AbstractType<any>, child: Y.Item): number {
  let i = 0;
  for (let c = parent._start; c && c !== child; c = c.right) if (!c.deleted && c.countable) i++;
  return i;
}

/** the ids of the characters of `run` created from `from` on, in order */
function newChars(run: Y.XmlText, isNew: (id: Y.ID) => boolean): Y.ID[] {
  const ids: Y.ID[] = [];
  for (let it = run._start; it; it = it.right) if (!it.deleted && it.content instanceof Y.ContentString && isNew(it.id)) for (let i = 0; i < it.length; i++) ids.push(Y.createID(it.id.client, it.id.clock + i));
  return ids;
}

/** entries collected as unit pairs, merged into ranges */
export class EntryList {
  entries: number[] = [];
  push(sc: number, sk: number, len: number, side: number, dc: number, dk: number): void {
    const e = this.entries, n = e.length;
    if (n && e[n - 6] === sc && e[n - 5] + e[n - 4] === sk && e[n - 3] === side && e[n - 2] === dc && (dc < 0 || e[n - 1] + e[n - 4] === dk)) { e[n - 4] += len; return; }
    e.push(sc, sk, len, side, dc, dk);
  }
}

/**
 * Re-create a live run whole: a new run with its live content in its place, the run deleted (and
 * kept: its id goes into `protect`). Returns each live character's copy; the run's formatting
 * marks are recorded as HANDLED.
 */
export function recreateRun(item: Y.Item, out: EntryList, protect: Y.ID[]): Map<string, Y.ID> {
  const run = item.content instanceof Y.ContentType ? item.content.type as Y.XmlText : null;
  const parent = item.parent as Y.XmlElement;
  if (!run || !(run instanceof Y.XmlText)) throw new Error('not a run');
  const segs = liveSegments(run);
  const at = childIndex(parent, item);
  const copy = new Y.XmlText();
  insertSeparated(parent, at, [copy]);
  let pos = 0;
  for (const s of segs) { copy.insert(pos, s.text, { ...s.attrs }); pos += s.text.length; }
  const doc = parent.doc!;
  const ids = newChars(copy, id => id.client === doc.clientID);
  const copies = new Map<string, Y.ID>();
  let i = 0;
  for (const s of segs) for (let o = 0; o < s.item.length; o++, i++) copies.set(idKey(Y.createID(s.item.id.client, s.item.id.clock + o)), ids[i]);
  for (let it = run._start; it; it = it.right) if (!it.deleted && it.content instanceof Y.ContentFormat) out.push(it.id.client, it.id.clock, it.length, HANDLED, -1, 0);
  parent.delete(at + 1, 1);
  protect.push(item.id);
  return copies;
}

/** pairs of the units of a copied inline node and its copy (nested paragraphs, their runs and nodes) */
function deepPairs(src: Y.XmlElement, dst: Y.XmlElement, wasLive: (it: Y.Item) => boolean, side: number, out: EntryList): void {
  const sk: Y.Item[] = [], dk: Y.Item[] = [];
  for (let c = src._start; c; c = c.right) if (typeOf(c) && wasLive(c)) sk.push(c);
  for (let c = dst._start; c; c = c.right) if (typeOf(c) && !c.deleted) dk.push(c);
  for (let i = 0; i < sk.length && i < dk.length; i++) {
    const s = typeOf(sk[i])!, d = typeOf(dk[i])!;
    if (s instanceof Y.XmlText && d instanceof Y.XmlText) {
      const a: Y.ID[] = [], b: Y.ID[] = [];
      for (let it = s._start; it; it = it.right) if (it.content instanceof Y.ContentString && wasLive(it)) for (let o = 0; o < it.length; o++) a.push(Y.createID(it.id.client, it.id.clock + o));
      for (let it = d._start; it; it = it.right) if (it.content instanceof Y.ContentString && !it.deleted) for (let o = 0; o < it.length; o++) b.push(Y.createID(it.id.client, it.id.clock + o));
      for (let j = 0; j < a.length && j < b.length; j++) out.push(a[j].client, a[j].clock, 1, side, b[j].client, b[j].clock);
    } else if (s instanceof Y.XmlElement && d instanceof Y.XmlElement && s.nodeName === d.nodeName) {
      out.push(sk[i].id.client, sk[i].id.clock, 1, side, dk[i].id.client, dk[i].id.clock);
      deepPairs(s, d, wasLive, side, out);
    } else break;
  }
}
export { deepPairs as pairCopies };

/** how many deleted / new structs a transaction may have for its copies to be looked for */
const MAX_STRUCTS = 20000;
/** a matched stretch shorter than this is a coincidence, unless it is all that was deleted or inserted */
const MIN_STRETCH = 4;

/**
 * Called at the end of a local transaction (inside it): when it copied inline content from deleted
 * units into new ones — a paragraph split or join, a formula inserted into the middle of a run, a
 * paste that carries part of a paragraph along — the runs that lost or received copied units are
 * re-created whole and a move record is written into the `moves` map. Returns the record (null:
 * the transaction copied nothing).
 */
export function recordCopies(tr: Y.Transaction, opts: { containers?: ReadonlySet<string>; now?: number } = {}): MoveRecord | null {
  const containers = opts.containers ?? CONTAINERS;
  const doc = tr.doc;
  const del = Ranges.of(tr.deleteSet);
  if (del.empty) return null;
  const before = tr.beforeState;
  const isNew = (id: Y.ID) => id.clock >= (before.get(id.client) ?? 0);
  // the paragraphs whose inline content changed; copies need a run, node or paragraph made or deleted
  let structural = false, count = 0;
  const touched = new Set<Y.XmlElement>();
  const note = (it: Y.Item) => {
    count++;
    const t = typeOf(it);
    if (t instanceof Y.XmlText || t instanceof Y.XmlElement) structural = true;
    if (isContainer(t, containers)) touched.add(t);
    const c = containerOf(it, containers);
    if (c) touched.add(c);
  };
  del.forEach((client, clock, len) => forEachStruct(doc, client, clock, clock + len, it => { if (!isNew(it.id)) note(it); }));
  doc.store.clients.forEach((_s, client) => {
    const from = before.get(client) ?? 0, to = Y.getState(doc.store, client);
    if (to > from) forEachStruct(doc, client, from, to, it => { if (!it.deleted) note(it); });
  });
  if (!structural || count > MAX_STRUCTS || touched.size === 0) return null;

  // the touched paragraphs of one parent, in document order
  const groups = new Map<Y.AbstractType<any>, Y.XmlElement[]>();
  for (const c of touched) { const p = c._item?.parent as Y.AbstractType<any> | undefined; if (p) groups.set(p, []); }
  for (const [p, list] of groups) for (let it = p._start; it; it = it.right) { const t = typeOf(it); if (t && touched.has(t as Y.XmlElement)) list.push(t as Y.XmlElement); }

  const out = new EntryList();
  const protect: Y.ID[] = [];
  const recreate = new Set<Y.Item>();
  /** source unit → the unit it became (a copy made here, or a unit of a run to re-create) */
  const pairs: [Unit, Unit][] = [];
  let size = 0;
  const wasLive = (it: Y.Item) => !isNew(it.id) && (!it.deleted || del.hasId(it.id));
  const runOf = (u: Unit) => (u.item.parent instanceof Y.XmlText ? u.item.parent._item : null);
  for (const window of groups.values()) {
    // the window's units before the transaction (alive, or deleted by it) and after it, in document order
    const P: Unit[] = [], F: Unit[] = [];
    let deleted = 0, added = 0;
    for (const cont of window) {
      for (let ch = cont._start; ch; ch = ch.right) {
        const t = typeOf(ch);
        if (t instanceof Y.XmlText) {
          for (let it = t._start; it; it = it.right) {
            if (!(it.content instanceof Y.ContentString)) continue;
            const str = it.content.str;
            const before = wasLive(it) && (!ch.deleted || del.hasId(ch.id) || del.hasId(it.id)), after = !it.deleted;
            for (let o = 0; o < it.length; o++) {
              const u = { key: str[o], item: it, off: o, cont };
              if (before && !isNew(it.id)) { P.push(u); if (it.deleted) deleted++; }
              if (after) { F.push(u); if (isNew(it.id)) added++; }
            }
          }
        } else if (t instanceof Y.XmlElement) {
          const u = { key: elementKey(t), item: ch, off: 0, cont };
          if (wasLive(ch)) { P.push(u); if (ch.deleted) deleted++; }
          if (!ch.deleted) { F.push(u); if (isNew(ch.id)) added++; }
        }
      }
    }
    if (!deleted || !added) continue;
    // the text after the transaction read as the text before it, with the moved units copied: y-prosemirror's
    // diff may have reused a unit for its equal neighbour (a join that starts "w0…" before "w0…")
    const matched = matchSequences(P.map(u => u.key), F.map(u => u.key));
    const moved = matched.filter(([i, j]) => P[i].item !== F[j].item || P[i].off !== F[j].off);
    // stretches of consecutive moved pairs; short ones are coincidences
    for (let i = 0; i < moved.length;) {
      let j = i + 1;
      while (j < moved.length && moved[j][0] === moved[j - 1][0] + 1 && moved[j][1] === moved[j - 1][1] + 1) j++;
      const len = j - i;
      if (len >= MIN_STRETCH || len >= deleted || len >= added) for (const [pi, fi] of moved.slice(i, j)) pairs.push([P[pi], F[fi]]);
      i = j;
    }
  }
  if (!pairs.length) return null;
  // the runs alive before and after that lose or receive units are re-created whole; deleted ones holding sources are kept
  for (const [p, f] of pairs) {
    for (const u of [p, f]) {
      const run = runOf(u);
      if (!run || isNew(run.id)) continue;
      if (run.deleted) protect.push(run.id);
      else recreate.add(run);
    }
    const pt = typeOf(p.item), ft = typeOf(f.item);
    if (pt instanceof Y.XmlElement && p.item.deleted) protect.push(p.item.id);
    if (pt instanceof Y.XmlElement && ft instanceof Y.XmlElement && p.item.deleted && isNew(f.item.id)) deepPairs(pt, ft, wasLive, p.cont === f.cont ? KEPT : MOVED, out);
  }
  const copies = new Map<string, Y.ID>();
  for (const run of recreate) for (const [k, v] of recreateRun(run, out, protect)) copies.set(k, v);
  const dest = (u: Unit) => { const id = Y.createID(u.item.id.client, u.item.id.clock + u.off); return copies.get(idKey(id)) ?? id; };
  const contOf = (id: Y.ID) => containerOf(Y.getItem(doc.store, id), containers);
  const done = new Set<string>();
  const map = (src: Y.ID, dst: Y.ID, cont: Y.XmlElement | null) => {
    if (src.client === dst.client && src.clock === dst.clock) return;
    done.add(idKey(src));
    const side = cont && contOf(dst) === cont ? KEPT : MOVED;
    if (side === MOVED) size++;
    out.push(src.client, src.clock, 1, side, dst.client, dst.clock);
  };
  for (const [p, f] of pairs) map(Y.createID(p.item.id.client, p.item.id.clock + p.off), dest(f), containerOf(p.item, containers) ?? (p as Unit).cont);
  // the other units of the re-created runs: to their own copies
  for (const [k, v] of copies) {
    const [c, cl] = k.split(':').map(Number);
    if (!done.has(k) && !isNew(Y.createID(c, cl))) out.push(c, cl, 1, KEPT, v.client, v.clock);
  }
  for (const g of groups.values()) for (const cont of g) if (cont._item && cont._item.deleted && !isNew(cont._item.id)) protect.push(cont._item.id);
  // the formatting marks of the deleted runs that hold sources count for the formatting there
  for (const id of protect) {
    const t = typeOf(Y.getItem(doc.store, id));
    if (t instanceof Y.XmlText) for (let it = t._start; it; it = it.right) if (it.content instanceof Y.ContentFormat && wasLive(it)) out.push(it.id.client, it.id.clock, it.length, HANDLED, -1, 0);
  }
  const uniq = new Map(protect.map(p => [idKey(p), p]));
  const rec: MoveRecord = {
    key: `c${doc.clientID}-${Y.getState(doc.store, doc.clientID)}`,
    t: Math.floor((opts.now ?? Date.now()) / 1000), server: false, size,
    protect: [...uniq.values()], adopt: [], entries: out.entries,
  };
  doc.getMap(MOVES_MAP).set(rec.key, encodeRecord(rec));
  return rec;
}

/**
 * An editor's document: when a transaction from elsewhere brings move records, the moved
 * originals point to their copies (Yjs' `redone`), so that relative positions on them — the
 * editor's own cursor restored after the remote change, the undo history — follow the text.
 */
export function followMoves(ydoc: Y.Doc): () => void {
  const map = ydoc.getMap<unknown>(MOVES_MAP);
  const on = (tr: Y.Transaction) => {
    if (tr.local) return;
    const keys = tr.changed.get(map as unknown as Y.AbstractType<any>);
    if (!keys) return;
    for (const k of keys) {
      const r = typeof k === 'string' ? decodeRecord(k, map.get(k)) : null;
      if (!r) continue;
      const e = r.entries;
      for (let i = 0; i < e.length; i += 6) {
        if (e[i + 4] < 0) continue;
        const [sc, sk, len, , dc, dk] = e.slice(i, i + 6);
        if (Y.getState(ydoc.store, sc) <= sk || Y.getState(ydoc.store, dc) <= dk) continue;
        try {
          if (Y.getState(ydoc.store, sc) > sk + len) Y.getItemCleanStart(tr, Y.createID(sc, sk + len));
          for (let k = sk; k < sk + len;) {
            const item = Y.getItemCleanStart(tr, Y.createID(sc, k));
            if (!(item instanceof Y.Item)) break;
            if (item.redone === null) item.redone = Y.createID(dc, dk + (k - sk));
            k += item.length;
          }
        } catch { /* a garbage-collected original: nothing to follow */ }
      }
    }
  };
  ydoc.on('beforeObserverCalls', on);
  return () => ydoc.off('beforeObserverCalls', on);
}
