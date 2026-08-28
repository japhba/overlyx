/**
 * LyX table toolbar commands (packages/client/src/editor/tablecommands.ts): structure after each
 * command, LyX semantics of lines/alignment/spans, and a LyX-file round trip of every result.
 */
import { describe, it, expect, vi } from 'vitest';
// the client's math node views touch `window` at import time
vi.hoisted(() => { const g = globalThis as any; if (typeof g.window === 'undefined') g.window = g; });
import { EditorState, TextSelection, type Command } from 'prosemirror-state';
import type { Node as PMNode } from 'prosemirror-model';
import { CellSelection } from 'prosemirror-tables';
import { schema } from '../packages/core/src/schema.ts';
import { parseLyx } from '../packages/core/src/lyx/parser.ts';
import { writeLyx } from '../packages/core/src/lyx/writer.ts';
import { lyxToPmNode, pmToLyxBody } from '../packages/core/src/convert.ts';
import { insertTable, setTableAttrs } from '../packages/client/src/editor/commands.ts';
import * as tc from '../packages/client/src/editor/tablecommands.ts';

/* ------------------------------------------------------------------ helpers */

type Attrs = [string, string][];
interface Cell { node: PMNode; pos: number; r: number; c: number; attrs: Attrs; cont: Attrs[]; colspan: number; rowspan: number }

/** the (first) table of the document: start cells with grid coordinates, table attrs */
function table(state: EditorState) {
  let tnode: PMNode | null = null, tpos = 0;
  state.doc.descendants((n, pos) => { if (!tnode && n.type.name === 'table') { tnode = n; tpos = pos; } return !tnode; });
  if (!tnode) throw new Error('no table');
  const t = tnode as PMNode;
  const cells: Cell[] = [];
  const grid: boolean[][] = [];
  t.forEach((row, rowOffset, r) => {
    grid[r] ??= [];
    let c = 0;
    row.forEach((cell, cellOffset) => {
      while (grid[r][c]) c++;
      const colspan = cell.attrs.colspan ?? 1, rowspan = cell.attrs.rowspan ?? 1;
      cells.push({ node: cell, pos: tpos + 1 + rowOffset + 1 + cellOffset, r, c, attrs: JSON.parse(cell.attrs.attrs), cont: JSON.parse(cell.attrs.cont || '[]'), colspan, rowspan });
      for (let dr = 0; dr < rowspan; dr++) for (let dc = 0; dc < colspan; dc++) (grid[r + dr] ??= [])[c + dc] = true;
      c += colspan;
    });
  });
  const attrs = new Map<string, string>(JSON.parse(t.attrs.attrs));
  const features = new Map<string, string>(JSON.parse(t.attrs.features));
  const columns: Attrs[] = JSON.parse(t.attrs.columns);
  return { node: t, pos: tpos, cells, attrs, features, columns, nrows: t.childCount, ncols: Math.max(...grid.map(g => g.length)) };
}
const cellAt = (state: EditorState, r: number, c: number): Cell => {
  const x = table(state).cells.find(x => x.r === r && x.c === c);
  if (!x) throw new Error(`no cell at ${r},${c}`);
  return x;
};
const get = (a: Attrs, k: string) => a.find(x => x[0] === k)?.[1];
const lines = (cell: Cell) => ['topline', 'bottomline', 'leftline', 'rightline'].filter(k => get(cell.attrs, k) === 'true').map(k => k.replace('line', '')).join(' ');

function mkState(rows = 3, cols = 3): EditorState {
  let state = EditorState.create({ schema, doc: schema.nodes.doc.create(null, schema.nodes.paragraph.create({ layout: 'Standard' })) });
  state = state.apply(state.tr.setSelection(TextSelection.create(state.doc, 1)));
  insertTable(rows, cols)(state, tr => { state = state.apply(tr); });
  return cursorIn(state, 0, 0);
}
/** cursor at the start of cell (r, c) */
function cursorIn(state: EditorState, r: number, c: number): EditorState {
  const cell = cellAt(state, r, c);
  return state.apply(state.tr.setSelection(TextSelection.create(state.doc, cell.pos + 2)));
}
/** a prosemirror-tables cell selection from (r0, c0) to (r1, c1) */
function select(state: EditorState, r0: number, c0: number, r1: number, c1: number): EditorState {
  return state.apply(state.tr.setSelection(CellSelection.create(state.doc, cellAt(state, r0, c0).pos, cellAt(state, r1, c1).pos)));
}
/** type text at the start of cell (r, c) */
function typeIn(state: EditorState, r: number, c: number, text: string): EditorState {
  const cell = cellAt(state, r, c);
  return state.apply(state.tr.insertText(text, cell.pos + 2));
}
const textOf = (cell: Cell) => cell.node.textContent;

