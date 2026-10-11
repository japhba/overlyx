/**
 * Draw's strokes as GoodNotes draws them (perfect-freehand): an outline whose width follows the
 * Pencil's pressure — or, with a mouse or a finger, the speed (faster is thinner) — tapering in at the
 * start and out at the end; the highlighter's an even band. The outline is what the page keeps (a
 * filled `<path>`, sourceops.ts objectHtml), and what is shown while the stroke is drawn, so the line
 * under the pen is the line that stays. Pure: the runtime draws it, the tests measure it.
 */
import { getStroke } from 'perfect-freehand';

/** [x, y, pressure 0..1] — pressure 0.5 where there is none (a mouse, a finger) */
export type FreePt = [number, number, number];

export interface FreeOpts {
  /** the nominal width (px) */
  width: number;
  highlighter?: boolean;
  /** the points carry a pen's pressure (else it is simulated from the speed) */
  pressure?: boolean;
  /** the stroke is finished: its end tapers out and caps (while drawing, the end follows the pen) */
  last?: boolean;
}

/** the closed outline of a stroke (polygon points) */
export function freeOutline(pts: FreePt[], o: FreeOpts): number[][] {
  if (!pts.length) return [];
  const w = Math.max(0.5, o.width);
  if (o.highlighter) {
    return getStroke(pts, { size: w, thinning: 0, smoothing: 0.5, streamline: 0.45, simulatePressure: false, start: { cap: true, taper: 0 }, end: { cap: true, taper: 0 }, last: !!o.last });
  }
  // a dot (a tap, an i's): round, no taper to shrink it to nothing
  let len = 0;
  for (let i = 1; i < pts.length && len < w * 2; i++) len += Math.hypot(pts[i][0] - pts[i - 1][0], pts[i][1] - pts[i - 1][1]);
  const dot = len < w * 2;
  return getStroke(pts, {
    // a pen's nib at full pressure ~1.5× its width, light ~0.4×: the width the preset names is the middle
    size: w * 1.15,
    thinning: o.pressure ? 0.62 : 0.5,
    smoothing: 0.6,
    streamline: o.pressure ? 0.32 : 0.45,
    simulatePressure: !o.pressure,
    easing: o.pressure ? (t: number) => t * 0.65 + Math.sin((t * Math.PI) / 2) * 0.35 : (t: number) => Math.sin((t * Math.PI) / 2),
    start: { cap: true, taper: dot ? 0 : Math.max(6, w * 3), easing: (t: number) => t * (2 - t) },
    end: { cap: true, taper: dot ? 0 : Math.max(8, w * 4), easing: (t: number) => t * (2 - t) },
    last: !!o.last,
  });
}

const avg = (a: number, b: number) => (a + b) / 2;
const f2 = (n: number) => String(Math.round(n * 100) / 100);

/** the outline as SVG path data, smoothed through the midpoints, moved by (dx, dy) */
export function outlinePathD(poly: number[][], dx = 0, dy = 0): string {
  const n = poly.length;
  if (n < 3) return '';
  const p = (i: number) => poly[i % n];
  let d = `M${f2(avg(p(0)[0], p(1)[0]) + dx)} ${f2(avg(p(0)[1], p(1)[1]) + dy)}`;
  for (let i = 1; i <= n; i++) {
    const a = p(i), b = p(i + 1);
    d += `Q${f2(a[0] + dx)} ${f2(a[1] + dy)} ${f2(avg(a[0], b[0]) + dx)} ${f2(avg(a[1], b[1]) + dy)}`;
  }
  return d + 'Z';
}

/** the outline's box */
export function outlineBox(poly: number[][]): { x: number; y: number; w: number; h: number } {
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (const [x, y] of poly) { if (x < x0) x0 = x; if (y < y0) y0 = y; if (x > x1) x1 = x; if (y > y1) y1 = y; }
  return x0 === Infinity ? { x: 0, y: 0, w: 0, h: 0 } : { x: x0, y: y0, w: x1 - x0, h: y1 - y0 };
}
