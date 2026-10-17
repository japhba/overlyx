/**
 * "Fixed column widths" for the table at the cursor (Word's AutoFit ▸ Fixed column width): every
 * column becomes a p{…} column at the width it is drawn now, so the table keeps its layout and the
 * text wraps in its columns from then on. A table wider than its line is fitted into the line first:
 * the narrow columns keep their widths and the wide ones share what is left equally (max–min fair,
 * as a browser's automatic table layout shares a line), less the \tabcolsep padding LaTeX adds to
 * every column. The widths are shares of the text column (`23.5col%`, `0.235\columnwidth` in
 * LaTeX): the editor draws them on its text column (--ol-column), the PDF on the document's.
 *
 * The rest of the table-wide widths (Fit to contents, Fit to the page width) need no measuring:
 * tablecommands.ts setTableColumnWidths.
 */
import type { EditorView } from 'prosemirror-view';
import type { Node as PMNode } from 'prosemirror-model';
import { TableMap } from 'prosemirror-tables';
import { tableContext } from './commands';
import { setTableColumnWidths } from './tablecommands';

/** what LaTeX adds to each column of a tabular (2\tabcolsep, 12 pt), as a share of the text width (an article's 345 pt) */
export const COLUMN_PADDING_SHARE = 0.035;
/** the narrowest a fitted column is made, a share of the text width */
const MIN_SHARE = 0.04;

/**
 * Column widths fitted into `avail` (the same unit): unchanged when they fit; otherwise the columns
 * narrower than an equal share of what is left keep their widths (narrowest first), and the others
 * share the rest equally.
 */
export function fitColumnWidths(widths: readonly number[], avail: number): number[] {
  if (widths.reduce((a, b) => a + b, 0) <= avail) return [...widths];
  const out = [...widths];
  const order = widths.map((_, i) => i).sort((a, b) => widths[a] - widths[b]);
  let left = avail;
  for (let k = 0; k < order.length; k++) {
    const share = left / (order.length - k);
    if (widths[order[k]] > share) {
      for (let j = k; j < order.length; j++) out[order[j]] = share;
      break;
    }
    left -= widths[order[k]];
  }
  return out;
}

/** px widths as shares of the text column (`column` px): LyX lengths "23.5col%" */
export function widthsAsLengths(px: readonly number[], column: number): string[] {
  return px.map(w => `${+Math.max(MIN_SHARE * 100, Math.floor(w / column * 1000) / 10).toFixed(1)}col%`);
}

/**
 * The drawn width of each column of the table at `tablePos` (a <col>'s width is its cells'
 * border-box width): of a cell that spans only that column; a column without one gets an equal part
 * of what the others leave of the table. Null when the table is not drawn.
 */
export function drawnColumnWidths(view: EditorView, tablePos: number, table: PMNode): number[] | null {
  const el = view.nodeDOM(tablePos) as HTMLElement | null;
  if (!el || !el.offsetParent) return null;
  let map: TableMap;
  try { map = TableMap.get(table); } catch { return null; }
  const widths: (number | null)[] = [];
  for (let c = 0; c < map.width; c++) {
    let w: number | null = null;
    for (let r = 0; r < map.height && w === null; r++) {
      const off = map.map[r * map.width + c];
      if ((table.nodeAt(off)?.attrs.colspan ?? 1) !== 1) continue;
      const td = view.nodeDOM(tablePos + 1 + off) as HTMLElement | null;
      if (td?.offsetWidth) w = td.offsetWidth;
    }
    widths.push(w);
  }
  const known = widths.filter((w): w is number => w !== null);
  const missing = widths.length - known.length;
  const tableWidth = (el.querySelector('table') as HTMLElement | null)?.offsetWidth ?? el.offsetWidth;
  const rest = missing ? Math.max(0, tableWidth - known.reduce((a, b) => a + b, 0)) / missing : 0;
  return widths.map(w => w ?? rest);
}

/** Fixed column widths for the table at the cursor (the text then wraps in its columns): false when there is no table, or nothing changes. */
export function fixTableColumnWidths(view: EditorView): boolean {
  const ctx = tableContext(view.state);
  if (!ctx) return false;
  const drawn = drawnColumnWidths(view, ctx.tablePos, ctx.table);
  if (!drawn || !drawn.length) return false;
  const root = view.dom as HTMLElement;
  // (what the editor draws `col%` on: core schema.ts lyxLengthCss)
  const column = parseFloat(root.style.getPropertyValue('--ol-column')) || root.clientWidth;
  if (!(column > 0)) return false;
  // the line the table stands on: its paragraph's width inside its padding (an indented list item, a cell)
  const par = (view.nodeDOM(ctx.tablePos) as HTMLElement | null)?.closest('.lyx-par, p') as HTMLElement | null;
  let line = column;
  if (par) {
    const cs = getComputedStyle(par);
    line = Math.min(column, par.clientWidth - (parseFloat(cs.paddingLeft) || 0) - (parseFloat(cs.paddingRight) || 0)) || column;
  }
  // (many columns: the padding never takes more than half the line)
  const widths = fitColumnWidths(drawn, Math.max(line / 2, line - drawn.length * COLUMN_PADDING_SHARE * column));
  return setTableColumnWidths('fixed', widthsAsLengths(widths, column))(view.state, view.dispatch, view);
}
