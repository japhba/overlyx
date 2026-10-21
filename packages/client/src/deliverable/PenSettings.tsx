/**
 * Draw's pen settings, as GoodNotes has them (the pen button clicked again): a fountain pen or a ball
 * pen, the fountain pen's tip sharpness, pressure sensitivity and tip flatness, and the stroke
 * stabilization of either — with a stroke drawn as they make it (runtime/freehand.ts, as on the slide).
 * Kept in this browser with the pen's colours and widths (deckink.ts).
 */
import type { Nib } from './protocol';
import { DEFAULT_NIB } from './deckink';
import { inkRuns, inkPaths, type FreePt } from './runtime/freehand';

/** the preview's stroke: a loop and a wave, pressed lightly at either end and harder in the middle */
const SAMPLE: FreePt[] = Array.from({ length: 241 }, (_, i) => {
  const t = i / 240, a = t * Math.PI * 5;
  return [14 + t * 172 + Math.sin(a) * 7, 25 - Math.cos(a) * 11 + Math.sin(t * Math.PI) * 2, 0.06 + 0.42 * Math.sin(t * Math.PI) ** 0.7];
});

const LEVELS: { key: 'sharpness' | 'sensitivity' | 'flatness' | 'stabilization'; label: string; low: string; high: string; fountain: boolean }[] = [
  { key: 'sharpness', label: 'Tip sharpness', low: 'round', high: 'sharp', fountain: true },
  { key: 'sensitivity', label: 'Pressure sensitivity', low: 'even', high: 'strong', fountain: true },
  { key: 'flatness', label: 'Tip flatness', low: 'round', high: 'flat nib', fountain: true },
  { key: 'stabilization', label: 'Stroke stabilization', low: 'as drawn', high: 'smooth', fountain: false },
];

export interface PenHabits { scribble: boolean; fingersDraw: boolean; pencil: boolean; penInks: boolean; snap: boolean }

export function PenSettings({ nib, color, width, habits, onChange, onHabits }: { nib: Nib; color: string; width: number; habits: PenHabits; onChange: (p: Partial<Nib>) => void; onHabits: (p: Partial<PenHabits>) => void }) {
  const w = Math.max(1.5, Math.min(7, width * 1.1));
  const paths = inkPaths(inkRuns(SAMPLE, { width: w, pressure: true, nib, final: true }));
  const off = (p: Partial<Nib>) => Object.entries(p).every(([k, v]) => nib[k as keyof Nib] === v);
  return (
    <div class="ink-pick pen-set" data-pen-settings>
      <div class="pen-set-kind" role="radiogroup" aria-label="Pen">
        {([['fountain', 'Fountain pen', false], ['ball', 'Ball pen', true]] as const).map(([k, label, ball]) => (
          <button key={k} type="button" role="radio" aria-checked={nib.ball === ball} class={'pen-set-k' + (nib.ball === ball ? ' active' : '')} data-pen-kind={k}
            title={ball ? 'An even line with a round tip, whatever the pressure' : 'Its width follows the pressure; its tip as set below'}
            onMouseDown={e => e.preventDefault()} onClick={() => onChange({ ball })}>{label}</button>
        ))}
      </div>
      <svg class="ink-pick-preview" viewBox="0 0 200 48" width="200" height="48" aria-hidden="true">
        <g fill="none" stroke={color} stroke-linecap="round" stroke-linejoin="round">{paths.map(p => <path key={p.w} stroke-width={p.w} d={p.d} />)}</g>
      </svg>
      {LEVELS.filter(l => !nib.ball || !l.fountain).map(l => {
        const v = Math.round(nib[l.key] * 100);
        return (
          <label key={l.key} class="pen-set-row" data-pen-level={l.key}>
            <span class="pen-set-name">{l.label}<span class="pen-set-val">{v}%</span></span>
            <input type="range" class="ink-pick-range" min={0} max={100} step={5} value={v} aria-valuetext={`${v}%`}
              onInput={e => onChange({ [l.key]: Number((e.target as HTMLInputElement).value) / 100 })} />
            <span class="pen-set-ends"><span>{l.low}</span><span>{l.high}</span></span>
          </label>
        );
      })}
      {nib.ball && <div class="pen-set-note">A ball pen's line is even and round, whatever the pressure.</div>}
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
        <button type="button" class="pen-set-reset" data-pen-reset disabled={off(DEFAULT_NIB)} onMouseDown={e => e.preventDefault()} onClick={() => onChange(DEFAULT_NIB)}>Reset</button>
        <span class="ink-pick-hint">for this browser's pen</span>
      </div>
    </div>
  );
}
