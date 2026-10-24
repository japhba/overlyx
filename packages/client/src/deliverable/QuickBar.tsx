/**
 * The quick menu: the selection's most used operations (decktoolbar.tsx quickGroups) in a small bar
 * right beside it — above the selection, or below it when there is no room above (the toolbar's
 * contextual row, floating over the canvas's top, takes that room too) — following it
 * while the canvas is zoomed or panned (the frame's box is read every frame: the one-slide view
 * moves the frame with a transform, not through Preact). Hidden while something is dragged. Over words
 * selected in a text being retyped, it sits right over those words — above the name tag of their `box`
 * when they are in its first lines.
 */
import { useLayoutEffect, useRef } from 'preact/hooks';
import { Toolbar, type ToolButton } from '../app/Toolbar';
import type { Rect } from './protocol';

export function QuickBar({ groups, rect, box, frame, scrollY }: { groups: ToolButton[][]; rect: Rect; box?: Rect; frame: () => HTMLIFrameElement | null; scrollY: () => number }) {
  const ref = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    let raf = 0;
    const place = () => {
      const el = ref.current, f = frame();
      if (el && f && f.offsetWidth) {
        const r = f.getBoundingClientRect();
        const s = r.width / f.offsetWidth;
        // the canvas area the bar stays in (the frame may be larger than what is shown of it)
        const a = (f.closest('.dl-canvas') ?? f.parentElement ?? f).getBoundingClientRect();
        const x = r.left + rect.x * s, top = r.top + (rect.y - scrollY()) * s, bottom = top + rect.h * s;
        const w = el.offsetWidth, h = el.offsetHeight, gap = 26;   // (clear of the selection's name tag above its corner)
        const left = Math.max(a.left + 4, Math.min(x, a.right - w - 4));
        // (the toolbar's contextual row floating over the canvas's top: the bar stays below it, not on it)
        const row = document.querySelector<HTMLElement>('.dl-toolbar.dl-ctx-row > .dl-ctx');
        const rr = row && row.offsetHeight ? row.getBoundingClientRect() : null;
        const areaTop = rr && rr.bottom > a.top && rr.left < left + w && rr.right > left ? rr.bottom + 2 : a.top;
        let y = top - h - (box ? 10 : gap);
        if (box) { const boxTop = r.top + (box.y - scrollY()) * s; if (y + h > boxTop - gap && y < boxTop) y = boxTop - h - gap; }
        if (y < areaTop + 4) y = bottom + gap;
        if (y + h > a.bottom - 4) y = Math.max(areaTop + 4, Math.min(top - h - gap, a.bottom - h - 4));
        // (left / top, not a transform: a transformed parent would carry the palettes' fixed popups along)
        el.style.left = `${Math.round(left)}px`;
        el.style.top = `${Math.round(y)}px`;
        el.style.visibility = bottom < a.top || top > a.bottom ? 'hidden' : 'visible';
      }
      raf = requestAnimationFrame(place);
    };
    place();
    return () => cancelAnimationFrame(raf);
  }, [rect.x, rect.y, rect.w, rect.h, box?.y]);
  return (
    <div ref={ref} class="dl-quick" data-dl-quick style={{ visibility: 'hidden' }} onMouseDown={e => { if ((e.target as HTMLElement).tagName !== 'INPUT') e.preventDefault(); }}>
      <Toolbar id="deck-quick" groups={groups} />
    </div>
  );
}
