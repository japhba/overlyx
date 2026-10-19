/**
 * An editor state bound to a model-2 CRDT (model.ts): what the editor changes goes into the CRDT,
 * what changes in the CRDT (others' edits, an agent's, a reload) comes into the editor — as
 * ProseMirror steps that replace just what changed, so that the selection, decorations, the undo
 * history and everything else that maps positions stays where it was.
 *
 * The CRDT is the truth; the editor's document is always what it reads as (read.ts). A local change
 * is written with the transactions' mapping (write.ts), so typed text goes exactly where it was
 * typed. A change from elsewhere is read incrementally and handed to `onRemote` with the
 * transaction that brings the editor there (`remoteTransaction`); the editor dispatches it, and the
 * binding learns the new document from it (`noteTransactions`).
 *
 * Undo is the editor's own (prosemirror-history): undoing is a local change like any other, mapped
 * over what others did meanwhile, so it never restores text that somebody else has since moved or
 * joined, and it restores deleted text in one piece.
 *
 * Headless (no view): the same calls drive an EditorState in tests and in the VS Code webview's
 * session; client/editor/collab wraps them in ProseMirror plugins.
 */
import type { Node as PMNode, Schema } from 'prosemirror-model';
import { EditorState, Selection, TextSelection, type Transaction } from 'prosemirror-state';
import { Mapping } from 'prosemirror-transform';
import * as Y from 'yjs';
import { BODY, PAGES, PAGE_ORDER } from './model.ts';
import { Reader } from './read.ts';
import { Writer } from './write.ts';
import { preciseSteps, type NodesOfMaps } from './steps.ts';

/** the meta key on transactions that bring the CRDT's changes into the editor (value: RemoteMeta) */
export const REMOTE_META = 'collabRemote';
export interface RemoteMeta {
  /** the Yjs transaction's origin (the provider, an agent's edit, …) */
  origin: unknown;
  /** the transaction changed the document (not only formatting cleanup) */
  remote: true;
  /** its steps are the CRDT's own (steps.ts) — false: a diff stood in for some (or all) */
  exact: boolean;
}

export interface BindingOptions {
  /** the Yjs origin of the editor's writes */
  origin?: unknown;
  /** a change from elsewhere: dispatch `tr` (made by remoteTransaction) now, or later (then call `catchUp`) */
  /** a change from elsewhere: what the CRDT now reads as, and the change (for remoteTransaction) */
  onRemote?: (reading: PMNode, change: RemoteChange) => void;
  /** a write did not read back as written (a bug): the reading wins */
  onMismatch?: (wrote: PMNode, reads: PMNode) => void;
  /** write every change as a whole-document diff, without the transactions' mapping (tests: the server's way) */
  diffOnly?: boolean;
}

export class Binding {
  readonly reader: Reader;
  readonly writer: Writer;
  readonly origin: unknown;
  /** what the CRDT reads as: the editor's document after the last transaction the binding knows of */
  doc: PMNode;
  /** the local changes since `doc` (their mapping), not written yet */
  private pending: Mapping | null = null;
  /** the document being written (the reading of the write's transaction must be it) */
  private writing: PMNode | null = null;
  private readonly roots: Y.AbstractType<any>[];
  private destroyed = false;

  constructor(readonly schema: Schema, readonly ydoc: Y.Doc, private opts: BindingOptions = {}) {
    this.origin = opts.origin ?? this;
    this.reader = new Reader(schema, ydoc);
    this.writer = new Writer(schema);
    this.doc = this.reader.read();
    this.roots = [ydoc.getText(BODY), ydoc.getMap(PAGES), ydoc.getArray(PAGE_ORDER)];
    ydoc.on('afterTransaction', this.afterTransaction);
  }

  /** who hears of changes from elsewhere and of mismatches (a new view of a kept binding) */
  setHandlers(h: Pick<BindingOptions, 'onRemote' | 'onMismatch'>): void {
    this.opts = { ...this.opts, ...h };
  }

  get isDestroyed(): boolean { return this.destroyed; }

  destroy(): void {
    this.destroyed = true;
    this.ydoc.off('afterTransaction', this.afterTransaction);
  }

