/**
 * Several slides at once — the selection of the slide rail and the slide sorter: which slides a
 * click selects (pickSlide), and the selection moved, duplicated, deleted, skipped as operations on
 * the deck's text (core html/source.ts), so undo, suggestions and the master's follow-ups
 * (deckmaster.ts: linked objects, slide numbers) work as they do for one slide. Pure string work,
 * tested without a browser (tests/slideops.test.ts). Slides on the clipboard: slideclip.ts.
 */
import { parseSource, elementChildren, outerRange, pathOf, attr, type HtmlOp, type HElement, type Path } from '@overlyx/core/html/source.ts';
import { slideElements } from '@overlyx/core/html/deliverable.ts';
import { SKIP_ATTR } from './deckmaster';

/** a click: alone, Ctrl/⌘ (one more or one less), Shift (from the anchor to here) */
export type SlidePick = 'one' | 'toggle' | 'range';
export interface SlideSel { sel: number[]; anchor: number; current: number }

const sorted = (xs: Iterable<number>): number[] => [...new Set(xs)].sort((a, b) => a - b);

/** The selection after a click on slide `i` of `n` (the slide shown is always one of the selected). */
export function pickSlide(s: SlideSel, i: number, how: SlidePick, n: number): SlideSel {
  if (n <= 0) return { sel: [], anchor: 0, current: 0 };
  i = Math.max(0, Math.min(n - 1, i));
  if (how === 'range') {
    const a = Math.max(0, Math.min(n - 1, s.anchor));
    const out: number[] = [];
    for (let k = Math.min(a, i); k <= Math.max(a, i); k++) out.push(k);
    return { sel: out, anchor: a, current: i };
  }
  if (how === 'toggle') {
    if (!s.sel.includes(i)) return { sel: sorted([...s.sel, i]), anchor: i, current: i };
    if (s.sel.length <= 1) return s;
    const sel = s.sel.filter(k => k !== i);
    // (the slide shown left the selection: the nearest selected one is shown)
    const current = i === s.current ? sel.reduce((b, k) => (Math.abs(k - i) < Math.abs(b - i) ? k : b), sel[0]) : s.current;
    return { sel, anchor: current, current };
  }
  return { sel: [i], anchor: i, current: i };
}

/** the selection kept inside a deck of `n` slides (the slide shown: selected) */
export function clampSel(sel: readonly number[], current: number, n: number): number[] {
  const out = sorted(sel).filter(k => k >= 0 && k < n);
  return out.includes(current) ? out : n > 0 ? [Math.max(0, Math.min(n - 1, current))] : [];
}

interface Deck { text: string; els: HElement[] }
const deckOf = (text: string): Deck => { const src = parseSource(text); return { text: src.text, els: slideElements(src.doc) }; };
const picked = (d: Deck, sel: readonly number[]): number[] => sorted(sel).filter(k => k >= 0 && k < d.els.length);
/** the children a `reorder` / an `insert` counts: those written in the source */
const located = (p: HElement): HElement[] => elementChildren(p).filter(k => k.sourceCodeLocation);

/** an element's source without the indentation of its line (an insertion indents it again) */
export function dedented(text: string, el: HElement): string {
  const { from, to } = outerRange(el);
  const ls = text.lastIndexOf('\n', from - 1) + 1;
  const indent = /^[ \t]+$/.test(text.slice(ls, from)) ? text.slice(ls, from) : '';
  const s = text.slice(from, to);
  return indent ? s.split('\n').map((l, i) => (i && l.startsWith(indent) ? l.slice(indent.length) : l)).join('\n') : s;
}

/** what stands between two slides in the source: a blank line, or a line break */
export function slideGap(text: string, els: readonly HElement[]): string {
  if (els.length > 1) {
    const between = text.slice(outerRange(els[0]).to, outerRange(els[1]).from);
    return /\n[ \t]*\n/.test(between) ? '\n\n' : '\n';
  }
  return '\n\n';
}

/**
 * The slides `sel` moved together to before slide `to` (the number of slides: after the last), in
 * their order — one `reorder` of their parent — and where they are afterwards. Null: nothing to
 * move, or the slides do not lie in one element.
 */
