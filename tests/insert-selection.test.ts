// @vitest-environment happy-dom
/**
 * Inserting something with a selection never throws the selection away (pre-beta findings): a
 * comment on selected text keeps the text (a thread is a point in the file, anchored after it);
 * Insert ▸ Float / Caption with a selected image wraps the image (LyX moves the selection into the
 * new inset) instead of replacing it with an empty float; a selected object stays when a label, a
 * formula or a table is inserted; a selection of several paragraphs moves into a footnote whole.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { EditorState, TextSelection, NodeSelection, type Command } from 'prosemirror-state';
import { CellSelection } from 'prosemirror-tables';
import type { Node as PMNode } from 'prosemirror-model';
import { schema } from '../packages/core/src/schema.ts';
import * as C from '../packages/client/src/editor/commands.ts';
import { changeTrackingPlugin, changeOf } from '../packages/client/src/editor/plugins/changes.ts';
import { editorContext } from '../packages/client/src/editor/context.ts';

const par = (...content: (PMNode | string)[]) => schema.nodes.paragraph.create({ layout: 'Standard' }, content.map(c => (typeof c === 'string' ? schema.text(c) : c)));
const plain = (...content: (PMNode | string)[]) => schema.nodes.paragraph.create({ layout: 'Plain Layout' }, content.map(c => (typeof c === 'string' ? schema.text(c) : c)));
const image = () => schema.nodes.graphics.create({ params: JSON.stringify(['\tfilename figures/plot.png', '']) });
const doc = (...pars: PMNode[]) => schema.nodes.doc.create(null, pars);

function stateOf(d: PMNode, tracking = false): EditorState {
  return EditorState.create({ doc: d, plugins: tracking ? [changeTrackingPlugin()] : [] });
}
function run(state: EditorState, cmd: Command): EditorState {
  let next = state;
  expect(cmd(state, tr => { next = state.apply(tr); })).toBe(true);
  return next;
}
/** position of the first node of a type (and optional predicate) */
function posOf(d: PMNode, type: string, test: (n: PMNode) => boolean = () => true): number {
  let at = -1;
  d.descendants((n, p) => { if (at < 0 && n.type.name === type && test(n)) at = p; return at < 0; });
  return at;
}
/** text of the document with insets shown as [Name: …] */
function shape(n: PMNode): string {
  if (n.isText) return n.text!;
  if (n.type.name === 'inset') return `[${n.attrs.name}${n.attrs.arg ? ' ' + n.attrs.arg : ''}: ${n.content.content.map(shape).join(' | ')}]`;
  if (n.type.name === 'graphics') return '<img>';
  if (n.type.name === 'command') return `<${n.attrs.cmd}>`;
  if (n.type.name === 'table') return '<table>';
  return n.content.content.map(shape).join(n.type.name === 'doc' ? ' ¶ ' : '');
}
const select = (s: EditorState, from: number, to: number) => s.apply(s.tr.setSelection(TextSelection.create(s.doc, from, to)));
const selectNode = (s: EditorState, pos: number) => s.apply(s.tr.setSelection(NodeSelection.create(s.doc, pos)));

beforeEach(() => { editorContext.trackChanges = false; editorContext.changeAuthorId = undefined; editorContext.user = { id: 1, name: 'Bob' } as never; editorContext.notify = undefined; });

