/**
 * Tracked-change diff: an edit of a paragraph list (old → new, e.g. an agent's version of a
 * document) turned into the smallest reviewable set of LyX change marks, as if the author had
 * typed it with Track Changes on.
 *
 *  - Paragraphs are aligned first (unchanged ones are kept untouched, with their marks); within a
 *    changed region, similar paragraphs of the same layout are paired and diffed item by item,
 *    the rest are whole deleted / inserted paragraphs with their paragraph breaks tracked the way
 *    the editor and LyX do it (so Accept all gives exactly `new`, Reject all exactly `old`).
 *  - Within a paragraph, text is compared word by word (a single changed word down to its changed
 *    characters: 202[5→6]), formulas and other leaf insets as units, and a footnote, box, float or
 *    table (same shape) is entered and diffed inside instead of being replaced whole. Small
 *    unchanged fragments between two changes are folded into them, so a rewritten sentence reads
 *    as one deletion + one insertion rather than a shredded word salad.
 *  - Existing marks: content is compared regardless of who inserted it (another author's pending
 *    insertion that the new version keeps stays theirs); text already marked deleted only matches
 *    text marked deleted, and stays deleted when the new version leaves it out. The author's OWN
 *    pending changes in a changed region are first taken back (their insertions removed, their
 *    deletions restored) and then re-derived — like LyX, where deleting your own insertion simply
 *    removes it — so an agent refining its earlier proposal does not stack changes on changes.
 */
import type { Paragraph, Item, Change, FontState, Inset, TabularInset } from './ast.ts';
import { FONT_KEYS, changesEqual } from './ast.ts';
import { align } from './merge.ts';

export interface TrackAs { author: number; time: number }

/* ------------------------------------------------------------------ accept / reject */

/**
 * Accept or reject the tracked changes `which` selects (default: all) in a paragraph list,
 * recursively (insets, table cells). A removed paragraph break joins the paragraph with the next
 * one; an emptied paragraph takes the next one's layout.
 */
export function resolveChanges(pars: Paragraph[], accept: boolean, which: (c: Change) => boolean = () => true): Paragraph[] {
  const out: Paragraph[] = [];
  let joinNext = false;
  for (const p of pars) {
    const items: Item[] = [];
    for (const it of p.items) {
      const c = it.change;
      let next: Item = it;
      if (c && which(c)) {
        if (accept ? c.type === 'deleted' : c.type === 'inserted') continue;
        next = withChange(it, undefined);
      }
      items.push(resolveInItem(next, accept, which));
    }
    let np: Paragraph = { ...p, items };
    let join = false;
    if (p.endChange && which(p.endChange)) {
      join = accept ? p.endChange.type === 'deleted' : p.endChange.type === 'inserted';
      np = withEnd(np, undefined);
    }
    if (joinNext && out.length) {
      const prev = out.pop()!;
      const attrs = prev.items.length ? prev : np;
      np = withEnd({ ...attrs, items: [...prev.items, ...np.items] }, np.endChange);
    }
    out.push(np);
    joinNext = join;
  }
  return out;
}

function resolveInItem(it: Item, accept: boolean, which: (c: Change) => boolean): Item {
  if (it.kind !== 'inset') return it;
  const ins = it.inset;
  if (ins.type === 'Text') return { ...it, inset: { ...ins, paragraphs: resolveChanges(ins.paragraphs, accept, which) } };
  if (ins.type === 'Tabular') return { ...it, inset: mapCells(ins, c => resolveChanges(c, accept, which)) };
  return it;
}

/** Take back `author`'s own pending changes: their insertions disappear, their deletions are restored. */
export function rejectOwnChanges(pars: Paragraph[], author: number): Paragraph[] {
  return resolveChanges(pars, false, c => c.author === author);
}

/* ------------------------------------------------------------------ the diff */

