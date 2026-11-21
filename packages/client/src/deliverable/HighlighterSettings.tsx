/**
 * The highlighter's settings (Draw: the active highlighter clicked again, as the pen and the eraser
 * open theirs): its colour — the highlighter's colours of the Draw row, any other picked from the
 * layout editor's colours (it then takes the place of the one in hand) — and its width on a slider
 * with rungs at the row's three widths; see-through as every highlighter is (core inkpresets.ts
 * HIGHLIGHT_OPACITY). Changes go to the pens kept in this browser (deckink.ts), as the row's do.
 */
import { useState } from 'preact/hooks';
import { HIGHLIGHT_OPACITY } from '@overlyx/core/inkpresets.ts';
import { DECK_INK_WIDTH_CHOICES } from './deckink';
import { ColorGrid } from '../app/ColorGrid';
import { inkColorName } from '../editor/plugins/ink';
import { fmtPt, pxToPt } from './units';
import './hlsettings.css';

interface Props {
  color: string;
  width: number;
  colors: string[];
  widths: number[];
  /** a colour or width taken (`slot`: the preset of the row in hand replaced, as the row's palettes do) */
  onChange(p: { color?: string; width?: number; slotColor?: { idx: number; color: string } }): void;
}

const pd = (e: Event) => e.preventDefault();
const STEPS = 1000;

export function HighlighterSettings({ color, width, colors, widths, onChange }: Props) {
  const [other, setOther] = useState(false);
  const choices = DECK_INK_WIDTH_CHOICES.highlighter, lo = choices[0], hi = choices[choices.length - 1];
  const pos = (w: number) => Math.round((Math.log(w / lo) / Math.log(hi / lo)) * STEPS);
  const val = (p: number) => lo * Math.exp((p / STEPS) * Math.log(hi / lo));
  // near one of the row's widths (3 % of the track): that one
  const snap = (p: number) => { for (const w of widths) if (Math.abs(pos(w) - p) <= STEPS * 0.03) return w; return Math.round(val(p)); };
  const [shown, setShown] = useState(width);
  const at = colors.indexOf(color);
  return (
    <div class="ink-pick pen-set hl-set" data-hl-settings>
      <div class="ink-pick-title">Colour</div>
      <div class="hl-set-colors" role="radiogroup" aria-label="Highlighter colour">
        {colors.map(c => (
          <button key={c} type="button" role="radio" aria-checked={c === color} class={'hl-set-swatch' + (c === color ? ' active' : '')} title={inkColorName(c)} data-hl-color={c}
            onMouseDown={pd} onClick={() => onChange({ color: c })}><span style={{ background: c, opacity: HIGHLIGHT_OPACITY }} /></button>
        ))}
        <button type="button" class={'hl-set-other' + (other ? ' active' : '')} onMouseDown={pd} onClick={() => setOther(o => !o)} data-hl-other
          title="Another colour: it takes the place of the one in hand in the row">Other…</button>
      </div>
      {other && <ColorGrid current={color} close={() => setOther(false)} onPick={v => { if (v) onChange(at >= 0 ? { slotColor: { idx: at, color: v } } : { color: v }); setOther(false); }} />}
      <div class="hl-set-row"><span class="ink-pick-title">Width</span><span class="hl-set-value">{fmtPt(pxToPt(shown))} pt</span></div>
      <div class="hl-set-slider">
        <input type="range" min={0} max={STEPS} value={pos(Math.max(lo, Math.min(hi, shown)))} aria-label="Highlighter width" data-hl-width
          onInput={e => setShown(snap(Number((e.target as HTMLInputElement).value)))}
          onChange={e => { const w = snap(Number((e.target as HTMLInputElement).value)); setShown(w); onChange({ width: w }); }} />
        <span class="hl-set-rungs" aria-hidden="true">
          {widths.map(w => <button type="button" key={w} class={w === shown ? 'active' : ''} style={{ left: `${(pos(w) / STEPS) * 100}%` }} onMouseDown={pd}
            onClick={() => { setShown(w); onChange({ width: w }); }}>{fmtPt(pxToPt(w))}</button>)}
        </span>
      </div>
      <div class="pen-set-note">See-through: what is under it shows. Draw and hold for a straight one.</div>
    </div>
  );
}
