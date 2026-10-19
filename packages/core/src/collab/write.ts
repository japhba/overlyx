/**
 * Writing a ProseMirror document into a model-2 CRDT (model.ts) as the smallest change: what stayed
 * keeps its Yjs identity, so that whatever others did to it meanwhile (online or offline) survives.
 *
 * `writeDoc(ydoc, old, next, mapping?)` needs `old` to be exactly what the CRDT reads as (read.ts) —
 * the view's document before a transaction, or a fresh reading — and changes the CRDT so that it
 * reads as `next`.
 *
 * With the transaction's `mapping` (an editor's change), the mapping says what stayed: a character,
 * marker or inline node of `old` that the mapping does not delete is the one at its mapped position
 * in `next`, so typed text is inserted exactly where it was typed — never "found" in neighbouring
 * characters that happen to be the same — and only what a step really replaced is compared token
 * by token (a paragraph's attributes set by replacing its start; text a command re-inserted as it
 * was — matched word by word, see diffTokens). Without a mapping (a file loaded over the state, an
 * agent's edit) paragraphs that stayed (equal content) are matched first and the rest is diffed word
 * by word.
 *
 * An Enter inserts a marker, a join deletes one, typing inserts characters, formatting formats the
 * characters it covers. Inline nodes, rows, cells, pages and objects matched with an old one are
 * updated in place (their attributes, their own flows); pages and objects are also matched where
 * they moved (they are ordered by id). Nothing is deleted and inserted again to say the same.
 *
 * Call it inside a Yjs transaction.
 */
import { Mark, type Node as PMNode, type NodeType, type Schema } from 'prosemirror-model';
import type { Mappable, Mapping } from 'prosemirror-transform';
import * as Y from 'yjs';
import {
  BODY, PAGES, PAGE_ORDER, K_BODY, K_ROWS, K_CELLS, K_OBJECTS, K_ORDER, K_NOTES, K_TYPE,
  shapeOf, storedAttrs, updateAttrs, embedded, isMarkerItem, leadsWithMarker, effectiveOrder, newId, sameValue, pageObjectIds, typeOfMap,
} from './model.ts';
import { diffKeys, type Run } from './diff.ts';
import { Reader } from './read.ts';

// ---------------------------------------------------------------- node keys

const keys = new WeakMap<PMNode, string>();
/** equal nodes have equal keys */
function keyOf(node: PMNode): string {
  let k = keys.get(node);
  if (k === undefined) { k = JSON.stringify(node.toJSON()); keys.set(node, k); }
  return k;
}

/** a node in a list with where it starts in its document */
interface At { node: PMNode; pos: number }

/**
 * Old and new lists matched. With a mapping: a node whose start the mapping keeps is the node at its
 * mapped start (the same type). Then equal nodes in sequence; in containers ordered by id (`moves`)
 * equal nodes that moved; then what is left in each gap position by position where the types
 * agree (a node edited in place). Returns the pairs [old, new], the old indices left over and the
 * new ones.
 */
function match(olds: readonly At[], news: readonly At[], moves: boolean, mapping: Mappable | null): { pairs: [number, number][]; gone: number[]; born: number[] } {
  const pairOfNew = new Array<number>(news.length).fill(-1);
  const usedOld = new Array<boolean>(olds.length).fill(false);
  if (mapping) {
    const at = new Map<number, number>();
    news.forEach((n, j) => at.set(n.pos, j));
    olds.forEach((o, i) => {
      const r = mapping.mapResult(o.pos, 1);
      if (r.deleted) return;
      const j = at.get(r.pos);
      if (j === undefined || pairOfNew[j] >= 0 || news[j].node.type !== o.node.type) return;
      pairOfNew[j] = i; usedOld[i] = true;
    });
  }
  const restOld = olds.map((_o, i) => i).filter(i => !usedOld[i]);
  const restNew = news.map((_n, j) => j).filter(j => pairOfNew[j] < 0);
  const runs = diffKeys(restOld.map(i => keyOf(olds[i].node)), restNew.map(j => keyOf(news[j].node)), 2000);
  const gaps: { olds: number[]; news: number[] }[] = [];
  let gap: { olds: number[]; news: number[] } | null = null;
  for (const r of runs) {
    if (r.op === 'eq') {
      gap = null;
      for (let k = 0; k < r.len; k++) { pairOfNew[restNew[r.b0 + k]] = restOld[r.a0 + k]; usedOld[restOld[r.a0 + k]] = true; }
      continue;
    }
    if (!gap) { gap = { olds: [], news: [] }; gaps.push(gap); }
    for (let k = 0; k < r.len; k++) {
      if (r.op === 'del') gap.olds.push(restOld[r.a0 + k]); else gap.news.push(restNew[r.b0 + k]);
    }
  }
  if (moves) {
    const free = new Map<string, number[]>();
    olds.forEach((o, i) => { if (!usedOld[i]) { const k = keyOf(o.node); const l = free.get(k); if (l) l.push(i); else free.set(k, [i]); } });
    news.forEach((n, j) => {
      if (pairOfNew[j] >= 0) return;
      const l = free.get(keyOf(n.node));
      if (l?.length) { const i = l.shift()!; pairOfNew[j] = i; usedOld[i] = true; }
    });
  }
  for (const g of gaps) {
    const os = g.olds.filter(i => !usedOld[i]), ns = g.news.filter(j => pairOfNew[j] < 0);
    for (let k = 0; k < Math.min(os.length, ns.length); k++) {
      if (olds[os[k]].node.type !== news[ns[k]].node.type) continue;
      pairOfNew[ns[k]] = os[k]; usedOld[os[k]] = true;
    }
  }
  const pairs: [number, number][] = [];
  const born: number[] = [];
  pairOfNew.forEach((i, j) => (i >= 0 ? pairs.push([i, j]) : born.push(j)));
  const gone: number[] = [];
  usedOld.forEach((u, i) => { if (!u) gone.push(i); });
  return { pairs, gone, born };
}

