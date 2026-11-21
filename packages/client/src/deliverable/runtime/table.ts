/**
 * Tables on the canvas (tablemodel.ts has the source format): a `<table>` is an object like a text
 * box — selected, moved, resized, deleted by edit.ts — whose cells are typed in one at a time, each
 * the text being retyped as a text box's is (edit.ts beginText: bold, colours, formulas, links).
 *
 * A click in a cell types there; Tab / Shift+Tab go to the next / previous cell (Tab in the last one
 * adds a row), the arrow keys leave a cell at its edge, Enter is a line break, Esc ends typing with
 * the table selected. Rows and columns are added and removed at the cell typed in last (the
 * toolbar's Table section, the right-click menu); the borders between columns and under rows are
 * dragged. Every change is operations on the source (rows and cells inserted and removed, attributes
 * and styles set), as any other edit of the canvas.
 */
import type { HtmlOp, Path } from '../protocol';
import { BORDERS_ATTR, TABLE_CLASS, tableHtml, tablePlace, clipTable, type TableBorders, type TableCmd, type TableInfo } from '../tablemodel';
import { srcOf, pathOf, liveAt, sourced, docRect, state } from './env';
import { chipBeside } from './mathedit';
import { textListItem } from './textnavigation';
import { phRole, isEmptyPh } from './placeholders';

/**
 * The look of `table.ol-table`, in every mode (index.ts): the slide's font and colour, rules in the
 * text's colour (so it reads on light and dark slides and in every design; with all borders the header
 * row tinted with the design's `--accent`), sizes in em (a poster's table has a poster's rules). Stronger than a page's `* { padding: 0 }` reset, weaker than what a
 * page says about its own tables' cells by class, and than a cell's own style.
 */
const T = `table.${TABLE_CLASS}`, RULES = `${T}:not([${BORDERS_ATTR}="all"], [${BORDERS_ATTR}="none"])`, ALL = `${T}[${BORDERS_ATTR}="all"]`;
export const TABLE_CSS = `
  ${T} { border-collapse: collapse; table-layout: fixed; box-sizing: border-box; margin: 0; text-align: left; line-height: 1.3; font-variant-numeric: tabular-nums; border: 0 solid currentColor; }
  ${T} :is(th, td) { box-sizing: border-box; padding: 0.3em 0.6em; height: 1.9em; text-align: inherit; vertical-align: middle; font-weight: inherit; overflow-wrap: break-word; border: 0 solid currentColor; }
  ${T} th { font-weight: 600; }
  ${RULES} { border-top-width: max(1.5px, 0.08em); border-bottom-width: max(1.5px, 0.08em); }
  ${RULES} tr:first-child > th { border-bottom-width: max(1px, 0.045em); }
  ${ALL} :is(th, td) { border-width: max(1px, 0.045em); }
  ${ALL} tr:first-child > th { background: color-mix(in srgb, var(--accent, currentColor) 14%, transparent); }`;

/** in the canvas's overlay (edit.ts): the cell typed in, the borders that are dragged */
export const TABLE_OVERLAY_CSS = `
    .tcell { position: absolute; box-sizing: border-box; border: calc(1.5px * var(--s)) solid #e8a33d; pointer-events: none; }
    .tcell.last { border-style: dashed; border-color: rgba(47,111,222,.75); }
    .tgrip { position: absolute; pointer-events: auto; touch-action: none; }
    .tgrip.col { cursor: col-resize; }
    .tgrip.row { cursor: row-resize; }
    .tline { position: absolute; background: #2f6fde; pointer-events: none; }`;

interface Host {
  editing(): HTMLElement | null;
  beginText(el: HTMLElement, at: { x: number; y: number } | null, selectAll?: boolean): void;
  stopText(): void;
  commit(ops: HtmlOp[], extra?: { select?: 'inserted' | 'keep' | Path[] }): void;
  selection(): Element[];
  setSelection(els: Element[]): void;
  report(): void;
  draw(): void;
  isLocked(el: Element): boolean;
  scale(): number;
  /** the pointer kept through a drag of a border (the overlay is redrawn meanwhile) */
  capture(e: PointerEvent): void;
  /** the slide in view (a new table goes there) */
  visibleSlide(): HTMLElement | null;
}
let H: Host;
export function initTables(h: Host): void { H = h; }

type Cell = HTMLTableCellElement;

/* ------------------------------------------------------------------ the table as a grid */

interface Grid { rows: HTMLTableRowElement[]; at: (Cell | null)[][]; cols: number }

/** its rows and, for every place of the grid, the cell there (a merged cell at each of its places) */
function gridOf(table: HTMLTableElement): Grid {
  const rows = Array.from(table.rows).filter(r => srcOf.has(r) && r.closest('table') === table);
  const at: (Cell | null)[][] = rows.map(() => []);
  rows.forEach((tr, r) => {
    let c = 0;
    for (const cell of Array.from(tr.cells)) {
      if (!srcOf.has(cell)) continue;
      while (at[r][c]) c++;
      const cs = Math.max(1, cell.colSpan || 1), rs = Math.max(1, cell.rowSpan || 1);
      for (let i = 0; i < rs && r + i < rows.length; i++) for (let j = 0; j < cs; j++) at[r + i][c + j] = cell;
      c += cs;
    }
  });
  const cols = Math.max(0, ...at.map(a => a.length));
  for (const a of at) while (a.length < cols) a.push(null);
  return { rows, at, cols };
}

function posOf(g: Grid, cell: Cell): { row: number; col: number } | null {
  for (let r = 0; r < g.at.length; r++) { const c = g.at[r].indexOf(cell); if (c >= 0) return { row: r, col: c }; }
  return null;
}

