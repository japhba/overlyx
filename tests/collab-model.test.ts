/**
 * The document model in the CRDT (packages/core/src/collab, model 2): reading, writing, the binding
 * of an editor state, and what concurrent editing does to them.
 *
 * The random test lets three peers edit the way an editor does — ProseMirror commands on editor
 * states bound to their CRDTs (collab/binding.ts), undo with ProseMirror's history — deliver their
 * updates in any order, go offline and come back. Every word anybody types is unique and is followed
 * by its Yjs identity (the items of its characters). The checks:
 *  - a word nobody deleted — no edit or undo of any peer deleted one of its characters, and no
 *    container it is in was deleted — is in the end document exactly once, in one piece;
 *  - no word is ever in a document twice;
 *  - an edit never puts a word together from pieces (letters of it kept, letters of it inserted
 *    anew): when a word is moved (ProseMirror moving text into a note) it is moved whole;
 *  - every reading (incremental, after each transaction) equals a fresh one, and the peers agree.
 */
import { describe, it, expect } from 'vitest';
import * as Y from 'yjs';
import { EditorState, TextSelection, type Transaction, type Command } from 'prosemirror-state';
import { Mapping } from 'prosemirror-transform';
import { splitBlock, joinBackward, deleteSelection } from 'prosemirror-commands';
import { history, undo } from 'prosemirror-history';
import type { Node as PMNode } from 'prosemirror-model';
import { schema } from '@overlyx/core';
import { Reader, Binding, remoteTransaction, BODY, REMOTE_META, type RemoteMeta } from '@overlyx/core/collab/index.ts';

const par = (text: string, attrs?: Record<string, unknown>) => schema.nodes.paragraph.create(attrs ?? null, text ? schema.text(text) : null);

/** a replica: a Y.Doc and an editor state bound to it */
class Replica {
  ydoc = new Y.Doc({ gc: false });   // deleted text stays readable for the checks
  binding: Binding;
  state!: EditorState;
  outbox: Uint8Array[] = [];
  constructor(id: number, opts: { diffOnly?: boolean } = {}) {
    this.ydoc.clientID = id;
    this.binding = new Binding(schema, this.ydoc, {
      diffOnly: opts.diffOnly,
      onRemote: (reading, change) => {
        const tr = remoteTransaction(this.state, reading, 'net', process.env.OVERLYX_COLLAB_DIFF_STEPS ? null : change);
        // every change from elsewhere comes as the CRDT's own steps (steps.ts), not as a diff
        if (!process.env.OVERLYX_COLLAB_DIFF_STEPS && !(tr.getMeta(REMOTE_META) as RemoteMeta).exact) throw new Error(`a change from elsewhere did not come as its own steps\nhad   ${JSON.stringify(this.state.doc.toJSON()).slice(0, 1500)}\nreads ${JSON.stringify(reading.toJSON()).slice(0, 1500)}`);
        this.apply(tr);
      },
      onMismatch: (wrote, reads) => { throw new Error(`a write did not read back\nwrote ${JSON.stringify(wrote.toJSON()).slice(0, 2000)}\nreads ${JSON.stringify(reads.toJSON()).slice(0, 2000)}`); },
    });
    this.reset();
    this.ydoc.on('update', (u: Uint8Array, origin: unknown) => { if (origin !== 'net') this.outbox.push(u); });
  }
  /** a fresh editor state (empty history) on what the CRDT reads as */
  reset(): void { this.state = EditorState.create({ schema, doc: this.binding.doc, plugins: [history({ newGroupDelay: 0 })] }); }
  get doc(): PMNode { return this.state.doc; }
  /** the steps of the last transactions (TRACE_STEP), and their mapping (since the step began) */
  lastSteps: unknown[] = [];
  mapping = new Mapping();
  /** apply a transaction to the state (as a view would) and write what changed */
  apply(tr: Transaction): void {
    if (process.env.TRACE_STEP && tr.docChanged) this.lastSteps.push(...tr.steps.map(s => s.toJSON()));
    const { state, transactions } = this.state.applyTransaction(tr);
    if (!tr.getMeta('collabRemote')) for (const t of transactions) this.mapping.appendMapping(t.mapping);
    this.state = state;
    this.binding.noteTransactions(transactions);
    if (!tr.getMeta('collabRemote')) this.binding.flush(state.doc);
  }
  run(cmd: Command): boolean { return cmd(this.state, tr => this.apply(tr)); }
  receive(u: Uint8Array): void { Y.applyUpdate(this.ydoc, u, 'net'); }
  fresh(): PMNode { return new Reader(schema, this.ydoc).read(); }
}

