/**
 * Three-way merge of LyX documents at paragraph granularity.
 *
 * `base` is what the file contained when it was last read or written, `ours` is the live
 * document (with edits that are not on disk yet), `theirs` is what somebody else wrote to the
 * file meanwhile (desktop LyX, git, another editor). The result is `ours` with every region
 * that changed on disk taken from `theirs`; where both sides changed the same region, the disk
 * wins (the change on disk is the one that cannot be recovered otherwise — ours is still in the
 * CRDT history and the editor's versions).
 *
 * Paragraphs are compared by their LyX serialisation. Regions are computed in `base` coordinates
 * and grown until their boundaries are paragraphs that neither side touched, so that they can be
 * located in both `ours` and `theirs`.
 */
import type { LyxDocument, Paragraph } from './ast.ts';
import { writeParagraph } from './writer.ts';

/** Pairs (i, j) of equal elements forming a longest common subsequence (common prefix / suffix first, DP for the middle). */
export function align(a: string[], b: string[]): [number, number][] {
  const pairs: [number, number][] = [];
  let p = 0;
  while (p < a.length && p < b.length && a[p] === b[p]) { pairs.push([p, p]); p++; }
  let sa = a.length, sb = b.length;
  while (sa > p && sb > p && a[sa - 1] === b[sb - 1]) { sa--; sb--; }
  const n = sa - p, m = sb - p;
  if (n > 0 && m > 0) {
    if (n * m > 6_000_000) {
      // too different for the quadratic LCS: anchor on paragraphs that are unique on both sides
      const count = (xs: string[]) => { const c = new Map<string, number>(); for (const x of xs) c.set(x, (c.get(x) ?? 0) + 1); return c; };
      const ca = count(a.slice(p, sa)), cb = count(b.slice(p, sb));
      const posB = new Map<string, number>();
      for (let j = p; j < sb; j++) if (cb.get(b[j]) === 1 && ca.get(b[j]) === 1) posB.set(b[j], j);
      let lastJ = p - 1;
      for (let i = p; i < sa; i++) { const j = posB.get(a[i]); if (j !== undefined && j > lastJ) { pairs.push([i, j]); lastJ = j; } }
    } else {
      const W = m + 1;
      const dp = new Uint32Array((n + 1) * W);
      for (let i = n - 1; i >= 0; i--) for (let j = m - 1; j >= 0; j--) {
        dp[i * W + j] = a[p + i] === b[p + j] ? dp[(i + 1) * W + j + 1] + 1 : Math.max(dp[(i + 1) * W + j], dp[i * W + j + 1]);
      }
      let i = 0, j = 0;
      while (i < n && j < m) {
        if (a[p + i] === b[p + j]) { pairs.push([p + i, p + j]); i++; j++; }
        else if (dp[(i + 1) * W + j] >= dp[i * W + j + 1]) i++;
        else j++;
      }
    }
  }
  for (let k = 0; sa + k < a.length; k++) pairs.push([sa + k, sb + k]);
  return pairs;
}

interface Region { start: number; end: number }   // base paragraph indices [start, end)

/** Base regions that `other` changed: unmatched base paragraphs, and (empty) insertion points. */
function changedRegions(baseLen: number, pairs: [number, number][], otherLen: number): Region[] {
  const out: Region[] = [];
  let bi = 0, oi = 0;
  for (const [pb, po] of [...pairs, [baseLen, otherLen] as [number, number]]) {
    if (pb > bi || po > oi) out.push({ start: bi, end: pb });
    bi = pb + 1; oi = po + 1;
  }
  return out;
}

/** How a region both sides touched is resolved: base, ours and theirs versions of it → the result. */
export type RegionMerge = (base: Paragraph[], ours: Paragraph[], theirs: Paragraph[]) => Paragraph[];

/**
 * A region resolved paragraph by paragraph when all three versions have the same number of
 * paragraphs (edits in place, e.g. neighbouring paragraphs changed on either side): each side's
 * change is kept, theirs where both changed the same paragraph; otherwise theirs as a whole.
 */
export const mergeInPlace: RegionMerge = (b, o, t) => {
  if (b.length !== o.length || b.length !== t.length) return t;
  return b.map((bp, k) => (writeParagraph(t[k]) === writeParagraph(bp) ? o[k] : t[k]));
};

/** Where `side` replaced base paragraphs [start, end) by its own [from, to) (an insertion: start === end). */
interface Hunk { start: number; end: number; from: number; to: number }
function hunks(baseLen: number, pairs: [number, number][], sideLen: number): Hunk[] {
  const out: Hunk[] = [];
  let bi = 0, si = 0;
  for (const [pb, ps] of [...pairs, [baseLen, sideLen] as [number, number]]) {
    if (pb > bi || ps > si) out.push({ start: bi, end: pb, from: si, to: ps });
    bi = pb + 1; si = ps + 1;
  }
  return out;
}

