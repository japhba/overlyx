/**
 * Draw's pen settings, as GoodNotes has them (the pen button clicked again): a fountain pen or a ball
 * pen, the fountain pen's tip sharpness, pressure sensitivity and tip flatness, and the stroke
 * stabilization and rounding of either — with a stroke drawn as they make it (runtime/freehand.ts, as
 * on the slide) — and the way to the pen calibration (PenCalibration.tsx), where the pen's own strokes
 * show them. Kept in this browser with the pen's colours and widths (deckink.ts).
 */
import type { Nib } from './protocol';
import { DEFAULT_NIB } from './deckink';
import { inkRuns, inkPaths, type FreePt } from './runtime/freehand';
import { openPenCalibration } from './PenCalibration';

/** the preview's stroke: a loop and a wave, pressed lightly at either end and harder in the middle */
const SAMPLE: FreePt[] = Array.from({ length: 241 }, (_, i) => {
  const t = i / 240, a = t * Math.PI * 5;
  return [14 + t * 172 + Math.sin(a) * 7, 25 - Math.cos(a) * 11 + Math.sin(t * Math.PI) * 2, 0.06 + 0.42 * Math.sin(t * Math.PI) ** 0.7];
});

type LevelKey = 'sharpness' | 'sensitivity' | 'flatness' | 'stabilization' | 'rounding' | 'usual';
interface Level { key: LevelKey; label: string; title: string; rungs: [number, string][]; fountain: boolean; min?: number; max?: number }

const LEVELS: Level[] = [
  { key: 'sharpness', label: 'Tip sharpness', title: 'Round ends, or ends that taper to a point (the end once the pen lifts)', rungs: [[0, 'round'], [1, 'sharp']], fountain: true },
  { key: 'sensitivity', label: 'Pressure sensitivity', title: 'How much pressing harder widens the line', rungs: [[0, 'even'], [0.25, 'default'], [1, 'strong']], fountain: true },
  { key: 'flatness', label: 'Tip flatness', title: 'A flat nib: down-strokes full, up-strokes hairlines', rungs: [[0, 'round'], [1, 'flat nib']], fountain: true },
  { key: 'stabilization', label: 'Stroke stabilization', title: 'Smooths out a shaky hand', rungs: [[0, 'as drawn'], [1, 'smooth']], fountain: false },
  { key: 'rounding', label: 'Rounding', title: 'How the line joins the points the pen gives. 0 %: straight from one to the next, every corner exactly where you turned (and whole-pixel steps, where the browser rounds positions). 100 %: a curve through them, as before 22 Oct 2026: corners only at sharp turns, the steps smoothed away',
    rungs: [[0, 'exact'], [0.3, 'default'], [1, 'round']], fountain: false },
];
const USUAL: Level = { key: 'usual', label: 'Your usual pressure', title: 'The pressure you write with is drawn at the pen\'s width: lighter thinner, harder wider. Measured from what you draw here until you set it', rungs: [[0.25, 'Pencil']], fountain: true, min: 0.05, max: 0.95 };

/** a rung at `p` % of the slider: its tick exactly there, its name centred on it — at the ends reaching inwards (FontPicker's) */
export const rungStyle = (p: number) => ({ left: `${p}%`, ...(p < 8 ? { transform: 'none', alignItems: 'flex-start' } : p > 92 ? { transform: 'translateX(-100%)', alignItems: 'flex-end' } : {}) });

/** one of the pen's levels: a continuous slider with its rungs below, the knob snapping to a rung within 3 % */
function LevelSlider({ l, value, onChange }: { l: Level; value: number; onChange: (v: number) => void }) {
  const min = l.min ?? 0, max = l.max ?? 1, v = Math.round(value * 100);
  const at = (x: number) => ((x - min) / (max - min)) * 100;
  const snap = (x: number) => { const r = l.rungs.find(([rv]) => Math.abs(rv - x) <= 0.03 * (max - min)); return r ? r[0] : x; };
  return (
    <div class="pen-set-row" data-pen-level={l.key} title={l.title}>
      <span class="pen-set-name">{l.label}<span class="pen-set-val">{v}%</span></span>
      <input type="range" class="ink-pick-range" min={Math.round(min * 100)} max={Math.round(max * 100)} step={1} value={v} aria-label={l.label} aria-valuetext={`${v}%`}
        onInput={e => onChange(snap(Number((e.target as HTMLInputElement).value) / 100))} />
      <div class="ff-rungs pen-set-rungs">
        {l.rungs.map(([rv, name]) => (
          <button key={name} type="button" class={'ff-rung' + (Math.abs(rv - value) < 0.005 ? ' on' : '')} style={rungStyle(at(rv))} title={`${name} (${Math.round(rv * 100)} %)`}
            onMouseDown={e => e.preventDefault()} onClick={() => onChange(rv)}><span>{name}</span></button>
        ))}
      </div>
    </div>
  );
}

/**
 * The pen's kind and levels (here and on the calibration page). `measuredUsual` (the calibration):
 * the usual pressure too, with what was measured as a rung.
 */
