/**
 * The fonts OverLyX offers, for the two places a font is chosen. They are independent, like LyX's
 * screen fonts (Preferences) and document fonts (Document ▸ Settings):
 *
 *   EDITOR_FACES        what the editor shows the text in (Settings ▸ Editor ▸ Font, per browser).
 *                       Computer Modern is bundled; the others are web fonts from Google Fonts,
 *                       fetched only once chosen. Formulas take their letters and digits from the same
 *                       face and their symbols from the closest OpenType math font (KaTeX keeps its
 *                       layout and its large operators and delimiters) — fonts/editorfont.ts, styles.css.
 *   DOCUMENT_FONT_SETS  what the PDF is typeset in (Document ▸ Settings ▸ Fonts): LyX font names
 *                       (lib/latexfonts) of TeX fonts that come with TeX Live, each text font with the
 *                       math font made for it, so text and formulas agree. Written as LyX's
 *                       \font_roman / \font_sans / \font_typewriter / \font_math, so a .lyx file
 *                       opens with the same fonts in LyX.
 *
 * Each document font set names the editor face closest to it, for Settings ▸ Editor ▸ Font ▸ "As in
 * the document".
 */

export interface EditorFace {
  id: string;
  label: string;
  hint: string;
  /** CSS font-family of the text (Computer Modern stands in while a web font loads or when offline) */
  text: string;
  /** the sans-serif and typewriter families (Text Style ▸ Family) when the face has its own */
  sans?: string;
  mono?: string;
  /** formulas: upright letters, digits and operators from the text face, then the math font's symbols */
  math?: string;
  /** formulas: the italic of variables */
  mathItalic?: string;
  /** Google Fonts css2 `family=` values to load */
  google?: string[];
  /** size of formulas relative to the text (KaTeX's own is 1.21, OverLyX's Computer Modern 1.1) */
  mathScale?: number;
}

const CM = '"CMU Serif", serif';
const STIX_MATH = 'STIX Two Math';
const LIBERTINUS_MATH = 'Libertinus Math';
const FOUR = ':ital,wght@0,400;0,700;1,400;1,700';

export const DEFAULT_EDITOR_FACE = 'cm';

export const EDITOR_FACES: EditorFace[] = [
  { id: 'cm', label: 'Computer Modern', hint: 'LaTeX’s own typeface, formulas in KaTeX’s Computer Modern (built in)', text: CM },
  {
    id: 'libertinus', label: 'Libertinus', hint: 'serif, sans and mono, with Libertinus Math', text: `"Libertinus Serif", ${CM}`,
    sans: '"Libertinus Sans"', mono: '"Libertinus Mono"', math: `"Libertinus Serif", "${LIBERTINUS_MATH}"`, mathItalic: '"Libertinus Serif"',
    google: ['Libertinus Serif' + FOUR, 'Libertinus Sans:ital,wght@0,400;0,700;1,400', 'Libertinus Mono', LIBERTINUS_MATH], mathScale: 1.05,
  },
  {
    id: 'stix', label: 'STIX Two', hint: 'a Times, with STIX Two Math', text: `"STIX Two Text", ${CM}`,
    math: `"STIX Two Text", "${STIX_MATH}"`, mathItalic: '"STIX Two Text"', google: ['STIX Two Text' + FOUR, STIX_MATH], mathScale: 1,
  },
  {
    id: 'palatino', label: 'Palatino', hint: 'the Palatino of this computer (macOS, Windows; P052 or TeX Gyre Pagella on Linux), with STIX Two Math',
    text: `"Palatino Linotype", Palatino, "TeX Gyre Pagella", "URW Palladio L", P052, "Book Antiqua", ${CM}`,
    math: `"Palatino Linotype", Palatino, "TeX Gyre Pagella", "URW Palladio L", P052, "Book Antiqua", "${STIX_MATH}"`,
    mathItalic: '"Palatino Linotype", Palatino, "TeX Gyre Pagella", "URW Palladio L", P052, "Book Antiqua"', google: [STIX_MATH], mathScale: 1,
  },
  {
    id: 'charis', label: 'Charis', hint: 'Charter’s design, with STIX Two Math', text: `"Charis SIL", ${CM}`,
    math: `"Charis SIL", "${STIX_MATH}"`, mathItalic: '"Charis SIL"', google: ['Charis SIL' + FOUR, STIX_MATH], mathScale: 1,
  },
  {
    id: 'crimson', label: 'Crimson Pro', hint: 'an old-style book face, with STIX Two Math', text: `"Crimson Pro", ${CM}`,
    math: `"Crimson Pro", "${STIX_MATH}"`, mathItalic: '"Crimson Pro"', google: ['Crimson Pro' + FOUR, STIX_MATH], mathScale: 1.05,
  },
  {
    id: 'garamond', label: 'EB Garamond', hint: 'Garamond, with Libertinus Math', text: `"EB Garamond", ${CM}`,
    math: `"EB Garamond", "${LIBERTINUS_MATH}"`, mathItalic: '"EB Garamond"', google: ['EB Garamond' + FOUR, LIBERTINUS_MATH], mathScale: 1.05,
  },
  {
    id: 'noto', label: 'Noto Sans', hint: 'a sans-serif for the screen, with Noto Sans Math', text: '"Noto Sans", "CMU Serif", sans-serif',
    mono: '"Noto Sans Mono"', math: '"Noto Sans", "Noto Sans Math"', mathItalic: '"Noto Sans"',
    google: ['Noto Sans' + FOUR, 'Noto Sans Mono', 'Noto Sans Math'], mathScale: 1,
  },
];

