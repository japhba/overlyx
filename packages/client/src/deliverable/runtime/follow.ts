/**
 * The page pane beside an article following the editor's cursor (app/ArticlePage.tsx): the
 * paragraph the cursor is in, found on the page by its words, and scrolled into view. The page's
 * scripts may have rewritten its markup and typeset its formulas, so a paragraph is matched by its
 * text with the formulas left out, not by its place in the source.
 */

/** where the cursor is: the words of its paragraph (formulas left out), the how-manieth paragraph of
 *  the document with just those words it is (0: the first), how far into it (0–1); `flash`: marked
 *  for a moment (Sync, Ctrl+Alt+J), else scrolled only when out of view */
export interface FollowTarget { words: string[]; nth: number; frac: number; flash?: boolean }

/** a text's words, as both sides compare them */
export const followWords = (text: string): string[] => text.toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? [];

const BLOCKS = 'p, li, h1, h2, h3, h4, h5, h6, figcaption, blockquote, pre, td, th, dt, dd, summary, caption';
/** formulas, as the page's scripts typeset them, and what is not the page's text */
const SKIP = '.katex, mjx-container, math, .MathJax, svg, script, style, template, [data-ol-runtime]';

/** the page's paragraphs (innermost blocks), each with the words of its own text */
function pageBlocks(): { el: Element; words: string[] }[] {
  const text = new Map<Element, string[]>();
  const walk = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
  for (let n = walk.nextNode(); n; n = walk.nextNode()) {
    const parent = n.parentElement;
    if (!parent || parent.closest(SKIP)) continue;
    const block = parent.closest(BLOCKS);
    if (!block) continue;
    let parts = text.get(block);
    if (!parts) text.set(block, parts = []);
    parts.push(n.nodeValue ?? '');
  }
  return [...text].map(([el, parts]) => ({ el, words: followWords(parts.join(' ')) })).filter(b => b.words.length);
}

function grams(words: string[], n: number): Set<string> {
  const out = new Set<string>();
  for (let i = 0; i + n <= words.length; i++) out.add(words.slice(i, i + n).join(' '));
  return out;
}

/** the page's paragraph for a target: the most alike by word triples (Dice), the nth of equals */
function find(t: FollowTarget): Element | null {
  const n = Math.min(3, t.words.length);
  if (!n) return null;
  const want = grams(t.words, n);
  let best = 0, hits: Element[] = [];
  for (const b of pageBlocks()) {
    const have = grams(b.words, n);
    let shared = 0;
    for (const g of want) if (have.has(g)) shared++;
    const score = (2 * shared) / (want.size + have.size);
    if (score > best + 1e-9) { best = score; hits = [b.el]; } else if (score > 0 && Math.abs(score - best) <= 1e-9) hits.push(b.el);
  }
  return best >= 0.4 ? hits[Math.min(t.nth, hits.length - 1)] ?? null : null;
}

function flash(el: Element): void {
  const r = el.getBoundingClientRect();
  const mark = document.createElement('div');
  mark.setAttribute('data-ol-runtime', '');
  mark.style.cssText = `position:absolute;left:${r.left + scrollX - 6}px;top:${r.top + scrollY - 4}px;width:${r.width + 12}px;height:${r.height + 8}px;`
    + 'border-radius:6px;background:rgba(47,111,222,0.16);pointer-events:none;z-index:2147483646;transition:opacity 0.8s;';
  document.documentElement.appendChild(mark);
  setTimeout(() => { mark.style.opacity = '0'; }, 700);
  setTimeout(() => mark.remove(), 1600);
}

/** the cursor's place on the page brought into view (a third from the top), when it is out of view or asked for */
export function follow(t: FollowTarget): void {
  const el = find(t);
  if (!el) return;
  const r = el.getBoundingClientRect();
  if (!r.width && !r.height) return;
  // (in a long paragraph, the cursor's line, roughly)
  const y = r.top + Math.min(1, Math.max(0, t.frac)) * Math.max(0, r.height - innerHeight / 3);
  if (t.flash || y < innerHeight * 0.12 || y + 24 > innerHeight * 0.88) {
    scrollTo({ top: scrollY + y - innerHeight / 3, behavior: t.flash ? 'auto' : 'smooth' });
  }
  if (t.flash) flash(el);
}
