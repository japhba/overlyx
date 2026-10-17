/**
 * The toolbar's font list, as in Google Docs (toolbars.tsx, both shells, markdown too): the
 * button shows the font at the cursor in its own face; the list has the document's own families
 * (serif, sans serif, monospace — LaTeX documents), the fonts used lately and in this document,
 * Google's most popular ones, and a search through all of Google Fonts (server googlefonts.ts: each
 * name drawn in its face from a few glyphs). Below it, for the font at the cursor, its design axes
 * as sliders — continuous for a variable font, with rungs at its named instances (Light, Bold,
 * Condensed, …) that the knob snaps to; a static family's weights as rungs alone — and the
 * OpenType features it has (old-style or tabular figures, small capitals, stylistic sets, …) as
 * switches. Everything applies to the selection at once (core fontface.ts: the `face` mark).
 */
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'preact/hooks';
import type { EditorView } from 'prosemirror-view';
import { parseFace, faceValue, type FontFace, WEIGHT_LABELS } from '@overlyx/core';
import { setFontFace, setFontFamily } from '../editor/commands';
import { loadGoogleFont } from '../fonts/googlefont';
import { pinUnder } from './popup';

interface CatalogFamily { f: string; c: string; a: { t: string; min: number; max: number; d: number }[]; w: number[]; i: boolean; p: number }
interface Catalog { axisNames: Record<string, string>; families: CatalogFamily[] }
interface FontInfo {
  family: string; category: string;
  axes: { tag: string; name: string; min: number; def: number; max: number }[];
  instances: { name: string; coords: Record<string, number> }[];
  weights: number[]; italic: boolean; features: string[];
}

let catalogP: Promise<Catalog> | null = null;
const catalog = () => (catalogP ??= fetch('/api/fonts/catalog', { credentials: 'same-origin' }).then(r => (r.ok ? r.json() : { axisNames: {}, families: [] })).catch(() => ({ axisNames: {}, families: [] })));
const infos = new Map<string, Promise<FontInfo | null>>();
const fontInfo = (family: string) => {
  let p = infos.get(family);
  if (!p) { p = fetch('/api/fonts/info?family=' + encodeURIComponent(family), { credentials: 'same-origin' }).then(r => (r.ok ? r.json() : null)).catch(() => null); infos.set(family, p); }
  return p;
};

/** the family's name in its face (a few glyphs, server /api/fonts/sample), loaded when its row shows */
const samples = new Map<string, 'loading' | 'ok' | 'none'>();
function useSample(family: string, el: HTMLElement | null): string | null {
  const name = 'ol-sample ' + family;
  const [state, setState] = useState(samples.get(family) ?? null);
  useEffect(() => {
    if (!el || samples.get(family) === 'ok' || samples.get(family) === 'none' || typeof FontFace === 'undefined') return;
    const io = new IntersectionObserver(es => {
      if (!es.some(e => e.isIntersecting)) return;
      io.disconnect();
      if (samples.has(family)) return;
      samples.set(family, 'loading');
      new FontFace(name, `url(/api/fonts/sample?family=${encodeURIComponent(family)})`).load()
        .then(f => { document.fonts.add(f); samples.set(family, 'ok'); setState('ok'); })
        .catch(() => { samples.set(family, 'none'); setState('none'); });
    });
    io.observe(el);
    return () => io.disconnect();
  }, [family, el]);
  return state === 'ok' || samples.get(family) === 'ok' ? `'${name}'` : null;
}

const RECENT_KEY = 'ol.recentFonts';
function recentFonts(): string[] { try { return JSON.parse(localStorage.getItem(RECENT_KEY) ?? '[]') as string[]; } catch { return []; } }
function rememberFont(family: string): void {
  try { localStorage.setItem(RECENT_KEY, JSON.stringify([family, ...recentFonts().filter(f => f !== family)].slice(0, 6))); } catch { /* private window */ }
}