function run(state: EditorState, cmd: Command): { ok: boolean; state: EditorState } {
  let out = state;
  const ok = cmd(state, tr => { out = state.apply(tr); });
  // the command must give the same answer without a dispatch function
  expect(cmd(state)).toBe(ok);
  return { ok, state: out };
}
function apply(state: EditorState, cmd: Command): EditorState {
  const r = run(state, cmd);
  expect(r.ok).toBe(true);
  roundTrip(r.state);
  return r.state;
}

const MINIMAL = `#LyX 2.4 created this file. For more info see https://www.lyx.org/
\\lyxformat 620
\\begin_document
\\begin_header
\\textclass article
\\end_header

\\begin_body

\\begin_layout Standard
x
\\end_layout

\\end_body
\\end_document
`;

/** PM -> LyX text -> parse -> PM must give back the same document, and the text must be stable */
function roundTrip(state: EditorState): string {
  const base = parseLyx(MINIMAL);
  const out = writeLyx({ ...base, body: pmToLyxBody(state.doc) });
  const doc2 = parseLyx(out);
  expect(writeLyx(doc2)).toBe(out);
  const pm2 = lyxToPmNode(doc2);
  expect(pm2.toJSON()).toEqual(state.doc.toJSON());
  return out;
}

/* -------------------------------------------------------------------- tests */

describe('table toolbar: setup', () => {
  it('insertTable gives a 3x3 table with LyX default lines that round-trips', () => {
    const s = mkState();
    const t = table(s);
    expect(t.nrows).toBe(3); expect(t.ncols).toBe(3);
    expect(lines(cellAt(s, 0, 0))).toBe('top bottom left right');
    expect(lines(cellAt(s, 1, 1))).toBe('bottom right');
    const out = roundTrip(s);
    expect(out).toContain('<lyxtabular version="3" rows="3" columns="3">');
  });
  it('commands refuse to act outside a table', () => {
    let s = EditorState.create({ schema, doc: schema.nodes.doc.create(null, schema.nodes.paragraph.create({ layout: 'Standard' }, schema.text('abc'))) });
    s = s.apply(s.tr.setSelection(TextSelection.create(s.doc, 2)));
    for (const cmd of [tc.appendRow, tc.appendColumn, tc.deleteRow, tc.deleteColumn, tc.moveRowUp, tc.moveRowDown, tc.moveColumnLeft, tc.moveColumnRight,
      tc.toggleLine('top'), tc.toggleBorderLines, tc.toggleInnerLines, tc.toggleAllLines, tc.unsetAllLines, tc.resetFormalDefault,
      tc.setAlignment('left'), tc.setVAlignment('middle'), tc.toggleRotateCell, tc.toggleRotateTable, tc.toggleMultiColumn, tc.toggleMultiRow]) {
      expect(cmd(s, () => { throw new Error('dispatched'); })).toBe(false);
    }
    expect(tc.tableToolbarState(s).inTable).toBe(false);
  });
});

