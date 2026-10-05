/**
 * Document model → markdown (parse.ts in reverse). What markdown cannot express is written as the
 * closest thing it has (a numbered section as a heading, small caps as plain text, a citation as
 * `[@key]`) and reported in `warnings`.
 *
 * `writeMarkdownPreserving` writes into the text the file holds now: every block whose markdown is
 * unchanged keeps its bytes (its own list markers, emphasis style, line wrapping, reference links),
 * so saving an edit changes the lines of the edited blocks and nothing else — and writing a file
 * that was just parsed gives it back exactly.
 */
import type { Change, FontState, Header, Inset, Item, LyxDocument, Paragraph, TabularInset, TextInset } from '../lyx/ast.ts';
import { getAuthors, itemText, paramMap, unquote } from '../lyx/ast.ts';
import { align } from '../lyx/merge.ts';
import { headingLevel } from './common.ts';
import { normalize, parseMarkdown, type ParseMarkdownResult } from './parse.ts';

export type Span = { start: number; end: number } | null;

export interface WriteMarkdownResult {
  text: string;
  /** for every body paragraph: its character range in `text` (the source pane's cursor sync) */
  spans: Span[];
  warnings: string[];
}

/* ------------------------------------------------------------------ inline */

interface InlineOpts { singleLine?: boolean; inTable?: boolean; listItem?: boolean }

interface W {
  authors: Map<number, string>;
  warnings: Set<string>;
  /** footnote labels in use → their definition's markdown */
  footnotes: Map<string, string>;
  /** labels of the footnotes in order of their first reference */
  footnoteOrder: string[];
  usedLabels: Set<string>;
  /** the label given to each footnote inset (an inset is written more than once while choosing its markup) */
  footLabel: Map<TextInset, string>;
}

const PUNCT = /[!-/:-@[-`{-~]/;
const isAlnum = (c: string | undefined) => !!c && /[\p{L}\p{N}]/u.test(c);

/** text of a run, escaped so that markdown reads it back as this text */
function escapeText(s: string, o: InlineOpts): string {
  let out = '';
  for (let i = 0; i < s.length; i++) {
    const c = s[i], prev = s[i - 1], next = s[i + 1];
    switch (c) {
      case '\\': out += next === undefined || PUNCT.test(next) ? '\\\\' : '\\'; break;
      case '*': case '`': case '$': case '[': out += '\\' + c; break;
      case '_': out += isAlnum(prev) && isAlnum(next) ? '_' : '\\_'; break;
      case '~': out += prev === '~' || next === '~' || next === undefined || prev === undefined ? '\\~' : '~'; break;
      case '<': out += next === undefined || /[A-Za-z/!?]/.test(next) ? '\\<' : '<'; break;
      case '&': out += /^&#?[A-Za-z0-9]+;/.test(s.slice(i)) ? '\\&' : '&'; break;
      case '|': out += o.inTable ? '\\|' : '|'; break;
      default: out += c;
    }
  }
  return out;
}

