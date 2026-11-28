/**
 * The .tex reader and writer agree: what the reader makes of the author's LaTeX, the writer writes
 * back as the same LaTeX — the case of a paragraph written whole (new, split, joined, pasted, an
 * agent's edit, a patch that does not read back). One test per construct that did not.
 *   npx vitest run tests/tex-agree.test.ts
 */
import { describe, it, expect } from 'vitest';
import { parseTex, writeTex } from '../packages/core/src/tex/index.ts';
import { writeParagraphs } from '../packages/core/src/lyx/writer.ts';
import { walkInsets, plainText } from '../packages/core/src/lyx/ast.ts';
import { LYX_LAYOUTS } from './lyxlib.ts';

const opts = { layoutDir: LYX_LAYOUTS };
const doc = (body: string, pre = '', cls = 'article') => `\\documentclass{${cls}}\n${pre}\n\\begin{document}\n${body}\n\\end{document}\n`;
const bodyOf = (t: string) => t.slice(t.indexOf('\\begin{document}') + 16, t.lastIndexOf('\\end{document}')).trim();

/** parse → write → parse → write: the body written the first time, and the model and the text are fixpoints */
function roundTrip(src: string) {
  const p1 = parseTex(src, opts);
  const w1 = writeTex(p1.doc, { ...opts, fragment: p1.fragment }).text;
  const p2 = parseTex(w1, opts);
  const w2 = writeTex(p2.doc, { ...opts, fragment: p2.fragment }).text;
  expect(writeParagraphs(p2.doc.body)).toBe(writeParagraphs(p1.doc.body));
  expect(w2).toBe(w1);
  return { doc: p1.doc, text: w1, body: bodyOf(w1) };
}