  /**
   * Transactions the editor applied (in order): local ones are remembered for the next write,
   * remote ones (REMOTE_META) say what the document now is.
   */
  noteTransactions(trs: readonly Transaction[]): void {
    for (const tr of trs) {
      if (tr.getMeta(REMOTE_META)) {
        this.doc = tr.doc;
        this.pending = null;
        if (tr.doc !== this.reading && this.reading && tr.doc.eq(this.reading)) this.reader.adopt(tr.doc);
        continue;
      }
      if (!tr.docChanged) continue;
      if (tr.before !== (this.pending ? this.pendingTo : this.doc)) {
        // not a continuation of what is known (a state replaced from outside): written as a diff
        this.pending = null;
        this.pendingTo = tr.doc;
        this.unmapped = true;
        continue;
      }
      if (!this.pending) this.pending = new Mapping();
      this.pending.appendMapping(tr.mapping);
      this.pendingTo = tr.doc;
    }
  }
  private pendingTo: PMNode | null = null;
  private unmapped = false;
  /** the last reading handed to onRemote (or read after an own write) */
  private reading: PMNode | null = null;
  /** what the CRDT reads as now (as last read) */
  get latest(): PMNode { return this.reading ?? this.doc; }

  /** Write the editor's document `next` into the CRDT (after the transactions noted). */
  flush(next: PMNode): void {
    if (this.destroyed || next === this.doc) { this.pending = null; this.unmapped = false; return; }
    const mapping = !this.opts.diffOnly && !this.unmapped && this.pendingTo === next ? this.pending : null;
    const old = this.doc;
    this.writing = next;
    try {
      this.ydoc.transact(() => this.writer.writeDoc(this.ydoc, old, next, mapping), this.origin);
    } finally {
      this.writing = null;
      this.pending = null;
      this.pendingTo = null;
      this.unmapped = false;
    }
    // the reading of the write (afterTransaction) replaced `doc` if it differed; else it is `next`
    if (this.doc === old) this.doc = next;
  }

  private afterTransaction = (ytr: Y.Transaction): void => {
    if (this.destroyed) return;
    if (!this.roots.some(r => ytr.changedParentTypes.has(r) || ytr.changed.has(r))) return;
    // the nodes the maps under change stood for, before the reading replaces them (where the
    // transaction's flows and nodes were: steps.ts)
    const was = new Map<Y.Map<unknown>, PMNode>();
    for (const t of ytr.changedParentTypes.keys()) {
      if (!(t instanceof Y.Map)) continue;
      const n = this.reader.nodeOf(t as Y.Map<unknown>);
      if (n) was.set(t as Y.Map<unknown>, n);
    }
    const reading = this.reader.read(ytr);
    const change = (base: PMNode | null): RemoteChange => ({ ytr, ydoc: this.ydoc, base, nodes: { before: m => was.get(m), after: m => this.reader.nodeOf(m) } });
    if (this.writing) {
      const wrote = this.writing;
      if (reading === wrote || reading.eq(wrote)) { this.reader.adopt(wrote); this.doc = wrote; this.reading = wrote; return; }
      this.opts.onMismatch?.(wrote, reading);
      // the CRDT wins: the editor is brought to what it reads as (from `wrote`, which the transaction did not start from)
      this.doc = wrote;
      this.reading = reading;
      this.opts.onRemote?.(reading, change(null));
      return;
    }
    if (reading === this.doc || reading.eq(this.doc)) { this.reader.adopt(this.doc); this.reading = this.doc; return; }
    this.reading = reading;
    this.opts.onRemote?.(reading, change(this.doc));
  };
}

/**
 * A change from elsewhere (Binding onRemote): the Yjs transaction, the document it started from
 * (null: not one the editor shows), and the nodes the CRDT's maps stood for before and after it.
 */
export interface RemoteChange { ytr: Y.Transaction; ydoc: Y.Doc; base: PMNode | null; nodes?: NodesOfMaps }

/**
 * The transaction that brings `state` to `next` (the CRDT's reading). With the Yjs transaction that
 * made the change (`change`, when the editor shows the document it started from), its exact steps (steps.ts: positions from the Yjs deltas); what those do
 * not express, and everything without `ytr`, as replace steps over just what differs. The
 * selection follows (an empty one stays before what was inserted where it is).
 */
