/**
 * LaTeX output of LyX tables (Tabular inset), mirroring Tabular::latex,
 * TeXRow, TeXCellPreamble/Postamble and the horizontal line logic.
 */
import type { Paragraph, TabularCell, TabularInset } from '../lyx/ast.ts';
import type { ExportContext, RunParams } from './context.ts';
import { latexLength, isZeroLength } from './lengths.ts';
import type { TexStream } from './stream.ts';
import { insetTextLatex } from './insets.ts';

function attr(list: [string, string][], key: string): string | undefined {
  for (const [k, v] of list) if (k === key) return v;
  return undefined;
}

function isTrue(v: string | undefined): boolean { return v === 'true' || v === '1'; }

interface CellInfo {
  cell: TabularCell;
  row: number;
  col: number;
  multicolumn: number;   // 0 none, 1 begin, 2 part
  multirow: number;
  colspan: number;
  rowspan: number;
  alignment: string;
  valignment: string;
  topline: boolean;
  bottomline: boolean;
  leftline: boolean;
  rightline: boolean;
  usebox: string;
  width: string;
  special: string;
  rotate: number;
  mroffset: string;
}

interface ColInfo {
  alignment: string;
  valignment: string;
  width: string;
  special: string;
  varwidth: boolean;
  decimalPoint: string;
}

interface Grid {
  cells: CellInfo[][];  // [row][col]
  cols: ColInfo[];
  nrows: number;
  ncols: number;
  booktabs: boolean;
  longtable: boolean;
}

function buildGrid(tab: TabularInset): Grid {
  const cols: ColInfo[] = tab.columns.map(c => ({
    alignment: attr(c.attrs, 'alignment') ?? 'center',
    valignment: attr(c.attrs, 'valignment') ?? 'top',
    width: attr(c.attrs, 'width') ?? '',
    special: attr(c.attrs, 'special') ?? '',
    varwidth: isTrue(attr(c.attrs, 'varwidth')),
    decimalPoint: attr(c.attrs, 'decimal_point') ?? '',
  }));
  const ncols = cols.length;
  const cells: CellInfo[][] = tab.rows.map((r, ri) => r.cells.slice(0, ncols).map((c, ci) => ({
    cell: c, row: ri, col: ci,
    multicolumn: parseInt(attr(c.attrs, 'multicolumn') ?? '0', 10) || 0,
    multirow: parseInt(attr(c.attrs, 'multirow') ?? '0', 10) || 0,
    colspan: 1, rowspan: 1,
    alignment: attr(c.attrs, 'alignment') ?? cols[ci]?.alignment ?? 'center',
    valignment: attr(c.attrs, 'valignment') ?? cols[ci]?.valignment ?? 'top',
    topline: isTrue(attr(c.attrs, 'topline')),
    bottomline: isTrue(attr(c.attrs, 'bottomline')),
    leftline: isTrue(attr(c.attrs, 'leftline')),
    rightline: isTrue(attr(c.attrs, 'rightline')),
    usebox: attr(c.attrs, 'usebox') ?? 'none',
    width: attr(c.attrs, 'width') ?? '',
    special: attr(c.attrs, 'special') ?? '',
    rotate: parseInt(attr(c.attrs, 'rotate') ?? '0', 10) || 0,
    mroffset: attr(c.attrs, 'mroffset') ?? '',
  })));
  // fill missing cells
  for (const row of cells) while (row.length < ncols) {
    const ci = row.length;
    row.push({ cell: { attrs: [], paragraphs: [] }, row: cells.indexOf(row), col: ci, multicolumn: 0, multirow: 0, colspan: 1, rowspan: 1, alignment: cols[ci].alignment, valignment: cols[ci].valignment, topline: false, bottomline: false, leftline: false, rightline: false, usebox: 'none', width: '', special: '', rotate: 0, mroffset: '' });
  }
  // spans
  for (const row of cells) {
    for (let c = 0; c < ncols; c++) {
      if (row[c].multicolumn === 1) {
        let span = 1;
        while (c + span < ncols && row[c + span].multicolumn === 2) span++;
        row[c].colspan = span;
      }
    }
  }
  for (let c = 0; c < ncols; c++) {
    for (let r = 0; r < cells.length; r++) {
      if (cells[r][c].multirow === 1) {
        let span = 1;
        while (r + span < cells.length && cells[r + span][c].multirow === 2) span++;
        cells[r][c].rowspan = span;
      }
    }
  }
  return { cells, cols, nrows: cells.length, ncols, booktabs: isTrue(attr(tab.features, 'booktabs')), longtable: isTrue(attr(tab.features, 'islongtable')) };
}

