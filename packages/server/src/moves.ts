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
 *
 * Live text is moved (the second point, the paragraphs reordered after it, a stale join's cut
 * restored) only for an update that is concurrent with something: its sender had not been sent all
 * that the server had in the paragraphs it touched (`concurrent`). Those parts of the repair go by
 * Yjs origins and text provenance, and with nothing concurrent to repair they moved established text
 * — 18–19 Oct 2026, cosyne_27/main.tex, one person editing alone: inserting a comment moved a
 * sentence into the paragraph above, an Enter moved two formulas into a heading. The rest acts only
 * on what landed in, or was done to, deleted originals, which nobody does knowingly.
 */
import * as Y from 'yjs';
import {
  MOVES_MAP, MOVES_ORIGIN, KEPT, MOVED, HANDLED, PLACED, CONTAINERS, Ranges, EntryList, protectMoves, encodeRecord, decodeRecord,
  typeOf, isContainer, isLive, containerOf, valueOf, childIndex, pairCopies, forEachStruct, idKey, insertSeparated, sawBefore,
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
  /**
   * What the server had sent the sender, at most (per client the highest clock that went out on its
   * connection; the server's own diff: what its mirror held). With `knows` and what the update
   * carries, an upper bound of what the sender can have had when it made the update — a client
   * learns of others' edits only from the server. Undefined: not tracked (every update counts as
   * concurrent, as before).
   */
  sent?: Map<number, number> | null;
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
// Server-only evidence retained with move history: cut entries are
// [timestamp, left ID, right ID, retained marker ID, authored paragraph ID];
// native operation entries are [timestamp, joined, ...protected paragraph IDs].
// Capture native anchors before adoption combines sparse author state vectors.
const NATIVE_CUTS_MAP = 'move-cuts';
interface NativeBoundary { left: Y.ID; right: Y.ID; marker: Y.ID; created: Y.ID }

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
  receive(update: Uint8Array, origin: unknown, info: { step2: boolean; knows?: Map<number, number> | null; server?: boolean; sent?: Map<number, number> | null }): void {
    this.incoming = { origin, update, step2: info.step2, knows: info.knows ?? null, server: !!info.server, sent: 'sent' in info ? info.sent : info.server ? info.knows ?? undefined : undefined };
    try { Y.applyUpdate(this.ydoc, update, origin); } finally { this.incoming = null; }
  }

  /** drop records older than the retention period (their originals are collected when the document is next loaded) */
  prune(): void {
    const map = this.ydoc.getMap<unknown>(MOVES_MAP);
    const limit = this.now() - (this.opts.ttlDays ?? 30) * DAY;
    const cuts = this.ydoc.getMap<unknown>(NATIVE_CUTS_MAP);
    const oldCuts = [...cuts.keys()].filter(key => { const value = cuts.get(key); return !Array.isArray(value) || typeof value[0] !== 'number' || value[0] < limit; });
    const old = [...map.keys()].filter(k => { const r = decodeRecord(k, map.get(k)); return !r || r.t < limit; });
    this.lastPrune = this.now();
    if (old.length || oldCuts.length) this.ydoc.transact(() => { for (const k of old) map.delete(k); for (const k of oldCuts) cuts.delete(k); }, MOVES_ORIGIN);
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
  /** copied runs whose author still counted a format the server had already removed */
  private formatBaselines = new Set<Y.XmlText>();
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
  private nativeCopiedIds = new Map<MoveRecord, Map<string, Y.ID>>();
  /** earlier concurrent blocks revealed beyond an authored empty successor */
  private blockCandidates = new Set<Y.Item>();
  /** what this update brought into something that had moved (deleted on arrival, not by anybody) */
  private doa = new Ranges();
  /** the copies that won a competition (final ids) */
  private winners = new Set<string>();
  /** paragraph sizes before the conflicts are resolved */
  private sizes = new Map<Y.XmlElement, number>();
  /** winning kept units restored to their authored paragraph after a stale join */
  private recovered = new Ranges();
  private joining = false;

  constructor(private repair: MoveRepair, private tr: Y.Transaction, private inc: Incoming | null) {
    this.index = repair.index;
    this.doc = repair.ydoc;
    this.store = this.doc.store;
    this.deletedInT = Ranges.of(tr.deleteSet);
  }

  private isNew(id: Y.ID): boolean { return id.clock >= (this.tr.beforeState.get(id.client) ?? 0); }

  private concurrentCache: boolean | null = null;
  /**
   * The update was made without something the server already had in the paragraphs it touched (that
   * it put text into or took text from, or that its records copied from or to), or among the
   * paragraphs beside a paragraph it made: only then can anything in it be a late edit, or anything
   * there be late for it. Unknown what the sender had: concurrent.
   */
  get concurrent(): boolean {
    if (this.concurrentCache !== null) return this.concurrentCache;
    return this.concurrentCache = this.findConcurrent();
  }
  private findConcurrent(): boolean {
    const inc = this.inc;
    if (!inc) return !this.tr.local;
    if (inc.sent == null) return true;
    const had = carried(inc), sent = inc.sent, knows = inc.knows;
    const lacked = (id: Y.ID) => !this.isNew(id) && !((sent.get(id.client) ?? 0) > id.clock || (knows?.get(id.client) ?? 0) > id.clock || (had.get(id.client) ?? 0) > id.clock);
    const conts = new Set<Y.XmlElement>(), parents = new Set<Y.XmlFragment | Y.XmlElement>();
    const note = (it: Y.Item) => {
      const c = containerOf(it, this.repair.containerNames);
      if (c) conts.add(c);
      const t = typeOf(it);
      if (t instanceof Y.XmlElement && this.repair.containerNames.has(t.nodeName) && it.parent instanceof Y.AbstractType) parents.add(it.parent as Y.XmlElement);
    };
    for (const [client, after] of this.tr.afterState) {
      const from = this.tr.beforeState.get(client) ?? 0;
      if (after > from) forEachStruct(this.doc, client, from, after, note);
    }
    this.deletedInT.forEach((client, clock, len) => forEachStruct(this.doc, client, clock, clock + len, note));
    const map = this.doc.getMap<unknown>(MOVES_MAP);
    for (const k of this.tr.changed.get(map as unknown as Y.AbstractType<any>) ?? []) {
      const r = typeof k === 'string' ? this.index.records.get(k) : undefined;
      if (!r) continue;
      for (let i = 0; i < r.entries.length; i += 6) {
        forEachStruct(this.doc, r.entries[i], r.entries[i + 1], r.entries[i + 1] + r.entries[i + 2], note);
        if (r.entries[i + 4] >= 0) forEachStruct(this.doc, r.entries[i + 4], r.entries[i + 5], r.entries[i + 5] + r.entries[i + 2], note);
      }
      for (const id of r.protect) forEachStruct(this.doc, id.client, id.clock, id.clock + 1, note);
    }
    for (const c of conts) {
      if (c._item && lacked(c._item.id)) return true;
      for (let ch = c._start; ch; ch = ch.right) {
        if (lacked(ch.id)) return true;
        const t = typeOf(ch);
        if (t instanceof Y.XmlText) for (let it = t._start; it; it = it.right) if (lacked(it.id)) return true;
      }
    }
    for (const p of parents) for (let ch = p._start; ch; ch = ch.right) if (lacked(ch.id)) return true;
    return false;
  }
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
    for (const k of keys) {
      const record = this.index.records.get(k);
      if (!record) continue;
      this.own.add(record);
      for (let i = 0; i < record.entries.length; i += 6) {
        const [client, clock, , side, destination] = record.entries.slice(i, i + 6);
        if (side !== HANDLED || destination >= 0) continue;
        const id = Y.createID(client, clock), unit = this.unitAt(id);
        const run = unit?.item.parent;
        // Client HANDLED entries identify the formatting it copied. A format
        // already collected before this update represents an unseen removal,
        // whose key/value Yjs no longer retains. Its still-retained source run
        // gives the current formatting of the text copied by this record.
        if (unit?.item.content instanceof Y.ContentDeleted && run instanceof Y.XmlText
          && !this.isNew(id) && !this.deletedInT.hasId(id)
          && run._item && record.protect.some(protectedId => sameId(protectedId, run._item!.id))) this.formatBaselines.add(run);
      }
    }
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
      if (it.content instanceof Y.ContentFormat) {
        // A stale move also deletes formatting another author already sent to
        // its original run. Reapply that unseen change to the winning copy,
        // just as for a format directive first received in a deleted run.
        const unseen = !fresh && [...this.own].some(record => record.sv
          && !madeBy(record, it.id.client) && !sawBefore(record, it.id));
        if ((fresh ? !this.index.lookup(it.id.client, it.id.clock) : unseen)
          && !this.explicit(it.id.client, it.id.clock)) this.formats.add(it);
        return;
      }
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
    } else if (fresh && !(it.content instanceof Y.ContentFormat) && this.concurrent && this.liveMisplaced({ item: it, off: a - it.id.clock, len: b - a })) {
      // a character of a live run: the run is re-created around it (no moved unit stays in a live run)
      if (it.parent instanceof Y.XmlText && it.parent._item) { this.dissolve.add(it.parent._item); this.misplaced.add(it); }
      else this.addPending({ item: it, off: 0, len: it.length });
    }
  }

  /** live children of the paragraphs a record took units from that were inserted next to them before it arrived */
  private sourceNeighbours(): void {
    if (!this.concurrent) return;
    const conts = new Set<Y.XmlElement>();
    this.adoptedSrc.forEach((client, clock, len) => forEachStruct(this.doc, client, clock, clock + len, it => { const c = containerOf(it, this.repair.containerNames); if (c && isLive(c)) conts.add(c); }));
    for (const c of conts) for (let ch = c._start; ch; ch = ch.right) if (!ch.deleted && !this.isNew(ch.id) && this.liveMisplaced({ item: ch, off: 0, len: 1 })) this.addPending({ item: ch, off: 0, len: 1 });
  }

  /** a live stretch of a live paragraph whose neighbour was moved, or with a copy it did not know between it and its neighbour */
  private liveMisplaced(p: Piece): boolean {
    const it = p.item;
    const first = typeOf(it) instanceof Y.XmlText ? this.edgeUnit(it, false) ?? { item: it, off: p.off } : { item: it, off: p.off };
    const splitSide = this.authoredSplitCopy(first);
    const splitRight = this.splitRightOf(first);
    if (splitRight) {
      const right = this.final(splitRight), here = containerOf(it, this.repair.containerNames);
      const there = containerOf(right.item, this.repair.containerNames);
      if (there && isLive(there) && !right.item.deleted && (here !== there || (here && this.unitIndex(here, right) < this.unitIndex(here, first)))) return true;
    }
    const repairedElsewhere = (anchor: Unit, preceding = true) => {
      if ((preceding ? this.sourceOrder(anchor, first) : this.sourceOrder(first, anchor)) !== -1) return false;
      const final = this.final(anchor);
      const here = containerOf(it, this.repair.containerNames), there = containerOf(final.item, this.repair.containerNames);
      const inlineCopy = typeOf(it) instanceof Y.XmlElement && !isContainer(typeOf(it), this.repair.containerNames) && this.ownCopy(it);
      // Resolving competing splits and joins can move an old neighbour again.
      // A surviving formula/run follows that final neighbour even when the
      // original move's author had already seen it.
      let id = Y.createID(anchor.item.id.client, anchor.item.id.clock + anchor.off), repaired = false;
      for (let depth = 0; depth < 64; depth++) {
        const mapping = this.mapped(id.client, id.clock);
        if (!mapping?.dst) break;
        repaired ||= (mapping.side === PLACED || (inlineCopy && !splitSide && mapping.side === MOVED)) && mapping.rec === this.rec;
        id = mapping.dst;
      }
      return repaired && !this.same(anchor, final) && !!here && !!there && here !== there && isLive(there);
    };
    for (let previous = this.prev({ item: it, off: p.off }, true); previous; previous = this.prev(previous, true)) {
      if (!this.authoredSplitCopy(first, false, true) && repairedElsewhere(previous)) return true;
      if (!previous.item.deleted) break;
    }
    const sourceLeft = this.sourceLeftOf(p);
    if (sourceLeft && !splitSide && repairedElsewhere(sourceLeft)) return true;
    const sourceRight = this.sourceRightOf(p);
    if (sourceRight && !splitSide && repairedElsewhere(sourceRight, false)) return true;
    if (this.ownCopy(it)) return false;
    const o = this.originOf(p);
    const laterOrigin = !!o && this.sourceOrder(o, first) === 1;
    if (o && repairedElsewhere(o)) return true;
    if (o && this.isSource(o, it) && this.sourceOrder(o, first) !== 1) return true;
    const r = laterOrigin ? sourceRight : o ? null : this.rightOf(p, false);
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
    // made by the record's own author: no late edit, whether made after the record (its author knew it)
    // or before (its author had it when it moved the text). Undoing a split puts the originals back
    // (Yjs restores them as new items beside the deleted ones), and the opening quote of "…" typed
    // into a run is the author's item next to copies its next keystroke records: taken for late
    // edits, the restored text went after the copies the undo had just deleted, and the quote to the
    // end of the paragraph
    if (madeBy(rec, by.id.client)) return true;
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
    return !!m && !this.known(m.rec, by) && !sawBefore(m.rec, by.id);
  }
  /** a copy (or a run of copies) the sender's own record made */
  private ownCopy(it: Y.Item): boolean {
    let item = it, off = 0;
    if (typeOf(it) instanceof Y.XmlText) { const first = this.edgeUnit(it, false); if (!first) return false; item = first.item; off = first.off; }
    const s = this.index.sourceOf(item.id.client, item.id.clock + off);
    return !!s && this.own.has(s.rec);
  }

  /** A copied side of an authored split, including its recovered paragraph. */
  private authoredSplitCopy(initial: Unit, onlyKept = false, onlyHead = false): boolean {
    const operation = (record: MoveRecord, client: number, clock: number) => {
      const prefix = `c${client}-`;
      const ends = (record.server ? record.adopt : [record.key]).filter(key => key.startsWith(prefix))
        .map(key => Number(key.slice(prefix.length))).filter(end => Number.isFinite(end) && end > clock);
      return ends.length ? Math.min(...ends) : Infinity;
    };
    const startsSide = (record: MoveRecord, paragraph: Y.XmlElement, id: Y.ID) => {
      if (!record.sv) return false;
      const end = operation(record, id.client, id.clock), entries = record.entries;
      const firstIn = (item: Y.Item): Y.ID | null => {
        let first = Infinity;
        for (let i = 0; i < entries.length; i += 6) {
          if ((entries[i + 3] !== MOVED && entries[i + 3] !== KEPT) || entries[i + 4] !== id.client || item.id.client !== id.client) continue;
          const clock = Math.max(entries[i + 5], item.id.clock);
          if (clock < Math.min(entries[i + 5] + entries[i + 2], item.id.clock + item.length)
            && operation(record, id.client, clock) === end) first = Math.min(first, clock);
        }
        return Number.isFinite(first) ? Y.createID(id.client, first) : null;
      };
      for (let child = paragraph._start; child; child = child.right) {
        const type = typeOf(child);
        if (type instanceof Y.XmlText) {
          for (let text = type._start; text; text = text.right) {
            const first = firstIn(text);
            if (first) {
              if (!text.deleted && text.countable && first.clock > text.id.clock) return false;
              return sameId(first, id);
            }
            // Unchanged live text before the copied range makes it an
            // interior tail, even if it is this record's first destination.
            if (!text.deleted && text.countable) return false;
          }
        } else {
          const first = firstIn(child);
          if (first) return sameId(first, id);
          if (!child.deleted && child.countable) return false;
        }
      }
      return false;
    };
    const splitSide = (record: MoveRecord, paragraph: Y.XmlElement, id: Y.ID, side: number) => {
      if (!record.sv || !paragraph._item) return false;
      const authored = (client: number) => !record.server || record.adopt.some(key => key.startsWith(`c${client}-`));
      const copy = this.unitAt(id), inline = copy && typeOf(copy.item) instanceof Y.XmlElement;
      if (paragraph._item.id.client === id.client && !sawBefore(record, paragraph._item.id) && authored(id.client)) {
        return (!inline && !onlyHead) || startsSide(record, paragraph, id);
      }
      if (side !== KEPT || !startsSide(record, paragraph, id)) return false;
      // Yjs can keep the suffix in the original paragraph and copy the prefix
      // into a new one. Its first kept destination is the other authored side
      // of exactly the same split, even though its paragraph ID is older.
      for (let i = 0; i < record.entries.length; i += 6) {
        const entries = record.entries;
        if (entries[i + 3] !== MOVED || entries[i + 4] < 0) continue;
        const destination = this.unitAt(Y.createID(entries[i + 4], entries[i + 5]));
        const sibling = destination && containerOf(destination.item, this.repair.containerNames)?._item;
        if (sibling && sibling !== paragraph._item && !sawBefore(record, sibling.id) && authored(sibling.id.client)
          && ((sibling.rightOrigin && sameId(sibling.rightOrigin, paragraph._item.id))
            || (sibling.origin && sameId(sibling.origin, paragraph._item.id)))) return true;
      }
      return false;
    };
    let id = Y.createID(initial.item.id.client, initial.item.id.clock + initial.off);
    for (let depth = 0; depth < 64; depth++) {
      const copy = this.unitAt(id), paragraph = copy && containerOf(copy.item, this.repair.containerNames);
      if (paragraph?._item) {
        for (const record of this.own) {
          if (!record.sv) continue;
          for (let i = 0; i < record.entries.length; i += 6) {
            const entry = record.entries;
            if ((entry[i + 3] === MOVED || entry[i + 3] === KEPT) && entry[i + 4] === id.client
              && entry[i + 5] <= id.clock && id.clock < entry[i + 5] + entry[i + 2]) {
              if ((!onlyKept || entry[i + 3] === KEPT) && splitSide(record, paragraph, id, entry[i + 3])) return true;
              if (entry[i + 3] === MOVED && record.joined === true && sawBefore(record, paragraph._item.id)) return false;
            }
          }
        }
      }
      const source = this.index.sourceOf(id.client, id.clock);
      if (!source) return false;
      if (source.side === MOVED) {
        const original = this.unitAt(source.src), originalParagraph = original && containerOf(original.item, this.repair.containerNames);
        const paragraphCopy = originalParagraph?._item && entryFor(source.rec, originalParagraph._item.id.client, originalParagraph._item.id.clock);
        const kept = this.index.sourceOf(source.src.client, source.src.clock);
        // A partial canonical split creates a server paragraph after the live
        // source paragraph. Whole-paragraph relocation maps that container;
        // this partial side instead retains its own authored boundary.
        if (source.rec.server && source.rec.sv && paragraph?._item && originalParagraph?._item
          && !source.rec.adopt.some(key => key.startsWith(`c${paragraph._item!.id.client}-`))
          && paragraph._item.id.client === id.client && !sawBefore(source.rec, paragraph._item.id)
          && source.rec.protect.some(protectedId => sameId(protectedId, paragraph._item!.id))
          && !(paragraphCopy?.[0] === MOVED && paragraphCopy[1] && sameId(paragraphCopy[1], paragraph._item.id))
          && !onlyHead) return true;
        // Restoring a kept side also maps its old paragraph to the server's
        // replacement. That durable relation preserves the same authored
        // boundary after another update or a server restart.
        if (source.rec.server && kept?.side === KEPT && paragraph?._item
          && paragraphCopy?.[0] === MOVED && paragraphCopy[1] && sameId(paragraphCopy[1], paragraph._item.id)
          && !onlyHead) return true;
        if (!onlyKept && paragraph && splitSide(source.rec, paragraph, id, MOVED)) return true;
        if (source.rec.joined === true && paragraph?._item && sawBefore(source.rec, paragraph._item.id)) return false;
      }
      if (source.side === KEPT && paragraph && splitSide(source.rec, paragraph, id, KEPT)) return true;
      id = source.src;
    }
    return false;
  }
  /** A split can keep inserted text with its right word while moving its left word before the new break. */
  private splitRightOf(initial: Unit): Unit | null {
    const id = this.sourceIdentity(Y.createID(initial.item.id.client, initial.item.id.clock + initial.off));
    const original = this.unitAt(id);
    if (!original || !(original.item.content instanceof Y.ContentString
      || (original.item.content instanceof Y.ContentDeleted && original.item.parent instanceof Y.XmlText)) || !original.item.rightOrigin) return null;
    const left = this.originOf({ ...original, len: 1 });
    const right = this.rightOf({ ...original, len: original.item.length - original.off }, false);
    if (!left || !right) return null;
    const copied = (record: MoveRecord, unit: Y.ID): Y.ID | null => {
      const direct = entryFor(record, unit.client, unit.clock)?.[1];
      if (direct) return direct;
      let identities = this.nativeCopiedIds.get(record);
      if (!identities) {
        identities = new Map();
        for (let i = 0; i < record.entries.length; i += 6) {
          const e = record.entries;
          if ((e[i + 3] !== MOVED && e[i + 3] !== KEPT) || e[i + 4] < 0) continue;
          for (let off = 0; off < e[i + 2]; off++) identities.set(idKey(this.sourceIdentity(Y.createID(e[i], e[i + 1] + off))), Y.createID(e[i + 4], e[i + 5] + off));
        }
        this.nativeCopiedIds.set(record, identities);
      }
      return identities.get(idKey(this.sourceIdentity(unit))) ?? null;
    };
    for (const record of this.own) {
      if (record.server || record.joined !== false || !record.sv) continue;
      const copy = copied(record, id);
      if (!copy) continue;
      const leftCopy = copied(record, Y.createID(left.item.id.client, left.item.id.clock + left.off));
      const rightCopy = copied(record, Y.createID(right.item.id.client, right.item.id.clock + right.off));
      if (!leftCopy || !rightCopy) continue;
      const unit = this.unitAt(copy), before = this.unitAt(leftCopy), after = this.unitAt(rightCopy);
      const here = unit && containerOf(unit.item, this.repair.containerNames);
      const beforeParagraph = before && containerOf(before.item, this.repair.containerNames);
      const afterParagraph = after && containerOf(after.item, this.repair.containerNames);
      if (here && beforeParagraph && beforeParagraph !== here && afterParagraph === here) return right;
    }
    return null;
  }

  /** a copy a record made (not a late edit the server placed: that is just another concurrent insertion) */
  private isCopy(u: Unit, by: Y.Item): boolean {
    let item = u.item, off = u.off;
    if (typeOf(item) instanceof Y.XmlText) { const first = this.edgeUnit(item, false); if (!first) return false; item = first.item; off = first.off; }
    const s = this.index.sourceOf(item.id.client, item.id.clock + off);
    return !!s && s.side !== PLACED && !this.known(s.rec, by) && !sawBefore(s.rec, by.id);
  }

  /* ------------------------------------------------------------------------------ the repair */

  run(_t2: Y.Transaction, keys: string[], conflicts: MoveIndex['conflicts']): void {
    const boundaries = keys.length || conflicts.length ? this.nativeBoundaries() : [];
    const nonemptyCutSides = new Set(boundaries.filter(boundary => {
      const unit = this.unitAt(boundary.created), paragraph = unit && typeOf(unit.item);
      return paragraph instanceof Y.XmlElement && isLive(paragraph) && hasContent(paragraph);
    }).map(boundary => idKey(boundary.created)));
    const map = this.doc.getMap<unknown>(MOVES_MAP);
    let seq = 0;
    for (const k of map.keys()) if (k[0] === 's') seq = Math.max(seq, parseInt(k.slice(1), 36) || 0);
    this.rec = { key: 's' + (seq + 1).toString(36).padStart(8, '0'), t: this.repair.stamp, server: true, size: 0, protect: [], adopt: [], entries: [] };
    this.index.add(this.rec);
    const joined = [...this.own, ...conflicts.map(conflict => conflict.old.rec)].some(record => record.joined ?? record.protect.some(id => {
      const unit = this.unitAt(id), type = unit && typeOf(unit.item);
      // A join removes its source paragraph without making a replacement of
      // that paragraph. Block reordering also protects paragraphs, but maps
      // their containers to copies and must retain ordinary split placement.
      return type instanceof Y.XmlElement && this.repair.containerNames.has(type.nodeName) && !entryFor(record, id.client, id.clock)?.[1];
    }));
    this.rec.joined = joined;
    this.joining = !this.madeHere && joined;
    this.recoverSplitSuffixes(conflicts);
    const conflicted = new Ranges();
    for (const c of conflicts) conflicted.add(c.client, c.clock, c.len);
    // the editors' records: restated (their valid entries), so that the server's records are the only lasting ones
    let sv: Map<number, number> | undefined, svKnown = true;
    for (const key of keys) {
      const r = decodeRecord(key, map.get(key));
      map.delete(key);
      this.index.records.delete(key);
      this.rec.adopt.push(key);
      if (!r) continue;
      // what the editors had (one sender: the earliest of its records counts; a record without it: unknown)
      if (!r.sv) svKnown = false;
      else if (!sv) sv = new Map(r.sv);
      else for (const [c, k] of sv) { const o = r.sv.get(c); if (o === undefined) sv.delete(c); else if (o < k) sv.set(c, o); }
      this.rec.sv = svKnown ? sv : undefined;
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
    this.restoreNativeBoundaries(boundaries);
    this.retireReplacedCutSides(boundaries, nonemptyCutSides);
    this.reorderBlocks();
    this.normalize();
    if (this.rec.entries.length || this.rec.adopt.length || this.rec.protect.length) map.set(this.rec.key, encodeRecord(this.rec));
    else this.index.records.delete(this.rec.key);
  }

  private nativeBoundaries(): NativeBoundary[] {
    const cache = this.doc.getMap<unknown>(NATIVE_CUTS_MAP), out = new Map<string, NativeBoundary>();
    for (const [key, value] of cache) {
      if (!Array.isArray(value) || value.length !== 9 || !value.every(number => Number.isSafeInteger(number) && number >= 0)) continue;
      const [, lc, lk, rc, rk, mc, mk, cc, ck] = value;
      if (key !== idKey(Y.createID(cc, ck))) continue;
      out.set(key, { left: Y.createID(lc, lk), right: Y.createID(rc, rk), marker: Y.createID(mc, mk), created: Y.createID(cc, ck) });
    }
    for (const record of this.index.records.values()) {
      if (!record.server && record.joined !== undefined) cache.set(record.key, [record.t, Number(record.joined), ...record.protect.flatMap(id => [id.client, id.clock])]);
      if (!record.sv) continue;
      const groups = new Map<Y.XmlElement, { first: { dst: Y.ID; src: Y.ID } | null; last: { dst: Y.ID; src: Y.ID } | null; sources: Set<string> }>();
      const entries = record.entries;
      for (let i = 0; i < entries.length; i += 6) {
        if (entries[i + 3] !== MOVED || entries[i + 4] < 0) continue;
        for (const offset of [0, entries[i + 2] - 1]) {
          const dst = Y.createID(entries[i + 4], entries[i + 5] + offset), unit = this.unitAt(dst);
          if (!unit || unit.item.parentSub !== null || (!unit.item.countable && !(unit.item.content instanceof Y.ContentDeleted && unit.item.parent instanceof Y.XmlText))) continue;
          const paragraph = containerOf(unit.item, this.repair.containerNames), item = paragraph?._item;
          if (!paragraph || !item || item.id.client !== dst.client || sawBefore(record, item.id)) continue;
          const prefix = `c${item.id.client}-`;
          const ends = (record.server ? record.adopt : [record.key]).filter(key => key.startsWith(prefix))
            .map(key => Number(key.slice(prefix.length))).filter(clock => Number.isFinite(clock) && clock > item.id.clock);
          const end = ends.length ? Math.min(...ends) : Infinity;
          if (!Number.isFinite(end) || dst.clock >= end) continue;
          const nativeSource = Y.createID(entries[i], entries[i + 1] + offset);
          if (!sawBefore(record, nativeSource) && !(nativeSource.client === item.id.client && nativeSource.clock < item.id.clock)) continue;
          let src = nativeSource, source = this.unitAt(src);
          for (let depth = 0; (!source || !containerOf(source.item, this.repair.containerNames)) && depth < 64; depth++) {
            const earlier = this.index.sourceOf(src.client, src.clock);
            if (!earlier) break;
            src = earlier.src; source = this.unitAt(src);
          }
          const original = source && containerOf(source.item, this.repair.containerNames)?._item;
          let group = groups.get(paragraph);
          if (!group) groups.set(paragraph, group = { first: null, last: null, sources: new Set() });
          if (original) group.sources.add(idKey(original.id));
          if (!group.first || dst.clock < group.first.dst.clock) group.first = { dst, src };
          if (!group.last || dst.clock > group.last.dst.clock) group.last = { dst, src };
        }
      }
      for (const [paragraph, group] of groups) {
        const item = paragraph._item!;
        if (out.has(idKey(item.id))) continue;
        if (group.sources.size !== 1) continue;
        const original = [...group.sources][0];
        for (const prefix of [true, false]) {
          const anchor = prefix ? item.rightOrigin : item.origin, endpoint = prefix ? group.last : group.first;
          if (!anchor || idKey(anchor) !== original || !endpoint) continue;
          const source = this.unitAt(endpoint.src);
          if (!source) continue;
          let neighbour = prefix ? this.next(source, true) : this.prev(source, true);
          for (let depth = 0; neighbour && depth < 64; depth++) {
            const id = Y.createID(neighbour.item.id.client, neighbour.item.id.clock + neighbour.off);
            const known = sawBefore(record, id) || this.index.copiesOf(id.client, id.clock).some(copy => sawBefore(record, copy));
            if (known && !(neighbour.item.content instanceof Y.ContentFormat)
              && !(neighbour.item.content instanceof Y.ContentDeleted)) break;
            neighbour = prefix ? this.next(neighbour, true) : this.prev(neighbour, true);
          }
          if (!neighbour) continue;
          const neighbourId = Y.createID(neighbour.item.id.client, neighbour.item.id.clock + neighbour.off);
          const boundary: NativeBoundary = { left: prefix ? endpoint.src : neighbourId, right: prefix ? neighbourId : endpoint.src, marker: prefix ? anchor : item.id, created: item.id };
          out.set(idKey(item.id), boundary);
          cache.set(idKey(item.id), [record.t, boundary.left.client, boundary.left.clock, boundary.right.client, boundary.right.clock, boundary.marker.client, boundary.marker.clock, boundary.created.client, boundary.created.clock]);
          break;
        }
      }
    }
    return [...out.values()];
  }

  private nativeBoundaryJoined(boundary: NativeBoundary): boolean {
    const left = this.unitAt(boundary.left), right = this.unitAt(boundary.right);
    const finalLeft = this.unitAt(this.resolveId(boundary.left)), finalRight = this.unitAt(this.resolveId(boundary.right));
    if (finalLeft && finalRight && containerOf(finalLeft.item, this.repair.containerNames) === containerOf(finalRight.item, this.repair.containerNames)) {
      for (const [key, value] of this.doc.getMap<unknown>(NATIVE_CUTS_MAP)) {
        if (!key.startsWith('c') || !Array.isArray(value) || value[1] !== 1) continue;
        if (value.some((client, i) => i >= 2 && i % 2 === 0 && client === boundary.created.client && value[i + 1] === boundary.created.clock)) return true;
      }
    }
    if (!left || !right) return false;
    const operation = (record: MoveRecord, destination: Y.ID) => {
      const prefix = `c${destination.client}-`;
      const ends = (record.server ? record.adopt : [record.key]).filter(key => key.startsWith(prefix))
        .map(key => Number(key.slice(prefix.length))).filter(end => Number.isFinite(end) && end > destination.clock);
      return ends.length ? Math.min(...ends) : null;
    };
    for (const leftSide of [false, true]) {
      let id = leftSide ? boundary.left : boundary.right;
      for (let depth = 0; depth < 64; depth++) {
        const mapping = this.mapped(id.client, id.clock);
        if (!mapping?.dst) break;
        const source = this.unitAt(id), paragraph = source && containerOf(source.item, this.repair.containerNames);
        const item = paragraph?._item, record = mapping.rec;
        const end = operation(record, mapping.dst);
        const nativeOperation = end === null ? undefined : this.doc.getMap<unknown>(NATIVE_CUTS_MAP).get(`c${mapping.dst.client}-${end}`);
        const operationKnown = Array.isArray(nativeOperation) && nativeOperation.length >= 2 && nativeOperation.length % 2 === 0;
        const joined = operationKnown ? nativeOperation[1] === 1 : record.joined === true;
        const sourceRemoved = !operationKnown || nativeOperation.some((value, i) => i >= 2 && i % 2 === 0 && value === item?.id.client && nativeOperation[i + 1] === item?.id.clock);
        if (mapping.side === MOVED && joined && sourceRemoved && item?.deleted
          && record.protect.some(protectedId => sameId(protectedId, item.id))
          && !entryFor(record, item.id.client, item.id.clock)?.[1]
          && (sawBefore(record, boundary.created) || (mapping.dst.client === boundary.created.client && end !== null && end > boundary.created.clock))) {
          const opposite = this.unitAt(this.resolveId(leftSide ? boundary.right : boundary.left));
          const destination = this.unitAt(this.resolveId(mapping.dst));
          if (!opposite || !destination || containerOf(opposite.item, this.repair.containerNames) !== containerOf(destination.item, this.repair.containerNames)) { id = mapping.dst; continue; }

          let edge: Unit | null = null;
          const found = (unit: Y.Item) => {
            if (!unit.countable || unit.parentSub !== null || unit.content instanceof Y.ContentFormat) return;
            for (let off = 0; off < unit.length; off++) {
              if (!leftSide && unit.content instanceof Y.ContentString && !unit.content.str[off].trim()) continue;
              const entry = entryFor(record, unit.id.client, unit.id.clock + off);
              if (entry?.[0] !== MOVED || !entry[1] || entry[1].client !== mapping.dst!.client || end === null || operation(record, entry[1]) !== end) continue;
              edge = { item: unit, off };
              if (!leftSide) break;
            }
          };
          for (let child = paragraph!._start; child; child = child.right) {
            const type = typeOf(child);
            if (type instanceof Y.XmlText) {
              for (let text = type._start; text; text = text.right) { found(text); if (edge && !leftSide) break; }
            } else found(child);
            if (edge && !leftSide) break;
          }
          if (edge) {
            const unit: Unit = edge;
            const edgeId = this.sourceIdentity(Y.createID(unit.item.id.client, unit.item.id.clock + unit.off));
            const sameEdge = sameId(edgeId, this.sourceIdentity(leftSide ? boundary.left : boundary.right));
            const afterLeft = this.sourceOrder(left, unit), beforeRight = this.sourceOrder(unit, right);
            if (sameEdge || ((afterLeft === -1 || afterLeft === 0) && beforeRight === -1)) return true;
          }
        }
        id = mapping.dst;
      }
    }
    return false;
  }

  /** Text typed into the right side after a cut stays with its explicitly anchored right word. */
  private boundaryRightStart(boundary: NativeBoundary, right: Unit): Unit {
    const prefix = `c${boundary.created.client}-`;
    const ends = [...this.doc.getMap<unknown>(NATIVE_CUTS_MAP).keys()].filter(key => key.startsWith(prefix))
      .map(key => Number(key.slice(prefix.length))).filter(end => Number.isSafeInteger(end) && end > boundary.created.clock);
    if (!ends.length) return right;
    const end = Math.min(...ends), rightIdentity = this.sourceIdentity(boundary.right);
    const paragraph = containerOf(right.item, this.repair.containerNames);
    let start = right, insertion: Y.Item | null = null, nextClock: number | null = null;
    let previous = this.prev(start, true);
    while (previous) {
      if (containerOf(previous.item, this.repair.containerNames) !== paragraph) break;
      if (previous.item.deleted) { previous = this.prev({ item: previous.item, off: 0 }, true); continue; }
      const id = this.sourceIdentity(Y.createID(previous.item.id.client, previous.item.id.clock + previous.off));
      const original = this.unitAt(id), item = original?.item;
      if (!item || !(item.content instanceof Y.ContentString
        || (item.content instanceof Y.ContentDeleted && item.parent instanceof Y.XmlText)) || !item.rightOrigin) break;
      const ownInsertion = item.id.client === boundary.created.client;
      const leftIdentity = this.sourceIdentity(boundary.left);
      const insertedLeft = item.origin && this.sourceIdentity(item.origin);
      if (ownInsertion ? !!item.origin || item.id.clock < end
        : (leftIdentity.client === item.id.client && leftIdentity.clock >= item.id.clock && leftIdentity.clock < item.id.clock + item.length)
          || (insertedLeft?.client === item.id.client && sameId(insertedLeft, leftIdentity))) break;
      const anchor = this.unitAt(item.rightOrigin);
      if (!anchor || !sameId(this.sourceIdentity(item.rightOrigin), rightIdentity)
        || containerOf(item, this.repair.containerNames) !== containerOf(anchor.item, this.repair.containerNames)
        || (insertion && (insertion !== item || id.clock !== nextClock))
        || (!insertion && id.clock !== item.id.clock + item.length - 1)) break;
      insertion = item; nextClock = id.clock - 1; start = previous;
      if (id.clock === item.id.clock) return start;
      previous = this.prev(previous, true);
    }
    // An incomplete span must not introduce a cut inside the insertion.
    return right;
  }

  /** Retire a nonempty authored side only after this repair has moved its cut to replacement paragraphs. */
  private retireReplacedCutSides(boundaries: NativeBoundary[], nonempty: ReadonlySet<string>): void {
    for (const boundary of boundaries) {
      if (!nonempty.has(idKey(boundary.created)) || this.nativeBoundaryJoined(boundary)) continue;
      const unit = this.unitAt(boundary.created), old = unit && typeOf(unit.item);
      if (!(old instanceof Y.XmlElement) || !isLive(old) || hasContent(old)) continue;
      const left = this.unitAt(this.resolveId(boundary.left)), right = this.unitAt(this.resolveId(boundary.right));
      const before = left && containerOf(left.item, this.repair.containerNames), after = right && containerOf(right.item, this.repair.containerNames);
      if (!before || !after || before === after || before === old || after === old || !isLive(before) || !isLive(after)) continue;
      const parent = old._item?.parent;
      if (!(parent instanceof Y.XmlFragment) || before._item?.parent !== parent || after._item?.parent !== parent) continue;
      let ordered = false;
      for (let item = before._item!.right; item; item = item.right) if (item === after._item) { ordered = true; break; }
      if (!ordered) continue;
      const replacement = sameId(boundary.marker, boundary.created) ? after : before;
      this.protect(old._item!.id);
      this.add(old._item!.id.client, old._item!.id.clock, 1, MOVED, replacement._item!.id.client, replacement._item!.id.clock);
      parent.delete(childIndex(parent, old._item!), 1); this.ours.add(old._item!);
    }
  }

  private restoreNativeBoundaries(boundaries: NativeBoundary[]): void {
    if (!this.concurrent) return;
    const ordered = [...boundaries].sort((first, second) => {
      const left = this.unitAt(first.left), right = this.unitAt(second.left);
      return left && right ? this.sourceOrder(left, right) ?? 0 : 0;
    });
    for (const boundary of ordered) {
      if (this.nativeBoundaryJoined(boundary)) continue;
      const marker = this.unitAt(this.resolveId(boundary.marker)), markerType = marker && typeOf(marker.item);
      // A later join by the cut's author can replace this retained marker
      // while joining a different boundary. Its original protected IDs prove
      // the replacement; nativeBoundaryJoined above still excludes removed cuts.
      const replacedByCreatorJoin = [...this.doc.getMap<unknown>(NATIVE_CUTS_MAP)].some(([key, value]) =>
        key.startsWith(`c${boundary.created.client}-`) && Number(key.slice(key.indexOf('-') + 1)) > boundary.created.clock
        && Array.isArray(value) && value[1] === 1
        && value.some((client, i) => i >= 2 && i % 2 === 0 && client === boundary.created.client && value[i + 1] === boundary.created.clock));
      if (!(markerType instanceof Y.XmlElement) || (!isLive(markerType) && !replacedByCreatorJoin)) continue;
      const surviving = (id: Y.ID, before: boolean): Unit | null => {
        const direct = this.unitAt(this.resolveId(id));
        if (direct && !direct.item.deleted && isLive(containerOf(direct.item, this.repair.containerNames))) return direct;
        let source = this.unitAt(this.sourceIdentity(id)) ?? this.unitAt(id);
        const endpoint = source;
        const originalParagraph = source && containerOf(source.item, this.repair.containerNames);
        for (let depth = 0; source && depth < 256; depth++) {
          const resolved = this.unitAt(this.resolveId(Y.createID(source.item.id.client, source.item.id.clock + source.off)));
          const direction = endpoint && this.sourceOrder(endpoint, source);
          if (resolved && !resolved.item.deleted && isLive(containerOf(resolved.item, this.repair.containerNames))
            && (direction === 0 || direction === (before ? 1 : -1))) return resolved;
          source = before ? this.prev(source, true) : this.next(source, true);
          if (source && containerOf(source.item, this.repair.containerNames) !== originalParagraph) break;
        }
        return null;
      };
      const left = surviving(boundary.left, true), survivingRight = surviving(boundary.right, false);
      if (!left || !survivingRight) continue;
      const right = this.boundaryRightStart(boundary, survivingRight);
      const paragraph = containerOf(left.item, this.repair.containerNames);
      const rightParagraph = containerOf(right.item, this.repair.containerNames);
      if (!paragraph || !isLive(paragraph) || !rightParagraph || !isLive(rightParagraph)) continue;
      const parent = paragraph._item?.parent;
      if (!(parent instanceof Y.XmlFragment) || !isLive(parent) || rightParagraph._item?.parent !== parent) continue;
      let preceding = false;
      if (paragraph !== rightParagraph) {
        for (let sibling = parent._start; sibling; sibling = sibling.right) {
          if (sibling === paragraph._item) break;
          if (sibling === rightParagraph._item) { preceding = true; break; }
        }
      }
      if (paragraph !== rightParagraph && !preceding) continue;
      const originParagraph = rightParagraph;
      const at = this.unitIndex(originParagraph, right), before = this.unitIndex(paragraph, left);
      if (!preceding && (at <= before || at === 0)) continue;
      if (preceding && at === 0) {
        const moved = this.moveContainer(originParagraph, parent, childIndex(parent, paragraph._item!) + 1);
        this.newBlocks.push(moved._item!);
        continue;
      }
      const suffix = new Y.XmlElement(originParagraph.nodeName);
      for (const [key, value] of Object.entries(originParagraph.getAttributes())) if (value !== undefined) suffix.setAttribute(key, value);
      parent.insert(childIndex(parent, paragraph._item!) + 1, [suffix]);
      this.protect(suffix._item!.id);
      let position = 0;
      const oldChildren: { item: Y.Item; offset: number }[] = [];
      for (let child = originParagraph._start; child; child = child.right) {
        if (child.deleted || !child.countable) continue;
        const type = typeOf(child), length = type instanceof Y.XmlText ? type.length : 1;
        if (position + length <= at) { position += length; continue; }
        const offset = Math.max(0, at - position);
        if (type instanceof Y.XmlText) {
          const text = new Y.XmlText(); suffix.insert(suffix.length, [text]);
          const ids: Y.ID[] = [];
          let skip = offset, copied = 0;
          for (const segment of this.segments(type, true)) {
            const from = Math.min(skip, segment.item.length); skip -= from;
            const value = segment.item.content.str.slice(from);
            if (!value) continue;
            text.insert(copied, value, segment.attrs); copied += value.length;
            for (let i = from; i < segment.item.length; i++) ids.push(Y.createID(segment.item.id.client, segment.item.id.clock + i));
          }
          let copiedIndex = 0;
          for (let copy = text._start; copy; copy = copy.right) if (copy.content instanceof Y.ContentString && !copy.deleted) {
            for (let i = 0; i < copy.length; i++) {
              const original = ids[copiedIndex++];
              this.add(original.client, original.clock, 1, MOVED, copy.id.client, copy.id.clock + i);
              this.recovered.add(copy.id.client, copy.id.clock + i, 1);
            }
          }
        } else if (type instanceof Y.XmlElement) {
          const copy = this.virtualCopy(type, item => !item.deleted);
          suffix.insert(suffix.length, [copy]);
          this.add(child.id.client, child.id.clock, 1, MOVED, copy._item!.id.client, copy._item!.id.clock);
          const pairs = new EntryList(); pairCopies(type, copy, item => !item.deleted, MOVED, pairs);
          for (let i = 0; i < pairs.entries.length; i += 6) this.add(...pairs.entries.slice(i, i + 6) as [number, number, number, number, number, number]);
        }
        oldChildren.push({ item: child, offset }); position += length;
      }
      for (const { item, offset } of oldChildren) {
        this.protect(item.id);
        const type = typeOf(item);
        if (type instanceof Y.XmlText && offset > 0) type.delete(offset, type.length - offset);
        else { originParagraph.delete(childIndex(originParagraph, item), 1); this.ours.add(item); }
      }
    }
  }

  /** A stale join must not erase an independent split's surviving suffix paragraph. */
  private recoverSplitSuffixes(conflicts: MoveIndex['conflicts']): void {
    if (!this.joining) return;
    const joins = [...this.own, ...conflicts.map(conflict => conflict.old.rec)].filter(record => record.joined === true);
    const candidates = new Map<Y.XmlElement, Ranges>();
    for (const record of this.index.records.values()) {
      if (!record.sv) continue;
      const entries = record.entries;
      for (let i = 0; i < entries.length; i += 6) {
        const [sc, sk, len, side, dc, dk] = entries.slice(i, i + 6);
        if (side !== KEPT || dc < 0) continue;
        for (let off = 0; off < len; off++) {
          const destination = this.resolveId(Y.createID(dc, dk + off));
          const unit = this.unitAt(destination);
          if (!unit || this.explicit(destination.client, destination.clock)) continue;
          // Older kept copies may already have lost to another move. Only the
          // current copy, or this update's newly competing split, can recover.
          if (!this.own.has(record) && !sameId(this.resolveId(Y.createID(sc, sk + off)), destination)) continue;
          if (unit.item.deleted && !this.deletedInT.hasId(destination) && !this.doa.hasId(destination)) continue;
          const paragraph = containerOf(unit.item, this.repair.containerNames);
          const item = paragraph?._item;
          const parent = item?.parent;
          if (!paragraph || !item?.deleted || !(parent instanceof Y.XmlFragment) || !isLive(parent)) continue;
          let split: Y.Item | null = null;
          for (let sibling = parent._start; sibling; sibling = sibling.right) {
            if (!sibling.deleted && ((sibling.rightOrigin && sameId(sibling.rightOrigin, item.id))
                || (sibling.origin && sameId(sibling.origin, item.id)))
              && typeOf(sibling) instanceof Y.XmlElement && madeBy(record, sibling.id.client)
              && !sawBefore(record, sibling.id)
              && (!record.server || record.adopt.some(key => key.startsWith(`c${sibling.id.client}-`)))) split = sibling;
          }
          if (!split || !joins.some(join => {
            if (!join.sv || sawBefore(join, split!.id) || sawBefore(join, destination)
              || !join.protect.some(id => sameId(id, item.id)) || entryFor(join, item.id.client, item.id.clock)?.[1]) return false;
            if (split!.rightOrigin && sameId(split!.rightOrigin, item.id)) return true;
            // A kept prefix precedes its newly split suffix. Restore it only
            // when the stale join removed the paragraph's following boundary;
            // a join into an earlier paragraph intentionally removes its left
            // boundary and must still append that prefix to the earlier text.
            for (let i = 0; i < join.entries.length; i += 6) {
              const entries = join.entries;
              if (entries[i + 3] !== MOVED || entries[i + 4] < 0) continue;
              const source = this.unitAt(Y.createID(entries[i], entries[i + 1]));
              const target = this.unitAt(Y.createID(entries[i + 4], entries[i + 5]));
              if (!source || !target || containerOf(source.item, this.repair.containerNames) !== paragraph) continue;
              const targetParagraph = containerOf(target.item, this.repair.containerNames)?._item;
              if (!targetParagraph || targetParagraph.parent !== parent) continue;
              for (let next = item.right; next; next = next.right) if (next === targetParagraph) return true;
            }
            return false;
          })) continue;
          let selected = candidates.get(paragraph);
          if (!selected) candidates.set(paragraph, selected = new Ranges());
          selected.add(destination.client, destination.clock, 1);
        }
      }
    }
    for (const [paragraph, selected] of candidates) {
      const item = paragraph._item!, parent = item.parent as Y.XmlFragment;
      const copy = new Y.XmlElement(paragraph.nodeName);
      const visible = (unit: Y.Item) => !unit.deleted || (this.deletedInT.hasId(unit.id) && (!this.isNew(unit.id) || !this.explicit(unit.id.client, unit.id.clock)));
      paragraph._map.forEach((unit, key) => { if (visible(unit)) copy.setAttribute(key, valueOf(unit) as string); });
      parent.insert(childIndex(parent, item), [copy]);
      for (let child = paragraph._start; child; child = child.right) {
        const type = typeOf(child);
        if (type instanceof Y.XmlText) {
          const units: { id: Y.ID; text: string; attrs: Record<string, unknown> }[] = [];
          const attrs: Record<string, unknown> = {};
          for (let text = type._start; text; text = text.right) {
            if (text.content instanceof Y.ContentFormat) {
              if (visible(text)) {
                const { key, value } = text.content;
                if (value === null) delete attrs[key]; else attrs[key] = value;
              }
            } else if (text.content instanceof Y.ContentString) {
              for (let off = 0; off < text.length; off++) if (selected.has(text.id.client, text.id.clock + off)) {
                units.push({ id: Y.createID(text.id.client, text.id.clock + off), text: text.content.str[off], attrs: { ...attrs } });
              }
            }
          }
          if (!units.length) continue;
          const run = new Y.XmlText();
          copy.insert(copy.length, [run]);
          run.applyDelta(units.map(unit => ({ insert: unit.text, attributes: unit.attrs })));
          const ids: Y.ID[] = [];
          for (let text = run._start; text; text = text.right) if (text.content instanceof Y.ContentString) {
            for (let off = 0; off < text.length; off++) ids.push(Y.createID(text.id.client, text.id.clock + off));
          }
          units.forEach((unit, i) => {
            this.add(unit.id.client, unit.id.clock, 1, MOVED, ids[i].client, ids[i].clock);
            this.recovered.add(ids[i].client, ids[i].clock, 1);
          });
          // Only the recorded kept characters have been copied here. Leave
          // the source run available for pending text inserted after that
          // split; its mover skips mapped characters and preserves the rest.
          this.protect(child.id);
        } else if (type instanceof Y.XmlElement && selected.hasId(child.id)) {
          const element = this.virtualCopy(type, visible);
          copy.insert(copy.length, [element]);
          this.add(child.id.client, child.id.clock, 1, MOVED, element._item!.id.client, element._item!.id.clock);
          this.recovered.add(element._item!.id.client, element._item!.id.clock, 1);
          const pairs = new EntryList();
          pairCopies(type, element, visible, MOVED, pairs);
          for (let i = 0; i < pairs.entries.length; i += 6) this.add(...(pairs.entries.slice(i, i + 6) as [number, number, number, number, number, number]));
          this.protect(child.id);
        }
      }
      this.add(item.id.client, item.id.clock, 1, MOVED, copy._item!.id.client, copy._item!.id.clock);
      this.protect(item.id);
      this.newBlocks.push(copy._item!);
    }
  }

  private add(sc: number, sk: number, len: number, side: number, dc: number, dk: number): void {
    const out = new EntryList();
    out.entries = this.rec.entries;
    out.push(sc, sk, len, side, dc, dk);
    this.index.entry(this.rec, sc, sk, len, side, dc, dk);
    // A copied run is another place a coauthor can still be typing. If someone
    // empties that run before the typing arrives, retain its parent and children
    // so the late insertion can be repaired next to the surviving neighbours.
    if (dc >= 0) {
      const copy = this.unitAt(Y.createID(dc, dk));
      const run = copy?.item.parent;
      if (run instanceof Y.XmlText && run._item) this.protect(run._item.id);
    }
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
    const nativeEnds = new Map<string, Y.ID | null>();
    const nativeEndpoint = (record: MoveRecord, paragraph: Y.XmlElement, last: boolean): Unit | null => {
      const item = paragraph._item, anchor = last ? item?.rightOrigin : item?.origin;
      if (!item || !anchor || !record.sv || sawBefore(record, item.id)) return null;
      const cacheKey = `${record.key}:${idKey(item.id)}:${last}`;
      if (nativeEnds.has(cacheKey)) {
        const id = nativeEnds.get(cacheKey);
        return id ? this.unitAt(id) : null;
      }
      const prefix = `c${item.id.client}-`;
      const ends = (record.server ? record.adopt : [record.key]).filter(key => key.startsWith(prefix))
        .map(key => Number(key.slice(prefix.length))).filter(end => Number.isFinite(end) && end > item.id.clock);
      const end = ends.length ? Math.min(...ends) : Infinity;
      // Offline typing can have collected originals. Other copied units
      // still prove the retained paragraph; any known different source rules
      // out this role (for example, an incidental post-join neighbour).
      let found: Y.ID | null = null, selected = last ? -1 : Infinity, sourceKnown = false, sourceMismatch = false;
      if (Number.isFinite(end)) for (let i = 0; i < record.entries.length; i += 6) {
        const e = record.entries;
        if (e[i + 3] !== MOVED || e[i + 4] !== item.id.client) continue;
        const clock = e[i + 5] + (last ? e[i + 2] - 1 : 0);
        if (clock >= end) continue;
        const id = Y.createID(e[i + 4], clock), unit = this.unitAt(id);
        if (!unit || containerOf(unit.item, this.repair.containerNames) !== paragraph) continue;
        for (const off of [0, e[i + 2] - 1]) {
          const source = this.unitAt(Y.createID(e[i], e[i + 1] + off));
          if (!source || source.item.content instanceof Y.ContentDeleted) continue;
          const container = containerOf(source.item, this.repair.containerNames);
          if (!container?._item) continue;
          if (sameId(container._item.id, anchor)) sourceKnown = true; else sourceMismatch = true;
        }
        if (last ? clock > selected : clock < selected) { found = id; selected = clock; }
      }
      if (!sourceKnown || sourceMismatch) found = null;
      nativeEnds.set(cacheKey, found);
      return found ? this.unitAt(found) : null;
    };
    const nativeKeptSuffix = (record: MoveRecord, id: Y.ID, final: Unit): boolean => {
      if (!record.sv) return false;
      const unit = this.unitAt(id), paragraph = unit && containerOf(unit.item, this.repair.containerNames), item = paragraph?._item;
      const finalParagraph = containerOf(final.item, this.repair.containerNames);
      if (!item || !finalParagraph) return false;
      const finalContainer = this.unitAt(this.resolveId(item.id));
      if (!finalContainer || typeOf(finalContainer.item) !== finalParagraph) return false;
      const prefix = `c${id.client}-`;
      const ends = (record.server ? record.adopt : [record.key]).filter(key => key.startsWith(prefix))
        .map(key => Number(key.slice(prefix.length))).filter(end => Number.isSafeInteger(end) && end > id.clock);
      if (!ends.length) return false;
      const end = Math.min(...ends), e = record.entries;
      const operation = this.doc.getMap<unknown>(NATIVE_CUTS_MAP).get(`${prefix}${end}`);
      const nativeSplit = Array.isArray(operation) && operation[1] === 0;
      for (let i = 0; i < e.length; i += 6) {
        if (e[i + 3] !== MOVED || e[i + 4] !== id.client || e[i + 5] >= end
          || Math.min(...ends.filter(clock => clock > e[i + 5])) !== end) continue;
        const destination = this.unitAt(Y.createID(e[i + 4], e[i + 5]));
        const sibling = destination && containerOf(destination.item, this.repair.containerNames)?._item;
        const source = this.unitAt(Y.createID(e[i], e[i + 1]));
        if (sibling && sibling !== item && sibling.id.client === id.client && !sawBefore(record, sibling.id)
          && sibling.id.clock < end && (nativeSplit || (source && containerOf(source.item, this.repair.containerNames) === paragraph))
          && sibling.rightOrigin && sameId(sibling.rightOrigin, item.id)) return true;
      }
      return false;
    };
    const keptSideAuthored = (record: MoveRecord, id: Y.ID, final: Unit): boolean => {
      if (nativeKeptSuffix(record, id, final)) return true;
      for (let depth = 0; depth < 64; depth++) {
        const mapping = this.mapped(id.client, id.clock);
        if (!mapping?.dst || mapping.rec === this.rec || this.own.has(mapping.rec)) break;
        if (mapping.side === KEPT && nativeKeptSuffix(mapping.rec, mapping.dst, final)) return true;
        id = mapping.dst;
      }
      // A server can recreate a kept run. Its destination uses the server's
      // clock; walk the recorded source lineage to the same native suffix.
      for (let depth = 0; depth < 64; depth++) {
        const source = this.index.sourceOf(id.client, id.clock);
        if (!source || source.rec === this.rec || this.own.has(source.rec)) break;
        if (source.side === KEPT && nativeKeptSuffix(source.rec, id, final)) return true;
        id = source.src;
      }
      // Adoption can choose another kept alias as the canonical source.
      // The original's other copies retain the independent native cut proof.
      const copies: { id: Y.ID; depth: number }[] = [{ id: this.sourceIdentity(id), depth: 0 }];
      const seen = new Set<string>();
      for (let at = 0; at < copies.length; at++) {
        const current = copies[at], key = idKey(current.id);
        if (seen.has(key) || current.depth >= 64) continue;
        seen.add(key);
        for (const copy of this.index.copiesOf(current.id.client, current.id.clock)) {
          const source = this.index.sourceOf(copy.client, copy.clock);
          if (!source || source.rec === this.rec || this.own.has(source.rec)) continue;
          if (source.side === KEPT && nativeKeptSuffix(source.rec, copy, final)) return true;
          copies.push({ id: copy, depth: current.depth + 1 });
        }
      }
      return false;
    };
    for (let k = c.clock; k < c.clock + c.len; k++) {
      const mine = entryFor(r, c.client, k);
      if (!mine || !mine[1]) continue;
      const [side, dst] = mine;
      const oldDst = old.dst ? Y.createID(old.dst.client, old.dst.clock + (k - c.clock)) : null;
      // A propagated deletion records the copied unit as handled with no next
      // copy. A stale author can still copy that tombstone in a later split or
      // join; keep the deletion when adopting that new destination.
      if (!oldDst && old.side === HANDLED && this.isDeleted(Y.createID(c.client, k))) gone.push(dst);
      // a move beats a copy that stayed with its neighbours (a re-created run, or the server's placement of
      // a late edit): those agree with each other, and the earlier one is where the neighbours are; a copy
      // its author moved on (a second split) counts as moved; of two moves the one into the smaller
      // paragraph (the inner split point) wins
      const ns = this.strength(side, dst), os = oldDst ? this.strength(old.side, oldDst) : KEPT;
      let newWins = !oldDst || (ns === MOVED && os !== MOVED) || (ns === MOVED && os === MOVED && this.sizeAt(this.resolveId(dst)) < this.sizeAt(this.resolveId(oldDst)));
      if (oldDst && ns === MOVED && os === MOVED) {
        const nu = this.unitAt(this.resolveId(dst)), ou = this.unitAt(this.resolveId(oldDst));
        const np = nu && containerOf(nu.item, this.repair.containerNames), op = ou && containerOf(ou.item, this.repair.containerNames);
        if (np && op && np !== op) for (const last of [true, false]) {
          const na = last ? np._item?.rightOrigin : np._item?.origin;
          const oa = last ? op._item?.rightOrigin : op._item?.origin;
          if (!na || !oa || !sameId(na, oa)) continue;
          // Prefixes keep the earlier end; suffixes keep the later start.
          // Use native endpoints so later typing and disjoint splits do not
          // change which original cut lies inside the other.
          const ne = nativeEndpoint(r, np, last);
          const moved = ou && this.index.sourceOf(ou.item.id.client, ou.item.id.clock + ou.off);
          const oe = (moved?.side === MOVED ? nativeEndpoint(moved.rec, op, last) : null) ?? nativeEndpoint(old.rec, op, last);
          const order = ne && oe && this.sourceOrder(ne, oe);
          if (order === -1 || order === 1) {
            newWins = last ? order === -1 : order === 1;
            break;
          }
        }
      }
      // a copy inside a paragraph (or run) that is gone — joined into another meanwhile — cannot win
      if (oldDst) {
        const pn = this.placeable(this.resolveId(dst)), po = this.placeable(this.resolveId(oldDst));
        if (pn !== po) newWins = pn;
      }
      // a late edit the server placed beside its neighbour, also moved by this record (which knew it): it
      // goes where this record's move of that neighbour went (if the move lost there, it lost here too)
      if (oldDst && !newWins && side === KEPT && (old.side === PLACED || old.side === KEPT) && !r.server && r.joined === false && r.sv) {
        const kept = this.unitAt(dst), paragraph = kept && containerOf(kept.item, this.repair.containerNames);
        const oldFinal = this.unitAt(this.resolveId(oldDst));
        const prefix = `c${dst.client}-`, end = r.key.startsWith(prefix) ? Number(r.key.slice(prefix.length)) : 0;
        const start = r.sv.get(dst.client) ?? 0;
        if (paragraph?._item && end > dst.clock && dst.clock >= start && (!oldFinal || (!this.authoredSplitCopy(oldFinal) && !(old.side === KEPT && keptSideAuthored(old.rec, oldDst, oldFinal))))) {
          for (let i = 0; i < r.entries.length; i += 6) {
            const e = r.entries;
            if (e[i + 3] !== MOVED || e[i + 4] !== dst.client) continue;
            const unit = this.unitAt(Y.createID(e[i + 4], e[i + 5]));
            const sibling = unit && containerOf(unit.item, this.repair.containerNames)?._item;
            // This operation copied a prefix before its kept paragraph. Its
            // explicit suffix beats an older kept copy or late placement,
            // while a coauthor's authored split side competes normally.
            if (sibling && sibling.id.client === dst.client && sibling.id.clock >= start && sibling.id.clock < end
              && sibling.rightOrigin && sameId(sibling.rightOrigin, paragraph._item.id)) { newWins = true; break; }
          }
        }
      }
      if (oldDst && newWins && old.side === PLACED) newWins = this.moveHeld(r, Y.createID(c.client, k), dst, oldDst);
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
  private moveHeld(r: MoveRecord, id: Y.ID, dst: Y.ID, oldDst: Y.ID): boolean {
    const u = this.unitAt(id);
    if (!u) return true;
    // Recovery can promote a newly kept copy of one's own insertion. Its
    // native record leaves the insertion and its right word together. If that
    // word won an independent split side beside the earlier placed insertion,
    // retain their shared gap instead of following the recovered left side.
    const native = entryFor(r, id.client, id.clock);
    const rawCopy = this.unitAt(dst), restoredId = this.resolveId(dst), restored = this.unitAt(restoredId);
    if (native?.[0] === KEPT && !r.server && r.joined === false && r.sv && id.client === dst.client
      && !this.index.sourceOf(id.client, id.clock) && u.item.parent instanceof Y.XmlText
      && u.item.rightOrigin && this.recovered.hasId(restoredId)) {
      const rightEntry = entryFor(r, u.item.rightOrigin.client, u.item.rightOrigin.clock);
      const rawRight = rightEntry?.[1] && this.unitAt(rightEntry[1]);
      const right = this.unitAt(this.resolveId(u.item.rightOrigin)), old = this.unitAt(this.resolveId(oldDst));
      const rawParagraph = rawCopy && containerOf(rawCopy.item, this.repair.containerNames);
      const rawRightParagraph = rawRight && containerOf(rawRight.item, this.repair.containerNames);
      const rightParagraph = right && containerOf(right.item, this.repair.containerNames);
      const oldParagraph = old && containerOf(old.item, this.repair.containerNames);
      const restoredParagraph = restored && containerOf(restored.item, this.repair.containerNames);
      const rightSource = right && this.index.sourceOf(right.item.id.client, right.item.id.clock + right.off);
      if (rawParagraph && rawParagraph === rawRightParagraph && right && !right.item.deleted
        && !this.isNew(Y.createID(right.item.id.client, right.item.id.clock + right.off)) && rightParagraph?._item && !this.isNew(rightParagraph._item.id)
        && rightSource?.side === MOVED && rightSource.rec !== r && rightSource.rec !== this.rec
        && this.authoredSplitCopy(right) && rightParagraph === oldParagraph && restoredParagraph !== rightParagraph) {
        return false;
      }
    }
    for (let a = this.prev(u, true); a; a = this.prev(a, true)) {
      const mine = entryFor(r, a.item.id.client, a.item.id.clock + a.off);
      if (!mine || !mine[1]) continue;
      const authoredLeft = this.unitAt(mine[1]), authoredHere = this.unitAt(dst);
      const leftParagraph = authoredLeft && containerOf(authoredLeft.item, this.repair.containerNames);
      const hereParagraph = authoredHere && containerOf(authoredHere.item, this.repair.containerNames);
      // A new split can explicitly put this text after a paragraph break,
      // while its old server placement was beside a word before that break.
      // Couple their winning positions only when this record kept them in
      // the same authored paragraph.
      if (leftParagraph && hereParagraph && leftParagraph !== hereParagraph) return true;
      const fa = this.unitAt(this.resolveId(Y.createID(a.item.id.client, a.item.id.clock + a.off)));
      const fd = this.unitAt(this.resolveId(dst));
      const finalParagraph = fa && containerOf(fa.item, this.repair.containerNames);
      if (fa && fd && finalParagraph && finalParagraph === containerOf(fd.item, this.repair.containerNames)
        && this.unitIndex(finalParagraph, fd) < this.unitIndex(finalParagraph, fa)) return false;
      const rawRightId = u.item.rightOrigin;
      const rawRightCopy = rawRightId && entryFor(r, rawRightId.client, rawRightId.clock)?.[1];
      const rawRight = rawRightCopy && this.unitAt(rawRightCopy);
      const right = rawRightId && this.unitAt(this.resolveId(rawRightId));
      const oldPlacement = this.unitAt(this.resolveId(oldDst));
      if (fa && fd && right && oldPlacement && finalParagraph && finalParagraph === containerOf(fd.item, this.repair.containerNames)
        && finalParagraph === containerOf(right.item, this.repair.containerNames)
        && rawRight && hereParagraph === containerOf(rawRight.item, this.repair.containerNames)
        && finalParagraph === containerOf(oldPlacement.item, this.repair.containerNames)
        // Another conflict may still move the right word. Retain the older
        // placement only while it lies inside the settled shared gap.
        && this.unitIndex(finalParagraph, fa) < this.unitIndex(finalParagraph, oldPlacement)
        && this.unitIndex(finalParagraph, oldPlacement) < this.unitIndex(finalParagraph, right)
        && this.unitIndex(finalParagraph, fd) >= this.unitIndex(finalParagraph, right)) return false;
      return !!fa && !!fd && finalParagraph === containerOf(fd.item, this.repair.containerNames);
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
    if (Y.getState(this.store, id.client) <= id.clock) return false;
    // Removing the last text from a copied run removes the run too. Yjs may
    // collect its children into GC structs, but their tombstones still mean
    // that a competing stale copy must be deleted.
    const item = Y.getItem(this.store, id);
    if (!item.deleted || this.mapped(id.client, id.clock) || this.doa.has(id.client, id.clock)) return false;
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
    /** the unit that moved away right after each stretch */
    const after: (Y.ID | null)[] = [null];
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
          if (this.mapped(id.client, id.clock)) {
            if (stretches[stretches.length - 1].length) { after[after.length - 1] = id; stretches.push([]); before.push(id); after.push(null); }
            else before[before.length - 1] = id;
          }
          continue;
        }
        if (this.misplaced.has(it)) { stretches.push([{ id, item: it, off: o, text: '', attrs: {} }], []); before.push(null, null); after.push(null, null); continue; }
        stretches[stretches.length - 1].push({ id, item: it, off: o, text: it.content.str[o], attrs: { ...attrs } });
      }
    }
    // a copy that won against a competing one, or a moved copy that counts for its original, holds its stretch in place
    const counts = (c: Ch) => {
      if (this.misplaced.has(c.item)) return false;
      if (this.winners.has(idKey(c.id))) return true;
      const src = this.index.sourceOf(c.id.client, c.id.clock);
      if (!src || src.side !== MOVED || !sameId(this.resolveId(src.src), c.id)) return false;
      // A stale split did not see this author's inserted text. Its prior copy
      // alone cannot hold a stretch in place after all surrounding words moved:
      // it follows those shared anchors just like the original late insertion.
      let original = c.id;
      for (let depth = 0; depth < 64; depth++) {
        const source = this.index.sourceOf(original.client, original.clock);
        if (!source) break;
        original = source.src;
      }
      // Check the inserted unit's identity. originalOf() also finds a copied
      // neighbour for layout provenance, which can be an older word its author
      // knew even though it had never seen this coauthor's new insertion.
      return !this.rec.sv || sawBefore(this.rec, original);
    };
    // a stretch that the move put next to the unit before it (a join appending another paragraph's text)
    // goes where that unit went; one that followed it in the same paragraph before stays with its own
    const sameSource = (a: Y.ID, b: Y.ID) => {
      if (!this.joining) {
        const oa = this.unitAt(a), ob = this.unitAt(b);
        const first = oa && this.originalOf(oa, 0), second = ob && this.originalOf(ob, 0);
        return !!first && !!second && containerOf(first.item, this.repair.containerNames) === containerOf(second.item, this.repair.containerNames);
      }
      const ca = this.sourceContainer(a), cb = this.sourceContainer(b);
      return !!ca && ca === cb;
    };
    const stay: Ch[] = [], go: Ch[] = [];
    let outside = this.next({ item: runItem, off: 0 }, true, true);
    while (outside?.item.deleted) outside = this.next(outside, true);
    stretches.forEach((st, i) => {
      if (!st.length) return;
      const prev = before[i];
      const next = after[i];
      // A join can prepend one paragraph's copies to another paragraph. When
      // a concurrent split moves that following paragraph's prefix elsewhere,
      // the joined prefix follows it; its own moved copies must not hold the
      // prefix ahead of the remaining suffix and reverse the original words.
      // Even copies from the same source cannot hold a joined suffix behind
      // its former left neighbour after that neighbour moved to another block.
      const first = { item: st[0].item, off: st[0].off };
      const authored = this.unitIndex(parent, first) === 0 && this.authoredSplitCopy(first);
      // The restored side and a winning authored split side retain their own
      // paragraph boundary even when another author's neighbouring copy moved.
      // Text legitimately joined after that winning side stays with it.
      const holds = st.every(unit => this.recovered.hasId(unit.id)) || (authored && st.some(counts)) || (st.some(counts) && (!prev || !this.unitAt(prev) || (this.joining ? st.every(unit => sameSource(prev, unit.id)) : sameSource(prev, st[0].id)))
        && (!this.joining || !next || !this.unitAt(next) || st.every(unit => sameSource(unit.id, next)))
        && (!this.joining || !prev || !this.unitAt(prev)
          || containerOf(this.final(this.unitAt(prev)!).item, this.repair.containerNames) === parent)
        && (!this.joining || !next || !this.unitAt(next)
          || containerOf(this.final(this.unitAt(next)!).item, this.repair.containerNames) === parent)
        && (!this.joining || !outside || this.sourceOrder({ item: st[st.length - 1].item, off: st[st.length - 1].off }, outside) !== 1));
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
    const ordered: Piece[] = [];
    for (const [cont, pieces] of byCont) {
      const order = new Map<Y.Item, number>();
      let i = 0;
      for (let ch = cont._start; ch; ch = ch.right) {
        order.set(ch, i++);
        const t = typeOf(ch);
        if (t instanceof Y.XmlText) for (let it = t._start; it; it = it.right) order.set(it, i++);
      }
      pieces.sort((a, b) => (order.get(a.item) ?? 0) - (order.get(b.item) ?? 0) || a.off - b.off);
      ordered.push(...pieces);
    }
    const visiting = new Set<Piece>(), done = new Set<Piece>();
    const includes = (p: Piece, unit: Unit) => {
      const run = typeOf(p.item);
      return (p.item === unit.item && unit.off >= p.off && unit.off < p.off + p.len)
        || (run instanceof Y.XmlText && unit.item.parent === run);
    };
    const partsOf = (p: Piece): Piece[] => {
      const run = typeOf(p.item);
      return run instanceof Y.XmlText
        ? this.segments(run).flatMap(segment => this.unmappedParts({ item: segment.item, off: 0, len: segment.item.length }))
        : [p];
    };
    const place = (p: Piece) => {
      if (done.has(p) || visiting.has(p)) return;
      visiting.add(p);
      for (const q of this.unmappedParts(p)) {
        // A joined run can itself be waiting to follow a concurrently split
        // neighbour. Place those destination anchors before text typed between
        // them; otherwise it falls back beside the old, deleted destination.
        for (const part of partsOf(q)) {
          const anchors = this.placementAnchors(part);
          for (const anchor of this.joining ? [anchors.origin, anchors.right] : []) {
            if (!anchor) continue;
            const final = this.final(anchor);
            if (!final.item.deleted && this.placeable(Y.createID(final.item.id.client, final.item.id.clock + final.off))) continue;
            for (const dependency of ordered) {
              if (dependency === p) continue;
              if (!includes(dependency, final)) continue;
              // A right neighbour that was typed after this piece depends on
              // this piece's placement. Recursing into it would reverse that
              // left-to-right chain and force its first character to fallback.
              if (anchor === anchors.right && partsOf(dependency).some(part => {
                const left = this.placementAnchors(part).origin;
                return left && [...visiting].some(piece => includes(piece, this.final(left)));
              })) continue;
              place(dependency);
            }
          }
        }
        // what a competing record's resolution mapped meanwhile is placed already (a losing copy)
        for (const part of this.unmappedParts(q)) {
          try { this.move(part); } catch (e) { this.repair.log('[moves] could not place', idKey(part.item.id), e); }
        }
      }
      visiting.delete(p); done.add(p);
    };
    for (const p of ordered) place(p);
  }

  /** live children of the paragraphs this repair moved things out of, whose neighbour moved meanwhile: pending again */
  private followers(): boolean {
    if (!this.concurrent) return false;
    const conts = new Set<Y.XmlElement>();
    const e = this.rec.entries;
    for (let i = 0; i < e.length; i += 6) {
      if (e[i + 3] !== PLACED && e[i + 3] !== MOVED) continue;
      const u = this.unitAt(Y.createID(e[i], e[i + 1]));
      const c = u && containerOf(u.item, this.repair.containerNames);
      if (c && isLive(c)) conts.add(c);
      if (u) {
        const last = this.unitAt(Y.createID(e[i], e[i + 1] + e[i + 2] - 1));
        for (const anchor of [this.sourceLeftOf({ ...u, len: 1 }), last && this.sourceRightOf({ ...last, len: 1 })]) {
          const neighbour = anchor && containerOf(this.final(anchor).item, this.repair.containerNames);
          if (neighbour && isLive(neighbour)) conts.add(neighbour);
        }
      }
    }
    const before = this.pending.length;
    this.pending = [];
    for (const c of conts) for (let ch = c._start; ch; ch = ch.right) if (!ch.deleted && (!this.isNew(ch.id) || this.ownCopy(ch)) && this.liveMisplaced({ item: ch, off: 0, len: 1 })) this.addPending({ item: ch, off: 0, len: 1 });
    void before;
    return this.pending.length > 0;
  }

  private unmappedParts(p: Piece): Piece[] {
    if (typeOf(p.item)) return this.index.lookup(p.item.id.client, p.item.id.clock) ? [] : [p];
    const out: Piece[] = [];
    for (let o = p.off; o < p.off + p.len;) {
      let n = 1;
      const m = !!this.index.lookup(p.item.id.client, p.item.id.clock + o);
      let source = this.placementSource({ item: p.item, off: o });
      while (o + n < p.off + p.len && !!this.index.lookup(p.item.id.client, p.item.id.clock + o + n) === m) {
        const next = this.placementSource({ item: p.item, off: o + n });
        if (!m && this.joining && source.item.parent !== next.item.parent) break;
        source = next; n++;
      }
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
    // Capture live content before our own deletion. Afterwards inOurs() treats
    // children deleted by this move as movable, and must not revive historical
    // tombstones that the author explicitly removed earlier.
    const segments = t instanceof Y.XmlText ? this.segments(t) : null;
    const visible = new Set<Y.Item>();
    if (t instanceof Y.XmlElement) {
      const remember = (parent: Y.AbstractType<any>) => {
        for (let child = parent._start; child; child = child.right) {
          if (this.wasLive(child)) visible.add(child);
          const nested = typeOf(child);
          if (nested) remember(nested);
        }
      };
      remember(t);
    }
    const element = t instanceof Y.XmlElement ? this.virtualCopy(t) : null;
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
      for (const seg of segments!) {
        // what of it was moved elsewhere already (a losing copy resolved onto the winner) stays there
        for (const part of this.unmappedParts({ item: seg.item, off: 0, len: seg.item.length })) {
          // A run may contain copies that already moved, with an author's new
          // text between them. Place that text next to its own copied anchors,
          // rather than at the beginning of the run after skipping those copies.
          const anchor = this.originOf(part);
          const right = this.rightOf(part, false);
          if (this.placementAnchors(part).source
            || (anchor && this.mapped(anchor.item.id.client, anchor.item.id.clock + anchor.off))
            || (right && this.mapped(right.item.id.client, right.item.id.clock + right.off))) {
            const target = this.target(part);
            if (target && target !== 'stay') p = target;
          }
          const id = this.insertText(p, seg.item.content.str.slice(part.off, part.off + part.len), seg.attrs);
          this.add(seg.item.id.client, seg.item.id.clock + part.off, part.len, PLACED, id.client, id.clock);
          last = this.unitAt(Y.createID(id.client, id.clock + part.len - 1));
          if (last) this.rememberPlaced(p.key, last);
          p = { ...p, index: p.index + part.len };
        }
      }
      this.add(it.id.client, it.id.clock, 1, HANDLED, -1, 0);
      this.removeLive(it);
    } else if (t instanceof Y.XmlElement) {
      const copy = this.insertElement(pos, element!);
      this.add(it.id.client, it.id.clock, 1, PLACED, copy._item!.id.client, copy._item!.id.clock);
      const out = new EntryList();
      pairCopies(t, copy, item => visible.has(item), PLACED, out);
      for (let i = 0; i < out.entries.length; i += 6) this.add(...(out.entries.slice(i, i + 6) as [number, number, number, number, number, number]));
      this.removeLive(it);
      last = { item: copy._item!, off: 0 };
    }
    if (last) {
      // the next one placed after the same unit, or after what was just placed there, goes behind it all
      this.rememberPlaced(pos.key, last);
    }
  }

  private rememberPlaced(key: string, last: Unit): void {
    const root = this.chain.get(key) ?? key;
    this.placed.set(root, last);
    this.chain.set(idKey(Y.createID(last.item.id.client, last.item.id.clock + last.off)), root);
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
          const key = 'start:' + idKey(it.id), last = this.lastPlaced(key);
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
    if (!this.joining && !this.madeHere && this.unknownJoinedSource(x)) {
      this.joining = true;
      try { return this.target(x); } finally { this.joining = false; }
    }
    const firstUnit = typeOf(x.item) instanceof Y.XmlText ? this.edgeUnit(x.item, false) ?? { item: x.item, off: x.off } : { item: x.item, off: x.off };
    const physicalOrigin = this.originOf(x);
    const splitRight = this.splitRightOf(firstUnit);
    if (splitRight) {
      const right = this.final(splitRight), here = containerOf(x.item, this.repair.containerNames);
      const there = containerOf(right.item, this.repair.containerNames);
      if (there && isLive(there) && !right.item.deleted && (here !== there || (here && this.unitIndex(here, right) < this.unitIndex(here, firstUnit)))) return this.before(splitRight, x);
    }
    let sourceRight = this.sourceRightOf(x);
    // Text inserted after this stretch can itself be waiting for this stretch
    // to move. Its own right word is an independent anchor; following the
    // dependent insertion first would fall back through the deleted run.
    for (let depth = 0; sourceRight && depth < 64; depth++) {
      const destination = this.final(sourceRight);
      if (!destination.item.deleted && this.placeable(Y.createID(destination.item.id.client, destination.item.id.clock + destination.off))) break;
      const left = this.sourceLeftOf({ ...sourceRight, len: 1 });
      const final = left && this.final(left);
      const run = typeOf(x.item), clock = final ? final.item.id.clock + final.off : 0;
      const inside = final && ((run instanceof Y.XmlText && final.item.parent === run)
        || (final.item.id.client === x.item.id.client && clock >= x.item.id.clock + x.off && clock < x.item.id.clock + x.off + x.len));
      if (!inside) break;
      const next = this.rightOf({ ...sourceRight, len: sourceRight.item.length - sourceRight.off }, true);
      if (!next || this.same(next, sourceRight)) { sourceRight = null; break; }
      sourceRight = next;
    }
    const here = containerOf(x.item, this.repair.containerNames);
    const sourceLeft = this.sourceLeftOf(x);
    const finalLeft = sourceLeft && this.final(sourceLeft), leftType = finalLeft && typeOf(finalLeft.item);
    const inlineCopy = finalLeft && this.index.sourceOf(finalLeft.item.id.client, finalLeft.item.id.clock + finalLeft.off);
    const operationEnd = (record: MoveRecord, id: Y.ID) => {
      const prefix = `c${id.client}-`;
      const ends = [record.key, ...record.adopt].filter(key => key.startsWith(prefix))
        .map(key => Number(key.slice(prefix.length))).filter(end => Number.isSafeInteger(end) && end > id.clock);
      return ends.length ? Math.min(...ends) : Infinity;
    };
    const sameNativeSplit = inlineCopy?.side === MOVED && inlineCopy.rec !== this.rec && !this.own.has(inlineCopy.rec)
      && inlineCopy.rec.sv && here?._item && finalLeft
      && here._item.id.client === finalLeft.item.id.client && madeBy(inlineCopy.rec, here._item.id.client)
      && !sawBefore(inlineCopy.rec, here._item.id)
      && Number.isFinite(operationEnd(inlineCopy.rec, here._item.id))
      && operationEnd(inlineCopy.rec, here._item.id) === operationEnd(inlineCopy.rec, finalLeft.item.id);
    const retainedInlineLeft = sourceLeft && finalLeft && leftType instanceof Y.XmlElement
      && !isContainer(leftType, this.repair.containerNames) && !finalLeft.item.deleted
      && containerOf(finalLeft.item, this.repair.containerNames) === here
      && sameNativeSplit && this.counts(sourceLeft.item, sourceLeft.off) && this.sourceOrder(sourceLeft, firstUnit) === -1;
    // A joined prefix without a left origin follows its original right word,
    // rather than falling back after a later paragraph already joined here.
    if (this.joining && !physicalOrigin && !retainedInlineLeft && sourceRight && this.counts(sourceRight.item, sourceRight.off)
      && this.sourceOrder(firstUnit, sourceRight) === -1 && here
      && (containerOf(this.final(sourceRight).item, this.repair.containerNames) !== here
        || this.unitIndex(here, this.final(sourceRight)) < this.unitIndex(here, firstUnit))) return this.before(sourceRight, x);
    // A merged joined string may keep a much earlier paragraph's left anchor
    // while its own preceding word moves independently. The nearer original
    // word is authoritative once its destination is alive.
    if (!this.authoredSplitCopy(firstUnit) && physicalOrigin && sourceLeft && this.counts(sourceLeft.item, sourceLeft.off)
      && this.sourceOrder(physicalOrigin, sourceLeft) === -1 && this.sourceOrder(sourceLeft, firstUnit) === -1
      && this.placeable(this.resolveId(Y.createID(sourceLeft.item.id.client, sourceLeft.item.id.clock + sourceLeft.off)))) return this.after(sourceLeft, x);
    if (physicalOrigin && this.sourceOrder(physicalOrigin, firstUnit) === 1) {
      // A joined copy can have a later source at its physical left edge.
      // Use a relocated original left neighbour; otherwise earlier text and
      // formulas follow the original right neighbour that moved away.
      const left = this.sourceLeftOf(x);
      const right = sourceRight ?? this.originalOf(firstUnit, 0);
      if (left && this.counts(left.item, left.off)
        && (containerOf(this.final(left).item, this.repair.containerNames) !== here
          || !right || !this.counts(right.item, right.off)
          || containerOf(this.final(right).item, this.repair.containerNames) === here)) return this.after(left, x, 0, right);
      for (let next = right; next; next = this.next(next, true)) {
        if (this.counts(next.item, next.off)) return this.before(next, x);
      }
    }
    // A copied string starts with no character origin; a re-created run can
    // retain only a deleted separator. Its original first character still
    // identifies the nearer surviving word or inline formula to its left.
    if (this.joining && sourceLeft && (!physicalOrigin || physicalOrigin.item.content instanceof Y.ContentDeleted)
      && this.counts(sourceLeft.item, sourceLeft.off) && this.sourceOrder(sourceLeft, firstUnit) === -1) return this.after(sourceLeft, x);
    if (typeOf(x.item) instanceof Y.XmlText) {
      const first = this.edgeUnit(x.item, false);
      const original = first && this.originalOf(first, 0);
      const sourceRun = original?.item.parent instanceof Y.XmlText ? original.item.parent._item : null;
      const before = original && !this.prev(original, false) && sourceRun
        ? this.originOf({ item: sourceRun, off: 0, len: 1 }) : null;
      // A recreated run after an inline formula retains that formula's
      // position even after a later split moves it again. The run container's
      // old physical anchors may instead point at a much earlier joined prefix.
      if (first && before && typeOf(before.item) instanceof Y.XmlElement
        && this.counts(before.item, before.off) && this.sourceOrder(before, first) === -1) return this.after(before, x);
    }
    const anchors = this.placementAnchors(x);
    if (anchors.source) {
      const { origin } = anchors;
      if (origin && this.counts(origin.item, origin.off)) return this.after(origin, x, 0, anchors.right);
      for (let right = anchors.right; right; right = this.next(right, true)) {
        if (this.counts(right.item, right.off)) return this.before(right, x);
      }
    }
    const origin = this.originOf(x);
    if (origin && this.counts(origin.item, origin.off)) return this.after(origin, x);
    // An explicitly deleted last word still has surviving characters to its
    // left in the same run. A following formula follows that nearest moved
    // word, before considering its own old right-hand tail as an anchor.
    for (let a = origin && this.prev(origin, false); a; a = this.prev(a, false)) {
      if (this.counts(a.item, a.off)) return this.after(a, x);
    }
    // If the immediate left anchor disappeared, the right anchor is closer than
    // an earlier run. Searching left first can cross unseen copies inserted by a
    // stale split and append the draft after an unrelated paragraph's suffix.
    for (let r = this.rightOf(x, false); r; r = this.next(r, false)) if (this.counts(r.item, r.off)) return this.before(r, x);
    for (let a = origin && this.prev(origin, true); a; a = this.prev(a, true)) {
      if (this.counts(a.item, a.off)) return this.after(a, x);
    }
    // where its run is: after what precedes the run, at the start of the paragraph, before what follows
    const self = x.item.parent instanceof Y.XmlText && x.item.parent._item ? x.item.parent._item : x.item;
    for (let a = this.prev({ item: self, off: 0 }, true); a; a = this.prev(a, true)) if (this.counts(a.item, a.off)) return this.after(a, x);
    const cont = containerOf(x.item, this.repair.containerNames);
    if (cont && isLive(cont)) {
      if (!x.item.deleted) return 'stay';
      const key = 'start:' + idKey(cont._item!.id), last = this.lastPlaced(key);
      return { cont, index: last ? this.unitIndex(cont, last) + 1 : 0, key };
    }
    for (let r = this.next({ item: self, off: 0 }, true, true); r; r = this.next(r, true)) if (this.counts(r.item, r.off)) return this.before(r, x);
    return null;
  }

  private after(a: Unit, x: Piece, depth = 0, rightAnchor?: Unit | null): Pos | 'stay' | null {
    const f = this.final(a);
    const fit = f.item;
    const cont = containerOf(fit, this.repair.containerNames);
    if (!cont || !isLive(cont) || (fit.parent instanceof Y.XmlText && !isLive(fit.parent))) return depth > 8 ? null : this.around(f, x, depth + 1);
    const key = idKey(Y.createID(fit.id.client, fit.id.clock + f.off));
    const firstUnit = typeOf(x.item) instanceof Y.XmlText ? this.edgeUnit(x.item, false) ?? { item: x.item, off: x.off } : { item: x.item, off: x.off };
    const previous = this.lastPlaced(key);
    // The chain may include the next paragraph just appended after a deleted
    // end word. Typing before that word belongs before the appended paragraph.
    const last = previous && containerOf(previous.item, this.repair.containerNames) === cont
      && this.unitIndex(cont, previous) >= this.unitIndex(cont, f)
      && this.sourceOrder(previous, firstUnit) !== 1 ? previous : null;
    if (last) {
      const right = rightAnchor === undefined ? this.rightOf(x, false) : rightAnchor;
      const end = right && this.final(right);
      if (right && end && !end.item.deleted && containerOf(end.item, this.repair.containerNames) === cont
        && this.sourceOrder(right, firstUnit) !== -1
        && this.unitIndex(cont, last) >= this.unitIndex(cont, end)) return this.before(end, x, depth);
    }
    if (!x.item.deleted && !last && this.adjacentAfter(f, x)) return 'stay';
    let base = last ?? f;
    if (this.joining) {
      // A join appends the following paragraph after the preceding paragraph's
      // end, including text concurrently inserted before a deleted end word.
      // The copied left anchor alone precedes that text in Yjs's insertion gap.
      const first = this.placementSource(firstUnit);
      for (let next = this.next(base, true); next; next = this.next(next, true)) {
        if (next.item.deleted) continue;
        if (containerOf(next.item, this.repair.containerNames) !== cont
          || next.item === x.item || next.item.parent === typeOf(x.item)
          || this.sourceOrder(next, first) !== -1) break;
        base = next;
      }
    }
    return { cont, index: this.unitIndex(cont, base) + (base.item.deleted ? 0 : 1), key };
  }

  private before(r: Unit, x: Piece, depth = 0): Pos | 'stay' | null {
    const f = this.final(r);
    const fit = f.item;
    const cont = containerOf(fit, this.repair.containerNames);
    if (!cont || !isLive(cont) || (fit.parent instanceof Y.XmlText && !isLive(fit.parent))) return depth > 8 ? null : this.around(f, x, depth + 1);
    if (!x.item.deleted && this.adjacentBefore(f, x)) return 'stay';
    let first = f;
    const run = typeOf(x.item);
    const firstUnit = run instanceof Y.XmlText ? this.edgeUnit(x.item, false) ?? { item: x.item, off: x.off } : { item: x.item, off: x.off };
    if (this.sourceOrder(firstUnit, r) === -1) {
      // Joining the previous paragraph places it before text concurrently
      // typed at the start of the next one, as well as before that next word.
      for (let previous = this.prev(f, true); previous; previous = this.prev(previous, true)) {
        if (previous.item.deleted) continue;
        if (containerOf(previous.item, this.repair.containerNames) !== cont
          || this.sourceOrder(previous, firstUnit) !== 1) break;
        first = previous;
      }
    }
    return { cont, index: this.unitIndex(cont, first), key: 'before:' + idKey(Y.createID(first.item.id.client, first.item.id.clock + first.off)) };
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
  private lastPlaced(key: string): Unit | null {
    const last = this.placed.get(this.chain.get(key) ?? key);
    // Inserting text or an inline element can split the item this anchor once
    // belonged to. Resolve its character ID again before using its offset.
    return last ? this.final(last) : null;
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

  /** This pending stretch includes a join copy its current author had not seen. */
  private unknownJoinedSource(piece: Piece): boolean {
    const joined = (unit: Unit) => {
      if (this.authoredSplitCopy(unit)) return false;
      let id = Y.createID(unit.item.id.client, unit.item.id.clock + unit.off);
      for (let depth = 0; depth < 64; depth++) {
        const source = this.index.sourceOf(id.client, id.clock);
        if (!source) break;
        if (source.rec.joined === true && !sawBefore(this.rec, id)) return true;
        id = source.src;
      }
      return false;
    };
    const run = typeOf(piece.item);
    if (run instanceof Y.XmlText) {
      for (let text = run._start; text; text = text.right) if (text.content instanceof Y.ContentString) {
        for (let off = 0; off < text.length; off++) if (joined({ item: text, off })) return true;
      }
      return false;
    }
    for (let off = piece.off; off < piece.off + piece.len; off++) if (joined({ item: piece.item, off })) return true;
    return false;
  }

  /** the earliest recorded unit identity, including originals already collected */
  private sourceIdentity(id: Y.ID): Y.ID {
    for (let depth = 0; depth < 64; depth++) {
      const source = this.index.sourceOf(id.client, id.clock);
      if (!source) break;
      id = source.src;
    }
    return id;
  }

  private sourceRightOf(piece: Piece): Unit | null {
    const last = typeOf(piece.item) instanceof Y.XmlText ? this.edgeUnit(piece.item, true)
      : { item: piece.item, off: piece.off + piece.len - 1 };
    const original = last && this.unitAt(this.sourceIdentity(Y.createID(last.item.id.client, last.item.id.clock + last.off)));
    if (!original || original.item.content instanceof Y.ContentDeleted) return null;
    let right = this.rightOf({ ...original, len: 1 }, true);
    // Run recreation leaves non-content separator tombstones in the inline
    // list. They have no copy to follow; the next text or formula is the
    // original neighbour's surviving provenance.
    while (right?.item.content instanceof Y.ContentDeleted) right = this.next(right, true);
    return right;
  }

  private sourceLeftOf(piece: Piece): Unit | null {
    const first = typeOf(piece.item) instanceof Y.XmlText ? this.edgeUnit(piece.item, false)
      : { item: piece.item, off: piece.off };
    const original = first && this.unitAt(this.sourceIdentity(Y.createID(first.item.id.client, first.item.id.clock + first.off)));
    if (!original || original.item.content instanceof Y.ContentDeleted) return null;
    // Read the original insertion's anchor. A later insertion immediately
    // before it can share the gap, but was not its author's left neighbour.
    const before = original.off > 0 ? { item: original.item, off: original.off - 1 }
      : original.item.origin && this.unitAt(original.item.origin);
    if (before) return typeOf(before.item) instanceof Y.XmlText ? this.edgeUnit(before.item, true) ?? this.prev(before, true) : before;
    // The first character in a text run has no character origin. Its run's
    // origin still identifies the preceding inline formula or text run.
    const run = original.item.parent instanceof Y.XmlText ? original.item.parent._item : null;
    return run && !this.prev(original, false) ? this.originOf({ item: run, off: 0, len: 1 }) : null;
  }

  /** paragraph a unit belonged to before its latest move, skipping run recreations */
  private sourceContainer(id: Y.ID): Y.XmlElement | null {
    let unit = this.unitAt(id);
    for (let depth = 0; depth < 64; depth++) {
      const source = this.index.sourceOf(id.client, id.clock);
      if (!source) break;
      id = source.src;
      const original = this.unitAt(id);
      if (!original || original.item.content instanceof Y.ContentDeleted) continue;
      unit = original;
      // A server placement chooses anchors but does not make the inserted
      // units belong to every other source now sharing the destination run.
      if (source.side === MOVED) break;
    }
    return unit && containerOf(unit.item, this.repair.containerNames);
  }

  /** source of the latest move, retaining the paragraph created by an earlier split */
  private placementSource(initial: Unit): Unit {
    let unit = initial;
    let id = Y.createID(initial.item.id.client, initial.item.id.clock + initial.off);
    for (let depth = 0; depth < 64; depth++) {
      const source = this.index.sourceOf(id.client, id.clock);
      if (!source) return unit;
      // A server placement already chose the insertion's settled anchors.
      // Reopening its deleted source can split a typed word across old copies.
      if (source.side === PLACED) return unit;
      id = source.src;
      const original = this.unitAt(source.src);
      // A paragraph created and joined away while offline may have been
      // collected before reaching the server. Its record still links that copy
      // to the older source, so continue through the missing intermediate ID.
      if (!original || original.item.content instanceof Y.ContentDeleted) continue;
      unit = original;
      // A prior split's copy is now the paragraph a later join moved from.
      if (source.side === MOVED) return unit;
    }
    return unit;
  }

  private placementAnchors(x: Piece): { source: boolean; origin: Unit | null; right: Unit | null } {
    const origin = this.originOf(x), right = this.rightOf(x, false);
    if (!this.joining) return { source: false, origin, right };
    const first = this.placementSource({ item: x.item, off: x.off });
    const last = this.placementSource({ item: x.item, off: x.off + x.len - 1 });
    const source = (!this.same(first, { item: x.item, off: x.off }) || !this.same(last, { item: x.item, off: x.off + x.len - 1 }))
      && first.item.parent === last.item.parent;
    if (source) {
      const before = this.originOf({ ...first, len: 1 });
      const after = this.rightOf({ ...last, len: 1 }, true);
      // A merged joined string can place an earlier source paragraph after a
      // later one. Use its earlier anchors only for that inversion; the join's
      // new adjacency remains authoritative when it preserves source order.
      if ((origin && this.sourceOrder(origin, first) === 1)
        || (!origin && before && this.counts(before.item, before.off)
          && this.placeable(this.resolveId(Y.createID(before.item.id.client, before.item.id.clock + before.off)))
          && containerOf(this.final(before).item, this.repair.containerNames) !== containerOf(x.item, this.repair.containerNames))
        || (!origin && after && (!right || this.sourceOrder(after, right) === -1))) return { source: true, origin: before, right: after };
    }
    return { source: false, origin, right };
  }

  private sourceOrder(a: Unit, b: Unit): -1 | 0 | 1 | null {
    const insertedBefore = (unit: Unit, anchor: Unit) => {
      let id = Y.createID(unit.item.id.client, unit.item.id.clock + unit.off), retained = unit;
      const target = this.sourceIdentity(Y.createID(anchor.item.id.client, anchor.item.id.clock + anchor.off));
      for (let depth = 0; depth < 64; depth++) {
        const source = this.index.sourceOf(id.client, id.clock);
        if (!source) break;
        id = source.src;
        const original = this.unitAt(id);
        if (original && !(original.item.content instanceof Y.ContentDeleted)) retained = original;
      }
      if (sameId(id, target) || !(retained.item.content instanceof Y.ContentString)) return false;
      let length = retained.item.length - retained.off;
      const original = this.unitAt(id);
      if (!original || original.item.content instanceof Y.ContentDeleted) {
        // A collected insertion can survive inside a later merged copy.
        // Its own copied characters end before that copy's following words.
        length = 1;
        while (length < retained.item.length - retained.off) {
          const next = this.sourceIdentity(Y.createID(retained.item.id.client, retained.item.id.clock + retained.off + length));
          if (next.client !== id.client || next.clock !== id.clock + length) break;
          length++;
        }
      }
      const right = this.rightOf({ ...retained, len: length }, false);
      return !!right && sameId(this.sourceIdentity(Y.createID(right.item.id.client, right.item.id.clock + right.off)), target);
    };
    // Typing into a copied run inherits the nearby original's provenance, but
    // remains before the word used as its explicit right insertion anchor.
    if (insertedBefore(a, b)) return -1;
    if (insertedBefore(b, a)) return 1;
    const position = (unit: Unit) => {
      const original = this.unitAt(this.sourceIdentity(Y.createID(unit.item.id.client, unit.item.id.clock + unit.off)));
      // Collected characters can retain their item in a protected source run.
      // Its position remains authoritative even though its text is gone;
      // borrowing an earlier neighbour's position would move later copies
      // ahead of text inserted before these explicitly deleted characters.
      return original?.item.content instanceof Y.ContentDeleted && original.item.parent instanceof Y.XmlText
        ? original : this.originalOf(unit, 0);
    };
    const first = position(a), second = position(b);
    if (!first || !second) return null;
    if (first.item === second.item) return first.off < second.off ? -1 : first.off > second.off ? 1 : 0;
    const left = containerOf(first.item, this.repair.containerNames), right = containerOf(second.item, this.repair.containerNames);
    if (!left || !right) return null;
    const order = (parent: Y.AbstractType<any>, x: Y.Item, y: Y.Item): -1 | 1 | null => {
      for (let child = parent._start; child; child = child.right) {
        if (child === x) return -1;
        if (child === y) return 1;
      }
      return null;
    };
    if (left !== right) {
      const parent = left._item?.parent;
      return parent instanceof Y.AbstractType && parent === right._item?.parent ? order(parent, left._item!, right._item!) : null;
    }
    if (first.item.parent === second.item.parent && first.item.parent instanceof Y.AbstractType) return order(first.item.parent, first.item, second.item);
    const x = first.item.parent instanceof Y.XmlText ? first.item.parent._item : first.item;
    const y = second.item.parent instanceof Y.XmlText ? second.item.parent._item : second.item;
    return x && y ? order(left, x, y) : null;
  }

  /** the unit a stretch was typed after (within its item: the character before; a run as a neighbour: its last unit) */
  private originOf(x: Piece): Unit | null {
    if (x.off > 0) return { item: x.item, off: x.off - 1 };
    if (!x.item.origin) return null;
    // Concurrent insertions in one gap already have a settled Yjs order. A
    // copied neighbour must keep that order when a stale split recreates the
    // run; anchoring every insertion directly to the gap's left edge reverses it.
    const previous = this.prev({ item: x.item, off: 0 }, false);
    if (previous?.item.content instanceof Y.ContentString && previous.item.parent === x.item.parent
      && ((previous.item.rightOrigin && sameId(previous.item.rightOrigin, x.item.id)
          && previous.item.origin && sameId(previous.item.origin, x.item.origin))
        || (previous.item.rightOrigin && x.item.rightOrigin && sameId(previous.item.rightOrigin, x.item.rightOrigin))
        || (!previous.item.rightOrigin && !x.item.rightOrigin && previous.item.origin && sameId(previous.item.origin, x.item.origin)))) return previous;
    const u = this.unitAt(x.item.origin);
    if (!u) return null;
    return typeOf(u.item) instanceof Y.XmlText ? this.edgeUnit(u.item, true) ?? this.prev(u, true) : u;
  }
  /** the unit a stretch was typed before (`cross`: past the end of its run) */
  private rightOf(x: Piece, cross: boolean): Unit | null {
    if (x.off + x.len < x.item.length) return { item: x.item, off: x.off + x.len };
    const next = this.next({ item: x.item, off: x.off + x.len - 1 }, false);
    // Splitting a copied item retains its former distant rightOrigin. Its
    // continuation starts after this fragment and is the closer right anchor.
    if (x.item.content instanceof Y.ContentString && next?.item.content instanceof Y.ContentString
      && next.item.parent === x.item.parent && next.item.origin
      && sameId(next.item.origin, Y.createID(x.item.id.client, x.item.id.clock + x.off + x.len - 1))) return next;
    if (x.item.rightOrigin) {
      const u = this.unitAt(x.item.rightOrigin);
      if (u) return typeOf(u.item) instanceof Y.XmlText ? this.edgeUnit(u.item, false) ?? this.next(u, true, true) : u;
    }
    // Splitting a copied string can give its first fragment no rightOrigin: the
    // following fragment still carries its position in the run and may be moved
    // independently. Its physical successor is the nearest right anchor.
    if (next) return next;
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
    for (const run of this.formatBaselines) {
      const attrs: Record<string, unknown> = {};
      for (let item = run._start; item; item = item.right) {
        if (item.content instanceof Y.ContentFormat) {
          if (!item.deleted || (this.deletedInT.hasId(item.id) && !this.isNew(item.id))) {
            const { key, value } = item.content;
            if (value === null) delete attrs[key]; else attrs[key] = value;
          }
          continue;
        }
        if (!(item.content instanceof Y.ContentString)) continue;
        for (let off = 0; off < item.length; off++) {
          const id = Y.createID(item.id.client, item.id.clock + off);
          if (!this.deletedInT.hasId(id) || !this.adoptedSrc.hasId(id)) continue;
          const target = this.unitAt(this.resolveId(id));
          if (!target || target.item.deleted || !(target.item.parent instanceof Y.XmlText) || !isLive(target.item.parent)) continue;
          const current = this.attrsAt(target.item), delta: Record<string, unknown> = {};
          for (const key of new Set([...Object.keys(attrs), ...Object.keys(current)])) {
            if (JSON.stringify(attrs[key] ?? null) !== JSON.stringify(current[key] ?? null)) delta[key] = attrs[key] ?? null;
          }
          if (Object.keys(delta).length) target.item.parent.format(this.unitIndexIn(target.item.parent, target.item) + target.off, 1, delta);
        }
      }
    }
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
      // Copies in the sender's incoming split do not prove it learned this
      // deletion from a move: it may have deleted the word before splitting.
      if (!m || m.rec === this.rec || m.side === PLACED || m.side === HANDLED) continue;
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
      if (!u) continue;
      if (!u.item.deleted) {
        const p = u.item.parent;
        if (p instanceof Y.XmlText) { if (isLive(p)) p.delete(this.unitIndexIn(p, u.item) + u.off, 1); }
        else if (p instanceof Y.XmlElement && typeOf(u.item) instanceof Y.XmlElement && isLive(p)) p.delete(childIndex(p, u.item), 1);
      }
      // Adjacent deleted strings can merge in Yjs. A later run repair sees its
      // moved prefix and must still exclude these explicitly deleted units in
      // the middle; retaining their handled ranges makes that distinction
      // survive item merging and server restart.
      if (this.unitAt(id)?.item.deleted) this.add(id.client, id.clock, 1, HANDLED, -1, 0);
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
    const moved = new Set<Y.Item>(this.concurrent ? this.newBlocks.filter(it => !it.deleted) : []);
    for (const k of this.winners) {
      const [c, cl] = k.split(':').map(Number);
      const u = this.unitAt(this.resolveId(Y.createID(c, cl)));
      const cont = u && containerOf(u.item, this.repair.containerNames);
      if (cont && cont._item && isLive(cont)) moved.add(cont._item);
    }
    // until nothing moves (a paragraph moved changes what the others are between)
    let todo = [...moved];
    for (let round = 0; round < 4 && todo.length; round++) {
      this.blockCandidates.clear();
      const next: Y.Item[] = [];
      for (const it of todo) {
        if (it.deleted) continue;
        const copy = this.slot(it);
        if (copy) next.push(...todo.filter(o => o !== it && !o.deleted), copy._item!);
      }
      todo = [...new Set([...next, ...this.blockCandidates])];
    }
  }

  /** a paragraph the update made has others between its neighbours that its author did not see */
  concurrentBlocks(): boolean {
    if (!this.concurrent) return false;
    return this.newBlocks.some(x => {
      if (x.deleted) return false;
      const right = x.rightOrigin ? this.unitAt(x.rightOrigin)?.item ?? null : null;
      const left = x.origin ? this.unitAt(x.origin)?.item ?? null : null;
      // a neighbour the server moved since: it may have to follow
      if ((left?.deleted && this.mapped(left.id.client, left.id.clock)) || (right?.deleted && this.mapped(right.id.client, right.id.clock))) return true;
      for (let it = left ? left.right : (x.parent as Y.XmlFragment)._start; it && it !== right; it = it.right) if (it !== x && !it.deleted && typeOf(it) instanceof Y.XmlElement && !this.createdTogether(x, it)) return true;
      return false;
    });
  }

  /** authored structure in a new inset, or a comment's header/body pair; root splits still follow their text's source */
  private createdTogether(a: Y.Item, b: Y.Item): boolean {
    const parent = a.parent;
    if (!(parent instanceof Y.XmlElement) || parent !== b.parent) return false;
    const thread = parent.nodeName === 'inset' && parent.getAttribute('name') === 'Note' && parent.getAttribute('arg') === 'Comment';
    const fresh = parent._item && this.isNew(parent._item.id)
      && parent._item.id.clock < (this.tr.afterState.get(parent._item.id.client) ?? 0);
    if (!thread && !fresh) return false;
    return a.id.client === b.id.client && this.isNew(a.id) && this.isNew(b.id)
      && a.id.clock < (this.tr.afterState.get(a.id.client) ?? 0)
      && b.id.clock < (this.tr.afterState.get(b.id.client) ?? 0);
  }

  /** The visible right neighbour of an empty authored after its own earlier join. */
  private authoredEmptyRight(x: Y.Item): Y.Item | null {
    const authored = this.unitAt(this.sourceIdentity(x.id))?.item ?? x;
    const raw = authored.rightOrigin && this.unitAt(authored.rightOrigin)?.item;
    if (!raw?.deleted || raw.parent !== x.parent) return null;
    // Yjs may anchor Enter to a tombstone the author had already joined away.
    // An empty made before that join still follows its original left anchor.
    const earlierJoin = [...this.index.records.values()].find(record => record.joined === true && record.sv
      && record.protect.some(id => sameId(id, raw.id)) && !entryFor(record, raw.id.client, raw.id.clock)?.[1]
      && [record.key, ...record.adopt].some(key => {
        const prefix = `c${authored.id.client}-`;
        return key.startsWith(prefix) && Number(key.slice(prefix.length)) < authored.id.clock;
      }));
    if (!earlierJoin) return null;
    let right: Y.Item | null = null;
    for (let it = raw.right; it; it = it.right) {
      if (it.deleted || it === x || !(typeOf(it) instanceof Y.XmlElement)) continue;
      if (sawBefore(earlierJoin, it.id)) { right = it; break; }
    }
    const rightKey = right && this.blockKey(typeOf(right) as Y.XmlElement);
    if (!right || !rightKey) return null;
    // Concurrent halves of the joined prefix may now precede that neighbour.
    // Cross only proven earlier content, preserving other authored boundaries.
    for (let it = raw.right; it && it !== right; it = it.right) {
      if (it.deleted || it === x || !(typeOf(it) instanceof Y.XmlElement)) continue;
      const key = this.blockKey(typeOf(it) as Y.XmlElement);
      if (!key || cmpKey(key, rightKey) >= 0) return null;
    }
    return right;
  }

  /** a paragraph among the paragraphs between its neighbours as its author saw them, where its text came from */
  private slot(x: Y.Item): Y.XmlElement | null {
    const parent = x.parent as Y.XmlFragment;
    // its neighbours as its author saw them (where the server moved them since)
    const where = (id: Y.ID | null) => (id ? this.unitAt(this.resolveId(id))?.item ?? null : null);
    let left = where(x.origin);
    let right = where(x.rightOrigin);
    let authoredSuccessorBound = false;
    // An offline draft can have collected character originals. Its later
    // author-known split still explicitly follows that paragraph, even when
    // borrowed text provenance would sort the draft behind the new prefix.
    const type = typeOf(x) as Y.XmlElement;
    let first: Unit | null = null;
    for (let child = type._start; child && !first; child = child.right) {
      if (child.deleted) continue;
      const run = typeOf(child);
      if (run instanceof Y.XmlText) for (let text = run._start; text; text = text.right) {
        if (!text.deleted && text.content instanceof Y.ContentString) { first = { item: text, off: 0 }; break; }
      }
      else if (run instanceof Y.XmlElement) first = { item: child, off: 0 };
    }
    const originalFirst = first && this.unitAt(this.sourceIdentity(Y.createID(first.item.id.client, first.item.id.clock + first.off)));
    if (first && (!originalFirst || originalFirst.item.content instanceof Y.ContentDeleted)) {
      for (let sibling = parent._start; sibling; sibling = sibling.right) {
        if (sibling === x || !sibling.origin) continue;
        const predecessor = this.unitAt(sibling.origin)?.item;
        const successor = this.unitAt(this.resolveId(sibling.id))?.item;
        if (!predecessor || !successor || successor === x || successor.deleted || successor.parent !== parent
          || sibling.id.client !== predecessor.id.client || !sameId(this.resolveId(predecessor.id), x.id)) continue;
        const known = [...this.own, ...this.index.records.values()].some(record => sawBefore(record, predecessor.id)
          && madeBy(record, sibling!.id.client) && !sawBefore(record, sibling!.id));
        if (known) { right = successor; authoredSuccessorBound = true; break; }
      }
    }
    if ((left && left.parent !== parent) || (right && right.parent !== parent)) return null;
    const kx = this.blockKey(typeOf(x) as Y.XmlElement);
    if (!kx) {
      if (hasContent(typeOf(x) as Y.XmlElement)) return null;
      const authoredRight = this.authoredEmptyRight(x);
      if (!authoredRight) return null;
      let next = x.right;
      while (next && (next.deleted || !(typeOf(next) instanceof Y.XmlElement))) next = next.right;
      return next === authoredRight ? null : this.moveContainer(typeOf(x) as Y.XmlElement, parent, childIndex(parent, authoredRight));
    }
    const leftKey = left && typeOf(left) instanceof Y.XmlElement ? this.blockKey(typeOf(left) as Y.XmlElement) : null;
    const rightKey = right && typeOf(right) instanceof Y.XmlElement ? this.blockKey(typeOf(right) as Y.XmlElement) : null;
    // A deleted bound can resolve to a live competing copy whose text now
    // comes from the other side of this paragraph. Its tombstone still needs
    // expansion; using that copy as a hard bound would alternate their order
    // every time the repair recreates either paragraph.
    const movedLeft = x.origin && this.unitAt(x.origin)?.item.deleted && leftKey && cmpKey(leftKey, kx) > 0;
    const movedRight = x.rightOrigin && this.unitAt(x.rightOrigin)?.item.deleted && rightKey && cmpKey(rightKey, kx) < 0;
    const emptyPredecessor = left && !leftKey && typeOf(left) instanceof Y.XmlElement
      && !hasContent(typeOf(left) as Y.XmlElement) && left.origin ? where(left.origin) : null;
    const emptyRight = emptyPredecessor && left ? this.authoredEmptyRight(left) : null;
    if (emptyRight && left) this.blockCandidates.add(left);
    const emptyPredecessorKey = emptyRight ? this.blockKey(typeOf(emptyRight) as Y.XmlElement)
      : emptyPredecessor && typeOf(emptyPredecessor) instanceof Y.XmlElement
        ? this.blockKey(typeOf(emptyPredecessor) as Y.XmlElement) : null;
    // An empty successor of later-source text is later too. A repair copy
    // inserted after it must still be able to move before that text, keeping
    // the later paragraph and its authored empty successor together.
    const laterEmptyLeft = emptyPredecessorKey && cmpKey(emptyPredecessorKey, kx) > 0;
    if (left?.deleted || (left && (movedLeft || laterEmptyLeft))) {
      // A join can delete the author's paragraph anchor without mapping the
      // paragraph itself. Concurrent copies of its later text may now stand
      // before that tombstone. Include those known later blocks in the slot,
      // stopping at an earlier source or an authored block without provenance.
      let bound: Y.Item | null = null;
      for (let it = left.left; it; it = it.left) {
        if (it === x || it.deleted || !(typeOf(it) instanceof Y.XmlElement)) continue;
        const block = typeOf(it) as Y.XmlElement;
        const key = this.blockKey(block);
        if ((!key && hasContent(block)) || (key && cmpKey(key, kx) <= 0)) { bound = it; break; }
      }
      left = bound;
    }
    if (right?.deleted || (right && movedRight)) {
      // The same tombstone can hide an earlier copied prefix after the right
      // bound. Include that known prefix so a later suffix stays after it.
      let bound: Y.Item | null = null;
      for (let it = right.right; it; it = it.right) {
        if (it === x || it.deleted || !(typeOf(it) instanceof Y.XmlElement)) continue;
        const block = typeOf(it) as Y.XmlElement;
        const key = this.blockKey(block);
        if ((!key && hasContent(block)) || (key && cmpKey(key, kx) >= 0)) { bound = it; break; }
      }
      right = bound;
    }
    // A newly authored group has an intrinsic order. In a new comment, for
    // example, its header precedes its empty body; that body is an authored
    // right neighbor, not an unkeyed concurrent paragraph to sort past.
    for (let it = x.left; it && it !== left; it = it.left) {
      if (!it.deleted && typeOf(it) instanceof Y.XmlElement && this.createdTogether(x, it)) { left = it; break; }
    }
    for (let it = x.right; it && it !== right; it = it.right) {
      if (!it.deleted && typeOf(it) instanceof Y.XmlElement && this.createdTogether(x, it)) { right = it; break; }
    }
    // Moving the left paragraph can carry it past an old deleted right anchor.
    // Check their order only after expanding such tombstone bounds by source.
    if (authoredSuccessorBound && right && left && !isAfter(right, left)
      && x.origin && this.unitAt(x.origin)?.item.deleted) {
      // The old left tombstone can stand beyond the author's live successor.
      // Its borrowed key must not widen the slot across that native right edge.
      left = right.left;
      while (left && (left === x || left.deleted || !(typeOf(left) instanceof Y.XmlElement))) left = left.left;
    }
    if (left && right && !isAfter(right, left)) return null;
    const between: Y.Item[] = [];
    for (let it = left ? left.right : parent._start; it && it !== right; it = it.right) if (it !== x && !it.deleted && typeOf(it) instanceof Y.XmlElement) between.push(it);
    // right before the first one whose text comes from further on (else before its right neighbour);
    // Unknown text blocks keep their place. An empty paragraph has no text
    // provenance and does not block ordering the known text on either side.
    let before: Y.Item | null = right;
    const keys = between.map(it => this.blockKey(typeOf(it) as Y.XmlElement));
    if (keys.some((key, i) => !key && hasContent(typeOf(between[i]) as Y.XmlElement))) return null;
    for (let i = 0; i < between.length; i++) {
      const block = between[i];
      // An empty paragraph has no content key, but an explicit origin at this
      // paragraph makes it an authored successor. Moving its predecessor past
      // it reverses that boundary (for example, Enter at a paragraph's start).
      const dependentEmpty = !keys[i] && !hasContent(typeOf(block) as Y.XmlElement)
        && block.origin && sameId(this.resolveId(block.origin), x.id);
      if (dependentEmpty) {
        // Keep this paragraph before its authored empty successor. An earlier
        // concurrent prefix beyond that pair can instead find its own slot
        // before both, even when none of this update's words landed in it.
        for (let j = i + 1; j < between.length; j++) {
          if (keys[j] && cmpKey(keys[j]!, kx) < 0) this.blockCandidates.add(between[j]);
        }
      }
      if (dependentEmpty || (keys[i] && cmpKey(keys[i]!, kx) > 0)) { before = block; break; }
    }
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
    const span = (item: Y.Item): { first: Y.ID; last: Y.ID; source: Y.XmlText } | null => {
      let first: Y.ID | null = null, last: Y.ID | null = null, source: Y.XmlText | null = null;
      for (const segment of this.segments(typeOf(item) as Y.XmlText, true)) for (let offset = 0; offset < segment.item.length; offset++) {
        const id = this.sourceIdentity(Y.createID(segment.item.id.client, segment.item.id.clock + offset));
        const original = this.unitAt(id);
        if (!original || !(original.item.parent instanceof Y.XmlText)
          || (source && source !== original.item.parent)
          || (last && (id.client !== last.client || id.clock !== last.clock + 1))) return null;
        first ??= id; last = id; source = original.item.parent;
      }
      return first && last && source ? { first, last, source } : null;
    };
    const left = span(a), right = span(b);
    // Competing kept copies can leave adjacent pieces of one original string
    // in inverse run order. Preserve their exact contiguous source sequence;
    // unrelated text, intentional joins and paragraph boundaries retain order.
    const runs = left && right && left.source === right.source && right.last.client === left.first.client
      && right.last.clock + 1 === left.first.clock ? [b, a] : [a, b];
    for (const runItem of runs) {
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
  private blockKey(c: Y.XmlElement, depth = 0): [number, number] | null {
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
    if (!orig) {
      // Text typed offline and immediately split can arrive with its originals
      // already collected. Its new paragraph still has a right neighbour from
      // that author's document: place it before that neighbour's provenance,
      // after any concurrent suffix copied out of the preceding paragraph.
      if (!first || depth >= 8 || !c._item?.rightOrigin) return null;
      const right = this.unitAt(this.resolveId(c._item.rightOrigin));
      const next = right && typeOf(right.item);
      return next instanceof Y.XmlElement && next !== c && next._item?.parent === c._item.parent
        ? this.blockKey(next, depth + 1) : null;
    }
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
    let retained = u;
    for (let i = 0; i < 64; i++) {
      const s = this.index.sourceOf(id.client, id.clock); if (!s) break;
      id = s.src;
      const known = this.unitAt(id);
      if (known && !(known.item.content instanceof Y.ContentDeleted)) retained = known;
    }
    const original = this.unitAt(id);
    const collected = !original || original.item.content instanceof Y.ContentDeleted;
    if (collected) {
      if (depth > 4 || !(retained.item.parent instanceof Y.XmlText)) return null;
      // A copied word's original may already have been collected. Its copied
      // neighbors still locate it, even when Yjs merged them into one item.
      for (const following of [true, false]) {
        for (let neighbor = following ? this.next(retained, false) : this.prev(retained, false); neighbor;
          neighbor = following ? this.next(neighbor, false) : this.prev(neighbor, false)) {
          const key = Y.createID(neighbor.item.id.client, neighbor.item.id.clock + neighbor.off);
          if (!this.index.sourceOf(key.client, key.clock)) continue;
          const known = this.unitAt(this.sourceIdentity(key));
          if (!known || known.item.content instanceof Y.ContentDeleted) continue;
          const result = this.originalOf(neighbor, depth + 1);
          if (result) return result;
        }
      }
      return null;
    }
    const o = original;
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
/** `client` made copies of the record (not ones the server placed): it wrote the record */
function madeBy(r: MoveRecord, client: number): boolean {
  const e = r.entries;
  for (let i = 0; i < e.length; i += 6) if ((e[i + 3] === KEPT || e[i + 3] === MOVED) && e[i + 4] === client) return true;
  return false;
}

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
