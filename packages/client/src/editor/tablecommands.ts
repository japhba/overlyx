/**
 * LyX's table toolbar (lib/ui/stdtoolbars.inc, `Toolbar "table"`) as ProseMirror commands.
 *
 * Every command converts the table at the cursor into the LyX AST (`TabularInset`: one cell per
 * grid position with verbatim attributes — the data model of src/insets/InsetTabular.cpp),
 * applies the feature the way `Tabular::…` / `InsetTabular::tabularFeatures` do, and converts
 * the result back with the core converter. Lines, alignments and spans therefore end up in the
 * LyX file exactly as LyX itself would write them, and every result round-trips.
 *
 * Selections: a prosemirror-tables `CellSelection` or a text selection spanning several cells is
 * taken as LyX's selection rectangle (rows/columns of the first and last selected cell);
 * otherwise the command acts on the cursor cell.
 */
import { type Command, type EditorState, Selection, TextSelection } from 'prosemirror-state';
import type { Node as PMNode } from 'prosemirror-model';
import { CellSelection } from 'prosemirror-tables';
import { schema, insetToPm, pmBlocksToParagraphs, type PMJSON, type TabularInset, type TabularCell, type Paragraph } from '@overlyx/core';
import { tableContext, type TableContext } from './commands';

/* ------------------------------------------------------------- attributes */

type Attrs = [string, string][];

/** attribute order of Tabular::write, so that new attributes land where LyX writes them */
const CELL_ORDER = ['multicolumn', 'multirow', 'mroffset', 'alignment', 'valignment', 'topline', 'toplineltrim', 'toplinertrim', 'bottomline', 'bottomlineltrim', 'bottomlinertrim', 'leftline', 'rightline', 'rotate', 'usebox', 'width', 'special'];
const COLUMN_ORDER = ['alignment', 'decimal_point', 'change', 'valignment', 'width', 'varwidth', 'special'];
const FEATURE_ORDER = ['rotate', 'booktabs', 'islongtable', 'firstHeadTopDL', 'firstHeadBottomDL', 'firstHeadEmpty', 'headTopDL', 'headBottomDL', 'footTopDL', 'footBottomDL', 'lastFootTopDL', 'lastFootBottomDL', 'lastFootEmpty', 'tabularvalignment', 'tabularwidth', 'longtabularalignment'];
const TABLE_ORDER = ['version', 'rows', 'columns'];

function get(a: Attrs, key: string): string | undefined {
  for (const [k, v] of a) if (k === key) return v;
  return undefined;
}

/** Set (or remove, with `null`) an attribute in place, inserting new keys at LyX's position. */
function set(a: Attrs, key: string, value: string | null, order: string[]): void {
  const i = a.findIndex(x => x[0] === key);
  if (value === null) { if (i >= 0) a.splice(i, 1); return; }
  if (i >= 0) { a[i] = [key, value]; return; }
  const rank = order.indexOf(key);
  let at = a.length;
  if (rank >= 0) {
    for (let j = 0; j < a.length; j++) {
      const r = order.indexOf(a[j][0]);
      if (r > rank) { at = j; break; }
    }
  }
  a.splice(at, 0, [key, value]);
}

const copy = (a: Attrs): Attrs => a.map(([k, v]) => [k, v]);
const plainParagraph = (): Paragraph => ({ layout: 'Plain Layout', depth: 0, params: {}, items: [] });

/* ------------------------------------------------------------ Tabular model */

type Tab = TabularInset;
const nrows = (T: Tab) => T.rows.length;
const ncols = (T: Tab) => T.columns.length;
const cellData = (T: Tab, r: number, c: number): TabularCell => T.rows[r].cells[c];

const isPartMC = (T: Tab, r: number, c: number) => get(cellData(T, r, c).attrs, 'multicolumn') === '2';
const isBeginMC = (T: Tab, r: number, c: number) => get(cellData(T, r, c).attrs, 'multicolumn') === '1';
const isPartMR = (T: Tab, r: number, c: number) => get(cellData(T, r, c).attrs, 'multirow') === '2';
const isBeginMR = (T: Tab, r: number, c: number) => get(cellData(T, r, c).attrs, 'multirow') === '1';
/** Tabular::isMultiColumn / isMultiRow: begin or part */
const isMultiColumn = (T: Tab, r: number, c: number) => isBeginMC(T, r, c) || isPartMC(T, r, c);
const isMultiRow = (T: Tab, r: number, c: number) => isBeginMR(T, r, c) || isPartMR(T, r, c);

/** Tabular::cellIndex: the start cell of the span that covers (r, c). */
function startOf(T: Tab, r: number, c: number): [number, number] {
  while (c > 0 && isPartMC(T, r, c)) c--;
  while (r > 0 && isPartMR(T, r, c)) r--;
  return [r, c];
}
/** Tabular::cellInfo(cellIndex(r, c)) */
function cellInfo(T: Tab, r: number, c: number): TabularCell {
  const [sr, sc] = startOf(T, r, c);
  return cellData(T, sr, sc);
}
function columnSpan(T: Tab, r: number, c: number): number {
  let span = 1;
  while (c + span < ncols(T) && isPartMC(T, r, c + span)) span++;
  return span;
}
function rowSpan(T: Tab, r: number, c: number): number {
  let span = 1;
  while (r + span < nrows(T) && isPartMR(T, r + span, c)) span++;
  return span;
}
function hasMultiColumn(T: Tab, c: number): boolean {
  for (let r = 0; r < nrows(T); r++) if (isMultiColumn(T, r, c)) return true;
  return false;
}
function hasMultiRow(T: Tab, r: number): boolean {
  for (let c = 0; c < ncols(T); c++) if (isMultiRow(T, r, c)) return true;
  return false;
}