// ---------------------------------------------------------------- tokens of a flow

const MARKER_KEY = '\u0000\u0001P';
const embedKey = (node: PMNode) => '\u0000\u0002' + node.type.name;

type DeltaOp = { insert: string | Y.Map<unknown>; attributes?: Record<string, unknown> } | { retain: number; attributes?: Record<string, unknown> } | { delete: number };

/** kind: 0 a character (one code point), 1 a paragraph's marker, 2 an inline node; pos: where it starts in its document */
interface Tok { key: string; kind: 0 | 1 | 2; node: PMNode; text: string; marks: readonly Mark[]; ylen: number; pos: number }

/** the tokens of paragraphs starting at document position `pos` */
function tokens(pars: readonly PMNode[], pos: number, skipFirstMarker: boolean, out: Tok[] = []): Tok[] {
  pars.forEach((p, i) => {
    if (!(i === 0 && skipFirstMarker)) out.push({ key: MARKER_KEY, kind: 1, node: p, text: '', marks: Mark.none, ylen: 1, pos });
    let q = pos + 1;
    p.forEach(c => {
      if (c.isText) {
        for (const ch of c.text!) { out.push({ key: ch, kind: 0, node: c, text: ch, marks: c.marks, ylen: ch.length, pos: q }); q += ch.length; }
      } else { out.push({ key: embedKey(c), kind: 2, node: c, text: '', marks: c.marks, ylen: 1, pos: q }); q += c.nodeSize; }
    });
    pos += p.nodeSize;
  });
  return out;
}

const sizes = new WeakMap<PMNode, number>();
/** a paragraph's length in the flow, without its marker */
function inlineLength(p: PMNode): number {
  let n = sizes.get(p);
  if (n === undefined) {
    n = 0;
    p.forEach(c => { n! += c.isText ? c.text!.length : 1; });
    sizes.set(p, n);
  }
  return n;
}

/** Yjs text attributes for marks (each mark type is a key; the mark's attributes its value) */
function attrsOfMarks(marks: readonly Mark[]): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const m of marks) out[m.type.name] = { ...m.attrs };
  return out;
}

/** what turns `from` into `to` as text attributes (null: remove) — null when they are the same */
function markChange(from: readonly Mark[], to: readonly Mark[]): Record<string, unknown> | null {
  if (Mark.sameSet(from, to)) return null;
  const out: Record<string, unknown> = {};
  for (const m of from) if (!to.some(n => n.type === m.type)) out[m.type.name] = null;
  for (const m of to) { const o = from.find(n => n.type === m.type); if (!o || !sameValue(o.attrs, m.attrs)) out[m.type.name] = { ...m.attrs }; }
  return out;
}

const isDefaultParagraph = (p: PMNode) => Object.keys(storedAttrs(p)).length === 1;

/** the flow's first countable item is content before any marker */
function hasOrphanStart(flow: Y.Text): boolean {
  for (let it = flow._start; it; it = it.right) {
    if (it.deleted || !it.countable) continue;
    return !isMarkerItem(it);
  }
  return false;
}

/** the maps embedded in a flow by their index (markers and inline nodes) */
function embedsByIndex(flow: Y.Text): Map<number, Y.Map<unknown>> {
  const out = new Map<number, Y.Map<unknown>>();
  let i = 0;
  for (let it = flow._start; it; it = it.right) {
    if (it.deleted || !it.countable) continue;
    const t = embedded(it);
    if (t instanceof Y.Map) out.set(i, t as Y.Map<unknown>);
    i += it.length;
  }
  return out;
}

