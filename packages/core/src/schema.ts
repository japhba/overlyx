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
const attr = (d: HTMLElement, name: string, def: string) => d.getAttribute(name) ?? def;
/** a JSON attribute from the DOM: only accepted when it parses (foreign HTML never sets them) */
const jsonFrom = (d: HTMLElement, name: string, def: string) => { const v = d.getAttribute(name); if (v === null) return def; try { JSON.parse(v); return v; } catch { return def; } };
/** LyX's defaults for a table cell / column that did not come from a LyX file (pasted HTML) */
export const DEFAULT_CELL_ATTRS: [string, string][] = [['alignment', 'center'], ['valignment', 'top'], ['usebox', 'none']];
export const DEFAULT_COLUMN_ATTRS: [string, string][] = [['alignment', 'center'], ['valignment', 'top']];
const DEFAULT_TABLE_ATTRS: [string, string][] = [['version', '3']];
const DEFAULT_TABLE_FEATURES: [string, string][] = [['tabularvalignment', 'middle']];
const LAYOUT_OF_TAG: Record<string, string> = { h1: 'Section', h2: 'Subsection', h3: 'Subsubsection', h4: 'Paragraph', h5: 'Subparagraph', h6: 'Subparagraph', li: 'Itemize' };

export const INSET_NAMES_WITH_STATUS = new Set([
  'Note', 'ERT', 'Foot', 'Marginal', 'Float', 'Wrap', 'Box', 'Branch', 'Flex', 'Argument', 'Index',
  'listings', 'script', 'Phantom', 'IPA', 'IPADeco', 'Preview',
]);

function insetDOM(node: { attrs: Record<string, any> }): DOMOutputSpec {
  const cls = `lyx-inset lyx-inset-${node.attrs.name.toLowerCase()}` +
    (node.attrs.arg ? ` lyx-inset-${node.attrs.name.toLowerCase()}-${String(node.attrs.arg).toLowerCase().replace(/[^a-z0-9]+/g, '-')}` : '') +
    (node.attrs.status === 'collapsed' ? ' collapsed' : '');
  return ['span', { class: cls, 'data-name': node.attrs.name, 'data-arg': node.attrs.arg, 'data-params': node.attrs.params, 'data-status': node.attrs.status ?? '' }, 0];
}