/** the font families used in the document */
export function documentFaces(view: EditorView): string[] {
  const out = new Set<string>();
  view.state.doc.descendants(n => { for (const m of n.marks) if (m.type.name === 'face') { const f = parseFace(m.attrs.value); if (f) out.add(f.family); } });
  return [...out];
}

/* ------------------------------------------------------------------ features and rungs */

/** OpenType features people choose (the font's others are its own business) — default-on ones can be switched off */
const FEATURES: Record<string, string> = {
  smcp: 'Small capitals', c2sc: 'Capitals as small capitals', pcap: 'Petite capitals', onum: 'Old-style figures', lnum: 'Lining figures',
  tnum: 'Tabular figures', pnum: 'Proportional figures', zero: 'Slashed zero', frac: 'Fractions', ordn: 'Ordinals', sups: 'Superscript',
  subs: 'Subscript', sinf: 'Scientific inferiors', case: 'Case-sensitive forms', cpsp: 'Capital spacing', titl: 'Titling',
  dlig: 'Discretionary ligatures', hlig: 'Historical ligatures', salt: 'Stylistic alternates', swsh: 'Swashes', hist: 'Historical forms',
  liga: 'Ligatures', calt: 'Contextual alternates', kern: 'Kerning',
};
const DEFAULT_ON = new Set(['liga', 'calt', 'kern', 'clig']);
const featureLabel = (t: string) => FEATURES[t] ?? (/^ss\d\d$/.test(t) ? `Stylistic set ${Number(t.slice(2))}` : /^cv\d\d$/.test(t) ? `Character variant ${Number(t.slice(2))}` : null);

const WIDTHS: [number, string][] = [[50, 'Ultra condensed'], [62.5, 'Extra condensed'], [75, 'Condensed'], [87.5, 'Semi condensed'], [100, 'Normal'], [112.5, 'Semi expanded'], [125, 'Expanded'], [150, 'Extra expanded'], [200, 'Ultra expanded']];
const OPSZ = [8, 10, 12, 14, 18, 24, 36, 48, 72, 96, 144];

/** an axis' rungs: its named instances' values (weights: Thin … Black), else the usual stops of the registered axes, else its ends and default */
function rungsOf(axis: FontInfo['axes'][number], info: FontInfo): { v: number; label: string }[] {
  const inRange = (v: number) => v >= axis.min && v <= axis.max;
  let r: { v: number; label: string }[] = [];
  if (axis.tag === 'wght') {
    const seen = new Set<number>();
    for (const i of info.instances) { const v = i.coords.wght; if (v !== undefined && !seen.has(v)) { seen.add(v); r.push({ v, label: WEIGHT_LABELS[v] ?? i.name.replace(/\s*Italic$/, '') }); } }
    if (!r.length) r = Object.entries(WEIGHT_LABELS).map(([v, label]) => ({ v: Number(v), label })).filter(x => inRange(x.v));
  } else if (axis.tag === 'wdth') r = WIDTHS.filter(([v]) => inRange(v)).map(([v, label]) => ({ v, label }));
  else if (axis.tag === 'opsz') r = OPSZ.filter(inRange).map(v => ({ v, label: v + ' pt' }));
  else r = [...new Set([axis.min, axis.def, axis.max])].map(v => ({ v, label: v === axis.def ? 'Default' : String(v) }));
  return r.sort((a, b) => a.v - b.v);
}

/* ------------------------------------------------------------------ the picker */

export interface FontPickerProps {
  view: EditorView;
  /** the marks at the cursor: the family mark (roman / sans / typewriter) and the face mark's value */
  family: string | null;
  face: string | null;
  /** a markdown document: no LaTeX families */
  markdown: boolean;
  /** Document ▸ Settings ▸ Fonts / the markdown typesetting */
  documentFonts?: () => void;
}

const FAMILY_NAMES: Record<string, string> = { roman: 'Serif', sans: 'Sans serif', typewriter: 'Monospace' };