describe('append row / column', () => {
  it('appendRow inserts below the cursor row, inheriting lines like Tabular::insertRow', () => {
    let s = typeIn(mkState(), 1, 1, 'mid');
    s = cursorIn(s, 1, 1);
    s = apply(s, tc.appendRow);
    const t = table(s);
    expect(t.nrows).toBe(4);
    expect(t.attrs.get('rows')).toBe('4');
    expect(t.attrs.get('columns')).toBe('3');
    expect(t.columns.length).toBe(3);
    // the neighbour row (bottom line only): new cells copy left/right/top, no bottom line
    expect(lines(cellAt(s, 2, 0))).toBe('left right');
    expect(lines(cellAt(s, 2, 1))).toBe('right');
    expect(get(cellAt(s, 2, 1).attrs, 'alignment')).toBe('center');
    expect(get(cellAt(s, 2, 1).attrs, 'valignment')).toBe('top');
    expect(get(cellAt(s, 2, 1).attrs, 'usebox')).toBe('none');
    expect(textOf(cellAt(s, 2, 1))).toBe('');
    // the cursor stays in its cell
    expect(textOf(cellAt(s, 1, 1))).toBe('mid');
    const $c = s.selection.$from;
    expect($c.pos).toBe(cellAt(s, 1, 1).pos + 2);
  });
  it('appendRow after the first row moves its bottom line down (top && bottom rule)', () => {
    let s = mkState();
    s = apply(s, tc.appendRow);
    expect(lines(cellAt(s, 0, 0))).toBe('top left right');
    expect(lines(cellAt(s, 1, 0))).toBe('top bottom left right');
    expect(lines(cellAt(s, 1, 2))).toBe('top bottom right');
    expect(table(s).nrows).toBe(4);
  });
  it('appendColumn inserts right of the cursor column and takes over its right line', () => {
    let s = cursorIn(mkState(), 1, 1);
    s = apply(s, tc.appendColumn);
    const t = table(s);
    expect(t.ncols).toBe(4);
    expect(t.attrs.get('columns')).toBe('4');
    expect(t.columns.length).toBe(4);
    expect(t.columns[2]).toEqual(t.columns[1]);
    for (let r = 0; r < 3; r++) {
      expect(get(cellAt(s, r, 1).attrs, 'rightline')).toBeUndefined();
      expect(get(cellAt(s, r, 2).attrs, 'rightline')).toBe('true');
      expect(get(cellAt(s, r, 2).attrs, 'bottomline')).toBe('true');
      expect(get(cellAt(s, r, 2).attrs, 'usebox')).toBe('none');
    }
    expect(get(cellAt(s, 0, 2).attrs, 'topline')).toBe('true');
    expect(get(cellAt(s, 1, 2).attrs, 'topline')).toBeUndefined();
    expect(s.selection.$from.pos).toBe(cellAt(s, 1, 1).pos + 2);
  });
  it('new rows/columns extend a multirow/multicolumn span', () => {
    let s = select(mkState(), 0, 1, 1, 1);
    s = apply(s, tc.toggleMultiRow);
    s = cursorIn(s, 0, 1);
    s = apply(s, tc.appendRow);
    expect(cellAt(s, 0, 1).rowspan).toBe(3);
    expect(table(s).nrows).toBe(4);
    s = select(mkState(), 1, 0, 1, 1);
    s = apply(s, tc.toggleMultiColumn);
    s = cursorIn(s, 1, 0);
    s = apply(s, tc.appendColumn);
    expect(cellAt(s, 1, 0).colspan).toBe(3);
    expect(table(s).ncols).toBe(4);
  });
});

