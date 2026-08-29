/**
 * LaTeX syntax colouring for the source pane: turns source text into HTML made of
 * `<span class="hl-…">` runs (styles in styles.css). A small hand-written tokenizer — comments,
 * commands, \begin/\end with their environment name, sectioning commands with their argument,
 * braces, and math regions ($…$, $$…$$, \(…\), \[…\], math environments) — good enough to make a
 * .tex file scannable; it never fails on odd input (unbalanced braces etc. are just coloured as is).
 * A stray delimiter cannot colour the rest of the file: $…$, \(…\) and \[…\] end at a blank line
 * (TeX forbids paragraph breaks in math), and `$$` opens display math only when another `$$` follows
 * in the same paragraph — otherwise it is an empty inline formula, as OverLyX writes one.
 * Braces and brackets carry their nesting depth (`hl-d0` … `hl-d2`, cycling) for VS Code-style
 * bracket pair colours.
 */

const MATH_ENVS = new Set(['math', 'displaymath', 'equation', 'equation*', 'align', 'align*', 'alignat', 'alignat*', 'gather', 'gather*', 'multline', 'multline*', 'eqnarray', 'eqnarray*', 'flalign', 'flalign*', 'xalignat', 'xxalignat']);
/** commands whose {argument} is shown as a heading-like run */
const SECTIONING = new Set(['part', 'chapter', 'section', 'subsection', 'subsubsection', 'paragraph', 'subparagraph', 'title']);

const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

/** end index (exclusive) of the balanced {…} group starting at `i` (src[i] === '{'), or -1 */
function bracedEnd(src: string, i: number): number {
  let depth = 0;
  for (let j = i; j < src.length; j++) {
    const c = src[j];
    if (c === '\\') { j++; continue; }
    if (c === '{') depth++;
    else if (c === '}') { depth--; if (depth === 0) return j + 1; }
    else if (c === '\n' && src[j + 1] === '\n') return -1;   // a paragraph break: not an argument
  }
  return -1;
}

/** whether `what` occurs after `from` before the next blank line */
function hasInParagraph(src: string, from: number, what: string): boolean {
  const k = src.indexOf(what, from);
  if (k < 0) return false;
  const blank = src.indexOf('\n\n', from);
  return blank < 0 || k < blank;
}

/**
 * `marks`: character offsets to set off (the matched bracket pair, codearea.ts `matchBrackets`)
 * with the class given (`hl-match` / `hl-enclose`); a two-character token (\{) is marked at both
 * offsets.
 */
