/**
 * Light normalisation of math source before output. LyX re-serialises math
 * from its internal representation; the one transformation that matters for
 * compilation is that math-only commands used inside text-mode arguments
 * (\text{...}, \mbox{...}, ...) are wrapped in \ensuremath{...}.
 */
import type { MathSymbolDB } from './symbols.ts';

const TEXT_MODE_CMDS = new Set(['text', 'textrm', 'textbf', 'textit', 'textsf', 'texttt', 'textsc', 'textnormal', 'textup', 'mbox', 'intertext', 'shortintertext', 'hbox']);

/** Commands that are fine in text mode and must not be wrapped. */
const TEXT_OK = new Set([
  'ensuremath', 'textbackslash', 'LaTeX', 'TeX', 'LyX', 'ldots', 'dots', 'textsuperscript', 'textsubscript', 'emph', 'textbf', 'textit',
  'textrm', 'textsf', 'texttt', 'textsc', 'text', 'mbox', 'hspace', 'vspace', 'quad', 'qquad', 'small', 'footnotesize', 'scriptsize',
  'tiny', 'large', 'Large', 'normalsize', 'protect', 'label', 'ref', 'cite', 'citep', 'citet', 'eqref', 'index', 'footnote', 'and', 'or',
  'textcolor', 'color', 'underline', 'uline', 'sout', 'textendash', 'textemdash', 'textquoteleft', 'textquoteright', 'textquotedblleft',
  'textquotedblright', 'textdegree', 'S', 'P', 'dag', 'ddag', 'copyright', 'pounds', 'textasciitilde', 'textasciicircum', 'textbar', 'textless', 'textgreater',
  'newline', 'linebreak', 'hfill', 'thinspace', 'negthinspace', 'enspace', 'enskip', 'noindent', 'par', 'textvisiblespace', 'raggedright', 'centering', 'raggedleft',
  'textipa', 'lyxarrow', 'lyxmathsym', 'nobreakdash',
]);

function isMathCommand(name: string, db: MathSymbolDB, macros: Set<string>): boolean {
  if (TEXT_OK.has(name)) return false;
  if (macros.has(name)) return true;
  if (/^(math(bf|rm|cal|bb|it|sf|tt|frak|scr|ds|normal)|bm|boldsymbol|frac|dfrac|tfrac|sqrt|hat|bar|vec|tilde|dot|ddot|overline|widehat|widetilde|left|right|sum|prod|int|lim|log|exp|sin|cos|tan|max|min|operatorname|langle|rangle|cdot|times|pm|mp|infty|partial|nabla|to|leq|geq|neq|approx|sim|simeq|equiv|propto|in|notin|subset|subseteq|cup|cap|forall|exists|ell|hbar|top|bot|perp|circ|bullet|star|dagger|ast|vert|Vert|lvert|rvert|lVert|rVert|lfloor|rfloor|lceil|rceil|mathrel|mathbin|mathop|stackrel|overset|underset|binom|coloneqq|eqqcolon)$/.test(name)) return true;
  if (db.has(name)) return true;
  // greek letters and other single-symbol commands known to lib/symbols are covered by db.has
  return false;
}

/** Read a balanced {...} group starting at s[i] === '{'; returns end index (exclusive). */
function groupEnd(s: string, i: number): number {
  let depth = 0;
  for (let j = i; j < s.length; j++) {
    const c = s[j];
    if (c === '\\') { j++; continue; }
    if (c === '{') depth++;
    else if (c === '}') { depth--; if (depth === 0) return j + 1; }
  }
  return s.length;
}

/** Wrap math-only commands (with their brace arguments) in \ensuremath inside a text-mode argument. */
function fixTextArg(arg: string, db: MathSymbolDB, macros: Set<string>): string {
  let out = '';
  let i = 0;
  while (i < arg.length) {
    const c = arg[i];
    if (c === '\\') {
      const m = /^\\([A-Za-z]+)/.exec(arg.slice(i));
      if (!m) { out += arg.slice(i, i + 2); i += 2; continue; }
      const name = m[1];
      let j = i + m[0].length;
      if (TEXT_MODE_CMDS.has(name) && arg[j] === '{') {
        // nested text-mode argument
        const end = groupEnd(arg, j);
        out += '\\' + name + '{' + fixTextArg(arg.slice(j + 1, end - 1), db, macros) + '}';
        i = end;
        continue;
      }
      if (isMathCommand(name, db, macros)) {
        // include following brace groups, optional args and sub/superscripts
        while (j < arg.length) {
          if (arg[j] === '{') j = groupEnd(arg, j);
          else if (arg[j] === '[') { const k = arg.indexOf(']', j); j = k < 0 ? arg.length : k + 1; }
          else if (arg[j] === '^' || arg[j] === '_') { j++; if (arg[j] === '{') j = groupEnd(arg, j); else if (arg[j] === '\\') { const mm = /^\\[A-Za-z]+/.exec(arg.slice(j)); j += mm ? mm[0].length : 2; } else j++; }
          else break;
        }
        out += '\\ensuremath{' + arg.slice(i, j) + '}';
        i = j;
        continue;
      }
      out += m[0];
      i = j;
      continue;
    }
    out += c;
    i++;
  }
  return out;
}

/** Apply the \ensuremath normalisation to a formula's LaTeX source. */
export function normalizeMath(latex: string, db: MathSymbolDB, macros: Set<string>): string {
  if (!/\\(text|textrm|textbf|textit|textsf|texttt|textsc|textnormal|textup|mbox|intertext|shortintertext|hbox)\{/.test(latex)) return latex;
  let out = '';
  let i = 0;
  while (i < latex.length) {
    if (latex[i] === '\\') {
      const m = /^\\([A-Za-z]+)\{/.exec(latex.slice(i));
      if (m && TEXT_MODE_CMDS.has(m[1])) {
        const start = i + m[0].length - 1;
        const end = groupEnd(latex, start);
        out += '\\' + m[1] + '{' + fixTextArg(latex.slice(start + 1, end - 1), db, macros) + '}';
        i = end;
        continue;
      }
      out += latex.slice(i, i + 2);
      i += 2;
      continue;
    }
    out += latex[i];
    i++;
  }
  return out;
}