/** the start of a line must not read as block syntax: `# `, `> `, `- `, `1. `, `===` … */
function escapeLineStart(s: string): string {
  s = s.replace(/^[ \t]+/, '');
  if (/^(#|>|-|\+|=)/.test(s)) return '\\' + s;
  const m = /^(\d{1,9})([.)])/.exec(s);
  if (m) return m[1] + '\\' + s.slice(m[1].length);
  return s;
}

function codeSpan(text: string, inTable = false): string {
  if (!text) return '';
  // in a table, a pipe ends the cell even inside code: it is escaped (and the escape removed again)
  if (inTable) text = text.replace(/\|/g, '\\|');
  const longest = Math.max(0, ...(text.match(/`+/g) ?? []).map(r => r.length));
  const fence = '`'.repeat(longest + 1);
  const pad = text.startsWith('`') || text.endsWith('`') || (text.startsWith(' ') && text.endsWith(' ') && text.trim() !== '');
  return fence + (pad ? ' ' : '') + text + (pad ? ' ' : '') + fence;
}

const linkTarget = (t: string) => (/[\s<>]/.test(t) || unbalanced(t) ? '<' + t.replace(/[<>]/g, c => (c === '<' ? '%3C' : '%3E')) + '>' : t);
function unbalanced(t: string): boolean {
  let d = 0;
  for (const c of t) { if (c === '(') d++; else if (c === ')' && --d < 0) return true; }
  return d !== 0;
}
const linkTitle = (t: string) => (t ? ` "${t.replace(/(["\\])/g, '\\$1')}"` : '');

/** the latex of a formula without its delimiters */
function formulaInner(latex: string): { inner: string; display: boolean } {
  const t = latex.trim();
  let m = /^\$\$([\s\S]*)\$\$$/.exec(t);
  if (m) return { inner: m[1].trim(), display: true };
  m = /^\$([\s\S]*)\$$/.exec(t);
  if (m) return { inner: m[1].trim(), display: false };
  m = /^\\\(([\s\S]*)\\\)$/.exec(t);
  if (m) return { inner: m[1].trim(), display: false };
  m = /^\\\[([\s\S]*)\\\]$/.exec(t);
  if (m) return { inner: m[1].trim(), display: true };
  return { inner: t, display: true };
}

/** the lines of a note's paragraphs (plain text; empty paragraphs dropped: a blank line would end the markdown paragraph) */
function noteLines(pars: Paragraph[]): string[] {
  return pars.map(p => p.items.map(itemText).join('').replace(/\n/g, ' ')).filter(l => l.trim() !== '');
}

function htmlComment(kind: string, lines: string[], single: boolean): string {
  const tag = kind === 'Comment' ? '@comment' : kind === 'Greyedout' ? '@greyedout' : '';
  const safe = lines.map(l => l.replace(/-->/g, '--&gt;'));
  if (single || (!tag && safe.length <= 1)) {
    const body = safe.map(l => l.replace(/\\/g, '\\\\')).join('\\n');
    return `<!--${tag ? ' ' + tag : ''}${body ? ' ' + body : ''} -->`;
  }
  return `<!--${tag ? ' ' + tag : ''}\n${safe.map(l => '    ' + l).join('\n')}\n    -->`;
}

const iso = (t: number) => new Date(t * 1000).toISOString().replace(/\.\d{3}Z$/, 'Z');
const attrQ = (s: string) => s.replace(/&/g, '&amp;').replace(/"/g, '&quot;');

type Seg = { md: string; marks: string[]; change?: Change; text?: string; code?: boolean; note?: boolean };

const MARK_ORDER = ['strong', 'em', 'strike', 'u'];

function fontMarks(f: FontState): string[] {
  const out: string[] = [];
  if (f.series === 'bold') out.push('strong');
  if (f.emph === 'on' || f.shape === 'italic' || f.shape === 'slanted') out.push('em');
  if (f.strikeout === 'on' || f.xout === 'on') out.push('strike');
  if (f.bar === 'under' || f.uuline === 'on' || f.uwave === 'on') out.push('u');
  return out;
}

const DROPPED_FONT: [keyof FontState, string][] = [['noun', 'small caps'], ['size', 'font sizes'], ['color', 'text colours'], ['family', 'font families']];

function noteDropped(w: W, f: FontState): void {
  for (const [k, what] of DROPPED_FONT) {
    const v = f[k];
    if (v === undefined || v === 'default' || v === 'off' || v === 'none' || v === 'inherit') continue;
    if (k === 'family' && v === 'typewriter') continue;
    w.warnings.add(`markdown has no ${what}: written as plain text`);
  }
}

/** an inset as inline markdown */
function insetMd(ins: Inset, w: W, o: InlineOpts, font: FontState = {}): string {
  switch (ins.type) {
    case 'Formula': {
      const { inner, display } = formulaInner(ins.latex);
      if (!inner) return '';
      return display ? '$$' + inner.replace(/\s*\n\s*/g, ' ') + '$$' : '$' + inner + '$';
    }
    case 'Leaf': {
      const pm = paramMap(ins.params);
      if (ins.name === 'Newline') return o.singleLine ? '<br>' : '\\\n';
      if (ins.name === 'Quotes') return ins.arg[2] === 's' ? (ins.arg[1] === 'l' ? '‘' : '’') : (ins.arg[1] === 'l' ? '“' : '”');
      if (ins.name === 'space') return ins.params.some(p => p.includes('~')) || ins.arg.includes('~') ? '\u00a0' : ' ';
      if (ins.name === 'Graphics') {
        const src = (pm.get('filename') ?? '').trim();
        const alt = /alt=\{([^}]*)\}/.exec(pm.get('special') ?? '')?.[1] ?? '';
        if (pm.has('width') || pm.has('height') || pm.has('scale')) w.warnings.add('image sizes are not kept in markdown');
        const img = `![${escapeText(alt, o).replace(/\]/g, '\\]')}](${linkTarget(src)})`;
        const link = pm.get('link');
        return link ? `[${img}](${linkTarget(link.trim())})` : img;
      }
      if (ins.name === 'CommandInset') {
        const name = unquote(pm.get('name'));
        switch (ins.arg) {
          case 'href': {
            const target = unquote(pm.get('target'));
            const type = unquote(pm.get('type'));
            const href = type === 'mailto:' && !target.startsWith('mailto:') ? 'mailto:' + target : target;
            if (!name && /^[a-z][a-z0-9+.-]{1,31}:[^\s<>]*$/i.test(href)) return '<' + href + '>';
            const shown = name || href;
            const label = font.family === 'typewriter' ? codeSpan(shown, o.inTable) : escapeText(shown, o).replace(/\]/g, '\\]');
            return `[${label}](${linkTarget(href)}${linkTitle(unquote(pm.get('title')))})`;
          }
          case 'line': return o.singleLine ? '<hr>' : '<hr>';
          case 'label': w.warnings.add('labels are written as HTML anchors'); return `<a id="${attrQ(name)}"></a>`;
          case 'ref': w.warnings.add('cross-references are written as links'); { const r = unquote(pm.get('reference')); return `[${escapeText(r, o)}](#${r})`; }
          case 'citation': w.warnings.add('citations are written as [@key]'); return '\\[' + unquote(pm.get('key')).split(',').map(k => '@' + k.trim()).join('; ') + ']';
          default: w.warnings.add(`${ins.arg} insets are not kept in markdown`); return '';
        }
      }
      return '';
    }
    case 'Text': return textInsetMd(ins, w, o);
    case 'Tabular': return ins.rows.map(r => r.cells.map(c => inlineMd(flatItems(c.paragraphs), w, { ...o, singleLine: true })).join(' ')).join(' ');
    default: return '';
  }
}

/** a paragraph list's items, paragraphs joined by spaces */
function flatItems(pars: Paragraph[]): Item[] {
  const out: Item[] = [];
  pars.forEach((p, i) => { if (i) out.push({ kind: 'text', text: ' ', font: {} }); out.push(...p.items); });
  return out;
}

function textInsetMd(ins: TextInset, w: W, o: InlineOpts): string {
  const pm = paramMap(ins.params);
  switch (ins.name) {
    case 'Note': return htmlComment(ins.arg, noteLines(ins.paragraphs), !!o.singleLine);
    case 'Foot': {
      let label = w.footLabel.get(ins);
      if (!label) {
        label = unquote(pm.get('label'));
        const taken = new Set(w.footLabel.values());
        // the same footnote referred to twice (`[^a]` … `[^a]`) keeps its label
        if (label && taken.has(label) && w.footnotes.get(label) === footnoteDef(label, ins.paragraphs, w)) { w.footLabel.set(ins, label); return `[^${label}]`; }
        if (!label || taken.has(label)) {
          let k = 1;
          while (w.usedLabels.has(String(k)) || taken.has(String(k))) k++;
          label = String(k);
        }
        w.footLabel.set(ins, label);
        w.footnotes.set(label, footnoteDef(label, ins.paragraphs, w));
        w.footnoteOrder.push(label);
      }
      return `[^${label}]`;
    }
    case 'ERT': return ins.paragraphs.map(p => p.items.map(itemText).join('')).join(o.singleLine ? ' ' : '\n');
    case 'Flex':
      if (ins.arg === 'URL') {
        const url = plainOf(ins.paragraphs);
        return /^[a-z][a-z0-9+.-]{1,31}:[^\s<>]*$/i.test(url) ? '<' + url + '>' : escapeText(url, o);
      }
      w.warnings.add(`${ins.arg} insets are written as their text`);
      return inlineMd(flatItems(ins.paragraphs), w, o);
    case 'script': {
      const tag = ins.arg === 'subscript' ? 'sub' : 'sup';
      return `<${tag}>${inlineMd(flatItems(ins.paragraphs), w, { ...o, singleLine: true })}</${tag}>`;
    }
    case 'listings': return codeSpan(ins.paragraphs.map(p => p.items.map(itemText).join('')).join(' '));
    default:
      w.warnings.add(`${ins.name} insets are written as their text`);
      return inlineMd(flatItems(ins.paragraphs), w, o);
  }
}

const plainOf = (pars: Paragraph[]) => pars.map(p => p.items.map(itemText).join('')).join(' ');

function footnoteDef(label: string, pars: Paragraph[], w: W): string {
  const body = blocksMd(pars.map(p => ({ ...p, layout: p.layout === 'Plain Layout' ? 'Standard' : p.layout })), w).text;
  const lines = body.split('\n');
  return `[^${label}]: ` + lines.map((l, i) => (i && l ? '    ' + l : l)).join('\n');
}

/** inline markdown of a run of items (a paragraph's text) */
function inlineMd(items: Item[], w: W, o: InlineOpts): string {
  const delimited = renderSegs(segments(items, w, o), o, false);
  if (!/[*~]/.test(delimited) || !items.some(i => i.kind === 'text' && fontMarks(i.font).length)) return delimited;
  // `**`/`*`/`~~` only make emphasis where the delimiter rules allow (flanking): if this text does
  // not read back the way the unambiguous HTML tags do, the tags are written
  const html = renderSegs(segments(items, w, o), o, true);
  return sameInline(delimited, html) ? delimited : html;
}

function sameInline(a: string, b: string): boolean {
  try {
    const p = (s: string) => JSON.stringify(parseMarkdown(s).doc.body.map(x => trimEnds(normalize(x.items.flatMap(plainSpaces)))));
    return p(a) === p(b);
  } catch { return false; }
}

/**
 * Emphasis and bold do not show on a space: `*the value* more` (the space moved out of the
 * delimiters) reads back the way `<em>the value </em>more` does.
 */
function plainSpaces(it: Item): Item[] {
  if (it.kind !== 'text' || (!it.font.emph && !it.font.series)) return [it];
  const { emph: _e, series: _s, ...plain } = it.font;
  return it.text.split(/(\s+)/).filter(Boolean).map(t => ({ ...it, text: t, font: /^\s+$/.test(t) ? plain : it.font }));
}

/** the space at the start and end of a paragraph is not written (`<em>typing </em>` at its end reads back as `*typing*` does) */
function trimEnds(items: Item[]): Item[] {
  const out = [...items];
  const first = out[0], last = out[out.length - 1];
  if (first?.kind === 'text') out[0] = { ...first, text: first.text.trimStart() };
  if (last?.kind === 'text') out[out.length - 1] = { ...(out[out.length - 1] as typeof last), text: (out[out.length - 1] as typeof last).text.trimEnd() };
  return out.filter(i => i.kind !== 'text' || i.text);
}

function segments(items: Item[], w: W, o: InlineOpts): Seg[] {
  const segs: Seg[] = [];
  for (let i = 0; i < items.length; i++) {
    const it = items[i];
    if (it.kind === 'text') {
      noteDropped(w, it.font);
      if (it.font.family === 'typewriter') {
        // consecutive code text (with the same other marks / change) is one code span
        let t = it.text;
        while (items[i + 1]?.kind === 'text' && (items[i + 1] as typeof it).font.family === 'typewriter' && fontMarks((items[i + 1] as typeof it).font).join() === fontMarks(it.font).join() && sameChange(items[i + 1].change, it.change)) t += (items[++i] as typeof it).text;
        segs.push({ md: codeSpan(t, o.inTable), marks: fontMarks(it.font), change: it.change, code: true });
        continue;
      }
      segs.push({ md: '', text: it.text, marks: fontMarks(it.font), change: it.change });
    } else if (it.kind === 'special') {
      const t = SPECIAL[it.arg] ?? itemText(it);
      segs.push({ md: '', text: t, marks: fontMarks(it.font), change: it.change });
    } else if (it.kind === 'inset') {
      const isBreak = (x: Item) => x.kind === 'inset' && x.inset.type === 'Leaf' && x.inset.name === 'Newline';
      // a line break that ends the paragraph: markdown drops a trailing backslash break, not a <br>
      const trailing = isBreak(it) && items.slice(i + 1).every(x => isBreak(x) || (x.kind === 'text' && !x.text.trim()));
      const md = trailing ? '<br>' : insetMd(it.inset, w, o, it.font);
      segs.push({ md, marks: it.inset.type === 'Text' && it.inset.name === 'Note' ? [] : fontMarks(it.font), change: it.change, note: it.inset.type === 'Text' && it.inset.name === 'Note' });
    }
  }
  // a comment inside emphasis does not end it: it takes the marks its neighbours share
  segs.forEach((s, k) => {
    if (!s.note) return;
    const prev = segs.slice(0, k).reverse().find(x => !x.note), next = segs.slice(k + 1).find(x => !x.note);
    s.marks = prev && next ? prev.marks.filter(m => next.marks.includes(m)) : [];
  });
  return segs;
}

const SPECIAL: Record<string, string> = { LaTeX: 'LaTeX', TeX: 'TeX', LaTeX2e: 'LaTeX2e', LyX: 'LyX', slash: '/', nobreakdash: '-', textcompwordmark: '', ligaturebreak: '', hyphenation: '' };

function sameChange(a?: Change, b?: Change): boolean {
  if (!a && !b) return true;
  return !!a && !!b && a.type === b.type && a.author === b.author && a.time === b.time;
}

const OPEN: Record<string, [string, string]> = { strong: ['**', '<strong>'], em: ['*', '<em>'], strike: ['~~', '<s>'], u: ['<u>', '<u>'] };
const CLOSE: Record<string, [string, string]> = { strong: ['**', '</strong>'], em: ['*', '</em>'], strike: ['~~', '</s>'], u: ['</u>', '</u>'] };

function renderSegs(segs: Seg[], o: InlineOpts, html: boolean): string {
  type Tok = { t: 'open' | 'close'; k: string; s: string } | { t: 'text'; s: string; raw: boolean };
  const toks: Tok[] = [];
  let stack: string[] = [];
  const changeKey = (c?: Change) => (c ? `change:${c.type}:${c.author}:${c.time}` : '');
  const want = (s: Seg) => [...(s.change ? [changeKey(s.change)] : []), ...MARK_ORDER.filter(m => s.marks.includes(m))];
  const changes = new Map<string, Change>();
  const openTag = (k: string) => {
    if (k.startsWith('change:')) {
      const c = changes.get(k)!;
      const tag = c.type === 'inserted' ? 'ins' : 'del';
      return `<${tag} author="${attrQ(authorName(c.author))}"${c.time ? ` datetime="${iso(c.time)}"` : ''}>`;
    }
    return OPEN[k][html ? 1 : 0];
  };
  const closeTag = (k: string) => (k.startsWith('change:') ? (k.startsWith('change:inserted') ? '</ins>' : '</del>') : CLOSE[k][html ? 1 : 0]);
  const authorName = (id: number) => currentAuthors.get(id) ?? 'Unknown';
  const wants = segs.map(want);
  /** how many segments from `at` on carry `k` */
  const runOf = (k: string, at: number) => { let n = 0; while (at + n < segs.length && wants[at + n].includes(k)) n++; return n; };
  segs.forEach((s, at) => {
    if (s.change) changes.set(changeKey(s.change), s.change);
    const target = wants[at];
    // what is open and still wanted stays open (`*a **b** c*`, not `*a* ***b*** *c*`) …
    let common = 0;
    while (common < stack.length && target.includes(stack[common])) common++;
    for (let i = stack.length - 1; i >= common; i--) toks.push({ t: 'close', k: stack[i], s: closeTag(stack[i]) });
    stack = stack.slice(0, common);
    // … and of the marks opened here, the one that runs longest is outermost
    const opening = target.filter(k => !stack.includes(k)).sort((a, b) => runOf(b, at) - runOf(a, at) || target.indexOf(a) - target.indexOf(b));
    for (const k of opening) { toks.push({ t: 'open', k, s: openTag(k) }); stack.push(k); }
    if (s.text !== undefined) toks.push({ t: 'text', s: s.text, raw: false });
    else toks.push({ t: 'text', s: s.md, raw: true });
  });
  for (let i = stack.length - 1; i >= 0; i--) toks.push({ t: 'close', k: stack[i], s: closeTag(stack[i]) });
  // whitespace moves out of delimiter runs (`** a**` is no emphasis)
  for (let i = 0; i < toks.length && !html; i++) {
    const tk = toks[i];
    if (tk.t !== 'text' || tk.raw) continue;
    let j = i - 1;
    const lead = /^\s+/.exec(tk.s)?.[0] ?? '';
    if (lead && toks[j]?.t === 'open') {
      while (toks[j - 1]?.t === 'open') j--;
      tk.s = tk.s.slice(lead.length);
      toks.splice(j, 0, { t: 'text', s: lead, raw: false });
      i++;
    }
    const trail = /\s+$/.exec(tk.s)?.[0] ?? '';
    if (trail && toks[i + 1]?.t === 'close') {
      let k = i + 1;
      while (toks[k + 1]?.t === 'close') k++;
      tk.s = tk.s.slice(0, tk.s.length - trail.length);
      toks.splice(k + 1, 0, { t: 'text', s: trail, raw: false });
    }
  }
  // empty runs (`****`) are dropped
  for (let i = 0; i + 1 < toks.length; i++) {
    const a = toks[i], b = toks[i + 1];
    if (a.t === 'open' && b.t === 'close' && a.k === b.k) { toks.splice(i, 2); i = Math.max(-1, i - 2); }
  }
  let out = '';
  let lineStart = true;
  for (const tk of toks) {
    if (tk.t !== 'text') { out += tk.s; lineStart = false; continue; }
    if (tk.raw) { out += tk.s; lineStart = tk.s.endsWith('\n'); continue; }
    let s = escapeText(tk.s, o);
    if (lineStart) s = o.listItem && out === '' && /^\[[ xX]\] /.test(tk.s) ? tk.s.slice(0, 4) + escapeLineStart(escapeText(tk.s.slice(4), o)) : escapeLineStart(s);
    out += s;
    if (s) lineStart = false;
  }
  return out.replace(/[ \t]+$/, '').replace(/[ \t]+(\\\n)/g, '$1');
}

/** the authors of the document being written (ids → names), for <ins>/<del> */
let currentAuthors = new Map<number, string>();

/* ------------------------------------------------------------------ blocks */

interface Block { lines: string[]; spans: Map<number, [number, number]> }

interface TreeNode { par: Paragraph; index: number; children: TreeNode[] }

/** paragraphs with depths as a tree (a child sits one level below its parent) */
function treeOf(pars: Paragraph[], offset: number): TreeNode[] {
  const roots: TreeNode[] = [];
  const stack: TreeNode[] = [];
  pars.forEach((par, k) => {
    const node: TreeNode = { par, index: offset + k, children: [] };
    while (stack.length && stack[stack.length - 1].par.depth >= par.depth) stack.pop();
    // a paragraph can only nest in a list item or a quote; elsewhere it is a sibling
    while (stack.length && !NESTING.has(stack[stack.length - 1].par.layout)) stack.pop();
    (stack.length ? stack[stack.length - 1].children : roots).push(node);
    stack.push(node);
  });
  return roots;
}

const NESTING = new Set(['Itemize', 'Enumerate', 'Quote', 'Quotation', 'Description', 'Labeling']);
const isList = (l: string) => l === 'Itemize' || l === 'Enumerate' || l === 'Description' || l === 'Labeling';
const isQuote = (l: string) => l === 'Quote' || l === 'Quotation' || l === 'Verse';

/** a paragraph that is one block inset (code, formula, table, rule, raw HTML), or null */
function soleInset(par: Paragraph): Inset | null {
  const items = par.items.filter(i => !(i.kind === 'text' && !i.text.trim()));
  if (items.length !== 1 || items[0].kind !== 'inset' || items[0].change) return null;
  const ins = items[0].inset;
  if (ins.type === 'Formula' && !ins.inline) return ins;
  if (ins.type === 'Tabular') return ins;
  if (ins.type === 'Leaf' && ins.name === 'CommandInset' && ins.arg === 'line') return ins;
  if (ins.type === 'Text' && ins.name === 'listings' && !/inline true/.test(ins.params.join('\n'))) return ins;
  if (ins.type === 'Text' && ins.name === 'ERT' && ins.paragraphs.length > 1) return ins;
  return null;
}

function codeBlockLines(ins: TextInset): string[] {
  const pm = paramMap(ins.params);
  const lang = /language=([^,"\s]+)/.exec(unquote(pm.get('lstparams')))?.[1] ?? '';
  const lines = ins.paragraphs.map(p => p.items.map(itemText).join(''));
  if (pm.get('indented') === 'true' && !lang && lines.some(l => l.trim()) && lines[0].trim() && lines[lines.length - 1].trim()) return lines.map(l => (l ? '    ' + l : ''));
  let fence = unquote(pm.get('fence')) || '```';
  const ch = fence[0];
  const longest = Math.max(0, ...lines.map(l => (new RegExp('^\\s*(' + (ch === '`' ? '`' : '~') + '+)').exec(l)?.[1].length ?? 0)));
  if (longest >= fence.length) fence = ch.repeat(longest + 1);
  return [fence + lang, ...lines, fence];
}

function tableLines(t: TabularInset, w: W): string[] {
  const ncols = t.columns.length || Math.max(0, ...t.rows.map(r => r.cells.length));
  if (!ncols || !t.rows.length) return [];
  const cell = (pars: Paragraph[]) => pars.map(p => inlineMd(p.items, w, { singleLine: true, inTable: true }).trim()).filter((s, i, a) => s || a.length === 1).join('<br>');
  const rows = t.rows.map(r => Array.from({ length: ncols }, (_, c) => (r.cells[c] ? cell(r.cells[c].paragraphs) : '')));
  if (t.rows.some(r => r.cells.some(c => c.attrs.some(([k, v]) => (k === 'multicolumn' || k === 'multirow') && v !== '0')))) w.warnings.add('merged table cells are written one by one');
  const alignOf = (c: number) => t.columns[c]?.attrs.find(([k]) => k === 'alignment')?.[1] ?? 'left';
  const width = Array.from({ length: ncols }, (_, c) => Math.max(3, ...rows.map(r => [...r[c]].length)));
  const pad = (s: string, c: number) => s + ' '.repeat(Math.max(0, width[c] - [...s].length));
  const sep = Array.from({ length: ncols }, (_, c) => {
    const a = alignOf(c);
    const n = width[c];
    return a === 'center' ? ':' + '-'.repeat(n - 2) + ':' : a === 'right' ? '-'.repeat(n - 1) + ':' : '-'.repeat(n);
  });
  const row = (cells: string[]) => '| ' + cells.map((s, c) => pad(s, c)).join(' | ') + ' |';
  return [row(rows[0]), '| ' + sep.join(' | ') + ' |', ...rows.slice(1).map(row)];
}

/** a paragraph's own lines (its text, or its block), without children or container prefixes */
function parLines(par: Paragraph, w: W, inList: boolean): string[] {
  const level = headingLevel(par.layout);
  if (level) {
    const text = inlineMd(par.items, w, { singleLine: true });
    if (/[\r\n]/.test(text)) w.warnings.add('line breaks in headings are not kept');
    return ['#'.repeat(level) + (text ? ' ' + text.replace(/\s*\n\s*/g, ' ') : '')];
  }
  const ins = soleInset(par);
  if (ins?.type === 'Formula') {
    const { inner } = formulaInner(ins.latex);
    return ['$$', ...inner.split('\n'), '$$'];
  }
  if (ins?.type === 'Tabular') return tableLines(ins, w);
  if (ins?.type === 'Leaf') return ['---'];
  if (ins?.type === 'Text' && ins.name === 'listings') return codeBlockLines(ins);
  if (ins?.type === 'Text' && ins.name === 'ERT') return ins.paragraphs.map(p => p.items.map(itemText).join(''));
  if (!['Standard', 'Plain Layout', 'Itemize', 'Enumerate', 'Quote'].includes(par.layout)) w.warnings.add(`the ${par.layout} layout is written as ${isList(par.layout) ? 'a list' : isQuote(par.layout) ? 'a quote' : 'a paragraph'}`);
  const text = inlineMd(par.items, w, { listItem: inList });
  return text ? text.split('\n') : [];
}

/** blocks of sibling nodes, each followed by its children; `Block` line spans are per paragraph */
function writeNodes(nodes: TreeNode[], w: W): Block {
  const out: Block = { lines: [], spans: new Map() };
  const blank = () => { if (out.lines.length && out.lines[out.lines.length - 1] !== '') out.lines.push(''); };
  const append = (b: Block, prefixFirst: string, prefixRest: string) => {
    const base = out.lines.length;
    b.lines.forEach((l, i) => out.lines.push(l === '' ? (i ? prefixRest : prefixFirst).trimEnd() : (i ? prefixRest : prefixFirst) + l));
    for (const [k, [s, e]] of b.spans) out.spans.set(k, [s + base, e + base]);
  };
  for (let i = 0; i < nodes.length; i++) {
    const n = nodes[i];
    const layout = n.par.layout;
    if (isList(layout)) {
      // one list: the consecutive items of the same kind
      const ordered = layout === 'Enumerate';
      let k = 0;
      blank();
      for (; i < nodes.length && isList(nodes[i].par.layout) && (nodes[i].par.layout === 'Enumerate') === ordered; i++, k++) {
        const item = nodes[i];
        const marker = ordered ? `${k + 1}.` : '-';
        const indent = ' '.repeat(marker.length + 1);
        const own = parLines(item.par, w, true);
        const b: Block = { lines: own.length ? own : [''], spans: new Map([[item.index, [0, Math.max(1, own.length)]]]) };
        const kids = writeNodes(item.children, w);
        if (kids.lines.length) {
          const firstKid = item.children[0];
          if (!isList(firstKid.par.layout) || !own.length) b.lines.push('');
          const base = b.lines.length;
          b.lines.push(...kids.lines);
          for (const [x, [s, e]] of kids.spans) b.spans.set(x, [s + base, e + base]);
        }
        if (k && item.children.some(c => !isList(c.par.layout))) blank();
        else if (k && nodes[i - 1].children.some(c => !isList(c.par.layout))) blank();
        const first = b.lines[0] === '' ? marker : marker + ' ';
        append({ lines: [b.lines[0] === '' ? '' : b.lines[0], ...b.lines.slice(1)], spans: b.spans }, first, indent);
        if (b.lines[0] === '') out.lines[out.lines.length - b.lines.length] = marker;
      }
      i--;
      continue;
    }
    if (isQuote(layout)) {
      // one quote: consecutive quote paragraphs (and what nests in them)
      blank();
      const inner: Block = { lines: [], spans: new Map() };
      for (let first = true; i < nodes.length && isQuote(nodes[i].par.layout); i++, first = false) {
        const q = nodes[i];
        if (!first) inner.lines.push('');
        const own = parLines(q.par, w, false);
        inner.spans.set(q.index, [inner.lines.length, inner.lines.length + Math.max(1, own.length)]);
        inner.lines.push(...(own.length ? own : ['']));
        const kids = writeNodes(q.children, w);
        if (kids.lines.length) {
          inner.lines.push('');
          const base = inner.lines.length;
          inner.lines.push(...kids.lines);
          for (const [x, [s, e]] of kids.spans) inner.spans.set(x, [s + base, e + base]);
        }
      }
      i--;
      append(inner, '> ', '> ');
      continue;
    }
    blank();
    const own = parLines(n.par, w, false);
    out.spans.set(n.index, [out.lines.length, out.lines.length + own.length]);
    out.lines.push(...own);
    if (n.children.length) {
      blank();
      append(writeNodes(n.children, w), '', '');
    }
  }
  return out;
}

function blocksMd(pars: Paragraph[], w: W, offset = 0): { text: string; spans: Map<number, [number, number]> } {
  const b = writeNodes(treeOf(pars, offset), w);
  while (b.lines.length && b.lines[0] === '') { b.lines.shift(); for (const [k, [s, e]] of b.spans) b.spans.set(k, [s - 1, e - 1]); }
  while (b.lines.length && b.lines[b.lines.length - 1] === '') b.lines.pop();
  // line spans → character spans
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

/* ------------------------------------------------------------------ groups: the top-level blocks */

interface Group { from: number; to: number; text: string; spans: Map<number, [number, number]> }

/** body paragraphs → top-level blocks: a list or quote with what nests in it, else one paragraph */
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
    const r = blocksMd(pars, w, start);
    if (!r.text) continue;
    out.push({ from: start, to: i, text: r.text, spans: r.spans });
  }
  return out;
}

function writer(header: Header): W {
  const authors = new Map(getAuthors(header).map(a => [a.id, a.name] as [number, string]));
  return { authors, warnings: new Set(), footnotes: new Map(), footnoteOrder: [], usedLabels: new Set(), footLabel: new Map() };
}

function labelsIn(body: Paragraph[]): Set<string> {
  const out = new Set<string>();
  const walk = (pars: Paragraph[]) => {
    for (const p of pars) for (const it of p.items) {
      if (it.kind !== 'inset') continue;
      const ins = it.inset;
      if (ins.type === 'Text') {
        if (ins.name === 'Foot') { const l = unquote(paramMap(ins.params).get('label')); if (l) out.add(l); }
        walk(ins.paragraphs);
      } else if (ins.type === 'Tabular') for (const r of ins.rows) for (const c of r.cells) walk(c.paragraphs);
    }
  };
  walk(body);
  return out;
}

interface Written { groups: Group[]; footnotes: Map<string, string>; order: string[]; warnings: string[] }

function writeAll(doc: LyxDocument): Written {
  const w = writer(doc.header);
  currentAuthors = w.authors;
  w.usedLabels = labelsIn(doc.body);
  const groups = groupsOf(doc.body, w);
  return { groups, footnotes: w.footnotes, order: [...new Set(w.footnoteOrder)], warnings: [...w.warnings] };
}

const frontMatter = (doc: LyxDocument) => (doc.preamble.length && /^---/.test(doc.preamble[0]) ? doc.preamble.join('\n') + '\n' : '');

/** The document as markdown, written from scratch. */
export function writeMarkdown(doc: LyxDocument): WriteMarkdownResult {
  const wr = writeAll(doc);
  const spans: Span[] = doc.body.map(() => null);
  let text = frontMatter(doc);
  if (text) text += '\n';
  const add = (s: string, g?: Group) => {
    if (text && !text.endsWith('\n\n')) text += text.endsWith('\n') ? '\n' : '\n\n';
    const base = text.length;
    text += s;
    if (g) for (const [k, [a, b]] of g.spans) spans[k] = { start: base + a, end: base + b };
  };
  for (const g of wr.groups) add(g.text, g);
  for (const l of wr.order) add(wr.footnotes.get(l)!);
  return { text: text ? text.replace(/\n*$/, '\n') : '', spans, warnings: wr.warnings };
}

/* ------------------------------------------------------------------ preserving the file's own text */

export interface MarkdownPreserveCache { base?: string; parsed?: ParseMarkdownResult; written?: Written }

interface Unit {
  /** source range in the base text */
  start: number; end: number;
  /** body units: the base groups they consist of (indices into the base's groups); footnote definitions: the label */
  groups?: number[];
  label?: string;
}

/**
 * The document as markdown written into `base` (the file's text): blocks whose markdown did not
 * change keep the file's bytes, the space between them too; writing `parseMarkdown(base).doc`
 * gives `base` back.
 */
export function writeMarkdownPreserving(doc: LyxDocument, base: string | null, cache: MarkdownPreserveCache = {}): WriteMarkdownResult {
  if (base === null || !base.trim()) return writeMarkdown(doc);
  if (cache.base !== base || !cache.parsed || !cache.written) {
    cache.base = base;
    cache.parsed = parseMarkdown(base);
    cache.written = writeAll(cache.parsed.doc);
  }
  const parsed = cache.parsed, bw = cache.written;
  const nw = writeAll(doc);

  // base units: the base groups, merged where they share a block of the source; footnote definitions
  const units: Unit[] = [];
  const groupUnit = new Map<number, Unit>();
  bw.groups.forEach((g, gi) => {
    const nodes = parsed.parNode.slice(g.from, g.to).filter(n => n >= 0);
    if (!nodes.length) return;
    const lo = Math.min(...nodes), hi = Math.max(...nodes);
    const start = parsed.nodes[lo].start, end = parsed.nodes[hi].end;
    const last = units[units.length - 1];
    if (last?.groups && start < last.end) { last.end = Math.max(last.end, end); last.groups.push(gi); groupUnit.set(gi, last); return; }
    const u: Unit = { start, end, groups: [gi] };
    units.push(u);
    groupUnit.set(gi, u);
  });
  for (const n of parsed.nodes) if (n.footnote !== undefined) units.push({ start: n.start, end: n.end, label: n.footnote });
  units.sort((a, b) => a.start - b.start);
  // overlapping units (a footnote definition inside a list item): the outer one wins
  for (let i = 1; i < units.length; i++) if (units[i].start < units[i - 1].end) { units.splice(i, 1); i--; }

  const pairs = align(bw.groups.map(g => g.text), nw.groups.map(g => g.text));
  const newOf = new Map<number, number>(pairs);
  // a body unit is kept when all its groups are matched, to consecutive new groups
  const kept = new Map<Unit, number>();   // unit → first new group
  for (const u of units) {
    if (!u.groups) continue;
    const js = u.groups.map(g => newOf.get(g));
    if (js.every((j, k) => j !== undefined && j === js[0]! + k)) kept.set(u, js[0]!);
  }
  const keptStart = new Map<number, Unit>([...kept].map(([u, j]) => [j, u]));

  const spans: Span[] = doc.body.map(() => null);
  // leading text (front matter, blank lines, link definitions before the first block)
  const lead = base.slice(0, units[0]?.start ?? base.length);
  let text = frontMatter(doc) === frontMatter(parsed.doc) ? lead : frontMatter(doc) + (frontMatter(doc) ? '\n' : '') + lead.slice(frontMatter(parsed.doc).length).replace(/^\n+/, '');
  let wrote = false;
  let prevUnit = -1;   // the base unit written last (-1: a new block was)
  const gapKept = new Set<number>();   // gap i: between units[i] and units[i + 1]
  const sep = (ui: number) => {
    if (!wrote) { wrote = true; return; }
    if (prevUnit >= 0 && ui === prevUnit + 1) { text += base.slice(units[prevUnit].end, units[ui].start); gapKept.add(prevUnit); return; }
    text = text.replace(/\n*$/, '') + '\n\n';
  };
  const writeBase = (ui: number, j?: number) => {
    const u = units[ui];
    sep(ui);
    const at = text.length;
    text += base.slice(u.start, u.end);
    prevUnit = ui;
    if (j === undefined || !u.groups) return;
    // the paragraphs' spans: the base parse's own, shifted
    let k = j;
    for (const gi of u.groups) {
      const bg = bw.groups[gi], ng = nw.groups[k++];
      for (let p = 0; p < ng.to - ng.from && bg.from + p < bg.to; p++) {
        const s = parsed.parSpans[bg.from + p];
        if (s) spans[ng.from + p] = { start: at + s.start - u.start, end: at + s.end - u.start };
      }
    }
  };
  const writeNew = (s: string, g?: Group) => {
    sep(-1);
    const at = text.length;
    text += s;
    prevUnit = -1;
    if (g) for (const [k, [a2, b2]] of g.spans) spans[k] = { start: at + a2, end: at + b2 };
  };
  let j = 0;
  const flushNew = (upTo: number) => { for (; j < upTo; j++) if (!keptStart.has(j)) writeNew(nw.groups[j].text, nw.groups[j]); };
  const footDone = new Set<string>();
  // the new block that the next kept block after unit ui starts (new blocks before it come first)
  const nextKept = (ui: number) => { for (let k = ui + 1; k < units.length; k++) { const at = kept.get(units[k]); if (at !== undefined) return at; } return nw.groups.length; };
  units.forEach((u, ui) => {
    if (u.label !== undefined) {
      // footnote definitions (usually at the end) come after the blocks edited before them
      flushNew(nextKept(ui));
      if (!nw.footnotes.has(u.label)) {
        if (!bw.footnotes.has(u.label)) writeBase(ui);   // a definition nothing refers to stays as it is
        return;
      }
      footDone.add(u.label);
      if (bw.footnotes.get(u.label) === nw.footnotes.get(u.label)) writeBase(ui);
      else writeNew(nw.footnotes.get(u.label)!);
      return;
    }
    const at = kept.get(u);
    if (at === undefined) return;
    flushNew(at);
    writeBase(ui, at);
    j = at + u.groups!.length;
  });
  flushNew(nw.groups.length);
  for (const l of nw.order) if (!footDone.has(l)) writeNew(nw.footnotes.get(l)!);
  // reference link definitions in the space around blocks that went away
  const defs = units.slice(0, -1).flatMap((u, i) => (gapKept.has(i) ? [] : base.slice(u.end, units[i + 1].start).split('\n').filter(l => /^\s{0,3}\[[^\]]+\]:/.test(l))));
  if (defs.length) writeNew([...new Set(defs)].join('\n'));
  // the text after the last block
  if (units.length && prevUnit === units.length - 1) text += base.slice(units[units.length - 1].end);
  else if (text.trim()) text = text.replace(/\n*$/, '\n');
  return { text, spans, warnings: nw.warnings };
}

/** Warnings about what this document loses when written as markdown (nothing for one that came from markdown). */
export function markdownWarnings(doc: LyxDocument): string[] {
  return writeAll(doc).warnings;
}

