/**
 * Leaving a list the Google-Docs way (packages/client/src/editor/commands.ts): Backspace at the
 * start of a list item takes the bullet away and keeps the text (a nested item moves out one
 * level first); Enter on an empty item ends the list instead of adding another item. Elsewhere
 * both keys keep their meaning.
 */
import { describe, it, expect, vi } from 'vitest';
// the client's math node views touch `window` at import time
vi.hoisted(() => { const g = globalThis as any; if (typeof g.window === 'undefined') g.window = g; });
import { EditorState, TextSelection } from 'prosemirror-state';
import { schema } from '../packages/core/src/schema.ts';
import { listExitBackspace, paragraphBreak } from '../packages/client/src/editor/commands.ts';

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
  it('takes the bullet away and keeps the text; the paragraphs are not joined', () => {
    const s = cursor(mkState([['Standard', 0, 'Intro'], ['Itemize', 0, 'first'], ['Itemize', 0, 'second']]), 1);
    const r = run(listExitBackspace, s)!;
    expect(r).not.toBeNull();
    expect(shape(r)).toEqual([['Standard', 0, 'Intro'], ['Standard', 0, 'first'], ['Itemize', 0, 'second']]);
  });
  it('moves a nested item out one level first', () => {
    const s = cursor(mkState([['Itemize', 0, 'outer'], ['Itemize', 1, 'inner']]), 1);
    const r = run(listExitBackspace, s)!;
    expect(shape(r)).toEqual([['Itemize', 0, 'outer'], ['Itemize', 0, 'inner']]);
    expect(shape(run(listExitBackspace, cursor(r, 1))!)).toEqual([['Itemize', 0, 'outer'], ['Standard', 0, 'inner']]);
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
