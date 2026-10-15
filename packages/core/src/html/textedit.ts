/**
 * Small edits to a contenteditable's HTML, not replacements of a stale whole box.
 * Tags, entities and Unicode code points are indivisible. A bounded diff avoids
 * quadratic work for large pastes; an ambiguous concurrent replacement is rejected
 * so the caller can keep the draft rather than silently erase somebody's work.
 */
import type { Splice } from './source.ts';

const atoms = (s: string): string[] => s.match(/<!--[\s\S]*?-->|<(?:[^>"']|"[^"]*"|'[^']*')*>|&(?:#[xX][\da-fA-F]+|#\d+|[\w]+);|[\s\S]/gu) ?? [];
const MAX_CELLS = 2_000_000;

/** Minimal non-overlapping changes in the old string's UTF-16 coordinates. */
export function textChanges(before: string, after: string): Splice[] {
  if (before === after) return [];
  const a = atoms(before), b = atoms(after);
  let p = 0, ae = a.length, be = b.length;
  while (p < ae && p < be && a[p] === b[p]) p++;
  while (ae > p && be > p && a[ae - 1] === b[be - 1]) { ae--; be--; }
  const offsets = [0];
  for (const token of a) offsets.push(offsets[offsets.length - 1] + token.length);
  const n = ae - p, m = be - p;
  if (!n || !m || n * m > MAX_CELLS) return [{ from: offsets[p], to: offsets[ae], insert: b.slice(p, be).join('') }];
  const width = m + 1;
  const dp = new Uint32Array((n + 1) * width);
  for (let i = n - 1; i >= 0; i--) for (let j = m - 1; j >= 0; j--) {
    dp[i * width + j] = a[p + i] === b[p + j]
      ? dp[(i + 1) * width + j + 1] + 1
      : Math.max(dp[(i + 1) * width + j], dp[i * width + j + 1]);
  }
  const out: Splice[] = [];
  let i = p, j = p, start = p, inserted = '';
  const flush = () => {
    if (start !== i || inserted) out.push({ from: offsets[start], to: offsets[i], insert: inserted });
    start = i; inserted = '';
  };
  while (i < ae && j < be) {
    if (a[i] === b[j]) { flush(); i++; j++; start = i; }
    else if (dp[(i - p + 1) * width + j - p] >= dp[(i - p) * width + j - p + 1]) i++;
    else inserted += b[j++];
  }
  i = ae;
  inserted += b.slice(j, be).join('');
  flush();
  return out;
}

/** Map a boundary through edits; null inside replaced/deleted content. */
export function mapTextOffset(changes: readonly Splice[], offset: number, afterInsert = true): number | null {
  let delta = 0;
  for (const change of changes) {
    if (offset < change.from) break;
    if (change.from < offset && offset < change.to) return null;
    if (change.to <= offset && (change.to < offset || change.from !== change.to || afterInsert)) delta += change.insert.length - (change.to - change.from);
  }
  return offset + delta;
}

const identical = (a: Splice, b: Splice) => a.from === b.from && a.to === b.to && a.insert === b.insert;
const overlaps = (a: Splice, b: Splice) =>
  Math.max(a.from, b.from) < Math.min(a.to, b.to)
  || (a.from === a.to && b.from < a.from && a.from < b.to)
  || (b.from === b.to && a.from < b.from && b.from < a.to);

/** Splices of current that apply only the local before→after edits. */
export function mergedTextSplices(before: string, after: string, current: string): Splice[] | null {
  if (after === current || before === after) return [];
  const own = textChanges(before, after);
  if (before === current) return own;
  const remote = textChanges(before, current);
  const out: Splice[] = [];
  for (const change of own) {
    if (remote.some(other => identical(change, other))) continue;
    if (remote.some(other => overlaps(change, other))) return null;
    const from = mapTextOffset(remote, change.from, true);
    const to = change.to === change.from ? from : mapTextOffset(remote, change.to, false);
    if (from === null || to === null || to < from) return null;
    out.push({ from, to, insert: change.insert });
  }
  return out;
}

export function spliceText(text: string, changes: readonly Splice[]): string {
  let out = text;
  for (const change of [...changes].sort((a, b) => b.from - a.from || b.to - a.to)) out = out.slice(0, change.from) + change.insert + out.slice(change.to);
  return out;
}

/** Concurrent formatting must not produce crossing tags that the parser repairs unpredictably. */
export function balancedInlineHtml(html: string): boolean {
  const stack: string[] = [];
  for (const token of atoms(html)) {
    if (!token.startsWith('<') || /^<!--|^<!|^<\?/.test(token)) continue;
    const match = /^<(\/)?([\w:-]+)/.exec(token);
    if (!match) continue;
    const name = match[2].toLowerCase();
    if (/^(area|base|br|col|embed|hr|img|input|link|meta|param|source|track|wbr)$/.test(name) || /\/>$/.test(token)) continue;
    if (match[1]) { if (stack.pop() !== name) return false; }
    else stack.push(name);
  }
  return !stack.length;
}
