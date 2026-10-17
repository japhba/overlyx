/**
 * Format ▸ Text styles (and ✎ beside a style in the paragraph style list): how each kind of text
 * looks — Title, Heading 1–4, Normal text, Quote — set as in Google Docs or Word, the document
 * changing as you go. A floating panel, not a dialog: the page stays in view. For the kind chosen:
 * font (any Google font, the document's own families or font sets; a variable font's axes and its
 * OpenType features), weight (Thin … Black, as far as the font has them), size, italics, small
 * capitals / capitals, colour, alignment, the body's line spacing, the space above and below, and for
 * headings whether they run into their paragraph and a rule. "Match the text at the cursor" takes the
 * font, size, weight, italics and colour of the text where the cursor is (Google Docs' "Update to match").
 *
 * Where a change goes — the switch at the top (core textstyles.ts has the layers):
 *   Document & PDF   the document's settings: a markdown document's front matter (`headings:`, `styles:`,
 *                    pandoc's mainfont / fontsize / linestretch / justify), a .tex document's settings
 *                    (`overlyx_styles` — the managed block's LaTeX — and paperfontsize / spacing /
 *                    justification / fonts). The PDF and everyone's editor follow them.
 *   Only my editor   this person's own (prefs.screenStyles; Normal text's font is prefs.editorFont):
 *                    every document they open is drawn so, the PDF never.
 * Every setting says where what it shows comes from: LaTeX's default, the document, LaTeX in the
 * preamble (header-includes, a .tex preamble: it has the last word in the PDF), or this editor alone.
 * Setting in the document what the preamble's LaTeX sets replaces that LaTeX — the values it set are
 * kept, the statements removed (core takeOver / removeStatements) — with an Undo; so does Reset.
 */
import { useEffect, useMemo, useRef, useState } from 'preact/hooks';
import type { EditorView } from 'prosemirror-view';
import {
  TEXT_TYPES, NAMED_SIZES, SIZE_EM, TYPE_DEFAULTS, FAMILY_FONTS, ONEHALF_STRETCH, DOUBLE_STRETCH, WEIGHT_LABELS,
  styleLayers, readTexStyles, settingsOverTex, managedSettings, pdfStyles, mergeStyles, takeOver, removeStatements, headerPreamble, bodyDefaults, spacingValue,
  stylesJson, parseFace, faceValue, isHeading, typeOfLayout, TYPE_LAYOUTS,
  type TextStyle, type TextStyles, type TextType, type StyleKey, type TexLayer, type TexStatement, type FontFace,
} from '@overlyx/core';
import { MD_FONTS } from '@overlyx/core/md/typesetting.ts';
import { api } from '../api';
import { FontList, FacePanel, documentFaces, fontInfo, type FontInfo, type FontSection } from './FontPicker';
import { cursorMarks } from './toolbars';
import { previewTextStyles } from '../editor/paragraphsep';
import { loadGoogleFont } from '../fonts/googlefont';
import { getPrefs, setPref, subscribePrefs } from '../prefs';
import { EDITOR_FACES, DOCUMENT_FONT_SETS, FOLLOW_DOCUMENT, GOOGLE_FACE, editorFace, matchFontSet, fontSetValues, fontValues, type DocumentFontSet } from '../fonts/catalog';
import { pinUnder } from './popup';
import { styleLabel } from './stylenames';

/** a kind's name: its paragraph style's, as the style list shows it (.tex: Section …; markdown: Heading 1 …; Modern: Normal text) */
const typeName = (t: TextType, markdown: boolean) => styleLabel(TYPE_LAYOUTS[t][0], document.documentElement.dataset.ui === 'modern' ? 'modern' : 'classic', markdown);
const SIZE_NAMES: Record<string, string> = { small: 'Small', normal: 'Normal', large: 'Large', larger: 'Larger', huge: 'Huge' };
const COLORS = ['#000000', '#444444', '#1f4e79', '#2a62d6', '#0b7a75', '#2e7d32', '#b8860b', '#c0392b', '#8e44ad'];
const SPACE_RUNGS = [0, 3, 6, 9, 12, 18, 24, 36];
const WEIGHTS = [100, 200, 300, 400, 500, 600, 700, 800, 900];
const SPACING_RUNGS = [{ v: 1, label: 'Single' }, { v: 1.15, label: '1.15' }, { v: ONEHALF_STRETCH, label: '1½' }, { v: DOUBLE_STRETCH, label: 'Double' }, { v: 2, label: '2' }];
/** the body's settings of their own (not `overlyx_styles` / `styles.body`) */
const BODY_SETTINGS: StyleKey[] = ['align', 'lineSpacing', 'size', 'font'];

type Scope = 'document' | 'screen';
type Origin = 'default' | 'document' | 'latex' | 'screen';
/** the body's font as chosen here: a font by name, a LaTeX font set (.tex), a font with its math font (markdown), or the default */
type BodyFont = { kind: 'name'; face: string } | { kind: 'set'; set: DocumentFontSet } | { kind: 'md'; main: string; math: string } | { kind: 'default' };
type Undo = { doc: TextStyles; pre: string; changed: StyleKey[]; font: BodyFont | null };

const headerValue = (lines: readonly string[], key: string) => lines.find(l => l === '\\' + key || l.startsWith('\\' + key + ' '))?.slice(key.length + 2).trim();

