/**
 * The server's half of moves (core/moves.ts): editors record the copies a paragraph split or join
 * makes; the server adopts each record, keeps the deleted originals it names from Yjs' garbage
 * collection, and repairs what arrives for them from somebody who had not seen the move — in one
 * transaction of its own, sent to everybody like any update, right after the update that needed it:
 *
 * - text, inline nodes or runs inserted into a deleted original (they are deleted with it) are
 *   inserted again next to the copy of their neighbour — the unit their author typed after (Yjs'
 *   `origin`), or before (`rightOrigin`), whichever is still there or was copied;
 * - an item inserted into a live paragraph next to a moved one (a formula after a moved formula),
 *   or with a copy between it and its neighbour, moves the same way;
 * - deleting an original that was copied deletes the copy (Yjs reports nothing for deleting what is
 *   already deleted: the update's own delete set is read);
 * - formatting marks set on originals, and attributes set on moved inline nodes (a formula edit),
 *   are applied to the copies;
 * - two copies of one original (two people split the same paragraph before syncing) are reduced to
 *   one: a moved copy wins over one that stayed in its paragraph, of two moved copies the one of
 *   the smaller move (the inner of the two split points).
 *
 * The repaired items are recorded too (in the server's record), so a repair is never made twice and
 * later edits of a repaired item follow it. Only the update's own items, the units it deleted and
 * the records it brought are looked at.
 */
import * as Y from 'yjs';
import {
  MOVES_MAP, MOVES_ORIGIN, KEPT, MOVED, HANDLED, PLACED, CONTAINERS, Ranges, EntryList, protectMoves, encodeRecord, decodeRecord,
  typeOf, isContainer, isLive, containerOf, valueOf, childIndex, pairCopies, forEachStruct, idKey, insertSeparated,
  type MoveIndex, type MoveRecord,
} from '@overlyx/core/moves.ts';

export { MOVES_ORIGIN };

interface Incoming {
  origin: unknown;
  update: Uint8Array;
  /** sync step 2 (the whole delete set of the sender) or a live update (its own deletions) */
  step2: boolean;
  /** the state vector the sender reported in its sync step 1 (the server's own diff: what it was made on) */
  knows: Map<number, number> | null;
  /** the server's own diff (a file changed on disk, an agent's edit), made on a mirror of the document */
  server: boolean;
  ds?: Ranges;
  had?: Map<number, number>;
}

/** one inline unit: a character of a text item, or the item of an inline node / text run */
interface Unit { item: Y.Item; off: number }
/** a stretch of one item: characters [off, off + len) of a text item, or a whole node or run (0, 1) */
interface Piece { item: Y.Item; off: number; len: number }
/** where a moved item goes: a unit position in a live paragraph */
interface Pos { cont: Y.XmlElement; index: number; key: string }

export interface MoveRepairOptions {
  containers?: ReadonlySet<string>;
  /** how long records (and the deleted originals they keep) are kept, days */
  ttlDays?: number;
  now?: () => number;
  log?: (...a: unknown[]) => void;
}

const DAY = 86400;

export class MoveRepair {
  readonly index: MoveIndex;
  private incoming: Incoming | null = null;
  private queue: { tr: Y.Transaction; inc: Incoming | null; conflicts: MoveIndex['conflicts'] }[] = [];
  private flushing = false;
  private containers: ReadonlySet<string>;
  private lastPrune = 0;

  constructor(readonly ydoc: Y.Doc, private opts: MoveRepairOptions = {}) {
    this.containers = opts.containers ?? CONTAINERS;
    this.index = protectMoves(ydoc);
    // what an update needs is noted when it is applied (the records it brought protect their originals
    // before its garbage collection); the repair follows once it is done, as an update of its own
    ydoc.on('afterTransaction', (tr: Y.Transaction) => this.note(tr));
    ydoc.on('afterAllTransactions', () => this.flush());
  }

  private now(): number { return Math.floor((this.opts.now ?? Date.now)() / 1000); }

  /**
   * Apply an update a client sent (instead of Y.applyUpdate): `step2` for its answer to the
   * server's sync step 1, with the state vector of its own step 1 (`knows`). `server`: the server's
   * own diff made on a mirror of the document (docs.ts applyMirrorUpdate), `knows` what that held.
   */
  receive(update: Uint8Array, origin: unknown, info: { step2: boolean; knows?: Map<number, number> | null; server?: boolean }): void {
    this.incoming = { origin, update, step2: info.step2, knows: info.knows ?? null, server: !!info.server };
    try { Y.applyUpdate(this.ydoc, update, origin); } finally { this.incoming = null; }
  }

  /** drop records older than the retention period (their originals are collected when the document is next loaded) */
  prune(): void {
    const map = this.ydoc.getMap<unknown>(MOVES_MAP);
    const limit = this.now() - (this.opts.ttlDays ?? 30) * DAY;
    const old = [...map.keys()].filter(k => { const r = decodeRecord(k, map.get(k)); return !r || r.t < limit; });
    this.lastPrune = this.now();
    if (old.length) this.ydoc.transact(() => { for (const k of old) map.delete(k); }, MOVES_ORIGIN);
  }

  /* ------------------------------------------------------------------------------ after an update */

  private note(tr: Y.Transaction): void {
    if (tr.origin === MOVES_ORIGIN) return;
    const conflicts = this.index.conflicts;
    this.index.conflicts = [];
    if (tr.origin === 'db' || this.index.empty) return;
    this.queue.push({ tr, inc: this.incoming && this.incoming.origin === tr.origin ? this.incoming : null, conflicts });
  }

  private flush(): void {
    if (this.flushing) return;
    this.flushing = true;
    try {
      for (let q = this.queue.shift(); q; q = this.queue.shift()) {
        try { this.process(q.tr, q.inc, q.conflicts); } catch (e) { (this.opts.log ?? console.error)('[moves] repair failed', e); }
      }
    } finally { this.flushing = false; }
  }

  private process(tr: Y.Transaction, inc: Incoming | null, conflicts: MoveIndex['conflicts']): void {
    const map = this.ydoc.getMap<unknown>(MOVES_MAP);
    const keys = [...(tr.changed.get(map as unknown as Y.AbstractType<any>) ?? [])].filter((k): k is string => typeof k === 'string' && k[0] === 'c' && map.has(k));
    const work = new Work(this, tr, inc);
    work.scan(keys);
    const hits = inc ? this.deletionHits(inc) : false;
    if (!keys.length && !conflicts.length && !work.pending.length && !work.dissolve.size && !work.formats.size && !work.attrs.length && !hits && !work.concurrentBlocks()) {
      if (this.lastPrune < this.now() - DAY) this.prune();
      return;
    }
    this.ydoc.transact(t2 => work.run(t2, keys, conflicts), MOVES_ORIGIN);
  }

  /** the update deletes units that were copied, and its sender did not have the copy (as far as known) */
  private deletionHits(inc: Incoming): boolean {
    const ds = dsOf(inc);
    const had = carried(inc);
    let hit = false;
    ds.forEach((client, clock, len) => {
      if (hit) return;
      for (const [k, n, m] of this.index.overlapping(client, clock, len)) {
        if (!m.dst || m.side === HANDLED) continue;
        for (let i = 0; i < n && !hit; i++) if (!this.index.copiesOf(client, k + i).some(c => (had.get(c.client) ?? 0) > c.clock)) hit = true;
        if (hit) return;
      }
    });
    return hit;
  }

  /** for Work */
  get containerNames(): ReadonlySet<string> { return this.containers; }
  get stamp(): number { return this.now(); }
  log(...a: unknown[]): void { (this.opts.log ?? (() => {}))(...a); }
}

function dsOf(inc: Incoming): Ranges {
  if (!inc.ds) { try { inc.ds = Ranges.of(Y.decodeUpdate(inc.update).ds); } catch { inc.ds = new Ranges(); } }
  return inc.ds;
}

/**
 * What the sender had, at least: the structs its update carries (a client resends what it applied
 * from elsewhere — the editor applies an agent's edit itself and y-websocket sends it back — and that
 * update deletes the originals its copies replace) and the state vector of its sync step 1.
 */
function carried(inc: Incoming): Map<number, number> {
  if (!inc.had) {
    const had = new Map(inc.knows ?? []);
    try { for (const [client, to] of Y.parseUpdateMeta(inc.update).to) if (to > (had.get(client) ?? 0)) had.set(client, to); } catch { /* not decodable: nothing more */ }
    inc.had = had;
  }
  return inc.had;
}

/** the repair of one update */
class Work {
  /** stretches to move next to the copy of their neighbour */
  pending: Piece[] = [];
  private pendingAt = new Set<string>();
  /** formatting marks set on originals */
  formats = new Set<Y.Item>();
  /** live runs to re-create (something in them is misplaced) */
  dissolve = new Set<Y.Item>();
  /** the misplaced characters in them */
  private misplaced = new Set<Y.Item>();
  /** attribute values set on moved inline nodes */
  attrs: Y.Item[] = [];
  private index: MoveIndex;
  private doc: Y.Doc;
  private store: Y.Doc['store'];
  private deletedInT: Ranges;
  /** types this repair deleted (their content was alive) */
  private ours = new Set<Y.Item>();
  private rec!: MoveRecord;
  /** the copy last placed after each anchor (concurrent insertions keep their order) */
  private placed = new Map<string, Unit>();
  /** a placed copy → the anchor it was placed after (first in its chain) */
  private chain = new Map<string, string>();
  private adoptedSrc = new Ranges();
  /** copies of originals that were deleted before their record arrived */
  private late: Y.ID[] = [];
  /** paragraphs that lost copies to a competing record */
  private emptied = new Set<Y.XmlElement>();
  /** the records this update brought */
  private own = new Set<MoveRecord>();
  /** paragraphs the update made */
  private newBlocks: Y.Item[] = [];
  /** what this update brought into something that had moved (deleted on arrival, not by anybody) */
  private doa = new Ranges();
  /** the copies that won a competition (final ids) */
  private winners = new Set<string>();
  /** paragraph sizes before the conflicts are resolved */
  private sizes = new Map<Y.XmlElement, number>();

