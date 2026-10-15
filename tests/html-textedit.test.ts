import { describe, expect, it } from 'vitest';
import { balancedInlineHtml, mergedTextSplices, spliceText, textChanges } from '../packages/core/src/html/textedit.ts';
import { applyOp, elementAt, innerRange, parseSource } from '../packages/core/src/html/source.ts';
import { reviewOps } from '../packages/core/src/html/review.ts';
import { applyTo, rebasedSplices } from '../packages/client/src/deliverable/sourceops.ts';

const merge = (base: string, ours: string, theirs: string) => {
  const edits = mergedTextSplices(base, ours, theirs);
  return edits === null ? null : spliceText(theirs, edits);
};
const wrap = (html: string) => `<html><head><title>Brief</title></head><body><section class="slide"><p>${html}</p><p>Other object</p></section></body></html>`;
const path = [1, 0, 0];

describe('incremental canvas typing', () => {
  it('keeps a saved remote append when the active stale box continues typing', () => {
    expect(merge('Baseline A', 'Baseline A LAST', 'Baseline A SECOND')).toBe('Baseline A SECOND LAST');
  });
  it('merges separate word replacements in one box', () => {
    expect(merge('Heat is 35 C; canopy is 18%.', 'Heat is 37 C; canopy is 18%.', 'Heat is 35 C; canopy is 20%.')).toBe('Heat is 37 C; canopy is 20%.');
  });
  it('keeps insertions at both boundaries of a deleted range', () => {
    expect(merge('aXYZb', 'ab', 'aLEFTXYZRIGHTb')).toBe('aLEFTRIGHTb');
  });
  it('rejects overlapping replacements or an insertion inside deleted content', () => {
    expect(merge('Temperature 35 C', 'Temperature 37 C', 'Temperature 39 C')).toBeNull();
    expect(merge('aXYZb', 'ab', 'aXREMOTEYZb')).toBeNull();
  });
  it('does not duplicate a change already present', () => {
    expect(merge('hello', 'hello world', 'hello world')).toBe('hello world');
  });
  it('keeps Unicode code points and HTML entities intact', () => {
    const before = 'A 😀 &amp; Ω', after = 'A 🖊️ &amp; Ω!';
    expect(spliceText(before, textChanges(before, after))).toBe(after);
    for (const change of textChanges(before, after)) expect(before.slice(change.from, change.to)).not.toMatch(/^[\uDC00-\uDFFF]|[\uD800-\uDBFF]$/);
  });
  it('leaves markup atomic, including greater-than signs in quoted attributes', () => {
    const before = '<a href="x>y">Old</a> &amp; <b>second</b>';
    const after = '<a href="x>y">New</a> &amp; <b>second</b>';
    expect(merge(before, after, before.replace('second', 'remote'))).toBe('<a href="x>y">New</a> &amp; <b>remote</b>');
    expect(balancedInlineHtml('<b>one <i>two</b></i>')).toBe(false);
  });
  it('bounds large paste diff work and conservatively rejects overlap', () => {
    const before = 'a'.repeat(3000), ours = 'b'.repeat(3000);
    expect(textChanges(before, ours)).toHaveLength(1);
    expect(merge(before, ours, before.slice(0, 1000) + 'remote' + before.slice(1000))).toBeNull();
  });
  it('reconstructs strings over randomized edits without corrupting source', () => {
    let seed = 7391;
    const random = () => { seed = (seed * 1664525 + 1013904223) >>> 0; return seed; };
    const letters = ['a', 'b', ' ', '😀', '&amp;', '<b>', '</b>'];
    for (let round = 0; round < 300; round++) {
      const before = Array.from({ length: 10 + random() % 30 }, () => letters[random() % letters.length]).join('');
      const start = random() % (before.length + 1), end = start + random() % (before.length - start + 1);
      const after = before.slice(0, start) + letters[random() % letters.length] + before.slice(end);
      expect(spliceText(before, textChanges(before, after))).toBe(after);
    }
  });
  it('merges normalized browser HTML without deleting a remote insertion', () => {
    const current = wrap('Text &amp; <b class=\'bold\'>remote</b>');
    const out = applyOp(current, { t: 'inner', path, before: 'Text &amp; ', html: 'Text &amp; local' });
    expect(out).toContain('remote'); expect(out).toContain('local');
    expect(out).toContain('<p>Other object</p>');
  });
  it('turns a paragraph into a block container without replacing concurrent words or attributes', () => {
    const current = wrap('Baseline REMOTE').replace('<p>', '<p class="body" style="left:20px">');
    const out = applyOp(current, { t: 'inner', path, before: 'Baseline', html: 'Baseline<ul><li>Item</li></ul>', as: 'div' });
    expect(out).toContain('<div class="body" style="left:20px">Baseline REMOTE<ul><li>Item</li></ul></div>');
  });
  it('rebases typing after multiple other objects change and siblings are inserted', () => {
    const base = wrap('Baseline');
    const cur = base.replace('<title>Brief', '<title>Retitled').replace('<p>Baseline', '<h2>New sibling</h2><p>Baseline REMOTE').replace('Other object', 'Other object changed');
    const splices = rebasedSplices(base, cur, [{ t: 'inner', path, before: 'Baseline', html: 'Baseline LOCAL' }]);
    expect(splices).not.toBeNull();
    const out = applyTo(cur, splices!);
    expect(out).toContain('<p>Baseline REMOTE LOCAL</p>');
    expect(out).toContain('<h2>New sibling</h2>'); expect(out).toContain('Other object changed');
  });
  it('keeps simultaneous line-height styling when a paragraph becomes a list container', () => {
    const source = wrap('Baseline').replace('<p>', '<p style="left:20px">');
    const splices = rebasedSplices(source, source, [
      { t: 'inner', path, before: 'Baseline', html: 'Baseline<ul><li>Item</li></ul>', as: 'div' },
      { t: 'style', path, set: { 'line-height': '1.6' } },
    ]);
    expect(splices).not.toBeNull();
    expect(applyTo(source, splices!)).toContain('<div style="left: 20px; line-height: 1.6">Baseline<ul><li>Item</li></ul></div>');
  });
  it('rejects a deleted target rather than editing its new neighbour', () => {
    const base = wrap('Baseline');
    const cur = base.replace('<p>Baseline</p>', '');
    expect(rebasedSplices(base, cur, [{ t: 'inner', path, before: 'Baseline', html: 'Baseline LOCAL' }])).toBeNull();
  });
  it('tracks only local edits while suggesting; remote words are not deletions', () => {
    const source = wrap('Baseline REMOTE');
    const ops = reviewOps(parseSource(source), [{ t: 'inner', path, before: 'Baseline', html: 'Baseline LOCAL' }], 'Alice|2026-10-12');
    const out = applyTo(source, rebasedSplices(source, source, ops)!);
    expect(out).toContain('REMOTE'); expect(out).toContain('LOCAL');
    expect(out).not.toMatch(/<del[^>]*>[^<]*REMOTE/);
    const el = elementAt(parseSource(out).doc, path)!;
    expect(innerRange(el)).not.toBeNull();
  });
});
