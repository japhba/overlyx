/**
 * The grid and the rulers of the slide / poster canvas (runtime/grid.ts draws them): shown or not,
 * snapping or not and the grid's spacing are this browser's, per document (`ol.grid:<path>`), as the
 * canvas colour is — a view setting, never written into the file. Spacing in slide px (CSS px), offered
 * in the document's unit (units.ts: mm, inches in the US).
 */
import { lengthUnit } from './units';

export interface GridView { show: boolean; snap: boolean; rulers: boolean; /** slide px; 0: the usual for the kind */ size: number }

const NONE: GridView = { show: false, snap: false, rulers: false, size: 0 };

export function loadGrid(path: string): GridView {
  try { const v = JSON.parse(localStorage.getItem('ol.grid:' + path) ?? 'null'); return v && typeof v === 'object' ? { ...NONE, ...v } : NONE; } catch { return NONE; }
}
export function saveGrid(path: string, v: GridView): void {
  try { if (!v.show && !v.snap && !v.rulers && !v.size) localStorage.removeItem('ol.grid:' + path); else localStorage.setItem('ol.grid:' + path, JSON.stringify(v)); } catch { /* private window */ }
}

const MM = 96 / 25.4, IN = 96;

/** the spacings offered: a slide's in small steps, a poster's in larger ones */
export function gridChoices(kind: 'deck' | 'poster' | 'page', unit = lengthUnit()): { label: string; px: number }[] {
  const poster = kind === 'poster';
  if (unit === 'in') return (poster ? [0.5, 1, 2, 4] : [0.125, 0.25, 0.5, 1]).map(n => ({ label: `${n === 0.125 ? '⅛' : n === 0.25 ? '¼' : n === 0.5 ? '½' : n} in`, px: n * IN }));
  return (poster ? [10, 20, 50, 100] : [2, 5, 10, 20]).map(n => ({ label: `${n} mm`, px: n * MM }));
}

/** the spacing in use: the one chosen, or the second of the kind's choices */
export const gridSize = (v: GridView, kind: 'deck' | 'poster' | 'page'): number => v.size > 0 ? v.size : gridChoices(kind)[1].px;

/** the runtime's message for these settings */
export const gridMessage = (v: GridView, kind: 'deck' | 'poster' | 'page') =>
  ({ ol: 'grid' as const, show: v.show && kind !== 'page', snap: v.snap && kind !== 'page', rulers: v.rulers && kind !== 'page', size: gridSize(v, kind), unit: lengthUnit() });