const useBooktabs = (T: Tab) => get(T.features, 'booktabs') === 'true';
const columnHasWidth = (T: Tab, c: number) => !!get(T.columns[c].attrs, 'width');

/* lines (Tabular::topLine & co. — left/right lines do not exist with booktabs) */
const lineOf = (T: Tab, r: number, c: number, key: string) => get(cellInfo(T, r, c).attrs, key) === 'true';
const topLine = (T: Tab, r: number, c: number) => lineOf(T, r, c, 'topline');
const bottomLine = (T: Tab, r: number, c: number) => lineOf(T, r, c, 'bottomline');
const leftLine = (T: Tab, r: number, c: number, ignoreBt = false) => (useBooktabs(T) && !ignoreBt) ? false : lineOf(T, r, c, 'leftline');
const rightLine = (T: Tab, r: number, c: number, ignoreBt = false) => (useBooktabs(T) && !ignoreBt) ? false : lineOf(T, r, c, 'rightline');
function setLine(T: Tab, r: number, c: number, key: string, on: boolean): void {
  set(cellInfo(T, r, c).attrs, key, on ? 'true' : null, CELL_ORDER);
}

/* alignment (Tabular::getAlignment / getVAlignment: cells only matter for multicolumns) */
function getAlignment(T: Tab, r: number, c: number, onlyColumn = false): string {
  if (!onlyColumn && isMultiColumn(T, r, c)) return get(cellInfo(T, r, c).attrs, 'alignment') ?? 'center';
  return get(T.columns[startOf(T, r, c)[1]].attrs, 'alignment') ?? 'center';
}
function getVAlignment(T: Tab, r: number, c: number, onlyColumn = false): string {
  if (!onlyColumn && isMultiColumn(T, r, c)) return get(cellInfo(T, r, c).attrs, 'valignment') ?? 'top';
  return get(T.columns[startOf(T, r, c)[1]].attrs, 'valignment') ?? 'top';
}

/** Tabular::outsideBorders */
function outsideBorders(T: Tab, rs: number, re: number, cs: number, ce: number): boolean {
  if (!useBooktabs(T))
    for (let r = rs; r <= re; r++) if (!leftLine(T, r, cs) || !rightLine(T, r, ce)) return false;
  for (let c = cs; c <= ce; c++) if (!topLine(T, rs, c) || !bottomLine(T, re, c)) return false;
  return true;
}
/** Tabular::innerBorders */
function innerBorders(T: Tab, rs: number, re: number, cs: number, ce: number): boolean {
  if (rs === re && cs === ce) return false;
  for (let r = rs; r <= re; r++)
    for (let c = cs; c <= ce; c++) {
      if ((r !== rs && !topLine(T, r, c) && !isPartMR(T, r, c))
        || (!useBooktabs(T) && c !== cs && !leftLine(T, r, c) && !isPartMC(T, r, c))) return false;
    }
  return true;
}
/** Tabular::setLines */
function setLines(T: Tab, rs: number, re: number, cs: number, ce: number, innerOnly: boolean, on: boolean): void {
  for (let r = rs; r <= re; r++)
    for (let c = cs; c <= ce; c++) {
      if (!(innerOnly && r === rs) && !isPartMR(T, r, c)) setLine(T, r, c, 'topline', on);
      if (!(innerOnly && r === re) && (r === re || (!on && !isPartMR(T, r + 1, c)))) setLine(T, r, c, 'bottomline', on);
      if (!(innerOnly && c === cs) && !isPartMC(T, r, c)) setLine(T, r, c, 'leftline', on);
      if (!(innerOnly && c === ce) && (c === ce || (!on && !isPartMC(T, r, c + 1)))) setLine(T, r, c, 'rightline', on);
    }
}

/** a fresh CellData: LyX defaults, alignment taken from the column */
function newCell(T: Tab, c: number): TabularCell {
  const col = T.columns[c]?.attrs ?? [];
  return {
    attrs: [['alignment', get(col, 'alignment') ?? 'center'], ['valignment', get(col, 'valignment') ?? 'top'], ['usebox', 'none']],
    paragraphs: [plainParagraph()],
  };
}

function updateCounts(T: Tab): void {
  set(T.attrs, 'rows', String(nrows(T)), TABLE_ORDER);
  set(T.attrs, 'columns', String(ncols(T)), TABLE_ORDER);
}

