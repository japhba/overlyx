// @vitest-environment happy-dom
/** Links to a place (client/src/editor/permalink.ts): the quote made for a range finds that range again, also after edits. */
import { describe, it, expect } from 'vitest';
import { schema } from '../packages/core/src/schema.ts';
import { docText, quotePlace, findPlace, placeQuery, parsePlace } from '../packages/client/src/editor/permalink.ts';

const par = (...content: (string | ReturnType<typeof schema.node>)[]) => schema.node('paragraph', null, content.map(c => typeof c === 'string' ? schema.text(c) : c));
const doc = (...ps: ReturnType<typeof par>[]) => schema.node('doc', null, ps);
/** the document range of the n-th paragraph's content */
const parRange = (d: ReturnType<typeof doc>, n: number) => { let pos = 0; for (let k = 0; k < n; k++) pos += d.child(k).nodeSize; return { from: pos + 1, to: pos + 1 + d.child(n).content.size }; };
const roundTrip = (d: ReturnType<typeof doc>, from: number, to: number) => {
  const p = quotePlace(docText(d), from, to)!;
  const back = parsePlace(new URLSearchParams(placeQuery(p)))!;
  return { p, found: findPlace(docText(d), back) };
};

describe('links to a place in a document', () => {
  const long = 'The measurements were taken over three consecutive winters at the northern station, and every series was calibrated against the reference thermometer before it was used.';
  const d = doc(par('Introduction'), par(long), par('We repeat it here.'), par('We repeat it here.'), par('Results follow.'));

  it('quotes a short paragraph whole and finds it', () => {
    const r = parRange(d, 4);
    const { p, found } = roundTrip(d, r.from, r.to);
    expect(p).toEqual({ text: 'Results follow.' });
    expect(found).toEqual({ ...r, exact: true });
  });

  it('quotes a long paragraph by its first and last words', () => {
    const r = parRange(d, 1);
    const { p, found } = roundTrip(d, r.from, r.to);
    expect(p.text!.length).toBeLessThan(40);
    expect(p.end).toBeTruthy();
    expect(long.startsWith(p.text!) && long.endsWith(p.end!)).toBe(true);
    expect(found).toEqual({ ...r, exact: true });
  });

  it('tells a repeated paragraph from its twin by what comes before it', () => {
    const r = parRange(d, 3);
    const { p, found } = roundTrip(d, r.from, r.to);
    expect(p.before).toBeTruthy();
    expect(found).toEqual({ ...r, exact: true });
  });

  it('finds a selection inside a paragraph', () => {
    const r = parRange(d, 1);
    const from = r.from + long.indexOf('three'), to = from + 'three consecutive winters'.length;
    expect(roundTrip(d, from, to).found).toEqual({ from, to, exact: true });
  });

  it('quotes a formula as LaTeX and finds it as one object', () => {
    const f = schema.node('math_inline', { latex: 'E=mc^2' });
    const d2 = doc(par('Energy is '), par('so ', f, ' holds.'));
    const pos = parRange(d2, 1).from + 3;
    const { p, found } = roundTrip(d2, pos, pos + f.nodeSize);
    expect(p.text).toBe('$E=mc^2$');
    expect(found).toEqual({ from: pos, to: pos + f.nodeSize, exact: true });
  });

  it('finds the place again after others edited around it, and its beginning when it was edited itself', () => {
    const r = parRange(d, 1);
    const p = quotePlace(docText(d), r.from, r.to)!;
    const moved = doc(par('A new first paragraph that pushes everything down.'), ...Array.from({ length: d.childCount }, (_, k) => d.child(k)));
    expect(findPlace(docText(moved), p)).toEqual({ ...parRange(moved, 2), exact: true });
    const edited = doc(par('Introduction'), par(long.replace('northern', 'southern').replace(/ before it was used\.$/, '.')));
    const hit = findPlace(docText(edited), p)!;
    expect(hit.from).toBe(parRange(edited, 1).from);
    expect(hit.exact).toBe(false);
  });

  it('reads lines, pages, slides and objects', () => {
    expect(parsePlace(new URLSearchParams('line=20-12'))).toEqual({ line: [12, 20] });
    expect(placeQuery({ line: [7, 7] })).toBe('line=7');
    expect(placeQuery({ goto: 'sec:a', view: 'wysiwym,pdf' })).toBe('goto=sec%3Aa&view=wysiwym,pdf');
    expect(parsePlace(new URLSearchParams(placeQuery({ slide: 3, obj: [2, 1] })))).toEqual({ slide: 3, obj: [2, 1] });
    expect(parsePlace(new URLSearchParams('page=4'))).toEqual({ page: 4 });
    expect(parsePlace(new URLSearchParams('goto=sec:intro'))).toBeNull();
    expect(placeQuery({ text: 'two words' })).toBe('text=two%20words');
  });
});
