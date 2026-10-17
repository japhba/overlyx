/**
 * Where the contextual toolbars (math, its panels, table, review, draw) sit: each on its own at an
 * edge of the document area — the bottom (LyX's place, the default), the top, the left or the
 * right, standing upright at the sides. A bar is dragged by its label: it follows the pointer, the
 * edge it would go to lights up, and it snaps there when let go (a right-click on it names the four
 * places too). Kept per bar in this browser (`ol.ctxDock`). Shared by the web client and the VS Code
 * extension: each shell renders <ContextBars> where the bottom rows were, inside its `.app`.
 */
import type { ComponentChildren, JSX } from 'preact';
import { useEffect, useLayoutEffect, useRef, useState } from 'preact/hooks';
import { showContextMenu, type MenuItem } from '../editor/contextmenu';

export type CtxEdge = 'bottom' | 'top' | 'left' | 'right';
const EDGES: CtxEdge[] = ['bottom', 'top', 'left', 'right'];
const KEY = 'ol.ctxDock';

let docks: Record<string, CtxEdge> = (() => {
  try {
    const v = JSON.parse(localStorage.getItem(KEY) ?? '{}');
    return Object.fromEntries(Object.entries(v).filter(([, e]) => EDGES.includes(e as CtxEdge))) as Record<string, CtxEdge>;
  } catch { return {}; }
})();
const subs = new Set<() => void>();

/** the edge a contextual toolbar sits at */
export function ctxDock(id: string): CtxEdge { return docks[id] ?? 'bottom'; }
export function setCtxDock(id: string, edge: CtxEdge): void {
  if (ctxDock(id) === edge) return;
  docks = { ...docks, [id]: edge };
  if (edge === 'bottom') delete docks[id];
  try { localStorage.setItem(KEY, JSON.stringify(docks)); } catch { /* private window */ }
  for (const fn of subs) fn();
}
function useCtxDocks(): Record<string, CtxEdge> {
  const [d, setD] = useState(docks);
  useEffect(() => { const fn = () => setD(docks); subs.add(fn); return () => { subs.delete(fn); }; }, []);
  return d;
}

/** the bars shown now, from [shown, id, row] */
export function contextBars(rows: [unknown, string, ComponentChildren][]): [string, ComponentChildren][] {
  return rows.filter(r => !!r[0]).map(r => [r[1], r[2]]);
}

const PLACE: Record<CtxEdge, string> = { bottom: 'At the bottom', top: 'At the top', left: 'On the left', right: 'On the right' };

/**
 * The contextual toolbars shown now (`bars`: their ids and rows), each at its edge. `style` keeps
 * them over the document: its `left` / `right` are the side panels' widths, as the bottom rows had.
 */
