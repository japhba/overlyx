// @vitest-environment happy-dom
/**
 * Hyperlinks the Google Docs way (client/editor/links.ts): ⌘K over selected text makes a
 * hyperlink inset, on a link it changes it, Remove link gives the text back, an address pasted
 * over a selection links it. Inside formulas: `\href{…}{…}` in the math model (parse, write,
 * MathJax, the cursor's insertLink / unlink, hyperref required) — the link that could not be made
 * over a table's `\text{Wang24}` cell. Also the formula geometry inside `\text{…}` (the caret
 * used to stick at the start of a text of more than one character).
 */
import { describe, it, expect, beforeAll } from 'vitest';
import { EditorState, TextSelection } from 'prosemirror-state';
import { EditorView } from 'prosemirror-view';
import { schema } from '@overlyx/core';
import { parseCell, parseFormula, writeFormula, writeCellLatex, renderHullSource, MathCursor, atomCells, nargs, type Atom, type Owner } from '../packages/core/src/math';
import { mathRequirements } from '../packages/core/src/latex/symbols';
import { normalizeMath } from '../packages/core/src/latex/mathfix';
import { normalizeLinkInput, openableUrl, mathLinkTarget, mathLinkUrl, hrefAt, hrefOf, hrefParams, unlinkText, pasteLinkOverSelection, linksPlugin } from '../packages/client/src/editor/links';
import { MathGeometry } from '../packages/client/src/editor/lyxmath/geometry';
import { toMathml } from './mathjax';
import { renderMath, mathReady } from '../packages/client/src/editor/lyxmath/mathjax';

describe('addresses typed into the link box', () => {
  it('get a scheme when they have none', () => {
    expect(normalizeLinkInput('arxiv.org/html/2405.18634')).toBe('https://arxiv.org/html/2405.18634');
    expect(normalizeLinkInput(' www.example.com ')).toBe('https://www.example.com');
    expect(normalizeLinkInput('jan@example.org')).toBe('mailto:jan@example.org');
    expect(normalizeLinkInput('http://x.org/a b')).toBe('http://x.org/a b');
    expect(normalizeLinkInput('#sec:intro')).toBe('#sec:intro');
    expect(normalizeLinkInput('notes')).toBe('notes');
  });
  it('only web, mail and ftp addresses are opened', () => {
    expect(openableUrl('https://x.org')).toBe('https://x.org');
    expect(openableUrl('mailto:a@b.org')).toBe('mailto:a@b.org');
    expect(openableUrl('x.org/a')).toBe('https://x.org/a');
    expect(openableUrl('javascript:alert(1)')).toBeNull();
    expect(openableUrl('data:text/html,hi')).toBeNull();
  });
  it('a formula keeps the address as LaTeX: % and # escaped, and back', () => {
    const url = 'https://x.org/a%20b#frag';
    expect(mathLinkTarget(url)).toBe('https://x.org/a\\%20b\\#frag');
    expect(mathLinkUrl(mathLinkTarget(url))).toBe(url);
  });
});

describe('\\href in the math model', () => {
  const TABLE = '\\begin{matrix}\\text{A} & \\text{\\href{https://arxiv.org/html/2405.18634}{Wang24}}\\\\ x & \\href{https://x.org/a\\%20b}{y^{2}}\\end{matrix}';
  it('parses into a link atom whose content is in the mode around it, and writes back byte-identically', () => {
    const cell = parseCell('\\text{see \\href{https://arxiv.org/abs/1\\#x}{Wang24}}');
    const text = cell[0] as Extract<Atom, { t: 'font' }>;
    const link = text.body.find(a => a.t === 'href') as Extract<Atom, { t: 'href' }>;
    expect(link.target).toBe('https://arxiv.org/abs/1\\#x');
    expect(link.body.map(a => (a as { c: string }).c).join('')).toBe('Wang24');
    expect(writeCellLatex(cell)).toBe('\\text{see \\href{https://arxiv.org/abs/1\\#x}{Wang24}}');
    const src = '$' + TABLE.replace('\\\\ x', '\\\\\nx').replace('\\end', '\n\\end') + '$';   // as LyX lays a matrix out
    expect(writeFormula(parseFormula(src))).toBe(src);
  });
  it('is drawn as a link box around its content (not MathJax\'s \\href, which would navigate)', () => {
    const { latex } = renderHullSource(parseFormula('$\\text{\\href{https://x.org}{Wang24}}$'), {});
    expect(latex).toContain('\\htmlClass{lm-href}');
    expect(latex).not.toContain('x.org');
    expect(toMathml(latex)).toContain('class="lm-href"');
  });
  it('needs hyperref in the document, and is text inside \\text{…} (not wrapped in \\ensuremath when written)', () => {
    const db = new Map([['href', 'hyperref'], ['alpha', '']]);
    expect(mathRequirements(TABLE, db)).toContain('hyperref');
    expect(normalizeMath('\\text{\\href{https://x.org}{Wang24} and \\alpha}', db, new Set())).toBe('\\text{\\href{https://x.org}{Wang24} and \\ensuremath{\\alpha}}');
  });
});