function isPartOfMultiColumn(g: Grid, r: number, c: number): boolean { return g.cells[r][c].multicolumn === 2; }
function isPartOfMultiRow(g: Grid, r: number, c: number): boolean { return g.cells[r][c].multirow === 2; }

function columnLeftLine(g: Grid, c: number): boolean {
  if (g.booktabs) return false;
  let left = 0, total = 0;
  for (let r = 0; r < g.nrows; r++) {
    if (isPartOfMultiColumn(g, r, c)) continue;
    total++;
    const right = c > 0 && g.cells[r][c - 1].rightline;
    if (g.cells[r][c].leftline || right) left++;
  }
  return 2 * left >= total;
}

function columnRightLine(g: Grid, c: number): boolean {
  if (g.booktabs) return false;
  let right = 0, total = 0;
  for (let r = 0; r < g.nrows; r++) {
    const cell = cellStart(g, r, c);
    if (cell.col + cell.colspan - 1 !== c) continue;
    total++;
    const left = (c + 1 < g.ncols && g.cells[r][c + 1].leftline) || c + 1 === g.ncols;
    if (cell.rightline && left) right++;
  }
  return 2 * right >= total;
}

/** The starting cell of the multicolumn containing (r, c). */
function cellStart(g: Grid, r: number, c: number): CellInfo {
  let cc = c;
  while (cc > 0 && g.cells[r][cc].multicolumn === 2) cc--;
  return g.cells[r][cc];
}

function valignChar(v: string, forParbox = false): string {
  if (v === 'middle') return forParbox ? 'c' : 'm';
  if (v === 'bottom') return 'b';
  return forParbox ? 't' : 'p';
}

function columnSpec(g: Grid, c: number): string {
  const col = g.cols[c];
  let s = '';
  if (columnLeftLine(g, c)) s += '|';
  if (col.special) s += col.special;
  else if (!isZeroLength(col.width)) {
    if (col.alignment === 'left') s += '>{\\raggedright}';
    else if (col.alignment === 'right') s += '>{\\raggedleft}';
    else if (col.alignment === 'center') s += '>{\\centering}';
    let v = 'p';
    if (col.valignment === 'middle') v = 'm'; else if (col.valignment === 'bottom') v = 'b';
    s += v + `{${latexLength(col.width)}}`;
  } else if (col.varwidth) {
    if (col.alignment === 'left') s += '>{\\raggedright\\arraybackslash}';
    else if (col.alignment === 'right') s += '>{\\raggedleft\\arraybackslash}';
    else if (col.alignment === 'center') s += '>{\\centering\\arraybackslash}';
    s += 'X';
  } else {
    switch (col.alignment) {
      case 'left': s += 'l'; break;
      case 'right': s += 'r'; break;
      case 'decimal': s += `r@{\\extracolsep{0pt}${col.decimalPoint}}l`; break;
      default: s += 'c';
    }
  }
  if (columnRightLine(g, c)) s += '|';
  return s;
}

