/**
 * .tex documents: the LaTeX parser (packages/core/src/tex/parse.ts), the writer (tex/write.ts)
 * and the LyX importer (tex/import.ts).
 *
 * The contract: whatever LaTeX comes in parses (nothing is dropped: what the model has no place
 * for is kept verbatim), and writing what the parser read is stable — write(parse(write(parse(x))))
 * equals write(parse(x)) — so a saved file stays as it is until somebody edits it.
 *   npx vitest run tests/tex.test.ts
 */
import { describe, it, expect } from 'vitest';
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import { parseTex, writeTex, importLyx, splitDocument, settingsFromHeader } from '../packages/core/src/tex/index.ts';
import { parseLyx } from '../packages/core/src/lyx/parser.ts';
import { collectMacros, headerValue, paramMap, unquote, walkInsets, walkParagraphs, plainText, type LyxDocument, type Paragraph } from '../packages/core/src/index.ts';

const doc = (body: string, preamble = '', cls = 'article') => `\\documentclass{${cls}}\n${preamble}\n\\begin{document}\n${body}\n\\end{document}\n`;
const parse = (text: string) => parseTex(text).doc;
const write = (d: LyxDocument) => writeTex(d).text;
const rewrite = (text: string) => write(parse(text));
/** the body of a written document, without the managed block */
const bodyOf = (text: string) => text.slice(text.indexOf('\\begin{document}\n') + 17, text.lastIndexOf('\\end{document}')).trim();

function insets(d: LyxDocument, name: string, arg?: string) {
  return [...walkInsets(d.body)].map(x => x.inset).filter(i => (i.type === 'Text' || i.type === 'Leaf') && i.name === name && (arg === undefined || i.arg === arg));
}
function pars(d: LyxDocument): Paragraph[] { return [...walkParagraphs(d.body)]; }
function expectStable(text: string, label = ''): string {
  const once = rewrite(text);
  const twice = rewrite(once);
  expect(twice, label || 'second rewrite equals the first').toBe(once);
  return once;
}

/* ------------------------------------------------------------ structure */

describe('paragraphs and layouts (class-driven)', () => {
  it('maps sectioning commands, lists, quotes and theorems to layouts and back', () => {
    const src = doc(`\\section{Intro}\\label{sec:intro}

Text of the intro.

\\subsection*{Unnumbered}

\\begin{itemize}
\\item One
\\item Two \\textbf{bold}

Second paragraph of two.
\\begin{enumerate}
\\item nested
\\end{enumerate}
\\end{itemize}
\\begin{quote}
A quotation.
\\end{quote}
\\begin{description}
\\item[Term one] Its definition.
\\end{description}`);
    const d = parse(src);
    const layouts = d.body.map(p => `${p.layout}@${p.depth}`);
    expect(layouts).toEqual(['Section@0', 'Standard@0', 'Subsection*@0', 'Itemize@0', 'Itemize@0', 'Standard@1', 'Enumerate@1', 'Quote@0', 'Description@0']);
    // the label after \section belongs to the heading
    expect(insets(d, 'CommandInset', 'label')).toHaveLength(1);
    expect(d.body[0].items.some(i => i.kind === 'inset' && i.inset.type === 'Leaf' && i.inset.arg === 'label')).toBe(true);
    const out = expectStable(src);
    expect(bodyOf(out)).toContain('\\section{Intro}\\label{sec:intro}');
    expect(bodyOf(out)).toContain('\\item [{Term~one}] Its definition.');
    expect(bodyOf(out)).toContain('\\begin{enumerate}\n\\item nested\n\\end{enumerate}');
  });

  it('title, author, abstract, alignment environments, appendix, noindent', () => {
    const src = doc(`\\title{T}
\\author{A \\and B}
\\maketitle
\\begin{abstract}
Abs.
\\end{abstract}
\\begin{center}
Centered.
\\end{center}
\\noindent No indent here.

\\appendix

\\section{App}`);
    const d = parse(src);
    expect(d.body.map(p => p.layout)).toEqual(['Title', 'Author', 'Abstract', 'Standard', 'Standard', 'Section']);
    expect(d.body[3].params.align).toBe('center');
    expect(d.body[4].params.noindent).toBe(true);
    expect(d.body[5].params.start_of_appendix).toBe(true);
    const out = expectStable(src);
    expect(bodyOf(out)).toContain('\\maketitle');
    expect(bodyOf(out)).toContain('\\begin{center}\nCentered.\n\\par\\end{center}');
    expect(bodyOf(out)).toContain('\\appendix');
  });

  it('a theorem environment needs its module: with it the layout is used, without it the environment is kept verbatim', () => {
    const src = doc('\\begin{thm}\nA theorem.\n\\end{thm}');
    const plain = parse(src);
    expect(plain.body[0].layout).toBe('Standard');
    expect(insets(plain, 'ERT').length).toBe(2);
    expect(bodyOf(rewrite(src))).toContain('\\begin{thm}');
    const withModule = parse(src.replace('\\begin{document}', '%% OverLyX ------------------------------------------------------------------\n%% overlyx-settings: {"modules":["theorems-ams"]}\n%% end OverLyX --------------------------------------------------------------\n\\begin{document}'));
    expect(withModule.body[0].layout).toBe('Theorem');
    expect(write(withModule)).toContain('"modules":["theorems-ams"]');
  });
});

