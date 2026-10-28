import { describe, expect, it } from 'vitest';
import { macrosFromLatex, toMathliveMacros } from '../packages/core/src/macros.ts';
import { MathCursor, parseCell, parseFormula, renderHullSource, writeFormula } from '../packages/core/src/math';
import { setDocumentMacros, macroTableFor } from '../packages/client/src/editor/lyxmath/macrotable';
import { toMathml } from './mathjax';

const source = String.raw`
  \newcommand{\slot}[1][]{r_{b#1}}
  \newcommand{\indexed}[2][k]{#2_{#1}}
  \newcommand{\nested}{\slot[,c]+\indexed{x}}
`;
const metadata = toMathliveMacros(macrosFromLatex(source).macros);
const view = {};
setDocumentMacros(view, metadata);
const { table } = macroTableFor(view, undefined);

// Cell markers add transparent mrows; compare the resulting mathematical structure.
const structure = (mml: string) => mml.replace(/\s+[\w:-]+="[^"]*"/g, '').replace(/<\/?mrow>/g, '').replace(/\s+/g, '');
const rendered = (latex: string, atoms = false) => structure(toMathml(renderHullSource(parseFormula(latex, table), table, { atoms }).latex));
const expected = (latex: string) => structure(toMathml(latex));

describe('optional document macro arguments', () => {
  it('preserves the optional parameter through document metadata and consumes it before scripts', () => {
    expect(metadata.slot).toMatchObject({ args: 1, optional: '', def: 'r_{b#1}' });
    expect(table.slot).toMatchObject({ nargs: 1, nopt: 1, optional: '' });
    for (const atoms of [false, true]) {
      expect(rendered(String.raw`\slot[,c]^2`, atoms)).toBe(expected('r_{b,c}^2'));
    }
    expect(writeFormula(parseFormula(String.raw`$\slot[,c]^{2}$`, table))).toBe(String.raw`$\slot[,c]^{2}$`);
  });

  it('keeps required argument numbering and uses defaults only for omitted options', () => {
    expect(rendered(String.raw`\slot`)).toBe(expected('r_b'));
    expect(rendered(String.raw`\indexed{x}`)).toBe(expected('x_k'));
    expect(rendered(String.raw`\indexed [j] {x}`)).toBe(expected('x_j'));
    expect(rendered(String.raw`\indexed[]{x}`)).toBe(expected('x_{}'));
    const written = writeFormula(parseFormula(String.raw`$\indexed[]{x}$`, table));
    expect(written).toContain('[]');
    expect(rendered(written)).toBe(expected('x_{}'));
  });

  it('expands optional arguments and defaults inside other macro definitions', () => {
    expect(rendered(String.raw`\nested`)).toBe(expected('r_{b,c}+x_k'));
    const nestedMetadata = toMathliveMacros(macrosFromLatex(source + String.raw`
      \newcommand{\customdefault}[2][\indexed{x}]{#2+#1}
      \newcommand{\emptyoption}{\indexed[]{x}}
      \newcommand{\bracketoption}{\indexed[{]}]{x}}
    `).macros);
    const nestedView = {};
    setDocumentMacros(nestedView, nestedMetadata);
    const nestedTable = macroTableFor(nestedView, undefined).table;
    const show = (latex: string) => structure(toMathml(renderHullSource(parseFormula(latex, nestedTable), nestedTable).latex));
    expect(show(String.raw`\customdefault{y}`)).toBe(expected('y+x_k'));
    expect(show(String.raw`\emptyoption`)).toBe(expected('x_{}'));
    expect(show(String.raw`\bracketoption`)).toBe(expected('x_{]}'));
  });

  it('invalidates the macro table when only the default changes', () => {
    const otherView = {};
    setDocumentMacros(otherView, metadata);
    const before = macroTableFor(otherView, undefined);
    setDocumentMacros(otherView, { ...metadata, indexed: { ...metadata.indexed, optional: 'j' } });
    const after = macroTableFor(otherView, undefined);
    expect(after.key).not.toBe(before.key);
    expect(after.table.indexed.optional).toBe('j');
  });

  it('enters a valid argument cell when a macro has only optional arguments', () => {
    const cursor = new MathCursor(parseFormula('$$', table), table);
    for (const char of '\\slot ') cursor.interpretChar(char);
    expect(cursor.idx).toBe(0);
    cursor.insertChar('c');
    expect(writeFormula(cursor.hull)).toBe(String.raw`$\slot[c]$`);
    const inserted = new MathCursor(parseFormula('$$', table), table);
    inserted.niceInsertAtom(parseCell(String.raw`\slot`, table)[0]);
    inserted.insertChar('d');
    expect(writeFormula(inserted.hull)).toBe(String.raw`$\slot[d]$`);
  });
});