function cellPreamble(ctx: ExportContext, os: TexStream, g: Grid, cell: CellInfo): { multicol: boolean; multirow: boolean } {
  const c = cell.col;
  const nextcol = c + cell.colspan;
  const colright = columnRightLine(g, c);
  const colleft = columnLeftLine(g, c);
  const nextcolleft = nextcol < g.ncols && columnLeftLine(g, nextcol);
  const nextcellleft = nextcol < g.ncols && g.cells[cell.row][nextcol].leftline;
  const coldouble = colright && nextcolleft;
  const celldouble = cell.rightline && nextcellleft;
  const isMulti = cell.multicolumn === 1;
  const ismulticol = (isMulti
    || (c === 0 && colleft !== cell.leftline)
    || ((colright || nextcolleft) && !cell.rightline && !nextcellleft)
    || (!colright && !nextcolleft && (cell.rightline || nextcellleft))
    || (coldouble !== celldouble))
    && g.cols[c].alignment !== 'decimal';
  const align = isMulti ? cell.alignment : (attrHas(cell, 'alignment') ? cell.alignment : g.cols[c].alignment);
  const valign = isMulti ? cell.valignment : (attrHas(cell, 'valignment') ? cell.valignment : g.cols[c].valignment);
  const pwidth = isMulti ? cell.width : (isZeroLength(cell.width) ? g.cols[c].width : cell.width);
  if (ismulticol) {
    os.write(`\\multicolumn{${cell.colspan}}{`);
    if (c === 0 && cell.leftline) os.write('|');
    if (cell.special) os.write(cell.special);
    else if (!isZeroLength(pwidth)) {
      if (align === 'left') os.write('>{\\raggedright}');
      else if (align === 'right') os.write('>{\\raggedleft}');
      else if (align === 'center') os.write('>{\\centering}');
      os.write(valignChar(valign) + `{${latexLength(pwidth)}}`);
    } else if (cell.rotate === 0 && cell.usebox === 'varwidth' && align === 'left') {
      os.write('V{\\linewidth}');
    } else {
      os.write(align === 'left' ? 'l' : align === 'right' ? 'r' : 'c');
    }
    if (cell.rightline || nextcellleft) os.write('|');
    if (celldouble) os.write('|');
    os.write('}{');
  }
  const ismultirow = cell.multirow === 1;
  if (ismultirow) {
    ctx.features.require('multirow');
    os.write(`\\multirow{${cell.rowspan}}{`);
    if (!isZeroLength(pwidth)) os.write(latexLength(pwidth));
    else os.write(g.cols[c].varwidth ? '=' : '*');
    os.write('}');
    if (!isZeroLength(cell.mroffset)) os.write(`[${latexLength(cell.mroffset)}]`);
    os.write('{');
  }
  if (cell.rotate !== 0) { ctx.features.require('rotating'); os.write(`\\begin{turn}{${cell.rotate}}\n`); }
  if (cell.usebox === 'parbox') {
    os.write(`\\parbox[${valignChar(valign, true)}]{${latexLength(pwidth)}}{`);
  } else if (cell.usebox === 'minipage') {
    os.write(`\\begin{minipage}[${valignChar(valign, true) === 'c' ? 'm' : valignChar(valign, true)}]{${latexLength(pwidth)}}\n`);
  } else if (cell.usebox === 'varwidth' && (cell.rotate !== 0 || align !== 'left' || valign !== 'top' || hasNewlines(cell.cell))) {
    ctx.features.require('varwidth');
    ctx.features.require('cellvarwidth');
    os.write(`\\begin{cellvarwidth}[${valignChar(valign, true) === 'c' ? 'm' : valignChar(valign, true)}]\n`);
    if (align === 'right') os.write('\\raggedleft\n');
    else if (align === 'center') os.write('\\centering\n');
  }
  return { multicol: ismulticol, multirow: ismultirow };
}

function attrHas(cell: CellInfo, key: string): boolean { return attr(cell.cell.attrs, key) !== undefined; }

function hasNewlines(cell: TabularCell): boolean {
  for (const p of cell.paragraphs) for (const it of p.items) if (it.kind === 'inset' && it.inset.type === 'Leaf' && it.inset.name === 'Newline') return true;
  return false;
}

