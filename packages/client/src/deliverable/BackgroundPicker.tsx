/**
 * Slide ▸ Background… (and the poster's, and the theme pane's): a colour, a gradient or a picture
 * for this slide or every slide (background.ts writes the CSS). The gradient editor is the fill
 * palette's too (decktoolbar.tsx): a shape or box filled with a gradient.
 */
import { useEffect, useRef, useState } from 'preact/hooks';
import { ColorGrid, toHex } from '../app/ColorGrid';
import { Seg, Slider } from '../app/TextStyles';
import { bgCss, gradientCss, parseBg, type Bg, type Fit, type Stop } from './background';
import './background.css';

const PRESETS: { shape: 'linear' | 'radial'; angle: number; stops: Stop[] }[] = [
  { shape: 'linear', angle: 135, stops: [{ color: '#1a73e8', at: 0 }, { color: '#9334e6', at: 100 }] },
  { shape: 'linear', angle: 180, stops: [{ color: '#ffffff', at: 0 }, { color: '#dbe5f6', at: 100 }] },
  { shape: 'linear', angle: 90, stops: [{ color: '#0b8043', at: 0 }, { color: '#f6bf26', at: 100 }] },
  { shape: 'linear', angle: 160, stops: [{ color: '#202124', at: 0 }, { color: '#3c4043', at: 100 }] },
  { shape: 'radial', angle: 0, stops: [{ color: '#ffffff', at: 0 }, { color: '#c6dafc', at: 100 }] },
  { shape: 'linear', angle: 45, stops: [{ color: '#ff6d01', at: 0 }, { color: '#e91e63', at: 50 }, { color: '#673ab7', at: 100 }] },
];

const ANGLE_RUNGS = [{ v: 0, label: '↑' }, { v: 45, label: '↗' }, { v: 90, label: '→' }, { v: 135, label: '↘' }, { v: 180, label: '↓' }, { v: 225, label: '↙' }, { v: 270, label: '←' }, { v: 315, label: '↖' }, { v: 360, label: '↑' }];

/** a gradient's type, angle and stops; `onApply` with the CSS image (a shape's fill, a slide's background) */
export function GradientEditor({ initial, onApply, applyLabel = 'Apply' }: { initial?: Bg | null; onApply: (css: string, g: Extract<Bg, { kind: 'gradient' }>) => void; applyLabel?: string }) {
  const start = initial?.kind === 'gradient' ? initial : { kind: 'gradient' as const, ...PRESETS[0] };
  const [shape, setShape] = useState(start.shape);
  const [angle, setAngle] = useState(start.angle);
  const [stops, setStops] = useState<Stop[]>(start.stops.map(s => ({ ...s, color: toHex(s.color) ?? s.color })));
  const css = gradientCss(shape, angle, stops);
  const setStop = (i: number, s: Partial<Stop>) => setStops(stops.map((x, k) => (k === i ? { ...x, ...s } : x)));
  return (
    <div class="bgp-grad" data-bgp-gradient>
      <div class="bgp-preview" style={{ background: css }} />
      <div class="bgp-presets">
        {PRESETS.map((p, i) => (
          <button key={i} type="button" class="bgp-preset" title="Start from this gradient" style={{ background: gradientCss(p.shape, p.angle, p.stops) }}
            onClick={() => { setShape(p.shape); setAngle(p.angle); setStops(p.stops); }} />
        ))}
      </div>
      <div class="bgp-row"><span class="bgp-label">Type</span><Seg value={shape} options={[['linear', 'Linear'], ['radial', 'Radial']]} onChange={v => setShape(v as 'linear' | 'radial')} /></div>
      {shape === 'linear' && <div class="bgp-row bgp-slider"><span class="bgp-label">Direction</span>
        <Slider min={0} max={360} step={1} value={angle} rungs={ANGLE_RUNGS} format={v => `${Math.round(v)}°`} onChange={setAngle} /></div>}
      <div class="bgp-label">Colours</div>
      {stops.map((s, i) => (
        <div key={i} class="bgp-stop" data-bgp-stop={i}>
          <label class="bgp-swatch" style={{ background: s.color }} title="Choose the colour">
            <input type="color" value={toHex(s.color) ?? '#000000'} onInput={e => setStop(i, { color: (e.target as HTMLInputElement).value })} />
          </label>
          <input type="range" min={0} max={100} step={1} value={s.at} title={`At ${Math.round(s.at)} %`}
            onInput={e => setStop(i, { at: Number((e.target as HTMLInputElement).value) })} onKeyDown={e => e.stopPropagation()} />
          <span class="bgp-at">{Math.round(s.at)} %</span>
          <button type="button" class="bgp-x" disabled={stops.length <= 2} title="Remove this colour" onClick={() => setStops(stops.filter((_, k) => k !== i))}>×</button>
        </div>
      ))}
      <div class="bgp-actions">
        <button type="button" class="dl-btn" disabled={stops.length >= 6} onClick={() => {
          const sorted = stops.slice().sort((a, b) => a.at - b.at);
          // (the new colour halfway along the widest gap)
          let gi = 0;
          for (let i = 1; i < sorted.length - 1; i++) if (sorted[i + 1].at - sorted[i].at > sorted[gi + 1].at - sorted[gi].at) gi = i;
          setStops([...sorted.slice(0, gi + 1), { color: sorted[gi].color, at: Math.round((sorted[gi].at + sorted[gi + 1].at) / 2) }, ...sorted.slice(gi + 1)]);
        }}>+ Colour</button>
        <button type="button" class="dl-btn bgp-apply" data-bgp-apply onClick={() => onApply(css, { kind: 'gradient', shape, angle, stops })}>{applyLabel}</button>
      </div>
    </div>
  );
}

