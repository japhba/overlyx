/**
 * Where the document's toolbars sit: along the top (the default), or in a column on the left or
 * the right of the document — LyX docks its toolbars on any side; on a wide screen a side column
 * leaves the page more height. Chosen in View ▸ Toolbars or by right-clicking a toolbar; kept in
 * this browser (`ol.tbDock`). Shared by the web client and the VS Code extension: each shell puts
 * one <ToolbarDock at="top"> above its main row and one for each side inside it, around the
 * editor column; only the one for the chosen place renders the rows.
 */
import type { ComponentChildren } from 'preact';
import { useEffect, useState } from 'preact/hooks';
import { showContextMenu, type MenuItem } from '../editor/contextmenu';

export type TbDock = 'top' | 'left' | 'right';
const KEY = 'ol.tbDock';
const isDock = (v: unknown): v is TbDock => v === 'top' || v === 'left' || v === 'right';

let dock: TbDock = (() => { try { const v = localStorage.getItem(KEY); return isDock(v) ? v : 'top'; } catch { return 'top'; } })();
const subs = new Set<() => void>();
const mark = () => { try { document.documentElement.dataset.tbDock = dock; } catch { /* no document (tests) */ } };
mark();

export function tbDock(): TbDock { return dock; }
export function setTbDock(d: TbDock): void {
  if (d === dock) return;
  dock = d;
  try { localStorage.setItem(KEY, d); } catch { /* private window */ }
  mark();
  for (const fn of subs) fn();
  // the editor's measurements (ruler, margins, notes) follow the column's new width
  window.dispatchEvent(new Event('resize'));
}
export function useTbDock(): TbDock {
  const [d, setD] = useState(dock);
  useEffect(() => { const fn = () => setD(dock); subs.add(fn); return () => { subs.delete(fn); }; }, []);
  return d;
}

const PLACES: [TbDock, string][] = [['top', 'Toolbars at the top'], ['left', 'Toolbars on the left'], ['right', 'Toolbars on the right']];
/** the three places as checked menu entries (View ▸ Toolbars; a toolbar's right-click menu) */
export function tbDockMenuEntries(): { label: string; checked: boolean; action: () => void }[] {
  return PLACES.map(([d, label]) => ({ label, checked: dock === d, action: () => setTbDock(d) }));
}

/** The toolbar rows (`children`) when the toolbars are docked `at` this place; right-click moves them. */
export function ToolbarDock({ at, children }: { at: TbDock; children: ComponentChildren }) {
  const d = useTbDock();
  if (d !== at) return null;
  const menu = (e: MouseEvent) => {
    if ((e.target as HTMLElement).closest('input, select, textarea, .tb-popup')) return;
    e.preventDefault();
    showContextMenu(e.clientX, e.clientY, [{ label: 'Toolbars', info: true }, ...tbDockMenuEntries()] as MenuItem[]);
  };
  return at === 'top'
    ? <div class="tb-dock-top" onContextMenu={menu}>{children}</div>
    : <div class={'tb-side ' + at} data-tb-side={at} onContextMenu={menu}>{children}</div>;
}
