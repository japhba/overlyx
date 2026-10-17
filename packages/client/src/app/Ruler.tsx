/**
 * Horizontal ruler above the page (Google-Docs style). The text column is centred and its width is
 * the View ▸ Text width setting; the ruler shows that column with centimetre ticks and two margin
 * handles — dragging either one resizes the column symmetrically, out to the full width of the
 * document pane if wanted; it snaps to the View menu's widths (rungs) and to the full width.
 * Double-click resets the width.
 *
 * Its second, thinner track is the width display formulas and tables alone on their line may take
 * (editor/widecontent.ts): centred on the column like their spill, never narrower than it. Its two
 * handles snap to the text column (no spill) and to the full pane (the default).
 *
 * In margin mode the ruler shows the split too (app/notespane.tsx): the column is centred in the
 * text part, and over the notes & comments pane sit its sash and the notes' text size.
 */
import { useEffect, useRef, useState } from 'preact/hooks';
import type { SashProps } from './notespane';
import { documentViewScale } from '../editor/viewscale';
import { wideWidth, setWideWidth, onWideWidth, paneRoom, WIDE_FULL, WIDE_TEXT } from '../editor/widecontent';

const PX_PER_CM = 96 / 2.54;
export const MIN_WIDTH = 400, MAX_WIDTH = 4000, DEFAULT_WIDTH = 720;
/** the View menu's text widths: the handles snap to them (and to the full width) */
export const TEXT_WIDTH_RUNGS: [string, number][] = [['Narrow', 560], ['Normal', 720], ['Wide', 880], ['Extra wide', 1080]];
/** how close (screen px) a dragged handle has to come to a rung to snap to it */
const SNAP = 10;

/** text size of notes and comments in % of the document text */
export const NOTE_SCALE_MIN = 60, NOTE_SCALE_MAX = 130, NOTE_SCALE_DEFAULT = 90, NOTE_SCALE_STEP = 5;

/** Margin mode's part of the ruler: the notes pane's sash, − / + for the text size of notes and comments, and » to fold the pane away. */
export interface RulerNotes { sash: SashProps; scale: number; onScale(pct: number): void; onFold?(): void }

/**
 * Where the column sits on the ruler and how wide things are, in the ruler's own (layout) px — the
 * document's px: a viewport zoom transforms the ruler with the page (app/documentviewport.ts) —
 * and the zoom, for pointer distances (screen px).
 */
interface Geometry { centre: number; column: number; scale: number; full: number; pane: number }

/** the width setting of the ruler's second track, kept in step with it */
function useWideWidth(): number {
  const [w, setW] = useState(wideWidth());
  useEffect(() => onWideWidth(() => setW(wideWidth())), []);
  return w;
}

