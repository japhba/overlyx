/**
 * Conversion between the LyX AST (lyx/ast.ts) and ProseMirror JSON (schema.ts).
 * Both directions are lossless for everything the AST represents.
 */
import type {
  Change, FontState, Inset, Item, LyxDocument, Paragraph, TabularInset, TabularCell,
} from './lyx/ast.ts';
import { FONT_KEYS } from './lyx/ast.ts';
import { schema } from './schema.ts';
import type { Node as PMNode } from 'prosemirror-model';

export interface PMJSON { type: string; attrs?: Record<string, any>; content?: PMJSON[]; marks?: { type: string; attrs?: Record<string, any> }[]; text?: string }

/* ----------------------------------------------------------------- LyX -> PM */

function marksFor(font: FontState, change?: Change): PMJSON['marks'] {
  const marks: NonNullable<PMJSON['marks']> = [];
  for (const k of FONT_KEYS) if (font[k] !== undefined) marks.push({ type: k, attrs: { value: font[k] } });
  if (change) marks.push({ type: 'change', attrs: { type: change.type, author: change.author, time: change.time } });
  return marks.length ? marks : undefined;
}

export function paragraphToPm(p: Paragraph): PMJSON {
  const attrs: Record<string, any> = {
    layout: p.layout, depth: p.depth,
    align: p.params.align ?? null,
    noindent: !!p.params.noindent,
    labelwidthstring: p.params.labelwidthstring ?? null,
    spacing: p.params.paragraph_spacing ?? null,
    leftindent: p.params.leftindent ?? null,
    appendix: !!p.params.start_of_appendix,
    endChange: p.endChange ? JSON.stringify(p.endChange) : null,
  };
  const content: PMJSON[] = [];
  for (const it of p.items) {
    const n = itemToPm(it);
    if (n) content.push(n);
  }
  const node: PMJSON = { type: 'paragraph', attrs };
  if (content.length) node.content = content;
  return node;
}

export function paragraphsToPm(pars: Paragraph[], defaultLayout = 'Plain Layout'): PMJSON[] {
  if (!pars.length) return [{ type: 'paragraph', attrs: { layout: defaultLayout, depth: 0 } }];
  return pars.map(paragraphToPm);
}

function itemToPm(it: Item): PMJSON | null {
  const marks = marksFor(it.font, it.change);
  let node: PMJSON | null;
  switch (it.kind) {
    case 'text':
      if (!it.text) return null;
      node = { type: 'text', text: it.text };
      break;
    case 'special':
      node = { type: 'special', attrs: { token: it.token, arg: it.arg } };
      break;
    case 'unknown':
      node = { type: 'unknown', attrs: { line: it.line } };
      break;
    case 'inset':
      node = insetToPm(it.inset);
      break;
  }
  if (node && marks) {
    if (node.type === 'text') node.marks = marks;
    else node.attrs = { ...(node.attrs ?? {}), marks: JSON.stringify(marks) };
  }
  return node;
}

export function insetToPm(ins: Inset): PMJSON {
  switch (ins.type) {
    case 'Formula': {
      if (ins.inline) {
        const m = /^\$([\s\S]*)\$$/.exec(ins.latex);
        if (m) return { type: 'math_inline', attrs: { latex: m[1], delim: '$' } };
        return { type: 'math_inline', attrs: { latex: ins.latex, delim: '' } };
      }
      return { type: 'math_display', attrs: { latex: ins.latex } };
    }
    case 'FormulaMacro':
      return { type: 'macro', attrs: { lines: JSON.stringify(ins.lines) } };
    case 'Text':
      return {
        type: 'inset',
        attrs: { name: ins.name, arg: ins.arg, params: JSON.stringify(ins.params), status: ins.status ?? null },
        content: paragraphsToPm(ins.paragraphs),
      };
    case 'Leaf':
      switch (ins.name) {
        case 'CommandInset': return { type: 'command', attrs: { cmd: ins.arg, params: JSON.stringify(ins.params) } };
        case 'Graphics': return { type: 'graphics', attrs: { params: JSON.stringify(ins.params) } };
        case 'Quotes': return { type: 'quotes', attrs: { kind: ins.arg } };
        case 'space': return { type: 'space', attrs: { kind: ins.arg, params: JSON.stringify(ins.params) } };
        case 'Newline': return { type: 'newline', attrs: { kind: ins.arg } };
        case 'Newpage': return { type: 'newpage', attrs: { kind: ins.arg } };
        default: return { type: 'leaf', attrs: { name: ins.name, arg: ins.arg, params: JSON.stringify(ins.params) } };
      }
    case 'Tabular':
      return tabularToPm(ins);
    case 'Raw':
      return { type: 'raw', attrs: { firstLine: ins.firstLine, lines: JSON.stringify(ins.lines) } };
  }
}