/** its cells in reading order */
function cellsOf(g: Grid): Cell[] {
  const out: Cell[] = [];
  for (const row of g.at) for (const c of row) if (c && !out.includes(c)) out.push(c);
  return out;
}

/** a table of the page's source (one that is edited) */
export function tableOf(el: Element | null | undefined): HTMLTableElement | null {
  return el instanceof HTMLTableElement && srcOf.has(el) ? el : null;
}

function cellOf(n: Element | null | undefined, table?: HTMLTableElement): Cell | null {
  const c = n?.closest?.('td, th') as Cell | null;
  if (!c || !srcOf.has(c)) return null;
  const t = c.closest('table');
  return t && srcOf.has(t) && (!table || t === table) ? c : null;
}

/** the cell being typed in */
function typedCell(table?: HTMLTableElement | null): Cell | null {
  const e = H.editing();
  if (!e || (e.localName !== 'td' && e.localName !== 'th')) return null;
  return cellOf(e, table ?? undefined);
}

/** the table the commands are for: the one selected, or the one typed in */
function currentTable(): HTMLTableElement | null {
  const typed = typedCell();
  if (typed) return typed.closest('table') as HTMLTableElement;
  const sel = H.selection();
  return sel.length === 1 ? tableOf(sel[0]) : null;
}

const srcIndex = (el: Element): number => { const s = srcOf.get(el)!; return Array.prototype.indexOf.call(s.parentElement!.children, s); };
const headerRow = (g: Grid, r: number): boolean => { const cells = g.at[r]?.filter((c): c is Cell => !!c) ?? []; return cells.length > 0 && cells.every(c => c.localName === 'th'); };

/* ------------------------------------------------------------------ typing in cells */

/** the cell typed in last (rows and columns are added there, also once typing has ended) */
let last: { table: HTMLTableElement; row: number; col: number } | null = null;
/** the cell to type in once the table has it (a row was added for it) */
let pending: { path: Path; row: number; col: number; all: boolean; version: number | null; until: number } | null = null;
/** a command waiting for the text typed until now to be in the source */
let waiting: { run(): void; version: number | null; timer: ReturnType<typeof setTimeout> } | null = null;

function enterCell(table: HTMLTableElement, cell: Cell, at: { x: number; y: number } | null, selectAll = false, caret: 'start' | 'end' = 'end'): void {
  const p = posOf(gridOf(table), cell);
  last = p ? { table, ...p } : null;
  const sel = H.selection();
  if (!(sel.length === 1 && sel[0] === table)) H.setSelection([table]);
  H.beginText(cell, at, selectAll);
  if (!at && !selectAll && caret === 'start' && H.editing() === cell) {
    const r = document.createRange();
    r.selectNodeContents(cell); r.collapse(true);
    getSelection()?.removeAllRanges(); getSelection()?.addRange(r);
  }
  H.report();
  H.draw();
}

function cellAt(table: HTMLTableElement, x: number, y: number): Cell | null {
  for (const n of document.elementsFromPoint(x, y)) {
    const c = cellOf(n, table);
    if (c) return c;
    if (n === table) break;
  }
  for (const c of cellsOf(gridOf(table))) { const r = c.getBoundingClientRect(); if (x >= r.left && x <= r.right && y >= r.top && y <= r.bottom) return c; }
  return null;
}

/** a click on a table (not a drag, which moves it): the cell there is typed in */
export function tableClick(el: Element, e: { clientX: number; clientY: number }): boolean {
  const table = tableOf(el);
  if (!table || H.isLocked(table) || state.version === null || state.kind === 'page') return false;
  const cell = cellAt(table, e.clientX, e.clientY);
  if (!cell) return false;
  enterCell(table, cell, { x: e.clientX, y: e.clientY });
  return true;
}

/** a double click on a cell (of a table in a group too) */
export function tableDblClick(t: Element, e: { clientX: number; clientY: number }): boolean {
  if (state.kind === 'page') return false;
  const cell = cellOf(sourced(t));
  const table = cell?.closest('table') as HTMLTableElement | null;
  if (!cell || !table || H.isLocked(table)) return false;
  enterCell(table, cell, { x: e.clientX, y: e.clientY });
  return true;
}

/** Enter on a selected table: the cell typed in last, else its first */
export function tableEnter(el: Element): boolean {
  const table = tableOf(el);
  if (!table || H.isLocked(table) || state.kind === 'page') return false;
  const g = gridOf(table);
  const cell = (last && last.table === table ? g.at[last.row]?.[last.col] : null) ?? cellsOf(g)[0];
  if (!cell) return false;
  enterCell(table, cell, null, true);
  return true;
}

/** a right click: the commands are for the cell under the pointer */
export function tableMenuAt(el: Element | null, e: { clientX: number; clientY: number }): void {
  const table = tableOf(el);
  if (!table) return;
  const cell = cellAt(table, e.clientX, e.clientY);
  const p = cell ? posOf(gridOf(table), cell) : null;
  if (p) { last = { table, ...p }; H.report(); H.draw(); }
}

/** is the text being retyped a table's cell (its right-click menu is the table's) */
export function typingInCell(): boolean { return !!typedCell(); }

