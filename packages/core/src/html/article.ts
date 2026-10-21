/**
 * HTML articles: a web page — a research post, an essay — whose prose is a document. It opens in the
 * document editor like a .tex or markdown file (comments, suggestions, formulas, citations, agents'
 * tracked edits, versions), while everything around the prose — the <head> with its styles and
 * scripts, a header, interactive figures, anything bespoke — stays exactly as its authors wrote it.
 *
 * A page is an article when its head says so: `<meta name="overlyx" content="article">` (an HTML
 * deliverable says deck, poster or page there: deliverable.ts). Its prose is the content of its
 * first <article> element (else <main>, else <body>); the text before and after it is the document's
 * preamble and trailer, kept verbatim.
 *
 * Inside, the semantic HTML of prose maps to LyX paragraphs and insets:
 *  - <h1> → Title, <h2>…<h6> → Section … Subparagraph, <p> → Standard (class "byline" → Author,
 *    "date" → Date, "abstract" → Abstract), <ul>/<ol> → Itemize / Enumerate with depth,
 *    <blockquote> → Quote, <pre> → a listings inset, <hr> → a rule, a <figure> of images and a
 *    caption → a figure float (class "wide": a wide one), a simple <table> → a tabular;
 *  - inline: <em>/<i>, <strong>/<b>, <s>, <u>, <code>, <sub>/<sup>, <br>, links, images,
 *    `<span class="sidenote">` (or "footnote") → a footnote, `<span class="marginnote">` → a margin
 *    note; TeX as the runtime typesets it (`\(…\)`, `\[…\]`, `$$…$$`, display environments →
 *    formulas, `\cite{…}` → citations, `\ref{…}` / `\eqref{…}` → cross-references);
 *  - review as in markdown (md/parse.ts): `<!-- @comment … -->` threads, `<!-- … -->` notes,
 *    `<ins>` / `<del>` with author and datetime for tracked changes.
 * Sections, divs and other containers holding prose are transparent: their prose is the document's,
 * their tags stay where they are. Anything else — a widget, a canvas, an SVG, a script — is an HTML
 * block: a raw (ERT) inset holding its source, which the editor shows running (blockKey).
 *
 * Saving writes into the file's own text (writeArticlePreserving): a block whose HTML did not change
 * keeps its bytes, an edited one keeps its own start tag (classes, ids), and the markup between
 * blocks — container tags, comments, indentation — is never touched.
 */
import { parse } from 'parse5';
import type { Change, FontState, Inset, Item, LyxDocument, Paragraph, TabularInset, TextInset } from '../lyx/ast.ts';
import { addAuthor, getAuthors, itemText, lyxAuthorId, paramMap, unquote, FONT_KEYS } from '../lyx/ast.ts';
import { align } from '../lyx/merge.ts';
import { markdownHeader } from '../md/common.ts';
import { noteInset, normalize } from '../md/parse.ts';
import { htmlComment, noteLines } from '../md/write.ts';
import { faceFromCss, faceValue, parseFace, faceSpan } from '../fontface.ts';
import { CITE_SRC } from './refs.ts';
import { attr, elementChildren, hasClass, htmlElement, isElement, walk, type HDocument, type HElement, type HNode } from './source.ts';
import { articleHead } from './articletheme.ts';

/* ------------------------------------------------------------------ what an article is */

/** Is this HTML text an article (`<meta name="overlyx" content="article">` before its <body>)? */
export function isArticleHtml(text: string): boolean {
  const head = text.slice(0, 65536);
  const body = head.search(/<body[\s>]/i);
  for (const m of (body >= 0 ? head.slice(0, body) : head).matchAll(/<meta\b[^>]*>/gi)) {
    const a = tagAttrs(m[0]);
    if ((a.name ?? '').toLowerCase() === 'overlyx' && /^\s*article\b/i.test(a.content ?? '')) return true;
  }
  return false;
}

const ATTR_RE = /([a-zA-Z_:][-a-zA-Z0-9_:.]*)\s*=\s*("([^"]*)"|'([^']*)'|[^\s"'=<>`]+)/g;
function tagAttrs(tag: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const m of tag.matchAll(ATTR_RE)) out[m[1].toLowerCase()] = m[3] ?? m[4] ?? m[2];
  return out;
}

/** The paragraph layouts an article writes as its own elements (others are written as the closest of these). */
export const ARTICLE_LAYOUTS = ['Standard', 'Title', 'Author', 'Date', 'Abstract', 'Section', 'Subsection', 'Subsubsection', 'Paragraph', 'Subparagraph', 'Itemize', 'Enumerate', 'Quote'];

const HEADING_OF_TAG: Record<string, string> = { h1: 'Title', h2: 'Section', h3: 'Subsection', h4: 'Subsubsection', h5: 'Paragraph', h6: 'Subparagraph' };
const TAG_OF_HEADING: Record<string, string> = Object.fromEntries(Object.entries(HEADING_OF_TAG).map(([t, l]) => [l, t]));
const CLASS_OF_LAYOUT: Record<string, string> = { Author: 'byline', Date: 'date', Abstract: 'abstract' };

/** a layout an article cannot write → the one it is written as */
export function articleLayoutFor(layout: string): string {
  if (ARTICLE_LAYOUTS.includes(layout)) return layout;
  const plain = layout.replace(/\*$/, '');
  if (TAG_OF_HEADING[plain]) return plain;
  if (plain === 'Part' || plain === 'Chapter') return 'Section';
  if (layout === 'Quotation' || layout === 'Verse') return 'Quote';
  if (layout === 'Description' || layout === 'Labeling' || layout === 'List') return 'Itemize';
  return 'Standard';
}

/**
 * A key for an HTML block's source (its raw inset's lines joined by newlines): the editor names the
 * block it wants shown running by it, and the server finds that block in the page's text (FNV-1a).
 */
export function blockKey(source: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < source.length; i++) { h ^= source.charCodeAt(i); h = Math.imul(h, 0x01000193); }
  return (h >>> 0).toString(36) + source.length.toString(36);
}

/** the source of an HTML block: a raw inset's lines */
export const rawSource = (ins: TextInset): string => ins.paragraphs.map(p => p.items.map(itemText).join('')).join('\n');

/** a paragraph that is an HTML block (a raw inset alone in it), or null */
export function htmlBlockOf(par: Paragraph): TextInset | null {
  const items = par.items.filter(i => !(i.kind === 'text' && !i.text.trim()));
  if (items.length !== 1 || items[0].kind !== 'inset') return null;
  const ins = items[0].inset;
  return ins.type === 'Text' && ins.name === 'ERT' ? ins : null;
}

/* ------------------------------------------------------------------ parsing */

export interface ArticleUnit {
  /** the block's source range (an element, or a run of loose inline content) */
  start: number;
  end: number;
  /** its element's tag ('' for loose inline content) */
  tag: string;
  /** its start and end tags' ranges (absent: not in the source) */
  open?: { start: number; end: number };
  close?: { start: number; end: number };
}

export interface ParseArticleResult {
  doc: LyxDocument;
  /** the blocks of the source the paragraphs come from, in order */
  units: ArticleUnit[];
  /** for each body paragraph: the unit it came from (-1: none) */
  parUnit: number[];
  /** for each body paragraph: its character range in the source */
  parSpans: ({ start: number; end: number } | null)[];
  /** the article's content in the text (between its start and end tags) */
  region: { start: number; end: number };
  warnings: string[];
}

type Loc = { startOffset: number; endOffset: number; startTag?: { startOffset: number; endOffset: number }; endTag?: { startOffset: number; endOffset: number } };
type TextNode = { nodeName: '#text'; value: string; sourceCodeLocation?: Loc | null };
type CommentNode = { nodeName: '#comment'; data: string; sourceCodeLocation?: Loc | null };
const isText = (n: HNode): n is HNode & TextNode => n.nodeName === '#text';
const isComment = (n: HNode): n is HNode & CommentNode => n.nodeName === '#comment';
const locOf = (n: HNode): Loc | null => ((n as { sourceCodeLocation?: Loc | null }).sourceCodeLocation ?? null);
const blank = (n: HNode) => isText(n) && !/[^ \t\n\r\f]/.test(n.value);

/** the element prose lives in: the first <article>, else the first <main>, else <body> */
function articleRoot(doc: HDocument): HElement | null {
  const html = htmlElement(doc);
  const body = html ? elementChildren(html).find(e => e.tagName === 'body') ?? null : null;
  if (!body) return null;
  let main: HElement | null = null;
  for (const el of walk(body)) {
    if (el.tagName === 'article') return el;
    if (!main && el.tagName === 'main') main = el;
  }
  return main ?? body;
}