/** `oldPars` edited into `newPars`, as tracked changes by `as` (see the module comment). */
export function trackDiff(oldPars: Paragraph[], newPars: Paragraph[], as: TrackAs): Paragraph[] {
  const cx = new Cx(as);
  return cx.paragraphs(oldPars, newPars, false);
}

/** Characters (and paragraph breaks) inserted / deleted by exactly this change (author + time). */
export function changeStats(pars: Paragraph[], as: TrackAs): { inserted: number; deleted: number } {
  const st = { inserted: 0, deleted: 0 };
  const mine = (c?: Change) => !!c && c.author === as.author && c.time === as.time;
  const visit = (ps: Paragraph[]): void => {
    for (const p of ps) {
      if (mine(p.endChange)) st[p.endChange!.type]++;
      for (const it of p.items) {
        if (mine(it.change)) st[it.change!.type] += it.kind === 'text' ? [...it.text].length : 1;
        else if (it.kind === 'inset') {
          const ins = it.inset;
          if (ins.type === 'Text') visit(ins.paragraphs);
          else if (ins.type === 'Tabular') for (const r of ins.rows) for (const c of r.cells) visit(c.paragraphs);
        }
      }
    }
  };
  visit(pars);
  return st;
}

/**
 * A piece of a token: visible text (one font, its own mark — a word may straddle marks), or a
 * *passenger*: content already marked deleted (text or an inset). Passengers are invisible to the
 * comparison — only what a reader of the new version sees is compared — and ride along with the
 * token they sit in: kept where the old version is kept or deleted, dropped from the new side.
 */
type Part = { text: string; font: FontState; change?: Change } | { item: Item };

interface Tok {
  key: string;
  /** visible text (text tokens; '' otherwise) */
  text: string;
  /** a word or a whitespace run (not an inset / special character / passengers only) */
  isText: boolean;
  ws: boolean;
  font: FontState;
  parts: Part[];
}

type Op =
  | { t: 'same'; old: Tok[] }
  | { t: 'chg'; del: Tok[]; add: Tok[] }
  | { t: 'rec'; item: Item };

/** K kept / paired, D deleted, I inserted, P an old paragraph that is already entirely deleted (kept as is) */
interface Entry { kind: 'K' | 'D' | 'I' | 'P'; par: Paragraph; /** index into the (virtual) old list, for K and D */ v?: number }

const isDel = (c?: Change): boolean => c?.type === 'deleted';
const partDel = (p: Part): boolean => isDel('item' in p ? p.item.change : p.change);
const fontKey = (f: FontState): string => FONT_KEYS.map(k => f[k] ?? '').join('|');
/** LaTeX whitespace (not ~ / U+00A0, which are characters of their own) */
const WS = /^[ \t\r\n]/;
const INSET_WEIGHT = 4;

function withChange<T extends Item>(it: T, change: Change | undefined): T {
  const out = { ...it };
  if (change) out.change = change; else delete out.change;
  return out;
}

function withEnd(p: Paragraph, change: Change | undefined): Paragraph {
  const out = { ...p };
  if (change) out.endChange = change; else delete out.endChange;
  return out;
}

function mapCells(ins: TabularInset, f: (pars: Paragraph[], ri: number, ci: number) => Paragraph[]): TabularInset {
  return { ...ins, rows: ins.rows.map((r, ri) => ({ ...r, cells: r.cells.map((c, ci) => ({ ...c, paragraphs: f(c.paragraphs, ri, ci) })) })) };
}

/** A paragraph whose content and break are both marked deleted: it vanishes on Accept. */
const invisible = (p: Paragraph): boolean => isDel(p.endChange) && p.items.every(it => isDel(it.change));

class Cx {
  private toks = new Map<Paragraph, Tok[]>();
  private keys = new Map<Paragraph, string>();
  private words = new Map<Paragraph, Map<string, number>>();
  readonly ins: Change;
  readonly del: Change;

