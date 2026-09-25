/**
 * Concurrent formula edits (client/src/editor/mathconflict.ts): a competing version is kept in a
 * comment — but the file's spelling of the same formula, which a server that reopened the document
 * after a restart brings back, is not one (a matrix edited in generative-learning/table.tex got a
 * "retained for review" copy of itself on every deploy).
 */
import { describe, it, expect } from 'vitest';
import { parseFormula, writeFormula } from '../packages/core/src/math/index.ts';
import { sameFormula } from '../packages/client/src/editor/mathconflict.ts';

const FILE = '\\begin{matrix}\\text{\\textbf{Feature}} &  & \\text{\\textbf{RBMs}}\\\\ \\text{weight sharing} &  & 1\\\\ \\text{offline learning} &  & 0\\text{ (requires \\ensuremath{p(x)})}\\\\ \\text{Notes} \\end{matrix}';

describe('sameFormula', () => {
  it('the editor\'s spelling and the file\'s spelling of one formula are the same formula', () => {
    // what the editor writes: the rows on lines of their own
    const editor = writeFormula(parseFormula('$' + FILE + '$')).replace(/^\$|\$$/g, '');
    expect(editor).not.toBe(FILE);
    expect(editor).toContain('\\\\\n');
    expect(sameFormula(editor, FILE, false)).toBe(true);
    expect(sameFormula('x^{2}+y', 'x^2 + y', false)).toBe(true);
    expect(sameFormula('\\[\n\\alpha\n\\]', '\\[ \\alpha \\]', true)).toBe(true);
  });

  it('a real change is still a competing version', () => {
    expect(sameFormula(FILE, FILE.replace('weight sharing} &  & 1', 'weight sharing} &  & 0'), false)).toBe(false);
    expect(sameFormula(FILE, FILE.replace('\\text{Notes} ', '\\text{Notes} & X'), false)).toBe(false);
    expect(sameFormula('x^{2}', 'x^{3}', false)).toBe(false);
    expect(sameFormula('\\[\n\\alpha\n\\]', '\\[\n\\beta\n\\]', true)).toBe(false);
  });
});
