/**
 * Document ▸ Settings ▸ Paragraph separation in the editor. "Vertical space"
 * (`\paragraph_separation skip`) is what the PDF gets as \parindent 0pt and \parskip \defskip:
 * paragraphs start flush left, a gap between them (styles.css, `html[data-par-sep]`). "Indentation"
 * (the default) indents a paragraph's first line. Both shells report their document's settings here,
 * next to setDocumentFonts (tests/parity.test.ts) — and its text styles (setDocumentHeadings).
 */
import {
  HEADING_LEVELS, TEXT_TYPES, TYPE_LAYOUTS, SIZE_EM, FAMILY_FONTS, headingDisplay, styleLayers, pdfStyles, mergeStyles, bodyDefaults, parseFace, faceCss,
  type HeadingLevel, type TextStyle, type TextStyles, type TextType, type TexLayer,
} from '@overlyx/core';
import { faceForFontName, FOLLOW_DOCUMENT, GOOGLE_FACE } from '../fonts/catalog';
import { loadGoogleFont } from '../fonts/googlefont';
import { getPrefs, subscribePrefs } from '../prefs';

const SKIPS = new Set(['smallskip', 'medskip', 'bigskip', 'halfline', 'fullline']);

/** The gap between paragraphs, or null when they are indented instead. A length of its own draws as medskip. */
export function paragraphSkip(headerLines: readonly string[]): string | null {
  const value = (key: string) => headerLines.find(l => l.startsWith('\\' + key + ' '))?.slice(key.length + 2).trim();
  if (value('paragraph_separation') !== 'skip') return null;
  const skip = value('defskip') ?? 'medskip';
  return SKIPS.has(skip) ? skip : 'medskip';
}

export function setDocumentParagraphs(headerLines: readonly string[]): void {
  if (typeof document === 'undefined') return;
  const skip = paragraphSkip(headerLines);
  const root = document.documentElement;
  if (skip) root.dataset.parSep = skip; else delete root.dataset.parSep;
}

/* ------------------------------------------------------------------ text styles */

/**
 * The text styles as the editor draws them (core textstyles.ts): the PDF's — the document's
 * settings (`\overlyx_styles`, a markdown document's front matter, a .tex document's settings) under
 * what the preamble's own LaTeX sets — and over them the person's own for this editor
 * (prefs.screenStyles, prefs.editorFont: Text styles ▸ My editor). Font, size, weight, shape, small
 * caps / capitals, colour, alignment, a rule, the space around, a heading that runs into the paragraph
 * after it (inline, the space above it on the paragraph before, a block pseudo-element ending the
 * line), the body's line spacing (--ol-line-stretch), justification (html[data-justify]). One <style>
 * element, rewritten when the settings, the preferences or the style editor's live changes change.
 */
const LAYOUT: Record<HeadingLevel, string> = { section: 'Section', subsection: 'Subsection', subsubsection: 'Subsubsection', paragraph: 'Paragraph' };
const selOf = (t: TextType) => (t === 'body' ? '.lyx-editor' : TYPE_LAYOUTS[t].map(l => `.lyx-editor > .lyx-par[data-layout="${l}"]`).join(', '));

/** a style's font as CSS (the document's own families, a font by name, a family the editor carries, or a Google font of that name) */
function fontCss(font: string): Record<string, string> {
  if (FAMILY_FONTS[font]) return { 'font-family': font === '@sans' ? 'var(--editor-sans-font, system-ui), sans-serif' : font === '@mono' ? 'var(--editor-mono-font, monospace), monospace' : 'var(--editor-font)' };
  if (font.includes('|')) {
    const f = parseFace(font);
    if (!f) return {};
    loadGoogleFont(f.family);
    return faceCss(f, 'var(--editor-font)');
  }
  const face = faceForFontName(font);
  if (!face) loadGoogleFont(font);
  return { 'font-family': face ? face.text : JSON.stringify(font) + ', var(--editor-font)' };
}

