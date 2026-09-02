/**
 * Layout knowledge used by the editor UI (fallback when the server cannot describe the
 * document class; the server's layout descriptions take precedence when available).
 */
import type { LayoutInfo } from '../api';

export const STANDARD_LAYOUTS: LayoutInfo[] = [
  { name: 'Standard', category: 'Text', latexType: 'Paragraph' },
  { name: 'Plain Layout', category: 'Text', latexType: 'Paragraph' },
  { name: 'Title', category: 'FrontMatter', latexType: 'Command', latexName: 'title' },
  { name: 'Author', category: 'FrontMatter', latexType: 'Command', latexName: 'author' },
  { name: 'Date', category: 'FrontMatter', latexType: 'Command', latexName: 'date' },
  { name: 'Abstract', category: 'FrontMatter', latexType: 'Environment', latexName: 'abstract' },
  { name: 'Part', category: 'Sectioning', latexType: 'Command', tocLevel: -1, isNumbered: true },
  { name: 'Chapter', category: 'Sectioning', latexType: 'Command', tocLevel: 0, isNumbered: true },
  { name: 'Section', category: 'Sectioning', latexType: 'Command', tocLevel: 1, isNumbered: true },
  { name: 'Subsection', category: 'Sectioning', latexType: 'Command', tocLevel: 2, isNumbered: true },
  { name: 'Subsubsection', category: 'Sectioning', latexType: 'Command', tocLevel: 3, isNumbered: true },
  { name: 'Paragraph', category: 'Sectioning', latexType: 'Command', tocLevel: 4, isNumbered: true },
  { name: 'Subparagraph', category: 'Sectioning', latexType: 'Command', tocLevel: 5, isNumbered: true },
  { name: 'Part*', category: 'Unnumbered', latexType: 'Command', tocLevel: -1 },
  { name: 'Chapter*', category: 'Unnumbered', latexType: 'Command', tocLevel: 0 },
  { name: 'Section*', category: 'Unnumbered', latexType: 'Command', tocLevel: 1 },
  { name: 'Subsection*', category: 'Unnumbered', latexType: 'Command', tocLevel: 2 },
  { name: 'Subsubsection*', category: 'Unnumbered', latexType: 'Command', tocLevel: 3 },
  { name: 'Paragraph*', category: 'Unnumbered', latexType: 'Command', tocLevel: 4 },
  { name: 'Subparagraph*', category: 'Unnumbered', latexType: 'Command', tocLevel: 5 },
  { name: 'Itemize', category: 'List', latexType: 'Item_Environment', labelType: 'Itemize' },
  { name: 'Enumerate', category: 'List', latexType: 'Item_Environment', labelType: 'Enumerate' },
  { name: 'Description', category: 'List', latexType: 'Item_Environment', labelType: 'Manual' },
  { name: 'Labeling', category: 'List', latexType: 'List_Environment', labelType: 'Manual' },
  { name: 'Quote', category: 'Text', latexType: 'Environment' },
  { name: 'Quotation', category: 'Text', latexType: 'Environment' },
  { name: 'Verse', category: 'Text', latexType: 'Environment' },
  { name: 'LyX-Code', category: 'Text', latexType: 'Environment' },
  { name: 'Bibliography', category: 'BackMatter', latexType: 'Bib_Environment', labelType: 'Bibliography' },
  { name: 'Address', category: 'FrontMatter', latexType: 'Command' },
  { name: 'Right Address', category: 'FrontMatter', latexType: 'Command' },
];

const SECTION_LEVEL: Record<string, number> = {
  Part: -1, Chapter: 0, Section: 1, Subsection: 2, Subsubsection: 3, Paragraph: 4, Subparagraph: 5,
};

export function sectionLevel(layout: string): number | null {
  const base = layout.replace(/\*$/, '');
  return base in SECTION_LEVEL ? SECTION_LEVEL[base] : null;
}
/**
 * The heading layout one level up (delta -1) or down (+1) from `layout` (a * is kept), or null at
 * the ends. `layouts`: the class's layouts — an article has no Chapter, so Section promotes to Part.
 */
