/**
 * ProseMirror schema for OverLyX documents.
 *
 * The schema mirrors LyX's document model rather than HTML:
 *  - the document is a flat list of paragraphs, each with a `layout` (Standard, Section,
 *    Itemize, ...) and a nesting `depth` (LyX \begin_deeper);
 *  - insets are *inline* nodes; the ones that contain text contain paragraphs (block+),
 *    exactly like LyX (a Note or Footnote sits inside a paragraph and holds paragraphs);
 *  - font attributes (emph, series, shape, ...) and change tracking are marks carrying the
 *    LyX value, so that anything LyX can express round-trips losslessly.
 */
import { Schema, type NodeSpec, type MarkSpec, type DOMOutputSpec } from 'prosemirror-model';

const jsonAttr = (def: unknown) => ({ default: JSON.stringify(def) });

export const INSET_NAMES_WITH_STATUS = new Set([
  'Note', 'ERT', 'Foot', 'Marginal', 'Float', 'Wrap', 'Box', 'Branch', 'Flex', 'Argument', 'Index',
  'listings', 'script', 'Phantom', 'IPA', 'IPADeco', 'Preview',
]);

function insetDOM(node: { attrs: Record<string, any> }): DOMOutputSpec {
  const cls = `lyx-inset lyx-inset-${node.attrs.name.toLowerCase()}` +
    (node.attrs.arg ? ` lyx-inset-${node.attrs.name.toLowerCase()}-${String(node.attrs.arg).toLowerCase().replace(/[^a-z0-9]+/g, '-')}` : '') +
    (node.attrs.status === 'collapsed' ? ' collapsed' : '');
  return ['span', { class: cls, 'data-name': node.attrs.name, 'data-arg': node.attrs.arg }, 0];
}