export interface BackgroundPickerProps {
  /** the background now (the slide's own `background`, or null) */
  current: string | null;
  /** a deck: "this slide" or "every slide"; a poster: none */
  scopes?: boolean;
  /** start with "every slide" chosen (the theme view) */
  every?: boolean;
  /** the picture files the deck uses already */
  pictures: string[];
  /** a picture chosen from the computer: uploaded next to the deck, its address relative to the page (null: failed) */
  upload: (f: File) => Promise<string | null>;
  /** a picture's file for its thumbnail (null: none shown) */
  thumb?: (rel: string) => Promise<string | null>;
  apply: (css: string | null, every: boolean) => void;
  close: () => void;
}

const DIM_RUNGS = [{ v: 0, label: 'None' }, { v: 0.2, label: '20 %' }, { v: 0.4, label: '40 %' }, { v: 0.6, label: '60 %' }, { v: 0.8, label: '80 %' }];

function Thumb({ rel, thumb }: { rel: string; thumb?: (rel: string) => Promise<string | null> }) {
  const [url, setUrl] = useState<string | null>(null);
  useEffect(() => { let live = true; void thumb?.(rel).then(u => { if (live) setUrl(u); }).catch(() => {}); return () => { live = false; }; }, [rel]);
  return url ? <img src={url} alt="" /> : <span class="bgp-thumb-none">{rel.split('/').pop()}</span>;
}

