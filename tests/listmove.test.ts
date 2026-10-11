/**
 * Moving a list item with its sub-items (packages/client/src/editor/listmove.ts): the places a drag
 * may drop it (depth ranges that keep the list's structure), the move itself (one transaction, the
 * selection along), the list type taken from the list it lands in, and Alt+↑ / Alt+↓.
 */
import { describe, it, expect } from 'vitest';
import { EditorState, TextSelection } from 'prosemirror-state';
import { ReplaceAroundStep } from 'prosemirror-transform';
import { schema } from '../packages/core/src/schema.ts';
import { listUnitAt, depthRange, moveUnit, layoutAt, moveListItem, stepPlace, childPos, unitEnd } from '../packages/client/src/editor/listmove.ts';

type Par = [string, number, string];
function mkState(pars: Par[]): EditorState {
  const doc = schema.nodes.doc.create(null, pars.map(([layout, depth, text]) =>
    schema.nodes.paragraph.create({ layout, depth }, text ? schema.text(text) : undefined)));
  return EditorState.create({ schema, doc });
}
/** caret `at` characters into paragraph `i` */
function caret(state: EditorState, i: number, at = 1): EditorState {
  let pos = 0;
  state.doc.forEach((_n, offset, idx) => { if (idx === i) pos = offset + 1 + at; });
  return state.apply(state.tr.setSelection(TextSelection.create(state.doc, pos)));
}
const unitOf = (state: EditorState, i: number) => {
  let pos = 0;
  state.doc.forEach((_n, offset, idx) => { if (idx === i) pos = offset + 1; });
  return listUnitAt(state.doc, pos)!;
};
const pars = (state: EditorState): Par[] => {
  const out: Par[] = [];
  state.doc.forEach(n => { out.push([String(n.attrs.layout), Number(n.attrs.depth) || 0, n.textContent]); });
  return out;
};
const texts = (state: EditorState) => pars(state).map(([, d, t]) => '  '.repeat(d) + t);

//   a
//     a1
//       a1x (text nested in a1)
//     a2
//   b
//     b1
//   c
const LIST: Par[] = [
  ['Itemize', 0, 'a'], ['Itemize', 1, 'a1'], ['Standard', 2, 'a1x'], ['Itemize', 1, 'a2'],
  ['Itemize', 0, 'b'], ['Itemize', 1, 'b1'], ['Itemize', 0, 'c'],
];

describe('list units', () => {
  it('an item takes its deeper followers along, up to the next item of its depth', () => {
    const s = mkState(LIST);
    expect([unitOf(s, 0).from, unitOf(s, 0).to]).toEqual([0, 4]);
    expect([unitOf(s, 1).from, unitOf(s, 1).to]).toEqual([1, 3]);
    expect([unitOf(s, 3).from, unitOf(s, 3).to]).toEqual([3, 4]);
    expect([unitOf(s, 6).from, unitOf(s, 6).to]).toEqual([6, 7]);
  });
  it('a heading ends the sub-items; plain paragraphs are no units', () => {
    const s = mkState([['Itemize', 0, 'a'], ['Section', 1, 'h'], ['Standard', 0, 'p']]);
    expect(unitEnd(s.doc, 0)).toBe(1);
    expect(listUnitAt(s.doc, childPos({ parent: s.doc, start: 0 }, 2) + 1)).toBeNull();
  });
});

describe('drop depths', () => {
  const s = mkState(LIST);
  const c = unitOf(s, 6);
  it('between an item and its first sub-item: only as that sub-item\'s sibling (never stealing it)', () => {
    expect(depthRange(c, 1)).toEqual([1, 1]);
  });
  it('after a nested item before a top-level one: any depth from the top to one under it', () => {
    expect(depthRange(c, 4)).toEqual([0, 2]);
  });
  it('after a nested plain paragraph: no deeper than it (it is no environment)', () => {
    expect(depthRange(c, 3)).toEqual([1, 2]);
  });
  it('at the very top: depth 0 only', () => {
    expect(depthRange(c, 0)).toEqual([0, 0]);
  });
  it('back at its own place the range is that of the gap without it', () => {
    const b = unitOf(s, 4);
    expect(depthRange(b, 4)).toEqual([0, 2]);
    expect(depthRange(b, 6)).toEqual([0, 2]);
  });
});

