/**
 * Page setup… (File ▸ Page setup, the Slide menu, the More menu, a right-click on an empty slide —
 * PowerPoint's Slide Size, Google Slides' Page setup): the size of a deck's slides or of a poster
 * changed after it was made. The sizes the New dialogs offer (app/decksize.ts), either way up, or
 * any width × height — px for slides, mm or in for paper and posters. What happens to what is on
 * the pages is the dialog's second question, said in its own words there: scaled with the page
 * (core html/pagesetup.ts, the default) or kept as it is. One undo step.
 */
import { useState } from 'preact/hooks';
import { pageSize, type PageSize, type PageUnit } from '@overlyx/core/html/deliverable.ts';
import { pageSetupFactor, pageSizePx, type PageSetupMode } from '@overlyx/core/html/pagesetup.ts';
import { pageSizes, turned, sizeText, ratioLabel } from '../app/decksize';
import './pagesetup.css';

interface Props {
  kind: 'deck' | 'poster';
  /** the size now (null: the deck sets it in a way Page setup does not know) */
  size: PageSize | null;
  apply(to: PageSize, mode: PageSetupMode): void;
  close(): void;
}

const PER_PX: Record<PageUnit, number> = { px: 1, mm: 25.4 / 96, in: 1 / 96 };
const shown = (n: number, unit: PageUnit) => String(unit === 'px' ? Math.round(n) : unit === 'mm' ? Math.round(n * 10) / 10 : Math.round(n * 100) / 100);
const near = (a: number, b: number) => Math.abs(a - b) <= Math.max(a, b) * 0.002;