/** text-level elements: they continue a run of inline content (a loose paragraph) */
const RUN_TAGS = new Set(['a', 'abbr', 'b', 'bdi', 'bdo', 'br', 'cite', 'code', 'data', 'dfn', 'em', 'i', 'kbd', 'mark', 'q', 's', 'samp', 'small', 'span', 'strong', 'sub', 'sup', 'time', 'u', 'var', 'wbr', 'del', 'ins', 'img', 'label', 'strike', 'tt', 'font']);
/** containers whose prose is the document's (unless they hold a widget of their own) */
const CONTAINERS = new Set(['section', 'div', 'header', 'footer', 'main', 'article', 'aside', 'hgroup', 'nav', 'address', 'center']);
/** a container with one of these as a child is a widget: shown running, kept whole */
const WIDGET_TAGS = new Set(['script', 'canvas', 'svg', 'iframe', 'video', 'audio', 'object', 'embed', 'input', 'button', 'select', 'textarea', 'form', 'template', 'slot', 'noscript', 'math', 'map', 'output', 'progress', 'meter']);
const PROSE_TAGS = new Set(['p', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'ul', 'ol', 'blockquote', 'pre', 'figure', 'table', 'dl']);
/** inline elements kept whole as raw HTML (their content is no text of the document's) */
const WHOLE_INLINE = new Set([...WIDGET_TAGS, 'picture', 'ruby', 'wbr', 'img', 'br']);

function hasProse(el: HElement): boolean {
  for (const c of el.childNodes as HNode[]) {
    if (isText(c)) { if (/[^ \t\n\r\f]/.test(c.value)) return true; continue; }
    if (!isElement(c)) continue;
    if (WIDGET_TAGS.has(c.tagName) || c.tagName.includes('-')) continue;
    if (PROSE_TAGS.has(c.tagName) || RUN_TAGS.has(c.tagName)) return true;
    if (CONTAINERS.has(c.tagName) && hasProse(c)) return true;
  }
  return false;
}

/** a container whose children are blocks of the document (it is not a widget, and it holds prose) */
function transparent(el: HElement): boolean {
  if (!CONTAINERS.has(el.tagName)) return false;
  if (el.attrs.some(a => /^on/i.test(a.name) || a.name === 'contenteditable')) return false;
  for (const c of el.childNodes as HNode[]) if (isElement(c) && (WIDGET_TAGS.has(c.tagName) || c.tagName.includes('-'))) return false;
  return hasProse(el);
}

const isRunNode = (n: HNode) => !isElement(n) || RUN_TAGS.has(n.tagName);