  constructor(private repair: MoveRepair, private tr: Y.Transaction, private inc: Incoming | null) {
    this.index = repair.index;
    this.doc = repair.ydoc;
    this.store = this.doc.store;
    this.deletedInT = Ranges.of(tr.deleteSet);
  }

  private isNew(id: Y.ID): boolean { return id.clock >= (this.tr.beforeState.get(id.client) ?? 0); }
  /** the sender deleted it itself (in the same update) */
  private explicit(client: number, clock: number): boolean {
    if (this.inc) return dsOf(this.inc).has(client, clock);
    // not from a client (the server's own diff of a file or an agent's edit, applied whole): what it
    // deleted it deleted itself, unless it went into something that was gone before it arrived
    if (clock < (this.tr.beforeState.get(client) ?? 0)) return true;
    let gone = false;
    forEachStruct(this.doc, client, clock, clock + 1, it => {
      for (let t = it.parent as Y.AbstractType<any> | null; t instanceof Y.AbstractType && t._item; t = t._item.parent as Y.AbstractType<any>) {
        if (t._item.deleted && !this.isNew(t._item.id) && !this.deletedInT.hasId(t._item.id)) { gone = true; break; }
      }
    });
    return !gone;
  }
  private mapped(client: number, clock: number) { const m = this.index.lookup(client, clock); return m && m.side !== HANDLED ? m : null; }
  /** a unit that counts for the text around it: alive, or moved (its copy stands for it) */
  private counts(it: Y.Item, off = 0): boolean {
    if (it.content instanceof Y.ContentFormat || it.content instanceof Y.ContentDeleted) return false;
    if (!it.deleted) return true;
    return !!this.mapped(it.id.client, it.id.clock + off);
  }
  /** an item that was there for whoever made it: alive, moved, or inserted / deleted in this update by somebody who did not delete it */
  private wasLive = (it: Y.Item): boolean => {
    if (it.content instanceof Y.ContentDeleted) return false;
    if (!it.deleted) return true;
    if (this.index.lookup(it.id.client, it.id.clock)) return true;
    if (this.ours.has(it) || this.inOurs(it)) return true;
    return (this.isNew(it.id) || this.deletedInT.hasId(it.id)) && !this.explicit(it.id.client, it.id.clock);
  };
  private inOurs(it: Y.Item): boolean {
    for (let p = it.parent as Y.AbstractType<any> | null; p instanceof Y.AbstractType && p._item; p = p._item.parent as Y.AbstractType<any>) if (this.ours.has(p._item)) return true;
    return false;
  }

  private addPending(p: Piece): void {
    const key = idKey(Y.createID(p.item.id.client, p.item.id.clock + p.off));
    if (this.pendingAt.has(key)) return;
    this.pendingAt.add(key);
    this.pending.push(p);
  }

  /* ------------------------------------------------------------------------------ what to repair */

  /** the update's new items, and what it deleted inside protected originals */
  scan(keys: string[]): void {
    const tr = this.tr;
    for (const k of keys) { const r = this.index.records.get(k); if (r) this.own.add(r); }
    for (const [client, after] of tr.afterState) {
      const from = tr.beforeState.get(client) ?? 0;
      if (after > from) forEachStruct(this.doc, client, from, after, it => this.consider(it, from, after, true));
    }
    // a record arrived: what others had put into the originals it deletes (deleted with them, implicitly)
    if (keys.length) this.deletedInT.forEach((client, clock, len) => forEachStruct(this.doc, client, clock, clock + len, it => this.consider(it, clock, clock + len, false)));
  }

  /** the part [from, to) of an item (new in the update, or deleted by it) */
  private consider(it: Y.Item, from: number, to: number, fresh: boolean): void {
    const a = Math.max(it.id.clock, from), b = Math.min(it.id.clock + it.length, to);
    if (a >= b || (!fresh && this.isNew(Y.createID(it.id.client, a)))) return;
    // (paragraphs the server's own diff made are where it put them: it saw their neighbours)
    if (fresh && !it.deleted && it.parentSub === null && !this.madeHere && typeOf(it) instanceof Y.XmlElement && this.repair.containerNames.has((typeOf(it) as Y.XmlElement).nodeName)) this.newBlocks.push(it);
    if (it.parentSub !== null) {
      // an attribute value set on a moved inline node
      const el = it.parent;
      if (fresh && it.deleted && el instanceof Y.XmlElement && el._item && this.index.keeps(el._item) && this.mapped(el._item.id.client, el._item.id.clock) && el._map.get(it.parentSub) === it && !this.explicit(it.id.client, it.id.clock)) this.attrs.push(it);
      return;
    }
    if (!containerOf(it, this.repair.containerNames)) return;
    if (it.deleted) {
      if (!this.index.keeps(it)) return;
      if (it.content instanceof Y.ContentFormat) { if (fresh && !this.index.lookup(it.id.client, it.id.clock) && !this.explicit(it.id.client, it.id.clock)) this.formats.add(it); return; }
      if (!(it.content instanceof Y.ContentString || it.content instanceof Y.ContentType || it.content instanceof Y.ContentEmbed)) return;
      if (fresh) this.doa.add(it.id.client, a, b - a);
      // the stretches nobody moved or deleted yet
      for (let k = a; k < b;) {
        let n = 1;
        const skip = !!this.index.lookup(it.id.client, k) || this.explicit(it.id.client, k);
        while (k + n < b && (!!this.index.lookup(it.id.client, k + n) || this.explicit(it.id.client, k + n)) === skip) n++;
        if (!skip) this.addPending({ item: it, off: k - it.id.clock, len: n });
        k += n;
      }
    } else if (fresh && !(it.content instanceof Y.ContentFormat) && this.liveMisplaced({ item: it, off: a - it.id.clock, len: b - a })) {
      // a character of a live run: the run is re-created around it (no moved unit stays in a live run)
      if (it.parent instanceof Y.XmlText && it.parent._item) { this.dissolve.add(it.parent._item); this.misplaced.add(it); }
      else this.addPending({ item: it, off: 0, len: it.length });
    }
  }

  /** live children of the paragraphs a record took units from that were inserted next to them before it arrived */
  private sourceNeighbours(): void {
    const conts = new Set<Y.XmlElement>();
    this.adoptedSrc.forEach((client, clock, len) => forEachStruct(this.doc, client, clock, clock + len, it => { const c = containerOf(it, this.repair.containerNames); if (c && isLive(c)) conts.add(c); }));
    for (const c of conts) for (let ch = c._start; ch; ch = ch.right) if (!ch.deleted && !this.isNew(ch.id) && this.liveMisplaced({ item: ch, off: 0, len: 1 })) this.addPending({ item: ch, off: 0, len: 1 });
  }

  /** a live stretch of a live paragraph whose neighbour was moved, or with a copy it did not know between it and its neighbour */
  private liveMisplaced(p: Piece): boolean {
    const it = p.item;
    if (this.ownCopy(it)) return false;
    const o = this.originOf(p);
    if (o && this.isSource(o, it)) return true;
    const r = o ? null : this.rightOf(p, false);
    if (r && this.isSource(r, it)) return true;
    // copies between it and its neighbour (inserted concurrently: its author did not see them)
    if (o) { for (let u: Unit | null = this.prev({ item: it, off: p.off }, true); u && !this.same(u, o); u = this.prev(u, true)) if (!u.item.deleted && this.isCopy(u, it)) return true; }
    else if (r) { for (let u: Unit | null = this.next({ item: it, off: p.off + p.len - 1 }, true); u && !this.same(u, r); u = this.next(u, true)) if (!u.item.deleted && this.isCopy(u, it)) return true; }
    return false;
  }
  /** `by`'s author knew the record when it made `by`: a record of this update, for what the update made (the server's own diff: whatever it saw) */
  private known(rec: MoveRecord, by: Y.Item): boolean {
    // (the update's records are restated in this repair's record)
    const own = this.own.has(rec) || rec === this.rec;
    if (own && this.isNew(by.id)) return true;
    if (!this.madeHere) return false;
    // the server's own diff: it saw everything it was made on (a client's update can arrive meanwhile)
    const at = own ? null : this.doc.getMap<unknown>(MOVES_MAP)._map.get(rec.key);
    return this.saw(by.id) && (own || (!!at && this.saw(at.id)));
  }
  /** the update was made by the server on the document as it was (not by a client that may not have seen everything) */
  private get madeHere(): boolean { return this.tr.local || !!this.inc?.server; }
  /** its author had it when it made the update (a client is known to have had only what it made in it) */
  private saw(id: Y.ID): boolean {
    if (this.isNew(id) || this.tr.local) return true;
    const k = this.inc?.server ? this.inc.knows : null;
    return !!k && id.clock < (k.get(id.client) ?? 0);
  }
  private isSource(u: Unit, by: Y.Item): boolean {
    if (typeOf(u.item) instanceof Y.XmlText) { const last = this.edgeUnit(u.item, true); return !!last && this.isSource(last, by); }
    const m = u.item.deleted ? this.mapped(u.item.id.client, u.item.id.clock + u.off) : null;
    return !!m && !this.known(m.rec, by);
  }
  /** a copy (or a run of copies) the sender's own record made */
  private ownCopy(it: Y.Item): boolean {
    let item = it, off = 0;
    if (typeOf(it) instanceof Y.XmlText) { const first = this.edgeUnit(it, false); if (!first) return false; item = first.item; off = first.off; }
    const s = this.index.sourceOf(item.id.client, item.id.clock + off);
    return !!s && this.own.has(s.rec);
  }
  /** a copy a record made (not a late edit the server placed: that is just another concurrent insertion) */
  private isCopy(u: Unit, by: Y.Item): boolean {
    let item = u.item, off = u.off;
    if (typeOf(item) instanceof Y.XmlText) { const first = this.edgeUnit(item, false); if (!first) return false; item = first.item; off = first.off; }
    const s = this.index.sourceOf(item.id.client, item.id.clock + off);
    return !!s && s.side !== PLACED && !this.known(s.rec, by);
  }