function attrGet(attrs: [string, string][], key: string): string | undefined {
  for (const [k, v] of attrs) if (k === key) return v;
  return undefined;
}

function tabularToPm(t: TabularInset): PMJSON {
  const ncols = t.columns.length || Number(attrGet(t.attrs, 'columns') || 0);
  const rows: PMJSON[] = [];
  // occupancy grid for multirow continuation
  const occupied: (PMJSON | null)[][] = t.rows.map(() => new Array(ncols).fill(null));
  for (let r = 0; r < t.rows.length; r++) {
    const row = t.rows[r];
    const cells: PMJSON[] = [];
    let lastStart: PMJSON | null = null;
    for (let c = 0; c < row.cells.length; c++) {
      const cell = row.cells[c];
      const mc = attrGet(cell.attrs, 'multicolumn');
      const mr = attrGet(cell.attrs, 'multirow');
      const isCont = mc === '2' || mr === '2';
      if (isCont) {
        // attach to the start cell (multicolumn: previous start in this row; multirow: cell above)
        let start: PMJSON | null = null;
        if (mr === '2') { for (let rr = r - 1; rr >= 0 && !start; rr--) start = occupied[rr][c]; }
        if (!start) start = lastStart;
        if (start) {
          const cont: [string, string][][] = JSON.parse(start.attrs!.cont);
          cont.push(cell.attrs);
          start.attrs!.cont = JSON.stringify(cont);
          if (mr === '2') {
            start.attrs!.rowspan = (start.attrs!.rowspan || 1) + 1;
            if (occupied[r]) occupied[r][c] = start;
          } else {
            start.attrs!.colspan = (start.attrs!.colspan || 1) + 1;
          }
          // keep content of continuation cells (normally empty) to be lossless
          const paras = cell.paragraphs.filter(p => p.items.length);
          if (paras.length) {
            const extra: PMJSON[][] = JSON.parse(start.attrs!.contContent || '[]');
            extra.push(cell.paragraphs.map(paragraphToPm));
            start.attrs!.contContent = JSON.stringify(extra);
          }
        }
        continue;
      }
      const node: PMJSON = {
        type: 'table_cell',
        attrs: { colspan: 1, rowspan: 1, colwidth: null, attrs: JSON.stringify(cell.attrs), cont: '[]' },
        content: paragraphsToPm(cell.paragraphs),
      };
      if (occupied[r]) occupied[r][c] = node;
      cells.push(node);
      lastStart = node;
    }
    rows.push({ type: 'table_row', attrs: { attrs: JSON.stringify(row.attrs) }, content: cells });
  }
  return {
    type: 'table',
    attrs: { attrs: JSON.stringify(t.attrs), features: JSON.stringify(t.features), columns: JSON.stringify(t.columns.map(c => c.attrs)) },
    content: rows,
  };
}

export function lyxToPm(doc: LyxDocument): PMJSON {
  return { type: 'doc', content: doc.body.length ? doc.body.map(paragraphToPm) : [{ type: 'paragraph', attrs: { layout: 'Standard', depth: 0 } }] };
}

/* ----------------------------------------------------------------- PM -> LyX */

function fontFromMarks(marks: PMJSON['marks'] | readonly any[] | undefined): { font: FontState; change?: Change } {
  const font: FontState = {};
  let change: Change | undefined;
  for (const m of marks ?? []) {
    const type = typeof m.type === 'string' ? m.type : m.type.name;
    const attrs = m.attrs ?? {};
    if (type === 'change') change = { type: attrs.type, author: Number(attrs.author), time: Number(attrs.time) };
    else if ((FONT_KEYS as readonly string[]).includes(type)) (font as any)[type] = attrs.value;
  }
  return change ? { font, change } : { font };
}

function toJSON(n: PMNode | PMJSON): PMJSON {
  return (n as any).toJSON ? (n as PMNode).toJSON() : (n as PMJSON);
}

