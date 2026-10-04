/**
 * "New slide" layouts of layout decks — PowerPoint's Title slide / Title and content / Two content /
 * … — styled like the deck they go into. A beamer file has no slide masters, so the deck's style is
 * read off its pages (deckStyle): the title box most content pages share (the top box with the
 * largest type), the body box below it, the background most pages have, and the objects repeated on
 * most pages (a footer bar, a logo, a rule) — those come along on every new slide. The title slide
 * is the deck's own first page with its text taken out, when that page looks like one.
 *
 * Boxes are created empty and named (Title, Text, …): the editor shows "Click to add title" in an
 * empty named box (nodeviews.ts BoxView), which neither the PDF nor the presentation shows, and text
 * typed into it gets the formatting of the deck's own titles (promptMarks, used by the layout plugin).
 */
import type { Mark, Node as PMNode } from 'prosemirror-model';
import type { EditorState, Transaction } from 'prosemirror-state';
import { schema } from '@overlyx/core';
import { pages, defaultParagraph, makeShape, type Attrs } from './commands';

export type SlideLayout = 'title' | 'content' | 'section' | 'two' | 'comparison' | 'titleonly' | 'statement' | 'blank';

export const SLIDE_LAYOUTS: { id: SlideLayout; label: string }[] = [
  { id: 'title', label: 'Title slide' },
  { id: 'content', label: 'Title and content' },
  { id: 'section', label: 'Section header' },
  { id: 'two', label: 'Two content' },
  { id: 'comparison', label: 'Comparison' },
  { id: 'titleonly', label: 'Title only' },
  { id: 'statement', label: 'Big statement' },
  { id: 'blank', label: 'Blank' },
];

/** what an empty box of that name shows in the editor */
export const BOX_PROMPTS: Record<string, string> = {
  Title: 'Click to add title', Subtitle: 'Click to add subtitle', Text: 'Click to add text', Heading: 'Click to add heading', Statement: 'Click to add a statement',
};

/** Is the box empty: one paragraph without any content (a list item counts as empty too)? */
export function boxIsEmpty(box: PMNode): boolean {
  return box.childCount === 1 && box.firstChild!.isTextblock && box.firstChild!.content.size === 0;
}

/** a box of the deck to copy: its attributes, the formatting of its first letters, its first paragraph's style */
interface BoxStyle { attrs: Attrs; marks: readonly Mark[]; par: Attrs }

export interface DeckStyle {
  title: BoxStyle;
  body: BoxStyle;
  /** the background most pages have */
  fill: string | null;
  /** objects on most content pages, in drawing order: they come along on every new slide */
  master: PMNode[];
  /** the first page, when it looks like a title slide (a box with type at least as large as the titles') */
  cover: PMNode | null;
}

const NO_ANIMATION = { step: null, effect: null, lock: false };
const r1 = (v: unknown) => Math.round(Number(v ?? 0));

/** the page's text boxes with text (an empty one — a new slide's prompt — says nothing about the deck's style) */
function topBoxes(page: PMNode): PMNode[] {
  const out: PMNode[] = [];
  page.forEach(c => { if (c.type.name === 'ol_box' && c.textContent.trim()) out.push(c); });
  return out;
}

function firstMarks(box: PMNode): readonly Mark[] {
  let marks: readonly Mark[] | null = null;
  box.descendants(n => { if (marks) return false; if (n.isText) marks = n.marks; return true; });
  return marks ?? [];
}

function styleOf(box: PMNode): BoxStyle {
  return { attrs: { ...box.attrs, ...NO_ANIMATION }, marks: firstMarks(box), par: box.firstChild?.isTextblock ? { ...box.firstChild.attrs } : {} };
}

/** the entry seen most often, if any (ties: the first seen) */
function mode<T>(entries: { key: string; value: T }[]): { value: T; count: number } | null {
  const counts = new Map<string, { value: T; count: number }>();
  for (const e of entries) { const c = counts.get(e.key); if (c) c.count++; else counts.set(e.key, { value: e.value, count: 1 }); }
  let best: { value: T; count: number } | null = null;
  for (const c of counts.values()) if (!best || c.count > best.count) best = c;
  return best;
}