/** the caret is at the cell's edge that way (the arrow key leaves the cell) */
function caretAtEdge(cell: Cell, dir: 'left' | 'right' | 'up' | 'down'): boolean {
  const sel = getSelection();
  if (!sel || !sel.rangeCount || !sel.isCollapsed) return false;
  const r = sel.getRangeAt(0);
  if (!cell.contains(r.startContainer)) return true;
  const holds = (f: DocumentFragment) => !!(f.textContent ?? '').length || !!f.querySelector('.ol-mathchip, img, br, svg');
  const before = document.createRange(); before.selectNodeContents(cell); before.setEnd(r.startContainer, r.startOffset);
  const after = document.createRange(); after.selectNodeContents(cell); after.setStart(r.endContainer, r.endOffset);
  const atStart = !holds(before.cloneContents()), atEnd = !holds(after.cloneContents());
  if (dir === 'left') return atStart;
  if (dir === 'right') return atEnd;
  if (atStart && atEnd) return true;
  // up / down: the caret's line is the cell's first / last
  const box = (rg: Range): DOMRect | null => { const rs = rg.getClientRects(); return rs.length ? rs[dir === 'up' ? 0 : rs.length - 1] : null; };
  const edge = document.createRange(); edge.selectNodeContents(cell); edge.collapse(dir === 'up');
  const a = box(r), b = box(edge);
  const lh = parseFloat(getComputedStyle(cell).lineHeight) || parseFloat(getComputedStyle(cell).fontSize) * 1.3 || 20;
  const k = cell.getBoundingClientRect().height / (cell.offsetHeight || 1) || 1;
  if (a && b) return Math.abs(a.top - b.top) < lh * k * 0.6;
  // (no box for a caret between elements: one line of text leaves at once, more stay with the browser)
  const cst = getComputedStyle(cell);
  return cell.clientHeight - parseFloat(cst.paddingTop) - parseFloat(cst.paddingBottom) < lh * 1.6;
}

/** a key while a cell is typed in: true when it was the table's */
export function tableKey(e: KeyboardEvent): boolean {
  const cell = typedCell();
  if (!cell || e.isComposing || e.ctrlKey || e.metaKey || e.altKey) return false;
  const table = cell.closest('table') as HTMLTableElement;
  const inItem = !!textListItem(cell, getSelection()?.anchorNode);
  if (e.key === 'Tab') {
    if (inItem) return false;
    e.preventDefault();
    const g = gridOf(table), order = cellsOf(g);
    const to = order[order.indexOf(cell) + (e.shiftKey ? -1 : 1)];
    if (to) enterCell(table, to, null, true);
    else if (!e.shiftKey) {
      // past the last cell: a row for it (PowerPoint's, Google Slides')
      tableCommand({ t: 'row', where: 'below' }, 0);
    }
    return true;
  }
  if (e.shiftKey) return false;
  // a line break, not a paragraph: the cell's source stays text
  if (e.key === 'Enter') { if (inItem) return false; e.preventDefault(); document.execCommand('insertLineBreak'); return true; }
  const dir = ({ ArrowLeft: 'left', ArrowRight: 'right', ArrowUp: 'up', ArrowDown: 'down' } as const)[e.key as 'ArrowLeft'];
  if (!dir) return false;
  // (a formula beside the caret is gone into first: edit.ts)
  if ((dir === 'left' || dir === 'right') && chipBeside(dir === 'left' ? 'before' : 'after')) return false;
  if (!caretAtEdge(cell, dir)) return false;
  const g = gridOf(table), p = posOf(g, cell);
  if (!p) return false;
  let to: Cell | null = null;
  if (dir === 'left' || dir === 'right') { const order = cellsOf(g); to = order[order.indexOf(cell) + (dir === 'left' ? -1 : 1)] ?? null; }
  else for (let r = p.row + (dir === 'up' ? -1 : 1); r >= 0 && r < g.rows.length && !to; r += dir === 'up' ? -1 : 1) { const c = g.at[r][p.col]; if (c && c !== cell) to = c; }
  if (!to) return false;
  e.preventDefault();
  enterCell(table, to, null, false, dir === 'left' || dir === 'up' ? 'end' : 'start');
  return true;
}

/** alignment while a cell is typed in is the cell's own (not a block inside it) */
export function cellExec(command: string): boolean {
  const cell = typedCell();
  const a = ({ justifyLeft: 'left', justifyCenter: 'center', justifyRight: 'right', justifyFull: 'justify' } as Record<string, string>)[command];
  if (!cell || !a) return false;
  const path = pathOf(cell);
  cell.style.setProperty('text-align', a);
  if (path) H.commit([{ t: 'style', path, set: { 'text-align': a } }]);
  return true;
}

/** the editor's vertical alignment on a table: its cells' (the one typed in, else all) */
export function tableValign(v: 'flex-start' | 'center' | 'flex-end'): boolean {
  if (!currentTable()) return false;
  tableCommand({ t: 'valign', v: v === 'flex-start' ? 'top' : v === 'flex-end' ? 'bottom' : 'middle' });
  return true;
}

/** after every new version of the source: the cell waited for is typed in, a waiting command runs */
export function tablesAfterSource(): void {
  if (last && !last.table.isConnected) last = null;
  if (waiting && state.version !== waiting.version) { const w = waiting; waiting = null; clearTimeout(w.timer); w.run(); }
  if (!pending) return;
  if (Date.now() > pending.until) { pending = null; return; }
  // (the version the command was made from: the one with its row or column comes next)
  if (state.version === pending.version) return;
  const table = tableOf(liveAt(pending.path));
  if (!table) return;
  const g = gridOf(table);
  const cell = g.at[Math.min(pending.row, g.rows.length - 1)]?.[Math.min(pending.col, g.cols - 1)];
  // (the row asked for is not there yet: an older version came first)
  if (!cell || pending.row >= g.rows.length || H.editing()) return;
  const all = pending.all;
  pending = null;
  enterCell(table, cell, null, all);
}

