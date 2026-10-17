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
 *
 * The pane folds away like a VS Code side panel: the » on its sash (or the sash dragged nearly shut)
 * turns margin mode off and leaves a "Notes" tab at the right edge that brings it back
 * (useNotesFold, <NotesUnfoldTab>; kept in this browser as `ol.notesFolded`).
 */
import { useEffect, useLayoutEffect, useState } from 'preact/hooks';
import { documentViewScale } from '../editor/viewscale';
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

/** `onCollapse`: the sash was dragged (nearly) shut — the pane folds away */
export function useNotesPane(scrollRef: RefObject<HTMLElement>, on: boolean, onCollapse?: () => void): { share: number; sash: SashProps } {
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
      let last = share, want = w0;
      const root = document.documentElement;
      root.classList.add('pane-resizing', 'notes-resizing');
      const scale = documentViewScale(scroll);
      const move = (e: PointerEvent) => { want = w0 + (x0 - e.clientX) / scale; last = clampShare(want / pane); setShare(last); };
      const up = () => {
        window.removeEventListener('pointermove', move);
        window.removeEventListener('pointerup', up);
        window.removeEventListener('pointercancel', up);
        root.classList.remove('pane-resizing', 'notes-resizing');
        // dragged well past its narrowest: folded away (its width stays what it was before)
        if (onCollapse && want < NOTES_MIN_PX / 2) { setShare(share); onCollapse(); return; }
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

/** The sash on the page, between the text and the notes pane (full height; styles.css places it at --notes-col), with the pane's fold button at the top. */
export function NotesSash({ sash, onFold }: { sash: SashProps; onFold?: () => void }) {
  const stop = (e: Event) => e.stopPropagation();
  return (
    <div class="notes-sash" data-sash="page" {...sash}>
      {onFold && <button type="button" class="notes-fold" data-notes-fold title="Fold the notes & comments pane away (the Notes tab at the right brings it back)" aria-label="Fold the notes & comments pane"
        onPointerDown={stop} onDblClick={stop} onKeyDown={stop} onClick={e => { e.stopPropagation(); onFold(); }}>»</button>}
    </div>
  );
}

const FOLD_KEY = 'ol.notesFolded';
/**
 * Folding the notes pane away: margin mode goes off (comments open as pop-ups, notes sit in the
 * text) and a tab at the pane's right edge brings it back. Turned on or off from the View menu, it
 * is not folded any more. `toggleMargin`: the shell's margin-mode switch.
 */
export function useNotesFold(marginMode: boolean, toggleMargin: () => void): { folded: boolean; fold(): void; unfold(): void } {
  const [folded, setFolded] = useState(() => { try { return localStorage.getItem(FOLD_KEY) === '1'; } catch { return false; } });
  const save = (v: boolean) => { setFolded(v); try { localStorage.setItem(FOLD_KEY, v ? '1' : '0'); } catch { /* storage unavailable */ } };
  useEffect(() => { if (marginMode && folded) save(false); }, [marginMode]);
  return {
    folded: folded && !marginMode,
    fold: () => { if (!marginMode) return; save(true); toggleMargin(); },
    unfold: () => { save(false); if (!marginMode) toggleMargin(); },
  };
}

/** The folded notes pane: a tab at the document pane's right edge (sticky under the ruler) that unfolds it. */
export function NotesUnfoldTab({ onUnfold }: { onUnfold: () => void }) {
  return (
    <div class="notes-unfold">
      <button type="button" data-notes-unfold title="Show the notes & comments pane again" onClick={onUnfold}>Notes</button>
    </div>
  );
}