describe('collab model: reading and writing', () => {
  it('a split inserts one marker; a join deletes it; nothing is copied', () => {
    const a = new Replica(1);
    a.apply(a.state.tr.replaceWith(0, a.doc.content.size, [par('Title', { layout: 'Section' }), par('one two three')]));
    const sv = Y.encodeStateVector(a.ydoc);
    const deletedBefore = countDeleted(a.ydoc);
    a.apply(a.state.tr.setSelection(TextSelection.create(a.doc, a.doc.child(0).nodeSize + 1 + 'one two'.length)));
    expect(a.run(splitBlock)).toBe(true);
    const update = Y.decodeUpdate(Y.encodeStateAsUpdate(a.ydoc, sv));
    // the marker: an embedded map and its type entry; no text
    expect(update.structs.length).toBe(2);
    for (const st of update.structs) expect((st as Y.Item).content?.constructor?.name).not.toBe('ContentString');
    expect(countDeleted(a.ydoc)).toBe(deletedBefore);
    expect(a.doc.childCount).toBe(3);
    a.apply(a.state.tr.setSelection(TextSelection.create(a.doc, a.doc.child(0).nodeSize + a.doc.child(1).nodeSize + 1)));
    expect(a.run(joinBackward)).toBe(true);
    expect(a.doc.childCount).toBe(2);
    expect(a.doc.child(1).textContent).toBe('one two three');
    expect(a.doc.eq(a.fresh())).toBe(true);
  });

  it('formatting formats; a style change sets the marker; nothing is re-inserted', () => {
    const a = new Replica(1);
    a.apply(a.state.tr.replaceWith(0, a.doc.content.size, par('alpha beta gamma')));
    const sv = Y.encodeStateVector(a.ydoc);
    a.apply(a.state.tr.addMark(1, 6, schema.marks.series.create({ value: 'bold' })).setNodeMarkup(0, undefined, { ...a.doc.child(0).attrs, layout: 'Section' }));
    const update = Y.decodeUpdate(Y.encodeStateAsUpdate(a.ydoc, sv));
    for (const st of update.structs) expect((st as Y.Item).content?.constructor?.name ?? 'GC').not.toBe('ContentString');
    expect(a.doc.child(0).attrs.layout).toBe('Section');
    expect(a.doc.eq(a.fresh())).toBe(true);
  });

  it('typing next to a word that begins with the same letter inserts the typed word itself', () => {
    const a = new Replica(1), b = new Replica(2);
    a.apply(a.state.tr.replaceWith(0, a.doc.content.size, par('apple avocado')));
    b.receive(Y.encodeStateAsUpdate(a.ydoc));
    // a types "anchor " before "avocado"; b deletes "avocado" meanwhile
    a.apply(a.state.tr.insertText('anchor ', 1 + 'apple '.length));
    b.apply(b.state.tr.delete(1 + 'apple '.length, 1 + 'apple avocado'.length));
    for (const u of a.outbox) b.receive(u);
    for (const u of b.outbox) a.receive(u);
    expect(a.doc.textContent).toBe('apple anchor ');
    expect(b.doc.eq(a.doc)).toBe(true);
  });

  it('text a deletion lifts out of a note is new text there: it takes no letter the deletion removed', () => {
    const a = new Replica(1), b = new Replica(2);
    const note = schema.nodes.inset.create({ name: 'Note', arg: 'Note' }, par('cedar wood'));
    b.apply(b.state.tr.replaceWith(0, b.doc.content.size, schema.nodes.paragraph.create(null, [schema.text('basic '), note])));
    a.receive(Y.encodeStateAsUpdate(b.ydoc));
    // from after "basi" into the note, before "cedar": the note's text comes out after "basi"
    a.apply(a.state.tr.setSelection(TextSelection.create(a.doc, 1 + 'basi'.length, 1 + 'basic '.length + 2)));
    a.run(deleteSelection);
    expect(a.doc.textContent).toBe('basicedar wood');
    // "cedar" is all new characters (a's): not the "c" of "basic" (b's), which the deletion removed
    const cedar = occurrences(a.ydoc, 'cedar');
    expect(cedar.length).toBe(1);
    expect(cedar[0].map(c => c.client)).toEqual([1, 1, 1, 1, 1]);
  });

  it('concurrent: one splits a paragraph while another types into its second half', () => {
    const a = new Replica(1), b = new Replica(2);
    a.apply(a.state.tr.replaceWith(0, a.doc.content.size, par('first part second part')));
    b.receive(Y.encodeStateAsUpdate(a.ydoc)); a.outbox = [];
    a.apply(a.state.tr.setSelection(TextSelection.create(a.doc, 1 + 'first part '.length)));
    a.run(splitBlock);
    b.apply(b.state.tr.insertText('XX', 1 + 'first part second'.length));
    for (const u of a.outbox) b.receive(u);
    for (const u of b.outbox) a.receive(u);
    expect(a.doc.eq(b.doc)).toBe(true);
    expect(a.doc.childCount).toBe(2);
    expect(a.doc.child(1).textContent).toBe('secondXX part');
  });

  it('undoing an Enter that somebody joined back meanwhile changes nothing', () => {
    const a = new Replica(1), b = new Replica(2);
    a.apply(a.state.tr.replaceWith(0, a.doc.content.size, par('one two')));
    a.reset();
    b.receive(Y.encodeStateAsUpdate(a.ydoc)); a.outbox = [];
    a.apply(a.state.tr.setSelection(TextSelection.create(a.doc, 1 + 'one '.length)));
    a.run(splitBlock);
    for (const u of a.outbox.splice(0)) b.receive(u);
    b.apply(b.state.tr.setSelection(TextSelection.create(b.doc, b.doc.child(0).nodeSize + 1)));
    b.run(joinBackward);
    for (const u of b.outbox.splice(0)) a.receive(u);
    expect(a.doc.childCount).toBe(1);
    a.run(undo);
    for (const u of a.outbox.splice(0)) b.receive(u);
    expect(a.doc.textContent).toBe('one two');
    expect(b.doc.eq(a.doc)).toBe(true);
  });
});

