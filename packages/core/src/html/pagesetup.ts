/**
 * Page setup: the size of a deck's slides or of a poster changed after it was made (PowerPoint's
 * Slide Size, Keynote's Document ▸ Slide Size). The size is where the page's stylesheet has it — the
 * `.slide { width: …; height: … }` rule (a `var(--…)` there: the custom property) and the print
 * rule's `@page { size: … }` — and a change is a list of splices of the text, one undo step.
 *
 * `scale` (the default): what is on the pages follows the page. With s the smaller of the two
 * factors (new width / old width, new height / old height):
 * - every length of the stylesheets and of the inline styles is multiplied by s — type, line
 *   weights, corners, paddings, gaps, custom properties (`--pad: 24px`): nothing grows out of its box;
 * - an object placed on a slide (a direct child with `left` / `top`…, or a rule of the stylesheet
 *   with `position: absolute`) keeps its place on the page: its `left`, `right` and `width` follow the
 *   width's factor, its `top`, `bottom` and `height` the height's — so what was aligned stays aligned,
 *   and a bar from edge to edge still reaches both edges;
 * - what must keep its shape — pictures, drawings (`svg`), videos, groups, round shapes — is scaled
 *   by s and stays in the middle of the place it would have had;
 * - a length that was the page's own width or height becomes the new one;
 * - guides (`data-ol-guides`) and the template's margins (`data-ol-layout-margins`) move with the
 *   page; a drawing without a `viewBox` gets one, so that its strokes scale with its box.
 * Percentages, `em` and unitless values are left alone: they follow by themselves. The same change
 * is made to every slide, the layouts kept in `<template>`s and every copy of a master object, so
 * linked copies stay identical.
 *
 * `keep`: only the page changes — everything on it keeps its size and its distance from the top
 * left corner.
 */
import { parseSource, attr, hasClass, isElement, attrSplice, innerRange, type HElement, type HDocument, type HNode, type Splice } from './source.ts';
import type { PageSize, PageUnit } from './deliverable.ts';

export type PageSetupMode = 'scale' | 'keep';

const UNIT_PX: Record<string, number> = { px: 1, pt: 96 / 72, pc: 16, mm: 96 / 25.4, cm: 96 / 2.54, in: 96, q: 96 / 101.6 };

/** a page size in CSS px */
export const pageSizePx = (s: PageSize): { w: number; h: number } => ({ w: s.width * UNIT_PX[s.unit], h: s.height * UNIT_PX[s.unit] });

/* ------------------------------------------------------------------ reading CSS */

interface Decl { prop: string; from: number; to: number }
interface Block { prelude: string; decls: Decl[]; top: boolean }

/** the same text, as long as it was, with comments, strings, url(…)s and character references blanked */
function blanked(s: string): string {
  const fill = (m: string) => '_'.repeat(m.length);
  return s
    .replace(/\/\*[\s\S]*?\*\//g, m => ' '.repeat(m.length))
    .replace(/&#?\w+;/g, fill)
    .replace(/"(?:[^"\\\n]|\\.)*"|'(?:[^'\\\n]|\\.)*'/g, m => m[0] + fill(m.slice(1, -1)) + m[0])
    .replace(/url\([^)]*\)/gi, m => 'url(' + fill(m.slice(4, -1)) + ')');
}

function closing(b: string, open: number, to: number): number {
  let depth = 0;
  for (let i = open; i < to; i++) {
    if (b[i] === '{') depth++;
    else if (b[i] === '}' && --depth === 0) return i;
  }
  return to;
}

/**
 * The declaration blocks of `b[from, to)` (blanked CSS; `base`: where b starts in the page's text):
 * `prelude` null reads rules (a stylesheet, the inside of @media), otherwise declarations (a rule's
 * body, an inline style).
 */
