/**
 * Margin mode's split (View ▸ Notes & comments in the margin), sized like VS Code's side-by-side
 * editor groups: the document pane holds the text on the left and the notes & comments pane on
 * the right, with a sash between them (the same divider as between the WYSIWYG / TeX / PDF panes).
 * The notes pane's width is a share of the document pane, so it grows and shrinks with the window,
 * the file tree and the PDF pane. Dragging the sash (on the page or on the ruler) moves the split,
 * the arrow keys step it, a double-click resets it. The text column keeps its own width (the
 * ruler's handles, View ▸ Text width) and is centred in the text part, so the page margin and the
 * split are separate settings.
 *
 * Both shells (App.tsx, the extension's EditorShell.tsx) call useNotesPane on their .editor-scroll
 * and put <NotesSash> into the page. The hook sets --notes-col (px) on the scroll element. The
 * page's padding and tint (styles.css), the ruler (Ruler.tsx) and the cards (plugins/margin.ts)
 * all read it.
 */
import { useLayoutEffect, useState } from 'preact/hooks';
import type { RefObject } from 'preact';

export const NOTES_SHARE_DEFAULT = 0.3, NOTES_SHARE_MIN = 0.15, NOTES_SHARE_MAX = 0.6;
const NOTES_MIN_PX = 200, TEXT_MIN_PX = 360, KEY_STEP = 0.02;
const STORAGE = 'ol.notesShare';

export const clampShare = (s: number) => Math.min(NOTES_SHARE_MAX, Math.max(NOTES_SHARE_MIN, s));

/** The notes pane's width in a document pane `pane` px wide: its share, but at least 200px, and the text part keeps 360px. */
export function notesColumnWidth(pane: number, share: number): number {
  return Math.round(Math.max(NOTES_MIN_PX, Math.min(share * pane, pane - TEXT_MIN_PX)));
}

function storedShare(): number {
  try {
    const raw = localStorage.getItem(STORAGE);
    const v = Number(raw);
    if (raw !== null && Number.isFinite(v)) return clampShare(v);
  } catch { /* storage unavailable */ }
  return NOTES_SHARE_DEFAULT;
}
function saveShare(s: number): void {
  try { localStorage.setItem(STORAGE, String(Math.round(s * 1000) / 1000)); } catch { /* storage unavailable */ }
}

/** What a sash element gets: drag, double-click to reset, arrow keys; a separator for screen readers. */
export interface SashProps {
  role: 'separator';
  tabIndex: number;
  title: string;
  'aria-orientation': 'vertical';
  'aria-label': string;
  'aria-valuemin': number;
  'aria-valuemax': number;
  'aria-valuenow': number;
  onPointerDown(ev: PointerEvent): void;
  onDblClick(ev: MouseEvent): void;
  onKeyDown(ev: KeyboardEvent): void;
}

export function useNotesPane(scrollRef: RefObject<HTMLElement>, on: boolean): { share: number; sash: SashProps } {
  const [share, setShare] = useState(storedShare);
  // before paint (layout effect, ResizeObserver), so the page never shows a frame with the old split
  useLayoutEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    if (!on) { el.style.removeProperty('--notes-col'); return; }
    const apply = () => {
      const px = notesColumnWidth(el.clientWidth, share) + 'px';
      if (el.style.getPropertyValue('--notes-col') !== px) el.style.setProperty('--notes-col', px);
    };
    apply();
    const ro = new ResizeObserver(apply);
    ro.observe(el);
    return () => ro.disconnect();
  }, [on, share]);

  const set = (s: number) => { const v = clampShare(s); setShare(v); saveShare(v); };
  const sash: SashProps = {
    role: 'separator', tabIndex: 0, 'aria-orientation': 'vertical', 'aria-label': 'Width of the notes & comments pane',
    'aria-valuemin': Math.round(NOTES_SHARE_MIN * 100), 'aria-valuemax': Math.round(NOTES_SHARE_MAX * 100), 'aria-valuenow': Math.round(share * 100),
    title: 'Drag to resize the notes & comments pane; double-click to reset',
    onPointerDown: ev => {
      const scroll = scrollRef.current;
      if (!scroll || ev.button !== 0) return;
      ev.preventDefault();
      ev.stopPropagation();
      // relative to where the drag started: the pane may be scrolled sideways (ink mode's gutters)
      const pane = scroll.clientWidth, x0 = ev.clientX;
      const w0 = parseFloat(scroll.style.getPropertyValue('--notes-col')) || notesColumnWidth(pane, share);
      let last = share;
      const root = document.documentElement;
      root.classList.add('pane-resizing', 'notes-resizing');
      const move = (e: PointerEvent) => { last = clampShare((w0 + x0 - e.clientX) / pane); setShare(last); };
      const up = () => {
        window.removeEventListener('pointermove', move);
        window.removeEventListener('pointerup', up);
        window.removeEventListener('pointercancel', up);
        root.classList.remove('pane-resizing', 'notes-resizing');
        saveShare(last);
      };
      window.addEventListener('pointermove', move);
      window.addEventListener('pointerup', up);
      window.addEventListener('pointercancel', up);
    },
    onDblClick: ev => { ev.preventDefault(); ev.stopPropagation(); set(NOTES_SHARE_DEFAULT); },
    onKeyDown: ev => {
      const next = ev.key === 'ArrowLeft' ? share + KEY_STEP : ev.key === 'ArrowRight' ? share - KEY_STEP
        : ev.key === 'Home' ? NOTES_SHARE_MAX : ev.key === 'End' ? NOTES_SHARE_MIN : null;
      if (next === null) return;
      ev.preventDefault();
      ev.stopPropagation();
      set(next);
    },
  };
  return { share, sash };
}

/** The sash on the page, between the text and the notes pane (full height; styles.css places it at --notes-col). */
export function NotesSash({ sash }: { sash: SashProps }) {
  return <div class="notes-sash" data-sash="page" {...sash} />;
}
