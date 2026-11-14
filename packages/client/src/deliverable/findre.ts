/**
 * Find on slides: what a search looks for — shared by the editor (slidefind.ts, on the deck's source)
 * and the canvas frame (runtime/findmarks.ts, on the slides shown), so both count the same matches.
 * No imports: the runtime bundles it.
 */
export interface FindOpts { query: string; matchCase: boolean; words: boolean }

/** the search as a regular expression (null: nothing to look for) — a space finds any run of spaces and line breaks */
export function findRegExp(o: FindOpts): RegExp | null {
  const q = o.query.trim() ? o.query : '';
  if (!q) return null;
  const body = q.split(/\s+/).map(p => p.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('\\s+');
  const src = o.words ? `(?<![\\p{L}\\p{N}_])${body}(?![\\p{L}\\p{N}_])` : body;
  try { return new RegExp(src, 'gu' + (o.matchCase ? '' : 'i')); } catch { return null; }
}

/** the formulas of a text (their TeX: \( \), \[ \], $ $, $$ $$) — a search does not look inside them */
export function mathSpans(s: string): [number, number][] {
  const out: [number, number][] = [];
  const re = /\\\(([\s\S]*?)\\\)|\\\[([\s\S]*?)\\\]|\$\$([\s\S]*?)\$\$|(?<![\\$])\$(?!\s)([^$\n]*?[^\s\\])\$/g;
  for (const m of s.matchAll(re)) out.push([m.index!, m.index! + m[0].length]);
  return out;
}

/** the matches of `re` in `s` outside its formulas: [from, to) */
export function matchesIn(s: string, re: RegExp): [number, number][] {
  const math = s.includes('\\') || s.includes('$') ? mathSpans(s) : [];
  const out: [number, number][] = [];
  re.lastIndex = 0;
  for (const m of s.matchAll(re)) {
    const a = m.index!, b = a + m[0].length;
    if (b === a) continue;
    if (math.some(([x, y]) => a < y && b > x)) continue;
    out.push([a, b]);
  }
  return out;
}