describe('a comment on a selection keeps the selected text', () => {
  it('selected words: the text stays, the thread is anchored right after it, the cursor in the message', () => {
    let s = select(stateOf(doc(par('We want to minimise a function.'))), 9, 11);   // "to"
    s = run(s, C.insertComment);
    const p = s.doc.firstChild!;
    expect(p.textContent.startsWith('We want to')).toBe(true);
    expect(shape(s.doc)).toMatch(/^We want to\[Note Comment: Bob \(.*\): \| \] minimise a function\.$/);
    const $c = s.selection.$from;
    expect($c.parent.type.name).toBe('paragraph');
    expect($c.parent.content.size).toBe(0);   // the empty message paragraph
    expect($c.node($c.depth - 1).attrs.arg).toBe('Comment');
  });

  it('a selection over several paragraphs (and a formula) keeps all of them; the thread ends the last one', () => {
    const math = schema.nodes.math_display.create({ latex: '\\begin{equation}x\\label{eq:a}\\end{equation}' });
    let s = stateOf(doc(par('First sentence.'), par('Second ', math, ' end.'), par('Third.')));
    s = select(s, 1, s.doc.child(0).nodeSize + s.doc.child(1).nodeSize + 1);   // to the start of "Third."
    const before = s.doc.textContent;
    s = run(s, C.insertComment);
    expect(posOf(s.doc, 'math_display')).toBeGreaterThan(0);
    expect(s.doc.childCount).toBe(3);
    expect(shape(s.doc.child(1))).toMatch(/^Second  end\.\[Note Comment: /);
    expect(s.doc.child(2).textContent).toBe('Third.');
    expect(s.doc.textContent.startsWith(before.slice(0, 20))).toBe(true);
  });

  it('while suggesting: nothing is deleted, the thread is the only insertion', () => {
    editorContext.trackChanges = true; editorContext.changeAuthorId = 5;
    let s = select(stateOf(doc(par('We want to minimise.')), true), 9, 11);
    s = run(s, C.insertComment);
    let deleted = 0;
    s.doc.descendants(n => { if (changeOf(n)?.type === 'deleted') deleted++; });
    expect(deleted).toBe(0);
    expect(s.doc.firstChild!.textContent.startsWith('We want to')).toBe(true);
  });
});

describe('floats and captions wrap a selected image', () => {
  it('Insert ▸ Float ▸ Figure with the image selected: the image goes into the float, the cursor into its caption', () => {
    let s = stateOf(doc(par(image())));
    s = selectNode(s, posOf(s.doc, 'graphics'));
    s = run(s, C.insertFloat('figure'));
    expect(shape(s.doc)).toBe('[Float figure: <img> | [Caption Standard: ]]');
    const $c = s.selection.$from;
    expect($c.node($c.depth - 1).attrs.name).toBe('Caption');
  });

  it('a table float puts its caption above the selected table', () => {
    const table = schema.nodes.table.create(null, schema.nodes.table_row.create(null, [schema.nodes.table_cell.create(null, plain('a'))]));
    let s = stateOf(doc(par(table)));
    s = selectNode(s, posOf(s.doc, 'table'));
    s = run(s, C.insertFloat('table'));
    expect(shape(s.doc)).toBe('[Float table: [Caption Standard: ] | <table>]');
  });

  it('selected text of a paragraph becomes the figure\'s content', () => {
    let s = select(stateOf(doc(par('A diagram here.'))), 3, 10);
    s = run(s, C.insertFloat('figure'));
    expect(shape(s.doc)).toBe('A [Float figure: diagram | [Caption Standard: ]] here.');
  });

  it('Insert ▸ Caption with an image selected outside a float makes it a figure with a caption', () => {
    let s = stateOf(doc(par('Before ', image(), ' after')));
    s = selectNode(s, posOf(s.doc, 'graphics'));
    s = run(s, C.insertCaption);
    expect(shape(s.doc)).toBe('Before [Float figure: <img> | [Caption Standard: ]] after');
  });

  it('Insert ▸ Caption with the image selected inside a float adds a caption paragraph below it', () => {
    const float = schema.nodes.inset.create({ name: 'Float', arg: 'figure', params: '[]', status: 'open' }, [plain(image())]);
    let s = stateOf(doc(par(float)));
    s = selectNode(s, posOf(s.doc, 'graphics'));
    s = run(s, C.insertCaption);
    expect(shape(s.doc)).toBe('[Float figure: <img> | [Caption Standard: ]]');
    const $c = s.selection.$from;
    expect($c.node($c.depth - 1).attrs.name).toBe('Caption');
  });

  it('Insert ▸ Caption on selected text still moves the text into the caption (LyX)', () => {
    const float = schema.nodes.inset.create({ name: 'Float', arg: 'figure', params: '[]', status: 'open' }, [plain(image()), plain('A plot')]);
    let s = stateOf(doc(par(float)));
    const at = posOf(s.doc, 'paragraph', n => n.attrs.layout === 'Plain Layout' && n.textContent === 'A plot');
    s = select(s, at + 1, at + 7);
    s = run(s, C.insertCaption);
    expect(shape(s.doc)).toBe('[Float figure: <img> | [Caption Standard: A plot]]');
  });
});

describe('a selected object stays when something is inserted', () => {
  it('a label inserted with the image selected goes after the image', () => {
    let s = stateOf(doc(par('x ', image(), ' y')));
    s = selectNode(s, posOf(s.doc, 'graphics'));
    s = run(s, C.insertLabel('fig:a'));
    expect(shape(s.doc)).toBe('x <img><label> y');
  });

  it('a table inserted with a formula selected takes it into its first cell (LyX)', () => {
    let s = stateOf(doc(par('x ', schema.nodes.math_inline.create({ latex: 'a' }), ' y')));
    s = selectNode(s, posOf(s.doc, 'math_inline'));
    s = run(s, C.insertTable(2, 2));
    const table = s.doc.nodeAt(posOf(s.doc, 'table'))!;
    expect(table.firstChild!.firstChild!.firstChild!.firstChild!.type.name).toBe('math_inline');
    expect(shape(s.doc)).toBe('x <table> y');
  });

  it('a formula inserted with an image selected goes after the image', () => {
    let s = stateOf(doc(par('x ', image(), ' y')));
    s = selectNode(s, posOf(s.doc, 'graphics'));
    const view = { state: s, dispatch(tr: import('prosemirror-state').Transaction) { s = s.apply(tr); this.state = s; }, nodeDOM: () => null } as never;
    C.insertMath(false)(view);
    expect(posOf(s.doc, 'graphics')).toBeGreaterThan(0);
    expect(posOf(s.doc, 'math_inline')).toBeGreaterThan(posOf(s.doc, 'graphics'));
  });

  it('a footnote inserted with selected table cells keeps their text', () => {
    const cell = (t: string) => schema.nodes.table_cell.create(null, plain(t));
    const table = schema.nodes.table.create(null, schema.nodes.table_row.create(null, [cell('a1'), cell('b2')]));
    let s = stateOf(doc(par(table)));
    const first = posOf(s.doc, 'table_cell'), last = posOf(s.doc, 'table_cell', n => n.textContent === 'b2');
    s = s.apply(s.tr.setSelection(CellSelection.create(s.doc, first, last)));
    s = run(s, C.insertFootnote);
    expect(s.doc.textContent).toContain('a1');
    expect(s.doc.textContent).toContain('b2');
    expect(posOf(s.doc, 'inset', n => n.attrs.name === 'Foot')).toBeGreaterThan(0);
  });

  it('a footnote over several paragraphs takes them in whole — nothing is lost', () => {
    let s = stateOf(doc(par('One two'), par('Three'), par('Four five')));
    s = select(s, 5, s.doc.child(0).nodeSize + s.doc.child(1).nodeSize + 5);   // "two" … "Four"
    s = run(s, C.insertFootnote);
    expect(shape(s.doc)).toBe('One [Foot: two | Three | Four] five');
  });
});
