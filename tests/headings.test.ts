/** Headings of a LaTeX file by text scan (packages/core/src/tex/headings.ts) — the document panel's static outline. */
import { describe, it, expect } from 'vitest';
import { texHeadings, headingPlainText } from '../packages/core/src/tex/headings.ts';

describe('texHeadings', () => {
  it('lists headings with levels, numbers and ordinals; starred ones are unnumbered', () => {
    const h = texHeadings('\\documentclass{article}\n\\begin{document}\n\\section{Intro}\nText.\n\\subsection{Setup}\n\\section*{Thanks}\n\\subsection{More}\n\\end{document}\n');
    expect(h.map(x => [x.level, x.text, x.n, x.num ?? null])).toEqual([[2, 'Intro', 0, '1'], [3, 'Setup', 1, '1.1'], [2, 'Thanks', 2, null], [3, 'More', 3, '1.2']]);
  });
  it('skips commented headings, reads optional short titles and nested braces, unwraps markup', () => {
    const h = texHeadings('% \\section{Not this}\n\\section[short]{Long \\emph{title} with $x^2$ \\label{sec:a}}\n\\subsection{A {nested} group}\n');
    expect(h.map(x => x.text)).toEqual(['Long title with $x^2$', 'A nested group']);
    expect(h[0].num).toBe('1');
  });
  it('letters the top level after \\appendix and restarts the counters', () => {
    const h = texHeadings('\\section{A}\n\\section{B}\n\\appendix\n\\section{Proofs}\n\\subsection{Lemma}\n');
    expect(h.map(x => x.num)).toEqual(['1', '2', 'A', 'A.1']);
  });
  it('counts chapters and parts like the editor (Part 0, Chapter 1, Section 2)', () => {
    const h = texHeadings('\\part{One}\n\\chapter{First}\n\\section{Detail}\n\\paragraph{Tiny}\n');
    expect(h.map(x => x.level)).toEqual([0, 1, 2, 5]);
    expect(h.map(x => x.num)).toEqual(['1', '1.1', '1.1.1', undefined]);   // paragraphs are below secnumdepth 3
  });
  it('a heading that runs into a blank line is not a heading', () => {
    expect(texHeadings('\\section{Broken\n\nText}')).toEqual([]);
  });
  it('headingPlainText', () => {
    expect(headingPlainText('\\textbf{Bold} and \\texttt{code}\\\\next')).toBe('Bold and code next');
    expect(headingPlainText('\\lyxadded{Jan}{Sun May 12}{New} \\lyxdeleted{Jan}{Sun May 12}{old} title')).toBe('New title');
  });
});