/** a style as the front matter writes it (`space-above`) */
function fmStyle(st: TextStyle): Record<string, string | number> {
  const out: Record<string, string | number> = {};
  for (const [k, v] of Object.entries(st)) if (v !== undefined) out[k === 'spaceAbove' ? 'space-above' : k === 'spaceBelow' ? 'space-below' : k === 'lineSpacing' ? 'line-spacing' : k] = v as string | number;
  return out;
}
/** a length as points (for the sliders; ex ≈ 0.43 em) */
function lengthPt(len: string | undefined, base: number): number | null {
  if (!len) return null;
  const m = /^(\d+(?:\.\d+)?)(ex|em|pt|mm|cm)$/.exec(len);
  if (!m) return null;
  return Math.round(({ pt: 1, em: base, ex: base * 0.43, mm: 2.845, cm: 28.45 }[m[2]] ?? 1) * Number(m[1]) * 10) / 10;
}
/** a size as points at the base size */
const sizePt = (size: string, base: number) => (SIZE_EM[size] ? Math.round(SIZE_EM[size] * base * 100) / 100 : parseFloat(size));
const weightLabel = (w: number) => WEIGHT_LABELS[w] ?? String(w);
/** keys without a value dropped */
const clean = (st: TextStyle): TextStyle => Object.fromEntries(Object.entries(st).filter(([, v]) => v !== undefined)) as TextStyle;
const familyOf = (font: string | undefined) => (font && !FAMILY_FONTS[font] ? font.split('|')[0] : null);
/** a font's name as people read it (`Inter|wdth=90` → Inter, `@sans` → Sans serif) */
const fontLabel = (font: string) => FAMILY_FONTS[font]?.label ?? font.split('|')[0];
const SCOPE_KEY = 'ol.textStylesScope';

/** the document with what `statements` (the preamble's, being removed) set kept — a key one set without a value back to the default; `except` left out */
function keepWhatItSet(doc: TextStyles, statements: readonly TexStatement[], except?: TextType): TextStyles {
  const out: TextStyles = { ...doc };
  for (const st of statements) for (const t of st.types) {
    if (t === except) continue;
    const d: TextStyle = { ...(out[t] ?? {}) };
    for (const k of st.keys) { const v = st.set[t]?.[k]; if (v === undefined) delete d[k]; else (d as Record<string, unknown>)[k] = v; }
    out[t] = d;
  }
  return out;
}