/** Settings ▸ Editor ▸ Font: a face, or the face closest to the document's roman font */
export const FOLLOW_DOCUMENT = 'document';

export interface DocumentFontSet {
  id: string;
  label: string;
  hint: string;
  /** LyX font names (lib/latexfonts); 'default' / 'auto' leave the choice to LaTeX or to the roman font */
  roman: string;
  sans: string;
  typewriter: string;
  math: string;
  /** \font_sf_scale for the sans font (percent) */
  sfScale?: number;
  /** the closest editor face */
  face: string;
}

export const DOCUMENT_FONT_SETS: DocumentFontSet[] = [
  { id: 'cm', label: 'Computer Modern', hint: 'LaTeX’s default', roman: 'default', sans: 'default', typewriter: 'default', math: 'auto', face: 'cm' },
  { id: 'lmodern', label: 'Latin Modern', hint: 'Computer Modern with complete accented letters', roman: 'lmodern', sans: 'default', typewriter: 'default', math: 'auto', face: 'cm' },
  { id: 'libertinus', label: 'Libertinus', hint: 'serif, sans and mono, with Libertinus Math', roman: 'libertinus', sans: 'default', typewriter: 'default', math: 'libertinusmath', face: 'libertinus' },
  { id: 'times', label: 'Times', hint: 'with Helvetica, Courier and newtx math', roman: 'times', sans: 'helvet', typewriter: 'courier', math: 'newtxmath', sfScale: 92, face: 'stix' },
  { id: 'palatino', label: 'Palatino', hint: 'with Palatino math (mathpazo)', roman: 'palatino', sans: 'default', typewriter: 'default', math: 'auto', face: 'palatino' },
  { id: 'charter', label: 'Charter', hint: 'with Charter math (Mathdesign)', roman: 'md-charter', sans: 'default', typewriter: 'default', math: 'auto', face: 'charis' },
  { id: 'utopia', label: 'Utopia', hint: 'with Fourier math', roman: 'utopia', sans: 'default', typewriter: 'default', math: 'auto', face: 'charis' },
  { id: 'crimson', label: 'Crimson Pro', hint: 'with newtx math in Cochineal’s style', roman: 'CrimsonPro', sans: 'default', typewriter: 'default', math: 'cochineal-ntxm', face: 'crimson' },
];

