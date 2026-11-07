/**
 * Scripts on a macro whose expansion ends in scripts of its own (core/math/mathjax.ts): \q := q_{a},
 * typed \q^x_y — on screen x goes above q and y joins a, instead of both hanging to the right of
 * the whole q_a as TeX sets them.
 */
import { describe, it, expect } from 'vitest';
import { parseFormula, renderHullSource, type MacroTable } from '../packages/core/src/math';
import { splitTrailingScripts, expandUserMacros } from '../packages/core/src/math/mathjax.ts';

const MACROS: MacroTable = {
  q: { nargs: 0, def: 'q_{a}' },
  Q: { nargs: 0, def: 'Q^{\\ast}' },
  M: { nargs: 0, def: '\\mathbf{M}' },
  qq: { nargs: 0, def: 'q_a' },
} as MacroTable;
const render = (latex: string) => renderHullSource(parseFormula(latex, MACROS), MACROS).latex;

describe('splitTrailingScripts', () => {
  it('splits braced and bare trailing scripts', () => {
    expect(splitTrailingScripts('q_{a}')).toEqual({ base: 'q', down: 'a' });
    expect(splitTrailingScripts('q_a')).toEqual({ base: 'q', down: 'a' });
    expect(splitTrailingScripts('q^{\\ast}_{i j}')).toEqual({ base: 'q', up: '\\ast', down: 'i j' });
    expect(splitTrailingScripts('\\hat{x}_\\alpha')).toEqual({ base: '\\hat{x}', down: '\\alpha' });
  });
  it('leaves strings without a trailing script alone', () => {
    expect(splitTrailingScripts('\\mathbf{M}')).toBeNull();
    expect(splitTrailingScripts('a\\{b\\}')).toBeNull();
    expect(splitTrailingScripts('_{a}')).toBeNull();
  });
});

describe('macro scripts render greedily', () => {
  it('a new superscript goes into the free slot, a new subscript is appended to the macro\'s own', () => {
    const s = render('$\\q^{x}_{y}$');
    expect(s).toMatch(/\\htmlClass\{lm-macro\}\{q\}\}\^\{\\htmlClass\{lm-c\d+\}\{x\}\}_\{\\htmlClass\{lm-macro\}\{a\}\\htmlClass\{lm-c\d+\}\{y\}\}/);
  });
  it('works for a bare script in the definition too', () => {
    expect(render('$\\qq^{2}$')).toMatch(/\{q\}\}\^\{\\htmlClass\{lm-c\d+\}\{2\}\}_\{\\htmlClass\{lm-macro\}\{a\}\}/);
  });
  it('a macro without trailing scripts renders as before', () => {
    const s = render('$\\M^{2}$');
    expect(s).toMatch(/\\htmlClass\{lm-macro\}\{\\mathbf\{M\}\}\}\^\{\\htmlClass\{lm-c\d+\}\{2\}\}/);
  });
  it('merges in the editable field too, where every atom carries its lm-a marker (and its symbol key)', () => {
    // the field renders with atom markers (renderHullSource atoms: true); the merge used to
    // recognise only the static form, so a formula stopped being greedy the moment it was clicked
    const field = (latex: string) => renderHullSource(parseFormula(latex, MACROS), MACROS, { atoms: true }).latex;
    expect(field('$\\q^{x}_{y}$')).toMatch(/\\htmlClass\{lm-c\d+\}\{\\htmlClass\{lm-a(?: [\w-]+)?\}\{\\htmlClass\{lm-macro\}\{q\}\}\}\^\{\\htmlClass\{lm-c\d+\}\{\\htmlClass\{lm-a(?: [\w-]+)?\}\{x\}\}\}_\{\\htmlClass\{lm-macro\}\{a\}\\htmlClass\{lm-c\d+\}\{\\htmlClass\{lm-a(?: [\w-]+)?\}\{y\}\}\}/);
    expect(field('$\\qq^{2}$')).toMatch(/\{\\htmlClass\{lm-macro\}\{q\}\}\}\^\{\\htmlClass\{lm-c\d+\}\{\\htmlClass\{lm-a(?: [\w-]+)?\}\{2\}\}\}_\{\\htmlClass\{lm-macro\}\{a\}\}/);
    // a definition without trailing scripts: unchanged, markers and all
    expect(field('$\\M^{2}$')).toMatch(/\\htmlClass\{lm-a(?: [\w-]+)?\}\{\\htmlClass\{lm-macro\}\{\\mathbf\{M\}\}\}\}\^\{/);
    // letters carry the key of their symbol: x in its font, the same x wherever it stands
    expect(field('$x+\\mathbf{x}_{i}+\\alpha$')).toMatch(/\\htmlClass\{lm-a lm-k-c120\}\{x\}\\htmlClass\{lm-a\}\{\+\}.*\\htmlClass\{lm-a lm-k-mathbf-c120\}\{x\}.*\\htmlClass\{lm-a lm-k-s-alpha\}\{\\alpha\}/);
  });
  it('the LaTeX written back is untouched', async () => {
    const { writeFormula } = await import('../packages/core/src/math');
    expect(writeFormula(parseFormula('$\\q^{x}_{y}$', MACROS))).toBe('$\\q^{x}_{y}$');
  });
});

describe('macros that use other macros', () => {
  const NESTED: MacroTable = {
    bb: { nargs: 1, def: '\\mathbf{#1}' },
    bz: { nargs: 0, def: '\\bb{z}' },
    vect: { nargs: 1, def: '\\bb{#1}' },
    pair: { nargs: 2, def: '(\\bz, #2)' },
  } as MacroTable;
  const show = (latex: string) => renderHullSource(parseFormula(latex, NESTED), NESTED).latex;
  it('expands the inner macro instead of showing its name (\\bz := \\bb{z} rendered as "\\bb z")', () => {
    expect(show('q(\\bz)')).toContain('\\mathbf{');
    expect(show('q(\\bz)')).not.toMatch(/\\bb(?![a-z])/);
    expect(show('\\vect{y}')).toContain('\\mathbf');
    expect(show('\\pair{a}{b}')).toContain('\\mathbf');
  });
  it('expandUserMacros: groups, single tokens, recursion limit', () => {
    expect(expandUserMacros('\\bb{z}+\\bb x', NESTED)).toBe('{\\mathbf{{z}}}+{\\mathbf{{x}}}');
    expect(expandUserMacros('\\bz', NESTED)).toBe('{{\\mathbf{{z}}}}');
    const loop = { a: { nargs: 0, def: '\\a' } } as MacroTable;
    expect(() => expandUserMacros('\\a', loop)).not.toThrow();
  });
});