function useFontInfo(family: string | null): FontInfo | null | undefined {
  const [info, setInfo] = useState<FontInfo | null | undefined>(family ? undefined : null);
  useEffect(() => {
    if (!family) { setInfo(null); return; }
    let live = true;
    setInfo(undefined);
    void fontInfo(family).then(i => { if (live) setInfo(i); });
    return () => { live = false; };
  }, [family]);
  return info;
}

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
  const [type, setType] = useState<TextType>(typeOfLayout(layout ?? cursorLayout ?? '') ?? 'section');
  const [scope, setScopeState] = useState<Scope>(() => { try { return localStorage.getItem(SCOPE_KEY) === 'screen' ? 'screen' : 'document'; } catch { return 'document'; } });
  const setScope = (s: Scope) => { setScopeState(s); try { localStorage.setItem(SCOPE_KEY, s); } catch { /* private window */ } };

  // the document's layers as edited here (its header catches up once they are saved)
  const layers = useMemo(() => styleLayers(headerLines), [headerLines]);
  const [doc, setDoc] = useState<TextStyles>(layers.document);
  const [pre, setPre] = useState(() => headerPreamble(headerLines));
  const [screen, setScreen] = useState<TextStyles>(() => getPrefs().screenStyles ?? {});
  const [ownFont, setOwnFont] = useState(() => getPrefs().editorFont);
  useEffect(() => subscribePrefs(p => { setScreen(p.screenStyles ?? {}); setOwnFont(p.editorFont); }), []);
  const timer = useRef<ReturnType<typeof setTimeout>>();
  const saving = useRef(0);
  const latest = useRef({ doc, pre });
  useEffect(() => {
    if (timer.current || saving.current) return;
    setDoc(layers.document);
    const p = headerPreamble(headerLines);
    setPre(p);
    latest.current = { doc: layers.document, pre: p };
  }, [headerLines]);
  const tex = useMemo<TexLayer>(() => settingsOverTex(readTexStyles(pre), managedSettings(headerLines)), [pre, headerLines]);
  const pdf = useMemo(() => pdfStyles(doc, tex), [doc, tex]);
  const editor = useMemo(() => mergeStyles(pdf, screen), [pdf, screen]);
  useEffect(() => { previewTextStyles({ document: doc, tex, screen }); }, [doc, tex, screen]);

  const base = useMemo(() => { const v = Number(headerValue(headerLines, 'paperfontsize')); return v > 0 ? v : 10; }, [headerLines]);
  useEffect(() => {
    const k = (e: KeyboardEvent) => { if (e.key === 'Escape' && !(e.target as HTMLElement | null)?.closest?.('.ff-pop')) { e.preventDefault(); onClose(); } };
    document.addEventListener('keydown', k);
    return () => document.removeEventListener('keydown', k);
  }, [onClose]);

  /* -------------------------------------------------------------- saving the document's */

  const dirty = useRef(new Set<StyleKey>());
  const preChanged = useRef(false);
  const bodyFont = useRef<BodyFont | null>(null);
  const persist = async (d: TextStyles, preamble: string, changed: Set<StyleKey>, preDirty: boolean, font: BodyFont | null) => {
    const b = d.body ?? {};
    // the body's own style: its colour, weight, and a font by name's axes and features (the family is a setting)
    const bodyOwn = clean({ color: b.color, weight: b.weight, font: b.font?.includes('|') ? b.font : undefined });
    if (markdown) {
      const set: Record<string, unknown> = {};
      const headings: Record<string, Record<string, string | number>> = {};
      for (const l of ['section', 'subsection', 'subsubsection', 'paragraph'] as const) if (d[l] && Object.keys(d[l]!).length) headings[l] = fmStyle(d[l]!);
      set.headings = Object.keys(headings).length ? headings : null;
      const others: Record<string, Record<string, string | number>> = {};
      if (d.title && Object.keys(d.title).length) others.title = fmStyle(d.title);
      if (d.quote && Object.keys(d.quote).length) others.quote = fmStyle(d.quote);
      if (Object.keys(bodyOwn).length) others.body = fmStyle(bodyOwn);
      set.styles = Object.keys(others).length ? others : null;
      if (changed.has('align')) set.justify = b.align === 'justify' ? true : null;
      if (changed.has('lineSpacing')) set.linestretch = b.lineSpacing && Math.abs(b.lineSpacing - 1) > 0.004 ? b.lineSpacing : null;
      if (changed.has('size')) set.fontsize = b.size ?? null;
      if (changed.has('font') && font) {
        if (font.kind === 'md') { set.mainfont = font.main; set.mathfont = font.math; }
        else if (font.kind === 'name') set.mainfont = font.face.split('|')[0];
        else set.mainfont = null;
      }
      if (preDirty) { const lines = preamble.split('\n').filter(l => l.trim()); set['header-includes'] = lines.length ? lines : null; }
      await api.setMdFrontMatter(docId, set);
    } else {
      const set: Record<string, string> = { overlyx_styles: stylesJson({ ...d, body: bodyOwn }) };
      if (changed.has('align')) set.justification = b.align === 'left' ? 'false' : 'true';
      if (changed.has('lineSpacing')) set.spacing = spacingValue(b.lineSpacing ?? 1);
      if (changed.has('size')) set.paperfontsize = b.size ? String(parseFloat(b.size)) : 'default';
      if (changed.has('font') && font) {
        const cur = (k: string, dflt: string) => headerValue(headerLines, k) ?? dflt;
        const texName = fontValues(cur('font_roman', '"default" "default"'))[0] || 'default';
        if (font.kind === 'name') Object.assign(set, { use_non_tex_fonts: 'true', font_roman: `"${texName}" "${font.face.split('|')[0]}"` });
        else if (font.kind === 'set') {
          Object.assign(set, fontSetValues(font.set, {
            font_roman: cur('font_roman', '"default" "default"'), font_sans: cur('font_sans', '"default" "default"'), font_typewriter: cur('font_typewriter', '"default" "default"'),
            font_math: cur('font_math', '"auto" "auto"'), font_sf_scale: cur('font_sf_scale', '100 100'),
          }), { use_non_tex_fonts: 'false' });
        } else Object.assign(set, { use_non_tex_fonts: 'false', font_roman: '"default" "default"' });
      }
      await api.setHeader(docId, { set, ...(preDirty ? { preamble } : {}) });
    }
    onSaved?.();
  };
  const flush = async () => {
    timer.current = undefined;
    const { doc: d, pre: p } = latest.current;
    const changed = new Set(dirty.current), preDirty = preChanged.current, font = bodyFont.current;
    dirty.current.clear(); preChanged.current = false;
    saving.current++;
    try { await persist(d, p, changed, preDirty, font); } catch { /* the next change tries again */ } finally { saving.current--; }
  };
  // what is not saved yet is saved on closing; the editor then draws what the document says
  useEffect(() => () => { if (timer.current) { clearTimeout(timer.current); void flush(); } previewTextStyles(null); }, []);

  const commit = (nextDoc: TextStyles, nextPre: string, changed: StyleKey[] = []) => {
    setDoc(nextDoc);
    if (nextPre !== latest.current.pre) { setPre(nextPre); preChanged.current = true; }
    for (const k of changed) dirty.current.add(k);
    latest.current = { doc: nextDoc, pre: nextPre };
    clearTimeout(timer.current);
    timer.current = setTimeout(() => { void flush(); }, 350);
  };

  /* -------------------------------------------------------------- changing */

  const [notice, setNotice] = useState<{ statements: TexStatement[]; undo: Undo } | null>(null);
  const bodyKeysOf = (statements: readonly TexStatement[]) => statements.filter(st => st.types.includes('body')).flatMap(st => st.keys.filter(k => BODY_SETTINGS.includes(k)));

  /** the preamble's statements that set `keys` of the kind (null: all of them) go; what they set stays in the document (but the kind's own, resetting it) */
  const replaceLatex = (keys: StyleKey[] | null, resetting = false) => {
    const statements: TexStatement[] = [];
    for (const k of keys ?? [undefined]) for (const st of takeOver(tex, type, k).statements) if (!statements.includes(st)) statements.push(st);
    const { doc: d, pre: p } = latest.current;
    if (!statements.length) return { doc: d, pre: p, statements, changed: [] as StyleKey[] };
    if (statements.length) setNotice({ statements, undo: { doc: d, pre: p, changed: bodyKeysOf(statements), font: bodyFont.current } });
    return { doc: keepWhatItSet(d, statements, resetting ? type : undefined), pre: removeStatements(p, statements), statements, changed: bodyKeysOf(statements) };
  };

  /** a change in the chosen scope (`font`: the body's font as chosen, for its settings) */
  const change = (patch: Partial<TextStyle>, font?: BodyFont) => {
    if (scope === 'screen') {
      const p = { ...patch };
      // (the body's font in this editor is the editor's text font)
      if (type === 'body' && 'font' in p) { const f = familyOf(p.font); setPref('editorFont', f ? GOOGLE_FACE + p.font : FOLLOW_DOCUMENT); delete p.font; }
      const next: TextStyles = { ...screen, [type]: clean({ ...(screen[type] ?? {}), ...p }) };
      if (!Object.keys(next[type]!).length) delete next[type];
      setScreen(next);
      setPref('screenStyles', next);
      return;
    }
    const taken = (Object.keys(patch) as StyleKey[]).filter(k => tex[type]?.keys.includes(k));
    const r = replaceLatex(taken);
    const next: TextStyles = { ...r.doc, [type]: clean({ ...(r.doc[type] ?? {}), ...patch }) };
    if (!Object.keys(next[type]!).length) delete next[type];
    if (font) bodyFont.current = font;
    else if (r.changed.includes('font')) bodyFont.current = next.body?.font ? { kind: 'name', face: next.body.font } : { kind: 'default' };
    commit(next, r.pre, [...r.changed, ...(type === 'body' ? (Object.keys(patch) as StyleKey[]).filter(k => BODY_SETTINGS.includes(k)) : [])]);
  };
  /** one setting back to the layer below: the document's to the default (the preamble's LaTeX for it removed), this editor's to the document's */
  const resetKey = (k: StyleKey) => {
    if (scope === 'screen') {
      if (type === 'body' && k === 'font') setPref('editorFont', FOLLOW_DOCUMENT);
      else change({ [k]: undefined });
      return;
    }
    const r = tex[type]?.keys.includes(k) ? replaceLatex([k]) : { ...latest.current, statements: [], changed: [] as StyleKey[] };
    const st: TextStyle = { ...(r.doc[type] ?? {}) };
    delete st[k];
    const next: TextStyles = { ...r.doc, [type]: st };
    if (!Object.keys(st).length) delete next[type];
    if (type === 'body' && k === 'font') bodyFont.current = { kind: 'default' };
    commit(next, r.pre, [...r.changed, ...(type === 'body' && BODY_SETTINGS.includes(k) ? [k] : [])]);
  };
  /** the whole kind back: the document's to LaTeX's default look (its LaTeX in the preamble removed too), this editor's to the document's */
  const resetType = () => {
    if (scope === 'screen') {
      const next = { ...screen };
      delete next[type];
      setScreen(next);
      setPref('screenStyles', next);
      if (type === 'body' && ownFont !== FOLLOW_DOCUMENT) setPref('editorFont', FOLLOW_DOCUMENT);
      return;
    }
    const r = replaceLatex(null, true);
    const next = { ...r.doc };
    delete next[type];
    if (type === 'body') bodyFont.current = { kind: 'default' };
    commit(next, r.pre, type === 'body' ? BODY_SETTINGS : r.changed);
  };
  /** the preamble's LaTeX for this kind replaced by the same settings here (the look stays) */
  const replaceAll = () => {
    const r = replaceLatex(null);
    if (r.changed.includes('font')) bodyFont.current = r.doc.body?.font ? { kind: 'name', face: r.doc.body.font } : { kind: 'default' };
    commit(r.doc, r.pre, r.changed);
  };
  const undo = () => {
    if (!notice) return;
    const u = notice.undo;
    bodyFont.current = u.font ?? (u.doc.body?.font ? { kind: 'name', face: u.doc.body.font } : { kind: 'default' });
    setNotice(null);
    commit(u.doc, u.pre, u.changed);
  };

  // the text at the cursor: its font, size, weight, shape, colour become the style (Google Docs' "Update to match")
  const match = () => {
    if (!view) return;
    const marks = cursorMarks(view);
    const value = (n: string) => marks.find(m => m.type.name === n)?.attrs.value as string | undefined;
    const patch: Partial<TextStyle> = {};
    const face = parseFace(value('face'));
    if (face) { if (face.axes.wght !== undefined) patch.weight = Math.round(face.axes.wght); delete face.axes.wght; patch.font = faceValue(face); }
    const family = value('family');
    if (!face && family && family !== 'default' && type !== 'body') patch.font = family === 'sans' ? '@sans' : family === 'typewriter' ? '@mono' : '@serif';
    const size = value('size');
    const LYX_SIZE: Record<string, string> = { small: 'small', normal: 'normal', large: 'large', larger: 'larger', largest: 'huge' };
    if (size && type !== 'body') patch.size = LYX_SIZE[size] ?? (/^\d/.test(size) ? `${parseFloat(size)}pt` : undefined);
    if (value('series') === 'bold' && patch.weight === undefined) patch.weight = 700;
    if (value('shape') === 'italic' || value('emph') === 'on') patch.shape = 'italic';
    if (value('noun') === 'on' || value('shape') === 'smallcaps') patch.case = 'smallcaps';
    const color = value('color');
    if (color?.startsWith('#')) patch.color = color.toLowerCase();
    const p = clean(patch);
    change(p, type === 'body' && p.font ? { kind: 'name', face: p.font } : undefined);
  };

  /* -------------------------------------------------------------- what each setting shows */

  const def = TYPE_DEFAULTS[type];
  const dflt: TextStyle = type === 'body'
    ? { ...bodyDefaults(markdown), weight: 400, size: `${base}pt` }
    : { size: def.size, weight: def.weight, align: def.align, display: def.display };
  const shown: TextStyle = (scope === 'document' ? pdf[type] : editor[type]) ?? {};
  const val = <K extends StyleKey>(k: K): TextStyle[K] => (shown[k] ?? dflt[k]) as TextStyle[K];
  const texOf = tex[type];
  const ownBodyFont = type === 'body' && ownFont !== FOLLOW_DOCUMENT;
  const originOf = (k: StyleKey): Origin => {
    if (scope === 'screen' && (screen[type]?.[k] !== undefined || (k === 'font' && ownBodyFont))) return 'screen';
    if (texOf?.keys.includes(k)) return 'latex';
    return doc[type]?.[k] !== undefined ? 'document' : 'default';
  };
  /** in the document's view: what this editor alone shows instead */
  const ownOf = (k: StyleKey): string | null => {
    if (scope !== 'document') return null;
    if (type === 'body' && k === 'font') return ownBodyFont ? editorFace(ownFont).label : null;
    const v = screen[type]?.[k];
    if (v === undefined) return null;
    return k === 'weight' ? weightLabel(v as number) : k === 'lineSpacing' ? `×${v}` : k === 'font' ? fontLabel(v as string) : String(v);
  };
  const dropOwn = (k: StyleKey) => {
    if (type === 'body' && k === 'font') { setPref('editorFont', FOLLOW_DOCUMENT); return; }
    const next: TextStyles = { ...screen, [type]: { ...(screen[type] ?? {}) } };
    delete next[type]![k];
    if (!Object.keys(next[type]!).length) delete next[type];
    setPref('screenStyles', next);
  };
  const row = (k: StyleKey | null, label: string, control: preact.ComponentChildren) => {
    const origin = k ? originOf(k) : 'default';
    const own = k ? ownOf(k) : null;
    const resettable = !!k && (scope === 'screen' ? origin === 'screen' : origin === 'document' || origin === 'latex');
    const custom = !!k && !!texOf?.custom.includes(k);
    return (
      <div class="ts-row" data-ts-row={k ?? label} data-origin={origin}>
        <div class="ts-label">
          <span>{label}</span>
          {origin === 'latex' && <span class={'ts-chip ts-chip-tex' + (custom ? ' custom' : '')} title={custom ? 'LaTeX in the preamble sets this in a way shown here as the default; changing it here replaces that LaTeX' : 'Set by LaTeX in the preamble, which has the last word in the PDF; changing it here replaces that LaTeX'}>LaTeX</span>}
          {origin === 'screen' && <span class="ts-chip ts-chip-own" title="Only in your editor: the PDF and other people's editors show the document's">Mine</span>}
          {resettable && <button type="button" class="ts-reset" title={scope === 'screen' ? 'Show the document’s again' : origin === 'latex' ? 'Back to LaTeX’s default — removes the preamble’s LaTeX for it' : 'Back to the default'} onClick={() => resetKey(k!)}>↺</button>}
        </div>
        <div class="ts-ctl">
          {control}
          {own !== null && <div class="ts-own">Your editor shows {own} <button type="button" class="ts-reset" title="Show the document’s in your editor too" onClick={() => dropOwn(k!)}>↺</button></div>}
        </div>
      </div>
    );
  };

  /* -------------------------------------------------------------- the font */

  const docBodyLabel = (): string => {
    const f = pdf.body?.font;
    if (f) return fontLabel(f);
    if (markdown || headerValue(headerLines, 'use_non_tex_fonts') === 'true') return 'Latin Modern';
    const cur = (k: string, dflt: string) => headerValue(headerLines, k) ?? dflt;
    const set = matchFontSet({ font_roman: cur('font_roman', '"default" "default"'), font_sans: cur('font_sans', '"default" "default"'), font_typewriter: cur('font_typewriter', '"default" "default"'), font_math: cur('font_math', '"auto" "auto"') });
    const name = fontValues(cur('font_roman', '"default"'))[0];
    return set?.label ?? (name && name !== 'default' ? name : 'Computer Modern');
  };
  const fontSections = (): FontSection[] => {
    if (type !== 'body') return [];
    if (scope === 'screen') return [{ title: 'Your editor', items: [
      { key: 'doc', label: 'As in the document', active: ownFont === FOLLOW_DOCUMENT, pick: () => setPref('editorFont', FOLLOW_DOCUMENT) },
      ...EDITOR_FACES.map(f => ({ key: f.id, label: f.label, hint: f.hint, fontFamily: f.text, active: ownFont === f.id, pick: () => setPref('editorFont', f.id) })),
    ] }];
    if (markdown) return [{ title: 'With their math fonts', items: MD_FONTS.map(f => ({ key: f.main, label: f.label, hint: f.hint, active: familyOf(pdf.body?.font) === f.main, pick: () => change({ font: f.main }, { kind: 'md', main: f.main, math: f.math }) })) }];
    return [{ title: 'LaTeX’s font sets', items: DOCUMENT_FONT_SETS.map(s => ({ key: s.id, label: s.label, hint: s.hint, fontFamily: editorFace(s.face).text, active: !pdf.body?.font && docBodyLabel() === s.label, pick: () => change({ font: undefined }, { kind: 'set', set: s }) })) }];
  };
  /** the font shown: a family or a font by name (its axes and features), or one of the document's own families */
  const shownFont: string | undefined = type === 'body' && scope === 'screen'
    ? (ownFont === FOLLOW_DOCUMENT ? pdf.body?.font : ownFont.startsWith(GOOGLE_FACE) ? ownFont.slice(GOOGLE_FACE.length) : undefined)
    : val('font');
  const fontName = type === 'body'
    ? (scope === 'screen' && ownBodyFont ? editorFace(ownFont).label : docBodyLabel())
    : shownFont ? fontLabel(shownFont) : 'The document’s';
  const pickFont = (font: string | null) => {
    if (type === 'body' && scope === 'screen') { setPref('editorFont', font ? GOOGLE_FACE + font : FOLLOW_DOCUMENT); return; }
    if (type === 'body') { change({ font: font ?? undefined }, font ? { kind: 'name', face: font } : { kind: 'default' }); return; }
    change({ font: font ?? undefined });
  };
  const family = familyOf(shownFont);
  const info = useFontInfo(family);
  const face = family && shownFont ? parseFace(shownFont.includes('|') ? shownFont : family) : null;
  /** a Google font with axes but its weight, or OpenType features to set */
  const extras = !!info && (info.axes.some(a => a.tag !== 'wght') || info.features.length > 0);

  /* -------------------------------------------------------------- weight */

  const wAxis = info?.axes.find(a => a.tag === 'wght');
  const weight = val('weight') ?? 400;
  const weightControl = () => {
    if (type === 'body' && scope === 'document' && !family) return <span class="ts-note">The document’s font has Regular and Bold; choose a font by name for other weights of the text.</span>;
    if (family && info === undefined) return <span class="ts-note">Loading {family}…</span>;
    if (wAxis) {
      const rungs = WEIGHTS.filter(w => w >= wAxis.min && w <= wAxis.max).map(w => ({ v: w, label: weightLabel(w) }));
      return <Slider min={wAxis.min} max={wAxis.max} step={1} value={weight} rungs={rungs} format={v => { const r = rungs.find(x => x.v === v); return `${r ? r.label + ' · ' : ''}${Math.round(v)}`; }} onChange={v => change({ weight: Math.round(v) })} />;
    }
    const stops = family && info ? (info.weights.length ? info.weights : [400]) : scope === 'screen' ? WEIGHTS : [400, 700];
    return <Rungs value={weight} rungs={stops.map(w => ({ v: w, label: weightLabel(w).replace('Extra ', 'X-') }))} onChange={v => change({ weight: v })} />;
  };

  /* -------------------------------------------------------------- the panel */

  const heading = isHeading(type);
  const runIn = heading && (val('display') ?? def.display) === 'run-in';
  const statements = texOf?.statements ?? [];
  const [showTex, setShowTex] = useState(false);
  useEffect(() => setShowTex(false), [type]);

  return (
    <div class="ts-panel" role="dialog" aria-label="Text styles" data-text-styles data-scope={scope}>
      <div class="ts-head"><b>Text styles</b><button type="button" class="ts-close" title="Close (Esc)" onClick={onClose}>✕</button></div>
      <div class="ts-scope">
        <span class="ts-seg ts-scope-seg">
          <button type="button" class={scope === 'document' ? 'on' : ''} data-ts-scope="document" onClick={() => setScope('document')}>Document &amp; PDF</button>
          <button type="button" class={scope === 'screen' ? 'on' : ''} data-ts-scope="screen" onClick={() => setScope('screen')}>Only my editor</button>
        </span>
        <div class="ts-scope-say">{scope === 'document' ? 'Saved in the document: its PDF and everyone’s editor show it.' : 'How your editor shows every document — the PDF and other people’s editors stay as they are.'}</div>
      </div>
      <div class="ts-types" role="tablist">
        {TEXT_TYPES.map(t => {
          const s = editor[t] ?? {};
          const d = TYPE_DEFAULTS[t];
          const f = s.font && !FAMILY_FONTS[s.font] ? parseFace(s.font.includes('|') ? s.font : s.font.replace(/[^A-Za-z0-9 ]/g, '')) : null;
          if (f) loadGoogleFont(f.family);
          return (
            <button key={t} type="button" role="tab" aria-selected={t === type} class={'ts-type' + (t === type ? ' on' : '')} data-ts-type={t} onClick={() => setType(t)}
              style={{
                fontFamily: f ? `'${f.family}', var(--editor-font)` : s.font === '@sans' ? 'var(--editor-sans-font, system-ui), sans-serif' : s.font === '@mono' ? 'var(--editor-mono-font, monospace), monospace' : 'var(--editor-font)',
                fontWeight: s.weight ?? d.weight, fontStyle: s.shape === 'italic' ? 'italic' : 'normal', color: s.color,
                fontVariant: s.case === 'smallcaps' ? 'small-caps' : undefined, textTransform: s.case === 'uppercase' ? 'uppercase' : undefined,
                fontSize: t === 'body' ? '1em' : `${Math.min(1.35, Math.max(0.85, sizePt(s.size ?? d.size, 10) / 10))}em`,
              }}>
              <span class="ts-type-name">{typeName(t, markdown)}</span>
              {tex[t] && <span class="ts-dot ts-dot-tex" title="LaTeX in the preamble sets some of this" />}
              {(screen[t] || (t === 'body' && ownFont !== FOLLOW_DOCUMENT)) && <span class="ts-dot ts-dot-own" title="Your editor shows some of this its own way" />}
            </button>
          );
        })}
      </div>
      {scope === 'document' && statements.length > 0 && (
        <div class="ts-banner" data-ts-latex>
          <div><b>LaTeX in the preamble</b> styles this in the PDF — the settings marked <span class="ts-chip ts-chip-tex">LaTeX</span>. Changing one here replaces that LaTeX.</div>
          <div class="ts-banner-acts">
            <button type="button" onClick={() => setShowTex(s => !s)}>{showTex ? 'Hide' : 'Show'} the LaTeX</button>
            <button type="button" data-ts-takeover onClick={replaceAll} title="Take these lines out of the preamble; the settings here keep what they did">Use these settings instead</button>
          </div>
          {showTex && <pre class="ts-tex">{statements.map(st => st.text).join('\n')}</pre>}
        </div>
      )}
      {notice && (
        <div class="ts-notice" data-ts-notice>
          <span>Replaced in the preamble: <code>{notice.statements[0].text.split('\n')[0].slice(0, 56)}</code>{notice.statements.length > 1 ? ` and ${notice.statements.length - 1} more` : ''}</span>
          <button type="button" onClick={undo}>Undo</button>
          <button type="button" class="ts-close" title="OK" onClick={() => setNotice(null)}>✕</button>
        </div>
      )}
      <div class="ts-body">
        {row('font', 'Font', (
          <>
            <FontButton label={fontName} face={face} markdown={markdown} sections={fontSections()} withFamilies={type !== 'body'} view={view} onFont={pickFont}
              onFamily={f => change({ font: f === 'sans' ? '@sans' : f === 'typewriter' ? '@mono' : f === 'roman' ? '@serif' : undefined })} />
            {face && extras && <FaceDetails face={face} onChange={f => pickFont(faceValue(f))} />}
          </>
        ))}
        {row('weight', 'Weight', weightControl())}
        {type === 'body' ? (
          <>
            {scope === 'document'
              ? row('size', 'Size', <Rungs value={parseFloat(val('size') ?? `${base}pt`) || base} rungs={[10, 11, 12].map(v => ({ v, label: v + ' pt' }))} onChange={v => change({ size: `${v}pt` })} />)
              : row(null, 'Size', <span class="ts-note">Your editor’s text zoom: Ctrl + and Ctrl − (the PDF keeps {base} pt)</span>)}
            {row('lineSpacing', 'Line spacing', (
              <Slider min={1} max={2.5} step={0.05} value={val('lineSpacing') ?? 1} rungs={SPACING_RUNGS}
                format={v => { const r = SPACING_RUNGS.find(x => Math.abs(x.v - v) < 0.004); return `${r && r.label !== String(v) ? r.label + ' · ' : ''}×${Math.round(v * 100) / 100}`; }}
                onChange={v => change({ lineSpacing: Math.round(v * 1000) / 1000 })} />
            ))}
            {row('align', 'Alignment', <Seg value={val('align') ?? 'left'} options={[['left', 'Left (ragged right)'], ['justify', 'Justified']]} onChange={v => change({ align: v as TextStyle['align'] })} />)}
            {row('color', 'Colour', <Colors value={val('color')} onChange={c => change({ color: c })} />)}
          </>
        ) : (
          <>
            {row('size', 'Size', (
              <Slider min={Math.round(base * 0.7)} max={Math.round(base * (type === 'title' ? 3 : 2.4))} step={0.5} value={sizePt(val('size') ?? def.size, base)}
                rungs={NAMED_SIZES.map(n => ({ v: sizePt(n, base), label: String(Math.round(sizePt(n, base))) }))}
                format={v => { const n = NAMED_SIZES.find(x => Math.abs(sizePt(x, base) - v) < 0.05); return `${n ? SIZE_NAMES[n] + ' · ' : ''}${Math.round(v * 10) / 10} pt`; }}
                onChange={v => { const named = NAMED_SIZES.find(n => Math.abs(sizePt(n, base) - v) < 0.05); change({ size: named ?? `${Math.round(v * 2) / 2}pt` }); }} />
            ))}
            {row('shape', 'Style', (
              <span class="ts-toggles">
                <button type="button" class={'ts-tog' + (val('shape') === 'italic' ? ' on' : '')} title="Italic" onClick={() => change({ shape: val('shape') === 'italic' ? 'upright' : 'italic' })}><i>I</i></button>
                <button type="button" class={'ts-tog' + (val('case') === 'smallcaps' ? ' on' : '')} title="Small capitals" onClick={() => change({ case: val('case') === 'smallcaps' ? 'normal' : 'smallcaps' })}><span style={{ fontVariant: 'small-caps' }}>Sc</span></button>
                <button type="button" class={'ts-tog' + (val('case') === 'uppercase' ? ' on' : '')} title="Capitals" onClick={() => change({ case: val('case') === 'uppercase' ? 'normal' : 'uppercase' })}>AA</button>
              </span>
            ))}
            {row('color', 'Colour', <Colors value={val('color')} onChange={c => change({ color: c })} />)}
            {!runIn && row('align', 'Alignment', (
              <Seg value={val('align') ?? def.align} options={[['left', 'Left'], ['center', 'Centred'], ['right', 'Right'], ...(type === 'quote' ? [['justify', 'Justified']] as [string, string][] : [])]}
                onChange={v => change({ align: v as TextStyle['align'] })} />
            ))}
            {row('spaceAbove', 'Space above', (
              <Slider min={0} max={36} step={0.5} value={lengthPt(val('spaceAbove'), base) ?? def.above} rungs={SPACE_RUNGS.map(v => ({ v, label: String(v) }))}
                format={v => (val('spaceAbove') ? `${v} pt` : `Default (≈${def.above} pt)`)} onChange={v => change({ spaceAbove: `${v}pt` })} />
            ))}
            {!runIn && type !== 'quote' && row('spaceBelow', 'Space below', (
              <Slider min={0} max={36} step={0.5} value={lengthPt(val('spaceBelow'), base) ?? def.below} rungs={SPACE_RUNGS.map(v => ({ v, label: String(v) }))}
                format={v => (val('spaceBelow') ? `${v} pt` : `Default (≈${def.below} pt)`)} onChange={v => change({ spaceBelow: `${v}pt` })} />
            ))}
            {heading && row('display', 'Placement', <Seg value={runIn ? 'run-in' : 'block'} options={[['block', 'Own line'], ['run-in', 'Run into the text']]} onChange={v => change({ display: v as TextStyle['display'] })} />)}
            {(heading || type === 'title') && !runIn && row('rule', 'Rule', <Seg value={val('rule') ?? 'none'} options={[['none', 'None'], ['below', 'Below'], ['above', 'Above']]} onChange={v => change({ rule: v as TextStyle['rule'] })} />)}
          </>
        )}
      </div>
      <div class="ts-foot">
        {view && <button type="button" onMouseDown={e => e.preventDefault()} onClick={match} title="Take the font, size, weight, italics and colour of the text where the cursor is">Match the text at the cursor</button>}
        <button type="button" data-ts-reset onClick={resetType}
          disabled={scope === 'screen' ? !screen[type] && !ownBodyFont : !doc[type] && !texOf}
          title={scope === 'screen' ? 'Your editor shows the document’s again' : texOf ? 'LaTeX’s default look — removes the preamble’s LaTeX for it too' : 'LaTeX’s default look'}>
          {scope === 'screen' ? `Reset ${typeName(type, markdown)} in my editor` : `Reset ${typeName(type, markdown)}`}
        </button>
      </div>
    </div>
  );
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