export function FontPicker({ view, family, face, markdown, documentFonts }: FontPickerProps) {
  const current = parseFace(face);
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLSpanElement>(null);
  const popRef = useRef<HTMLDivElement>(null);
  useEffect(() => { if (current) loadGoogleFont(current.family); }, [current?.family]);
  useEffect(() => {
    if (!open) return;
    const h = (e: MouseEvent) => { if (!ref.current?.contains(e.target as Node)) setOpen(false); };
    const k = (e: KeyboardEvent) => { if (e.key === 'Escape') { setOpen(false); view.focus(); } };
    document.addEventListener('mousedown', h);
    document.addEventListener('keydown', k);
    return () => { document.removeEventListener('mousedown', h); document.removeEventListener('keydown', k); };
  }, [open]);
  useLayoutEffect(() => { if (open && popRef.current && ref.current) pinUnder(popRef.current, ref.current); }, [open]);
  const label = current ? current.family : family ? FAMILY_NAMES[family] ?? family : 'Default';
  return (
    <span ref={ref} class="ff-box" data-fontpicker>
      <button type="button" class="tb-btn ff-button" title="Font (a Google font, its weight and features — or the document's serif, sans serif, monospace)"
        onMouseDown={e => e.preventDefault()} onClick={() => setOpen(o => !o)}>
        <span class="ff-name" style={current ? { fontFamily: `'${current.family}', var(--ui-font)` } : undefined}>{label}</span><span class="ff-caret">▾</span>
      </button>
      {open && (
        <div ref={popRef} class="tb-popup ff-pop" role="dialog" aria-label="Font">
          <FontList family={family} current={current} markdown={markdown} documentFonts={documentFonts} inDocument={documentFaces(view)}
            onPick={name => setFontFace(faceValue({ family: name, axes: {}, features: [] }))(view.state, view.dispatch)}
            onFamily={f => { setFontFamily(f)(view.state, view.dispatch); setOpen(false); view.focus(); }}
            close={() => { setOpen(false); view.focus(); }} />
          {current && <FacePanel key={current.family} face={current} onChange={f => setFontFace(faceValue(f))(view.state, view.dispatch)} />}
        </div>
      )}
    </span>
  );
}

export interface FontListProps {
  /** the LaTeX family at the cursor (roman / sans / typewriter), when the list offers them */
  family: string | null;
  current: FontFace | null;
  markdown: boolean;
  documentFonts?: () => void;
  /** families the document uses already */
  inDocument: string[];
  /** a Google font picked (another family keeps no axes or features: they were the old font's) */
  onPick: (family: string) => void;
  /** the document's own families (null: the default); none given: the list does not offer them */
  onFamily?: (family: string | null) => void;
  close: () => void;
}

