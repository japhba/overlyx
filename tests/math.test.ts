/**
 * The LyX-style math model: parse.ts (port of MathParser.cpp) and write.ts (port of the
 * TeXMathStream / InsetMath*::write of LyX 2.5) must round-trip everything LyX writes byte-exactly.
 */
import { describe, it, expect } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import { parseCell, parseFormula, writeFormula, writeCellLatex, type MacroTable, type Atom } from '../packages/core/src/math';

const MACROS: MacroTable = { inv: { nargs: 1 }, lndet: { nargs: 1 }, Pfi: { nargs: 0 }, kap: { nargs: 0 }, cum: { nargs: 2 }, mdiag: { nargs: 1 } };

const rt = (latex: string, macros = MACROS) => writeFormula(parseFormula(latex, macros));

describe('math round trip (LyX 2.5 conventions)', () => {
  const samples = [
    '$a+b$',
    '$\\alpha x$',
    '$\\alpha\\beta$',
    '$x^{2}$',
    '$x^{2}_{i}$',                         // 2.5 writes the superscript first
    '$\\Pfi^{-}_{\\mathcal{T}}$',
    '$\\sum^{N}_{i=1}x_{i}$',
    '$\\int^{\\infty}_{-\\infty}dx$',
    '$\\frac{1}{2}\\sqrt{x}\\sqrt[3]{y}$',
    '$\\left(x+\\frac{a}{b}\\right)$',
    '$\\left\\{ x\\right\\} $',
    '$\\left\\langle x\\right\\rangle $',
    '$\\left.\\frac{a}{b}\\right|_{x=0}$',
    '$\\bigl(x\\bigr)\\Bigl\\{ y\\Bigr\\}$',
    '$\\text{if }x>0$',
    '$\\mathrm{d}x\\,\\mathbf{v}\\mathcal{N}(0,1)$',
    '$\\hat{x}\\tilde{y}\\bar{z}\\vec{v}\\overline{ab}\\underbrace{abc}_{n}$',
    '$\\inv A$',                           // single ASCII char argument: LyX writes it unbraced
    '$\\inv{\\v\\Pfi^{-}+\\kap}$',
    '$\\lndet{\\HH}$',
    '$\\cum{h(t)}{}$',
    '$\\bm{x}\\boldsymbol{\\phi}$',
    '$\\{x\\}$',
    '${a}^{2}$',
    '$a\\,b\\;c\\!d\\quad e\\qquad f~g$',
    '$\\hspace{2cm}x\\kern1em y\\mkern-3mu z$',
    '$\\begin{pmatrix}a & b\\\\\nc & d\n\\end{pmatrix}$',
    '$\\begin{cases}\na & x>0\\\\\nb & \\text{otherwise}\n\\end{cases}$',
    '$\\begin{array}{cc}\na & b\\\\\nc & d\n\\end{array}$',
    '$\\overset{!}{=}\\underset{n\\to\\infty}{\\lim}\\stackrel{\\text{i.i.d.}}{\\sim}$',
    '$\\xrightarrow[n]{\\infty}$',
    '${\\displaystyle \\frac{a}{b}}$',
    '$\\phantom{x}\\ensuremath{y}\\textcolor{red}{z}$',
    '$\\mathop{\\mathrm{tr}}\\nolimits_{i}$',
    '$\\sum\\limits_{i}$',
    '$\\ldots\\cdots\\dots$',
    '$\\sqrt{\\det(K)}$',
    '$x\\prime\\prime$',
    '$\\lim_{x\\to0}\\sin x$',
    '$\\eqref{eq:foo}\\ref{bar}$',
    '$\\mbox{text here}$',
    '$a\\coloneqq b$',
    '$\\mathrm{I}$',
    '$\\text{no update in \\ensuremath{[s,t]}}$',
    '$ $',
    '$\\operatorname{Cov}(x)$',
    '$\\operatorname*{argmax}_{x}f(x)$',
    '\n\\[\nE=mc^{2}\n\\]\n',
    '\n\\begin{equation}\nE=mc^{2}\\label{eq:e}\n\\end{equation}\n',
    '\n\\begin{align}\na & =b\\\\\nc & =d\\label{eq:cd}\n\\end{align}\n',
    '\n\\begin{align}\na & =b\\nonumber \\\\\nc & =d\n\\end{align}\n',
    '\n\\begin{align*}\na & =b\\\\\nc & =d\n\\end{align*}\n',
    '\n\\begin{align*}\na & =b\\\\\n\\end{align*}\n',   // trailing empty row is kept
    '\n\\begin{multline}\nP(h|y,\\bx)\\propto\\exp\\Bigl\\{-\\hlf\\tr\\,[\\YY]\\\\\n\\quad-\\hlf h^{\\T}\\Bigr\\}.\\label{eq:P}\n\\end{multline}\n',
    '\n\\begin{gather}\na\\\\\nb\n\\end{gather}\n',
    '\n\\begin{eqnarray}\na & = & b\\\\\nc & = & d\n\\end{eqnarray}\n',
    '\n\\begin{alignat}{2}\na & =b & c & =d\n\\end{alignat}\n',
  ];
  for (const s of samples) it(JSON.stringify(s), () => { expect(rt(s)).toBe(s); });
});

