/**
 * The quick menu over selected words in a document — the deck's (deliverable/QuickBar.tsx) in the
 * document editor: the text menu's own buttons (toolbars.tsx `quick`: font, size, bold / italic /
 * underline, colour, link, comment) in a small bar right above the selection, below it when there is
 * no room above, kept inside the document pane and following it while it scrolls. It comes up once a
 * selection has settled — the mouse button released, or a moment after the last Shift+arrow — and
 * goes with the selection (a click, typing over it), Escape, or the focus moving elsewhere (into the
 * bar's own lists and fields it may go). Not over a node selection, cells, a formula being edited, a
 * read-only document; Settings ▸ Editor switches it off. Both shells mount it (tests/parity.test.ts).
 */
import { useEffect, useLayoutEffect, useReducer, useRef, useState } from 'preact/hooks';
import { createPortal } from 'preact/compat';
import { TextSelection } from 'prosemirror-state';
import type { EditorView } from 'prosemirror-view';
import { Toolbar, type ToolButton } from './Toolbar';

/** how long a selection made from the keyboard stays put before the bar comes up (ms) */
const SETTLE_MS = 250;

/** the selection the bar is for: a non-empty text selection of an editable view that has the focus, as `from-to` */
function selectionKey(view: EditorView | null): string {
  if (!view || view.isDestroyed || !view.editable) return '';
  const sel = view.state.selection;
  if (!(sel instanceof TextSelection) || sel.empty) return '';
  return `${sel.from}-${sel.to}`;
}

export function SelectionBar({ view, groups }: { view: EditorView | null; groups: ToolButton[][] }) {
  const ref = useRef<HTMLDivElement>(null);
  const [, bump] = useReducer((n: number) => n + 1, 0);
  /** the pointer is down in the editor: a selection is still being made */
  const [choosing, setChoosing] = useState(false);
  const [settled, setSettled] = useState('');
  const [dismissed, setDismissed] = useState('');
  /** when the pointer was last released in the text: a selection made with it settles at once */
  const released = useRef(0);
  const key = selectionKey(view);

  // pointer down in the text: no bar until it is released (then at once)
  useEffect(() => {
    if (!view) return;
    const down = (e: PointerEvent) => { if (e.button === 0) setChoosing(true); };
    const up = () => { released.current = Date.now(); setChoosing(false); };
    view.dom.addEventListener('pointerdown', down);
    window.addEventListener('pointerup', up);
    window.addEventListener('pointercancel', up);
    return () => { view.dom.removeEventListener('pointerdown', down); window.removeEventListener('pointerup', up); window.removeEventListener('pointercancel', up); };
  }, [view]);
  // a selection settles: right after the pointer is released, a moment after the last key
  useEffect(() => {
    if (!key || choosing) return;
    const t = setTimeout(() => setSettled(key), Date.now() - released.current < 500 ? 0 : SETTLE_MS);
    return () => clearTimeout(t);
  }, [key, choosing]);
  // Escape puts it away for this selection; the focus leaving for elsewhere hides it
  useEffect(() => {
    // (Escape while one of the bar's own lists is open — the font list, the colours — closes that, not the bar)
    const esc = (e: KeyboardEvent) => {
      const bar = ref.current;
      if (e.key !== 'Escape' || !key || bar?.contains(e.target as Node) || bar?.querySelector('.tb-popup')) return;
      setDismissed(key);
    };
    window.addEventListener('keydown', esc, true);
    document.addEventListener('focusin', bump);
    document.addEventListener('focusout', bump);
    return () => { window.removeEventListener('keydown', esc, true); document.removeEventListener('focusin', bump); document.removeEventListener('focusout', bump); };
  }, [key]);

  const active = typeof document !== 'undefined' ? document.activeElement : null;
  const focused = !!view && (view.hasFocus() || (!!active && !!ref.current?.contains(active)));
  const shown = !!groups.length && !!key && settled === key && !choosing && dismissed !== key && focused;

  useLayoutEffect(() => {
    if (!shown || !view) return;
    let raf = 0;
    const place = () => {
      const el = ref.current;
      if (el && !view.isDestroyed) {
        const { from, to } = view.state.selection;
        try {
          const a = view.coordsAtPos(from, 1), b = view.coordsAtPos(to, -1);
          const pane = ((view.dom.closest('.editor-scroll') as HTMLElement | null) ?? document.documentElement).getBoundingClientRect();
          const top = Math.min(a.top, b.top), bottom = Math.max(a.bottom, b.bottom);
          const w = el.offsetWidth, h = el.offsetHeight, gap = 8;
          // above the first line of the selection, at its start — below its last line when there is no room above
          let y = top - h - gap;
          if (y < pane.top + 4) y = bottom + gap;
          if (y + h > pane.bottom - 4) y = Math.max(pane.top + 4, top - h - gap);
          const left = Math.max(pane.left + 4, Math.min(a.left - 6, pane.right - w - 4));
          // (left / top, not a transform: a transformed parent would carry the palettes' fixed popups along)
          el.style.left = `${Math.round(left)}px`;
          el.style.top = `${Math.round(y)}px`;
          el.style.visibility = bottom < pane.top || top > pane.bottom ? 'hidden' : 'visible';
        } catch { /* the view is being redrawn */ }
      }
      raf = requestAnimationFrame(place);
    };
    place();
    return () => cancelAnimationFrame(raf);
  }, [shown, view, key]);

  if (!shown || typeof document === 'undefined') return null;
  // (in <body>: the document pane may be transformed or clip what overflows it)
  return createPortal(
    <div ref={ref} class="dl-quick ol-selbar" data-selection-bar style={{ visibility: 'hidden' }}
      onMouseDown={e => { if ((e.target as HTMLElement).tagName !== 'INPUT') e.preventDefault(); }}>
      <Toolbar id="selection-quick" groups={groups} />
    </div>,
    document.body,
  );
}