const nodes: Record<string, NodeSpec> = {
  doc: { content: 'paragraph+' },

  paragraph: {
    content: 'inline*',
    group: 'block',
    attrs: {
      layout: { default: 'Standard' },
      depth: { default: 0 },
      align: { default: null },
      noindent: { default: false },
      labelwidthstring: { default: null },
      spacing: { default: null },
      leftindent: { default: null },
      appendix: { default: false },
      endChange: { default: null },
    },
    parseDOM: [{ tag: 'p', getAttrs: (dom: HTMLElement) => ({ layout: dom.getAttribute('data-layout') || 'Standard', depth: Number(dom.getAttribute('data-depth') || 0) }) }],
    toDOM(node) {
      const a = node.attrs;
      const cls = 'lyx-par lyx-layout-' + String(a.layout).toLowerCase().replace(/[^a-z0-9*]+/g, '-').replace(/\*/g, 'star');
      const attrs: Record<string, string> = { class: cls, 'data-layout': a.layout, 'data-depth': String(a.depth) };
      if (a.align) attrs['data-align'] = a.align;
      if (a.noindent) attrs['data-noindent'] = '1';
      return ['p', attrs, 0];
    },
  },

  text: { group: 'inline' },

  /** Inline formula ($...$). `latex` is the content without delimiters. */
  math_inline: {
    inline: true, group: 'inline', atom: true,
    attrs: { latex: { default: '' }, delim: { default: '$' } },
    toDOM: node => ['span', { class: 'lyx-math-inline', 'data-latex': node.attrs.latex }, node.attrs.latex],
    parseDOM: [{ tag: 'span.lyx-math-inline', getAttrs: (d: HTMLElement) => ({ latex: d.getAttribute('data-latex') ?? '' }) }],
  },

  /**
   * Display formula. `latex` is the verbatim LyX formula text, e.g.
   * "\begin{align}\n a &= b \label{eq:x}\n\end{align}" or "\[\n x \n\]".
   */
  math_display: {
    inline: true, group: 'inline', atom: true,
    attrs: { latex: { default: '\\[\n\n\\]' } },
    toDOM: node => ['span', { class: 'lyx-math-display', 'data-latex': node.attrs.latex }, node.attrs.latex],
    parseDOM: [{ tag: 'span.lyx-math-display', getAttrs: (d: HTMLElement) => ({ latex: d.getAttribute('data-latex') ?? '' }) }],
  },

  /** FormulaMacro inset: LyX macro definition lines (\newcommand... + optional display form). */
  macro: {
    inline: true, group: 'inline', atom: true,
    attrs: { lines: jsonAttr([]) },
    toDOM: node => ['span', { class: 'lyx-macro', 'data-lines': node.attrs.lines }, JSON.parse(node.attrs.lines)[0] ?? ''],
  },

  /**
   * Generic text-containing inset (Note, ERT, Foot, Marginal, Float, Wrap, Box, Branch, Flex,
   * Argument, Index, Listings, Caption, script, ...). `name`/`arg` are LyX's first-line words,
   * `params` the verbatim parameter lines, `status` open/collapsed (null when LyX has no status line).
   */
  inset: {
    inline: true, group: 'inline',
    content: 'block+',
    isolating: true,
    defining: true,
    attrs: {
      name: { default: 'Note' },
      arg: { default: 'Note' },
      params: jsonAttr([]),
      status: { default: 'open' },
    },
    toDOM: insetDOM,
    parseDOM: [{ tag: 'span.lyx-inset', getAttrs: (d: HTMLElement) => ({ name: d.getAttribute('data-name') || 'Note', arg: d.getAttribute('data-arg') || '' }) }],
  },

  /** LyX tabular. Inline like in LyX; content are table rows. */
  table: {
    inline: true, group: 'inline',
    content: 'table_row+',
    tableRole: 'table',
    isolating: true,
    attrs: { attrs: jsonAttr([]), features: jsonAttr([]), columns: jsonAttr([]) },
    toDOM: () => ['span', { class: 'lyx-tabular' }, ['table', ['tbody', 0]]],
  },
  table_row: {
    content: '(table_cell | table_header)*',
    tableRole: 'row',
    attrs: { attrs: jsonAttr([]) },
    toDOM: () => ['tr', 0],
  },
  table_cell: {
    content: 'block+',
    tableRole: 'cell',
    isolating: true,
    attrs: {
      colspan: { default: 1 }, rowspan: { default: 1 }, colwidth: { default: null },
      attrs: jsonAttr([]),
      /** verbatim attrs of LyX multicolumn/multirow continuation cells (lossless round trip) */
      cont: jsonAttr([]),
      contContent: { default: null },
    },
    toDOM(node) {
      const a: Record<string, string> = {};
      if (node.attrs.colspan !== 1) a.colspan = String(node.attrs.colspan);
      if (node.attrs.rowspan !== 1) a.rowspan = String(node.attrs.rowspan);
      const m = new Map<string, string>(JSON.parse(node.attrs.attrs));
      const cls: string[] = ['lyx-cell'];
      for (const k of ['topline', 'bottomline', 'leftline', 'rightline']) if (m.get(k) === 'true') cls.push(k);
      if (m.get('alignment')) cls.push('align-' + m.get('alignment'));
      a.class = cls.join(' ');
      return ['td', a, 0];
    },
  },
  table_header: {
    content: 'block+',
    tableRole: 'header_cell',
    isolating: true,
    attrs: { colspan: { default: 1 }, rowspan: { default: 1 }, colwidth: { default: null }, attrs: jsonAttr([]) },
    toDOM: () => ['th', 0],
  },

  /** CommandInset (ref, label, cite, href, include, bibtex, index_print, toc, nomenclature, ...). */
  command: {
    inline: true, group: 'inline', atom: true,
    attrs: { cmd: { default: 'ref' }, params: jsonAttr([]) },
    toDOM: node => ['span', { class: 'lyx-command lyx-command-' + node.attrs.cmd, 'data-cmd': node.attrs.cmd, 'data-params': node.attrs.params }],
  },

  graphics: {
    inline: true, group: 'inline', atom: true,
    attrs: { params: jsonAttr([]) },
    toDOM: node => ['span', { class: 'lyx-graphics', 'data-params': node.attrs.params }],
  },

  quotes: {
    inline: true, group: 'inline', atom: true,
    attrs: { kind: { default: 'eld' } },
    toDOM: node => ['span', { class: 'lyx-quotes', 'data-kind': node.attrs.kind }, quoteChar(node.attrs.kind)],
  },

  space: {
    inline: true, group: 'inline', atom: true,
    attrs: { kind: { default: '~' }, params: jsonAttr([]) },
    toDOM: node => ['span', { class: 'lyx-space', 'data-kind': node.attrs.kind, title: 'space ' + node.attrs.kind }, spaceChar(node.attrs.kind)],
  },

  newline: {
    inline: true, group: 'inline', atom: true,
    attrs: { kind: { default: 'newline' } },
    toDOM: node => ['span', { class: 'lyx-newline lyx-newline-' + node.attrs.kind }, ['br']],
  },

  newpage: {
    inline: true, group: 'inline', atom: true,
    attrs: { kind: { default: 'newpage' } },
    toDOM: node => ['span', { class: 'lyx-newpage', 'data-kind': node.attrs.kind }, node.attrs.kind],
  },

  /** \SpecialChar etc. */
  special: {
    inline: true, group: 'inline', atom: true,
    attrs: { token: { default: '\\SpecialChar' }, arg: { default: 'ldots' } },
    toDOM: node => ['span', { class: 'lyx-special', 'data-arg': node.attrs.arg, 'data-token': node.attrs.token }, specialText(node.attrs.token, node.attrs.arg)],
  },

  /** Any other leaf inset (VSpace, Info, External, Separator, line, Nomenclature ...) kept verbatim. */
  leaf: {
    inline: true, group: 'inline', atom: true,
    attrs: { name: { default: '' }, arg: { default: '' }, params: jsonAttr([]) },
    toDOM: node => ['span', { class: 'lyx-leaf lyx-leaf-' + String(node.attrs.name).toLowerCase(), 'data-name': node.attrs.name, 'data-arg': node.attrs.arg }, node.attrs.name + (node.attrs.arg ? ' ' + node.attrs.arg : '')],
  },

  /** Unknown inset, body verbatim. */
  raw: {
    inline: true, group: 'inline', atom: true,
    attrs: { firstLine: { default: '' }, lines: jsonAttr([]) },
    toDOM: node => ['span', { class: 'lyx-raw' }, node.attrs.firstLine],
  },

  /** Unknown paragraph token, verbatim. */
  unknown: {
    inline: true, group: 'inline', atom: true,
    attrs: { line: { default: '' } },
    toDOM: node => ['span', { class: 'lyx-unknown' }, node.attrs.line],
  },
};