/** a rung at `p` % of a slider: its tick exactly there, its name centred on it — at the ends it reaches inwards */
const rungStyle = (p: number) => ({ left: `${p}%`, ...(p < 8 ? { transform: 'none', alignItems: 'flex-start' } : p > 92 ? { transform: 'translateX(-100%)', alignItems: 'flex-end' } : {}) });

/** a continuous slider whose knob snaps to its rungs (within 1.5 % of the range); the rungs labelled under it where they fit */
function Slider({ min, max, step, value, rungs, format, onChange }: { min: number; max: number; step: number; value: number; rungs: { v: number; label: string }[]; format: (v: number) => string; onChange: (v: number) => void }) {
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
      <div class="ts-slider-val">{format(v)}</div>
      <input type="range" min={min} max={max} step={step} value={v} onInput={e => { const x = snap(Number((e.target as HTMLInputElement).value)); setV(x); onChange(x); }} onKeyDown={e => e.stopPropagation()} />
      <div class="ff-rungs">
        {shown.map(r => (
          <button key={r.v} type="button" class={'ff-rung' + (Math.abs(r.v - v) < step / 2 ? ' on' : '')} style={rungStyle(r.p)}
            title={r.label} onClick={() => { setV(r.v); onChange(r.v); }}>{r.show ? <span>{r.label}</span> : null}</button>
        ))}
      </div>
    </div>
  );
}