const LINE_RE = /\r?\n/;
const plainPar = (text: string, layout = 'Plain Layout'): Paragraph => ({ layout, depth: 0, params: {}, items: text ? [{ kind: 'text', text, font: {} }] : [] });
/** raw HTML: an ERT inset of its lines */
const raw = (text: string): TextInset => ({ type: 'Text', name: 'ERT', arg: '', params: [], status: 'collapsed', paragraphs: text.split(LINE_RE).map(l => plainPar(l)) });
const RULE: Inset = { type: 'Leaf', name: 'CommandInset', arg: 'line', params: ['LatexCommand rule', 'width "100text%"', 'height "0.4pt"'] };
const newlineInset = (): Inset => ({ type: 'Leaf', name: 'Newline', arg: 'newline', params: [] });
const q = (s: string) => '"' + s.replace(/\\/g, '\\\\').replace(/"/g, '\\"') + '"';

const DISPLAY_ENVS = 'equation|align|gather|multline|eqnarray|flalign|alignat';
/** TeX in text: 1 `\(…\)`, 2 `\[…\]`, 3 `$$…$$`, 4–6 a display environment, a citation (7–10), 11–12 a cross-reference */
const TEX_RE = new RegExp(String.raw`\\\(([\s\S]*?)\\\)|\\\[([\s\S]*?)\\\]|\$\$([\s\S]*?)\$\$|(\\begin\{(${DISPLAY_ENVS})(\*?)\}[\s\S]*?\\end\{\5\6\})|` + CITE_SRC + String.raw`|\\(ref|eqref|autoref|cref|Cref|pageref)\{([^}]*)\}`, 'g');

interface Ctx { depth: number; quote: boolean; base: string }
interface InlineState { fonts: { key: keyof FontState; value: string }[]; change?: Change; literal: boolean }

class Converter {
  pars: Paragraph[] = [];
  parUnit: number[] = [];
  parSpans: ({ start: number; end: number } | null)[] = [];
  units: ArticleUnit[] = [];
  warnings: string[] = [];
  authors = new Map<string, number>();
  cur = -1;
  constructor(private text: string) {}

  par(layout: string, depth: number, items: Item[], span: { start: number; end: number } | null, params: Paragraph['params'] = {}): void {
    this.pars.push({ layout, depth, params, items });
    this.parUnit.push(this.cur);
    this.parSpans.push(span);
  }

  insetPar(ctx: Ctx, inset: Inset, span: { start: number; end: number } | null, params: Paragraph['params'] = {}): void {
    this.par(ctx.quote ? 'Quote' : ctx.base, ctx.depth, [{ kind: 'inset', inset, font: {} }], span, params);
  }

  span(n: HNode): { start: number; end: number } | null {
    const l = locOf(n);
    return l ? { start: l.startOffset, end: l.endOffset } : null;
  }

  /** a run of inline nodes' range without the white space around it */
  runSpan(nodes: HNode[]): { start: number; end: number } | null {
    const first = locOf(nodes[0]), last = locOf(nodes[nodes.length - 1]);
    if (!first || !last) return null;
    let start = first.startOffset, end = last.endOffset;
    while (start < end && /\s/.test(this.text[start])) start++;
    while (end > start && /\s/.test(this.text[end - 1])) end--;
    return { start, end };
  }

  /** the blocks of the article (or of a transparent container in it): each is a unit */
  flow(nodes: HNode[]): void {
    let run: HNode[] = [];
    const flush = () => {
      const content = run.filter(n => !blank(n));
      if (content.length && !content.every(isComment)) this.looseRun(run);
      run = [];
    };
    for (const n of nodes) {
      if (isElement(n) && !RUN_TAGS.has(n.tagName)) { flush(); this.flowBlock(n); continue; }
      // a comment between blocks stays in the markup between them
      if (isComment(n) && run.every(blank)) { run = []; continue; }
      run.push(n);
    }
    flush();
  }

  flowBlock(el: HElement): void {
    const loc = locOf(el);
    if (transparent(el) || !loc) { this.flow(el.childNodes as HNode[]); return; }
    // an empty container (what is left of one whose text was deleted) stays in the markup — unless a
    // script may fill it (it has an id) or the runtime does (the list of references)
    if (CONTAINERS.has(el.tagName) && (el.childNodes as HNode[]).every(blank) && !attr(el, 'id') && !hasClass(el, 'ol-bibliography')) return;
    this.units.push({
      start: loc.startOffset, end: loc.endOffset, tag: el.tagName,
      open: loc.startTag ? { start: loc.startTag.startOffset, end: loc.startTag.endOffset } : undefined,
      close: loc.endTag ? { start: loc.endTag.startOffset, end: loc.endTag.endOffset } : undefined,
    });
    this.cur = this.units.length - 1;
    this.block(el, { depth: 0, quote: false, base: 'Standard' });
  }

  looseRun(nodes: HNode[]): void {
    const span = this.runSpan(nodes);
    const items = this.inline(nodes);
    if (!items.length || !span) return;
    this.units.push({ start: span.start, end: span.end, tag: '' });
    this.cur = this.units.length - 1;
    this.par('Standard', 0, items, span);
  }

  /** blocks inside a unit (a list item's, a quote's): no units of their own */
  nested(nodes: HNode[], ctx: Ctx): void {
    let run: HNode[] = [];
    const flush = () => {
      if (run.some(n => !blank(n) && !isComment(n))) {
        const items = this.inline(run);
        if (items.length) this.par(ctx.quote ? 'Quote' : ctx.base, ctx.depth, items, this.runSpan(run));
      }
      run = [];
    };
    for (const n of nodes) {
      if (isElement(n) && !isRunNode(n)) { flush(); this.block(n, ctx); continue; }
      if (isComment(n) && run.every(blank)) { run = []; continue; }
      run.push(n);
    }
    flush();
  }

  block(el: HElement, ctx: Ctx): void {
    const tag = el.tagName;
    const span = this.span(el);
    const kids = el.childNodes as HNode[];
    if (HEADING_OF_TAG[tag]) { this.par(ctx.quote ? 'Quote' : HEADING_OF_TAG[tag], ctx.depth, this.inline(kids), span); return; }
    switch (tag) {
      case 'p': {
        const layout = ctx.quote ? 'Quote' : ctx.base !== 'Standard' ? ctx.base : hasClass(el, 'byline') || hasClass(el, 'author') ? 'Author' : hasClass(el, 'date') ? 'Date' : hasClass(el, 'abstract') ? 'Abstract' : 'Standard';
        this.par(layout, ctx.depth, this.inline(kids), span);
        return;
      }
      case 'ul': case 'ol': this.list(el, ctx); return;
      case 'blockquote': this.nested(kids, { ...ctx, quote: true }); return;
      case 'pre': this.insetPar(ctx, this.pre(el), span); return;
      case 'hr': this.insetPar(ctx, RULE, span, { noindent: true }); return;
      case 'figure': { const f = this.figure(el); if (f) { this.insetPar(ctx, f, span); return; } break; }
      case 'table': { const t = this.table(el); if (t) { this.insetPar(ctx, t, span); return; } break; }
    }
    if (transparent(el)) { this.nested(kids, ctx); return; }
    const loc = locOf(el);
    if (loc) this.insetPar(ctx, raw(this.text.slice(loc.startOffset, loc.endOffset)), span);
  }

  list(el: HElement, ctx: Ctx): void {
    const layout = el.tagName === 'ol' ? 'Enumerate' : 'Itemize';
    // a list inside a quote nests under a Quote paragraph
    if (ctx.quote) {
      const last = this.pars[this.pars.length - 1];
      if (!last || last.layout !== 'Quote' || last.depth !== ctx.depth) this.par('Quote', ctx.depth, [], null);
      ctx = { ...ctx, depth: ctx.depth + 1, quote: false };
    }
    for (const li of el.childNodes as HNode[]) {
      if (!isElement(li)) continue;
      if (li.tagName !== 'li') { this.block(li, ctx); continue; }
      const kids = li.childNodes as HNode[];
      // the item's own text: its inline content before its first block, else its first <p>
      let i = 0;
      while (i < kids.length && isRunNode(kids[i])) i++;
      let items = this.inline(kids.slice(0, i));
      const first = kids[i];
      if (!items.length && first && isElement(first) && first.tagName === 'p') { items = this.inline(first.childNodes as HNode[]); i++; }
      this.par(layout, ctx.depth, items, this.span(li));
      this.nested(kids.slice(i), { depth: ctx.depth + 1, quote: false, base: 'Standard' });
    }
  }

  pre(el: HElement): TextInset {
    const kids = (el.childNodes as HNode[]).filter(n => !blank(n));
    const code = kids.length === 1 && isElement(kids[0]) && kids[0].tagName === 'code' ? kids[0] : null;
    const cls = `${attr(el, 'class') ?? ''} ${code ? attr(code, 'class') ?? '' : ''}`;
    const lang = /(?:^|\s)(?:language|lang)-([^\s"]+)/.exec(cls)?.[1] ?? '';
    const content = textContent(code ?? el).replace(/^\r?\n/, '').replace(/\r?\n$/, '');
    return { type: 'Text', name: 'listings', arg: '', params: [`lstparams "${lang ? 'language=' + lang.replace(/"/g, '') : ''}"`, 'inline false'], status: 'open', paragraphs: content.split(LINE_RE).map(l => plainPar(l)) };
  }

  image(el: HElement): Inset {
    const params = [`\tfilename ${attr(el, 'src') ?? ''}`];
    const alt = attr(el, 'alt');
    if (alt) params.push(`\tspecial alt={${alt.replace(/[{}]/g, '')}}`);
    const w = /(?:^|;)\s*width\s*:\s*([\d.]+)%/i.exec(attr(el, 'style') ?? '')?.[1];
    if (w) params.push(`\twidth ${w}text%`);
    return { type: 'Leaf', name: 'Graphics', arg: '', params };
  }

  /** a figure of images and a caption (anything else in it: an HTML block) */
  figure(el: HElement): Inset | null {
    const imgs: HElement[] = [];
    let caption: HElement | null = null;
    for (const c of el.childNodes as HNode[]) {
      if (isText(c)) { if (!blank(c)) return null; continue; }
      if (!isElement(c)) continue;
      if (c.tagName === 'img') imgs.push(c);
      else if (c.tagName === 'figcaption' && !caption && !(c.childNodes as HNode[]).some(k => isElement(k) && !isRunNode(k))) caption = c;
      else return null;
    }
    if (!imgs.length) return null;
    const paragraphs: Paragraph[] = [{ layout: 'Plain Layout', depth: 0, params: { align: 'center' }, items: imgs.map(i => ({ kind: 'inset', inset: this.image(i), font: {} }) as Item) }];
    if (caption) paragraphs.push({ layout: 'Plain Layout', depth: 0, params: {}, items: [{ kind: 'inset', font: {}, inset: { type: 'Text', name: 'Caption', arg: 'Standard', params: [], paragraphs: [{ layout: 'Plain Layout', depth: 0, params: {}, items: this.inline(caption.childNodes as HNode[]) }] } }] });
    const wide = hasClass(el, 'wide') || hasClass(el, 'full') || hasClass(el, 'fullwidth');
    return { type: 'Text', name: 'Float', arg: 'figure', params: [`wide ${wide}`, 'sideways false'], status: 'open', paragraphs };
  }

  /** a table without merged cells or blocks in its cells (else an HTML block) */
  table(el: HElement): TabularInset | null {
    const rows: HElement[] = [];
    for (const c of elementChildren(el)) {
      if (c.tagName === 'tr') rows.push(c);
      else if (c.tagName === 'thead' || c.tagName === 'tbody' || c.tagName === 'tfoot') rows.push(...elementChildren(c).filter(r => r.tagName === 'tr'));
      else if (c.tagName !== 'colgroup') return null;
    }
    if (!rows.length) return null;
    const cells = rows.map(r => elementChildren(r).filter(c => c.tagName === 'td' || c.tagName === 'th'));
    for (const r of cells) for (const c of r) {
      if (Number(attr(c, 'rowspan') ?? 1) > 1 || Number(attr(c, 'colspan') ?? 1) > 1) return null;
      if ((c.childNodes as HNode[]).some(k => isElement(k) && !isRunNode(k) && k.tagName !== 'p')) return null;
    }
    const ncols = Math.max(1, ...cells.map(r => r.length));
    const alignOf = (c: HElement | undefined): string => {
      const m = /text-align:\s*(left|right|center)/i.exec(c ? attr(c, 'style') ?? '' : '') ?? /^(left|right|center)$/i.exec(c ? attr(c, 'align') ?? '' : '');
      return m ? m[1].toLowerCase() : 'left';
    };
    const header = cells[0];
    const headRow = header.length > 0 && header.every(c => c.tagName === 'th');
    const columns = Array.from({ length: ncols }, (_, c) => ({ attrs: [['alignment', alignOf(header[c])], ['valignment', 'top']] as [string, string][] }));
    const out = cells.map((r, ri) => ({
      attrs: [...(ri === 0 && headRow ? [['endhead', 'true']] : []), ...(ri === 0 ? [['topline', 'true']] : []), ...(ri === 0 && headRow ? [['bottomline', 'true']] : []), ...(ri === cells.length - 1 ? [['bottomline', 'true']] : [])] as [string, string][],
      cells: Array.from({ length: ncols }, (_, c) => {
        const cell = r[c];
        const lines: [string, string][] = ri === 0 ? [['topline', 'true'], ...(headRow ? [['bottomline', 'true']] as [string, string][] : [])] : ri === cells.length - 1 ? [['bottomline', 'true']] : [];
        const kids = cell ? (cell.childNodes as HNode[]) : [];
        const ps = kids.filter(k => isElement(k) && k.tagName === 'p') as HElement[];
        const paragraphs: Paragraph[] = ps.length ? ps.map(p => ({ layout: 'Plain Layout', depth: 0, params: {}, items: this.inline(p.childNodes as HNode[]) })) : [{ layout: 'Plain Layout', depth: 0, params: {}, items: this.inline(kids) }];
        return { attrs: [['alignment', alignOf(header[c])], ['valignment', 'top'], ...lines, ['usebox', 'none']] as [string, string][], paragraphs };
      }),
    }));
    return { type: 'Tabular', attrs: [['version', '3'], ['rows', String(out.length)], ['columns', String(ncols)]], features: [['tabularvalignment', 'middle']], columns, rows: out };
  }

  /* -------------------------------------------------------------- inline */

  inline(nodes: HNode[]): Item[] {
    const items: Item[] = [];
    this.inlineInto(nodes, items, { fonts: [], literal: false });
    return collapse(normalize(items));
  }

  font(st: InlineState): FontState {
    const f: Record<string, string> = {};
    for (const k of FONT_KEYS) for (let i = st.fonts.length - 1; i >= 0; i--) if (st.fonts[i].key === k) { f[k] = st.fonts[i].value; break; }
    return f as FontState;
  }

  add(items: Item[], it: Item, st: InlineState): void {
    if (st.change) it.change = { ...st.change };
    items.push(it);
  }

  inlineInto(nodes: HNode[], items: Item[], st: InlineState): void {
    for (const n of nodes) {
      if (isText(n)) { this.textInto(n.value, items, st); continue; }
      if (isComment(n)) {
        const note = noteInset(`<!--${n.data}-->`, 'Plain Layout');
        if (note) this.add(items, { kind: 'inset', inset: note, font: {} }, st);
        continue;
      }
      if (isElement(n)) this.elementInto(n, items, st);
    }
  }

  withFont(el: HElement, key: keyof FontState, value: string, items: Item[], st: InlineState): void {
    st.fonts.push({ key, value });
    this.inlineInto(el.childNodes as HNode[], items, key === 'family' && value === 'typewriter' ? { ...st, literal: true } : st);
    st.fonts.pop();
  }

  /** an element kept as its source (a whole one, or its start and end tags around its content) */
  rawInto(el: HElement, items: Item[], st: InlineState): void {
    const loc = locOf(el);
    if (!loc) { this.inlineInto(el.childNodes as HNode[], items, st); return; }
    if (!loc.startTag || !loc.endTag || WHOLE_INLINE.has(el.tagName) || el.tagName.includes('-')) {
      this.add(items, { kind: 'inset', inset: raw(this.text.slice(loc.startOffset, loc.endOffset)), font: this.font(st) }, st);
      return;
    }
    this.add(items, { kind: 'inset', inset: raw(this.text.slice(loc.startTag.startOffset, loc.startTag.endOffset)), font: this.font(st) }, st);
    this.inlineInto(el.childNodes as HNode[], items, st);
    this.add(items, { kind: 'inset', inset: raw(this.text.slice(loc.endTag.startOffset, loc.endTag.endOffset)), font: this.font(st) }, st);
  }

  elementInto(el: HElement, items: Item[], st: InlineState): void {
    const tag = el.tagName;
    const kids = el.childNodes as HNode[];
    switch (tag) {
      case 'em': case 'i': this.withFont(el, 'emph', 'on', items, st); return;
      case 'strong': case 'b': this.withFont(el, 'series', 'bold', items, st); return;
      case 's': case 'strike': this.withFont(el, 'strikeout', 'on', items, st); return;
      case 'u': this.withFont(el, 'bar', 'under', items, st); return;
      case 'code': case 'tt': if (!el.attrs.length) { this.withFont(el, 'family', 'typewriter', items, st); return; } break;
      case 'br': this.add(items, { kind: 'inset', inset: newlineInset(), font: this.font(st) }, st); return;
      case 'img': this.add(items, { kind: 'inset', inset: this.image(el), font: {} }, st); return;
      case 'sub': case 'sup': {
        if (el.attrs.length) break;
        const outer = this.font(st);
        const inner: Item[] = [];
        this.inlineInto(kids, inner, { ...st, fonts: [] });
        this.add(items, { kind: 'inset', font: outer, inset: { type: 'Text', name: 'script', arg: tag === 'sub' ? 'subscript' : 'superscript', params: [], status: 'open', paragraphs: [{ layout: 'Plain Layout', depth: 0, params: {}, items: collapse(normalize(inner)) }] } }, st);
        return;
      }
      case 'a': {
        const href = attr(el, 'href');
        if (href === null || el.attrs.some(a => !['href', 'title'].includes(a.name)) || kids.some(k => isElement(k) && k.tagName === 'img')) break;
        const name = textContent(el).replace(/[ \t\n\r\f]+/g, ' ').trim();
        const title = attr(el, 'title');
        const auto = name === href;
        const params = ['LatexCommand href', `name ${q(auto ? '' : name)}`, `target ${q(href)}`];
        if (title) params.push(`title ${q(title)}`);
        params.push('literal "true"');
        const inner: Item[] = [];
        this.inlineInto(kids, inner, st);
        const font = inner.find(i => i.kind === 'text')?.font ?? this.font(st);
        this.add(items, { kind: 'inset', inset: { type: 'Leaf', name: 'CommandInset', arg: 'href', params }, font }, st);
        return;
      }
      case 'ins': case 'del': {
        if (!el.attrs.some(a => a.name === 'author' || a.name === 'datetime')) {
          if (tag === 'del' && !el.attrs.length) { this.withFont(el, 'strikeout', 'on', items, st); return; }
          break;
        }
        const author = attr(el, 'author') || 'Unknown';
        const id = lyxAuthorId(author, '');
        this.authors.set(author, id);
        const t = attr(el, 'datetime');
        const time = t ? Math.floor(Date.parse(t) / 1000) : 0;
        const saved = st.change;
        st.change = { type: tag === 'ins' ? 'inserted' : 'deleted', author: id, time: Number.isFinite(time) ? time : 0 };
        this.inlineInto(kids, items, st);
        st.change = saved;
        return;
      }
      case 'span': {
        const cls = (attr(el, 'class') ?? '').split(/\s+/);
        const others = el.attrs.filter(a => a.name !== 'class');
        if (!others.length && (cls.includes('sidenote') || cls.includes('footnote') || cls.includes('marginnote')) && cls.length === 1) {
          const inner: Item[] = [];
          this.inlineInto(kids, inner, { ...st, fonts: [], change: undefined });
          const margin = cls[0] === 'marginnote';
          const params = margin || cls[0] === 'sidenote' ? [] : [`class ${q(cls[0])}`];
          this.add(items, { kind: 'inset', font: {}, inset: { type: 'Text', name: margin ? 'Marginal' : 'Foot', arg: '', params, status: 'collapsed', paragraphs: [{ layout: 'Plain Layout', depth: 0, params: {}, items: collapse(normalize(inner)) }] } }, st);
          return;
        }
        if (!others.length && cls.length === 1 && cls[0] === 'ol-notex') { this.inlineInto(kids, items, { ...st, literal: true }); return; }
        if (el.attrs.length === 1 && el.attrs[0].name === 'style') {
          const face = faceFromCss(el.attrs[0].value);
          if (face) { this.withFont(el, 'face', faceValue(face), items, st); return; }
        }
        break;
      }
    }
    this.rawInto(el, items, st);
  }

  /** text with the TeX the runtime typesets in it: formulas, citations, cross-references */
  textInto(value: string, items: Item[], st: InlineState): void {
    const addText = (s: string) => { if (s) this.add(items, { kind: 'text', text: s.replace(/[ \t\n\r\f]+/g, ' '), font: this.font(st) }, st); };
    if (st.literal) { addText(value); return; }
    let last = 0;
    for (const m of value.matchAll(TEX_RE)) {
      addText(value.slice(last, m.index));
      last = m.index! + m[0].length;
      let inset: Inset;
      if (m[1] !== undefined) inset = { type: 'Formula', inline: true, latex: '$' + m[1].trim() + '$' };
      else if (m[2] !== undefined) inset = { type: 'Formula', inline: false, latex: '\\[' + m[2].trim() + '\\]' };
      else if (m[3] !== undefined) inset = { type: 'Formula', inline: false, latex: '\\[' + m[3].trim() + '\\]' };
      else if (m[4] !== undefined) inset = { type: 'Formula', inline: false, latex: m[4].trim() };
      else if (m[7] !== undefined) {
        // natbib: one optional argument is the note after, two are before and after
        const two = m[9] !== undefined;
        const before = two ? m[8] ?? '' : '', after = two ? m[9] ?? '' : m[8] ?? '';
        const cmd = m[7] + (m[0].startsWith('\\' + m[7] + '*') ? '*' : '');
        const params = [`LatexCommand ${cmd}`];
        if (after) params.push(`after ${q(after)}`);
        if (before) params.push(`before ${q(before)}`);
        params.push(`key ${q(m[10].split(',').map(k => k.trim()).filter(Boolean).join(','))}`, 'literal "true"');
        inset = { type: 'Leaf', name: 'CommandInset', arg: 'citation', params };
      } else {
        inset = { type: 'Leaf', name: 'CommandInset', arg: 'ref', params: [`LatexCommand ${m[11]}`, `reference ${q(m[12])}`, 'plural "false"', 'caps "false"', 'noprefix "false"', 'nolink "false"'] };
      }
      this.add(items, { kind: 'inset', inset, font: this.font(st) }, st);
    }
    addText(value.slice(last));
  }
}

/** an element's text (all its descendants', entities decoded) */
function textContent(el: HElement): string {
  let out = '';
  for (const c of el.childNodes as HNode[]) {
    if (isText(c)) out += c.value;
    else if (isElement(c)) out += c.tagName === 'br' ? '\n' : textContent(c);
  }
  return out;
}

const isBreak = (it: Item | undefined) => it?.kind === 'inset' && it.inset.type === 'Leaf' && it.inset.name === 'Newline';

/** white space as a browser shows it: none at the ends, after a line break or after a space; one between words */
function collapse(items: Item[]): Item[] {
  const out: Item[] = [];
  let space = true;   // at the start, a space is dropped
  for (const it of items) {
    if (it.kind !== 'text') {
      out.push(it);
      if (isBreak(it)) { space = true; const prev = out[out.length - 2]; if (prev?.kind === 'text') prev.text = prev.text.replace(/ +$/, ''); }
      else if (!(it.kind === 'inset' && it.inset.type === 'Text' && it.inset.name === 'Note')) space = false;
      continue;
    }
    let t = it.text;
    if (space) t = t.replace(/^ +/, '');
    if (!t) continue;
    space = t.endsWith(' ');
    out.push({ ...it, text: t });
  }
  for (let i = out.length - 1; i >= 0; i--) {
    const it = out[i];
    if (it.kind !== 'text') { if (isBreak(it)) continue; break; }
    it.text = it.text.replace(/ +$/, '');
    if (!it.text) { out.splice(i, 1); continue; }
    break;
  }
  return out.filter(i => i.kind !== 'text' || i.text);
}

/** The header of every article: the article class without section numbers, paragraphs spaced as on the web. */
export const articleHeader = markdownHeader;

export function parseArticle(text: string): ParseArticleResult {
  const doc = parse(text, { sourceCodeLocationInfo: true, scriptingEnabled: false }) as unknown as HDocument;
  const root = articleRoot(doc);
  const conv = new Converter(text);
  let region = { start: text.length, end: text.length };
  if (root) {
    const loc = locOf(root);
    const kids = root.childNodes as HNode[];
    const firstLoc = kids.map(locOf).find(Boolean), lastLoc = [...kids].reverse().map(locOf).find(Boolean);
    const start = loc?.startTag?.endOffset ?? firstLoc?.startOffset ?? text.length;
    const end = loc?.endTag?.startOffset ?? lastLoc?.endOffset ?? start;
    region = { start, end: Math.max(start, end) };
    conv.flow(kids);
  }
  if (!conv.pars.length) { conv.cur = -1; conv.par('Standard', 0, [], null); }
  const header = articleHeader();
  for (const [name, id] of conv.authors) addAuthor(header, id, name, '');
  return {
    doc: { preamble: text.slice(0, region.start).split('\n'), format: 643, header, body: conv.pars, trailer: text.slice(region.end).split('\n') },
    units: conv.units, parUnit: conv.parUnit, parSpans: conv.parSpans, region, warnings: conv.warnings,
  };
}

/* ------------------------------------------------------------------ writing */

export interface WriteArticleResult {
  text: string;
  /** for every body paragraph: its character range in `text` */
  spans: ({ start: number; end: number } | null)[];
  warnings: string[];
}

interface W { authors: Map<number, string>; warnings: Set<string> }

/**
 * A line break inside one element's HTML (a comment's lines, code, raw HTML): written as a newline,
 * but never indented with the structure around it (that would change code, and grow every time).
 */
const NL = String.fromCharCode(0);
const oneLine = (s: string) => s.replace(/\n/g, NL);
const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/ /g, '&nbsp;');
const escAttr = (s: string) => s.replace(/&/g, '&amp;').replace(/"/g, '&quot;');
/** what the runtime would take for TeX in a text: such text is written in a span it leaves alone */
const TEX_TRIGGER = new RegExp(String.raw`\\\(|\\\[|\$\$|\\begin\{|\\(?:ref|eqref|autoref|cref|Cref|pageref)\{|` + CITE_SRC.slice(0, CITE_SRC.indexOf('(?:')));
const iso = (t: number) => new Date(t * 1000).toISOString().replace(/\.\d{3}Z$/, 'Z');

/** the latex of a formula without its delimiters */
function formulaInner(latex: string): { inner: string; display: boolean; env: boolean } {
  const t = latex.trim();
  let m = /^\$\$([\s\S]*)\$\$$/.exec(t);
  if (m) return { inner: m[1].trim(), display: true, env: false };
  m = /^\$([\s\S]*)\$$/.exec(t);
  if (m) return { inner: m[1].trim(), display: false, env: false };
  m = /^\\\(([\s\S]*)\\\)$/.exec(t);
  if (m) return { inner: m[1].trim(), display: false, env: false };
  m = /^\\\[([\s\S]*)\\\]$/.exec(t);
  if (m) return { inner: m[1].trim(), display: true, env: false };
  return { inner: t, display: true, env: /^\\begin\{/.test(t) };
}

function formulaHtml(latex: string): string {
  const f = formulaInner(latex);
  if (!f.inner) return '';
  if (f.env) return esc(f.inner);
  return f.display ? `\\[${esc(f.inner)}\\]` : `\\(${esc(f.inner)}\\)`;
}

const SPECIAL: Record<string, string> = { LaTeX: 'LaTeX', TeX: 'TeX', LaTeX2e: 'LaTeX2e', LyX: 'LyX', slash: '/', nobreakdash: '-', textcompwordmark: '', ligaturebreak: '', hyphenation: '' };

/** the marks of an item, outermost first: a tracked change, a font by name, then the font tags */
function marksOf(it: Item): string[] {
  const out: string[] = [];
  if (it.change) out.push(`change:${it.change.type}:${it.change.author}:${it.change.time}`);
  if (it.kind === 'inset' && it.inset.type === 'Text' && it.inset.name === 'Note') return out;
  const f = it.font;
  if (f.face && parseFace(f.face)) out.push('face:' + f.face);
  if (f.series === 'bold') out.push('strong');
  if (f.emph === 'on' || f.shape === 'italic' || f.shape === 'slanted') out.push('em');
  if (f.strikeout === 'on' || f.xout === 'on') out.push('s');
  if (f.bar === 'under' || f.uuline === 'on' || f.uwave === 'on') out.push('u');
  if (f.family === 'typewriter' && it.kind === 'text') out.push('code');
  return out;
}

function plainText(pars: Paragraph[]): string {
  return pars.map(p => p.items.map(itemText).join('')).join(' ');
}

function insetHtml(ins: Inset, w: W, font: FontState): string {
  switch (ins.type) {
    case 'Formula': return formulaHtml(ins.latex);
    case 'Leaf': {
      const pm = paramMap(ins.params);
      switch (ins.name) {
        case 'Newline': return '<br>';
        case 'Quotes': return ins.arg[2] === 's' ? (ins.arg[1] === 'l' ? '‘' : '’') : (ins.arg[1] === 'l' ? '“' : '”');
        case 'space': return ins.params.some(p => p.includes('~')) || ins.arg.includes('~') ? '&nbsp;' : ' ';
        case 'Graphics': {
          const src = (pm.get('filename') ?? '').trim();
          const alt = /alt=\{([^}]*)\}/.exec(pm.get('special') ?? '')?.[1] ?? '';
          const width = /^([\d.]+)(?:text|col|line|page)%$/.exec((pm.get('width') ?? '').trim())?.[1];
          return `<img src="${escAttr(src)}" alt="${escAttr(alt)}"${width ? ` style="width: ${width}%"` : ''}>`;
        }
        case 'CommandInset': {
          switch (ins.arg) {
            case 'href': {
              const target = unquote(pm.get('target'));
              const type = unquote(pm.get('type'));
              const href = type === 'mailto:' && !target.startsWith('mailto:') ? 'mailto:' + target : target;
              const title = unquote(pm.get('title'));
              const name = unquote(pm.get('name')) || href;
              const shown = font.family === 'typewriter' ? `<code>${esc(name)}</code>` : esc(name);
              return `<a href="${escAttr(href)}"${title ? ` title="${escAttr(title)}"` : ''}>${shown}</a>`;
            }
            case 'citation': {
              const cmd = (pm.get('LatexCommand') ?? 'cite').trim();
              const before = unquote(pm.get('before')), after = unquote(pm.get('after'));
              const opt = before ? `[${before}][${after}]` : after ? `[${after}]` : '';
              return esc(`\\${cmd}${opt}{${unquote(pm.get('key'))}}`);
            }
            case 'ref': return esc(`\\${(pm.get('LatexCommand') ?? 'ref').trim()}{${unquote(pm.get('reference'))}}`);
            case 'label': return `<a id="${escAttr(unquote(pm.get('name')))}"></a>`;
            case 'line': return '<hr>';
            default: w.warnings.add(`${ins.arg} insets are not kept in an HTML article`); return '';
          }
        }
        default: return '';
      }
    }
    case 'Text': return textInsetHtml(ins, w);
    case 'Tabular': return tableLines(ins, w).join(NL);
    default: return '';
  }
}

function textInsetHtml(ins: TextInset, w: W): string {
  const pm = paramMap(ins.params);
  switch (ins.name) {
    case 'Note': return htmlComment(ins.arg, noteLines(ins.paragraphs), false);
    case 'Foot': return `<span class="${escAttr(unquote(pm.get('class')) || 'sidenote')}">${inlineHtml(flatItems(ins.paragraphs), w)}</span>`;
    case 'Marginal': return `<span class="marginnote">${inlineHtml(flatItems(ins.paragraphs), w)}</span>`;
    case 'ERT': return rawSource(ins);
    case 'script': { const tag = ins.arg === 'subscript' ? 'sub' : 'sup'; return `<${tag}>${inlineHtml(flatItems(ins.paragraphs), w)}</${tag}>`; }
    case 'listings': return `<code>${esc(ins.paragraphs.map(p => p.items.map(itemText).join('')).join(' '))}</code>`;
    case 'Float': return figureLines(ins, w).join(NL);
    case 'Flex':
      if (ins.arg === 'URL') { const url = plainText(ins.paragraphs); return `<a href="${escAttr(url)}">${esc(url)}</a>`; }
      w.warnings.add(`${ins.arg} insets are written as their text`);
      return inlineHtml(flatItems(ins.paragraphs), w);
    default:
      w.warnings.add(`${ins.name} insets are written as their text`);
      return inlineHtml(flatItems(ins.paragraphs), w);
  }
}

/** a paragraph list's items, paragraphs joined by line breaks */
function flatItems(pars: Paragraph[]): Item[] {
  const out: Item[] = [];
  pars.forEach((p, i) => { if (i) out.push({ kind: 'inset', inset: newlineInset(), font: {} }); out.push(...p.items); });
  return out;
}

/** the inline HTML of a run of items (a paragraph's text) */
function inlineHtml(items: Item[], w: W): string {
  type Seg = { html: string; marks: string[]; code: boolean };
  const segs: Seg[] = [];
  for (const it of items) {
    let html: string;
    if (it.kind === 'text') {
      const typewriter = it.font.family === 'typewriter';
      html = typewriter || !TEX_TRIGGER.test(it.text) ? esc(it.text) : `<span class="ol-notex">${esc(it.text)}</span>`;
      if (it.font.size && it.font.size !== 'default') w.warnings.add('font sizes are not kept in an HTML article');
    } else if (it.kind === 'special') html = esc(SPECIAL[it.arg] ?? itemText(it));
    else if (it.kind === 'inset') html = insetHtml(it.inset, w, it.font);
    else continue;
    segs.push({ html, marks: marksOf(it), code: it.kind === 'text' && it.font.family === 'typewriter' });
  }
  // a comment inside emphasis does not end it: it takes the marks its neighbours share
  segs.forEach((s, k) => {
    if (s.marks.some(m => m.startsWith('change:')) || s.html.startsWith('<!--') === false) return;
    const prev = segs.slice(0, k).reverse().find(x => !x.html.startsWith('<!--')), next = segs.slice(k + 1).find(x => !x.html.startsWith('<!--'));
    s.marks = prev && next ? prev.marks.filter(m => next.marks.includes(m)) : [];
  });
  const openTag = (k: string): string => {
    if (k.startsWith('change:')) {
      const [, type, author, time] = k.split(':');
      return `<${type === 'inserted' ? 'ins' : 'del'} author="${escAttr(w.authors.get(Number(author)) ?? 'Unknown')}"${Number(time) ? ` datetime="${iso(Number(time))}"` : ''}>`;
    }
    if (k.startsWith('face:')) return faceSpan(parseFace(k.slice(5))!);
    return `<${k}>`;
  };
  const closeTag = (k: string) => (k.startsWith('change:') ? (k.startsWith('change:inserted') ? '</ins>' : '</del>') : k.startsWith('face:') ? '</span>' : `</${k}>`);
  const runOf = (k: string, at: number) => { let n = 0; while (at + n < segs.length && segs[at + n].marks.includes(k)) n++; return n; };
  let out = '';
  let stack: string[] = [];
  segs.forEach((s, at) => {
    let common = 0;
    while (common < stack.length && s.marks.includes(stack[common])) common++;
    for (let i = stack.length - 1; i >= common; i--) out += closeTag(stack[i]);
    stack = stack.slice(0, common);
    // what runs longest opens outermost
    const opening = s.marks.filter(k => !stack.includes(k)).sort((a, b) => runOf(b, at) - runOf(a, at) || s.marks.indexOf(a) - s.marks.indexOf(b));
    for (const k of opening) { out += openTag(k); stack.push(k); }
    out += s.html;
  });
  for (let i = stack.length - 1; i >= 0; i--) out += closeTag(stack[i]);
  return out;
}

function figureLines(ins: TextInset, w: W): string[] {
  const pm = paramMap(ins.params);
  const wide = pm.get('wide') === 'true';
  const inner: string[] = [];
  let caption: string | null = null;
  for (const p of ins.paragraphs) {
    const rest: Item[] = [];
    for (const it of p.items) {
      if (it.kind === 'inset' && it.inset.type === 'Text' && it.inset.name === 'Caption') caption = inlineHtml(flatItems(it.inset.paragraphs), w);
      else rest.push(it);
    }
    const html = inlineHtml(collapse(rest), w);
    if (html.trim()) inner.push(oneLine(html));
  }
  if (ins.arg !== 'figure') w.warnings.add(`${ins.arg} floats are written as figures`);
  return [`<figure${wide ? ' class="wide"' : ''}>`, ...inner.map(l => '  ' + l), ...(caption !== null ? [`  <figcaption>${oneLine(caption)}</figcaption>`] : []), '</figure>'];
}

function tableLines(t: TabularInset, w: W): string[] {
  const ncols = t.columns.length || Math.max(0, ...t.rows.map(r => r.cells.length));
  if (!ncols || !t.rows.length) return [];
  const alignOf = (c: number) => t.columns[c]?.attrs.find(([k]) => k === 'alignment')?.[1] ?? 'left';
  const cellHtml = (pars: Paragraph[]) => oneLine(pars.map(p => inlineHtml(p.items, w)).filter((s, i, a) => s || a.length === 1).join('<br>'));
  const headRow = t.rows[0].attrs.some(([k, v]) => k === 'endhead' && v === 'true');
  if (t.rows.some(r => r.cells.some(c => c.attrs.some(([k, v]) => (k === 'multicolumn' || k === 'multirow') && v !== '0')))) w.warnings.add('merged table cells are written one by one');
  const row = (r: TabularInset['rows'][number], tag: 'td' | 'th') => '    <tr>' + Array.from({ length: ncols }, (_, c) => {
    const a = alignOf(c);
    return `<${tag}${a !== 'left' ? ` style="text-align: ${a}"` : ''}>${r.cells[c] ? cellHtml(r.cells[c].paragraphs) : ''}</${tag}>`;
  }).join('') + '</tr>';
  const body = t.rows.slice(headRow ? 1 : 0);
  return ['<table>', ...(headRow ? ['  <thead>', row(t.rows[0], 'th'), '  </thead>'] : []), '  <tbody>', ...body.map(r => row(r, 'td')), '  </tbody>', '</table>'];
}

/** a paragraph's element as lines (no list or quote around it) */
function parLines(par: Paragraph, w: W): string[] {
  const items = par.items.filter(i => !(i.kind === 'text' && !i.text.trim()));
  const sole = items.length === 1 && items[0].kind === 'inset' && !items[0].change ? items[0].inset : null;
  if (sole?.type === 'Text' && sole.name === 'ERT') return [oneLine(rawSource(sole))];
  if (sole?.type === 'Text' && sole.name === 'Float') return figureLines(sole, w);
  if (sole?.type === 'Tabular') return tableLines(sole, w);
  if (sole?.type === 'Leaf' && sole.name === 'CommandInset' && sole.arg === 'line') return ['<hr>'];
  if (sole?.type === 'Text' && sole.name === 'listings' && !/inline true/.test(sole.params.join('\n'))) {
    const lang = /language=([^,"\s]+)/.exec(unquote(paramMap(sole.params).get('lstparams')))?.[1] ?? '';
    const lines = sole.paragraphs.map(p => esc(p.items.map(itemText).join('')));
    return [`<pre><code${lang ? ` class="language-${escAttr(lang)}"` : ''}>${lines.join(NL)}</code></pre>`];
  }
  const layout = articleLayoutFor(par.layout);
  if (layout !== par.layout && par.layout !== 'Plain Layout') w.warnings.add(`the ${par.layout} layout is written as ${layout === 'Standard' ? 'a paragraph' : layout}`);
  const tag = TAG_OF_HEADING[layout] ?? 'p';
  const cls = CLASS_OF_LAYOUT[layout];
  return [oneLine(`<${tag}${cls ? ` class="${cls}"` : ''}>${inlineHtml(par.items, w)}</${tag}>`)];
}

interface TreeNode { par: Paragraph; index: number; children: TreeNode[] }
const NESTING = new Set(['Itemize', 'Enumerate', 'Quote', 'Quotation', 'Description', 'Labeling']);
const isList = (l: string) => l === 'Itemize' || l === 'Enumerate' || l === 'Description' || l === 'Labeling' || l === 'List';
const isQuote = (l: string) => l === 'Quote' || l === 'Quotation' || l === 'Verse';

function treeOf(pars: Paragraph[], offset: number): TreeNode[] {
  const roots: TreeNode[] = [];
  const stack: TreeNode[] = [];
  pars.forEach((par, k) => {
    const node: TreeNode = { par, index: offset + k, children: [] };
    while (stack.length && stack[stack.length - 1].par.depth >= par.depth) stack.pop();
    while (stack.length && !NESTING.has(stack[stack.length - 1].par.layout)) stack.pop();
    (stack.length ? stack[stack.length - 1].children : roots).push(node);
    stack.push(node);
  });
  return roots;
}

/** lines, and for each paragraph written the line range it took */
interface Block { lines: string[]; spans: Map<number, [number, number]> }

function indentBlock(b: Block, by: string, out: Block): void {
  const base = out.lines.length;
  for (const l of b.lines) out.lines.push(l ? by + l : l);
  for (const [k, [s, e]] of b.spans) out.spans.set(k, [s + base, e + base]);
}

function writeNodes(nodes: TreeNode[], w: W): Block {
  const out: Block = { lines: [], spans: new Map() };
  for (let i = 0; i < nodes.length; i++) {
    const layout = nodes[i].par.layout;
    if (isList(layout)) {
      const ordered = layout === 'Enumerate';
      out.lines.push(ordered ? '<ol>' : '<ul>');
      for (; i < nodes.length && isList(nodes[i].par.layout) && (nodes[i].par.layout === 'Enumerate') === ordered; i++) {
        const item = nodes[i];
        const own = oneLine(inlineHtml(item.par.items, w));
        const at = out.lines.length;
        if (!item.children.length) { out.lines.push(`  <li>${own}</li>`); out.spans.set(item.index, [at, at + 1]); continue; }
        out.lines.push(`  <li>${own}`);
        out.spans.set(item.index, [at, at + 1]);
        indentBlock(writeNodes(item.children, w), '    ', out);
        out.lines.push('  </li>');
      }
      i--;
      out.lines.push(ordered ? '</ol>' : '</ul>');
      continue;
    }
    if (isQuote(layout)) {
      out.lines.push('<blockquote>');
      for (; i < nodes.length && isQuote(nodes[i].par.layout); i++) {
        const qn = nodes[i];
        const at = out.lines.length;
        out.lines.push('  ' + oneLine(`<p>${inlineHtml(qn.par.items, w)}</p>`));
        out.spans.set(qn.index, [at, at + 1]);
        if (qn.children.length) indentBlock(writeNodes(qn.children, w), '  ', out);
      }
      i--;
      out.lines.push('</blockquote>');
      continue;
    }
    const n = nodes[i];
    const own = parLines(n.par, w);
    out.spans.set(n.index, [out.lines.length, out.lines.length + own.length]);
    out.lines.push(...own);
    if (n.children.length) { const kids = writeNodes(n.children, w); indentBlock(kids, '', out); }
  }
  return out;
}

/** a top-level block of the article: a list or a quote with what nests in it, else one paragraph */
interface Group {
  from: number; to: number;
  text: string;
  /** paragraph index → character range in `text` */
  spans: Map<number, [number, number]>;
  /** the outer element's tag ('' for raw HTML or several elements), and its inner HTML's range in `text` */
  tag: string;
  inner: [number, number] | null;
  /** an HTML block: its source has the file's own indentation already */
  raw: boolean;
}

function blockText(b: Block): { text: string; spans: Map<number, [number, number]> } {
  const starts: number[] = [];
  let pos = 0;
  for (const l of b.lines) { starts.push(pos); pos += l.length + 1; }
  const text = b.lines.join('\n');
  const spans = new Map<number, [number, number]>();
  for (const [k, [s, e]] of b.spans) {
    const a = starts[s] ?? text.length;
    const z = e > s ? (starts[e - 1] ?? text.length) + (b.lines[e - 1]?.length ?? 0) : a;
    spans.set(k, [a, Math.max(a, z)]);
  }
  return { text, spans };
}

/** the outer element of a group's HTML: its tag and the range of its content (null: not one element) */
function outerOf(text: string): { tag: string; inner: [number, number] } | null {
  const open = /^<([a-z][a-z0-9]*)\b[^>]*>/.exec(text);
  if (!open) return null;
  const close = `</${open[1]}>`;
  if (!text.endsWith(close)) return null;
  // one element: its own end tag is the last one (no sibling of the same name)
  const inner = text.slice(open[0].length, text.length - close.length);
  const opens = (inner.match(new RegExp(`<${open[1]}\\b`, 'g')) ?? []).length, closes = (inner.match(new RegExp(`</${open[1]}>`, 'g')) ?? []).length;
  if (opens !== closes) return null;
  return { tag: open[1], inner: [open[0].length, text.length - close.length] };
}

function groupsOf(body: Paragraph[], w: W): Group[] {
  const out: Group[] = [];
  for (let i = 0; i < body.length;) {
    const start = i;
    const layout = body[i].layout;
    i++;
    if (isList(layout) || isQuote(layout)) {
      const ordered = layout === 'Enumerate';
      while (i < body.length && (body[i].depth > 0 || (isList(layout) ? isList(body[i].layout) && (body[i].layout === 'Enumerate') === ordered : isQuote(body[i].layout)))) i++;
    }
    const pars = body.slice(start, i).map((p, k) => (k === 0 && p.depth > 0 ? { ...p, depth: 0 } : p));
    const r = blockText(writeNodes(treeOf(pars, start), w));
    if (!r.text) continue;
    const isRaw = pars.length === 1 && !!htmlBlockOf(pars[0]);
    const outer = isRaw ? null : outerOf(r.text);
    out.push({ from: start, to: i, text: r.text, spans: r.spans, tag: outer?.tag ?? '', inner: outer?.inner ?? null, raw: isRaw });
  }
  return out;
}

function writer(doc: LyxDocument): W {
  return { authors: new Map(getAuthors(doc.header).map(a => [a.id, a.name] as [number, string])), warnings: new Set() };
}

/** The <head> and the start of the <body> of an article written from scratch (the page around its prose). */
export function articleShell(title: string, css: string): { before: string; after: string } {
  const t = esc(title || 'Untitled');
  return {
    before: `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="overlyx" content="article">
<title>${t}</title>
${css}
</head>
<body>
<article>`,
    after: `</article>
</body>
</html>
`,
  };
}

/** a group's text indented by `indent` after its first line (its spans moved along) */
function reindent(text: string, indent: string): { text: string; map: (offset: number) => number } {
  if (!indent) return { text, map: o => o };
  const nl: number[] = [];
  for (let i = 0; i < text.length; i++) if (text[i] === '\n') nl.push(i);
  const out = text.replace(/\n(?=[^\n])/g, '\n' + indent);
  return {
    text: out,
    map: (o: number) => {
      let k = 0;
      // each line start before o that is not empty got the indent
      for (const p of nl) { if (p < o && text[p + 1] !== '\n' && p + 1 < text.length) k++; else if (p >= o) break; }
      return o + k * indent.length;
    },
  };
}

/** The document as an HTML page, written from scratch (the page around it: the preamble and the trailer). */
export function writeArticle(doc: LyxDocument): WriteArticleResult {
  const w = writer(doc);
  const groups = groupsOf(doc.body, w);
  const spans: WriteArticleResult['spans'] = doc.body.map(() => null);
  const pre = doc.preamble.join('\n');
  const shell = pre ? null : articleShell(plainText(doc.body.filter(p => p.layout === 'Title').slice(0, 1)), articleHead());
  let text = pre || shell!.before;
  const indent = '  ';
  for (const g of groups) {
    text += '\n' + indent;
    const at = text.length;
    const r = reindent(g.text, g.raw ? '' : indent);
    text += r.text.replaceAll(NL, '\n');
    for (const [k, [a, b]] of g.spans) spans[k] = { start: at + r.map(a), end: at + r.map(b) };
  }
  const post = doc.trailer.join('\n');
  text += '\n' + (shell ? shell.after : post);
  return { text, spans, warnings: [...w.warnings] };
}

export interface ArticlePreserveCache { base?: string; parsed?: ParseArticleResult; groups?: Group[] }

interface Slot { units: [number, number]; groups: number[]; start: number; end: number }

/**
 * The document as HTML written into `base` (the file's text): blocks whose HTML did not change keep
 * their bytes, an edited block keeps its own start and end tags, and the markup between blocks
 * stays as it is. Writing `parseArticle(base).doc` gives `base` back.
 */
export function writeArticlePreserving(doc: LyxDocument, base: string | null, cache: ArticlePreserveCache = {}): WriteArticleResult {
  if (base === null || !base.trim() || !isArticleHtml(base)) return writeArticle(doc);
  if (cache.base !== base || !cache.parsed || !cache.groups) {
    cache.base = base;
    cache.parsed = parseArticle(base);
    cache.groups = groupsOf(cache.parsed.doc.body, writer(cache.parsed.doc));
  }
  const parsed = cache.parsed, bg = cache.groups;
  const w = writer(doc);
  const ng = groupsOf(doc.body, w);

  // slots: base units together with the groups written from them (a group spanning units joins them)
  const slots: Slot[] = [];
  const slotOfGroup: number[] = [];
  bg.forEach((g, gi) => {
    const us = parsed.parUnit.slice(g.from, g.to).filter(u => u >= 0);
    if (!us.length) { slotOfGroup.push(-1); return; }
    const lo = Math.min(...us), hi = Math.max(...us);
    const last = slots[slots.length - 1];
    if (last && lo <= last.units[1]) { last.units[1] = Math.max(last.units[1], hi); last.groups.push(gi); last.end = parsed.units[last.units[1]].end; slotOfGroup.push(slots.length - 1); return; }
    slots.push({ units: [lo, hi], groups: [gi], start: parsed.units[lo].start, end: parsed.units[hi].end });
    slotOfGroup.push(slots.length - 1);
  });

  const pairs = align(bg.map(g => g.text), ng.map(g => g.text));
  const newOf = new Map<number, number>(pairs);
  const keptAt = new Map<number, number>();   // slot → its first new group
  slots.forEach((s, si) => {
    const js = s.groups.map(g => newOf.get(g));
    if (js.every((j, k) => j !== undefined && j === js[0]! + k)) keptAt.set(si, js[0]!);
  });

  const spans: WriteArticleResult['spans'] = doc.body.map(() => null);
  const samePre = doc.preamble.join('\n') === parsed.doc.preamble.join('\n');
  const sameTrail = doc.trailer.join('\n') === parsed.doc.trailer.join('\n');
  let text = samePre ? base.slice(0, parsed.region.start) : doc.preamble.join('\n');
  const { start: rStart, end: rEnd } = parsed.region;

  const lineIndent = (at: number) => { let s = at; while (s > 0 && base[s - 1] !== '\n') s--; const ws = /^[ \t]*/.exec(base.slice(s, at))?.[0] ?? ''; return ws.length === at - s ? ws : ''; };
  /** a new group's text where a base slot's element was (its start and end tags kept when they are the same element's) */
  const emitNew = (g: Group, indent: string, like?: Slot) => {
    const at = text.length;
    const u = like && like.units[0] === like.units[1] ? parsed.units[like.units[0]] : null;
    if (u && u.open && u.close && g.tag && g.tag === u.tag && g.inner) {
      const open = base.slice(u.open.start, u.open.end), close = base.slice(u.close.start, u.close.end);
      const innerText = g.text.slice(g.inner[0], g.inner[1]);
      const r = reindent(innerText, indent);
      text += open + r.text.replaceAll(NL, '\n') + close;
      const shift = (o: number) => (o <= g.inner![0] ? Math.min(o, open.length) : o >= g.inner![1] ? open.length + r.text.length + (o - g.inner![1]) : open.length + r.map(o - g.inner![0]));
      for (const [k, [a, b]] of g.spans) spans[k] = { start: at + shift(a), end: at + shift(b) };
      return;
    }
    const r = reindent(g.text, g.raw ? '' : indent);
    text += r.text.replaceAll(NL, '\n');
    for (const [k, [a, b]] of g.spans) spans[k] = { start: at + r.map(a), end: at + r.map(b) };
  };
  const emitKept = (s: Slot, j: number) => {
    const at = text.length;
    text += base.slice(s.start, s.end);
    let k = j;
    for (const gi of s.groups) {
      const b = bg[gi], n = ng[k++];
      for (let p = 0; p < n.to - n.from && b.from + p < b.to; p++) {
        const sp = parsed.parSpans[b.from + p];
        if (sp) spans[n.from + p] = { start: at + sp.start - s.start, end: at + sp.end - s.start };
      }
    }
  };
  const isHeading = (g: Group) => /^h[1-6]$/.test(g.tag);

  // runs: the slots and new groups between two kept slots
  const kept = [...keptAt.keys()].sort((a, b) => a - b);
  let prevSlot = -1, prevNew = 0, pos = rStart;
  const run = (toSlot: number, toNew: number, endPos: number) => {
    const rs: number[] = [];
    for (let s = prevSlot + 1; s < toSlot; s++) rs.push(s);
    const news: number[] = [];
    for (let j = prevNew; j < toNew; j++) news.push(j);
    const gapAt = (from: number, to: number) => base.slice(from, to);
    if (!rs.length) {
      const gap = gapAt(pos, endPos);
      if (!news.length) { text += gap; return; }
      const prevIndent = prevSlot >= 0 ? lineIndent(slots[prevSlot].start) : null;
      const nextIndent = toSlot < slots.length ? lineIndent(slots[toSlot].start) : null;
      // new blocks go right after the block before them (inside its section) — a heading, or a block
      // at the very start, goes after the markup that follows it, where the next section begins
      if (prevSlot < 0 || isHeading(ng[news[0]])) {
        // (at the end: as indented as the markup before it, a section's end tag)
        const lastLine = gap.split('\n').reverse().find(l => l.trim());
        const indent = nextIndent ?? (lastLine !== undefined ? /^[ \t]*/.exec(lastLine)![0] : null) ?? prevIndent ?? '  ';
        const tail = /[ \t]*$/.exec(gap)?.[0] ?? '';
        text += gap.slice(0, gap.length - tail.length);
        for (const j of news) { if (!text.endsWith('\n')) text += '\n'; text += indent; emitNew(ng[j], indent); text += '\n'; }
        text += tail;
      } else {
        const indent = prevIndent ?? '  ';
        for (const j of news) { text += '\n' + indent; emitNew(ng[j], indent); }
        text += gap;
      }
      return;
    }
    // base slots in this run: paired in order with the new blocks (each takes its place); extra new
    // ones follow the last; a slot left without one is gone, the markup around it stays
    for (let i = 0; i < rs.length; i++) {
      const s = slots[rs[i]];
      const gap = gapAt(pos, s.start);
      const indent = lineIndent(s.start);
      if (i < news.length) { text += gap; emitNew(ng[news[i]], indent, s); }
      else if (/\S/.test(gap)) text += gap;
      if (i === rs.length - 1) for (let k = rs.length; k < news.length; k++) { text += '\n' + indent; emitNew(ng[news[k]], indent); }
      pos = s.end;
    }
    text += gapAt(pos, endPos);
  };
  for (const s of kept) {
    const j = keptAt.get(s)!;
    run(s, j, slots[s].start);
    emitKept(slots[s], j);
    prevSlot = s;
    prevNew = j + slots[s].groups.length;
    pos = slots[s].end;
  }
  run(slots.length, ng.length, rEnd);
  text += sameTrail ? base.slice(rEnd) : doc.trailer.join('\n');
  return { text, spans, warnings: [...w.warnings] };
}

/** Warnings about what this document loses when written as an HTML article. */
export function articleWarnings(doc: LyxDocument): string[] {
  const w = writer(doc);
  groupsOf(doc.body, w);
  return [...w.warnings];
}

/** What agents are told about articles (the MCP instructions, create_document). */
export const ARTICLE_GUIDE = `Web articles — a research post, an essay, a rich page of prose — are documents written as HTML: an .html file whose head has <meta name="overlyx" content="article"> (create_document with a path ending in .html starts one: index.html in a folder of its own). People write them in the document editor, with comments, suggestions and formulas; you read and edit them with read_document / edit_document like any document, and look at them with render_page. The prose is the content of the page's <article> element, in plain semantic HTML: <h1> title, <p class="byline">, <p class="abstract">, <h2>–<h6> headings, <p>, <ul>/<ol>, <blockquote>, <pre><code>, <figure><img><figcaption> (class "wide": wider than the text), simple <table>s; inline <em>, <strong>, <code>, <a href>, <sub>/<sup>, notes as <span class="sidenote">…</span>; TeX math as \\(…\\) and \\[…\\], \\cite{key} with the project's .bib (a <div class="ol-bibliography"></div> lists the references). Sections and divs around prose are fine. Anything else — an interactive figure with its own script, an SVG, a canvas, a custom element — is an HTML block: people see it running and cannot type into it, so put such pieces in their own elements (a <figure class="widget"> with its script inside) and keep prose out of them. Style the page in its <head> (its stylesheet's custom properties at :root — --font-text, --font-ui, --text-size, --measure, --ink, --accent, --paper … — also restyle the editor's view of it).`;
