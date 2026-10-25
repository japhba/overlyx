/**
 * The Draw row on a touch screen, as a palette of its own on the canvas (DeliverableEditor): the user,
 * 25 Oct 2026: "the toolbar, when locked, is in an awkward position. allow the user to intuitively
 * drag it across the screen, possibly by having suitable visual support". Like Apple's tool picker it
 * sits at an edge — along the bottom at first, standing upright at the left or the right — and is
 * dragged by its grip: it follows the finger, the canvas' edges light up, the nearest brightest, and a
 * dashed outline shows where it will go; let go, it settles there. A double tap on the grip puts it
 * back at the bottom. Kept in this browser (`ol.deckDrawPalette`).
 */
import { useEffect, useLayoutEffect, useRef, useState } from 'preact/hooks';
import { Toolbar } from '../app/Toolbar';
import type { ToolSection } from './decktoolbar';

export type PalEdge = 'top' | 'bottom' | 'left' | 'right';
/** the edge it sits at, and where along it (0–1: its middle) */
export interface PalDock { edge: PalEdge; at: number }
interface Size { w: number; h: number }

const KEY = 'ol.deckDrawPalette';
const EDGES: PalEdge[] = ['top', 'bottom', 'left', 'right'];
export const PAL_HOME: PalDock = { edge: 'bottom', at: 0.5 };
/** the room it keeps from the canvas' edge (px) */
const M = 10;

function loadDock(): PalDock {
  try {
    const v = JSON.parse(localStorage.getItem(KEY) ?? 'null') as Partial<PalDock> | null;
    if (v && EDGES.includes(v.edge as PalEdge) && typeof v.at === 'number' && v.at >= 0 && v.at <= 1) return { edge: v.edge as PalEdge, at: v.at };
  } catch { /* private window */ }
  return PAL_HOME;
}
let dock = loadDock();
const subs = new Set<(d: PalDock) => void>();
function setDock(d: PalDock): void {
  dock = d;
  try { localStorage.setItem(KEY, JSON.stringify(d)); } catch { /* private window */ }
  for (const fn of subs) fn(d);
}

export const upright = (e: PalEdge): boolean => e === 'left' || e === 'right';

/** its top left corner on a `canvas`-sized canvas, `size` its size there */
export function palPlace(d: PalDock, size: Size, canvas: Size): { x: number; y: number } {
  const along = (len: number, s: number) => Math.max(M, Math.min(len - s - M, d.at * len - s / 2));
  switch (d.edge) {
    case 'top': return { x: along(canvas.w, size.w), y: M };
    case 'bottom': return { x: along(canvas.w, size.w), y: Math.max(M, canvas.h - size.h - M) };
    case 'left': return { x: M, y: along(canvas.h, size.h) };
    case 'right': return { x: Math.max(M, canvas.w - size.w - M), y: along(canvas.h, size.h) };
  }
}

/** the edge nearest to a point of the canvas, and where along it */
export function nearestDock(x: number, y: number, canvas: Size): PalDock {
  const dist: [PalEdge, number][] = [['top', y], ['bottom', canvas.h - y], ['left', x], ['right', canvas.w - x]];
  const edge = dist.sort((a, b) => a[1] - b[1])[0][0];
  const at = upright(edge) ? y / Math.max(1, canvas.h) : x / Math.max(1, canvas.w);
  return { edge, at: Math.max(0, Math.min(1, at)) };
}

const GRIP = '<svg viewBox="0 0 12 18" aria-hidden="true"><g fill="currentColor"><circle cx="3.5" cy="3.5" r="1.5"/><circle cx="8.5" cy="3.5" r="1.5"/><circle cx="3.5" cy="9" r="1.5"/><circle cx="8.5" cy="9" r="1.5"/><circle cx="3.5" cy="14.5" r="1.5"/><circle cx="8.5" cy="14.5" r="1.5"/></g></svg>';

