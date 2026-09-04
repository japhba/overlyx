// @vitest-environment happy-dom
/**
 * Tracked changes on inline NODES (formulas, references, graphics…): an inline node keeps its
 * change in the `marks` attribute (y-prosemirror drops real marks on non-text nodes). This covers
 *  - changeTrackingPlugin marking a node the user inserts while tracking is on (a pasted formula),
 *    but not a formula whose latex is merely edited, and never a margin-drawing anchor;
 *  - the DOM side: applyChangeAttrs (node views) and the schema's toDOM (plain leaves) both show
 *    the change with the `lyx-change-*` classes and `data-changed` / `data-author` — which is what
 *    colours a formula inserted by the agent like the text around it;
 *  - the clipboard: the node-level attributes must not let the change MARK's parse rule swallow
 *    the node (it matches `span[data-change]`, hence `data-changed` on nodes).
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { EditorState, TextSelection } from 'prosemirror-state';
import { DOMParser as PMDOMParser, DOMSerializer, Node as PMNode } from 'prosemirror-model';
import { schema } from '../packages/core/src/schema.ts';
import { changeTrackingPlugin, applyChangeAttrs, changeOf } from '../packages/client/src/editor/plugins/changes.ts';
import { editorContext } from '../packages/client/src/editor/context.ts';

const para = (...content: PMNode[]) => schema.nodes.paragraph.create({ layout: 'Standard' }, content);
const doc = (...pars: PMNode[]) => schema.nodes.doc.create(null, pars);
const math = (latex: string, marks = '[]') => schema.nodes.math_inline.create({ latex, delim: '$', marks });

function stateWith(d: PMNode) {
  return EditorState.create({ doc: d, plugins: [changeTrackingPlugin()] });
}

describe('changeTrackingPlugin and inline nodes', () => {
  beforeEach(() => { editorContext.trackChanges = true; editorContext.changeAuthorId = 7; });

  it('a formula inserted while tracking is on carries the change in its marks attribute', () => {
    let state = stateWith(doc(para(schema.text('Hello world'))));
    state = state.apply(state.tr.setSelection(TextSelection.create(state.doc, 6)));
    state = state.apply(state.tr.replaceSelectionWith(math('x^2'), false));
    const node = state.doc.nodeAt(6)!;
    expect(node.type.name).toBe('math_inline');
    expect(changeOf(node)).toMatchObject({ type: 'inserted', author: 7 });
    // the surrounding text is untouched
    expect(state.doc.firstChild!.firstChild!.marks.length).toBe(0);
  });

  it('editing an existing (unchanged) formula does not mark it — LyX tracks no edits inside math', () => {
    let state = stateWith(doc(para(schema.text('a '), math('x'), schema.text(' b'))));
    state = state.apply(state.tr.setNodeMarkup(3, undefined, { ...state.doc.nodeAt(3)!.attrs, latex: 'x+1' }));
    expect(state.doc.nodeAt(3)!.attrs.latex).toBe('x+1');
    expect(changeOf(state.doc.nodeAt(3)!)).toBeNull();
  });

  it('a pasted slice marks its text and its nodes, keeping an existing change', () => {
    let state = stateWith(doc(para(schema.text('start'))));
    state = state.apply(state.tr.setSelection(TextSelection.create(state.doc, 6)));
    const existing = JSON.stringify([{ type: 'change', attrs: { type: 'deleted', author: 3, time: 1 } }]);
    state = state.apply(state.tr.insert(6, [schema.text(' new '), math('y'), schema.text(' '), math('z', existing)]));
    const par = state.doc.firstChild!;
    const kinds = par.content.content.map(n => [n.type.name, changeOf(n)?.type ?? null, changeOf(n)?.author ?? null]);
    expect(kinds).toEqual([['text', null, null], ['text', 'inserted', 7], ['math_inline', 'inserted', 7], ['text', 'inserted', 7], ['math_inline', 'deleted', 3]]);
  });

  it('a margin-drawing anchor is never tracked', () => {
    let state = stateWith(doc(para(schema.text('text'))));
    state = state.apply(state.tr.insert(1, schema.nodes.sketch.create({ src: 'figures/ink-1.svg', data: null })));
    expect(changeOf(state.doc.nodeAt(1)!)).toBeNull();
  });

  it('does nothing while tracking is off', () => {
    editorContext.trackChanges = false;
    let state = stateWith(doc(para(schema.text('Hello'))));
    state = state.apply(state.tr.insert(1, math('q')));
    expect(changeOf(state.doc.nodeAt(1)!)).toBeNull();
  });
});

describe('the change shows on the node DOM', () => {
  const inserted = JSON.stringify([{ type: 'change', attrs: { type: 'inserted', author: 7, time: 1700000000 } }]);

  it('applyChangeAttrs sets and clears the classes and data attributes', () => {
    const dom = document.createElement('span');
    dom.className = 'lyx-math-inline';
    applyChangeAttrs(dom, math('x', inserted));
    expect(dom.className).toBe('lyx-math-inline lyx-change lyx-change-inserted');
    expect(dom.getAttribute('data-changed')).toBe('inserted');
    expect(dom.getAttribute('data-author')).toBe('7');
    expect(dom.getAttribute('data-time')).toBe('1700000000');
    expect(dom.hasAttribute('data-change')).toBe(false);   // the mark's attribute stays the mark's
    applyChangeAttrs(dom, math('x'));
    expect(dom.className).toBe('lyx-math-inline');
    expect(dom.hasAttribute('data-changed')).toBe(false);
    expect(dom.hasAttribute('data-author')).toBe(false);
  });

  it('toDOM of a plain leaf carries the change, and the clipboard round trip keeps the node', () => {
    const quotes = schema.nodes.quotes.create({ kind: 'eld', marks: inserted });
    const el = DOMSerializer.fromSchema(schema).serializeNode(quotes) as HTMLElement;
    expect(el.className).toBe('lyx-quotes lyx-change lyx-change-inserted');
    expect(el.getAttribute('data-changed')).toBe('inserted');
    expect(el.getAttribute('data-author')).toBe('7');
    // paste it back: still a quotes node with its marks, not text inside a change mark
    const d = doc(para(schema.text('a'), quotes, math('m', inserted)));
    const frag = DOMSerializer.fromSchema(schema).serializeFragment(d.content);
    const holder = document.createElement('div'); holder.appendChild(frag);
    const back = PMDOMParser.fromSchema(schema).parse(holder);
    expect(back.firstChild!.content.content.map(n => n.type.name)).toEqual(['text', 'quotes', 'math_inline']);
    expect(changeOf(back.firstChild!.child(1))).toMatchObject({ type: 'inserted', author: 7 });
    expect(changeOf(back.firstChild!.child(2))).toMatchObject({ type: 'inserted', author: 7 });
  });
});