/**
 * A region resolved by each side's own changes where they touch different paragraphs — a paragraph
 * typed or changed next to one that changed on disk, a new paragraph inserted before it — and as
 * mergeInPlace where both changed the same paragraph (the disk wins there). mergeLyx grows a region
 * over changes that merely touch, so that its edges can be found on both sides; taken from `theirs`
 * as a whole, what was typed in the neighbouring paragraph was lost (the VS Code extension, 21 Nov 2026).
 */
export const mergeApart: RegionMerge = (b, o, t) => {
  const kb = b.map(p => writeParagraph(p)), ko = o.map(p => writeParagraph(p)), kt = t.map(p => writeParagraph(p));
  const pairsO = align(kb, ko);
  const ho = hunks(kb.length, pairsO, ko.length), ht = hunks(kb.length, align(kb, kt), kt.length);
  const clash = (x: Hunk, y: Hunk) => (x.start < y.end && y.start < x.end)
    || (x.start === x.end && y.start === y.end && x.start === y.start)          // two insertions at one place: which first?
    || (x.start === x.end && x.start > y.start && x.start < y.end)             // an insertion inside the other's change
    || (y.start === y.end && y.start > x.start && y.start < x.end);
  if (ho.some(x => ht.some(y => clash(x, y)))) return mergeInPlace(b, o, t);
  const oursAt = new Map(pairsO);
  const all = [...ho.map(h => ({ ...h, side: o })), ...ht.map(h => ({ ...h, side: t }))]
    .sort((x, y) => x.start - y.start || (x.end - x.start) - (y.end - y.start));   // an insertion before a change at the same place
  const out: Paragraph[] = [];
  let i = 0;
  for (const h of all) {
    for (; i < h.start; i++) out.push(o[oursAt.get(i)!]);
    out.push(...h.side.slice(h.from, h.to));
    i = Math.max(i, h.end);
  }
  for (; i < kb.length; i++) out.push(o[oursAt.get(i)!]);
  return out;
};

export function mergeLyx(base: LyxDocument, ours: LyxDocument, theirs: LyxDocument, combine?: RegionMerge): LyxDocument {
  const kb = base.body.map(writeParagraph), ko = ours.body.map(writeParagraph), kt = theirs.body.map(writeParagraph);
  const bo = align(kb, ko), bt = align(kb, kt);
  const mapO = new Map(bo), mapT = new Map(bt);
  const theirRegions = changedRegions(kb.length, bt, kt.length);
  const ourRegions = changedRegions(kb.length, bo, ko.length);
  // grow every region changed on disk by the regions we changed that overlap or touch it
  const regions: Region[] = [];
  for (const r of theirRegions) {
    let { start, end } = r;
    let grown = true;
    while (grown) {
      grown = false;
      for (const o of ourRegions) if (o.start <= end && o.end >= start && (o.start < start || o.end > end)) { start = Math.min(start, o.start); end = Math.max(end, o.end); grown = true; }
      const last = regions[regions.length - 1];
      if (last && last.end >= start) { start = Math.min(start, last.start); end = Math.max(end, last.end); regions.pop(); grown = true; }
    }
    regions.push({ start, end });
  }
  // an index just outside a region is matched on both sides (or is the document edge)
  const body: Paragraph[] = ours.body.slice();
  for (let k = regions.length - 1; k >= 0; k--) {
    const { start, end } = regions[k];
    const oursStart = start === 0 ? 0 : mapO.get(start - 1)! + 1;
    const oursEnd = end >= kb.length ? body.length : mapO.get(end)!;
    const theirsStart = start === 0 ? 0 : mapT.get(start - 1)! + 1;
    const theirsEnd = end >= kb.length ? theirs.body.length : mapT.get(end)!;
    const theirsPart = theirs.body.slice(theirsStart, theirsEnd);
    body.splice(oursStart, oursEnd - oursStart, ...(combine ? combine(base.body.slice(start, end), body.slice(oursStart, oursEnd), theirsPart) : theirsPart));
  }
  const same = (x: string[], y: string[]) => x.length === y.length && x.every((l, i) => l === y[i]);
  return {
    preamble: same(base.preamble, theirs.preamble) ? ours.preamble : theirs.preamble,
    format: base.format === theirs.format ? ours.format : theirs.format,
    header: { lines: same(base.header.lines, theirs.header.lines) ? ours.header.lines : theirs.header.lines },
    body,
    trailer: same(base.trailer, theirs.trailer) ? ours.trailer : theirs.trailer,
  };
}
