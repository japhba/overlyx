/**
 * The first save must not rewrite what nobody touched (core tex/preserve.ts, tex/parse.ts). Over the
 * starters, the welcome document and synthetic fixtures that reproduce what real documents hold
 * (an imported LyX document's settings line with its defaults left out and an \input{preamble} with
 * hyperref, cleveref and a guarded fontspec; an older OverLyX block; REVTeX with a PDF setting and
 * no hyperref; a hand-written paper with \path, floats with tables and \renewcommand{\arraystretch},
 * multi-line formulas, \end{center} followed by text; a child document of tables):
 *   (a) open + save untouched gives the file back byte for byte;
 *   (b) one word changed in one paragraph changes that paragraph's lines and nothing else.
 *   npx vitest run tests/tex-firstsave.test.ts
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { parseTex, writeTex, writeTexPreserving, type ParseTexResult } from '../packages/core/src/tex/index.ts';
import { canonical } from '../packages/core/src/tex/preserve.ts';
import { align } from '../packages/core/src/lyx/merge.ts';
import { lyxToPm, pmToLyxBody, type LyxDocument, type Paragraph } from '../packages/core/src/index.ts';
import { LYX_LAYOUTS } from './lyxlib.ts';

const ROOT = join(import.meta.dirname, '..');

/** An imported LyX document as OverLyX wrote it (the shape of a real one, made-up text). */
const IMPORTED = `%% Imported from abstract.lyx by OverLyX on 2026-08-28.
\\documentclass[fontsize=12,american]{scrartcl}
\\usepackage[T1]{fontenc}
\\usepackage{geometry}
\\geometry{verbose,tmargin=0.5in,bmargin=0.5in,lmargin=0.5in,rmargin=0.5in}
\\usepackage{float}
\\usepackage{amsmath}
\\usepackage{amssymb}
\\usepackage{graphicx}

\\makeatletter
%%%%%%%%%%%%%%%%%%%%%%%%%%%%%% User specified LaTeX commands.
\\input{preamble}
\\newcommand\\scalemath[2]{\\scalebox{#1}{\\mbox{\\ensuremath{\\displaystyle #2}}}}

\\makeatother

\\usepackage{babel}
\\usepackage[style=authoryear,natbib=true,maxcitenames=1]{biblatex}
\\addbibresource{refs.bib}

%% OverLyX ------------------------------------------------------------------
%% overlyx-settings: {"textclass":"scrartcl","language":"american","inputencoding":"default","fontencoding":"global","cite_engine":"biblatex-natbib","cite_engine_type":"authoryear","biblio_options":"maxcitenames=1","biblatex_bibstyle":"authoryear","biblatex_citestyle":"authoryear","use_refstyle":"0","output_changes":"false","paperfontsize":"12","papersize":"a4paper","use_geometry":"true","pdf_colorlinks":"true"}
%% Packages and macros needed by the content (generated on every save; put your own preamble above this block).
\\usepackage{amstext}
\\makeatletter
%% Change tracking: Disable markup in output
\\newcommand{\\lyxadded}[3]{#3}
\\newcommand{\\lyxdeleted}[3]{}
\\makeatother
\\addbibresource{refs.bib}
%% end OverLyX --------------------------------------------------------------

\\begin{document}

\\subsubsection*{Sparse codes regularise recurrent networks}

\\paragraph*{Summary}

Recurrent networks trained on small data sets tend to memorise their
inputs. We show that a discrete bottleneck between the layers acts
as a regulariser \\citep{someone2020}, and that its strength can be
read off the spectrum of the trained weights (see \\cref{fig:spectrum}).

\\begin{figure}[H]
\\begin{centering}
\\includegraphics[width=0.8\\columnwidth]{figures/spectrum}
\\par\\end{centering}
\\caption{The spectrum of the trained weights.\\label{fig:spectrum}}
\\end{figure}

The bottleneck has a single parameter, the number of symbols per
step. With few symbols the network generalises; with many it memorises
again, as the table shows.

\\begin{table}[H]
\\begin{centering}
\\renewcommand{\\arraystretch}{1.5}
\\begin{tabular}{lcc}
\\toprule
Symbols & Train error & Test error \\\\
\\midrule
2 & 0.12 & 0.15 \\\\
16 & 0.03 & 0.21 \\\\
\\bottomrule
\\end{tabular}
\\par\\end{centering}
\\caption{Errors for two bottleneck sizes.}
\\end{table}

\\paragraph*{Acknowledgements}

We thank the reviewers for their careful reading.

\\printbibliography

\\end{document}
`;

/** what \\input{preamble} reads */
const PREAMBLE_TEX = `\\usepackage{iftex}
\\newif\\ifunicodeengine\\unicodeenginefalse
\\ifxetex\\unicodeenginetrue\\fi
\\ifluatex\\unicodeenginetrue\\fi
\\ifunicodeengine
  \\usepackage{fontspec}
\\fi
\\usepackage[colorlinks=true]{hyperref}
\\usepackage{cleveref}
`;

