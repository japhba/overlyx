/**
 * Format ▸ Text styles (and ✎ beside a style in the paragraph style list): how each kind of text
 * looks — Title, Heading 1–4, Normal text, Quote — set as in Google Docs or Word, the document
 * changing as you go. A floating panel, not a dialog: the page stays in view. For the kind chosen:
 * font (the toolbar's font list; a variable font's axes and its OpenType features), size (a slider
 * with rungs at LaTeX's sizes), bold / italic / small capitals / capitals, colour, alignment, the
 * space above and below (sliders with rungs), and for headings whether they run into their
 * paragraph and a rule. "Match the text at the cursor" takes the font, size, weight, italics and
 * colour of the text where the cursor is, as Google Docs' "Update to match" does.
 *
 * Where it goes (core textstyles.ts): a markdown document's front matter — `headings:` for the
 * levels, `styles:` for the title, the body's colour and quotes, and for the body's font, size,
 * line spacing and alignment pandoc's own keys (mainfont, fontsize, linestretch, justify); a style
 * edited here takes over from LaTeX in its header-includes that set the same thing (takeOverIncludes).
 * A .tex document's settings: `overlyx_styles` (the managed block writes the LaTeX), the body's size,
 * line spacing and alignment its paperfontsize / spacing / justification (Document ▸ Settings's).
 */
import { useEffect, useMemo, useRef, useState } from 'preact/hooks';
import type { EditorView } from 'prosemirror-view';
import {
  TEXT_TYPES, HEADING_LEVELS, NAMED_SIZES, SIZE_EM, stylesOfHeader, stylesJson, takeOverIncludes, textStyleOf, parseFace, faceValue,
  type TextStyle, type TextStyles, type TextType, type HeadingLevel, type FontFace,
} from '@overlyx/core';
import { headingStyles } from '@overlyx/core/md/typesetting.ts';
import { api } from '../api';
import { FontList, FacePanel, documentFaces } from './FontPicker';
import { cursorMarks } from './toolbars';
import { justified, stylesCss } from '../editor/paragraphsep';
import { loadGoogleFont } from '../fonts/googlefont';
import { pinUnder } from './popup';


const NAMES: Record<TextType, string> = { title: 'Title', section: 'Heading 1', subsection: 'Heading 2', subsubsection: 'Heading 3', paragraph: 'Heading 4', body: 'Normal text', quote: 'Quote' };
/** the paragraph style a kind of text is (the style list's names) */
export const TYPE_OF_LAYOUT: Record<string, TextType> = {
  Title: 'title', Section: 'section', 'Section*': 'section', Subsection: 'subsection', 'Subsection*': 'subsection', Subsubsection: 'subsubsection',
  'Subsubsection*': 'subsubsection', Paragraph: 'paragraph', 'Paragraph*': 'paragraph', Standard: 'body', Quote: 'quote', Quotation: 'quote',
};
/** what LaTeX (article) gives each kind when nothing is set — the panel's starting points */
const DEFAULTS: Record<TextType, { size: string; weight: 'bold' | 'normal'; align: TextStyle['align']; above: number; below: number }> = {
  title: { size: 'huge', weight: 'normal', align: 'center', above: 0, below: 12 },
  section: { size: 'larger', weight: 'bold', align: 'left', above: 15, below: 10 },
  subsection: { size: 'large', weight: 'bold', align: 'left', above: 14, below: 6 },
  subsubsection: { size: 'normal', weight: 'bold', align: 'left', above: 14, below: 6 },
  paragraph: { size: 'normal', weight: 'bold', align: 'left', above: 14, below: 0 },
  body: { size: 'normal', weight: 'normal', align: 'justify', above: 0, below: 0 },
  quote: { size: 'normal', weight: 'normal', align: 'justify', above: 6, below: 6 },
};
const SIZE_NAMES: Record<string, string> = { small: 'Small', normal: 'Normal', large: 'Large', larger: 'Larger', huge: 'Huge' };
const COLORS = ['#000000', '#444444', '#1f4e79', '#2a62d6', '#0b7a75', '#2e7d32', '#b8860b', '#c0392b', '#8e44ad'];
const SPACE_RUNGS = [0, 3, 6, 9, 12, 18, 24, 36];

