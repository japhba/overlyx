/**
 * The grid and the rulers of the editing canvas (../gridview.ts keeps the settings: this browser's,
 * per document, as the canvas colour), drawn in the overlay over the slide shown — never in a slide,
 * the rail, a presentation or an export. The grid's lines every `size` slide px; with `snap`, moved and
 * resized objects snap their edges to them (edit.ts `snap`). The rulers lie along the slide's top and
 * left edges in the document's unit (mm, or in), the selection's extent shaded on them and the
 * pointer's place marked; a guide is dragged out of either (the top one: a horizontal guide, the left
 * one: a vertical one — guides.ts takes it from there).
 */
import type { Rect } from '../protocol';
import { docRect } from './env';

export interface GridSettings { show: boolean; snap: boolean; size: number; rulers: boolean; unit: 'mm' | 'in' }

let g: GridSettings = { show: false, snap: false, size: 96 / 2.54, rulers: false, unit: 'mm' };
let hooks: { scale: () => number; draw: () => void } | null = null;
const scale = () => hooks?.scale() ?? 1;

export function initGrid(h: NonNullable<typeof hooks>): void { hooks = h; }
export function setGrid(s: GridSettings): void {
  g = { ...s, size: s.size > 0.5 ? s.size : 37.8 };
  hooks?.draw();
}
export const rulersShown = (): boolean => g.rulers;

/** the pointer over the page (doc px), for the rulers' marks */
let pointer: { x: number; y: number } | null = null;
let raf = 0;
export function rulerPointer(x: number, y: number): void {
  if (!g.rulers) return;
  pointer = { x, y };
  if (!raf) raf = requestAnimationFrame(() => { raf = 0; hooks?.draw(); });
}