describe('delete row / column', () => {
  it('deleteRow removes the cursor row and moves the cursor to the row below', () => {
    let s = typeIn(typeIn(mkState(), 1, 0, 'b'), 2, 0, 'c');
    s = cursorIn(s, 1, 0);
    s = apply(s, tc.deleteRow);
    expect(table(s).nrows).toBe(2);
    expect(table(s).attrs.get('rows')).toBe('2');
    expect(textOf(cellAt(s, 1, 0))).toBe('c');
    expect(s.selection.$from.pos).toBe(cellAt(s, 1, 0).pos + 2);
  });
  it('deleting the last row hands its bottom line to the row above', () => {
    let s = mkState();
    s = apply(cursorIn(s, 1, 0), tc.unsetAllLines);
    s = apply(select(s, 1, 0, 1, 2), tc.unsetAllLines);
    expect(lines(cellAt(s, 1, 1))).toBe('');
    s = apply(cursorIn(s, 2, 1), tc.deleteRow);
    expect(table(s).nrows).toBe(2);
    expect(get(cellAt(s, 1, 1).attrs, 'bottomline')).toBe('true');
    expect(s.selection.$from.pos).toBe(cellAt(s, 1, 1).pos + 2);
  });
  it('deleteRow with a selection removes all selected rows but never the last one', () => {
    let s = select(mkState(), 0, 0, 2, 2);
    s = apply(s, tc.deleteRow);
    expect(table(s).nrows).toBe(1);
    expect(run(s, tc.deleteRow).ok).toBe(false);
  });
  it('deleteRow shrinks a multirow spanning the deleted row', () => {
    let s = typeIn(mkState(), 0, 1, 'span');
    s = apply(select(s, 0, 1, 2, 1), tc.toggleMultiRow);
    expect(cellAt(s, 0, 1).rowspan).toBe(3);
    // deleting the begin row: the span moves down with its content
    s = apply(cursorIn(s, 0, 0), tc.deleteRow);
    expect(table(s).nrows).toBe(2);
    expect(cellAt(s, 0, 1).rowspan).toBe(2);
    expect(textOf(cellAt(s, 0, 1))).toBe('span');
    expect(get(cellAt(s, 0, 1).attrs, 'multirow')).toBe('1');
    expect(cellAt(s, 0, 1).cont.length).toBe(1);
    // deleting the last part row
    s = apply(cursorIn(s, 1, 0), tc.deleteRow);
    expect(table(s).nrows).toBe(1);
    expect(cellAt(s, 0, 1).rowspan).toBe(1);
    expect(cellAt(s, 0, 1).cont.length).toBe(0);
    expect(textOf(cellAt(s, 0, 1))).toBe('span');
  });
  it('deleteColumn removes the cursor column, keeping the outer lines', () => {
    let s = typeIn(mkState(), 0, 2, 'last');
    s = apply(cursorIn(s, 0, 2), tc.deleteColumn);
    const t = table(s);
    expect(t.ncols).toBe(2);
    expect(t.attrs.get('columns')).toBe('2');
    expect(t.columns.length).toBe(2);
    expect(get(cellAt(s, 0, 1).attrs, 'rightline')).toBe('true');
    expect(s.selection.$from.pos).toBe(cellAt(s, 0, 1).pos + 2);
    // first column: its left line moves to the new first column
    s = apply(cursorIn(s, 1, 0), tc.deleteColumn);
    expect(table(s).ncols).toBe(1);
    expect(get(cellAt(s, 1, 0).attrs, 'leftline')).toBe('true');
    expect(run(s, tc.deleteColumn).ok).toBe(false);
  });
  it('deleteColumn shrinks a multicolumn spanning the deleted column', () => {
    let s = typeIn(mkState(), 1, 0, 'wide');
    s = apply(select(s, 1, 0, 1, 2), tc.toggleMultiColumn);
    expect(cellAt(s, 1, 0).colspan).toBe(3);
    s = apply(cursorIn(s, 0, 0), tc.deleteColumn);
    expect(table(s).ncols).toBe(2);
    expect(cellAt(s, 1, 0).colspan).toBe(2);
    expect(textOf(cellAt(s, 1, 0))).toBe('wide');
    expect(get(cellAt(s, 1, 0).attrs, 'multicolumn')).toBe('1');
    expect(get(cellAt(s, 1, 0).cont[0], 'multicolumn')).toBe('2');
  });
});

describe('move row / column', () => {
  it('moveRowDown/Up swap content but leave the lines in place, cursor follows', () => {
    let s = typeIn(typeIn(mkState(), 0, 0, 'A'), 1, 0, 'B');
    s = cursorIn(s, 0, 0);
    s = s.apply(s.tr.setSelection(TextSelection.create(s.doc, cellAt(s, 0, 0).pos + 3))); // after 'A'
    s = apply(s, tc.moveRowDown);
    expect(textOf(cellAt(s, 0, 0))).toBe('B');
    expect(textOf(cellAt(s, 1, 0))).toBe('A');
    expect(lines(cellAt(s, 0, 0))).toBe('top bottom left right');
    expect(lines(cellAt(s, 1, 0))).toBe('bottom left right');
    expect(s.selection.$from.pos).toBe(cellAt(s, 1, 0).pos + 3);
    expect(run(cursorIn(s, 2, 0), tc.moveRowDown).ok).toBe(false);
    s = apply(s, tc.moveRowUp);
    expect(textOf(cellAt(s, 0, 0))).toBe('A');
    expect(s.selection.$from.pos).toBe(cellAt(s, 0, 0).pos + 3);
    expect(run(s, tc.moveRowUp).ok).toBe(false);
  });
  it('moveColumnRight/Left swap the column specs too', () => {
    let s = typeIn(mkState(), 2, 0, 'x');
    s = apply(cursorIn(s, 2, 0), tc.setAlignment('right'));
    s = apply(cursorIn(s, 2, 0), tc.moveColumnRight);
    expect(textOf(cellAt(s, 2, 1))).toBe('x');
    expect(get(table(s).columns[1], 'alignment')).toBe('right');
    expect(get(table(s).columns[0], 'alignment')).toBe('center');
    expect(lines(cellAt(s, 2, 0))).toBe('bottom left right');
    expect(lines(cellAt(s, 2, 1))).toBe('bottom right');
    expect(s.selection.$from.pos).toBe(cellAt(s, 2, 1).pos + 2);
    expect(run(cursorIn(s, 0, 2), tc.moveColumnRight).ok).toBe(false);
    s = apply(s, tc.moveColumnLeft);
    expect(textOf(cellAt(s, 2, 0))).toBe('x');
    expect(get(table(s).columns[0], 'alignment')).toBe('right');
    expect(run(s, tc.moveColumnLeft).ok).toBe(false);
  });
  it('moving keeps a multi-cell selection and refuses spans', () => {
    let s = select(mkState(), 0, 0, 0, 2);
    s = apply(s, tc.moveRowDown);
    expect(s.selection).toBeInstanceOf(CellSelection);
    expect(cellAt(s, 1, 0).pos).toBe((s.selection as CellSelection).$anchorCell.pos);
    expect(cellAt(s, 1, 2).pos).toBe((s.selection as CellSelection).$headCell.pos);
    let m = apply(select(mkState(), 0, 1, 1, 1), tc.toggleMultiRow);
    expect(run(cursorIn(m, 2, 0), tc.moveRowUp).ok).toBe(false);
    m = apply(select(mkState(), 1, 0, 1, 1), tc.toggleMultiColumn);
    expect(run(cursorIn(m, 0, 2), tc.moveColumnLeft).ok).toBe(false);
  });
});

