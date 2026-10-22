/**
 * Slide layouts with placeholders, as Google Slides' (the user, 22 Oct 2026: "Google Slides-like
 * templates where I can put various placeholders, in particular a title placeholder and possibly a
 * bullet box"): the arrangements a new slide can take — Title slide, Section header, Title and body,
 * Title and two columns, Title only, Title and picture, Blank — with boxes in them that say what goes
 * there ("Click to add title") while they are empty.
 *
 * An HTML deck has no masters (sourceops slideDesigns): its built-in layouts are made from the deck
 * itself — its margins (the template's data-ol-layout-margins, else where its slides' objects sit), its
 * titles and its text as they look on its slides, the decoration its slides share (what recurs on
 * them, or is marked as decoration). The deck's own layouts are slides kept in
 * <template data-ol-layout="Name"> in its <body> (Save as layout): a template is never shown,
 * presented or printed.
 *
 * A placeholder is any object of a slide with data-ol-ph="title | subtitle | body | text | picture".
 * Empty, the canvas shows its prompt in a dashed outline (runtime/placeholders.ts); presented, printed
 * or exported it is an empty element — nothing shows. Typed into, it is a text box that keeps its role:
 * Apply layout puts a slide's title into the new layout's title, its list into the new list.
 */
import { parseSource, elementChildren, attr, hasClass, outerRange, innerRange, parseStyle, formatStyle, editStyle, type HElement, type HtmlOp, type Path, type SourceDoc } from '@overlyx/core/html/source.ts';
import { slideElements } from '@overlyx/core/html/deliverable.ts';
import { LAYOUT_MARGINS_ATTR, layoutMarginSides, type MarginSides } from './guides';
import type { TextLook } from './protocol';

export const PH_ATTR = 'data-ol-ph';
export const LAYOUT_ATTR = 'data-ol-layout';
export type PhRole = 'title' | 'subtitle' | 'body' | 'text' | 'picture';
export const PH_ROLES: readonly PhRole[] = ['title', 'subtitle', 'body', 'text', 'picture'];
export const PH_LABELS: Record<PhRole, string> = { title: 'Title', subtitle: 'Subtitle', body: 'Bulleted list', text: 'Text', picture: 'Picture' };
export const isRole = (v: string | null | undefined): v is PhRole => !!v && (PH_ROLES as readonly string[]).includes(v);

export interface Size { w: number; h: number }
export interface Box { x: number; y: number; w: number; h: number }

/* ------------------------------------------------------------------ reading the deck */

interface Obj {
  el: HElement; tag: string; src: string; style: Map<string, string>;
  x?: number; y?: number; w?: number; h?: number;
  /** words in a text element */
  textual: boolean; heading: boolean;
  /** decoration: marked as such, or the same on another slide */
  decor: boolean; repeated: boolean;
  ph: PhRole | null;
}
interface SlideInfo { el: HElement; objs: Obj[] }

const DECOR_CLASS = /(^|\s)(decor\w*|bg|background|accent|ornament|logo|footer|bar|band|stripe|rule)(\s|$)/i;
const TEXT_TAG = /^(h[1-6]|p|ul|ol|div|blockquote)$/;
/** what a layout keeps of a slide's own attributes: not its comments, its suggestions, its guides */
const NOT_DESIGN = /^(id|data-ol-comments|data-ol-ins|data-ol-del|data-ol-chg|data-ol-was|data-ol-guides|data-ol-name|data-ol-layout)$/;
const GEOMETRY = new Set(['position', 'left', 'top', 'right', 'bottom', 'width', 'height', 'min-height', 'max-height', 'min-width', 'max-width', 'transform', 'rotate', 'translate']);