/** the Draw row's sections in a palette on the canvas it is rendered in (its offset parent) */
export function DrawPalette({ sections }: { sections: ToolSection[] }) {
  const [d, setD] = useState(dock);
  useEffect(() => { subs.add(setD); return () => { subs.delete(setD); }; }, []);
  const ref = useRef<HTMLDivElement>(null);
  const [size, setSize] = useState<Size>({ w: 0, h: 0 });
  const [canvas, setCanvas] = useState<Size>({ w: 0, h: 0 });
  useLayoutEffect(() => {
    const el = ref.current, c = el?.parentElement;
    if (!el || !c) return;
    const measure = () => {
      setSize(s => (s.w === el.offsetWidth && s.h === el.offsetHeight ? s : { w: el.offsetWidth, h: el.offsetHeight }));
      setCanvas(s => (s.w === c.clientWidth && s.h === c.clientHeight ? s : { w: c.clientWidth, h: c.clientHeight }));
    };
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(el); ro.observe(c);
    return () => ro.disconnect();
  }, []);
  /** being dragged: where it is (its top left), and where it would go */
  const [drag, setDrag] = useState<{ x: number; y: number; to: PalDock } | null>(null);
  const lastTap = useRef(0);

  const onGrip = (e: PointerEvent) => {
    if (e.button !== 0) return;
    e.preventDefault();
    e.stopPropagation();
    const grip = e.currentTarget as HTMLElement, el = ref.current, c = el?.parentElement;
    if (!el || !c) return;
    grip.setPointerCapture?.(e.pointerId);
    const cr = c.getBoundingClientRect(), pr = el.getBoundingClientRect();
    const off = { x: e.clientX - pr.left, y: e.clientY - pr.top }, x0 = e.clientX, y0 = e.clientY;
    const cv = { w: c.clientWidth, h: c.clientHeight };
    let moved = false, to: PalDock | null = null;
    const move = (ev: PointerEvent) => {
      if (!moved && Math.hypot(ev.clientX - x0, ev.clientY - y0) < 6) return;
      moved = true;
      to = nearestDock(ev.clientX - cr.left, ev.clientY - cr.top, cv);
      setDrag({ x: ev.clientX - cr.left - off.x, y: ev.clientY - cr.top - off.y, to });
    };
    const up = (ev: PointerEvent) => {
      grip.removeEventListener('pointermove', move);
      grip.removeEventListener('pointerup', up);
      grip.removeEventListener('pointercancel', up);
      setDrag(null);
      if (moved) { if (ev.type === 'pointerup' && to) setDock(to); return; }
      // a double tap: back at the bottom
      const now = performance.now();
      if (now - lastTap.current < 350) { setDock(PAL_HOME); lastTap.current = 0; } else lastTap.current = now;
    };
    grip.addEventListener('pointermove', move);
    grip.addEventListener('pointerup', up);
    grip.addEventListener('pointercancel', up);
  };

  const up = upright(d.edge);
  const at = drag ? { x: drag.x, y: drag.y } : palPlace(d, size, canvas);
  // where it would go: its outline there, upright at the sides (as long as it is wide, as wide as it is high)
  const ghost = drag && (() => {
    const s = upright(drag.to.edge) === up ? size : { w: size.h, h: Math.min(size.w, canvas.h - 2 * M) };
    const p = palPlace(drag.to, s, canvas);
    return { left: `${p.x}px`, top: `${p.y}px`, width: `${s.w}px`, height: `${s.h}px` };
  })();
  return (
    <>
      {drag && (
        <div class="dl-drawpal-guides" aria-hidden="true">
          {EDGES.map(e => <div key={e} class={'dl-drawpal-rail ' + e + (e === drag.to.edge ? ' on' : '')} />)}
          {ghost && <div class={'dl-drawpal-ghost' + (upright(drag.to.edge) ? ' upright' : '')} style={ghost} />}
        </div>
      )}
      <div ref={ref} class={'dl-drawpal' + (up ? ' upright' : '') + (drag ? ' lifted' : '') + (size.w ? '' : ' unplaced')} data-dl-drawpal data-edge={d.edge}
        data-tb-side={d.edge === 'left' ? 'left' : d.edge === 'right' ? 'right' : undefined} role="toolbar" aria-label="Draw"
        style={{ left: `${at.x}px`, top: `${at.y}px` }}
        // (the canvas beside the slide takes fingers as moving it: not those on the palette)
        onPointerDown={e => e.stopPropagation()}>
        <button type="button" class="dl-drawpal-grip" data-dl-drawpal-grip aria-label="Move the pens"
          title="Drag to put the pens anywhere along an edge — the left or the right stands them upright (double-tap: back at the bottom)"
          onPointerDown={onGrip as unknown as (e: Event) => void} dangerouslySetInnerHTML={{ __html: GRIP }} />
        {sections.map((sec, i) => <Toolbar key={`${i}:${sec.label}`} id="deck-context" groups={sec.groups} />)}
      </div>
    </>
  );
}