  /* ------------------------------------------------------------------------------ the repair */

  run(_t2: Y.Transaction, keys: string[], conflicts: MoveIndex['conflicts']): void {
    const map = this.doc.getMap<unknown>(MOVES_MAP);
    let seq = 0;
    for (const k of map.keys()) if (k[0] === 's') seq = Math.max(seq, parseInt(k.slice(1), 36) || 0);
    this.rec = { key: 's' + (seq + 1).toString(36).padStart(8, '0'), t: this.repair.stamp, server: true, size: 0, protect: [], adopt: [], entries: [] };
    this.index.add(this.rec);
    const conflicted = new Ranges();
    for (const c of conflicts) conflicted.add(c.client, c.clock, c.len);
    // the editors' records: restated (their valid entries), so that the server's records are the only lasting ones
    for (const key of keys) {
      const r = decodeRecord(key, map.get(key));
      map.delete(key);
      this.index.records.delete(key);
      this.rec.adopt.push(key);
      if (!r) continue;
      this.rec.size += r.size;
      for (const p of r.protect) if (Y.getState(this.store, p.client) > p.clock) { const it = Y.getItem(this.store, p); if (it instanceof Y.Item && it.deleted) this.protect(it.id); }
      const e = r.entries;
      for (let i = 0; i < e.length; i += 6) {
        const [sc, sk, len, side, dc, dk] = e.slice(i, i + 6);
        this.adoptedSrc.add(sc, sk, len);
        if (!this.valid(sc, sk, len, dc, dk)) { this.add(sc, sk, len, HANDLED, -1, 0); continue; }
        // the parts that conflict with an earlier record are resolved below
        for (let k = sk; k < sk + len;) {
          let n = 1;
          const c = conflicted.has(sc, k);
          while (k + n < sk + len && conflicted.has(sc, k + n) === c) n++;
          if (!c) this.add(sc, k, n, side, dc, dc < 0 ? 0 : dk + (k - sk));
          k += n;
        }
        // an original somebody had deleted before the record arrived (its author copied it, not knowing): the copy goes too
        if (dc >= 0 && side !== HANDLED) for (let k = sk; k < sk + len; k++) if (!this.isNew(Y.createID(sc, k)) && !this.deletedInT.has(sc, k) && !conflicted.has(sc, k)) this.late.push(Y.createID(dc, dk + (k - sk)));
      }
    }
    if (keys.length) this.sourceNeighbours();
    const recreate = new Set<Y.Item>(this.dissolve);
    for (const c of conflicts) this.resolve(c, recreate);
    for (const runItem of recreate) this.dissolveRun(runItem);
    this.place();
    // what was typed next to something this repair moved follows it too (a run behind a formula that moved)
    for (let round = 0; round < 3 && this.followers(); round++) this.place();
    this.reformat();
    this.reattribute();
    this.propagateDeletions();
    this.reorderBlocks();
    this.normalize();
    if (this.rec.entries.length || this.rec.adopt.length || this.rec.protect.length) map.set(this.rec.key, encodeRecord(this.rec));
    else this.index.records.delete(this.rec.key);
  }

  private add(sc: number, sk: number, len: number, side: number, dc: number, dk: number): void {
    const out = new EntryList();
    out.entries = this.rec.entries;
    out.push(sc, sk, len, side, dc, dk);
    this.index.entry(this.rec, sc, sk, len, side, dc, dk);
  }
  /** entries sorted and merged into ranges */
  private addMany(list: number[][]): void {
    list.sort((a, b) => a[0] - b[0] || a[1] - b[1]);
    const merged = new EntryList();
    for (const e of list) merged.push(e[0], e[1], e[2], e[3], e[4], e[5]);
    const e = merged.entries;
    for (let i = 0; i < e.length; i += 6) this.add(e[i], e[i + 1], e[i + 2], e[i + 3], e[i + 4], e[i + 5]);
  }
  private protect(id: Y.ID): void {
    if (!this.rec.protect.some(p => p.client === id.client && p.clock === id.clock)) this.rec.protect.push(id);
    this.index.protect(id);
  }

  /**
   * An editor's entry: deleted sources, existing copies of the same kind. (A copy may be gone already —
   * a run the editor re-created right after the copy, collected before the editor sent it.)
   */
  private valid(sc: number, sk: number, len: number, dc: number, dk: number): boolean {
    if (Y.getState(this.store, sc) < sk + len || (dc >= 0 && Y.getState(this.store, dc) < dk + len)) return false;
    let ok = true;
    forEachStruct(this.doc, sc, sk, sk + len, it => { if (!it.deleted) ok = false; });
    if (ok && dc >= 0) {
      const a = Y.getItem(this.store, Y.createID(sc, sk)), b = Y.getItem(this.store, Y.createID(dc, dk));
      if (!(a instanceof Y.Item) || !(b instanceof Y.Item) || b.content instanceof Y.ContentDeleted || a.content instanceof Y.ContentDeleted) return true;
      const ta = typeOf(a), tb = typeOf(b);
      if ((ta instanceof Y.XmlElement) !== (tb instanceof Y.XmlElement)) return false;
      if (ta instanceof Y.XmlElement && tb instanceof Y.XmlElement && ta.nodeName !== tb.nodeName) return false;
      if (a.content instanceof Y.ContentString && b.content instanceof Y.ContentString && a.content.str[sk - a.id.clock] !== b.content.str[dk - b.id.clock]) return false;
    }
    return ok;
  }

  /**
   * One original copied by two records: the copy of a move wins over one that stayed in its
   * paragraph (or was placed there by the server); of two moved copies the smaller move's (the inner
   * split point); else the earlier.
   * A copy that was deleted takes the other one with it (somebody deleted that text).
   */
  private resolve(c: MoveIndex['conflicts'][number], recreate: Set<Y.Item>): void {
    const r = c.rec, old = c.old;
    const out: number[][] = [];
    const gone: Y.ID[] = [];
    for (let k = c.clock; k < c.clock + c.len; k++) {
      const mine = entryFor(r, c.client, k);
      if (!mine || !mine[1]) continue;
      const [side, dst] = mine;
      const oldDst = old.dst ? Y.createID(old.dst.client, old.dst.clock + (k - c.clock)) : null;
      // a move beats a copy that stayed with its neighbours (a re-created run, or the server's placement of
      // a late edit): those agree with each other, and the earlier one is where the neighbours are; a copy
      // its author moved on (a second split) counts as moved; of two moves the one into the smaller
      // paragraph (the inner split point) wins
      const ns = this.strength(side, dst), os = oldDst ? this.strength(old.side, oldDst) : KEPT;
      let newWins = !oldDst || (ns === MOVED && os !== MOVED) || (ns === MOVED && os === MOVED && this.sizeAt(this.resolveId(dst)) < this.sizeAt(this.resolveId(oldDst)));
      // a copy inside a paragraph (or run) that is gone — joined into another meanwhile — cannot win
      if (oldDst) {
        const pn = this.placeable(this.resolveId(dst)), po = this.placeable(this.resolveId(oldDst));
        if (pn !== po) newWins = pn;
      }
      // a late edit the server placed beside its neighbour, also moved by this record (which knew it): it
      // goes where this record's move of that neighbour went (if the move lost there, it lost here too)
      if (oldDst && newWins && old.side === PLACED) newWins = this.moveHeld(r, Y.createID(c.client, k), dst);
      this.winners.add(idKey(this.resolveId(newWins ? dst : oldDst!)));
      const at = out.length;
      if (newWins) {
        out.push([c.client, k, 1, side, dst.client, dst.clock]);
        if (oldDst) {
          const f = this.resolveId(oldDst);
          if (this.isDeleted(f)) gone.push(dst);
          this.drop(f, recreate);
          if (!sameId(f, dst)) out.push([f.client, f.clock, 1, side, dst.client, dst.clock]);
        }
      } else {
        out.push([c.client, k, 1, old.side, oldDst!.client, oldDst!.clock]);
        const f = this.resolveId(oldDst!);
        // the losing copy may have been moved on by its author (a second split): the last one goes
        const fn = this.resolveId(dst);
        if (this.isDeleted(fn)) gone.push(f);
        this.drop(fn, recreate);
        if (!sameId(f, fn)) out.push([fn.client, fn.clock, 1, old.side, f.client, f.clock]);
      }
      // in the index right away: the next unit's decision may look at this one
      for (const e of out.slice(at)) this.index.entry(this.rec, e[0], e[1], e[2], e[3], e[4], e[5]);
    }
    this.addMany(out);
    this.late.push(...gone);
  }
  /** the record's copy of the unit is where its move of the unit's left neighbour ended up */
  private moveHeld(r: MoveRecord, id: Y.ID, dst: Y.ID): boolean {
    const u = this.unitAt(id);
    if (!u) return true;
    for (let a = this.prev(u, true); a; a = this.prev(a, true)) {
      const mine = entryFor(r, a.item.id.client, a.item.id.clock + a.off);
      if (!mine || !mine[1]) continue;
      const fa = this.unitAt(this.resolveId(Y.createID(a.item.id.client, a.item.id.clock + a.off)));
      const fd = this.unitAt(this.resolveId(dst));
      return !!fa && !!fd && containerOf(fa.item, this.repair.containerNames) === containerOf(fd.item, this.repair.containerNames);
    }
    return true;
  }