/** `run` once what was typed in the cell is in the source (its operations are made from the source) */
function afterText(run: () => void): void {
  if (!typedCell()) { run(); return; }
  const version = state.version;
  H.stopText();
  // (what was typed comes back as the next version; nothing typed: nothing comes)
  waiting = { run, version, timer: setTimeout(() => { const w = waiting; waiting = null; w?.run(); }, 250) };
}

/* ------------------------------------------------------------------ what the editor is told */

const VALIGN: Record<string, 'top' | 'middle' | 'bottom'> = { top: 'top', bottom: 'bottom' };

export function tableInfo(el: Element): TableInfo | null {
  const table = tableOf(el);
  if (!table) return null;
  const g = gridOf(table);
  const typed = typedCell(table);
  const cell = typed ?? (last && last.table === table ? g.at[last.row]?.[last.col] ?? null : null);
  const p = cell ? posOf(g, cell) : null;
  const b = table.getAttribute(BORDERS_ATTR);
  const bg = getComputedStyle(cell ?? table).backgroundColor;
  const first = cell ?? cellsOf(g)[0];
  return {
    rows: g.rows.length, cols: g.cols, header: headerRow(g, 0),
    borders: b === 'all' || b === 'none' ? b : 'rules',
    cell: p, typing: !!typed,
    merged: !!cell && ((cell.colSpan || 1) > 1 || (cell.rowSpan || 1) > 1),
    canMerge: { right: !!cell && !!mergeable(g, cell, 'right'), down: !!cell && !!mergeable(g, cell, 'down') },
    fill: bg && bg !== 'rgba(0, 0, 0, 0)' && bg !== 'transparent' ? bg : null,
    valign: first ? VALIGN[getComputedStyle(first).verticalAlign] ?? 'middle' : 'middle',
  };
}

/* ------------------------------------------------------------------ commands */

const pct = (n: number) => `${Math.round(n * 100) / 100}%`;

/** the table's `<col>`s when there is one for each column (their widths are kept through column changes) */
function colsOf(table: HTMLTableElement, g: Grid): HTMLElement[] | null {
  const cols = Array.from(table.querySelectorAll(':scope > colgroup > col')).filter(c => srcOf.has(c)) as HTMLElement[];
  return cols.length === g.cols && cols.every(c => !(c as HTMLTableColElement).span || (c as HTMLTableColElement).span === 1) ? cols : null;
}

/** the columns' widths, % of the table's */
function colWidths(g: Grid, table: HTMLTableElement): number[] {
  const xs = colEdges(g, table);
  const w = xs[g.cols] - xs[0] || 1;
  return Array.from({ length: g.cols }, (_, c) => ((xs[c + 1] - xs[c]) / w) * 100);
}

/** where the columns begin and the last one ends (client px) */
function colEdges(g: Grid, table: HTMLTableElement): number[] {
  const xs: (number | null)[] = Array.from({ length: g.cols + 1 }, () => null);
  for (let r = 0; r < g.at.length; r++) for (let c = 0; c < g.cols; c++) {
    const cell = g.at[r][c];
    if (!cell || (c > 0 && g.at[r][c - 1] === cell)) continue;
    const b = cell.getBoundingClientRect();
    xs[c] ??= b.left;
    xs[c + Math.max(1, cell.colSpan || 1)] ??= b.right;
  }
  const t = table.getBoundingClientRect();
  xs[0] ??= t.left; xs[g.cols] ??= t.right;
  // (a column no cell begins in: between its neighbours)
  for (let c = 1; c < g.cols; c++) if (xs[c] === null) { let n = c + 1; while (xs[n] === null) n++; xs[c] = xs[c - 1]! + (xs[n]! - xs[c - 1]!) / (n - c + 1); }
  return xs as number[];
}

function rowOps(table: HTMLTableElement, g: Grid, r: number, where: 'above' | 'below'): HtmlOp[] {
  const ref = g.rows[r];
  const section = ref?.parentElement, parent = section ? pathOf(section) : null;
  if (!ref || !parent) return [];
  const i = where === 'above' ? r : r + 1;
  const ops: HtmlOp[] = [];
  const grown = new Set<Cell>();
  let cells = '';
  for (let c = 0; c < g.cols; c++) {
    const over = i > 0 && i < g.rows.length ? g.at[i - 1][c] : null;
    // a cell merged across the new row's place grows by it
    if (over && over === g.at[i][c]) {
      const p = pathOf(over);
      if (p && !grown.has(over)) ops.push({ t: 'attr', path: p, name: 'rowspan', value: String((over.rowSpan || 1) + 1) });
      grown.add(over);
      continue;
    }
    const like = g.at[r][c];
    // (a column of row headers goes on; a header row's cells do not)
    cells += like && like.localName === 'th' && !headerRow(g, r) ? '<th></th>' : '<td></td>';
  }
  ops.unshift({ t: 'insert', parent, index: srcIndex(ref) + (where === 'below' ? 1 : 0), html: `<tr>${cells}</tr>` });
  return ops;
}

