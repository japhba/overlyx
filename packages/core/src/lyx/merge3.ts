/**
 * Three-way merge of an offline copy with the live document, word by word (the server's
 * offlinemerge.ts: an editor that worked offline has reconnected).
 *
 * The CRDT has merged both sides already, and wherever they changed different words it got it
 * right. Where both changed the *same* words it interleaved them, and nobody would notice. This
 * finds those places:
 *
 *  - paragraphs are aligned as in merge.ts; a run of paragraphs only one side changed is that side's;
 *  - a run both changed is merged by tokens — words, whitespace runs, insets and paragraph starts,
 *    so a paragraph split on one side and edited on the other merges too — with the classic diff3:
 *    between tokens neither side touched, a chunk only one side changed (or both alike) is taken,
 *    and a chunk both changed differently is a conflict;
 *  - a footnote, note or other text inset both changed is merged inside the same way.
 *
 * The result has two readings that differ only in the conflicts: `live` (the live document's
 * version of each) and `offline` (the offline copy's). `reviewBody` lays the offline reading over
 * the live one as tracked changes: Reject keeps the live text, Accept takes the offline one.
 */
import type { Paragraph, Item, FontState, Change } from './ast.ts';
import { FONT_KEYS } from './ast.ts';
import { align } from './merge.ts';
import { writeParagraph } from './writer.ts';
import { trackDiff, changeStats, type TrackAs } from './trackdiff.ts';

export interface Merge3 {
  /** the merge with the live document's version of every conflict */
  live: Paragraph[];
  /** the merge with the offline copy's version of every conflict */
  offline: Paragraph[];
  /** places both sides changed differently */
  conflicts: number;
}

type Chunk<T> = { same: T[] } | { b: T[]; o: T[]; t: T[] };

/** Three versions of a list in chunks: runs equal in all three, and the runs between them. */
function diff3<T>(b: T[], o: T[], t: T[], key: (x: T) => string): { chunks: Chunk<T>[]; kb: Map<T, string> } {
  const kb = new Map<T, string>();
  const keys = (xs: T[]) => xs.map(x => { let k = kb.get(x); if (k === undefined) kb.set(x, k = key(x)); return k; });
  const mo = new Map(align(keys(b), keys(o))), mt = new Map(align(keys(b), keys(t)));
  const chunks: Chunk<T>[] = [];
  let ib = 0, io = 0, it = 0;
  const between = (eb: number, eo: number, et: number) => {
    if (eb > ib || eo > io || et > it) chunks.push({ b: b.slice(ib, eb), o: o.slice(io, eo), t: t.slice(it, et) });
  };
  for (let i = 0; i < b.length; i++) {
    const jo = mo.get(i), jt = mt.get(i);
    if (jo === undefined || jt === undefined) continue;
    between(i, jo, jt);
    const last = chunks.at(-1);
    if (last && 'same' in last && ib === i) last.same.push(o[jo]); else chunks.push({ same: [o[jo]] });
    ib = i + 1; io = jo + 1; it = jt + 1;
  }
  between(b.length, o.length, t.length);
  return { chunks, kb };
}

/** What a chunk both sides did not change differently comes to (null: a conflict). */
function settled<T>(c: { b: T[]; o: T[]; t: T[] }, keyOf: (x: T) => string): T[] | null {
  const kb = c.b.map(keyOf), ko = c.o.map(keyOf), kt = c.t.map(keyOf);
  const eq = (x: string[], y: string[]) => x.length === y.length && x.every((v, i) => v === y[i]);
  if (eq(ko, kb)) return c.t;
  if (eq(kt, kb) || eq(kt, ko)) return c.o;
  return null;
}

/** `base` → `live` and `base` → `offline` merged (see the module comment). */
export function merge3(base: Paragraph[], live: Paragraph[], offline: Paragraph[]): Merge3 {
  const out: Merge3 = { live: [], offline: [], conflicts: 0 };
  const keys = new Map<Paragraph, string>();
  const key = (p: Paragraph) => { let k = keys.get(p); if (k === undefined) keys.set(p, k = writeParagraph(p)); return k; };
  for (const c of diff3(base, live, offline, key).chunks) {
    if ('same' in c) { out.live.push(...c.same); out.offline.push(...c.same); continue; }
    const taken = settled(c, key);
    if (taken) { out.live.push(...taken); out.offline.push(...taken); continue; }
    const m = mergeRegion(c.b, c.o, c.t);
    out.live.push(...m.live); out.offline.push(...m.offline); out.conflicts += m.conflicts;
  }
  return out;
}

/** The merge laid out for review: the live reading, with the offline one over it as tracked changes by `as`. */
export function reviewBody(m: Merge3, as: TrackAs): Paragraph[] {
  return m.conflicts ? trackDiff(m.live, m.offline, as) : m.live;
}

/**
 * The live document `now` with the conflicts of `review` (a reviewBody of `before`, the live
 * document as it was when the merge was computed) put in: paragraphs of `review` holding changes
 * `as` made replace theirs in `now`; everything else stays as `now` has it (the CRDT's merge).
 */