/** Tabular::insertRow(row, copy=false) — the new row goes below `row` */
function insertRow(T: Tab, row: number): void {
  const rowAttrs = copy(T.rows[row].attrs).filter(([k]) => k !== 'change');
  const cells: TabularCell[] = [];
  for (let c = 0; c < ncols(T); c++) {
    const cell = newCell(T, c);
    // keep multirow spans contiguous (LyX extends a span whose begin is in `row`)
    if (isBeginMR(T, row, c) || (isPartMR(T, row, c) && row + 1 < nrows(T) && isPartMR(T, row + 1, c))) set(cell.attrs, 'multirow', '2', CELL_ORDER);
    cells.push(cell);
  }
  T.rows.splice(row + 1, 0, { attrs: rowAttrs, cells });
  for (let c = 0; c < ncols(T); c++) {
    if (isPartMR(T, row, c) || isPartMR(T, row + 1, c)) continue;
    // inherit line settings
    const i = cellData(T, row + 1, c);
    const [jr, jc] = startOf(T, row, c);
    set(i.attrs, 'leftline', leftLine(T, jr, jc) ? 'true' : null, CELL_ORDER);
    set(i.attrs, 'rightline', rightLine(T, jr, jc) ? 'true' : null, CELL_ORDER);
    set(i.attrs, 'topline', topLine(T, jr, jc) ? 'true' : null, CELL_ORDER);
    if (topLine(T, jr, jc) && bottomLine(T, jr, jc)) {
      set(i.attrs, 'bottomline', 'true', CELL_ORDER);
      setLine(T, jr, jc, 'bottomline', false);
    }
  }
  updateCounts(T);
}

/** Tabular::insertColumn(col, copy=false) — the new column goes right of `col` */
function insertColumn(T: Tab, col: number): void {
  T.columns.splice(col + 1, 0, { attrs: copy(T.columns[col].attrs).filter(([k]) => k !== 'change') });
  for (let r = 0; r < nrows(T); r++) {
    const cell = newCell(T, col + 1);
    if (isBeginMC(T, r, col) || (isPartMC(T, r, col) && col + 1 < T.rows[r].cells.length && isPartMC(T, r, col + 1))) set(cell.attrs, 'multicolumn', '2', CELL_ORDER);
    T.rows[r].cells.splice(col + 1, 0, cell);
  }
  for (let r = 0; r < nrows(T); r++) {
    if (isPartMC(T, r, col + 1)) continue;
    // inherit line settings
    const i = cellData(T, r, col + 1);
    const [jr, jc] = startOf(T, r, col);
    set(i.attrs, 'bottomline', bottomLine(T, jr, jc) ? 'true' : null, CELL_ORDER);
    set(i.attrs, 'topline', topLine(T, jr, jc) ? 'true' : null, CELL_ORDER);
    set(i.attrs, 'leftline', leftLine(T, jr, jc) ? 'true' : null, CELL_ORDER);
    set(i.attrs, 'rightline', rightLine(T, jr, jc) ? 'true' : null, CELL_ORDER);
    if (rightLine(T, r, col + 1) && rightLine(T, jr, jc)) setLine(T, jr, jc, 'rightline', false);
  }
  updateCounts(T);
}

/** Tabular::deleteRow — refuses to delete the last row; a multirow starting here moves down */
function deleteRowT(T: Tab, row: number): boolean {
  if (nrows(T) === 1) return false;
  for (let c = 0; c < ncols(T); c++) {
    if (row + 1 < nrows(T) && isBeginMR(T, row, c) && isPartMR(T, row + 1, c)) T.rows[row + 1].cells[c] = T.rows[row].cells[c];
  }
  T.rows.splice(row, 1);
  updateCounts(T);
  return true;
}

/** Tabular::deleteColumn — refuses to delete the last column; a multicolumn starting here moves right */
function deleteColumnT(T: Tab, col: number): boolean {
  if (ncols(T) === 1) return false;
  for (let r = 0; r < nrows(T); r++) {
    if (col + 1 < ncols(T) && isBeginMC(T, r, col) && isPartMC(T, r, col + 1)) T.rows[r].cells[col + 1] = T.rows[r].cells[col];
    T.rows[r].cells.splice(col, 1);
  }
  T.columns.splice(col, 1);
  updateCounts(T);
  return true;
}

function swapAttr(a: Attrs, b: Attrs, key: string, order: string[]): void {
  const va = get(a, key), vb = get(b, key);
  set(a, key, vb ?? null, order);
  set(b, key, va ?? null, order);
}

/** Tabular::moveRow: rows swap, but top/bottom lines stay with the position */
function swapRows(T: Tab, r1: number, r2: number): void {
  [T.rows[r1], T.rows[r2]] = [T.rows[r2], T.rows[r1]];
  for (let c = 0; c < ncols(T); c++) {
    swapAttr(T.rows[r1].cells[c].attrs, T.rows[r2].cells[c].attrs, 'topline', CELL_ORDER);
    swapAttr(T.rows[r1].cells[c].attrs, T.rows[r2].cells[c].attrs, 'bottomline', CELL_ORDER);
  }
}
/** Tabular::moveColumn: columns swap, but left/right lines stay with the position */
function swapColumns(T: Tab, c1: number, c2: number): void {
  [T.columns[c1], T.columns[c2]] = [T.columns[c2], T.columns[c1]];
  for (let r = 0; r < nrows(T); r++) {
    const cells = T.rows[r].cells;
    [cells[c1], cells[c2]] = [cells[c2], cells[c1]];
    swapAttr(cells[c1].attrs, cells[c2].attrs, 'leftline', CELL_ORDER);
    swapAttr(cells[c1].attrs, cells[c2].attrs, 'rightline', CELL_ORDER);
  }
}