function colOps(table: HTMLTableElement, g: Grid, c: number, where: 'left' | 'right'): HtmlOp[] {
  const j = where === 'left' ? c : c + 1;
  const ops: HtmlOp[] = [];
  const grown = new Set<Cell>();
  g.rows.forEach((tr, r) => {
    const over = j > 0 && j < g.cols ? g.at[r][j - 1] : null;
    if (over && over === g.at[r][j]) {
      const p = pathOf(over);
      if (p && !grown.has(over)) ops.push({ t: 'attr', path: p, name: 'colspan', value: String((over.colSpan || 1) + 1) });
      grown.add(over);
      return;
    }
    const parent = pathOf(tr);
    if (!parent) return;
    // before the first cell of this row that begins at or after the new column
    let before: Cell | null = null;
    for (let k = j; k < g.cols && !before; k++) { const x = g.at[r][k]; if (x && x.parentElement === tr && (k === 0 || g.at[r][k - 1] !== x)) before = x; }
    const n = srcOf.get(tr)!.children.length;
    ops.push({ t: 'insert', parent, index: before ? srcIndex(before) : n, html: headerRow(g, r) ? '<th></th>' : '<td></td>' });
  });
  // the widths that were set: the new column takes its share of them
  const cols = colsOf(table, g);
  if (cols) {
    const n = g.cols, ws = cols.map(col => parseFloat(col.style.width) || 100 / n), sum = ws.reduce((a, b) => a + b, 0) || 100;
    cols.forEach((col, k) => { const p = pathOf(col); if (p) ops.push({ t: 'style', path: p, set: { width: pct((ws[k] / sum) * 100 * n / (n + 1)) } }); });
    const group = cols[0].parentElement!, gp = pathOf(group);
    const at = j < n ? cols[j] : null;
    if (gp) ops.push({ t: 'insert', parent: gp, index: at ? srcIndex(at) : srcOf.get(group)!.children.length, html: `<col style="width: ${pct(100 / (n + 1))}">` });
  }
  return ops;
}

function delRowOps(table: HTMLTableElement, g: Grid, r: number): HtmlOp[] {
  const tp = pathOf(table);
  if (g.rows.length <= 1) return tp ? [{ t: 'remove', paths: [tp] }] : [];
  const rp = pathOf(g.rows[r]);
  if (!rp) return [];
  const ops: HtmlOp[] = [{ t: 'remove', paths: [rp] }];
  const seen = new Set<Cell>();
  for (const cell of g.at[r]) {
    if (!cell || seen.has(cell) || cell.parentElement === g.rows[r]) continue;
    seen.add(cell);
    const p = pathOf(cell), n = (cell.rowSpan || 1) - 1;
    if (p) ops.push({ t: 'attr', path: p, name: 'rowspan', value: n > 1 ? String(n) : null });
  }
  return ops;
}

function delColOps(table: HTMLTableElement, g: Grid, c: number): HtmlOp[] {
  const tp = pathOf(table);
  if (g.cols <= 1) return tp ? [{ t: 'remove', paths: [tp] }] : [];
  const ops: HtmlOp[] = [];
  const gone: Path[] = [];
  const seen = new Set<Cell>();
  for (let r = 0; r < g.rows.length; r++) {
    const cell = g.at[r][c];
    if (!cell || seen.has(cell)) continue;
    seen.add(cell);
    const p = pathOf(cell);
    if (!p) continue;
    const span = cell.colSpan || 1;
    if (span > 1) ops.push({ t: 'attr', path: p, name: 'colspan', value: span > 2 ? String(span - 1) : null });
    else gone.push(p);
  }
  const cols = colsOf(table, g);
  if (cols) {
    const ws = cols.map(col => parseFloat(col.style.width) || 100 / g.cols), rest = ws.reduce((a, b, k) => (k === c ? a : a + b), 0) || 100;
    cols.forEach((col, k) => { const p = pathOf(col); if (!p) return; if (k === c) gone.push(p); else ops.push({ t: 'style', path: p, set: { width: pct((ws[k] / rest) * 100) } }); });
  }
  if (gone.length) ops.unshift({ t: 'remove', paths: gone });
  return ops;
}

/** the first row's cells as header cells (`<th>`) or ordinary ones */
function headerOps(g: Grid, on: boolean): HtmlOp[] {
  const ops: HtmlOp[] = [];
  const tag = on ? 'th' : 'td';
  for (const cell of new Set(g.at[0] ?? [])) {
    if (!cell || cell.localName === tag || cell.parentElement !== g.rows[0]) continue;
    const p = pathOf(cell), s = srcOf.get(cell);
    if (p && s) ops.push({ t: 'outer', path: p, html: s.outerHTML.replace(/^<t[dh]\b/i, `<${tag}`).replace(/<\/t[dh]>\s*$/i, `</${tag}>`) });
  }
  return ops;
}

/** the cell `cell` merges with that way: as tall (as wide) as it, beginning in its row (column) */
function mergeable(g: Grid, cell: Cell, dir: 'right' | 'down'): Cell | null {
  const p = posOf(g, cell);
  if (!p) return null;
  const cs = cell.colSpan || 1, rs = cell.rowSpan || 1;
  const other = dir === 'right' ? g.at[p.row]?.[p.col + cs] : g.at[p.row + rs]?.[p.col];
  const q = other ? posOf(g, other) : null;
  if (!other || other === cell || !q || !srcOf.has(other)) return null;
  return dir === 'right' ? (q.row === p.row && (other.rowSpan || 1) === rs ? other : null) : (q.col === p.col && (other.colSpan || 1) === cs ? other : null);
}