/** The style a new slide of this deck gets (see the comment at the top). */
export function deckStyle(doc: PMNode, page: { w: number; h: number }, basePt = 11): DeckStyle {
  const W = page.w, H = page.h;
  const all = pages(doc).map(p => p.node);
  const content = all.length > 2 ? all.slice(1) : all;
  const font = (b: PMNode) => Number(b.attrs.font ?? basePt);

  // the title: on each content page the box nearest the top among those with the largest type in its top third
  const titles: { key: string; value: PMNode }[] = [];
  for (const p of content) {
    const top = topBoxes(p).filter(b => Number(b.attrs.y) < H * 0.3);
    if (!top.length) continue;
    const t = top.reduce((a, b) => (font(b) > font(a) || (font(b) === font(a) && Number(b.attrs.y) < Number(a.attrs.y)) ? b : a));
    titles.push({ key: [r1(t.attrs.x), r1(t.attrs.y), r1(t.attrs.w), font(t), t.attrs.color ?? ''].join('|'), value: t });
  }
  const t = mode(titles)?.value ?? null;
  const u = W / 160;
  const title: BoxStyle = t ? styleOf(t) : {
    attrs: { x: 10 * u, y: 7, w: W - 20 * u, h: 10, font: 20, grow: true, valign: 't', align: 'left' },
    marks: [], par: {},
  };

  // the body: on pages with that title, the largest other box below it
  const bodies: { key: string; value: PMNode }[] = [];
  if (t) {
    const tkey = titles.find(x => x.value === t)!.key;
    for (const { key, value } of titles) {
      if (key !== tkey) continue;
      const p = content.find(pg => { let has = false; pg.forEach(c => { if (c === value) has = true; }); return has; });
      const below = p ? topBoxes(p).filter(b => b !== value && Number(b.attrs.y) >= Number(value.attrs.y) + Number(value.attrs.h) * 0.5) : [];
      if (!below.length) continue;
      const b = below.reduce((a, c) => (Number(c.attrs.w) * Number(c.attrs.h) > Number(a.attrs.w) * Number(a.attrs.h) ? c : a));
      bodies.push({ key: [r1(b.attrs.x), r1(b.attrs.y), r1(b.attrs.w), font(b)].join('|'), value: b });
    }
  }
  // pages that each have a body of their own (a caption, a table, a card) agree on none: the default then
  const bm = mode(bodies);
  const b = bm && (bm.count >= 2 || bodies.length === 1) ? bm.value : null;
  const ta = title.attrs;
  const bodyY = Number(ta.y) + Number(ta.h) + 6;
  const body: BoxStyle = b ? styleOf(b) : {
    attrs: { x: ta.x, y: bodyY, w: ta.w, h: Math.max(20, H - bodyY - H * 0.12), font: Math.max(10, Math.round(Number(ta.font ?? 20) * 0.6)), grow: true, valign: 't', align: 'left' },
    marks: [], par: { layout: 'Itemize', depth: 0 },
  };

  // the background and the repeated objects: on at least 60 % of the content pages (two at least)
  const enough = (n: number) => n >= 2 && n >= content.length * 0.6;
  const fills = mode(content.map(p => ({ key: String(p.attrs.fill ?? ''), value: p.attrs.fill as string | null })));
  const fill = fills && enough(fills.count) ? fills.value : null;
  const seen = new Map<string, { node: PMNode; pages: number; order: number }>();
  content.forEach(p => {
    const here = new Set<string>();
    p.forEach((c, _o, i) => {
      if (c.type.name === 'ol_notes' || c === t || c === b) return;
      if (c.type.name === 'ol_raw' && c.attrs.placed === false) return;
      const { step: _s, effect: _e, ...rest } = c.attrs;
      const sig = c.type.name + JSON.stringify(rest) + (c.isLeaf ? '' : JSON.stringify(c.content.toJSON()));
      if (here.has(sig)) return;
      here.add(sig);
      const e = seen.get(sig);
      if (e) e.pages++; else seen.set(sig, { node: c, pages: 1, order: i });
    });
  });
  const master = [...seen.values()].filter(e => enough(e.pages)).sort((x, y) => x.order - y.order).map(e => e.node);

  const first = all[0];
  const cover = all.length > 1 && first && topBoxes(first).some(x => font(x) >= Number(ta.font ?? 20)) ? first : null;
  return { title, body, fill, master, cover };
}

function emptyBox(style: BoxStyle, name: string, patch: Attrs = {}, par: Attrs = style.par): PMNode {
  const p = par.layout ? schema.nodes.paragraph.create({ ...par, depth: par.depth ?? 0 }) : defaultParagraph();
  return schema.nodes.ol_box.create({ ...style.attrs, ...NO_ANIMATION, name, ...patch }, [p]);
}

/** The first page with every text box emptied: the largest type becomes the title, the next the subtitle. */
function coverPage(cover: PMNode, style: DeckStyle): PMNode[] {
  const boxes = topBoxes(cover).sort((a, b) => Number(b.attrs.font ?? 0) - Number(a.attrs.font ?? 0));
  const names = new Map<PMNode, string>(boxes.map((bx, i) => [bx, i === 0 ? 'Title' : i === 1 ? 'Subtitle' : 'Text']));
  const out: PMNode[] = [];
  cover.forEach(c => {
    if (c.type.name === 'ol_notes') return;
    if (c.type.name !== 'ol_box') { out.push(c); return; }
    const name = names.get(c);
    if (!name) { out.push(c); return; }   // an empty frame (a coloured panel): stays as it is
    out.push(emptyBox(styleOf(c), name));
  });
  void style;
  return out;
}