function textOf(el: HElement): string {
  let s = '';
  for (const n of el.childNodes) s += 'value' in n ? (n as { value: string }).value : 'tagName' in n ? textOf(n as HElement) : '';
  return s;
}
const px = (v: string | undefined): number | undefined => {
  const m = v ? /^(-?\d+(?:\.\d+)?)(px)?$/i.exec(v.trim()) : null;
  return m ? Number(m[1]) : undefined;
};
const median = (xs: number[]): number | null => {
  if (!xs.length) return null;
  const s = [...xs].sort((a, b) => a - b), k = s.length >> 1;
  return s.length % 2 ? s[k] : (s[k - 1] + s[k]) / 2;
};
const r1 = (n: number) => Math.round(n);
/** the value most of `xs` are at (8 px apart counts as one), the first of a tie; null: none twice */
const commonest = (xs: number[]): number | null => {
  let best: number | null = null, most = 1;
  for (const x of xs) { const n = xs.filter(y => Math.abs(y - x) <= 8).length; if (n > most) { most = n; best = x; } }
  return best;
};
const escAttr = (s: string) => s.replace(/&/g, '&amp;').replace(/"/g, '&quot;');

function readSlides(text: string | SourceDoc, size: Size): { t: string; slides: SlideInfo[]; bodyEl: HElement | null } {
  const { doc, text: t } = typeof text === 'string' ? parseSource(text) : text;
  const els = slideElements(doc);
  const html = elementChildren(doc).find(e => e.tagName === 'html');
  const bodyEl = html ? elementChildren(html).find(e => e.tagName === 'body') ?? null : null;
  const srcs = els.map(s => elementChildren(s).filter(k => k.sourceCodeLocation).map(k => { const r = outerRange(k); return t.slice(r.from, r.to).trim(); }));
  // (a copy of a slide — duplicated, or made of a layout saved from it — repeats all of it: that is no design the slides share)
  const copies = (i: number, j: number) => { const a = srcs[i], b = new Set(srcs[j]); return a.length > 0 && a.filter(x => b.has(x)).length >= 0.6 * Math.max(a.length, b.size); };
  const slides = els.map((s, i) => {
    const objs: Obj[] = [];
    for (const k of elementChildren(s)) {
      if (!k.sourceCodeLocation || (k.tagName === 'aside' && hasClass(k, 'notes')) || k.tagName === 'template' || k.tagName === 'script' || k.tagName === 'style') continue;
      const r = outerRange(k), src = t.slice(r.from, r.to);
      const st = new Map(parseStyle(attr(k, 'style') ?? '').map(d => [d.prop.toLowerCase(), d.value]));
      const w = px(st.get('width')), h = px(st.get('height')) ?? px(st.get('min-height'));
      let x = px(st.get('left')), y = px(st.get('top'));
      if (x === undefined && w !== undefined && px(st.get('right')) !== undefined) x = size.w - px(st.get('right'))! - w;
      if (y === undefined && h !== undefined && px(st.get('bottom')) !== undefined) y = size.h - px(st.get('bottom'))! - h;
      const ph = attr(k, PH_ATTR);
      const textual = TEXT_TAG.test(k.tagName) && /\S/.test(textOf(k));
      const repeated = srcs.some((o, j) => j !== i && o.includes(src.trim()) && !copies(i, j));
      const marked = attr(k, 'aria-hidden') === 'true' || attr(k, 'data-ol-master') !== null || DECOR_CLASS.test(attr(k, 'class') ?? '');
      objs.push({
        el: k, tag: k.tagName, src, style: st, x, y, w, h, textual, heading: /^h[1-6]$/.test(k.tagName),
        // (the same heading on two slides is two slides about one thing, not their design)
        ph: isRole(ph) ? ph : null, repeated, decor: !isRole(ph) && ((repeated && !/^h[1-6]$/.test(k.tagName)) || (marked && !textual)),
      });
    }
    return { el: s, objs };
  });
  return { t, slides, bodyEl };
}

/** a slide's start tag without what is that slide's own (comments, suggestions, guides) */
function openTag(el: HElement): string {
  const attrs = el.attrs.filter(a => !NOT_DESIGN.test(a.name));
  return `<${el.tagName}${attrs.map(a => ` ${a.name}="${escAttr(a.value)}"`).join('')}>`;
}

/** the look of a text: its style without where it is */
function lookOf(o: Obj): string {
  return formatStyle(parseStyle(attr(o.el, 'style') ?? '').filter(d => !GEOMETRY.has(d.prop.toLowerCase())));
}

/** a text of the deck a layout's placeholders look like: which element (`path`: the runtime measures it), its tag, class and look, where it is */
export interface TextRef { path: Path; tag: string; cls: string | null; look: string; box: Partial<Box> }

function refOf(o: Obj | undefined): TextRef | null {
  if (!o) return null;
  const path: number[] = [];
  let cur: HElement = o.el;
  while (cur.parentNode && 'tagName' in cur.parentNode) { const p = cur.parentNode as HElement; path.unshift(elementChildren(p).indexOf(cur)); cur = p; }
  return { path, tag: o.tag, cls: attr(o.el, 'class'), look: lookOf(o), box: { x: o.x, y: o.y, w: o.w, h: o.h } };
}

/**
 * The margins of the deck's slides (slide px from each edge): the slide's own data-ol-layout-margins,
 * else the template's (on <body>), else where its objects sit — on each side the middle of the slides'
 * (their outermost text and pictures, decoration and full-width objects left out) — else 6 % / 7 %.
 */
export function deckMargins(text: string, size: Size, slide = -1): { sides: MarginSides; from: 'slide' | 'template' | 'deck' | 'default' } {
  const { slides, bodyEl } = readSlides(text, size);
  return marginsOf(slides, bodyEl, size, slide);
}

function marginsOf(slides: SlideInfo[], bodyEl: HElement | null, size: Size, slide: number): { sides: MarginSides; from: 'slide' | 'template' | 'deck' | 'default' } {
  const own = slides[slide] ? layoutMarginSides(attr(slides[slide].el, LAYOUT_MARGINS_ATTR), size.w, size.h) : null;
  if (own) return { sides: own, from: 'slide' };
  const tpl = bodyEl ? layoutMarginSides(attr(bodyEl, LAYOUT_MARGINS_ATTR), size.w, size.h) : null;
  if (tpl) return { sides: tpl, from: 'template' };
  const { w: W, h: H } = size;
  const L: number[] = [], R: number[] = [], T: number[] = [], B: number[] = [];
  const content = slides.length > 1 ? slides.slice(1) : slides;
  for (const s of content) {
    const os = s.objs.filter(o => !o.decor && o.x !== undefined && o.y !== undefined && o.w !== undefined && o.w < 0.9 * W && (o.textual || o.ph || o.tag === 'img' || o.tag === 'svg'));
    if (!os.length) continue;
    L.push(Math.min(...os.map(o => o.x!)));
    R.push(W - Math.max(...os.map(o => o.x! + o.w!)));
    T.push(Math.min(...os.map(o => o.y!)));
    const tall = os.filter(o => o.h !== undefined);
    if (tall.length) B.push(H - Math.max(...tall.map(o => o.y! + o.h!)));
  }
  const clamp = (v: number | null, lo: number, hi: number, dflt: number) => v === null ? dflt : Math.min(hi, Math.max(lo, v));
  const left = clamp(median(L), 0.015 * W, 0.2 * W, 0.06 * W), right = clamp(median(R), 0.015 * W, 0.2 * W, left);
  const top = clamp(median(T), 0.02 * H, 0.25 * H, 0.07 * H);
  // (only boxes with a height say where they end — not the words of a text box: its foot as far from the edge as its head, or less)
  const bottom = Math.min(clamp(median(B), 0.02 * H, 0.25 * H, top), Math.max(0.04 * H, Math.min(top, 0.12 * H)));
  return { sides: { top, right, bottom, left }, from: L.length ? 'deck' : 'default' };
}

/**
 * What the built-in layouts are made of: the slides' frame, the title of a content slide, its text
 * (a list when the deck has one), the title slide's title and subtitle, the decoration of a content
 * slide (`content`: the one shown, unless it is the first) and of the title slide.
 */
export interface DeckDesign {
  size: Size; frame: MarginSides;
  title: TextRef | null; body: TextRef | null; coverTitle: TextRef | null; coverSub: TextRef | null;
  /** where the text of content slides starts (the middle of theirs), and its left edge */
  bodyTop: number | null; bodyX: number | null;
  contentOpen: string; coverOpen: string;
  contentDecor: string[]; coverDecor: string[];
}

export function deckDesign(text: string, size: Size, current = 1): DeckDesign {
  const { slides, bodyEl } = readSlides(text, size);
  const frame = marginsOf(slides, bodyEl, size, current).sides;
  const contentSlides = slides.length > 1 ? slides.slice(1) : slides;
  // the content slides' title: their placeholder for one, else the commonest place of their first heading
  const titles = contentSlides.map(s => s.objs.find(o => o.ph === 'title') ?? s.objs.find(o => o.heading && !o.decor)).filter((o): o is Obj => !!o);
  const at = (o: Obj) => `${o.tag}:${Math.round((o.x ?? -1) / 8)}:${Math.round((o.y ?? -1) / 8)}`;
  const counts = new Map<string, number>();
  for (const o of titles) counts.set(at(o), (counts.get(at(o)) ?? 0) + 1);
  const title = titles.find(o => o.ph === 'title') ?? [...titles].sort((a, b) => (counts.get(at(b)) ?? 0) - (counts.get(at(a)) ?? 0))[0];
  // their text: the first after the title (a list among them first: the body placeholder is one)
  const below = (s: SlideInfo, t: Obj | undefined) => {
    const ts = s.objs.filter(o => o.textual && !o.heading && !o.decor && !o.ph && o !== t);
    // what is under the title (a kicker above it is no subtitle), in line with it first (an equation in the column beside is no body)
    const left = t?.x ?? frame.left;
    const inLine = (o: Obj) => o.x === undefined || Math.abs(o.x - left) <= 0.15 * size.w;
    const under = t?.y !== undefined ? ts.filter(o => o.y !== undefined && o.y > t.y!) : [];
    return under.sort((a, b) => Number(!inLine(a)) - Number(!inLine(b)) || a.y! - b.y!)[0] ?? ts.find(o => !t || s.objs.indexOf(o) > s.objs.indexOf(t)) ?? ts[0];
  };
  const firstText = (s: SlideInfo) => s.objs.find(o => o.ph === 'body') ?? below(s, s.objs.find(o => o.ph === 'title') ?? s.objs.find(o => o.heading && !o.decor));
  const texts = contentSlides.map(firstText).filter((o): o is Obj => !!o);
  const lists = contentSlides.flatMap(s => s.objs.filter(o => (o.tag === 'ul' || o.tag === 'ol') && !o.decor));
  const body = texts.find(o => o.ph === 'body') ?? lists[0] ?? texts[0];
  const cover = slides[0];
  const coverTitle = cover ? cover.objs.find(o => o.ph === 'title') ?? cover.objs.find(o => o.heading && !o.decor) : undefined;
  const coverSub = cover ? cover.objs.find(o => o.ph === 'subtitle') ?? below(cover, coverTitle) : undefined;
  const rep = slides[current] && current > 0 ? slides[current] : slides[1] ?? slides[0];
  const decor = (s: SlideInfo | undefined) => s ? s.objs.filter(o => o.decor && !o.ph).map(o => o.src) : [];
  const tops = texts.map(o => o.y).filter((y): y is number => y !== undefined && (!title?.y || y > title.y));
  const xs = texts.map(o => o.x).filter((x): x is number => x !== undefined);
  return {
    size, frame,
    title: refOf(title), body: refOf(body), coverTitle: refOf(coverTitle), coverSub: refOf(coverSub),
    bodyTop: median(tops), bodyX: commonest(xs) ?? median(xs),
    contentOpen: rep ? openTag(rep.el) : '<section class="slide">', coverOpen: cover ? openTag(cover.el) : '<section class="slide">',
    contentDecor: decor(rep), coverDecor: decor(cover),
  };
}

/* ------------------------------------------------------------------ the layouts */

export interface Layout { id: string; name: string; html: string; /** a layout of the deck's own (<template>): its path */ saved?: Path }
/** the looks the runtime measured (DeliverableEditor asks for the design's texts) */
export type DesignLooks = Partial<Record<'title' | 'body' | 'coverTitle' | 'coverSub', TextLook | null>>;

/** one line of a text (px): its look's line height, else its own font size's, else `dflt` */
function lineOf(ref: TextRef | null, look: TextLook | null | undefined, dflt: number): number {
  const own = ref ? new Map(parseStyle(ref.look).map(d => [d.prop.toLowerCase(), d.value])) : new Map<string, string>();
  const fs = px(look?.fontSize) ?? px(own.get('font-size')) ?? dflt / 1.2;
  const lh = look?.lineHeight ?? own.get('line-height') ?? 'normal';
  const n = px(lh);
  if (lh === 'normal' || n === undefined) return 1.2 * fs;
  return /px$/i.test(lh) ? n : n * fs;
}

/** a placeholder: an empty object of the role, its tag and look the deck's */
function phHtml(role: PhRole, tag: string, cls: string | null, look: string, b: Box, fixed = false): string {
  const geo = `position: absolute; left: ${r1(b.x)}px; top: ${r1(b.y)}px; width: ${r1(b.w)}px; ${fixed ? 'height' : 'min-height'}: ${r1(b.h)}px`;
  return `<${tag}${cls ? ` class="${escAttr(cls)}"` : ''} ${PH_ATTR}="${role}" style="${escAttr(look ? `${geo}; ${look}` : geo)}"></${tag}>`;
}

/** a bulleted list placeholder: the deck's list as it is, or a list that looks like its text */
function listPh(d: DeckDesign, looks: DesignLooks, b: Box): string {
  const ref = d.body;
  if (ref && (ref.tag === 'ul' || ref.tag === 'ol')) return phHtml('body', ref.tag, ref.cls, ref.look, b);
  const l = looks.body;
  let look = ref?.look ?? '';
  const has = new Set(parseStyle(look).map(x => x.prop.toLowerCase()));
  const set: Record<string, string> = { margin: '0', 'padding-left': '1.1em' };
  if (l && !has.has('font-size')) set['font-size'] = l.fontSize;
  if (l && !has.has('line-height') && l.lineHeight !== 'normal') set['line-height'] = l.lineHeight;
  look = editStyle(look, set);
  return phHtml('body', 'ul', ref?.cls ?? null, look, b);
}

/** the deck's built-in layouts (decks only), made of its own design */
export function builtInLayouts(d: DeckDesign, looks: DesignLooks = {}): Layout[] {
  const { w: W, h: H } = d.size, F = d.frame;
  const x0 = F.left, y0 = F.top, x1 = W - F.right, y1 = H - F.bottom, fw = x1 - x0, fh = y1 - y0;
  const slide = (open: string, parts: string[]) => `${open}\n${parts.map(p => '  ' + p).join('\n')}\n</${/^<(\w+)/.exec(open)?.[1] ?? 'section'}>`;
  // a content slide's title, where the deck has it
  const t = d.title, tl = lineOf(t, looks.title, 0.07 * H);
  const tBox: Box = { x: t?.box.x ?? x0, y: t?.box.y ?? y0, w: t?.box.w ?? fw, h: Math.max(t?.box.h ?? 0, tl) };
  const titlePh = phHtml('title', t?.tag ?? 'h2', t?.cls ?? null, t?.look ?? '', tBox);
  // the text below it, to the frame's foot
  const under = tBox.y + tBox.h + 0.03 * H;
  // (where the deck's text starts, below its title; inside the frame when the title sits above it, in a bar)
  const bTop = Math.max(d.bodyTop !== null && d.bodyTop >= tBox.y + 0.8 * tBox.h ? d.bodyTop : under, y0);
  const bX = d.bodyX !== null && d.bodyX >= 0 && d.bodyX < x1 - 0.3 * fw ? d.bodyX : x0;
  const bBox: Box = { x: bX, y: bTop, w: x1 - bX, h: Math.max(0.2 * H, y1 - bTop) };
  const gap = 0.04 * W, colW = (bBox.w - gap) / 2;
  const textLook = d.body && d.body.tag !== 'ul' && d.body.tag !== 'ol' ? d.body : null;
  const textPh = (b: Box) => phHtml('text', textLook?.tag === 'div' ? 'div' : 'p', textLook?.cls ?? null, textLook?.look ?? '', b);
  // the title slide's title and subtitle, where the deck has them
  const ct = d.coverTitle ?? d.title, ctl = lineOf(ct, d.coverTitle ? looks.coverTitle : looks.title, 0.1 * H);
  const ctBox: Box = { x: ct === d.coverTitle && ct?.box.x !== undefined ? ct.box.x : x0, y: ct === d.coverTitle && ct?.box.y !== undefined ? ct.box.y : y0 + 0.32 * fh, w: ct === d.coverTitle && ct?.box.w !== undefined ? ct.box.w : fw, h: Math.max(ct === d.coverTitle ? ct?.box.h ?? 0 : 0, ctl) };
  const cs = d.coverSub, csl = lineOf(cs ?? d.body, cs ? looks.coverSub : looks.body, 0.05 * H);
  const csBox: Box = { x: cs?.box.x ?? ctBox.x, y: cs?.box.y ?? ctBox.y + ctBox.h + 0.03 * H, w: cs?.box.w ?? ctBox.w, h: Math.max(cs?.box.h ?? 0, csl) };
  const coverTitlePh = (b: Box) => phHtml('title', ct?.tag ?? 'h1', ct?.cls ?? null, ct?.look ?? '', b);
  const subPh = (role: PhRole, b: Box) => phHtml(role, cs?.tag === 'div' ? 'div' : 'p', cs?.cls ?? textLook?.cls ?? null, cs?.look ?? textLook?.look ?? '', b);
  const sTitle: Box = { x: x0, y: y0 + 0.36 * fh - ctl / 2, w: fw, h: ctl };
  const sText: Box = { x: x0, y: sTitle.y + sTitle.h + 0.03 * H, w: fw, h: csl };
  return [
    { id: 'title', name: 'Title slide', html: slide(d.coverOpen, [...d.coverDecor, coverTitlePh(ctBox), subPh('subtitle', csBox)]) },
    { id: 'section', name: 'Section header', html: slide(d.coverOpen, [...d.coverDecor, coverTitlePh(sTitle), subPh('text', sText)]) },
    { id: 'body', name: 'Title and body', html: slide(d.contentOpen, [...d.contentDecor, titlePh, listPh(d, looks, bBox)]) },
    { id: 'columns', name: 'Title and two columns', html: slide(d.contentOpen, [...d.contentDecor, titlePh, listPh(d, looks, { ...bBox, w: colW }), listPh(d, looks, { ...bBox, x: bBox.x + colW + gap, w: colW })]) },
    { id: 'only', name: 'Title only', html: slide(d.contentOpen, [...d.contentDecor, titlePh]) },
    { id: 'picture', name: 'Title and picture', html: slide(d.contentOpen, [...d.contentDecor, titlePh, phHtml('picture', 'div', null, '', { ...bBox, w: bBox.w * 0.62 }, true), textPh({ x: bBox.x + bBox.w * 0.62 + gap, y: bBox.y, w: bBox.w * 0.38 - gap, h: csl })]) },
    { id: 'blank', name: 'Blank', html: slide(d.contentOpen, d.contentDecor) },
  ];
}

/** the deck's own layouts: the slides kept in its <template data-ol-layout="…"> */
export function savedLayouts(text: string): Layout[] {
  const { doc, text: t } = parseSource(text);
  const html = elementChildren(doc).find(e => e.tagName === 'html');
  const body = html ? elementChildren(html).find(e => e.tagName === 'body') : undefined;
  if (!body) return [];
  const bi = html ? elementChildren(html).indexOf(body) : 1;
  const out: Layout[] = [];
  elementChildren(body).forEach((k, i) => {
    const name = k.tagName === 'template' ? attr(k, LAYOUT_ATTR) : null;
    const r = name !== null ? innerRange(k) : null;
    if (name === null || !r) return;
    const inner = t.slice(r.from, r.to).trim();
    if (!/class="[^"]*\bslide\b/.test(inner)) return;
    out.push({ id: `saved:${i}`, name: name || 'Layout', html: inner, saved: [bi, i] });
  });
  return out;
}

