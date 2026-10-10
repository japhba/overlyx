/**
 * LaTeX in HTML decks (core html/refs.ts, html/deckextras.ts): citation commands found and shown
 * (numeric and author-year, natbib's forms, notes, keys the bibliography lacks), the list of
 * references, BibTeX text made plain, what a server hands the runtime with a page (the cited
 * entries, the macros of linked .tex files and what they \input), steps.
 */
import { describe, it, expect } from 'vitest';
import { findCites, citedKeys, citeEntry, citeNumbers, citeText, referencePieces, bibliographyOrder, texToText, authorNames, hasCite, stepOf, type CiteEntry } from '../packages/core/src/html/refs.ts';
import { deckExtras, mathJaxMacros, pageLinks, pageCiteStyle } from '../packages/core/src/html/deckextras.ts';
import { parseBibtex } from '../packages/core/src/bib.ts';

const BIB = String.raw`
@book{knuth84, author = {Knuth, Donald E.}, title = {The {\TeX}book}, publisher = {Addison-Wesley}, year = 1984}
@article{lamport94, author = {Leslie Lamport and Frank Mittelbach and Michel Goossens}, title = {A paper}, journal = {TUGboat}, volume = {15}, number = {3}, pages = {200--210}, year = {1994}}
@inproceedings{schr, author = {Erwin Schr{\"o}dinger}, title = {Quantisierung}, booktitle = {Annalen der Physik}, year = {1926}}
`;
const entries = new Map(parseBibtex(BIB).map(e => [e.key, citeEntry(e)] as [string, CiteEntry]));

describe('citation commands', () => {
  it('finds \\cite, natbib forms with notes, several keys', () => {
    const c = findCites(String.raw`as \cite{knuth84} and \citep[see][p.~5]{lamport94, schr}, \citet[ch.~2]{knuth84}`);
    expect(c.map(x => x.cmd)).toEqual(['cite', 'citep', 'citet']);
    expect(c[1]).toMatchObject({ pre: 'see', post: 'p.~5', keys: ['lamport94', 'schr'] });
    expect(c[2]).toMatchObject({ pre: '', post: 'ch.~2' });
    expect(hasCite('x \\citep{a}')).toBe(true);
    expect(hasCite('\\city')).toBe(false);
  });

  it('the keys of a page in the order first cited, scripts and comments left out', () => {
    expect(citedKeys(String.raw`<p>\cite{b,a}</p><!-- \cite{z} --><script>"\cite{y}"</script><p>\citep{a,c}</p>`)).toEqual(['b', 'a', 'c']);
  });

  it('numeric: numbers in citation order, ranges, notes, natbib author forms, unknown keys', () => {
    const n = citeNumbers(['knuth84', 'lamport94', 'schr']);
    expect(citeText(findCites('\\cite{knuth84}')[0], n, entries, 'numeric')).toBe('[1]');
    expect(citeText(findCites('\\cite{schr,knuth84,lamport94}')[0], n, entries, 'numeric')).toBe('[1–3]');
    expect(citeText(findCites('\\citep[see][p.~5]{lamport94}')[0], n, entries, 'numeric')).toBe('[see 2, p. 5]');
    expect(citeText(findCites('\\citet{lamport94}')[0], n, entries, 'numeric')).toBe('Lamport et al. [2]');
    expect(citeText(findCites('\\cite{nope}')[0], n, entries, 'numeric')).toBe('[?]');
    expect(citeText(findCites('\\nocite{knuth84}')[0], n, entries, 'numeric')).toBe('');
  });

  it('author-year: \\citet, \\citep with several keys, accents', () => {
    const n = citeNumbers([]);
    expect(citeText(findCites('\\citet{knuth84}')[0], n, entries, 'authoryear')).toBe('Knuth (1984)');
    expect(citeText(findCites('\\citep{knuth84,schr}')[0], n, entries, 'authoryear')).toBe('(Knuth, 1984; Schrödinger, 1926)');
    expect(citeText(findCites('\\citep{nope}')[0], n, entries, 'authoryear')).toBe('(?, ?)');
  });
});