  /** the unit's run and paragraph are alive (the unit itself may be deleted) */
  private placeable(id: Y.ID): boolean {
    const u = this.unitAt(id);
    if (!u) return false;
    const c = containerOf(u.item, this.repair.containerNames);
    return !!c && isLive(c) && (!(u.item.parent instanceof Y.XmlText) || isLive(u.item.parent));
  }

  /** moved, when a copy along the way was moved (not only re-created or placed) */
  private strength(side: number, dst: Y.ID): number {
    let id = dst;
    for (let i = 0; i < 64 && side !== MOVED; i++) {
      const m = this.mapped(id.client, id.clock);
      if (!m || !m.dst) break;
      if (m.side === MOVED) side = MOVED;
      id = m.dst;
    }
    return side;
  }
  /** the number of units in the paragraph of a unit */
  private sizeAt(id: Y.ID): number {
    const u = this.unitAt(id);
    const c = u && containerOf(u.item, this.repair.containerNames);
    if (!c) return Infinity;
    let cached = this.sizes.get(c);
    if (cached === undefined) {
      cached = 0;
      for (let ch = c._start; ch; ch = ch.right) if (!ch.deleted) { const t = typeOf(ch); cached += t instanceof Y.XmlText ? t._length : 1; }
      this.sizes.set(c, cached);
    }
    return cached;
  }
  /** deleted by somebody (not moved, nor arrived inside something that had moved) */
  private isDeleted(id: Y.ID): boolean {
    const u = this.unitAt(id);
    if (!u || !u.item.deleted || this.mapped(id.client, id.clock) || this.doa.has(id.client, id.clock)) return false;
    // gone with its paragraph or run in this very update (a join deleted it), not deleted by its sender
    return !(this.deletedInT.has(id.client, id.clock) && !this.explicit(id.client, id.clock));
  }

  /** take a losing copy out: a character (its run is re-created), an inline node (deleted, kept) */
  private drop(id: Y.ID, recreate: Set<Y.Item>): void {
    if (Y.getState(this.store, id.client) <= id.clock) return;
    const it = Y.getItem(this.store, id);
    if (!(it instanceof Y.Item) || it.deleted) return;
    const cont = containerOf(it, this.repair.containerNames);
    if (cont) this.emptied.add(cont);
    const run = it.parent instanceof Y.XmlText ? it.parent._item : null;
    if (run) {
      const at = this.unitIndexIn(it.parent as Y.XmlText, it) + (id.clock - it.id.clock);
      (it.parent as Y.XmlText).delete(at, 1);
      if (isLive(it.parent as Y.XmlText)) recreate.add(run);
    } else if (typeOf(it) instanceof Y.XmlElement) {
      const parent = it.parent as Y.XmlElement;
      parent.delete(childIndex(parent, it), 1);
      this.protect(it.id);
    }
  }

  /**
   * A live run with moved units in it (or a misplaced one), re-created. Its live text falls into
   * stretches between the units that moved away; a stretch holding the copy that counts for some
   * earlier unit stays (in a new run in its place), any other — text typed after a unit that moved,
   * or a copy of the editor's own new text that stayed with neighbours which moved — follows the unit
   * before it.
   */
  private dissolveRun(runItem: Y.Item): void {
    if (runItem.deleted) return;
    const run = typeOf(runItem) as Y.XmlText;
    const parent = runItem.parent as Y.XmlElement;
    type Ch = { id: Y.ID; item: Y.Item; off: number; text: string; attrs: Record<string, unknown> };
    const stretches: Ch[][] = [[]];
    /** the unit that moved away right before each stretch */
    const before: (Y.ID | null)[] = [null];
    const attrs: Record<string, unknown> = {};
    for (let it = run._start; it; it = it.right) {
      if (it.content instanceof Y.ContentFormat) {
        if (!it.deleted) { const { key, value } = it.content; if (value === null) delete attrs[key]; else attrs[key] = value; this.add(it.id.client, it.id.clock, it.length, HANDLED, -1, 0); }
        continue;
      }
      if (!(it.content instanceof Y.ContentString)) continue;
      for (let o = 0; o < it.length; o++) {
        const id = Y.createID(it.id.client, it.id.clock + o);
        if (it.deleted) {
          if (this.mapped(id.client, id.clock)) { if (stretches[stretches.length - 1].length) { stretches.push([]); before.push(id); } else before[before.length - 1] = id; }
          continue;
        }
        if (this.misplaced.has(it)) { stretches.push([{ id, item: it, off: o, text: '', attrs: {} }], []); before.push(null, null); continue; }
        stretches[stretches.length - 1].push({ id, item: it, off: o, text: it.content.str[o], attrs: { ...attrs } });
      }
    }
    // a copy that won against a competing one, or a moved copy that counts for its original, holds its stretch in place
    const counts = (c: Ch) => {
      if (this.misplaced.has(c.item)) return false;
      if (this.winners.has(idKey(c.id))) return true;
      const src = this.index.sourceOf(c.id.client, c.id.clock);
      return !!src && src.side === MOVED && sameId(this.resolveId(src.src), c.id);
    };
    // a stretch that the move put next to the unit before it (a join appending another paragraph's text)
    // goes where that unit went; one that followed it in the same paragraph before stays with its own
    const sameSource = (a: Y.ID, b: Y.ID) => {
      const oa = this.originalOf(this.unitAt(a)!, 0), ob = this.originalOf(this.unitAt(b)!, 0);
      return !!oa && !!ob && containerOf(oa.item, this.repair.containerNames) === containerOf(ob.item, this.repair.containerNames);
    };
    const stay: Ch[] = [], go: Ch[] = [];
    stretches.forEach((st, i) => {
      if (!st.length) return;
      const prev = before[i];
      const holds = st.some(counts) && (!prev || !this.unitAt(prev) || sameSource(prev, st[0].id));
      (holds ? stay : go).push(...st);
    });
    const at = childIndex(parent, runItem);
    if (stay.length) {
      const copy = new Y.XmlText();
      insertSeparated(parent, at, [copy]);
      let pos = 0;
      for (const u of stay) { copy.insert(pos, u.text, u.attrs); pos += u.text.length; }
      const ids: Y.ID[] = [];
      for (let it = copy._start; it; it = it.right) if (it.content instanceof Y.ContentString) for (let o = 0; o < it.length; o++) ids.push(Y.createID(it.id.client, it.id.clock + o));
      stay.forEach((u, i) => this.add(u.id.client, u.id.clock, 1, KEPT, ids[i].client, ids[i].clock));
      parent.delete(at + 1, 1);
    } else parent.delete(at, 1);
    this.ours.add(runItem);
    this.protect(runItem.id);
    // what goes, in stretches of one item each (a word typed in one go moves as one)
    for (let i = 0; i < go.length;) {
      let j = i + 1;
      while (j < go.length && go[j].item === go[i].item && go[j].off === go[j - 1].off + 1) j++;
      this.addPending({ item: go[i].item, off: go[i].off, len: j - i });
      i = j;
    }
  }

  /* ------------------------------------------------------------------------------ placing */

  /** every pending stretch, paragraph by paragraph in document order */
  private place(): void {
    const byCont = new Map<Y.XmlElement, Piece[]>();
    for (const p of this.pending) {
      if (this.insidePending(p.item)) continue;
      const c = containerOf(p.item, this.repair.containerNames);
      if (!c) continue;
      let l = byCont.get(c);
      if (!l) byCont.set(c, l = []);
      l.push(p);
    }
    for (const [cont, pieces] of byCont) {
      const order = new Map<Y.Item, number>();
      let i = 0;
      for (let ch = cont._start; ch; ch = ch.right) {
        order.set(ch, i++);
        const t = typeOf(ch);
        if (t instanceof Y.XmlText) for (let it = t._start; it; it = it.right) order.set(it, i++);
      }
      pieces.sort((a, b) => (order.get(a.item) ?? 0) - (order.get(b.item) ?? 0) || a.off - b.off);
      for (const p of pieces) {
        // what a competing record's resolution mapped meanwhile is placed already (a losing copy)
        for (const q of this.unmappedParts(p)) {
          try { this.move(q); } catch (e) { this.repair.log('[moves] could not place', idKey(q.item.id), e); }
        }
      }
    }
  }

  /** live children of the paragraphs this repair moved things out of, whose neighbour moved meanwhile: pending again */
  private followers(): boolean {
    const conts = new Set<Y.XmlElement>();
    const e = this.rec.entries;
    for (let i = 0; i < e.length; i += 6) {
      if (e[i + 3] !== PLACED && e[i + 3] !== MOVED) continue;
      const u = this.unitAt(Y.createID(e[i], e[i + 1]));
      const c = u && containerOf(u.item, this.repair.containerNames);
      if (c && isLive(c)) conts.add(c);
    }
    const before = this.pending.length;
    this.pending = [];
    for (const c of conts) for (let ch = c._start; ch; ch = ch.right) if (!ch.deleted && !this.isNew(ch.id) && this.liveMisplaced({ item: ch, off: 0, len: 1 })) this.addPending({ item: ch, off: 0, len: 1 });
    void before;
    return this.pending.length > 0;
  }