describe('raw LaTeX fidelity (ERT)', () => {
  it('keeps the braces of script groups after raw ^ and _', () => {
    const src = doc('\\widemath{x_{J}^{r1}x_{J}^{r2}+\\int_{WV}f}');
    const out = expectStable(src);
    expect(bodyOf(out)).toContain('\\widemath{x_{J}^{r1}x_{J}^{r2}+\\int_{WV}f}');
  });

  it('a command the preamble defines stays a command, not the unicode symbol of that name', () => {
    const src = doc('\\eq{i\\th_{i}^{r}\\ty}', '\\global\\long\\def\\th{\\tilde{h}}\n\\global\\long\\def\\ty{\\tilde{y}}');
    const out = expectStable(src);
    expect(bodyOf(out)).toContain('\\th_{i}^{r}\\ty');
    expect(out).not.toContain('\u00fe');
  });

  it('\\maketitle with the title in the user preamble is kept verbatim', () => {
    const src = doc('\\maketitle\n\nHello.', '\\title{In the preamble}');
    const out = expectStable(src);
    expect(bodyOf(out)).toContain('\\maketitle');
  });
});

/* ------------------------------------------------------------ inline content */

describe('inline content', () => {
  it('fonts, quotes, dashes, special characters, spaces, footnotes', () => {
    const src = doc('Some \\emph{emphasised} and \\textbf{bold \\textit{italic}} text, ``quoted\'\' -- dashed --- and 50\\% of \\$5, a~tie\\footnote{Note $x$.} and \\ldots{} \\LaTeX{} done.');
    const d = parse(src);
    const p = d.body[0];
    const emph = p.items.find(i => i.kind === 'text' && i.text === 'emphasised');
    expect(emph?.font.emph).toBe('on');
    const bi = p.items.find(i => i.kind === 'text' && i.text === 'italic');
    expect(bi?.font).toMatchObject({ series: 'bold', shape: 'italic' });
    expect(insets(d, 'Quotes').map(q => q.arg)).toEqual(['eld', 'erd']);
    expect(plainText([p])).toContain('50% of $5');
    expect(plainText([p])).toContain('– dashed —');
    expect(insets(d, 'space', '~')).toHaveLength(1);
    expect(insets(d, 'Foot')).toHaveLength(1);
    expect(p.items.filter(i => i.kind === 'special').map(i => (i as { arg: string }).arg)).toEqual(['ldots', 'LaTeX']);
    const out = expectStable(src);
    // LyX closes and reopens font commands at every font change
    expect(bodyOf(out).replace(/\n/g, ' ')).toBe('Some \\emph{emphasised} and \\textbf{bold }\\textbf{\\textit{italic}} text, ``quoted\'\' -- dashed --- and 50\\% of \\$5, a~tie\\footnote{Note $x$.} and \\ldots{} \\LaTeX{} done.');
  });

  it('custom text colours: \\textcolor[HTML|rgb|RGB|gray] round-trip as #rrggbb, named colours stay named', () => {
    const src = doc('A \\textcolor[HTML]{FF8800}{custom} and \\textcolor{red}{named} and \\textcolor[rgb]{1,0.5,0}{rgb} and \\textcolor[RGB]{0,128,255}{big} and \\textcolor[gray]{0.5}{grey} word.');
    const out = expectStable(src, 'colours');
    expect(bodyOf(out).replace(/\n/g, ' ')).toBe('A \\textcolor[HTML]{FF8800}{custom} and \\textcolor{red}{named} and \\textcolor[HTML]{FF8000}{rgb} and \\textcolor[HTML]{0080FF}{big} and \\textcolor[HTML]{808080}{grey} word.');
    expect(out).toContain('xcolor');
    // an unknown model is not understood: kept verbatim as TeX code, nothing lost
    const odd = doc('A \\textcolor[cmyk]{0,1,1,0}{x} word.');
    expect(bodyOf(rewrite(odd))).toContain('\\textcolor[cmyk]{0,1,1,0}');
  });

  it('accented characters and symbols come in as Unicode and go out as LaTeX again', () => {
    const src = doc('Caf\\\'{e}, na\\"ive, stra\\ss{}e, \\textdegree{} and \\textrightarrow{} and a literal ä.');
    const d = parse(src);
    expect(plainText(d.body)).toBe('Café, naïve, straße, ° and → and a literal ä.');
    const out = expectStable(src);
    // what utf8 inputenc handles stays a character; the rest becomes a command again (textcomp)
    expect(bodyOf(out)).toBe('Café, naïve, straße, ° and \\textrightarrow{} and a literal ä.');
    expect(out).toContain('\\usepackage{textcomp}');
  });

  it('math: inline, display, environments (verbatim), \\ensuremath', () => {
    const src = doc('Inline $a^2$ and \\(b\\) then\n\\[\nc = d\n\\]\nand\n\\begin{align}\nx &= y \\\\\nz &= w \\label{eq:z}\n\\end{align}\nend.');
    const d = parse(src);
    const f = [...walkInsets(d.body)].map(x => x.inset).filter(i => i.type === 'Formula');
    expect(f.map(x => (x as { inline: boolean }).inline)).toEqual([true, true, false, false]);
    expect((f[3] as { latex: string }).latex).toBe('\\begin{align}\nx &= y \\\\\nz &= w \\label{eq:z}\n\\end{align}');
    const out = expectStable(src);
    expect(bodyOf(out)).toBe('Inline $a^2$ and \\(b\\) then\n\\[\nc = d\n\\]\nand\n\\begin{align}\nx &= y \\\\\nz &= w \\label{eq:z}\n\\end{align}\nend.');
  });

  it('references, citations (natbib), hyperlinks, labels', () => {
    const src = doc('See \\ref{sec:a}, \\eqref{eq:b}, \\cref{fig:c} and \\citep[see][p.~5]{knuth,lamport}, \\citet*{knuth}, \\href{https://x.org/a}{the site}, \\url{https://x.org}.', '\\usepackage{natbib}\n\\usepackage{cleveref}\n\\usepackage{hyperref}');
    const d = parse(src);
    expect(headerValue(d.header, 'cite_engine')).toBe('natbib');
    expect(headerValue(d.header, 'crossref_package')).toBe('cleveref');
    const refs = insets(d, 'CommandInset', 'ref').map(r => paramMap((r as { params: string[] }).params).get('LatexCommand'));
    expect(refs).toEqual(['ref', 'eqref', 'formatted']);
    const cites = insets(d, 'CommandInset', 'citation').map(c => paramMap((c as { params: string[] }).params));
    expect(cites[0].get('LatexCommand')).toBe('citep');
    expect(unquote(cites[0].get('key'))).toBe('knuth,lamport');
    expect(unquote(cites[0].get('before'))).toBe('see');
    expect(unquote(cites[0].get('after'))).toBe('p.~5');
    expect(cites[1].get('LatexCommand')).toBe('citet*');
    expect(insets(d, 'CommandInset', 'href')).toHaveLength(1);
    expect(insets(d, 'Flex', 'URL')).toHaveLength(1);
    const out = expectStable(src);
    const flat = bodyOf(out).replace(/\n/g, ' ');
    expect(flat).toContain('\\citep[see][p.~5]{knuth,lamport}, \\citet*{knuth}, \\href{https://x.org/a}{the site}, \\url{https://x.org}.');
    expect(flat).toContain('\\eqref{eq:b}, \\cref{fig:c}');
  });
});