/** a style as the front matter writes it (`space-above`) */
function fmStyle(st: TextStyle): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(st)) if (v !== undefined) out[k === 'spaceAbove' ? 'space-above' : k === 'spaceBelow' ? 'space-below' : k] = String(v);
  return out;
}
/** a length as points (for the sliders; ex ≈ 0.43 em) */
function lengthPt(len: string | undefined, base: number): number | null {
  if (!len) return null;
  const m = /^(\d+(?:\.\d+)?)(ex|em|pt|mm|cm)$/.exec(len);
  if (!m) return null;
  const n = Number(m[1]);
  return Math.round(({ pt: 1, em: base, ex: base * 0.43, mm: 2.845, cm: 28.45 }[m[2]] ?? 1) * n * 10) / 10;
}
/** a size as points at the base size */
const sizePt = (size: string, base: number) => (SIZE_EM[size] ? Math.round(SIZE_EM[size] * base * 100) / 100 : parseFloat(size));

export interface TextStylesPanelProps {
  docId: string;
  headerLines: readonly string[];
  view: EditorView | null;
  markdown: boolean;
  /** the kind shown first (a paragraph style's name, e.g. "Section"), else the cursor's */
  layout?: string;
  onClose: () => void;
  /** after a change was saved (a shell without live settings reads the header again: VS Code) */
  onSaved?: () => void;
}

