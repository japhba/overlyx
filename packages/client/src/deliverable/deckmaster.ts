/**
 * The master of an HTML deck — what PowerPoint's slide master and Keynote's master slides are for —
 * kept in the page's own markup, so the file stays a page any browser shows as it is:
 *
 * - **On every slide** (`data-ol-master="<key>"` on an object of a slide): the copies of one object
 *   on the slides that have it — a logo, a bar, a footer, the slide number. They are kept identical:
 *   a copy changed on any slide (moved, recoloured, retyped) is the new one on all of them, and in
 *   the deck's saved layouts. A slide without a copy simply does not show it; a copy without the
 *   attribute is that slide's own.
 * - **Fields** (`data-ol-field="slide-number" | "slide-count"` on an element in a text): its text is
 *   the slide's number, or how many slides there are, written in the file and kept right as slides
 *   are added, moved and removed.
 * - Slide numbers typed as plain text (most decks an agent writes, the starters): when slides are
 *   added, moved or removed and the slides were numbered right before, the numbers follow
 *   (`numbering`: the same place on most slides, a number that is the slide's, minus an offset when
 *   the title slide is not counted, with "/ total" if they have it).
 * - **Skipped** slides (`data-ol-skip` on a slide): not presented, not printed, still edited.
 *
 * `followUps` turns one edit made from the editor into what else it takes; `composeSplices` makes it
 * and its follow-ups one change of the text (one undo step). Pure string work (core html/source.ts).
 */
import { parseSource, elementChildren, elementAt, attr, pathOf, parseStyle, outerRange, innerRange, applySplices, type HElement, type HNode, type HDocument, type HtmlOp, type Path, type Splice } from '@overlyx/core/html/source.ts';
import { slideElements } from '@overlyx/core/html/deliverable.ts';

export const MASTER_ATTR = 'data-ol-master';
export const FIELD_ATTR = 'data-ol-field';
export const SKIP_ATTR = 'data-ol-skip';
export type DeckField = 'slide-number' | 'slide-count';