export function moveSlidesOps(text: string, sel: readonly number[], to: number): { ops: HtmlOp[]; sel: number[] } | null {
  const d = deckOf(text);
  const p = picked(d, sel);
  if (!p.length) return null;
  const rest = d.els.map((_, i) => i).filter(i => !p.includes(i));
  const before = rest.filter(i => i < to).length;
  const order = [...rest.slice(0, before), ...p, ...rest.slice(before)];
  const now = p.map((_, k) => before + k);
  if (order.every((v, k) => v === k)) return { ops: [], sel: now };
  const parent = d.els[0].parentNode as HElement;
  if (!parent || !('tagName' in parent) || !d.els.every(e => e.parentNode === parent)) return null;
  const kids = located(parent);
  const slots = d.els.map(e => kids.indexOf(e));
  if (slots.some(s => s < 0)) return null;
  const full = kids.map((_, k) => k);
  order.forEach((slide, k) => { full[slots[k]] = slots[slide]; });
  return { ops: [{ t: 'reorder', parent: pathOf(parent), order: full }], sel: now };
}

/** The slides `sel` a place up (-1) or down (1), together (slides apart come together). */
export function stepSlidesOps(text: string, sel: readonly number[], dir: -1 | 1): { ops: HtmlOp[]; sel: number[] } | null {
  const d = deckOf(text);
  const p = picked(d, sel);
  if (!p.length) return null;
  const block = p[p.length - 1] - p[0] + 1 === p.length;
  // (a block steps over its neighbour; slides apart gather at the first / the last of them)
  const to = dir < 0 ? (block ? p[0] - 1 : p[0]) : (block ? p[p.length - 1] + 2 : p[p.length - 1] + 1);
  if (to < 0 || to > d.els.length) return null;
  return moveSlidesOps(text, p, to);
}

/** The slides `sel` deleted (null: no slide would be left). */
export function removeSlidesOps(text: string, sel: readonly number[]): HtmlOp[] | null {
  const d = deckOf(text);
  const p = picked(d, sel);
  if (!p.length || p.length >= d.els.length) return null;
  return [{ t: 'remove', paths: p.map(i => pathOf(d.els[i])) }];
}

/** `html` (slides) as an insertion after slide `after` */
export function insertSlidesOp(text: string, after: number, html: string): HtmlOp | null {
  const d = deckOf(text);
  const el = d.els[Math.max(0, Math.min(d.els.length - 1, after))];
  const parent = el?.parentNode as HElement | undefined;
  if (!el || !parent || !('tagName' in parent)) return null;
  return { t: 'insert', parent: pathOf(parent), index: located(parent).indexOf(el) + 1, html };
}

/** The slides `sel` again, together after the last of them (PowerPoint's and Google Slides' Duplicate) — and where the copies are. */
export function duplicateSlidesOps(text: string, sel: readonly number[]): { ops: HtmlOp[]; sel: number[] } | null {
  const d = deckOf(text);
  const p = picked(d, sel);
  if (!p.length) return null;
  const last = p[p.length - 1];
  const op = insertSlidesOp(text, last, p.map(i => dedented(d.text, d.els[i])).join(slideGap(d.text, d.els)));
  return op ? { ops: [op], sel: p.map((_, k) => last + 1 + k) } : null;
}

/** Skip slide for the selection: all skipped — or, when all of them are already, all presented again. */
export function skipSlidesOps(text: string, sel: readonly number[]): { ops: HtmlOp[]; on: boolean } | null {
  const d = deckOf(text);
  const p = picked(d, sel);
  if (!p.length) return null;
  const on = p.some(i => attr(d.els[i], SKIP_ATTR) === null);
  const ops: HtmlOp[] = p.filter(i => (attr(d.els[i], SKIP_ATTR) === null) === on).map(i => ({ t: 'attr', path: pathOf(d.els[i]), name: SKIP_ATTR, value: on ? '' : null }));
  return { ops, on };
}

/** the paths of the slides `sel` */
export function slidePathsOf(text: string, sel: readonly number[]): Path[] {
  const d = deckOf(text);
  return picked(d, sel).map(i => pathOf(d.els[i]));
}