/** REVTeX, a PDF setting in the settings line, no hyperref anywhere (the block an older OverLyX wrote). */
const REVTEX = `\\documentclass[aps,prl,twocolumn]{revtex4-1}
\\usepackage{amsmath}
\\usepackage{amssymb}
\\usepackage{cleveref}

%% OverLyX ------------------------------------------------------------------
%% overlyx-settings: {"textclass":"revtex4-1","fontencoding":"global","cite_engine":"natbib","cite_engine_type":"authoryear","use_refstyle":"1","output_changes":"false","pdf_colorlinks":"false","bibtex_command":"bibtex"}
%% Packages and macros needed by the content (generated on every save; put your own preamble above this block).
%% end OverLyX --------------------------------------------------------------

\\begin{document}

\\title{Coupled oscillators near a bifurcation}

\\author{A. Author}

\\maketitle

\\section{Introduction}

Networks of coupled oscillators synchronise when the coupling exceeds
a critical value. Below it, the phases drift independently; above it,
a macroscopic fraction locks to a common frequency.

\\section{Model}

We study $N$ oscillators with phases $\\theta_{i}$ that obey
\\begin{equation}
\\dot{\\theta}_{i}=\\omega_{i}+\\frac{K}{N}\\sum_{j=1}^{N}\\sin(\\theta_{j}-\\theta_{i}),\\label{eq:model}
\\end{equation}
where the natural frequencies $\\omega_{i}$ are drawn from a distribution
with a single peak. \\Cref{eq:model} is the classical starting point.

\\end{document}
`;

/** A hand-written paper (Overleaf style): no managed block, hard-wrapped lines, tables in floats. */
const HANDWRITTEN = `\\documentclass{article}
\\usepackage[a4paper,margin=25mm]{geometry}
\\usepackage{amsmath,amssymb,bm,booktabs,graphicx,hyperref}
\\newcommand{\\EE}{\\mathbb E}
\\title{Four learners at equal budgets}
\\author{}
\\date{8 September 2026}

\\begin{document}
\\maketitle

\\section{Setting}
The code that produced every number is in \\path{src/run.py}; it
evaluates all modes and checks the identities below.

\\begin{table}[t]
\\centering
\\caption{The steps of the derivation.}
\\label{tab:steps}
\\renewcommand{\\arraystretch}{1.5}
\\begin{tabular}{p{.23\\linewidth}p{.69\\linewidth}}
\\toprule
Step & Equation or assumption \\\\
\\midrule
Sampled gradient &
 $g_a=b^{-1}\\sum_{\\mu=1}^b\\chi_a(x_\\mu)
       [e(x_\\mu)-\\epsilon_\\mu]$;
 the label noise has variance $\\sigma^2$. \\\\
Mode update & $e'_a=e_a-\\eta\\lambda_a g_a$. \\\\
Conditional mean & $\\EE[g_a\\mid e]=e_a$. \\\\
\\bottomrule
\\end{tabular}
\\end{table}

The mean error then follows a linear recursion,
\\begin{align}
\\EE[e'_a] &= (1-\\eta\\lambda_a)\\,\\EE[e_a], \\\\
q'_a &= (1-\\eta\\lambda_a)^2 q_a + \\eta^2\\lambda_a^2 R/b,
\\end{align}
which we solve in closed form below.

\\begin{center}
\\begin{tabular}{lr}
\\toprule
Learner & Rate \\\\
\\midrule
Shallow & [0.12, 0.15] \\\\
Deep & 0.31 \\\\
\\bottomrule
\\end{tabular}
\\end{center}
The intervals are percentile bootstrap intervals over the seeds; they
are not simultaneous intervals.

\\section{Results}
Both learners reach the same risk, but the deep one gets there in
half the number of steps.

\\end{document}
`;

/** A child document of tables, written by OverLyX (settings line at the top). */
const CHILD = `%% overlyx-settings: {"textclass":"article"}
\\begin{center}
\\begin{tabular}{llr}
\\toprule
Target & Learner & Final risk \\\\
\\midrule
Interaction & Shallow & [1.01, 1.04] \\\\
Interaction & Deep & 1.0075 \\\\
\\bottomrule
\\end{tabular}
\\end{center}
Final risk is evaluated on all population inputs. Ranges span three independent seeds; they are not confidence intervals.
\\begin{center}
\\begin{tabular}{ll}
\\toprule
Learner & Status \\\\
\\midrule
Shallow & \\texttt{budget\\_reached} \\\\
\\bottomrule
\\end{tabular}
\\end{center}
`;

interface Case { name: string; text: string; files?: Record<string, string> }

const read = (rel: string) => readFileSync(join(ROOT, rel), 'utf8');
const CASES: Case[] = [
  { name: 'starter paper', text: read('packages/server/templates/starters/paper/paper.tex') },
  { name: 'starter slides', text: read('packages/server/templates/starters/slides/slides.tex') },
  { name: 'welcome', text: read('packages/server/templates/welcome/welcome.tex') },
  { name: 'imported LyX document', text: IMPORTED, files: { 'preamble.tex': PREAMBLE_TEX } },
  { name: 'REVTeX with a PDF setting', text: REVTEX },
  { name: 'hand-written paper', text: HANDWRITTEN },
  { name: 'child of tables', text: CHILD },
];