function cellPostamble(os: TexStream, cell: CellInfo, flags: { multicol: boolean; multirow: boolean }): void {
  const align = cell.alignment;
  if (cell.usebox === 'parbox') os.write('}');
  else if (cell.usebox === 'minipage') { os.breakln(); os.write('\\end{minipage}'); }
  else if (cell.usebox === 'varwidth' && (cell.rotate !== 0 || align !== 'left' || cell.valignment !== 'top' || hasNewlines(cell.cell))) { os.breakln(); os.write('\\end{cellvarwidth}'); }
  if (cell.rotate !== 0) { os.breakln(); os.write('\\end{turn}'); }
  if (flags.multirow) os.write('}');
  if (flags.multicol) os.write('}');
}

function rowAttr(tab: TabularInset, r: number, key: string): string | undefined { return attr(tab.rows[r].attrs, key); }

function topHLine(ctx: ExportContext, os: TexStream, g: Grid, tab: TabularInset, row: number, first: number): void {
  const topline: boolean[] = [];
  let nset = 0;
  for (let c = 0; c < g.ncols; c++) {
    let t = g.cells[row][c].topline;
    if (row !== 0 && g.cells[row][c].multirow === 2) t = false;
    topline.push(t);
    if (t) nset++;
  }
  if ((row === first && nset === 0) || (row > first && nset !== g.ncols)) return;
  const realFirst = row === first || (g.longtable && row === first + 1 && isTrue(rowAttr(tab, first, 'caption')));
  if (nset === g.ncols) {
    if (g.booktabs) { ctx.features.require('booktabs'); os.write(realFirst ? '\\toprule ' : '\\midrule '); }
    else os.write('\\hline ');
  } else if (realFirst) {
    writeClines(ctx, os, g, row, topline);
  }
  os.write('\n');
}

function writeClines(ctx: ExportContext, os: TexStream, g: Grid, row: number, lines: boolean[]): void {
  const cline = g.booktabs ? '\\cmidrule' : '\\cline';
  if (g.booktabs) ctx.features.require('booktabs');
  let c = 0;
  while (c < g.ncols) {
    if (!lines[c]) { c++; continue; }
    const firstcol = c + 1;
    while (c + 1 < g.ncols && lines[c + 1]) c++;
    const lastcol = c + 1;
    os.write(`${cline}{${firstcol}-${lastcol}}`);
    c++;
  }
}

function bottomHLine(ctx: ExportContext, os: TexStream, g: Grid, row: number, last: number): void {
  const lastrow = row === last;
  const bottomline: boolean[] = [];
  const topline: boolean[] = [];
  let nextrowset = true;
  for (let c = 0; c < g.ncols; c++) {
    let b = g.cells[row][c].bottomline;
    let t = !lastrow && g.cells[row + 1][c].topline;
    if (!lastrow && g.cells[row][c].multirow !== 0 && g.cells[row + 1][c].multirow === 2) { b = false; t = false; }
    bottomline.push(b);
    topline.push(t);
    nextrowset &&= t;
  }
  let nset = 0;
  for (let c = 0; c < g.ncols; c++) {
    if (!nextrowset) bottomline[c] = bottomline[c] || topline[c];
    if (bottomline[c]) nset++;
  }
  if (nset === 0 || (nextrowset && nset !== g.ncols)) return;
  if (nset === g.ncols) {
    if (g.booktabs) { ctx.features.require('booktabs'); os.write(lastrow ? '\\bottomrule' : '\\midrule'); }
    else os.write('\\hline ');
  } else {
    writeClines(ctx, os, g, row, bottomline);
  }
  os.write('\n');
}

