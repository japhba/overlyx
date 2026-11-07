/**
 * Leaving a list (packages/client/src/editor/commands.ts): Backspace at the start of a list item
 * takes it one level out with its sub-items — no bullet is level 0 —, a paragraph nested in an item
 * moves out one level per Backspace; Enter on an empty item
 * ends the list instead of adding another item; Tab puts a paragraph after a list into the item
 * above. Elsewhere the keys keep their meaning.
 */
import { describe, it, expect, vi } from 'vitest';
// the client's math node views touch `window` at import time
vi.hoisted(() => { const g = globalThis as any; if (typeof g.window === 'undefined') { g.window = g; /* MathJax reads navigator.appVersion (node's navigator has none) */ if (g.navigator && g.navigator.appVersion === undefined) Object.defineProperty(g.navigator, 'appVersion', { value: '', configurable: true }); } });
import { EditorState, TextSelection } from 'prosemirror-state';
import { schema } from '../packages/core/src/schema.ts';
import { listExitBackspace, paragraphBreak, listIndent } from '../packages/client/src/editor/commands.ts';

/** a doc of flat paragraphs; each ["Layout", depth, "text"] */
function mkState(pars: [string, number, string][]): EditorState {
  const doc = schema.nodes.doc.create(null, pars.map(([layout, depth, text]) =>
    schema.nodes.paragraph.create({ layout, depth }, text ? schema.text(text) : undefined)));
  return EditorState.create({ schema, doc });
}
/** the cursor at character `col` of paragraph `i` */
function cursor(state: EditorState, i: number, col = 0): EditorState {
  let pos = 0;
  state.doc.forEach((n, offset, idx) => { if (idx === i) pos = offset + 1 + col; });
  return state.apply(state.tr.setSelection(TextSelection.create(state.doc, pos)));
}
const shape = (state: EditorState): [string, number, string][] => {
  const out: [string, number, string][] = [];
  state.doc.forEach(n => { out.push([n.attrs.layout as string, n.attrs.depth as number, n.textContent]); });
  return out;
};
const run = (cmd: typeof listExitBackspace, state: EditorState): EditorState | null => {
  let out: EditorState | null = null;
  const ok = cmd(state, tr => { out = state.apply(tr); });
  return ok ? out : null;
};

describe('Backspace at the start of a list item', () => {
  it('takes an item of the outermost level out of the list: a plain paragraph, its text kept; the paragraphs are not joined', () => {
    const s = cursor(mkState([['Standard', 0, 'Intro'], ['Itemize', 0, 'first'], ['Itemize', 0, 'second']]), 1);
    const r = run(listExitBackspace, s)!;
    expect(r).not.toBeNull();
    expect(shape(r)).toEqual([['Standard', 0, 'Intro'], ['Standard', 0, 'first'], ['Itemize', 0, 'second']]);
    const r2 = run(listExitBackspace, cursor(mkState([['Itemize', 0, 'first'], ['Itemize', 0, 'second']]), 1))!;
    expect(shape(r2)).toEqual([['Itemize', 0, 'first'], ['Standard', 0, 'second']]);
    expect(run(listExitBackspace, cursor(r2, 1))).toBeNull();   // now an ordinary Backspace (joins)
  });
  it('takes a nested item one level out, a bullet still (no bullet is level 0)', () => {
    const s = cursor(mkState([['Itemize', 0, 'outer'], ['Itemize', 1, 'a'], ['Itemize', 1, 'b']]), 2);
    const r1 = run(listExitBackspace, s)!;
    expect(shape(r1)).toEqual([['Itemize', 0, 'outer'], ['Itemize', 1, 'a'], ['Itemize', 0, 'b']]);
    expect(shape(run(listExitBackspace, cursor(r1, 2))!)).toEqual([['Itemize', 0, 'outer'], ['Itemize', 1, 'a'], ['Standard', 0, 'b']]);
  });
  it('an item with sub-items: they go out with it and stay its sub-items, or carry the list on under the plain paragraph', () => {
    const nested = cursor(mkState([['Itemize', 0, 'P'], ['Itemize', 1, 'B'], ['Itemize', 2, 'B1'], ['Standard', 2, 'B1 text'], ['Itemize', 1, 'C']]), 1);
    expect(shape(run(listExitBackspace, nested)!)).toEqual([['Itemize', 0, 'P'], ['Itemize', 0, 'B'], ['Itemize', 1, 'B1'], ['Standard', 1, 'B1 text'], ['Itemize', 1, 'C']]);
    const outer = cursor(mkState([['Standard', 0, 'Intro'], ['Itemize', 0, 'A'], ['Itemize', 1, 'A1'], ['Itemize', 1, 'A2'], ['Itemize', 0, 'B']]), 1);
    expect(shape(run(listExitBackspace, outer)!)).toEqual([['Standard', 0, 'Intro'], ['Standard', 0, 'A'], ['Itemize', 0, 'A1'], ['Itemize', 0, 'A2'], ['Itemize', 0, 'B']]);
  });
  it('a paragraph nested in an item moves out one level per Backspace, then joins', () => {
    const s = cursor(mkState([['Itemize', 0, 'item'], ['Standard', 1, 'inside']]), 1);
    const r = run(listExitBackspace, s)!;
    expect(shape(r)).toEqual([['Itemize', 0, 'item'], ['Standard', 0, 'inside']]);
    expect(run(listExitBackspace, cursor(r, 1))).toBeNull();
  });
  it('does nothing away from the start of an item, or in an ordinary paragraph (Backspace keeps its meaning)', () => {
    expect(run(listExitBackspace, cursor(mkState([['Itemize', 0, 'first']]), 0, 2))).toBeNull();
    expect(run(listExitBackspace, cursor(mkState([['Standard', 0, 'a'], ['Standard', 0, 'b']]), 1))).toBeNull();
  });
});

describe('Enter on a list item', () => {
  it('ends the list when the item is empty (no new paragraph), continues it otherwise', () => {
    const empty = cursor(mkState([['Itemize', 0, 'first'], ['Itemize', 0, '']]), 1);
    expect(shape(run(paragraphBreak, empty)!)).toEqual([['Itemize', 0, 'first'], ['Standard', 0, '']]);
    const full = cursor(mkState([['Itemize', 0, 'first']]), 0, 5);
    expect(shape(run(paragraphBreak, full)!)).toEqual([['Itemize', 0, 'first'], ['Itemize', 0, '']]);
  });
  it('moves an empty nested item out one level before ending the list', () => {
    const s = cursor(mkState([['Itemize', 0, 'outer'], ['Itemize', 1, '']]), 1);
    expect(shape(run(paragraphBreak, s)!)).toEqual([['Itemize', 0, 'outer'], ['Itemize', 0, '']]);
  });
});

describe('Tab after a list', () => {
  it('puts a paragraph right after a list item into that item; elsewhere Tab is not claimed', () => {
    const s = cursor(mkState([['Itemize', 0, 'item'], ['Standard', 0, 'after']]), 1);
    expect(shape(run(listIndent(1), s)!)).toEqual([['Itemize', 0, 'item'], ['Standard', 1, 'after']]);
    expect(run(listIndent(1), cursor(mkState([['Standard', 0, 'a'], ['Standard', 0, 'b']]), 1))).toBeNull();
    expect(run(listIndent(1), cursor(mkState([['Section', 0, 'H'], ['Standard', 0, 'b']]), 1))).toBeNull();
  });
});
