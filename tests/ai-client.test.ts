/**
 * Client-side pieces of the AI assistance that need no browser: where a text completion may be
 * requested and which context it sends (editor/ai/complete.ts), how the formula with the cursor
 * is described (editor/ai/mathassist.ts), and how the ghost is spliced into the KaTeX source of
 * a formula (lyxmath/field.ts `injectGhost`).
 */
import { describe, it, expect } from 'vitest';
import { EditorState, TextSelection } from 'prosemirror-state';
import { schema, renderHullSource, parseFormula } from '../packages/core/src/index.ts';
import { completionContext } from '../packages/client/src/editor/ai/complete.ts';
import { formulaWithCursor } from '../packages/client/src/editor/ai/mathassist.ts';
import { injectGhost } from '../packages/client/src/editor/lyxmath/field.ts';

const par = (text: string, layout = 'Standard') => schema.nodes.paragraph.create({ layout, depth: 0 }, text ? schema.text(text) : undefined);
const doc = (...pars: ReturnType<typeof par>[]) => schema.nodes.doc.create(null, pars);
const at = (d: ReturnType<typeof doc>, pos: number) => EditorState.create({ doc: d, selection: TextSelection.create(d, pos) });

describe('completionContext', () => {
  const d = doc(par('Introduction', 'Section'), par('Networks show rich dynamics.'), par('The gain controls chaos.'));
  const p1 = 1 + d.child(0).nodeSize;   // start of the second paragraph's text
  it('offers a completion at the end of a paragraph, with the neighbours as context', () => {
    const ctx = completionContext(at(d, p1 + 'Networks show rich dynamics.'.length));
    expect(ctx).not.toBeNull();
    expect(ctx!.before).toBe('Introduction\n\nNetworks show rich dynamics.');
    expect(ctx!.after).toBe('\n\nThe gain controls chaos.');
  });
  it('offers one before a space, but not inside a word', () => {
    expect(completionContext(at(d, p1 + 'Networks'.length))).not.toBeNull();
    expect(completionContext(at(d, p1 + 'Netw'.length))).toBeNull();
  });
  it('needs a few characters, a collapsed cursor, and no code-like layout', () => {
    expect(completionContext(at(d, p1 + 2))).toBeNull();
    const withSel = EditorState.create({ doc: d, selection: TextSelection.create(d, p1, p1 + 5) });
    expect(completionContext(withSel)).toBeNull();
    const code = doc(par('int main() {', 'LyX-Code'));
    expect(completionContext(at(code, 1 + 'int main() {'.length))).toBeNull();
  });
});

describe('formulaWithCursor', () => {
  it('marks the cursor inside the whole formula when the cell is found', () => {
    expect(formulaWithCursor('\\begin{equation}\n\\lambda=\\log g+1\n\\end{equation}', '\\lambda=\\log g+1', '')).toBe('\\begin{equation}\n\\lambda=\\log g+1⟦CURSOR⟧\n\\end{equation}');
    expect(formulaWithCursor('$a+b$', 'a+', 'b')).toBe('$a+⟦CURSOR⟧b$');
  });
  it('describes the position otherwise', () => {
    expect(formulaWithCursor('\\frac{a}{b}', 'z', '')).toContain('right after: z⟦CURSOR⟧');
  });
});

describe('injectGhost', () => {
  it('appends the ghost inside the cell wrapper', () => {
    expect(injectGhost('\\htmlClass{lm-c0}{a+b}', 0, 'x^{2}', false)).toBe('\\htmlClass{lm-c0}{a+b\\htmlClass{lm-ghost}{x^{2}}}');
    expect(injectGhost('\\htmlClass{lm-c1}{\\frac{\\htmlClass{lm-c2}{a}}{\\htmlClass{lm-c3}{b}}}', 3, '+c', false)).toBe('\\htmlClass{lm-c1}{\\frac{\\htmlClass{lm-c2}{a}}{\\htmlClass{lm-c3}{b\\htmlClass{lm-ghost}{+c}}}}');
  });
  it('works on the source the renderer produces for a real formula', () => {
    const hull = parseFormula('\\begin{equation}\n\\lambda=\\log g+1\n\\end{equation}', {});
    const { latex, cells } = renderHullSource(hull, {});
    const top = cells.find(c => c.owner === hull)!;
    const out = injectGhost(latex, top.id, '+\\sigma^{2}', false);
    expect(out).toContain('\\htmlClass{lm-ghost}{+\\sigma^{2}}');
    expect(out.length).toBe(latex.length + '\\htmlClass{lm-ghost}{+\\sigma^{2}}'.length);
  });
  it('leaves the source alone when the cell is missing', () => {
    expect(injectGhost('\\htmlClass{lm-c0}{a}', 7, 'x', false)).toBe('\\htmlClass{lm-c0}{a}');
  });
});

describe('IDE-style suggestion handling', async () => {
  const { trimNodes, typedSince, nodesText } = await import('../packages/client/src/editor/ai/complete.ts');
  const nodes = [{ type: 'text', text: ' is governed by ' }, { type: 'math_inline', attrs: { latex: '\\lambda_1', delim: '$' } }, { type: 'text', text: '.' }];
  it('the plain text of a suggestion writes formulas as $…$', () => {
    expect(nodesText(nodes)).toBe(' is governed by $\\lambda_1$.');
  });
  it('typing the beginning shortens the suggestion; a formula cannot be cut into', () => {
    expect(trimNodes(nodes, 4)).toEqual([{ type: 'text', text: 'governed by ' }, nodes[1], nodes[2]]);
    expect(trimNodes(nodes, ' is governed by '.length)).toEqual([nodes[1], nodes[2]]);
    expect(trimNodes(nodes, ' is governed by '.length + 1)).toBeNull();
    expect(trimNodes(nodes, 0)).toEqual(nodes);
  });
  it('recognises what was typed since the request, and a cursor that went elsewhere', () => {
    const req = { pos: 10, before: 'The chaos', after: '' };
    expect(typedSince(req, { pos: 14, before: 'The chaos is ', after: '' })).toBe(' is ');
    expect(typedSince(req, { pos: 10, before: 'The chaos', after: '' })).toBe('');
    expect(typedSince(req, { pos: 9, before: 'The chao', after: '' })).toBeNull();
    expect(typedSince(req, { pos: 14, before: 'Elsewhere now', after: '' })).toBeNull();
    expect(typedSince(req, { pos: 12, before: 'The chaos is ', after: '' })).toBeNull();   // positions and text disagree (a formula was inserted)
    expect(typedSince(req, { pos: 14, before: 'The chaos is ', after: 'changed' })).toBeNull();
  });
});