/** the font list: the document's families, recent and in-document fonts, Google's popular ones, a search through all */
export function FontList({ family, current, markdown, documentFonts, inDocument: inDoc, onPick, onFamily, close }: FontListProps) {
  const [query, setQuery] = useState('');
  const [cat, setCat] = useState<Catalog | null>(null);
  useEffect(() => { let live = true; void catalog().then(c => { if (live) setCat(c); }); return () => { live = false; }; }, []);
  const recent = useMemo(() => recentFonts(), []);
  const pick = (name: string) => {
    const entry = cat?.families.find(f => f.f === name);
    rememberFont(name);
    loadGoogleFont(name);
    onPick(entry?.f ?? name);
  };
  const q = query.trim().toLowerCase();
  const results = useMemo(() => {
    if (!cat || !q) return [];
    const hits = cat.families.filter(f => f.f.toLowerCase().includes(q) || f.c.toLowerCase() === q);
    return hits.sort((a, b) => Number(!a.f.toLowerCase().startsWith(q)) - Number(!b.f.toLowerCase().startsWith(q)) || a.p - b.p).slice(0, 80);
  }, [cat, q]);
  const byName = (n: string) => cat?.families.find(f => f.f === n) ?? null;
  const row = (name: string, key: string) => <FontRow key={key} name={name} entry={byName(name)} active={current?.family === name} onPick={() => pick(name)} />;
  return (
    <div class="ff-list">
      <input class="ff-search" type="search" placeholder="Search fonts" value={query} autoFocus
        onInput={e => setQuery((e.target as HTMLInputElement).value)}
        onKeyDown={e => { e.stopPropagation(); if (e.key === 'Enter' && results[0]) { pick(results[0].f); } if (e.key === 'Escape') close(); }} />
      <div class="ff-scroll">
        {q ? (
          results.length ? results.map(f => row(f.f, 'q' + f.f)) : <div class="ff-empty">{cat ? 'No Google font of that name' : 'Loading the fonts…'}</div>
        ) : (
          <>
            {onFamily && <div class="tb-popup-title">{markdown ? 'The document’s font' : 'The document’s fonts'}</div>}
            {onFamily && <button type="button" class={'tb-pal-item ff-item' + (!current && !family ? ' active' : '')} onMouseDown={e => e.preventDefault()} onClick={() => onFamily(null)}>Default</button>}
            {onFamily && !markdown && (['roman', 'sans', 'typewriter'] as const).map(f => (
              <button key={f} type="button" class={'tb-pal-item ff-item' + (!current && family === f ? ' active' : '')} style={{ fontFamily: f === 'roman' ? 'var(--editor-font), serif' : f === 'sans' ? 'var(--editor-sans-font, system-ui), sans-serif' : 'var(--editor-mono-font, monospace), monospace' }}
                onMouseDown={e => e.preventDefault()} onClick={() => onFamily(f)}>{FAMILY_NAMES[f]}</button>
            ))}
            {documentFonts && <button type="button" class="tb-pal-item ff-item ff-more" onMouseDown={e => e.preventDefault()} onClick={() => { close(); documentFonts(); }}>{markdown ? 'Typesetting…' : 'Document fonts…'}</button>}
            {inDoc.length > 0 && <><div class="tb-popup-title">In this document</div>{inDoc.map(n => row(n, 'd' + n))}</>}
            {recent.filter(n => !inDoc.includes(n)).length > 0 && <><div class="tb-popup-title">Recent</div>{recent.filter(n => !inDoc.includes(n)).map(n => row(n, 'r' + n))}</>}
            <div class="tb-popup-title">Popular — Google Fonts</div>
            {cat ? cat.families.slice(0, 40).map(f => row(f.f, 'p' + f.f)) : <div class="ff-empty">Loading the fonts…</div>}
          </>
        )}
      </div>
    </div>
  );
}

function FontRow({ name, entry, active, onPick }: { name: string; entry: CatalogFamily | null; active: boolean; onPick: () => void }) {
  const [el, setEl] = useState<HTMLButtonElement | null>(null);
  const sample = useSample(name, el);
  const variable = !!entry?.a.length;
  return (
    <button ref={setEl} type="button" class={'tb-pal-item ff-item' + (active ? ' active' : '')} title={entry ? `${name} — ${entry.c}${variable ? ', variable: ' + entry.a.map(a => a.t).join(', ') : entry.w.length > 1 ? `, ${entry.w.length} weights` : ''}` : name}
      onMouseDown={e => e.preventDefault()} onClick={onPick}>
      <span class="ff-item-name" style={sample ? { fontFamily: `${sample}, var(--ui-font)` } : undefined}>{name}</span>
      {variable ? <span class="ff-tag" title="A variable font: any weight (and its other axes)">◐</span> : entry && entry.w.length > 1 ? <span class="ff-tag">{entry.w.length}</span> : null}
    </button>
  );
}

/* ------------------------------------------------------------------ axes and features of the font at the cursor */

