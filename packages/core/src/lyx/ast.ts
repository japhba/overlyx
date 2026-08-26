/**
 * OverLyX — lossless in-memory representation of a LyX document.
 *
 * Design goals:
 *  - Anything LyX can write, we can read and write back *byte-identically*
 *    (unknown insets/params are carried verbatim).
 *  - The structure mirrors LyX's own model: a list of paragraphs, each with a
 *    layout, params and a run of items (text with font/change state, insets).
 */

/** Font state as LyX names it. `undefined` means "inherit/default". */
export interface FontState {
  family?: string;      // roman | sans | typewriter | default
  series?: string;      // medium | bold | default
  shape?: string;       // up | italic | slanted | smallcaps | default
  size?: string;        // tiny ... giant | default
  emph?: string;        // on | off | toggle | default
  numeric?: string;
  nospellcheck?: string;
  bar?: string;         // no | under | default
  strikeout?: string;
  xout?: string;
  uuline?: string;
  uwave?: string;
  noun?: string;
  color?: string;       // LyX color name (e.g. red, none, inherit)
  lang?: string;        // language name
}

export const FONT_KEYS: (keyof FontState)[] = [
  'family', 'series', 'shape', 'size', 'emph', 'numeric', 'nospellcheck', 'bar',
  'strikeout', 'xout', 'uuline', 'uwave', 'noun', 'color', 'lang',
];

export interface Change {
  type: 'inserted' | 'deleted';
  author: number;  // buffer author id (see getAuthors)
  time: number;    // unix seconds
}

export interface ItemBase {
  font: FontState;
  change?: Change;
}

export interface TextItem extends ItemBase {
  kind: 'text';
  text: string;
}

/** \SpecialChar, \SpecialCharNoPassThru, \IPAChar, \twohyphens, \threehyphens */
export interface SpecialItem extends ItemBase {
  kind: 'special';
  token: string;   // e.g. "\\SpecialChar"
  arg: string;     // e.g. "nobreakdash", "\\ldots{}"
}

export interface InsetItem extends ItemBase {
  kind: 'inset';
  inset: Inset;
}

/** Unknown paragraph-level token, preserved verbatim. */
export interface UnknownItem extends ItemBase {
  kind: 'unknown';
  line: string;
}

export type Item = TextItem | SpecialItem | InsetItem | UnknownItem;

export interface ParagraphParams {
  align?: string;              // left | right | center | block
  noindent?: boolean;
  labelwidthstring?: string;
  paragraph_spacing?: string;  // e.g. "single", "other 1.5"
  leftindent?: string;
  start_of_appendix?: boolean;
}

export interface Paragraph {
  layout: string;
  depth: number;
  params: ParagraphParams;
  items: Item[];
  /** change-tracking state of the paragraph break itself */
  endChange?: Change;
}

/* ------------------------------------------------------------------ insets */

/** Inline or display formula. `latex` is stored verbatim. */
export interface FormulaInset {
  type: 'Formula';
  /** true when written on one line as $...$ (or \( \)) */
  inline: boolean;
  latex: string;
}

/** \newcommand-style macro definition; lines kept verbatim (def + optional display). */
export interface FormulaMacroInset {
  type: 'FormulaMacro';
  lines: string[];
}

/**
 * Any inset that contains paragraphs (Note, ERT, Foot, Marginal, Float, Wrap,
 * Caption, Box, Branch, Flex, Argument, Index, Listings, script, Phantom, IPA,
 * Text, Preview, ...).
 */
export interface TextInset {
  type: 'Text';
  /** first word after \begin_inset, e.g. "Note", "ERT", "Float", "Caption" */
  name: string;
  /** rest of the first line, e.g. "Note" (for Note Note), "figure", "Standard" */
  arg: string;
  /** parameter lines between the first line and `status`/first paragraph, verbatim */
  params: string[];
  /** undefined for insets without a status line (Caption, Text) */
  status?: 'open' | 'collapsed';
  paragraphs: Paragraph[];
}

/** Leaf inset with parameter lines only (Graphics, CommandInset, Quotes, space, Newline, ...). */
export interface LeafInset {
  type: 'Leaf';
  name: string;       // "Graphics", "CommandInset", "Quotes", "space", "Newline", "Newpage", ...
  arg: string;        // e.g. "ref" for CommandInset ref, "eld" for Quotes
  params: string[];   // verbatim lines (may be tab-indented for Graphics)
}

export interface TabularCell {
  /** attributes of <cell ...> as an ordered list to preserve order */
  attrs: [string, string][];
  paragraphs: Paragraph[];
}

export interface TabularRow {
  attrs: [string, string][];
  cells: TabularCell[];
}

export interface TabularColumn {
  attrs: [string, string][];
}