describe('lines', () => {
  it('toggleLine follows the cursor cell and applies to the selection', () => {
    let s = cursorIn(mkState(), 1, 1);
    s = apply(s, tc.toggleLine('top'));
    expect(lines(cellAt(s, 1, 1))).toBe('top bottom right');
    s = apply(s, tc.toggleLine('top'));
    expect(lines(cellAt(s, 1, 1))).toBe('bottom right');
    s = apply(s, tc.toggleLine('bottom'));
    expect(lines(cellAt(s, 1, 1))).toBe('right');
    s = apply(s, tc.toggleLine('left'));
    expect(lines(cellAt(s, 1, 1))).toBe('left right');
    s = apply(s, tc.toggleLine('right'));
    expect(lines(cellAt(s, 1, 1))).toBe('left');
    // attribute order stays LyX's
    expect(cellAt(s, 1, 1).attrs.map(a => a[0])).toEqual(['alignment', 'valignment', 'leftline', 'usebox']);
    s = apply(select(s, 1, 0, 1, 2), tc.toggleLine('top'));
    for (let c = 0; c < 3; c++) expect(get(cellAt(s, 1, c).attrs, 'topline')).toBe('true');
    expect(s.selection).toBeInstanceOf(CellSelection);
    // the cursor cell has the line now, so the selection toggles it off again
    s = apply(s, tc.toggleLine('top'));
    for (let c = 0; c < 3; c++) expect(get(cellAt(s, 1, c).attrs, 'topline')).toBeUndefined();
  });
  it('toggleBorderLines / toggleInnerLines / toggleAllLines / unsetAllLines', () => {
    let s = select(mkState(), 0, 0, 2, 2);
    // the default table has its outside borders -> toggling removes them
    expect(tc.tableToolbarState(s).borderLines).toBe(true);
    s = apply(s, tc.toggleBorderLines);
    expect(lines(cellAt(s, 0, 0))).toBe('bottom right');
    expect(lines(cellAt(s, 2, 2))).toBe('');
    expect(lines(cellAt(s, 1, 1))).toBe('bottom right');
    expect(tc.tableToolbarState(s).borderLines).toBe(false);
    s = apply(s, tc.toggleBorderLines);
    expect(lines(cellAt(s, 0, 0))).toBe('top bottom left right');
    expect(lines(cellAt(s, 2, 2))).toBe('bottom right');
    s = apply(s, tc.unsetAllLines);
    for (const c of table(s).cells) expect(lines(c)).toBe('');
    expect(tc.tableToolbarState(s).innerLines).toBe(false);
    s = apply(s, tc.toggleInnerLines);
    expect(lines(cellAt(s, 0, 0))).toBe('');
    expect(lines(cellAt(s, 1, 1))).toBe('top left');
    expect(lines(cellAt(s, 2, 0))).toBe('top');
    expect(lines(cellAt(s, 0, 2))).toBe('left');
    expect(tc.tableToolbarState(s).innerLines).toBe(true);
    s = apply(s, tc.toggleInnerLines);
    for (const c of table(s).cells) expect(lines(c)).toBe('');
    s = apply(s, tc.toggleAllLines);
    // Tabular::setLines: bottom/right lines only where no neighbour draws the same line
    for (const c of table(s).cells) expect(lines(c)).toBe(['top', c.r === 2 ? 'bottom' : '', 'left', c.c === 2 ? 'right' : ''].filter(Boolean).join(' '));
    expect(tc.tableToolbarState(s).allLines).toBe(true);
    s = apply(s, tc.toggleAllLines);
    for (const c of table(s).cells) expect(lines(c)).toBe('');
    // on a single cell the toggles work on that cell
    s = apply(cursorIn(s, 1, 1), tc.toggleAllLines);
    expect(lines(cellAt(s, 1, 1))).toBe('top bottom left right');
    expect(lines(cellAt(s, 0, 0))).toBe('');
  });
  it('resetFormalDefault needs booktabs and gives head/foot rules only', () => {
    let s = mkState();
    expect(run(s, tc.resetFormalDefault).ok).toBe(false);
    setTableAttrs({ table: [['booktabs', 'true']] })(s, tr => { s = s.apply(tr); });
    s = apply(cursorIn(s, 1, 1), tc.resetFormalDefault);
    expect(lines(cellAt(s, 0, 1))).toBe('top bottom right');
    expect(lines(cellAt(s, 0, 0))).toBe('top bottom left right');
    expect(lines(cellAt(s, 1, 1))).toBe('right');
    expect(lines(cellAt(s, 2, 1))).toBe('top bottom right');
    const st = tc.tableToolbarState(s);
    expect(st.booktabs).toBe(true);
    // booktabs tables have no vertical lines
    expect(st.lines).toEqual({ top: false, bottom: false, left: false, right: false });
    expect(tc.tableToolbarState(cursorIn(s, 0, 1)).lines).toEqual({ top: true, bottom: true, left: false, right: false });
  });
});

