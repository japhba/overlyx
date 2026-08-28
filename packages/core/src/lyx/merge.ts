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

export function mergeLyx(base: LyxDocument, ours: LyxDocument, theirs: LyxDocument): LyxDocument {
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
    body.splice(oursStart, oursEnd - oursStart, ...theirs.body.slice(theirsStart, theirsEnd));
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
