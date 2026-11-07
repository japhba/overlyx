/**
 * Settings ▸ Fonts ▸ Your editor's text styles: how this person's editor draws each kind of text in
 * every document (the "my editor" layer, prefs.screenStyles — Text styles ▸ Only my editor edits the same,
 * one document at a time), as a tree:
 *
 *   Normal text                its font is the editor's text font (prefs.editorFont)
 *     Title, Quote
 *     All headings             every level takes from it what it does not set itself
 *       Section … Paragraph    (Heading 1–4 in markdown)
 *
 * Each property says where its value comes from — set here ("Yours", ↺ to inherit again), All
 * headings, the document open behind, Normal text (the font and colour flow down), or LaTeX's default
 * (core textstyles.ts screenValue). The font: any font of the font list with its axes (weight, width,
 * grade …) and OpenType features; the weight a continuous slider with the named weights as rungs.
 * Below, a sample page drawn as the editor will draw it.
 */
import { useEffect, useState } from 'preact/hooks';
import type { ComponentChildren } from 'preact';
import {
  ALL_HEADINGS, SCREEN_PARENT, NAMED_SIZES, WEIGHT_LABELS, FAMILY_FONTS, ONEHALF_STRETCH, DOUBLE_STRETCH, TYPE_DEFAULTS,
  screenValue, resolveScreenStyles, mergeStyles, parseFace, faceValue,
  type ScreenStyles, type ScreenStyleKey, type StyleKey, type TextStyle, type TextType, type StyleOrigin,
} from '@overlyx/core';
import { getPrefs, setPref, subscribePrefs } from '../prefs';
import { FontChooser, FacePanel, editorFontSections, editorFontLabel } from './FontPicker';
import { Seg, Colors, Slider } from './TextStyles';
import { editorStyleLayers, styleSampleCss } from '../editor/paragraphsep';
import { GOOGLE_FACE, FOLLOW_DOCUMENT, editorFace } from '../fonts/catalog';
import { resolvedFace } from '../fonts/editorfont';

/** the tree, in order, with each style's depth */
const TREE: [ScreenStyleKey, number][] = [['body', 0], ['title', 1], ['quote', 1], [ALL_HEADINGS, 1], ['section', 2], ['subsection', 2], ['subsubsection', 2], ['paragraph', 2]];
const NAMES: Record<ScreenStyleKey, string> = {
  body: 'Normal text', title: 'Title', quote: 'Quote', headings: 'All headings',
  section: 'Section · Heading 1', subsection: 'Subsection · Heading 2', subsubsection: 'Subsubsection · Heading 3', paragraph: 'Paragraph · Heading 4',
};
const SIZE_NAMES: Record<string, string> = { small: 'Small', normal: 'Normal', large: 'Large', larger: 'Larger', huge: 'Huge' };
const WEIGHT_RUNGS = [100, 400, 700, 900].map(v => ({ v, label: WEIGHT_LABELS[v] }));
const SPACING_RUNGS = [{ v: 1, label: 'Single' }, { v: 1.15, label: '1.15' }, { v: ONEHALF_STRETCH, label: '1½' }, { v: DOUBLE_STRETCH, label: 'Double' }];
const SPACE_RUNGS = [0, 12, 24, 36].map(v => ({ v, label: `${v} pt` }));

/** the editor's text font as Normal text's style font (a font by name), for the samples and the origins of its children */
function bodyFontOf(editorFont: string): string | undefined {
  if (editorFont === FOLLOW_DOCUMENT) return undefined;
  if (editorFont.startsWith(GOOGLE_FACE)) return editorFont.slice(GOOGLE_FACE.length);
  return editorFace(editorFont).label;
}

/** where a value comes from, in words */
function originText(o: StyleOrigin): string {
  switch (o.from) {
    case 'own': return 'Yours';
    case 'parent': return 'from All headings';
    case 'document': return 'from the document';
    case 'body': return 'from Normal text';
    default: return 'LaTeX’s default';
  }
}

