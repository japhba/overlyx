/**
 * The fonts OverLyX offers, for the two places a font is chosen. They are independent, like LyX's
 * screen fonts (Preferences) and document fonts (Document ▸ Settings):
 *
 *   EDITOR_FACES        the editor's text (Settings ▸ Editor ▸ Text font, per browser): Computer
 *                       Modern (CMU Serif), the text fonts of the OpenType math fonts listed on
 *                       https://tex.stackexchange.com/q/425098 and a few more, all served with the
 *                       client (fonts/web, scripts/build-editor-fonts.py) and fetched only once
 *                       chosen — except the computer's own Palatino and San Francisco.
 *   MATH_FONTS          the editor's formulas (Settings ▸ Editor ▸ Math font): KaTeX's own Computer
 *                       Modern, or one of those OpenType math fonts, taken apart by the build script
 *                       into faces that stand in for KaTeX's fonts glyph by glyph (KaTeX keeps its
 *                       layout: it cannot read a MATH table) — fonts/editorfont.ts, styles.css.
 *                       "Matching the text font" is the math font drawn for the text face.
 *   DOCUMENT_FONT_SETS  what the PDF is typeset in (Document ▸ Settings ▸ Fonts): LyX font names
 *                       (lib/latexfonts) of TeX fonts that come with TeX Live, each text font with the
 *                       math font made for it, so text and formulas agree. Written as LyX's
 *                       \font_roman / \font_sans / \font_typewriter / \font_math, so a .lyx file
 *                       opens with the same fonts in LyX.
 *
 * Each document font set names the editor face closest to it, for Settings ▸ Editor ▸ Text font ▸
 * "As in the document".
 */
import { TEXT_X_HEIGHT } from './web/metrics.gen';

export interface EditorFace {
  id: string;
  label: string;
  hint: string;
  /** CSS font-family of the text (Computer Modern stands in while a web font loads) */
  text: string;
  /** the sans-serif and typewriter families (Text Style ▸ Family) when the face has its own */
  sans?: string;
  mono?: string;
  /** the math font drawn for it (Math font ▸ "Matching the text font") */
  math: string;
  /** its x-height (em): formulas are sized to it */
  xHeight: number;
}

export interface MathFont {
  id: string;
  label: string;
  hint: string;
  /** taken apart into fonts/web/math/<id> (absent: KaTeX's own Computer Modern) */
  built?: string;
  /** the letters of formulas from the text face, the rest from `built` (a face that cannot be shipped: the system's San Francisco) */
  textLetters?: boolean;
}

const CM = '"CMU Serif", serif';
/** San Francisco where the system has it, SF Compact first on phones (styles.css --sf-font) */
const SF = 'var(--sf-font)';
/** Computer Modern's x-height, KaTeX's and every built math font's (scripts/build-editor-fonts.py) */
export const CM_X_HEIGHT = 0.4306;

export const DEFAULT_EDITOR_FACE = 'cm';
export const DEFAULT_MATH_FONT = 'cm';
/** Math font ▸ the math font drawn for the text face */
export const MATCH_TEXT = 'match';

/** a face served with the client: family "OLT <files>" (fonts/web/webfonts.css) */
function served(id: string, label: string, hint: string, math: string, extra: { files?: string; sans?: string; mono?: string } = {}): EditorFace {
  const files = extra.files ?? id;
  return { id, label, hint, math, text: `"OLT ${files}", ${CM}`, sans: extra.sans, mono: extra.mono, xHeight: TEXT_X_HEIGHT[files] ?? CM_X_HEIGHT };
}

