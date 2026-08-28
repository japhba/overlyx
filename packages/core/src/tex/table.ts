/**
 * tabular / tabular* / tabularx / longtable → LyX Tabular inset (the inverse of latex/tabular.ts).
 * Column specifications, \hline / \cline and booktabs rules, \multicolumn and \multirow are
 * understood; anything else inside a cell is parsed as text by the caller's callback. Returns
 * null when the table cannot be represented (the caller keeps it as raw LaTeX).
 */
import type { Paragraph, TabularCell, TabularInset, TabularRow } from '../lyx/ast.ts';
import { Scanner, groupEnd } from './scanner.ts';
import { lyxLength } from './parse.ts';

interface ColSpec { alignment: string; valignment: string; width: string; special: string; varwidth: boolean; leftline: boolean; rightline: boolean }

/** Expand *{n}{spec} and split a column specification into columns with their rules. */
export function parseColumnSpec(spec: string): ColSpec[] | null {
  let s = spec.replace(/\s+/g, ' ');
  // *{n}{...}
  for (let guard = 0; guard < 20; guard++) {
    const m = /\*\s*\{(\d+)\}\s*\{/.exec(s);
    if (!m) break;
    const start = m.index + m[0].length - 1;
    const end = groupEnd(s, start);
    const inner = s.slice(start + 1, end - 1);
    s = s.slice(0, m.index) + inner.repeat(parseInt(m[1], 10)) + s.slice(end);
  }
  const cols: ColSpec[] = [];
  let pendingLeft = false;
  let pendingBefore = '';   // >{...}
  const newCol = (alignment: string, valignment = 'top', width = '', special = ''): ColSpec => ({ alignment, valignment, width, special, varwidth: false, leftline: pendingLeft, rightline: false });
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (c === ' ') continue;
    if (c === '|') {
      if (cols.length && !pendingLeft && pendingBefore === '') { cols[cols.length - 1].rightline = true; }
      else pendingLeft = true;
      continue;
    }
    if (c === '@' || c === '!') {
      if (s[i + 1] === '{') { const e = groupEnd(s, i + 1); i = e - 1; }
      continue;
    }
    if (c === '>' || c === '<') {
      if (s[i + 1] === '{') { const e = groupEnd(s, i + 1); if (c === '>') pendingBefore = s.slice(i + 2, e - 1); i = e - 1; }
      continue;
    }
    let col: ColSpec;
    if (c === 'l' || c === 'c' || c === 'r') col = newCol(c === 'l' ? 'left' : c === 'c' ? 'center' : 'right');
    else if (c === 'p' || c === 'm' || c === 'b') {
      if (s[i + 1] !== '{') return null;
      const e = groupEnd(s, i + 1);
      const width = lyxLength(s.slice(i + 2, e - 1));
      i = e - 1;
      let align = 'block';
      if (/raggedright/.test(pendingBefore)) align = 'left';
      else if (/centering/.test(pendingBefore)) align = 'center';
      else if (/raggedleft/.test(pendingBefore)) align = 'right';
      col = newCol(align, c === 'm' ? 'middle' : c === 'b' ? 'bottom' : 'top', width);
    } else if (c === 'X') { col = newCol('block'); col.varwidth = true; }
    else {
      // unknown column type (S, N, ...): keep it as a special column
      let special = c;
      while (s[i + 1] === '{' || s[i + 1] === '[') { const e = s[i + 1] === '{' ? groupEnd(s, i + 1) : s.indexOf(']', i + 1) + 1; if (e <= 0) break; special += s.slice(i + 1, e); i = e - 1; }
      col = newCol('center', 'top', '', special);
    }
    if (pendingBefore && !col.width && !col.varwidth) col.special = `>{${pendingBefore}}${col.special || c}`;
    pendingBefore = '';
    pendingLeft = false;
    cols.push(col);
  }
  if (pendingLeft && cols.length) cols[cols.length - 1].rightline = true;
  return cols.length ? cols : null;
}