export function TextStylesPanel({ docId, headerLines, view, markdown, layout, onClose, onSaved }: TextStylesPanelProps) {
  const cursorLayout = view ? (view.state.selection.$from.parent.attrs.layout as string | undefined) : undefined;
  const [type, setType] = useState<TextType>(TYPE_OF_LAYOUT[layout ?? cursorLayout ?? ''] ?? 'section');
  /** the styles as edited here (the document's header catches up a moment later) */
  const [styles, setStyles] = useState<TextStyles>(() => stylesOfHeader(headerLines));
  const [fm, setFm] = useState<Record<string, unknown> | null>(null);
  const edited = useRef(false);
  useEffect(() => { if (!edited.current) setStyles(stylesOfHeader(headerLines)); }, [headerLines]);
  useEffect(() => { if (markdown) void api.mdFrontMatter(docId).then(r => setFm(r.vars as Record<string, unknown>)).catch(() => setFm({})); }, [docId, markdown]);
  const base = useMemo(() => {
    const v = headerLines.find(l => l.startsWith('\\paperfontsize '))?.slice(15).trim();
    return Number(v) > 0 ? Number(v) : 10;
  }, [headerLines]);
  const st: TextStyle = styles[type] ?? {};
  useEffect(() => {
    const k = (e: KeyboardEvent) => { if (e.key === 'Escape' && !(e.target as HTMLElement | null)?.closest?.('.ff-pop')) { e.preventDefault(); onClose(); } };
    document.addEventListener('keydown', k);
    return () => document.removeEventListener('keydown', k);
  }, [onClose]);

  // the change: drawn at once (the page's style element), saved a moment later
  const timer = useRef<ReturnType<typeof setTimeout>>();
  const pendingBody = useRef<Record<string, unknown>>({});
  const save = (next: TextStyles, t: TextType, body: Record<string, unknown> = {}) => {
    edited.current = true;
    setStyles(next);
    const el = document.getElementById('ol-heading-styles') as HTMLStyleElement | null;
    const css = stylesCss(next);
    if (el) el.textContent = css;
    else if (css) { const s = document.createElement('style'); s.id = 'ol-heading-styles'; s.textContent = css; document.head.appendChild(s); }
    Object.assign(pendingBody.current, body);
    clearTimeout(timer.current);
    timer.current = setTimeout(() => { void persist(next, t, pendingBody.current); pendingBody.current = {}; }, 300);
  };
  const touched = useRef(new Set<TextType>());
  const persist = async (next: TextStyles, t: TextType, body: Record<string, unknown>) => {
    touched.current.add(t);
    try {
      if (markdown) {
        // the levels and the other kinds this document's front matter sets, with the ones edited here
        const own = headingStyles((fm?.headings ?? undefined) as never);
        const headings: Record<string, Record<string, string>> = {};
        for (const l of HEADING_LEVELS) {
          const s = touched.current.has(l) ? next[l] : own?.[l];
          if (s && Object.keys(s).length) headings[l] = fmStyle(s);
        }
        const ownStyles = (fm?.styles && typeof fm.styles === 'object' ? fm.styles : {}) as Record<string, unknown>;
        const others: Record<string, Record<string, string>> = {};
        for (const k of ['title', 'body', 'quote'] as const) {
          const s = touched.current.has(k) ? next[k] : textStyleOf(ownStyles[k]);
          // (the body's font, size and alignment are pandoc's keys)
          const kept = k === 'body' && s ? { ...(s.color ? { color: s.color } : {}) } : s;
          if (kept && Object.keys(kept).length) others[k] = fmStyle(kept);
        }
        const includes = Array.isArray(fm?.['header-includes']) ? (fm!['header-includes'] as string[]) : [];
        const taken = takeOverIncludes(includes, [...touched.current]);
        const set: Record<string, unknown> = {
          headings: Object.keys(headings).length ? headings : null,
          styles: Object.keys(others).length ? others : null,
          ...(taken.length !== includes.length ? { 'header-includes': taken.length ? taken : null } : {}),
          ...body,
        };
        const r = await api.setMdFrontMatter(docId, set);
        setFm(r.vars as Record<string, unknown>);
      } else {
        const set: Record<string, string> = { overlyx_styles: stylesJson(next) };
        for (const [k, v] of Object.entries(body)) set[k] = String(v);
        await api.setHeader(docId, { set });
      }
      onSaved?.();
    } catch { /* the next change tries again */ }
  };

  const change = (patch: Partial<TextStyle>) => {
    const s: TextStyle = { ...st, ...patch };
    for (const k of Object.keys(s) as (keyof TextStyle)[]) if (s[k] === undefined) delete s[k];
    save({ ...styles, [type]: s }, type);
  };

  // the body: font / size / spacing / alignment are the document's own settings
  const mdVars = fm ?? {};
  const bodyAlign: 'justify' | 'left' = justified(headerLines) ? 'justify' : 'left';
  const [bodyJustify, setBodyJustify] = useState(bodyAlign === 'justify');
  useEffect(() => setBodyJustify(bodyAlign === 'justify'), [bodyAlign]);
  const bodySize = markdown ? (parseInt(String(mdVars.fontsize ?? ''), 10) || base) : base;
  const spacing = (() => {
    if (markdown) return Number(mdVars.linestretch) || 1;
    const v = headerLines.find(l => l.startsWith('\\spacing '))?.slice(9).trim() ?? 'single';
    return v === 'onehalf' ? 1.5 : v === 'double' ? 2 : v.startsWith('other ') ? Number(v.slice(6)) || 1 : 1;
  })();
  const setBody = (body: Record<string, unknown>) => save(styles, 'body', body);

  // the text at the cursor: its font, size, weight, shape, colour become the style (Google Docs' "Update to match")
  const match = () => {
    if (!view) return;
    const marks = cursorMarks(view);
    const value = (n: string) => marks.find(m => m.type.name === n)?.attrs.value as string | undefined;
    const patch: Partial<TextStyle> = {};
    const face = value('face');
    if (face) patch.font = face;
    const size = value('size');
    const LYX_SIZE: Record<string, string> = { small: 'small', normal: 'normal', large: 'large', larger: 'larger', largest: 'huge' };
    if (size) patch.size = LYX_SIZE[size] ?? (/^\d/.test(size) ? `${parseFloat(size)}pt` : undefined);
    if (value('series') === 'bold') patch.weight = 'bold';
    if (value('shape') === 'italic' || value('emph') === 'on') patch.shape = 'italic';
    if (value('noun') === 'on' || value('shape') === 'smallcaps') patch.case = 'smallcaps';
    const color = value('color');
    if (color?.startsWith('#')) patch.color = color.toLowerCase();
    change(patch);
  };

  const heading = (HEADING_LEVELS as readonly string[]).includes(type);
  const def = DEFAULTS[type];
  const runIn = heading && (st.display ?? (type === 'paragraph' ? 'run-in' : 'block')) === 'run-in';
  const face = st.font ? (st.font.includes('|') ? parseFace(st.font) : parseFace(st.font.replace(/[^A-Za-z0-9 ]/g, ''))) : null;

  return (
    <div class="ts-panel" role="dialog" aria-label="Text styles" data-text-styles>
      <div class="ts-head"><b>Text styles</b><button type="button" class="ts-close" title="Close (Esc)" onClick={onClose}>✕</button></div>
      <div class="ts-types" role="tablist">
        {TEXT_TYPES.map(t => {
          const s = styles[t] ?? {};
          const d = DEFAULTS[t];
          const f = s.font ? (s.font.includes('|') ? parseFace(s.font) : null) : null;
          if (f) loadGoogleFont(f.family);
          return (
            <button key={t} type="button" role="tab" aria-selected={t === type} class={'ts-type' + (t === type ? ' on' : '')} data-ts-type={t} onClick={() => setType(t)}
              style={{
                fontFamily: s.font ? `'${f ? f.family : s.font}', var(--editor-font)` : 'var(--editor-font)',
                fontWeight: (s.weight ?? d.weight) === 'bold' ? 700 : f?.axes.wght ?? 400,
                fontStyle: s.shape === 'italic' ? 'italic' : 'normal', color: s.color ?? (t === 'body' ? undefined : undefined),
                fontVariant: s.case === 'smallcaps' ? 'small-caps' : undefined, textTransform: s.case === 'uppercase' ? 'uppercase' : undefined,
                fontSize: `${Math.min(1.35, Math.max(0.85, sizePt(s.size ?? d.size, 10) / 10))}em`,
              }}>{NAMES[t]}</button>
          );
        })}
      </div>
      <div class="ts-body">
        {type === 'body' && !markdown
          ? <Row label="Font"><span class="ts-note">Document ▸ Settings ▸ Fonts</span></Row>
          : (
            <Row label="Font">
              <FontButton style={type === 'body' ? { font: typeof mdVars.mainfont === 'string' && mdVars.mainfont ? mdVars.mainfont : undefined } : st} face={type === 'body' ? (typeof mdVars.mainfont === 'string' ? parseFace(mdVars.mainfont.replace(/[^A-Za-z0-9 ]/g, '')) : null) : face}
                markdown={markdown} view={view} axes={type !== 'body'}
                onFont={font => (type === 'body' ? setBody({ mainfont: font ? font.split('|')[0] : null }) : change({ font: font ?? undefined }))} />
            </Row>
          )}
        {type === 'body' ? (
          <>
            <Row label="Size"><Rungs value={bodySize} rungs={[10, 11, 12].map(v => ({ v, label: v + ' pt' }))} onChange={v => setBody(markdown ? { fontsize: `${v}pt` } : { paperfontsize: String(v) })} /></Row>
            <Row label="Line spacing"><Slider min={1} max={2.5} step={0.05} value={spacing} rungs={[{ v: 1, label: 'Single' }, { v: 1.15, label: '1.15' }, { v: 1.5, label: '1.5' }, { v: 2, label: 'Double' }]}
              format={v => `${Math.round(v * 100) / 100}×`} onChange={v => setBody(markdown ? { linestretch: v === 1 ? null : v } : { spacing: v === 1 ? 'single' : v === 1.5 ? 'onehalf' : v === 2 ? 'double' : `other ${v}` })} /></Row>
            <Row label="Alignment">
              <Seg value={bodyJustify ? 'justify' : 'left'} options={[['left', 'Left (ragged right)'], ['justify', 'Justified']]}
                onChange={v => { setBodyJustify(v === 'justify'); document.documentElement.toggleAttribute('data-justify', v === 'justify'); setBody(markdown ? { justify: v === 'justify' ? true : null } : { justification: v === 'justify' ? 'true' : 'false' }); }} />
            </Row>
            <Row label="Colour"><Colors value={st.color} onChange={c => change({ color: c })} /></Row>
          </>
        ) : (
          <>
            <Row label="Size">
              <Slider min={Math.round(base * 0.7)} max={Math.round(base * (type === 'title' ? 3 : 2.4))} step={0.5} value={sizePt(st.size ?? def.size, base)}
                rungs={NAMED_SIZES.map(n => ({ v: sizePt(n, base), label: String(Math.round(sizePt(n, base))) }))}
                format={v => { const n = NAMED_SIZES.find(x => Math.abs(sizePt(x, base) - v) < 0.05); return `${n ? SIZE_NAMES[n] + ' · ' : ''}${Math.round(v * 10) / 10} pt`; }}
                onChange={v => { const named = NAMED_SIZES.find(n => Math.abs(sizePt(n, base) - v) < 0.05); change({ size: named ?? `${Math.round(v * 2) / 2}pt` }); }} />
            </Row>
            <Row label="Style">
              <span class="ts-toggles">
                <button type="button" class={'ts-tog' + ((st.weight ?? def.weight) === 'bold' ? ' on' : '')} title="Bold" onClick={() => change({ weight: (st.weight ?? def.weight) === 'bold' ? 'normal' : 'bold' })}><b>B</b></button>
                <button type="button" class={'ts-tog' + (st.shape === 'italic' ? ' on' : '')} title="Italic" onClick={() => change({ shape: st.shape === 'italic' ? undefined : 'italic' })}><i>I</i></button>
                <button type="button" class={'ts-tog' + (st.case === 'smallcaps' ? ' on' : '')} title="Small capitals" onClick={() => change({ case: st.case === 'smallcaps' ? undefined : 'smallcaps' })}><span style={{ fontVariant: 'small-caps' }}>Sc</span></button>
                <button type="button" class={'ts-tog' + (st.case === 'uppercase' ? ' on' : '')} title="Capitals" onClick={() => change({ case: st.case === 'uppercase' ? undefined : 'uppercase' })}>AA</button>
              </span>
            </Row>
            <Row label="Colour"><Colors value={st.color} onChange={c => change({ color: c })} /></Row>
            {!runIn && (
              <Row label="Alignment">
                <Seg value={st.align ?? def.align ?? 'left'} options={[['left', 'Left'], ['center', 'Centred'], ['right', 'Right'], ...(type === 'quote' ? [['justify', 'Justified']] as [string, string][] : [])]}
                  onChange={v => change({ align: v as TextStyle['align'] })} />
              </Row>
            )}
            <Row label="Space above">
              <Slider min={0} max={36} step={0.5} value={lengthPt(st.spaceAbove, base) ?? def.above} rungs={SPACE_RUNGS.map(v => ({ v, label: String(v) }))} format={v => (st.spaceAbove ? `${v} pt` : `Default (≈${def.above} pt)`)}
                onChange={v => change({ spaceAbove: `${v}pt` })} onReset={st.spaceAbove ? () => change({ spaceAbove: undefined }) : undefined} />
            </Row>
            {!runIn && (
              <Row label="Space below">
                <Slider min={0} max={36} step={0.5} value={lengthPt(st.spaceBelow, base) ?? def.below} rungs={SPACE_RUNGS.map(v => ({ v, label: String(v) }))} format={v => (st.spaceBelow ? `${v} pt` : `Default (≈${def.below} pt)`)}
                  onChange={v => change({ spaceBelow: `${v}pt` })} onReset={st.spaceBelow ? () => change({ spaceBelow: undefined }) : undefined} />
              </Row>
            )}
            {heading && (
              <Row label="Placement">
                <Seg value={runIn ? 'run-in' : 'block'} options={[['block', 'Own line'], ['run-in', 'Run into the text']]} onChange={v => change({ display: v as TextStyle['display'] })} />
              </Row>
            )}
            {(heading || type === 'title') && !runIn && (
              <Row label="Rule">
                <Seg value={st.rule ?? 'none'} options={[['none', 'None'], ['below', 'Below'], ['above', 'Above']]} onChange={v => change({ rule: v === 'none' ? undefined : v as TextStyle['rule'] })} />
              </Row>
            )}
          </>
        )}
      </div>
      <div class="ts-foot">
        {view && type !== 'body' && <button type="button" onMouseDown={e => e.preventDefault()} onClick={match} title="Take the font, size, weight, italics and colour of the text where the cursor is">Match the text at the cursor</button>}
        <button type="button" onClick={() => { const next = { ...styles }; delete next[type]; save(next, type); }} disabled={!Object.keys(st).length}>Reset {NAMES[type]}</button>
      </div>
    </div>
  );
}

