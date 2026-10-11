/**
 * Seaborn's colour palettes — tab10 "muted" by default, and its siblings (deep, pastel, bright,
 * dark, colorblind, and matplotlib's tab10 itself) — as one row in every colour picker (ColorGrid,
 * the layout documents' palette, the pens). Right-click the row, or click its title, to switch the
 * variant; the choice is kept in this browser (`ol.seaborn`). Each picker draws the swatches its own
 * way (`swatch`), so a pick goes through that picker's usual path (hex, \textcolor, a pen preset).
 */
import { useState } from 'preact/hooks';
import type { ComponentChildren } from 'preact';

export const SEABORN: Record<string, string[]> = {
  muted: ['#4878d0', '#ee854a', '#6acc64', '#d65f5f', '#956cb4', '#8c613c', '#dc7ec0', '#797979', '#d5bb67', '#82c6e2'],
  deep: ['#4c72b0', '#dd8452', '#55a868', '#c44e52', '#8172b3', '#937860', '#da8bc3', '#8c8c8c', '#ccb974', '#64b5cd'],
  pastel: ['#a1c9f4', '#ffb482', '#8de5a1', '#ff9f9b', '#d0bbff', '#debb9b', '#fab0e4', '#cfcfcf', '#fffea3', '#b9f2f0'],
  bright: ['#023eff', '#ff7c00', '#1ac938', '#e8000b', '#8b2be2', '#9f4800', '#f14cc1', '#a3a3a3', '#ffc400', '#00d7ff'],
  dark: ['#001c7f', '#b1400d', '#12711c', '#8c0800', '#591e71', '#592f0d', '#a23582', '#3c3c3c', '#b8850a', '#006374'],
  colorblind: ['#0173b2', '#de8f05', '#029e73', '#d55e00', '#cc78bc', '#ca9161', '#fbafe4', '#949494', '#ece133', '#56b4e9'],
  tab10: ['#1f77b4', '#ff7f0e', '#2ca02c', '#d62728', '#9467bd', '#8c564b', '#e377c2', '#7f7f7f', '#bcbd22', '#17becf'],
};
export const SEABORN_VARIANTS = Object.keys(SEABORN);

const KEY = 'ol.seaborn';
export function seabornVariant(): string {
  try { const v = localStorage.getItem(KEY); return v && SEABORN[v] ? v : 'muted'; } catch { return 'muted'; }
}
function rememberVariant(v: string): void {
  try { localStorage.setItem(KEY, v); } catch { /* private window */ }
}

/** The palette's row: its title (the variant, ▾), then its ten swatches; right-click or the title lists the variants. */
export function SeabornRow({ swatch, titleClass = 'cg-custom-title', rowClass = 'cg-row' }: { swatch: (color: string) => ComponentChildren; titleClass?: string; rowClass?: string }) {
  const [variant, setVariant] = useState(seabornVariant);
  const [choosing, setChoosing] = useState(false);
  const choose = (v: string) => { setVariant(v); rememberVariant(v); setChoosing(false); };
  const open = (e: MouseEvent) => { e.preventDefault(); e.stopPropagation(); setChoosing(c => !c); };
  return (
    <div class="sb-palette" data-seaborn={variant} onContextMenu={open}>
      <button type="button" class={titleClass + ' sb-title'} title="Seaborn's palettes — right-click the row (or click here) for its other variants"
        onMouseDown={e => e.preventDefault()} onClick={open} data-seaborn-title>
        Seaborn · {variant} <span class="sb-caret">▾</span>
      </button>
      {choosing ? (
        <div class="sb-variants" role="menu" data-seaborn-variants>
          {SEABORN_VARIANTS.map(v => (
            <button key={v} type="button" role="menuitemradio" aria-checked={v === variant} class={'sb-variant' + (v === variant ? ' active' : '')} data-seaborn-variant={v}
              onMouseDown={e => e.preventDefault()} onClick={() => choose(v)}>
              <span class="sb-name">{v}</span>
              <span class="sb-strip">{SEABORN[v].map(c => <i key={c} style={{ background: c }} />)}</span>
            </button>
          ))}
        </div>
      ) : (
        <div class={rowClass}>{SEABORN[variant].map(c => swatch(c))}</div>
      )}
    </div>
  );
}