/** a cursor in the cell of `\text{…}` in the matrix cell (row, col) of `$\begin{matrix}…$` */
function cursorInText(src: string, row: number, col: number) {
  const hull = parseFormula(src);
  const c = new MathCursor(hull, {});
  const grid = hull.rows[0].cells[0][0] as Extract<Atom, { t: 'grid' }>;
  const text = grid.rows[row].cells[col][0];
  c.slices = [{ owner: hull, idx: 0, pos: 0 }, { owner: grid, idx: row * grid.ncols + col, pos: 0 }, { owner: text, idx: 0, pos: 0 }];
  return { hull, c };
}

describe('the math cursor makes, finds and removes links', () => {
  const TABLE = '$\\begin{matrix}\\text{Feature} & \\text{Wang24}\\\\ 1 & 0\\end{matrix}$';
  it('the selection in a table cell’s \\text becomes a link; the cursor ends behind it', () => {
    const { hull, c } = cursorInText(TABLE, 0, 1);
    c.resetAnchor(); c.selHandle(true); c.pos = c.lastpos;
    expect(c.grabSelection()).toBe('Wang24');
    expect(c.insertLink('https://arxiv.org/html/2405.18634', '')).toBe(true);
    expect(writeFormula(hull)).toBe(writeFormula(parseFormula('$\\begin{matrix}\\text{Feature} & \\text{\\href{https://arxiv.org/html/2405.18634}{Wang24}}\\\\ 1 & 0\\end{matrix}$')));
    expect(c.selection).toBe(false);
    expect(c.linkAt()?.atom.target).toBe('https://arxiv.org/html/2405.18634');   // right behind it: still "on" the link
  });
  it('without a selection a new link is typed in: text inside \\text, \\text{} added in math', () => {
    const { hull, c } = cursorInText(TABLE, 0, 0);
    c.pos = c.lastpos;
    c.insertLink('https://x.org', ' (see here)');
    expect(writeFormula(hull)).toContain('\\text{Feature\\href{https://x.org}{ (see here)}}');
    const h2 = parseFormula('$a+b$');
    const c2 = new MathCursor(h2, {});
    c2.pos = c2.lastpos;
    c2.insertLink('https://x.org', 'x & y');
    expect(writeFormula(h2)).toBe('$a+b\\href{https://x.org}{\\text{x \\& y}}$');
  });
  it('a selection across cells is refused', () => {
    const hull = parseFormula(TABLE);
    const c = new MathCursor(hull, {});
    const grid = hull.rows[0].cells[0][0] as Extract<Atom, { t: 'grid' }>;
    c.slices = [{ owner: hull, idx: 0, pos: 0 }, { owner: grid, idx: 0, pos: 0 }];
    c.resetAnchor(); c.selHandle(true); c.idx = 1; c.pos = c.lastpos;
    expect(c.insertLink('https://x.org', '')).toBe(false);
    expect(writeFormula(hull)).toBe(writeFormula(parseFormula(TABLE)));
  });
  it('unlink keeps the content and the cursor where they were', () => {
    const hull = parseFormula('$\\text{see \\href{https://x.org}{Wang24} now}$');
    const c = new MathCursor(hull, {});
    const text = hull.rows[0].cells[0][0] as Extract<Atom, { t: 'font' }>;
    const link = text.body[4];
    c.slices = [{ owner: hull, idx: 0, pos: 0 }, { owner: text, idx: 0, pos: 4 }, { owner: link, idx: 0, pos: 3 }];   // Wan|g24
    expect(c.linkAt()?.atom).toBe(link);
    expect(c.unlink()).toBe(true);
    expect(writeFormula(hull)).toBe('$\\text{see Wang24 now}$');
    expect(c.depth).toBe(2);
    expect(c.pos).toBe(7);
    expect(c.linkAt()).toBeNull();
  });
});

