/**
 * Several slides at once (packages/client/src/deliverable/slideops.ts): what a click in the slide
 * list selects, and the selection moved, duplicated, deleted and skipped as one change of the deck's
 * text — with the master's follow-ups (linked objects, slide numbers) still right.
 */
import { describe, it, expect } from 'vitest';
import { pickSlide, clampSel, moveSlidesOps, stepSlidesOps, removeSlidesOps, duplicateSlidesOps, skipSlidesOps } from '../packages/client/src/deliverable/slideops.ts';
import { followUps } from '../packages/client/src/deliverable/deckmaster.ts';
import { applySplices, opSplices, parseSource, type HtmlOp } from '../packages/core/src/html/source.ts';
import { reviewOps } from '../packages/core/src/html/review.ts';
import { slideElements } from '../packages/core/src/html/deliverable.ts';

const deck = (body: string) => `<!doctype html><html><head><meta name="overlyx" content="deck"><style>.slide{width:1280px;height:720px}</style></head><body>\n${body}\n\n<script src="deck.js"></script>\n</body></html>`;
const num = (n: number) => `<p class="footer" style="position: absolute; left: 1160px; top: 668px; width: 80px">${n}</p>`;
const slide = (t: string, n: number) => `<section class="slide">\n  <h2>${t}</h2>\n  ${num(n)}\n</section>`;
const five = deck(['A', 'B', 'C', 'D', 'E'].map((t, i) => slide(t, i + 1)).join('\n\n'));
/** the text after `ops`, with what the editor adds (deckmaster followUps), optionally as suggestions */
function edit(text: string, ops: HtmlOp[], stamp: string | null = null): string {
  const src = parseSource(text);
  const sp = reviewOps(src, ops, stamp).flatMap(op => opSplices(src, op));
  const after = applySplices(text, sp);
  return applySplices(after, followUps(text, after).splices);
}
const titles = (text: string) => { const { doc, text: t } = parseSource(text); return slideElements(doc).map(s => /<h2>(.*?)<\/h2>/.exec(t.slice(s.sourceCodeLocation!.startOffset, s.sourceCodeLocation!.endOffset))?.[1]).join(''); };
const numbers = (text: string) => [...text.matchAll(/class="footer"[^>]*>(\d+)</g)].map(m => m[1]).join('');

describe('pickSlide', () => {
  const one = { sel: [2], anchor: 2, current: 2 };
  it('a plain click selects that slide alone', () => expect(pickSlide({ sel: [1, 2, 3], anchor: 1, current: 3 }, 0, 'one', 5)).toEqual({ sel: [0], anchor: 0, current: 0 }));
  it('Shift+click selects from the anchor to the slide, either way', () => {
    expect(pickSlide(one, 4, 'range', 5)).toEqual({ sel: [2, 3, 4], anchor: 2, current: 4 });
    expect(pickSlide(one, 0, 'range', 5)).toEqual({ sel: [0, 1, 2], anchor: 2, current: 0 });
  });
  it('Ctrl+click adds a slide, and takes one out again — never the last one', () => {
    const two = pickSlide(one, 4, 'toggle', 5);
    expect(two).toEqual({ sel: [2, 4], anchor: 4, current: 4 });
    expect(pickSlide(two, 4, 'toggle', 5)).toEqual({ sel: [2], anchor: 2, current: 2 });
    expect(pickSlide(one, 2, 'toggle', 5)).toEqual(one);
  });
  it('clampSel keeps the slide shown selected', () => {
    expect(clampSel([1, 7, 3], 3, 5)).toEqual([1, 3]);
    expect(clampSel([1, 2], 4, 5)).toEqual([4]);
  });
});

describe('several slides moved', () => {
  it('together to another place, in their order, the slide numbers following', () => {
    const r = moveSlidesOps(five, [1, 3], 5)!;
    const out = edit(five, r.ops);
    expect(titles(out)).toBe('ACEBD');
    expect(r.sel).toEqual([3, 4]);
    expect(numbers(out)).toBe('12345');
    // (what is not a slide stays where it was)
    expect(out.indexOf('<script')).toBeGreaterThan(out.lastIndexOf('</section>'));
  });
  it('to the front; a drop where they are changes nothing', () => {
    const r = moveSlidesOps(five, [2, 4], 0)!;
    expect(titles(edit(five, r.ops))).toBe('CEABD');
    expect(r.sel).toEqual([0, 1]);
    expect(moveSlidesOps(five, [1, 2], 1)!.ops).toEqual([]);
    expect(moveSlidesOps(five, [1, 2], 3)!.ops).toEqual([]);
  });
  it('a place up or down: a block steps over its neighbour, slides apart come together', () => {
    expect(titles(edit(five, stepSlidesOps(five, [1, 2], -1)!.ops))).toBe('BCADE');
    expect(titles(edit(five, stepSlidesOps(five, [1, 2], 1)!.ops))).toBe('ADBCE');
    expect(titles(edit(five, stepSlidesOps(five, [1, 3], 1)!.ops))).toBe('ACBDE');
    expect(stepSlidesOps(five, [0, 1], -1)).toBeNull();
    expect(stepSlidesOps(five, [3, 4], 1)).toBeNull();
  });
  it('while suggesting: the moved slides are marked', () => {
    const out = edit(five, moveSlidesOps(five, [0, 1], 5)!.ops, 'Ada|2026-11-14T10:00:00Z');
    expect(titles(out)).toBe('CDEAB');
    expect(out).toContain('data-ol-chg');
  });
});

describe('several slides duplicated, deleted, skipped', () => {
  it('duplicates come together after the last selected slide', () => {
    const r = duplicateSlidesOps(five, [0, 2])!;
    const out = edit(five, r.ops);
    expect(titles(out)).toBe('ABCACDE');
    expect(r.sel).toEqual([3, 4]);
    expect(numbers(out)).toBe('1234567');
    // (the source stays as it was written: a blank line between slides, the copies indented as theirs)
    expect(out).toContain('</section>\n\n<section class="slide">\n  <h2>A</h2>');
  });
  it('deletes them at once, but never every slide', () => {
    const out = edit(five, removeSlidesOps(five, [1, 2, 4])!);
    expect(titles(out)).toBe('AD');
    expect(numbers(out)).toBe('12');
    expect(removeSlidesOps(five, [0, 1, 2, 3, 4])).toBeNull();
  });
  it('skips them all, and brings them all back', () => {
    const r = skipSlidesOps(five, [1, 2])!;
    expect(r.on).toBe(true);
    const out = edit(five, r.ops);
    expect(out.match(/data-ol-skip/g)?.length).toBe(2);
    const mixed = skipSlidesOps(out, [0, 1])!;
    expect(mixed.on).toBe(true);
    expect(mixed.ops.length).toBe(1);
    const back = skipSlidesOps(out, [1, 2])!;
    expect(back.on).toBe(false);
    expect(edit(out, back.ops)).not.toContain('data-ol-skip');
  });
});