  private unmappedParts(p: Piece): Piece[] {
    if (typeOf(p.item)) return this.index.lookup(p.item.id.client, p.item.id.clock) ? [] : [p];
    const out: Piece[] = [];
    for (let o = p.off; o < p.off + p.len;) {
      let n = 1;
      const m = !!this.index.lookup(p.item.id.client, p.item.id.clock + o);
      while (o + n < p.off + p.len && !!this.index.lookup(p.item.id.client, p.item.id.clock + o + n) === m) n++;
      if (!m) out.push({ item: p.item, off: o, len: n });
      o += n;
    }
    return out;
  }

  private insidePending(it: Y.Item): boolean {
    for (let p = it.parent as Y.AbstractType<any> | null; p instanceof Y.AbstractType && p._item; p = p._item.parent as Y.AbstractType<any>) if (this.pendingAt.has(idKey(p._item.id))) return true;
    return false;
  }

  private move(x: Piece): void {
    let pos = this.target(x);
    if (pos === 'stay') return;
    // nothing around it is left (its paragraph and its neighbours' went): beside the nearest live paragraph, never lost
    pos ??= this.fallback(x);
    if (!pos) { this.repair.log('[moves] nowhere to put', idKey(x.item.id)); return; }
    const it = x.item, t = typeOf(it);
    // a live run or inline node goes first (its copy must not land inside it), then the place is found again
    if (!it.deleted && t) {
      const parent = it.parent as Y.XmlElement;
      parent.delete(childIndex(parent, it), 1);
      this.ours.add(it);
      const again = this.target(x);
      if (again && again !== 'stay') pos = again;
    }
    let last: Unit | null = null;
    if (it.content instanceof Y.ContentString) {
      const id = this.insertText(pos, it.content.str.slice(x.off, x.off + x.len), this.attrsAt(it));
      this.add(it.id.client, it.id.clock + x.off, x.len, PLACED, id.client, id.clock);
      last = this.unitAt(Y.createID(id.client, id.clock + x.len - 1));
    } else if (t instanceof Y.XmlText) {
      let p = pos;
      for (const seg of this.segments(t)) {
        // what of it was moved elsewhere already (a losing copy resolved onto the winner) stays there
        for (const part of this.unmappedParts({ item: seg.item, off: 0, len: seg.item.length })) {
          const id = this.insertText(p, seg.item.content.str.slice(part.off, part.off + part.len), seg.attrs);
          this.add(seg.item.id.client, seg.item.id.clock + part.off, part.len, PLACED, id.client, id.clock);
          last = this.unitAt(Y.createID(id.client, id.clock + part.len - 1));
          p = { ...p, index: p.index + part.len };
        }
      }
      this.add(it.id.client, it.id.clock, 1, HANDLED, -1, 0);
      this.removeLive(it);
    } else if (t instanceof Y.XmlElement) {
      const copy = this.insertElement(pos, this.virtualCopy(t));
      this.add(it.id.client, it.id.clock, 1, PLACED, copy._item!.id.client, copy._item!.id.clock);
      const out = new EntryList();
      pairCopies(t, copy, this.wasLive, PLACED, out);
      for (let i = 0; i < out.entries.length; i += 6) this.add(...(out.entries.slice(i, i + 6) as [number, number, number, number, number, number]));
      this.removeLive(it);
      last = { item: copy._item!, off: 0 };
    }
    if (last) {
      // the next one placed after the same unit, or after what was just placed there, goes behind it all
      const root = this.chain.get(pos.key) ?? pos.key;
      this.placed.set(root, last);
      this.chain.set(idKey(Y.createID(last.item.id.client, last.item.id.clock + last.off)), root);
    }
  }

  /**
   * Where something goes that has nothing left around it: at the end of the nearest live paragraph
   * before its paragraph (or the start of the one after), going up through deleted insets and cells.
   */
  private fallback(x: Piece): Pos | null {
    let t: Y.AbstractType<any> | null = containerOf(x.item, this.repair.containerNames);
    for (let depth = 0; t && t._item && depth < 16; depth++) {
      const item = t._item;
      const parent = item.parent as Y.AbstractType<any>;
      for (let it = item.left; it; it = it.left) {
        const c = typeOf(it);
        if (!it.deleted && isContainer(c, this.repair.containerNames) && isLive(c)) {
          let n = 0;
          for (let ch = (c as Y.XmlElement)._start; ch; ch = ch.right) if (!ch.deleted && ch.countable) { const tc = typeOf(ch); n += tc instanceof Y.XmlText ? tc._length : 1; }
          return { cont: c as Y.XmlElement, index: n, key: 'end:' + idKey(it.id) };
        }
      }
      for (let it = item.right; it; it = it.right) {
        const c = typeOf(it);
        if (!it.deleted && isContainer(c, this.repair.containerNames) && isLive(c)) {
          const key = 'start:' + idKey(it.id), last = this.placed.get(key);
          return { cont: c as Y.XmlElement, index: last ? this.unitIndex(c as Y.XmlElement, last) + 1 : 0, key };
        }
      }
      t = parent instanceof Y.AbstractType ? parent : null;
      // past the paragraph level: the inline node holding it, then its paragraph
      while (t && t._item && !isContainer(t, this.repair.containerNames)) t = t._item.parent instanceof Y.AbstractType ? t._item.parent : null;
    }
    return null;
  }

  /** a live item that was moved: deleted, and kept as the original of its copy */
  private removeLive(x: Y.Item): void {
    if (!x.deleted) {
      const parent = x.parent as Y.XmlElement;
      parent.delete(childIndex(parent, x), 1);
      this.ours.add(x);
    }
    this.protect(x.id);
  }

  /**
   * Where `x` goes: after its left neighbour as its author saw it (its origin), or the nearest unit
   * before that which is still there or was copied; else before its right neighbour; else where
   * its run was; 'stay' when that is where it is.
   */
  private target(x: Piece): Pos | 'stay' | null {
    for (let a = this.originOf(x); a; a = this.prev(a, true)) {
      if (this.counts(a.item, a.off)) return this.after(a, x);
    }
    // before what followed it in its run (or list)
    for (let r = this.rightOf(x, false); r; r = this.next(r, false)) if (this.counts(r.item, r.off)) return this.before(r, x);
    // where its run is: after what precedes the run, at the start of the paragraph, before what follows
    const self = x.item.parent instanceof Y.XmlText && x.item.parent._item ? x.item.parent._item : x.item;
    for (let a = this.prev({ item: self, off: 0 }, true); a; a = this.prev(a, true)) if (this.counts(a.item, a.off)) return this.after(a, x);
    const cont = containerOf(x.item, this.repair.containerNames);
    if (cont && isLive(cont)) {
      if (!x.item.deleted) return 'stay';
      const key = 'start:' + idKey(cont._item!.id), last = this.placed.get(key);
      return { cont, index: last ? this.unitIndex(cont, last) + 1 : 0, key };
    }
    for (let r = this.next({ item: self, off: 0 }, true, true); r; r = this.next(r, true)) if (this.counts(r.item, r.off)) return this.before(r, x);
    return null;
  }

  private after(a: Unit, x: Piece, depth = 0): Pos | 'stay' | null {
    const f = this.final(a);
    const fit = f.item;
    const cont = containerOf(fit, this.repair.containerNames);
    if (!cont || !isLive(cont) || (fit.parent instanceof Y.XmlText && !isLive(fit.parent))) return depth > 8 ? null : this.around(f, x, depth + 1);
    const key = idKey(Y.createID(fit.id.client, fit.id.clock + f.off));
    const last = this.placed.get(this.chain.get(key) ?? key);
    if (!x.item.deleted && !last && this.adjacentAfter(f, x)) return 'stay';
    const base = last ?? f;
    return { cont, index: this.unitIndex(cont, base) + (base.item.deleted ? 0 : 1), key };
  }

  private before(r: Unit, x: Piece, depth = 0): Pos | 'stay' | null {
    const f = this.final(r);
    const fit = f.item;
    const cont = containerOf(fit, this.repair.containerNames);
    if (!cont || !isLive(cont) || (fit.parent instanceof Y.XmlText && !isLive(fit.parent))) return depth > 8 ? null : this.around(f, x, depth + 1);
    if (!x.item.deleted && this.adjacentBefore(f, x)) return 'stay';
    return { cont, index: this.unitIndex(cont, f), key: 'before:' + idKey(Y.createID(fit.id.client, fit.id.clock + f.off)) };
  }

  /** a final copy that is itself in deleted territory: next to what is around it */
  private around(f: Unit, x: Piece, depth: number): Pos | 'stay' | null {
    for (let a = this.prev(f, true); a; a = this.prev(a, true)) if (this.counts(a.item, a.off)) return this.after(a, x, depth);
    for (let r = this.next(f, true); r; r = this.next(r, true)) if (this.counts(r.item, r.off)) return this.before(r, x, depth);
    return null;
  }

  /** x (alive) comes right after f: only uncounted units between them */
  private adjacentAfter(f: Unit, x: Piece): boolean {
    const run = typeOf(x.item);
    for (let u = this.next(f, true); u; u = this.next(u, true)) {
      if ((u.item === x.item && u.off === x.off) || (run && u.item.parent === run)) return true;
      if (!u.item.deleted && this.counts(u.item, u.off)) return false;
    }
    return false;
  }
  private adjacentBefore(f: Unit, x: Piece): boolean {
    const run = typeOf(x.item);
    for (let u = this.prev(f, true); u; u = this.prev(u, true)) {
      if ((u.item === x.item && u.off === x.off + x.len - 1) || (run && u.item.parent === run)) return true;
      if (!u.item.deleted && this.counts(u.item, u.off)) return false;
    }
    return false;
  }