/** a font's axes as sliders with rungs and its OpenType features as switches; `onChange` with the face as it is set now */
export function FacePanel({ face, onChange }: { face: FontFace; onChange: (f: FontFace) => void }) {
  const [info, setInfo] = useState<FontInfo | null | undefined>(undefined);
  const [f, setF] = useState(face);
  useEffect(() => { let live = true; void fontInfo(face.family).then(i => { if (live) setInfo(i); }); return () => { live = false; }; }, [face.family]);
  useEffect(() => { setF(face); }, [faceValue(face)]);
  const raf = useRef(0);
  const apply = (next: FontFace) => {
    setF(next);
    cancelAnimationFrame(raf.current);
    raf.current = requestAnimationFrame(() => onChange(next));
  };
  if (info === undefined) return <div class="ff-panel"><div class="ff-empty">Loading {face.family}…</div></div>;
  if (!info) return null;
  const features = info.features.filter(t => featureLabel(t)).sort((a, b) => Number(/^(ss|cv)\d\d$/.test(a)) - Number(/^(ss|cv)\d\d$/.test(b)) || a.localeCompare(b));
  const on = (t: string) => (DEFAULT_ON.has(t) ? !f.features.includes('-' + t) : f.features.includes('+' + t));
  const toggle = (t: string) => {
    const rest = f.features.filter(x => x.slice(1) !== t);
    const want = !on(t);
    apply({ ...f, features: DEFAULT_ON.has(t) ? (want ? rest : [...rest, '-' + t]) : (want ? [...rest, '+' + t] : rest) });
  };
  const setAxis = (tag: string, v: number | null) => {
    const axes = { ...f.axes };
    if (v === null) delete axes[tag]; else axes[tag] = v;
    apply({ ...f, axes });
  };
  // the registered axes (lower-case tags: weight, width, optical size, slant) first; a font's own
  // parametric ones (upper-case: grade, stroke thickness, x-height …) folded below them
  const slider = (a: FontInfo['axes'][number]) => <AxisSlider key={a.tag} name={a.name} min={a.min} max={a.max} def={a.def} rungs={rungsOf(a, info)} value={f.axes[a.tag] ?? a.def}
    onChange={v => setAxis(a.tag, v === a.def && a.tag !== 'wght' ? null : v === 400 && a.tag === 'wght' ? null : v)} />;
  const order = (a: FontInfo['axes'][number]) => ['wght', 'wdth', 'opsz', 'slnt', 'ital'].indexOf(a.tag) + 1 || 9;
  const main = info.axes.filter(a => a.tag === a.tag.toLowerCase()).sort((a, b) => order(a) - order(b));
  const more = info.axes.filter(a => a.tag !== a.tag.toLowerCase());
  return (
    <div class="ff-panel">
      <div class="tb-popup-title">{face.family}{info.axes.length ? ' — variable' : ''}</div>
      {info.axes.length
        ? main.map(slider)
        : info.weights.length > 1 && <WeightRungs weights={info.weights} value={f.axes.wght ?? 400} onChange={v => setAxis('wght', v === 400 ? null : v)} />}
      {more.length > 0 && (
        <details class="ff-more-axes" open={more.some(a => f.axes[a.tag] !== undefined)}>
          <summary class="ff-sub" title={more.map(a => a.name).join(', ')}>More axes ({more.length})</summary>
          {more.map(slider)}
        </details>
      )}
      {features.length > 0 && (
        <div class="ff-features">
          <div class="ff-sub">OpenType features</div>
          {features.map(t => (
            <label key={t} class="ff-feature" title={t}>
              <input type="checkbox" checked={on(t)} onChange={() => toggle(t)} /> {featureLabel(t)}
            </label>
          ))}
        </div>
      )}
      {(Object.keys(f.axes).length > 0 || f.features.length > 0) && <button type="button" class="ff-reset" onMouseDown={e => e.preventDefault()} onClick={() => apply({ ...f, axes: {}, features: [] })}>Reset to regular</button>}
    </div>
  );
}

