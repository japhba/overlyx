/**
 * Horizontal ruler above the page (Google-Docs style). The text column is centred and its width is
 * the View ▸ Text width setting; the ruler shows that column with centimetre ticks and two margin
 * handles — dragging either one resizes the column symmetrically. Double-click resets the width.
 * In margin mode the ruler shows the split too (app/notespane.tsx): the column is centred in the
 * text part, and over the notes & comments pane sit its sash and the notes' text size.
 */
import { useEffect, useRef, useState } from 'preact/hooks';
import type { SashProps } from './notespane';

const PX_PER_CM = 96 / 2.54;
export const MIN_WIDTH = 400, MAX_WIDTH = 1600, DEFAULT_WIDTH = 720;

/** text size of notes and comments in % of the document text */
export const NOTE_SCALE_MIN = 60, NOTE_SCALE_MAX = 130, NOTE_SCALE_DEFAULT = 90, NOTE_SCALE_STEP = 5;

/** Margin mode's part of the ruler: the notes pane's sash, and − / + for the text size of notes and comments. */
export interface RulerNotes { sash: SashProps; scale: number; onScale(pct: number): void }

export function Ruler({ width, onChange, notes }: { width: number; onChange: (w: number) => void; notes?: RulerNotes }) {
  const bandRef = useRef<HTMLDivElement>(null);
  const [drag, setDrag] = useState<{ side: 'left' | 'right'; width: number } | null>(null);
  const [bandPx, setBandPx] = useState(0);

  // the rendered column width (full width = the available page width)
  useEffect(() => {
    const el = bandRef.current;
    if (!el) return;
    const ro = new ResizeObserver(() => setBandPx(el.getBoundingClientRect().width));
    ro.observe(el);
    setBandPx(el.getBoundingClientRect().width);
    return () => ro.disconnect();
  }, [width, !!notes]);

  const startDrag = (side: 'left' | 'right') => (ev: PointerEvent) => {
    ev.preventDefault();
    const band = bandRef.current;
    if (!band) return;
    const rect = band.getBoundingClientRect();
    const centre = rect.left + rect.width / 2;
    const move = (e: PointerEvent) => {
      const w = Math.round(Math.min(MAX_WIDTH, Math.max(MIN_WIDTH, 2 * Math.abs(e.clientX - centre))));   // centred column: symmetric
      setDrag({ side, width: w });
      onChange(w);
    };
    const up = () => { window.removeEventListener('pointermove', move); window.removeEventListener('pointerup', up); setDrag(null); };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
  };

  const shown = drag?.width ?? (width > 0 ? Math.round(bandPx) : Math.round(bandPx));
  const keyboardWidth = (e: KeyboardEvent) => {
    const value = width || shown;
    const next = e.key === 'ArrowRight' ? value + 20 : e.key === 'ArrowLeft' ? value - 20 : e.key === 'Home' ? MIN_WIDTH : e.key === 'End' ? MAX_WIDTH : null;
    if (next !== null) { e.preventDefault(); onChange(Math.max(MIN_WIDTH, Math.min(MAX_WIDTH, next))); }
  };
  const ticks: { x: number; major: boolean; label?: string }[] = [];
  for (let cm = 0; cm * PX_PER_CM <= bandPx + 1; cm += 0.5) {
    const major = Number.isInteger(cm);
    ticks.push({ x: cm * PX_PER_CM, major, label: major && cm > 0 ? String(cm) : undefined });
  }
  return (
    <div class={'ruler' + (drag ? ' dragging' : '')}>
      <div class="ruler-inner" title="Drag a handle to change the text width; double-click to reset">
        <div class="ruler-band" ref={bandRef} onDblClick={() => onChange(DEFAULT_WIDTH)}>
          {ticks.map(t => <span key={t.x} class={'tick' + (t.major ? ' major' : '')} style={{ left: t.x + 'px' }}>{t.label && <span class="tick-label">{t.label}</span>}</span>)}
          <span class="handle left" role="slider" tabIndex={0} aria-label="Text width, left handle" aria-valuemin={MIN_WIDTH} aria-valuemax={MAX_WIDTH} aria-valuenow={width || shown} onKeyDown={keyboardWidth} onPointerDown={startDrag('left')} title="Left margin — drag or use arrow keys to change the text width" />
          <span class="handle right" role="slider" tabIndex={0} aria-label="Text width, right handle" aria-valuemin={MIN_WIDTH} aria-valuemax={MAX_WIDTH} aria-valuenow={width || shown} onKeyDown={keyboardWidth} onPointerDown={startDrag('right')} title="Right margin — drag or use arrow keys to change the text width" />
          {(drag || width === 0) && <span class="readout">{(shown / PX_PER_CM).toFixed(1)} cm · {shown} px{width === 0 ? ' (full width)' : ''}</span>}
        </div>
      </div>
      {notes && (
        <div class="ruler-notes-pane">
          <div class="notes-sash" data-sash="ruler" {...notes.sash} />
          <span class="ruler-notes" title="Text size of notes and comments (double-click to reset)">
            <button type="button" data-notes="smaller" disabled={notes.scale <= NOTE_SCALE_MIN} onClick={() => notes.onScale(Math.max(NOTE_SCALE_MIN, notes.scale - NOTE_SCALE_STEP))} title="Smaller note text">−</button>
            <span class="label" onDblClick={() => notes.onScale(NOTE_SCALE_DEFAULT)}>Notes {notes.scale} %</span>
            <button type="button" data-notes="bigger" disabled={notes.scale >= NOTE_SCALE_MAX} onClick={() => notes.onScale(Math.min(NOTE_SCALE_MAX, notes.scale + NOTE_SCALE_STEP))} title="Larger note text">+</button>
          </span>
        </div>
      )}
    </div>
  );
}