/** Other LyX roman fonts (and non-TeX font names), mapped to the closest editor face. */
const ROMAN_FACES: Record<string, string> = {
  cmr: 'cm', lmodern: 'cm', lmr: 'cm', ae: 'cm', 'latin modern roman': 'cm', 'cmu serif': 'cm', 'new computer modern': 'cm',
  libertine: 'libertinus', 'libertinus serif': 'libertinus', 'linux libertine o': 'libertinus', 'linux libertine': 'libertinus',
  times: 'stix', ptm: 'stix', tgtermes: 'stix', 'tex gyre termes': 'stix', 'times new roman': 'stix', 'stix two text': 'stix', 'nimbus roman': 'stix', tinos: 'stix',
  palatino: 'palatino', ppl: 'palatino', tgpagella: 'palatino', 'tex gyre pagella': 'palatino', 'palatino linotype': 'palatino', p052: 'palatino',
  charter: 'charis', xcharter: 'charis', 'md-charter': 'charis', mdbch: 'charis', 'charis sil': 'charis', 'bitstream charter': 'charis',
  utopia: 'charis', futs: 'charis', 'md-utopia': 'charis',
  cochineal: 'crimson', crimsonpro: 'crimson', crimsonpromedium: 'crimson', crimsonprolight: 'crimson', 'crimson pro': 'crimson', 'crimson text': 'crimson',
  garamondx: 'garamond', 'md-garamond': 'garamond', 'eb garamond': 'garamond',
};

export function editorFace(id: string): EditorFace {
  return EDITOR_FACES.find(f => f.id === id) ?? EDITOR_FACES[0];
}

/** The quoted values of a font header line: `"libertinus" "default"` → ['libertinus', 'default']. */
export function fontValues(value: string): string[] {
  const out: string[] = [];
  for (const m of value.matchAll(/"([^"]*)"|(\S+)/g)) out.push(m[1] ?? m[2]);
  return out;
}

function headerValue(headerLines: string[], key: string): string {
  return headerLines.find(l => l.startsWith('\\' + key + ' '))?.slice(key.length + 2) ?? '';
}

/**
 * The editor face closest to a document's roman font: its font set's face, else a known relative,
 * else Computer Modern. With non-TeX fonts (fontspec) the system font name counts.
 */
export function documentFace(headerLines: string[]): string {
  const [tex = 'default', nonTex = 'default'] = fontValues(headerValue(headerLines, 'font_roman'));
  const name = headerValue(headerLines, 'use_non_tex_fonts') === 'true' ? nonTex : tex;
  const set = DOCUMENT_FONT_SETS.find(s => s.roman === name);
  return set?.face ?? ROMAN_FACES[name.toLowerCase()] ?? DEFAULT_EDITOR_FACE;
}

/** The font set a document's settings amount to, or undefined when they are something else. */
export function matchFontSet(values: { font_roman: string; font_sans: string; font_typewriter: string; font_math: string }): DocumentFontSet | undefined {
  const first = (v: string, dflt: string) => fontValues(v)[0] || dflt;
  const rm = first(values.font_roman, 'default'), sf = first(values.font_sans, 'default'), tt = first(values.font_typewriter, 'default'), math = first(values.font_math, 'auto');
  return DOCUMENT_FONT_SETS.find(s => s.roman === rm && s.sans === sf && s.typewriter === tt && s.math === math);
}

/** The header values for a font set; the second (non-TeX) name of each value is kept. */
export function fontSetValues(set: DocumentFontSet, current: { font_roman: string; font_sans: string; font_typewriter: string; font_math: string; font_sf_scale: string }): Record<string, string> {
  const pair = (tex: string, cur: string, dflt: string) => `"${tex}" "${fontValues(cur)[1] ?? dflt}"`;
  const [, sfNonTex = '100'] = fontValues(current.font_sf_scale);
  return {
    font_roman: pair(set.roman, current.font_roman, 'default'),
    font_sans: pair(set.sans, current.font_sans, 'default'),
    font_typewriter: pair(set.typewriter, current.font_typewriter, 'default'),
    font_math: pair(set.math, current.font_math, 'auto'),
    font_sf_scale: `${set.sfScale ?? 100} ${sfNonTex}`,
  };
}

/** The Google Fonts stylesheet for a face ('' for a built-in one). */
export function googleFontsUrl(face: EditorFace): string {
  if (!face.google?.length) return '';
  return 'https://fonts.googleapis.com/css2?' + face.google.map(f => 'family=' + f.replace(/ /g, '+')).join('&') + '&display=swap';
}
