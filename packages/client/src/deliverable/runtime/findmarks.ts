/**
 * Find on slides (the editor's find bar, SlideFind.tsx): the words found marked on the canvas — all
 * of them pale, the current one strong — with the browser's highlights (no change of the page), and
 * the current one's slide shown. The editor names each match by its element and which match of that
 * element's own text it is (slidefind.ts); the same search here (findre.ts) finds its words.
 */
import { liveAt, slideOf } from './env';
import { revealSlideOf } from './solo';
import { findRegExp, matchesIn, type FindOpts } from '../findre';
import type { Path } from '../protocol';

export interface FindMarks extends FindOpts { marks: { path: Path; nth: number }[]; current: number }

let styled = false;
type HighlightReg = { set(name: string, h: unknown): void; delete(name: string): void };
const registry = (): HighlightReg | null => (typeof CSS !== 'undefined' && (CSS as unknown as { highlights?: HighlightReg }).highlights) || null;

export function setFindMarks(m: FindMarks | null): void {
  const reg = registry();
  const H = (globalThis as unknown as { Highlight?: new (...r: Range[]) => { add(r: Range): void } }).Highlight;
  if (!reg || !H) return;
  if (!styled) {
    styled = true;
    const s = document.createElement('style');
    s.setAttribute('data-ol-runtime', '');
    s.textContent = '::highlight(ol-find) { background-color: rgba(255, 196, 0, .45); color: inherit; } ::highlight(ol-find-now) { background-color: rgba(255, 128, 0, .85); color: #000; }';
    (document.head ?? document.documentElement).appendChild(s);
  }
  reg.delete('ol-find'); reg.delete('ol-find-now');
  const re = m && findRegExp(m);
  if (!m || !re) return;
  const all = new H(), now = new H();
  let nowEl: Element | null = null;
  m.marks.forEach((mk, k) => {
    const el = liveAt(mk.path);
    if (!el) return;
    let n = 0;
    for (const node of Array.from(el.childNodes)) {
      if (node.nodeType !== 3) continue;
      const t = node as Text;
      for (const [a, b] of matchesIn(t.data, re)) {
        if (n++ !== mk.nth) continue;
        const r = document.createRange();
        r.setStart(t, a); r.setEnd(t, b);
        if (k === m.current) { now.add(r); nowEl = el; } else all.add(r);
      }
    }
  });
  reg.set('ol-find', all); reg.set('ol-find-now', now);
  // the current one's slide shown (one slide at a time; stacked, the editor scrolls to it)
  const el = nowEl as Element | null;
  if (el && slideOf(el)) revealSlideOf(el);
}