export function NibLevels({ nib, onChange, measuredUsual, wide }: { nib: Nib; onChange: (p: Partial<Nib>) => void; measuredUsual?: number | null; wide?: boolean }) {
  const usual = measuredUsual !== undefined && !nib.ball && nib.sensitivity > 0
    ? { ...USUAL, rungs: [...USUAL.rungs, ...(measuredUsual != null && Math.abs(measuredUsual - 0.25) > 0.02 ? [[measuredUsual, 'yours'] as [number, string]] : [])] } : null;
  return (
    <div class={'pen-set-levels' + (wide ? ' wide' : '')}>
      <div class="pen-set-kind" role="radiogroup" aria-label="Pen">
        {([['fountain', 'Fountain pen', false], ['ball', 'Ball pen', true]] as const).map(([k, label, ball]) => (
          <button key={k} type="button" role="radio" aria-checked={nib.ball === ball} class={'pen-set-k' + (nib.ball === ball ? ' active' : '')} data-pen-kind={k}
            title={ball ? 'An even line with a round tip, whatever the pressure' : 'Its width follows the pressure; its tip as set below'}
            onMouseDown={e => e.preventDefault()} onClick={() => onChange({ ball })}>{label}</button>
        ))}
      </div>
      {LEVELS.filter(l => !nib.ball || !l.fountain).map(l => <LevelSlider key={l.key} l={l} value={nib[l.key]} onChange={v => onChange({ [l.key]: v })} />)}
      {usual && <LevelSlider l={usual} value={nib.usual} onChange={v => onChange({ usual: v })} />}
      {nib.ball && <div class="pen-set-note">A ball pen's line is even and round, whatever the pressure.</div>}
    </div>
  );
}

export interface PenHabits { scribble: boolean; fingersDraw: boolean; pencil: boolean; penInks: boolean; snap: boolean }

export function PenSettings({ nib, color, width, habits, onChange, onHabits, onClose }: { nib: Nib; color: string; width: number; habits: PenHabits; onChange: (p: Partial<Nib>) => void; onHabits: (p: Partial<PenHabits>) => void; onClose?: () => void }) {
  const w = Math.max(1.5, Math.min(7, width * 1.1));
  const paths = inkPaths(inkRuns(SAMPLE, { width: w, pressure: true, nib, final: true }));
  const off = (p: Partial<Nib>) => Object.entries(p).every(([k, v]) => nib[k as keyof Nib] === v);
  return (
    <div class="ink-pick pen-set" data-pen-settings>
      <svg class="ink-pick-preview" viewBox="0 0 200 48" width="200" height="48" aria-hidden="true">
        <g fill="none" stroke={color} stroke-linecap="round" stroke-linejoin="round">{paths.map(p => <path key={p.w} stroke-width={p.w} d={p.d} />)}</g>
      </svg>
      <NibLevels nib={nib} onChange={onChange} />
      <button type="button" class="pen-set-calibrate" data-pen-calibrate onMouseDown={e => e.preventDefault()} onClick={() => { onClose?.(); openPenCalibration(); }}
        title="A page to trace a few strokes with your pen while you change these settings, which also measures your pen's pressure">Calibrate with your pen…</button>
      <label class="pen-set-check" title="Scribble tightly back and forth over strokes to erase them: what it would erase fades as you scribble, and goes when the pen lifts (lifted away from it, nothing goes; resting the pen at the end makes a short scribble count). Undo brings the strokes back, with the scribble as ink. A scribble over nothing stays.">
        <input type="checkbox" checked={habits.scribble} data-pen-scribble onChange={e => onHabits({ scribble: (e.target as HTMLInputElement).checked })} /> Scribble to erase
      </label>
      <label class="pen-set-check" title="Draw a line, a circle, a rectangle, a triangle or an arrow and keep the pen still at the end for a moment: it becomes that shape, clean (the highlighter's line straight). Undo brings the stroke back as drawn">
        <input type="checkbox" checked={habits.snap} data-pen-snap onChange={e => onHabits({ snap: (e.target as HTMLInputElement).checked })} /> Draw and hold for shapes
      </label>
      {habits.pencil && (
        <label class="pen-set-check" title="The pen draws as soon as it touches a slide or a document's margin, without Draw turned on; fingers and the mouse select and move. Off: the pen selects too until Draw is on">
          <input type="checkbox" checked={habits.penInks} data-pen-inks onChange={e => onHabits({ penInks: (e.target as HTMLInputElement).checked })} /> Pen draws right away
        </label>
      )}
      {habits.pencil && (
        <label class="pen-set-check" title="Since a Pencil has drawn in this browser, fingers move the slide and the resting hand is ignored">
          <input type="checkbox" checked={habits.fingersDraw} data-pen-fingers onChange={e => onHabits({ fingersDraw: (e.target as HTMLInputElement).checked })} /> Fingers draw too
        </label>
      )}
      <div class="ink-pick-foot">
        {/* (the usual pressure is the hand's, measured: kept) */}
        <button type="button" class="pen-set-reset" data-pen-reset disabled={off({ ...DEFAULT_NIB, usual: nib.usual })} onMouseDown={e => e.preventDefault()} onClick={() => onChange({ ...DEFAULT_NIB, usual: nib.usual })}>Reset</button>
        <span class="ink-pick-hint">for this browser's pen</span>
      </div>
    </div>
  );
}
