/**
 * The rulers of the slide / poster canvas (View ▸ Rulers; gridview.ts keeps the setting): along the
 * canvas's top and left edges, as PowerPoint's and Keynote's are, so they stay in view however the
 * slide is zoomed and panned — the slide's part of the canvas starts past them (DeliverableEditor
 * `rulerRoom`). In the document's unit (units.ts: mm, inches in the US), 0 at the slide's top left
 * corner (where Position and size measures from), labels as dense as the zoom allows; the slide's
 * extent light, the selection's shaded, the pointer's place (the runtime's `rulerPointer`) a red mark.
 * A press on a ruler drags out a new guide on every slide — the top ruler a horizontal one, the left a
 * vertical one (runtime grid.ts `rulerGuide`, guides.ts's drag); let go back on the ruler, none is made.
 * Redrawn as the frame moves (viewport.ts `placed`), never through a render of the editor.
 */
import { useEffect, useRef } from 'preact/hooks';
import type { Rect, ToRuntime } from './protocol';
import './rulers.css';

/** the rulers' thickness (screen px) */
export const RULER = 18;

type Unit = 'mm' | 'in';
interface Place { tx: number; ty: number; s: number }

/** label steps in the unit, and how many small ticks between */
const STEPS: Record<Unit, [number, number][]> = {
  mm: [[1, 1], [2, 2], [5, 5], [10, 10], [20, 4], [50, 5], [100, 10], [200, 4], [500, 5], [1000, 10]],
  in: [[0.125, 1], [0.25, 2], [0.5, 4], [1, 8], [2, 4], [5, 5], [10, 10], [20, 4], [50, 5]],
};
const PX_PER: Record<Unit, number> = { mm: 96 / 25.4, in: 96 };
const n2 = (v: number) => Math.round(v * 100) / 100;

/**
 * One ruler's SVG: `len` screen px long, the slide's 0 at `o` (screen px along it), `k` screen px per
 * slide px; `slide` its length in slide px; `sel` the selection's extent and `mark` the pointer (slide px).
 */
export function rulerSvg(axis: 'x' | 'y', len: number, o: number, k: number, slide: number, unit: Unit, sel: [number, number] | null, mark: number | null): string {
  const t = RULER, per = PX_PER[unit] * k;   // screen px per unit
  const [step, sub] = STEPS[unit].find(([st]) => st * per >= 48) ?? STEPS[unit][STEPS[unit].length - 1];
  const along = (a: number, b: number, cls: string) => {
    const lo = Math.max(0, a), hi = Math.min(len, b);
    if (hi <= lo) return '';
    return axis === 'x' ? `<rect x="${n2(lo)}" y="0" width="${n2(hi - lo)}" height="${t}" class="${cls}"/>` : `<rect x="0" y="${n2(lo)}" width="${t}" height="${n2(hi - lo)}" class="${cls}"/>`;
  };
  const parts = [along(o, o + slide * k, 'rs')];
  if (sel) parts.push(along(o + sel[0] * k, o + sel[1] * k, 'rsel'));
  const minor = step / sub;
  const first = Math.max(0, Math.ceil(-o / (minor * per) - 1e-6)), last = Math.floor(Math.min(slide * k, len - o) / (minor * per) + 1e-6);
  let d = '';
  const labels: string[] = [];
  for (let i = first; i <= last && i - first < 2000; i++) {
    const p = o + i * minor * per, major = i % sub === 0, half = sub % 2 === 0 && i % (sub / 2) === 0;
    const l = major ? t * 0.55 : half ? t * 0.38 : t * 0.22;
    d += axis === 'x' ? `M${n2(p)} ${t}v${n2(-l)}` : `M${t} ${n2(p)}h${n2(-l)}`;
    if (major && i > 0 && p < len - 4) {
      const label = String(n2(i * minor));
      labels.push(axis === 'x' ? `<text x="${n2(p + 2)}" y="9">${label}</text>` : `<text x="9" y="${n2(p + 2)}" transform="rotate(-90 9 ${n2(p + 2)})" text-anchor="end">${label}</text>`);
    }
  }
  parts.push(`<path d="${d}" class="rtick"/>`, ...labels);
  if (mark !== null && mark >= 0 && mark <= slide) {
    const p = o + mark * k;
    if (p >= 0 && p <= len) parts.push(axis === 'x' ? `<path d="M${n2(p)} 0v${t}" class="rmark"/>` : `<path d="M0 ${n2(p)}h${t}" class="rmark"/>`);
  }
  return parts.join('');
}

/** draws both rulers as the frame is placed; the editor hands it the place, the slide and the pointer */
export class RulerPainter {
  top: SVGSVGElement | null = null;
  left: SVGSVGElement | null = null;
  /** the slide's part of the canvas: its corner (canvas px) */
  off = { x: RULER, y: RULER };
  unit: Unit = 'mm';
  /** the selection's boxes (slide px) */
  sel: Rect[] = [];
  private p: Place | null = null;
  private rect: Rect | null = null;
  private pointer: { x: number; y: number } | null = null;
  private raf = 0;

