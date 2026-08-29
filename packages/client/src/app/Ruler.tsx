/**
 * Horizontal ruler above the page (Google-Docs style). The text column is centred and its width is
 * the View ▸ Text width setting; the ruler shows that column with centimetre ticks and two margin
 * handles — dragging either one resizes the column symmetrically. Double-click resets the width.
 */
import { useEffect, useRef, useState } from 'preact/hooks';

const PX_PER_CM = 96 / 2.54;
export const MIN_WIDTH = 400, MAX_WIDTH = 1600, DEFAULT_WIDTH = 720;

/** text size of notes and comments in % of the document text */
export const NOTE_SCALE_MIN = 60, NOTE_SCALE_MAX = 130, NOTE_SCALE_DEFAULT = 90, NOTE_SCALE_STEP = 5;

/**
 * `noteScale` / `onNoteScale`: in margin mode the ruler also carries − / + buttons over the note
 * column that make the text of notes and comments smaller / larger.
 */
export function Ruler({ width, onChange, marginMode, noteScale, onNoteScale }: { width: number; onChange: (w: number) => void; marginMode: boolean; noteScale?: number; onNoteScale?: (pct: number) => void }) {
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
  }, [width, marginMode]);

  const startDrag = (side: 'left' | 'right') => (ev: PointerEvent) => {
    ev.preventDefault();
    const band = bandRef.current;
    if (!band) return;
    const rect = band.getBoundingClientRect();
    const centre = marginMode ? null : rect.left + rect.width / 2;
    const move = (e: PointerEvent) => {
      let w: number;
      if (centre !== null) w = 2 * Math.abs(e.clientX - centre);            // centred column: symmetric
      else w = side === 'right' ? e.clientX - rect.left : rect.right - e.clientX;   // margin mode: the column is left-aligned
      w = Math.round(Math.min(MAX_WIDTH, Math.max(MIN_WIDTH, w)));
      setDrag({ side, width: w });
      onChange(w);
    };
    const up = () => { window.removeEventListener('pointermove', move); window.removeEventListener('pointerup', up); setDrag(null); };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
  };

  const shown = drag?.width ?? (width > 0 ? Math.round(bandPx) : Math.round(bandPx));
  const ticks: { x: number; major: boolean; label?: string }[] = [];
  for (let cm = 0; cm * PX_PER_CM <= bandPx + 1; cm += 0.5) {
    const major = Number.isInteger(cm);
    ticks.push({ x: cm * PX_PER_CM, major, label: major && cm > 0 ? String(cm) : undefined });
  }
  return (
    <div class={'ruler' + (drag ? ' dragging' : '')} title="Drag a handle to change the text width; double-click to reset">
      <div class="ruler-inner">
        <div class="ruler-band" ref={bandRef} onDblClick={() => onChange(DEFAULT_WIDTH)}>
          {ticks.map(t => <span key={t.x} class={'tick' + (t.major ? ' major' : '')} style={{ left: t.x + 'px' }}>{t.label && <span class="tick-label">{t.label}</span>}</span>)}
          <span class="handle left" onPointerDown={startDrag('left')} title="Left margin — drag to change the text width" />
          <span class="handle right" onPointerDown={startDrag('right')} title="Right margin — drag to change the text width" />
          {(drag || width === 0) && <span class="readout">{(shown / PX_PER_CM).toFixed(1)} cm · {shown} px{width === 0 ? ' (full width)' : ''}</span>}
          {marginMode && onNoteScale && noteScale !== undefined && (
            <span class="ruler-notes" title="Text size of notes and comments (double-click to reset)">
              <button type="button" data-notes="smaller" disabled={noteScale <= NOTE_SCALE_MIN} onClick={() => onNoteScale(Math.max(NOTE_SCALE_MIN, noteScale - NOTE_SCALE_STEP))} title="Smaller note text">−</button>
              <span class="label" onDblClick={() => onNoteScale(NOTE_SCALE_DEFAULT)}>notes {noteScale} %</span>
              <button type="button" data-notes="bigger" disabled={noteScale >= NOTE_SCALE_MAX} onClick={() => onNoteScale(Math.min(NOTE_SCALE_MAX, noteScale + NOTE_SCALE_STEP))} title="Larger note text">+</button>
            </span>
          )}
        </div>
      </div>
    </div>
  );
}