/** Index just after the \end{env} matching the environment opened before `pos` (nesting-aware). */
function envEnd(s: string, pos: number, env: string): number {
  let depth = 1;
  const re = new RegExp(`\\\\(begin|end)\\{${env.replace(/\*/g, '\\*')}\\}`, 'g');
  re.lastIndex = pos;
  let m: RegExpExecArray | null;
  while ((m = re.exec(s))) {
    if (m[1] === 'begin') depth++;
    else if (--depth === 0) return m.index;
  }
  return -1;
}

interface RawCell { text: string; leading: string[] }
interface RawRow { cells: RawCell[]; hlinesBefore: string[] }

/** Split the body of a tabular into rows and cells at the top level (braces, environments and math respected). */
function splitRows(body: string): { rows: RawRow[]; trailingLines: string[] } | null {
  const rows: RawRow[] = [];
  let cur: RawCell[] = [];
  let cell = '';
  let hlines: string[] = [];
  let lineCmds: string[] = [];   // \hline & co seen since the last row end
  let brace = 0, env = 0, math = false;
  const flushCell = () => { cur.push({ text: cell, leading: [] }); cell = ''; };
  const endRow = () => {
    flushCell();
    // a row that is only whitespace (e.g. before the final \end) is not a row
    if (cur.length === 1 && !cur[0].text.trim() && rows.length && !rows[rows.length - 1].cells.length) { cur = []; return; }
    rows.push({ cells: cur, hlinesBefore: lineCmds });
    cur = []; lineCmds = [];
  };
  for (let i = 0; i < body.length; i++) {
    const c = body[i];
    if (c === '\\') {
      const m = /^\\([A-Za-z]+\*?|.)/.exec(body.slice(i));
      const name = m ? m[1] : '';
      if (brace === 0 && env === 0 && !math) {
        if (name === '\\' || name === 'tabularnewline') {
          i += m![0].length - 1;
          // optional [length] after the line break
          const o = /^\s*\[[^\]]*\]/.exec(body.slice(i + 1));
          if (o) i += o[0].length;
          endRow();
          continue;
        }
        if (/^(hline|toprule|midrule|bottomrule|cline|cmidrule|addlinespace|specialrule|morecmidrules)$/.test(name)) {
          let cmd = '\\' + name;
          let j = i + m![0].length;
          while (body[j] === '[' || body[j] === '{' || body[j] === '(') {
            const close = body[j] === '[' ? ']' : body[j] === '{' ? '}' : ')';
            const e = body.indexOf(close, j);
            if (e < 0) break;
            cmd += body.slice(j, e + 1); j = e + 1;
          }
          if (cell.trim() === '' && cur.length === 0) lineCmds.push(cmd);
          else cell += cmd;   // a rule inside a row (unusual): keep it in the cell
          i = j - 1;
          continue;
        }
      }
      if (name === 'begin' || name === 'end') {
        const g = /^\\(begin|end)\s*\{([^}]*)\}/.exec(body.slice(i));
        if (g) { if (g[1] === 'begin') env++; else env--; cell += g[0]; i += g[0].length - 1; continue; }
      }
      cell += m ? m[0] : c;
      i += m ? m[0].length - 1 : 0;
      continue;
    }
    if (c === '%') { const e = body.indexOf('\n', i); cell += body.slice(i, e < 0 ? body.length : e + 1); i = e < 0 ? body.length : e; continue; }
    if (c === '{') brace++;
    else if (c === '}') brace--;
    else if (c === '$') math = !math;
    else if (c === '&' && brace === 0 && env === 0 && !math) { flushCell(); continue; }
    cell += c;
  }
  const rest = cell.trim();
  if (rest || cur.length) { flushCell(); rows.push({ cells: cur, hlinesBefore: lineCmds }); lineCmds = []; }
  if (brace !== 0 || env !== 0) return null;
  void hlines;
  return { rows, trailingLines: lineCmds };
}