function texRow(ctx: ExportContext, os: TexStream, rp: RunParams, g: Grid, tab: TabularInset, row: number, first: number, last: number): void {
  topHLine(ctx, os, g, tab, row, first);
  const topspace = rowAttr(tab, row, 'topspace');
  if (topspace === 'default') os.write(g.booktabs ? '\\addlinespace\n' : '\\noalign{\\vskip\\doublerulesep}\n');
  else if (topspace && !isZeroLength(topspace)) os.write(g.booktabs ? `\\addlinespace[${latexLength(topspace)}]\n` : `\\noalign{\\vskip${latexLength(topspace)}}\n`);
  const isCaptionRow = g.longtable && isTrue(rowAttr(tab, row, 'caption'));
  // last cell index in the row (start cells only)
  let lastcell = -1;
  for (let c = 0; c < g.ncols; c++) if (!isPartOfMultiColumn(g, row, c)) lastcell = c;
  for (let c = 0; c < g.ncols; c++) {
    if (isPartOfMultiColumn(g, row, c)) continue;
    const cell = g.cells[row][c];
    if (isPartOfMultiRow(g, row, c) && g.cols[c].alignment !== 'decimal') {
      if (c !== lastcell) os.write(' & ');
      continue;
    }
    const flags = isCaptionRow ? { multicol: false, multirow: false } : cellPreamble(ctx, os, g, cell);
    const align = cell.multicolumn === 1 ? cell.alignment : (attrHas(cell, 'alignment') ? cell.alignment : g.cols[c].alignment);
    const cellRp: RunParams = { ...rp, inTableCell: align === 'block' ? 'plain' : 'aligned', owner: 'cell', isMainText: false, isNonLong: cell.multirow === 1 };
    if (isCaptionRow) {
      for (const p of cell.cell.paragraphs) for (const it of p.items) {
        if (it.kind === 'inset' && it.inset.type === 'Text' && it.inset.name === 'Caption') {
          insetTextLatex(ctx, os, { ...rp, movingArg: true }, it.inset.paragraphs, undefined, { movingArg: true });
          os.write('\\tabularnewline\n');
        }
      }
    } else if (!isPartOfMultiRow(g, row, c)) {
      insetTextLatex(ctx, os, cellRp, cell.cell.paragraphs, undefined, { owner: 'cell', inTableCell: cellRp.inTableCell });
    }
    if (!isCaptionRow) cellPostamble(os, cell, flags);
    if (c !== lastcell) os.write(' & ');
  }
  if (isCaptionRow) return;
  os.write('\\tabularnewline');
  const bottomspace = rowAttr(tab, row, 'bottomspace');
  if (bottomspace === 'default') os.write(g.booktabs ? '\\addlinespace' : '[\\doublerulesep]');
  else if (bottomspace && !isZeroLength(bottomspace)) { if (g.booktabs) os.write('\\addlinespace'); os.write(`[${latexLength(bottomspace)}]`); }
  os.write('\n');
  bottomHLine(ctx, os, g, row, last);
  const interline = rowAttr(tab, row, 'interlinespace');
  if (interline === 'default') os.write(g.booktabs ? '\\addlinespace\n' : '\\noalign{\\vskip\\doublerulesep}\n');
  else if (interline && !isZeroLength(interline)) os.write(g.booktabs ? `\\addlinespace[${latexLength(interline)}]\n` : `\\noalign{\\vskip${latexLength(interline)}}\n`);
}