/* ------------------------------------------------------------ insets */

describe('floats, graphics, tables, boxes', () => {
  it('figure with placement, centering, graphics options, caption + label', () => {
    const src = doc('\\begin{figure*}[htbp]\n\\centering\n\\includegraphics[width=0.5\\columnwidth,angle=90]{figures/a.svg}\\caption{A caption.}\\label{fig:a}\n\\end{figure*}');
    const d = parse(src);
    const fl = insets(d, 'Float', 'figure')[0] as { params: string[]; paragraphs: Paragraph[] };
    expect(paramMap(fl.params).get('placement')).toBe('htbp');
    expect(paramMap(fl.params).get('alignment')).toBe('center');
    expect(paramMap(fl.params).get('wide')).toBe('true');
    const g = insets(d, 'Graphics')[0] as { params: string[] };
    expect(paramMap(g.params).get('filename')).toBe('figures/a.svg');
    expect(paramMap(g.params).get('width')).toBe('50col%');
    expect(paramMap(g.params).get('rotateAngle')).toBe('90');
    expect(insets(d, 'Caption')).toHaveLength(1);
    expect(insets(d, 'CommandInset', 'label')).toHaveLength(1);
    const out = expectStable(src);
    expect(bodyOf(out)).toBe('\\begin{figure*}[htbp]\n\\centering\n\\includegraphics[angle=90,width=0.5\\columnwidth]{figures/a.svg}\\caption{A caption.}\\label{fig:a}\n\\end{figure*}');
    expect(out).toContain('\\usepackage{graphicx}');
  });

  it('tabular with rules, multicolumn and multirow', () => {
    const src = doc('\\begin{tabular}{|l|c|r|}\n\\hline\na & b & c \\\\\n\\hline\n\\multicolumn{2}{|c|}{wide} & \\multirow{2}{*}{tall} \\\\\nx & y & \\\\\n\\hline\n\\end{tabular}');
    const d = parse(src);
    const t = [...walkInsets(d.body)].map(x => x.inset).find(i => i.type === 'Tabular') as { rows: { cells: { attrs: [string, string][] }[] }[]; columns: unknown[] } | undefined;
    expect(t).toBeDefined();
    expect(t!.columns).toHaveLength(3);
    expect(t!.rows).toHaveLength(3);
    const attr = (r: number, c: number, k: string) => t!.rows[r].cells[c].attrs.find(a => a[0] === k)?.[1];
    expect(attr(0, 0, 'topline')).toBe('true');
    expect(attr(1, 0, 'multicolumn')).toBe('1');
    expect(attr(1, 1, 'multicolumn')).toBe('2');
    expect(attr(1, 2, 'multirow')).toBe('1');
    expect(attr(2, 2, 'multirow')).toBe('2');
    expect(attr(2, 0, 'bottomline')).toBe('true');
    const out = expectStable(src);
    expect(bodyOf(out)).toContain('\\multicolumn{2}{|c|}{wide}');
    expect(bodyOf(out)).toContain('\\multirow{2}{*}{tall}');
  });

  it('booktabs and a longtable', () => {
    const src = doc('\\begin{tabular}{ll}\n\\toprule\nh1 & h2 \\\\\n\\midrule\na & b \\\\\n\\bottomrule\n\\end{tabular}\n\n\\begin{longtable}{cc}\n1 & 2 \\\\\n\\end{longtable}');
    const d = parse(src);
    const tabs = [...walkInsets(d.body)].map(x => x.inset).filter(i => i.type === 'Tabular') as { features: [string, string][] }[];
    expect(tabs).toHaveLength(2);
    expect(tabs[0].features.find(f => f[0] === 'booktabs')?.[1]).toBe('true');
    expect(tabs[1].features.find(f => f[0] === 'islongtable')?.[1]).toBe('true');
    const out = expectStable(src);
    expect(bodyOf(out)).toContain('\\toprule');
    expect(bodyOf(out)).toContain('\\begin{longtable}');
  });

  it('minipages become boxes; \\fbox around one is a boxed box', () => {
    const src = doc('\\noindent\\fbox{\\begin{minipage}[t]{1\\columnwidth}%\nInside the box.%\n\\end{minipage}}\n\nAfter.');
    const d = parse(src);
    expect(insets(d, 'Box', 'Boxed')).toHaveLength(1);
    expect(insets(d, 'ERT')).toHaveLength(0);
    const out = expectStable(src);
    // LyX's form of a full-width boxed box (the frame is subtracted from the width)
    expect(bodyOf(out)).toContain('\\noindent\\fbox{\\begin{minipage}[t]{1\\columnwidth - 2\\fboxsep - 2\\fboxrule}%');
  });
});

