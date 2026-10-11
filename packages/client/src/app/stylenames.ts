/**
 * What a paragraph style is called on screen. The Classic interface shows LyX's layout names
 * (Standard, Itemize, LyX-Code …); the Modern one assumes nobody comes from LyX and says what a
 * Google Docs or Overleaf user would — the LaTeX name stays findable in the style picker's search.
 * The names stored in documents and used by commands never change.
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

/** the style's name in this interface */
export function styleLabel(name: string, mode: UiMode): string {
  if (mode !== 'modern') return name;
  if (PLAIN[name]) return PLAIN[name];
  // Section* / Subsection* …: LaTeX's unnumbered headings
  return name.endsWith('*') ? name.slice(0, -1) + ' (unnumbered)' : name;
}

/** what the picker's search matches: the shown name and LyX's own */
export function styleSearchText(name: string, mode: UiMode): string {
  return (styleLabel(name, mode) + ' ' + name).toLowerCase();
}