export function remoteTransaction(state: EditorState, next: PMNode, origin: unknown, change?: RemoteChange | null): Transaction {
  const tr = state.tr;
  // the transaction's positions are those of the document it started from: the editor must show it
  if (change?.base && (change.base === state.doc || change.base.eq(state.doc))) {
    const { ytr, ydoc, nodes } = change;
    try { preciseSteps(tr, state.doc, next, ytr, ydoc, state.schema, nodes); } catch { /* the diff below does it all */ }
  }
  const exact = tr.doc.eq(next);
  if (!exact) diffSteps(tr, next);
  if (!tr.doc.eq(next)) {
    // the steps did not give the reading (should not happen): the whole document instead
    const t2 = state.tr.replaceWith(0, state.doc.content.size, next.content);
    return finish(state, t2, origin, false);
  }
  return finish(state, tr, origin, exact);
}

/** replace steps over what differs between `tr.doc` and `next` (top-level children that are the same node objects anchor it) */
function diffSteps(tr: Transaction, next: PMNode): void {
  const a = tr.doc;
  if (a === next || a.eq(next)) return;
  const ac: PMNode[] = [], bc: PMNode[] = [];
  a.forEach(c => ac.push(c));
  next.forEach(c => bc.push(c));
  const posA: number[] = [0], posB: number[] = [0];
  for (const c of ac) posA.push(posA[posA.length - 1] + c.nodeSize);
  for (const c of bc) posB.push(posB[posB.length - 1] + c.nodeSize);
  const gaps: [number, number, number, number][] = [];
  let i = 0, j = 0;
  const indexB = new Map<PMNode, number>();
  bc.forEach((c, k) => { if (!indexB.has(c)) indexB.set(c, k); });
  while (i < ac.length || j < bc.length) {
    if (i < ac.length && j < bc.length && (ac[i] === bc[j] || ac[i].eq(bc[j]))) { i++; j++; continue; }
    // the next anchor: an old child that is still there further on
    let ni = i, nj = -1;
    for (; ni < ac.length; ni++) { const k = indexB.get(ac[ni]); if (k !== undefined && k >= j) { nj = k; break; } }
    if (nj < 0) { ni = ac.length; nj = bc.length; }
    gaps.push([i, ni, j, nj]);
    i = ni; j = nj;
  }
  // from the last gap: the positions before a gap stay valid
  for (let g = gaps.length - 1; g >= 0; g--) {
    const [i0, i1, j0, j1] = gaps[g];
    const fa = a.content.cut(posA[i0], posA[i1]), fb = next.content.cut(posB[j0], posB[j1]);
    const s0 = fa.findDiffStart(fb);
    if (s0 == null) continue;
    // relative to the gap's start (in both documents)
    const end = fa.findDiffEnd(fb)!;
    let eA = end.a, eB = end.b;
    if (eA < s0 && fa.size < fb.size) { eB = s0 + (eB - eA); eA = s0; }
    else if (eB < s0) { eA = s0 + (eA - eB); eB = s0; }
    try { tr.replace(posA[i0] + s0, posA[i0] + eA, next.slice(posB[j0] + s0, posB[j0] + eB)); }
    catch { tr.replaceWith(posA[i0], posA[i1], fb); }
  }
}

function finish(state: EditorState, tr: Transaction, origin: unknown, exact: boolean): Transaction {
  // an empty selection stays before text inserted where it is (it stays after what its owner typed)
  const sel = state.selection;
  if (sel instanceof TextSelection && tr.docChanged) {
    try {
      const anchor = tr.mapping.map(sel.anchor, -1), head = tr.mapping.map(sel.head, -1);
      const $a = tr.doc.resolve(anchor), $h = tr.doc.resolve(head);
      if ($a.parent.inlineContent && $h.parent.inlineContent) tr.setSelection(TextSelection.between($a, $h));
    } catch { tr.setSelection(Selection.near(tr.doc.resolve(Math.min(tr.mapping.map(sel.head), tr.doc.content.size)))); }
  }
  const meta: RemoteMeta = { origin, remote: true, exact };
  return tr.setMeta(REMOTE_META, meta).setMeta('addToHistory', false);
}