/** a rung at `p` % of the slider: its tick exactly there, its name centred on it — at the ends it reaches inwards */
const rungStyle = (p: number) => ({ left: `${p}%`, ...(p < 8 ? { transform: 'none', alignItems: 'flex-start' } : p > 92 ? { transform: 'translateX(-100%)', alignItems: 'flex-end' } : {}) });

/** a continuous axis with its rungs below; the knob snaps to a rung within 1.5 % of the range */
function AxisSlider({ name, min, max, def, rungs, value, onChange }: { name: string; min: number; max: number; def: number; rungs: { v: number; label: string }[]; value: number; onChange: (v: number) => void }) {
  const span = max - min || 1;
  const step = span > 20 ? 1 : 0.1;
  const pct = (v: number) => ((v - min) / span) * 100;
  const snap = (v: number) => { const r = rungs.find(x => Math.abs(x.v - v) <= span * 0.015); return r ? r.v : Math.round(v / step) * step; };
  const at = rungs.find(r => Math.abs(r.v - value) < step / 2);
  // (every rung has its tick; a name only where it does not run into the one before: ~5.5 px a
  // character on a ~270 px track, centred on its tick — at the ends reaching inwards, rungStyle)
  let lastRight = -100;
  const shown = rungs.map(r => {
    const p = pct(r.v), w = (r.label.length * 5.5 + 6) / 270 * 100;
    const [left, right] = p < 8 ? [p, p + w] : p > 92 ? [p - w, p] : [p - w / 2, p + w / 2];
    const show = left >= lastRight;
    if (show) lastRight = right;
    return { ...r, p, show };
  });
  return (
    <div class="ff-axis">
      <div class="ff-axis-head"><span class="ff-sub" title="Double-click: back to the default" onDblClick={() => onChange(def)}>{name}</span><span class="ff-axis-val">{at ? `${at.label} · ` : ''}{Math.round(value * 10) / 10}</span></div>
      <input type="range" class="ff-range" min={min} max={max} step={step} value={value}
        onInput={e => onChange(snap(Number((e.target as HTMLInputElement).value)))} onKeyDown={e => e.stopPropagation()} />
      <div class="ff-rungs">
        {shown.map(r => (
          <button key={r.v} type="button" class={'ff-rung' + (at?.v === r.v ? ' on' : '')} style={rungStyle(r.p)} title={`${r.label} (${r.v})`}
            onMouseDown={e => e.preventDefault()} onClick={() => onChange(r.v)}>{r.show ? <span>{r.label}</span> : null}</button>
        ))}
      </div>
    </div>
  );
}

/** the weights of a family of static faces: a slider that only stops at them */
function WeightRungs({ weights, value, onChange }: { weights: number[]; value: number; onChange: (v: number) => void }) {
  const idx = Math.max(0, weights.findIndex(w => w >= value));
  const pct = (i: number) => (weights.length > 1 ? (i / (weights.length - 1)) * 100 : 0);
  return (
    <div class="ff-axis">
      <div class="ff-axis-head"><span class="ff-sub">Weight</span><span class="ff-axis-val">{WEIGHT_LABELS[weights[idx]] ?? weights[idx]} · {weights[idx]}</span></div>
      <input type="range" class="ff-range" min={0} max={weights.length - 1} step={1} value={idx}
        onInput={e => onChange(weights[Number((e.target as HTMLInputElement).value)])} onKeyDown={e => e.stopPropagation()} />
      <div class="ff-rungs">
        {weights.map((w, i) => (
          <button key={w} type="button" class={'ff-rung' + (i === idx ? ' on' : '')} style={rungStyle(pct(i))} title={`${WEIGHT_LABELS[w] ?? w} (${w})`}
            onMouseDown={e => e.preventDefault()} onClick={() => onChange(w)}><span>{(WEIGHT_LABELS[w] ?? String(w)).replace('Extra ', 'X-')}</span></button>
        ))}
      </div>
    </div>
  );
}