  /** follow the copies of a unit to the last one */
  private final(u: Unit): Unit {
    const id = this.resolveId(Y.createID(u.item.id.client, u.item.id.clock + u.off));
    return this.unitAt(id) ?? u;
  }
  private resolveId(id: Y.ID): Y.ID {
    for (let i = 0; i < 64; i++) { const m = this.mapped(id.client, id.clock); if (!m || !m.dst) break; id = m.dst; }
    return id;
  }

  /* ------------------------------------------------------------------------------ inline units */

  private unitAt(id: Y.ID): Unit | null {
    if (Y.getState(this.store, id.client) <= id.clock) return null;
    const it = Y.getItem(this.store, id);
    return it instanceof Y.Item ? { item: it, off: id.clock - it.id.clock } : null;
  }
  private same(a: Unit, b: Unit): boolean { return a.item === b.item && a.off === b.off; }

  /** the unit a stretch was typed after (within its item: the character before; a run as a neighbour: its last unit) */
  private originOf(x: Piece): Unit | null {
    if (x.off > 0) return { item: x.item, off: x.off - 1 };
    if (!x.item.origin) return null;
    const u = this.unitAt(x.item.origin);
    if (!u) return null;
    return typeOf(u.item) instanceof Y.XmlText ? this.edgeUnit(u.item, true) ?? this.prev(u, true) : u;
  }
  /** the unit a stretch was typed before (`cross`: past the end of its run) */
  private rightOf(x: Piece, cross: boolean): Unit | null {
    if (x.off + x.len < x.item.length) return { item: x.item, off: x.off + x.len };
    if (x.item.rightOrigin) {
      const u = this.unitAt(x.item.rightOrigin);
      if (u) return typeOf(u.item) instanceof Y.XmlText ? this.edgeUnit(u.item, false) ?? this.next(u, true, true) : u;
    }
    if (cross && x.item.parent instanceof Y.XmlText && x.item.parent._item) return this.next({ item: x.item.parent._item, off: 0 }, true, true);
    return null;
  }
  /** the first / last unit of a run item */
  private edgeUnit(runItem: Y.Item, last: boolean): Unit | null {
    const run = typeOf(runItem) as Y.XmlText;
    if (last) {
      let lastIt: Y.Item | null = null;
      for (let it = run._start; it; it = it.right) if (it.length && !(it.content instanceof Y.ContentFormat)) lastIt = it;
      return lastIt ? { item: lastIt, off: lastIt.length - 1 } : null;
    }
    for (let it = run._start; it; it = it.right) if (it.length && !(it.content instanceof Y.ContentFormat)) return { item: it, off: 0 };
    return null;
  }

  /** the unit before `u` in its paragraph (`cross`: across runs) */
  private prev(u: Unit, cross: boolean): Unit | null {
    if (u.off > 0) return { item: u.item, off: u.off - 1 };
    let it = u.item.left;
    while (it && (it.content instanceof Y.ContentFormat || it.length === 0)) it = it.left;
    if (it) return typeOf(it) instanceof Y.XmlText ? (this.edgeUnit(it, true) ?? this.prev({ item: it, off: 0 }, cross)) : { item: it, off: it.length - 1 };
    if (cross && u.item.parent instanceof Y.XmlText && u.item.parent._item) return this.prev({ item: u.item.parent._item, off: 0 }, cross);
    return null;
  }
  private next(u: Unit, cross: boolean, skipSelf = false): Unit | null {
    if (!skipSelf && u.off < u.item.length - 1 && !typeOf(u.item)) return { item: u.item, off: u.off + 1 };
    let it = u.item.right;
    while (it && (it.content instanceof Y.ContentFormat || it.length === 0)) it = it.right;
    if (it) return typeOf(it) instanceof Y.XmlText ? (this.edgeUnit(it, false) ?? this.next({ item: it, off: 0 }, cross, true)) : { item: it, off: 0 };
    if (cross && u.item.parent instanceof Y.XmlText && u.item.parent._item) return this.next({ item: u.item.parent._item, off: 0 }, cross, true);
    return null;
  }

  /** the number of visible units before `u` in the live paragraph `cont` */
  private unitIndex(cont: Y.XmlElement, u: Unit): number {
    let n = 0;
    for (let c = cont._start; c; c = c.right) {
      if (c === u.item) return n;
      const t = typeOf(c);
      if (t instanceof Y.XmlText && u.item.parent === t) return n + this.unitIndexIn(t, u.item) + (u.item.deleted ? 0 : u.off);
      if (!c.deleted && c.countable) n += t instanceof Y.XmlText ? t._length : 1;
    }
    return n;
  }
  private unitIndexIn(run: Y.XmlText, item: Y.Item): number {
    let n = 0;
    for (let it = run._start; it && it !== item; it = it.right) if (!it.deleted && it.countable) n += it.length;
    return n;
  }

  /** insert text at a unit position of a live paragraph (into the run there, or a new one); returns the id of its first character */
  private insertText(pos: Pos, text: string, attrs: Record<string, unknown>): Y.ID {
    const { cont, index } = pos;
    const me = this.doc.clientID;
    const from = Y.getState(this.store, me);
    let n = 0, child = 0, done = false;
    for (let c = cont._start; c && !done; c = c.right) {
      if (c.deleted || !c.countable) continue;
      const t = typeOf(c);
      if (t instanceof Y.XmlText) {
        if (index >= n && index <= n + t._length) { t.insert(index - n, text, { ...attrs }); done = true; break; }
        n += t._length;
      } else {
        if (index === n) { const r = new Y.XmlText(); insertSeparated(cont, child, [r]); r.insert(0, text, { ...attrs }); done = true; break; }
        n += 1;
      }
      child++;
    }
    if (!done) { const r = new Y.XmlText(); insertSeparated(cont, child, [r]); r.insert(0, text, { ...attrs }); }
    let id: Y.ID | null = null;
    forEachStruct(this.doc, me, from, Y.getState(this.store, me), it => { if (!id && it.content instanceof Y.ContentString) id = it.id; });
    if (!id) throw new Error('inserted text not found');
    return id;
  }

  /** insert an inline node at a unit position (a run there is re-created in two parts around it) */
  private insertElement(pos: Pos, el: Y.XmlElement): Y.XmlElement {
    const { cont, index } = pos;
    let n = 0, child = 0;
    for (let c = cont._start; c; c = c.right) {
      if (c.deleted || !c.countable) continue;
      const t = typeOf(c);
      if (index === n) { cont.insert(child, [el]); return el; }
      if (t instanceof Y.XmlText) {
        if (index > n && index < n + t._length) { this.splitRun(c, index - n, el); return el; }
        n += t._length;
      } else n += 1;
      child++;
    }
    cont.insert(child, [el]);
    return el;
  }

  /** a live run re-created as two runs with `el` between them, at offset `k` */
  private splitRun(runItem: Y.Item, k: number, el: Y.XmlElement): void {
    const run = typeOf(runItem) as Y.XmlText;
    const parent = runItem.parent as Y.XmlElement;
    const units: { id: Y.ID; ch: string; attrs: Record<string, unknown> }[] = [];
    for (const s of this.segments(run, true)) for (let o = 0; o < s.item.length; o++) units.push({ id: Y.createID(s.item.id.client, s.item.id.clock + o), ch: s.item.content.str[o], attrs: s.attrs });
    const a = new Y.XmlText(), b = new Y.XmlText();
    const at = childIndex(parent, runItem);
    insertSeparated(parent, at, [a, el, b]);
    const fill = (t: Y.XmlText, part: typeof units) => {
      let pos = 0;
      for (const u of part) t.insert(pos++, u.ch, { ...u.attrs });
      const ids: Y.ID[] = [];
      for (let it = t._start; it; it = it.right) if (it.content instanceof Y.ContentString) for (let o = 0; o < it.length; o++) ids.push(Y.createID(it.id.client, it.id.clock + o));
      part.forEach((u, i) => this.add(u.id.client, u.id.clock, 1, KEPT, ids[i].client, ids[i].clock));
    };
    fill(a, units.slice(0, k));
    fill(b, units.slice(k));
    for (let it = run._start; it; it = it.right) if (!it.deleted && it.content instanceof Y.ContentFormat) this.add(it.id.client, it.id.clock, it.length, HANDLED, -1, 0);
    parent.delete(at + 3, 1);
    this.ours.add(runItem);
    this.protect(runItem.id);
  }

  /* ------------------------------------------------------------------------------ content of originals */

  /** the formatting at a character of a run, counting the marks that were there for its author */
  private attrsAt(x: Y.Item): Record<string, unknown> {
    const run = x.parent as Y.XmlText;
    const attrs: Record<string, unknown> = {};
    for (let it = run._start; it && it !== x; it = it.right) {
      if (it.content instanceof Y.ContentFormat && this.formatCounts(it)) { const { key, value } = it.content; if (value === null) delete attrs[key]; else attrs[key] = value; }
    }
    return attrs;
  }
  private formatCounts(it: Y.Item): boolean {
    return !it.deleted || !!this.index.lookup(it.id.client, it.id.clock) || this.formats.has(it) || this.inOurs(it) || this.ours.has(it);
  }
  /** the text items of a run as they were for their authors (or alive now), with their formatting */
  private segments(run: Y.XmlText, liveOnly = false): { item: Y.Item & { content: Y.ContentString }; attrs: Record<string, unknown> }[] {
    const out: { item: Y.Item & { content: Y.ContentString }; attrs: Record<string, unknown> }[] = [];
    const attrs: Record<string, unknown> = {};
    for (let it = run._start; it; it = it.right) {
      if (it.content instanceof Y.ContentFormat) { if (liveOnly ? !it.deleted : this.formatCounts(it)) { const { key, value } = it.content; if (value === null) delete attrs[key]; else attrs[key] = value; } }
      else if (it.content instanceof Y.ContentString && (liveOnly ? !it.deleted : this.wasLive(it))) out.push({ item: it as Y.Item & { content: Y.ContentString }, attrs: { ...attrs } });
    }
    return out;
  }
  /** an inline node as it was for its author, as a new node */
  private virtualCopy(el: Y.XmlElement, vis: (it: Y.Item) => boolean = this.wasLive): Y.XmlElement {
    const out = new Y.XmlElement(el.nodeName);
    el._map.forEach((it, k) => { if (vis(it)) out.setAttribute(k, valueOf(it) as string); });
    const kids: (Y.XmlElement | Y.XmlText)[] = [];
    for (let c = el._start; c; c = c.right) {
      const t = typeOf(c);
      if (!t || !vis(c)) continue;
      if (t instanceof Y.XmlElement) kids.push(this.virtualCopy(t, vis));
      else if (t instanceof Y.XmlText) {
        const x = new Y.XmlText();
        x.applyDelta(this.segments(t, vis !== this.wasLive).map(s => ({ insert: s.item.content.str, attributes: { ...s.attrs } })));
        kids.push(x);
      }
    }
    if (kids.length) out.insert(0, kids);
    return out;
  }