export function EditorStyles() {
  const [screen, setScreen] = useState<ScreenStyles>(() => getPrefs().screenStyles ?? {});
  const [editorFont, setEditorFont] = useState(() => getPrefs().editorFont);
  const [sel, setSel] = useState<ScreenStyleKey>('body');
  useEffect(() => subscribePrefs(p => { setScreen(p.screenStyles ?? {}); setEditorFont(p.editorFont); }), []);
  // (the document open behind the dialog: what its own styles give, for "from the document")
  const pdf = editorStyleLayers().pdf;
  const bodyFont = bodyFontOf(editorFont);
  const withBody: ScreenStyles = { ...screen, body: { ...(screen.body ?? {}), ...(bodyFont ? { font: bodyFont } : {}) } };
  const value = <K extends StyleKey>(key: ScreenStyleKey, k: K) => screenValue(withBody, pdf, key, k);

  const set = (key: ScreenStyleKey, k: StyleKey, v: TextStyle[StyleKey] | undefined) => {
    const st: TextStyle = { ...(screen[key] ?? {}) };
    if (v === undefined) delete st[k]; else (st as Record<string, unknown>)[k] = v;
    const next: ScreenStyles = { ...screen };
    if (Object.keys(st).length) next[key] = st; else delete next[key];
    setPref('screenStyles', next);
  };
  const clear = (key: ScreenStyleKey) => { const next = { ...screen }; delete next[key]; setPref('screenStyles', next); };

  /** a property row: its name, its control, where its value comes from (↺: inherit again) */
  const row = (k: StyleKey, label: string, control: ComponentChildren) => {
    const { origin } = value(sel, k);
    const own = origin.from === 'own' || (sel === 'body' && k === 'font' && editorFont !== FOLLOW_DOCUMENT);
    return (
      <div class="es-prop" key={k}>
        <span class="es-label">{label}
          <span class={'es-origin' + (own ? ' own' : '')}>
            {own ? 'Yours' : originText(origin)}
            {own && <button type="button" class="es-reset" title="Back to inheriting it" data-es-reset={k}
              onClick={() => (sel === 'body' && k === 'font' ? setPref('editorFont', FOLLOW_DOCUMENT) : set(sel, k, undefined))}>↺</button>}
          </span>
        </span>
        <span class="es-control">{control}</span>
      </div>
    );
  };

  const font = value(sel, 'font').value;
  // (a font by name with axes and features: a Google or house font — Normal text's only when the editor's text font is one)
  const face = !font || FAMILY_FONTS[font] || (sel === 'body' && !editorFont.startsWith(GOOGLE_FACE) && editorFont !== 'anodyne') ? null : parseFace(font);
  const weightDefault = sel === 'body' || sel === 'title' || sel === 'quote' ? TYPE_DEFAULTS[sel as TextType].weight : 700;
  const weight = value(sel, 'weight').value ?? weightDefault;
  const resolved = mergeStyles(pdf, resolveScreenStyles(withBody));
  const sample = (t: TextType) => styleSampleCss({ ...(resolved[t] ?? {}), ...(t !== 'body' && resolved[t]?.font === undefined && resolved.body?.font ? { font: resolved.body.font } : {}) });
  const own = (key: ScreenStyleKey) => Object.keys(screen[key] ?? {}).length > 0 || (key === 'body' && editorFont !== FOLLOW_DOCUMENT);
  // (the tree names in their style's font, weight and italics, not its size or colour)
  const nodeCss = (t: TextType) => { const st = resolved[t] ?? {}; return styleSampleCss({ font: st.font ?? resolved.body?.font, weight: st.weight, shape: st.shape }); };

  return (
    <div class="es" data-editor-styles>
      <div class="es-main">
        <div class="es-tree" role="listbox" aria-label="Text styles">
          {TREE.map(([key, depth]) => (
            <button key={key} type="button" role="option" aria-selected={sel === key} class={'es-node' + (sel === key ? ' on' : '')} style={{ paddingLeft: `${8 + depth * 14}px` }}
              data-es-style={key} onClick={() => setSel(key)}>
              <span class="es-node-name" style={nodeCss(key === ALL_HEADINGS ? 'section' : key as TextType)}>{NAMES[key]}</span>
              {own(key) && <span class="es-dot" title="Set here" />}
            </button>
          ))}
        </div>
        <div class="es-props">
          <div class="es-props-head">
            <strong>{NAMES[sel]}</strong>
            <span class="es-parent">{SCREEN_PARENT[sel] ? `takes what it does not set from ${NAMES[SCREEN_PARENT[sel]!]}${sel !== ALL_HEADINGS && SCREEN_PARENT[sel] === ALL_HEADINGS ? ' and the document' : ' (font, colour) and the document'}` : 'the editor’s text: every other style starts from it'}</span>
            {sel !== 'body' && own(sel) && <button type="button" class="es-clear" data-es-clear onClick={() => clear(sel)}>Inherit everything</button>}
          </div>
          {row('font', 'Font', sel === 'body'
            ? <FontChooser label={editorFontLabel(editorFont)} labelFont={editorFace(editorFont === FOLLOW_DOCUMENT ? resolvedFace(FOLLOW_DOCUMENT) : editorFont).text}
                sections={editorFontSections(editorFont, id => setPref('editorFont', id))} onPick={f => setPref('editorFont', GOOGLE_FACE + f)} title="Normal text’s font" />
            : <FontChooser label={font ? (FAMILY_FONTS[font]?.label ?? (face?.family ?? font)) : 'As inherited'} face={face}
                onFamily={f => set(sel, 'font', f === null ? undefined : f === 'roman' ? '@serif' : f === 'sans' ? '@sans' : '@mono')} markdown={false}
                onPick={f => set(sel, 'font', f)} title={`${NAMES[sel]}’s font`} />)}
          {face && (
            <details class="ts-face es-face" open={Object.keys(face.axes).some(a => a !== 'wght') || face.features.length > 0}>
              <summary>Width, grade, other axes &amp; OpenType features</summary>
              <FacePanel key={face.family} face={face} noWeight
                onChange={f => (sel === 'body' ? setPref('editorFont', GOOGLE_FACE + faceValue(f)) : set(sel, 'font', faceValue(f)))} />
            </details>
          )}
          {row('weight', 'Weight', <Slider min={100} max={900} step={10} value={weight} rungs={WEIGHT_RUNGS} format={v => WEIGHT_LABELS[v] ?? String(v)} onChange={v => set(sel, 'weight', v)} />)}
          {sel !== 'body' && row('size', 'Size', <Seg value={value(sel, 'size').value ?? ''} options={NAMED_SIZES.map(s => [s, SIZE_NAMES[s]] as [string, string])} onChange={v => set(sel, 'size', v)} />)}
          {row('shape', 'Italic', <Seg value={value(sel, 'shape').value ?? 'upright'} options={[['upright', 'Upright'], ['italic', 'Italic']]} onChange={v => set(sel, 'shape', v as TextStyle['shape'])} />)}
          {row('case', 'Letters', <Seg value={value(sel, 'case').value ?? 'normal'} options={[['normal', 'As typed'], ['smallcaps', 'Small caps'], ['uppercase', 'Capitals']]} onChange={v => set(sel, 'case', v as TextStyle['case'])} />)}
          {row('color', 'Colour', <Colors value={value(sel, 'color').value} onChange={c => set(sel, 'color', c)} />)}
          {sel === 'body'
            ? row('lineSpacing', 'Line spacing', <Slider min={1} max={2.5} step={0.05} value={value(sel, 'lineSpacing').value ?? 1} rungs={SPACING_RUNGS} format={v => v.toFixed(2).replace(/\.?0+$/, '')} onChange={v => set(sel, 'lineSpacing', v)} />)
            : <>
              {row('spaceAbove', 'Space above', <Slider min={0} max={48} step={1} value={parseFloat(value(sel, 'spaceAbove').value ?? '') || 0} rungs={SPACE_RUNGS} format={v => `${v} pt`} onChange={v => set(sel, 'spaceAbove', `${v}pt`)} />)}
              {row('spaceBelow', 'Space below', <Slider min={0} max={48} step={1} value={parseFloat(value(sel, 'spaceBelow').value ?? '') || 0} rungs={SPACE_RUNGS} format={v => `${v} pt`} onChange={v => set(sel, 'spaceBelow', `${v}pt`)} />)}
            </>}
        </div>
      </div>
      <div class="es-sample" aria-label="Sample" style={{ fontFamily: 'var(--editor-font)' }}>
        <div style={sample('title')} class="es-s-title">On the Shape of Things</div>
        <div style={sample('section')} class="es-s-h1">1 Introduction</div>
        <div style={sample('body')}>Normal text runs like this, with I l 1 and O 0 easy to tell apart, and a formula’s neighbours set in the same font.</div>
        <div style={sample('subsection')} class="es-s-h2">1.1 Background</div>
        <div style={sample('quote')} class="es-s-quote">A quotation stands a little apart from the text around it.</div>
        <div style={sample('subsubsection')} class="es-s-h3">Details</div>
      </div>
    </div>
  );
}
