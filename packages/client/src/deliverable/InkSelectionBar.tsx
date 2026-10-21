/**
 * The lasso selection's bar on whiteboards and documents' margins (its buttons: lassobar.tsx
 * lassoGroups): just above the selection — clear of its rotation handle —, below it when there is no
 * room above, kept on the screen. `rect` is the selection's box in client px. The slides have their
 * own quick menu (QuickBar.tsx) in the same look.
 */
import { useLayoutEffect, useRef } from 'preact/hooks';
import { Toolbar, type ToolButton } from '../app/Toolbar';

export interface ClientRect { x: number; y: number; w: number; h: number }

/** how far above the selection the bar stays (its rotation handle is there) */
const ABOVE = 34;

export function LassoBar({ groups, rect, id = 'lasso-bar' }: { groups: ToolButton[][]; rect: ClientRect; id?: string }) {
  const ref = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const w = el.offsetWidth, h = el.offsetHeight;
    let y = rect.y - h - ABOVE;
    if (y < 4) y = rect.y + rect.h + 12;
    if (y + h > innerHeight - 4) y = Math.max(4, Math.min(rect.y - h - ABOVE, innerHeight - h - 4));
    const x = Math.max(4, Math.min(rect.x + rect.w / 2 - w / 2, innerWidth - w - 4));
    el.style.left = `${Math.round(x)}px`;
    el.style.top = `${Math.round(y)}px`;
    el.style.visibility = 'visible';
  });
  return (
    <div ref={ref} class="dl-quick lz-bar" data-lasso-bar style={{ visibility: 'hidden' }}
      onMouseDown={e => { if ((e.target as HTMLElement).tagName !== 'INPUT') e.preventDefault(); }}
      onPointerDown={e => e.stopPropagation()}>
      <Toolbar id={id} groups={groups} />
    </div>
  );
}

/** the bar a tap with the lasso on nothing brings when something was copied: Paste there */
export function pasteGroups(paste: () => void): ToolButton[][] {
  return [[{ id: 'lz-paste', title: 'Paste here (Ctrl+V)', icon: 'paste', action: paste }]];
}