export function latexTabular(ctx: ExportContext, os: TexStream, rp: RunParams, tab: TabularInset): void {
  const g = buildGrid(tab);
  if (g.ncols === 0 || g.nrows === 0) return;
  const f = (k: string) => attr(tab.features, k);
  const rotate = parseInt(f('rotate') ?? '0', 10) || 0;
  const width = f('tabularwidth') ?? '';
  const hasVarwidth = g.cols.some(c => c.varwidth);
  const isTabularStar = !g.longtable && !isZeroLength(width) && !hasVarwidth;
  const isXltabular = g.longtable && (hasVarwidth || !isZeroLength(width));
  os.safebreakln();
  if (rotate !== 0) {
    if (g.longtable) { ctx.features.require('lscape'); os.write('\\begin{landscape}\n'); }
    else { ctx.features.require('rotating'); os.write(`\\begin{turn}{${rotate}}\n`); }
  }
  if (g.longtable) {
    ctx.features.require('longtable');
    if (isXltabular) { ctx.features.require('xltabular'); os.write('\\begin{xltabular}'); }
    else os.write('\\begin{longtable}');
    const la = f('longtabularalignment');
    if (la === 'left') os.write('[l]'); else if (la === 'center') os.write('[c]'); else if (la === 'right') os.write('[r]');
    if (isXltabular) os.write(`{${isZeroLength(width) ? '\\columnwidth' : latexLength(width)}}`);
  } else {
    if (isTabularStar) os.write(`\\begin{tabular*}{${latexLength(width)}}`);
    else if (hasVarwidth) { ctx.features.require('tabularx'); os.write(`\\begin{tabularx}{${isZeroLength(width) ? '\\columnwidth' : latexLength(width)}}`); }
    else os.write('\\begin{tabular}');
    const va = f('tabularvalignment');
    if (va === 'top') os.write('[t]'); else if (va === 'bottom') os.write('[b]');
  }
  os.write('{');
  if (isTabularStar) os.write('@{\\extracolsep{\\fill}}');
  for (let c = 0; c < g.ncols; c++) os.write(columnSpec(g, c));
  os.write('}\n');
  ctx.features.require('NeedTabularnewline');
  for (const c of g.cols) if (!isZeroLength(c.width) || c.varwidth) ctx.features.require('array');
  for (const row of g.cells) for (const cell of row) {
    if (!isZeroLength(cell.width)) ctx.features.require('array');
    if (cell.usebox === 'varwidth') ctx.features.require('varwidth');
  }

  const first = 0;
  const last = g.nrows - 1;
  const rowFlag = (r: number, k: string) => isTrue(rowAttr(tab, r, k));
  const emitted = new Set<number>();
  if (g.longtable) {
    // caption rows outside header/footer
    for (let r = 0; r < g.nrows; r++) {
      if (rowFlag(r, 'caption') && !rowFlag(r, 'endfirsthead') && !rowFlag(r, 'endhead') && !rowFlag(r, 'endfoot') && !rowFlag(r, 'endlastfoot')) { texRow(ctx, os, rp, g, tab, r, first, last); emitted.add(r); }
    }
    const section = (flag: string, topDL: string, bottomDL: string, end: string) => {
      const rows = [];
      for (let r = 0; r < g.nrows; r++) if (rowFlag(r, flag)) rows.push(r);
      if (!rows.length) return false;
      if (isTrue(f(topDL))) os.write('\\hline\n');
      for (const r of rows) { texRow(ctx, os, rp, g, tab, r, first, last); emitted.add(r); }
      if (isTrue(f(bottomDL))) os.write('\\hline\n');
      os.write(end + '\n');
      return true;
    };
    const haveFirstHead = section('endfirsthead', 'firstHeadTopDL', 'firstHeadBottomDL', '\\endfirsthead');
    const hasHead = tab.rows.some((_, r) => rowFlag(r, 'endhead'));
    if (hasHead && isTrue(f('firstHeadEmpty')) && !haveFirstHead) os.write('\\endfirsthead\n');
    section('endhead', 'headTopDL', 'headBottomDL', '\\endhead');
    const hasFoot = section('endfoot', 'footTopDL', 'footBottomDL', '\\endfoot');
    const hasLastFoot = tab.rows.some((_, r) => rowFlag(r, 'endlastfoot'));
    if (hasFoot && isTrue(f('lastFootEmpty')) && !hasLastFoot) os.write('\\endlastfoot\n');
    section('endlastfoot', 'lastFootTopDL', 'lastFootBottomDL', '\\endlastfoot');
  }
  for (let r = 0; r < g.nrows; r++) {
    if (emitted.has(r)) continue;
    if (!ctx.outputChanges && rowAttr(tab, r, 'change') === 'deleted') continue;
    texRow(ctx, os, rp, g, tab, r, first, last);
    if (g.longtable && rowFlag(r, 'newpage')) os.write('\\newpage\n');
  }
  if (g.longtable) os.write(isXltabular ? '\\end{xltabular}' : '\\end{longtable}');
  else if (isTabularStar) os.write('\\end{tabular*}');
  else if (hasVarwidth) os.write('\\end{tabularx}');
  else os.write('\\end{tabular}');
  if (rotate !== 0) { os.breakln(); os.write(g.longtable ? '\\end{landscape}' : '\\end{turn}'); }
}

export type { Paragraph };