/** Tabular::setAlignment(cell, align, has_width) */
function setAlignmentT(T: Tab, r: number, c: number, align: string, hasWidth: boolean): void {
  const [, col] = startOf(T, r, c);
  if (!isMultiColumn(T, r, c)) {
    for (let rr = 0; rr < nrows(T); rr++) {
      const mr = isMultiRow(T, rr, col), mc = isMultiColumn(T, rr, col);
      if (!(mr && hasWidth) && !mc) set(cellData(T, rr, col).attrs, 'alignment', align, CELL_ORDER);
      if (mr && hasWidth && !mc) set(cellData(T, rr, col).attrs, 'alignment', 'left', CELL_ORDER);
    }
    const ca = T.columns[col].attrs;
    set(ca, 'alignment', align, COLUMN_ORDER);
    // LyX keeps the decimal point in memory but writes it only for decimal columns
    if (align === 'decimal') { if (!get(ca, 'decimal_point')) set(ca, 'decimal_point', '.', COLUMN_ORDER); }
    else set(ca, 'decimal_point', null, COLUMN_ORDER);
  } else {
    set(cellInfo(T, r, c).attrs, 'alignment', align, CELL_ORDER);
  }
}

/** Tabular::setVAlignment(cell, align, onlycolumn) */
function setVAlignmentT(T: Tab, r: number, c: number, valign: string, onlyColumn: boolean): void {
  const [, col] = startOf(T, r, c);
  if (!isMultiColumn(T, r, c) || onlyColumn) set(T.columns[col].attrs, 'valignment', valign, COLUMN_ORDER);
  if (!onlyColumn) set(cellInfo(T, r, c).attrs, 'valignment', valign, CELL_ORDER);
}

/** move the paragraphs of `from` into `to` (Tabular::setMultiColumn: appendParagraphs + clear) */
function mergeContent(to: TabularCell, from: TabularCell): void {
  const paras = from.paragraphs.filter(p => p.items.length);
  if (paras.length) {
    if (to.paragraphs.length === 1 && !to.paragraphs[0].items.length) to.paragraphs = [];
    to.paragraphs.push(...paras);
  }
  from.paragraphs = [plainParagraph()];
}

/** Tabular::unsetMultiColumn */
function unsetMultiColumnT(T: Tab, r: number, c: number): void {
  if (!isMultiColumn(T, r, c)) return;
  const [row, col] = startOf(T, r, c);
  const span = columnSpan(T, row, col);
  for (let i = 0; i < span; i++) {
    const a = cellData(T, row, col + i).attrs;
    // the dialog sets a right line on the begin cell; it would separate the freed cells
    if (get(a, 'multicolumn') === '1' && i < span - 1) set(a, 'rightline', null, CELL_ORDER);
    set(a, 'multicolumn', null, CELL_ORDER);
  }
}

/** Tabular::unsetMultiRow */
function unsetMultiRowT(T: Tab, r: number, c: number): void {
  if (!isMultiRow(T, r, c)) return;
  const [row, col] = startOf(T, r, c);
  const a = cellData(T, row, col).attrs;
  set(a, 'valignment', 'top', CELL_ORDER);
  set(a, 'alignment', 'center', CELL_ORDER);
  const span = rowSpan(T, row, col);
  for (let i = 0; i < span; i++) set(cellData(T, row + i, col).attrs, 'multirow', null, CELL_ORDER);
}

/** Tabular::setMultiColumn(cell, number, right_border) */
function setMultiColumnT(T: Tab, row: number, col: number, number: number, rightBorder: boolean): void {
  for (let i = 0; i < number; i++) unsetMultiRowT(T, row, col + i);
  const cs = cellData(T, row, col);
  set(cs.attrs, 'multicolumn', '1', CELL_ORDER);
  const colAlign = get(T.columns[col].attrs, 'alignment');
  if (colAlign !== 'decimal') set(cs.attrs, 'alignment', colAlign ?? 'center', CELL_ORDER);
  set(cs.attrs, 'rightline', rightBorder ? 'true' : null, CELL_ORDER);
  for (let i = 1; i < number && col + i < ncols(T); i++) {
    const cs1 = cellData(T, row, col + i);
    set(cs1.attrs, 'multicolumn', '2', CELL_ORDER);
    mergeContent(cs, cs1);
  }
}

/** Tabular::setMultiRow(cell, number, bottom_border, halign) */
function setMultiRowT(T: Tab, row: number, col: number, number: number, bottomBorder: boolean, halign: string): void {
  for (let i = 0; i < number; i++) unsetMultiColumnT(T, row + i, col);
  const cs = cellData(T, row, col);
  set(cs.attrs, 'multirow', '1', CELL_ORDER);
  set(cs.attrs, 'valignment', 'middle', CELL_ORDER);
  // the horizontal alignment of multirow cells follows the column unless it has a width
  set(cs.attrs, 'alignment', columnHasWidth(T, col) ? 'left' : halign, CELL_ORDER);
  set(cs.attrs, 'bottomline', bottomBorder ? 'true' : null, CELL_ORDER);
  for (let i = 1; i < number && row + i < nrows(T); i++) {
    const cs1 = cellData(T, row + i, col);
    set(cs1.attrs, 'multirow', '2', CELL_ORDER);
    mergeContent(cs, cs1);
  }
}

/* ------------------------------------------------- PM table <-> Tabular AST */

/** the table's JSON without any cell content (enough for status queries and `dispatch`-less calls) */
function shallowJSON(table: PMNode): PMJSON {
  const rows: PMJSON[] = [];
  table.forEach(row => {
    const cells: PMJSON[] = [];
    row.forEach(cell => cells.push({ type: cell.type.name, attrs: { ...cell.attrs, contContent: null } }));
    rows.push({ type: 'table_row', attrs: row.attrs, content: cells });
  });
  return { type: 'table', attrs: table.attrs, content: rows };
}