/* ------------------------------------------------------------------ slides made of layouts */

/** a placeholder of a slide's markup emptied, `<tag …></tag>` */
function emptied(src: string, tag: string): string {
  const open = /^<[^>]*>/.exec(src)?.[0] ?? `<${tag}>`;
  return `${open}</${tag}>`;
}
const stripReview = (src: string) => src.replace(/\s(data-ol-(?:comments|ins|del|chg|was))=("[^"]*"|'[^']*')/g, '');

/**
 * A slide as a layout (Save as layout): everything on it as it is — its decoration, pictures, words
 * that belong to the design —, its placeholders emptied; no speaker notes, comments or suggestions.
 */
export function layoutFromSlide(text: string, slide: number): string | null {
  const { doc, text: t } = parseSource(text);
  const s = slideElements(doc)[slide];
  if (!s?.sourceCodeLocation) return null;
  const parts: string[] = [];
  for (const k of elementChildren(s)) {
    if (!k.sourceCodeLocation || (k.tagName === 'aside' && hasClass(k, 'notes'))) continue;
    const r = outerRange(k), src = t.slice(r.from, r.to);
    parts.push(stripReview(isRole(attr(k, PH_ATTR)) ? emptied(src, k.tagName) : src));
  }
  return `${openTag(s)}\n${parts.map(p => '  ' + p).join('\n')}\n</${s.tagName}>`;
}

/** the operation that keeps `html` (a slide) as a layout of the deck named `name`: a <template> at the end of its <body> */
export function saveLayoutOp(text: string, html: string, name: string): HtmlOp | null {
  const { doc } = parseSource(text);
  const root = elementChildren(doc).find(e => e.tagName === 'html');
  const body = root ? elementChildren(root).find(e => e.tagName === 'body') : undefined;
  if (!root || !body) return null;
  const kids = elementChildren(body);
  // (before the page's scripts, after its slides and the layouts before it)
  let index = kids.length;
  while (index > 0 && kids[index - 1].tagName === 'script') index--;
  return { t: 'insert', parent: [elementChildren(root).indexOf(body)], index, html: `<template ${LAYOUT_ATTR}="${escAttr(name)}">\n${html}\n</template>` };
}

/** markup put into a placeholder of another tag: list items into a list, a list's items as lines into a text */
function fitInto(tag: string, inner: string): string {
  const list = tag === 'ul' || tag === 'ol';
  if (list && !/<li[\s>]/i.test(inner)) {
    const lines = inner.split(/<br\s*\/?>|<\/p>\s*<p[^>]*>/i).map(s => s.replace(/<\/?p[^>]*>/gi, '').trim()).filter(Boolean);
    return (lines.length ? lines : [inner]).map(s => `<li>${s}</li>`).join('');
  }
  if (!list && /^h[1-6]$|^p$/.test(tag) && /<li[\s>]/i.test(inner)) {
    return [...inner.matchAll(/<li[^>]*>([\s\S]*?)<\/li>/gi)].map(m => m[1].trim()).join('<br>');
  }
  return inner;
}

/**
 * Apply layout (Google Slides' Slide ▸ Apply layout): the slide made of `layout` — its decoration,
 * its placeholders filled with what the slide's had (its title, a subtitle, its list or text in
 * order) —, everything else on the slide kept where it is (pictures, drawings, text boxes that are no
 * placeholder), its notes and comments too. One operation: the slide's markup replaced.
 */
export function applyLayoutOp(text: string, slide: number, layout: string): HtmlOp | null {
  const src = parseSource(text), { doc, text: t } = src;
  const s = slideElements(doc)[slide];
  const layText = `<!doctype html><html><body>${layout}</body></html>`;
  const lay = slideElements(parseSource(layText).doc)[0];
  if (!s?.sourceCodeLocation || !lay) return null;
  const lsrc = (k: HElement) => { const r = outerRange(k); return layText.slice(r.from, r.to); };
  const inner = (k: HElement) => { const r = innerRange(k); return r ? t.slice(r.from, r.to).trim() : ''; };
  // what the slide had, by role: its placeholders, else its first heading as the title
  const kids = elementChildren(s).filter(k => k.sourceCodeLocation);
  const used = new Set<HElement>();
  const have = (role: PhRole): HElement[] => kids.filter(k => attr(k, PH_ATTR) === role && /\S/.test(textOf(k)));
  const pool: Record<PhRole, HElement[]> = { title: have('title'), subtitle: have('subtitle'), body: have('body'), text: have('text'), picture: kids.filter(k => attr(k, PH_ATTR) === 'picture' && k.tagName === 'img') };
  if (!pool.title.length) { const h = kids.find(k => /^h[1-6]$/.test(k.tagName) && !attr(k, PH_ATTR) && /\S/.test(textOf(k))); if (h) pool.title.push(h); }
  // (a slide made without placeholders: its text boxes, top to bottom, for the text placeholders once its own run out)
  const info = readSlides(src, { w: 1280, h: 720 }).slides[slide];
  // (what is under its title: a kicker above it stays where it is)
  const titleY = info?.objs.find(o => o.el === pool.title[0])?.y;
  const loose = (info?.objs ?? []).filter(o => o.textual && !o.heading && !o.decor && !o.ph && (titleY === undefined || o.y === undefined || o.y > titleY))
    .sort((a, b) => (a.y ?? 1e9) - (b.y ?? 1e9)).map(o => o.el);
  const take = (role: PhRole): HElement | undefined => {
    const order: PhRole[] = role === 'body' ? ['body', 'text'] : role === 'text' ? ['text', 'body', 'subtitle'] : role === 'subtitle' ? ['subtitle', 'text'] : [role];
    for (const r of order) { const k = pool[r].find(x => !used.has(x)); if (k) { used.add(k); return k; } }
    if (role === 'body' || role === 'text' || role === 'subtitle') { const k = loose.find(x => !used.has(x) && !pool.title.includes(x)); if (k) { used.add(k); return k; } }
    return undefined;
  };
  const parts: string[] = [];
  for (const k of elementChildren(lay)) {
    if (!k.sourceCodeLocation) continue;
    const role = attr(k, PH_ATTR);
    const src = lsrc(k);
    if (!isRole(role)) { parts.push(src); continue; }
    const from = take(role);
    if (!from) { parts.push(emptied(src, k.tagName)); continue; }
    if (role === 'picture') {
      // the picture, in the placeholder's place and size
      const st = new Map(parseStyle(attr(k, 'style') ?? '').map(d => [d.prop.toLowerCase(), d.value]));
      const r = outerRange(from);
      const img = t.slice(r.from, r.to).replace(/\sstyle=("[^"]*"|'[^']*')/, '');
      const geo = ['position', 'left', 'top', 'width', 'height'].map(p => st.get(p) ? `${p}: ${st.get(p)}` : '').filter(Boolean).join('; ');
      parts.push(img.replace(/^<img/, `<img style="${escAttr(geo + '; object-fit: cover')}"`));
      continue;
    }
    const open = /^<[^>]*>/.exec(src)?.[0] ?? `<${k.tagName}>`;
    parts.push(`${open}${fitInto(k.tagName, inner(from))}</${k.tagName}>`);
  }
  // the rest of the slide: kept (not its decoration — the layout's comes instead —, nor its empty placeholders)
  const decor = new Set(info?.objs.filter(o => o.decor && !o.textual).map(o => o.el) ?? []);
  let notes = '';
  for (const k of kids) {
    if (used.has(k) || decor.has(k)) continue;
    const r = outerRange(k), src = t.slice(r.from, r.to);
    if (k.tagName === 'aside' && hasClass(k, 'notes')) { notes = src; continue; }
    if (isRole(attr(k, PH_ATTR)) && !/\S/.test(textOf(k)) && k.tagName !== 'img') continue;
    parts.push(src);
  }
  if (notes) parts.push(notes);
  // the layout's start tag, with what is the slide's own (its comments, suggestions, guides) kept
  const mine = s.attrs.filter(a => NOT_DESIGN.test(a.name));
  const theirs = lay.attrs.filter(a => !NOT_DESIGN.test(a.name));
  const open = `<${s.tagName}${[...theirs, ...mine].map(a => ` ${a.name}="${escAttr(a.value)}"`).join('')}>`;
  const path: number[] = [];
  let cur: HElement = s;
  while (cur.parentNode && 'tagName' in cur.parentNode) { const p = cur.parentNode as HElement; path.unshift(elementChildren(p).indexOf(cur)); cur = p; }
  return { t: 'outer', path, html: `${open}\n${parts.map(p => '  ' + p).join('\n')}\n</${s.tagName}>` };
}

/**
 * A placeholder of `role` to put on a slide (Insert ▸ Placeholder): where the deck's built-in layouts
 * have one — a title at the content slides' title, a subtitle at the title slide's, a list or a text
 * or a picture in the body —, its look the deck's.
 */
export function placeholderObject(role: PhRole, d: DeckDesign, looks: DesignLooks = {}): string {
  const ls = builtInLayouts(d, looks);
  const pick = role === 'subtitle' ? ls[0] : role === 'picture' ? ls[5] : ls[2];
  const text = `<!doctype html><html><body>${pick.html}</body></html>`;
  const lay = slideElements(parseSource(text).doc)[0];
  for (const k of lay ? elementChildren(lay) : []) {
    const r = attr(k, PH_ATTR);
    if (r === role || (role === 'text' && r === 'body')) {
      const o = outerRange(k), src = text.slice(o.from, o.to);
      if (role !== 'text') return src;
      // a text: a paragraph where the list would be
      const st = attr(k, 'style') ?? '';
      const look = d.body && d.body.tag !== 'ul' && d.body.tag !== 'ol' ? d.body : null;
      return `<${look?.tag === 'div' ? 'div' : 'p'}${look?.cls ? ` class="${escAttr(look.cls)}"` : ''} ${PH_ATTR}="text" style="${escAttr(editStyle(st, { margin: null, 'padding-left': null }))}"></${look?.tag === 'div' ? 'div' : 'p'}>`;
    }
  }
  return `<p ${PH_ATTR}="${role}" style="position: absolute; left: 10%; top: 40%; width: 80%; min-height: 48px"></p>`;
}

/* ------------------------------------------------------------------ pictures of layouts */

/** the deck's colours as its styles set them, for the layouts' pictures: its custom properties (`--accent: #eb811b`), and its classes' backgrounds and colours (`.dark { background: … }`) */
export interface DeckColors { vars: Record<string, string>; classes: Record<string, { background?: string; color?: string }> }

export function deckColors(text: string): DeckColors {
  const vars: Record<string, string> = {}, classes: DeckColors['classes'] = {};
  for (const st of text.matchAll(/<style[^>]*>([\s\S]*?)<\/style>/gi)) {
    const css = st[1].replace(/\/\*[\s\S]*?\*\//g, '');
    for (const m of css.matchAll(/--([\w-]+)\s*:\s*([^;}]+)/g)) vars[m[1]] ??= m[2].trim();
    // (rules of one class, or of the slide with one: `.dark`, `.slide.dark`, `.slide .card`)
    for (const m of css.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
      const decls = new Map(parseStyle(m[2]).map(d => [d.prop.toLowerCase(), d.value]));
      for (const sel of m[1].split(',')) {
        const k = /^(?:\.slide\s*)?\.([\w-]+)$/.exec(sel.trim().replace(/\.slide\./, '.'))?.[1];
        if (!k || k === 'slide') continue;
        const c = classes[k] ??= {};
        const bg = decls.get('background-color') ?? decls.get('background');
        if (bg) c.background = bg;
        if (decls.get('color')) c.color = decls.get('color');
      }
    }
  }
  return { vars, classes };
}

/**
 * A layout drawn small (the New slide picker): its decoration in the colours it has (`vars`: the
 * deck's custom properties; `paper`: the slides' own colour), its placeholders as Google draws them —
 * a bar for a title, lines for text, bullets for a list, a frame for a picture.
 */
export function layoutThumb(html: string, size: Size, colors: DeckColors = { vars: {}, classes: {} }, paper = '#fff'): string {
  const { w: W, h: H } = size;
  const text = `<!doctype html><html><body>${html}</body></html>`;
  const s = slideElements(parseSource(text).doc)[0];
  const out: string[] = [];
  const value = (v: string | undefined): string | null => {
    let c = (v ?? '').trim();
    for (let i = 0; i < 3; i++) { const m = /^var\(\s*--([\w-]+)\s*(?:,\s*([^)]+))?\)$/.exec(c); if (!m) break; c = (colors.vars[m[1]] ?? m[2] ?? '').trim(); }
    // (a gradient: the colour in its middle)
    if (/gradient\(/i.test(c)) {
      const cs = [...c.matchAll(/#[0-9a-f]{3,8}\b|rgba?\([^)]*\)|var\(--[\w-]+\)/gi)].map(m => m[0]);
      c = cs.length ? value(cs[Math.floor((cs.length - 1) / 2)]) ?? '' : '';
    }
    return /^(#[0-9a-f]{3,8}|rgba?\([^)]*\)|hsla?\([^)]*\)|[a-z]+)$/i.test(c) && !/^(none|transparent|inherit|initial|currentcolor)$/i.test(c) ? c : null;
  };
  /** an element's own style, its classes' under it */
  const styleOf = (el: HElement): Map<string, string> => {
    const st = new Map<string, string>();
    for (const k of (attr(el, 'class') ?? '').split(/\s+/)) {
      const c = colors.classes[k];
      if (c?.background) st.set('background', c.background);
      if (c?.color) st.set('color', c.color);
    }
    for (const d of parseStyle(attr(el, 'style') ?? '')) st.set(d.prop.toLowerCase(), d.value);
    return st;
  };
  const colour = (st: Map<string, string>) => value(st.get('background-color') ?? st.get('background'));
  const bg = s ? styleOf(s) : new Map<string, string>();
  out.push(`<rect width="${W}" height="${H}" fill="${escAttr(colour(bg) ?? paper)}"/>`);
  for (const k of s ? elementChildren(s) : []) {
    const st = styleOf(k);
    const x = px(st.get('left')), y = px(st.get('top')), w = px(st.get('width'));
    if (x === undefined || y === undefined || w === undefined) continue;
    const h = px(st.get('height')) ?? px(st.get('min-height')) ?? 0.06 * H;
    const role = attr(k, PH_ATTR);
    const u = H / 40;
    // (a title in a dark bar is drawn light, as its words are; on a dark slide, as the slide's are)
    const ink = escAttr(value(st.get('color')) ?? value(bg.get('color')) ?? '#80868b');
    if (role === 'title' || role === 'subtitle') {
      const bh = role === 'title' ? Math.min(h * 0.55, 2.2 * u) : Math.min(h * 0.5, 1.4 * u);
      const centred = /center/.test(st.get('text-align') ?? '');
      const bw = w * (role === 'title' ? 0.7 : 0.5);
      out.push(`<rect x="${r1(centred ? x + (w - bw) / 2 : x)}" y="${r1(y + (h - bh) / 2)}" width="${r1(bw)}" height="${r1(bh)}" rx="${r1(bh / 3)}" fill="${ink}" opacity="${role === 'title' ? 0.7 : 0.4}"/>`);
    } else if (role === 'body' || role === 'text') {
      const n = Math.max(1, Math.min(role === 'body' ? 4 : 2, Math.floor(h / (3.2 * u))));
      for (let i = 0; i < n; i++) {
        const ly = y + 1.4 * u + i * 3.2 * u;
        if (role === 'body') out.push(`<circle cx="${r1(x + 0.8 * u)}" cy="${r1(ly)}" r="${r1(0.5 * u)}" fill="${ink}" opacity="0.45"/>`);
        out.push(`<rect x="${r1(x + (role === 'body' ? 2 * u : 0))}" y="${r1(ly - 0.5 * u)}" width="${r1((w - 2 * u) * (i % 2 ? 0.72 : 0.9))}" height="${r1(u)}" rx="${r1(u / 2)}" fill="${ink}" opacity="0.3"/>`);
      }
    } else if (role === 'picture') {
      out.push(`<rect x="${r1(x)}" y="${r1(y)}" width="${r1(w)}" height="${r1(h)}" fill="${ink}" opacity="0.08" stroke="${ink}" stroke-opacity="0.35" stroke-width="${r1(u / 3)}"/>`);
      const cx = x + w / 2, cy = y + h / 2, m = Math.min(w, h) * 0.18;
      out.push(`<path d="M${r1(cx - m)} ${r1(cy + m * 0.7)} L${r1(cx - m * 0.2)} ${r1(cy - m * 0.3)} L${r1(cx + m * 0.3)} ${r1(cy + m * 0.3)} L${r1(cx + m * 0.6)} ${r1(cy)} L${r1(cx + m)} ${r1(cy + m * 0.7)} Z" fill="${ink}" opacity="0.35"/>`);
    } else if (/^(h[1-6]|p|ul|ol|div|blockquote)$/.test(k.tagName) && /\S/.test(textOf(k))) {
      // words the layout has of its own (a saved one keeps them): a bar for a heading, lines for text
      const heading = /^h[1-6]$/.test(k.tagName);
      const n = heading ? 1 : Math.max(1, Math.min(3, Math.round(h / (3.2 * u))));
      for (let i = 0; i < n; i++) {
        const bh = heading ? 1.8 * u : u;
        out.push(`<rect x="${r1(x)}" y="${r1(y + i * 3.2 * u + (heading ? 0.6 * u : 1.2 * u))}" width="${r1(w * (heading ? 0.6 : i % 2 ? 0.7 : 0.88))}" height="${r1(bh)}" rx="${r1(bh / 2)}" fill="${ink}" opacity="${heading ? 0.55 : 0.28}"/>`);
      }
    } else {
      // decoration: its colour, where it is (a picture: a light box)
      const c = colour(st);
      const round = /^(50%|9999px)$/.test(st.get('border-radius') ?? '') || /^(\d+)px$/.test(st.get('border-radius') ?? '') && Number(/^(\d+)/.exec(st.get('border-radius')!)![1]) >= Math.min(w, h) / 2;
      if (c && round) out.push(`<ellipse cx="${r1(x + w / 2)}" cy="${r1(y + h / 2)}" rx="${r1(w / 2)}" ry="${r1(h / 2)}" fill="${escAttr(c)}"/>`);
      else if (c) out.push(`<rect x="${r1(x)}" y="${r1(y)}" width="${r1(w)}" height="${r1(Math.max(h, 1))}" fill="${escAttr(c)}"/>`);
      else if (k.tagName === 'img' || k.tagName === 'svg') out.push(`<rect x="${r1(x)}" y="${r1(y)}" width="${r1(w)}" height="${r1(h)}" fill="#80868b" opacity="0.15"/>`);
    }
  }
  return `<svg viewBox="0 0 ${W} ${H}" xmlns="http://www.w3.org/2000/svg" aria-hidden="true">${out.join('')}</svg>`;
}