  constructor(readonly as: TrackAs) {
    this.ins = { type: 'inserted', author: as.author, time: as.time };
    this.del = { type: 'deleted', author: as.author, time: as.time };
  }

  /* ---------------------------------------------------------------- keys */

  private insetKey(ins: Inset): string {
    // content identity: who inserted something does not matter, whether it is deleted does
    return JSON.stringify(ins, (k, v) => (k === 'change' ? (v?.type === 'deleted' ? 'x' : undefined) : k === 'endChange' ? undefined : v));
  }

  tokens(p: Paragraph): Tok[] {
    let out = this.toks.get(p);
    if (out) return out;
    const toks: Tok[] = [];
    let lead: Part[] = [];
    const start = (tok: Tok) => { if (lead.length) { tok.parts.unshift(...lead); lead = []; } toks.push(tok); };
    for (const it of p.items) {
      if (isDel(it.change)) {
        const part: Part = it.kind === 'text' ? { text: it.text, font: it.font, change: it.change } : { item: it };
        const last = toks.at(-1);
        if (last) last.parts.push(part); else lead.push(part);
        continue;
      }
      if (it.kind === 'text') {
        for (const seg of it.text.match(/[ \t\r\n]+|[^ \t\r\n]+/g) ?? []) {
          const ws = WS.test(seg), last = toks.at(-1);
          const part: Part = { text: seg, font: it.font, change: it.change };
          // a word continues across marks (and passengers): 202[5→]7 is one word
          if (last?.isText && last.ws === ws && fontKey(last.font) === fontKey(it.font)) { last.text += seg; last.parts.push(part); }
          else start({ key: '', text: seg, isText: true, ws, font: it.font, parts: [part] });
        }
        continue;
      }
      const content = it.kind === 'inset' ? 'i' + this.insetKey(it.inset) : it.kind === 'special' ? 's' + it.token + '\u0001' + it.arg : 'u' + it.line;
      start({ key: content + '\u0001' + fontKey(it.font), text: '', isText: false, ws: false, font: it.font, parts: [{ item: it }] });
    }
    if (lead.length) toks.push({ key: '\u0005', text: '', isText: false, ws: false, font: {}, parts: lead });   // nothing visible
    for (const t of toks) if (t.isText) t.key = 't' + fontKey(t.font) + '\u0001' + (t.ws ? ' ' : t.text);
    this.toks.set(p, toks);
    return toks;
  }

  parKey(p: Paragraph): string {
    let k = this.keys.get(p);
    if (k === undefined) {
      k = `${p.layout}\u0002${p.depth}\u0002${JSON.stringify(p.params)}\u0002${this.tokens(p).filter(t => t.key !== '\u0005').map(t => t.key).join('\u0003')}`;
      this.keys.set(p, k);
    }
    return k;
  }

  /** Word bag of a paragraph (into insets and table cells) for pairing similar paragraphs. */
  private wordBag(p: Paragraph): Map<string, number> {
    let bag = this.words.get(p);
    if (bag) return bag;
    bag = new Map();
    const add = (w: string) => bag!.set(w, (bag!.get(w) ?? 0) + 1);
    const visit = (ps: Paragraph[]): void => {
      for (const q of ps) for (const it of q.items) {
        if (isDel(it.change)) continue;
        if (it.kind === 'text') { for (const w of it.text.toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? []) add(w); continue; }
        if (it.kind !== 'inset') continue;
        const ins = it.inset;
        add('\u0000' + ins.type + ((ins as { name?: string }).name ?? ''));
        if (ins.type === 'Text') visit(ins.paragraphs);
        else if (ins.type === 'Tabular') for (const r of ins.rows) for (const c of r.cells) visit(c.paragraphs);
        else if (ins.type === 'Formula') add('\u0000' + ins.latex);
      }
    };
    visit([p]);
    this.words.set(p, bag);
    return bag;
  }