function toTabular(table: PMNode, shallow: boolean): Tab {
  const json = shallow ? shallowJSON(table) : table.toJSON();
  const [p] = pmBlocksToParagraphs([{ type: 'paragraph', attrs: { layout: 'Plain Layout', depth: 0 }, content: [json] }]);
  const it = p.items[0];
  if (!it || it.kind !== 'inset' || it.inset.type !== 'Tabular') throw new Error('tablecommands: not a table');
  return it.inset;
}

const fromTabular = (T: Tab): PMNode => schema.nodeFromJSON(insetToPm(T));

/** start cells of a PM table with their grid coordinates */
interface CellLayout { node: PMNode; pos: number; r: number; c: number }
function layoutCells(table: PMNode, tablePos: number): CellLayout[] {
  const out: CellLayout[] = [];
  const grid: boolean[][] = [];
  table.forEach((row, rowOffset, r) => {
    grid[r] ??= [];
    let c = 0;
    row.forEach((cell, cellOffset) => {
      while (grid[r][c]) c++;
      const cs = cell.attrs.colspan ?? 1, rs = cell.attrs.rowspan ?? 1;
      out.push({ node: cell, pos: tablePos + 1 + rowOffset + 1 + cellOffset, r, c });
      for (let dr = 0; dr < rs; dr++) for (let dc = 0; dc < cs; dc++) (grid[r + dr] ??= [])[c + dc] = true;
      c += cs;
    });
  });
  return out;
}

interface Rect { rs: number; re: number; cs: number; ce: number }
interface Context { ctx: TableContext; T: Tab; cells: CellLayout[]; cur: CellLayout; anchor: CellLayout; head: CellLayout; rect: Rect; multi: boolean }

/** the table_cell of `ctx.table` that contains $pos (null if $pos is outside this table) */
function cellOfPos(state: EditorState, ctx: TableContext, pos: number, cells: CellLayout[]): CellLayout | null {
  const $pos = state.doc.resolve(pos);
  let cellPos: number | null = null;
  for (let d = $pos.depth; d > 0; d--) {
    const n = $pos.node(d);
    if (n.type.name === 'table_cell' && cellPos === null) cellPos = $pos.before(d);
    else if (n.type.name === 'table') { if ($pos.before(d) !== ctx.tablePos) cellPos = null; break; }
  }
  return cellPos === null ? null : cells.find(x => x.pos === cellPos) ?? null;
}

/** InsetTabular::getSelection: the rectangle between the first and last selected cell */
function context(state: EditorState, shallow: boolean): Context | null {
  const ctx = tableContext(state);
  if (!ctx) return null;
  const cells = layoutCells(ctx.table, ctx.tablePos);
  const cur = cells.find(x => x.pos === ctx.cellPos);
  if (!cur) return null;
  let anchor = cur, head = cur;
  const sel = state.selection;
  if (sel instanceof CellSelection) {
    anchor = cells.find(x => x.pos === sel.$anchorCell.pos) ?? cur;
    head = cells.find(x => x.pos === sel.$headCell.pos) ?? cur;
  } else if (sel.from !== sel.to) {
    const a = cellOfPos(state, ctx, sel.anchor, cells), h = cellOfPos(state, ctx, sel.head, cells);
    if (a && h) { anchor = a; head = h; }
  }
  const rect = { rs: Math.min(anchor.r, head.r), re: Math.max(anchor.r, head.r), cs: Math.min(anchor.c, head.c), ce: Math.max(anchor.c, head.c) };
  const multi = anchor !== head;
  return { ctx, T: toTabular(ctx.table, shallow), cells, cur, anchor, head, rect, multi };
}

/** where the cursor goes after the table was rebuilt */
interface Target {
  r: number; c: number;
  /** keep the cursor offset inside the cell (the cell content is unchanged) */
  keepOffset?: boolean;
  /** re-create the cell selection between these grid coordinates */
  sel?: { ar: number; ac: number; hr: number; hc: number };
}

/**
 * Run a table feature: `fn` edits the Tabular AST and returns the cursor target, or false when
 * the feature does not apply (LyX would disable the button).
 */
function feature(fn: (C: Context) => Target | false): Command {
  return (state, dispatch) => {
    const C = context(state, !dispatch);
    if (!C) return false;
    const target = fn(C);
    if (!target) return false;
    if (!dispatch) return true;
    const { ctx } = C;
    const table = fromTabular(C.T);
    const tr = state.tr.replaceWith(ctx.tablePos, ctx.tablePos + ctx.table.nodeSize, table);
    const cells = layoutCells(table, ctx.tablePos);
    const covering = (r: number, c: number) => {
      // start cell of the span covering (r, c)
      let best: CellLayout | null = null;
      for (const x of cells) {
        const cs = x.node.attrs.colspan ?? 1, rs = x.node.attrs.rowspan ?? 1;
        if (x.r <= r && r < x.r + rs && x.c <= c && c < x.c + cs) { best = x; break; }
      }
      return best ?? cells[0];
    };
    const dest = covering(target.r, target.c);
    let selection: Selection | null = null;
    if (target.sel) {
      const a = covering(target.sel.ar, target.sel.ac), h = covering(target.sel.hr, target.sel.hc);
      if (a !== h) selection = CellSelection.create(tr.doc, a.pos, h.pos);
    }
    if (!selection && target.keepOffset && dest.node.content.eq(C.cur.node.content)) {
      const sel = state.selection;
      const inCell = (p: number) => p > ctx.cellPos && p < ctx.cellPos + ctx.cell.nodeSize;
      if (sel instanceof TextSelection && inCell(sel.anchor) && inCell(sel.head)) {
        const map = (p: number) => dest.pos + (p - ctx.cellPos);
        try {
          const $a = tr.doc.resolve(map(sel.anchor)), $h = tr.doc.resolve(map(sel.head));
          if ($a.parent.isTextblock && $h.parent.isTextblock) selection = TextSelection.between($a, $h);
        } catch { /* fall through */ }
      }
    }
    if (!selection) selection = Selection.near(tr.doc.resolve(dest.pos + 1), 1);
    dispatch(tr.setSelection(selection).scrollIntoView());
    return true;
  };
}

