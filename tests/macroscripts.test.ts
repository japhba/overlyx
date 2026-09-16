/**
 * Scripts on a macro whose expansion ends in scripts of its own (core/math/katex.ts): \q := q_{a},
 * typed \q^x_y — on screen x goes above q and y joins a, instead of both hanging to the right of
 * the whole q_a as TeX sets them.
 */
import { describe, it, expect } from 'vitest';
import { parseFormula, renderHullSource, type MacroTable } from '../packages/core/src/math';
import { splitTrailingScripts } from '../packages/core/src/math/katex.ts';

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
  it('the LaTeX written back is untouched', async () => {
    const { writeFormula } = await import('../packages/core/src/math');
    expect(writeFormula(parseFormula('$\\q^{x}_{y}$', MACROS))).toBe('$\\q^{x}_{y}$');
  });
});