export function pmParagraphToLyx(nj: PMJSON): Paragraph {
  const a = nj.attrs ?? {};
  const p: Paragraph = { layout: a.layout ?? 'Standard', depth: a.depth ?? 0, params: {}, items: [] };
  if (a.align) p.params.align = a.align;
  if (a.noindent) p.params.noindent = true;
  if (a.labelwidthstring) p.params.labelwidthstring = a.labelwidthstring;
  if (a.spacing) p.params.paragraph_spacing = a.spacing;
  if (a.leftindent) p.params.leftindent = a.leftindent;
  if (a.appendix) p.params.start_of_appendix = true;
  if (a.endChange) { try { p.endChange = JSON.parse(a.endChange); } catch { /* ignore */ } }
  for (const c of nj.content ?? []) {
    const it = pmInlineToItem(c);
    if (!it) continue;
    const last = p.items[p.items.length - 1];
    if (it.kind === 'text' && last && last.kind === 'text' && sameFont(last, it)) last.text += it.text;
    else p.items.push(it);
  }
  return p;
}

function sameFont(a: Item, b: Item): boolean {
  for (const k of FONT_KEYS) if (a.font[k] !== b.font[k]) return false;
  const ca = a.change, cb = b.change;
  if (!ca && !cb) return true;
  if (!ca || !cb) return false;
  return ca.type === cb.type && ca.author === cb.author && ca.time === cb.time;
}

function pmInlineToItem(c: PMJSON): Item | null {
  const a = c.attrs ?? {};
  const parse = (s: string | undefined, def: any) => { try { return s ? JSON.parse(s) : def; } catch { return def; } };
  // marks on non-text nodes live in the `marks` attribute (see schema.ts); PM marks are merged in too
  const fc = c.type === 'text' ? fontFromMarks(c.marks) : fontFromMarks([...(parse(a.marks, []) as any[]), ...(c.marks ?? [])]);
  switch (c.type) {
    case 'text':
      return c.text ? { kind: 'text', text: c.text, ...fc } : null;
    case 'special':
      return { kind: 'special', token: a.token, arg: a.arg, ...fc };
    case 'unknown':
      return { kind: 'unknown', line: a.line, ...fc };
    case 'math_inline':
      return { kind: 'inset', inset: { type: 'Formula', inline: true, latex: a.delim === '$' ? '$' + a.latex + '$' : a.latex }, ...fc };
    case 'math_display':
      return { kind: 'inset', inset: { type: 'Formula', inline: false, latex: a.latex }, ...fc };
    case 'macro':
      return { kind: 'inset', inset: { type: 'FormulaMacro', lines: parse(a.lines, []) }, ...fc };
    case 'inset':
      return {
        kind: 'inset', ...fc,
        inset: { type: 'Text', name: a.name, arg: a.arg ?? '', params: parse(a.params, []), status: a.status ?? undefined, paragraphs: pmBlocksToParagraphs(c.content ?? []) },
      };
    case 'command':
      return { kind: 'inset', inset: { type: 'Leaf', name: 'CommandInset', arg: a.cmd, params: parse(a.params, []) }, ...fc };
    case 'graphics':
      return { kind: 'inset', inset: { type: 'Leaf', name: 'Graphics', arg: '', params: parse(a.params, []) }, ...fc };
    case 'quotes':
      return { kind: 'inset', inset: { type: 'Leaf', name: 'Quotes', arg: a.kind, params: [] }, ...fc };
    case 'space':
      return { kind: 'inset', inset: { type: 'Leaf', name: 'space', arg: a.kind, params: parse(a.params, []) }, ...fc };
    case 'newline':
      return { kind: 'inset', inset: { type: 'Leaf', name: 'Newline', arg: a.kind, params: [] }, ...fc };
    case 'newpage':
      return { kind: 'inset', inset: { type: 'Leaf', name: 'Newpage', arg: a.kind, params: [] }, ...fc };
    case 'leaf':
      return { kind: 'inset', inset: { type: 'Leaf', name: a.name, arg: a.arg ?? '', params: parse(a.params, []) }, ...fc };
    case 'raw':
      return { kind: 'inset', inset: { type: 'Raw', firstLine: a.firstLine, lines: parse(a.lines, []) }, ...fc };
    case 'table':
      return { kind: 'inset', inset: pmTableToLyx(c), ...fc };
    default:
      return null;
  }
}

export function pmBlocksToParagraphs(blocks: PMJSON[]): Paragraph[] {
  const out: Paragraph[] = [];
  for (const b of blocks) {
    if (b.type === 'paragraph') out.push(pmParagraphToLyx(b));
    else {
      // any other block (should not happen with our schema) — wrap as a Plain Layout paragraph
      const it = pmInlineToItem(b);
      const p: Paragraph = { layout: 'Plain Layout', depth: 0, params: {}, items: it ? [it] : [] };
      out.push(p);
    }
  }
  return out;
}