/** the tokens just outside a slice that diffTokens is given (to tell whether its ends are inside a word) */
interface Context { oBefore?: Tok; oAfter?: Tok; nBefore?: Tok; nAfter?: Tok }
const isWordTok = (t: Tok) => t.kind === 0 && !/\s/.test(t.text);

/** words (at most 32 code points), each whitespace character, marker and inline node: what diffs match as a whole */
function groups(toks: readonly Tok[]): { key: string; i: number; n: number }[] {
  const out: { key: string; i: number; n: number }[] = [];
  let i = 0;
  while (i < toks.length) {
    const t = toks[i];
    if (t.kind !== 0 || /\s/.test(t.text)) { out.push({ key: t.key, i, n: 1 }); i++; continue; }
    let j = i, key = '';
    while (j < toks.length && j - i < 32 && toks[j].kind === 0 && !/\s/.test(toks[j].text)) key += toks[j++].text;
    out.push({ key: '\u0000w' + key, i, n: j - i });
    i = j;
  }
  return out;
}

/**
 * An edit script matching whole words: words are diffed as words, and of what lies between two
 * matched words only the characters it has in common at its start and its end stay ("cat" → "cats"
 * keeps "cat"; a word typed right against another keeps that other one). What stays is always one
 * piece on each side of the change, joined to the unchanged text: nothing is put together from
 * letters scattered over different words. (A plain character diff keeps stray letters of unrelated
 * text — the first letter of a typed word "found" in the next word, a one-letter word inside a moved
 * one — and whatever others do meanwhile to those letters then breaks the word apart.)
 */
function diffTokens(ot: readonly Tok[], nt: readonly Tok[], ctx: Context = {}): Run[] {
  const ga = groups(ot), gb = groups(nt);
  const out: Run[] = [];
  const push = (op: Run['op'], a0: number, b0: number, len: number) => {
    if (len <= 0) return;
    const last = out[out.length - 1];
    if (last && last.op === op && last.a0 + (op === 'ins' ? 0 : last.len) === a0 && last.b0 + (op === 'del' ? 0 : last.len) === b0) last.len += len;
    else out.push({ op, a0, b0, len });
  };
  // where words start (a word's first token, and the end): a cut there splits no word — the ends of
  // the tokens only when the text around them (outside: `ctx`) does not go on with the same word
  const starts = (gs: { i: number }[], toks: readonly Tok[], before?: Tok, after?: Tok) => {
    const len = toks.length;
    const m = new Uint8Array(len + 1);
    for (const g of gs) m[g.i] = 1;
    m[len] = 1;
    if (len && isWordTok(toks[0]) && before && isWordTok(before)) m[0] = 0;
    if (len && isWordTok(toks[len - 1]) && after && isWordTok(after)) m[len] = 0;
    return m;
  };
  const oa = starts(ga, ot, ctx.oBefore, ctx.oAfter), nb = starts(gb, nt, ctx.nBefore, ctx.nAfter);
  const atStart = (m: Uint8Array, k: number) => m[k] === 1;
  /** groups ga0…ga1 replaced by gb0…gb1: what they have in common at their start and end stays */
  const region = (ga0: number, ga1: number, gb0: number, gb1: number) => {
    const a0 = ga0 < ga.length ? ga[ga0].i : ot.length, a1 = ga1 < ga.length ? ga[ga1].i : ot.length;
    const b0 = gb0 < gb.length ? gb[gb0].i : nt.length, b1 = gb1 < gb.length ? gb[gb1].i : nt.length;
    let p = 0;
    while (a0 + p < a1 && b0 + p < b1 && ot[a0 + p].key === nt[b0 + p].key) p++;
    // a cut inside a word on both sides would splice old letters into a new word: back off to where it is not
    while (p > 0 && !atStart(oa, a0 + p) && !atStart(nb, b0 + p)) p--;
    let q = 0;
    while (q < a1 - a0 - p && q < b1 - b0 - p && ot[a1 - 1 - q].key === nt[b1 - 1 - q].key) q++;
    while (q > 0 && !atStart(oa, a1 - q) && !atStart(nb, b1 - q)) q--;
    push('eq', a0, b0, p);
    push('del', a0 + p, b0 + p, a1 - a0 - p - q);
    push('ins', a1 - q, b0 + p, b1 - b0 - p - q);
    push('eq', a1 - q, b1 - q, q);
  };
  let pa = 0, pb = 0;   // the groups after the last equal ones
  for (const r of diffKeys(ga.map(g => g.key), gb.map(g => g.key))) {
    if (r.op !== 'eq') continue;
    region(pa, r.a0, pb, r.b0);
    const s = ga[r.a0], e = ga[r.a0 + r.len - 1];
    push('eq', s.i, gb[r.b0].i, e.i + e.n - s.i);
    pa = r.a0 + r.len; pb = r.b0 + r.len;
  }
  region(pa, ga.length, pb, gb.length);
  return out;
}