export function shiftLayout(layout: string, delta: -1 | 1, layouts?: LayoutInfo[] | null): string | null {
  const starred = layout.endsWith('*');
  const base = layout.replace(/\*$/, '');
  const ladder = Object.keys(SECTION_LEVEL).filter(k => !layouts || layouts.some(l => l.name === k) || k === base);
  const i = ladder.indexOf(base);
  if (i < 0) return null;
  const next = ladder[i + delta];
  return next ? next + (starred ? '*' : '') : null;
}
export function isNumberedSection(layout: string): boolean {
  return sectionLevel(layout) !== null && !layout.endsWith('*');
}
export function isHeadingLayout(layout: string, layouts?: LayoutInfo[] | null): boolean {
  if (sectionLevel(layout) !== null) return true;
  const li = layouts?.find(l => l.name === layout);
  if (li?.latexType === 'Command') return true;
  return ['Title', 'Author', 'Date', 'Address', 'Right Address', 'Affiliation', 'Author Email', 'Author URL', 'Keywords'].includes(layout);
}
export function isListLayout(layout: string): boolean {
  return ['Itemize', 'Enumerate', 'Description', 'Labeling', 'List'].includes(layout);
}
/** LyX Paragraph::getMaxDepthAfter: only an environment paragraph lets the next one nest deeper. */
export function isEnvironmentLayout(layout: string, layouts?: LayoutInfo[] | null): boolean {
  const lt = layouts?.find(l => l.name === layout)?.latexType ?? STANDARD_LAYOUTS.find(l => l.name === layout)?.latexType;
  return !!lt && lt.includes('Environment');
}

/** Layout to use for the paragraph created by Enter (LyX: headings -> Standard; lists keep). */
export function nextLayout(layout: string, inInset: boolean, layouts?: LayoutInfo[] | null): string {
  const def = inInset ? 'Plain Layout' : 'Standard';
  if (isHeadingLayout(layout, layouts)) return def;
  if (layout === 'Abstract') return layout;
  return layout;
}

export const ENUM_STYLES = [
  (n: number) => `${n}.`,
  (n: number) => `(${String.fromCharCode(96 + ((n - 1) % 26) + 1)})`,
  (n: number) => roman(n) + '.',
  (n: number) => `${String.fromCharCode(64 + ((n - 1) % 26) + 1)}.`,
];
export const ITEMIZE_BULLETS = ['•', '–', '∗', '·'];

export function roman(n: number): string {
  const map: [number, string][] = [[1000, 'm'], [900, 'cm'], [500, 'd'], [400, 'cd'], [100, 'c'], [90, 'xc'], [50, 'l'], [40, 'xl'], [10, 'x'], [9, 'ix'], [5, 'v'], [4, 'iv'], [1, 'i']];
  let out = '';
  for (const [v, s] of map) while (n >= v) { out += s; n -= v; }
  return out;
}

/** Human-readable inset button labels, mirroring LyX. */
export function insetLabel(name: string, arg: string, params?: string[]): string {
  switch (name) {
    case 'Note':
      return arg === 'Comment' ? 'Comment' : arg === 'Greyedout' ? 'Greyed out' : 'Note';
    case 'ERT': return 'TeX Code';
    case 'Foot': return 'foot';
    case 'Marginal': return 'margin';
    case 'Float': return 'Float: ' + cap(arg);
    case 'Wrap': return 'Wrap: ' + cap(arg);
    case 'Caption': return 'Caption';
    case 'Box': return arg === 'Frameless' ? 'Box' : `Box: ${arg}`;
    case 'Branch': return 'Branch: ' + arg;
    case 'Flex': return arg || 'Flex';
    case 'Argument': return 'Arg ' + arg;
    case 'Index': return 'Idx';
    case 'listings': return 'Listing';
    case 'script': return arg === 'superscript' ? 'sup' : 'sub';
    case 'Phantom': return arg || 'Phantom';
    case 'IPA': return 'IPA';
    case 'Preview': return 'Preview';
    default: return name + (arg ? ' ' + arg : '');
  }
}

function cap(s: string): string { return s ? s[0].toUpperCase() + s.slice(1) : s; }
