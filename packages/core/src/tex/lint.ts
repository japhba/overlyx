/**
 * A structural LaTeX linter for text as it is being typed: the mistakes that make the parser
 * turn a document into raw LaTeX (ERT) or that TeX itself refuses, each with the offset of the
 * culprit so an editor can point at the line —
 *
 *  - a brace without a partner (the first unclosed `{`, or the first stray `}`),
 *  - `\begin{x}` without `\end{x}`, `\end{x}` closing a different environment, a stray `\end`,
 *  - a `$` left open (inline math cannot run past a blank line: the pair that would is broken there),
 *  - `\[` without `\]` and the other way round.
 *
 * `maskOpaque` blanks what must not be read as LaTeX first: `%` comments, `\verb…`, the arguments
 * of `\url` / `\href` / `\path` (a `%` or a brace in a URL is literal), and verbatim-like
 * environments (verbatim, lstlisting, minted, comment, …) — the false alarms that stopped
 * correct edits from being applied. Total and text-only: never throws, no layouts needed.
 */

export interface LintIssue {
  code: 'brace-unclosed' | 'brace-stray' | 'env-unclosed' | 'env-mismatch' | 'env-stray' | 'math-unclosed' | 'display-unclosed' | 'display-stray';
  message: string;
  /** where the culprit is in the text */
  offset: number;
  severity: 'error';
}

/** environments whose content is not LaTeX */
const OPAQUE_ENVS = new Set(['verbatim', 'verbatim*', 'Verbatim', 'Verbatim*', 'BVerbatim', 'LVerbatim', 'lstlisting', 'minted', 'comment', 'alltt', 'filecontents', 'filecontents*', 'tikzpicture']);
/** commands whose (first) brace argument is not LaTeX */
const OPAQUE_ARG_CMDS = new Set(['url', 'href', 'path', 'nolinkurl', 'lstinline', 'mintinline', 'verbatiminput', 'lstinputlisting', 'inputminted', 'includegraphics', 'input', 'include', 'bibliography', 'addbibresource']);

const isLetter = (c: string): boolean => (c >= 'a' && c <= 'z') || (c >= 'A' && c <= 'Z');

/** the end (exclusive) of the brace group starting at `open` (which must be `{`); the text length when it never closes */
function groupEnd(s: string, open: number): number {
  let depth = 0;
  for (let i = open; i < s.length; i++) {
    const c = s[i];
    if (c === '\\') { i++; continue; }
    if (c === '{') depth++;
    else if (c === '}') { depth--; if (depth === 0) return i + 1; }
  }
  return s.length;
}

/**
 * `text` with everything that is not LaTeX to be read replaced by spaces (newlines kept, so
 * lines and offsets are unchanged): comments, `\verb`, the URL-like arguments, verbatim-like
 * environments.
 */
export function maskOpaque(text: string): string {
  const out = text.split('');
  const blank = (from: number, to: number) => { for (let k = from; k < to && k < out.length; k++) if (out[k] !== '\n') out[k] = ' '; };
  let i = 0;
  while (i < text.length) {
    const c = text[i];
    if (c === '\\') {
      // a control word: \verb<delim>…<delim>, \url{…}, \begin{verbatim}…\end{verbatim}
      let j = i + 1;
      while (j < text.length && isLetter(text[j])) j++;
      const name = text.slice(i + 1, j);
      if (name === 'verb') {
        if (text[j] === '*') j++;
        const delim = text[j];
        if (delim && delim !== '\n') { const end = text.indexOf(delim, j + 1); const stop = end < 0 ? text.length : end + 1; blank(j, stop); i = stop; continue; }
      } else if (OPAQUE_ARG_CMDS.has(name)) {
        let k = j;
        if (text[k] === '*') k++;
        if (text[k] === '[') { const e = text.indexOf(']', k); if (e >= 0) k = e + 1; }
        if (text[k] === '{') { const end = groupEnd(text, k); blank(k + 1, end - 1); i = end; continue; }
      } else if (name === 'begin' && text[j] === '{') {
        const close = text.indexOf('}', j);
        const env = close >= 0 ? text.slice(j + 1, close) : '';
        if (OPAQUE_ENVS.has(env)) {
          const endTag = `\\end{${env}}`;
          const end = text.indexOf(endTag, close + 1);
          const stop = end < 0 ? text.length : end + endTag.length;
          blank(close + 1, end < 0 ? text.length : end);
          i = stop; continue;
        }
      }
      i = Math.max(j, i + 2);   // `\%`, `\{`: the escaped character is not read as a delimiter
      continue;
    }
    if (c === '%') {
      let j = text.indexOf('\n', i);
      if (j < 0) j = text.length;
      blank(i, j);
      i = j; continue;
    }
    i++;
  }
  return out.join('');
}