/** The objects of a new slide of this layout (the master objects first: they are the background). */
export function layoutObjects(layout: SlideLayout, style: DeckStyle, page: { w: number; h: number }): PMNode[] {
  const W = page.w, H = page.h;
  const T = style.title, B = style.body;
  const ta = T.attrs, ba = B.attrs;
  const tfont = Number(ta.font ?? 20), bfont = Number(ba.font ?? 12);
  const gap = Math.max(4, W * 0.03);
  const half = (Number(ba.w) - gap) / 2;
  const own: PMNode[] = [];
  switch (layout) {
    case 'title':
      if (style.cover) return coverPage(style.cover, style);
      own.push(emptyBox(T, 'Title', { y: H * 0.3, h: Number(ta.h) * 1.4, font: Math.round(tfont * 1.35), valign: 'c' }));
      own.push(emptyBox(B, 'Subtitle', { x: ta.x, w: ta.w, y: H * 0.3 + Number(ta.h) * 1.4 + 4, h: 10, font: Math.max(10, Math.round(bfont * 1.1)) }, {}));
      break;
    case 'content':
      own.push(emptyBox(T, 'Title'), emptyBox(B, 'Text'));
      break;
    case 'titleonly':
      own.push(emptyBox(T, 'Title'));
      break;
    case 'two':
      own.push(emptyBox(T, 'Title'), emptyBox(B, 'Text', { w: half }), emptyBox(B, 'Text', { x: Number(ba.x) + half + gap, w: half }));
      break;
    case 'comparison': {
      const hh = bfont * 1.25 * 0.3528 + 3;   // one line of the heading (pt → mm) and some air
      const head = { font: Math.round(bfont * 1.15), color: ta.color ?? null, h: hh, grow: true, valign: 't' };
      const rest = { y: Number(ba.y) + hh + 2, h: Math.max(15, Number(ba.h) - hh - 2) };
      own.push(emptyBox(T, 'Title'),
        emptyBox(B, 'Heading', { ...head, w: half }, {}), emptyBox(B, 'Heading', { ...head, x: Number(ba.x) + half + gap, w: half }, {}),
        emptyBox(B, 'Text', { ...rest, w: half }), emptyBox(B, 'Text', { ...rest, x: Number(ba.x) + half + gap, w: half }));
      break;
    }
    case 'section': {
      const y = H * 0.36, h = Number(ta.h) * 1.4;
      own.push(emptyBox(T, 'Title', { y, h, font: Math.round(tfont * 1.35), valign: 'b', align: 'left' }));
      own.push(makeShape('rect', { x: ta.x, y: y + h + 3, w: Math.min(40, Number(ta.w) * 0.25), h: 0.9, fill: ta.color ?? 'structure', stroke: null }));
      own.push(emptyBox(B, 'Subtitle', { x: ta.x, w: ta.w, y: y + h + 7, h: 10, font: bfont }, {}));
      break;
    }
    case 'statement':
      own.push(emptyBox(T, 'Statement', { y: H * 0.22, h: H * 0.5, font: Math.round(tfont * 1.3), align: 'center', valign: 'c', grow: false }));
      break;
    case 'blank':
      break;
  }
  return [...style.master, ...own];
}

/** A new slide of this layout after the page at `afterPos` (null: at the end). */
export function insertSlide(state: EditorState, afterPos: number | null, layout: SlideLayout, page: { w: number; h: number }, basePt = 11): { tr: Transaction; pos: number } {
  const style = deckStyle(state.doc, page, basePt);
  // the title slide copies the deck's own first page: its background too (a dark cover in a light deck)
  const fill = layout === 'title' && style.cover ? style.cover.attrs.fill : style.fill;
  const node = schema.nodes.ol_page.create({ fill }, layoutObjects(layout, style, page));
  const list = pages(state.doc);
  const after = afterPos === null ? null : list.find(p => p.pos === afterPos) ?? null;
  const at = after ? after.pos + after.node.nodeSize : (list.length ? list[list.length - 1].pos + list[list.length - 1].node.nodeSize : state.doc.content.size);
  return { tr: state.tr.insert(at, node), pos: at };
}

/**
 * The formatting text typed into an empty named box starts with: the deck's titles' for a title
 * (their bold, their size command), nothing special otherwise. Null: leave the marks alone.
 */
export function promptMarks(doc: PMNode, box: PMNode, page: { w: number; h: number }): readonly Mark[] | null {
  const name = box.attrs.name as string | null;
  if (name !== 'Title' && name !== 'Statement' && name !== 'Heading') return null;
  const marks = deckStyle(doc, page).title.marks;
  return marks.length ? marks : null;
}