describe('alignment', () => {
  it('setAlignment sets the column and its cells; decimal adds the decimal point', () => {
    let s = cursorIn(mkState(), 1, 1);
    s = apply(s, tc.setAlignment('left'));
    expect(get(table(s).columns[1], 'alignment')).toBe('left');
    for (let r = 0; r < 3; r++) expect(get(cellAt(s, r, 1).attrs, 'alignment')).toBe('left');
    expect(get(cellAt(s, 1, 0).attrs, 'alignment')).toBe('center');
    expect(tc.tableToolbarState(s).align).toBe('left');
    s = apply(s, tc.setAlignment('decimal'));
    expect(table(s).columns[1]).toEqual([['alignment', 'decimal'], ['decimal_point', '.'], ['valignment', 'top']]);
    expect(get(cellAt(s, 0, 1).attrs, 'alignment')).toBe('decimal');
    expect(roundTrip(s)).toContain('<column alignment="decimal" decimal_point="." valignment="top">');
    s = apply(s, tc.setAlignment('center'));
    expect(table(s).columns[1]).toEqual([['alignment', 'center'], ['valignment', 'top']]);
    // a selection spanning columns aligns all of them
    s = apply(select(s, 0, 0, 0, 2), tc.setAlignment('right'));
    for (const col of table(s).columns) expect(get(col, 'alignment')).toBe('right');
  });
  it('setAlignment on a multicolumn cell only changes that cell', () => {
    let s = apply(select(mkState(), 1, 0, 1, 1), tc.toggleMultiColumn);
    s = apply(cursorIn(s, 1, 0), tc.setAlignment('right'));
    expect(get(cellAt(s, 1, 0).attrs, 'alignment')).toBe('right');
    expect(get(table(s).columns[0], 'alignment')).toBe('center');
    expect(get(cellAt(s, 0, 0).attrs, 'alignment')).toBe('center');
    expect(tc.tableToolbarState(s).align).toBe('right');
    expect(run(s, tc.setAlignment('decimal')).ok).toBe(false);
  });
  it('setVAlignment sets the column (the cell for multicolumns)', () => {
    let s = cursorIn(mkState(), 2, 2);
    s = apply(s, tc.setVAlignment('middle'));
    expect(get(table(s).columns[2], 'valignment')).toBe('middle');
    expect(tc.tableToolbarState(s).valign).toBe('middle');
    s = apply(select(mkState(), 0, 0, 0, 1), tc.toggleMultiColumn);
    s = apply(cursorIn(s, 0, 0), tc.setVAlignment('bottom'));
    expect(get(cellAt(s, 0, 0).attrs, 'valignment')).toBe('bottom');
    expect(get(table(s).columns[0], 'valignment')).toBe('top');
    expect(tc.tableToolbarState(s).valign).toBe('bottom');
  });
});