  /* ------------------------------------------------------------------------------ marks, attributes, deletions, order */

  /** formatting set on originals: the difference it makes, applied to their copies */
  private reformat(): void {
    const runs = new Set<Y.XmlText>();
    for (const f of this.formats) runs.add(f.parent as Y.XmlText);
    for (const run of runs) {
      const withF: Record<string, unknown> = {}, without: Record<string, unknown> = {};
      const changes: { id: Y.ID; delta: Record<string, unknown> }[] = [];
      for (let it = run._start; it; it = it.right) {
        if (it.content instanceof Y.ContentFormat) {
          if (!this.formatCounts(it)) continue;
          const { key, value } = it.content;
          const set = (o: Record<string, unknown>) => { if (value === null) delete o[key]; else o[key] = value; };
          set(withF);
          if (!this.formats.has(it)) set(without);
          continue;
        }
        if (!(it.content instanceof Y.ContentString)) continue;
        const delta: Record<string, unknown> = {};
        for (const k of new Set([...Object.keys(withF), ...Object.keys(without)])) if (JSON.stringify(withF[k] ?? null) !== JSON.stringify(without[k] ?? null)) delta[k] = withF[k] ?? null;
        if (!Object.keys(delta).length) continue;
        for (let o = 0; o < it.length; o++) if (this.mapped(it.id.client, it.id.clock + o)) changes.push({ id: this.resolveId(Y.createID(it.id.client, it.id.clock + o)), delta });
      }
      for (const ch of changes) {
        const u = this.unitAt(ch.id);
        if (!u || u.item.deleted || !(u.item.parent instanceof Y.XmlText) || !isLive(u.item.parent)) continue;
        const target = u.item.parent;
        target.format(this.unitIndexIn(target, u.item) + u.off, 1, ch.delta);
      }
    }
    for (const f of this.formats) this.add(f.id.client, f.id.clock, f.length, HANDLED, -1, 0);
  }

  /** attribute values set on moved inline nodes (a formula edited): onto the copy, unless that was changed meanwhile */
  private reattribute(): void {
    for (const it of this.attrs) {
      const el = it.parent as Y.XmlElement;
      const target = this.resolveId(el._item!.id);
      const u = this.unitAt(target);
      const copy = u && typeOf(u.item);
      if (copy instanceof Y.XmlElement && !u!.item.deleted) {
        const key = it.parentSub!;
        const prev = it.left && !(it.left.content instanceof Y.ContentDeleted) ? valueOf(it.left) : undefined;
        const cur = copy.getAttribute(key);
        if (it.left === null || JSON.stringify(cur) === JSON.stringify(prev)) copy.setAttribute(key, valueOf(it) as string);
      }
      this.add(it.id.client, it.id.clock, 1, HANDLED, -1, 0);
    }
  }

  private knowsCopy(knows: Map<number, number>, client: number, clock: number): boolean {
    return this.index.copiesOf(client, clock).some(c => (knows.get(c.client) ?? 0) > c.clock);
  }
  /** the sender knew a copy of another unit of the deleted run (or inline node) the unit is in */
  private knowsMoveAround(knows: Map<number, number>, client: number, clock: number): boolean {
    const u = this.unitAt(Y.createID(client, clock));
    const parent = u && u.item.parent instanceof Y.AbstractType ? u.item.parent._item : null;
    if (!parent || !parent.deleted) return false;
    const t = typeOf(parent);
    if (!t) return false;
    let checked = 0;
    for (let it = t._start; it && checked < 8; it = it.right) {
      if (it === u!.item || !(it.content instanceof Y.ContentString || typeOf(it))) continue;
      const m = this.index.lookup(it.id.client, it.id.clock);
      if (!m || m.side === PLACED || m.side === HANDLED) continue;
      checked++;
      if (this.knowsCopy(knows, it.id.client, it.id.clock)) return true;
    }
    return false;
  }

  /** originals the sender deleted without having seen their move: their copies go too */
  private propagateDeletions(): void {
    const inc = this.inc;
    const ids: Y.ID[] = [];
    const had = inc ? carried(inc) : null;
    if (inc) dsOf(inc).forEach((client, clock, len) => {
      for (const [k, n, m] of this.index.overlapping(client, clock, len)) {
        if (!m.dst || m.side === HANDLED || m.rec === this.rec) continue;
        for (let i = 0; i < n; i++) {
          if (this.adoptedSrc.has(client, k + i)) continue;
          // the sender had the copy (its update carries it): the deletion is the move's own, sent again
          if (this.knowsCopy(had!, client, k + i)) continue;
          // a sync step 2 carries every deletion the sender knows of: one that knew a copy of the unit
          // (the move's own, or its own copy when it moved the unit too) learnt of the deletion with it;
          // one that knew the move of the run around it got the unit only inside the deleted run
          if (inc.step2 && (!inc.knows || this.knowsCopy(inc.knows, client, k + i) || this.knowsMoveAround(inc.knows, client, k + i))) continue;
          ids.push(this.resolveId(Y.createID(client, k + i)));
        }
      }
    });
    for (const id of [...ids, ...this.late.map(id => this.resolveId(id))]) {
      const u = this.unitAt(id);
      if (!u || u.item.deleted) continue;
      const p = u.item.parent;
      if (p instanceof Y.XmlText) { if (isLive(p)) p.delete(this.unitIndexIn(p, u.item) + u.off, 1); }
      else if (p instanceof Y.XmlElement && typeOf(u.item) instanceof Y.XmlElement && isLive(p)) p.delete(childIndex(p, u.item), 1);
    }
  }

  /**
   * Paragraphs inserted at one place by people who did not see each other's (two splits, a split and
   * a new paragraph) are ordered by Yjs by client number: each one this update made or a record
   * moved text into goes, among the paragraphs its author did not see, where the text it holds came
   * from (a paragraph out of place is moved: copied and deleted). A paragraph that lost all it had to
   * a competing copy goes.
   */
  private reorderBlocks(): void {
    for (const c of this.emptied) {
      if (!isLive(c) || hasContent(c)) continue;
      const p = c._item!.parent as Y.XmlFragment;
      p.delete(childIndex(p, c._item!), 1);
      // kept: what is still on its way into its old runs (from somebody who has not seen this) is placed then
      this.protect(c._item!.id);
    }
    // the paragraphs this update made (an editor's new halves), and those holding the copies that won a
    // competition, find their place among the others
    const moved = new Set<Y.Item>(this.newBlocks.filter(it => !it.deleted));
    for (const k of this.winners) {
      const [c, cl] = k.split(':').map(Number);
      const u = this.unitAt(this.resolveId(Y.createID(c, cl)));
      const cont = u && containerOf(u.item, this.repair.containerNames);
      if (cont && cont._item && isLive(cont)) moved.add(cont._item);
    }
    // until nothing moves (a paragraph moved changes what the others are between)
    let todo = [...moved];
    for (let round = 0; round < 4 && todo.length; round++) {
      const next: Y.Item[] = [];
      for (const it of todo) {
        if (it.deleted) continue;
        const copy = this.slot(it);
        if (copy) next.push(...todo.filter(o => o !== it && !o.deleted), copy._item!);
      }
      todo = [...new Set(next)];
    }
  }

  /** a paragraph the update made has others between its neighbours that its author did not see */
  concurrentBlocks(): boolean {
    return this.newBlocks.some(x => {
      if (x.deleted) return false;
      const right = x.rightOrigin ? this.unitAt(x.rightOrigin)?.item ?? null : null;
      const left = x.origin ? this.unitAt(x.origin)?.item ?? null : null;
      // a neighbour the server moved since: it may have to follow
      if ((left?.deleted && this.mapped(left.id.client, left.id.clock)) || (right?.deleted && this.mapped(right.id.client, right.id.clock))) return true;
      for (let it = left ? left.right : (x.parent as Y.XmlFragment)._start; it && it !== right; it = it.right) if (it !== x && !it.deleted && typeOf(it) instanceof Y.XmlElement) return true;
      return false;
    });
  }