function valueMark(name: string, dom: (v: string) => DOMOutputSpec, extra: Partial<MarkSpec> = {}): MarkSpec {
  return {
    attrs: { value: { default: 'on' } },
    toDOM: m => dom(m.attrs.value),
    parseDOM: [{ tag: `span[data-${name}]`, getAttrs: (d: HTMLElement) => ({ value: d.getAttribute('data-' + name) }) }],
    ...extra,
  };
}

const marks: Record<string, MarkSpec> = {
  emph: valueMark('emph', v => ['span', { class: 'lyx-emph-' + v, 'data-emph': v }, 0]),
  series: valueMark('series', v => ['span', { class: 'lyx-series-' + v, 'data-series': v }, 0]),
  shape: valueMark('shape', v => ['span', { class: 'lyx-shape-' + v, 'data-shape': v }, 0]),
  family: valueMark('family', v => ['span', { class: 'lyx-family-' + v, 'data-family': v }, 0]),
  size: valueMark('size', v => ['span', { class: 'lyx-size-' + v, 'data-size': v }, 0]),
  bar: valueMark('bar', v => ['span', { class: 'lyx-bar-' + v, 'data-bar': v }, 0]),
  strikeout: valueMark('strikeout', v => ['span', { class: 'lyx-strikeout-' + v, 'data-strikeout': v }, 0]),
  xout: valueMark('xout', v => ['span', { class: 'lyx-xout-' + v, 'data-xout': v }, 0]),
  uuline: valueMark('uuline', v => ['span', { class: 'lyx-uuline-' + v, 'data-uuline': v }, 0]),
  uwave: valueMark('uwave', v => ['span', { class: 'lyx-uwave-' + v, 'data-uwave': v }, 0]),
  noun: valueMark('noun', v => ['span', { class: 'lyx-noun-' + v, 'data-noun': v }, 0]),
  numeric: valueMark('numeric', v => ['span', { class: 'lyx-numeric-' + v, 'data-numeric': v }, 0]),
  nospellcheck: valueMark('nospellcheck', v => ['span', { 'data-nospellcheck': v }, 0]),
  color: valueMark('color', v => ['span', { class: 'lyx-color-' + v, 'data-color': v }, 0]),
  lang: valueMark('lang', v => ['span', { class: 'lyx-lang', 'data-lang': v, lang: v === 'latex' ? undefined : v }, 0]),
  /** change tracking */
  change: {
    attrs: { type: { default: 'inserted' }, author: { default: 0 }, time: { default: 0 } },
    inclusive: true,
    toDOM: m => ['span', { class: 'lyx-change lyx-change-' + m.attrs.type, 'data-change': m.attrs.type, 'data-author': String(m.attrs.author), 'data-time': String(m.attrs.time) }, 0],
    parseDOM: [{ tag: 'span[data-change]', getAttrs: (d: HTMLElement) => ({ type: d.getAttribute('data-change'), author: Number(d.getAttribute('data-author')), time: Number(d.getAttribute('data-time')) }) }],
  },
};