describe('math parse structure (LyX semantics)', () => {
  it('scripts attach to the previous atom and merge', () => {
    const c = parseCell('x_{i}^{2}');
    expect(c.length).toBe(1);
    const s = c[0] as Extract<Atom, { t: 'script' }>;
    expect(s.t).toBe('script'); expect(writeCellLatex(s.nuc)).toBe('x'); expect(writeCellLatex(s.up!)).toBe('2'); expect(writeCellLatex(s.down!)).toBe('i');
  });
  it('user braces become a brace inset, argument braces do not', () => {
    expect(parseCell('{ab}')[0].t).toBe('brace');
    expect(parseCell('\\frac{a}{b}')[0].t).toBe('frac');
    expect(parseCell('\\sqrt{ab}')[0].t).toBe('sqrt');
  });
  it('macros take the number of arguments of their definition; unknown commands take none', () => {
    const m = parseCell('\\inv{A}+\\bm{x}', MACROS);
    expect(m[0]).toMatchObject({ t: 'macro', n: 'inv' });
    expect(m.map(a => a.t)).toEqual(['macro', 'char', 'class']);   // \bm is InsetMathBoldSymbol (one cell)
    expect(parseCell('\\foo{x}').map(a => a.t)).toEqual(['cmd', 'brace']);
  });
  it('delimiters, big delimiters and text', () => {
    const c = parseCell('\\left(\\frac{a}{b}\\right)\\bigl[x\\bigr]\\text{if }y');
    expect(c.map(a => a.t)).toEqual(['delim', 'big', 'char', 'big', 'font', 'char']);
    const d = c[0] as Extract<Atom, { t: 'delim' }>;
    expect(d.l).toBe('('); expect(d.r).toBe(')');
    const f = c[4] as Extract<Atom, { t: 'font' }>;
    expect(f.mode).toBe('text'); expect(f.body.map(a => (a as { c: string }).c).join('')).toBe('if ');
  });
  it('hull rows, columns, numbering and labels', () => {
    const h = parseFormula('\n\\begin{align}\na & =b\\nonumber \\\\\nc & =d\\label{eq:cd}\n\\end{align}\n');
    expect(h.type).toBe('align'); expect(h.rows.length).toBe(2); expect(h.ncols).toBe(2);
    expect(h.numberedRows).toEqual([false, true]); expect(h.labels).toEqual([undefined, 'eq:cd']);
    const s = parseFormula('$x$');
    expect(s.type).toBe('simple'); expect(writeCellLatex(s.rows[0].cells[0])).toBe('x');
    const e = parseFormula('\n\\[\nx\n\\]\n');
    expect(e.type).toBe('equation'); expect(e.numberedRows).toEqual([false]);
  });
  it('matrices are grids with rows and columns', () => {
    const g = parseCell('\\begin{pmatrix}a & b\\\\\nc & d\n\\end{pmatrix}')[0] as Extract<Atom, { t: 'grid' }>;
    expect(g.t).toBe('grid'); expect(g.env).toBe('pmatrix'); expect(g.rows.length).toBe(2); expect(g.ncols).toBe(2);
  });
  it('normalises what LyX normalises', () => {
    expect(rt('$x^2$')).toBe('$x^{2}$');
    expect(rt('$x_{i}^{2}$')).toBe('$x^{2}_{i}$');
    expect(rt('$\\inv{A}$')).toBe('$\\inv A$');
    expect(rt('$\\alpha  \\beta$')).toBe('$\\alpha\\beta$');
    expect(rt('$a \\over b$')).toBe('$\\frac{a}{b}$');
    expect(rt('$\\left| x \\right|$')).toBe('$\\left|x\\right|$');
  });
});

describe('corpus (all formulas of the local LyX projects, when present)', () => {
  const dir = '/tmp/claude-0/-root-lyx/9250d901-48e6-4b48-98b5-a211e39f6f1d/scratchpad/corpus';
  it.skipIf(!existsSync(dir + '/formulas.json'))('≥ 99% of LyX-2.5-written formulas round-trip byte-exactly', () => {
    const formulas: { file: string; latex: string }[] = JSON.parse(readFileSync(dir + '/formulas.json', 'utf8'));
    const fmt = new Map<string, string>();
    // the projects' .lyx originals moved into <project>/lyx_deprecated/ when the documents became .tex
    const lyxPath = (f: string) => (existsSync(f) ? f : f.replace(/^(\/root\/projects\/[^/]+\/)/, '$1lyx_deprecated/'));
    for (const f of new Set(formulas.map(x => x.file))) { const m = /\\lyxformat (\d+)/.exec(readFileSync(lyxPath(f), 'utf8').slice(0, 400)); fmt.set(f, m?.[1] ?? '?'); }
    const sel = formulas.filter(f => fmt.get(f.file) === '643');
    let ok = 0;
    for (const f of sel) { try { if (writeFormula(parseFormula(f.latex, { inv: { nargs: 1 }, lndet: { nargs: 1 }, mdiag: { nargs: 1 }, cum: { nargs: 2 }, vev: { nargs: 1 }, ev: { nargs: 1 }, order: { nargs: 1 }, tr: { nargs: 0 } })) === f.latex) ok++; } catch { /* counted as failure */ } }
    expect(ok / sel.length).toBeGreaterThan(0.99);
  });
});
