/**
 * What a paragraph style is called on screen. The Classic interface shows LyX's layout names
 * (Standard, Itemize, LyX-Code …); the Modern one assumes nobody comes from LyX and says what a
 * Google Docs or Overleaf user would — the LaTeX name stays findable in the style picker's search.
 * The names stored in documents and used by commands never change.
 *
 * Headings: a .tex document always shows LaTeX's names (Section, Subsection …), in both interfaces;
 * a markdown document calls the same levels Heading 1 … Heading 5 (# … #####), as its toolbar does.
 */
import type { UiMode } from './uimode';

const PLAIN: Record<string, string> = {
  'Standard': 'Normal text',
  'Plain Layout': 'Plain text',
  'Itemize': 'Bullet list',
  'Enumerate': 'Numbered list',
  'Description': 'Description list',
  'Labeling': 'Labelled list',
  'LyX-Code': 'Code',
  'Bibliography': 'Bibliography item',
};

/** a markdown document's headings (#, ##, …), in both interfaces */
const MD_HEADINGS: Record<string, string> = {
  'Section': 'Heading 1', 'Subsection': 'Heading 2', 'Subsubsection': 'Heading 3', 'Paragraph': 'Heading 4', 'Subparagraph': 'Heading 5',
};

/** the style's name in this interface (and kind of document) */
export function styleLabel(name: string, mode: UiMode, markdown = false): string {
  if (markdown && MD_HEADINGS[name.replace(/\*$/, '')]) return MD_HEADINGS[name.replace(/\*$/, '')] + (name.endsWith('*') ? ' (unnumbered)' : '');
  if (mode !== 'modern') return name;
  if (PLAIN[name]) return PLAIN[name];
  // Section* / Subsection* …: LaTeX's unnumbered headings
  return name.endsWith('*') ? name.slice(0, -1) + ' (unnumbered)' : name;
}

/** what the picker's search matches: the shown name and LyX's own */
export function styleSearchText(name: string, mode: UiMode, markdown = false): string {
  return (styleLabel(name, mode, markdown) + ' ' + name).toLowerCase();
}