describe('the formula geometry inside \\text{…}', () => {
  beforeAll(() => mathReady());
  it('finds every character’s box, also inside the row MathJax puts around a longer text', async () => {
    const hull = parseFormula('$a\\text{hello}b$');
    const { latex, cells } = renderHullSource(hull, {}, { atoms: true });
    const content = document.createElement('div');
    const r = renderMath(latex);
    expect(r.error).toBeNull();
    content.appendChild(r.node!);
    document.body.appendChild(content);
    expect(content.querySelector('.lm-c1 > mjx-mrow:not([class])')).not.toBeNull();   // the wrapper this is about
    const parents = new Map<Owner, { owner: Owner; idx: number; pos: number }>();
    const walk = (owner: Owner) => atomCells(owner).forEach((cell, idx) => cell.forEach((atom, pos) => { if (nargs(atom) > 0) { parents.set(atom, { owner, idx, pos }); walk(atom); } }));
    walk(hull);
    const g = new MathGeometry(content, cells, parents);
    const text = hull.rows[0].cells[0][1];
    expect(g.cell(text, 0)?.atoms.length).toBe(5);
    expect(g.cell(hull, 0)?.atoms.length).toBe(3);
    content.remove();
  });
});

describe('links in the text', () => {
  function editor(text = 'See Wang24 here', plugins = [linksPlugin()]): EditorView {
    const doc = schema.node('doc', null, [schema.node('paragraph', { layout: 'Standard' }, [schema.text(text, [schema.marks.series.create({ value: 'bold' })])])]);
    return new EditorView(document.createElement('div'), { state: EditorState.create({ doc, plugins }) });
  }
  const select = (v: EditorView, from: number, to: number) => v.dispatch(v.state.tr.setSelection(TextSelection.create(v.state.doc, from, to)));
  it('an address pasted over selected text links it, in the text’s font; Remove link gives the text back', () => {
    const v = editor();
    select(v, 5, 11);   // "Wang24"
    expect(pasteLinkOverSelection(v, ' https://arxiv.org/html/2405.18634 ')).toBe(true);
    const node = v.state.doc.firstChild!.child(1);
    expect(node.type.name).toBe('command');
    expect(hrefOf(node)).toEqual({ url: 'https://arxiv.org/html/2405.18634', name: 'Wang24', literal: false });
    expect(JSON.parse(node.attrs.marks)).toEqual([{ type: 'series', attrs: { value: 'bold' } }]);
    // the cursor is right behind the link: ⌘K there edits it
    expect(v.state.selection.from).toBe(6);
    expect(hrefAt(v.state)?.pos).toBe(5);
    unlinkText(v, 5);
    expect(v.state.doc.textContent).toBe('See Wang24 here');
    expect(v.state.doc.firstChild!.childCount).toBe(1);   // one bold text run again
    v.destroy();
  });
  it('pasting anything but a single address, or with nothing selected, is an ordinary paste', () => {
    const v = editor();
    select(v, 5, 11);
    expect(pasteLinkOverSelection(v, 'two words')).toBe(false);
    expect(pasteLinkOverSelection(v, 'https://a.org https://b.org')).toBe(false);
    select(v, 5, 5);
    expect(pasteLinkOverSelection(v, 'https://a.org')).toBe(false);
    v.destroy();
  });
  it('the inset’s params follow LyX: mailto: as the type, the name only when it differs', () => {
    expect(hrefParams('mailto:a@b.org', 'write')).toEqual(['LatexCommand href', 'name "write"', 'target "a@b.org"', 'type "mailto:"', 'literal "false"', '']);
    expect(hrefParams('https://x.org', 'https://x.org')).toEqual(['LatexCommand href', 'target "https://x.org"', 'literal "false"', '']);
    expect(hrefParams('https://x.org', 'say "hi"')[1]).toBe('name "say \\"hi\\""');
  });
});
