/**
 * Tables on slides and posters: what the editor and the canvas runtime (runtime/table.ts) share.
 *
 * A table is a plain `<table>` in the page's source, an object on the slide like a text box:
 *
 *     <table class="ol-table" style="position: absolute; left: 160px; top: 240px; width: 960px">
 *       <tr><th>Method</th><th>Accuracy</th></tr>
 *       <tr><td>Ours</td><td>0.93</td></tr>
 *     </table>
 *
 * - `class="ol-table"`: OverLyX's look (runtime/table.ts TABLE_CSS, in every mode — editing, the
 *   rail, presenting, the PDF, the website): the slide's own font and text colour, rules in that
 *   colour, columns of equal width unless `<col style="width: …%">` say otherwise.
 * - `data-ol-borders="all" | "none"`: a line round every cell, or no lines; without it horizontal
 *   rules only (LaTeX's booktabs: a rule above, one under the header row, one below).
 * - The header row is a first row of `<th>` cells.
 * - A cell's fill and alignment are its own `style` (`background`, `text-align`, `vertical-align`),
 *   a row's height `style="height: …px"` on its `<tr>`.
 *
 * A `<table>` written by hand or by an agent (with or without the class) is edited the same way.
 */

export const TABLE_CLASS = 'ol-table';
export const BORDERS_ATTR = 'data-ol-borders';

export type TableBorders = 'rules' | 'all' | 'none';

/** what the toolbar and the menus do to the selected table (the cell typed in last, else its last row / column) */
export type TableCmd =
  /** a new table of `rows` × `cols` in the middle of the slide in view (the first row a header row), its first cell typed in */
  | { t: 'insert'; rows: number; cols: number }
  | { t: 'row'; where: 'above' | 'below' }
  | { t: 'col'; where: 'left' | 'right' }
  | { t: 'delRow' }
  | { t: 'delCol' }
  | { t: 'header'; on: boolean }
  | { t: 'borders'; borders: TableBorders }
  /** the cell typed in — or, the table selected as a whole, all of it */
  | { t: 'fill'; color: string | null }
  | { t: 'valign'; v: 'top' | 'middle' | 'bottom' }
  /** every column as wide as the others */
  | { t: 'evenCols' }
  /** the cell and the one to its right / below made one (`colspan` / `rowspan`; their texts joined) */
  | { t: 'merge'; dir: 'right' | 'down' }
  /** a merged cell split into single ones again */
  | { t: 'split' };

/** the selected table as the editor sees it */
export interface TableInfo {
  rows: number;
  cols: number;
  /** its first row is a header row */
  header: boolean;
  borders: TableBorders;
  /** the cell typed in (or typed in last, or right-clicked) */
  cell: { row: number; col: number } | null;
  /** a cell is being typed in */
  typing: boolean;
  /** that cell spans several columns or rows (Split cell); it can be merged with the one to its right / below */
  merged: boolean;
  canMerge: { right: boolean; down: boolean };
  /** the fill of that cell (the table's when none is) */
  fill: string | null;
  valign: 'top' | 'middle' | 'bottom';
}

const r1 = (n: number) => String(Math.round(n * 10) / 10);
const escText = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

/**
 * A new table's source: `rect` its place on the slide (px; null in the flow of a web page), the
 * first row a header row; `cells`: what is in them (plain text), row by row.
 */
export function tableHtml(rows: number, cols: number, rect: { x: number; y: number; w: number } | null, cells?: string[][], header = true): string {
  const n = Math.max(1, Math.min(50, Math.round(rows))), m = Math.max(1, Math.min(30, Math.round(cols)));
  const lines: string[] = [];
  for (let r = 0; r < n; r++) {
    const tag = header && r === 0 ? 'th' : 'td';
    let row = '';
    for (let c = 0; c < m; c++) row += `<${tag}>${escText(cells?.[r]?.[c] ?? '').replace(/\r?\n/g, '<br>')}</${tag}>`;
    lines.push(`  <tr>${row}</tr>`);
  }
  const style = rect ? ` style="position: absolute; left: ${r1(rect.x)}px; top: ${r1(rect.y)}px; width: ${r1(rect.w)}px"` : '';
  return `<table class="${TABLE_CLASS}"${style}>\n${lines.join('\n')}\n</table>`;
}

/** where a new table goes on a slide of `pageW` × `pageH` px: centred, wider with more columns */
export function tablePlace(cols: number, rows: number, pageW: number, pageH: number, fontPx: number): { x: number; y: number; w: number } {
  const w = Math.round(Math.min(pageW * 0.84, Math.max(pageW * 0.3, pageW * (0.24 + 0.12 * cols))));
  const h = rows * fontPx * 1.9;
  return { x: Math.round((pageW - w) / 2), y: Math.round(Math.max(pageH * 0.12, Math.min(pageH * 0.36, (pageH - h) / 2))), w };
}

/**
 * A table copied from a spreadsheet, as the clipboard has it: the cells of an HTML `<table>`, else
 * of tab-separated lines (at least two columns or two lines with a tab) — null when it is no table.
 */
export function clipTable(html: string, plain: string): string[][] | null {
  if (/<table[\s>]/i.test(html) && typeof DOMParser !== 'undefined') {
    const doc = new DOMParser().parseFromString(html, 'text/html');
    const t = doc.querySelector('table');
    const rows = t ? Array.from(t.rows).map(tr => Array.from(tr.cells).map(c => (c.textContent ?? '').replace(/\s+/g, ' ').trim())) : [];
    const out = rows.filter(r => r.length);
    if (out.length && (out.length > 1 || out[0].length > 1)) return squared(out);
  }
  return tsvTable(plain);
}

/** tab-separated lines as cells (a spreadsheet's plain-text copy) */
export function tsvTable(plain: string): string[][] | null {
  if (!plain.includes('\t')) return null;
  const lines = plain.replace(/\r\n?/g, '\n').replace(/\n+$/, '').split('\n');
  if (!lines.length || lines.length > 200) return null;
  const rows = lines.map(l => l.split('\t').map(c => c.trim()));
  if (!rows.every(r => r.length > 1) && rows.filter(r => r.length > 1).length < 2) return null;
  return squared(rows);
}

/** every row as long as the longest (at most 30 columns, 50 rows) */
function squared(rows: string[][]): string[][] {
  const m = Math.min(30, Math.max(...rows.map(r => r.length)));
  return rows.slice(0, 50).map(r => Array.from({ length: m }, (_, i) => r[i] ?? ''));
}

/** the sizes the Insert menu offers (the toolbar's button has the grid) */
export const TABLE_SIZES: [number, number][] = [[2, 2], [3, 3], [4, 3], [4, 4], [5, 4], [6, 5]];