/**
 * The ranges of the final document that the steps of `mapping` inserted — their slices' content,
 * not what they carried along (a ReplaceAroundStep's gap: the text of a note lifted out of it).
 */
export function insertedRanges(mapping: Mapping): [number, number][] {
  const out: [number, number][] = [];
  const maps = mapping.maps;
  maps.forEach((map, k) => {
    map.forEach((_oldStart, _oldEnd, newStart, newEnd) => {
      let from = newStart, to = newEnd;
      for (let m = k + 1; m < maps.length && from < to; m++) { from = maps[m].map(from, 1); to = maps[m].map(to, -1); }
      if (from < to) out.push([from, to]);
    });
  });
  return out;
}

/**
 * An edit script with a mapping: what the mapping keeps is kept where it maps to; what lies between
 * two kept tokens (deleted on one side, inserted on the other) is diffed, so that text and markers
 * a step replaced by equal ones keep their identity. Only what a step inserted may take the
 * identity of equal text it deleted: text it carried here from elsewhere (out of a note, from
 * another flow) is new text in this flow — matched with the letters deleted here, a word lifted out
 * of a note began with the last letter of the word before it.
 */
function alignTokens(ot: Tok[], nt: Tok[], mapping: Mappable, inserted: [number, number][] | null): Run[] {
  const at = new Map<number, number>();
  nt.forEach((t, j) => at.set(t.pos, j));
  const isInserted = (pos: number) => !inserted || inserted.some(([a, b]) => pos >= a && pos < b);
  const pairs: [number, number][] = [];
  let lastJ = -1;
  ot.forEach((t, i) => {
    const r = mapping.mapResult(t.pos, 1);
    if (r.deleted) return;
    const j = at.get(r.pos);
    if (j === undefined || j <= lastJ || nt[j].key !== t.key) return;
    pairs.push([i, j]);
    lastJ = j;
  });
  const runs: Run[] = [];
  const push = (op: Run['op'], a0: number, b0: number, len: number) => {
    if (len <= 0) return;
    const last = runs[runs.length - 1];
    if (last && last.op === op && last.a0 + (op === 'ins' ? 0 : last.len) === a0 && last.b0 + (op === 'del' ? 0 : last.len) === b0) last.len += len;
    else runs.push({ op, a0, b0, len });
  };
  let i0 = 0, j0 = 0;
  const between = (i1: number, j1: number) => {
    if (i1 > i0 || j1 > j0) {
      const ctx: Context = { oBefore: ot[i0 - 1], oAfter: ot[i1], nBefore: nt[j0 - 1], nAfter: nt[j1] };
      // carried text matches nothing
      const ns = nt.slice(j0, j1).map(t => (isInserted(t.pos) ? t : { ...t, key: `${t.key}\u0002${t.pos}` }));
      for (const r of diffTokens(ot.slice(i0, i1), ns, ctx)) push(r.op, i0 + r.a0, j0 + r.b0, r.len);
    }
  };
  for (const [i, j] of pairs) { between(i, j); push('eq', i, j, 1); i0 = i + 1; j0 = j + 1; }
  between(ot.length, nt.length);
  return runs;
}

// ---------------------------------------------------------------- the writer

export class Writer {
  /** the change being written (null: none known), and the ranges its steps inserted */
  private mapping: Mappable | null = null;
  private inserted: [number, number][] | null = null;

  constructor(readonly schema: Schema) {}

  /**
   * Change `ydoc` from reading as `old` to reading as `next`. `mapping`: the positions of `old`
   * mapped to `next` (the transactions between them), when known.
   */
  writeDoc(ydoc: Y.Doc, old: PMNode, next: PMNode, mapping?: Mapping | null): void {
    if (old === next) return;
    this.mapping = mapping ?? null;
    this.inserted = mapping ? insertedRanges(mapping) : null;
    try {
      const isLayout = (d: PMNode) => d.firstChild?.type.name === 'ol_page';
      const body = ydoc.getText(BODY);
      const pages = ydoc.getMap<Y.Map<unknown>>(PAGES);
      const order = ydoc.getArray<string>(PAGE_ORDER);
      if (isLayout(next)) {
        if (!isLayout(old)) this.mapping = null;
        this.writePages(pages, order, isLayout(old) ? atsOf(old, 0) : [], atsOf(next, 0));
        if (!isLayout(old) && body.length) body.delete(0, body.length);
      } else if (isLayout(old)) {
        // a layout document became a linear one: its pages go, the body is what it reads as now
        this.mapping = null;
        pages.forEach((_v, k) => pages.delete(k));
        if (order.length) order.delete(0, order.length);
        this.writeFlow(body, new Reader(this.schema, ydoc).readFlow(body), children(next), 0, 0);
      } else this.writeFlow(body, children(old), children(next), 0, 0);
    } finally { this.mapping = null; this.inserted = null; }
  }