function Row({ label, children }: { label: string; children: preact.ComponentChildren }) {
  return <div class="ts-row"><div class="ts-label">{label}</div><div class="ts-ctl">{children}</div></div>;
}

function Seg({ value, options, onChange }: { value: string; options: [string, string][]; onChange: (v: string) => void }) {
  return <span class="ts-seg">{options.map(([v, l]) => <button key={v} type="button" class={v === value ? 'on' : ''} onClick={() => onChange(v)}>{l}</button>)}</span>;
}

function Colors({ value, onChange }: { value?: string; onChange: (c: string | undefined) => void }) {
  return (
    <span class="ts-colors">
      <button type="button" class={'ts-swatch ts-none' + (!value ? ' on' : '')} title="The document's colour" onClick={() => onChange(undefined)}>⦸</button>
      {COLORS.map(c => <button key={c} type="button" class={'ts-swatch' + (value === c ? ' on' : '')} style={{ background: c }} title={c} onClick={() => onChange(c)} />)}
      <label class="ts-swatch ts-custom" title="Another colour"><input type="color" value={value ?? '#000000'} onInput={e => onChange((e.target as HTMLInputElement).value.toLowerCase())} />+</label>
    </span>
  );
}

/** a continuous slider whose knob snaps to its rungs (within 1.5 % of the range); the rungs labelled under it */
function Slider({ min, max, step, value, rungs, format, onChange, onReset }: { min: number; max: number; step: number; value: number; rungs: { v: number; label: string }[]; format: (v: number) => string; onChange: (v: number) => void; onReset?: () => void }) {
  const span = max - min || 1;
  const pct = (v: number) => ((Math.min(max, Math.max(min, v)) - min) / span) * 100;
  const [v, setV] = useState(value);
  useEffect(() => setV(value), [value]);
  const snap = (x: number) => { const r = rungs.find(r => Math.abs(r.v - x) <= span * 0.015); return r ? r.v : Math.round(x / step) * step; };
  let lastRight = -100;
  const shown = rungs.filter(r => r.v >= min && r.v <= max).map(r => {
    const p = pct(r.v), w = (r.label.length * 5.5 + 6) / 230 * 100;
    const [l, rt] = p < 8 ? [p, p + w] : p > 92 ? [p - w, p] : [p - w / 2, p + w / 2];
    const show = l >= lastRight;
    if (show) lastRight = rt;
    return { ...r, p, show };
  });
  return (
    <div class="ts-slider">
      <div class="ts-slider-val">{format(v)}{onReset && <button type="button" class="ts-reset" title="Back to the default" onClick={onReset}>↺</button>}</div>
      <input type="range" min={min} max={max} step={step} value={v} onInput={e => { const x = snap(Number((e.target as HTMLInputElement).value)); setV(x); onChange(x); }} onKeyDown={e => e.stopPropagation()} />
      <div class="ff-rungs">
        {shown.map(r => (
          <button key={r.v} type="button" class={'ff-rung' + (Math.abs(r.v - v) < step / 2 ? ' on' : '')} style={{ left: `${r.p}%`, ...(r.p < 8 ? { transform: 'none', alignItems: 'flex-start' } : r.p > 92 ? { transform: 'translateX(-100%)', alignItems: 'flex-end' } : {}) }}
            title={r.label} onClick={() => { setV(r.v); onChange(r.v); }}>{r.show ? <span>{r.label}</span> : null}</button>
        ))}
      </div>
    </div>
  );
}

