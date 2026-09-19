/**
 * The structural LaTeX linter (packages/core/src/tex/lint.ts): unbalanced braces, environments,
 * `$` and `\[ \]` located by line, with comments, \verb, URL arguments and verbatim-like
 * environments blanked first — and the health check's brace count sharing that masking.
 */
import { describe, it, expect } from 'vitest';
import { lintTex, maskOpaque } from '../packages/core/src/tex/lint.ts';
import { checkTexHealth } from '../packages/core/src/tex/health.ts';
import { parseTex } from '../packages/core/src/tex/index.ts';

const codes = (t: string) => lintTex(t).map(i => i.code);

describe('maskOpaque', () => {
  it('blanks comments, \\verb, URL arguments and verbatim-like environments but keeps the layout of the text', () => {
    const t = 'a % comment {\nb \\verb|{x|\nc \\url{http://x.org/a%20b}\nd \\begin{verbatim}\n{ % $\n\\end{verbatim}\ne \\% \\{ f';
    const m = maskOpaque(t);
    expect(m.length).toBe(t.length);
    expect(m.split('\n').length).toBe(t.split('\n').length);
    expect(m).not.toContain('comment');
    expect(m).not.toContain('{x');
    expect(m).not.toContain('%20b');
    expect(m).toContain('\\url{');
    expect(m).toContain('\\begin{verbatim}');
    expect(m).toContain('\\end{verbatim}');
    expect(m).not.toContain('{ % $');
    expect(m).toContain('\\% \\{ f');   // escaped characters stay (the linter skips them itself)
  });
});

describe('lintTex', () => {
  it('accepts well-formed LaTeX, including a % or a brace inside a URL, \\verb and verbatim', () => {
    expect(codes('\\section{A}\nText $x$ and \\[ y \\] and\n\\begin{itemize}\n\\item one\n\\end{itemize}\n')).toEqual([]);
    expect(codes('See \\url{http://x.org/a%20{b}} and \\verb|}| and\n\\begin{lstlisting}\nif (a) { %\n\\end{lstlisting}\n\\href{http://a.b/c%d}{text}')).toEqual([]);
    expect(codes('Escaped \\{ \\} \\$ and 100\\% here')).toEqual([]);
    expect(codes('Display $$a$$ and $b$ $c$')).toEqual([]);
  });
  it('names the line of an unclosed or stray brace', () => {
    const t = 'line one\n\\section{Title\nmore\n';
    const [i] = lintTex(t);
    expect(i.code).toBe('brace-unclosed');
    expect(i.message).toContain('line 2');
    expect(t.slice(i.offset, i.offset + 1)).toBe('{');
    const [j] = lintTex('a\nb }\n');
    expect(j.code).toBe('brace-stray');
    expect(j.message).toContain('line 2');
  });
  it('finds an environment that is never closed, a mismatched \\end and a stray \\end', () => {
    const [u] = lintTex('x\n\\begin{itemize}\n\\item a\n\ntext');
    expect(u.code).toBe('env-unclosed');
    expect(u.message).toContain('\\begin{itemize} on line 2');
    const [m] = lintTex('\\begin{align}\na\n\\end{equation}');
    expect(m.code).toBe('env-mismatch');
    expect(m.message).toContain('closes \\begin{align} from line 1');
    const [s] = lintTex('text\n\\end{itemize}');
    expect(s.code).toBe('env-stray');
    // an \end for an outer environment: the inner ones are the unclosed ones
    const r = lintTex('\\begin{figure}\n\\begin{center}\nx\n\\end{figure}');
    expect(r.map(i => i.code)).toEqual(['env-unclosed']);
    expect(r[0].message).toContain('\\begin{center} on line 2');
  });
  it('finds a $ that runs past a blank line or is never closed, and unbalanced \\[ \\]', () => {
    const [d] = lintTex('a $x + y\n\nnext paragraph $z$');
    expect(d.code).toBe('math-unclosed');
    expect(d.message).toContain('line 1');
    const [e] = lintTex('a $x + y');
    expect(e.code).toBe('math-unclosed');
    expect(codes('\\[ x')).toEqual(['display-unclosed']);
    expect(codes('x \\]')).toEqual(['display-stray']);
    expect(codes('$$ x $$ ok')).toEqual([]);
  });
  it('reports several problems in text order', () => {
    const r = lintTex('\\begin{itemize}\n\\item {a\n\\end{enumerate}');
    expect(r.map(i => i.code)).toEqual(['brace-unclosed', 'env-mismatch']);
  });
});

describe('checkTexHealth braces use the same masking', () => {
  it('a URL with a % or a verbatim brace no longer looks unbalanced', () => {
    const doc = '\\documentclass{article}\n\\begin{document}\nSee \\url{http://x.org/a%20b} and \\verb|{|.\n\\begin{verbatim}\n{\n\\end{verbatim}\n\\end{document}\n';
    expect(checkTexHealth(doc).filter(i => i.code === 'brace-imbalance')).toEqual([]);
    expect(checkTexHealth('\\documentclass{article}\n\\begin{document}\n{\n\\end{document}\n').map(i => i.code)).toEqual(['brace-imbalance']);
  });
});

describe('the parser says what it kept as raw LaTeX', () => {
  it('warns about an unknown environment with its line', () => {
    const r = parseTex('\\documentclass{article}\n\\begin{document}\nText.\n\n\\begin{mysterybox}\ninside\n\\end{mysterybox}\n\\end{document}\n', {});
    expect(r.warnings.some(w => /\\begin\{mysterybox\} on line 5 .*raw LaTeX/.test(w))).toBe(true);
    const ok = parseTex('\\documentclass{article}\n\\begin{document}\n\\begin{itemize}\n\\item a\n\\end{itemize}\n\\end{document}\n', {});
    expect(ok.warnings.filter(w => /raw LaTeX/.test(w))).toEqual([]);
  });
});
