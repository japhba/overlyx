/**
 * Settings ▸ Text styles in the User and Project tabs: how the editor draws each kind of text, in
 * that scope (core textstyles.ts has the scopes: Default < User < Project < Document, the more
 * specific winning key by key) — User: this person's own in every document (prefs.screenStyles,
 * Normal text's font is prefs.editorFont); Project: everyone's in the project
 * (projectsettings.ts textStyles, editorFont). As a tree:
 *
 *   Normal text                its font is the editor's text font
 *     Title, Quote
 *     All headings             every level takes from it what it does not set itself
 *       Section … Paragraph    (Heading 1–4 in markdown)
 *
 * Every property shows the value this scope gives — set here (↺ to inherit again), from All headings,
 * from the scope below (Project shows User's), Normal text's font and colour, or the default (LaTeX's
 * article: TYPE_DEFAULTS, shown as values) — and says when a more specific scope sets it too, which is
 * then what the editor draws ("Project sets …", "The document sets …"). The font: any font of the font
 * list with its axes and OpenType features; the weight a continuous slider with the named weights as
 * rungs. Beside it a sample page drawn as this scope gives it.
 */
import { useEffect, useState } from 'preact/hooks';
import type { ComponentChildren } from 'preact';
import {
  ALL_HEADINGS, SCREEN_PARENT, NAMED_SIZES, WEIGHT_LABELS, FAMILY_FONTS, ONEHALF_STRETCH, DOUBLE_STRETCH, TYPE_DEFAULTS, TEXT_TYPES,
  scopedStyleValue, cascadeStyles, mergeStyles, parseFace, faceValue,
  type ScreenStyles, type ScreenStyleKey, type StyleKey, type TextStyle, type TextStyles, type TextType, type ScopedOrigin, type ScopedStyles, type StyleScope,
} from '@overlyx/core';
import { getUserPrefs, setPref, subscribePrefs } from '../prefs';
import { saveProjectSettings, useProjectSettings } from '../projectsettings';
import { FontChooser, FacePanel, editorFontSections, editorFontLabel } from './FontPicker';
import { Seg, Colors, Slider } from './TextStyles';
import { editorStyleLayers, styleSampleCss } from '../editor/paragraphsep';
import { documentSetsFont } from '../fonts/editorfont';
import { GOOGLE_FACE, FOLLOW_DOCUMENT, editorFace } from '../fonts/catalog';
import { resolvedFace } from '../fonts/editorfont';

/** the tree, in order, with each style's depth */
const TREE: [ScreenStyleKey, number][] = [['body', 0], ['title', 1], ['quote', 1], [ALL_HEADINGS, 1], ['section', 2], ['subsection', 2], ['subsubsection', 2], ['paragraph', 2]];
const NAMES: Record<ScreenStyleKey, string> = {
  body: 'Normal text', title: 'Title', quote: 'Quote', headings: 'All headings',
  section: 'Section · Heading 1', subsection: 'Subsection · Heading 2', subsubsection: 'Subsubsection · Heading 3', paragraph: 'Paragraph · Heading 4',
};
export const SCOPE_NAMES: Record<StyleScope | 'default', string> = { user: 'User', project: 'Project', document: 'Document', default: 'Default' };
const SIZE_NAMES: Record<string, string> = { small: 'Small', normal: 'Normal', large: 'Large', larger: 'Larger', huge: 'Huge' };
const WEIGHT_RUNGS = [100, 400, 700, 900].map(v => ({ v, label: WEIGHT_LABELS[v] }));
const SPACING_RUNGS = [{ v: 1, label: 'Single' }, { v: 1.15, label: '1.15' }, { v: ONEHALF_STRETCH, label: '1½' }, { v: DOUBLE_STRETCH, label: 'Double' }];
const SPACE_RUNGS = [0, 12, 24, 36].map(v => ({ v, label: `${v} pt` }));

/** the defaults every scope starts from, as styles (LaTeX's article: TYPE_DEFAULTS) — what the samples show where nothing is set */
export const DEFAULT_STYLES: TextStyles = Object.fromEntries(TEXT_TYPES.map(t => {
  const d = TYPE_DEFAULTS[t];
  return [t, { size: d.size, weight: d.weight, ...(t === 'title' ? { align: 'center' as const } : {}) }];
}));
/** a style's default value for a key (All headings: the first level's) */
function defaultOf(key: ScreenStyleKey, k: StyleKey): TextStyle[StyleKey] | undefined {
  const d = TYPE_DEFAULTS[key === ALL_HEADINGS ? 'section' : key];
  switch (k) {
    case 'size': return d.size;
    case 'weight': return d.weight;
    case 'shape': return 'upright';
    case 'case': return 'normal';
    case 'lineSpacing': return 1;
    case 'spaceAbove': return `${d.above}pt`;
    case 'spaceBelow': return `${d.below}pt`;
    default: return undefined;
  }
}