  /** the frame placed (`p`, viewport.ts) with the slide at `rect` (frame px) */
  place(p: Place | null, rect: Rect | null | undefined): void { this.p = p; this.rect = rect ?? null; this.draw(); }
  point(at: { x: number; y: number } | null): void {
    this.pointer = at;
    if (!this.raf) this.raf = requestAnimationFrame(() => { this.raf = 0; this.draw(); });
  }
  /** a canvas point (client px) on the frame's page (CSS px) */
  toFrame(clientX: number, clientY: number, canvas: Element): { x: number; y: number } | null {
    const p = this.p;
    if (!p || !p.s) return null;
    const c = canvas.getBoundingClientRect();
    return { x: (clientX - c.left - this.off.x - p.tx) / p.s, y: (clientY - c.top - this.off.y - p.ty) / p.s };
  }
  draw(): void {
    const { top, left, p, rect } = this;
    if (!top || !left) return;
    if (!p || !rect) { for (const r of [top, left]) if (r.lastElementChild) r.lastElementChild.innerHTML = ''; return; }
    // (the rulers start at the canvas's corner square: their own px begin RULER in)
    const ox = this.off.x - RULER + p.tx + rect.x * p.s, oy = this.off.y - RULER + p.ty + rect.y * p.s;
    const u = this.sel.length ? {
      x: [Math.min(...this.sel.map(r => r.x)), Math.max(...this.sel.map(r => r.x + r.w))] as [number, number],
      y: [Math.min(...this.sel.map(r => r.y)), Math.max(...this.sel.map(r => r.y + r.h))] as [number, number],
    } : null;
    const pt = this.pointer;
    // (into each ruler's <g>: its <title> stays)
    const tg = top.lastElementChild, lg = left.lastElementChild;
    if (tg) tg.innerHTML = rulerSvg('x', top.clientWidth || 2000, ox, p.s, rect.w, this.unit, u?.x ?? null, pt ? pt.x : null);
    if (lg) lg.innerHTML = rulerSvg('y', left.clientHeight || 2000, oy, p.s, rect.h, this.unit, u?.y ?? null, pt ? pt.y : null);
  }
}

interface Props {
  painter: RulerPainter;
  unit: Unit;
  sel: Rect[];
  /** the slide's part of the canvas: its corner (canvas px) — the drawing focus's insets plus the rulers */
  off: { x: number; y: number };
  send(msg: ToRuntime): void;
}

export function CanvasRulers({ painter, unit, sel, off, send }: Props) {
  const drag = useRef<{ axis: 'x' | 'y'; id: number } | null>(null);
  painter.unit = unit;
  painter.off = off;
  useEffect(() => { painter.sel = sel; painter.draw(); }, [sel, unit, off.x, off.y]);
  useEffect(() => () => { painter.top = null; painter.left = null; }, []);
  const canvasOf = (e: PointerEvent) => (e.currentTarget as Element).closest('.dl-canvas');
  const at = (e: PointerEvent) => { const c = canvasOf(e); return c ? painter.toFrame(e.clientX, e.clientY, c) : null; };
  const down = (axis: 'x' | 'y') => (e: PointerEvent) => {
    if (e.button !== 0 || drag.current) return;
    const p = at(e);
    if (!p) return;
    e.preventDefault();
    (e.currentTarget as Element).setPointerCapture?.(e.pointerId);
    drag.current = { axis, id: e.pointerId };
    // (the pointer over the frame stays the ruler's while the guide is dragged)
    canvasOf(e)?.classList.add('dl-ruling');
    send({ ol: 'rulerGuide', phase: 'start', axis, ...p });
  };
  const move = (e: PointerEvent) => {
    const d = drag.current;
    if (!d || d.id !== e.pointerId) return;
    const p = at(e);
    if (p) send({ ol: 'rulerGuide', phase: 'move', axis: d.axis, ...p, free: e.ctrlKey || e.metaKey });
  };
  const end = (cancel: boolean) => (e: PointerEvent) => {
    const d = drag.current;
    if (!d || d.id !== e.pointerId) return;
    drag.current = null;
    canvasOf(e)?.classList.remove('dl-ruling');
    const p = at(e) ?? { x: 0, y: 0 };
    send({ ol: 'rulerGuide', phase: cancel ? 'cancel' : 'end', axis: d.axis, ...p });
  };
  const handlers = (axis: 'x' | 'y') => ({ onPointerDown: down(axis), onPointerMove: move, onPointerUp: end(false), onPointerCancel: end(true), onLostPointerCapture: end(true) });
  // (the top ruler makes horizontal guides — axis 'y' —, the left one vertical guides)
  return <>
    <svg ref={el => { painter.top = el; }} class="dl-ruler top" data-dl-ruler="top" style={{ left: `${off.x}px`, top: `${off.y - RULER}px`, width: `calc(100% - ${off.x}px)`, height: `${RULER}px` }}
      aria-label="Ruler: drag down onto the slide for a guide" {...handlers('y')}><title>Drag down onto the slide for a guide</title><g /></svg>
    <svg ref={el => { painter.left = el; }} class="dl-ruler left" data-dl-ruler="left" style={{ left: `${off.x - RULER}px`, top: `${off.y}px`, width: `${RULER}px`, height: `calc(100% - ${off.y}px)` }}
      aria-label="Ruler: drag onto the slide for a guide" {...handlers('x')}><title>Drag onto the slide for a guide</title><g /></svg>
    <div class="dl-ruler-corner" style={{ left: `${off.x - RULER}px`, top: `${off.y - RULER}px` }} title={unit === 'mm' ? 'Millimetres' : 'Inches'}>{unit}</div>
  </>;
}