describe('moving', () => {
  it('moves an item with its sub-items to another place, the depths shifted together', () => {
    const s = mkState(LIST);
    const b = unitOf(s, 4);
    const tr = moveUnit(s, b, { gap: 0, depth: 0 })!;
    expect(texts(s.apply(tr))).toEqual(['b', '  b1', 'a', '  a1', '    a1x', '  a2', 'c']);
  });
  it('dropped deeper: the sub-items go one deeper with it', () => {
    const s = mkState(LIST);
    const b = unitOf(s, 4);
    const tr = moveUnit(s, b, { gap: 7, depth: 1 });
    // after c, one deeper: under c
    expect(texts(s.apply(tr!))).toEqual(['a', '  a1', '    a1x', '  a2', 'c', '  b', '    b1']);
  });
  it('moving down past later items lands right (positions after the deletion)', () => {
    const s = mkState(LIST);
    const a = unitOf(s, 0);
    expect(texts(s.apply(moveUnit(s, a, { gap: 6, depth: 0 })!))).toEqual(['b', '  b1', 'a', '  a1', '    a1x', '  a2', 'c']);
  });
  it('the caret moves along with the item', () => {
    let s = caret(mkState(LIST), 5, 1);   // b|1
    s = s.apply(moveUnit(s, unitOf(s, 4), { gap: 0, depth: 0 })!);
    const $c = s.selection.$from;
    expect($c.parent.textContent).toBe('b1');
    expect($c.parentOffset).toBe(1);
  });
  it('back at its own place with another depth: the depths change, nothing is deleted', () => {
    const s = mkState(LIST);
    const b = unitOf(s, 4);
    const tr = moveUnit(s, b, { gap: 4, depth: 1 })!;
    expect(tr.steps.every(st => st instanceof ReplaceAroundStep)).toBe(true);
    expect(texts(s.apply(tr))).toEqual(['a', '  a1', '    a1x', '  a2', '  b', '    b1', 'c']);
    expect(moveUnit(s, b, { gap: 6, depth: 0 })).toBeNull();
  });
  it('one undoable transaction: the document is the same length', () => {
    const s = mkState(LIST);
    const tr = moveUnit(s, unitOf(s, 6), { gap: 0, depth: 0 })!;
    expect(tr.doc.content.size).toBe(s.doc.content.size);
  });
});

describe('list types', () => {
  it('a bullet dropped among numbered items is numbered (and back)', () => {
    const s = mkState([['Enumerate', 0, 'one'], ['Enumerate', 0, 'two'], ['Standard', 0, 'gap'], ['Itemize', 0, 'dot']]);
    const u = unitOf(s, 3);
    expect(layoutAt(u, { gap: 1, depth: 0 })).toBe('Enumerate');
    const s2 = s.apply(moveUnit(s, u, { gap: 1, depth: 0 }, layoutAt(u, { gap: 1, depth: 0 }))!);
    expect(pars(s2)[1]).toEqual(['Enumerate', 0, 'dot']);
  });
  it('nested under an item, it follows the items at its new depth only', () => {
    const s = mkState([['Enumerate', 0, 'one'], ['Itemize', 1, 'sub'], ['Itemize', 0, 'x']]);
    const u = unitOf(s, 2);
    expect(layoutAt(u, { gap: 2, depth: 1 })).toBeNull();   // among bullets: stays a bullet
    expect(layoutAt(u, { gap: 2, depth: 0 })).toBeNull();   // back at its own place: it never changes its type there
    expect(layoutAt(u, { gap: 1, depth: 1 })).toBeNull();   // a sibling of 'sub'
  });
  it('descriptions keep their layout', () => {
    const s = mkState([['Enumerate', 0, 'one'], ['Description', 0, 'term def']]);
    expect(layoutAt(unitOf(s, 1), { gap: 0, depth: 0 })).toBeNull();
  });
});

describe('Alt+↑ / Alt+↓', () => {
  const run = (s: EditorState, dir: -1 | 1) => { let out = s; const ok = moveListItem(dir)(s, tr => { out = s.apply(tr); }); return { ok, s: out }; };
  it('swaps with the previous sibling, sub-items and all', () => {
    const r = run(caret(mkState(LIST), 4), -1);
    expect(r.ok).toBe(true);
    expect(texts(r.s)).toEqual(['b', '  b1', 'a', '  a1', '    a1x', '  a2', 'c']);
    expect(r.s.selection.$from.parent.textContent).toBe('b');
  });
  it('swaps with the next sibling', () => {
    const r = run(caret(mkState(LIST), 0), 1);
    expect(texts(r.s)).toEqual(['b', '  b1', 'a', '  a1', '    a1x', '  a2', 'c']);
  });
  it('a first sub-item goes up above its item, keeping its depth when it may (the end of the item before)', () => {
    const r = run(caret(mkState(LIST), 5), -1);
    expect(texts(r.s)).toEqual(['a', '  a1', '    a1x', '  a2', '  b1', 'b', 'c']);
  });
  it('a last sub-item goes down to be the first sub-item of the next item', () => {
    const s = mkState([['Itemize', 0, 'a'], ['Itemize', 1, 'a1'], ['Itemize', 0, 'b'], ['Itemize', 1, 'b1']]);
    const r = run(caret(s, 1), 1);
    expect(texts(r.s)).toEqual(['a', 'b', '  a1', '  b1']);
  });
  it('at the ends, and outside lists: not handled (the paragraph move takes over)', () => {
    expect(run(caret(mkState(LIST), 0), -1).ok).toBe(false);
    expect(run(caret(mkState(LIST), 6), 1).ok).toBe(false);
    expect(run(caret(mkState([['Standard', 0, 'p'], ['Standard', 0, 'q']]), 1), -1).ok).toBe(false);
  });
  it('a step lands where the structure allows', () => {
    const s = mkState(LIST);
    expect(stepPlace(unitOf(s, 3), -1)).toEqual({ gap: 1, depth: 1 });
    expect(stepPlace(unitOf(s, 3), 1)).toEqual({ gap: 5, depth: 1 });
  });
});