describe('rotation', () => {
  it('toggleRotateCell rotates by 90 degrees unless every selected cell is rotated', () => {
    let s = cursorIn(mkState(), 1, 1);
    s = apply(s, tc.toggleRotateCell);
    expect(cellAt(s, 1, 1).attrs).toEqual([['alignment', 'center'], ['valignment', 'top'], ['bottomline', 'true'], ['rightline', 'true'], ['rotate', '90'], ['usebox', 'none']]);
    expect(tc.tableToolbarState(s).rotateCell).toBe(true);
    s = apply(select(s, 1, 0, 1, 2), tc.toggleRotateCell);
    for (let c = 0; c < 3; c++) expect(get(cellAt(s, 1, c).attrs, 'rotate')).toBe('90');
    s = apply(s, tc.toggleRotateCell);
    for (let c = 0; c < 3; c++) expect(get(cellAt(s, 1, c).attrs, 'rotate')).toBeUndefined();
    expect(tc.tableToolbarState(s).rotateCell).toBe(false);
  });
  it('toggleRotateTable sets/unsets the rotate feature', () => {
    let s = mkState();
    s = apply(s, tc.toggleRotateTable);
    expect(JSON.parse(table(s).node.attrs.features)).toEqual([['rotate', '90'], ['tabularvalignment', 'middle']]);
    expect(tc.tableToolbarState(s).rotateTable).toBe(true);
    s = apply(s, tc.toggleRotateTable);
    expect(JSON.parse(table(s).node.attrs.features)).toEqual([['tabularvalignment', 'middle']]);
    expect(tc.tableToolbarState(s).rotateTable).toBe(false);
  });
});