  /**
   * Change a flow from holding the paragraphs `olds` (exactly what it reads as; their content starts
   * at `oldStart` in the old document) to `news` (at `newStart` in the new one).
   */
  writeFlow(flow: Y.Text, olds: readonly PMNode[], news: readonly PMNode[], oldStart: number, newStart: number): void {
    const implicit = !leadsWithMarker(flow);
    const mapping = this.mapping;
    // paragraphs that stayed: the same node, (with a mapping) where the mapping puts it
    const op: number[] = [], np: number[] = [];
    { let p = oldStart; for (const n of olds) { op.push(p); p += n.nodeSize; } op.push(p); }
    { let p = newStart; for (const n of news) { np.push(p); p += n.nodeSize; } np.push(p); }
    const same = (i: number, j: number) => olds[i] === news[j] && (!mapping || (mapping.map(op[i], 1) === np[j] && mapping.map(op[i + 1], -1) === np[j + 1]));
    let pre = 0;
    while (pre < olds.length && pre < news.length && same(pre, pre)) pre++;
    if (pre === olds.length && pre === news.length) return;
    let suf = 0;
    while (suf < olds.length - pre && suf < news.length - pre && same(olds.length - 1 - suf, news.length - 1 - suf)) suf++;
    // an implicit first paragraph (no marker) can only stay the first one
    if (implicit && pre === 0 && suf === olds.length) suf--;
    const gaps: { a0: number; a1: number; b0: number; b1: number }[] = [];
    if (mapping) {
      // the paragraphs between, with their stays (same node where the mapping puts it) as anchors
      const at = new Map<number, number>();
      for (let j = pre; j < news.length - suf; j++) at.set(np[j], j);
      let a = pre, b = pre;
      for (let i = pre; i < olds.length - suf; i++) {
        if (implicit && i === 0) continue;
        const j = at.get(mapping.map(op[i], 1));
        if (j === undefined || j < b || !same(i, j)) continue;
        if (i > a || j > b) gaps.push({ a0: a, a1: i, b0: b, b1: j });
        a = i + 1; b = j + 1;
      }
      if (olds.length - suf > a || news.length - suf > b) gaps.push({ a0: a, a1: olds.length - suf, b0: b, b1: news.length - suf });
    } else {
      const om = olds.slice(pre, olds.length - suf), nm = news.slice(pre, news.length - suf);
      const okeys = om.map(keyOf);
      if (implicit && pre === 0 && okeys.length) okeys[0] = '\u0000implicit';
      let open: { a0: number; a1: number; b0: number; b1: number } | null = null;
      for (const r of diffKeys(okeys, nm.map(keyOf), 2000)) {
        if (r.op === 'eq') { if (open) { gaps.push(open); open = null; } continue; }
        if (!open) open = { a0: pre + r.a0, a1: pre + r.a0, b0: pre + r.b0, b1: pre + r.b0 };
        if (r.op === 'del') open.a1 = pre + r.a0 + r.len; else open.b1 = pre + r.b0 + r.len;
      }
      if (open) gaps.push(open);
    }
    if (!gaps.length) return;
    const orphanStart = implicit && hasOrphanStart(flow);
    // where each old paragraph begins in the flow
    const starts: number[] = [];
    let total = 0;
    for (let i = 0; i < olds.length; i++) { starts.push(total); total += inlineLength(olds[i]) + (i === 0 && implicit ? 0 : 1); }
    starts.push(total);
    const delta: DeltaOp[] = [];
    const after: (() => void)[] = [];
    let maps: Map<number, Y.Map<unknown>> | null = null;
    const mapAt = (i: number) => (maps ??= embedsByIndex(flow)).get(i);
    let y = 0;
    for (const { a0, a1, b0, b1 } of gaps) {
      const skipOld = a0 === 0 && implicit;
      const skipNew = b0 === 0 && a0 === 0 && orphanStart && isDefaultParagraph(news[0]) && news[0].content.size > 0;
      if (starts[a0] > y) delta.push({ retain: starts[a0] - y });
      const ot = tokens(olds.slice(a0, a1), op[a0], skipOld), nt = tokens(news.slice(b0, b1), np[b0], skipNew);
      this.tokenDelta(starts[a0], ot, nt, mapAt, delta, after);
      y = starts[a1];
    }
    if (y > total || total !== flow.length) throw new Error(`collab: the flow is not what was read (${total} vs ${flow.length})`);
    flow.applyDelta(delta);
    for (const f of after) f();
  }