function mergeOps(g: Grid, cell: Cell, dir: 'right' | 'down'): HtmlOp[] {
  const other = mergeable(g, cell, dir);
  const p = pathOf(cell), op = other ? pathOf(other) : null, a = srcOf.get(cell), b = other ? srcOf.get(other) : null;
  if (!other || !p || !op || !a || !b) return [];
  const ops: HtmlOp[] = dir === 'right'
    ? [{ t: 'attr', path: p, name: 'colspan', value: String((cell.colSpan || 1) + (other.colSpan || 1)) }]
    : [{ t: 'attr', path: p, name: 'rowspan', value: String((cell.rowSpan || 1) + (other.rowSpan || 1)) }];
  // (both texts kept, one under the other)
  const x = a.innerHTML.trim(), y = b.innerHTML.trim();
  if (y) ops.push({ t: 'inner', path: p, html: x ? `${x}<br>${y}` : y });
  // a row whose last cell this was goes with it (an empty <tr> is no row): what spans it a row shorter
  const tr = dir === 'down' ? other.parentElement : null, q = posOf(g, other), trp = tr ? pathOf(tr) : null;
  if (tr && q && trp && !Array.from(tr.children).some(c => c !== other && srcOf.has(c) && (c.localName === 'td' || c.localName === 'th'))) {
    const span = (cell.rowSpan || 1) + (other.rowSpan || 1) - 1;
    ops[0] = { t: 'attr', path: p, name: 'rowspan', value: span > 1 ? String(span) : null };
    for (const c of new Set(g.at[q.row])) {
      const cp = c && c !== cell && c !== other && (posOf(g, c)?.row ?? q.row) < q.row ? pathOf(c) : null;
      if (c && cp) ops.push({ t: 'attr', path: cp, name: 'rowspan', value: (c.rowSpan || 1) > 2 ? String((c.rowSpan || 1) - 1) : null });
    }
    ops.push({ t: 'remove', paths: [trp] });
    return ops;
  }
  ops.push({ t: 'remove', paths: [op] });
  return ops;
}

function splitOps(g: Grid, cell: Cell): HtmlOp[] {
  const p = posOf(g, cell), path = pathOf(cell), src = srcOf.get(cell);
  const cs = cell.colSpan || 1, rs = cell.rowSpan || 1;
  if (!p || !path || !src || (cs === 1 && rs === 1)) return [];
  const empty = (n: number) => `<${cell.localName}></${cell.localName}>`.repeat(n);
  const ops: HtmlOp[] = [];
  if (cs > 1 && rs > 1) {
    const c = src.cloneNode(true) as Element;
    c.removeAttribute('colspan'); c.removeAttribute('rowspan');
    ops.push({ t: 'outer', path, html: c.outerHTML });
  } else ops.push({ t: 'attr', path, name: cs > 1 ? 'colspan' : 'rowspan', value: null });
  const tr = cell.parentElement, tp = tr ? pathOf(tr) : null;
  if (cs > 1 && tp) ops.push({ t: 'insert', parent: tp, index: srcIndex(cell) + 1, html: empty(cs - 1) });
  for (let r = p.row + 1; r < p.row + rs && r < g.rows.length; r++) {
    const row = g.rows[r], rp = pathOf(row);
    if (!rp) continue;
    // before the first cell of that row beginning right of the split one
    let before: Cell | null = null;
    for (let k = p.col + cs; k < g.cols && !before; k++) { const x = g.at[r][k]; if (x && x.parentElement === row && (k === 0 || g.at[r][k - 1] !== x)) before = x; }
    ops.push({ t: 'insert', parent: rp, index: before ? srcIndex(before) : srcOf.get(row)!.children.length, html: empty(cs) });
  }
  return ops;
}

/** what the toolbar's Table section and the menus do (tablemodel.ts TableCmd); `enterCol`: the column typed in after a row was added (Tab) */
export function tableCommand(cmd: TableCmd, enterCol?: number): void {
  if (cmd.t === 'insert') { insertTable(cmd.rows, cmd.cols); return; }
  const table = currentTable();
  if (!table || H.isLocked(table) || state.version === null) return;
  const typed = typedCell(table);
  const tp = pathOf(table);
  if (!tp) return;
  // the cell's own look: while it is typed in, as it is (nothing of its text is touched)
  if (cmd.t === 'fill' || cmd.t === 'valign') {
    const set: Record<string, string | null> = cmd.t === 'fill' ? { background: cmd.color, 'background-color': null } : { 'vertical-align': cmd.v };
    if (typed) {
      for (const [k, v] of Object.entries(set)) { if (v === null) typed.style.removeProperty(k); else typed.style.setProperty(k, v); }
      const p = pathOf(typed);
      if (p) H.commit([{ t: 'style', path: p, set }]);
      H.report();
      return;
    }
    if (cmd.t === 'fill') { H.commit([{ t: 'style', path: tp, set }], { select: 'keep' }); return; }
    const ops: HtmlOp[] = [];
    for (const cell of cellsOf(gridOf(table))) { const p = pathOf(cell); if (p) ops.push({ t: 'style', path: p, set }); }
    H.commit(ops, { select: 'keep' });
    return;
  }
  if (cmd.t === 'borders') {
    const ops: HtmlOp[] = [{ t: 'attr', path: tp, name: BORDERS_ATTR, value: cmd.borders === 'rules' ? null : cmd.borders }];
    // (a table written by hand takes OverLyX's look with the first border style chosen for it)
    if (!table.classList.contains(TABLE_CLASS)) ops.push({ t: 'attr', path: tp, name: 'class', value: `${srcOf.get(table)?.getAttribute('class') ?? ''} ${TABLE_CLASS}`.trim() });
    H.commit(ops, { select: 'keep' });
    return;
  }
  // rows, columns, the header row: made from the source, so what is typed goes there first
  const at0 = typed ? posOf(gridOf(table), typed) : last && last.table === table ? { row: last.row, col: last.col } : null;
  const wasTyping = !!typed;
  afterText(() => {
    const t = tableOf(liveAt(tp));
    if (!t) return;
    const g = gridOf(t);
    if (!g.rows.length || !g.cols) return;
    const row = Math.min(at0?.row ?? g.rows.length - 1, g.rows.length - 1), col = Math.min(at0?.col ?? g.cols - 1, g.cols - 1);
    let ops: HtmlOp[] = [];
    let then = { row, col };
    switch (cmd.t) {
      case 'row': ops = rowOps(t, g, row, cmd.where); then = { row: cmd.where === 'above' ? row : row + 1, col: enterCol ?? (at0 ? col : 0) }; break;
      case 'col': ops = colOps(t, g, col, cmd.where); then = { row: at0 ? row : 0, col: cmd.where === 'left' ? col : col + 1 }; break;
      case 'delRow': ops = delRowOps(t, g, row); then = { row: Math.max(0, Math.min(row, g.rows.length - 2)), col }; break;
      case 'delCol': ops = delColOps(t, g, col); then = { row, col: Math.max(0, Math.min(col, g.cols - 2)) }; break;
      case 'header': ops = headerOps(g, cmd.on); break;
      case 'merge': case 'split': {
        const cell = g.at[row]?.[col];
        if (cell) ops = cmd.t === 'merge' ? mergeOps(g, cell, cmd.dir) : splitOps(g, cell);
        const q = cell ? posOf(g, cell) : null;
        if (q) then = q;
        break;
      }
      case 'evenCols': { const gone = Array.from(t.querySelectorAll(':scope > colgroup')).map(pathOf).filter((p): p is Path => !!p); if (gone.length) ops = [{ t: 'remove', paths: gone }]; break; }
    }
    if (!ops.length) return;
    const whole = ops[0].t === 'remove' && ops[0].paths.length === 1 && ops[0].paths[0].join('/') === tp.join('/');
    H.commit(ops, whole ? {} : { select: 'keep' });
    if (whole) { last = null; return; }
    last = { table: t, ...then };
    // typing goes on: in the new row or column when one was added, else where it was
    if (wasTyping) pending = { path: tp, row: then.row, col: then.col, all: cmd.t === 'row' || cmd.t === 'col', version: state.version, until: Date.now() + 3000 };
    else { H.report(); H.draw(); }
  });
}