  private similarity(a: Paragraph, b: Paragraph): number {
    if (a.layout !== b.layout) return 0;
    const A = this.wordBag(a), B = this.wordBag(b);
    let na = 0, nb = 0, common = 0;
    for (const n of A.values()) na += n;
    for (const [w, n] of B) { nb += n; common += Math.min(n, A.get(w) ?? 0); }
    if (!na && !nb) return 1;
    return (2 * common) / (na + nb);
  }

  /* ---------------------------------------------------------------- paragraph lists */

  /** The tracked version of a paragraph list; `clean`: old carries none of the author's own changes. */
  paragraphs(oldPars: Paragraph[], newPars: Paragraph[], clean: boolean): Paragraph[] {
    const { seq, vOld } = this.entries(oldPars, newPars, clean);
    return this.breaks(seq, vOld);
  }

  private ownEnd(p: Paragraph): boolean { return !!p.endChange && p.endChange.author === this.as.author; }

  private entries(allOld: Paragraph[], allNew: Paragraph[], clean: boolean): { seq: Entry[]; vOld: Paragraph[] } {
    // paragraphs already entirely deleted take no part in the comparison; each stays in front of
    // the next visible old paragraph (the one it joins on Accept)
    const oldPars: Paragraph[] = [], before: Paragraph[][] = [];
    let pending: Paragraph[] = [];
    for (const p of allOld) { if (invisible(p)) pending.push(p); else { before.push(pending); pending = []; oldPars.push(p); } }
    before.push(pending);
    const newPars = allNew.filter(p => !invisible(p));
    const passengers = (k: number): Entry[] => before[k].map(par => ({ kind: 'P', par }));

    let pairs = align(oldPars.map(p => this.parKey(p)), newPars.map(p => this.parKey(p)));
    if (!clean) {
      // a changed region takes the author's own changes back before diffing: widen it over a
      // neighbouring paragraph whose break is such a change (a paragraph the author inserted
      // earlier and now edits or removes), so that break is taken back together with it
      for (let grown = true; grown;) {
        grown = false;
        const set = new Set(pairs.map(([i]) => i));
        for (let k = 0; k < pairs.length && !grown; k++) {
          const [i, j] = pairs[k];
          const next = pairs[k + 1] ?? [oldPars.length, newPars.length];
          const prev = pairs[k - 1] ?? [-1, -1];
          const hunkAfter = next[0] > i + 1 || next[1] > j + 1;
          const hunkBefore = prev[0] < i - 1 || prev[1] < j - 1;
          if ((hunkAfter && this.ownEnd(oldPars[i])) || (hunkBefore && i > 0 && !set.has(i - 1) && this.ownEnd(oldPars[i - 1]))) {
            pairs = pairs.filter((_, x) => x !== k);
            grown = true;
          }
        }
      }
    }
    const seq: Entry[] = [], vOld: Paragraph[] = [];
    let i = 0, j = 0;
    for (const [pi, pj] of [...pairs, [oldPars.length, newPars.length] as [number, number]]) {
      if (pi > i || pj > j) {
        const olds = clean ? oldPars.slice(i, pi) : rejectOwnChanges(oldPars.slice(i, pi), this.as.author);
        const sub = clean ? this.region(olds, newPars.slice(j, pj)) : this.entries(olds, newPars.slice(j, pj), true);
        // passengers in front of the old paragraph they preceded (all in front when the region's
        // own changes were joined away and the correspondence is gone)
        const exact = olds.length === pi - i && sub.vOld.length === pi - i;
        if (!exact) for (let k = i; k < pi; k++) seq.push(...passengers(k));
        for (const e of sub.seq) {
          if (exact && e.v !== undefined && e.kind !== 'P') seq.push(...passengers(i + e.v));
          seq.push(e.v === undefined ? e : { ...e, v: e.v + vOld.length });
        }
        vOld.push(...sub.vOld);
      }
      seq.push(...passengers(pi));
      if (pi < oldPars.length) { seq.push({ kind: 'K', par: oldPars[pi], v: vOld.length }); vOld.push(oldPars[pi]); }
      i = pi + 1; j = pj + 1;
    }
    return { seq, vOld };
  }