export function PageSetup({ kind, size, apply, close }: Props) {
  const start: PageSize = size ?? (kind === 'poster' ? { width: 841, height: 1189, unit: 'mm' } : { width: 1280, height: 720, unit: 'px' });
  const [w, setW] = useState(String(start.width));
  const [h, setH] = useState(String(start.height));
  const [unit, setUnit] = useState<PageUnit>(start.unit);
  const [mode, setMode] = useState<PageSetupMode>('scale');
  const pages = kind === 'deck' ? 'slides' : 'poster';

  if (!size) {
    return <div class="dl-pgs" data-dl-pagesetup>
      <p class="dialog-hint">The size of {kind === 'deck' ? 'these slides' : 'this poster'} is set in a way Page setup cannot change (it looks for one width and height that every page shares). It can be changed in the code: Edit ▸ Edit code.</p>
      <div class="dl-pgs-actions"><button type="button" class="dl-btn" onClick={close}>Close</button></div>
    </div>;
  }

  const wn = Number(w), hn = Number(h);
  let to: PageSize | null = null, problem = '';
  try { to = pageSize({ width: wn, height: hn, unit }); } catch (e) { problem = (e as Error).message.replace(/^size\.(width|height): /, (_m, s: string) => `The ${s} must be `) + '.'; }
  const portrait = hn > wn;
  const sizes = pageSizes(kind);
  const isPreset = (s: PageSize) => { const p = turned(s, portrait), a = pageSizePx(p), b = to ? pageSizePx(to) : null; return !!b && near(a.w, b.w) && near(a.h, b.h); };
  const pick = (s: PageSize) => { const p = turned(s, portrait); setW(String(p.width)); setH(String(p.height)); setUnit(p.unit); };
  const turn = (up: boolean) => { if (up !== portrait && wn !== hn) { setW(h); setH(w); } };
  /** another unit: the same size written in it */
  const changeUnit = (u: PageUnit) => {
    const k = PER_PX[u] / PER_PX[unit];
    if (Number.isFinite(wn) && wn > 0) setW(shown(wn * k, u));
    if (Number.isFinite(hn) && hn > 0) setH(shown(hn * k, u));
    setUnit(u);
  };
  const step = (set: (v: string) => void, v: string) => (e: KeyboardEvent) => {
    if (e.key !== 'ArrowUp' && e.key !== 'ArrowDown') return;
    e.preventDefault();
    const by = (unit === 'in' ? 0.25 : unit === 'mm' ? 1 : 10) * (e.shiftKey ? 10 : 1) * (e.key === 'ArrowUp' ? 1 : -1);
    set(shown(Math.max(0, (Number(v) || 0) + by), unit));
  };

  const f = to ? pageSetupFactor(size, to) : null;
  const unchanged = !!f && near(f.fx, 1) && near(f.fy, 1) && to!.unit === size.unit;
  const pct = f ? Math.round(f.factor * 100) : 100;
  const sizeWord = pct === 100 ? 'stay the size they are' : `become ${pct} % of their size`;
  const scaleHint = !f ? '' : f.sameShape
    ? (pct === 100
      ? `The new page has the shape of the old one and its size: nothing on the ${pages} changes.`
      : `The new page has the shape of the old one, so the ${pages} look as before, only ${pct > 100 ? 'larger' : 'smaller'}: text, pictures, lines and distances ${sizeWord}.`)
    : `Text, pictures and lines ${sizeWord}, so that nothing grows out of its box. Everything keeps its place on the page: text boxes, bars and backgrounds follow the page’s new shape, pictures, drawings and groups keep their own.`;
  const smaller = !!f && (f.fx < 0.999 || f.fy < 0.999);
  const keepHint = `Only the page changes. Text, pictures and shapes keep their size and their distance from the top left corner${smaller ? ' — what no longer fits hangs over the edge and is cut off there' : ''}.`;

  return <div class="dl-pgs" data-dl-pagesetup>
    <p class="dialog-hint">Now: {sizeText(size)}{size.unit === 'px' ? ' px' : ''} ({ratioLabel(size)}). {kind === 'deck' ? 'Every slide of the deck has the same size.' : ''}</p>
    <div class="ol-size-grid" role="radiogroup" aria-label="Page size">
      {sizes.map(s => {
        const p = turned(s, portrait), k = 30 / Math.max(p.width, p.height), on = isPreset(s);
        return <button key={s.id} type="button" role="radio" aria-checked={on} class={'ol-size-card' + (on ? ' active' : '')} data-pgs-size={s.id} title={s.hint} onClick={() => pick(s)}>
          <span class="ol-size-thumb"><span style={{ width: `${p.width * k}px`, height: `${p.height * k}px` }} /></span>
          <strong>{s.label}</strong>
          <small>{s.id === 'device' ? ratioLabel(p) : sizeText(p)}</small>
        </button>;
      })}
    </div>
    <div class="dl-pgs-custom">
      <label>Width <input type="text" inputMode="decimal" value={w} data-pgs-w aria-label="Width" onInput={e => setW((e.target as HTMLInputElement).value.replace(',', '.'))} onKeyDown={step(setW, w)} /></label>
      <span aria-hidden="true">×</span>
      <label>Height <input type="text" inputMode="decimal" value={h} data-pgs-h aria-label="Height" onInput={e => setH((e.target as HTMLInputElement).value.replace(',', '.'))} onKeyDown={step(setH, h)} /></label>
      <select value={unit} data-pgs-unit aria-label="Unit" onChange={e => changeUnit((e.target as HTMLSelectElement).value as PageUnit)}>
        <option value="px">px (screens)</option>
        <option value="mm">mm</option>
        <option value="in">in</option>
      </select>
      <div class="ol-orient" role="radiogroup" aria-label="Orientation">
        {([false, true] as const).map(up => <button key={String(up)} type="button" role="radio" aria-checked={portrait === up} data-pgs-orient={up ? 'portrait' : 'landscape'}
          class={'ol-orient-btn' + (portrait === up ? ' active' : '')} onClick={() => turn(up)}>
          <span style={up ? { width: '9px', height: '12px' } : { width: '12px', height: '9px' }} />{up ? 'Upright' : 'Landscape'}</button>)}
      </div>
    </div>
    {problem && <p class="dialog-hint error">{problem}</p>}
    <fieldset class="dl-pgs-modes">
      <legend>What is on the {pages}</legend>
      <label class="dl-pgs-mode">
        <input type="radio" name="dl-pgs-mode" checked={mode === 'scale'} data-pgs-mode="scale" onChange={() => setMode('scale')} />
        <span><strong>Fit it to the new page</strong><small>{scaleHint}</small></span>
      </label>
      <label class="dl-pgs-mode">
        <input type="radio" name="dl-pgs-mode" checked={mode === 'keep'} data-pgs-mode="keep" onChange={() => setMode('keep')} />
        <span><strong>Leave it as it is</strong><small>{keepHint}</small></span>
      </label>
    </fieldset>
    <p class="dialog-hint">{kind === 'deck' ? 'Applies to every slide, the layouts and what is on every slide. ' : ''}Ctrl+Z brings the old size back.</p>
    <div class="dl-pgs-actions">
      <button type="button" class="dl-btn" onClick={close}>Cancel</button>
      <button type="button" class="dl-btn primary" data-pgs-apply disabled={!to || unchanged} onClick={() => { if (to) { apply(to, mode); close(); } }}>Change the size</button>
    </div>
  </div>;
}
