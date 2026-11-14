/**
 * Find and replace on slides (packages/client/src/deliverable/slidefind.ts): matches on the slides
 * and in their speaker notes, not in formulas, styles or deleted words; a replacement as `inner`
 * operations that keep the rest of the source, and as tracked changes while suggesting.
 */
import { describe, it, expect } from 'vitest';
import { findInDeck, replaceOps, decodeMap } from '../packages/client/src/deliverable/slidefind.ts';
import { findRegExp, matchesIn } from '../packages/client/src/deliverable/findre.ts';
import { applySplices, opSplices, parseSource, type HtmlOp } from '../packages/core/src/html/source.ts';
import { reviewOps } from '../packages/core/src/html/review.ts';

const deck = `<!doctype html><html><head><meta name="overlyx" content="deck"><style>.slide { color: red; } /* Apple */</style></head><body>
<section class="slide">
  <h1>Apples &amp; pears</h1>
  <p>An apple a day, <b>apple</b> pie and pineapple. \\(apple^2\\)</p>
  <aside class="notes">Say apple slowly.</aside>
</section>

<section class="slide">
  <p>No fruit here <del data-ol-by="x">apple</del></p>
  <script>const apple = 1;</script>
</section>
</body></html>`;
const apply = (text: string, ops: HtmlOp[], stamp: string | null = null) => {
  const src = parseSource(text);
  return applySplices(text, reviewOps(src, ops, stamp).flatMap(op => opSplices(src, op)));
};

describe('find on slides', () => {
  it('finds words on the slides and in the notes, not in formulas, scripts, styles or deleted words', () => {
    const m = findInDeck(deck, { query: 'apple', matchCase: false, words: false });
    expect(m.map(x => `${x.slide}${x.notes ? 'n' : ''}:${x.text}`)).toEqual(['0:Apple', '0:apple', '0:apple', '0:apple', '0n:apple']);
    expect(m.every(x => deck.slice(x.from, x.to).toLowerCase() === 'apple')).toBe(true);
    // (the k-th match of an element's own text: the canvas marks the same one)
    expect(m.map(x => x.nth)).toEqual([0, 0, 0, 1, 0]);
  });
  it('match case and whole words', () => {
    expect(findInDeck(deck, { query: 'apple', matchCase: true, words: false }).length).toBe(4);
    expect(findInDeck(deck, { query: 'apple', matchCase: false, words: true }).length).toBe(3);
    expect(findInDeck(deck, { query: 'apples & pears', matchCase: false, words: false })[0].text).toBe('Apples & pears');
    expect(findInDeck(deck, { query: '  ', matchCase: false, words: false })).toEqual([]);
  });
  it('maps entities back to the source', () => {
    expect(decodeMap('a &amp; b', 'a & b')).toEqual([0, 1, 2, 7, 8, 9]);
    expect(decodeMap('x &unknownthing; y', 'x ? y')).toBeNull();
  });
  it('skips formulas in the text', () => {
    const re = findRegExp({ query: 'x', matchCase: false, words: false })!;
    expect(matchesIn('x \\(x+1\\) and $x$ x', re)).toEqual([[0, 1], [18, 19]]);
  });
});

describe('replace on slides', () => {
  const all = findInDeck(deck, { query: 'apple', matchCase: false, words: true });
  it('replaces all at once, one operation for an element and what is inside it', () => {
    const ops = replaceOps(deck, all, 'pear & <fig>');
    expect(ops.length).toBe(2);
    const out = apply(deck, ops);
    expect(out).toContain('<p>An pear &amp; &lt;fig&gt; a day, <b>pear &amp; &lt;fig&gt;</b> pie and pineapple. \\(apple^2\\)</p>');
    expect(out).toContain('<aside class="notes">Say pear &amp; &lt;fig&gt; slowly.</aside>');
    expect(out).toContain('<del data-ol-by="x">apple</del>');
    expect(out).toContain('const apple = 1;');
  });
  it('replaces one', () => {
    const out = apply(deck, replaceOps(deck, [all[2]], 'Pear'));
    expect(out).toContain('<aside class="notes">Say Pear slowly.</aside>');
    expect(out).toContain('An apple a day');
  });
  it('while suggesting: the words are a tracked change', () => {
    const out = apply(deck, replaceOps(deck, [all[0]], 'pear'), 'Ada|2026-11-14T10:00:00Z');
    expect(out).toMatch(/<del data-ol-by="[^"]*Ada[^"]*"[^>]*>apple<\/del>/);
    expect(out).toMatch(/<ins data-ol-by="[^"]*Ada[^"]*"[^>]*>pear<\/ins>/);
  });
});
