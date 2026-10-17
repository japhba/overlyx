/**
 * Document ▸ Settings ▸ Paragraph separation in the editor. "Vertical space"
 * (`\paragraph_separation skip`) is what the PDF gets as \parindent 0pt and \parskip \defskip:
 * paragraphs start flush left, a gap between them (styles.css, `html[data-par-sep]`). "Indentation"
 * (the default) indents a paragraph's first line. Both shells report their document's settings here,
 * next to setDocumentFonts (tests/parity.test.ts) — and its headings (setDocumentHeadings).
 */
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
 * A markdown document's `headings: run-in` (core md/typesetting.ts; `\overlyx_headings run-in` in its
 * settings): a heading runs into the paragraph after it, as the PDF sets it (styles.css,
 * `html[data-headings]`).
 */
export function setDocumentHeadings(headerLines: readonly string[]): void {
  if (typeof document === 'undefined') return;
  const root = document.documentElement;
  if (headerLines.includes('\\overlyx_headings run-in')) root.dataset.headings = 'run-in'; else delete root.dataset.headings;
}