function countDeleted(ydoc: Y.Doc): number {
  let n = 0;
  for (const structs of ydoc.store.clients.values()) for (const s of structs) if (s.deleted) n += s.length;
  return n;
}

// ---------------------------------------------------------------- the random test

/** a small deterministic random generator */
function rng(seed: number) {
  let x = seed >>> 0 || 1;
  const next = () => { x ^= x << 13; x >>>= 0; x ^= x >>> 17; x ^= x << 5; x >>>= 0; return x / 4294967296; };
  return { next, int: (n: number) => Math.floor(next() * n), pick: <T>(a: readonly T[]) => a[Math.floor(next() * a.length)], chance: (p: number) => next() < p };
}

/** text positions in a document: whether at a word boundary, whether at a paragraph's start */
function textPositions(doc: PMNode): { pos: number; boundary: boolean; parStart: boolean }[] {
  const out: { pos: number; boundary: boolean; parStart: boolean }[] = [];
  doc.descendants((n, pos) => {
    if (!n.isTextblock) return true;
    const start = pos + 1;
    out.push({ pos: start, boundary: true, parStart: true });
    let p = start;
    n.forEach(c => {
      if (c.isText) {
        for (let i = 0; i < c.text!.length; i++) { p++; out.push({ pos: p, boundary: c.text![i] === ' ', parStart: false }); }
      } else { p += c.nodeSize; out.push({ pos: p, boundary: true, parStart: false }); }
    });
    return true;
  });
  return out;
}

/** each paragraph's own text (an inset's paragraphs are paragraphs of their own), inline nodes as " | " */
function allText(doc: PMNode): string {
  const parts: string[] = [];
  doc.descendants(n => { if (n.isTextblock) { let t = ''; n.forEach(c => { t += c.isText ? c.text : ' | '; }); parts.push(t); } return true; });
  return parts.join('\n');
}