  /** the delta turning tokens `ot` (at flow index y0) into `nt`, and what to do once it is applied (fill new maps, update kept ones) */
  private tokenDelta(y0: number, ot: Tok[], nt: Tok[], mapAt: (i: number) => Y.Map<unknown> | undefined, delta: DeltaOp[], after: (() => void)[]): void {
    const runs = this.mapping ? alignTokens(ot, nt, this.mapping, this.inserted) : diffTokens(ot, nt);
    const oy: number[] = [];
    let acc = y0;
    for (const t of ot) { oy.push(acc); acc += t.ylen; }
    for (const r of runs) {
      if (r.op === 'eq') {
        // what stays: formatted where its marks changed (in runs of the same change); maps updated
        let len = 0, ck = '', change: Record<string, unknown> | null = null;
        const flush = () => { if (len) delta.push(change ? { retain: len, attributes: change } : { retain: len }); len = 0; };
        for (let i = 0; i < r.len; i++) {
          const o = ot[r.a0 + i], n = nt[r.b0 + i];
          const c = o.kind === 1 ? null : markChange(o.marks, n.marks);
          const k = c ? JSON.stringify(c) : '';
          if (k !== ck) { flush(); ck = k; change = c; }
          len += o.ylen;
          if (o.kind === 1 && !sameValue(storedAttrs(o.node), storedAttrs(n.node))) {
            const m = mapAt(oy[r.a0 + i]);
            if (m) after.push(() => updateAttrs(m, o.node, n.node));
          } else if (o.kind === 2 && o.node !== n.node && !o.node.eq(n.node)) {
            const m = mapAt(oy[r.a0 + i]);
            if (m) after.push(() => this.updateNode(m, o.node, n.node, o.pos, n.pos));
          }
        }
        flush();
      } else if (r.op === 'del') {
        let len = 0;
        for (let i = 0; i < r.len; i++) len += ot[r.a0 + i].ylen;
        delta.push({ delete: len });
      } else {
        let text = '', marks: readonly Mark[] = Mark.none;
        const flush = () => { if (text) { delta.push({ insert: text, attributes: attrsOfMarks(marks) }); text = ''; } };
        for (let i = 0; i < r.len; i++) {
          const t = nt[r.b0 + i];
          if (t.kind === 0) {
            if (text && !Mark.sameSet(marks, t.marks)) flush();
            marks = t.marks; text += t.text;
            continue;
          }
          flush();
          const m = new Y.Map<unknown>();
          delta.push({ insert: m, attributes: t.kind === 1 ? {} : attrsOfMarks(t.marks) });
          const node = t.node;
          after.push(t.kind === 1 ? () => this.fillAttrs(m, node) : () => this.build(m, node));
        }
        flush();
      }
    }
  }

  private fillAttrs(m: Y.Map<unknown>, node: PMNode): void {
    for (const [k, v] of Object.entries(storedAttrs(node))) m.set(k, v);
  }

  /** Fill an (integrated, empty) map with a new node: its attributes and content. */
  build(m: Y.Map<unknown>, node: PMNode): void {
    this.fillAttrs(m, node);
    switch (shapeOf(node.type)) {
      case 'flow': {
        const body = new Y.Text();
        m.set(K_BODY, body);
        this.writeNewFlow(body, children(node));
        break;
      }
      case 'rows': case 'cells': {
        const list = new Y.Array<Y.Map<unknown>>();
        m.set(shapeOf(node.type) === 'rows' ? K_ROWS : K_CELLS, list);
        node.forEach(c => { const cm = new Y.Map<unknown>(); list.push([cm]); this.build(cm, c); });
        break;
      }
      default: break;
    }
  }

  /** paragraphs into an empty flow (every paragraph with its marker) */
  writeNewFlow(flow: Y.Text, pars: readonly PMNode[]): void {
    const delta: DeltaOp[] = [], after: (() => void)[] = [];
    const saved = this.mapping;
    this.mapping = null;
    try { this.tokenDelta(0, [], tokens(pars, 0, false), () => undefined, delta, after); } finally { this.mapping = saved; }
    flow.applyDelta(delta);
    for (const f of after) f();
  }

  /** An embed, row, cell or object matched with an old one (at `oldPos` / `newPos`): brought from `old` to `next`. */
  updateNode(m: Y.Map<unknown>, old: PMNode, next: PMNode, oldPos: number, newPos: number): void {
    if (old === next) return;
    updateAttrs(m, old, next);
    switch (shapeOf(next.type)) {
      case 'flow': {
        const body = m.get(K_BODY);
        if (body instanceof Y.Text) this.writeFlow(body, children(old), children(next), oldPos + 1, newPos + 1);
        else { const b = new Y.Text(); m.set(K_BODY, b); this.writeNewFlow(b, children(next)); }
        break;
      }
      case 'rows': case 'cells': {
        const key = shapeOf(next.type) === 'rows' ? K_ROWS : K_CELLS;
        let list = m.get(key);
        if (!(list instanceof Y.Array)) { list = new Y.Array<Y.Map<unknown>>(); m.set(key, list); }
        this.writeList(list as Y.Array<unknown>, atsOf(old, oldPos + 1), atsOf(next, newPos + 1),
          t => (key === K_ROWS ? t.spec.tableRole === 'row' : t.spec.tableRole === 'cell' || t.spec.tableRole === 'header_cell'));
        break;
      }
      default: break;
    }
  }