/* ------------------------------------------------------------ tracking, notes, macros, raw */

describe('change tracking and notes live in the file', () => {
  it('\\lyxadded / \\lyxdeleted become tracked changes with authors and times, and are written back', () => {
    const src = doc('Old \\lyxdeleted{Jan Bauer}{Tue Aug 26 14:03:00 2026}{deleted }text \\lyxadded{Kirsten Fischer}{Wed Aug 27 09:10:11 2026}{and new} words.\n\nGone.\\lyxadded{Jan Bauer}{Tue Aug 26 14:03:00 2026}{¶}\n\nNext.');
    const d = parse(src);
    const p = d.body[0];
    const del = p.items.find(i => i.change?.type === 'deleted');
    const add = p.items.find(i => i.change?.type === 'inserted');
    expect(del && del.kind === 'text' ? del.text : '').toBe('deleted ');
    expect(add && add.kind === 'text' ? add.text : '').toBe('and new');
    expect(del!.change!.time).toBe(1787752980);
    const authors = d.header.lines.filter(l => l.startsWith('\\author '));
    expect(authors.some(l => l.includes('"Jan Bauer"'))).toBe(true);
    expect(authors.some(l => l.includes('"Kirsten Fischer"'))).toBe(true);
    expect(d.body[1].endChange?.type).toBe('inserted');
    const out = expectStable(src);
    expect(bodyOf(out).replace(/\n/g, ' ')).toContain('\\lyxdeleted{Jan Bauer}{Wed Aug 26 14:03:00 2026}{deleted }text \\lyxadded{Kirsten Fischer}{Thu Aug 27 09:10:11 2026}{and new} words.');
    expect(bodyOf(out)).toContain('Gone.\\lyxadded{Jan Bauer}{Wed Aug 26 14:03:00 2026}{¶}');
    expect(out).toContain('\\DeclareRobustCommand{\\lyxadded}');
    expect(out).toContain('\\usepackage{ulem}');
    // with output_changes off the macros hide the markup but the changes stay in the file
    const hidden = write({ ...d, header: { lines: d.header.lines.map(l => (l === '\\output_changes true' ? '\\output_changes false' : l)) } });
    expect(hidden).toContain('\\lyxdeleted{Jan Bauer}');
    expect(hidden).toContain('\\newcommand{\\lyxdeleted}[3]{}');
    expect(rewrite(hidden)).toBe(hidden);
  });

  it('notes and comments are %% blocks (nested ones too) that other LaTeX tools ignore', () => {
    const src = doc('Text %\n%% @comment\n%% Jan Bauer (2026-08-26 14:03):\n%%\n%% A comment with \\emph{emphasis} and $x$.\n%% %% @note\n%% %% nested note\ncontinues here.');
    const d = parse(src);
    const c = insets(d, 'Note', 'Comment')[0] as { paragraphs: Paragraph[] };
    expect(c.paragraphs).toHaveLength(2);
    expect(plainText([c.paragraphs[0]])).toBe('Jan Bauer (2026-08-26 14:03):');
    expect(c.paragraphs[1].items.map(i => (i.kind === 'text' ? i.text : i.kind === 'inset' ? `[${i.inset.type === 'Text' ? i.inset.name + ' ' + i.inset.arg : i.inset.type}]` : '?')).join('')).toBe('A comment with emphasis and [Formula]. [Note Note]');
    expect(insets(d, 'Note', 'Note')).toHaveLength(1);
    expect(d.body[0].items.filter(i => i.kind === 'text').map(i => (i as { text: string }).text).join('')).toBe('Text continues here.');
    const out = expectStable(src);
    // written back as self-contained blocks: every note is closed by "%% @end" (nested: "%% %% @end")
    expect(bodyOf(out)).toBe('Text %\n%% @comment\n%% Jan Bauer (2026-08-26 14:03):\n%%\n%% A comment with \\emph{emphasis} and $x$. %\n%% %% @note\n%% %% nested note\n%% %% @end\n%% @end\ncontinues here.');
    // the closed form reads back the same (and a note without the closer, as above, still ends at the first plain line)
    expect(bodyOf(write(parse(out)))).toBe(bodyOf(out));
    expect(insets(parse(out), 'Note')).toHaveLength(2);
    // two notes in a row stay two notes
    const two = doc('A %\n%% @note\n%% first\n%% @comment\n%% second\nB');
    expect(insets(parse(two), 'Note')).toHaveLength(2);
    expectStable(two);
  });

  it('a folded note keeps its fold state: "%% @note collapsed" (LyX status collapsed), open without the word', () => {
    const src = doc('A %\n%% @note collapsed\n%% folded\n%% @comment\n%% open thread\n%% %% @note collapsed\n%% %% nested folded\nB');
    const d = parse(src);
    const notes = insets(d, 'Note') as { arg: string; status?: string }[];
    expect(notes.map(n => `${n.arg}:${n.status}`)).toEqual(['Note:collapsed', 'Comment:open', 'Note:collapsed']);
    expect(bodyOf(expectStable(src))).toBe('A %\n%% @note collapsed\n%% folded\n%% @end\n%% @comment\n%% open thread %\n%% %% @note collapsed\n%% %% nested folded\n%% %% @end\n%% @end\nB');
    // toggling the state in the editor changes only the header line
    const toggled = write({ ...d, body: d.body.map(p => ({ ...p, items: p.items.map(i => (i.kind === 'inset' && i.inset.type === 'Text' && i.inset.name === 'Note' ? { ...i, inset: { ...i.inset, status: i.inset.status === 'collapsed' ? 'open' as const : 'collapsed' as const } } : i)) })) });
    expect(bodyOf(toggled)).toBe('A %\n%% @note\n%% folded\n%% @end\n%% @comment collapsed\n%% open thread %\n%% %% @note collapsed\n%% %% nested folded\n%% %% @end\n%% @end\nB');
    // "open" is accepted too (and normalised away)
    expect(bodyOf(write(parse(doc('A %\n%% @note open\n%% x\nB'))))).toBe('A %\n%% @note\n%% x\n%% @end\nB');
  });

  it('macro definitions in the body are macro insets (positional), also inside notes; the preamble ones are collected too', () => {
    const src = doc('\\global\\long\\def\\vec#1{\\mathbf{#1}}%\n\n\\newcommand{\\R}{\\mathbb{R}}\n\n%% @note\n%% \\global\\long\\def\\hidden{h}%\n$\\vec{x} \\in \\R$', '\\newcommand{\\E}[1]{\\mathbb{E}[#1]}');
    const d = parse(src);
    expect(insets(d, 'FormulaMacro')).toHaveLength(0);
    const macros = [...walkInsets(d.body)].map(x => x.inset).filter(i => i.type === 'FormulaMacro') as { lines: string[] }[];
    expect(macros.map(m => m.lines[0])).toEqual(['\\global\\long\\def\\vec#1{\\mathbf{#1}}', '\\newcommand{\\R}{\\mathbb{R}}', '\\global\\long\\def\\hidden{h}']);
    expect(collectMacros(d).map(m => m.name)).toEqual(['E', 'vec', 'R', 'hidden']);
    const out = expectStable(src);
    expect(bodyOf(out)).toContain('\\global\\long\\def\\vec#1{\\mathbf{#1}}%');
    expect(bodyOf(out)).toContain('\\global\\long\\def\\R{\\mathbb{R}}%');
  });

  it('a macro keeps its LyX display form as "%% @display {…}" on the definition line', () => {
    const src = doc('\\global\\long\\def\\inv#1{\\myinv{(#1)}}%% @display {(#1)^{-1}}\n\\global\\long\\def\\ZZ{Z}%% @display {\\mathbb{Z}}\n\\global\\long\\def\\plain{p}%\n\n$\\inv{x}$');
    const d = parse(src);
    const macros = [...walkInsets(d.body)].map(x => x.inset).filter(i => i.type === 'FormulaMacro') as { lines: string[] }[];
    expect(macros.map(m => m.lines)).toEqual([['\\global\\long\\def\\inv#1{\\myinv{(#1)}}', '{(#1)^{-1}}'], ['\\global\\long\\def\\ZZ{Z}', '{\\mathbb{Z}}'], ['\\global\\long\\def\\plain{p}']]);
    const inv = collectMacros(d).find(m => m.name === 'inv')!;
    expect(inv.def).toBe('\\myinv{(#1)}');
    expect(inv.display).toBe('(#1)^{-1}');
    expect(collectMacros(d).find(m => m.name === 'plain')!.display).toBeUndefined();
    const out = expectStable(src);
    expect(bodyOf(out)).toBe('\\global\\long\\def\\inv#1{\\myinv{(#1)}}%% @display {(#1)^{-1}}\n\\global\\long\\def\\ZZ{Z}%% @display {\\mathbb{Z}}\n\\global\\long\\def\\plain{p}%\n\n$\\inv{x}$');
    // the LyX importer carries the display form over
    const lyx = '#LyX 2.4 created this file. For more info see https://www.lyx.org/\n\\lyxformat 620\n\\begin_document\n\\begin_header\n\\save_transient_properties true\n\\origin unavailable\n\\textclass article\n\\end_header\n\n\\begin_body\n\n\\begin_layout Standard\n\\begin_inset FormulaMacro\n\\newcommand{\\inv}[1]{\\myinv{(#1)}}\n{(#1)^{-1}}\n\\end_inset\n\n\n\\end_layout\n\n\\end_body\n\\end_document\n';
    expect(importLyx(lyx, {}).tex).toContain('\\global\\long\\def\\inv#1{\\myinv{(#1)}}%% @display {(#1)^{-1}}');
  });

  it('unknown commands and environments are kept verbatim (raw LaTeX insets), arguments stay editable text', () => {
    const src = doc('\\twocolumn[\n\\icmltitle{A title}\n\\vskip 0.3in\n]\n\\begin{tikzpicture}\n\\draw (0,0) -- (1,1);\n\\end{tikzpicture}\n\n\\setlength{\\parskip}{1em} A \\mycmd{with \\emph{text}} and \\verb|a&b| here.\n\n\\begin{myenv}[opt]\nInside.\n\\end{myenv}');
    const d = parse(src);
    expect(insets(d, 'ERT').length).toBeGreaterThan(3);
    const out = expectStable(src);
    const b = bodyOf(out);
    expect(b).toContain('\\twocolumn[\n\\icmltitle{A title}\n\\vskip 0.3in\n]');
    expect(b).toContain('\\begin{tikzpicture}\n\\draw (0,0) -- (1,1);\n\\end{tikzpicture}');
    expect(b.replace(/\n/g, ' ')).toContain('\\setlength{\\parskip}{1em} A \\mycmd{with \\emph{text}} and \\verb|a&b| here.');
    expect(b).toContain('\\begin{myenv}[opt] Inside. \\end{myenv}');
  });

  it('comments that are not notes are kept, and never swallow what follows', () => {
    const src = doc('Text % a remark\nmore text.\n% a whole line\nAnd more.');
    const d = parse(src);
    expect(d.body[0].items.filter(i => i.kind === 'text').map(i => (i as { text: string }).text).join('|')).toBe('Text |more text. |And more.');
    expect(insets(d, 'ERT')).toHaveLength(2);
    const out = expectStable(src);
    expect(bodyOf(out)).toBe('Text % a remark\nmore text. % a whole line\nAnd more.');
  });
});