/** Add `data-marks` (the LyX font / change state of an inline node) to a DOM output spec. */
function withMarks(spec: DOMOutputSpec, marks: string): DOMOutputSpec {
  if (!marks || marks === '[]' || !Array.isArray(spec)) return spec;
  const [tag, second, ...rest] = spec as [string, unknown, ...unknown[]];
  if (second && typeof second === 'object' && !Array.isArray(second) && !(typeof Node !== 'undefined' && second instanceof Node)) return [tag, { ...(second as Record<string, unknown>), 'data-marks': marks }, ...rest] as DOMOutputSpec;
  return [tag, { 'data-marks': marks }, ...(second === undefined ? [] : [second]), ...rest] as DOMOutputSpec;
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
    parseDOM: [
      { tag: 'p', getAttrs: (dom: HTMLElement) => ({
        layout: dom.getAttribute('data-layout') || 'Standard', depth: Number(dom.getAttribute('data-depth') || 0),
        align: dom.getAttribute('data-align'), noindent: dom.getAttribute('data-noindent') === '1',
        labelwidthstring: dom.getAttribute('data-labelwidthstring'), spacing: dom.getAttribute('data-spacing'), leftindent: dom.getAttribute('data-leftindent'),
        appendix: dom.getAttribute('data-appendix') === '1',
        endChange: (() => { try { const v = dom.getAttribute('data-end-change'); return v ? JSON.parse(v) : null; } catch { return null; } })(),
      }) },
      // foreign HTML (a web page, Google Docs, …): headings and list items become LyX layouts
      ...Object.entries(LAYOUT_OF_TAG).map(([tag, layout]) => ({ tag, getAttrs: () => ({ layout }) })),
    ],
    toDOM(node) {
      const a = node.attrs;
      const cls = 'lyx-par lyx-layout-' + String(a.layout).toLowerCase().replace(/[^a-z0-9*]+/g, '-').replace(/\*/g, 'star');
      const attrs: Record<string, string> = { class: cls, 'data-layout': a.layout, 'data-depth': String(a.depth) };
      if (a.align) attrs['data-align'] = a.align;
      if (a.noindent) attrs['data-noindent'] = '1';
      if (a.labelwidthstring) attrs['data-labelwidthstring'] = a.labelwidthstring;
      if (a.spacing) attrs['data-spacing'] = a.spacing;
      if (a.leftindent) attrs['data-leftindent'] = a.leftindent;
      if (a.appendix) attrs['data-appendix'] = '1';
      if (a.endChange) attrs['data-end-change'] = JSON.stringify(a.endChange);
      return ['p', attrs, 0];
    },
  },

  text: { group: 'inline' },

  /** Inline formula ($...$). `latex` is the content without delimiters. */
  math_inline: {
    inline: true, group: 'inline', atom: true,
    attrs: { latex: { default: '' }, delim: { default: '$' } },
    toDOM: node => ['span', { class: 'lyx-math-inline', 'data-latex': node.attrs.latex, 'data-delim': node.attrs.delim }, node.attrs.latex],
    parseDOM: [{ tag: 'span.lyx-math-inline', getAttrs: (d: HTMLElement) => ({ latex: d.getAttribute('data-latex') ?? '', delim: d.getAttribute('data-delim') ?? '$' }) }],
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
    parseDOM: [{ tag: 'span.lyx-macro', getAttrs: (d: HTMLElement) => ({ lines: jsonFrom(d, 'data-lines', '[]') }) }],
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
    parseDOM: [{ tag: 'span.lyx-inset', getAttrs: (d: HTMLElement) => ({ name: d.getAttribute('data-name') || 'Note', arg: d.getAttribute('data-arg') || '', params: jsonFrom(d, 'data-params', '[]'), status: d.hasAttribute('data-status') ? d.getAttribute('data-status') || null : 'open' }) }],
  },

  /** LyX tabular. Inline like in LyX; content are table rows. */
  table: {
    inline: true, group: 'inline',
    content: 'table_row+',
    tableRole: 'table',
    isolating: true,
    attrs: { attrs: jsonAttr([]), features: jsonAttr([]), columns: jsonAttr([]) },
    toDOM: node => ['span', { class: 'lyx-tabular', 'data-attrs': node.attrs.attrs, 'data-features': node.attrs.features, 'data-columns': node.attrs.columns }, ['table', ['tbody', 0]]],
    parseDOM: [
      { tag: 'span.lyx-tabular', contentElement: 'tbody', getAttrs: (d: HTMLElement) => ({ attrs: jsonFrom(d, 'data-attrs', '[]'), features: jsonFrom(d, 'data-features', '[]'), columns: jsonFrom(d, 'data-columns', '[]') }) },
      // a foreign HTML table: columns get LyX's defaults (the converter fills in what is missing)
      { tag: 'table', contentElement: (d: HTMLElement) => d.querySelector('tbody') ?? d, getAttrs: (d: HTMLElement) => {
        if (d.parentElement?.classList.contains('lyx-tabular')) return false;
        const first = d.querySelector('tr');
        const n = first ? Array.from(first.children).reduce((s, c) => s + (Number((c as HTMLElement).getAttribute('colspan')) || 1), 0) : 1;
        return { attrs: JSON.stringify(DEFAULT_TABLE_ATTRS), features: JSON.stringify(DEFAULT_TABLE_FEATURES), columns: JSON.stringify(Array.from({ length: n }, () => DEFAULT_COLUMN_ATTRS)) };
      } },
    ],
  },
  table_row: {
    content: '(table_cell | table_header)*',
    tableRole: 'row',
    attrs: { attrs: jsonAttr([]) },
    toDOM: node => ['tr', { 'data-attrs': node.attrs.attrs }, 0],
    parseDOM: [{ tag: 'tr', getAttrs: (d: HTMLElement) => ({ attrs: jsonFrom(d, 'data-attrs', '[]') }) }],
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
      a['data-attrs'] = node.attrs.attrs;
      if (node.attrs.cont !== '[]') a['data-cont'] = node.attrs.cont;
      if (node.attrs.contContent) a['data-cont-content'] = node.attrs.contContent;
      return ['td', a, 0];
    },
    parseDOM: [{ tag: 'td', getAttrs: (d: HTMLElement) => ({
      colspan: Number(d.getAttribute('colspan')) || 1, rowspan: Number(d.getAttribute('rowspan')) || 1,
      attrs: jsonFrom(d, 'data-attrs', JSON.stringify(DEFAULT_CELL_ATTRS)), cont: jsonFrom(d, 'data-cont', '[]'), contContent: d.getAttribute('data-cont-content'),
    }) }],
  },
  table_header: {
    content: 'block+',
    tableRole: 'header_cell',
    isolating: true,
    attrs: { colspan: { default: 1 }, rowspan: { default: 1 }, colwidth: { default: null }, attrs: jsonAttr([]) },
    toDOM: node => ['th', { 'data-attrs': node.attrs.attrs }, 0],
    parseDOM: [{ tag: 'th', getAttrs: (d: HTMLElement) => ({ colspan: Number(d.getAttribute('colspan')) || 1, rowspan: Number(d.getAttribute('rowspan')) || 1, attrs: jsonFrom(d, 'data-attrs', JSON.stringify([['alignment', 'center'], ['valignment', 'top'], ['topline', 'true'], ['bottomline', 'true'], ['usebox', 'none']])) }) }],
  },

  /** CommandInset (ref, label, cite, href, include, bibtex, index_print, toc, nomenclature, ...). */
  command: {
    inline: true, group: 'inline', atom: true,
    attrs: { cmd: { default: 'ref' }, params: jsonAttr([]) },
    toDOM: node => ['span', { class: 'lyx-command lyx-command-' + node.attrs.cmd, 'data-cmd': node.attrs.cmd, 'data-params': node.attrs.params }],
    parseDOM: [{ tag: 'span.lyx-command', getAttrs: (d: HTMLElement) => ({ cmd: attr(d, 'data-cmd', 'ref'), params: jsonFrom(d, 'data-params', '[]') }) }],
  },

  graphics: {
    inline: true, group: 'inline', atom: true,
    attrs: { params: jsonAttr([]) },
    toDOM: node => ['span', { class: 'lyx-graphics', 'data-params': node.attrs.params }],
    parseDOM: [{ tag: 'span.lyx-graphics', getAttrs: (d: HTMLElement) => ({ params: jsonFrom(d, 'data-params', '[]') }) }],
  },

  quotes: {
    inline: true, group: 'inline', atom: true,
    attrs: { kind: { default: 'eld' } },
    toDOM: node => ['span', { class: 'lyx-quotes', 'data-kind': node.attrs.kind }, quoteChar(node.attrs.kind)],
    parseDOM: [{ tag: 'span.lyx-quotes', getAttrs: (d: HTMLElement) => ({ kind: attr(d, 'data-kind', 'eld') }) }],
  },

  space: {
    inline: true, group: 'inline', atom: true,
    attrs: { kind: { default: '~' }, params: jsonAttr([]) },
    toDOM: node => ['span', { class: 'lyx-space', 'data-kind': node.attrs.kind, 'data-params': node.attrs.params, title: 'space ' + node.attrs.kind }, spaceChar(node.attrs.kind)],
    parseDOM: [{ tag: 'span.lyx-space', getAttrs: (d: HTMLElement) => ({ kind: attr(d, 'data-kind', '~'), params: jsonFrom(d, 'data-params', '[]') }) }],
  },

  newline: {
    inline: true, group: 'inline', atom: true,
    attrs: { kind: { default: 'newline' } },
    toDOM: node => ['span', { class: 'lyx-newline lyx-newline-' + node.attrs.kind, 'data-kind': node.attrs.kind }, ['br']],
    parseDOM: [
      { tag: 'span.lyx-newline', getAttrs: (d: HTMLElement) => ({ kind: attr(d, 'data-kind', 'newline') }) },
      { tag: 'br', getAttrs: (d: HTMLElement) => (d.parentElement?.classList.contains('lyx-newline') ? false : { kind: 'newline' }) },
    ],
  },

  newpage: {
    inline: true, group: 'inline', atom: true,
    attrs: { kind: { default: 'newpage' } },
    toDOM: node => ['span', { class: 'lyx-newpage', 'data-kind': node.attrs.kind }, node.attrs.kind],
    parseDOM: [{ tag: 'span.lyx-newpage', getAttrs: (d: HTMLElement) => ({ kind: attr(d, 'data-kind', 'newpage') }) }],
  },

  /** \SpecialChar etc. */
  special: {
    inline: true, group: 'inline', atom: true,
    attrs: { token: { default: '\\SpecialChar' }, arg: { default: 'ldots' } },
    toDOM: node => ['span', { class: 'lyx-special', 'data-arg': node.attrs.arg, 'data-token': node.attrs.token }, specialText(node.attrs.token, node.attrs.arg)],
    parseDOM: [{ tag: 'span.lyx-special', getAttrs: (d: HTMLElement) => ({ token: attr(d, 'data-token', '\\SpecialChar'), arg: attr(d, 'data-arg', 'ldots') }) }],
  },

  /** Any other leaf inset (VSpace, Info, External, Separator, line, Nomenclature ...) kept verbatim. */
  leaf: {
    inline: true, group: 'inline', atom: true,
    attrs: { name: { default: '' }, arg: { default: '' }, params: jsonAttr([]) },
    toDOM: node => ['span', { class: 'lyx-leaf lyx-leaf-' + String(node.attrs.name).toLowerCase(), 'data-name': node.attrs.name, 'data-arg': node.attrs.arg, 'data-params': node.attrs.params }, node.attrs.name + (node.attrs.arg ? ' ' + node.attrs.arg : '')],
    parseDOM: [{ tag: 'span.lyx-leaf', getAttrs: (d: HTMLElement) => ({ name: attr(d, 'data-name', ''), arg: attr(d, 'data-arg', ''), params: jsonFrom(d, 'data-params', '[]') }) }],
  },

  /** Unknown inset, body verbatim. */
  raw: {
    inline: true, group: 'inline', atom: true,
    attrs: { firstLine: { default: '' }, lines: jsonAttr([]) },
    toDOM: node => ['span', { class: 'lyx-raw', 'data-first-line': node.attrs.firstLine, 'data-lines': node.attrs.lines }, node.attrs.firstLine],
    parseDOM: [{ tag: 'span.lyx-raw', getAttrs: (d: HTMLElement) => ({ firstLine: attr(d, 'data-first-line', ''), lines: jsonFrom(d, 'data-lines', '[]') }) }],
  },

  /** Unknown paragraph token, verbatim. */
  unknown: {
    inline: true, group: 'inline', atom: true,
    attrs: { line: { default: '' } },
    toDOM: node => ['span', { class: 'lyx-unknown', 'data-line': node.attrs.line }, node.attrs.line],
    parseDOM: [{ tag: 'span.lyx-unknown', getAttrs: (d: HTMLElement) => ({ line: attr(d, 'data-line', '') }) }],
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

/** foreign HTML (pasted from a web page / another editor) → the LyX font attribute */
const foreign = (tags: string[], value: string) => tags.map(tag => ({ tag, getAttrs: () => ({ value }) }));
const fontStyle = (style: string, re: RegExp, value: string) => [{ style, getAttrs: (v: string) => (re.test(v) ? { value } : false) }];

const marks: Record<string, MarkSpec> = {
  emph: valueMark('emph', v => ['span', { class: 'lyx-emph-' + v, 'data-emph': v }, 0], { parseDOM: [{ tag: 'span[data-emph]', getAttrs: (d: HTMLElement) => ({ value: d.getAttribute('data-emph') }) }, ...foreign(['em', 'i'], 'on'), ...fontStyle('font-style', /italic/, 'on')] }),
  series: valueMark('series', v => ['span', { class: 'lyx-series-' + v, 'data-series': v }, 0], { parseDOM: [{ tag: 'span[data-series]', getAttrs: (d: HTMLElement) => ({ value: d.getAttribute('data-series') }) }, ...foreign(['b', 'strong'], 'bold'), ...fontStyle('font-weight', /^(bold|bolder|[6-9]00)$/, 'bold')] }),
  shape: valueMark('shape', v => ['span', { class: 'lyx-shape-' + v, 'data-shape': v }, 0]),
  family: valueMark('family', v => ['span', { class: 'lyx-family-' + v, 'data-family': v }, 0], { parseDOM: [{ tag: 'span[data-family]', getAttrs: (d: HTMLElement) => ({ value: d.getAttribute('data-family') }) }, ...foreign(['code', 'tt', 'kbd', 'samp'], 'typewriter')] }),
  size: valueMark('size', v => ['span', { class: 'lyx-size-' + v, 'data-size': v }, 0]),
  bar: valueMark('bar', v => ['span', { class: 'lyx-bar-' + v, 'data-bar': v }, 0], { parseDOM: [{ tag: 'span[data-bar]', getAttrs: (d: HTMLElement) => ({ value: d.getAttribute('data-bar') }) }, ...foreign(['u'], 'under')] }),
  strikeout: valueMark('strikeout', v => ['span', { class: 'lyx-strikeout-' + v, 'data-strikeout': v }, 0], { parseDOM: [{ tag: 'span[data-strikeout]', getAttrs: (d: HTMLElement) => ({ value: d.getAttribute('data-strikeout') }) }, ...foreign(['s', 'strike', 'del'], 'on')] }),
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
  // …and they travel with the node through the clipboard (toDOM → parseDOM)
  const toDOM = spec.toDOM!;
  spec.toDOM = node => withMarks(toDOM(node), node.attrs.marks);
  for (const rule of spec.parseDOM ?? []) {
    const getAttrs = rule.getAttrs;
    rule.getAttrs = (d: HTMLElement | string) => {
      const a = getAttrs ? getAttrs(d as never) : {};
      if (a === false) return false;
      const m = typeof d === 'string' ? null : d.getAttribute('data-marks');
      return m ? { ...(a ?? {}), marks: m } : a;
    };
  }
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