  /** A Y.Array of maps (rows, cells) from reading as `olds` to `news`. */
  private writeList(list: Y.Array<unknown>, olds: readonly At[], news: readonly At[], ok: (t: NodeType) => boolean): void {
    // the entries the reading used, by position
    const raw = list.toArray();
    const valid: number[] = [];
    raw.forEach((m, i) => { if (m instanceof Y.Map) { const t = typeOfMap(this.schema, m); if (t && ok(t)) valid.push(i); } });
    if (valid.length !== olds.length) {
      // not what the reading saw (should not happen): rewrite the list
      if (list.length) list.delete(0, list.length);
      news.forEach(n => { const cm = new Y.Map<unknown>(); list.push([cm]); this.build(cm, n.node); });
      return;
    }
    const { pairs, gone, born } = match(olds, news, false, this.mapping);
    for (const [i, j] of pairs) this.updateNode(raw[valid[i]] as Y.Map<unknown>, olds[i].node, news[j].node, olds[i].pos, news[j].pos);
    // deletions from the last, then insertions in order (each right after its predecessor)
    for (const i of [...gone].reverse()) list.delete(valid[i], 1);
    const position = new Map<number, number>();   // new index → where it now is
    const alive = list.toArray();
    for (const [i, j] of pairs) position.set(j, alive.indexOf(raw[valid[i]]));
    for (const j of born) {
      let at = 0;
      for (let jj = j - 1; jj >= 0; jj--) { const p = position.get(jj); if (p !== undefined) { at = p + 1; break; } }
      const cm = new Y.Map<unknown>();
      list.insert(at, [cm]);
      this.build(cm, news[j].node);
      for (const [k, p] of position) if (p >= at) position.set(k, p + 1);
      position.set(j, at);
    }
  }

  // ---------------------------------------------------------------- pages and objects

  private writePages(pages: Y.Map<Y.Map<unknown>>, order: Y.Array<string>, olds: readonly At[], news: readonly At[]): void {
    const ids = effectiveOrder(order, id => { const p = pages.get(id); return p instanceof Y.Map && p.get(K_TYPE) === 'ol_page'; });
    if (ids.length !== olds.length) {
      // not what the reading saw (should not happen): every page anew
      pages.forEach((_v, k) => pages.delete(k));
      if (order.length) order.delete(0, order.length);
      ids.length = 0;
      olds = [];
    }
    const { pairs, gone, born } = match(olds, news, true, this.mapping);
    const idOfNew: string[] = new Array(news.length);
    for (const [i, j] of pairs) { idOfNew[j] = ids[i]; this.updatePage(pages.get(ids[i])!, olds[i], news[j]); }
    for (const j of born) {
      const id = newId();
      const m = new Y.Map<unknown>();
      pages.set(id, m);
      this.buildPage(m, news[j].node);
      idOfNew[j] = id;
    }
    for (const i of gone) pages.delete(ids[i]);
    writeOrder(order, idOfNew);
  }

  private buildPage(m: Y.Map<unknown>, page: PMNode): void {
    this.fillAttrs(m, page);
    const objects = new Y.Map<Y.Map<unknown>>();
    m.set(K_OBJECTS, objects);
    const order = new Y.Array<string>();
    m.set(K_ORDER, order);
    const top: string[] = [];
    page.forEach(c => {
      if (c.type.name === 'ol_notes') { const notes = new Y.Text(); m.set(K_NOTES, notes); this.writeNewFlow(notes, children(c)); }
      else top.push(this.buildObject(objects, c));
    });
    order.push(top);
  }

  private buildObject(objects: Y.Map<Y.Map<unknown>>, node: PMNode): string {
    const id = newId();
    const m = new Y.Map<unknown>();
    objects.set(id, m);
    if (shapeOf(node.type) === 'objects') {
      this.fillAttrs(m, node);
      const order = new Y.Array<string>();
      m.set(K_ORDER, order);
      const ids: string[] = [];
      node.forEach(c => ids.push(this.buildObject(objects, c)));
      order.push(ids);
    } else this.build(m, node);
    return id;
  }