export function ContextBars({ bars, style }: { bars: [string, ComponentChildren][]; style: { left: string; right: string } }) {
  const d = useCtxDocks();
  const anchor = useRef<HTMLDivElement>(null);
  // the document area (the `.main` row): the top, left and right bars stand inside it
  const [area, setArea] = useState<{ top: number; height: number } | null>(null);
  useLayoutEffect(() => {
    const app = anchor.current?.parentElement;
    const main = app?.querySelector<HTMLElement>(':scope > .main');
    if (!app || !main) return;
    const measure = () => {
      const a = app.getBoundingClientRect(), m = main.getBoundingClientRect();
      setArea(p => (p && p.top === m.top - a.top && p.height === m.height ? p : { top: m.top - a.top, height: m.height }));
    };
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(main); ro.observe(app);
    return () => ro.disconnect();
  }, []);
  const [drag, setDrag] = useState<{ id: string; edge: CtxEdge } | null>(null);

  const at = (edge: CtxEdge) => bars.filter(([id]) => (d[id] ?? 'bottom') === edge);
  /** the edge nearest to a point of the window, within the document area */
  const nearest = (x: number, y: number): CtxEdge => {
    const app = anchor.current?.parentElement?.getBoundingClientRect();
    if (!app || !area) return 'bottom';
    const left = app.left + (parseFloat(style.left) || 0), right = app.right - (parseFloat(style.right) || 0);
    const top = app.top + area.top, bottom = top + area.height;
    const dist: [CtxEdge, number][] = [['top', y - top], ['bottom', bottom - y], ['left', x - left], ['right', right - x]];
    return dist.sort((a, b) => a[1] - b[1])[0][0];
  };

  const down = (e: PointerEvent) => {
    const label = (e.target as HTMLElement).closest('.tb-label');
    const bar = label?.closest<HTMLElement>('[data-toolbar]');
    const id = bar?.dataset.toolbar;
    if (!label || !bar || !id || e.button !== 0) return;
    e.preventDefault();
    const x0 = e.clientX, y0 = e.clientY;
    let moved = false;
    (label as HTMLElement).setPointerCapture(e.pointerId);
    const move = (ev: PointerEvent) => {
      if (!moved && Math.hypot(ev.clientX - x0, ev.clientY - y0) < 5) return;
      moved = true;
      bar.style.transform = `translate(${ev.clientX - x0}px, ${ev.clientY - y0}px)`;
      bar.classList.add('ctx-dragging');
      setDrag({ id, edge: nearest(ev.clientX, ev.clientY) });
    };
    const up = (ev: PointerEvent) => {
      label.removeEventListener('pointermove', move as EventListener);
      label.removeEventListener('pointerup', up as EventListener);
      label.removeEventListener('pointercancel', up as EventListener);
      bar.style.transform = '';
      bar.classList.remove('ctx-dragging');
      setDrag(null);
      if (moved && ev.type === 'pointerup') setCtxDock(id, nearest(ev.clientX, ev.clientY));
    };
    label.addEventListener('pointermove', move as EventListener);
    label.addEventListener('pointerup', up as EventListener);
    label.addEventListener('pointercancel', up as EventListener);
  };
  const menu = (e: MouseEvent) => {
    const bar = (e.target as HTMLElement).closest<HTMLElement>('[data-toolbar]');
    const id = bar?.dataset.toolbar;
    if (!id || (e.target as HTMLElement).closest('input, select, textarea, .tb-popup')) return;
    e.preventDefault();
    const name = bar.querySelector('.tb-label')?.textContent?.trim() || id;
    showContextMenu(e.clientX, e.clientY, [
      { label: `${name} toolbar (or drag it by its name)`, info: true },
      ...EDGES.map(edge => ({ label: PLACE[edge], checked: ctxDock(id) === edge, action: () => setCtxDock(id, edge) })),
    ] as MenuItem[]);
  };

  const holder = (edge: CtxEdge, extra: JSX.CSSProperties = {}) => {
    const list = at(edge);
    if (!list.length) return null;
    const cls = edge === 'bottom' ? 'bottom-toolbars ctx-bars' : `ctx-bars ctx-${edge}` + (edge === 'left' || edge === 'right' ? ' tb-side' : '');
    return (
      <div class={cls} data-ctx-edge={edge} style={{ ...extra }} onPointerDown={down as unknown as JSX.PointerEventHandler<HTMLDivElement>} onContextMenu={menu}>
        {list.map(([, node]) => node)}
      </div>
    );
  };
  const top = area?.top ?? 0, height = area?.height ?? 0;
  return (
    <>
      <div ref={anchor} hidden />
      {holder('bottom', { left: style.left, right: style.right })}
      {area && holder('top', { left: style.left, right: style.right, top: `${top}px` })}
      {area && holder('left', { left: style.left, top: `${top}px`, height: `${height}px` })}
      {area && holder('right', { right: style.right, top: `${top}px`, height: `${height}px` })}
      {drag && area && (
        <div class="ctx-drop" style={{ left: style.left, right: style.right, top: `${top}px`, height: `${height}px` }} aria-hidden="true">
          {EDGES.map(edge => <div key={edge} class={'ctx-drop-' + edge + (drag.edge === edge ? ' on' : '')} />)}
        </div>
      )}
    </>
  );
}
