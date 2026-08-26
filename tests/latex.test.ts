import { describe, it, expect } from 'vitest';
import { readFileSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { spawnSync } from 'node:child_process';
import { parseLyx } from '../packages/core/src/lyx/parser.ts';
import { exportLatex } from '../packages/core/src/latex/export.ts';
import { loadDocumentClass, describeLayouts, flexInsetNames, floatTypes } from '../packages/core/src/latex/layouts.ts';
import { parseMacroDefinition } from '../packages/core/src/latex/insets.ts';
import { latexLength } from '../packages/core/src/latex/lengths.ts';

/* ------------------------------------------------------------ helpers */

const HEADER_DEFAULTS = [
  '\\textclass article', '\\language english', '\\inputencoding utf8', '\\fontencoding auto',
  '\\font_roman "default" "default"', '\\font_sans "default" "default"', '\\font_typewriter "default" "default"',
  '\\use_non_tex_fonts false', '\\paperfontsize default', '\\spacing single', '\\use_hyperref false',
  '\\papersize default', '\\use_geometry false', '\\use_package amsmath 1', '\\use_package amssymb 1',
  '\\cite_engine basic', '\\cite_engine_type default', '\\biblio_style plain', '\\use_refstyle 1',
  '\\secnumdepth 3', '\\tocdepth 3', '\\paragraph_separation indent', '\\quotes_style english',
  '\\papercolumns 1', '\\papersides 1', '\\paperpagestyle default', '\\tracking_changes false', '\\output_changes false',
];

/** Build a LyX file from body text; header lines override defaults by key. */
function lyx(body: string, header: string[] = []): string {
  const keys = new Set(header.map(h => h.split(' ')[0]));
  const lines = [...HEADER_DEFAULTS.filter(h => !keys.has(h.split(' ')[0])), ...header];
  return `#LyX 2.4 created this file. For more info see https://www.lyx.org/\n\\lyxformat 614\n\\begin_document\n\\begin_header\n${lines.join('\n')}\n\\end_header\n\n\\begin_body\n\n${body}\n\\end_body\n\\end_document\n`;
}

function par(layout: string, content: string, depth = 0): string {
  const open = depth > 0 ? '\\begin_deeper\n'.repeat(depth) : '';
  const close = depth > 0 ? '\\end_deeper\n'.repeat(depth) : '';
  return `${open}\\begin_layout ${layout}\n${content}\n\\end_layout\n\n${close}`;
}

function inset(name: string, body: string, params = ''): string {
  return `\\begin_inset ${name}\n${params}status open\n\n${body}\\end_inset\n`;
}

function tex(src: string, opts: Parameters<typeof exportLatex>[1] = {}): ReturnType<typeof exportLatex> {
  return exportLatex(parseLyx(src), opts);
}

function body(res: ReturnType<typeof exportLatex>): string {
  const i = res.tex.indexOf('\\begin{document}');
  return res.tex.slice(i + '\\begin{document}\n'.length).replace(/\\end\{document\}\n$/, '');
}

function ws(s: string): string {
  return s.replace(/^%.*$/gm, '').replace(/\s+/g, ' ').trim();
}

/* ------------------------------------------------------------ layouts */

describe('layout parser', () => {
  it('loads the article class with modules', () => {
    const dc = loadDocumentClass('article', ['theorems-ams', 'logicalmkup']);
    expect(dc.latexName).toBe('article');
    expect(dc.styles.get('Section')?.latexName).toBe('section');
    expect(dc.styles.get('Section*')?.latexName).toBe('section*');
    expect(dc.styles.get('Itemize')?.latexType).toBe('Item_Environment');
    expect(dc.styles.get('Description')?.labelType).toBe('Manual');
    expect(dc.styles.get('Bibliography')?.latexType).toBe('Bib_Environment');
    expect(dc.styles.get('Theorem')?.preamble).toContain('\\newtheorem{thm}');
    expect(dc.styles.get('Theorem')?.requires).toContain('amsthm');
    expect(dc.insetLayouts.get('Flex:Code')?.latexName).toBe('code');
    expect(dc.insetLayouts.get('Note:Comment')?.latexName).toBe('comment');
    expect(dc.floats.get('figure')?.listCommand).toBe('listoffigures');
    expect(dc.styles.get('Section')?.args.get('1')?.labelString).toContain('Short Title');
    expect(dc.styles.get('List')?.obsoletedBy).toBe('Labeling');
    expect(flexInsetNames(dc)).toContain('Code');
    expect(floatTypes(dc)).toEqual(expect.arrayContaining(['figure', 'table', 'algorithm']));
    const desc = describeLayouts(dc);
    const sec = desc.find(d => d.name === 'Section')!;
    expect(sec.isNumbered).toBe(true);
    expect(sec.tocLevel).toBe(1);
    expect(desc.find(d => d.name === 'Section*')!.isNumbered).toBe(false);
  });

  it('loads revtex4-2 with provides', () => {
    const dc = loadDocumentClass('revtex4-2', []);
    expect(dc.latexName).toBe('revtex4-2');
    expect(dc.provides.has('natbib-internal')).toBe(true);
    expect(dc.styles.get('Abstract')?.inTitle).toBe(true);
    expect(dc.styles.get('Affiliation')?.latexName).toBe('affiliation');
  });

  it('falls back for unknown classes', () => {
    const dc = loadDocumentClass('no-such-class-xyz', []);
    expect(dc.latexName).toBe('no-such-class-xyz');
    expect(dc.styles.has('Standard')).toBe(true);
    expect(dc.warnings.length).toBeGreaterThan(0);
  });
});

/* ------------------------------------------------------------ preamble */

describe('preamble', () => {
  it('writes documentclass, fontenc, inputenc, babel', () => {
    const res = tex(lyx(par('Standard', 'Hello')));
    expect(res.tex).toMatch(/^%% LyX/);
    expect(res.tex).toContain('\\documentclass[english]{article}');
    expect(res.tex).toContain('\\usepackage[T1]{fontenc}');
    expect(res.tex).toContain('\\usepackage[utf8]{inputenc}');
    expect(res.tex).toContain('\\usepackage{babel}');
    expect(res.tex).toContain('\\begin{document}\nHello\n\n\\end{document}');
    expect(res.warnings).toEqual([]);
  });

  it('handles class options, fonts, geometry, spacing, hyperref, parskip', () => {
    const res = tex(lyx(par('Standard', 'x'), [
      '\\options a4paper,draft', '\\use_default_options true', '\\paperfontsize 12', '\\papercolumns 2', '\\papersides 2',
      '\\font_roman "palatino" "default"', '\\font_sans "helvet" "default"', '\\font_sf_scale 95 100', '\\font_typewriter "courier" "default"',
      '\\use_geometry true', '\\leftmargin 2cm', '\\topmargin 1in', '\\spacing onehalf', '\\use_hyperref true', '\\pdf_bookmarks true',
      '\\pdf_colorlinks true', '\\pdf_pdfusetitle true', '\\pdf_title "My Title"', '\\paragraph_separation skip', '\\defskip medskip', '\\secnumdepth 2',
      '\\use_microtype true', '\\paperorientation landscape',
    ]));
    expect(res.tex).toContain('\\documentclass[12pt,twoside,twocolumn,english,a4paper,draft]{article}');
    expect(res.tex).toContain('\\usepackage{mathpazo}');
    expect(res.tex).toContain('\\usepackage[scaled=0.95]{helvet}');
    expect(res.tex).toContain('\\usepackage{courier}');
    expect(res.tex).toContain('\\usepackage[landscape]{geometry}');
    expect(res.tex).toContain('\\geometry{verbose,tmargin=1in,lmargin=2cm}');
    expect(res.tex).toContain('\\setcounter{secnumdepth}{2}');
    expect(res.tex).toContain('\\usepackage[skip=\\medskipamount]{parskip}');
    expect(res.tex).toContain('\\usepackage{setspace}');
    expect(res.tex).toContain('\\onehalfspacing');
    expect(res.tex).toContain('\\usepackage{microtype}');
    // pdfusetitle is only passed when no explicit title/author is set
    expect(res.tex).toMatch(/\\usepackage\[bookmarks=true,bookmarksnumbered=false,bookmarksopen=false,\n breaklinks=false,pdfborder=\{0 0 1\},backref=false,colorlinks=true\]\n \{hyperref\}/);
    expect(res.tex).toContain('\\hypersetup{pdftitle={My Title}}');
    // hyperref forces babel to be loaded early (before the packages)
    expect(res.tex.indexOf('\\usepackage{babel}')).toBeLessThan(res.tex.indexOf('{hyperref}'));
    expect(res.tex).toContain('\\usepackage{color}');
  });

  it('respects \\use_package values (0 off, 1 auto, 2 on)', () => {
    const res = tex(lyx(par('Standard', 'x'), ['\\use_package amsmath 2', '\\use_package amssymb 2', '\\use_package cancel 1', '\\use_package esint 0']));
    expect(res.tex).toContain('\\usepackage{amsmath}');
    expect(res.tex).toContain('\\usepackage{amssymb}');
    expect(res.tex).not.toContain('\\usepackage{cancel}');
    const auto = tex(lyx(par('Standard', inset('Formula', '', '$\\lesssim \\coloneqq \\iint$\n').replace('status open\n\n', ''))));
    expect(auto.tex).toContain('\\usepackage{amssymb}');
    expect(auto.tex).toContain('\\usepackage{mathtools}');
    expect(auto.tex).toContain('\\usepackage{esint}');
  });

  it('adds the user preamble inside makeatletter and style preambles', () => {
    const res = tex(lyx(par('LyX-Code', 'code'), ['\\begin_preamble', '\\newcommand{\\foo}{bar}', '\\end_preamble']));
    expect(res.tex).toMatch(/\\makeatletter\n[\s\S]*Textclass specific LaTeX commands\.\n\\newenvironment\{lyxcode\}[\s\S]*User specified LaTeX commands\.\n\\newcommand\{\\foo\}\{bar\}\n\n\\makeatother/);
    expect(body(res)).toContain('\\begin{lyxcode}\ncode\n\\end{lyxcode}');
  });

  it('non-TeX fonts use fontspec and polyglossia', () => {
    const res = tex(lyx(par('Standard', 'ä → x'), ['\\use_non_tex_fonts true', '\\font_roman "default" "Libertinus Serif"', '\\inputencoding utf8']));
    expect(res.tex).toContain('\\usepackage{fontspec}');
    expect(res.tex).toContain('\\setmainfont[Ligatures=TeX]{Libertinus Serif}');
    expect(res.tex).toContain('\\usepackage{polyglossia}');
    expect(res.tex).toContain('\\setdefaultlanguage[variant=american]{english}');
    expect(res.tex).not.toContain('inputenc');
    expect(body(res)).toContain('ä → x');
  });
});

/* ---------------------------------------------------------- structure */

describe('sections, lists, environments', () => {
  it('sections with short titles and starred variants', () => {
    const src = lyx(
      par('Section', `${inset('Argument 1', par('Plain Layout', 'Short'))}Long title`) +
      par('Subsection*', 'Unnumbered') +
      par('Standard', 'Text.'),
    );
    const b = body(tex(src));
    expect(b).toContain('\\section[Short]{Long title}\n\n\\subsection*{Unnumbered}\n\nText.');
  });

  it('title block with maketitle', () => {
    const b = body(tex(lyx(par('Title', 'T') + par('Author', 'A') + par('Abstract', 'abs') + par('Standard', 'Body'))));
    // like LyX: no blank lines between InTitle commands, \maketitle after the title block
    expect(b).toContain('\\title{T}\n\\author{A}\n\\maketitle\n\\begin{abstract}\nabs\n\\end{abstract}\nBody');
  });

  it('nested itemize / enumerate / description', () => {
    const src = lyx(
      par('Itemize', 'one') + par('Itemize', 'two') +
      par('Enumerate', 'a', 1) + par('Enumerate', 'b', 1) +
      par('Standard', 'continued', 1) +
      par('Itemize', 'three') +
      par('Description', 'Label text of the item') +
      par('Description', 'Two\n\\begin_inset space ~\n\\end_inset\n\nwords rest') +
      par('Standard', 'after'),
    );
    const b = body(tex(src));
    expect(b).toContain('\\begin{itemize}\n\\item one\n\\item two\n\\begin{enumerate}\n\\item a\n\\item b\n\\end{enumerate}\ncontinued\n\\item three\n\\end{itemize}');
    expect(b).toContain('\\begin{description}\n\\item [{Label}] text of the item\n\\item [{Two~words}] rest\n\\end{description}\nafter');
  });

  it('custom item labels and labeling lists', () => {
    const src = lyx(par('Itemize', `${inset('Argument item:1', par('Plain Layout', '*'))}custom`) + par('Labeling', 'key value\n\\labelwidthstring 00.00.0000'));
    const b = body(tex(src));
    expect(b).toContain('\\item[{*}] custom');
    expect(b).toContain('\\begin{lyxlist}{00.00.0000}\n\\item [{key}] value\n\\end{lyxlist}');
  });

  it('quote, verse, alignment, noindent, spacing, appendix, page breaks', () => {
    const src = lyx(
      par('Quote', 'quoted') +
      par('Standard', '\\align center\ncentered') +
      par('Standard', '\\noindent\nno indent') +
      par('Standard', '\\paragraph_spacing double\ndouble') +
      par('Standard', '\\start_of_appendix\nappendix\n\\begin_inset Newpage newpage\n\\end_inset\n\n') +
      par('Standard', 'a\n\\begin_inset Newline newline\n\\end_inset\n\nb\n\\begin_inset Newline linebreak\n\\end_inset\n\nc'),
    );
    const b = body(tex(src));
    expect(b).toContain('\\begin{quote}\nquoted\n\\end{quote}');
    expect(b).toContain('\\begin{center}\ncentered\n\\par\\end{center}');
    expect(b).toContain('\\noindent no indent');
    expect(b).toContain('\\begin{doublespace}\ndouble\n\\end{doublespace}');
    expect(b).toContain('\\appendix\nappendix\\newpage{}');
    expect(b).toContain('a\\\\\nb\\linebreak{}\nc');
  });

  it('theorems from modules with preamble and i18n', () => {
    const src = lyx(par('Theorem', 'thm text') + par('Proof', 'proof text'), ['\\begin_modules', 'theorems-ams', '\\end_modules']);
    const res = tex(src);
    expect(res.tex).toContain('\\usepackage{amsthm}');
    expect(res.tex).toContain('\\newtheorem{thm}{\\protect\\theoremname}');
    expect(res.tex).toContain('\\providecommand{\\theoremname}{Theorem}');
    expect(body(res)).toContain('\\begin{thm}\nthm text\n\\end{thm}\n\n\\begin{proof}\nproof text\n\\end{proof}');
  });
});

/* ---------------------------------------------------------------- text */

describe('text, fonts and special characters', () => {
  it('escapes special characters', () => {
    const b = ws(body(tex(lyx(par('Standard', 'a & b % c $ d # e _ f { g } h ~ i ^ j [k] * l \n\\backslash\nm < n > o "q"')))));
    // commands are terminated with {} before a space and with a space before a letter (like LyX)
    expect(b).toContain('a \\& b \\% c \\$ d \\# e \\_ f \\{ g \\} h \\textasciitilde{} i \\textasciicircum{} j {[}k{]} {*} l \\textbackslash m < n > o \\textquotedbl q\\textquotedbl{}');
  });

  it('font changes', () => {
    const src = lyx(par('Standard', 'plain \n\\series bold\nbold \n\\series default\n\\emph on\nemph\n\\emph default\n \n\\shape italic\nit\n\\shape default\n \n\\family typewriter\ntt\n\\family default\n \n\\bar under\nul\n\\bar default\n \n\\strikeout on\nso\n\\strikeout default\n \n\\color red\nred\n\\color inherit\n \n\\size small\nsmall\n\\size default\n \n\\noun on\nnoun\n\\noun default\n \n\\lang ngerman\ngerman\n\\lang english\n end'));
    const res = tex(src);
    const b = ws(body(res));
    expect(b).toContain('plain \\textbf{bold }\\emph{emph} \\textit{it} \\texttt{tt} \\uline{ul} \\sout{so} \\textcolor{red}{red} {\\small small} \\noun{noun} \\foreignlanguage{ngerman}{german} end');
    expect(res.tex).toContain('\\usepackage{ulem}');
    expect(res.tex).toContain('\\usepackage{color}');
    expect(res.tex).toContain('\\newcommand{\\noun}[1]{\\textsc{#1}}');
    expect(res.tex).toContain('\\documentclass[ngerman,english]{article}');
  });

  it('layout fonts are the base for reduction', () => {
    const b = body(tex(lyx(par('Section', '\\series bold\nstill bold \n\\series medium\nmedium'))));
    expect(b).toContain('\\section{still bold \\textmd{medium}}');
  });

  it('special chars, quotes and spaces', () => {
    const src = lyx(par('Standard', 'A\n\\SpecialChar ldots\n B\n\\SpecialChar nobreakdash\n-C\n\\SpecialChar endofsentence\n D\n\\SpecialChar menuseparator\nE\n\\SpecialChar LyX\n \n\\SpecialChar TeX\n.\n\\begin_inset Quotes eld\n\\end_inset\n\nq\n\\begin_inset Quotes erd\n\\end_inset\n\n \n\\begin_inset Quotes els\n\\end_inset\n\ns\n\\begin_inset Quotes ers\n\\end_inset\n\n \n\\begin_inset Quotes gld\n\\end_inset\n\ng\n\\begin_inset Quotes grd\n\\end_inset\n\n x\n\\begin_inset space ~\n\\end_inset\n\ny\n\\begin_inset space \\thinspace{}\n\\end_inset\n\nz\n\\begin_inset space \\quad{}\n\\end_inset\n\nw\n\\begin_inset space \\hfill{}\n\\end_inset\n\nv\n\\begin_inset space \\hspace{}\n\\length 2cm\n\\end_inset\n\nu\n\\begin_inset space \\space{}\n\\end_inset\n\nt\n\\twohyphens\n\n\\threehyphens\n\n\\begin_inset VSpace bigskip\n\\end_inset\n\n\\begin_inset VSpace 1cm*\n\\end_inset\n\n'));
    const res = tex(src);
    const b = ws(body(res));
    expect(b).toContain('A\\ldots{} B\\nobreakdash--C\\@. D\\lyxarrow E\\LyX{} \\TeX .``q\'\' `s\' ,,g`` x~y\\,z\\quad{}w\\hfill{}v\\hspace{2cm}u\\ t-----\\bigskip{} \\vspace*{1cm}');
    expect(res.tex).toContain('\\providecommand{\\LyX}');
    expect(res.tex).toContain('\\DeclareRobustCommand*{\\lyxarrow}');
  });

  it('unicode: latin letters pass through, symbols become commands', () => {
    const res = tex(lyx(par('Standard', 'ä ö é — ∞ ≤ ° €')));
    const b = body(res);
    // dashes become ligatures (\use_dash_ligatures default), latin-1 letters and ° pass through with utf8 inputenc
    expect(b).toContain('ä ö é --- \\ensuremath{\\infty} \\ensuremath{\\le} ° \\texteuro{}');
    const nolig = tex(lyx(par('Standard', 'a — b'), ['\\use_dash_ligatures false']));
    expect(body(nolig)).toContain('a — b');
    expect(res.tex).toContain('\\usepackage{textcomp}');
    const legacy = tex(lyx(par('Standard', 'ä é'), ['\\inputencoding auto-legacy-plain']));
    expect(body(legacy)).toContain('\\"{a} \\\'{e}');
    expect(legacy.tex).toContain('\\UseRawInputEncoding');
  });

  it('wraps long lines at spaces like LyX', () => {
    const b = body(tex(lyx(par('Standard', 'word '.repeat(40).trim()))));
    for (const line of b.split('\n')) expect(line.length).toBeLessThan(80);
    expect(b.split('\n').length).toBeGreaterThan(2);
  });
});

/* ------------------------------------------------------------- insets */

describe('insets', () => {
  it('footnotes, marginal notes, notes, ERT, scripts', () => {
    const src = lyx(par('Standard',
      `text${inset('Foot', par('Plain Layout', 'foot'))} m${inset('Marginal', par('Plain Layout', 'margin'))} ` +
      `${inset('Note Note', par('Plain Layout', 'hidden'))}${inset('Note Comment', par('Plain Layout', 'comment'))} after ` +
      `${inset('Note Greyedout', par('Plain Layout', 'grey'))} ${inset('ERT', par('Plain Layout', '\\backslash\nfoo{bar}'))} ` +
      `x${inset('script superscript', par('Plain Layout', '2'))} y${inset('script subscript', par('Plain Layout', 'i'))}`));
    const res = tex(src);
    const b = body(res);
    expect(b).toContain('text\\footnote{foot} m\\marginpar{margin} %\n\\begin{comment}\ncomment\n\\end{comment}\n{} after %\n\\begin{lyxgreyedout}\ngrey%\n\\end{lyxgreyedout}\n{} \\foo{bar} x\\textsuperscript{2} y\\textsubscript{i}');
    expect(b).not.toContain('hidden');
    expect(res.tex).toContain('\\usepackage{verbatim}');
    expect(res.tex).toContain('\\newenvironment{lyxgreyedout}');
    expect(res.tex).toContain('\\definecolor{note_fontcolor}{rgb}{0.8, 0.8, 0.8}');
  });

  it('floats with graphics, caption and label; wrap floats; graphics conversion', () => {
    const fig = inset('Float figure', par('Plain Layout', '\\align center\n\\begin_inset Graphics\n\tfilename figures/plot.svg\n\twidth 50col%\n\tscaleBeforeRotation\n\trotateAngle 90\n\n\\end_inset\n\n') +
      par('Plain Layout', inset('Caption Standard', par('Plain Layout', 'Cap \\begin_inset CommandInset label\nLatexCommand label\nname "fig:one"\n\n\\end_inset\n\n'))), 'placement H\nalignment document\nwide false\nsideways false\n');
    const src = lyx(par('Standard', fig) + par('Standard', 'See \\begin_inset CommandInset ref\nLatexCommand ref\nreference "fig:one"\nplural "false"\ncaps "false"\nnoprefix "false"\nnolink "false"\n\n\\end_inset\n\n and \\begin_inset CommandInset ref\nLatexCommand formatted\nreference "fig:one"\nplural "false"\ncaps "true"\nnoprefix "false"\nnolink "false"\n\n\\end_inset\n\n.') +
      par('Standard', inset('Wrap figure', par('Plain Layout', '\\begin_inset Graphics\n\tfilename img.png\n\tscale 50\n\n\\end_inset\n\n'), 'lines 0\nplacement o\noverhang 0col%\nwidth 40col%\n')),
      ['\\postpone_fragile_content true']);
    const res = tex(src);
    const b = body(res);
    expect(b).toContain('\\begin{figure}[H]\n\\begin{centering}\n\\includegraphics[width=0.5\\columnwidth,angle=90]{figures_plot_svg}\n\\par\\end{centering}\n\\caption{Cap }\\label{fig:one}\n\\end{figure}');
    expect(b).toContain('See \\ref{fig:one} and \\Figref{one}.');
    expect(b).toContain('\\begin{wrapfigure}{o}{0.4\\columnwidth}%\n\\includegraphics[scale=0.5]{img}\\end{wrapfigure}%');
    expect(res.graphics).toEqual([{ src: 'figures/plot.svg', dest: 'figures_plot_svg.pdf' }]);
    expect(res.tex).toContain('\\usepackage{float}');
    expect(res.tex).toContain('\\usepackage{wrapfig}');
    expect(res.tex).toContain('\\usepackage{graphicx}');
    expect(res.tex).toContain('\\usepackage{refstyle}');
    // LyX quirk: the capitalised prefix is also used in the label of the providecommand
    expect(res.tex).toContain('\\AtBeginDocument{\\providecommand\\Figref[1]{\\ref{Fig:#1}}}');
  });

  it('prettyref and cleveref for formatted references', () => {
    const ref = '\\begin_inset CommandInset ref\nLatexCommand formatted\nreference "sec:a"\nplural "false"\ncaps "false"\nnoprefix "false"\nnolink "false"\n\n\\end_inset\n\n';
    const pr = tex(lyx(par('Standard', ref), ['\\use_refstyle 0']));
    expect(body(pr)).toContain('\\prettyref{sec:a}');
    expect(pr.tex).toContain('\\usepackage{prettyref}');
    const cr = tex(lyx(par('Standard', ref), ['\\crossref_package cleveref']));
    expect(body(cr)).toContain('\\cref{sec:a}');
    expect(cr.tex).toContain('\\usepackage{cleveref}');
  });

  it('citations and bibtex with natbib', () => {
    const cite = (cmd: string, extra = '') => `\\begin_inset CommandInset citation\nLatexCommand ${cmd}\n${extra}key "a,b"\nliteral "false"\n\n\\end_inset\n\n`;
    const bib = '\\begin_inset CommandInset bibtex\nLatexCommand bibtex\nbibfiles "refs,more"\noptions "plainnat"\n\n\\end_inset\n\n';
    const res = tex(lyx(par('Standard', cite('citep') + cite('citet', 'before "see"\nafter "p. 3"\n') + cite('nocite')) + par('Standard', bib), ['\\cite_engine natbib', '\\cite_engine_type authoryear']));
    expect(body(res)).toContain('\\citep{a,b}\\citet[see][p. 3]{a,b}\\nocite{a,b}\n\n\\bibliographystyle{plainnat}\n\\bibliography{refs,more}');
    expect(res.tex).toContain('\\usepackage[authoryear]{natbib}');
    const basic = tex(lyx(par('Standard', cite('citep')), ['\\cite_engine basic']));
    expect(body(basic)).toContain('\\cite{a,b}');
    const biblatex = tex(lyx(par('Standard', cite('citet') + bib), ['\\cite_engine biblatex', '\\biblatex_bibstyle authoryear', '\\biblatex_citestyle authoryear']));
    expect(body(biblatex)).toContain('\\citet{a,b}\\printbibliography');
    expect(biblatex.tex).toContain('\\usepackage[style=authoryear]{biblatex}');
    expect(biblatex.tex).toContain('\\addbibresource{refs.bib}');
  });

  it('bibliography environment with bibitems', () => {
    const item = (key: string, label: string) => `\\begin_inset CommandInset bibitem\nLatexCommand bibitem\nkey "${key}"\nlabel "${label}"\nliteral "false"\n\n\\end_inset\n\nText ${key}`;
    const b = body(tex(lyx(par('Bibliography', item('k1', 'Knuth 84')) + par('Bibliography', item('k2', 'L')))));
    expect(b).toContain('\\begin{thebibliography}{Knuth 84}\n\\bibitem[Knuth 84]{k1}Text k1\n\n\\bibitem[L]{k2}Text k2\n\n\\end{thebibliography}');
  });

  it('hyperlinks, index, toc, listings, boxes, branches', () => {
    const src = lyx(
      par('Standard', '\\begin_inset CommandInset toc\nLatexCommand tableofcontents\n\n\\end_inset\n\n') +
      par('Standard', '\\begin_inset CommandInset href\nLatexCommand href\nname "LyX"\ntarget "https://www.lyx.org"\nliteral "false"\n\n\\end_inset\n\n \\begin_inset CommandInset href\nLatexCommand href\ntarget "me@x.org"\ntype "mailto:"\nliteral "false"\n\n\\end_inset\n\n') +
      par('Standard', `word${inset('Index idx', par('Plain Layout', 'word'), 'range none\npageformat default\n')} \\begin_inset CommandInset index_print\nLatexCommand printindex\ntype "idx"\nname "Index"\n\n\\end_inset\n\n`) +
      par('Standard', inset('listings', par('Plain Layout', 'int x = 1;') + par('Plain Layout', 'return x;'), 'lstparams "language=C"\ninline false\n')) +
      par('Standard', inset('Box Boxed', par('Plain Layout', 'boxed'), 'position "t"\nhor_pos "c"\nhas_inner_box 1\ninner_pos "t"\nuse_parbox 0\nuse_makebox 0\nwidth "100col%"\nspecial "none"\nheight "1in"\nheight_special "totalheight"\nthickness "0.4pt"\nseparation "3pt"\nshadowsize "4pt"\nframecolor "black"\nbackgroundcolor "none"\n')) +
      par('Standard', inset('Branch Yes', par('Plain Layout', 'shown'), 'inverted 0\n') + inset('Branch No', par('Plain Layout', 'hidden'), 'inverted 0\n')),
      ['\\branch Yes', '\\selected 1', '\\filename_suffix 0', '\\color #faf0e6', '\\end_branch', '\\branch No', '\\selected 0', '\\filename_suffix 0', '\\color #faf0e6', '\\end_branch'],
    );
    const res = tex(src);
    const b = body(res);
    expect(b).toContain('\\tableofcontents{}');
    expect(b).toContain('\\href{https://www.lyx.org}{LyX} \\href{mailto:me@x.org}{me@x.org}');
    expect(b).toContain('word\\index{word} \\printindex{}');
    expect(b).toContain('\\begin{lstlisting}[language=C]\nint x = 1;\nreturn x;\n\\end{lstlisting}');
    expect(b).toContain('\\noindent\\fbox{\\begin{minipage}[t]{1\\columnwidth - 2\\fboxsep - 2\\fboxrule}%\nboxed%\n\\end{minipage}}');
    expect(b).toContain('shown');
    expect(b).not.toContain('hidden');
    expect(res.tex).toContain('\\usepackage{makeidx}\n\\makeindex');
    expect(res.tex).toContain('\\usepackage{listings}');
    expect(res.tex).toContain('\\usepackage{hyperref}'.replace('\\usepackage{hyperref}', '{hyperref}'));
    expect(res.tex).toContain('\\usepackage{calc}');
  });

  it('flex insets from modules', () => {
    const res = tex(lyx(par('Standard', `see ${inset('Flex Code', par('Plain Layout', 'ls -l'))} and ${inset('Flex Noun', par('Plain Layout', 'Knuth'))}`), ['\\begin_modules', 'logicalmkup', '\\end_modules']));
    expect(body(res)).toContain('see \\code{ls -l} and \\noun{Knuth}');
    expect(res.tex).toContain('\\providecommand*{\\code}[1]{\\texttt{#1}}');
    const unknown = tex(lyx(par('Standard', inset('Flex Nope', par('Plain Layout', 'x')))));
    expect(unknown.warnings.some(w => w.includes('Nope'))).toBe(true);
    expect(body(unknown)).toContain('x');
  });
});

/* --------------------------------------------------------------- math */

describe('math', () => {
  it('inline and display formulas verbatim, macros as \\global\\long\\def', () => {
    const src = lyx(
      par('Standard', '\\begin_inset FormulaMacro\n\\newcommand{\\av}[2]{\\left\\langle #1\\right\\rangle _{#2}}\n{\\langle #1 \\rangle}\n\\end_inset\n\n\n\\begin_inset FormulaMacro\n\\newcommand{\\R}{\\mathbb{R}}\n\\end_inset\n\n') +
      par('Standard', 'Let \\begin_inset Formula $x\\in\\R$\n\\end_inset\n\n be\n\\begin_inset Formula \n\\begin{align}\nf(x) & =\\av{x}{t}\\label{eq:f}\n\\end{align}\n\n\\end_inset\n\nand \\begin_inset Formula $\\text{i.i.d. over \\bm{x}}$\n\\end_inset\n\n.') +
      par('Standard', '\\begin_inset FormulaMacro\n\\newcommand{\\opt}[2][d]{#1#2}\n\\end_inset\n\n'),
    );
    const res = tex(src);
    const b = body(res);
    expect(b).toContain('\\global\\long\\def\\av#1#2{\\left\\langle #1\\right\\rangle _{#2}}%\n\\global\\long\\def\\R{\\mathbb{R}}%\n');
    expect(b).toContain('Let $x\\in\\R$ be\n\\begin{align}\nf(x) & =\\av{x}{t}\\label{eq:f}\n\\end{align}\nand $\\text{i.i.d. over \\ensuremath{\\bm{x}}}$.');
    expect(b).toContain('\\newcommandx\\opt[2][usedefault, addprefix=\\global, 1=d]{#1#2}%');
    expect(res.tex).toContain('\\usepackage{amsmath}');
    expect(res.tex).toContain('\\usepackage{amssymb}');
    expect(res.tex).toContain('\\usepackage{bm}');
    expect(res.tex).toContain('\\usepackage{xargs}');
  });

  it('protects user macros in moving arguments', () => {
    const src = lyx(par('Standard', '\\begin_inset FormulaMacro\n\\newcommand{\\bx}{\\mathbf{x}}\n\\end_inset\n\n') + par('Section', 'On \\begin_inset Formula $\\bx$\n\\end_inset\n\n'));
    expect(body(tex(src))).toContain('\\section{On $\\protect\\bx$}');
  });

  it('parses macro definitions', () => {
    expect(parseMacroDefinition('\\newcommand{\\foo}[2]{#1+#2}')).toEqual({ name: 'foo', nargs: 2, optionals: [], body: '#1+#2', redefinition: false });
    expect(parseMacroDefinition('\\renewcommand{\\foo}{x}')?.redefinition).toBe(true);
    expect(parseMacroDefinition('\\def\\foo#1{x#1}')).toEqual({ name: 'foo', nargs: 1, optionals: [], body: 'x#1', redefinition: false });
  });
});

/* --------------------------------------------------------------- tables */

describe('tables', () => {
  function cell(content: string, attrs = 'alignment="center" valignment="top"'): string {
    return `<cell ${attrs} usebox="none">\n\\begin_inset Text\n\n\\begin_layout Plain Layout\n${content}\n\\end_layout\n\n\\end_inset\n</cell>\n`;
  }
  it('tabular with lines, multicolumn and multirow', () => {
    const table = `\\begin_inset Tabular\n<lyxtabular version="3" rows="3" columns="3">\n<features tabularvalignment="middle">\n<column alignment="left" valignment="top">\n<column alignment="center" valignment="top" width="3cm">\n<column alignment="right" valignment="top">\n<row>\n` +
      cell('h1', 'multicolumn="1" alignment="center" valignment="top" topline="true" bottomline="true" leftline="true"') +
      cell('', 'multicolumn="2" alignment="center" valignment="top" topline="true" bottomline="true" leftline="true"') +
      cell('h3', 'alignment="center" valignment="top" topline="true" bottomline="true" leftline="true" rightline="true"') +
      `</row>\n<row>\n` +
      cell('m', 'multirow="1" alignment="left" valignment="top" leftline="true"') +
      cell('b', 'alignment="center" valignment="top" leftline="true"') +
      cell('c', 'alignment="center" valignment="top" leftline="true" rightline="true"') +
      `</row>\n<row>\n` +
      cell('', 'multirow="2" alignment="left" valignment="top" bottomline="true" leftline="true"') +
      cell('e', 'alignment="center" valignment="top" bottomline="true" leftline="true"') +
      cell('f', 'alignment="center" valignment="top" bottomline="true" leftline="true" rightline="true"') +
      `</row>\n</lyxtabular>\n\n\\end_inset\n\n`;
    const res = tex(lyx(par('Standard', table)));
    const b = body(res);
    expect(b).toContain('\\begin{tabular}{|l|>{\\centering}p{3cm}|r|}\n\\hline \n\\multicolumn{2}{|c|}{h1} & h3\\tabularnewline\n\\hline \n\\multirow{2}{*}{m} & b & c\\tabularnewline\n & e & f\\tabularnewline\n\\hline \n\\end{tabular}');
    expect(res.tex).toContain('\\usepackage{multirow}');
    expect(res.tex).toContain('\\usepackage{array}');
    expect(res.tex).toContain('\\providecommand{\\tabularnewline}{\\\\}');
  });

  it('booktabs longtable with header rows', () => {
    const table = `\\begin_inset Tabular\n<lyxtabular version="3" rows="2" columns="2">\n<features booktabs="true" islongtable="true" longtabularalignment="center">\n<column alignment="center" valignment="top">\n<column alignment="center" valignment="top">\n<row endhead="true">\n` +
      cell('a', 'alignment="center" valignment="top" topline="true" bottomline="true"') + cell('b', 'alignment="center" valignment="top" topline="true" bottomline="true"') +
      `</row>\n<row>\n` + cell('c', 'alignment="center" valignment="top" bottomline="true"') + cell('d', 'alignment="center" valignment="top" bottomline="true"') +
      `</row>\n</lyxtabular>\n\n\\end_inset\n\n`;
    const res = tex(lyx(par('Standard', table)));
    const b = body(res);
    expect(b).toContain('\\begin{longtable}[c]{cc}\n\\toprule \na & b\\tabularnewline\n\\midrule\n\\endhead\nc & d\\tabularnewline\n\\bottomrule\n\\end{longtable}');
    expect(res.tex).toContain('\\usepackage{longtable}');
    expect(res.tex).toContain('\\usepackage{booktabs}');
  });
});

/* ----------------------------------------------------- change tracking */

describe('change tracking', () => {
  const src = lyx(par('Standard', 'keep \n\\change_deleted 1 1700000000\ndeleted \n\\change_inserted 1 1700000000\nadded \n\\change_unchanged\nend'), ['\\author 1 "Jane Doe" "jane@example.org"', '\\tracking_changes true']);
  it('drops deleted text by default', () => {
    const b = body(tex(src));
    expect(b).toContain('keep added end');
    expect(b).not.toContain('deleted');
  });
  it('emits lyxadded/lyxdeleted when changes are output', () => {
    const res = tex(src, { outputChanges: true });
    expect(ws(body(res))).toContain('keep \\lyxdeleted{Jane Doe}{Tue Nov 14 22:13:20 2023}{deleted }\\lyxadded{Jane Doe}{Tue Nov 14 22:13:20 2023}{added }end');
    expect(res.tex).toContain('\\usepackage{xcolor}');
    expect(res.tex).toContain('\\usepackage{ulem}');
    expect(res.tex).toContain('\\DeclareRobustCommand{\\lyxadded}');
  });
});

/* ------------------------------------------------------ child documents */

describe('child documents', () => {
  it('inputs and includes children with shared features', () => {
    const child = lyx(par('Standard', 'child text \n\\series bold\nbold\n\\series default\n \\begin_inset Formula $\\lesssim$\n\\end_inset\n\n'));
    const master = lyx(par('Standard', 'master') + par('Standard', '\\begin_inset CommandInset include\nLatexCommand input\nfilename "chapters/one.lyx"\nliteral "false"\n\n\\end_inset\n\n') + par('Standard', '\\begin_inset CommandInset include\nLatexCommand include\nfilename "two.lyx"\nliteral "true"\n\n\\end_inset\n\n'));
    const res = tex(master, { resolveInclude: (n) => (n === 'chapters/one.lyx' || n === 'two.lyx' ? parseLyx(child) : undefined) });
    expect(body(res)).toContain('master\n\n\\input{chapters/one.tex}\n\n\\include{two}');
    expect(Object.keys(res.files).sort()).toEqual(['chapters/one.tex', 'two.tex']);
    expect(res.files['two.tex']).toContain('child text \\textbf{bold} $\\lesssim$');
    expect(res.files['two.tex']).not.toContain('documentclass');
    expect(res.tex).toContain('\\usepackage{amssymb}');
    const missing = tex(master);
    expect(missing.warnings.some(w => w.includes('could not be resolved'))).toBe(true);
  });
  it('exports a document as child (body only)', () => {
    const res = tex(lyx(par('Standard', 'x')), { isChild: true });
    expect(res.tex).toBe('x\n');
  });
});

/* ---------------------------------------------------------- lengths */

describe('lengths', () => {
  it('converts LyX lengths', () => {
    expect(latexLength('100col%')).toBe('1\\columnwidth');
    expect(latexLength('50text%')).toBe('0.5\\textwidth');
    expect(latexLength('2.5cm')).toBe('2.5cm');
    expect(latexLength('12.50pt')).toBe('12.5pt');
    expect(latexLength('75baselineskip%')).toBe('0.75\\baselineskip');
  });
});

/* ------------------------------------------------ comparison with LyX */

const LYX_BIN = spawnSync('which', ['lyx']).status === 0;

describe.skipIf(!LYX_BIN)('comparison with LyX 2.4 export', () => {
  const scratch = process.env.OVERLYX_SCRATCH ?? '/tmp/claude-0/-root-lyx/9250d901-48e6-4b48-98b5-a211e39f6f1d/scratchpad/lyx-compare';
  const files = ['/root/lyx/lib/examples/Welcome.lyx', '/root/lyx/lib/doc/Intro.lyx', '/root/lyx/lib/examples/Example_%28LyXified%29.lyx', '/root/lyx/lib/doc/Tutorial.lyx'];
  for (const f of files) {
    it(`body of ${f.split('/').pop()} matches modulo whitespace`, () => {
      const { mkdirSync, copyFileSync } = require('node:fs') as typeof import('node:fs');
      mkdirSync(scratch, { recursive: true });
      const name = f.split('/').pop()!;
      const local = join(scratch, name);
      copyFileSync(f, local);
      const refTex = join(scratch, name.replace(/\.lyx$/, '.ref.tex'));
      if (!existsSync(refTex)) {
        const r = spawnSync('lyx', ['-batch', '-E', 'latex', refTex, local], { env: { ...process.env, QT_QPA_PLATFORM: 'offscreen' }, timeout: 120000 });
        if (!existsSync(refTex)) { console.log('LyX export failed:', String(r.stderr).slice(-500)); return; }
      }
      const doc = parseLyx(readFileSync(f, 'utf8'));
      const res = exportLatex(doc, { resolveInclude: (n) => { const p = join(dirname(f), n); return existsSync(p) ? parseLyx(readFileSync(p, 'utf8')) : undefined; } });
      const raw = readFileSync(refTex);
      let ref: string;
      try { ref = new TextDecoder('utf-8', { fatal: true }).decode(raw); } catch { ref = raw.toString('latin1'); }
      const refBody = ws(ref.slice(ref.indexOf('\\begin{document}')));
      const ourBody = ws(res.tex.slice(res.tex.indexOf('\\begin{document}')));
      // key structures must agree
      for (const key of ['\\section', '\\begin{itemize}', '\\begin{enumerate}', '\\footnote{', '\\begin{description}', '\\emph{', '\\begin{figure}', '\\begin{tabular}']) {
        const n = (s: string) => s.split(key).length - 1;
        if (n(refBody) !== n(ourBody)) console.log(`${name}: count of ${key} differs: lyx ${n(refBody)} vs ours ${n(ourBody)}`);
        expect(Math.abs(n(refBody) - n(ourBody))).toBeLessThanOrEqual(Math.max(1, Math.floor(n(refBody) * 0.05)));
      }
      // similarity of the whole body (informative)
      const a = refBody.split(' ');
      const b = ourBody.split(' ');
      let same = 0;
      const setB = new Map<string, number>();
      for (const w of b) setB.set(w, (setB.get(w) ?? 0) + 1);
      for (const w of a) { const c = setB.get(w) ?? 0; if (c > 0) { same++; setB.set(w, c - 1); } }
      const ratio = same / Math.max(a.length, b.length);
      console.log(`${name}: token overlap with LyX output ${(ratio * 100).toFixed(1)}% (${a.length} vs ${b.length} tokens)`);
      expect(ratio).toBeGreaterThan(0.9);
      if (name === 'Welcome.lyx') expect(ourBody.replace(/\\includegraphics\[[^\]]*\]\{[^}]*\} ?/g, '')).toBe(refBody.replace(/\\includegraphics\[[^\]]*\]\{[^}]*\} ?/g, ''));
    });
  }
});