export interface TabularInset {
  type: 'Tabular';
  /** attrs of <lyxtabular ...> */
  attrs: [string, string][];
  /** attrs of <features ...> */
  features: [string, string][];
  columns: TabularColumn[];
  rows: TabularRow[];
}

/** Inset we do not understand; body preserved verbatim. */
export interface RawInset {
  type: 'Raw';
  firstLine: string;   // everything after "\begin_inset "
  lines: string[];     // body lines until matching \end_inset
}

export type Inset = FormulaInset | FormulaMacroInset | TextInset | LeafInset | TabularInset | RawInset;

/* ------------------------------------------------------------------ header */

export interface Author {
  id: number;
  name: string;
  email?: string;
  raw: string;
}

export interface Header {
  /** verbatim header lines between \begin_header and \end_header */
  lines: string[];
}

export interface LyxDocument {
  /** first line(s) before \lyxformat (comment) */
  preamble: string[];  // e.g. ["#LyX 2.5 created this file. ..."]
  format: number;
  header: Header;
  body: Paragraph[];
  /** trailing lines after \end_document (usually none) */
  trailer: string[];
}

/* ------------------------------------------------------------- accessors */

export function headerValue(h: Header, key: string): string | undefined {
  const prefix = '\\' + key + ' ';
  for (const l of h.lines) {
    if (l.startsWith(prefix)) return l.slice(prefix.length);
    if (l === '\\' + key) return '';
  }
  return undefined;
}

export function setHeaderValue(h: Header, key: string, value: string): void {
  const prefix = '\\' + key + ' ';
  for (let i = 0; i < h.lines.length; i++) {
    if (h.lines[i].startsWith(prefix) || h.lines[i] === '\\' + key) {
      h.lines[i] = prefix + value;
      return;
    }
  }
  h.lines.push(prefix + value);
}

/** Multi-line block, e.g. begin_preamble/end_preamble, begin_modules/end_modules */
export function headerBlock(h: Header, name: string): string[] | undefined {
  const start = h.lines.indexOf('\\begin_' + name);
  if (start < 0) return undefined;
  const end = h.lines.indexOf('\\end_' + name, start);
  if (end < 0) return undefined;
  return h.lines.slice(start + 1, end);
}

export function setHeaderBlock(h: Header, name: string, content: string[], insertAfterKey?: string): void {
  const start = h.lines.indexOf('\\begin_' + name);
  if (start >= 0) {
    const end = h.lines.indexOf('\\end_' + name, start);
    h.lines.splice(start + 1, Math.max(0, end - start - 1), ...content);
    return;
  }
  let at = h.lines.length;
  if (insertAfterKey) {
    const idx = h.lines.findIndex(l => l.startsWith('\\' + insertAfterKey + ' ') || l === '\\' + insertAfterKey);
    if (idx >= 0) at = idx + 1;
  }
  h.lines.splice(at, 0, '\\begin_' + name, ...content, '\\end_' + name);
}

export function getAuthors(h: Header): Author[] {
  const out: Author[] = [];
  for (const l of h.lines) {
    if (!l.startsWith('\\author ')) continue;
    const m = /^\\author (-?\d+) "((?:[^"\\]|\\.)*)"(?: "((?:[^"\\]|\\.)*)")?/.exec(l);
    if (m) out.push({ id: Number(m[1]), name: m[2], email: m[3], raw: l });
  }
  return out;
}

export function addAuthor(h: Header, id: number, name: string, email = ''): void {
  if (getAuthors(h).some(a => a.id === id)) return;
  const line = `\\author ${id} "${name}" "${email}"`;
  let idx = -1;
  for (let i = h.lines.length - 1; i >= 0; i--) {
    if (h.lines[i].startsWith('\\author ')) { idx = i; break; }
  }
  if (idx >= 0) h.lines.splice(idx + 1, 0, line);
  else h.lines.push(line);
}

export function getTextClass(doc: LyxDocument): string {
  return headerValue(doc.header, 'textclass') ?? 'article';
}

export function getPreamble(doc: LyxDocument): string {
  return (headerBlock(doc.header, 'preamble') ?? []).join('\n');
}

export function getModules(doc: LyxDocument): string[] {
  return headerBlock(doc.header, 'modules') ?? [];
}

/** Stable pseudo-random author id for authors we create (LyX uses a hash too). */
export function lyxAuthorId(name: string, email: string): number {
  const s = name + ' ' + email;
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return (h | 0);
}

/* ------------------------------------------------------------- helpers */

export function paragraph(layout: string, items: Item[] = [], depth = 0): Paragraph {
  return { layout, depth, params: {}, items };
}