  /** A changed region (no exact matches left): pair similar paragraphs, the rest is deleted / inserted. */
  private region(olds: Paragraph[], news: Paragraph[]): { seq: Entry[]; vOld: Paragraph[] } {
    const pairs = this.pairUp(olds, news);
    const seq: Entry[] = [];
    let i = 0, j = 0;
    for (const [pi, pj] of [...pairs, [olds.length, news.length] as [number, number]]) {
      // deletions before insertions: the reviewer reads old, then new (and breaks stay simple)
      for (; i < pi; i++) seq.push({ kind: 'D', par: this.deletedPar(olds[i]), v: i });
      for (; j < pj; j++) seq.push({ kind: 'I', par: this.insertedPar(news[j]) });
      if (pi < olds.length) seq.push({ kind: 'K', par: this.pairedPar(olds[pi], news[pj]), v: pi });
      i = pi + 1; j = pj + 1;
    }
    return { seq, vOld: olds };
  }

  private pairUp(A: Paragraph[], B: Paragraph[]): [number, number][] {
    const n = A.length, m = B.length;
    if (!n || !m) return [];
    if (n === 1 && m === 1) return A[0].layout === B[0].layout ? [[0, 0]] : [];
    if (n * m > 40000) return [];
    const MIN = 0.3;
    const W = m + 1;
    const sim = new Float64Array(n * m);
    for (let a = 0; a < n; a++) for (let b = 0; b < m; b++) sim[a * m + b] = this.similarity(A[a], B[b]);
    const dp = new Float64Array((n + 1) * W);
    for (let a = n - 1; a >= 0; a--) for (let b = m - 1; b >= 0; b--) {
      const s = sim[a * m + b];
      dp[a * W + b] = Math.max(dp[(a + 1) * W + b], dp[a * W + b + 1], s >= MIN ? s + dp[(a + 1) * W + b + 1] : 0);
    }
    const out: [number, number][] = [];
    let a = 0, b = 0;
    while (a < n && b < m) {
      const s = sim[a * m + b];
      if (s >= MIN && dp[a * W + b] === s + dp[(a + 1) * W + b + 1]) { out.push([a, b]); a++; b++; }
      else if (dp[a * W + b] === dp[(a + 1) * W + b]) a++;
      else b++;
    }
    return out;
  }

  private deletedPar(p: Paragraph): Paragraph {
    return { ...p, items: p.items.map(it => (isDel(it.change) ? it : withChange(it, this.del))) };
  }

  private insertedPar(p: Paragraph): Paragraph {
    return { ...p, items: p.items.filter(it => !isDel(it.change)).map(it => withChange(it, this.ins)) };
  }

  private pairedPar(o: Paragraph, n: Paragraph): Paragraph {
    return { ...o, depth: n.depth, params: n.params, items: this.items(o, n) };
  }