const sameSel = (C: Context) => C.multi ? { ar: C.anchor.r, ac: C.anchor.c, hr: C.head.r, hc: C.head.c } : undefined;

/* ---------------------------------------------------------------- commands */

/** tabular-feature append-row: a new row below the cursor row (inherits lines like LyX). */
export const appendRow: Command = feature(C => {
  insertRow(C.T, C.cur.r);
  return { r: C.cur.r, c: C.cur.c, keepOffset: true };
});

/** tabular-feature append-column: a new column right of the cursor column. */
export const appendColumn: Command = feature(C => {
  insertColumn(C.T, C.cur.c);
  return { r: C.cur.r, c: C.cur.c, keepOffset: true };
});

/** tabular-feature delete-row: deletes the selected rows (never the last one). */
export const deleteRow: Command = feature(C => {
  const { T, rect: { rs, re } } = C;
  if (nrows(T) === 1) return false;
  if (re === nrows(T) - 1 && rs !== 0) {
    // the bottom line of the table moves up to the row that becomes the last one
    for (let c = 0; c < ncols(T); c++) {
      setLine(T, rs - 1, c, 'bottomline', bottomLine(T, re, c));
      const bt = useBooktabs(T);
      setLine(T, rs - 1, c, 'bottomlineltrim', bt && lineOf(T, re, c, 'bottomlineltrim'));
      setLine(T, rs - 1, c, 'bottomlinertrim', bt && lineOf(T, re, c, 'bottomlinertrim'));
    }
  }
  for (let r = rs; r <= re; r++) if (!deleteRowT(T, rs)) break;
  return { r: Math.min(rs, nrows(T) - 1), c: C.cur.c };
});

/** tabular-feature delete-column: deletes the selected columns (never the last one). */
export const deleteColumn: Command = feature(C => {
  const { T, rect: { cs, ce } } = C;
  if (ncols(T) === 1) return false;
  if (ce === ncols(T) - 1 && cs !== 0)
    for (let r = 0; r < nrows(T); r++) setLine(T, r, cs - 1, 'rightline', rightLine(T, r, ce));
  if (cs === 0 && ce !== ncols(T) - 1)
    for (let r = 0; r < nrows(T); r++) setLine(T, r, ce + 1, 'leftline', leftLine(T, r, 0));
  for (let c = cs; c <= ce; c++) if (!deleteColumnT(T, cs)) break;
  return { r: C.cur.r, c: Math.min(cs, ncols(T) - 1) };
});

function moveRows(dir: -1 | 1): Command {
  return feature(C => {
    const { T, rect: { rs, re } } = C;
    if (dir < 0 ? rs === 0 : re === nrows(T) - 1) return false;
    // LyX refuses to move rows that take part in a multirow
    for (let r = rs - (dir < 0 ? 1 : 0); r <= re + (dir > 0 ? 1 : 0); r++) if (hasMultiRow(T, r)) return false;
    if (dir < 0) for (let r = rs; r <= re; r++) swapRows(T, r - 1, r);
    else for (let r = re; r >= rs; r--) swapRows(T, r, r + 1);
    const s = sameSel(C);
    return { r: C.cur.r + dir, c: C.cur.c, keepOffset: true, sel: s && { ar: s.ar + dir, ac: s.ac, hr: s.hr + dir, hc: s.hc } };
  });
}
function moveColumns(dir: -1 | 1): Command {
  return feature(C => {
    const { T, rect: { cs, ce } } = C;
    if (dir < 0 ? cs === 0 : ce === ncols(T) - 1) return false;
    // LyX refuses to move columns that take part in a multicolumn
    for (let c = cs - (dir < 0 ? 1 : 0); c <= ce + (dir > 0 ? 1 : 0); c++) if (hasMultiColumn(T, c)) return false;
    if (dir < 0) for (let c = cs; c <= ce; c++) swapColumns(T, c - 1, c);
    else for (let c = ce; c >= cs; c--) swapColumns(T, c, c + 1);
    const s = sameSel(C);
    return { r: C.cur.r, c: C.cur.c + dir, keepOffset: true, sel: s && { ar: s.ar, ac: s.ac + dir, hr: s.hr, hc: s.hc + dir } };
  });
}

/** tabular-feature move-row-up / move-row-down (lines stay in place, as in LyX). */
export const moveRowUp: Command = moveRows(-1);
export const moveRowDown: Command = moveRows(1);
/** tabular-feature move-column-left / move-column-right. */
export const moveColumnLeft: Command = moveColumns(-1);
export const moveColumnRight: Command = moveColumns(1);