export const sizeCss = (size: string) => (SIZE_EM[size] ? `${SIZE_EM[size]}em` : `calc(var(--ol-pt, 1.333px) * ${parseFloat(size)} * var(--ol-text-scale, 1))`);

function declarations(st: TextStyle, runIn: boolean): string[] {
  const d: string[] = [];
  if (st.font) for (const [k, v] of Object.entries(fontCss(st.font))) if (k !== 'font-weight') d.push(`${k}: ${v}`);
  if (st.size || runIn) d.push(`font-size: ${sizeCss(st.size ?? 'normal')}`);
  if (st.weight !== undefined) d.push(`font-weight: ${st.weight}`);
  if (st.shape) d.push(`font-style: ${st.shape === 'italic' ? 'italic' : 'normal'}`);
  if (st.case === 'smallcaps') d.push('font-variant: small-caps');
  if (st.case === 'uppercase') d.push('text-transform: uppercase');
  if (st.case === 'normal') d.push('font-variant: normal', 'text-transform: none');
  if (st.color) d.push(`color: ${st.color}`);
  return d;
}

/** the CSS of the styles the editor draws; `bodyFont`: the body's font by name when it is drawn (its axes and features) */
export function stylesCss(styles: TextStyles, bodyFont?: string | null): string {
  const out: string[] = [];
  for (const type of TEXT_TYPES) {
    const st = styles[type];
    if (type === 'body') {
      // the body: its colour, weight, line spacing; its font's axes and features (the family is the
      // editor's text font: fonts/editorfont.ts); justification is html[data-justify]
      const d: string[] = [];
      if (st?.color) d.push(`color: ${st.color}`);
      if (st?.weight !== undefined && st.weight !== 400) d.push(`font-weight: ${st.weight}`);
      if (st?.lineSpacing && st.lineSpacing !== 1) d.push(`--ol-line-stretch: ${st.lineSpacing}`);
      const f = bodyFont?.includes('|') ? parseFace(bodyFont) : null;
      if (f) for (const [k, v] of Object.entries(faceCss(f))) if (k !== 'font-family' && k !== 'font-weight') d.push(`${k}: ${v}`);
      if (d.length) out.push(`html .lyx-editor:not(.ol-layout) { ${d.join('; ')}; }`);
      // (bold text in heavy text: heavier still)
      if (st?.weight !== undefined && st.weight >= 600) out.push('html .lyx-editor:not(.ol-layout) .lyx-series-bold { font-weight: 900; }');
      continue;
    }
    if (!st || !Object.keys(st).length) continue;
    const sel = selOf(type);
    const level = (HEADING_LEVELS as readonly string[]).includes(type) ? type as HeadingLevel : null;
    // (LaTeX's \paragraph runs in unless it says otherwise, as in the PDF)
    const runIn = !!level && headingDisplay(level, st) === 'run-in';
    const d = declarations(st, runIn);
    if (!runIn && st.align) d.push(`text-align: ${st.align === 'justify' ? 'justify' : st.align}`);
    if (!runIn && st.rule === 'below') d.push('border-bottom: 1px solid currentColor', 'padding-bottom: 0.15em');
    if (!runIn && st.rule === 'above') d.push('border-top: 1px solid currentColor', 'padding-top: 0.25em');
    if (st.spaceAbove) d.push(`margin-top: ${st.spaceAbove}`);
    if (!runIn && st.spaceBelow) {
      d.push(`margin-bottom: ${st.spaceBelow}`);
      // the space below is the text's alone (the paragraph's own gap above would collapse into it, the larger winning)
      out.push(...TYPE_LAYOUTS[type].map(l => `html .lyx-editor > .lyx-par[data-layout="${l}"] + .lyx-par { margin-top: 0 !important; }`));
    }
    if (d.length) out.push(`html ${sel.split(', ').join(', html ')} { ${d.join('; ')}; }`);
    // the number is the heading's, in its colour (styles.css greys section numbers)
    if (level && st.color) out.push(`${TYPE_LAYOUTS[type].map(l => `.lyx-editor > .lyx-par[data-layout="${l}"][data-label]::before`).join(', ')} { color: inherit; }`);
    if (runIn) {
      const lay = LAYOUT[level!];
      const next = `.lyx-editor > .lyx-par[data-layout="${lay}"] + .lyx-par[data-layout="Standard"]`;
      out.push(`.lyx-editor > .lyx-par[data-layout="${lay}"]:has(+ .lyx-par[data-layout="Standard"]) { display: inline; margin: 0 0.7em 0 0; padding-top: 0; padding-bottom: 0; }`,
        `${next} { display: inline; margin: 0; }`,
        `${next}::after { content: ''; display: block; height: 0.9em; }`,
        // (over the paragraph spacing's own rules: the space above the heading is this paragraph's)
        // (one chain of siblings: :has() inside :has() is not allowed, and the rule would be dropped)
        `html .lyx-editor > .lyx-par:has(+ .lyx-par[data-layout="${lay}"] + .lyx-par[data-layout="Standard"]) { margin-bottom: ${st.spaceAbove ?? '0.9em'} !important; }`);
    }
  }
  return out.join('\n');
}