  /**
   * Paragraph breaks of the result. A break before an old paragraph exists in the old reading, a
   * break before a new one in the new reading; one in both keeps its original mark, one only in
   * the old reading is deleted, one only in the new reading inserted. A leading run of inserted
   * (deleted) paragraphs has no break in the old (new) reading before the first old (new) one; a
   * break in neither reading means the two paragraphs are one — they are merged. Already deleted
   * paragraphs (P) are passed through as they are.
   */
  private breaks(all: Entry[], vOld: Paragraph[]): Paragraph[] {
    const out: Paragraph[] = [];
    const seq = all.filter(e => e.kind !== 'P');
    // the passengers in front of each non-P entry, and after the last one
    const front: Paragraph[][] = [];
    let run: Paragraph[] = [];
    for (const e of all) { if (e.kind === 'P') run.push(e.par); else { front.push(run); run = []; } }
    const tail = run;
    let sawOld = false, sawNew = false;
    for (let i = 0; i < seq.length; i++) {
      let e = seq[i];
      out.push(...front[i]);
      sawOld ||= e.kind !== 'I'; sawNew ||= e.kind !== 'D';
      let next = seq[i + 1];
      while (next) {
        const oldView = sawOld && next.kind !== 'I', newView = sawNew && next.kind !== 'D';
        if (oldView || newView) break;
        // the same paragraph in both readings: deleted content, then inserted content
        const [d, n] = e.kind === 'D' ? [e, next] : [next, e];
        e = { kind: 'K', par: { ...d.par, items: [...d.par.items, ...n.par.items] }, v: d.v };
        sawOld = sawNew = true;
        out.push(...front[i + 1]);
        seq.splice(i + 1, 1); front.splice(i + 1, 1);
        next = seq[i + 1];
      }
      const put = (end: Change | undefined) => out.push(changesEqual(e.par.endChange, end) ? e.par : withEnd(e.par, end));
      if (!next) { put(vOld.at(-1)?.endChange); break; }
      const oldView = sawOld && next.kind !== 'I', newView = sawNew && next.kind !== 'D';
      const carried = next.v !== undefined && next.v > 0 ? vOld[next.v - 1].endChange : undefined;
      put(oldView && newView ? carried : oldView ? (isDel(carried) ? carried : this.del) : this.ins);
    }
    out.push(...tail);
    return out;
  }

  /* ---------------------------------------------------------------- within a paragraph */

  private items(o: Paragraph, n: Paragraph): Item[] {
    const A = this.tokens(o), B = this.tokens(n);
    const pairs = align(A.map(t => t.key), B.map(t => t.key));
    let ops: Op[] = [];
    let i = 0, j = 0;
    for (const [pi, pj] of [...pairs, [A.length, B.length] as [number, number]]) {
      if (pi > i || pj > j) ops.push(...this.hunk(A.slice(i, pi), B.slice(j, pj)));
      if (pi < A.length) {
        const last = ops.at(-1);
        if (last?.t === 'same') last.old.push(A[pi]); else ops.push({ t: 'same', old: [A[pi]] });
      }
      i = pi + 1; j = pj + 1;
    }
    ops = cleanup(ops);
    return this.emit(ops);
  }

  /** One changed stretch: containers of the same kind on both sides are entered, the rest refined. */
  private hunk(del: Tok[], add: Tok[]): Op[] {
    const out: Op[] = [];
    let di = 0, aj = 0;
    for (let d = 0; d < del.length; d++) {
      const sig = containerSig(del[d]);
      if (!sig) continue;
      let a = aj;
      while (a < add.length && containerSig(add[a]) !== sig) a++;
      if (a >= add.length) continue;
      out.push(...refine(del.slice(di, d), add.slice(aj, a)));
      // the container itself is entered; passengers riding with its token stay (old) / go (new)
      const [oldItem, ...oldRest] = del[d].parts, newRest = add[a].parts.slice(1);
      out.push({ t: 'rec', item: this.enter((oldItem as { item: Item }).item, (add[a].parts[0] as { item: Item }).item) });
      if (oldRest.length || newRest.length) out.push({ t: 'chg', del: oldRest.length ? [{ ...del[d], parts: oldRest }] : [], add: newRest.length ? [{ ...add[a], parts: newRest }] : [] });
      di = d + 1; aj = a + 1;
    }
    out.push(...refine(del.slice(di), add.slice(aj)));
    return out;
  }

  /** A footnote / box / float / table present on both sides: diff inside it. */
  private enter(o: Item, n: Item): Item {
    const oi = (o as Extract<Item, { kind: 'inset' }>).inset, ni = (n as Extract<Item, { kind: 'inset' }>).inset;
    if (oi.type === 'Text' && ni.type === 'Text') return { ...o, inset: { ...ni, status: oi.status, paragraphs: this.paragraphs(oi.paragraphs, ni.paragraphs, true) } } as Item;
    if (oi.type === 'Tabular' && ni.type === 'Tabular') return { ...o, inset: mapCells(ni, (pars, r, c) => this.paragraphs(oi.rows[r].cells[c].paragraphs, pars, true)) } as Item;
    return o;
  }