/** tabular-feature toggle-line-{top,bottom,left,right}: the cursor cell decides, the selection follows. */
export function toggleLine(which: 'top' | 'bottom' | 'left' | 'right'): Command {
  return feature(C => {
    const { T, cur, rect } = C;
    const on = which === 'top' ? !topLine(T, cur.r, cur.c) : which === 'bottom' ? !bottomLine(T, cur.r, cur.c)
      : which === 'left' ? !leftLine(T, cur.r, cur.c) : !rightLine(T, cur.r, cur.c);
    for (let r = rect.rs; r <= rect.re; r++)
      for (let c = rect.cs; c <= rect.ce; c++) setLine(T, r, c, which + 'line', on);
    return { r: cur.r, c: cur.c, keepOffset: true, sel: sameSel(C) };
  });
}

/** tabular-feature toggle-border-lines: unset if the selection already has all outside borders. */
export const toggleBorderLines: Command = feature(C => {
  const { T, rect: { rs, re, cs, ce } } = C;
  const border = !outsideBorders(T, rs, re, cs, ce);
  for (let r = rs; r <= re; r++) { setLine(T, r, cs, 'leftline', border); setLine(T, r, ce, 'rightline', border); }
  for (let c = cs; c <= ce; c++) { setLine(T, rs, c, 'topline', border); setLine(T, re, c, 'bottomline', border); }
  return { r: C.cur.r, c: C.cur.c, keepOffset: true, sel: sameSel(C) };
});

/** tabular-feature toggle-inner-lines */
export const toggleInnerLines: Command = feature(C => {
  const { T, rect: { rs, re, cs, ce } } = C;
  setLines(T, rs, re, cs, ce, true, !innerBorders(T, rs, re, cs, ce));
  return { r: C.cur.r, c: C.cur.c, keepOffset: true, sel: sameSel(C) };
});

/** tabular-feature toggle-all-lines */
export const toggleAllLines: Command = feature(C => {
  const { T, rect: { rs, re, cs, ce } } = C;
  setLines(T, rs, re, cs, ce, false, !innerBorders(T, rs, re, cs, ce) || !outsideBorders(T, rs, re, cs, ce));
  return { r: C.cur.r, c: C.cur.c, keepOffset: true, sel: sameSel(C) };
});

/** tabular-feature unset-all-lines */
export const unsetAllLines: Command = feature(C => {
  const { T, rect: { rs, re, cs, ce } } = C;
  setLines(T, rs, re, cs, ce, false, false);
  return { r: C.cur.r, c: C.cur.c, keepOffset: true, sel: sameSel(C) };
});

/**
 * tabular-feature reset-formal-default: the booktabs default — top and bottom line on the first
 * and the last row, none elsewhere (vertical lines are untouched; booktabs ignores them).
 * LyX enables this only for booktabs tables.
 */
export const resetFormalDefault: Command = feature(C => {
  const { T } = C;
  if (!useBooktabs(T)) return false;
  for (let r = 0; r < nrows(T); r++) {
    const headOrFoot = r === 0 || r === nrows(T) - 1;
    for (let c = 0; c < ncols(T); c++) { setLine(T, r, c, 'topline', headOrFoot); setLine(T, r, c, 'bottomline', headOrFoot); }
  }
  return { r: C.cur.r, c: C.cur.c, keepOffset: true, sel: sameSel(C) };
});

/**
 * tabular-feature align-{left,center,right,decimal} (m-align-* for multicolumn cells): the
 * column's alignment, or the cell's own for a multicolumn cell. Decimal alignment also sets the
 * column's decimal point ("." — LyX takes the document language's separator).
 */
export function setAlignment(align: 'left' | 'center' | 'right' | 'decimal' | 'block'): Command {
  return feature(C => {
    const { T, rect: { rs, re, cs, ce }, cur } = C;
    if (align === 'decimal' && (isMultiRow(T, cur.r, cur.c) || isMultiColumn(T, cur.r, cur.c))) return false;
    for (let r = rs; r <= re; r++)
      for (let c = cs; c <= ce; c++) setAlignmentT(T, r, c, align, columnHasWidth(T, startOf(T, r, c)[1]));
    return { r: cur.r, c: cur.c, keepOffset: true, sel: sameSel(C) };
  });
}

/**
 * tabular-feature valign-{top,middle,bottom} (m-valign-* for multicolumn cells): the column's
 * vertical alignment; for a multicolumn cell only the cell's own.
 */
export function setVAlignment(valign: 'top' | 'middle' | 'bottom'): Command {
  return feature(C => {
    const { T, rect: { rs, re, cs, ce }, cur } = C;
    const onlyColumn = !isMultiColumn(T, cur.r, cur.c);
    for (let r = rs; r <= re; r++)
      for (let c = cs; c <= ce; c++) setVAlignmentT(T, r, c, valign, onlyColumn);
    return { r: cur.r, c: cur.c, keepOffset: true, sel: sameSel(C) };
  });
}

const rotated = (T: Tab, r: number, c: number) => (get(cellInfo(T, r, c).attrs, 'rotate') ?? '0') !== '0';