/** \multicolumn{n}{spec}{content} / \multirow{n}{w}[off]{content} at the start of a cell. */
function cellPrefix(text: string): { span: number; rowspan: number; spec: string; content: string; mroffset: string; mrwidth: string } {
  let t = text.trim();
  let span = 1, rowspan = 1, spec = '', mroffset = '', mrwidth = '';
  for (let guard = 0; guard < 2; guard++) {
    let m = /^\\multicolumn\s*\{(\d+)\}\s*\{/.exec(t);
    if (m) {
      const specEnd = groupEnd(t, m[0].length - 1);
      spec = t.slice(m[0].length, specEnd - 1);
      span = parseInt(m[1], 10);
      const rest = t.slice(specEnd).trim();
      if (rest.startsWith('{')) { const e = groupEnd(rest, 0); t = rest.slice(1, e - 1) + rest.slice(e); } else t = rest;
      continue;
    }
    m = /^\\multirow\s*\{(-?\d+)\}\s*\{/.exec(t);
    if (m) {
      const wEnd = groupEnd(t, m[0].length - 1);
      mrwidth = t.slice(m[0].length, wEnd - 1);
      rowspan = parseInt(m[1], 10);
      let rest = t.slice(wEnd).trim();
      const o = /^\[([^\]]*)\]/.exec(rest);
      if (o) { mroffset = o[1]; rest = rest.slice(o[0].length).trim(); }
      if (rest.startsWith('{')) { const e = groupEnd(rest, 0); t = rest.slice(1, e - 1) + rest.slice(e); } else t = rest;
      continue;
    }
    break;
  }
  return { span, rowspan, spec, content: t, mroffset, mrwidth };
}

/**
 * Parse a tabular environment whose \begin{env} has just been read; the scanner is positioned
 * after the environment name. `parseCell` turns cell LaTeX into paragraphs.
 */
export function parseTabular(s: Scanner, env: string, parseCell: (text: string) => Paragraph[]): TabularInset | null {
  // arguments
  let valign = '';
  let width = '';
  if (env === 'tabular' || env === 'longtable') { const o = s.readOptional(); if (o !== null) valign = o.trim(); }
  if (env === 'tabular*' || env === 'tabularx' || env === 'xltabular') { const w = s.readGroup(); if (w === null) return null; width = lyxLength(w); }
  const spec = s.readGroup();
  if (spec === null) return null;
  const cols = parseColumnSpec(spec.replace(/@\{\\extracolsep\{\\fill\}\}/, ''));
  if (!cols) return null;
  const end = envEnd(s.s, s.pos, env);
  if (end < 0) return null;
  const body = s.s.slice(s.pos, end);
  const split = splitRows(body);
  if (!split) return null;
  s.pos = end + `\\end{${env}}`.length;
  const ncols = cols.length;
  const rows = split.rows.filter(r => !(r.cells.length === 1 && !r.cells[0].text.trim() && !r.hlinesBefore.length));
  if (!rows.length) return null;
  let booktabs = false;
  const rowLines = (cmds: string[]): { all: boolean; ranges: [number, number][] } => {
    let all = false;
    const ranges: [number, number][] = [];
    for (const c of cmds) {
      if (/^\\(hline|toprule|midrule|bottomrule)/.test(c)) { all = true; if (!c.startsWith('\\hline')) booktabs = true; }
      const m = /^\\(cline|cmidrule)(?:\([^)]*\))?\{(\d+)-(\d+)\}/.exec(c);
      if (m) { ranges.push([parseInt(m[2], 10), parseInt(m[3], 10)]); if (m[1] === 'cmidrule') booktabs = true; }
    }
    return { all, ranges };
  };
  const lyxRows: TabularRow[] = [];
  // occupancy for multirow continuation cells
  const occupied: (TabularCell | null)[][] = rows.map(() => new Array(ncols).fill(null));
  rows.forEach((row, r) => {
    const lines = rowLines(row.hlinesBefore);
    const cells: TabularCell[] = [];
    let c = 0;
    let ci = 0;
    while (c < ncols) {
      if (occupied[r][c]) { cells.push(occupied[r][c]!); c++; continue; }
      const raw = row.cells[ci++];
      const info = cellPrefix(raw ? raw.text : '');
      const col = cols[c];
      const attrs: [string, string][] = [];
      let alignment = col.alignment;
      let leftline = col.leftline, rightline = col.rightline;
      let cwidth = '';
      if (info.spec) {
        const sc = parseColumnSpec(info.spec);
        if (sc && sc.length) { alignment = sc[0].alignment; leftline = sc[0].leftline; rightline = sc[sc.length - 1].rightline; cwidth = sc[0].width; }
      }
      if (info.span > 1 || info.spec) attrs.push(['multicolumn', '1']);
      if (info.rowspan > 1) attrs.push(['multirow', '1']);
      attrs.push(['alignment', alignment], ['valignment', col.valignment]);
      if (cwidth) attrs.push(['width', cwidth]);
      if (info.mroffset) attrs.push(['mroffset', info.mroffset]);
      if (lines.all || lines.ranges.some(([a, b]) => c + 1 >= a && c + 1 <= b)) attrs.push(['topline', 'true']);
      if (leftline) attrs.push(['leftline', 'true']);
      if (rightline) attrs.push(['rightline', 'true']);
      attrs.push(['usebox', 'none']);
      const cell: TabularCell = { attrs, paragraphs: parseCell(info.content) };
      cells.push(cell);
      const span = Math.min(info.span, ncols - c);
      for (let k = 1; k < span; k++) {
        const cont: [string, string][] = [['multicolumn', '2'], ['alignment', alignment], ['valignment', col.valignment]];
        if (lines.all) cont.push(['topline', 'true']);
        cont.push(['usebox', 'none']);
        cells.push({ attrs: cont, paragraphs: [{ layout: 'Plain Layout', depth: 0, params: {}, items: [] }] });
      }
      if (info.rowspan > 1) {
        for (let k = 1; k < info.rowspan && r + k < rows.length; k++) {
          const cont: TabularCell = { attrs: [['multirow', '2'], ['alignment', alignment], ['valignment', col.valignment], ['usebox', 'none']], paragraphs: [{ layout: 'Plain Layout', depth: 0, params: {}, items: [] }] };
          occupied[r + k][c] = cont;
        }
      }
      c += span;
    }
    lyxRows.push({ attrs: [], cells });
  });
  // rules after the last row → bottom lines of the last row
  const trailing = rowLines(split.trailingLines);
  const last = lyxRows[lyxRows.length - 1];
  last.cells.forEach((cell, c) => {
    if (trailing.all || trailing.ranges.some(([a, b]) => c + 1 >= a && c + 1 <= b)) {
      const i = cell.attrs.findIndex(([k]) => k === 'usebox');
      cell.attrs.splice(i < 0 ? cell.attrs.length : i, 0, ['bottomline', 'true']);
    }
  });
  // multirow continuation cells: the LaTeX row had no & for them in some styles; drop rows that became empty
  const features: [string, string][] = [];
  if (env === 'longtable' || env === 'xltabular') features.push(['islongtable', 'true']);
  if (booktabs) features.push(['booktabs', 'true']);
  features.push(['tabularvalignment', valign === 't' ? 'top' : valign === 'b' ? 'bottom' : 'middle']);
  if (width) features.push(['tabularwidth', width]);
  const columns = cols.map(col => {
    const attrs: [string, string][] = [['alignment', col.alignment], ['valignment', col.valignment]];
    if (col.width) attrs.push(['width', col.width]);
    if (col.varwidth) attrs.push(['varwidth', 'true']);
    if (col.special) attrs.push(['special', col.special]);
    return { attrs };
  });
  return {
    type: 'Tabular',
    attrs: [['version', '3'], ['rows', String(lyxRows.length)], ['columns', String(ncols)]],
    features,
    columns,
    rows: lyxRows,
  };
}
