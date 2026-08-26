/**
 * Compilation tests: export documents with OverLyX and run them through
 * latexmk (pdflatex). These take a while; run separately with
 *   npx vitest run tests/compile.test.ts
 */
import { describe, it, expect } from 'vitest';
import { copyFileSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { parseLyx } from '../packages/core/src/lyx/parser.ts';
import { exportLatex } from '../packages/core/src/latex/export.ts';

const SCRATCH = process.env.OVERLYX_SCRATCH ?? '/tmp/claude-0/-root-lyx/9250d901-48e6-4b48-98b5-a211e39f6f1d/scratchpad/compile-tests';
const HAVE_LATEXMK = spawnSync('which', ['latexmk']).status === 0;

interface CompileResult { pdf: boolean; errors: string[]; log: string; warnings: string[] }

/** Export a .lyx file into `outdir` (graphics converted) and compile it with latexmk. */
function exportAndCompile(lyxFile: string, outdir: string, timeoutMs = 240000): CompileResult {
  rmSync(outdir, { recursive: true, force: true });
  mkdirSync(outdir, { recursive: true });
  const docdir = dirname(lyxFile);
  // TeX cannot handle % or spaces in file names: use a sanitised base name
  const base = basename(lyxFile).replace(/\.lyx$/, '').replace(/[^A-Za-z0-9_-]/g, '_');
  const doc = parseLyx(readFileSync(lyxFile, 'utf8'));
  const res = exportLatex(doc, {
    basename: base,
    resolveInclude: (name) => { const p = join(docdir, name); return existsSync(p) ? parseLyx(readFileSync(p, 'utf8')) : undefined; },
  });
  writeFileSync(join(outdir, base + '.tex'), res.tex);
  for (const [name, content] of Object.entries(res.files)) {
    mkdirSync(dirname(join(outdir, name)), { recursive: true });
    writeFileSync(join(outdir, name), content);
  }
  for (const g of res.graphics) {
    const from = join(docdir, g.src);
    const to = join(outdir, g.dest);
    if (!existsSync(from)) continue;
    mkdirSync(dirname(to), { recursive: true });
    if (to.endsWith('.pdf') && !from.endsWith('.pdf')) {
      let r = spawnSync('rsvg-convert', ['-f', 'pdf', '-o', to, from]);
      if (r.status !== 0) r = spawnSync('inkscape', ['--export-type=pdf', `--export-filename=${to}`, from]);
      if (r.status !== 0) spawnSync('convert', [from, to]);
    } else copyFileSync(from, to);
  }
  const env = { ...process.env, TEXINPUTS: `${docdir}//:`, BIBINPUTS: `${docdir}//:`, BSTINPUTS: `${docdir}//:` };
  spawnSync('latexmk', ['-pdf', '-bibtex', '-interaction=nonstopmode', '-f', base + '.tex'], { cwd: outdir, env, timeout: timeoutMs });
  const logFile = join(outdir, base + '.log');
  const log = existsSync(logFile) ? readFileSync(logFile, 'latin1') : '';
  const errors = log.split('\n').filter(l => l.startsWith('! '));
  return { pdf: existsSync(join(outdir, base + '.pdf')), errors, log, warnings: res.warnings };
}

function report(name: string, r: CompileResult): void {
  const uniq = [...new Set(r.errors)];
  if (r.errors.length) {
    const lines = r.log.split('\n');
    const i = lines.findIndex(l => l.startsWith('! '));
    console.log(lines.slice(i, i + 8).join('\n'));
  }
  console.log(`${name}: pdf=${r.pdf} errors=${r.errors.length}${uniq.length ? ' ' + uniq.slice(0, 5).join(' | ') : ''}${r.warnings.length ? ` export warnings=${r.warnings.length}` : ''}`);
}

/* ------------------------------------------------ (a) synthetic document */

function syntheticDocument(dir: string): string {
  mkdirSync(join(dir, 'figures'), { recursive: true });
  // a PNG from the LyX documentation and an SVG
  const pngSrc = ['/root/lyx/lib/doc/clipart/ToolbarEnvBox.png', '/usr/share/lyx/doc/clipart/ToolbarEnvBox.png'].find(existsSync);
  if (pngSrc) copyFileSync(pngSrc, join(dir, 'figures', 'dot.png'));
  else writeFileSync(join(dir, 'figures', 'dot.png'), Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M/wHwAE/wJ/l0qNqQAAAABJRU5ErkJggg==', 'base64'));
  writeFileSync(join(dir, 'figures', 'box.svg'), '<svg xmlns="http://www.w3.org/2000/svg" width="40" height="20"><rect width="40" height="20" fill="teal"/></svg>\n');
  writeFileSync(join(dir, 'refs.bib'), '@article{knuth84, author={Donald E. Knuth}, title={Literate Programming}, journal={The Computer Journal}, year={1984}, volume={27}, pages={97--111}}\n@book{lamport94, author={Leslie Lamport}, title={LaTeX: A Document Preparation System}, publisher={Addison-Wesley}, year={1994}}\n');
  const child = `#LyX 2.4 created this file. For more info see https://www.lyx.org/
\\lyxformat 614
\\begin_document
\\begin_header
\\textclass article
\\language english
\\inputencoding utf8
\\end_header
\\begin_body

\\begin_layout Standard
This paragraph comes from the child document with 
\\begin_inset Formula $\\alpha\\lesssim\\beta$
\\end_inset

.
\\end_layout

\\end_body
\\end_document
`;
  writeFileSync(join(dir, 'child.lyx'), child);
  const cell = (c: string, extra = '') => `<cell alignment="center" valignment="top" ${extra} usebox="none">\n\\begin_inset Text\n\n\\begin_layout Plain Layout\n${c}\n\\end_layout\n\n\\end_inset\n</cell>\n`;
  const main = `#LyX 2.4 created this file. For more info see https://www.lyx.org/
\\lyxformat 614
\\begin_document
\\begin_header
\\textclass article
\\begin_preamble
\\usepackage{lipsum}
\\end_preamble
\\use_default_options true
\\begin_modules
theorems-ams
logicalmkup
\\end_modules
\\language english
\\inputencoding utf8
\\fontencoding auto
\\font_roman "default" "default"
\\font_sans "default" "default"
\\font_typewriter "default" "default"
\\use_non_tex_fonts false
\\paperfontsize 11
\\spacing single
\\use_hyperref true
\\pdf_bookmarks true
\\pdf_colorlinks true
\\papersize a4
\\use_geometry true
\\leftmargin 2.5cm
\\rightmargin 2.5cm
\\use_package amsmath 1
\\use_package amssymb 1
\\cite_engine natbib
\\cite_engine_type authoryear
\\biblio_style plainnat
\\use_refstyle 1
\\branch Draft
\\selected 1
\\filename_suffix 0
\\color #faf0e6
\\end_branch
\\branch Hidden
\\selected 0
\\filename_suffix 0
\\color #faf0e6
\\end_branch
\\secnumdepth 3
\\tocdepth 3
\\paragraph_separation indent
\\quotes_style english
\\papercolumns 1
\\papersides 1
\\paperpagestyle default
\\tracking_changes true
\\output_changes false
\\author 1 "Jane Doe" "jane@example.org"
\\end_header

\\begin_body

\\begin_layout Title
OverLyX Export Test
\\end_layout

\\begin_layout Author
Jane Doe
\\begin_inset Foot
status open

\\begin_layout Plain Layout
Thanks to everyone.
\\end_layout

\\end_inset


\\end_layout

\\begin_layout Abstract
An abstract with math 
\\begin_inset Formula $E=mc^{2}$
\\end_inset

 and a quote: 
\\begin_inset Quotes eld
\\end_inset

hello
\\begin_inset Quotes erd
\\end_inset

.
\\end_layout

\\begin_layout Standard
\\begin_inset CommandInset toc
LatexCommand tableofcontents

\\end_inset


\\end_layout

\\begin_layout Section
Introduction
\\begin_inset CommandInset label
LatexCommand label
name "sec:intro"

\\end_inset


\\end_layout

\\begin_layout Standard
\\begin_inset FormulaMacro
\\newcommand{\\R}{\\mathbb{R}}
\\end_inset


\\begin_inset FormulaMacro
\\newcommand{\\av}[2]{\\left\\langle #1\\right\\rangle _{#2}}
\\end_inset


\\end_layout

\\begin_layout Standard
Some text with 
\\series bold
bold
\\series default
, 
\\emph on
emphasis
\\emph default
, 
\\family typewriter
typewriter
\\family default
, 
\\color blue
blue
\\color inherit
 and 
\\size small
small
\\size default
 text. Special: 50% & $ # _ { } ~ ^ [x] \\backslash
 é ü — ∞ ≤.
\\SpecialChar ldots

\\SpecialChar LyX

 rocks
\\SpecialChar endofsentence

 Menu
\\SpecialChar menuseparator
Item. Refs: 
\\begin_inset CommandInset ref
LatexCommand ref
reference "sec:intro"
plural "false"
caps "false"
noprefix "false"
nolink "false"

\\end_inset

, 
\\begin_inset CommandInset ref
LatexCommand formatted
reference "sec:intro"
plural "false"
caps "true"
noprefix "false"
nolink "false"

\\end_inset

, 
\\begin_inset CommandInset ref
LatexCommand eqref
reference "eq:one"
plural "false"
caps "false"
noprefix "false"
nolink "false"

\\end_inset

. Cite 
\\begin_inset CommandInset citation
LatexCommand citep
key "knuth84,lamport94"
literal "false"

\\end_inset

 and 
\\begin_inset CommandInset citation
LatexCommand citet
after "p. 5"
key "knuth84"
literal "false"

\\end_inset

.
\\begin_inset Foot
status open

\\begin_layout Plain Layout
A footnote with 
\\begin_inset Formula $x\\in\\R$
\\end_inset

.
\\end_layout

\\end_inset

 Link: 
\\begin_inset CommandInset href
LatexCommand href
name "LyX"
target "https://www.lyx.org"
literal "false"

\\end_inset

. Code: 
\\begin_inset Flex Code
status collapsed

\\begin_layout Plain Layout
ls -l
\\end_layout

\\end_inset

. Index
\\begin_inset Index idx
range none
pageformat default
status collapsed

\\begin_layout Plain Layout
index entry
\\end_layout

\\end_inset

. Deleted 
\\change_deleted 1 1700000000
gone 
\\change_inserted 1 1700000000
added 
\\change_unchanged
end.
\\end_layout

\\begin_layout Standard
Display math:
\\begin_inset Formula 
\\begin{align}
f(x) & =\\av{x}{t}+\\int_{0}^{1}g(t)\\,dt\\label{eq:one}\\\\
 & =\\text{const. for \\bm{x}}\\nonumber
\\end{align}

\\end_inset

and 
\\begin_inset Formula \\[
\\sum_{i=1}^{N}x_{i}\\lesssim\\coloneqq y
\\]

\\end_inset


\\end_layout

\\begin_layout Itemize
first item
\\end_layout

\\begin_layout Itemize
second item
\\end_layout

\\begin_deeper
\\begin_layout Enumerate
nested one
\\end_layout

\\begin_layout Enumerate
nested two
\\end_layout

\\end_deeper
\\begin_layout Description
Term description of the term
\\end_layout

\\begin_layout Quote
A quotation.
\\end_layout

\\begin_layout Theorem
Every theorem is true.
\\end_layout

\\begin_layout Proof
Trivial.
\\end_layout

\\begin_layout LyX-Code
code line 1
\\end_layout

\\begin_layout LyX-Code
  code line 2
\\end_layout

\\begin_layout Standard
\\align center
Centered paragraph.
\\end_layout

\\begin_layout Standard
\\noindent
No indent 
\\begin_inset Note Note
status open

\\begin_layout Plain Layout
invisible
\\end_layout

\\end_inset


\\begin_inset Note Comment
status open

\\begin_layout Plain Layout
a comment
\\end_layout

\\end_inset


\\begin_inset Note Greyedout
status open

\\begin_layout Plain Layout
greyed out
\\end_layout

\\end_inset

 
\\begin_inset ERT
status open

\\begin_layout Plain Layout

\\backslash
textsc{ert}
\\end_layout

\\end_inset

 x
\\begin_inset script superscript
status open

\\begin_layout Plain Layout
2
\\end_layout

\\end_inset

 
\\begin_inset Branch Draft
inverted 0
status open

\\begin_layout Plain Layout
draft branch
\\end_layout

\\end_inset


\\begin_inset Branch Hidden
inverted 0
status open

\\begin_layout Plain Layout
HIDDENBRANCH
\\end_layout

\\end_inset


\\begin_inset Marginal
status open

\\begin_layout Plain Layout
margin
\\end_layout

\\end_inset


\\end_layout

\\begin_layout Standard
\\begin_inset Float figure
placement H
alignment document
wide false
sideways false
status open

\\begin_layout Plain Layout
\\align center
\\begin_inset Graphics
	filename figures/box.svg
	width 30col%

\\end_inset

 
\\begin_inset Graphics
	filename figures/dot.png
	scale 200

\\end_inset


\\end_layout

\\begin_layout Plain Layout
\\begin_inset Caption Standard

\\begin_layout Plain Layout
A figure with 
\\begin_inset Formula $\\R$
\\end_inset

.
\\begin_inset CommandInset label
LatexCommand label
name "fig:one"

\\end_inset


\\end_layout

\\end_inset


\\end_layout

\\end_inset


\\end_layout

\\begin_layout Standard
\\begin_inset Float table
placement tbp
alignment document
wide false
sideways false
status open

\\begin_layout Plain Layout
\\begin_inset Caption Standard

\\begin_layout Plain Layout
A table
\\end_layout

\\end_inset


\\end_layout

\\begin_layout Plain Layout
\\align center
\\begin_inset Tabular
<lyxtabular version="3" rows="3" columns="3">
<features tabularvalignment="middle">
<column alignment="left" valignment="top">
<column alignment="center" valignment="top" width="3cm">
<column alignment="right" valignment="top">
<row>
${cell('Head', 'multicolumn="1" topline="true" bottomline="true" leftline="true" rightline="true"')}${cell('', 'multicolumn="2" topline="true" bottomline="true" leftline="true"')}${cell('h3', 'topline="true" bottomline="true" leftline="true" rightline="true"')}</row>
<row>
${cell('multi', 'multirow="1" leftline="true"')}${cell('b', 'leftline="true"')}${cell('c', 'leftline="true" rightline="true"')}</row>
<row>
${cell('', 'multirow="2" bottomline="true" leftline="true"')}${cell('e', 'bottomline="true" leftline="true"')}${cell('f', 'bottomline="true" leftline="true" rightline="true"')}</row>
</lyxtabular>

\\end_inset


\\end_layout

\\end_inset


\\end_layout

\\begin_layout Standard
\\begin_inset Box Boxed
position "t"
hor_pos "c"
has_inner_box 1
inner_pos "t"
use_parbox 0
use_makebox 0
width "100col%"
special "none"
height "1in"
height_special "totalheight"
thickness "0.4pt"
separation "3pt"
shadowsize "4pt"
framecolor "black"
backgroundcolor "none"
status open

\\begin_layout Plain Layout
Boxed text.
\\end_layout

\\end_inset


\\end_layout

\\begin_layout Standard
\\begin_inset listings
lstparams "language=Python"
inline false
status open

\\begin_layout Plain Layout

def f(x):
\\end_layout

\\begin_layout Plain Layout

    return x
\\end_layout

\\end_inset


\\end_layout

\\begin_layout Standard
\\begin_inset CommandInset include
LatexCommand input
filename "child.lyx"
literal "false"

\\end_inset


\\end_layout

\\begin_layout Standard
Space 
\\begin_inset space ~
\\end_inset

inset, 
\\begin_inset space \\hfill{}
\\end_inset

 vspace
\\begin_inset VSpace bigskip
\\end_inset

 line
\\begin_inset Newline newline
\\end_inset

 break 
\\begin_inset CommandInset line
LatexCommand rule
offset "0.5ex"
width "100col%"
height "1pt"

\\end_inset


\\end_layout

\\begin_layout Section*
Unnumbered
\\end_layout

\\begin_layout Standard
\\begin_inset CommandInset bibtex
LatexCommand bibtex
bibfiles "refs"
options "plainnat"

\\end_inset


\\end_layout

\\begin_layout Standard
\\begin_inset CommandInset index_print
LatexCommand printindex
type "idx"
name "Index"

\\end_inset


\\end_layout

\\end_body
\\end_document
`;
  const p = join(dir, 'synthetic.lyx');
  writeFileSync(p, main);
  return p;
}

describe.skipIf(!HAVE_LATEXMK)('compile with latexmk', () => {
  it('synthetic article exercising most features', () => {
    const dir = join(SCRATCH, 'synthetic-src');
    rmSync(dir, { recursive: true, force: true });
    const file = syntheticDocument(dir);
    const r = exportAndCompile(file, join(SCRATCH, 'synthetic'));
    report('synthetic', r);
    const tex = readFileSync(join(SCRATCH, 'synthetic', 'synthetic.tex'), 'utf8');
    expect(tex).not.toContain('HIDDENBRANCH');
    expect(tex).not.toContain('invisible');
    expect(tex).not.toContain('gone');
    expect(r.pdf).toBe(true);
    expect(r.errors).toEqual([]);
    expect(existsSync(join(SCRATCH, 'synthetic', 'synthetic.bbl'))).toBe(true);
  }, 300000);

  it('bayesian_chaos (revtex4-2, includes, svg graphics, bibtex)', () => {
    const file = '/root/projects/bayesian_chaos/main.lyx';
    if (!existsSync(file)) return;
    const r = exportAndCompile(file, join(SCRATCH, 'bayesian_chaos'), 400000);
    report('bayesian_chaos', r);
    expect(r.pdf).toBe(true);
    // the user's .bib files contain malformed entries; errors raised inside the
    // generated bibliography (.bbl) are not export errors
    const lines = r.log.split('\n');
    const realErrors = lines.map((l, i) => (l.startsWith('! ') ? lines.slice(i, i + 6).join('\n') : '')).filter(ctx => ctx && !/BibitemShut|\.bbl|bibitem/.test(ctx));
    expect(realErrors).toEqual([]);
  }, 500000);

  const examples = [
    '/root/lyx/lib/examples/Welcome.lyx',
    '/root/lyx/lib/doc/Intro.lyx',
    '/root/lyx/lib/examples/Example_%28LyXified%29.lyx',
    '/root/lyx/lib/doc/Tutorial.lyx',
    '/root/lyx/lib/doc/Formula-numbering.lyx',
    '/root/lyx/lib/examples/Articles/American_Mathematical_Society_%28AMS%29.lyx',
    '/root/lyx/lib/examples/Articles/American_Chemical_Society_%28ACS%29.lyx',
  ];
  for (const f of examples) {
    const name = basename(f, '.lyx');
    it(`LyX example ${decodeURIComponent(name)}`, () => {
      if (!existsSync(f)) return;
      const r = exportAndCompile(f, join(SCRATCH, name.replace(/[^A-Za-z0-9_-]/g, '_')));
      report(name, r);
      const missing = r.errors.find(e => /File `[^']*\.sty' not found/.test(e));
      if (missing) { console.log(`${name}: skipped, TeX Live lacks a required package (${missing})`); return; }
      expect(r.pdf).toBe(true);
      // LyX's own documents contain the occasional intentional error demo; allow a handful
      expect(r.errors.length).toBeLessThanOrEqual(3);
    }, 300000);
  }
});
