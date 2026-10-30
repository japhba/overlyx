import { describe, expect, it } from 'vitest';
import { collectMacros, macrosFromLatex, toMathliveMacros } from '../packages/core/src/macros.ts';
import type { LyxDocument } from '../packages/core/src/lyx/ast.ts';
import { setDocumentMacros, macroTableFor } from '../packages/client/src/editor/lyxmath/macrotable.ts';
import { parseFormula, renderHullSource } from '../packages/core/src/math/index.ts';
import { toMathml } from './mathjax.ts';

const document = (preamble: string): LyxDocument => ({
  preamble: [], format: 620, header: { lines: ['\\begin_preamble', preamble, '\\end_preamble'] }, body: [], trailer: [],
});
const structure = (mml: string) => mml.replace(/\s+[\w:-]+="[^"]*"/g, '').replace(/<\/?mrow>/g, '').replace(/\s+/g, '');

describe('document macro collection', () => {
  it('executes inputs between preamble definitions, including nested files', () => {
    const files: Record<string, string> = {
      'outer.tex': String.raw`\renewcommand{\value}{b}\input{inner}\renewcommand{\value}{d}`,
      'inner.tex': String.raw`\renewcommand{\value}{c}`,
    };
    const macros = collectMacros(document(String.raw`\newcommand{\value}{a}\input{outer}\renewcommand{\value}{e}`), { readFile: name => files[name] });
    expect(macros.map(m => m.def)).toEqual(['a', 'b', 'c', 'd', 'e']);
    expect(macros.map(m => m.source)).toEqual(['preamble', 'file', 'file', 'file', 'preamble']);
    expect(toMathliveMacros(macros).value.def).toBe('e');
    expect(toMathliveMacros(collectMacros(document(String.raw`\newcommand{\value}{a}\input{outer}`), { readFile: name => files[name] })).value.def).toBe('d');
  });

  it('allows repeated inputs and stops recursive inputs', () => {
    const files: Record<string, string> = {
      'first.tex': String.raw`\input{second}\def\value{x}`,
      'second.tex': String.raw`\input{first}`,
    };
    const macros = collectMacros(document(String.raw`\input{first}\def\value{y}\input{first}`), { readFile: name => files[name] });
    expect(macros.map(m => m.def)).toEqual(['x', 'y', 'x']);
    expect(toMathliveMacros(macros).value.def).toBe('x');
  });

  it('uses the final switch assignments across input files without changing saved definitions', () => {
    const files: Record<string, string> = {
      'switches.tex': String.raw`\newif\ifboxed\boxedtrue\newcommand{\wrapped}[1]{\ifboxed\boxed{#1}\else#1\fi}`,
      'enable.tex': String.raw`\boxedtrue`,
    };
    const collect = (preamble: string) => collectMacros(document(preamble), { readFile: name => files[name] });
    const original = files['switches.tex'];
    const disabled = collect(String.raw`\input{switches}\boxedfalse`);
    expect(toMathliveMacros(disabled).wrapped).toMatchObject({ def: '#1', args: 1 });
    expect(disabled.find(m => m.name === 'wrapped')!.def).toBe(String.raw`\ifboxed\boxed{#1}\else#1\fi`);
    expect(disabled.find(m => m.name === 'wrapped')!.raw).toContain(String.raw`\ifboxed`);
    const enabled = toMathliveMacros(collect(String.raw`\input{switches}\boxedfalse\input{enable}`));
    expect(enabled.wrapped.def).toBe(String.raw`\boxed{#1}`);
    expect(Object.keys(enabled)).toEqual(['wrapped']);
    expect(files['switches.tex']).toBe(original);
  });
});

describe('boolean macro rendering', () => {
  it('uses false by default, resolves nesting and omits a false branch without else', () => {
    const macros = macrosFromLatex(String.raw`
      \newif\ifouter\newif\ifinner\outertrue
      \newcommand{\nested}[1]{\ifouter\ifinner a\else#1\fi\else b\fi}
      \newcommand{\hidden}[1]{\ifinner#1\fi}
      \newcommand{\defaulted}[1][\ifinner a\else k\fi]{#1}
      \newcommand{\indirect}[1]{\hidden{#1}z}
    `).macros;
    const defs = toMathliveMacros(macros);
    expect(defs.nested.def).toBe('#1');
    expect(defs.hidden.def).toBe('');
    expect(defs.defaulted.optional).toBe(' k');
    const view = {};
    setDocumentMacros(view, defs);
    const { table } = macroTableFor(view, undefined);
    for (const atoms of [false, true]) {
      const tex = renderHullSource(parseFormula(String.raw`\nested{x}+\hidden{y}+\defaulted`, table), table, { atoms }).latex;
      expect(structure(toMathml(tex))).toBe(structure(toMathml('x++k')));
      const nested = renderHullSource(parseFormula(String.raw`\indirect{y}`, table), table, { atoms }).latex;
      expect(structure(toMathml(nested))).toBe(structure(toMathml('z')));
    }
  });

  it('resolves the same definitions again when switches change after their declaration', () => {
    const source = String.raw`\newif\ifmarked\newcommand{\marked}[1]{\ifmarked\mathbf{#1}\else#1\fi}`;
    expect(toMathliveMacros(macrosFromLatex(source).macros).marked.def).toBe('#1');
    const defs = toMathliveMacros(macrosFromLatex(source + String.raw`\markedtrue`).macros);
    expect(defs.marked.def).toBe(String.raw`\mathbf{#1}`);
    const view = {};
    setDocumentMacros(view, defs);
    const { table } = macroTableFor(view, undefined);
    expect(structure(toMathml(renderHullSource(parseFormula(String.raw`\marked{x}`, table), table).latex)))
      .toBe(structure(toMathml(String.raw`\mathbf{x}`)));
  });

  it('ignores commented and escaped assignments and assignments inside macro bodies', () => {
    const source = String.raw`\newif\ifshown
      % \showntrue
      \\showntrue
      \newcommand{\enable}{\showntrue}
      \newcommand{\visible}[1]{\ifshown a\else#1\fi}
    `;
    expect(toMathliveMacros(macrosFromLatex(source).macros).visible.def).toBe('#1');
  });

  it('keeps unknown and incomplete conditionals intact and distinguishes math commands', () => {
    const source = String.raw`\newif\ifshown\showntrue
      \def\relation{\ifshown a\iff b\else c\fi}
      \def\primitive{\ifshown\ifnum1=1 a\else b\fi\else c\fi}
      \def\unknown{\ifmissing a\else b\fi}
      \def\incomplete{\ifshown a\else b}
    `;
    const defs = toMathliveMacros(macrosFromLatex(source).macros);
    expect(defs.relation.def).toBe(String.raw` a\iff b`);
    expect(defs.primitive.def).toBe(String.raw`\ifnum1=1 a\else b\fi`);
    expect(defs.unknown.def).toBe(String.raw`\ifmissing a\else b\fi`);
    expect(defs.incomplete.def).toBe(String.raw`\ifshown a\else b`);
  });
});