/** tabular-feature toggle-rotate-cell: rotate the selected cells by 90° unless all are rotated. */
export const toggleRotateCell: Command = feature(C => {
  const { T, rect: { rs, re, cs, ce } } = C;
  let oneNotRotated = false;
  for (let r = rs; r <= re; r++) for (let c = cs; c <= ce; c++) if (!rotated(T, r, c)) oneNotRotated = true;
  for (let r = rs; r <= re; r++)
    for (let c = cs; c <= ce; c++) set(cellInfo(T, r, c).attrs, 'rotate', oneNotRotated ? '90' : null, CELL_ORDER);
  return { r: C.cur.r, c: C.cur.c, keepOffset: true, sel: sameSel(C) };
});

/** tabular-feature toggle-rotate-tabular: rotate the table by 90° or unset the rotation. */
export const toggleRotateTable: Command = feature(C => {
  const { T } = C;
  set(T.features, 'rotate', (get(T.features, 'rotate') ?? '0') !== '0' ? null : '90', FEATURE_ORDER);
  return { r: C.cur.r, c: C.cur.c, keepOffset: true, sel: sameSel(C) };
});

/**
 * tabular-feature multicolumn: merge the selected cells of one row into a multicolumn (or make
 * the cursor cell a single-cell multicolumn); on a multicolumn cell without selection, split it.
 */
export const toggleMultiColumn: Command = feature(C => {
  const { T, rect: { rs, re, cs, ce }, cur, anchor, head } = C;
  if (rs !== re) return false;
  if (!C.multi) {
    if (isMultiColumn(T, cur.r, cur.c)) unsetMultiColumnT(T, cur.r, cur.c);
    else setMultiColumnT(T, cur.r, cur.c, 1, rightLine(T, cur.r, cur.c));
    return { r: cur.r, c: cur.c, keepOffset: true };
  }
  let merge = false;
  for (let c = cs; c <= ce; c++) if (!isMultiColumn(T, rs, c)) merge = true;
  if (!merge) return false; // LyX: unsetting needs a cursor without selection
  const first = anchor.c <= head.c ? anchor : head, last = first === anchor ? head : anchor;
  setMultiColumnT(T, first.r, first.c, ce - cs + 1, rightLine(T, last.r, last.c));
  return { r: first.r, c: first.c };
});

/**
 * tabular-feature multirow: merge the selected cells of one column into a multirow (or make the
 * cursor cell a single-cell multirow); on a multirow cell without selection, split it.
 */
export const toggleMultiRow: Command = feature(C => {
  const { T, rect: { rs, re, cs, ce }, cur, anchor, head } = C;
  if (cs !== ce) return false;
  if (!C.multi) {
    if (isMultiRow(T, cur.r, cur.c)) unsetMultiRowT(T, cur.r, cur.c);
    else setMultiRowT(T, cur.r, cur.c, 1, bottomLine(T, cur.r, cur.c), getAlignment(T, cur.r, cur.c));
    return { r: cur.r, c: cur.c, keepOffset: true };
  }
  let merge = false;
  for (let r = rs; r <= re; r++) if (!isMultiRow(T, r, cs)) merge = true;
  if (!merge) return false;
  const first = anchor.r <= head.r ? anchor : head, last = first === anchor ? head : anchor;
  setMultiRowT(T, first.r, first.c, re - rs + 1, bottomLine(T, last.r, last.c), getAlignment(T, last.r, last.c));
  return { r: first.r, c: first.c };
});

/* ------------------------------------------------------------- toolbar state */

export interface TableToolbarState {
  inTable: boolean;
  /** all selected cells are rotated */
  rotateCell: boolean;
  rotateTable: boolean;
  multicolumn: boolean;
  multirow: boolean;
  /** lines of the cursor cell (left/right are always off with booktabs) */
  lines: { top: boolean; bottom: boolean; left: boolean; right: boolean };
  borderLines: boolean;
  innerLines: boolean;
  allLines: boolean;
  booktabs: boolean;
  /** effective alignment of the cursor cell: its own for multicolumns, the column's otherwise */
  align: string | null;
  valign: string | null;
}

const NOT_IN_TABLE: TableToolbarState = {
  inTable: false, rotateCell: false, rotateTable: false, multicolumn: false, multirow: false,
  lines: { top: false, bottom: false, left: false, right: false }, borderLines: false, innerLines: false, allLines: false,
  booktabs: false, align: null, valign: null,
};

/** On/off state of the table toolbar buttons (InsetTabular::getFeatureStatus). */
export function tableToolbarState(state: EditorState): TableToolbarState {
  const C = context(state, true);
  if (!C) return NOT_IN_TABLE;
  const { T, cur, rect: { rs, re, cs, ce } } = C;
  let allRotated = true;
  for (let r = rs; r <= re; r++) for (let c = cs; c <= ce; c++) if (!rotated(T, r, c)) allRotated = false;
  const inner = innerBorders(T, rs, re, cs, ce), outside = outsideBorders(T, rs, re, cs, ce);
  return {
    inTable: true,
    rotateCell: allRotated,
    rotateTable: (get(T.features, 'rotate') ?? '0') !== '0',
    multicolumn: isMultiColumn(T, cur.r, cur.c),
    multirow: isMultiRow(T, cur.r, cur.c),
    lines: { top: topLine(T, cur.r, cur.c), bottom: bottomLine(T, cur.r, cur.c), left: leftLine(T, cur.r, cur.c), right: rightLine(T, cur.r, cur.c) },
    borderLines: outside, innerLines: inner, allLines: inner && outside,
    booktabs: useBooktabs(T),
    align: getAlignment(T, cur.r, cur.c),
    valign: getVAlignment(T, cur.r, cur.c),
  };
}