function frameOf(slide: HTMLElement) {
  const r = docRect(slide);
  const w = slide.offsetWidth || r.w, h = slide.offsetHeight || r.h;
  return { r, w, h, kx: r.w / (w || 1), ky: r.h / (h || 1) };
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

/** the rulers' thickness (doc px) */
const thick = () => 18 / scale();

/** a press on a ruler of the slide shown: the axis of the guide it drags out (top ruler: a horizontal guide) */
export function rulerAt(slide: HTMLElement | null, x: number, y: number): 'x' | 'y' | null {
  if (!g.rulers || !slide || !slide.isConnected) return null;
  const { r } = frameOf(slide), t = thick();
  if (x >= r.x && x <= r.x + r.w && y >= r.y - t && y < r.y) return 'y';
  if (y >= r.y && y <= r.y + r.h && x >= r.x - t && x < r.x) return 'x';
  return null;
}

/** label steps in the unit, and how many small ticks between */
const STEPS: Record<'mm' | 'in', [number, number][]> = {
  mm: [[1, 1], [2, 2], [5, 5], [10, 10], [20, 4], [50, 5], [100, 10], [200, 4], [500, 5], [1000, 10]],
  in: [[0.125, 1], [0.25, 2], [0.5, 4], [1, 8], [2, 4], [5, 5], [10, 10], [20, 4], [50, 5]],
};
const PX_PER: Record<'mm' | 'in', number> = { mm: 96 / 25.4, in: 96 };
const n2 = (v: number) => Math.round(v * 100) / 100;

/** one ruler as an SVG (doc px): ticks, labels, the selection's extent and the pointer */
function ruler(axis: 'x' | 'y', at: { x: number; y: number }, len: number, k: number, span: [number, number] | null, mark: number | null): string {
  const s = scale(), t = thick(), per = PX_PER[g.unit] * k;            // doc px per unit
  const [step, sub] = STEPS[g.unit].find(([st]) => st * per * s >= 56) ?? STEPS[g.unit][STEPS[g.unit].length - 1];
  const w = axis === 'x' ? len : t, h = axis === 'x' ? t : len;
  const parts: string[] = [`<rect x="0" y="0" width="${n2(w)}" height="${n2(h)}" class="rbg"/>`];
  if (span) {
    const a = Math.max(0, span[0]), b = Math.min(len, span[1]);
    if (b > a) parts.push(axis === 'x' ? `<rect x="${n2(a)}" y="0" width="${n2(b - a)}" height="${n2(t)}" class="rsel"/>` : `<rect x="0" y="${n2(a)}" width="${n2(t)}" height="${n2(b - a)}" class="rsel"/>`);
  }
  let d = '';
  const minor = step / sub, count = Math.floor(len / (minor * per) + 1e-6);
  for (let i = 0; i <= count; i++) {
    const p = i * minor * per, major = i % sub === 0, half = sub % 2 === 0 && i % (sub / 2) === 0;
    const l = major ? t : half ? t * 0.45 : t * 0.25;
    d += axis === 'x' ? `M${n2(p)} ${n2(t)}v${n2(-l)}` : `M${n2(t)} ${n2(p)}h${n2(-l)}`;
    if (major && i > 0) {
      const label = String(n2(i * minor));
      parts.push(axis === 'x'
        ? `<text x="${n2(p + 3 / s)}" y="${n2(10 / s)}">${label}</text>`
        : `<text x="${n2(10 / s)}" y="${n2(p + 3 / s)}" transform="rotate(-90 ${n2(10 / s)} ${n2(p + 3 / s)})" text-anchor="end">${label}</text>`);
    }
  }
  parts.push(`<path d="${d}" class="rtick" stroke-width="${n2(1 / s)}"/>`);
  if (mark !== null && mark >= 0 && mark <= len) parts.push(axis === 'x' ? `<path d="M${n2(mark)} 0v${n2(t)}" class="rmark" stroke-width="${n2(1 / s)}"/>` : `<path d="M0 ${n2(mark)}h${n2(t)}" class="rmark" stroke-width="${n2(1 / s)}"/>`);
  return `<svg class="uruler ${axis}" style="left:${n2(at.x)}px;top:${n2(at.y)}px;width:${n2(w)}px;height:${n2(h)}px" viewBox="0 0 ${n2(w)} ${n2(h)}">${parts.join('')}</svg>`;
}

/** the overlay's grid and rulers for the slide shown; `sel`: the selection's boxes (doc px) */
export function gridParts(slide: HTMLElement | null, sel: Rect[]): string {
  if ((!g.show && !g.rulers) || !slide || !slide.isConnected) return '';
  const f = frameOf(slide), out: string[] = [];
  if (g.show) {
    const sx = g.size * f.kx, sy = g.size * f.ky;
    out.push(`<div class="ugrid" style="left:${f.r.x}px;top:${f.r.y}px;width:${f.r.w}px;height:${f.r.h}px;background-size:${n2(sx)}px ${n2(sy)}px"></div>`);
  }
  if (g.rulers) {
    const t = thick();
    const u = sel.length ? { x0: Math.min(...sel.map(r => r.x)), x1: Math.max(...sel.map(r => r.x + r.w)), y0: Math.min(...sel.map(r => r.y)), y1: Math.max(...sel.map(r => r.y + r.h)) } : null;
    const p = pointer;
    out.push(ruler('x', { x: f.r.x, y: f.r.y - t }, f.r.w, f.kx, u ? [u.x0 - f.r.x, u.x1 - f.r.x] : null, p ? p.x - f.r.x : null));
    out.push(ruler('y', { x: f.r.x - t, y: f.r.y }, f.r.h, f.ky, u ? [u.y0 - f.r.y, u.y1 - f.r.y] : null, p ? p.y - f.r.y : null));
    out.push(`<div class="urcorner" style="left:${n2(f.r.x - t)}px;top:${n2(f.r.y - t)}px;width:${n2(t)}px;height:${n2(t)}px" title="${g.unit}">${g.unit}</div>`);
  }
  return out.join('');
}

/** (the overlay's styles: edit.ts) */
export const GRID_CSS = `
  .ugrid { position: absolute; pointer-events: none; opacity: .55;
    background-image: linear-gradient(to right, rgba(60, 110, 200, .45) calc(1px * var(--s)), transparent 0), linear-gradient(to bottom, rgba(60, 110, 200, .45) calc(1px * var(--s)), transparent 0); }
  .uruler { position: absolute; pointer-events: none; overflow: visible; font: 500 calc(9px * var(--s)) / 1 sans-serif; }
  .uruler.x { cursor: row-resize; } .uruler.y { cursor: col-resize; }
  .uruler .rbg { fill: rgba(250, 250, 250, .94); stroke: rgba(0, 0, 0, .18); stroke-width: calc(1px * var(--s)); }
  .uruler .rsel { fill: rgba(47, 111, 222, .18); }
  .uruler .rtick { stroke: #6b7280; fill: none; }
  .uruler .rmark { stroke: #d93025; }
  .uruler text { fill: #4b5563; font-size: calc(9px * var(--s)); }
  .urcorner { position: absolute; pointer-events: none; box-sizing: border-box; background: rgba(250, 250, 250, .94); border: calc(1px * var(--s)) solid rgba(0, 0, 0, .18); color: #6b7280; font: 500 calc(8px * var(--s)) / 1 sans-serif; display: flex; align-items: center; justify-content: center; }
`;
