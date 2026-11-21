/**
 * The grid of the editing canvas (../gridview.ts keeps the settings: this browser's, per document, as
 * the canvas colour), drawn in the overlay over the slide shown — never in a slide, the rail, a
 * presentation or an export. The grid's lines every `size` slide px; with `snap`, moved and resized
 * objects snap their edges to them (edit.ts `snap`).
 *
 * The rulers are the editor's (../rulers.ts): they lie along the canvas's top and left edges, as
 * PowerPoint's and Keynote's do, so they stay in view however the slide is zoomed and panned. The
 * runtime tells the editor where the pointer is on the slide (`rulerPointer`, slide px) and takes the
 * guides dragged out of them (`rulerGuide`: the top ruler gives a horizontal guide, the left one a
 * vertical one — guides.ts's drag from there on).
 */
import type { Rect } from '../protocol';
import { docRect, post, slides } from './env';
import { isSolo, soloIndex } from './solo';
import { startGuideDrag, moveGuideDrag, endGuideDrag, guideDragging } from './guides';

export interface GridSettings { show: boolean; snap: boolean; size: number; rulers: boolean; unit: 'mm' | 'in' }

let g: GridSettings = { show: false, snap: false, size: 96 / 2.54, rulers: false, unit: 'mm' };
let hooks: { scale: () => number; draw: () => void } | null = null;

export function initGrid(h: NonNullable<typeof hooks>): void {
  hooks = h;
  // (off the page: no mark on the rulers)
  document.documentElement.addEventListener('pointerleave', () => { pointer = null; if (g.rulers && !raf) raf = requestAnimationFrame(tellPointer); });
}
export function setGrid(s: GridSettings): void {
  g = { ...s, size: s.size > 0.5 ? s.size : 37.8 };
  hooks?.draw();
}
export const rulersShown = (): boolean => g.rulers;

const shownSlide = (): HTMLElement | null => isSolo() ? slides()[soloIndex()] ?? null : null;

function frameOf(slide: HTMLElement) {
  const r = docRect(slide);
  const w = slide.offsetWidth || r.w, h = slide.offsetHeight || r.h;
  return { r, w, h, kx: r.w / (w || 1), ky: r.h / (h || 1) };
}

/** the pointer over the page (doc px), for the rulers' marks — told the editor once a frame */
let pointer: { x: number; y: number } | null = null;
let raf = 0;
let told: { x: number; y: number } | null | undefined;
export function rulerPointer(x: number, y: number): void {
  if (!g.rulers) return;
  pointer = { x, y };
  if (!raf) raf = requestAnimationFrame(tellPointer);
}
function tellPointer(): void {
  raf = 0;
  const slide = shownSlide();
  let at: { x: number; y: number } | null = null;
  if (pointer && slide?.isConnected) {
    const f = frameOf(slide);
    at = { x: Math.round((pointer.x - f.r.x) / f.kx * 10) / 10, y: Math.round((pointer.y - f.r.y) / f.ky * 10) / 10 };
  }
  if (told !== undefined && (told === at || (told && at && told.x === at.x && told.y === at.y))) return;
  told = at;
  post({ ol: 'rulerPointer', at });
}

/** a guide dragged out of one of the editor's rulers, every slide's, at a point of the page (doc px) */
export function rulerGuide(m: { phase: 'start' | 'move' | 'end' | 'cancel'; axis: 'x' | 'y'; x: number; y: number; free?: boolean }): void {
  if (m.phase === 'start') {
    const slide = shownSlide();
    if (slide?.isConnected && !guideDragging()) startGuideDrag(slide, { axis: m.axis, at: -1e6, own: false }, true, m.x, m.y);
    return;
  }
  if (!guideDragging()) return;
  if (m.phase === 'move') moveGuideDrag(m.x, m.y, !!m.free);
  else endGuideDrag(m.phase === 'cancel');
}

/** grid lines near a box's edges (doc px): where a moved or resized object snaps besides the guides */
export function gridSnaps(slide: HTMLElement | null, box: Rect): { xs: number[]; ys: number[] } {
  if (!g.snap || !slide) return { xs: [], ys: [] };
  const f = frameOf(slide), sx = g.size * f.kx, sy = g.size * f.ky;
  const near = (v: number, o: number, s: number) => [o + Math.floor((v - o) / s) * s, o + Math.ceil((v - o) / s) * s];
  return {
    xs: [...near(box.x, f.r.x, sx), ...near(box.x + box.w, f.r.x, sx)],
    ys: [...near(box.y, f.r.y, sy), ...near(box.y + box.h, f.r.y, sy)],
  };
}

const n2 = (v: number) => Math.round(v * 100) / 100;

/** the overlay's grid for the slide shown */
export function gridParts(slide: HTMLElement | null): string {
  if (!g.show || !slide || !slide.isConnected) return '';
  const f = frameOf(slide), sx = g.size * f.kx, sy = g.size * f.ky;
  return `<div class="ugrid" style="left:${f.r.x}px;top:${f.r.y}px;width:${f.r.w}px;height:${f.r.h}px;background-size:${n2(sx)}px ${n2(sy)}px"></div>`;
}

/** (the overlay's styles: edit.ts) */
export const GRID_CSS = `
  .ugrid { position: absolute; pointer-events: none; opacity: .55;
    background-image: linear-gradient(to right, rgba(60, 110, 200, .45) calc(1px * var(--s)), transparent 0), linear-gradient(to bottom, rgba(60, 110, 200, .45) calc(1px * var(--s)), transparent 0); }
`;