/** a slider that only stops at its rungs */
function Rungs({ value, rungs, onChange }: { value: number; rungs: { v: number; label: string }[]; onChange: (v: number) => void }) {
  const idx = Math.max(0, rungs.findIndex(r => r.v >= value));
  const [i, setI] = useState(idx);
  useEffect(() => setI(idx), [idx]);
  return (
    <div class="ts-slider">
      <div class="ts-slider-val">{rungs[i]?.label}</div>
      <input type="range" min={0} max={rungs.length - 1} step={1} value={i} onInput={e => { const k = Number((e.target as HTMLInputElement).value); setI(k); onChange(rungs[k].v); }} onKeyDown={e => e.stopPropagation()} />
      <div class="ff-rungs">
        {rungs.map((r, k) => {
          const p = rungs.length > 1 ? (k / (rungs.length - 1)) * 100 : 0;
          return <button key={r.v} type="button" class={'ff-rung' + (k === i ? ' on' : '')} style={{ left: `${p}%`, ...(p < 8 ? { transform: 'none', alignItems: 'flex-start' } : p > 92 ? { transform: 'translateX(-100%)', alignItems: 'flex-end' } : {}) }}
            onClick={() => { setI(k); onChange(r.v); }}><span>{r.label}</span></button>;
        })}
      </div>
    </div>
  );
}