function pmTableToLyx(t: PMJSON): TabularInset {
  const parse = (s: string | undefined, def: any) => { try { return s ? JSON.parse(s) : def; } catch { return def; } };
  const a = t.attrs ?? {};
  const columns: [string, string][][] = parse(a.columns, []);
  const rowsIn = t.content ?? [];
  // grid reconstruction with spans
  const nrows = rowsIn.length;
  let ncols = columns.length;
  // compute actual column count from content if columns attr is missing/short
  {
    const widths = rowsIn.map(r => (r.content ?? []).reduce((s, c) => s + (c.attrs?.colspan || 1), 0));
    ncols = Math.max(ncols, ...widths, 0);
  }
  const grid: ({ start: PMJSON; cont?: [string, string][]; contContent?: PMJSON[] } | null)[][] = Array.from({ length: nrows }, () => new Array(ncols).fill(null));
  for (let r = 0; r < nrows; r++) {
    const cells = rowsIn[r].content ?? [];
    let c = 0;
    for (const cell of cells) {
      while (c < ncols && grid[r][c]) c++;
      if (c >= ncols) break;
      const cs = cell.attrs?.colspan || 1, rs = cell.attrs?.rowspan || 1;
      const cont: [string, string][][] = parse(cell.attrs?.cont, []);
      const contContent: PMJSON[][] = parse(cell.attrs?.contContent, []);
      let k = 0;
      for (let dr = 0; dr < rs; dr++) for (let dc = 0; dc < cs; dc++) {
        if (r + dr >= nrows || c + dc >= ncols) continue;
        if (dr === 0 && dc === 0) grid[r][c] = { start: cell };
        else {
          const attrs = cont[k] ?? defaultContAttrs(cell, dc > 0, dr > 0);
          const cc = contContent[k];
          grid[r + dr][c + dc] = { start: cell, cont: attrs, contContent: cc };
          k++;
        }
      }
      c += cs;
    }
  }
  const rows = rowsIn.map((row, r) => {
    const cells: TabularCell[] = [];
    for (let c = 0; c < ncols; c++) {
      const g = grid[r][c];
      if (!g) {
        cells.push({ attrs: [['alignment', 'center'], ['valignment', 'top'], ['usebox', 'none']], paragraphs: [{ layout: 'Plain Layout', depth: 0, params: {}, items: [] }] });
      } else if (g.cont) {
        cells.push({ attrs: g.cont, paragraphs: g.contContent ? pmBlocksToParagraphs(g.contContent) : [{ layout: 'Plain Layout', depth: 0, params: {}, items: [] }] });
      } else {
        cells.push({ attrs: parse(g.start.attrs?.attrs, []), paragraphs: pmBlocksToParagraphs(g.start.content ?? []) });
      }
    }
    return { attrs: parse(row.attrs?.attrs, []), cells };
  });
  const tattrs: [string, string][] = parse(a.attrs, []);
  const setA = (k: string, v: string) => { const i = tattrs.findIndex(x => x[0] === k); if (i >= 0) tattrs[i] = [k, v]; else tattrs.push([k, v]); };
  if (!tattrs.length) setA('version', '3');
  setA('rows', String(nrows)); setA('columns', String(ncols));
  const cols = columns.slice(0, ncols);
  while (cols.length < ncols) cols.push([['alignment', 'center'], ['valignment', 'top']]);
  return { type: 'Tabular', attrs: tattrs, features: parse(a.features, []), columns: cols.map(attrs => ({ attrs })), rows };
}

function defaultContAttrs(start: PMJSON, mc: boolean, mr: boolean): [string, string][] {
  const base: [string, string][] = JSON.parse(start.attrs?.attrs ?? '[]');
  const out: [string, string][] = [];
  if (mc) out.push(['multicolumn', '2']);
  if (mr) out.push(['multirow', '2']);
  for (const [k, v] of base) if (k !== 'multicolumn' && k !== 'multirow' && k !== 'mroffset') out.push([k, v]);
  return out;
}

/** Convert a ProseMirror document (JSON or Node) to LyX paragraphs. */
export function pmToLyxBody(doc: PMNode | PMJSON): Paragraph[] {
  const j = toJSON(doc);
  return pmBlocksToParagraphs(j.content ?? []);
}

/** Build a ProseMirror Node from a LyX document (validated against the schema). */
export function lyxToPmNode(doc: LyxDocument): PMNode {
  const node = schema.nodeFromJSON(lyxToPm(doc));
  node.check();
  return node;
}