/** a slider that only stops at its rungs */
function Rungs({ value, rungs, onChange }: { value: number; rungs: { v: number; label: string }[]; onChange: (v: number) => void }) {
  const nearest = rungs.reduce((best, r, k) => (Math.abs(r.v - value) < Math.abs(rungs[best].v - value) ? k : best), 0);
  const [i, setI] = useState(nearest);
  useEffect(() => setI(nearest), [nearest]);
  if (rungs.length < 2) return <span class="ts-note">{rungs[0]?.label ?? ''} only</span>;
  // (every stop has its tick; a name only where it does not run into the one before)
  let lastRight = -100;
  const named = rungs.map((r, k) => {
    const p = (k / (rungs.length - 1)) * 100, w = (r.label.length * 5.5 + 6) / 230 * 100;
    const [l, rt] = p < 8 ? [p, p + w] : p > 92 ? [p - w, p] : [p - w / 2, p + w / 2];
    const show = l >= lastRight;
    if (show) lastRight = rt;
    return show;
  });
  return (
    <div class="ts-slider">
      <div class="ts-slider-val">{rungs[i]?.label}</div>
      <input type="range" min={0} max={rungs.length - 1} step={1} value={i} onInput={e => { const k = Number((e.target as HTMLInputElement).value); setI(k); onChange(rungs[k].v); }} onKeyDown={e => e.stopPropagation()} />
      <div class="ff-rungs">
        {rungs.map((r, k) => (
          <button key={r.v} type="button" class={'ff-rung' + (k === i ? ' on' : '')} style={rungStyle(rungs.length > 1 ? (k / (rungs.length - 1)) * 100 : 0)}
            title={r.label} onClick={() => { setI(k); onChange(r.v); }}>{named[k] ? <span>{r.label}</span> : null}</button>
        ))}
      </div>
    </div>
  );
}

