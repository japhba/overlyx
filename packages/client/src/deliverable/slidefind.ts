/**
 * Find and replace on a deck's slides and speaker notes: the matches in the deck's source (its
 * words — not formulas' TeX, scripts, styles, drawings or words a suggestion deletes), and a
 * replacement as `inner` operations on the elements holding them — the path a retyped text takes,
 * so undo, co-editing and Suggesting mode (word-level tracked changes) work as for typing. Pure
 * string work (tests/slidefind.test.ts); the find bar: SlideFind.tsx; the marks on the canvas:
 * runtime/findmarks.ts.
 */
import { parseSource, innerRange, elementAt, pathOf, attr, walk, type HtmlOp, type HElement, type HNode, type Path } from '@overlyx/core/html/source.ts';
import { slideElements } from '@overlyx/core/html/deliverable.ts';
import { findRegExp, matchesIn, type FindOpts } from './findre';

export type { FindOpts } from './findre';

export interface SlideMatch {
  /** the slide (0-based), and whether the words are its speaker notes' */
  slide: number;
  notes: boolean;
  /** the element whose own text holds the match, and which of the matches in its own text it is (the canvas marks it so) */
  path: Path;
  nth: number;
  /** where it is in the source */
  from: number;
  to: number;
  /** the words found, and a few around them */
  text: string;
  context: string;
}

/** elements a search does not look into */
const SKIP = new Set(['script', 'style', 'svg', 'template', 'math', 'del', 'noscript', 'iframe', 'object', 'canvas', 'video', 'audio', 'textarea', 'select']);
const ENT: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', ndash: '–', mdash: '—', hellip: '…', lsquo: '‘', rsquo: '’', ldquo: '“', rdquo: '”', laquo: '«', raquo: '»', copy: '©', reg: '®', trade: '™', times: '×', middot: '·', bull: '•', euro: '€', shy: '­', thinsp: ' ', ensp: ' ', emsp: ' ' };

/**
 * A text node's source decoded, with where each character of it starts in the source (`at[k]`; the
 * last entry: the end). Null when the decoding does not give the parser's text (an entity this does
 * not know): such text is not searched rather than replaced wrongly.
 */
export function decodeMap(raw: string, value: string): number[] | null {
  if (raw === value) return Array.from({ length: raw.length + 1 }, (_, k) => k);
  const at: number[] = [];
  let out = '';
  for (let i = 0; i < raw.length;) {
    const m = raw[i] === '&' ? /^&(#[0-9]+|#x[0-9a-f]+|[a-z][a-z0-9]*);/i.exec(raw.slice(i, i + 12)) : null;
    let ch: string | null = null;
    if (m) {
      const n = m[1];
      ch = n[0] === '#' ? String.fromCodePoint(n[1] === 'x' || n[1] === 'X' ? parseInt(n.slice(2), 16) : parseInt(n.slice(1), 10)) : ENT[n] ?? null;
    }
    if (ch !== null && m) { for (let k = 0; k < ch.length; k++) at.push(i); out += ch; i += m[0].length; continue; }
    at.push(i); out += raw[i]; i++;
  }
  at.push(raw.length);
  return out === value ? at : null;
}

const isText = (n: HNode): n is HNode & { value: string; sourceCodeLocation?: { startOffset: number; endOffset: number } | null } => n.nodeName === '#text';

/** Every match of the search on the deck's slides, in order (a slide's words, then its notes, as written). */
export function findInDeck(text: string, o: FindOpts): SlideMatch[] {
  const re = findRegExp(o);
  if (!re) return [];
  const src = parseSource(text);
  const out: SlideMatch[] = [];
  // (a poster without slides: its page)
  let roots = slideElements(src.doc);
  if (!roots.length) { for (const el of walk(src.doc)) if (el.tagName === 'body' && el.sourceCodeLocation) { roots = [el]; break; } }
  roots.forEach((slide, i) => {
    const visit = (el: HElement, notes: boolean) => {
      let nth = 0;
      let path: Path | null = null;
      for (const c of el.childNodes as HNode[]) {
        if (isText(c)) {
          const loc = c.sourceCodeLocation;
          if (!loc || !/\S/.test(c.value)) continue;
          const found = matchesIn(c.value, re);
          if (!found.length) continue;
          const at = decodeMap(src.text.slice(loc.startOffset, loc.endOffset), c.value);
          for (const [a, b] of found) {
            const k = nth++;
            if (!at) continue;
            path ??= pathOf(el);
            const plain = c.value.replace(/\s+/g, ' ');
            out.push({
              slide: i, notes, path, nth: k, from: loc.startOffset + at[a], to: loc.startOffset + at[b],
              text: c.value.slice(a, b), context: (a > 30 ? '…' : '') + plain.slice(Math.max(0, a - 30), Math.min(plain.length, b + 30)).trim() + (b + 30 < plain.length ? '…' : ''),
            });
          }
          continue;
        }
        const k = c as HElement;
        if (!('tagName' in k) || !k.sourceCodeLocation || SKIP.has(k.tagName)) continue;
        if (attr(k, 'data-ol-del') !== null || k.tagName.startsWith('mjx-')) continue;
        const cls = ` ${attr(k, 'class') ?? ''} `;
        if (cls.includes(' ol-bibliography ')) continue;
        visit(k, notes || (k.tagName === 'aside' && cls.includes(' notes ')));
      }
    };
    visit(slide, false);
  });
  return out;
}

const escHtml = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/ /g, '&nbsp;');

/**
 * The matches replaced by `by`: one `inner` operation for each element holding some (an element
 * inside another one that holds some goes with that one), its new inner source and the source it
 * was made from (`before`: words a co-author typed meanwhile are kept).
 */
export function replaceOps(text: string, matches: readonly SlideMatch[], by: string): HtmlOp[] {
  if (!matches.length) return [];
  const src = parseSource(text);
  const key = (p: Path) => p.join('/');
  const tops = new Map<string, Path>();
  const paths = [...new Map(matches.map(m => [key(m.path), m.path])).values()].sort((a, b) => a.length - b.length);
  for (const p of paths) {
    const up = [...tops.values()].find(t => t.length < p.length && t.every((v, k) => p[k] === v));
    if (!up) tops.set(key(p), p);
  }
  const ops: HtmlOp[] = [];
  const ins = escHtml(by);
  for (const p of tops.values()) {
    const el = elementAt(src.doc, p);
    const r = el && innerRange(el);
    if (!r) continue;
    const mine = matches.filter(m => m.from >= r.from && m.to <= r.to).sort((a, b) => b.from - a.from);
    if (!mine.length) continue;
    const before = src.text.slice(r.from, r.to);
    let html = before;
    for (const m of mine) html = html.slice(0, m.from - r.from) + ins + html.slice(m.to - r.from);
    ops.push({ t: 'inner', path: p, html, before });
  }
  return ops;
}