/* ------------------------------------------------------------ preamble / classes / children */

describe('preamble, classes and child documents', () => {
  it('keeps the user preamble verbatim and manages its own block', () => {
    const pre = '\\usepackage{graphicx}\n% my comment\n\\newcommand{\\foo}{bar}\n\\input{macros}';
    const src = doc('Text with \\sout{struck} words.', pre);
    const out = rewrite(src);
    expect(out).toContain(pre);
    expect(out).toContain('%% OverLyX ---');
    expect(out).toContain('\\usepackage{ulem}');
    expect(out).not.toMatch(/graphicx[\s\S]*graphicx/);   // not loaded twice
    expect(rewrite(out)).toBe(out);
    // a document without any special needs gets only the settings line
    const plain = rewrite(doc('Plain text.'));
    expect(plain).toContain('%% overlyx-settings: {"textclass":"article"}');
    expect(plain).not.toContain('\\usepackage');
    // the settings line survives round trips and is not duplicated
    expect((rewrite(plain).match(/overlyx-settings/g) ?? []).length).toBe(1);
    expect(splitDocument(plain).userPreamble).toBe('');
  });

  it('resolves LaTeX classes to layouts (revtex4-2 with natbib and class options)', () => {
    const src = '\\documentclass[prx,twocolumn,superscriptaddress]{revtex4-2}\n\\begin{document}\n\\title{T}\n\\author{A}\n\\affiliation{Inst}\n\\begin{abstract}\nAbs.\n\\end{abstract}\n\\maketitle\n\\section{S}\nSee \\citep{k} and \\onlinecite{k}.\n\\end{document}\n';
    const r = parseTex(src);
    expect(r.warnings).toEqual([]);
    expect(headerValue(r.doc.header, 'textclass')).toBe('revtex4-2');
    expect(headerValue(r.doc.header, 'options')).toBe('prx,twocolumn,superscriptaddress');
    expect(headerValue(r.doc.header, 'cite_engine')).toBe('natbib');
    expect(r.doc.body.map(p => p.layout)).toEqual(['Title', 'Author', 'Affiliation', 'Abstract', 'Section', 'Standard']);
    const out = expectStable(src);
    expect(out).toContain('\\documentclass[prx,twocolumn,superscriptaddress]{revtex4-2}');
    expect(bodyOf(out)).toContain('\\affiliation{Inst}');
    expect(bodyOf(out)).toContain('\\citep{k}');
  });

  it('project-local layout files are found', () => {
    const dir = '/root/projects/recurrent_feature';
    if (!existsSync(join(dir, 'icml.layout'))) return;
    const r = parseTex('\\documentclass{icml}\n\\begin{document}\n\\section{S}\nText.\n\\end{document}\n', { localDirs: [dir] });
    expect(headerValue(r.doc.header, 'textclass')).toBe('icml');
    expect(r.doc.body[0].layout).toBe('Section');
  });

  it('a child document (no preamble) parses with its master\'s settings and is written as a fragment', () => {
    const master = parse(doc('\\input{child}', '\\usepackage{natbib}', 'revtex4-2'));
    const child = parseTex('\\section{Child}\nText \\citep{k}.\n', { masterHeader: master.header.lines });
    expect(child.fragment).toBe(true);
    expect(headerValue(child.doc.header, 'textclass')).toBe('revtex4-2');
    expect(child.doc.body[0].layout).toBe('Section');
    const out = writeTex(child.doc, { fragment: true }).text;
    expect(out).toMatch(/^%% overlyx-settings: \{.*"textclass":"revtex4-2"/);
    expect(out).not.toContain('\\begin{document}');
    expect(out).toContain('\\section{Child}');
    // written again, unchanged
    const again = parseTex(out, { masterHeader: master.header.lines });
    expect(writeTex(again.doc, { fragment: true }).text).toBe(out);
  });

  it('the settings line carries what LaTeX cannot express', () => {
    const header = ['\\textclass article', '\\begin_modules', 'theorems-ams', '\\end_modules', '\\cite_engine natbib', '\\output_changes false', '\\use_package amsmath 2'];
    expect(settingsFromHeader(header)).toEqual({ textclass: 'article', cite_engine: 'natbib', output_changes: 'false', modules: ['theorems-ams'], use_package: { amsmath: '2' } });
  });
});

/* ------------------------------------------------------------ importer */

describe('LyX import', () => {
  const lyx = (body: string, header = '') => `#LyX 2.5 created this file. For more info see https://www.lyx.org/\n\\lyxformat 643\n\\begin_document\n\\begin_header\n\\textclass article\n${header}\\end_header\n\n\\begin_body\n${body}\n\\end_body\n\\end_document\n`;

  it('turns a LyX document into a .tex document with its settings as a preamble; graphics and children are renamed', () => {
    const src = lyx('\n\\begin_layout Section\nIntro\n\\end_layout\n\n\\begin_layout Standard\nSee \n\\begin_inset CommandInset include\nLatexCommand include\nfilename "appendix.lyx"\nliteral "true"\n\n\\end_inset\n\n and \n\\begin_inset Graphics\n\tfilename figures/plot.svg\n\twidth 50col%\n\n\\end_inset\n\n\\end_layout\n', '\\use_hyperref true\n\\papersize a4\n');
    const r = importLyx(src, { sourceName: 'main.lyx' });
    expect(r.warnings).toEqual([]);
    expect(r.tex).toMatch(/^%% Imported from main.lyx by OverLyX on \d{4}-\d{2}-\d{2}\./);
    expect(r.tex).toContain('\\documentclass[a4paper,english]{article}');
    expect(r.tex).toContain('{hyperref}');
    expect(r.tex).toContain('\\include{appendix}');
    expect(r.tex).toContain('\\includegraphics[width=0.5\\columnwidth]{figures/plot.pdf}');
    expect(r.graphics).toEqual([{ src: 'figures/plot.svg', dest: 'figures/plot.pdf' }]);
    // what the importer wrote is a document the parser reads back to the same file after one save
    expectStable(r.tex);
  });

  it('a LyX child document becomes a fragment', () => {
    const r = importLyx(lyx('\n\\begin_layout Standard\nChild text.\n\\end_layout\n'), { fragment: true });
    expect(r.fragment).toBe(true);
    expect(r.tex).not.toContain('\\documentclass');
    expect(r.tex).toContain('Child text.');
  });
});

/* ------------------------------------------------------------ corpus */

function collectLyx(dir: string, out: string[] = [], depth = 0): string[] {
  if (!existsSync(dir) || depth > 3) return out;
  for (const f of readdirSync(dir)) {
    const p = join(dir, f);
    const st = statSync(p);
    if (st.isDirectory()) collectLyx(p, out, depth + 1);
    else if (f.endsWith('.lyx') && !f.endsWith('~') && !f.startsWith('#')) out.push(p);
  }
  return out;
}

describe('corpus: every imported document is stable under parse/write', () => {
  const userFiles = ['/root/projects/recurrent_feature/main.lyx', '/root/projects/recurrent_feature/appendix.lyx', '/root/projects/recurrent_feature/lyxmacros.lyx', '/root/projects/bayesian_chaos/main.lyx'].filter(f => existsSync(f));
  // (presentations rely on beamer overlay arguments the layouts write with their own delimiters;
  // qtree / xy / lilypond / noweb / sweave documents are external-tool languages inside ERT)
  const exampleFiles = collectLyx('/root/lyx/lib/examples').filter(f => !/\/(ja|zh_CN|ko|he|ar|fa|ru|uk|el|hu|ja_JP)\//.test(f) && !/Localization|lilypond|sweave|knitr|R-S-statistics|noweb|xy|chess|linguistics|spreadsheet|Presentations|Posters|Instant_Preview|Beamer|Seminar|Foils|Japanese/i.test(f)).slice(0, 120);
  const files = [...userFiles, ...exampleFiles];
  for (const f of files) {
    it(f.replace('/root/', ''), () => {
      const dir = dirname(f);
      const isChild = /appendix|lyxmacros/.test(basename(f));
      const text = readFileSync(f, 'utf8');
      const doc0 = parseLyx(text);
      if (doc0.format < 600) return;   // ancient files are not the target
      const readFile = (n: string) => { const p = join(dir, n); return existsSync(p) ? readFileSync(p, 'utf8') : undefined; };
      const imp = importLyx(text, { localDirs: [dir], readFile, fragment: isChild, sourceName: basename(f), resolveInclude: (fn) => { const p = join(dir, fn); return existsSync(p) ? parseLyx(readFileSync(p, 'utf8')) : undefined; } });
      const opts = { localDirs: [dir], readFile };
      const p1 = parseTex(imp.tex, opts);
      const w1 = writeTex(p1.doc, { ...opts, fragment: p1.fragment }).text;
      const p2 = parseTex(w1, opts);
      const w2 = writeTex(p2.doc, { ...opts, fragment: p2.fragment }).text;
      const p3 = parseTex(w2, opts);
      const w3 = writeTex(p3.doc, { ...opts, fragment: p3.fragment }).text;
      // the first save after the import may still collapse LyX's empty paragraphs (LaTeX has none);
      // apart from blank lines it is already stable, and from then on byte for byte
      const blanks = (t: string) => t.split('\n').map(l => l.replace(/\s+$/, '')).filter(l => l !== '').join('\n');
      expect(blanks(w2)).toBe(blanks(w1));
      expect(w3).toBe(w2);
      // nothing of substance is lost: the words of the body survive the trip
      const words = (d: LyxDocument) => plainText(pars(d)).replace(/\s+/g, ' ').trim();
      expect(words(p2.doc).length).toBeGreaterThanOrEqual(words(p1.doc).length * 0.98);
    });
  }
});