/** the positions of a word's characters in a document (it occurs once at most; null: not there) */
function charPositions(doc: PMNode, word: string): number[] | null {
  let text = '';
  const pos: number[] = [];
  doc.descendants((n, p) => {
    if (n.isText) { for (let k = 0; k < n.text!.length; k++) { text += n.text![k]; pos.push(p + k); } }
    else if (n.isInline || n.isTextblock) { text += '\u0001'; pos.push(-1); }
    return true;
  });
  const k = text.indexOf(word);
  return k < 0 ? null : pos.slice(k, k + word.length);
}

/** a word's identity: the ids of its characters */
type Chars = { client: number; clock: number }[];
type Ident = Chars;

/** where a word is now: each live occurrence as its characters' ids */
function occurrences(ydoc: Y.Doc, word: string): Chars[] {
  const out: Chars[] = [];
  const walk = (flow: Y.Text) => {
    let text = '';
    const ids: { client: number; clock: number }[] = [];
    for (let it = flow._start; it; it = it.right) {
      if (it.deleted) continue;
      if (it.content instanceof Y.ContentString) {
        text += it.content.str;
        for (let k = 0; k < it.content.str.length; k++) ids.push({ client: it.id.client, clock: it.id.clock + k });
      } else if (it.countable) { text += '\u0001'; ids.push({ client: -1, clock: -1 }); }
      if (it.content instanceof Y.ContentType && it.content.type instanceof Y.Map) { const b = (it.content.type as Y.Map<unknown>).get('$body'); if (b instanceof Y.Text) walk(b); }
    }
    for (let k = text.indexOf(word); k >= 0; k = text.indexOf(word, k + 1)) out.push(ids.slice(k, k + word.length));
  };
  walk(ydoc.getText(BODY));
  return out;
}

const isIdent = (chars: Chars, id: Ident) => chars.length === id.length && chars.every((c, k) => c.client === id[k].client && c.clock === id[k].clock);

/** the word's text was deleted with a container (an inset deleted while it was typed into) */
function containerDeleted(ydoc: Y.Doc, id: Ident): boolean {
  const st = (ydoc.store.clients.get(id[0].client) ?? []).find(s => s.id.clock <= id[0].clock && id[0].clock < s.id.clock + s.length);
  if (!(st instanceof Y.Item)) return false;
  for (let t: Y.AbstractType<any> | null = st.parent as Y.AbstractType<any>; t && t._item; t = t._item.parent as Y.AbstractType<any>) if (t._item.deleted) return true;
  return false;
}