  private emit(ops: Op[]): Item[] {
    const out: Item[] = [];
    const text = (t: string, font: FontState, change: Change | undefined) => {
      if (!t) return;
      const last = out.at(-1);
      if (last?.kind === 'text' && fontKey(last.font) === fontKey(font) && changesEqual(last.change, change)) { out[out.length - 1] = { ...last, text: last.text + t }; return; }
      out.push(change ? { kind: 'text', text: t, font, change } : { kind: 'text', text: t, font });
    };
    const put = (tok: Tok, mode: 'same' | 'del' | 'add') => {
      for (const part of tok.parts) {
        const ch = 'item' in part ? part.item.change : part.change;
        // passengers stay with the old side and are dropped from the new one
        const c = isDel(ch) ? (mode === 'add' ? null : ch) : mode === 'same' ? ch : mode === 'del' ? this.del : this.ins;
        if (c === null) continue;
        if ('item' in part) out.push(withChange(part.item, c)); else text(part.text, part.font, c);
      }
    };
    for (const op of ops) {
      if (op.t === 'rec') { out.push(op.item); continue; }
      if (op.t === 'same') { for (const t of op.old) put(t, 'same'); continue; }
      for (const t of op.del) put(t, 'del');
      for (const t of op.add) put(t, 'add');
    }
    return out;
  }
}

/* ------------------------------------------------------------------ token helpers */

function containerSig(t: Tok): string | null {
  const first = t.parts[0];
  if (t.isText || !first || !('item' in first) || isDel(first.item.change) || first.item.kind !== 'inset') return null;
  const ins = first.item.inset, f = fontKey(first.item.font);
  if (ins.type === 'Text') return `T${f}\u0001${ins.name}\u0001${ins.arg}\u0001${ins.params.join('\n')}`;
  if (ins.type === 'Tabular') {
    const spans = ins.rows.map(r => r.cells.map(c => c.attrs.filter(([k]) => k === 'multicolumn' || k === 'multirow').map(([k, v]) => k + v).join()).join(',')).join(';');
    return `G${f}\u0001${ins.rows.length}x${ins.columns.length}\u0001${spans}`;
  }
  return null;
}

const tokLen = (t: Tok): number => (t.isText ? t.text.length : t.key === '\u0005' ? 0 : INSET_WEIGHT);
const sumLen = (ts: Tok[]): number => ts.reduce((n, t) => n + tokLen(t), 0);

/** Parts between two offsets counted in visible characters; a passenger belongs to the slice it starts in. */
function sliceVisible(parts: Part[], from: number, to: number): Part[] {
  const out: Part[] = [];
  let at = 0;
  for (const p of parts) {
    if ('item' in p || partDel(p)) { if (at >= from && (at < to || to === Infinity)) out.push(p); continue; }
    const a = Math.max(from, at), b = Math.min(to, at + p.text.length);
    if (b > a) out.push({ ...p, text: p.text.slice(a - at, b - at) });
    at += p.text.length;
  }
  return out;
}

const wordChar = (c: string | undefined): boolean => !!c && /[\p{L}\p{N}]/u.test(c);
const wordEdge = (str: string, i: number): boolean => !(wordChar(str[i - 1]) && wordChar(str[i]));

/**
 * A replaced stretch of text in one font that mostly survives (a changed number, a typo, a
 * spelling variant, the same words tokenised differently) is narrowed to the characters that
 * actually changed: common prefix and suffix are kept.
 */