  /** a paragraph among the paragraphs between its neighbours as its author saw them, where its text came from */
  private slot(x: Y.Item): Y.XmlElement | null {
    const parent = x.parent as Y.XmlFragment;
    // its neighbours as its author saw them (where the server moved them since)
    const where = (id: Y.ID | null) => (id ? this.unitAt(this.resolveId(id))?.item ?? null : null);
    const left = where(x.origin), right = where(x.rightOrigin);
    if ((left && left.parent !== parent) || (right && right.parent !== parent)) return null;
    if (left && right && !isAfter(right, left)) return null;
    const between: Y.Item[] = [];
    for (let it = left ? left.right : parent._start; it && it !== right; it = it.right) if (it !== x && !it.deleted && typeOf(it) instanceof Y.XmlElement) between.push(it);
    const kx = this.blockKey(typeOf(x) as Y.XmlElement);
    if (!kx) return null;
    // right before the first one whose text comes from further on (else before its right neighbour);
    // nothing moves past a paragraph whose origin is unknown
    let before: Y.Item | null = right;
    const keys = between.map(it => this.blockKey(typeOf(it) as Y.XmlElement));
    if (keys.some(k => !k)) return null;
    for (let i = 0; i < between.length; i++) if (cmpKey(keys[i]!, kx) > 0) { before = between[i]; break; }
    // a deleted right neighbour stands for the next live paragraph after it
    while (before && (before.deleted || !(typeOf(before) instanceof Y.XmlElement))) before = before.right;
    const inside = (!left || isAfter(x, left)) && (!right || isAfter(right, x) || right.deleted);
    let next: Y.Item | null = x.right;
    while (next && (next.deleted || !(typeOf(next) instanceof Y.XmlElement))) next = next.right;
    if (inside && next === before) return null;
    const at = before ? childIndex(parent, before) : parent.length;
    return this.moveContainer(typeOf(x) as Y.XmlElement, parent, at);
  }

  /**
   * Two live text runs side by side in a paragraph this repair touched (an inline node between them
   * moved away) are re-created as one: y-prosemirror holds one run per stretch of text, and the next
   * editor to type there would otherwise merge them with an unrecorded copy.
   */
  private normalize(): void {
    const conts = new Set<Y.XmlElement>();
    const e = this.rec.entries;
    for (let i = 0; i < e.length; i += 6) {
      for (const id of [Y.createID(e[i], e[i + 1]), e[i + 4] >= 0 ? Y.createID(e[i + 4], e[i + 5]) : null]) {
        const u = id && this.unitAt(id);
        const c = u && containerOf(u.item, this.repair.containerNames);
        if (c && isLive(c)) conts.add(c);
      }
    }
    for (const c of conts) {
      for (;;) {
        const runs: Y.Item[] = [];
        let pair: Y.Item[] | null = null;
        for (let ch = c._start; ch && !pair; ch = ch.right) {
          if (ch.deleted) continue;
          if (typeOf(ch) instanceof Y.XmlText) { runs.push(ch); if (runs.length === 2) pair = runs; }
          else runs.length = 0;
        }
        if (!pair) break;
        this.mergeRuns(c, pair[0], pair[1]);
      }
    }
  }

  /** two adjacent live runs of a paragraph re-created as one */
  private mergeRuns(c: Y.XmlElement, a: Y.Item, b: Y.Item): void {
    const units: { id: Y.ID; text: string; attrs: Record<string, unknown> }[] = [];
    for (const runItem of [a, b]) {
      const run = typeOf(runItem) as Y.XmlText;
      for (const s of this.segments(run, true)) for (let o = 0; o < s.item.length; o++) units.push({ id: Y.createID(s.item.id.client, s.item.id.clock + o), text: s.item.content.str[o], attrs: s.attrs });
      for (let it = run._start; it; it = it.right) if (!it.deleted && it.content instanceof Y.ContentFormat) this.add(it.id.client, it.id.clock, it.length, HANDLED, -1, 0);
    }
    const at = childIndex(c, a);
    const copy = new Y.XmlText();
    insertSeparated(c, at, [copy]);
    let pos = 0;
    for (const u of units) copy.insert(pos++, u.text, { ...u.attrs });
    const ids: Y.ID[] = [];
    for (let it = copy._start; it; it = it.right) if (it.content instanceof Y.ContentString) for (let o = 0; o < it.length; o++) ids.push(Y.createID(it.id.client, it.id.clock + o));
    units.forEach((u, i) => this.add(u.id.client, u.id.clock, 1, KEPT, ids[i].client, ids[i].clock));
    for (const runItem of [a, b]) { c.delete(childIndex(c, runItem), 1); this.ours.add(runItem); this.protect(runItem.id); }
  }

  /** where a paragraph's text came from: the place of the paragraph that first held its first unit, and of the unit in it */
  private blockKey(c: Y.XmlElement): [number, number] | null {
    // the first unit that is a copy of an original the server has (text typed into a copy since stands
    // where that copy stands; an editor's own new text it copied at once never reached the server whole),
    // else the first one
    let first: Unit | null = null, orig: Unit | null = null;
    for (let ch = c._start; ch && !orig; ch = ch.right) {
      if (ch.deleted) continue;
      const t = typeOf(ch);
      const units: Unit[] = [];
      if (t instanceof Y.XmlText) { for (let it = t._start; it && units.length < 256; it = it.right) if (!it.deleted && it.content instanceof Y.ContentString) for (let o = 0; o < it.length; o++) units.push({ item: it, off: o }); }
      else if (t instanceof Y.XmlElement) units.push({ item: ch, off: 0 });
      for (const u of units) {
        first ??= u;
        if (!this.index.sourceOf(u.item.id.client, u.item.id.clock + u.off)) continue;
        const o = this.originalOf(u, 0);
        if (o && containerOf(o.item, this.repair.containerNames)) { orig = o; break; }
      }
    }
    orig ??= first && this.originalOf(first, 0);
    if (!orig) return null;
    const oc = orig && containerOf(orig.item, this.repair.containerNames);
    if (!oc || !oc._item || oc._item.parent !== c._item!.parent) return null;
    let pos = 0;
    for (let it = (oc._item.parent as Y.XmlFragment)._start; it && it !== oc._item; it = it.right) pos++;
    // its place among the units of that paragraph that are not copies
    const isCopy = (it: Y.Item) => !!this.index.sourceOf(it.id.client, it.id.clock);
    let n = 0, at = -1;
    for (let x = oc._start; x && at < 0; x = x.right) {
      const tx = typeOf(x);
      if (x === orig!.item) { at = n; break; }
      if (tx instanceof Y.XmlText) { for (let it = tx._start; it; it = it.right) { if (it === orig!.item) { at = n + orig!.off; break; } if (!isCopy(it) && it.content instanceof Y.ContentString) n += it.length; } }
      else if (tx instanceof Y.XmlElement && !isCopy(x)) n++;
    }
    return [pos, at];
  }

  /**
   * The original a unit is a copy of; for text typed into a copy (a re-created run, a new half), the
   * original of the copy next to it
   */
  private originalOf(u: Unit, depth: number): Unit | null {
    let id = Y.createID(u.item.id.client, u.item.id.clock + u.off);
    for (let i = 0; i < 64; i++) { const s = this.index.sourceOf(id.client, id.clock); if (!s) break; id = s.src; }
    const o = this.unitAt(id);
    if (!o || depth > 4 || !(o.item.parent instanceof Y.XmlText)) return o;
    const isCopy = (it: Y.Item) => it.content instanceof Y.ContentString && !!this.index.sourceOf(it.id.client, it.id.clock);
    for (let it = o.item.right; it; it = it.right) if (isCopy(it)) return this.originalOf({ item: it, off: 0 }, depth + 1);
    for (let it = o.item.left; it; it = it.left) if (isCopy(it)) return this.originalOf({ item: it, off: it.length - 1 }, depth + 1);
    return o;
  }

  /** a paragraph copied to `at` in `parent` (its live content), the original deleted and kept */
  private moveContainer(c: Y.XmlElement, parent: Y.XmlFragment, at: number): Y.XmlElement {
    const live = (it: Y.Item) => !it.deleted;
    const copy = this.virtualCopy(c, live);
    parent.insert(at, [copy]);
    const out = new EntryList();
    pairCopies(c, copy, live, MOVED, out);
    for (let i = 0; i < out.entries.length; i += 6) this.add(...(out.entries.slice(i, i + 6) as [number, number, number, number, number, number]));
    const item = c._item!;
    // the paragraph itself too: what was inserted next to it follows it
    this.add(item.id.client, item.id.clock, 1, MOVED, copy._item!.id.client, copy._item!.id.clock);
    parent.delete(childIndex(parent, item), 1);
    this.ours.add(item);
    this.protect(item.id);
    return copy;
  }
}

/** the side and copy an editor's record gives a source unit */
function entryFor(r: MoveRecord, client: number, clock: number): [number, Y.ID | null] | null {
  const e = r.entries;
  for (let i = 0; i < e.length; i += 6) {
    if (e[i] === client && clock >= e[i + 1] && clock < e[i + 1] + e[i + 2]) return [e[i + 3], e[i + 4] >= 0 ? Y.createID(e[i + 4], e[i + 5] + (clock - e[i + 1])) : null];
  }
  return null;
}
const sameId = (a: Y.ID, b: Y.ID) => a.client === b.client && a.clock === b.clock;
const idOr = (id: Y.ID | null) => (id ? idKey(id) : '-');
const cmpKey = (a: [number, number], b: [number, number]) => a[0] - b[0] || a[1] - b[1];
/** `a` comes after `b` in their list */
function isAfter(a: Y.Item, b: Y.Item): boolean { for (let it = b.right; it; it = it.right) if (it === a) return true; return false; }
/** a paragraph with text or an inline node in it */
function hasContent(c: Y.XmlElement): boolean {
  for (let ch = c._start; ch; ch = ch.right) {
    if (ch.deleted) continue;
    const t = typeOf(ch);
    if (t instanceof Y.XmlElement || (t instanceof Y.XmlText && t._length > 0)) return true;
  }
  return false;
}
