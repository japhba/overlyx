/**
 * The grid's settings (View ▸ Grid ▸ Grid spacing…, the canvas's right-click menu): shown, snapped to,
 * and its spacing on a slider with labelled rungs (the owner's preference for continuous values,
 * feedback-sliders-with-rungs) — the usual spacings of the kind (gridview.ts gridChoices: 2 / 5 / 10 /
 * 20 mm on a slide, 10 / 20 / 50 / 100 mm on a poster, inches in the US) as rungs the knob snaps to near
 * them, any spacing between. Logarithmic: small spacings get as much of the track as large ones.
 */
import { gridChoices, gridSize, type GridView } from './gridview';
import { lengthUnit } from './units';
import './gridspacing.css';

type Kind = 'deck' | 'poster' | 'page';

const MM = 96 / 25.4, IN = 96;
/** the slider's ends (slide px) */
function range(kind: Kind, unit: 'mm' | 'in'): [number, number] {
  const poster = kind === 'poster';
  return unit === 'in' ? (poster ? [0.25 * IN, 10 * IN] : [IN / 16, 2 * IN]) : (poster ? [5 * MM, 250 * MM] : [1 * MM, 50 * MM]);
}
const STEPS = 1000;

/** a spacing (slide px) as people read it in the unit */
export function spacingLabel(px: number, unit: 'mm' | 'in'): string {
  if (unit === 'in') { const v = px / IN; return `${Math.round(v * (v < 1 ? 100 : 10)) / (v < 1 ? 100 : 10)} in`; }
  const v = px / MM;
  return `${Math.round(v * (v < 10 ? 10 : 1)) / (v < 10 ? 10 : 1)} mm`;
}

interface Props {
  kind: Kind;
  view: GridView;
  set(p: Partial<GridView>): void;
}

export function GridSpacing({ kind, view, set }: Props) {
  const unit = lengthUnit();
  const [lo, hi] = range(kind, unit);
  const rungs = gridChoices(kind, unit);
  const size = gridSize(view, kind);
  const toPos = (px: number) => Math.round((Math.log(px / lo) / Math.log(hi / lo)) * STEPS);
  const fromPos = (pos: number) => lo * Math.exp((pos / STEPS) * Math.log(hi / lo));
  // near a rung (2.5 % of the track): the rung
  const snap = (pos: number) => { for (const r of rungs) if (Math.abs(toPos(r.px) - pos) <= STEPS * 0.025) return r.px; return fromPos(pos); };
  const pick = (px: number) => set({ size: px, show: true });
  return <div class="dl-gridset" data-dl-grid-spacing>
    <label class="dl-gridset-check"><input type="checkbox" checked={view.show} data-grid-show onChange={e => set({ show: (e.target as HTMLInputElement).checked })} /> Show grid</label>
    <label class="dl-gridset-check"><input type="checkbox" checked={view.snap} data-grid-snap onChange={e => set({ snap: (e.target as HTMLInputElement).checked })} /> Snap to grid</label>
    <div class="dl-gridset-row">
      <span class="dl-gridset-label">Spacing</span>
      <span class="dl-gridset-value" data-grid-value>{spacingLabel(size, unit)}</span>
    </div>
    <div class="dl-gridset-slider">
      <input type="range" min={0} max={STEPS} step={1} value={toPos(size)} aria-label="Grid spacing" aria-valuetext={spacingLabel(size, unit)} data-grid-size
        onInput={e => pick(snap(Number((e.target as HTMLInputElement).value)))} />
      <span class="dl-gridset-rungs" aria-hidden="true">
        {rungs.map(r => <button type="button" key={r.px} class={Math.abs(r.px - size) < 0.01 ? 'on' : ''} style={{ left: `${(toPos(r.px) / STEPS) * 100}%` }} onClick={() => pick(r.px)}>{r.label}</button>)}
      </span>
    </div>
  </div>;
}
