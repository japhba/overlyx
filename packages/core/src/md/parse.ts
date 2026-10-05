/**
 * Markdown → document model. A markdown file opens in the same editor as a .tex document: its
 * blocks become LyX paragraphs (headings → Section…Subparagraph, lists → Itemize / Enumerate with
 * depth, quotes → Quote, fenced code → a listings inset, $…$ / $$…$$ → formulas, GFM tables →
 * a tabular, footnotes → Foot insets), its inline markup font attributes and insets.
 *
 * Two OverLyX conventions ride on HTML, which every markdown renderer hides or shows sensibly:
 *  - comment threads are HTML comments `<!-- @comment … -->` whose lines follow core/comments.ts
 *    ("Author (time):" headers, message lines), placed right after the commented text; a plain
 *    `<!-- … -->` is a LyX note (not shown in the output, as in markdown);
 *  - tracked changes are `<ins author="…" datetime="…">` / `<del …>` around the changed text.
 * Other inline / block HTML is kept verbatim in a raw (ERT) inset.
 *
 * Besides the document, the parse reports where every top-level block came from (`nodes`) and
 * which block each body paragraph belongs to (`parNode`): the writer (write.ts) uses it to give
 * unchanged blocks back byte for byte.
 */
import MarkdownIt from 'markdown-it';
import type { Token, StateBlock, StateInline } from 'markdown-it';
import type { Change, FontState, Inset, Item, LyxDocument, Paragraph } from '../lyx/ast.ts';
import { addAuthor, lyxAuthorId, FONT_KEYS } from '../lyx/ast.ts';
import { markdownHeader, HEADING_LAYOUTS } from './common.ts';

export interface MdSourceNode {
  /** character range in the source */
  start: number;
  end: number;
  /** a footnote definition (label), placed by the writer by its label rather than in the flow */
  footnote?: string;
}

export interface ParseMarkdownResult {
  doc: LyxDocument;
  /** the top-level blocks of the source, in order */
  nodes: MdSourceNode[];
  /** for each body paragraph: the index of the top-level block it came from */
  parNode: number[];
  /** for each body paragraph: its character range in the source (its own lines) */
  parSpans: ({ start: number; end: number } | null)[];
  warnings: string[];
}

/* ------------------------------------------------------------------ markdown-it with the extensions */

interface Env { footnotes?: Map<string, string> }

/** `$…$` (no space inside the delimiters, so that "$5 and $10" stays text) and `$$…$$` inline. */
function mathInline(state: StateInline, silent: boolean): boolean {
  const src = state.src, start = state.pos, max = state.posMax;
  if (src.charCodeAt(start) !== 0x24) return false;
  if (src.charCodeAt(start + 1) === 0x24) {
    const end = src.indexOf('$$', start + 2);
    if (end < 0 || end + 2 > max || !src.slice(start + 2, end).trim()) return false;
    if (!silent) { const t = state.push('math_inline', 'math', 0); t.content = src.slice(start + 2, end); t.markup = '$$'; }
    state.pos = end + 2;
    return true;
  }
  const next = src.charCodeAt(start + 1);
  if (start + 1 >= max || next === 0x20 || next === 0x09 || next === 0x0a) return false;
  let end = start + 1;
  for (;;) {
    end = src.indexOf('$', end);
    if (end < 0 || end >= max) return false;
    let bs = 0;
    for (let k = end - 1; k > start && src.charCodeAt(k) === 0x5c; k--) bs++;
    const prev = src.charCodeAt(end - 1);
    if (bs % 2 === 1 || prev === 0x20 || prev === 0x09 || prev === 0x0a) { end++; continue; }
    break;
  }
  if (!silent) { const t = state.push('math_inline', 'math', 0); t.content = src.slice(start + 1, end); t.markup = '$'; }
  state.pos = end + 1;
  return true;
}