/** the style's font: a button opening the font list, and for a Google font its axes and features */
function FontButton({ style, face, markdown, view, axes, onFont }: { style: TextStyle; face: FontFace | null; markdown: boolean; view: EditorView | null; axes: boolean; onFont: (font: string | null) => void }) {
  const [open, setOpen] = useState(false);
  const btn = useRef<HTMLButtonElement>(null);
  const pop = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const h = (e: MouseEvent) => { if (!btn.current?.contains(e.target as Node) && !pop.current?.contains(e.target as Node)) setOpen(false); };
    document.addEventListener('mousedown', h);
    return () => document.removeEventListener('mousedown', h);
  }, [open]);
  useEffect(() => { if (open && pop.current && btn.current) pinUnder(pop.current, btn.current); }, [open]);
  const name = face ? face.family : style.font ?? 'The document’s';
  return (
    <span class="ts-font">
      <button ref={btn} type="button" class="ts-font-btn" onClick={() => setOpen(o => !o)} style={face ? { fontFamily: `'${face.family}', var(--ui-font)` } : undefined}>{name} ▾</button>
      {open && (
        <div ref={pop} class="tb-popup ff-pop ts-font-pop">
          <FontList family={null} current={face} markdown={markdown} inDocument={view ? documentFaces(view) : []}
            onPick={family => onFont(family)} onFamily={() => { onFont(null); setOpen(false); }} close={() => setOpen(false)} />
          {axes && face && style.font && <FacePanel key={face.family} face={face} onChange={f => onFont(faceValue(f))} />}
        </div>
      )}
      {style.font && <button type="button" class="ts-reset" title="The document's font" onClick={() => onFont(null)}>↺</button>}
    </span>
  );
}

