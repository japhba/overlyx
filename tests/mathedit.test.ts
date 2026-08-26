import { describe, it, expect } from 'vitest';
import { expandMacroArgs, contractMacroArgs } from '../packages/core/src/mathedit.ts';
import { toMathliveMacros, macrosFromLatex, sanitizeForMathlive } from '../packages/core/src/macros.ts';
import { parseLyx } from '../packages/core/src/lyx/parser.ts';
import { collectMacros } from '../packages/core/src/macros.ts';
import { readFileSync } from 'node:fs';

const M = { inv: { def: '(#1)^{-1}', args: 1 }, frac2: { def: '\\frac{#1}{#2}', args: 2 }, myinv: { def: '#1^{-1}', args: 1 }, winv: { def: '\\myinv{(#1)}', args: 1 }, rec: { def: '\\rec{#1}', args: 1 } };

describe('editable macro arguments', () => {
  it('expands and contracts a simple macro', () => {
    const e = expandMacroArgs('a+\\inv{x+y}\\cdot b', M);
    expect(e).toBe('a+\\htmlData{lyxmacro=inv,n=1,id=1}{(\\htmlData{lyxarg=1,id=1}{x+y})^{-1}}\\cdot b');
    expect(contractMacroArgs(e)).toBe('a+\\inv{x+y}\\cdot b');
  });
  it('keeps edits made inside the argument', () => {
    const e = expandMacroArgs('\\inv{x}', M).replace('{x}', '{x+z}');
    expect(contractMacroArgs(e)).toBe('\\inv{x+z}');
  });
  it('discards edits in the fixed template part', () => {
    const e = expandMacroArgs('\\inv{x}', M).replace('^{-1}', '^{-2}');
    expect(contractMacroArgs(e)).toBe('\\inv{x}');
  });
  it('handles several and nested arguments', () => {
    const src = '\\frac2{\\inv{a}}{\\inv{b}}';
    const e = expandMacroArgs(src, M);
    expect(contractMacroArgs(e)).toBe(src);
  });
  it('handles templates that use other macros with arguments', () => {
    const e = expandMacroArgs('\\winv{Q}', M);
    expect(e).toContain('lyxmacro=myinv');
    expect(contractMacroArgs(e)).toBe('\\winv{Q}');
    expect(contractMacroArgs(e.replace('{Q}', '{Q+1}'))).toBe('\\winv{Q+1}');
  });
  it('accepts unbraced and control-sequence arguments', () => {
    expect(contractMacroArgs(expandMacroArgs('\\inv x', M))).toBe('\\inv{x}');
    expect(contractMacroArgs(expandMacroArgs('\\inv\\alpha', M))).toBe('\\inv{\\alpha}');
  });
  it('leaves incomplete calls and zero-argument macros alone', () => {
    expect(expandMacroArgs('\\inv', M)).toBe('\\inv');
    expect(expandMacroArgs('\\alpha+\\beta', M)).toBe('\\alpha+\\beta');
    expect(expandMacroArgs('\\rec{x}', M)).toContain('lyxmacro=rec');   // recursion guarded
  });
  it('unwraps stray argument groups', () => {
    expect(contractMacroArgs('\\htmlData{lyxarg=1,id=4}{x+y}')).toBe('x+y');
  });
  it('contracts pasted duplicates independently', () => {
    const one = expandMacroArgs('\\inv{a}', M);
    expect(contractMacroArgs(one + '+' + one.replace('{a}', '{b}'))).toBe('\\inv{a}+\\inv{b}');
  });
});

describe('macro sanitising for MathLive', () => {
  it('strips scaleboxes and text boxes', () => {
    expect(sanitizeForMathlive('\\scalebox{0.365}[1.0]{$-$}', { name: 'm', args: 0 })).toBe('{-}');
    expect(sanitizeForMathlive('\\hbox{ab}', { name: 'm', args: 0 })).toBe('\\text{ab}');
    expect(sanitizeForMathlive('\\ensuremath{x}', { name: 'm', args: 0 })).toBe('{x}');
  });
  it('falls back to the name but keeps the arguments visible', () => {
    expect(sanitizeForMathlive('\\includegraphics{a}#1', { name: 'Pf', args: 1 })).toBe('\\mathrm{Pf}\\{#1\\}');
  });
  it('later definitions win in document order (nested insets included)', () => {
    const doc = parseLyx(readFileSync('/root/projects/recurrent_feature/lyxmacros.lyx', 'utf8'));
    const dict = toMathliveMacros(collectMacros(doc));
    expect(dict.lndet.args).toBe(1);
    expect(dict.inv.def).toBe('(#1)^{-1}');
  });
  it('parses the DeclareRobustCommand definitions of macros.tex', () => {
    const { macros } = macrosFromLatex(readFileSync('/root/projects/recurrent_feature/macros.tex', 'utf8'));
    const d = toMathliveMacros(macros);
    expect(d.myvarshortminus.def).toBe('{-}');
    expect(d.myinv.def).toContain('#1');
  });
});