/* ------------------------------------------------------------------ the overlay: the cell, the borders dragged */

let gripDrag: { kind: 'col' | 'row'; i: number; table: HTMLTableElement; x0: number; y0: number; min: number; max: number; line: HTMLElement; layer: HTMLElement; d: number } | null = null;

/** the overlay's parts for the selected table (edit.ts draw) */
export function tableParts(): string {
  const table = currentTable();
  if (!table || !table.isConnected || H.isLocked(table) || state.kind === 'page') return '';
  const g = gridOf(table);
  if (!g.rows.length || !g.cols) return '';
  const parts: string[] = [];
  const typed = typedCell(table);
  const cell = typed ?? (last && last.table === table ? g.at[last.row]?.[last.col] : null);
  if (cell && cell.isConnected) { const r = docRect(cell); parts.push(`<div class="tcell${typed ? '' : ' last'}" style="left:${r.x}px;top:${r.y}px;width:${r.w}px;height:${r.h}px"></div>`); }
  if (gripDrag) return parts.join('');
  const t = docRect(table), w = 7 / H.scale();
  const xs = colEdges(g, table);
  for (let c = 1; c < g.cols; c++) parts.push(`<div class="tgrip col" data-tcol="${c}" title="Drag: the column's width" style="left:${xs[c] + scrollX - w / 2}px;top:${t.y}px;width:${w}px;height:${t.h}px"></div>`);
  g.rows.forEach((tr, r) => { const b = docRect(tr); parts.push(`<div class="tgrip row" data-trow="${r}" title="Drag: the row's height" style="left:${t.x}px;top:${b.y + b.h - w / 2}px;width:${t.w}px;height:${w}px"></div>`); });
  return parts.join('');
}

export function bindTableGrips(layer: HTMLElement): void {
  for (const el of Array.from(layer.querySelectorAll('.tgrip'))) el.addEventListener('pointerdown', e => gripDown(e as PointerEvent, el as HTMLElement, layer), true);
}

function gripDown(e: PointerEvent, el: HTMLElement, layer: HTMLElement): void {
  if (e.button !== 0 || gripDrag) return;
  e.preventDefault();
  e.stopPropagation();
  const table = currentTable();
  if (!table || state.version === null) return;
  if (typedCell()) H.stopText();
  const kind = el.dataset.tcol ? 'col' : 'row', i = Number(el.dataset.tcol ?? el.dataset.trow);
  const g = gridOf(table);
  const line = document.createElement('div');
  line.className = 'tline';
  const t = docRect(table), w = 1.5 / H.scale();
  let min: number, max: number;
  if (kind === 'col') {
    const xs = colEdges(g, table), room = Math.min(24 / H.scale(), (xs[i + 1] - xs[i - 1]) / 4);
    min = xs[i - 1] + room - xs[i]; max = xs[i + 1] - room - xs[i];
    line.style.cssText = `left:${xs[i] + scrollX - w / 2}px;top:${t.y}px;width:${w}px;height:${t.h}px`;
  } else {
    const b = docRect(g.rows[i]);
    min = -b.h + 8 / H.scale(); max = 1e5;
    line.style.cssText = `left:${t.x}px;top:${b.y + b.h - w / 2}px;width:${t.w}px;height:${w}px`;
  }
  gripDrag = { kind, i, table, x0: e.clientX, y0: e.clientY, min, max, line, layer, d: 0 };
  H.capture(e);
  H.draw();
  layer.appendChild(line);
  addEventListener('pointermove', gripMove, true);
  addEventListener('pointerup', gripUp, true);
  addEventListener('pointercancel', gripUp, true);
}