export const EDITOR_FACES: EditorFace[] = [
  { id: 'cm', label: 'Computer Modern', hint: 'LaTeX’s own typeface (built in)', text: CM, math: 'cm', xHeight: CM_X_HEIGHT },
  served('newcm', 'New Computer Modern', 'Computer Modern in the heavier Book weight', 'newcm-book'),
  served('libertinus', 'Libertinus', 'Linux Libertine’s successor; serif, sans and mono', 'libertinus', { sans: '"OLT libertinus sans"', mono: '"OLT libertinus mono"' }),
  served('stix', 'STIX Two', 'a Times for science', 'stix2', { files: 'stix2' }),
  served('xits', 'XITS', 'STIX’s first version, a Times', 'xits'),
  served('termes', 'TeX Gyre Termes', 'a Times', 'termes'),
  served('pagella', 'TeX Gyre Pagella', 'a Palatino', 'pagella'),
  {
    id: 'palatino', label: 'Palatino (this computer’s)', hint: 'the Palatino of macOS and Windows; TeX Gyre Pagella elsewhere',
    text: `"Palatino Linotype", Palatino, "OLT pagella", "Book Antiqua", ${CM}`, math: 'pagella', xHeight: 0.469,
  },
  served('bonum', 'TeX Gyre Bonum', 'a Bookman', 'bonum'),
  served('schola', 'TeX Gyre Schola', 'a Century Schoolbook', 'schola'),
  served('dejavu', 'DejaVu Serif', 'Bitstream Vera’s serif', 'dejavu'),
  served('garamond', 'EB Garamond', 'Garamond', 'garamond'),
  served('crimson', 'Crimson Pro', 'an old-style book face', 'libertinus'),
  served('charis', 'Charis SIL', 'Charter, extended', 'xcharter'),
  served('xcharter', 'XCharter', 'Charter', 'xcharter'),
  served('erewhon', 'Erewhon', 'Utopia', 'erewhon'),
  served('kp', 'Kp Roman', 'the Kp fonts (Johannes Kepler)', 'kp'),
  served('concrete', 'Concrete', 'Knuth’s Concrete Roman (Concrete Mathematics)', 'concrete'),
  served('oldstandard', 'Old Standard', 'a 19th-century Modern', 'oldstandard'),
  served('neohellenic', 'GFS Neohellenic', 'with only slight serifs', 'neohellenic'),
  served('plex', 'IBM Plex Serif', 'IBM’s corporate serif', 'plex'),
  served('pl46', 'PL46', 'a Polish typeface of 1946 (no italic)', 'pl46'),
  served('fira', 'Fira Sans', 'sans-serif; typewriter Fira Mono', 'fira', { mono: '"OLT fira mono"' }),
  {
    // Fira Math is drawn to go with Fira Sans; San Francisco cannot be served, so its formulas take their letters from it
    id: 'sans', label: 'Sans-serif (this computer’s)', hint: 'San Francisco where the system has it (SF Compact on phones), else Fira Sans',
    text: `${SF}, "OLT fira", sans-serif`, mono: '"SF Mono", "OLT fira mono"', math: 'fira-text', xHeight: 0.52,
  },
  served('lato', 'Lato', 'sans-serif', 'lete'),
  served('notosans', 'Noto Sans', 'sans-serif, for every script', 'noto'),
  served('arsenal', 'Arsenal', 'sans-serif', 'arsenal'),
  served('luciole', 'Luciole', 'sans-serif drawn for readers with low vision', 'luciole'),
  served('pennstander', 'Pennstander', 'informal, handwriting-like', 'pennstander'),
];

const built = (id: string, label: string, hint: string): MathFont => ({ id, label, hint, built: id });

export const MATH_FONTS: MathFont[] = [
  { id: 'cm', label: 'Computer Modern', hint: 'KaTeX’s own (built in)' },
  built('lm', 'Latin Modern Math', 'Computer Modern as an OpenType math font'),
  built('newcm', 'New Computer Modern Math', 'Latin Modern extended'),
  built('newcm-book', 'New Computer Modern Math Book', 'in the heavier Book weight'),
  built('stix2', 'STIX Two Math', 'a Times'),
  built('xits', 'XITS Math', 'STIX’s first version'),
  built('termes', 'TeX Gyre Termes Math', 'a Times'),
  built('pagella', 'TeX Gyre Pagella Math', 'a Palatino'),
  built('asana', 'Asana Math', 'a Palatino (pxfonts)'),
  built('euler', 'Euler Math', 'Hermann Zapf’s upright AMS Euler'),
  built('bonum', 'TeX Gyre Bonum Math', 'a Bookman'),
  built('schola', 'TeX Gyre Schola Math', 'a Century Schoolbook'),
  built('dejavu', 'TeX Gyre DejaVu Math', 'DejaVu Serif'),
  built('libertinus', 'Libertinus Math', 'Libertinus'),
  built('garamond', 'Garamond Math', 'EB Garamond'),
  built('xcharter', 'XCharter Math', 'Charter'),
  built('erewhon', 'Erewhon Math', 'Utopia, Fourier’s symbols'),
  built('kp', 'KpMath', 'the Kp fonts'),
  built('kp-light', 'KpMath Light', 'the Kp fonts, light'),
  built('kp-sans', 'KpMath Sans', 'the Kp fonts, sans-serif'),
  built('concrete', 'Concrete Math', 'Concrete'),
  built('oldstandard', 'Old Standard Math', 'Old Standard'),
  built('neohellenic', 'GFS Neohellenic Math', 'GFS Neohellenic'),
  built('plex', 'IBM Plex Math', 'IBM Plex'),
  built('pl46', 'PL46 Math', 'PL46'),
  built('fira', 'Fira Math', 'sans-serif, Fira Sans'),
  { id: 'fira-text', label: 'Fira Math, letters from the text font', hint: 'the letters of the text face (San Francisco…), Fira Math’s symbols', built: 'fira', textLetters: true },
  built('lete', 'Lete Sans Math', 'sans-serif, Lato'),
  built('noto', 'Noto Sans Math', 'sans-serif, Noto Sans'),
  built('arsenal', 'Arsenal Math', 'sans-serif, Arsenal'),
  built('luciole', 'Luciole Math', 'sans-serif, for low vision'),
  built('pennstander', 'Pennstander Math', 'informal'),
];