/** the editor's text font as Normal text's style font (a font by name), for the samples and the origins of its children */
function bodyFontOf(editorFont: string | undefined): string | undefined {
  if (!editorFont || editorFont === FOLLOW_DOCUMENT) return undefined;
  if (editorFont.startsWith(GOOGLE_FACE)) return editorFont.slice(GOOGLE_FACE.length);
  return editorFace(editorFont).label;
}
const withBody = (tree: ScreenStyles, font: string | undefined): ScreenStyles => (font ? { ...tree, body: { ...(tree.body ?? {}), font } } : tree);

/** where a value comes from, in words, as `scope` shows it */
function originText(o: ScopedOrigin, scope: StyleScope): string {
  if (o.scope === 'default') return 'Default';
  const where = o.scope === scope ? '' : ` (${SCOPE_NAMES[o.scope]})`;
  if (o.via === 'headings') return `from All headings${where}`;
  if (o.via === 'body') return `from Normal text${where}`;
  return o.scope === scope ? 'Set here' : `from ${SCOPE_NAMES[o.scope]}`;
}

export function EditorStyles({ scope = 'user', project = null, document: hasDocument = true, readOnly = false }: {
  scope?: 'user' | 'project';
  /** the project in context: its settings (the Project tab's, and what overrides the User tab's) */
  project?: string | null;
  /** a document is open behind: what it sets overrides both */
  document?: boolean;
  readOnly?: boolean;
}) {
  const [user, setUser] = useState(getUserPrefs);
  const [sel, setSel] = useState<ScreenStyleKey>('body');
  useEffect(() => subscribePrefs(() => setUser(getUserPrefs())), []);
  const { settings: ps } = useProjectSettings(project);
  // (the document open behind the dialog: what its own styles give)
  const pdf = hasDocument ? editorStyleLayers().pdf : {};
  const projectFont = ps?.editorFont;
  const scopes: ScopedStyles = {
    user: withBody(user.screenStyles ?? {}, bodyFontOf(user.editorFont)),
    project: withBody(ps?.textStyles ?? {}, bodyFontOf(projectFont)),
    document: pdf,
  };
  const value = <K extends StyleKey>(key: ScreenStyleKey, k: K) => scopedStyleValue(scopes, scope, key, k);
  const own: ScreenStyles = (scope === 'user' ? user.screenStyles : ps?.textStyles) ?? {};

  const write = (next: ScreenStyles) => {
    if (scope === 'user') { setPref('screenStyles', next); return; }
    if (!project) return;
    const s = { ...(ps ?? {}) };
    if (Object.keys(next).length) s.textStyles = next; else delete s.textStyles;
    saveProjectSettings(project, s);
  };
  const set = (key: ScreenStyleKey, k: StyleKey, v: TextStyle[StyleKey] | undefined) => {
    const st: TextStyle = { ...(own[key] ?? {}) };
    if (v === undefined) delete st[k]; else (st as Record<string, unknown>)[k] = v;
    const next: ScreenStyles = { ...own };
    if (Object.keys(st).length) next[key] = st; else delete next[key];
    write(next);
  };
  const clear = (key: ScreenStyleKey) => { const next = { ...own }; delete next[key]; write(next); };

  /* the body's font: the editor's text font of this scope */
  const ownFont = scope === 'user' ? (user.editorFont !== FOLLOW_DOCUMENT ? user.editorFont : undefined) : projectFont;
  const shownFont = ownFont ?? (scope === 'project' ? user.editorFont : FOLLOW_DOCUMENT);
  const setFont = (id: string | undefined) => {
    if (scope === 'user') { setPref('editorFont', id ?? FOLLOW_DOCUMENT); return; }
    if (!project) return;
    const s = { ...(ps ?? {}) };
    if (id === undefined) delete s.editorFont; else s.editorFont = id;
    saveProjectSettings(project, s);
  };
  /** the body font's origin and the scopes above that set a font */
  const bodyFontState = (): { origin: ScopedOrigin; over: StyleScope[] } => {
    const over: StyleScope[] = [];
    if (scope === 'user' && projectFont) over.push('project');
    if (hasDocument && documentSetsFont()) over.push('document');
    if (ownFont) return { origin: { scope }, over };
    if (scope === 'project' && user.editorFont !== FOLLOW_DOCUMENT) return { origin: { scope: 'user' }, over };
    return { origin: { scope: 'default' }, over };
  };

  /** a property row: its name, where its value comes from (↺: inherit again), its control, the scopes above that set it */
  const row = (k: StyleKey, label: string, control: ComponentChildren) => {
    const body = sel === 'body' && k === 'font';
    const { origin, over } = body ? bodyFontState() : value(sel, k);
    const here = origin.scope === scope && !origin.via;
    return (
      <div class={'es-prop' + (here ? ' here' : '')} key={k} data-es-prop={k} data-origin={origin.scope}>
        <span class="es-label">{label}
          <span class={'es-origin' + (here ? ' own' : '')}>
            {originText(origin, scope)}
            {here && !readOnly && <button type="button" class="es-reset" title={scope === 'user' ? 'Back to the default' : 'Back to what each person has (User)'} data-es-reset={k}
              onClick={() => (body ? setFont(undefined) : set(sel, k, undefined))}>↺</button>}
          </span>
        </span>
        <span class="es-control">
          {control}
          {over.length > 0 && <span class="es-over" data-es-over={over.join(' ')}>{overText(over)}</span>}
        </span>
      </div>
    );
  };
  const overText = (over: StyleScope[]) => over.includes('document') && over.length === 1
    ? 'The document open sets its own — it shows that.'
    : `${over.map(s => (s === 'document' ? 'the document' : SCOPE_NAMES[s])).join(' and ').replace(/^t/, 'T')} ${over.length > 1 ? 'set' : 'sets'} this too — the editor shows ${over.includes('document') ? 'the document’s' : `${SCOPE_NAMES[over.at(-1)!]}’s`}.`;

  const shown = <K extends StyleKey>(k: K): TextStyle[K] | undefined => (value(sel, k).value ?? defaultOf(sel, k)) as TextStyle[K] | undefined;
  const font = value(sel, 'font').value;
  // (a font by name with axes and features: a Google or house font — Normal text's only when the text font is one)
  const face = sel === 'body'
    ? (shownFont.startsWith(GOOGLE_FACE) ? parseFace(shownFont.slice(GOOGLE_FACE.length)) : null)
    : !font || FAMILY_FONTS[font] ? null : parseFace(font);
  const weight = (shown('weight') as number | undefined) ?? 400;
  // (the sample: the defaults, then the scopes up to this one — what this scope gives)
  const upTo: ScopedStyles = scope === 'user' ? { user: scopes.user } : { user: scopes.user, project: scopes.project };
  const resolved = mergeStyles(DEFAULT_STYLES, cascadeStyles(upTo));
  const sample = (t: TextType) => styleSampleCss({ ...(resolved[t] ?? {}), ...(t !== 'body' && resolved[t]?.font === undefined && resolved.body?.font ? { font: resolved.body.font } : {}) });
  const isOwn = (key: ScreenStyleKey) => Object.keys(own[key] ?? {}).length > 0 || (key === 'body' && !!ownFont);
  // (the tree names in their style's font, weight and italics, not its size or colour)
  const nodeCss = (t: TextType) => { const st = resolved[t] ?? {}; return styleSampleCss({ font: st.font ?? resolved.body?.font, weight: st.weight, shape: st.shape }); };
  const sampleFont = shownFont === FOLLOW_DOCUMENT ? undefined : editorFace(shownFont).text;

  return (
    <div class="es" data-editor-styles data-scope={scope}>
      <div class="es-tree" role="listbox" aria-label="Text styles">
        {TREE.map(([key, depth]) => (
          <button key={key} type="button" role="option" aria-selected={sel === key} class={'es-node' + (sel === key ? ' on' : '')} style={{ paddingLeft: `${8 + depth * 14}px` }}
            data-es-style={key} onClick={() => setSel(key)}>
            <span class="es-node-name" style={nodeCss(key === ALL_HEADINGS ? 'section' : key as TextType)}>{NAMES[key]}</span>
            {isOwn(key) && <span class="es-dot" title="Set here" />}
          </button>
        ))}
      </div>
      <fieldset class="es-props" disabled={readOnly}>
        <div class="es-props-head">
          <strong>{NAMES[sel]}</strong>
          <span class="es-parent">{SCREEN_PARENT[sel] ? `takes what it does not set from ${NAMES[SCREEN_PARENT[sel]!]}${sel !== ALL_HEADINGS && SCREEN_PARENT[sel] === ALL_HEADINGS ? '' : ' (font, colour)'}` : 'every other style starts from it'}</span>
          {sel !== 'body' && isOwn(sel) && !readOnly && <button type="button" class="es-clear" data-es-clear onClick={() => clear(sel)}>Inherit everything</button>}
        </div>
        {row('font', 'Font', sel === 'body'
          ? <FontChooser label={editorFontLabel(shownFont)} labelFont={editorFace(shownFont === FOLLOW_DOCUMENT ? resolvedFace(FOLLOW_DOCUMENT) : shownFont).text}
              sections={editorFontSections(ownFont ?? '', id => setFont(id))} onPick={f => setFont(GOOGLE_FACE + f)} title="Normal text’s font" data={{ 'data-es-font': '' }} />
          : <FontChooser label={font ? (FAMILY_FONTS[font]?.label ?? (face?.family ?? font)) : 'As Normal text'} face={face}
              onFamily={f => set(sel, 'font', f === null ? undefined : f === 'roman' ? '@serif' : f === 'sans' ? '@sans' : '@mono')} markdown={false}
              onPick={f => set(sel, 'font', f)} title={`${NAMES[sel]}’s font`} />)}
        {face && (
          <details class="ts-face es-face" open={Object.keys(face.axes).some(a => a !== 'wght') || face.features.length > 0}>
            <summary>Width, grade, other axes &amp; OpenType features</summary>
            <FacePanel key={face.family} face={face} noWeight
              onChange={f => (sel === 'body' ? setFont(GOOGLE_FACE + faceValue(f)) : set(sel, 'font', faceValue(f)))} />
          </details>
        )}
        {row('weight', 'Weight', <Slider min={100} max={900} step={10} value={weight} rungs={WEIGHT_RUNGS} format={v => WEIGHT_LABELS[v] ?? String(v)} onChange={v => set(sel, 'weight', v)} />)}
        {sel !== 'body' && row('size', 'Size', <Seg value={(shown('size') as string | undefined) ?? 'normal'} options={NAMED_SIZES.map(s => [s, SIZE_NAMES[s]] as [string, string])} onChange={v => set(sel, 'size', v)} />)}
        {row('shape', 'Italic', <Seg value={(shown('shape') as string) ?? 'upright'} options={[['upright', 'Upright'], ['italic', 'Italic']]} onChange={v => set(sel, 'shape', v as TextStyle['shape'])} />)}
        {row('case', 'Letters', <Seg value={(shown('case') as string) ?? 'normal'} options={[['normal', 'As typed'], ['smallcaps', 'Small caps'], ['uppercase', 'Capitals']]} onChange={v => set(sel, 'case', v as TextStyle['case'])} />)}
        {row('color', 'Colour', <Colors value={value(sel, 'color').value} onChange={c => set(sel, 'color', c)} />)}
        {sel === 'body'
          ? row('lineSpacing', 'Line spacing', <Slider min={1} max={2.5} step={0.05} value={(shown('lineSpacing') as number) ?? 1} rungs={SPACING_RUNGS} format={v => v.toFixed(2).replace(/\.?0+$/, '')} onChange={v => set(sel, 'lineSpacing', v)} />)
          : <>
            {row('spaceAbove', 'Space above', <Slider min={0} max={48} step={1} value={parseFloat((shown('spaceAbove') as string) ?? '') || 0} rungs={SPACE_RUNGS} format={v => `${v} pt`} onChange={v => set(sel, 'spaceAbove', `${v}pt`)} />)}
            {row('spaceBelow', 'Space below', <Slider min={0} max={48} step={1} value={parseFloat((shown('spaceBelow') as string) ?? '') || 0} rungs={SPACE_RUNGS} format={v => `${v} pt`} onChange={v => set(sel, 'spaceBelow', `${v}pt`)} />)}
          </>}
      </fieldset>
      <div class="es-sample" aria-label="Sample" style={{ fontFamily: sampleFont ?? 'var(--editor-font)' }}>
        <div class="es-sample-say">{scope === 'user' ? 'Your styles, where a project or document sets nothing' : 'The project’s styles, where a document sets nothing'}</div>
        <div style={sample('title')} class="es-s-title">On the Shape of Things</div>
        <div style={sample('section')} class="es-s-h1">1 Introduction</div>
        <div style={sample('body')}>Normal text runs like this, with I l 1 and O 0 easy to tell apart, and a formula’s neighbours set in the same font.</div>
        <div style={sample('subsection')} class="es-s-h2">1.1 Background</div>
        <div style={sample('quote')} class="es-s-quote">A quotation stands a little apart from the text around it.</div>
        <div style={sample('subsubsection')} class="es-s-h3">Details</div>
        <div style={sample('body')}>Each heading takes the space and weight it is given; the text after it starts close below.</div>
      </div>
    </div>
  );
}
