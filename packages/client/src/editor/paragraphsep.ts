/**
 * Document ▸ Settings ▸ Paragraph separation in the editor. "Vertical space"
 * (`\paragraph_separation skip`) is what the PDF gets as \parindent 0pt and \parskip \defskip:
 * paragraphs start flush left, a gap between them (styles.css, `html[data-par-sep]`). "Indentation"
 * (the default) indents a paragraph's first line. Both shells report their document's settings here,
 * next to setDocumentFonts (tests/parity.test.ts) — and its headings (setDocumentHeadings).
 */
import { HEADING_LEVELS, TEXT_TYPES, TYPE_LAYOUTS, SIZE_EM, headingDisplay, stylesOfHeader, parseFace, faceCss, type HeadingLevel, type TextStyle, type TextStyles, type TextType } from '@overlyx/core';
import { faceForFontName } from '../fonts/catalog';
import { loadGoogleFont } from '../fonts/googlefont';

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
  if (justified(headerLines)) root.dataset.justify = ''; else delete root.dataset.justify;
}

/**
 * Whether the body text is justified, as in the PDF (styles.css html[data-justify]): a markdown
 * document says so in `\overlyx_justify` (its `justify: true`, a body style, or \justifying in its
 * header-includes — core md/typesetting.ts; ragged right otherwise); a .tex document is justified
 * unless Document ▸ Settings (or Text styles ▸ Normal text) set it ragged right, as LaTeX and LyX do.
 */
export function justified(headerLines: readonly string[]): boolean {
  const md = headerLines.find(l => l.startsWith('\\overlyx_justify '));
  if (md) return md.slice(17).trim() === 'true';
  return (headerLines.find(l => l.startsWith('\\justification '))?.slice(15).trim() ?? 'true') !== 'false';
}

/**
 * The text styles (core textstyles.ts: the header's `\overlyx_styles` — a markdown document's
 * `headings` / `styles` and what its header-includes set by hand, a .tex document's Text styles):
 * drawn as the PDF sets them — font, size, weight, shape, small caps / capitals, colour, alignment,
 * a rule, the space around, and a heading that runs into the paragraph after it (inline, the space
 * above it on the paragraph before, a block pseudo-element ending the line). One <style> element,
 * rewritten when the settings change.
 */
const LAYOUT: Record<HeadingLevel, string> = { section: 'Section', subsection: 'Subsection', subsubsection: 'Subsubsection', paragraph: 'Paragraph' };
const selOf = (t: TextType) => (t === 'body' ? '.lyx-editor' : TYPE_LAYOUTS[t].map(l => `.lyx-editor > .lyx-par[data-layout="${l}"]`).join(', '));

/** a style's font as CSS (a font by name, a family the editor carries, or a Google font of that name) */
function fontCss(font: string): Record<string, string> {
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
  if (st.font) for (const [k, v] of Object.entries(fontCss(st.font))) d.push(`${k}: ${v}`);
  if (st.size || runIn) d.push(`font-size: ${sizeCss(st.size ?? 'normal')}`);
  if (st.weight) d.push(`font-weight: ${st.weight === 'bold' ? 700 : 400}`);
  if (st.shape) d.push(`font-style: ${st.shape === 'italic' ? 'italic' : 'normal'}`);
  if (st.case === 'smallcaps') d.push('font-variant: small-caps');
  if (st.case === 'uppercase') d.push('text-transform: uppercase');
  if (st.case === 'normal') d.push('font-variant: normal', 'text-transform: none');
  if (st.color) d.push(`color: ${st.color}`);
  return d;
}

export function stylesCss(styles: TextStyles): string {
  const out: string[] = [];
  for (const type of TEXT_TYPES) {
    const st = styles[type];
    if (!st || !Object.keys(st).length) continue;
    const sel = selOf(type);
    const level = (HEADING_LEVELS as readonly string[]).includes(type) ? type as HeadingLevel : null;
    // (LaTeX's \paragraph runs in unless it says otherwise, as in the PDF)
    const runIn = !!level && headingDisplay(level, st) === 'run-in';
    if (type === 'body') {
      // the body's colour is the document's (headings, quotes, the title have their own on top); its
      // font, size and alignment are the document's settings (setDocumentFonts, data-justify)
      if (st.color) out.push(`html .lyx-editor { color: ${st.color}; }`);
      continue;
    }
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

/** the document's text styles into the page (one <style> element; none without styles) */
export function setDocumentHeadings(headerLines: readonly string[]): void {
  if (typeof document === 'undefined') return;
  const css = stylesCss(stylesOfHeader(headerLines));
  let el = document.getElementById('ol-heading-styles') as HTMLStyleElement | null;
  if (!css) { el?.remove(); return; }
  if (!el) { el = document.createElement('style'); el.id = 'ol-heading-styles'; document.head.appendChild(el); }
  if (el.textContent !== css) el.textContent = css;
}