function runRandom(seed: number, steps: number, diffing = false) {
  const r = rng(seed);
  const newWord = () => { let x = ''; for (let k = 0; k < 9; k++) x += 'abcdefghijklmnopqrstuvwxyz'[r.int(26)]; return x; };
  const peers = [new Replica(11, { diffOnly: diffing }), new Replica(22), new Replica(33)];
  /** each word's identities: the original, and every copy a move made (two peers moving it at once: two copies) */
  const ident = new Map<string, Ident[]>();
  const known = (word: string, chars: Chars) => (ident.get(word) ?? []).some(id => isIdent(chars, id));
  const touched = new Set<string>();
  const log: string[] = [];
  let step = -1;
  const fail = (msg: string): never => { throw new Error(`seed ${seed} step ${step}: ${msg}\n${log.slice(-15).join('\n')}`); };

  // each peer's own writes (deleted ids, the clocks before), for the words' identities
  let writes: { tr: Y.Transaction }[] = [];
  for (const p of peers) p.ydoc.on('afterTransaction', (tr: Y.Transaction) => {
    if (tr.origin === p.binding.origin) writes.push({ tr });
    const del = process.env.FIND_DEL?.split(':').map(Number);
    if (del && tr.deleteSet.clients.size && Y.isDeleted(tr.deleteSet, { client: del[0], clock: del[1] })) console.log(`DELETED ${process.env.FIND_DEL} at step ${step} by ${p.ydoc.clientID} (${tr.origin === p.binding.origin ? 'its own edit' : 'applying ' + String(tr.origin?.toString?.() ?? tr.origin)}), op ${log[log.length - 1]}`);
    const find = process.env.FIND_ID?.split(':').map(Number);
    if (find && find[0] === p.ydoc.clientID && (tr.beforeState.get(find[0]) ?? 0) <= find[1] && find[1] < (tr.afterState.get(find[0]) ?? 0)) console.log(`FOUND ${process.env.FIND_ID} made at step ${step} by ${p.ydoc.clientID}, origin ${String(tr.origin?.toString?.() ?? tr.origin)}, op ${log[log.length - 1]}`);
  });

  /** after a peer's own edit: the identities of the words it typed, moved or deleted */
  const settle = (p: Replica, i: number, typedNow: string[], before: PMNode | null = null) => {
    const ws = writes;
    writes = [];
    if (!ws.length) return;
    const isNew = (c: { client: number; clock: number }) => c.client === p.ydoc.clientID && ws.some(w => c.clock >= (w.tr.beforeState.get(c.client) ?? 0) && c.clock < (w.tr.afterState.get(c.client) ?? 0));
    for (const word of typedNow) {
      const occ = occurrences(p.ydoc, word);
      if (occ.length !== 1) fail(`typed ${word} is there ${occ.length} times`);
      if (!occ[0].every(isNew)) fail(`typed ${word} is not all new text`);
      ident.set(word, [occ[0]]);
      if (process.env.TRACE_WORD === word) console.log(`WORD step ${step} peer ${i}: typed ${occ[0].map(c => c.client + ':' + c.clock).join(',')}`);
    }
    for (const [word, ids] of ident) {
      if (touched.has(word) || typedNow.includes(word)) continue;
      // the edit itself deleted a letter of it (its steps' mapping): touched, whatever was written
      const at0 = before ? charPositions(before, word) : null;
      if (at0 && at0.some(pos => p.mapping.mapResult(pos, 1).deleted)) {
        // unless it was moved whole: then it is there anew
        const occ = occurrences(p.ydoc, word);
        const fresh = occ.filter(o => o.every(isNew));
        if (fresh.length === 1 && occ.length === 1) { ids.push(fresh[0]); continue; }
        touched.add(word);
        continue;
      }
      let deleted = false;
      for (const id of ids) for (const c of id) for (const w of ws) if (Y.isDeleted(w.tr.deleteSet, c)) deleted = true;
      if (!deleted) continue;
      // moved whole (new text, as a move that re-inserts it makes): a new identity; else, when the
      // edit itself deleted a letter of it (its steps' mapping), touched; anything else is a bug
      const occ = occurrences(p.ydoc, word);
      const moved = occ.filter(o => o.every(isNew));
      if (moved.length === 1) { ids.push(moved[0]); if (process.env.TRACE_WORD === word) console.log(`WORD step ${step} peer ${i}: moved`); continue; }
      const at = before ? charPositions(before, word) : null;
      if (at && at.some(pos => p.mapping.mapResult(pos, 1).deleted)) { touched.add(word); continue; }
      const mixed = occ.filter(o => o.some(isNew) && !moved.includes(o));
      if (mixed.length) fail(`${word} put together from pieces by peer ${i}`);
      if (process.env.TRACE_WORD === word) console.log(`WORD step ${step} peer ${i}: touched (${occ.length} occurrences after) ${log[log.length - 1] ?? ''}`);
      touched.add(word);
    }
    // nothing may be copied by an edit that did not move it (a deleted word may come back twice: an
    // undo re-inserting it while somebody else moved it is two copies, as two moves are)
    for (const word of ident.keys()) {
      if (touched.has(word)) continue;
      const occ = occurrences(p.ydoc, word);
      if (occ.length > 1 && !occ.every(o => known(word, o))) fail(`${word} twice after an edit of peer ${i}`);
    }
  };

  // the first document
  const init = Array.from({ length: 6 }, () => newWord());
  peers[0].apply(peers[0].state.tr.replaceWith(0, peers[0].doc.content.size, [par(init.slice(0, 3).join(' ') + ' '), par(init.slice(3, 5).join(' ') + ' '), par(init[5] + ' ')]));
  settle(peers[0], 0, init);
  peers[0].reset();
  for (const p of peers.slice(1)) p.receive(Y.encodeStateAsUpdate(peers[0].ydoc));
  peers[0].outbox = [];

  const queues = peers.map(() => peers.map(() => [] as Uint8Array[]));
  const online = peers.map(() => true);
  const flush = (i: number) => { for (const u of peers[i].outbox) for (let j = 0; j < peers.length; j++) if (j !== i) queues[i][j].push(u); peers[i].outbox = []; };
  const deliver = (j: number, u: Uint8Array) => {
    peers[j].receive(u);
    writes = [];
    const q = peers[j];
    if (!q.doc.eq(q.fresh())) fail(`the document of ${j} is not what its CRDT reads as`);
    if (process.env.TRACE_WORD && ident.has(process.env.TRACE_WORD)) console.log(`WORD step ${step} → ${j}: ${occurrences(q.ydoc, process.env.TRACE_WORD).map(o => o.map(c => c.client + ':' + c.clock).join(',')).join(' | ')}`);
    for (const word of ident.keys()) {
      if (touched.has(word)) continue;
      const occ = occurrences(q.ydoc, word);
      // more than once only as copies of moves (two peers moved it at once)
      if (occ.length > 1 && !occ.every(o => known(word, o))) fail(`${word} twice at ${j}`);
    }
  };

  for (step = 0; step < steps; step++) {
    const i = r.int(peers.length);
    const p = peers[i];
    const positions = textPositions(p.doc);
    const at = (pos: number) => p.apply(p.state.tr.setSelection(TextSelection.create(p.doc, pos)));
    const typedNow: string[] = [];
    const kind = r.int(100);
    const traceThis = process.env.TRACE_STEP !== undefined && Number(process.env.TRACE_STEP) === step;
    p.lastSteps = [];
    p.mapping = new Mapping();
    const docBefore = p.doc;
    try {
      if (kind < 30) {
        const b = r.pick(positions.filter(x => x.boundary));
        const word = newWord();
        typedNow.push(word);
        at(b.pos);
        const before = p.doc.textBetween(Math.max(0, b.pos - 1), b.pos);
        p.apply(p.state.tr.insertText(b.parStart || before === ' ' ? word + ' ' : ' ' + word));
        log.push(`${i} type ${word} @${b.pos}`);
      } else if (kind < 45) {
        at(r.pick(positions.filter(x => x.boundary)).pos);
        p.run(splitBlock);
        log.push(`${i} enter`);
      } else if (kind < 55) {
        at(r.pick(positions.filter(x => x.parStart)).pos);
        p.run(joinBackward);
        log.push(`${i} join`);
      } else if (kind < 63) {
        const a = r.pick(positions), b = r.pick(positions);
        const from = Math.min(a.pos, b.pos), to = Math.max(a.pos, b.pos);
        if (to > from && to - from < 40) {
          p.apply(p.state.tr.setSelection(TextSelection.create(p.doc, from, to)));
          p.run(deleteSelection);
          log.push(`${i} delete ${from}-${to}`);
        }
      } else if (kind < 71) {
        const a = r.pick(positions), b = r.pick(positions);
        const from = Math.min(a.pos, b.pos), to = Math.max(a.pos, b.pos);
        const mark = r.chance(0.5) ? schema.marks.series.create({ value: 'bold' }) : schema.marks.emph.create({ value: 'on' });
        if (to > from) p.apply(r.chance(0.7) ? p.state.tr.addMark(from, to, mark) : p.state.tr.removeMark(from, to, mark.type));
        log.push(`${i} format ${from}-${to}`);
      } else if (kind < 77) {
        const b = r.pick(positions.filter(x => x.parStart));
        const $p = p.doc.resolve(b.pos);
        p.apply(p.state.tr.setNodeMarkup($p.before(), undefined, { ...$p.parent.attrs, layout: r.pick(['Standard', 'Section', 'Itemize', 'Enumerate']) }));
        log.push(`${i} style @${b.pos}`);
      } else if (kind < 83) {
        const formulas: number[] = [];
        p.doc.descendants((n, pos) => { if (n.type.name === 'math_inline') formulas.push(pos); return true; });
        if (formulas.length && r.chance(0.5)) {
          const fp = r.pick(formulas);
          const n = p.doc.nodeAt(fp)!;
          p.apply(p.state.tr.setNodeMarkup(fp, undefined, { ...n.attrs, latex: n.attrs.latex + 'x' }));
          log.push(`${i} formula edit @${fp}`);
        } else {
          const b = r.pick(positions.filter(x => x.boundary));
          p.apply(p.state.tr.insert(b.pos, schema.nodes.math_inline.create({ latex: 'f' })));
          log.push(`${i} formula @${b.pos}`);
        }
      } else if (kind < 88) {
        const b = r.pick(positions.filter(x => x.boundary));
        const word = newWord();
        typedNow.push(word);
        p.apply(p.state.tr.insert(b.pos, schema.nodes.inset.create({ name: 'Note', arg: 'Note' }, par(word + ' '))));
        log.push(`${i} note ${word} @${b.pos}`);
      } else if (kind < 94) {
        p.run(undo);
        log.push(`${i} undo`);
      } else {
        online[i] = !online[i];
        log.push(`${i} ${online[i] ? 'online' : 'offline'}`);
      }
      if (!p.doc.eq(p.fresh())) fail('the document is not what its CRDT reads as');
      if (traceThis) {
        const show = (y: Y.Text): string => y.toDelta().map((d: any) => typeof d.insert === 'string' ? d.insert : '[' + d.insert.get('$t') + (d.insert.get('$body') ? ' ' + show(d.insert.get('$body')) : '') + ']').join('');
        console.log(`TRACE peer ${i} ${log[log.length - 1]}\nsteps ${JSON.stringify(p.lastSteps)}\nbefore ${allText(docBefore).replace(/\n/g, ' ¶ ')}\nafter  ${allText(p.doc).replace(/\n/g, ' ¶ ')}\nY ${show(p.ydoc.getText(BODY))}`);
        for (const w of writes) {
          const ins: string[] = [];
          for (const [client, clock] of w.tr.afterState) { const from = w.tr.beforeState.get(client) ?? 0; for (const st of p.ydoc.store.clients.get(client) ?? []) if (st.id.clock + st.length > from && st.id.clock < clock && st instanceof Y.Item) ins.push(st.content instanceof Y.ContentString ? JSON.stringify(st.content.str) : st.content.constructor.name); }
          const dels: string[] = [];
          Y.iterateDeletedStructs(w.tr, w.tr.deleteSet, st => { if (st instanceof Y.Item) dels.push(st.content instanceof Y.ContentString ? JSON.stringify(st.content.str) : st.content.constructor.name); });
          console.log('  ins', ins.join(' '), '\n  del', dels.join(' '));
        }
        require('fs').writeFileSync('/tmp/claude-0/-root/f7a517a7-ebe6-4c3d-938c-3147d563d36c/scratchpad/step.json', JSON.stringify({ before: docBefore.toJSON(), after: p.doc.toJSON() }));
      }
      if (process.env.TRACE_LOG) console.log(`LOG ${step}: ${log[log.length - 1]}`);
      settle(p, i, typedNow, docBefore);
    } catch (e) {
      if ((e as Error).message.startsWith(`seed ${seed}`)) throw e;
      fail((e as Error).stack ?? String(e));
    }
    flush(i);
    for (let k = 0; k < 3; k++) {
      const from = r.int(peers.length), to = r.int(peers.length);
      if (from === to || !online[from] || !online[to]) continue;
      for (const u of queues[from][to].splice(0, r.int(queues[from][to].length + 1))) deliver(to, u);
    }
  }
  // everybody online, everything delivered (Yjs' formatting clean-ups make more updates: until quiet)
  for (let round = 0; round < 8; round++) {
    for (let i = 0; i < peers.length; i++) flush(i);
    for (let from = 0; from < peers.length; from++) for (let to = 0; to < peers.length; to++) if (from !== to) for (const u of queues[from][to].splice(0)) deliver(to, u);
  }
  const final = peers[0].doc;
  for (const q of peers) {
    expect(q.doc.eq(q.fresh()), `seed ${seed}: the editor shows what the CRDT reads as`).toBe(true);
    expect(q.doc.eq(final), `seed ${seed}: the replicas agree`).toBe(true);
  }
  final.check();
  for (const [word, ids] of ident) {
    if (touched.has(word) || ids.some(id => containerDeleted(peers[0].ydoc, id))) continue;
    const occ = occurrences(peers[0].ydoc, word);
    if (occ.length > 1 && !occ.every(o => known(word, o))) fail(`${word} is there ${occ.length} times`);
    if (occ.length < 1 || !occ.every(o => known(word, o))) {
      // where its characters are
      const id = ids[0];
      const walk = (flow: Y.Text, depth: number): string[] => {
        const out: string[] = [];
        let line = '';
        for (let it = flow._start; it; it = it.right) {
          const c = it.content;
          const mine = it.id.client === id[0].client && it.id.clock <= id[id.length - 1].clock && it.id.clock + it.length > id[0].clock;
          const t = c instanceof Y.ContentString ? c.str : c instanceof Y.ContentType && c.type instanceof Y.Map ? `<${(c.type as Y.Map<unknown>).get('$t')}>` : c instanceof Y.ContentFormat ? `{${c.key}=${c.value === null ? '∅' : 'on'}}` : '';
          if (!t) continue;
          line += (it.deleted ? "[" + t + "]" : t) + (mine ? `«${it.id.client}:${it.id.clock}»` : `‹${it.id.client}:${it.id.clock}›`);
          if (c instanceof Y.ContentType && c.type instanceof Y.Map) { const b = (c.type as Y.Map<unknown>).get('$body'); if (b instanceof Y.Text) out.push(...walk(b, depth + 1).map(l => '  ' + l)); }
        }
        return [`${depth}: ${line}`, ...out];
      };
      const lines = walk(peers[0].ydoc.getText(BODY), 0).filter(l => l.includes('«'));
      // each character's item: deleted?, and the chain of parents up to the root
      for (const c of id) {
        const st = (peers[0].ydoc.store.clients.get(c.client) ?? []).find(x => x.id.clock <= c.clock && c.clock < x.id.clock + x.length) as Y.Item | undefined;
        if (!st) { lines.push(`char ${c.client}:${c.clock}: no struct`); continue; }
        const chain: string[] = [];
        for (let t: any = st.parent; t; t = t._item ? t._item.parent : null) chain.push(t._item ? `${t._item.id.client}:${t._item.id.clock}${t._item.deleted ? 'D' : ''}(${t._item.parentSub ?? ''})` : `root(${[...peers[0].ydoc.share].find(([, v]) => v === t)?.[0]})`);
        lines.push(`char ${c.client}:${c.clock} in item ${st.id.client}:${st.id.clock} deleted=${st.deleted} ${st.content instanceof Y.ContentString ? JSON.stringify(st.content.str) : st.content.constructor.name} left=${st.left ? st.left.id.client + ':' + st.left.id.clock : '-'} chain ${chain.join(' < ')}`);
      }
      fail(`untouched ${word} is not there in one piece (${occ.length} occurrences); its identities: ${ids.map(x => x.map(c => c.client + ':' + c.clock).join(',')).join(' | ')}\n${lines.map(l => { const k = l.indexOf('«'); return l.slice(Math.max(0, k - 200), k + 200); }).join('\n')}`);
    }
  }
}

describe('collab model: random concurrent editing', () => {
  const seeds = Number(process.env.OVERLYX_COLLAB_SEEDS ?? 40);
  const steps = Number(process.env.OVERLYX_COLLAB_STEPS ?? 150);
  const first = Number(process.env.OVERLYX_COLLAB_FIRST ?? 1);
  for (let seed = first; seed < first + seeds; seed++) it(`seed ${seed}`, () => runRandom(seed, steps));
  // one peer writes whole-document diffs (no mapping: the server loading a file over the state, an agent's edit)
  for (let seed = 1; seed <= Math.ceil(seeds / 4); seed++) it(`seed ${seed}, one peer diffing`, () => runRandom(1000 + seed, steps, true));
});