function refine(del: Tok[], add: Tok[]): Op[] {
  const whole: Op[] = [{ t: 'chg', del, add }];
  if (!del.length || !add.length) return whole;
  const font = fontKey(add[0].font);
  if (!del.every(t => t.isText && fontKey(t.font) === font) || !add.every(t => t.isText && fontKey(t.font) === font)) return whole;
  const a = del.map(t => t.text).join(''), b = add.map(t => t.text).join('');
  let p = 0;
  while (p < a.length && p < b.length && a[p] === b[p]) p++;
  let s = 0;
  while (s < a.length - p && s < b.length - p && a[a.length - 1 - s] === b[b.length - 1 - s]) s++;
  // inside one replaced word any cut is fine (colo[u]r); across words only at word edges, so a
  // reworded phrase does not read "[S→The s]econd"
  if (!(del.length === 1 && add.length === 1)) {
    while (p > 0 && !(wordEdge(a, p) && wordEdge(b, p))) p--;
    while (s > 0 && !(wordEdge(a, a.length - s) && wordEdge(b, b.length - s))) s--;
  }
  if (!(p + s > 0 && (p + s) * 2 >= Math.max(a.length, b.length))) return whole;
  const parts = del.flatMap(t => t.parts);
  const tok = (ps: Part[]): Tok => ({ key: '', text: ps.map(x => ('item' in x || partDel(x) ? '' : x.text)).join(''), isText: true, ws: false, font: del[0].font, parts: ps });
  const out: Op[] = [];
  const head = sliceVisible(parts, 0, p), mid = sliceVisible(parts, p, a.length - s), tail = sliceVisible(parts, a.length - s, Infinity);
  const midNew = b.slice(p, b.length - s);
  if (head.length) out.push({ t: 'same', old: [tok(head)] });
  out.push({ t: 'chg', del: mid.length ? [tok(mid)] : [], add: midNew ? [tok([{ text: midNew, font: add[0].font }])] : [] });
  if (tail.length) out.push({ t: 'same', old: [tok(tail)] });
  return out;
}

/**
 * Semantic cleanup: an unchanged stretch of plain text between two changes that is no longer than
 * either of them is folded into one change, so a rewritten phrase is one deletion + one insertion.
 */
function cleanup(ops: Op[]): Op[] {
  ops = ops.filter(op => op.t !== 'chg' || op.del.length || op.add.length);
  for (let changed = true; changed;) {
    changed = false;
    for (let k = 1; k + 1 < ops.length; k++) {
      const prev = ops[k - 1], mid = ops[k], next = ops[k + 1];
      if (prev.t !== 'chg' || mid.t !== 'same' || next.t !== 'chg') continue;
      if (!mid.old.every(t => t.isText)) continue;
      const len = sumLen(mid.old);
      if (len > Math.max(sumLen(prev.del), sumLen(prev.add)) || len > Math.max(sumLen(next.del), sumLen(next.add))) continue;
      // the unchanged text becomes deleted + re-inserted (its passengers stay on the deleted side)
      const again = mid.old.map(t => ({ ...t, parts: t.parts.filter(x => !('item' in x) && !partDel(x)).map(x => ({ text: (x as { text: string }).text, font: (x as { font: FontState }).font })) }));
      ops.splice(k - 1, 3, { t: 'chg', del: [...prev.del, ...mid.old, ...next.del], add: [...prev.add, ...again, ...next.add] });
      changed = true;
      break;
    }
  }
  // adjacent same-type ops (after folding)
  const out: Op[] = [];
  for (const op of ops) {
    const last = out.at(-1);
    if (last?.t === 'same' && op.t === 'same') last.old.push(...op.old);
    else if (last?.t === 'chg' && op.t === 'chg') { last.del.push(...op.del); last.add.push(...op.add); }
    else out.push(op.t === 'same' ? { t: 'same', old: op.old.slice() } : op.t === 'chg' ? { t: 'chg', del: op.del.slice(), add: op.add.slice() } : op);
  }
  return out;
}
