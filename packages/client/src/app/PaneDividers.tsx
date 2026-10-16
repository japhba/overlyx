import { useEffect, useRef } from 'preact/hooks';
import { PANE_LABELS, resizeBetween, visiblePanes, type PaneId, type PaneLayout } from './panes';

/** The same draggable dividers in the browser and VS Code. Panes keep their DOM order. */
export function PaneDividers({ layout, onChange, onResizeEnd }: {
  layout: PaneLayout;
  onChange: (next: PaneLayout) => void;
  onResizeEnd?: (next: PaneLayout) => void;
}) {
  const stop = useRef<(() => void) | null>(null);
  useEffect(() => () => stop.current?.(), []);

  const start = (a: PaneId, b: PaneId, e: PointerEvent) => {
    if (e.button !== 0) return;
    const column = (e.currentTarget as HTMLElement).parentElement;
    const left = column?.querySelector<HTMLElement>(`:scope > [data-pane="${a}"]`);
    const right = column?.querySelector<HTMLElement>(`:scope > [data-pane="${b}"]`);
    if (!left || !right) return;
    stop.current?.();
    e.preventDefault();
    const widths: [number, number] = [left.getBoundingClientRect().width, right.getBoundingClientRect().width];
    const x0 = e.clientX;
    let next = layout;
    document.documentElement.classList.add('pane-resizing');
    const move = (ev: PointerEvent) => {
      next = resizeBetween(layout, a, b, widths, ev.clientX - x0);
      onChange(next);
    };
    const end = () => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', end);
      window.removeEventListener('pointercancel', end);
      document.documentElement.classList.remove('pane-resizing');
      stop.current = null;
      onResizeEnd?.(next);
    };
    stop.current = end;
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', end);
    window.addEventListener('pointercancel', end);
  };

  const shown = visiblePanes(layout);
  return <>{shown.slice(0, -1).map((a, i) => <div key={a + '|' + shown[i + 1]} class="pane-grip"
    role="separator" aria-orientation="vertical" aria-label={`Resize ${PANE_LABELS[a]} and ${PANE_LABELS[shown[i + 1]]}`}
    style={{ order: 2 * layout.order.indexOf(a) + 1 }} title="Drag to resize the panes"
    onPointerDown={e => start(a, shown[i + 1], e as unknown as PointerEvent)} />)}</>;
}