// y-prosemirror does not persist marks on non-text nodes: inline nodes carry LyX's font/change
// state for the inset position in a `marks` attribute (JSON list of {type, attrs}) instead.
for (const [name, spec] of Object.entries(nodes)) {
  if (name === 'doc' || name === 'text' || spec.group !== 'inline') continue;
  spec.attrs = { ...(spec.attrs ?? {}), marks: jsonAttr([]) };
}

export const FONT_MARKS = ['family', 'series', 'shape', 'size', 'emph', 'numeric', 'nospellcheck', 'bar', 'strikeout', 'xout', 'uuline', 'uwave', 'noun', 'color', 'lang'] as const;

export const schema = new Schema({ nodes, marks });
export type LyxSchema = typeof schema;

export function quoteChar(kind: string): string {
  // LyX quote type: [style][side][level]: e.g. "eld" = english left double, "grs" = german right single
  const side = kind[1] === 'l' ? 'l' : 'r';
  const level = kind[2] === 's' ? 's' : 'd';
  const style = kind[0];
  const table: Record<string, [string, string, string, string]> = {
    // [ld, rd, ls, rs]
    e: ['\u201C', '\u201D', '\u2018', '\u2019'],
    s: ['\u201D', '\u201D', '\u2019', '\u2019'],
    g: ['\u201E', '\u201C', '\u201A', '\u2018'],
    p: ['\u201E', '\u201D', '\u201A', '\u2019'],
    f: ['\u00AB', '\u00BB', '\u2039', '\u203A'],
    a: ['\u00BB', '\u00AB', '\u203A', '\u2039'],
    q: ['"', '"', "'", "'"],
    b: ['\u201C', '\u201D', '\u2018', '\u2019'],
    w: ['\u00AB', '\u00BB', '\u2039', '\u203A'],
    d: ['\u201E', '\u201C', '\u201A', '\u2018'],
    i: ['\u00AB', '\u00BB', '\u2039', '\u203A'],
    r: ['\u00AB', '\u00BB', '\u201E', '\u201C'],
    c: ['\u201C', '\u201D', '\u2018', '\u2019'],
    j: ['\u300C', '\u300D', '\u300E', '\u300F'],
    k: ['\u300E', '\u300F', '\u300C', '\u300D'],
    h: ['\u201C', '\u201D', '\u2018', '\u2019'],
    x: ['\u201C', '\u201D', '\u2018', '\u2019'],
  };
  const t = table[style] ?? table.e;
  return level === 'd' ? (side === 'l' ? t[0] : t[1]) : (side === 'l' ? t[2] : t[3]);
}

export function spaceChar(kind: string): string {
  switch (kind) {
    case '~': return '\u00A0';
    case '\\space{}': return ' ';
    case '\\thinspace{}': return '\u2009';
    case '\\negthinspace{}': return '';
    case '\\quad{}': return '\u2003';
    case '\\qquad{}': return '\u2003\u2003';
    case '\\enspace{}': return '\u2002';
    case '\\enskip{}': return '\u2002';
    case '\\hfill{}': return '\u2003\u2003\u2003';
    case '\\textvisiblespace{}': return '\u2423';
    default: return ' ';
  }
}

export function specialText(token: string, arg: string): string {
  if (token === '\\twohyphens') return '\u2013';
  if (token === '\\threehyphens') return '\u2014';
  switch (arg) {
    case 'nobreakdash': return '-';
    case 'ldots': case '\\ldots{}': return '\u2026';
    case 'endofsentence': case '\\@.': return '.';
    case 'menuseparator': case '\\menuseparator': return '\u25B9';
    case 'softhyphen': case '\\-': return '\u00AD';
    case 'ligaturebreak': case '\\textcompwordmark{}': return '\u200C';
    case 'allowbreak': return '\u200B';
    case 'breakableslash': case '\\slash{}': return '/';
    case 'LyX': return 'LyX';
    case 'TeX': return 'TeX';
    case 'LaTeX': return 'LaTeX';
    case 'LaTeX2e': return 'LaTeX2e';
    default: return arg;
  }
}