function gripMove(e: PointerEvent): void {
  const d = gripDrag;
  if (!d) return;
  e.preventDefault(); e.stopPropagation();
  d.d = Math.max(d.min, Math.min(d.max, d.kind === 'col' ? e.clientX - d.x0 : e.clientY - d.y0));
  if (!d.line.isConnected) d.layer.appendChild(d.line);
  d.line.style.transform = d.kind === 'col' ? `translateX(${d.d}px)` : `translateY(${d.d}px)`;
}

function gripUp(e: PointerEvent): void {
  const d = gripDrag;
  removeEventListener('pointermove', gripMove, true);
  removeEventListener('pointerup', gripUp, true);
  removeEventListener('pointercancel', gripUp, true);
  gripDrag = null;
  if (!d) return;
  e.preventDefault(); e.stopPropagation();
  d.line.remove();
  const table = d.table, tp = pathOf(table);
  if (e.type === 'pointerup' && tp && table.isConnected && Math.abs(d.d) >= 1) {
    const g = gridOf(table);
    const ops: HtmlOp[] = [];
    if (d.kind === 'col') {
      const xs = colEdges(g, table);
      xs[d.i] += d.d;
      const w = xs[g.cols] - xs[0] || 1;
      const ws = Array.from({ length: g.cols }, (_, c) => pct(((xs[c + 1] - xs[c]) / w) * 100));
      const cols = colsOf(table, g);
      if (cols) cols.forEach((col, c) => { const p = pathOf(col); if (p) ops.push({ t: 'style', path: p, set: { width: ws[c] } }); });
      else {
        // (other column groups would count twice)
        const old = Array.from(table.querySelectorAll(':scope > colgroup')).map(pathOf).filter((p): p is Path => !!p);
        if (old.length) ops.push({ t: 'remove', paths: old });
        ops.push({ t: 'insert', parent: tp, index: 0, html: `<colgroup>${ws.map(x => `<col style="width: ${x}">`).join('')}</colgroup>` });
      }
    } else {
      const tr = g.rows[d.i], p = tr ? pathOf(tr) : null;
      // (client px to the slide's)
      const k = tr ? tr.getBoundingClientRect().height / (tr.offsetHeight || 1) || 1 : 1;
      if (tr && p) ops.push({ t: 'style', path: p, set: { height: `${Math.max(4, Math.round((tr.getBoundingClientRect().height + d.d) / k))}px` } });
    }
    if (ops.length) H.commit(ops, { select: 'keep' });
  }
  H.draw();
}

/* ------------------------------------------------------------------ a table pasted */

/**
 * A table put on `slide` — in the place of its empty body placeholder (PowerPoint's), else in the
 * middle before its speaker notes —, selected, its first cell typed in once it is there
 */
function putTable(slide: HTMLElement, rows: number, cols: number, cells?: string[][]): boolean {
  const sp = pathOf(slide), src = srcOf.get(slide);
  if (!sp || !src || state.version === null) return false;
  if (H.editing()) H.stopText();
  const ph = Array.from(slide.children).find(k => (phRole(k) === 'body' || phRole(k) === 'text') && isEmptyPh(k) && !H.isLocked(k));
  const phPath = ph ? pathOf(ph) : null;
  if (ph && phPath) {
    const r = ph.getBoundingClientRect(), s = slide.getBoundingClientRect(), k = slide.offsetWidth / (s.width || 1);
    const place = { x: (r.left - s.left) * k, y: (r.top - s.top) * k, w: r.width * k };
    H.commit([{ t: 'outer', path: phPath, html: tableHtml(rows, cols, place, cells) }], { select: [phPath] });
    pending = { path: phPath, row: 0, col: 0, all: !!cells, version: state.version, until: Date.now() + 3000 };
    return true;
  }
  const kids = Array.from(src.children);
  const notes = kids.findIndex(k => k.localName === 'aside' && k.classList.contains('notes'));
  const index = notes >= 0 ? notes : kids.length;
  const font = parseFloat(getComputedStyle(slide).fontSize) || 16;
  const place = tablePlace(cols, rows, slide.offsetWidth, slide.offsetHeight, font);
  H.commit([{ t: 'insert', parent: sp, index, html: tableHtml(rows, cols, place, cells) }], { select: 'inserted' });
  pending = { path: [...sp, index], row: 0, col: 0, all: !!cells, version: state.version, until: Date.now() + 3000 };
  return true;
}

/** Insert ▸ Table, the toolbar's grid: on the slide of the object selected, else on the slide in view */
function insertTable(rows: number, cols: number): void {
  if (state.kind === 'page') return;
  const sel = H.selection();
  const on = sel.length ? sel[0].closest('.slide') as HTMLElement | null : null;
  const slide = on && srcOf.has(on) ? on : H.visibleSlide();
  if (slide) putTable(slide, rows, cols);
}

/** cells copied from a spreadsheet (an HTML table or tab-separated lines on the clipboard): a table on the slide */
export function pasteTable(d: { html: string; plain: string }, slide: HTMLElement | null): boolean {
  if (!slide || state.kind === 'page' || state.version === null) return false;
  const cells = clipTable(d.html, d.plain);
  return !!cells && putTable(slide, cells.length, cells[0].length, cells);
}

export { colWidths as tableColWidths };