describe('the author\'s LaTeX is written back as it was', () => {
  it('list options: \\begin{enumerate}[label=(\\alph*)], \\begin{itemize}[noitemsep]', () => {
    const r = roundTrip(doc('\\begin{enumerate}[label=(\\alph*)]\n\\item One\n\\item Two\n\\end{enumerate}\n\n\\begin{itemize}[noitemsep]\n\\item A\n\\end{itemize}', '\\usepackage{enumitem}'));
    expect(r.body).toContain('\\begin{enumerate}[label=(\\alph*)]\n\\item One');
    expect(r.body).toContain('\\begin{itemize}[noitemsep]\n\\item A');
  });

  it('options of commands whose layout declares none: \\footnote[3]{…}, \\title[short]{…}, braces in an option', () => {
    const r = roundTrip(doc('\\title[Short]{A long title}\n\\maketitle\n\nA\\footnote[3]{x} b.\n\n\\begin{itemize}[label={[}x{]}]\n\\item A\n\\end{itemize}'));
    expect(r.body).toContain('\\title[Short]{A long title}');
    expect(r.body).toContain('A\\footnote[3]{x} b.');
    expect(r.body).toContain('\\begin{itemize}[label={[}x{]}]');
  });

  it('a URL is literal: ~, %, #, braces and backslashes in \\url{} and \\href{}', () => {
    const urls = '\\url{http://x.org/~me/a} \\url{http://x.org/a%20b} rest \\url{http://x.org/{a}b\\c_d#e&f}';
    const r = roundTrip(doc(`See ${urls}.\n\nSee \\href{http://x.org/~me/a%20b}{my page} rest.`, '\\usepackage{hyperref}'));
    expect(r.body).toContain(`See ${urls}.`);
    expect(r.body).toContain('See \\href{http://x.org/~me/a\\%20b}{my page} rest.');
    // the editor shows the URL as it is
    const shown = [...walkInsets(r.doc.body)].filter(x => x.inset.type === 'Text' && x.inset.arg === 'URL').map(x => plainText((x.inset as { paragraphs: never }).paragraphs));
    expect(shown).toEqual(['http://x.org/~me/a', 'http://x.org/a%20b', 'http://x.org/{a}b\\c_d#e&f']);
  });

  it('formatted references keep their command: \\autoref, \\prettyref, \\secref, \\cref', () => {
    const refs = 'See \\autoref{sec:a}, \\autoref*{b}, \\prettyref{sec:a}, \\secref{a}, \\cref{sec:a} and \\ref{x}.';
    expect(roundTrip(doc(refs, '\\usepackage{hyperref}')).body).toBe(refs);
    // whatever the document's own choice for references made in the editor
    expect(roundTrip(doc(refs, '\\usepackage{hyperref}\n\\usepackage{cleveref}')).body).toBe(refs);
  });

  it('a minipage without a position is centred, as in LaTeX (not top-aligned)', () => {
    const r = roundTrip(doc('A \\begin{minipage}{3cm} x \\end{minipage} B \\begin{minipage}[t]{3cm} y \\end{minipage}'));
    const boxes = [...walkInsets(r.doc.body)].filter(x => x.inset.type === 'Text' && x.inset.name === 'Box').map(x => (x.inset as { params: string[] }).params.find(p => p.startsWith('position ')));
    expect(boxes).toEqual(['position "c"', 'position "t"']);
    expect(r.body).toContain('\\begin{minipage}[c]{3cm}');
    expect(r.body).toContain('\\begin{minipage}[t]{3cm}');
  });

  it('a definition local to a group or an environment stays local (not \\global\\long\\def), its group stays', () => {
    const src = 'A {\\renewcommand{\\arraystretch}{1.2} x} B {\\def\\x{y} F} and\n\n\\begin{table}\n\\renewcommand{\\arraystretch}{1.5}\n\\begin{tabular}{l}\na\n\\end{tabular}\n\\end{table}';
    const r = roundTrip(doc(src));
    expect(r.body).toContain('A {\\renewcommand{\\arraystretch}{1.2} x} B {\\def\\x{y} F} and');
    expect(r.body).toContain('\\begin{table}\n\\renewcommand{\\arraystretch}{1.5}');
    expect(r.body).not.toContain('\\global\\long\\def\\arraystretch');
    // a definition at the top level is still the document's math macro
    const top = parseTex(doc('A \\newcommand{\\R}{r} B {\\newcommand{\\S}{s} C}'), opts).doc;
    expect([...walkInsets(top.body)].filter(x => x.inset.type === 'FormulaMacro').map(x => (x.inset as { lines: string[] }).lines[0])).toEqual(['\\newcommand{\\R}{r}']);
  });

  it('a group around raw LaTeX keeps its braces: {\\mymacro} text, {\\setlength…}, \\frame<1>{…}', () => {
    const src = 'I use {\\mymacro} daily, {\\setlength{\\parskip}{0pt} x} y, w{a\\foo b}c and {\\small s} t, {\\it Key\\/}: x.';
    expect(roundTrip(doc(src)).body).toBe('I use {\\mymacro} daily, {\\setlength{\\parskip}{0pt} x} y, w{a\\foo b}c and {\\small s} t, \\textit{Key\\/}: x.');
  });

  it('a tracked change inside a URL stays a tracked change', () => {
    const r = roundTrip(doc('See \\url{a\\lyxadded{Ann}{Mon Jan  5 10:00:00 2026}{x~y}b\\lyxdeleted{Ann}{Mon Jan  5 10:00:00 2026}{old}c}.'));
    expect(r.body).toContain('\\url{a\\lyxadded{Ann}{Mon Jan  5 10:00:00 2026}{x~y}b\\lyxdeleted{Ann}{Mon Jan  5 10:00:00 2026}{old}c}');
    const url = [...walkInsets(r.doc.body)].find(x => x.inset.type === 'Text' && x.inset.arg === 'URL')!.inset as { paragraphs: { items: { kind: string; text?: string; change?: { type: string } }[] }[] };
    expect(url.paragraphs[0].items.map(it => [it.text, it.change?.type])).toEqual([['a', undefined], ['x~y', 'inserted'], ['b', undefined], ['old', 'deleted'], ['c', undefined]]);
  });
});
