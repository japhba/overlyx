/**
 * A hyperlink's text with formulas in it: `\href{url}{see $x^2$}` in LaTeX, `[see $x^2$](url)` in
 * markdown. The text is typed as words with each formula between dollars; a hyperlink inset keeps it
 * as its `name`, LaTeX with `literal "true"` in a .tex document (the words escaped, the formulas as
 * they are) and the text itself in a markdown one (whose writer escapes the words).
 */

/** splits a link's text into words (even indices) and `$…$` formulas (odd indices) */
const MATH_SPLIT = /(\$[^$]+\$)/;

/** whether the text holds a formula (`$…$`) */
export function linkHasMath(text: string): boolean {
  return MATH_SPLIT.test(text);
}

/** the parts of a link's text: words and formulas (`math`: the LaTeX between the dollars) */
export type LinkTextPart = { text: string } | { math: string };
export function linkTextParts(text: string): LinkTextPart[] {
  return text.split(MATH_SPLIT).flatMap((part, i): LinkTextPart[] => (i % 2 ? [{ math: part.slice(1, -1) }] : part ? [{ text: part }] : []));
}

const escapeWords = (s: string) => s.replace(/[\\&_$%#{}^~]/g, ch =>
  ch === '\\' ? '\\textbackslash{}' : ch === '^' ? '\\^{}' : ch === '~' ? '\\textasciitilde{}' : '\\' + ch);
const unescapeWords = (s: string) => s.replace(/\\textbackslash\{\}|\\\^\{\}|\\textasciitilde\{\}|\\([&_$%#{}])/g, (m, ch: string | undefined) =>
  ch ?? (m === '\\textbackslash{}' ? '\\' : m === '\\^{}' ? '^' : '~'));

/** a link's text as LaTeX: the words escaped, the formulas as they are */
export function linkTextLatex(text: string): string {
  return text.split(MATH_SPLIT).map((part, i) => (i % 2 ? part : escapeWords(part))).join('');
}

/**
 * A hyperlink inset's name as its text is shown and typed: a LaTeX name (`literal`) with its words
 * unescaped — unless it holds other LaTeX (`\textbf{…}`), which is shown as it is.
 */
export function linkShownText(name: string, literal: boolean): string {
  if (!literal || !/[\\{}]/.test(name)) return name;
  const shown = name.split(MATH_SPLIT).map((part, i) => (i % 2 ? part : unescapeWords(part))).join('');
  return linkTextLatex(shown) === name ? shown : name;
}

/**
 * The name and `literal` flag a hyperlink inset gets for the text typed (`markdown`: of a markdown
 * document, whose links keep the text itself). Words alone stay a plain name in a .tex document.
 */
export function linkNameFor(text: string, markdown: boolean): { name: string; literal: boolean } {
  if (markdown) return { name: text, literal: true };
  return linkHasMath(text) ? { name: linkTextLatex(text), literal: true } : { name: text, literal: false };
}