function scan(b: string, base: number, from: number, to: number, prelude: string | null, top: boolean, out: Block[]): void {
  const block: Block | null = prelude !== null ? { prelude, decls: [], top } : null;
  if (block) out.push(block);
  const decl = (s: number, e: number) => {
    if (!block) return;
    const colon = b.indexOf(':', s);
    if (colon < 0 || colon >= e) return;
    const prop = b.slice(s, colon).trim().toLowerCase();
    if (!/^[-\w]+$/.test(prop)) return;
    let vs = colon + 1, ve = e;
    while (vs < ve && /\s/.test(b[vs])) vs++;
    while (ve > vs && /\s/.test(b[ve - 1])) ve--;
    if (ve > vs) block.decls.push({ prop, from: base + vs, to: base + ve });
  };
  let start = from, paren = 0;
  for (let i = from; i < to; i++) {
    const c = b[i];
    if (c === '(') paren++;
    else if (c === ')') paren = Math.max(0, paren - 1);
    else if (c === ';' && !paren) { decl(start, i); start = i + 1; }
    else if (c === '{' && !paren) {
      const end = closing(b, i, to);
      const pre = b.slice(start, i).trim().replace(/\s+/g, ' ');
      const low = pre.toLowerCase();
      if (/^@(media|supports|layer|container|scope|document|starting-style|(-\w+-)?keyframes)\b/.test(low)) scan(b, base, i + 1, end, null, false, out);
      else if (!/^@(font-face|font-feature-values|counter-style|property|font-palette-values)\b/.test(low)) scan(b, base, i + 1, end, pre, prelude === null && top, out);
      i = end;
      start = end + 1;
    }
  }
  decl(start, to);
}

