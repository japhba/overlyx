/**
 * Document ▸ Settings ▸ Paragraph separation in the editor. "Vertical space"
 * (`\paragraph_separation skip`) is what the PDF gets as \parindent 0pt and \parskip \defskip:
 * paragraphs start flush left, a gap between them (styles.css, `html[data-par-sep]`). "Indentation"
 * (the default) indents a paragraph's first line. Both shells report their document's settings here,
 * next to setDocumentFonts (tests/parity.test.ts) — and its headings (setDocumentHeadings).
 */
import { HEADING_LEVELS, headingStyles, type HeadingLevel, type HeadingStyles } from '@overlyx/core/md/typesetting.ts';
import { faceForFontName } from '../fonts/catalog';

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

/**
 * A markdown document's heading styles (`headings:` in its front matter, core md/typesetting.ts; the
 * parse puts them in its settings as `\overlyx_headings {json}`): drawn as the PDF sets them — font,
 * size, weight, shape, small caps / capitals, colour, centring, a rule, and a heading that runs into
 * the paragraph after it (inline, the space above it on the paragraph before, a block pseudo-element
 * ending the line). One <style> element, rewritten when the settings change; none for other documents.
 */
const LAYOUT: Record<HeadingLevel, string> = { section: 'Section', subsection: 'Subsection', subsubsection: 'Subsubsection', paragraph: 'Paragraph' };
const SIZE_EM = { small: 0.9, normal: 1, large: 1.2, larger: 1.44, huge: 1.73 } as const;

export function headingCss(styles: HeadingStyles): string {
  const out: string[] = [];
  for (const level of HEADING_LEVELS) {
    const st = styles[level];
    const sel = `.lyx-editor > .lyx-par[data-layout="${LAYOUT[level]}"]`;
    // (LaTeX's \paragraph runs in unless it says otherwise, as in the PDF)
    const runIn = (st.display ?? (level === 'paragraph' ? 'run-in' : 'block')) === 'run-in';
    const d: string[] = [];
    const face = st.font ? faceForFontName(st.font) : null;
    if (st.font) d.push(`font-family: ${face ? face.text : JSON.stringify(st.font) + ', sans-serif'}`);
    if (st.size || runIn) d.push(`font-size: ${SIZE_EM[st.size ?? 'normal']}em`);
    if (st.weight) d.push(`font-weight: ${st.weight === 'bold' ? 700 : 400}`);
    if (st.shape) d.push(`font-style: ${st.shape === 'italic' ? 'italic' : 'normal'}`);
    if (st.case === 'smallcaps') d.push('font-variant: small-caps');
    if (st.case === 'uppercase') d.push('text-transform: uppercase');
    if (st.color) d.push(`color: ${st.color}`);
    if (!runIn && st.align === 'center') d.push('text-align: center');
    if (!runIn && st.rule === 'below') d.push('border-bottom: 1px solid currentColor', 'padding-bottom: 0.15em');
    if (!runIn && st.rule === 'above') d.push('border-top: 1px solid currentColor', 'padding-top: 0.25em');
    if (st.spaceAbove) d.push(`margin-top: ${st.spaceAbove}`);
    if (!runIn && st.spaceBelow) {
      d.push(`margin-bottom: ${st.spaceBelow}`);
      // the space below is the heading's alone (the paragraph's own gap above would collapse into it, the larger winning)
      out.push(`html ${sel} + .lyx-par { margin-top: 0 !important; }`);
    }
    if (d.length) out.push(`${sel} { ${d.join('; ')}; }`);
    // the number is the heading's, in its colour (styles.css greys section numbers)
    if (st.color) out.push(`${sel}[data-label]::before { color: inherit; }`);
    if (runIn) {
      const next = `${sel} + .lyx-par[data-layout="Standard"]`;
      out.push(`${sel}:has(+ .lyx-par[data-layout="Standard"]) { display: inline; margin: 0 0.7em 0 0; padding-top: 0; padding-bottom: 0; }`,
        `${next} { display: inline; margin: 0; }`,
        `${next}::after { content: ''; display: block; height: 0.9em; }`,
        // (over the paragraph spacing's own rules: the space above the heading is this paragraph's)
        // (one chain of siblings: :has() inside :has() is not allowed, and the rule would be dropped)
        `html .lyx-editor > .lyx-par:has(+ .lyx-par[data-layout="${LAYOUT[level]}"] + .lyx-par[data-layout="Standard"]) { margin-bottom: ${st.spaceAbove ?? '0.9em'} !important; }`);
    }
  }
  return out.join('\n');
}

export function setDocumentHeadings(headerLines: readonly string[]): void {
  if (typeof document === 'undefined') return;
  const line = headerLines.find(l => l.startsWith('\\overlyx_headings '))?.slice(18).trim() ?? '';
  let styles: HeadingStyles | null = null;
  try { styles = line === 'run-in' ? headingStyles('run-in') : line ? JSON.parse(line) as HeadingStyles : null; } catch { styles = null; }
  const css = styles ? headingCss(styles) : '';
  let el = document.getElementById('ol-heading-styles') as HTMLStyleElement | null;
  if (!css) { el?.remove(); return; }
  if (!el) { el = document.createElement('style'); el.id = 'ol-heading-styles'; document.head.appendChild(el); }
  if (el.textContent !== css) el.textContent = css;
}
