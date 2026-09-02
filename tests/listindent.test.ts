/**
 * Tab / Shift+Tab list indenting (packages/client/src/editor/commands.ts listIndent/changeDepth):
 * LyX site.bind falls Tab through to depth-increment, gated by Text::changeDepthAllowed — a
 * paragraph may only nest one step deeper than its predecessor allows (getMaxDepthAfter).
 */
import { describe, it, expect, vi } from 'vitest';
// the client's math node views touch `window` at import time
vi.hoisted(() => { const g = globalThis as any; if (typeof g.window === 'undefined') g.window = g; });
import { EditorState, TextSelection } from 'prosemirror-state';
import { schema } from '../packages/core/src/schema.ts';
import { listIndent, changeDepth } from '../packages/client/src/editor/commands.ts';

/** a doc of flat paragraphs; each ["Layout", depth, "text"] */
function mkState(pars: [string, number, string][]): EditorState {
  const doc = schema.nodes.doc.create(null, pars.map(([layout, depth, text]) =>
    schema.nodes.paragraph.create({ layout, depth }, text ? schema.text(text) : undefined)));
  return EditorState.create({ schema, doc });
}
/** cursor into paragraph `i` (or a selection from paragraph `i` through `j`) */
function select(state: EditorState, i: number, j = i): EditorState {
  let from = 0, to = 0;
  state.doc.forEach((n, offset, idx) => { if (idx === i) from = offset + 1; if (idx === j) to = offset + 1 + n.content.size; });
  return state.apply(state.tr.setSelection(TextSelection.create(state.doc, from, to)));
}
const depths = (state: EditorState): number[] => {
  const out: number[] = [];
  state.doc.forEach(n => { out.push(n.attrs.depth as number); });
  return out;
};
const run = (state: EditorState, cmd: ReturnType<typeof listIndent>): { handled: boolean; state: EditorState } => {
  let out = state;
  const handled = cmd(state, tr => { out = state.apply(tr); });
  return { handled, state: out };
};

describe('Tab indents list items', () => {
  it('indents a bullet under the previous item', () => {
    const s = select(mkState([['Itemize', 0, 'one'], ['Itemize', 0, 'two']]), 1);
    const r = run(s, listIndent(1));
    expect(r.handled).toBe(true);
    expect(depths(r.state)).toEqual([0, 1]);
  });

  it('consumes the key but does nothing on the first item (LyX changeDepthAllowed)', () => {
    const s = select(mkState([['Itemize', 0, 'one'], ['Itemize', 0, 'two']]), 0);
    const r = run(s, listIndent(1));
    expect(r.handled).toBe(true); // eaten: focus must not tab out of the editor
    expect(depths(r.state)).toEqual([0, 0]);
  });

  it('cannot indent more than one step past the previous item', () => {
    let s = select(mkState([['Itemize', 0, 'one'], ['Itemize', 0, 'two']]), 1);
    s = run(s, listIndent(1)).state;
    s = run(select(s, 1), listIndent(1)).state;
    expect(depths(s)).toEqual([0, 1]);
  });

  it('is not claimed in an ordinary paragraph (browser keeps Tab)', () => {
    const s = select(mkState([['Standard', 0, 'text'], ['Standard', 0, 'more']]), 1);
    expect(run(s, listIndent(1)).handled).toBe(false);
    expect(run(s, listIndent(-1)).handled).toBe(false);
  });

  it('indents a whole selection, the max depth running forward through it', () => {
    const s = select(mkState([['Itemize', 0, 'one'], ['Itemize', 0, 'two'], ['Itemize', 0, 'three']]), 1, 2);
    const r = run(s, listIndent(1));
    expect(depths(r.state)).toEqual([0, 1, 1]);
  });

  it('cannot nest under a non-environment paragraph', () => {
    const s = select(mkState([['Standard', 0, 'text'], ['Itemize', 0, 'one']]), 1);
    const r = run(s, listIndent(1));
    expect(r.handled).toBe(true);
    expect(depths(r.state)).toEqual([0, 0]);
  });
});

describe('Shift+Tab unindents', () => {
  it('unindents a nested bullet', () => {
    const s = select(mkState([['Itemize', 0, 'one'], ['Itemize', 1, 'sub']]), 1);
    const r = run(s, listIndent(-1));
    expect(r.handled).toBe(true);
    expect(depths(r.state)).toEqual([0, 0]);
  });

  it('consumes the key at depth 0 without changing anything', () => {
    const s = select(mkState([['Itemize', 0, 'one'], ['Itemize', 0, 'two']]), 1);
    const r = run(s, listIndent(-1));
    expect(r.handled).toBe(true);
    expect(depths(r.state)).toEqual([0, 0]);
  });

  it('unindents a nested Standard continuation paragraph', () => {
    const s = select(mkState([['Itemize', 0, 'one'], ['Standard', 1, 'continuation']]), 1);
    const r = run(s, listIndent(-1));
    expect(r.handled).toBe(true);
    expect(depths(r.state)).toEqual([0, 0]);
  });
});

describe('changeDepth (Alt+Shift+arrows) follows the same LyX rule', () => {
  it('no longer indents a paragraph past what its predecessor allows', () => {
    const s = select(mkState([['Itemize', 0, 'one']]), 0);
    expect(run(s, changeDepth(1)).handled).toBe(false);
  });

  it('allows nesting under Quote (any environment, not just lists)', () => {
    const s = select(mkState([['Quote', 0, 'quoted'], ['Standard', 0, 'text']]), 1);
    const r = run(s, changeDepth(1));
    expect(r.handled).toBe(true);
    expect(depths(r.state)).toEqual([0, 1]);
  });
});