export function textItem(text: string, font: FontState = {}, change?: Change): TextItem {
  const t: TextItem = { kind: 'text', text, font };
  if (change) t.change = change;
  return t;
}

export function insetItem(inset: Inset, font: FontState = {}, change?: Change): InsetItem {
  const t: InsetItem = { kind: 'inset', inset, font };
  if (change) t.change = change;
  return t;
}

export function textInset(name: string, arg: string, paragraphs: Paragraph[], status: 'open' | 'collapsed' | undefined = 'open', params: string[] = []): TextInset {
  return { type: 'Text', name, arg, params, status, paragraphs };
}

export function fontsEqual(a: FontState, b: FontState): boolean {
  for (const k of FONT_KEYS) if ((a[k] ?? undefined) !== (b[k] ?? undefined)) return false;
  return true;
}

export function changesEqual(a?: Change, b?: Change): boolean {
  if (!a && !b) return true;
  if (!a || !b) return false;
  return a.type === b.type && a.author === b.author && a.time === b.time;
}

/** Plain text of a paragraph list (for outline / search / tooltips). */
export function plainText(pars: Paragraph[]): string {
  return pars.map(p => p.items.map(itemText).join('')).join('\n');
}

export function itemText(it: Item): string {
  switch (it.kind) {
    case 'text': return it.text;
    case 'special':
      if (it.arg === 'nobreakdash') return '-';
      if (it.arg.startsWith('\\ldots')) return '…';
      if (it.arg === 'endofsentence') return '.';
      if (it.arg === 'menuseparator') return '▹';
      return '';
    case 'inset': {
      const ins = it.inset;
      if (ins.type === 'Formula') return ins.latex.replace(/^\$|\$$/g, '');
      if (ins.type === 'Text') return plainText(ins.paragraphs);
      if (ins.type === 'Leaf') {
        if (ins.name === 'space') return ' ';
        if (ins.name === 'Quotes') return ins.arg.endsWith('ld') ? '“' : '”';
        if (ins.name === 'Newline') return '\n';
      }
      return '';
    }
    default: return '';
  }
}

/** Walk all paragraphs recursively (body, insets, table cells). */
export function* walkParagraphs(pars: Paragraph[]): Generator<Paragraph> {
  for (const p of pars) {
    yield p;
    for (const it of p.items) {
      if (it.kind !== 'inset') continue;
      const ins = it.inset;
      if (ins.type === 'Text') yield* walkParagraphs(ins.paragraphs);
      else if (ins.type === 'Tabular') for (const r of ins.rows) for (const c of r.cells) yield* walkParagraphs(c.paragraphs);
    }
  }
}

/** Walk all insets in document order (an inset is yielded before the insets nested inside it). */
export function* walkInsets(pars: Paragraph[]): Generator<{ inset: Inset; par: Paragraph; item: InsetItem }> {
  for (const p of pars) {
    for (const it of p.items) {
      if (it.kind !== 'inset') continue;
      yield { inset: it.inset, par: p, item: it };
      const ins = it.inset;
      if (ins.type === 'Text') yield* walkInsets(ins.paragraphs);
      else if (ins.type === 'Tabular') for (const r of ins.rows) for (const c of r.cells) yield* walkInsets(c.paragraphs);
    }
  }
}

/** Parse "key value" parameter lines (Graphics / CommandInset / Float) into a map. */
export function paramMap(lines: string[]): Map<string, string> {
  const m = new Map<string, string>();
  for (const raw of lines) {
    const l = raw.replace(/^\t/, '');
    const sp = l.indexOf(' ');
    if (sp < 0) { if (l) m.set(l, ''); continue; }
    m.set(l.slice(0, sp), l.slice(sp + 1));
  }
  return m;
}

export function unquote(s: string | undefined): string {
  if (s === undefined) return '';
  if (s.length >= 2 && s.startsWith('"') && s.endsWith('"')) return s.slice(1, -1).replace(/\\"/g, '"');
  return s;
}

export function quote(s: string): string {
  return '"' + s.replace(/"/g, '\\"') + '"';
}

/** Set or add a "key value" line in an ordered param list (keeps tab prefix style). */
export function setParam(lines: string[], key: string, value: string, tabbed = false): void {
  const prefix = (tabbed ? '\t' : '') + key + ' ';
  for (let i = 0; i < lines.length; i++) {
    const l = lines[i].replace(/^\t/, '');
    if (l === key || l.startsWith(key + ' ')) { lines[i] = prefix + value; return; }
  }
  lines.push(prefix + value);
}

export function removeParam(lines: string[], key: string): void {
  for (let i = lines.length - 1; i >= 0; i--) {
    const l = lines[i].replace(/^\t/, '');
    if (l === key || l.startsWith(key + ' ')) lines.splice(i, 1);
  }
}
