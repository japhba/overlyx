/**
 * A table typed as a formula made a real table (client editor/formulatable.ts): which formulas are
 * tables, the cells as text-mode LaTeX, the grid as a tabular that the .tex parser reads back.
 */
import { describe, it, expect, vi } from 'vitest';
vi.hoisted(() => { const g = globalThis as any; if (typeof g.window === 'undefined') { g.window = g; if (g.navigator && g.navigator.appVersion === undefined) Object.defineProperty(g.navigator, 'appVersion', { value: '', configurable: true }); } });
import { readFileSync } from 'node:fs';
import { parseFormula, parseCell } from '../packages/core/src/math/index.ts';
import { parseTex, writeTex } from '../packages/core/src/tex/index.ts';
import { walkInsets } from '../packages/core/src/index.ts';
import { formulaTableGrid, isFormulaTable, cellAsText, gridAsTabular } from '../packages/client/src/editor/formulatable.ts';

const grid = (latex: string) => formulaTableGrid(parseFormula(latex))!;

describe('which formulas are tables', () => {
  it('one matrix / smallmatrix / array alone; not a delimited matrix, not with more around it', () => {
    expect(isFormulaTable('$\\begin{matrix}a & b\\\\ c & d\\end{matrix}$')).toBe(true);
    expect(isFormulaTable('$ \\begin{array}{lc}a & b\\end{array} $')).toBe(true);
    expect(isFormulaTable('\\[\n\\begin{matrix}a\\end{matrix}\n\\]')).toBe(true);
    expect(isFormulaTable('$\\begin{pmatrix}a\\end{pmatrix}$')).toBe(false);
    expect(isFormulaTable('$x = \\begin{matrix}a\\end{matrix}$')).toBe(false);
    expect(isFormulaTable('$a^2$')).toBe(false);
  });
});

describe('cells as text', () => {
  const t = (latex: string) => cellAsText(parseCell(latex));
  it('\\text{…} is text, the math between is $…$, numbers stay text', () => {
    expect(t('\\text{weight sharing}')).toBe('weight sharing');
    expect(t('0\\text{ (requires \\ensuremath{p(x)})}')).toBe('0 (requires $p(x)$)');
    expect(t('.5')).toBe('.5');
    expect(t('?')).toBe('?');
    expect(t('N/A')).toBe('$N/A$');
    expect(t('\\log p(x)')).toBe('$\\log p(x)$');
    expect(t('\\mathbf{\\text{improve heldout error}}')).toBe('\\textbf{improve heldout error}');
    expect(t('\\text{\\textbf{Feature}}')).toBe('\\textbf{Feature}');
    expect(t('\\text{\\href{https://arxiv.org/html/2405.18634}{Wang24}}')).toBe('\\href{https://arxiv.org/html/2405.18634}{Wang24}');
    expect(t('\\text{overproduction of \\ensuremath{x_{i}z_{j}}}')).toBe('overproduction of $x_{i}z_{j}$');
    expect(t('\\text{\\text{{\\tiny learning rule}}}')).toBe('{\\tiny learning rule}');
  });
});

describe('the grid as a tabular', () => {
  it('matrix columns centred, every row with all its cells; an array keeps its spec and rules', () => {
    expect(gridAsTabular(grid('$\\begin{matrix}\\text{a} & 1\\\\ \\text{b} & x^2\\end{matrix}$'))).toBe('\\begin{tabular}{cc}\na & 1 \\\\\nb & $x^{2}$ \\\\\n\\end{tabular}');
    expect(gridAsTabular(grid('$\\begin{array}{l|r}\\hline a & b\\\\ c\\end{array}$'))).toBe('\\begin{tabular}{l|r}\n\\hline $a$ & $b$ \\\\\n$c$ &  \\\\\n\\end{tabular}');
  });

  it("the generative-learning comparison table reads back as a 12-column tabular", () => {
    const latex = String.raw`$\begin{matrix}\text{\textbf{Feature}} &  & \text{\textbf{RBMs}} & \text{\textbf{VAE}} & \text{\href{https://arxiv.org/html/2405.18634}{Wang24}}\\ \text{offline learning helpful} &  & 0\text{ (requires \ensuremath{p(x)})} & 1\\ \mathbf{\text{improve heldout error}} &  & 1 & \log p(x)\\ \\\\\\\text{Notes} &  & \text{\text{{\tiny learning rule is iffy, but \ensuremath{p(x)} is nice}}}\end{matrix}$`;
    const tab = gridAsTabular(grid(latex));
    const doc = parseTex(`\\documentclass{article}\n\\usepackage{hyperref}\n\\begin{document}\n${tab}\n\\end{document}\n`).doc;
    const t = [...walkInsets(doc.body)].map(x => x.inset).find(i => i.type === 'Tabular') as { rows: unknown[]; columns: unknown[] } | undefined;
    expect(t).toBeDefined();
    expect(t!.columns).toHaveLength(5);
    expect(t!.rows).toHaveLength(7);   // three empty rows before the notes, as in the formula
    const out = writeTex(doc).text;
    expect(out).toContain('\\textbf{Feature}');
    expect(out).toContain('0 (requires $p(x)$)');
    expect(out).toContain('$\\log p(x)$');
    expect(out).toContain('\\href{https://arxiv.org/html/2405.18634}{Wang24}');
    expect(out).toContain('{\\tiny learning rule is iffy, but $p(x)$ is nice}');
    expect(out).not.toContain('\\text{');
  });
});