export function adoptReview(before: Paragraph[], now: Paragraph[], review: Paragraph[], as: TrackAs): Paragraph[] {
  const marked = (p: Paragraph) => { const st = changeStats([p], as); return st.inserted + st.deleted > 0; };
  const pk = new Map<Paragraph, string>();
  const key = (p: Paragraph) => { let k = pk.get(p); if (k === undefined) pk.set(p, k = writeParagraph(p)); return k; };
  const out: Paragraph[] = [];
  // align `before` with both; where `review` differs from `before` and carries marks, it wins
  for (const c of diff3(before, now, review, key).chunks) {
    if ('same' in c) { out.push(...c.same); continue; }
    if (!c.t.some(marked)) { out.push(...c.o); continue; }
    out.push(...(c.o.length === c.t.length ? c.t.map((p, k) => (marked(p) ? p : c.o[k])) : c.t));
  }
  return out;
}

/* ------------------------------------------------------------------ within paragraphs */

/** A token of a paragraph run: the start of a paragraph (its attributes), or an item — a word, a whitespace run, an inset. */
interface Tok { key: string; par?: Paragraph; item?: Item }

const fontKey = (f: FontState): string => FONT_KEYS.map(k => f[k] ?? '').join('|');
const changeKey = (c?: Change): string => (c ? `${c.type}:${c.author}:${c.time}` : '');

function tokens(pars: Paragraph[]): Tok[] {
  const out: Tok[] = [];
  for (const p of pars) {
    const { items: _items, ...attrs } = p;
    out.push({ key: 'P' + JSON.stringify(attrs), par: { ...attrs, items: [] } });
    for (const it of p.items) {
      if (it.kind !== 'text') { out.push({ key: 'i' + JSON.stringify(it), item: it }); continue; }
      for (const seg of it.text.match(/[ \t\r\n]+|[^ \t\r\n]+/g) ?? []) {
        out.push({ key: `t${fontKey(it.font)}\u0001${changeKey(it.change)}\u0001${seg}`, item: { ...it, text: seg } });
      }
    }
  }
  return out;
}

/** Paragraphs from tokens (adjacent text of one font and change joined); `like`: attributes for text before any paragraph start. */
function rebuild(toks: Tok[], like: Paragraph[]): Paragraph[] {
  const out: Paragraph[] = [];
  for (const t of toks) {
    if (t.par) { out.push({ ...t.par, items: [] }); continue; }
    let p = out.at(-1);
    if (!p) {
      const l = like[0];
      out.push(p = { layout: l?.layout ?? 'Standard', depth: l?.depth ?? 0, params: l?.params ?? {}, items: [] });
    }
    const it = t.item!, last = p.items.at(-1);
    if (it.kind === 'text' && last?.kind === 'text' && fontKey(last.font) === fontKey(it.font) && changeKey(last.change) === changeKey(it.change)) {
      p.items[p.items.length - 1] = { ...last, text: last.text + it.text };
    } else p.items.push(it);
  }
  return out;
}

/** A run of paragraphs both sides changed, merged by tokens. */
function mergeRegion(b: Paragraph[], o: Paragraph[], t: Paragraph[]): Merge3 {
  const live: Tok[] = [], off: Tok[] = [];
  let conflicts = 0;
  const keyOf = (x: Tok) => x.key;
  for (const c of diff3(tokens(b), tokens(o), tokens(t), keyOf).chunks) {
    if ('same' in c) { live.push(...c.same); off.push(...c.same); continue; }
    const taken = settled(c, keyOf);
    if (taken) { live.push(...taken); off.push(...taken); continue; }
    const inner = insetMerge(c);
    if (inner) { live.push(inner.live); off.push(inner.offline); conflicts += inner.conflicts; continue; }
    live.push(...c.o); off.push(...c.t); conflicts++;
  }
  return { live: rebuild(live, o), offline: rebuild(off, t), conflicts };
}

/** One text inset (a footnote, a note…) both sides changed: merged inside. Null when the chunk is anything else. */
function insetMerge(c: { b: Tok[]; o: Tok[]; t: Tok[] }): { live: Tok; offline: Tok; conflicts: number } | null {
  if (c.b.length !== 1 || c.o.length !== 1 || c.t.length !== 1) return null;
  const [ib, io, it] = [c.b[0].item, c.o[0].item, c.t[0].item];
  if (ib?.kind !== 'inset' || io?.kind !== 'inset' || it?.kind !== 'inset') return null;
  const [xb, xo, xt] = [ib.inset, io.inset, it.inset];
  if (xb.type !== 'Text' || xo.type !== 'Text' || xt.type !== 'Text') return null;
  // the inset itself (kind, parameters, font, change) the same on all three sides: only its text changed
  const shell = (x: Item) => JSON.stringify({ ...x, inset: { ...(x as { inset: object }).inset, paragraphs: null } });
  if (shell(ib) !== shell(io) || shell(ib) !== shell(it)) return null;
  const m = merge3(xb.paragraphs, xo.paragraphs, xt.paragraphs);
  const tok = (pars: Paragraph[]): Tok => {
    const item: Item = { ...io, inset: { ...xo, paragraphs: pars } };
    return { key: 'i' + JSON.stringify(item), item };
  };
  return { live: tok(m.live), offline: tok(m.offline), conflicts: m.conflicts };
}
