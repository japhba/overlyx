/**
 * How wide display formulas and tables alone on their line may be drawn — the ruler's second track
 * (app/Ruler.tsx), View ▸ Formula & table width. Such content is centred on the text column; wider
 * than the column it spills into both margins as far as this width, wider still a table is drawn
 * smaller (plugins/widetables.ts) and a long one-line formula breaks at it (nodeviews/math.ts).
 *
 * A view setting, per user like the text width (localStorage), not the document's: the PDF does not
 * change. WIDE_FULL (the default): as far as the document pane reaches (the notes pane left out,
 * 16px either side); WIDE_TEXT: no wider than the text column; otherwise a width in px at 100 % zoom,
 * never less than the column.
 */
import { documentViewScale } from './viewscale';

export const WIDE_FULL = 0, WIDE_TEXT = -1;
const KEY = 'ol.wideWidth';

function read(): number {
  try {
    const raw = localStorage.getItem(KEY);
    const v = raw === null ? WIDE_FULL : Number(raw);
    return Number.isFinite(v) && (v === WIDE_TEXT || v >= 0) ? Math.round(v) : WIDE_FULL;
  } catch { return WIDE_FULL; }
}

let wide = typeof localStorage === 'undefined' ? WIDE_FULL : read();
const listeners = new Set<() => void>();

export function wideWidth(): number { return wide; }

export function setWideWidth(v: number): void {
  const next = v === WIDE_TEXT || v === WIDE_FULL ? v : Math.max(1, Math.round(v));
  if (next === wide) return;
  wide = next;
  try { localStorage.setItem(KEY, String(next)); } catch { /* private window */ }
  for (const l of [...listeners]) l();
}

/** called when the width changes; returns the unsubscribe */
export function onWideWidth(fn: () => void): () => void {
  listeners.add(fn);
  return () => { listeners.delete(fn); };
}

/** the document pane's room for wide content at 100 % zoom: its width, the notes pane left out, less 16px either side */
export function paneRoom(el: HTMLElement): number {
  const scroll = el.closest('.editor-scroll') as HTMLElement | null;
  const pane = scroll ? scroll.clientWidth - (parseFloat(scroll.style.getPropertyValue('--notes-col')) || 0) : window.innerWidth;
  return pane / documentViewScale(el) - 32;
}

/** the room wide content has, at 100 % zoom: the setting's width, within the pane, never less than `column` */
export function wideRoom(el: HTMLElement, column: number): number {
  if (wide === WIDE_TEXT) return column;
  const full = paneRoom(el);
  return Math.max(column, wide === WIDE_FULL ? full : Math.min(full, wide));
}
