/**
 * The selected symbol's other occurrences (packages/client/src/editor/plugins/mathoccurrences.ts):
 * which atoms count as the same symbol (core math/mathjax.ts symbolKey).
 */
import { describe, it, expect, vi } from 'vitest';
// the client's math field touches `window` at import time
vi.hoisted(() => { const g = globalThis as any; if (typeof g.window === 'undefined') { g.window = g; if (g.navigator && g.navigator.appVersion === undefined) Object.defineProperty(g.navigator, 'appVersion', { value: '', configurable: true }); } });
import { parseFormula, symbolKey } from '../packages/core/src/math/index.ts';
import { formulaSymbolKey } from '../packages/client/src/editor/plugins/mathoccurrences.ts';

const atoms = (latex: string) => parseFormula(latex, {}).rows[0].cells[0];

describe('symbolKey', () => {
  it('a letter in its font, a symbol command; digits and operators are not symbols', () => {
    const [x, plus, two, alpha] = atoms('$x+2\\alpha$');
    expect(symbolKey(x)).toBe('c120');
    expect(symbolKey(x, 'mathbf')).toBe('mathbf-c120');
    expect(symbolKey(alpha)).toBe('s-alpha');
    expect(symbolKey(plus)).toBeNull();
    expect(symbolKey(two)).toBeNull();
  });
  it('a symbol with scripts matches the same scripts only', () => {
    const [xi, , xi2, , xj] = atoms('$x_{i}+x_{i}+x_{j}$');
    expect(symbolKey(xi)).toBe(symbolKey(xi2));
    expect(symbolKey(xi)).not.toBe(symbolKey(xj));
    expect(symbolKey(xi)).toMatch(/^h[0-9a-z]+$/);
  });
});

describe('formulaSymbolKey', () => {
  it('a formula that is one symbol selected whole stands for it', () => {
    expect(formulaSymbolKey('$\\alpha$')).toBe('s-alpha');
    expect(formulaSymbolKey('$x$')).toBe('c120');
    expect(formulaSymbolKey('$x+y$')).toBeNull();
  });
});