  private updatePage(m: Y.Map<unknown>, old: At, next: At): void {
    if (old.node === next.node) return;
    updateAttrs(m, old.node, next.node);
    let objects = m.get(K_OBJECTS) as Y.Map<Y.Map<unknown>> | undefined;
    if (!(objects instanceof Y.Map)) { objects = new Y.Map(); m.set(K_OBJECTS, objects); }
    // the objects as the reading saw them, depth first, with their ids
    const flatten = (page: At) => {
      const list: (At & { parent: number })[] = [];
      const walk = (node: PMNode, start: number, parent: number) => node.forEach((c, off) => {
        if (c.type.name === 'ol_notes') return;
        const at = list.length;
        list.push({ node: c, pos: start + off, parent });
        if (shapeOf(c.type) === 'objects') walk(c, start + off + 1, at);
      });
      walk(page.node, page.pos + 1, -1);
      return list;
    };
    let oldList = flatten(old);
    let ids = pageObjectIds(this.schema, m);
    const newList = flatten(next);
    if (ids.length !== oldList.length) {
      // not what the reading saw (should not happen): all objects anew
      objects.forEach((_v, k) => objects!.delete(k));
      oldList = []; ids = [];
    }
    const { pairs, gone, born } = match(oldList, newList, true, this.mapping);
    const idOfNew: string[] = new Array(newList.length);
    for (const [i, j] of pairs) {
      idOfNew[j] = ids[i];
      const om = objects.get(ids[i])!;
      const o = oldList[i], n = newList[j];
      if (shapeOf(n.node.type) === 'objects') updateAttrs(om, o.node, n.node);
      else this.updateNode(om, o.node, n.node, o.pos, n.pos);
    }
    for (const j of born) {
      const n = newList[j].node;
      const id = newId();
      const om = new Y.Map<unknown>();
      objects.set(id, om);
      if (shapeOf(n.type) === 'objects') { this.fillAttrs(om, n); om.set(K_ORDER, new Y.Array<string>()); }
      else this.build(om, n);
      idOfNew[j] = id;
    }
    for (const i of gone) objects.delete(ids[i]);
    // every container's order: the page's, each group's
    const childrenOf = new Map<number, string[]>();
    newList.forEach((e, j) => { const l = childrenOf.get(e.parent); if (l) l.push(idOfNew[j]); else childrenOf.set(e.parent, [idOfNew[j]]); });
    let top = m.get(K_ORDER);
    if (!(top instanceof Y.Array)) { top = new Y.Array<string>(); m.set(K_ORDER, top); }
    writeOrder(top as Y.Array<string>, childrenOf.get(-1) ?? []);
    newList.forEach((e, j) => {
      if (shapeOf(e.node.type) !== 'objects') return;
      const gm = objects!.get(idOfNew[j])!;
      let go = gm.get(K_ORDER);
      if (!(go instanceof Y.Array)) { go = new Y.Array<string>(); gm.set(K_ORDER, go); }
      writeOrder(go as Y.Array<string>, childrenOf.get(j) ?? []);
    });
    // the notes
    const notesOf = (p: At) => { const l = p.node.lastChild; return l?.type.name === 'ol_notes' ? { node: l, pos: p.pos + p.node.nodeSize - 1 - l.nodeSize } : null; };
    const oldNotes = notesOf(old), newNotes = notesOf(next);
    const notes = m.get(K_NOTES);
    if (newNotes) {
      if (notes instanceof Y.Text && oldNotes) this.writeFlow(notes, children(oldNotes.node), children(newNotes.node), oldNotes.pos + 1, newNotes.pos + 1);
      else { const t = new Y.Text(); m.set(K_NOTES, t); this.writeNewFlow(t, children(newNotes.node)); }
    } else if (m.has(K_NOTES)) m.delete(K_NOTES);
  }
}

function children(node: PMNode): PMNode[] {
  const out: PMNode[] = [];
  node.forEach(c => out.push(c));
  return out;
}

/** a node's children with their positions (its content starting at `start`) */
function atsOf(node: PMNode, start: number): At[] {
  const out: At[] = [];
  node.forEach((c, off) => out.push({ node: c, pos: start + off }));
  return out;
}

/** An order (Y.Array of ids) made to give `ids` (each where it is first, as the reading counts). */
function writeOrder(order: Y.Array<string>, ids: readonly string[]): void {
  const raw = order.toArray().map(v => (typeof v === 'string' ? v : '\u0000'));
  const runs = diffKeys(raw, ids as string[], 2000);
  // from the last run: indices before it stay
  for (let r = runs.length - 1; r >= 0; r--) {
    const run = runs[r];
    if (run.op === 'del') order.delete(run.a0, run.len);
    else if (run.op === 'ins') order.insert(run.a0, ids.slice(run.b0, run.b0 + run.len) as string[]);
  }
}

/** Write `next` into `ydoc`, from what it reads as now (server side: loads, merges, agents' edits). */
export function writeDocument(schema: Schema, ydoc: Y.Doc, next: PMNode): void {
  const old = new Reader(schema, ydoc).read();
  new Writer(schema).writeDoc(ydoc, old, next);
}