describe('the list of references', () => {
  it('BibTeX text made plain; names in reading order', () => {
    expect(texToText(String.raw`Schr{\"o}dinger --- {\'E}cole, \emph{very} {\TeX}book~2`)).toBe('Schrödinger — École, very TeXbook 2');
    expect(authorNames('Knuth, Donald E. and Leslie Lamport and others')).toEqual(['Donald E. Knuth', 'Leslie Lamport', 'et al.']);
  });

  it('a book (title in italics) and an article (journal in italics, volume, pages)', () => {
    const book = referencePieces(entries.get('knuth84')!);
    expect(book.map(p => p.text).join('')).toBe('Donald E. Knuth. The TeXbook. Addison-Wesley, 1984.');
    expect(book.find(p => p.em)?.text).toBe('The TeXbook');
    const art = referencePieces(entries.get('lamport94')!);
    expect(art.map(p => p.text).join('')).toBe('Leslie Lamport, Frank Mittelbach, and Michel Goossens. A paper. TUGboat, 15(3):200–210, 1994.');
    expect(art.find(p => p.em)?.text).toBe('TUGboat');
  });

  it('ordered by number, or by author and year', () => {
    const n = citeNumbers(['schr', 'knuth84']);
    expect(bibliographyOrder(['knuth84', 'schr', 'nope'], n, entries, 'numeric')).toEqual(['schr', 'knuth84']);
    expect(bibliographyOrder(['schr', 'lamport94', 'knuth84'], n, entries, 'authoryear')).toEqual(['knuth84', 'lamport94', 'schr']);
  });
});

describe('what a page gets with it', () => {
  const files: Record<string, string> = {
    'refs.bib': BIB,
    'other.bib': '@misc{solo, title = {Solo}, year = 2000}',
    'paper/macros.tex': String.raw`\newcommand{\R}{\mathbb{R}}\input{more}\renewcommand{\norm}[1]{\lVert #1\rVert}`,
    'paper/more.tex': String.raw`\DeclareMathOperator{\tr}{tr}\newcommand{\E}[2][]{\mathbb{E}_{#1}[#2]}`,
  };
  const io = {
    read: (r: string) => files[r] ?? null,
    bibFiles: () => ['refs.bib', 'other.bib'],
    resolve: (from: string, href: string) => {
      const base = from.includes('/') ? from.slice(0, from.lastIndexOf('/') + 1) : '';
      const parts = (base + href).split('/');
      const out: string[] = [];
      for (const p of parts) { if (p === '..') out.pop(); else if (p && p !== '.') out.push(p); }
      return out.join('/');
    },
  };

  it('the cited entries from every .bib file of the project, the style the page asks for', () => {
    const html = String.raw`<head><meta name="overlyx-citations" content="authoryear"></head><body><p>\citep{knuth84,solo,nope}</p></body>`;
    const x = deckExtras(html, 'talk/index.html', io);
    expect(Object.keys(x.bib!).sort()).toEqual(['knuth84', 'solo']);
    expect(x.citeStyle).toBe('authoryear');
    expect(pageCiteStyle('<meta name="overlyx-citations" content="numeric">')).toBe('numeric');
  });

  it('only the linked .bib files when the page names some', () => {
    const html = String.raw`<link rel="overlyx-bibliography" href="../other.bib"><p>\cite{knuth84,solo}</p>`;
    expect(Object.keys(deckExtras(html, 'talk/index.html', io).bib!)).toEqual(['solo']);
  });

  it('the macros of a linked .tex file and of what it \\inputs, in MathJax\'s form', () => {
    const html = `<link rel="overlyx-macros" href="../paper/macros.tex"><p>\\(\\R\\)</p>`;
    expect(pageLinks(html, 'overlyx-macros')).toEqual(['../paper/macros.tex']);
    const m = deckExtras(html, 'talk/index.html', io).macros!;
    expect(m.R).toBe('\\mathbb{R}');
    expect(m.norm).toEqual(['\\lVert #1\\rVert', 1]);
    expect(m.E).toEqual(['\\mathbb{E}_{#1}[#2]', 2, '']);
    expect(m.tr).toBeDefined();
    expect(mathJaxMacros('\\def\\x{y}').macros.x).toBe('y');
    // a page with neither citations nor macros gets nothing
    expect(deckExtras('<p>plain</p>', 'talk/index.html', io)).toEqual({});
  });
});

describe('steps', () => {
  it('data-step is the step an object appears at (from the start when absent or 1)', () => {
    expect(stepOf('3')).toBe(3);
    expect(stepOf('1')).toBe(1);
    expect(stepOf(null)).toBe(1);
    expect(stepOf('x')).toBe(1);
  });
});