/** A `$$` display formula on lines of its own. */
function mathBlock(state: StateBlock, startLine: number, endLine: number, silent: boolean): boolean {
  if (state.sCount[startLine] - state.blkIndent >= 4) return false;
  const pos = state.bMarks[startLine] + state.tShift[startLine];
  const max = state.eMarks[startLine];
  if (state.src.slice(pos, pos + 2) !== '$$') return false;
  const first = state.src.slice(pos + 2, max);
  let line = startLine, content: string;
  if (first.trim().length > 2 && first.trim().endsWith('$$')) {
    content = first.trim().slice(0, -2);
  } else if (first.includes('$$')) {
    return false;   // `$$x$$ and more text`: an inline formula in a paragraph
  } else {
    const lines = [first];
    for (line = startLine + 1; line < endLine; line++) {
      const l = state.src.slice(state.bMarks[line] + state.tShift[line], state.eMarks[line]);
      if (state.sCount[line] < state.blkIndent && l.trim()) return false;
      if (l.trimEnd().endsWith('$$')) { lines.push(l.trimEnd().slice(0, -2)); break; }
      lines.push(state.src.slice(state.bMarks[line] + Math.min(state.tShift[line], state.blkIndent), state.eMarks[line]));
    }
    if (line >= endLine) return false;
    content = lines.join('\n');
  }
  if (silent) return true;
  const t = state.push('math_block', 'math', 0);
  t.content = content.replace(/^\n+|\n+$/g, '');
  t.map = [startLine, line + 1];
  t.markup = '$$';
  state.line = line + 1;
  return true;
}

/** `[^label]: text` (continuation lines indented by four spaces): a footnote definition. */
function footnoteDef(state: StateBlock, startLine: number, endLine: number, silent: boolean): boolean {
  if (state.sCount[startLine] - state.blkIndent >= 4) return false;
  const start = state.bMarks[startLine] + state.tShift[startLine];
  const max = state.eMarks[startLine];
  const m = /^\[\^([^\]\s]+)\]:[ \t]?/.exec(state.src.slice(start, max));
  if (!m) return false;
  if (silent) return true;
  const lines = [state.src.slice(start + m[0].length, max)];
  let line = startLine + 1;
  for (; line < endLine; line++) {
    const text = state.src.slice(state.bMarks[line], state.eMarks[line]);
    if (!text.trim()) {
      // a blank line belongs to the definition when an indented line follows
      let k = line + 1;
      while (k < endLine && !state.src.slice(state.bMarks[k], state.eMarks[k]).trim()) k++;
      if (k < endLine && state.sCount[k] - state.blkIndent >= 4) { lines.push(''); continue; }
      break;
    }
    if (state.sCount[line] - state.blkIndent >= 4) { lines.push(text.replace(/^(?: {4}|\t| {0,3}\t)/, '')); continue; }
    // a lazy continuation of the first paragraph
    if (lines[lines.length - 1].trim() && !/^\s{0,3}(\[\^|[#>*+-]\s|\d+[.)]\s|```|~~~|\$\$|\||<)/.test(text)) { lines.push(text.trim()); continue; }
    break;
  }
  while (lines.length && !lines[lines.length - 1].trim()) lines.pop();
  const env = state.env as Env;
  (env.footnotes ??= new Map()).set(m[1], lines.join('\n'));
  const t = state.push('footnote_def', '', 0);
  t.meta = { label: m[1], content: lines.join('\n') };
  t.map = [startLine, line];
  state.line = line;
  return true;
}

/** `[^label]` with a definition somewhere in the document: a footnote. */
function footnoteRef(state: StateInline, silent: boolean): boolean {
  const src = state.src, start = state.pos;
  if (src.charCodeAt(start) !== 0x5b || src.charCodeAt(start + 1) !== 0x5e) return false;
  const m = /^\[\^([^\]\s]+)\]/.exec(src.slice(start, state.posMax));
  const defs = (state.env as Env).footnotes;
  if (!m || !defs?.has(m[1])) return false;
  if (!silent) { const t = state.push('footnote_ref', '', 0); t.meta = { label: m[1] }; }
  state.pos += m[0].length;
  return true;
}

let mdInstance: MarkdownIt | null = null;
/** The markdown-it the parser uses: CommonMark + GFM tables / strikethrough + autolinks, math, footnotes. */
export function markdownIt(): MarkdownIt {
  if (mdInstance) return mdInstance;
  const md = new MarkdownIt('default', { html: true, linkify: true, typographer: false });
  // GitHub's autolinks: addresses with a scheme or www., e-mail addresses — not every word ending in .md
  md.linkify.set({ fuzzyLink: false, fuzzyIP: false });
  md.block.ruler.before('fence', 'math_block', mathBlock, { alt: ['paragraph', 'reference', 'blockquote', 'list'] });
  md.block.ruler.before('reference', 'footnote_def', footnoteDef, { alt: ['paragraph', 'reference'] });
  md.inline.ruler.after('escape', 'math_inline', mathInline);
  md.inline.ruler.after('math_inline', 'footnote_ref', footnoteRef);
  mdInstance = md;
  return md;
}

/* ------------------------------------------------------------------ tokens → tree */

interface Node { tok: Token; children: Node[] }

function tree(tokens: Token[]): Node[] {
  const root: Node[] = [];
  const stack: Node[][] = [root];
  for (const t of tokens) {
    if (t.nesting === 1) {
      const n: Node = { tok: t, children: [] };
      stack[stack.length - 1].push(n);
      stack.push(n.children);
    } else if (t.nesting === -1) {
      if (stack.length > 1) stack.pop();
    } else {
      stack[stack.length - 1].push({ tok: t, children: [] });
    }
  }
  return root;
}

const nodeType = (n: Node) => n.tok.type.replace(/_open$/, '');

/* ------------------------------------------------------------------ the converter */

const LINE_RE = /\r?\n/;
const ATTR_RE = /([a-zA-Z_:][-a-zA-Z0-9_:.]*)\s*=\s*("([^"]*)"|'([^']*)'|[^\s"'=<>`]+)/g;

function htmlAttrs(tag: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const m of tag.matchAll(ATTR_RE)) out[m[1].toLowerCase()] = decodeEntities(m[3] ?? m[4] ?? m[2]);
  return out;
}

