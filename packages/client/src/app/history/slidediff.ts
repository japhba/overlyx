/**
 * Comparing two versions of a deck or poster slide by slide (the History pane): which slides
 * changed, came or went, and each slide alone as a page a frame can show.
 */
import { parseSource, outerRange } from '@overlyx/core/html/source.ts';
import { slideElements } from '@overlyx/core/html/deliverable.ts';

export interface SlideChange {
  kind: 'changed' | 'added' | 'removed';
  /** the slide's number in the old / new version (1-based; null: not there) */
  oldNo: number | null;
  newNo: number | null;
}

export interface Slides { text: string; ranges: { from: number; to: number }[] }

export function slidesOf(text: string): Slides {
  try {
    const { doc } = parseSource(text);
    return { text, ranges: slideElements(doc).map(outerRange) };
  } catch { return { text, ranges: [] }; }
}

const norm = (s: string) => s.replace(/\s+/g, ' ').trim();

/** The slides that differ, in the new version's order (a removed one where it was). */
export function slideChanges(a: Slides, b: Slides): SlideChange[] {
  const A = a.ranges.map(r => norm(a.text.slice(r.from, r.to))), B = b.ranges.map(r => norm(b.text.slice(r.from, r.to)));
  // longest common subsequence of the slides (decks have tens of slides, not thousands)
  const n = A.length, m = B.length, w = m + 1;
  const dp = new Uint16Array((n + 1) * w);
  for (let i = n - 1; i >= 0; i--) for (let j = m - 1; j >= 0; j--) dp[i * w + j] = A[i] === B[j] ? dp[(i + 1) * w + j + 1] + 1 : Math.max(dp[(i + 1) * w + j], dp[i * w + j + 1]);
  const out: SlideChange[] = [];
  let i = 0, j = 0;
  const gap = (i1: number, j1: number) => {
    // between two unchanged slides: as many as both have are changed slides, the rest came or went
    const k = Math.min(i1 - i, j1 - j);
    for (let t = 0; t < k; t++) out.push({ kind: 'changed', oldNo: i + t + 1, newNo: j + t + 1 });
    for (let t = k; t < i1 - i; t++) out.push({ kind: 'removed', oldNo: i + t + 1, newNo: null });
    for (let t = k; t < j1 - j; t++) out.push({ kind: 'added', oldNo: null, newNo: j + t + 1 });
  };
  while (i < n && j < m) {
    if (A[i] === B[j]) { i++; j++; continue; }
    // find the next common pair along the LCS path
    let i1 = i, j1 = j;
    while (i1 < n && j1 < m && A[i1] !== B[j1]) { if (dp[(i1 + 1) * w + j1] >= dp[i1 * w + j1 + 1]) i1++; else j1++; }
    gap(i1, j1);
    i = i1; j = j1;
  }
  gap(n, m);
  return out;
}

/**
 * One slide of a version as a page of its own: the other slides taken out, the page's margins
 * gone, and `base` (the deck's folder as served, deliverables.ts) for its pictures and styles.
 * No scripts run in the frame that shows it (sandboxed without allow-scripts).
 */
export function slidePage(s: Slides, index: number, base: string | null): string {
  let text = s.text;
  for (let k = s.ranges.length - 1; k >= 0; k--) if (k !== index) text = text.slice(0, s.ranges[k].from) + text.slice(s.ranges[k].to);
  const style = '<style>html,body{margin:0!important;padding:0!important;overflow:hidden!important;background:transparent}.slide{margin:0!important;transform:none!important}</style>';
  const head = (base ? `<base href="${base.replace(/"/g, '&quot;')}">` : '') + style;
  const m = /<head(\s[^>]*)?>/i.exec(text);
  if (m) return text.slice(0, m.index + m[0].length) + head + text.slice(m.index + m[0].length);
  return `<head>${head}</head>` + text;
}