const lineOf = (text: string, off: number): number => { let n = 1; for (let i = 0; i < off && i < text.length; i++) if (text.charCodeAt(i) === 10) n++; return n; };

/** The structural problems of `text` (see the module comment), in text order. */
export function lintTex(text: string): LintIssue[] {
  const m = maskOpaque(text);
  const issues: LintIssue[] = [];
  const line = (off: number) => lineOf(text, off);

  // braces
  const braces: number[] = [];
  let stray = -1;
  for (let i = 0; i < m.length; i++) {
    const c = m[i];
    if (c === '\\') { i++; continue; }
    if (c === '{') braces.push(i);
    else if (c === '}') { if (!braces.length) { if (stray < 0) stray = i; } else braces.pop(); }
  }
  if (braces.length) issues.push({ code: 'brace-unclosed', message: `an opening brace on line ${line(braces[0])} is never closed`, offset: braces[0], severity: 'error' });
  if (stray >= 0) issues.push({ code: 'brace-stray', message: `a closing brace on line ${line(stray)} has no opening one`, offset: stray, severity: 'error' });

  // environments, \[ \] and $
  const envs: { name: string; at: number }[] = [];
  const displays: number[] = [];
  const dollars: number[] = [];
  const re = /\\(begin|end)\s*\{([^}\n]*)\}|\\\[|\\\]|\\.|\$\$?/g;
  let mt: RegExpExecArray | null;
  while ((mt = re.exec(m))) {
    const tok = mt[0];
    if (mt[1] === 'begin') envs.push({ name: mt[2], at: mt.index });
    else if (mt[1] === 'end') {
      const name = mt[2];
      const top = envs[envs.length - 1];
      if (!top) issues.push({ code: 'env-stray', message: `\\end{${name}} on line ${line(mt.index)} has no \\begin{${name}}`, offset: mt.index, severity: 'error' });
      else if (top.name !== name) {
        const inner = envs.findIndex(e => e.name === name);
        if (inner >= 0) {
          // an \end for something further out: everything opened since is unclosed
          for (let k = envs.length - 1; k > inner; k--) issues.push({ code: 'env-unclosed', message: `\\begin{${envs[k].name}} on line ${line(envs[k].at)} is not closed before \\end{${name}} on line ${line(mt.index)}`, offset: envs[k].at, severity: 'error' });
          envs.length = inner;
        } else {
          issues.push({ code: 'env-mismatch', message: `\\end{${name}} on line ${line(mt.index)} closes \\begin{${top.name}} from line ${line(top.at)}`, offset: mt.index, severity: 'error' });
          envs.pop();
        }
      } else envs.pop();
    } else if (tok === '\\[') displays.push(mt.index);
    else if (tok === '\\]') { if (!displays.length) issues.push({ code: 'display-stray', message: `\\] on line ${line(mt.index)} has no \\[`, offset: mt.index, severity: 'error' }); else displays.pop(); }
    else if (tok[0] === '$') { if (tok === '$$') dollars.push(mt.index, mt.index + 1); else dollars.push(mt.index); }
  }
  for (const e of envs) issues.push({ code: 'env-unclosed', message: `\\begin{${e.name}} on line ${line(e.at)} is never closed`, offset: e.at, severity: 'error' });
  for (const d of displays) issues.push({ code: 'display-unclosed', message: `\\[ on line ${line(d)} is never closed`, offset: d, severity: 'error' });
  // $ pairs: an inline formula cannot run past a blank line — a pair that would is broken there
  let k = 0;
  while (k < dollars.length) {
    const open = dollars[k], close = dollars[k + 1];
    if (close === undefined) { issues.push({ code: 'math-unclosed', message: `a $ on line ${line(open)} is never closed`, offset: open, severity: 'error' }); break; }
    if (close !== open + 1 && /\n[ \t]*\n/.test(m.slice(open, close))) { issues.push({ code: 'math-unclosed', message: `a $ on line ${line(open)} is not closed before the paragraph ends`, offset: open, severity: 'error' }); k += 1; continue; }
    k += 2;
  }
  return issues.sort((a, b) => a.offset - b.offset);
}