/** Faces that were renamed: a preference saved under the old id keeps its face. */
const FORMER_FACES: Record<string, string> = { noto: 'sans' };

/** Settings ▸ Editor ▸ Text font: a face, or the face closest to the document's roman font */
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
  { id: 'times', label: 'Times', hint: 'with Helvetica, Courier and newtx math', roman: 'times', sans: 'helvet', typewriter: 'courier', math: 'newtxmath', sfScale: 92, face: 'termes' },
  { id: 'palatino', label: 'Palatino', hint: 'with Palatino math (mathpazo)', roman: 'palatino', sans: 'default', typewriter: 'default', math: 'auto', face: 'pagella' },
  { id: 'charter', label: 'Charter', hint: 'with Charter math (Mathdesign)', roman: 'md-charter', sans: 'default', typewriter: 'default', math: 'auto', face: 'xcharter' },
  { id: 'utopia', label: 'Utopia', hint: 'with Fourier math', roman: 'utopia', sans: 'default', typewriter: 'default', math: 'auto', face: 'erewhon' },
  { id: 'crimson', label: 'Crimson Pro', hint: 'with newtx math in Cochineal’s style', roman: 'CrimsonPro', sans: 'default', typewriter: 'default', math: 'cochineal-ntxm', face: 'crimson' },
];

/** Other LyX roman fonts (and non-TeX font names), mapped to the closest editor face. */
const ROMAN_FACES: Record<string, string> = {
  cmr: 'cm', lmodern: 'cm', lmr: 'cm', ae: 'cm', 'latin modern roman': 'cm', 'cmu serif': 'cm', 'new computer modern': 'newcm', newcomputermodern: 'newcm',
  libertine: 'libertinus', 'libertine-full': 'libertinus', 'libertinus-full': 'libertinus', 'libertinus serif': 'libertinus', 'linux libertine o': 'libertinus', 'linux libertine': 'libertinus',
  'stix two text': 'stix', stix2: 'stix', 'stix two': 'stix', xits: 'xits',
  times: 'termes', ptm: 'termes', mathptm: 'termes', tgtermes: 'termes', 'tex gyre termes': 'termes', 'times new roman': 'termes', 'nimbus roman': 'termes', tinos: 'termes',
  palatino: 'pagella', ppl: 'pagella', pplj: 'pagella', mathpple: 'pagella', tgpagella: 'pagella', 'tex gyre pagella': 'pagella', 'palatino linotype': 'palatino', p052: 'pagella',
  bookman: 'bonum', pbk: 'bonum', tgbonum: 'bonum', 'tex gyre bonum': 'bonum', newcent: 'schola', pnc: 'schola', tgschola: 'schola', 'tex gyre schola': 'schola', 'century schoolbook': 'schola',
  dejavuserif: 'dejavu', 'dejavu serif': 'dejavu', dejavuserifcondensed: 'dejavu',
  charter: 'xcharter', xcharter: 'xcharter', 'md-charter': 'xcharter', mdbch: 'xcharter', 'bitstream charter': 'xcharter', 'charis sil': 'charis',
  utopia: 'erewhon', futs: 'erewhon', futj: 'erewhon', 'md-utopia': 'erewhon', mdput: 'erewhon', erewhon: 'erewhon', heuristica: 'erewhon',
  cochineal: 'crimson', crimson: 'crimson', crimsonpro: 'crimson', crimsonpromedium: 'crimson', crimsonprolight: 'crimson', 'crimson pro': 'crimson', 'crimson text': 'crimson',
  garamondx: 'garamond', 'md-garamond': 'garamond', ugm: 'garamond', mdugm: 'garamond', 'eb garamond': 'garamond', ebgaramond: 'garamond',
  kpfonts: 'kp', 'kp roman': 'kp', ccfonts: 'concrete', 'cmu concrete': 'concrete', oldstandard: 'oldstandard', 'old standard': 'oldstandard',
  'gfs neohellenic': 'neohellenic', ibmplexserif: 'plex', 'ibm plex serif': 'plex',
};

export function editorFace(id: string): EditorFace {
  id = FORMER_FACES[id] ?? id;
  return EDITOR_FACES.find(f => f.id === id) ?? EDITOR_FACES[0];
}

export function mathFont(id: string): MathFont {
  return MATH_FONTS.find(f => f.id === id) ?? MATH_FONTS[0];
}

/** The math font shown for a Math font preference with a text face. */
export function resolvedMathFont(pref: string, face: string): MathFont {
  return mathFont(pref === MATCH_TEXT ? editorFace(face).math : pref);
}

/**
 * The size of formulas relative to the text: their x-height 1.1 times the text's, as KaTeX's
 * Computer Modern beside CMU Serif has always been.
 */
export function mathScale(face: EditorFace): number {
  return Math.round(1.1 * face.xHeight / CM_X_HEIGHT * 1000) / 1000;
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
