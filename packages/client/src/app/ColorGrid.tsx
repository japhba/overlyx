/**
 * The colour picker of Google Docs / Slides: ten greys, ten bright colours and six rows of their
 * tints and shades, the colours picked with "Custom…" kept below (this browser, `ol.customColors`),
 * and "None" where a colour can be taken away (a fill, a highlight). Used by the deck toolbar and
 * the documents' text menu; `onPick` gets a CSS colour (#rrggbb) or null.
 */
import { useState } from 'preact/hooks';

export const GOOGLE_COLORS: string[][] = [
  ['#000000', '#434343', '#666666', '#999999', '#b7b7b7', '#cccccc', '#d9d9d9', '#efefef', '#f3f3f3', '#ffffff'],
  ['#980000', '#ff0000', '#ff9900', '#ffff00', '#00ff00', '#00ffff', '#4a86e8', '#0000ff', '#9900ff', '#ff00ff'],
  ['#e6b8af', '#f4cccc', '#fce5cd', '#fff2cc', '#d9ead3', '#d0e0e3', '#c9daf8', '#cfe2f3', '#d9d2e9', '#ead1dc'],
  ['#dd7e6b', '#ea9999', '#f9cb9c', '#ffe599', '#b6d7a8', '#a2c4c9', '#a4c2f4', '#9fc5e8', '#b4a7d6', '#d5a6bd'],
  ['#cc4125', '#e06666', '#f6b26b', '#ffd966', '#93c47d', '#76a5af', '#6d9eeb', '#6fa8dc', '#8e7cc3', '#c27ba0'],
  ['#a61c00', '#cc0000', '#e69138', '#f1c232', '#6aa84f', '#45818e', '#3c78d8', '#3d85c6', '#674ea7', '#a64d79'],
  ['#85200c', '#990000', '#b45f06', '#bf9000', '#38761d', '#134f5c', '#1155cc', '#0b5394', '#351c75', '#741b47'],
  ['#5b0f00', '#660000', '#783f04', '#7f6000', '#274e13', '#0c343d', '#1c4587', '#073763', '#20124d', '#4c1130'],
];

const CUSTOM_KEY = 'ol.customColors';
function customColors(): string[] {
  try { const v = JSON.parse(localStorage.getItem(CUSTOM_KEY) ?? '[]'); return Array.isArray(v) ? v.filter(c => typeof c === 'string' && /^#[0-9a-f]{6}$/i.test(c)).slice(0, 10) : []; } catch { return []; }
}
function rememberCustom(c: string): void {
  try { localStorage.setItem(CUSTOM_KEY, JSON.stringify([c, ...customColors().filter(x => x.toLowerCase() !== c.toLowerCase())].slice(0, 10))); } catch { /* private window */ }
}

/** #rrggbb of a CSS colour the browser computed (rgb(…) / rgba(…)), for comparing with the grid */
export function toHex(css: string | null | undefined): string | null {
  if (!css) return null;
  if (/^#[0-9a-f]{6}$/i.test(css)) return css.toLowerCase();
  if (/^#[0-9a-f]{3}$/i.test(css)) return '#' + css.slice(1).split('').map(c => c + c).join('').toLowerCase();
  const m = /^rgba?\(\s*(\d+)[,\s]+(\d+)[,\s]+(\d+)(?:[,\s/]+([\d.]+))?/i.exec(css);
  if (!m) return null;
  if (m[4] !== undefined && Number(m[4]) === 0) return null;
  return '#' + [m[1], m[2], m[3]].map(n => Number(n).toString(16).padStart(2, '0')).join('');
}

/**
 * `named`: colours with names (LaTeX's: black, red …) shown in a row of their own, picked by name —
 * the documents' text colour, written as \textcolor{red} rather than a hex code.
 */
export function ColorGrid({ current, onPick, close, none, named }: { current: string | null; onPick: (c: string | null) => void; close: () => void; none?: string; named?: [string, string][] }) {
  const cur = toHex(current) ?? (current && named?.some(([n]) => n === current) ? current : null);
  const [custom, setCustom] = useState(cur ?? '#3c78d8');
  const [mine, setMine] = useState(customColors);
  const pick = (c: string | null) => { close(); onPick(c); };
  const sw = (c: string, key: string) => (
    <button key={key} type="button" class={'cg-swatch' + (cur === c.toLowerCase() ? ' active' : '')} style={{ background: c }} title={c} data-color={c}
      onMouseDown={e => e.preventDefault()} onClick={() => pick(c)} />
  );
  return (
    <div class="cg" data-color-grid data-color-palette>
      {none && <button type="button" class="cg-none" data-color="none" onMouseDown={e => e.preventDefault()} onClick={() => pick(null)}><span class="cg-none-swatch" />{none}</button>}
      {GOOGLE_COLORS.map((row, i) => <div key={i} class={'cg-row' + (i === 1 ? ' gap' : '')}>{row.map(c => sw(c, c))}</div>)}
      {named && <>
        <div class="cg-custom-title">LaTeX colours</div>
        <div class="cg-row cg-wrap">{named.map(([n, css]) => (
          <button key={n} type="button" class={'cg-swatch' + (current === n ? ' active' : '')} style={{ background: css }} title={n} data-color={n} onMouseDown={e => e.preventDefault()} onClick={() => pick(n)} />
        ))}</div>
      </>}
      <div class="cg-custom-title">Custom</div>
      <div class="cg-row">
        <label class="cg-swatch cg-add" title="Custom colour…" data-color="custom">
          <span>+</span>
          <input type="color" value={custom} data-color-custom onInput={e => setCustom((e.target as HTMLInputElement).value)}
            onChange={e => { const v = (e.target as HTMLInputElement).value; rememberCustom(v); setMine(customColors()); pick(v); }} />
        </label>
        {mine.map(c => sw(c, 'c' + c))}
      </div>
    </div>
  );
}
