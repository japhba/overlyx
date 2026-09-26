// @vitest-environment happy-dom
/**
 * Tables as LaTeX sets them (core schema.ts): p{…} column widths as CSS in the table's <colgroup>;
 * which paragraphs hold a table alone on its line (client editor/plugins/widetables.ts), and that the
 * marks follow edits.
 */
import { describe, it, expect } from 'vitest';
import { DOMSerializer } from 'prosemirror-model';
import { EditorState, TextSelection } from 'prosemirror-state';
import { schema, lyxLengthCss } from '../packages/core/src/schema.ts';
import { isTableFormula, isSoloTable, wideTablesPlugin, wideTablesKey } from '../packages/client/src/editor/plugins/widetables.ts';

const cell = (text: string, attrs: [string, string][] = [['alignment', 'left']]) => schema.nodes.table_cell.create({ attrs: JSON.stringify(attrs) }, schema.nodes.paragraph.create({ layout: 'Plain Layout' }, text ? schema.text(text) : undefined));
const table = (columns: [string, string][][]) => schema.nodes.table.create({ columns: JSON.stringify(columns) }, schema.nodes.table_row.create(null, columns.map((_, i) => cell('c' + i))));
const par = (...content: any[]) => schema.nodes.paragraph.create(null, content);
const math = (latex: string) => schema.nodes.math_inline.create({ latex });

describe('column widths', () => {
  it('LyX lengths become CSS', () => {
    expect(lyxLengthCss('5.5cm')).toBe('5.5cm');
    expect(lyxLengthCss('2in')).toBe('2in');
    expect(lyxLengthCss('40pt')).toBe('40pt');
    expect(lyxLengthCss('11text%')).toBe('calc(var(--ol-column, 720px) * 0.11)');
    expect(lyxLengthCss('50col%')).toBe('calc(var(--ol-column, 720px) * 0.5)');
    expect(lyxLengthCss('0.4\\linewidth')).toBe('calc(var(--ol-column, 720px) * 0.4)');
    expect(lyxLengthCss('\\textwidth')).toBe('calc(var(--ol-column, 720px) * 1)');
    expect(lyxLengthCss('')).toBeNull();
    expect(lyxLengthCss('\\foo')).toBeNull();
    expect(lyxLengthCss(undefined)).toBeNull();
  });

  it('a table carries a <colgroup>: p{…} columns at their width, l / c / r columns free', () => {
    const t = table([[['alignment', 'left']], [['alignment', 'block'], ['width', '3cm']], [['alignment', 'block'], ['width', '30text%']]]);
    // (the spec itself: happy-dom rewrites style attributes and drops calc(var(…)))
    const spec = schema.nodes.table.spec.toDOM!(t) as any[];
    const colgroup = spec[2][1] as any[];
    expect(colgroup[0]).toBe('colgroup');
    expect(colgroup.slice(1).map(c => c[1]?.style ?? null)).toEqual([null, 'width: 3cm', 'width: calc(var(--ol-column, 720px) * 0.3)']);
    const dom = DOMSerializer.fromSchema(schema).serializeNode(t) as HTMLElement;
    expect(dom.querySelector('table > colgroup + tbody')).not.toBeNull();
    // the cells are still the table's content, and read back without the colgroup
    expect(dom.querySelectorAll('tbody td').length).toBe(3);
  });
});

describe('a table alone on its line', () => {
  it('matrix / array / tabular formulas count as tables, other formulas do not', () => {
    expect(isTableFormula('\\begin{matrix}a & b\\\\ c & d\\end{matrix}')).toBe(true);
    expect(isTableFormula(' \\begin{pmatrix}1\\end{pmatrix} ')).toBe(true);
    expect(isTableFormula('\\begin{array}{cc}a&b\\end{array}')).toBe(true);
    expect(isTableFormula('\\begin{matrix}a\\end{matrix} + x')).toBe(false);
    expect(isTableFormula('x = \\begin{matrix}a\\end{matrix}')).toBe(false);
    expect(isTableFormula('\\begin{matrix}a\\end{pmatrix}')).toBe(false);
    expect(isTableFormula('a^2+b^2')).toBe(false);
  });

  it('what may stand beside it: blanks, a caption, a label, a display formula — not text', () => {
    const t = table([[['alignment', 'left']]]);
    expect(isSoloTable(par(t))).toBe(true);
    expect(isSoloTable(par(t, schema.text(' '), schema.nodes.inset.create({ name: 'Caption' }, par(schema.text('A caption')))))).toBe(true);
    expect(isSoloTable(par(schema.nodes.math_display.create({ latex: '' }), math('\\begin{matrix}a\\end{matrix}')))).toBe(true);
    expect(isSoloTable(par(schema.text('Text '), t))).toBe(false);
    expect(isSoloTable(par(math('x')))).toBe(false);
    expect(isSoloTable(par(t, t))).toBe(false);
    expect(isSoloTable(schema.nodes.paragraph.create({ align: 'right' }, t))).toBe(false);
  });

  it('the marks follow edits: typing text beside a table unmarks its paragraph, deleting it marks it again', () => {
    const doc = schema.nodes.doc.create(null, [par(schema.text('Before.')), par(table([[['alignment', 'left']]])), par(schema.text('After.'))]);
    let state = EditorState.create({ doc, plugins: [wideTablesPlugin()] });
    const marked = () => wideTablesKey.getState(state)!.find(undefined, undefined, s => !s.blank).map(d => state.doc.nodeAt(d.from)!.firstChild!.type.name);
    expect(marked()).toEqual(['table']);
    const tablePar = doc.child(0).nodeSize;   // the position of the second paragraph
    const end = tablePar + doc.child(1).nodeSize - 1;
    state = state.apply(state.tr.setSelection(TextSelection.create(state.doc, end)).insertText(' words'));
    expect(marked()).toEqual([]);
    state = state.apply(state.tr.delete(end, end + ' words'.length));
    expect(marked()).toEqual(['table']);
    // an edit elsewhere leaves the mark alone
    state = state.apply(state.tr.insertText('!', 1));
    expect(marked()).toEqual(['table']);
  });
});