export function highlightTex(src: string, marks?: Map<number, string>): string {
  let out = '';
  const marked = (from: number, to: number): boolean => { if (marks) for (let k = from; k < to; k++) if (marks.has(k)) return true; return false; };
  const n = src.length;
  let i = 0;
  /** inside math: what closes it ('$', '$$', '\\)', '\\]' or 'env:<name>') */
  let mathEnd: string | null = null;
  const span = (cls: string, text: string) => { out += `<span class="${cls}${mathEnd ? ' m' : ''}">${esc(text)}</span>`; };
  let depth = 0;
  /** a bracket with its depth class: openers count before, closers after */
  const bracket = (c: string, extra = '') => {
    const open = c === '{' || c === '[';
    if (!open && depth > 0) depth--;
    span(`hl-brace hl-d${depth % 3}${extra}`, c);
    if (open) depth++;
  };
  const plain = (text: string) => { out += mathEnd ? `<span class="hl-math">${esc(text)}</span>` : esc(text); };

  while (i < n) {
    const c = src[i];
    if (marks?.has(i)) {
      const len = c === '\\' && marks.has(i + 1) ? 2 : 1;
      if (len === 1 && (c === '{' || c === '}' || c === '[' || c === ']')) bracket(c, ' ' + marks.get(i));
      else span('hl-brace ' + marks.get(i), src.slice(i, i + len));
      i += len; continue;
    }
    if (c === '%') {
      let j = src.indexOf('\n', i); if (j < 0) j = n;
      span('hl-comment', src.slice(i, j)); i = j; continue;
    }
    if (c === '\\') {
      const m = /^\\([A-Za-z]+\*?)/.exec(src.slice(i, i + 64));
      if (m) {
        const name = m[1];
        const end = i + m[0].length;
        if (name === 'begin' || name === 'end') {
          let arg = /^\s*\{([^{}\n]*)\}/.exec(src.slice(end, end + 80));
          if (arg && marked(end, end + arg[0].length)) arg = null;   // a marked brace inside: token by token
          span('hl-kw', m[0]);
          if (arg) {
            const env = arg[1];
            if (name === 'end' && mathEnd === 'env:' + env) { span('hl-brace', arg[0].slice(0, arg[0].indexOf('{') + 1)); span('hl-env', env); mathEnd = null; span('hl-brace', '}'); }
            else {
              span('hl-brace', arg[0].slice(0, arg[0].indexOf('{') + 1)); span('hl-env', env); span('hl-brace', '}');
              if (name === 'begin' && !mathEnd && MATH_ENVS.has(env)) mathEnd = 'env:' + env;
            }
            i = end + arg[0].length; continue;
          }
          i = end; continue;
        }
        if (SECTIONING.has(name.replace(/\*$/, '')) && !mathEnd) {
          span('hl-sec', m[0]);
          let k = end;
          const opt = /^\s*\[[^\]\n]*\]/.exec(src.slice(k, k + 200));
          if (opt) { span('hl-opt', opt[0]); k += opt[0].length; }
          const ws = /^\s*/.exec(src.slice(k, k + 8))![0];
          if (src[k + ws.length] === '{') {
            const e = bracedEnd(src, k + ws.length);
            if (e > 0 && !marked(k, e)) { plain(ws); span('hl-brace', '{'); span('hl-arg', src.slice(k + ws.length + 1, e - 1)); span('hl-brace', '}'); i = e; continue; }
          }
          i = end; continue;
        }
        span('hl-cmd', m[0]); i = end; continue;
      }
      const two = src.slice(i, i + 2);
      if (!mathEnd && (two === '\\(' || two === '\\[')) { span('hl-mdelim', two); mathEnd = two === '\\(' ? '\\)' : '\\]'; i += 2; continue; }
      if (mathEnd && two === mathEnd) { mathEnd = null; span('hl-mdelim', two); i += 2; continue; }
      span('hl-cmd', two.length === 2 ? two : c); i += two.length === 2 ? 2 : 1; continue;
    }
    if (c === '$') {
      const two = src[i + 1] === '$' ? '$$' : '$';
      if (!mathEnd) {
        if (two === '$$' && !hasInParagraph(src, i + 2, '$$')) { span('hl-mdelim', '$$'); i += 2; continue; }   // an empty inline formula
        span('hl-mdelim', two); mathEnd = two; i += two.length; continue;
      }
      if (mathEnd === two || (mathEnd === '$' && two === '$$')) { const d = mathEnd; mathEnd = null; span('hl-mdelim', d); i += d.length; continue; }
      plain(c); i++; continue;
    }
    if (c === '{' || c === '}' || c === '[' || c === ']') { bracket(c); i++; continue; }
    if (c === '&' && mathEnd) { span('hl-amp', c); i++; continue; }
    // a run of ordinary text; a blank line ends $…$, \(…\) and \[…\] math
    const inlineMath = mathEnd !== null && !mathEnd.startsWith('env:');
    let j = i, blank = false;
    if (inlineMath && c === '\n' && src[i + 1] === '\n') { mathEnd = null; plain('\n'); i++; continue; }
    j++;
    while (j < n && !'%\\${}[]&'.includes(src[j]) && !marks?.has(j)) { if (inlineMath && src[j] === '\n' && src[j + 1] === '\n') { blank = true; break; } j++; }
    plain(src.slice(i, j)); i = j;
    if (blank) mathEnd = null;
  }
  return out;
}