export function Ruler({ width, onChange, notes }: { width: number; onChange: (w: number) => void; notes?: RulerNotes }) {
  const rulerRef = useRef<HTMLDivElement>(null);
  const bandRef = useRef<HTMLDivElement>(null);
  const [drag, setDrag] = useState<{ track: 'text' | 'wide'; width: number; rung?: string } | null>(null);
  const [geo, setGeo] = useState<Geometry>({ centre: 0, column: 0, scale: 1, full: 0, pane: 0 });
  const wide = useWideWidth();

  // the rendered column (its width: the available page width when "full") and the room around it
  useEffect(() => {
    const band = bandRef.current, ruler = rulerRef.current;
    if (!band || !ruler) return;
    const measure = () => {
      const inner = band.parentElement as HTMLElement;
      // the widest the column can get: the text part's whole width (12px either side, as the page's padding then)
      const full = Math.max(MIN_WIDTH, notes ? inner.clientWidth : ruler.clientWidth - 24);
      setGeo({ centre: inner.offsetLeft + band.offsetLeft + band.offsetWidth / 2, column: band.offsetWidth, scale: documentViewScale(band) || 1, full, pane: paneRoom(band) });
    };
    const ro = new ResizeObserver(measure);
    ro.observe(band);
    ro.observe(ruler);
    measure();
    return () => ro.disconnect();
  }, [width, !!notes]);

  /** a handle dragged: the width it stands for (doc px), symmetric about the column's centre */
  const startDrag = (track: 'text' | 'wide') => (ev: PointerEvent) => {
    ev.preventDefault();
    const band = bandRef.current;
    if (!band) return;
    const rect = band.getBoundingClientRect();
    const centre = rect.left + rect.width / 2;
    const scale = documentViewScale(band) || 1;
    const move = (e: PointerEvent) => {
      const w = 2 * Math.abs(e.clientX - centre) / scale;
      const near = (v: number) => Math.abs(w - v) * scale <= SNAP;
      if (track === 'text') {
        // out to the edge: the full width (0); else the nearest rung, or the width dragged
        if (w >= geo.full - SNAP / scale || near(geo.full)) { setDrag({ track, width: Math.round(geo.full), rung: 'Full width' }); onChange(0); return; }
        const rung = TEXT_WIDTH_RUNGS.find(([, v]) => near(v));
        const next = Math.round(Math.min(MAX_WIDTH, Math.max(MIN_WIDTH, rung ? rung[1] : w)));
        setDrag({ track, width: next, rung: rung?.[0] });
        onChange(next);
      } else {
        const column = band.offsetWidth;
        if (w <= column || near(column)) { setDrag({ track, width: column, rung: 'Same as the text' }); setWideWidth(WIDE_TEXT); return; }
        if (w >= geo.pane || near(geo.pane)) { setDrag({ track, width: Math.round(geo.pane), rung: 'Full width' }); setWideWidth(WIDE_FULL); return; }
        setDrag({ track, width: Math.round(w) });
        setWideWidth(w);
      }
    };
    const up = () => { window.removeEventListener('pointermove', move); window.removeEventListener('pointerup', up); setDrag(null); };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
  };

  const shown = drag?.track === 'text' ? drag.width : Math.round(geo.column);
  const keyboardWidth = (e: KeyboardEvent) => {
    const value = width || shown;
    const next = e.key === 'ArrowRight' ? value + 20 : e.key === 'ArrowLeft' ? value - 20 : e.key === 'Home' ? MIN_WIDTH : e.key === 'End' ? 0 : null;
    if (next === 0) { e.preventDefault(); onChange(0); }
    else if (next !== null) { e.preventDefault(); onChange(next >= geo.full ? 0 : Math.max(MIN_WIDTH, Math.min(MAX_WIDTH, next))); }
  };
  // the second track: how wide wide content is drawn now (doc px)
  const wideNow = wide === WIDE_TEXT ? geo.column : Math.max(geo.column, wide === WIDE_FULL ? geo.pane : Math.min(geo.pane, wide));
  const wideShown = drag?.track === 'wide' ? drag.width : wideNow;
  const keyboardWide = (e: KeyboardEvent) => {
    const value = wideNow;
    const next = e.key === 'ArrowRight' ? value + 20 : e.key === 'ArrowLeft' ? value - 20 : null;
    if (e.key === 'Home') { e.preventDefault(); setWideWidth(WIDE_TEXT); }
    else if (e.key === 'End') { e.preventDefault(); setWideWidth(WIDE_FULL); }
    else if (next !== null) { e.preventDefault(); setWideWidth(next <= geo.column ? WIDE_TEXT : next >= geo.pane ? WIDE_FULL : next); }
  };
  const ticks: { x: number; major: boolean; label?: string }[] = [];
  for (let cm = 0; cm * PX_PER_CM <= geo.column + 1; cm += 0.5) {
    const major = Number.isInteger(cm);
    ticks.push({ x: cm * PX_PER_CM, major, label: major && cm > 0 ? String(cm) : undefined });
  }
  const px = (w: number) => w;
  const wideLabel = wide === WIDE_TEXT ? 'same as the text' : wide === WIDE_FULL ? 'full width' : `${(wideNow / PX_PER_CM).toFixed(1)} cm`;
  // rungs shown while a handle is dragged: where it snaps
  const rungs = drag?.track === 'text'
    ? [...TEXT_WIDTH_RUNGS.filter(([, v]) => v < geo.full).map(([l, v]) => ({ w: v, label: l })), { w: geo.full, label: 'Full width' }]
    : drag?.track === 'wide' ? [{ w: geo.column, label: 'Text' }, { w: geo.pane, label: 'Full' }] : [];
  return (
    <div ref={rulerRef} class={'ruler' + (drag ? ' dragging' : '')}>
      <div class="ruler-inner" title="Drag a handle to change the text width; double-click to reset">
        <div class="ruler-band" ref={bandRef} onDblClick={() => onChange(DEFAULT_WIDTH)}>
          {ticks.map(t => <span key={t.x} class={'tick' + (t.major ? ' major' : '')} style={{ left: t.x + 'px' }}>{t.label && <span class="tick-label">{t.label}</span>}</span>)}
          <span class="handle left" role="slider" tabIndex={0} aria-label="Text width, left handle" aria-valuemin={MIN_WIDTH} aria-valuemax={Math.round(geo.full)} aria-valuenow={width || shown} onKeyDown={keyboardWidth} onPointerDown={startDrag('text')} title="Left margin — drag or use arrow keys to change the text width (out to the edge: full width)" />
          <span class="handle right" role="slider" tabIndex={0} aria-label="Text width, right handle" aria-valuemin={MIN_WIDTH} aria-valuemax={Math.round(geo.full)} aria-valuenow={width || shown} onKeyDown={keyboardWidth} onPointerDown={startDrag('text')} title="Right margin — drag or use arrow keys to change the text width (out to the edge: full width)" />
          {(drag?.track === 'text' || width === 0) && <span class="readout">{drag?.rung ? drag.rung + ' · ' : ''}{(shown / PX_PER_CM).toFixed(1)} cm · {shown} px{width === 0 && !drag ? ' (full width)' : ''}</span>}
        </div>
      </div>
      {geo.column > 0 && (
        <div class="ruler-wide" data-ruler-wide title={`Formulas and tables: ${wideLabel} — drag an end to change how far they may reach into the margins; double-click: full width`}
          onDblClick={() => setWideWidth(WIDE_FULL)}>
          <span class="wide-band" style={{ left: `${geo.centre - px(wideShown) / 2}px`, width: `${px(wideShown)}px` }} />
          <span class="wide-column" style={{ left: `${geo.centre - px(geo.column) / 2}px`, width: `${px(geo.column)}px` }} />
          {(['left', 'right'] as const).map(side => (
            <span key={side} class={'wide-handle ' + side} role="slider" tabIndex={0} data-wide-handle={side}
              aria-label={`Formula and table width, ${side} end`} aria-valuemin={Math.round(geo.column)} aria-valuemax={Math.round(geo.pane)} aria-valuenow={Math.round(wideNow)}
              style={{ left: `${geo.centre + (side === 'left' ? -1 : 1) * px(wideShown) / 2}px` }}
              onKeyDown={keyboardWide} onPointerDown={startDrag('wide')} title="Formulas and tables reach this far — drag (Home: the text width, End: full width)" />
          ))}
          {drag?.track === 'wide' && <span class="readout wide-readout" style={{ left: `${geo.centre}px` }}>Formulas & tables · {drag.rung ?? `${(drag.width / PX_PER_CM).toFixed(1)} cm · ${drag.width} px`}</span>}
        </div>
      )}
      {rungs.map(r => (['l', 'r'] as const).map(s => (
        <span key={r.label + s} class={'ruler-rung' + (drag?.rung === r.label ? ' on' : '') + (drag?.track === 'wide' ? ' wide' : '')}
          style={{ left: `${geo.centre + (s === 'l' ? -1 : 1) * px(r.w) / 2}px` }} title={r.label} />
      )))}
      {notes && (
        <div class="ruler-notes-pane">
          <div class="notes-sash" data-sash="ruler" {...notes.sash} />
          <span class="ruler-notes" title="Text size of notes and comments (double-click to reset)">
            <button type="button" data-notes="smaller" disabled={notes.scale <= NOTE_SCALE_MIN} onClick={() => notes.onScale(Math.max(NOTE_SCALE_MIN, notes.scale - NOTE_SCALE_STEP))} title="Smaller note text">−</button>
            <span class="label" onDblClick={() => notes.onScale(NOTE_SCALE_DEFAULT)}>Notes {notes.scale} %</span>
            <button type="button" data-notes="bigger" disabled={notes.scale >= NOTE_SCALE_MAX} onClick={() => notes.onScale(Math.min(NOTE_SCALE_MAX, notes.scale + NOTE_SCALE_STEP))} title="Larger note text">+</button>
          </span>
          {notes.onFold && <button type="button" class="ruler-notes-fold" data-notes-fold-ruler onClick={notes.onFold} title="Fold the notes & comments pane away (the Notes tab at the right brings it back)" aria-label="Fold the notes & comments pane">»</button>}
        </div>
      )}
    </div>
  );
}