const isEl = (n: HNode): n is HElement => 'tagName' in n;
/** a slide's start tag (or anything with the class "slide"): in what an edit put in or took out, the slides may have changed */
const SLIDE_TAG = /\bclass\s*=\s*(["'])(?:(?!\1)[\s\S])*\bslide\b/i;

/* ------------------------------------------------------------------ splices */

/**
 * `first` (splices of `before`) and then `second` (splices of the text `first` made) as splices of
 * `before`: where they meet, one splice for both.
 */
export function composeSplices(before: string, first: readonly Splice[], second: readonly Splice[]): Splice[] {
  if (!second.length) return [...first];
  if (!first.length) return [...second];
  const f = [...first].sort((a, b) => a.from - b.from || a.to - b.to);
  const sec = [...second].sort((a, b) => a.from - b.from || a.to - b.to);
  const mid = applySplices(before, f);
  const final = applySplices(mid, sec);
  const delta = (s: Splice) => s.insert.length - (s.to - s.from);
  // where each of `first` lies in the middle text
  let shift = 0;
  const inMid = f.map(s => { const from = s.from + shift; shift += delta(s); return { from, to: from + s.insert.length, s }; });
  /** a position of the middle text as one of `before` (one inside what `first` put in: that splice's start or end) */
  const toBefore = (p: number, end: boolean): number => {
    let d = 0;
    for (const m of inMid) {
      if (m.from < p && p < m.to) return end ? m.s.to : m.s.from;
      if (m.to <= p) d += delta(m.s);
    }
    return p - d;
  };
  // the stretches of `before` that change — those of `first`, and those of `second` (with the splices of `first` they touch) —, merged where they meet
  const regions: { from: number; to: number }[] = f.map(s => ({ from: s.from, to: s.to }));
  for (const s of sec) {
    const hit = inMid.filter(m => s.from <= m.to && s.to >= m.from);
    regions.push({ from: Math.min(toBefore(s.from, false), ...hit.map(m => m.s.from)), to: Math.max(toBefore(s.to, true), ...hit.map(m => m.s.to)) });
  }
  regions.sort((a, b) => a.from - b.from || a.to - b.to);
  const merged: { from: number; to: number }[] = [];
  for (const r of regions) {
    const last = merged[merged.length - 1];
    if (last && r.from <= last.to) last.to = Math.max(last.to, r.to);
    else merged.push({ ...r });
  }
  /**
   * A stretch's start or end (a position of `before` no splice is inside) in the next text: moved by
   * the splices before it — at its end also by one that only puts something in right there (that one
   * is the stretch's own: stretches that meet were merged).
   */
  const along = (splices: Splice[], p: number, end: boolean) => {
    let d = 0;
    for (const s of splices) if (s.to < p || (s.to === p && (end || s.from < p))) d += delta(s);
    return p + d;
  };
  const finalOf = (p: number, end: boolean) => along(sec, along(f, p, end), end);
  return merged.map(r => ({ from: r.from, to: r.to, insert: final.slice(finalOf(r.from, false), finalOf(r.to, true)) }));
}

/* ------------------------------------------------------------------ reading the deck */

/** the slides inside the deck's saved layouts (<template data-ol-layout>) */
function layoutSlides(doc: HDocument): HElement[] {
  const out: HElement[] = [];
  const visit = (n: HElement | HDocument) => {
    for (const c of elementChildren(n)) {
      if (c.tagName === 'template') {
        const content = (c as HElement & { content?: { childNodes: HNode[] } }).content;
        for (const k of content?.childNodes ?? []) if (isEl(k) && (attr(k, 'class') ?? '').split(/\s+/).includes('slide')) out.push(k);
        continue;
      }
      if (c.tagName !== 'script' && c.tagName !== 'style') visit(c);
    }
  };
  visit(doc);
  return out;
}

const located = (el: HElement) => !!el.sourceCodeLocation;
/** the objects of a slide: its element children in the source */
const objectsOf = (s: HElement) => elementChildren(s).filter(located);

/** a copy's source with what its fields say left out (the slide number differs from slide to slide) */
export function withoutFields(src: string): string {
  return src.replace(/(<[^>]*\sdata-ol-field\s*=\s*(?:"[^"]*"|'[^']*'|[^\s>]+)[^>]*>)[^<]*/gi, '$1');
}

interface Copy { key: string; el: HElement; slide: number; src: string; norm: string }

/** the copies of each master object: on slide `slide` (-1: in a saved layout) */
function copiesIn(text: string, slides: HElement[], layouts: HElement[]): Map<string, Copy[]> {
  const out = new Map<string, Copy[]>();
  const add = (el: HElement, slide: number) => {
    const key = attr(el, MASTER_ATTR);
    if (!key) return;
    const r = outerRange(el), src = text.slice(r.from, r.to);
    const list = out.get(key) ?? [];
    list.push({ key, el, slide, src, norm: withoutFields(src) });
    out.set(key, list);
  };
  slides.forEach((s, i) => { for (const o of objectsOf(s)) add(o, i); });
  for (const s of layouts) for (const o of objectsOf(s)) add(o, -1);
  return out;
}

/** the master objects of slide `i` (their keys), and every key of the deck with how many slides have it */
export function masterInfo(text: string): { keys: Map<string, number>; slides: string[][] } {
  const { doc, text: t } = parseSource(text);
  const ss = slideElements(doc);
  const keys = new Map<string, number>();
  const slides = ss.map(s => {
    const ks = [...new Set(objectsOf(s).map(o => attr(o, MASTER_ATTR)).filter((k): k is string => !!k))];
    for (const k of ks) keys.set(k, (keys.get(k) ?? 0) + 1);
    return ks;
  });
  void t;
  return { keys, slides };
}

/* ------------------------------------------------------------------ slide numbers */

const NUM = /^(\s*)(\d{1,3})(\s*(?:\/|of)\s*)?(\d{1,3})?(\s*)$/;

function textOf(el: HElement): string {
  let s = '';
  for (const n of el.childNodes as HNode[]) s += 'value' in n ? (n as { value: string }).value : isEl(n) ? textOf(n) : '';
  return s;
}

function* leaves(el: HElement): Generator<HElement> {
  const kids = elementChildren(el);
  if (!kids.length) { yield el; return; }
  for (const k of kids) yield* leaves(k);
}

/** where a number is on its slide: its object's place (left, top) and how deep in it */
function placeOf(slide: HElement, el: HElement): string {
  let o = el, depth = 0;
  while (o.parentNode && o.parentNode !== slide && isEl(o.parentNode as HNode)) { o = o.parentNode as HElement; depth++; }
  const st = attr(o, 'style') ?? '';
  const px = (prop: string) => new RegExp(`(?:^|;)\\s*${prop}\\s*:\\s*([^;]+)`, 'i').exec(st)?.[1].trim() ?? '';
  const where = px('left') || px('right') ? `${px('left')}|${px('right')}|${px('top')}|${px('bottom')}` : `#${objectsOf(slide).indexOf(o)}`;
  return `${o.tagName}:${where}:${depth}:${el.tagName}`;
}

interface NumberCand { el: HElement; n: number; of: number | null; place: string; top: HElement }

function candidates(slide: HElement): NumberCand[] {
  const out: NumberCand[] = [];
  for (const o of objectsOf(slide)) {
    if (o.tagName === 'aside' || o.tagName === 'svg' || o.tagName === 'script' || o.tagName === 'style' || o.tagName === 'template') continue;
    for (const leaf of leaves(o)) {
      if (attr(leaf, FIELD_ATTR) !== null || !innerRange(leaf)) continue;
      const m = NUM.exec(textOf(leaf));
      if (!m || (m[3] && !m[4])) continue;
      out.push({ el: leaf, n: Number(m[2]), of: m[4] ? Number(m[4]) : null, place: placeOf(slide, leaf), top: o });
    }
  }
  return out;
}

/**
 * How the deck numbers its slides as text, if it does: the place the numbers are at, the offset
 * (slide i — from 0 — says i + 1 + `offset`) and, with "n / total", the total's offset from the
 * number of slides. Numbers right on at least 60 % of the slides (two at least), all at one place.
 */
export function numbering(slides: HElement[]): { place: string; offset: number; total: number | null } | null {
  if (slides.length < 2) return null;
  const votes = new Map<string, { n: number; totals: Map<number, number> }>();
  slides.forEach((s, i) => {
    const seen = new Set<string>();
    for (const c of candidates(s)) {
      const k = `${c.n - (i + 1)}\u0000${c.place}`;
      // (numbered from the first slide, or from the one after the title slide)
      if (seen.has(k) || c.n - (i + 1) < -1 || c.n - (i + 1) > 0) continue;
      seen.add(k);
      const v = votes.get(k) ?? { n: 0, totals: new Map() };
      v.n++;
      if (c.of !== null) v.totals.set(c.of - slides.length, (v.totals.get(c.of - slides.length) ?? 0) + 1);
      votes.set(k, v);
    }
  });
  let best: [string, { n: number; totals: Map<number, number> }] | null = null;
  for (const e of votes) if (!best || e[1].n > best[1].n) best = e;
  if (!best || best[1].n < 2 || best[1].n < 0.6 * slides.length) return null;
  const [offset, place] = best[0].split('\u0000');
  let total: number | null = null, most = 0;
  for (const [d, n] of best[1].totals) if (n > most) { most = n; total = d; }
  return { place, offset: Number(offset), total };
}

/** the objects holding the deck's slide numbers (typed as text): a new slide takes them along, renumbered */
export function numberObjects(text: string | { doc: HDocument }): Set<HElement> {
  const { doc } = typeof text === 'string' ? parseSource(text) : text;
  const ss = slideElements(doc);
  const how = numbering(ss);
  const out = new Set<HElement>();
  if (!how) return out;
  for (const s of ss) for (const c of candidates(s)) if (c.place === how.place) out.add(c.top);
  return out;
}

/** the order of the slides, numbers aside (a slide moved: the same slides in another order) */
const slideSig = (t: string, s: HElement) => { const r = outerRange(s); return t.slice(r.from, r.to).replace(/>\s*\d{1,3}(?:\s*(?:\/|of)\s*\d{1,3})?\s*</g, '><'); };

function sameMultiset(a: string[], b: string[]): boolean {
  if (a.length !== b.length) return false;
  const m = new Map<string, number>();
  for (const x of a) m.set(x, (m.get(x) ?? 0) + 1);
  for (const x of b) { const n = m.get(x); if (!n) return false; m.set(x, n - 1); }
  return true;
}

/** the fields and the typed numbers of `text` right (splices of it); `before`: how the slides were numbered */
function numberSplices(text: string, before: { slides: HElement[]; text: string } | null): { splices: Splice[]; changed: number } {
  const { doc } = parseSource(text);
  const ss = slideElements(doc);
  const out: Splice[] = [];
  const put = (el: HElement, value: string) => {
    const r = innerRange(el);
    if (r && text.slice(r.from, r.to) !== value) out.push({ from: r.from, to: r.to, insert: value });
  };
  if (/\sdata-ol-field\s*=/i.test(text)) {
    ss.forEach((s, i) => {
      const visit = (el: HElement) => {
        for (const k of elementChildren(el)) {
          const f = attr(k, FIELD_ATTR);
          if (f === 'slide-number') put(k, String(i + 1));
          else if (f === 'slide-count') put(k, String(ss.length));
          else visit(k);
        }
      };
      visit(s);
    });
  }
  if (before) {
    const was = before.slides.map(s => slideSig(before.text, s)), now = ss.map(s => slideSig(text, s));
    const moved = was.length !== now.length || (sameMultiset(was, now) && was.some((x, i) => x !== now[i]));
    const how = moved ? numbering(before.slides) : null;
    if (how) {
      ss.forEach((s, i) => {
        const n = i + 1 + how.offset;
        for (const c of candidates(s)) {
          if (c.place !== how.place || n < 1) continue;
          const r = innerRange(c.el)!;
          const m = NUM.exec(text.slice(r.from, r.to));
          if (!m) continue;
          const total = m[4] && how.total !== null ? String(ss.length + how.total) : m[4];
          put(c.el, `${m[1]}${n}${m[3] ?? ''}${total ?? ''}${m[5]}`);
        }
      });
    }
  }
  return { splices: out, changed: out.length };
}

/* ------------------------------------------------------------------ follow-ups */

export interface FollowUps {
  /** splices of the text after the edit */
  splices: Splice[];
  /** copies of master objects brought in line (on slides and in layouts) */
  copies: number;
  /** numbers set */
  numbers: number;
}

/**
 * What else an edit made from the editor (`before` → `after`) takes: the other copies of a master
 * object changed on one slide the same; a copy that came twice onto one slide (duplicated, pasted)
 * the slide's own the second time; slides added from a layout saved before the master changed made
 * like the rest; fields and typed slide numbers right. Splices of `after`, applied after the edit.
 */
export function followUps(before: string, after: string, splices?: readonly Splice[]): FollowUps {
  const none: FollowUps = { splices: [], copies: 0, numbers: 0 };
  const masters = after.includes(MASTER_ATTR);
  const fields = /\sdata-ol-field\s*=/i.test(after);
  // (most edits — a word typed, a stroke drawn — reach neither a master object nor the order of the
  // slides: told from the splices and the tree of `before`, which the edit parsed already; the text
  // after it is not parsed then — a big deck takes ~50 ms)
  if (splices && !splices.some(s => SLIDE_TAG.test(s.insert) || SLIDE_TAG.test(before.slice(s.from, s.to)))) {
    if (!masters) return none;
    const B0 = parseSource(before);
    const ranges = [...copiesIn(before, slideElements(B0.doc), layoutSlides(B0.doc)).values()].flat().map(c => outerRange(c.el));
    const reached = splices.some(s => s.insert.includes(MASTER_ATTR) || ranges.some(r => s.from < r.to && s.to > r.from));
    if (!reached) return none;
  }
  const A = parseSource(after), B = parseSource(before);
  const sa = slideElements(A.doc), sb = slideElements(B.doc);
  let text = after, copies = 0;
  const first: Splice[] = [];
  if (masters) {
    const ca = copiesIn(after, sa, layoutSlides(A.doc)), cb = copiesIn(before, sb, []);
    const strip = new Set<HElement>();
    for (const [key, list] of ca) {
      // (one copy a slide: a second is a copy of it made on the slide — duplicated, pasted —, that slide's own)
      const bySlide = new Map<number, Copy[]>();
      for (const c of list) if (c.slide >= 0) bySlide.set(c.slide, [...(bySlide.get(c.slide) ?? []), c]);
      const had = new Map<number, number>();
      for (const c of cb.get(key) ?? []) had.set(c.slide, (had.get(c.slide) ?? 0) + 1);
      for (const [i, cs] of bySlide) if (cs.length > 1 && cs.length > (had.get(i) ?? 0)) for (const c of cs.slice(Math.max(1, had.get(i) ?? 0))) strip.add(c.el);
      const live = list.filter(c => !strip.has(c.el));
      const onSlides = live.filter(c => c.slide >= 0);
      let target: Copy | null = null;
      if (sa.length === sb.length) {
        const old = cb.get(key) ?? [];
        const changed = onSlides.filter(c => { const o = old.find(x => x.slide === c.slide); return !!o && o.norm !== c.norm; });
        if (changed.length && changed.every(c => c.norm === changed[0].norm)) target = changed[0];
      } else if (sa.length > sb.length && new Set(onSlides.map(c => c.norm)).size > 1) {
        // (slides added — from a layout saved before the master changed: the copy most slides have)
        const count = new Map<string, number>();
        for (const c of onSlides) count.set(c.norm, (count.get(c.norm) ?? 0) + 1);
        target = onSlides.reduce((a, c) => (count.get(c.norm)! > count.get(a.norm)! ? c : a), onSlides[0]);
      }
      if (!target) continue;
      for (const c of live) if (c !== target && c.norm !== target.norm) { first.push({ ...outerRange(c.el), insert: target.src }); copies++; }
    }
    for (const el of strip) {
      const st = el.sourceCodeLocation?.startTag;
      if (!st) continue;
      const open = after.slice(st.startOffset, st.endOffset);
      const m = /\sdata-ol-master\s*=\s*(?:"[^"]*"|'[^']*'|[^\s>]+)/i.exec(open);
      if (m) first.push({ from: st.startOffset + m.index, to: st.startOffset + m.index + m[0].length, insert: '' });
    }
    // (a copy both replaced and stripped: the replacement wins — never two splices over one stretch)
    first.sort((a, b) => a.from - b.from);
    for (let i = first.length - 1; i > 0; i--) if (first[i].from < first[i - 1].to) first.splice(i, 1);
    if (first.length) text = applySplices(after, first);
  }
  const nums = fields || sa.length !== sb.length || masters || numbering(sb) ? numberSplices(text, { slides: sb, text: before }) : { splices: [], changed: 0 };
  return { splices: composeSplices(after, first, nums.splices), copies, numbers: nums.changed };
}

/* ------------------------------------------------------------------ the editor's operations */

/** a key for a new master object, not used in `text` */
export function newMasterKey(text: string): string {
  for (let n = 1; ; n++) { const k = `m${n}`; if (!text.includes(`${MASTER_ATTR}="${k}"`)) return k; }
}

/** the slide an object is on (its index) and the object, from its path */
function objectAt(text: string, path: Path): { doc: HDocument; slides: HElement[]; slide: number; el: HElement; src: string } | null {
  const { doc, text: t } = parseSource(text);
  const el = elementAt(doc, path);
  const ss = slideElements(doc);
  const slide = el ? ss.findIndex(s => s === el.parentNode) : -1;
  if (!el || slide < 0 || !el.sourceCodeLocation) return null;
  const r = outerRange(el);
  return { doc, slides: ss, slide, el, src: t.slice(r.from, r.to) };
}

/** where an object goes among a slide's objects: at `index`, before the speaker notes (which stay last) */
function placeIn(s: HElement, index: number): number {
  const kids = elementChildren(s);
  const notes = kids.findIndex(k => k.tagName === 'aside' && (attr(k, 'class') ?? '').split(/\s+/).includes('notes'));
  return Math.min(index, notes >= 0 ? notes : kids.length);
}

/** `html`'s first start tag given the attribute `name` (or without it: `value` null) */
export function withAttr(html: string, name: string, value: string | null): string {
  return html.replace(/^(\s*<[a-zA-Z][^\s/>]*)((?:\s+[^\s=/>]+(?:\s*=\s*(?:"[^"]*"|'[^']*'|[^\s>]+))?)*)(\s*\/?>)/, (_m, open: string, attrs: string, end: string) => {
    const rest = attrs.replace(new RegExp(`\\s+${name}(?:\\s*=\\s*(?:"[^"]*"|'[^']*'|[^\\s>]+))?`, 'i'), '');
    return value === null ? open + rest + end : `${open} ${name}="${value.replace(/&/g, '&amp;').replace(/"/g, '&quot;')}"${rest}${end}`;
  });
}

/** where an object is (its style's place and size), or null when its style does not place it */
function spotOf(el: HElement): string | null {
  const st = new Map(parseStyle(attr(el, 'style') ?? '').map(d => [d.prop.toLowerCase(), d.value.trim()]));
  const at = ['left', 'right', 'top', 'bottom', 'width', 'height'].map(k => st.get(k) ?? '');
  return (at[0] || at[1]) && (at[2] || at[3]) ? at.join('|') : null;
}

/** the same object on another slide: the same element and class in the same place (its colour, its words may differ), or the same markup */
function twin(text: string, a: HElement, b: HElement): boolean {
  if (a.tagName !== b.tagName || (attr(a, 'class') ?? '') !== (attr(b, 'class') ?? '')) return false;
  const sa = spotOf(a), sb = spotOf(b);
  if (sa && sb) return sa === sb;
  const ra = outerRange(a), rb = outerRange(b);
  return withoutFields(text.slice(ra.from, ra.to).trim()) === withoutFields(text.slice(rb.from, rb.to).trim());
}

/** a slide number typed in the object (its slide's: slide `i`, from 0) as a field — and "n / total" as two */
function numberFields(src: string, i: number, total: number): string {
  return src.replace(/>(\s*)(\d{1,3})(\s*(?:\/|of)\s*)?(\d{1,3})?(\s*)</g, (m, a: string, n: string, of: string | undefined, tot: string | undefined, b: string) =>
    Number(n) !== i + 1 || (tot && Number(tot) !== total) ? m
      : `>${a}<span ${FIELD_ATTR}="slide-number">${n}</span>${of && tot ? `${of}<span ${FIELD_ATTR}="slide-count">${tot}</span>` : of ?? ''}${b}<`);
}

/**
 * Put on every slide (PowerPoint's: an object of the slide master): the object at `path` and its
 * copies. Where the same object is on other slides already — a bar, a logo, a footer an agent
 * repeated: the same element in the same place, in another colour perhaps — those are linked and
 * made like this one, and no slide gets one it did not have; else a copy goes on every other slide,
 * in the same place in its stack. A slide number typed in it becomes a field (every slide's own
 * number). Null: not an object of a slide.
 */
export function putOnEverySlide(text: string, path: Path): { ops: HtmlOp[]; linked: number; added: number } | null {
  const o = objectAt(text, path);
  if (!o) return null;
  const key = attr(o.el, MASTER_ATTR) ?? newMasterKey(text);
  const html = withAttr(numberFields(o.src, o.slide, o.slides.length), MASTER_ATTR, key);
  const ops: HtmlOp[] = [{ t: 'outer', path, html }];
  const twins: HElement[] = [];
  o.slides.forEach((s, i) => {
    if (i === o.slide) return;
    const k = objectsOf(s).find(x => twin(text, x, o.el));
    if (k) twins.push(k);
  });
  if (twins.length) {
    for (const k of twins) ops.push({ t: 'outer', path: pathOf(k), html });
    return { ops, linked: twins.length, added: 0 };
  }
  const index = elementChildren(o.slides[o.slide]).indexOf(o.el);
  let added = 0;
  o.slides.forEach((s, i) => {
    if (i === o.slide) return;
    ops.push({ t: 'insert', parent: pathOf(s), index: placeIn(s, index), html });
    added++;
  });
  return { ops, linked: 0, added };
}

/** `html`'s first start tag's master key (null: none) */
const keyIn = (html: string): string | null => {
  const tag = /^\s*<[^>]*>/.exec(html)?.[0] ?? '';
  const m = /\sdata-ol-master\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/i.exec(tag);
  return m ? m[1] ?? m[2] ?? m[3] : null;
};
const samePath = (a: Path, b: Path) => a.length === b.length && a.every((v, i) => v === b[i]);

/**
 * The theme view's edits (DeliverableEditor's Edit theme — Google Slides' theme builder on the
 * linked copies): `ops` made on one slide, as what they mean there — an object put on a slide (drawn,
 * typed, pasted, a picture) or duplicated goes on every slide, a new master object (a copy on each, at
 * the same place in its stack, one insertion a slide); one deleted goes from every slide; one replaced
 * by markup without its key (a stroke snapped to a shape) keeps it, so its copies follow. Markup put
 * in with a key no copy on that slide has (Put on every slide, Slide numbers) is as it was. Operations
 * of `text`; the rest unchanged.
 */
export function everySlideOps(text: string, ops: readonly HtmlOp[]): HtmlOp[] {
  if (!ops.some(o => o.t === 'insert' || o.t === 'duplicate' || o.t === 'remove' || o.t === 'outer')) return [...ops];
  const { doc, text: t } = parseSource(text);
  const ss = slideElements(doc);
  const slideAt = (p: Path) => ss.findIndex(s => samePath(pathOf(s), p));
  const slideOfEl = (el: HElement | null) => (el ? ss.indexOf(el.parentNode as HElement) : -1);
  const taken = new Set<string>();
  const fresh = (): string => { for (let n = 1; ; n++) { const k = `m${n}`; if (!taken.has(k) && !text.includes(`${MASTER_ATTR}="${k}"`)) { taken.add(k); return k; } } };
  const keysOn = (i: number) => new Set(objectsOf(ss[i]).map(o => attr(o, MASTER_ATTR)).filter(Boolean));
  /** what goes on the other slides: one insertion each, where the first came on its slide */
  const others = new Map<number, { index: number; html: string[] }>();
  const spread = (from: number, index: number, html: string) => ss.forEach((s, i) => {
    if (i === from) return;
    const o = others.get(i) ?? { index: placeIn(s, index), html: [] };
    o.html.push(html);
    others.set(i, o);
  });
  const out: HtmlOp[] = [];
  for (const op of ops) {
    if (op.t === 'insert') {
      const i = slideAt(op.parent), key = keyIn(op.html);
      if (i < 0 || (key && !keysOn(i).has(key))) { out.push(op); continue; }
      const html = withAttr(op.html, MASTER_ATTR, fresh());
      out.push({ ...op, html });
      spread(i, op.index, html);
    } else if (op.t === 'duplicate') {
      const rest: Path[] = [];
      for (const p of op.paths) {
        const el = elementAt(doc, p), i = slideOfEl(el);
        if (!el?.sourceCodeLocation || i < 0) { rest.push(p); continue; }
        const r = outerRange(el);
        const html = withAttr(t.slice(r.from, r.to), MASTER_ATTR, fresh());
        const index = elementChildren(ss[i]).indexOf(el) + 1;
        out.push({ t: 'insert', parent: pathOf(ss[i]), index, html });
        spread(i, index, html);
      }
      if (rest.length) out.push({ ...op, paths: rest });
    } else if (op.t === 'remove') {
      const all = [...op.paths];
      for (const p of op.paths) for (const q of otherCopies(text, p)) if (!all.some(x => samePath(x, q))) all.push(q);
      out.push({ ...op, paths: all });
    } else if (op.t === 'outer') {
      const el = elementAt(doc, op.path);
      const key = slideOfEl(el) >= 0 ? attr(el!, MASTER_ATTR) : null;
      out.push(key && !keyIn(op.html) ? { ...op, html: withAttr(op.html, MASTER_ATTR, key) } : op);
    } else out.push(op);
  }
  for (const [i, o] of others) out.push({ t: 'insert', parent: pathOf(ss[i]), index: o.index, html: o.html.join('\n') });
  return out;
}

/** An object on every slide, as the theme pane lists those of a slide */
export interface MasterObject { key: string; path: Path; label: string; slides: number }

/** the objects of slide `slide` that are on every slide (their copies here), with how many slides have each */
export function masterObjects(text: string, slide: number): MasterObject[] {
  const { doc } = parseSource(text);
  const ss = slideElements(doc), s = ss[slide];
  if (!s) return [];
  const count = new Map<string, number>();
  for (const x of ss) for (const k of new Set(objectsOf(x).map(o => attr(o, MASTER_ATTR)).filter((k): k is string => !!k))) count.set(k, (count.get(k) ?? 0) + 1);
  const field = (e: HElement): boolean => attr(e, FIELD_ATTR) !== null || elementChildren(e).some(field);
  const name = (o: HElement): string => {
    const own = attr(o, 'data-ol-name');
    if (own) return own;
    if (field(o)) return 'Slide number';
    const words = textOf(o).replace(/\s+/g, ' ').trim();
    if (words) return words.length > 40 ? words.slice(0, 39) + '…' : words;
    return o.tagName === 'img' ? 'Picture' : o.tagName === 'svg' ? (/\bol-ink\b/.test(attr(o, 'class') ?? '') ? 'Drawing' : 'Shape') : 'Shape';
  };
  return objectsOf(s).flatMap(o => {
    const key = attr(o, MASTER_ATTR);
    return key ? [{ key, path: pathOf(o), label: name(o), slides: count.get(key) ?? 1 }] : [];
  });
}

/** the other copies of the master object at `path` (paths), on the slides */
export function otherCopies(text: string, path: Path): Path[] {
  const o = objectAt(text, path);
  const key = o && attr(o.el, MASTER_ATTR);
  if (!o || !key) return [];
  return o.slides.flatMap(s => objectsOf(s).filter(k => k !== o.el && attr(k, MASTER_ATTR) === key).map(pathOf));
}

/**
 * The deck's slide numbers: when they are typed already (numbering), or fields are there, nothing
 * (`already`); else a number at the slides' bottom right on every slide — a field, on every slide —
 * in the deck's footer style when its CSS has one.
 */
export function slideNumberOps(text: string, size: { w: number; h: number }): { ops: HtmlOp[]; already: boolean } {
  const { doc } = parseSource(text);
  const ss = slideElements(doc);
  if (/\sdata-ol-field\s*=\s*["']?slide-number/i.test(text) || numbering(ss)) return { ops: [], already: true };
  const key = newMasterKey(text);
  const footer = /\.footer\s*[{,]/.test(text);
  const w = 160, left = Math.round(size.w - size.w * 0.035 - w), top = Math.round(size.h - size.h * 0.085);
  const style = `position: absolute; left: ${left}px; top: ${top}px; width: ${w}px; margin: 0; text-align: right${footer ? '' : '; font-size: 18px; line-height: 1.4; opacity: 0.6'}`;
  const ops: HtmlOp[] = ss.map((s, i) => ({
    t: 'insert', parent: pathOf(s), index: placeIn(s, elementChildren(s).length),
    html: `<p${footer ? ' class="footer"' : ''} ${MASTER_ATTR}="${key}" data-ol-name="Slide number" style="${style}"><span ${FIELD_ATTR}="slide-number">${i + 1}</span></p>`,
  }));
  return { ops, already: false };
}

/** what makes a text's look (not where it is) */
const LOOK = ['font-family', 'font-size', 'font-weight', 'font-style', 'font-variant', 'font-variant-caps', 'color', 'letter-spacing', 'word-spacing', 'line-height', 'text-align', 'text-transform', 'text-decoration', 'text-shadow'];

/** the texts like the one at `path` on the other slides: the same element, class and placeholder role (a title, a caption, a kicker…) */
export function similarTexts(text: string, path: Path): Path[] {
  const o = objectAt(text, path);
  // (texts: words in them — a bar, a rule, an empty box is no text)
  const worded = (e: HElement) => /\S/.test(textOf(e)) || attr(e, 'data-ol-ph') !== null;
  if (!o || !worded(o.el)) return [];
  const sig = (e: HElement) => `${e.tagName}|${(attr(e, 'class') ?? '').trim().split(/\s+/).sort().join(' ')}|${attr(e, 'data-ol-ph') ?? ''}`;
  const want = sig(o.el);
  return o.slides.flatMap(s => objectsOf(s).filter(k => k !== o.el && sig(k) === want && attr(k, MASTER_ATTR) === null && worded(k)).map(pathOf));
}

/** Make all similar texts look like this one: its look (font, size, weight, colour, spacing, alignment) on each of them, what it does not set taken off theirs */
export function lookAlikeOps(text: string, path: Path): HtmlOp[] {
  const o = objectAt(text, path);
  if (!o) return [];
  const own = new Map(parseStyle(attr(o.el, 'style') ?? '').map(d => [d.prop.toLowerCase(), d.value]));
  const set: Record<string, string | null> = {};
  for (const p of LOOK) set[p] = own.get(p) ?? null;
  return similarTexts(text, path).map(p => ({ t: 'style', path: p, set }));
}

/**
 * An edit inside one object of a slide that is not on every slide but has twins — the same object on
 * other slides, as decks an agent wrote have their bars and logos —: how many (the editor then says
 * how to change them all). 0: anything else.
 */
export function twinsOf(before: string, splices: readonly Splice[]): number {
  if (!splices.length) return 0;
  const from = Math.min(...splices.map(s => s.from)), to = Math.max(...splices.map(s => s.to));
  const { doc } = parseSource(before);
  const ss = slideElements(doc);
  for (const [i, s] of ss.entries()) {
    const loc = s.sourceCodeLocation;
    if (!loc || from < loc.startOffset || to > loc.endOffset) continue;
    const o = objectsOf(s).find(k => { const r = outerRange(k); return r.from <= from && to <= r.to; });
    if (!o || attr(o, MASTER_ATTR) !== null) return 0;
    const r = outerRange(o), len = r.to - r.from;
    // (words of a slide's own — a heading, a paragraph — are not its design; a drawing's strokes neither)
    if (o.tagName === 'svg' || (/\S/.test(textOf(o)) && !/\bfooter\b/.test(attr(o, 'class') ?? ''))) return 0;
    const src = before.slice(r.from, r.to);
    // (the same length first: most objects are not compared at all)
    return ss.filter((x, j) => j !== i && objectsOf(x).some(k => { const q = outerRange(k); return q.to - q.from === len && before.slice(q.from, q.to) === src; })).length;
  }
  return 0;
}