function tools(c: Case) {
  const readFile = (name: string) => c.files?.[name];
  const opts = { layoutDir: LYX_LAYOUTS, readFile };
  const parse = (t: string): ParseTexResult => parseTex(t, opts);
  const fragment = parse(c.text).fragment;
  const write = (d: LyxDocument) => writeTex(d, { ...opts, fragment });
  return { parse, write };
}

/** the document as the editor hands it back (ProseMirror round trip) */
const viaEditor = (d: LyxDocument): LyxDocument => ({ ...d, header: { lines: [...d.header.lines] }, body: pmToLyxBody(JSON.parse(JSON.stringify(lyxToPm(d)))) });

function save(c: Case, edit: (d: LyxDocument) => void): { text: string; doc: LyxDocument } {
  const { parse, write } = tools(c);
  const doc = viaEditor(parse(c.text).doc);
  edit(doc);
  return { text: writeTexPreserving(doc, { base: c.text, parse, write }).text, doc };
}

/** the changed stretches of `a` → `b`: [first line, end line) of `a` and how many lines replace them */
function hunks(a: string, b: string): { a0: number; a1: number; added: number }[] {
  const A = a.split('\n'), B = b.split('\n');
  const out: { a0: number; a1: number; added: number }[] = [];
  let ai = 0, bi = 0;
  for (const [i, j] of [...align(A, B), [A.length, B.length] as [number, number]]) {
    if (i > ai || j > bi) out.push({ a0: ai, a1: i, added: j - bi });
    ai = i + 1; bi = j + 1;
  }
  return out;
}
const lineAt = (s: string, off: number) => s.slice(0, off).split('\n').length - 1;

/** the top-level paragraphs with a word of five letters or more in a plain text run, by index */
function wordParagraphs(d: LyxDocument): number[] {
  return d.body.flatMap((p: Paragraph, k) => (p.items.some(it => it.kind === 'text' && !it.change && /\b[a-z]{5,}\b/.test(it.text)) ? [k] : []));
}
function changeWord(p: Paragraph): void {
  for (const it of p.items) if (it.kind === 'text' && !it.change && /\b[a-z]{5,}\b/.test(it.text)) { it.text = it.text.replace(/\b[a-z]{5,}\b/, 'CHANGED'); return; }
}

describe('the first save changes only what was edited', () => {
  for (const c of CASES) {
    it(`${c.name}: a save without an edit gives the file back byte for byte`, () => {
      expect(save(c, () => {}).text).toBe(c.text);
    });

    it(`${c.name}: one word changed in a paragraph changes that paragraph's lines only`, () => {
      const { parse } = tools(c);
      const base = parse(c.text);
      const ks = wordParagraphs(viaEditor(base.doc)).filter(k => base.sources[k]);
      expect(ks.length).toBeGreaterThan(0);
      for (const k of ks) {
        const r = save(c, d => changeWord(d.body[k]));
        expect(r.text).toContain('CHANGED');
        const src = base.sources[k]!;
        const l0 = lineAt(c.text, src.start), l1 = lineAt(c.text, src.end);
        const outside = hunks(c.text, r.text).filter(h => h.a0 < l0 || h.a1 > l1 + 1);
        expect(outside.map(h => c.text.split('\n').slice(h.a0, h.a1).join('\n') + ` (+${h.added})`), `paragraph ${k}`).toEqual([]);
        expect(parse(r.text).doc.body.map(canonical)).toEqual(r.doc.body.map(canonical));
      }
    });
  }

  it('what the preamble loads takes effect without being written into the settings line', () => {
    // fontspec (through \input{preamble}) builds with XeTeX, hyperref and cleveref count, as before;
    // the settings line, which leaves them out, stays as it is
    const c = CASES.find(x => x.name === 'imported LyX document')!;
    const h = tools(c).parse(IMPORTED).doc.header.lines;
    expect(h).toContain('\\use_non_tex_fonts true');
    expect(h).toContain('\\default_output_format pdf4');
    expect(h).toContain('\\use_hyperref true');
    expect(h).toContain('\\crossref_package cleveref');
    const r = save(c, d => { d.header.lines = d.header.lines.map(l => (l.startsWith('\\output_changes') ? '\\output_changes true' : l)); });
    const line = (t: string) => JSON.parse(t.split('\n').find(l => l.startsWith('%% overlyx-settings: '))!.slice('%% overlyx-settings: '.length));
    // (output_changes back to its default: the key goes, the rest of the line is the file's)
    const want = { ...line(IMPORTED) };
    delete want.output_changes;
    expect(line(r.text)).toEqual(want);
    expect(line(r.text).use_non_tex_fonts).toBeUndefined();
  });
});