/** the style's font: a button opening the font list (lists of the style editor's own first) */
function FontButton({ label, face, markdown, sections, withFamilies, view, onFont, onFamily }: {
  label: string; face: FontFace | null; markdown: boolean; sections: FontSection[]; withFamilies: boolean; view: EditorView | null;
  onFont: (font: string | null) => void; onFamily: (family: string | null) => void;
}) {
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
  useEffect(() => { if (face) loadGoogleFont(face.family); }, [face?.family]);
  return (
    <span class="ts-font">
      <button ref={btn} type="button" class="ts-font-btn" data-ts-font onClick={() => setOpen(o => !o)} style={face ? { fontFamily: `'${face.family}', var(--ui-font)` } : undefined}>{label} ▾</button>
      {open && (
        <div ref={pop} class="tb-popup ff-pop ts-font-pop">
          <FontList family={null} current={face} markdown={markdown && !withFamilies} inDocument={view ? documentFaces(view) : []} sections={sections}
            onPick={family => { onFont(family); setOpen(false); }} onFamily={withFamilies ? f => { onFamily(f); setOpen(false); } : undefined} close={() => setOpen(false)} />
        </div>
      )}
    </span>
  );
}

/** a Google font's axes but its weight (a row of its own) and its OpenType features — folded under the font, open while any is set */
function FaceDetails({ face, onChange }: { face: FontFace; onChange: (f: FontFace) => void }) {
  const set = Object.keys(face.axes).some(k => k !== 'wght') || face.features.length > 0;
  return (
    <details class="ts-face" open={set}>
      <summary title="The font's design axes (width, optical size …) and OpenType features (old-style figures, small capitals, stylistic sets …)">Axes &amp; features{set ? ' · set' : ''}</summary>
      <FacePanel key={face.family} face={face} onChange={onChange} noWeight />
    </details>
  );
}
