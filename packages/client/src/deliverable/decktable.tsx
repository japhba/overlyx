/**
 * Tables in the deck editor's toolbar and menus (tablemodel.ts has the format, runtime/table.ts the
 * canvas side): the Table button's rows × columns grid, the Table section shown while a table is
 * selected or typed in, and the entries of the right-click and Format menus.
 */
import { TableSizePicker, type ToolButton } from '../app/Toolbar';
import { ColorGrid } from '../app/ColorGrid';
import type { MenuItem } from '../editor/contextmenu';
import { TABLE_SIZES, type TableBorders, type TableCmd, type TableInfo } from './tablemodel';

export interface DeckTableCtx {
  /** a table of `rows` × `cols` in the middle of the slide shown */
  insert(rows: number, cols: number): void;
  /** the selected table, or the one typed in */
  info: TableInfo | null;
  cmd(c: TableCmd): void;
}

const BORDERS: [TableBorders, string, string][] = [
  ['rules', 'Horizontal rules', 'formallines'],
  ['all', 'All borders', 'alllines'],
  ['none', 'No borders', 'nolines'],
];

/** the tools row's button: the grid of PowerPoint and Google Slides */
export function tableTool(t: DeckTableCtx, disabled: boolean): ToolButton {
  return {
    id: 'dk-table', title: 'Table — choose its rows and columns', icon: 'table', disabled,
    palette: { title: 'Table', render: close => <TableSizePicker close={close} max={8} onPick={(r, c) => t.insert(r, c)} /> },
  };
}

/** where rows and columns go: at the cell typed in, else at the table's end */
const place = (i: TableInfo) => (i.cell ? '' : ' — at the end of the table (click a cell first to choose where)');

/** the contextual toolbar's Table section */
export function tableGroups(t: DeckTableCtx): ToolButton[][] {
  const i = t.info;
  if (!i) return [];
  const fillWhat = i.typing ? 'Cell fill' : 'Table fill (type in a cell to fill that cell alone)';
  return [
    [
      { id: 'dk-table-row', title: `Insert row below${place(i)}`, icon: 'addrow', action: () => t.cmd({ t: 'row', where: 'below' }) },
      { id: 'dk-table-col', title: `Insert column right${place(i)}`, icon: 'addcol', action: () => t.cmd({ t: 'col', where: 'right' }) },
      { id: 'dk-table-delrow', title: `Delete row${place(i)}`, icon: 'delrow', action: () => t.cmd({ t: 'delRow' }) },
      { id: 'dk-table-delcol', title: `Delete column${place(i)}`, icon: 'delcol', action: () => t.cmd({ t: 'delCol' }) },
    ],
    [
      { id: 'dk-table-header', title: i.header ? 'Header row: on — the first row stands out' : 'Header row: off', icon: 'Header', active: i.header, action: () => t.cmd({ t: 'header', on: !i.header }) },
      ...BORDERS.map(([b, label, icon]) => ({ id: `dk-table-${b}`, title: label, icon, active: i.borders === b, action: () => t.cmd({ t: 'borders', borders: b }) })),
    ],
    [
      { id: 'dk-table-fill', title: fillWhat, icon: '',
        html: `<svg viewBox="0 0 16 16"><rect x="2.5" y="2.5" width="11" height="8" rx="1" fill="${i.fill ?? 'none'}" stroke="currentColor" stroke-width="1.1"/><rect x="2" y="12.6" width="12" height="2.6" rx="0.5" fill="${i.fill ?? 'none'}" stroke="${i.fill ? 'none' : 'currentColor'}" stroke-width="0.8"/></svg>`,
        palette: { title: fillWhat, render: close => <ColorGrid current={i.fill} close={close} none="No fill" onPick={col => t.cmd({ t: 'fill', color: col })} /> } },
      { id: 'dk-table-vtop', title: i.typing ? 'Cell: text at the top' : 'Cells: text at the top', icon: 'valigntop', active: i.valign === 'top', action: () => t.cmd({ t: 'valign', v: 'top' }) },
      { id: 'dk-table-vmid', title: i.typing ? 'Cell: text in the middle' : 'Cells: text in the middle', icon: 'valignmiddle', active: i.valign === 'middle', action: () => t.cmd({ t: 'valign', v: 'middle' }) },
      { id: 'dk-table-vbot', title: i.typing ? 'Cell: text at the bottom' : 'Cells: text at the bottom', icon: 'valignbottom', active: i.valign === 'bottom', action: () => t.cmd({ t: 'valign', v: 'bottom' }) },
    ],
  ];
}

/** the right-click menu's (and Format ▸ Table's) entries for the selected table */
export function tableMenuItems(t: DeckTableCtx, disabled = false): MenuItem[] {
  const i = t.info;
  if (!i) return [];
  return [
    { label: 'Insert row above', disabled, action: () => t.cmd({ t: 'row', where: 'above' }) },
    { label: 'Insert row below', disabled, action: () => t.cmd({ t: 'row', where: 'below' }) },
    { label: 'Insert column left', disabled, action: () => t.cmd({ t: 'col', where: 'left' }) },
    { label: 'Insert column right', disabled, action: () => t.cmd({ t: 'col', where: 'right' }) },
    { label: 'Delete row', disabled, action: () => t.cmd({ t: 'delRow' }) },
    { label: 'Delete column', disabled, action: () => t.cmd({ t: 'delCol' }) },
    { sep: true },
    { label: 'Merge with the cell to the right', disabled: disabled || !i.canMerge.right, action: () => t.cmd({ t: 'merge', dir: 'right' }) },
    { label: 'Merge with the cell below', disabled: disabled || !i.canMerge.down, action: () => t.cmd({ t: 'merge', dir: 'down' }) },
    { label: 'Split cell', disabled: disabled || !i.merged, action: () => t.cmd({ t: 'split' }) },
    { sep: true },
    { label: 'Header row', checked: i.header, disabled, action: () => t.cmd({ t: 'header', on: !i.header }) },
    { label: 'Borders', disabled, sub: BORDERS.map(([b, label]) => ({ label, checked: i.borders === b, action: () => t.cmd({ t: 'borders', borders: b }) })) },
    { label: 'Columns of equal width', disabled, action: () => t.cmd({ t: 'evenCols' }) },
  ];
}

/** Insert ▸ Table: a few sizes (the toolbar's button has the grid) */
export function tableInsertItems(t: DeckTableCtx): MenuItem[] {
  return TABLE_SIZES.map(([cols, rows]) => ({ label: `${cols} columns × ${rows} rows`, action: () => t.insert(rows, cols) }));
}