describe('multicolumn / multirow', () => {
  it('toggleMultiColumn merges the selected cells of a row and splits them again', () => {
    let s = typeIn(typeIn(mkState(), 1, 1, 'two'), 1, 2, 'three');
    s = select(s, 1, 1, 1, 2);
    s = apply(s, tc.toggleMultiColumn);
    let t = table(s);
    expect(t.nrows).toBe(3); expect(t.ncols).toBe(3);
    expect(t.node.child(1).childCount).toBe(2);
    const m = cellAt(s, 1, 1);
    expect(m.colspan).toBe(2);
    expect(get(m.attrs, 'multicolumn')).toBe('1');
    expect(m.attrs[0][0]).toBe('multicolumn');
    expect(get(m.attrs, 'rightline')).toBe('true');
    expect(m.cont).toEqual([[['multicolumn', '2'], ['alignment', 'center'], ['valignment', 'top'], ['bottomline', 'true'], ['rightline', 'true'], ['usebox', 'none']]]);
    expect(m.node.childCount).toBe(2);
    expect(textOf(m)).toBe('twothree');
    expect(s.selection.$from.pos).toBe(m.pos + 2);
    const st = tc.tableToolbarState(s);
    expect(st.multicolumn).toBe(true); expect(st.multirow).toBe(false);
    expect(roundTrip(s)).toContain('<cell multicolumn="1" alignment="center"');
    // split
    s = apply(s, tc.toggleMultiColumn);
    t = table(s);
    expect(t.node.child(1).childCount).toBe(3);
    expect(cellAt(s, 1, 1).colspan).toBe(1);
    expect(get(cellAt(s, 1, 1).attrs, 'multicolumn')).toBeUndefined();
    expect(get(cellAt(s, 1, 1).attrs, 'rightline')).toBeUndefined();
    expect(get(cellAt(s, 1, 2).attrs, 'multicolumn')).toBeUndefined();
    expect(get(cellAt(s, 1, 2).attrs, 'rightline')).toBe('true');
    expect(textOf(cellAt(s, 1, 1))).toBe('twothree');
    expect(textOf(cellAt(s, 1, 2))).toBe('');
    expect(tc.tableToolbarState(s).multicolumn).toBe(false);
    // a selection over several rows is refused
    expect(run(select(s, 0, 0, 1, 1), tc.toggleMultiColumn).ok).toBe(false);
  });
  it('toggleMultiColumn on a single cell makes a single-cell multicolumn (own alignment)', () => {
    let s = cursorIn(mkState(), 2, 2);
    s = apply(s, tc.toggleMultiColumn);
    expect(cellAt(s, 2, 2).colspan).toBe(1);
    expect(get(cellAt(s, 2, 2).attrs, 'multicolumn')).toBe('1');
    expect(table(s).node.child(2).childCount).toBe(3);
    s = apply(s, tc.toggleMultiColumn);
    expect(get(cellAt(s, 2, 2).attrs, 'multicolumn')).toBeUndefined();
    expect(get(cellAt(s, 2, 2).attrs, 'rightline')).toBe('true');
  });
  it('toggleMultiRow merges the selected cells of a column and splits them again', () => {
    let s = typeIn(typeIn(mkState(), 0, 0, 'top'), 2, 0, 'bottom');
    s = select(s, 0, 0, 2, 0);
    s = apply(s, tc.toggleMultiRow);
    let t = table(s);
    expect(t.nrows).toBe(3); expect(t.ncols).toBe(3);
    expect(t.node.child(1).childCount).toBe(2);
    expect(t.node.child(2).childCount).toBe(2);
    const m = cellAt(s, 0, 0);
    expect(m.rowspan).toBe(3);
    expect(m.attrs.slice(0, 3)).toEqual([['multirow', '1'], ['alignment', 'center'], ['valignment', 'middle']]);
    expect(get(m.attrs, 'bottomline')).toBe('true');
    expect(m.cont.length).toBe(2);
    expect(m.cont[0][0]).toEqual(['multirow', '2']);
    expect(textOf(m)).toBe('topbottom');
    expect(s.selection.$from.pos).toBe(m.pos + 2);
    expect(tc.tableToolbarState(s).multirow).toBe(true);
    expect(roundTrip(s)).toContain('<cell multirow="1" alignment="center" valignment="middle"');
    s = apply(s, tc.toggleMultiRow);
    t = table(s);
    expect(t.node.child(1).childCount).toBe(3);
    expect(cellAt(s, 0, 0).rowspan).toBe(1);
    expect(get(cellAt(s, 0, 0).attrs, 'multirow')).toBeUndefined();
    expect(get(cellAt(s, 0, 0).attrs, 'valignment')).toBe('top');
    expect(get(cellAt(s, 1, 0).attrs, 'multirow')).toBeUndefined();
    expect(textOf(cellAt(s, 1, 0))).toBe('');
    expect(tc.tableToolbarState(s).multirow).toBe(false);
    expect(run(select(s, 0, 0, 1, 1), tc.toggleMultiRow).ok).toBe(false);
  });
  it('a text selection across cells counts as a cell selection', () => {
    let s = mkState();
    s = s.apply(s.tr.setSelection(TextSelection.create(s.doc, cellAt(s, 2, 0).pos + 2, cellAt(s, 2, 2).pos + 2)));
    s = apply(s, tc.toggleMultiColumn);
    expect(cellAt(s, 2, 0).colspan).toBe(3);
    expect(table(s).node.child(2).childCount).toBe(1);
  });
  it('multicolumn wins over multirow and vice versa (LyX unsets the other span first)', () => {
    let s = apply(select(mkState(), 0, 1, 1, 1), tc.toggleMultiRow);
    s = apply(select(s, 0, 0, 0, 1), tc.toggleMultiColumn);
    expect(cellAt(s, 0, 0).colspan).toBe(2);
    expect(cellAt(s, 0, 0).rowspan).toBe(1);
    expect(table(s).node.child(1).childCount).toBe(3);
    for (const c of table(s).cells) expect(get(c.attrs, 'multirow')).toBeUndefined();
  });
});

describe('tableToolbarState', () => {
  it('reports the cursor cell', () => {
    const s = mkState();
    expect(tc.tableToolbarState(cursorIn(s, 0, 0))).toEqual({
      inTable: true, rotateCell: false, rotateTable: false, multicolumn: false, multirow: false,
      lines: { top: true, bottom: true, left: true, right: true }, borderLines: true, innerLines: false, allLines: false,
      booktabs: false, align: 'center', valign: 'top',
    });
    expect(tc.tableToolbarState(cursorIn(s, 1, 1)).lines).toEqual({ top: false, bottom: true, left: false, right: true });
  });
});