function decodeEntities(s: string): string {
  return s.replace(/&(?:#(\d+)|#x([0-9a-f]+)|(amp|lt|gt|quot|apos|nbsp));/gi, (_m, d, x, n) => {
    if (d) return String.fromCodePoint(Number(d));
    if (x) return String.fromCodePoint(parseInt(x, 16));
    return ({ amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ' } as Record<string, string>)[n.toLowerCase()];
  });
}

/** an HTML comment's text (between `<!--` and `-->`), dedented: its lines (OverLyX writes them indented by four spaces) */
function commentLines(body: string): string[] {
  let lines = body.split(LINE_RE);
  // the single-line form keeps its line breaks as `\n` (and backslashes doubled)
  if (lines.length === 1) lines = unescapeSingle(lines[0]);
  if (lines.length && !lines[0].trim()) lines = lines.slice(1);
  else if (lines.length) lines[0] = lines[0].replace(/^ /, '');
  if (lines.length && !lines[lines.length - 1].trim()) lines.pop();
  else if (lines.length) lines[lines.length - 1] = lines[lines.length - 1].replace(/ $/, '');
  return lines.map(l => l.replace(/^ {1,4}/, '').replace(/--&gt;/g, '-->'));
}

function unescapeSingle(s: string): string[] {
  const out: string[] = [];
  let cur = '';
  for (let i = 0; i < s.length; i++) {
    if (s[i] === '\\' && s[i + 1] === 'n') { out.push(cur); cur = ''; i++; continue; }
    if (s[i] === '\\' && s[i + 1] === '\\') { cur += '\\'; i++; continue; }
    cur += s[i];
  }
  out.push(cur);
  return out;
}

const COMMENT_RE = /^<!--([\s\S]*?)-->/;

/** an HTML comment as a LyX note: `@comment` → a comment thread, `@greyedout` → greyed out, else a note */
function noteInset(raw: string, base: string): Inset | null {
  const m = COMMENT_RE.exec(raw);
  if (!m) return null;
  let body = m[1];
  let arg = 'Note';
  const kind = /^\s*@(comment|greyedout|note)\b ?/.exec(body);
  if (kind) { arg = kind[1] === 'comment' ? 'Comment' : kind[1] === 'greyedout' ? 'Greyedout' : 'Note'; body = body.slice(kind[0].length); }
  const lines = commentLines(body);
  const paragraphs: Paragraph[] = lines.map(l => ({ layout: base, depth: 0, params: {}, items: l ? [{ kind: 'text', text: l, font: {} }] : [] }));
  if (!paragraphs.length) paragraphs.push({ layout: base, depth: 0, params: {}, items: [] });
  return { type: 'Text', name: 'Note', arg, params: [], status: 'open', paragraphs };
}

const ert = (text: string): Inset => ({
  type: 'Text', name: 'ERT', arg: '', params: [], status: 'collapsed',
  paragraphs: text.split(LINE_RE).map(l => ({ layout: 'Plain Layout', depth: 0, params: {}, items: l ? [{ kind: 'text', text: l, font: {} }] : [] })),
});

const DISPLAY_ENVS = /^\\begin\{(equation|align|gather|multline|eqnarray|flalign|alignat)\*?\}[\s\S]*\\end\{\1\*?\}$/;

function formula(content: string, display: boolean): Inset {
  const inner = content.trim();
  if (!display) return { type: 'Formula', inline: true, latex: '$' + inner + '$' };
  return { type: 'Formula', inline: false, latex: DISPLAY_ENVS.test(inner) ? inner : '\\[' + inner + '\\]' };
}

const HEADING_OF_TAG: Record<string, string> = { h1: HEADING_LAYOUTS[0], h2: HEADING_LAYOUTS[1], h3: HEADING_LAYOUTS[2], h4: HEADING_LAYOUTS[3], h5: HEADING_LAYOUTS[4], h6: HEADING_LAYOUTS[4] };

interface Ctx { depth: number; quote: boolean; base: string }

type Sub = { name: string; at: number; font: FontState };

class Converter {
  pars: Paragraph[] = [];
  parNode: number[] = [];
  parSpans: ({ start: number; end: number } | null)[] = [];
  warnings: string[] = [];
  curNode = -1;
  authors = new Map<string, number>();
  constructor(private md: MarkdownIt, private env: Env, private lineStart: number[], private src: string, private footnoteDepth = 0) {}

  span(map: [number, number] | null | undefined): { start: number; end: number } | null {
    if (!map) return null;
    const start = this.lineStart[map[0]] ?? this.src.length;
    let end = (this.lineStart[map[1]] ?? this.src.length + 1) - 1;
    while (end > start && /[\r\n]/.test(this.src[end - 1] ?? '')) end--;
    return { start, end: Math.max(start, Math.min(end, this.src.length)) };
  }

  push(p: Paragraph, map?: [number, number] | null): Paragraph {
    this.pars.push(p);
    this.parNode.push(this.curNode);
    this.parSpans.push(this.span(map));
    return p;
  }

  par(layout: string, depth: number, items: Item[], map?: [number, number] | null): Paragraph {
    return this.push({ layout, depth, params: {}, items: normalize(items) }, map);
  }

  /** a block that is an inset alone in a paragraph (code, table, display formula, rule, raw HTML) */
  insetPar(ctx: Ctx, inset: Inset, map?: [number, number] | null, params: Paragraph['params'] = {}): void {
    this.push({ layout: ctx.quote ? 'Quote' : ctx.base, depth: ctx.depth, params, items: [{ kind: 'inset', inset, font: {} }] }, map);
  }

  /**
   * The paragraph at `nodes[i]`: a paragraph, or an HTML comment block (a note / comment thread at
   * the start of a paragraph: CommonMark makes the line it ends on raw HTML) together with the
   * paragraph right below it (no blank line between), which is the rest of the same paragraph.
   * Null when `nodes[i]` is neither. `used`: how many nodes it took.
   */
  paragraphAt(nodes: Node[], i: number): { items: Item[]; map: [number, number] | null; used: number } | null {
    const n = nodes[i];
    if (!n) return null;
    if (nodeType(n) === 'paragraph') return { items: this.inline(n.children[0]), map: n.tok.map as [number, number] | null, used: 1 };
    if (nodeType(n) !== 'html_block') return null;
    const raw = n.tok.content.replace(/\n$/, '').trimStart();
    const c = COMMENT_RE.exec(raw);
    const rest = c ? raw.slice(c[0].length) : '';
    const note = c && !rest.includes('\n') ? noteInset(c[0], 'Plain Layout') : null;
    if (!note) return null;
    let items: Item[] = [{ kind: 'inset', inset: note, font: {} }, ...(rest.trim() ? this.inlineText(rest.replace(/\\$/, '')) : [])];
    let map = n.tok.map as [number, number] | null;
    const next = nodes[i + 1];
    if (next && nodeType(next) === 'paragraph' && next.tok.map && map && next.tok.map[0] === map[1]) {
      items = [...items, /\\$/.test(rest) ? newline() : text(' '), ...this.inline(next.children[0])];
      map = [map[0], next.tok.map[1]];
      return { items, map, used: 2 };
    }
    return { items, map, used: 1 };
  }

  blocks(nodes: Node[], ctx: Ctx): void {
    for (let i = 0; i < nodes.length; i++) {
      const n = nodes[i];
      const type = nodeType(n);
      const map = n.tok.map as [number, number] | null;
      const p = this.paragraphAt(nodes, i);
      if (p) {
        this.par(ctx.quote ? 'Quote' : ctx.base, ctx.depth, p.items, p.map);
        i += p.used - 1;
        continue;
      }
      switch (type) {
        case 'heading': {
          const layout = ctx.quote ? 'Quote' : ctx.base === 'Plain Layout' ? 'Plain Layout' : HEADING_OF_TAG[n.tok.tag] ?? HEADING_LAYOUTS[0];
          this.par(layout, ctx.depth, this.inline(n.children[0]), map);
          break;
        }
        case 'bullet_list':
        case 'ordered_list': this.list(n, ctx); break;
        case 'blockquote': this.blocks(n.children, { ...ctx, quote: true }); break;
        case 'fence':
        case 'code_block': {
          const info = (n.tok.info ?? '').trim().split(/\s+/)[0] ?? '';
          if (info === 'math') { this.insetPar(ctx, formula(n.tok.content, true), map); break; }
          const lines = n.tok.content.replace(/\n$/, '').split('\n');
          const params = [`lstparams "${info ? 'language=' + info.replace(/"/g, '') : ''}"`, 'inline false'];
          if (n.tok.type === 'code_block') params.push('indented true');
          else if (n.tok.markup !== '```') params.push(`fence "${n.tok.markup}"`);
          this.insetPar(ctx, { type: 'Text', name: 'listings', arg: '', params, status: 'open', paragraphs: lines.map(l => ({ layout: 'Plain Layout', depth: 0, params: {}, items: l ? [{ kind: 'text', text: l, font: {} }] : [] })) }, map);
          break;
        }
        case 'math_block': this.insetPar(ctx, formula(n.tok.content, true), map); break;
        case 'hr': this.insetPar(ctx, { type: 'Leaf', name: 'CommandInset', arg: 'line', params: ['LatexCommand rule', 'width "100text%"', 'height "0.4pt"'] }, map, { noindent: true }); break;
        case 'table': this.insetPar(ctx, this.table(n), map); break;
        case 'html_block': this.insetPar(ctx, ert(n.tok.content.replace(/\n$/, '')), map); break;
        case 'footnote_def': break;   // its text went into the Foot insets at the references
        default:
          this.warnings.push(`unsupported markdown block "${type}" kept as raw text`);
          if (n.tok.content) this.insetPar(ctx, ert(n.tok.content.replace(/\n$/, '')), map);
      }
    }
  }

  list(n: Node, ctx: Ctx): void {
    const layout = nodeType(n) === 'ordered_list' ? 'Enumerate' : 'Itemize';
    // a list inside a quote needs a Quote paragraph to nest under
    if (ctx.quote) {
      const last = this.pars[this.pars.length - 1];
      if (!last || last.layout !== 'Quote' || last.depth !== ctx.depth) this.par('Quote', ctx.depth, [], n.tok.map as [number, number]);
      ctx = { ...ctx, depth: ctx.depth + 1, quote: false };
    }
    for (const item of n.children) {
      if (nodeType(item) !== 'list_item') continue;
      const kids = item.children;
      const first = this.paragraphAt(kids, 0);
      this.par(layout, ctx.depth, first?.items ?? [], item.tok.map as [number, number] | null);
      this.blocks(kids.slice(first?.used ?? 0), { depth: ctx.depth + 1, quote: false, base: ctx.base === 'Plain Layout' ? 'Plain Layout' : 'Standard' });
    }
  }

  table(n: Node): Inset {
    const rows: Node[] = [];
    for (const sec of n.children) for (const tr of sec.children) if (nodeType(tr) === 'tr') rows.push(tr);
    const ncols = Math.max(1, ...rows.map(r => r.children.length));
    const align = (cell: Node | undefined): string => {
      const m = /text-align:\s*(left|right|center)/.exec(cell?.tok.attrGet('style') ?? '');
      return m ? m[1] : 'left';
    };
    const header = rows[0];
    const columns = Array.from({ length: ncols }, (_, c) => ({ attrs: [['alignment', align(header?.children[c])], ['valignment', 'top']] as [string, string][] }));
    const out = rows.map((r, ri) => ({
      attrs: (ri === 0 ? [['topline', 'true'], ['bottomline', 'true']] : ri === rows.length - 1 ? [['bottomline', 'true']] : []) as [string, string][],
      cells: Array.from({ length: ncols }, (_, c) => {
        const cell = r.children[c];
        // rules as booktabs sets them: above and below the header row, below the last row
        const lines: [string, string][] = ri === 0 ? [['topline', 'true'], ['bottomline', 'true']] : ri === rows.length - 1 ? [['bottomline', 'true']] : [];
        const attrs: [string, string][] = [['alignment', align(header?.children[c])], ['valignment', 'top'], ...lines, ['usebox', 'none']];
        return { attrs, paragraphs: splitCellLines(cell ? this.inline(cell.children[0]) : []) };
      }),
    }));
    return {
      type: 'Tabular',
      attrs: [['version', '3'], ['rows', String(rows.length)], ['columns', String(ncols)]],
      features: [['tabularvalignment', 'middle']],
      columns, rows: out,
    };
  }

  /** inline markdown parsed on its own (the text after a comment block) */
  inlineText(s: string): Item[] {
    const toks = this.md.parseInline(s, this.env);
    return toks.length ? this.inline({ tok: toks[0], children: [] }) : [];
  }

  /** an inline token's children as items */
  inline(n: Node | undefined): Item[] {
    const kids = n?.tok.children ?? [];
    const items: Item[] = [];
    const fontStack: { key: keyof FontState; value: string; tag: string }[] = [];
    let change: Change | undefined;
    const changeStack: (Change | undefined)[] = [];
    const subs: Sub[] = [];
    let link: { href: string; title: string; start: number } | null = null;
    const cur = (): FontState => {
      const f: Record<string, string> = {};
      // in the model's key order: equal fonts serialise equally
      for (const k of FONT_KEYS) { for (let i = fontStack.length - 1; i >= 0; i--) if (fontStack[i].key === k) { f[k] = fontStack[i].value; break; } }
      return f as FontState;
    };
    const add = (it: Item) => { if (change) it.change = { ...change }; items.push(it); };
    // an inline object takes the font around it, as text does: `*the value $x$ is*` is one emphasis
    const addInset = (inset: Inset) => add({ kind: 'inset', inset, font: cur() });
    const addText = (t: string) => { if (t) add({ kind: 'text', text: t, font: cur() }); };
    const open = (key: keyof FontState, value: string, tag: string) => { fontStack.push({ key, value, tag }); };
    const close = (tag: string) => {
      for (let i = fontStack.length - 1; i >= 0; i--) if (fontStack[i].tag === tag) { fontStack.splice(i, 1); break; }
    };
    for (const t of kids) {
      switch (t.type) {
        case 'text': case 'text_special': addText(t.content); break;
        case 'softbreak': addText(' '); break;
        case 'hardbreak': addInset(newlineInset()); break;
        case 'em_open': open('emph', 'on', 'em'); break;
        case 'em_close': close('em'); break;
        case 'strong_open': open('series', 'bold', 'strong'); break;
        case 'strong_close': close('strong'); break;
        case 's_open': open('strikeout', 'on', 's'); break;
        case 's_close': close('s'); break;
        case 'code_inline': { const f: Record<string, string> = { ...cur(), family: 'typewriter' }; add({ kind: 'text', text: t.content, font: Object.fromEntries(FONT_KEYS.filter(k => f[k]).map(k => [k, f[k]])) as FontState }); break; }
        case 'math_inline': addInset(formula(t.content, t.markup === '$$')); break;
        case 'footnote_ref': {
          const label = String(t.meta?.label ?? '');
          const content = this.env.footnotes?.get(label) ?? '';
          const paragraphs = this.footnoteDepth > 2 ? [{ layout: 'Plain Layout', depth: 0, params: {}, items: content ? [text(content)] : [] }] : parseBlocksInto(this.md, content, this.env, 'Plain Layout', this.footnoteDepth + 1, this);
          addInset({ type: 'Text', name: 'Foot', arg: '', params: [`label ${q(label)}`], status: 'collapsed', paragraphs });
          break;
        }
        case 'link_open':
          link = { href: t.attrGet('href') ?? '', title: t.attrGet('title') ?? '', start: items.length };
          break;
        case 'link_close': {
          if (!link) break;
          const inner = items.splice(link.start);
          const { href, title } = link;
          link = null;
          // a linked image (a badge): the image carries the link
          if (inner.some(i => i.kind === 'inset' && i.inset.type === 'Leaf' && i.inset.name === 'Graphics')) {
            for (const i of inner) {
              if (i.kind === 'inset' && i.inset.type === 'Leaf' && i.inset.name === 'Graphics') i.inset.params.push(`\tlink ${href}`);
              items.push(i);
            }
            break;
          }
          const label = inner.map(itemTextOf).join('');
          const font = inner.find(i => i.kind === 'text')?.font ?? cur();
          // an autolink's text is its address: no name (the editor shows the address)
          const auto = label === href && /^[a-z][a-z0-9+.-]{1,31}:/i.test(href);
          const params = ['LatexCommand href', `name ${q(auto ? '' : label)}`, `target ${q(href)}`];
          if (title) params.push(`title ${q(title)}`);
          params.push('literal "true"');
          add({ kind: 'inset', inset: { type: 'Leaf', name: 'CommandInset', arg: 'href', params }, font });
          break;
        }
        case 'image': {
          const params = [`\tfilename ${t.attrGet('src') ?? ''}`];
          const alt = (t.children ?? []).map(c => c.content).join('') || t.content;
          if (alt) params.push(`\tspecial alt={${alt.replace(/[{}]/g, '')}}`);
          addInset({ type: 'Leaf', name: 'Graphics', arg: '', params });
          break;
        }
        case 'html_inline': {
          const raw = t.content;
          const tag = /^<\/?([a-zA-Z][a-zA-Z0-9]*)\b[^>]*?\/?>$/.exec(raw);
          const closing = raw.startsWith('</');
          const name = tag?.[1].toLowerCase();
          if (raw.startsWith('<!--')) {
            const note = noteInset(raw, 'Plain Layout');
            if (note) { add({ kind: 'inset', inset: note, font: {} }); break; }
          }
          if ((name === 'ins' || name === 'del') && (closing ? changeStack.length > 0 : /\b(author|datetime)\s*=/.test(raw))) {
            if (closing) { change = changeStack.pop(); break; }
            const a = htmlAttrs(raw);
            const author = a.author || 'Unknown';
            const id = lyxAuthorId(author, '');
            this.authors.set(author, id);
            const time = a.datetime ? Math.floor(Date.parse(a.datetime) / 1000) : 0;
            changeStack.push(change);
            change = { type: name === 'ins' ? 'inserted' : 'deleted', author: id, time: Number.isFinite(time) ? time : 0 };
            break;
          }
          if (name && FONT_TAGS[name] && raw.toLowerCase() === (closing ? `</${name}>` : `<${name}>`)) {
            if (closing) close('html:' + name); else open(FONT_TAGS[name][0], FONT_TAGS[name][1], 'html:' + name);
            break;
          }
          if (name === 'br' && !closing) { addInset(newlineInset()); break; }
          if ((name === 'sub' || name === 'sup') && raw.toLowerCase() === `<${name}>`) { subs.push({ name, at: items.length, font: cur() }); break; }
          if ((name === 'sub' || name === 'sup') && closing && subs[subs.length - 1]?.name === name) {
            const sub = subs.pop()!;
            // the script carries the font around it; its text only what was set inside it
            const inner = items.splice(sub.at).map(i => ({ ...i, font: fontInside(i.font, sub.font) }));
            add({ kind: 'inset', inset: { type: 'Text', name: 'script', arg: name === 'sub' ? 'subscript' : 'superscript', params: [], status: 'open', paragraphs: [{ layout: 'Plain Layout', depth: 0, params: {}, items: normalize(inner) }] }, font: sub.font });
            break;
          }
          addInset(ert(raw));
          break;
        }
        default:
          if (t.content) addText(t.content);
      }
    }
    return normalize(items);
  }
}

const FONT_TAGS: Record<string, [keyof FontState, string]> = {
  em: ['emph', 'on'], i: ['emph', 'on'], strong: ['series', 'bold'], b: ['series', 'bold'], s: ['strikeout', 'on'], strike: ['strikeout', 'on'],
  del: ['strikeout', 'on'], u: ['bar', 'under'], code: ['family', 'typewriter'], tt: ['family', 'typewriter'],
};

const q = (s: string) => '"' + s.replace(/"/g, '\\"') + '"';
const text = (s: string): Item => ({ kind: 'text', text: s, font: {} });
const newlineInset = (): Inset => ({ type: 'Leaf', name: 'Newline', arg: 'newline', params: [] });
const newline = (): Item => ({ kind: 'inset', inset: newlineInset(), font: {} });

function itemTextOf(it: Item): string {
  if (it.kind === 'text') return it.text;
  if (it.kind === 'inset' && it.inset.type === 'Formula') return it.inset.latex;
  return '';
}

/** a table cell's items as paragraphs: `<br>` separates them */
function splitCellLines(items: Item[]): Paragraph[] {
  const out: Paragraph[] = [{ layout: 'Plain Layout', depth: 0, params: {}, items: [] }];
  for (const it of items) {
    if (it.kind === 'inset' && it.inset.type === 'Leaf' && it.inset.name === 'Newline') { out.push({ layout: 'Plain Layout', depth: 0, params: {}, items: [] }); continue; }
    out[out.length - 1].items.push(it);
  }
  return out;
}

/** adjacent text items with the same font and change merged */
export function normalize(items: Item[]): Item[] {
  const out: Item[] = [];
  for (const it of items) {
    const last = out[out.length - 1];
    if (it.kind === 'text' && !it.text) continue;
    if (it.kind === 'text' && last?.kind === 'text' && sameFont(last.font, it.font) && sameChange(last.change, it.change)) {
      out[out.length - 1] = { ...last, text: last.text + it.text };
      continue;
    }
    out.push(it);
  }
  return out;
}

/** `font` without what it shares with the font around it (`outer`) */
function fontInside(font: FontState, outer: FontState): FontState {
  const f = font as Record<string, string | undefined>, o = outer as Record<string, string | undefined>;
  return Object.fromEntries(Object.keys(f).filter(k => f[k] !== undefined && f[k] !== o[k]).map(k => [k, f[k]])) as FontState;
}

function sameFont(a: FontState, b: FontState): boolean {
  const ka = Object.keys(a).filter(k => (a as Record<string, unknown>)[k] !== undefined), kb = Object.keys(b).filter(k => (b as Record<string, unknown>)[k] !== undefined);
  return ka.length === kb.length && ka.every(k => (a as Record<string, unknown>)[k] === (b as Record<string, unknown>)[k]);
}
function sameChange(a?: Change, b?: Change): boolean {
  if (!a && !b) return true;
  return !!a && !!b && a.type === b.type && a.author === b.author && a.time === b.time;
}

/** blocks of a markdown string (a footnote's text) as paragraphs of another converter's document */
function parseBlocksInto(md: MarkdownIt, src: string, env: Env, base: string, depth: number, parent: Converter): Paragraph[] {
  const tokens = md.parse(src, env);
  const c = new Converter(md, env, lineStarts(src), src, depth);
  c.blocks(tree(tokens), { depth: 0, quote: false, base });
  for (const [a, id] of c.authors) parent.authors.set(a, id);
  parent.warnings.push(...c.warnings);
  if (!c.pars.length) c.pars.push({ layout: base, depth: 0, params: {}, items: [] });
  return c.pars;
}

function lineStarts(s: string): number[] {
  const out = [0];
  for (let i = 0; i < s.length; i++) if (s[i] === '\n') out.push(i + 1);
  return out;
}

/** YAML front matter (`---` … `---` / `...` at the very top): kept verbatim, not parsed */
export function frontMatterEnd(text: string): number {
  if (!/^---[ \t]*\r?\n/.test(text)) return 0;
  const re = /^(?:---|\.\.\.)[ \t]*(?:\r?\n|$)/gm;
  re.lastIndex = text.indexOf('\n') + 1;
  const m = re.exec(text);
  return m ? m.index + m[0].length : 0;
}

export function parseMarkdown(text: string): ParseMarkdownResult {
  const md = markdownIt();
  const env: Env = {};
  const fmEnd = frontMatterEnd(text);
  // the front matter's lines are blanked (not removed), so the line numbers stay those of the file
  const body = fmEnd ? text.slice(0, fmEnd).replace(/[^\n]/g, '') + text.slice(fmEnd) : text;
  const tokens = md.parse(body, env);
  const starts = lineStarts(text);
  const conv = new Converter(md, env, starts, text);
  const nodes: MdSourceNode[] = [];
  const top = tree(tokens);
  for (let i = 0; i < top.length; i++) {
    const n = top[i];
    const sp = conv.span(n.tok.map as [number, number] | null);
    if (!sp) continue;
    nodes.push(nodeType(n) === 'footnote_def' ? { ...sp, footnote: String(n.tok.meta?.label ?? '') } : sp);
    conv.curNode = nodes.length - 1;
    // a comment block and the paragraph right below it are one paragraph (Converter.paragraphAt)
    const p = conv.paragraphAt(top, i);
    if (p && p.used === 2) {
      const nsp = conv.span(top[i + 1].tok.map as [number, number] | null);
      if (nsp) nodes[nodes.length - 1].end = nsp.end;
      conv.blocks(top.slice(i, i + 2), { depth: 0, quote: false, base: 'Standard' });
      i++;
      continue;
    }
    conv.blocks([n], { depth: 0, quote: false, base: 'Standard' });
  }
  if (!conv.pars.length) { conv.curNode = -1; conv.par('Standard', 0, []); }
  const header = markdownHeader();
  for (const [name, id] of conv.authors) addAuthor(header, id, name, '');
  return {
    doc: { preamble: fmEnd ? text.slice(0, fmEnd).replace(/\r?\n$/, '').split(LINE_RE) : [], format: 643, header, body: conv.pars, trailer: [] },
    nodes, parNode: conv.parNode, parSpans: conv.parSpans, warnings: conv.warnings,
  };
}
