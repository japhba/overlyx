/**
 * Comparing two texts for the History pane: changed regions by lines (common lines at both ends
 * skipped first, then a longest-common-subsequence over what is left), and within a region the
 * changed words — so that a sentence with one word changed shows that word, not two whole lines.
 */

/** a line with its line break (the last one may have none): joined again they are the text exactly */
export function splitLines(text: string): string[] {
  if (!text) return [];
  const out = text.split(/(?<=\n)/);
  return out;
}

/** one changed region: lines [a0, a1) of the old text became lines [b0, b1) of the new one */
export interface Region { a0: number; a1: number; b0: number; b1: number }

const same = (x: string, y: string) => x === y || (x.endsWith('\n') !== y.endsWith('\n') && x.replace(/\n$/, '') === y.replace(/\n$/, ''));

/** the longest-common-subsequence pairs of two short arrays (null: too big to compare in memory) */
function lcs(A: string[], B: string[], eq: (x: string, y: string) => boolean, max = 6_000_000): [number, number][] | null {
  const n = A.length, m = B.length;
  if (n * m > max) return null;
  const w = m + 1;
  const dp = new Uint32Array((n + 1) * w);
  for (let i = n - 1; i >= 0; i--) for (let j = m - 1; j >= 0; j--) {
    dp[i * w + j] = eq(A[i], B[j]) ? dp[(i + 1) * w + j + 1] + 1 : Math.max(dp[(i + 1) * w + j], dp[i * w + j + 1]);
  }
  const out: [number, number][] = [];
  let i = 0, j = 0;
  while (i < n && j < m) {
    if (eq(A[i], B[j])) { out.push([i, j]); i++; j++; }
    else if (dp[(i + 1) * w + j] >= dp[i * w + j + 1]) i++;
    else j++;
  }
  return out;
}

/** The changed regions between two lists of lines. */
export function diffRegions(A: string[], B: string[]): Region[] {
  let p = 0;
  while (p < A.length && p < B.length && same(A[p], B[p])) p++;
  let s = 0;
  while (s < A.length - p && s < B.length - p && same(A[A.length - 1 - s], B[B.length - 1 - s])) s++;
  const a = A.slice(p, A.length - s), b = B.slice(p, B.length - s);
  if (!a.length && !b.length) return [];
  const pairs = lcs(a, b, same) ?? [];
  const out: Region[] = [];
  let i = 0, j = 0;
  for (const [pi, pj] of [...pairs, [a.length, b.length] as [number, number]]) {
    if (pi > i || pj > j) out.push({ a0: p + i, a1: p + pi, b0: p + j, b1: p + pj });
    i = pi + 1; j = pj + 1;
  }
  return out;
}

/** a piece of a region's text: unchanged, or only in the old (del) / new (add) text */
export interface Piece { kind: 'same' | 'del' | 'add'; text: string }

const TOKEN = /\s+|[\p{L}\p{N}_]+|[^\s\p{L}\p{N}_]/gu;

/**
 * The words that changed between two passages: the old passage's pieces (same / del) and the new
 * one's (same / add). A passage too long to compare word by word is all changed.
 */
export function wordDiff(a: string, b: string): { old: Piece[]; new: Piece[] } {
  const A = a.match(TOKEN) ?? [], B = b.match(TOKEN) ?? [];
  const pairs = lcs(A, B, (x, y) => x === y, 4_000_000);
  if (!pairs) return { old: a ? [{ kind: 'del', text: a }] : [], new: b ? [{ kind: 'add', text: b }] : [] };
  const old: Piece[] = [], neu: Piece[] = [];
  const push = (list: Piece[], kind: Piece['kind'], text: string) => {
    if (!text) return;
    const last = list[list.length - 1];
    if (last && last.kind === kind) last.text += text; else list.push({ kind, text });
  };
  let i = 0, j = 0;
  for (const [pi, pj] of [...pairs, [A.length, B.length] as [number, number]]) {
    push(old, 'del', A.slice(i, pi).join(''));
    push(neu, 'add', B.slice(j, pj).join(''));
    if (pi < A.length) { push(old, 'same', A[pi]); push(neu, 'same', B[pj]); }
    i = pi + 1; j = pj + 1;
  }
  // a changed word between two unchanged blanks reads better with the blank kept apart: nothing to do;
  // but a lone unchanged blank between two changes is noise — fold it into the changes
  return { old: fold(old, 'del'), new: fold(neu, 'add') };
}

function fold(list: Piece[], kind: 'del' | 'add'): Piece[] {
  const out: Piece[] = [];
  for (let k = 0; k < list.length; k++) {
    const p = list[k];
    if (p.kind === 'same' && /^\s+$/.test(p.text) && list[k - 1]?.kind === kind && list[k + 1]?.kind === kind) {
      out[out.length - 1].text += p.text + list[k + 1].text;
      k++;
      continue;
    }
    const last = out[out.length - 1];
    if (last && last.kind === p.kind) last.text += p.text; else out.push({ ...p });
  }
  return out;
}

/** a region with its context, ready to show: the unchanged lines before and after it, its texts and their changed words */
export interface Hunk {
  region: Region;
  before: string[];
  after: string[];
  /** the line numbers (1-based) where the old / new passage starts */
  aLine: number;
  bLine: number;
  oldText: string;
  newText: string;
  words: { old: Piece[]; new: Piece[] };
  /** where the new passage starts in the new text (characters) */
  bOffset: number;
}

/** The hunks of a comparison: every changed region with `context` unchanged lines around it. */
export function hunks(oldText: string, newText: string, context = 2): Hunk[] {
  const A = splitLines(oldText), B = splitLines(newText);
  const regions = diffRegions(A, B);
  const offsets: number[] = [0];
  for (const l of B) offsets.push(offsets[offsets.length - 1] + l.length);
  return regions.map((r, k) => {
    const prevEnd = k ? regions[k - 1].b1 : 0, nextStart = k + 1 < regions.length ? regions[k + 1].b0 : B.length;
    const oldPart = A.slice(r.a0, r.a1).join(''), newPart = B.slice(r.b0, r.b1).join('');
    return {
      region: r,
      before: B.slice(Math.max(prevEnd, r.b0 - context), r.b0),
      after: B.slice(r.b1, Math.min(nextStart, r.b1 + context)),
      aLine: r.a0 + 1, bLine: r.b0 + 1,
      oldText: oldPart, newText: newPart,
      words: wordDiff(oldPart, newPart),
      bOffset: offsets[r.b0],
    };
  });
}

/** how much changed: lines taken out and put in */
export function changeCount(list: Hunk[]): { added: number; removed: number } {
  let added = 0, removed = 0;
  for (const h of list) { added += h.region.b1 - h.region.b0; removed += h.region.a1 - h.region.a0; }
  return { added, removed };
}
