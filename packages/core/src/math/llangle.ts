/**
 * Double angle brackets ⟪ ⟫ (`\llangle` … `\rrangle`).
 *
 * Neither LaTeX nor LyX know these delimiters (stmaryrd only has \llbracket); OverLyX offers
 * them in the delimiter toolbar and, the first time they are used in a document, adds this
 * definition to the LaTeX preamble. It makes all three forms compile with symmetric, correctly
 * scaled brackets: plain `\llangle x \rrangle`, `\left\llangle … \right\rrangle` and
 * `\bigl\llangle … \Biggr\rrangle` (plus mathtools' \DeclarePairedDelimiter). Since \left/\right
 * accept a single glyph only, the scalable bracket is built from two nested \left…\right pairs;
 * \left / \right are wrapped to notice \llangle / \rrangle, the second closing \right is supplied
 * by \aftergroup when the inner pair closes (so \bigl\llangle, which ends in \right., works too;
 * amsmath and the kernel build \bigr\rrangle with \left as well, so \left handles \rrangle too).
 */
export const LLANGLE_PREAMBLE_MARKER = '% OverLyX: double angle brackets';

/** Definition of the plain symbols (only when the document does not define them itself). */
export const LLANGLE_DEFINE = `\\providecommand{\\llangle}{\\langle\\mkern-4.5mu\\langle}
\\providecommand{\\rrangle}{\\rangle\\mkern-4.5mu\\rangle}`;

/** Makes \left\llangle … \right\rrangle and \bigl\llangle … \bigr\rrangle work whatever \llangle itself is. */
export const LLANGLE_SCALABLE = `\\makeatletter
\\let\\ol@left=\\left
\\let\\ol@right=\\right
\\def\\ol@rr{}
\\newcommand*{\\ol@dclose}{\\@ifnextchar\\ol@rr{\\mkern-4.5mu\\ol@right\\rangle\\@gobble}{\\ol@right.}}
\\protected\\def\\left{\\@ifnextchar\\llangle{\\ol@dleft}{\\@ifnextchar\\rrangle{\\ol@dleftr}{\\ol@left}}}
\\def\\ol@dleft\\llangle{\\ol@left\\langle\\mkern-4.5mu\\ol@left\\langle\\aftergroup\\ol@dclose}
\\def\\ol@dleftr\\rrangle{\\ol@left\\rangle\\mkern-4.5mu\\ol@left\\rangle\\aftergroup\\ol@dclose}
\\protected\\def\\right{\\@ifnextchar\\rrangle{\\ol@dright}{\\ol@right}}
\\def\\ol@dright\\rrangle{\\ol@right\\rangle\\ol@rr}
\\makeatother`;

/** The preamble snippet to add: with the symbol definition unless the document already has one. */
export function llanglePreamble(alreadyDefined: boolean): string {
  return `${LLANGLE_PREAMBLE_MARKER} \\llangle … \\rrangle (plain, \\left…\\right and \\bigl…\\bigr)\n` + (alreadyDefined ? '' : LLANGLE_DEFINE + '\n') + LLANGLE_SCALABLE;
}
/** Full snippet (definition + scalable forms). */
export const LLANGLE_PREAMBLE = llanglePreamble(false);

/** Is OverLyX's snippet already in this preamble? */
export function hasLlangleSnippet(preamble: string): boolean { return preamble.includes(LLANGLE_PREAMBLE_MARKER); }

/** Does this preamble (or a macro table) already define \llangle? */
export function definesLlangle(preamble: string, macroNames: Iterable<string> = []): boolean {
  if (preamble.includes(LLANGLE_PREAMBLE_MARKER)) return true;
  if (/\\(newcommand|renewcommand|providecommand|def|DeclareMathDelimiter|let)\s*\*?\s*\{?\\llangle\b/.test(preamble)) return true;
  if (/\\usepackage(\[[^\]]*\])?\{[^}]*\b(MnSymbol|fdsymbol|mathabx)\b/.test(preamble)) return true;
  for (const n of macroNames) if (n === 'llangle') return true;
  return false;
}