export function BackgroundPicker({ current, scopes, every: everyAtFirst, pictures, upload, thumb, apply, close }: BackgroundPickerProps) {
  const now = parseBg(current);
  const [tab, setTab] = useState<'color' | 'gradient' | 'picture'>(now.kind === 'gradient' ? 'gradient' : now.kind === 'picture' ? 'picture' : 'color');
  const [every, setEvery] = useState(!!everyAtFirst);
  const pic0 = now.kind === 'picture' ? now : null;
  const [src, setSrc] = useState<string | null>(pic0?.src ?? null);
  const [fit, setFit] = useState<Fit>(pic0?.fit ?? 'fill');
  const [dim, setDim] = useState(pic0?.dim ?? 0);
  const [dimTo, setDimTo] = useState<'white' | 'black'>(pic0?.dimTo ?? 'white');
  const [busy, setBusy] = useState(false);
  const file = useRef<HTMLInputElement>(null);
  const done = (css: string | null) => { close(); apply(css, every); };
  const list = src && !pictures.includes(src) ? [src, ...pictures] : pictures;
  return (
    <div class="bgp" data-bgp onKeyDown={e => e.stopPropagation()}>
      {scopes && <div class="bgp-row bgp-scope"><Seg value={every ? 'every' : 'one'} options={[['one', 'This slide'], ['every', 'Every slide']]} onChange={v => setEvery(v === 'every')} /></div>}
      <div class="bgp-tabs"><Seg value={tab} options={[['color', 'Colour'], ['gradient', 'Gradient'], ['picture', 'Picture']]} onChange={v => setTab(v as typeof tab)} /></div>
      {tab === 'color' && <ColorGrid current={now.kind === 'color' ? now.color : null} close={() => {}} none="As the design has it" onPick={c => done(c)} />}
      {tab === 'gradient' && <GradientEditor initial={now} onApply={css => done(css)} />}
      {tab === 'picture' && <div class="bgp-pic" data-bgp-picture>
        <div class="bgp-pics">
          {list.map(p => (
            <button key={p} type="button" class={'bgp-thumb' + (p === src ? ' on' : '')} title={p} data-bgp-pic={p} onClick={() => setSrc(p)}><Thumb rel={p} thumb={thumb} /></button>
          ))}
          <button type="button" class="bgp-thumb bgp-upload" disabled={busy} data-bgp-upload onClick={() => file.current?.click()}>{busy ? 'Uploading…' : '+ From your computer…'}</button>
          <input ref={file} type="file" accept="image/*" hidden onChange={async e => {
            const f = (e.target as HTMLInputElement).files?.[0];
            (e.target as HTMLInputElement).value = '';
            if (!f) return;
            setBusy(true);
            const rel = await upload(f).catch(() => null);
            setBusy(false);
            if (rel) setSrc(rel);
          }} />
        </div>
        {!list.length && <div class="bgp-note">No pictures in this deck yet: add one from your computer.</div>}
        <div class="bgp-row"><span class="bgp-label">Size</span><Seg value={fit} options={[['fill', 'Fill'], ['fit', 'Fit'], ['tile', 'Tile']]} onChange={v => setFit(v as Fit)} /></div>
        <div class="bgp-row bgp-slider"><span class="bgp-label">Dim</span>
          <Slider min={0} max={0.8} step={0.05} value={dim} rungs={DIM_RUNGS} format={v => (v ? `${Math.round(v * 100)} %` : 'None')} onChange={setDim} /></div>
        <div class="bgp-row"><span class="bgp-label">Towards</span><Seg value={dimTo} options={[['white', 'White'], ['black', 'Black']]} onChange={v => setDimTo(v as 'white' | 'black')} /></div>
        {src && <div class="bgp-preview bgp-preview-pic" style={{ background: thumbBg(bgCss({ kind: 'picture', src, fit, dim, dimTo })!) }} />}
        <div class="bgp-actions">
          <button type="button" class="dl-btn bgp-apply" disabled={!src} data-bgp-apply onClick={() => src && done(bgCss({ kind: 'picture', src, fit, dim, dimTo }))}>Apply</button>
        </div>
      </div>}
      {now.kind !== 'none' && <div class="bgp-actions bgp-reset"><button type="button" class="dl-btn" data-bgp-reset onClick={() => done(null)}>As the design has it</button></div>}
    </div>
  );
}

/** (the preview shows the veil and the fit only: the picture's address is the page's, not the editor's) */
const thumbBg = (css: string) => css.replace(/url\('[^']*'\)/, 'linear-gradient(135deg, #8ab4f8, #34a853)');

/** the fill palette (decktoolbar.tsx): the colours, and below them a gradient for the shape or box */
export function FillPicker({ current, close, fill }: { current: string | null; close: () => void; fill: (css: string | null) => void }) {
  const [grad, setGrad] = useState(false);
  return (
    <div class="bgp-fill" data-bgp-fill>
      {!grad && <ColorGrid current={current} close={close} none="Transparent" onPick={fill} />}
      <button type="button" class="dl-btn bgp-fill-toggle" data-bgp-fill-gradient aria-expanded={grad} onClick={() => setGrad(!grad)}>{grad ? '‹ Colours' : 'Gradient…'}</button>
      {grad && <GradientEditor applyLabel="Fill with it" onApply={css => { close(); fill(css); }} />}
    </div>
  );
}