const LENGTH = /(?<![\w.#%-])(-?(?:\d+\.?\d*|\.\d+))(px|pt|pc|mm|cm|in|q)(?![\w%-])/gi;
const ONE_LENGTH = /^(-?(?:\d+\.?\d*|\.\d+))(px|pt|pc|mm|cm|in|q)(?:\s*!important)?$/i;

/** a number as CSS writes it: px to a tenth (small ones to a hundredth), mm and pt to a hundredth, in and cm to a thousandth */
function num(n: number, unit: string): string {
  const u = unit.toLowerCase();
  const d = u === 'px' ? (Math.abs(n) >= 4 ? 1 : 2) : u === 'in' || u === 'cm' ? 3 : 2;
  const r = Math.round(n * 10 ** d) / 10 ** d;
  return String(r === 0 ? 0 : r);
}

/** a value that is one length: its number, unit and CSS px */
function oneLength(v: string): { n: number; unit: string; px: number } | null {
  const m = ONE_LENGTH.exec(v.trim());
  return m ? { n: Number(m[1]), unit: m[2], px: Number(m[1]) * UNIT_PX[m[2].toLowerCase()] } : null;
}

const X_PROPS = new Set(['left', 'right', 'width', 'min-width', 'max-width', 'inset-inline-start', 'inset-inline-end']);
const Y_PROPS = new Set(['top', 'bottom', 'height', 'min-height', 'max-height', 'inset-block-start', 'inset-block-end']);

/* ------------------------------------------------------------------ the page's size in the source */

interface SizeDecl { decl: Decl; n: number; unit: string; px: number }
interface Sheets { blocks: Block[]; width: SizeDecl | null; height: SizeDecl | null }

function* everyElement(n: { childNodes: HNode[] }, parent: HElement | null): Generator<[HElement, HElement | null]> {
  for (const c of n.childNodes) {
    if (!isElement(c)) continue;
    yield [c, parent];
    yield* everyElement(c as { childNodes: HNode[] }, c);
    const content = (c as unknown as { content?: { childNodes: HNode[] } }).content;
    if (c.tagName === 'template' && content) yield* everyElement(content, null);
  }
}

const SLIDE_SEL = /^(?:section|div|article)?\.slide$/;

function readSheets(text: string, doc: HDocument): Sheets {
  const blocks: Block[] = [];
  for (const [el] of everyElement(doc as unknown as { childNodes: HNode[] }, null)) {
    if (el.tagName !== 'style') continue;
    const r = innerRange(el);
    if (r) scan(blanked(text.slice(r.from, r.to)), r.from, 0, r.to - r.from, null, true, blocks);
  }
  const value = (d: Decl) => text.slice(d.from, d.to);
  /** the declaration that holds the length: the one given, or the custom property its var() names */
  const resolve = (d: Decl): SizeDecl | null => {
    const one = oneLength(value(d));
    if (one) return { decl: d, ...one };
    const v = /^var\(\s*(--[-\w]+)\s*(?:,[^)]*)?\)$/.exec(value(d).trim());
    if (!v) return null;
    let found: SizeDecl | null = null;
    for (const b of blocks) for (const c of b.decls) {
      if (c.prop !== v[1].toLowerCase()) continue;
      const l = oneLength(value(c));
      if (l) found = { decl: c, ...l };
    }
    return found;
  };
  let width: SizeDecl | null = null, height: SizeDecl | null = null;
  for (const b of blocks) {
    if (!b.top || !b.prelude.split(',').some(s => SLIDE_SEL.test(s.trim()))) continue;
    for (const d of b.decls) {
      if (d.prop === 'width') width = resolve(d) ?? width;
      else if (d.prop === 'height') height = resolve(d) ?? height;
    }
  }
  return { blocks, width, height };
}

/** The page's size as the stylesheet's `.slide` rule has it; null when there is no such rule (a size set some other way). */
export function deckPageSize(text: string): PageSize | null {
  const { width, height } = readSheets(text, parseSource(text).doc);
  if (!width || !height) return null;
  const wu = width.unit.toLowerCase(), hu = height.unit.toLowerCase();
  if (wu === hu && (wu === 'px' || wu === 'mm' || wu === 'in')) return { width: width.n, height: height.n, unit: wu as PageUnit };
  if (wu === hu && wu === 'cm') return { width: width.n * 10, height: height.n * 10, unit: 'mm' };
  return { width: Math.round(width.px * 100) / 100, height: Math.round(height.px * 100) / 100, unit: 'px' };
}

/* ------------------------------------------------------------------ the change */

interface How { fx: number; fy: number; f: number; lock: boolean; W: number; H: number; W2: number; H2: number }

/** the splices scaling a block's declarations (`skip`: declarations written elsewhere) */
function scaleBlock(text: string, decls: Decl[], how: How, skip: Set<Decl>, out: Splice[]): void {
  const one = (prop: string) => { const d = decls.find(x => x.prop === prop); return d ? oneLength(text.slice(d.from, d.to)) : null; };
  const w = one('width'), h = one('height');
  for (const d of decls) {
    if (skip.has(d)) continue;
    const v = text.slice(d.from, d.to);
    const axis = X_PROPS.has(d.prop) ? 'x' : Y_PROPS.has(d.prop) ? 'y' : null;
    const own = axis ? oneLength(v) : null;
    const tail = /\s*!important$/i.exec(v)?.[0] ?? '';
    // (the page's own width or height: the new one)
    if (own && (d.prop === 'width' || d.prop === 'max-width' || d.prop === 'min-width') && Math.abs(own.px - how.W) <= 0.5) { out.push({ from: d.from, to: d.to, insert: num(how.W2 / UNIT_PX[own.unit.toLowerCase()], own.unit) + own.unit + tail }); continue; }
    if (own && (d.prop === 'height' || d.prop === 'max-height' || d.prop === 'min-height') && Math.abs(own.px - how.H) <= 0.5) { out.push({ from: d.from, to: d.to, insert: num(how.H2 / UNIT_PX[own.unit.toLowerCase()], own.unit) + own.unit + tail }); continue; }
    let factor = axis === 'x' ? how.fx : axis === 'y' ? how.fy : how.f;
    if (how.lock && axis) {
      // what keeps its shape: its size by s, itself in the middle of the place it would have had
      const size = axis === 'x' ? w : h, span = axis === 'x' ? how.fx : how.fy;
      if (d.prop === 'width' || d.prop === 'height' || /^(min|max)-/.test(d.prop)) factor = how.f;
      else if (own && size) { out.push({ from: d.from, to: d.to, insert: num((own.px * span + size.px * (span - how.f) / 2) / UNIT_PX[own.unit.toLowerCase()], own.unit) + own.unit + tail }); continue; }
    }
    if (factor === 1) continue;
    const b = blanked(v);
    let next = '', last = 0;
    for (const m of b.matchAll(LENGTH)) {
      // (the unit as it was written)
      next += v.slice(last, m.index) + num(Number(m[1]) * factor, m[2]) + v.slice(m.index + m[1].length, m.index + m[0].length);
      last = m.index + m[0].length;
    }
    if (last) out.push({ from: d.from, to: d.to, insert: next + v.slice(last) });
  }
}

/** where an attribute's value is in the text (inside its quotes) */
function attrValueRange(text: string, el: HElement, name: string): { from: number; to: number } | null {
  const loc = el.sourceCodeLocation as { startTag?: { attrs?: Record<string, { startOffset: number; endOffset: number }> }; attrs?: Record<string, { startOffset: number; endOffset: number }> } | null | undefined;
  const a = (loc?.startTag?.attrs ?? loc?.attrs)?.[name.toLowerCase()];
  if (!a) return null;
  const src = text.slice(a.startOffset, a.endOffset), eq = src.indexOf('=');
  if (eq < 0) return null;
  let from = eq + 1;
  while (from < src.length && /\s/.test(src[from])) from++;
  const q = src[from];
  if (q === '"' || q === "'") { const end = src.lastIndexOf(q); return end > from ? { from: a.startOffset + from + 1, to: a.startOffset + end } : null; }
  return { from: a.startOffset + from, to: a.endOffset };
}

const KEEPS_SHAPE = new Set(['img', 'svg', 'video', 'canvas', 'iframe', 'picture', 'object', 'embed', 'math']);
const SIZED = new Set(['img', 'svg', 'video', 'canvas', 'iframe', 'object', 'embed']);
const round = (s: string) => /border-radius\s*:\s*(?:50%|9999?px|100%)/i.test(s) || /aspect-ratio\s*:/i.test(s);
const positioned = (s: string) => /(?:^|;)\s*position\s*:\s*(?:absolute|fixed)/i.test(s);

export interface PageSetupResult {
  splices: Splice[];
  /** the factor things were scaled by (1: kept) */
  factor: number;
}

/**
 * The splices that give the page `to`'s size; null when the stylesheet has no `.slide` rule with a
 * width and a height to change. `scale`: the content follows (above); `keep`: only the page.
 */
export function pageSetupSplices(text: string, to: PageSize, mode: PageSetupMode = 'scale'): PageSetupResult | null {
  const { doc } = parseSource(text);
  const sheets = readSheets(text, doc);
  const { width, height, blocks } = sheets;
  if (!width || !height) return null;
  const target = pageSizePx(to);
  const W = width.px, H = height.px;
  if (!(W > 0 && H > 0 && target.w > 0 && target.h > 0)) return null;
  const out: Splice[] = [];
  const w2 = `${to.width}${to.unit}`, h2 = `${to.height}${to.unit}`;
  out.push({ from: width.decl.from, to: width.decl.to, insert: w2 }, { from: height.decl.from, to: height.decl.to, insert: h2 });
  const done = new Set<Decl>([width.decl, height.decl]);
  for (const b of blocks) {
    if (!/^@page\b/i.test(b.prelude)) continue;
    for (const d of b.decls) if (d.prop === 'size' && !done.has(d)) { out.push({ from: d.from, to: d.to, insert: `${w2} ${h2}` }); done.add(d); }
  }
  const fx = target.w / W, fy = target.h / H, f = Math.min(fx, fy);
  const same = Math.abs(fx - 1) < 1e-6 && Math.abs(fy - 1) < 1e-6;
  if (mode === 'keep' || same) return { splices: tidy(text, out), factor: 1 };
  const base = { fx, fy, f, W, H, W2: target.w, H2: target.h };
  const uniform: How = { ...base, fx: f, fy: f, lock: false };

  // the stylesheets
  for (const b of blocks) {
    const body = b.decls.map(d => `${d.prop}:${text.slice(d.from, d.to)}`).join(';');
    scaleBlock(text, b.decls, positioned(body) ? { ...base, lock: round(body) } : uniform, done, out);
  }

  // the elements: inline styles, sizes written as attributes, guides and margins
  for (const [el, parent] of everyElement(doc as unknown as { childNodes: HNode[] }, null)) {
    const style = attrValueRange(text, el, 'style');
    const raw = style ? text.slice(style.from, style.to) : '';
    if (style && raw.trim()) {
      const bs: Block[] = [];
      scan(blanked(raw), style.from, 0, raw.length, '', false, bs);
      const onSlide = !!parent && hasClass(parent, 'slide') && !hasClass(el, 'slide');
      const placed = onSlide && bs[0].decls.some(d => d.prop === 'left' || d.prop === 'top' || d.prop === 'right' || d.prop === 'bottom');
      const lock = KEEPS_SHAPE.has(el.tagName) || hasClass(el, 'ol-group') || round(raw)
        || (el.childNodes as HNode[]).some(k => isElement(k) && positioned(attr(k, 'style') ?? ''));
      scaleBlock(text, bs[0].decls, placed ? { ...base, lock } : uniform, done, out);
    }
    if (SIZED.has(el.tagName)) {
      for (const name of ['width', 'height']) {
        const r = attrValueRange(text, el, name);
        const m = r && /^(\d+(?:\.\d+)?)(px)?$/.exec(text.slice(r.from, r.to).trim());
        if (r && m) out.push({ from: r.from, to: r.to, insert: num(Number(m[1]) * f, 'px') + (m[2] ?? '') });
      }
    }
    // a drawing without a viewBox: its strokes are in px of its old box
    if (el.tagName === 'svg' && attr(el, 'viewBox') === null && attr(el, 'viewbox') === null) {
      const st = new Map(raw.split(';').map(p => { const k = p.indexOf(':'); return [p.slice(0, k).trim().toLowerCase(), p.slice(k + 1).trim()] as [string, string]; }));
      const side = (name: string) => oneLength(st.get(name) ?? '')?.px ?? (/^\d+(\.\d+)?(px)?$/.test(attr(el, name) ?? '') ? parseFloat(attr(el, name)!) : null);
      const sw = side('width'), sh = side('height');
      if (sw && sh) { const sp = attrSplice(text, el, 'viewBox', `0 0 ${num(sw, 'px')} ${num(sh, 'px')}`); if (sp) out.push(sp); }
    }
    const guides = attrValueRange(text, el, 'data-ol-guides');
    if (guides) {
      const v = text.slice(guides.from, guides.to);
      const next = v.replace(/([xy])(\s*)(-?\d+(?:\.\d+)?)/g, (_m, a: string, gap: string, n: string) => a + gap + String(Math.round(Number(n) * (a === 'x' ? fx : fy) * 2) / 2));
      if (next !== v) out.push({ from: guides.from, to: guides.to, insert: next });
    }
    const margins = attrValueRange(text, el, 'data-ol-layout-margins');
    if (margins) {
      const v = text.slice(margins.from, margins.to), t = v.trim().split(/\s+/);
      if (t.length >= 1 && t.length <= 4 && t.every(x => /^\d+(?:\.\d+)?(px|pt|mm|cm|in|%)?$/i.test(x))) {
        const sides = t.length === 1 ? [t[0], t[0], t[0], t[0]] : t.length === 2 ? [t[0], t[1], t[0], t[1]] : t.length === 3 ? [t[0], t[1], t[2], t[1]] : t;
        const s = sides.map((x, i) => {
          const m = /^(\d+(?:\.\d+)?)(px|pt|mm|cm|in|%)?$/i.exec(x)!;
          return m[2] === '%' ? x : num(Number(m[1]) * (i % 2 === 0 ? fy : fx), m[2] ?? 'px') + (m[2] ?? '');
        });
        const next = (s[1] === s[3] ? (s[0] === s[2] ? (s[0] === s[1] ? [s[0]] : [s[0], s[1]]) : [s[0], s[1], s[2]]) : s).join(' ');
        if (next !== v) out.push({ from: margins.from, to: margins.to, insert: next });
      }
    }
  }
  return { splices: tidy(text, out), factor: f };
}

/** in order, without the ones that change nothing or overlap an earlier one */
function tidy(text: string, splices: Splice[]): Splice[] {
  const s = splices.filter(x => text.slice(x.from, x.to) !== x.insert).sort((a, b) => a.from - b.from || a.to - b.to);
  const out: Splice[] = [];
  for (const x of s) if (!out.length || x.from >= out[out.length - 1].to) out.push(x);
  return out;
}

/** what a change of size does, for the dialog: the factor of the content and how the page's shape changes */
export function pageSetupFactor(from: PageSize, to: PageSize): { factor: number; fx: number; fy: number; sameShape: boolean } {
  const a = pageSizePx(from), b = pageSizePx(to);
  const fx = b.w / a.w, fy = b.h / a.h;
  return { factor: Math.min(fx, fy), fx, fy, sameShape: Math.abs(fx / fy - 1) < 0.005 };
}