/** the layers the editor draws: the document's, its LaTeX's, the PDF's (both), this editor's own, and what the editor shows */
export interface EditorStyleLayers { document: TextStyles; tex: TexLayer; pdf: TextStyles; screen: TextStyles; editor: TextStyles; markdown: boolean }

let header: readonly string[] = [];
/** the style editor's changes, drawn before they are saved (app/TextStyles.tsx) */
let preview: { document?: TextStyles; tex?: TexLayer; screen?: TextStyles } | null = null;

export function editorStyleLayers(headerLines: readonly string[] = header): EditorStyleLayers {
  const l = styleLayers(headerLines);
  const document = preview?.document ?? l.document, tex = preview?.tex ?? l.tex;
  const pdf = preview ? pdfStyles(document, tex) : l.pdf;
  const screen = preview?.screen ?? getPrefs().screenStyles ?? {};
  return { document, tex, pdf, screen, editor: mergeStyles(pdf, screen), markdown: l.markdown };
}

/** the body's font by name the editor draws (its axes and features): this editor's own, else the PDF's */
function drawnBodyFont(layers: EditorStyleLayers): string | null {
  const own = getPrefs().editorFont;
  if (own && own !== FOLLOW_DOCUMENT) return own.startsWith(GOOGLE_FACE) ? own.slice(GOOGLE_FACE.length) : null;
  return layers.pdf.body?.font ?? null;
}

function render(): void {
  if (typeof document === 'undefined') return;
  const layers = editorStyleLayers();
  const root = document.documentElement;
  const align = layers.editor.body?.align ?? bodyDefaults(layers.markdown).align;
  if (align === 'justify') root.dataset.justify = ''; else delete root.dataset.justify;
  const css = stylesCss(layers.editor, drawnBodyFont(layers));
  let el = document.getElementById('ol-heading-styles') as HTMLStyleElement | null;
  if (!css) { el?.remove(); return; }
  if (!el) { el = document.createElement('style'); el.id = 'ol-heading-styles'; document.head.appendChild(el); }
  if (el.textContent !== css) el.textContent = css;
}

/** the document's text styles into the page (one <style> element; none without styles), justification too */
export function setDocumentHeadings(headerLines: readonly string[]): void {
  header = headerLines;
  render();
}

/** the style editor's changes, drawn at once (null: what the document and the preferences say) */
export function previewTextStyles(p: { document?: TextStyles; tex?: TexLayer; screen?: TextStyles } | null): void {
  preview = p;
  render();
}

subscribePrefs(() => render());
