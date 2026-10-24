/**
 * The master of an HTML deck (packages/client/src/deliverable/deckmaster.ts): copies of an object on
 * every slide kept identical, slide-number fields and typed slide numbers kept right as slides come
 * and go, an edit and its follow-ups as one change of the text.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { composeSplices, followUps, numberObjects, withoutFields, putOnEverySlide, otherCopies, slideNumberOps, lookAlikeOps, similarTexts, withAttr, twinsOf } from '../packages/client/src/deliverable/deckmaster.ts';
import { applyOp, applySplices, opSplices, parseSource, type HtmlOp, type Splice } from '../packages/core/src/html/source.ts';
import { slideElements } from '../packages/core/src/html/deliverable.ts';
import { newSlideHtml } from '../packages/client/src/deliverable/sourceops.ts';

const deck = (body: string) => `<!doctype html><html><head><meta name="overlyx" content="deck"><style>.slide{width:1280px;height:720px}</style></head><body>\n${body}\n</body></html>`;
const slide = (...objs: string[]) => `<section class="slide">\n  ${objs.join('\n  ')}\n</section>`;
const bar = (color = '#23373b') => `<div data-ol-master="m1" style="position: absolute; left: 0px; top: 0px; width: 1280px; height: 84px; background: ${color}"></div>`;
const num = (n: number) => `<p class="footer" style="position: absolute; left: 1160px; top: 668px; width: 80px">${n}</p>`;
const h2 = (t: string) => `<h2 style="position: absolute; left: 40px; top: 21px">${t}</h2>`;
/** the text after `op`, with what the editor adds to it */
function edit(text: string, op: HtmlOp): string {
  const sp = opSplices(parseSource(text), op);
  const after = applySplices(text, sp);
  const full = applySplices(after, followUps(text, after).splices);
  // (told from the edit's splices: the same)
  expect(applySplices(text, composeSplices(text, sp, followUps(text, after, sp).splices))).toBe(full);
  return full;
}
const slidesOf = (text: string) => { const { doc, text: t } = parseSource(text); return slideElements(doc).map(s => t.slice(s.sourceCodeLocation!.startOffset, s.sourceCodeLocation!.endOffset)); };

describe('composeSplices', () => {
  it('is the same as applying one list of splices after the other, wherever they meet', () => {
    let seed = 7;
    const rnd = (n: number) => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed % n; };
    const word = () => 'xyzw'.slice(0, rnd(4));
    const splicesOf = (t: string): Splice[] => {
      const out: Splice[] = [];
      let p = 0;
      while (p <= t.length && out.length < 4) {
        const from = p + rnd(5);
        if (from > t.length) break;
        const to = Math.min(t.length, from + rnd(3));
        out.push({ from, to, insert: word() });
        p = to + 1;
      }
      return out;
    };
    for (let i = 0; i < 3000; i++) {
      const before = 'abcdefghijklmnop'.slice(0, 4 + rnd(12));
      const first = splicesOf(before);
      const mid = applySplices(before, first);
      const second = splicesOf(mid);
      const want = applySplices(mid, second);
      const got = applySplices(before, composeSplices(before, first, second));
      if (got !== want) throw new Error(JSON.stringify({ before, first, second, want, got }));
    }
  });
});

describe('objects on every slide', () => {
  const text = deck([slide(bar(), h2('One')), slide(bar(), h2('Two')), slide(h2('Three')), slide(bar(), h2('Four'))].join('\n'));
  it('a copy changed on one slide changes on every slide that has it (not on one without)', () => {
    const out = edit(text, { t: 'style', path: [1, 1, 0], set: { background: '#a30000' } });
    const ss = slidesOf(out);
    expect(ss[0]).toContain('background: #a30000');
    expect(ss[1]).toContain('background: #a30000');
    expect(ss[2]).not.toContain('data-ol-master');
    expect(ss[3]).toContain('background: #a30000');
    expect(out.match(/#23373b/g)).toBeNull();
  });
  it("and in the deck's saved layouts", () => {
    const withLayout = text.replace('</body>', `<template data-ol-layout="Plain">${slide(bar(), '<h2 data-ol-ph="title"></h2>')}</template>\n</body>`);
    const out = edit(withLayout, { t: 'style', path: [1, 0, 0], set: { height: '60px' } });
    expect(out.match(/height: 60px/g)).toHaveLength(4);
  });
  it('one removed from a slide: only from that slide', () => {
    const out = edit(text, { t: 'remove', paths: [[1, 0, 0]] });
    expect(out.match(/data-ol-master/g)).toHaveLength(2);
  });
  it('duplicated on its slide: the duplicate is the slide\'s own (it does not move the others)', () => {
    const dup = edit(text, { t: 'duplicate', paths: [[1, 1, 0]] });
    expect(slidesOf(dup)[1].match(/data-ol-master/g)).toHaveLength(1);
    const moved = edit(dup, { t: 'style', path: [1, 1, 1], set: { top: '300px' } });
    expect(moved.match(/top: 300px/g)).toHaveLength(1);
  });
  it('a slide added from a layout saved before the master changed: made like the rest', () => {
    const old = bar('#000000');
    const out = edit(text, { t: 'insert', parent: [1], index: 4, html: slide(old, h2('Five')) });
    expect(out).not.toContain('#000000');
    expect(slidesOf(out)).toHaveLength(5);
  });
  it('an edit of a slide\'s own text changes nothing else', () => {
    const op: HtmlOp = { t: 'inner', path: [1, 1, 1], html: 'Zwei' };
    expect(edit(text, op)).toBe(applyOp(text, op));
  });
  it('the copies are compared without what their fields say', () => {
    expect(withoutFields('<p data-ol-master="n"><span data-ol-field="slide-number">3</span> / <span data-ol-field="slide-count">9</span></p>'))
      .toBe('<p data-ol-master="n"><span data-ol-field="slide-number"></span> / <span data-ol-field="slide-count"></span></p>');
  });
});

describe('slide numbers', () => {
  it('fields: the slide\'s number and the number of slides, as slides are removed and moved', () => {
    const f = '<p data-ol-master="n" style="position: absolute; left: 1100px; top: 670px"><span data-ol-field="slide-number">?</span> / <span data-ol-field="slide-count">?</span></p>';
    const text = deck([slide(h2('A'), f), slide(h2('B'), f), slide(h2('C'), f)].join('\n'));
    const shown = (t: string) => slidesOf(t).map(s => /slide-number">(\d+)</.exec(s)?.[1] + '/' + /slide-count">(\d+)</.exec(s)?.[1]);
    const dup = edit(text, { t: 'duplicate', paths: [[1, 0]] });
    expect(shown(dup)).toEqual(['1/4', '2/4', '3/4', '4/4']);
    const removed = edit(dup, { t: 'remove', paths: [[1, 0]] });
    expect(shown(removed)).toEqual(['1/3', '2/3', '3/3']);
    const moved = edit(removed, { t: 'move', path: [1, 2], parent: [1], index: 0 });
    expect(shown(moved)).toEqual(['1/3', '2/3', '3/3']);
    expect(slidesOf(moved)[0]).toContain('>C<');
  });
  const typed = deck([1, 2, 3, 4].map(n => slide(h2('Slide ' + n), num(n))).join('\n'));
  const numbers = (t: string) => slidesOf(t).map(s => /footer[^>]*>([^<]*)</.exec(s)?.[1]);
  it('typed as text: they follow a slide moved, duplicated, removed', () => {
    const moved = edit(typed, { t: 'move', path: [1, 0], parent: [1], index: 3 });
    expect(numbers(moved)).toEqual(['1', '2', '3', '4']);
    expect(slidesOf(moved)[3]).toContain('Slide 1');
    const dup = edit(typed, { t: 'duplicate', paths: [[1, 1]] });
    expect(numbers(dup)).toEqual(['1', '2', '3', '4', '5']);
    const gone = edit(typed, { t: 'remove', paths: [[1, 0]] });
    expect(numbers(gone)).toEqual(['1', '2', '3']);
  });
  it('"n / total", and a title slide not counted (beamer\'s dark themes)', () => {
    const n = (k: number, of: number) => `<p class="footer" style="position: absolute; left: 1180px; top: 698px">${k} / ${of}</p>`;
    const text = deck([slide('<h1>Title</h1>'), slide(h2('A'), n(1, 3)), slide(h2('B'), n(2, 3)), slide(h2('C'), n(3, 3))].join('\n'));
    const dup = edit(text, { t: 'duplicate', paths: [[1, 2]] });
    expect(slidesOf(dup).map(s => /footer[^>]*>([^<]*)</.exec(s)?.[1])).toEqual([undefined, '1 / 4', '2 / 4', '3 / 4', '4 / 4']);
  });
  it('numbers that were not right before are left alone; a number in a slide\'s text is no slide number', () => {
    const wrong = deck([slide(h2('A'), num(7)), slide(h2('B'), num(3)), slide(h2('C'), num(9))].join('\n'));
    const op: HtmlOp = { t: 'remove', paths: [[1, 0]] };
    expect(edit(wrong, op)).toBe(applyOp(wrong, op));
    const content = deck([slide(h2('A'), num(1), '<p style="position: absolute; left: 96px; top: 300px">42</p>'), slide(h2('B'), num(2)), slide(h2('C'), num(3))].join('\n'));
    const out = edit(content, { t: 'remove', paths: [[1, 1]] });
    expect(out).toContain('>42<');
    expect(numbers(out)).toEqual(['1', '2']);
  });
  it('a new slide takes the number along (newSlideHtml), renumbered', () => {
    expect([...numberObjects(typed)]).toHaveLength(4);
    const html = newSlideHtml(typed, 1)!;
    expect(html).toContain('class="footer"');
    const out = edit(typed, { t: 'insert', parent: [1], index: 2, html });
    expect(numbers(out)).toEqual(['1', '2', '3', '4', '5']);
  });
});

describe("the master's operations", () => {
  const ops = (text: string, list: HtmlOp[]) => { const src = parseSource(text); return applySplices(text, list.flatMap(op => opSplices(src, op))); };
  const plain = '<div style="position: absolute; left: 0px; top: 0px; width: 1280px; height: 84px; background: #23373b"></div>';
  it('Put on every slide: the same object on other slides is linked (none added where it is not)', () => {
    const text = deck([slide(h2('One')), slide(plain, h2('Two')), slide(plain, h2('Three'))].join('\n'));
    const r = putOnEverySlide(text, [1, 1, 0])!;
    expect(r).toMatchObject({ linked: 1, added: 0 });
    const out = ops(text, r.ops);
    expect(out.match(/data-ol-master="m1"/g)).toHaveLength(2);
    expect(slidesOf(out)[0]).not.toContain('data-ol-master');
    expect(otherCopies(out, [1, 1, 0])).toEqual([[1, 2, 0]]);
  });
  it('… also when one of them was changed already (the same element in the same place): they become like the one chosen', () => {
    const red = plain.replace('#23373b', '#a30000');
    const text = deck([slide(h2('One')), slide(red, h2('Two')), slide(plain, h2('Three')), slide(plain, h2('Four'))].join('\n'));
    const out = ops(text, putOnEverySlide(text, [1, 1, 0])!.ops);
    expect(out.match(/#a30000/g)).toHaveLength(3);
    expect(out).not.toContain('#23373b');
    expect(slidesOf(out)[0]).not.toContain('<div');
  });
  it('… a slide number typed in it becomes a field: each slide shows its own', () => {
    const text = deck([1, 2, 3].map(n => slide(h2('S'), num(n))).join('\n'));
    const r = putOnEverySlide(text, [1, 1, 1])!;
    expect(r.linked).toBe(2);
    // (as the editor writes it: the operations, then what the master adds — the fields filled in)
    const src = parseSource(text), sp = r.ops.flatMap(op => opSplices(src, op)), after = applySplices(text, sp);
    const out = applySplices(after, followUps(text, after, sp).splices);
    expect(slidesOf(out).map(s => /slide-number">(\d+)</.exec(s)?.[1])).toEqual(['1', '2', '3']);
    expect(out.match(/data-ol-master="m1"/g)).toHaveLength(3);
  });
  it('Put on every slide: a copy on every other slide, in the same place in its stack, before the notes', () => {
    const logo = '<img src="logo.png" style="position: absolute; left: 1180px; top: 20px; width: 60px">';
    const text = deck([slide(h2('One'), logo, '<aside class="notes">n</aside>'), slide(h2('Two'), '<aside class="notes">m</aside>'), slide(h2('Three'))].join('\n'));
    const r = putOnEverySlide(text, [1, 0, 1])!;
    expect(r).toMatchObject({ linked: 0, added: 2 });
    const ss = slidesOf(ops(text, r.ops));
    for (const s of ss) expect(s).toMatch(/<h2[^]*<img data-ol-master="m1" src="logo.png"/);
    expect(ss[1]).toMatch(/<img[^>]*>\s*<aside class="notes">m/);
  });
  it('the slide number: a field on every slide, unless the slides are numbered already', () => {
    const text = deck([slide(h2('A')), slide(h2('B')), slide(h2('C'))].join('\n'));
    const r = slideNumberOps(text, { w: 1280, h: 720 });
    expect(r.already).toBe(false);
    const out = ops(text, r.ops);
    expect(slidesOf(out).map(s => /slide-number">(\d+)</.exec(s)?.[1])).toEqual(['1', '2', '3']);
    expect(slideNumberOps(out, { w: 1280, h: 720 }).already).toBe(true);
    const typed = deck([1, 2, 3].map(n => slide(h2('S'), num(n))).join('\n'));
    expect(slideNumberOps(typed, { w: 1280, h: 720 })).toEqual({ ops: [], already: true });
  });
  it('Make all similar texts look like this: the same element and class on the other slides take its look, not its place', () => {
    const k = (style: string) => `<p class="kicker" style="${style}">Model</p>`;
    const text = deck([slide(k('position: absolute; left: 96px; top: 100px; color: red; font-size: 20px')), slide(k('position: absolute; left: 600px; top: 300px; color: blue; letter-spacing: 2px'), '<p style="color: green">body</p>')].join('\n'));
    expect(similarTexts(text, [1, 0, 0])).toEqual([[1, 1, 0]]);
    const out = ops(text, lookAlikeOps(text, [1, 0, 0]));
    expect(slidesOf(out)[1]).toContain('<p class="kicker" style="position: absolute; left: 600px; top: 300px; color: red; font-size: 20px">');
    expect(slidesOf(out)[1]).toContain('color: green');
  });
  it('an object with twins on other slides, not linked: how many (the editor says how to link them)', () => {
    const text = deck([slide(plain, h2('One')), slide(plain, h2('Two')), slide(h2('Three'))].join('\n'));
    const sp = (op: HtmlOp) => opSplices(parseSource(text), op);
    expect(twinsOf(text, sp({ t: 'style', path: [1, 0, 0], set: { background: 'red' } }))).toBe(1);
    expect(twinsOf(text, sp({ t: 'style', path: [1, 0, 1], set: { color: 'red' } }))).toBe(0);
    expect(twinsOf(text, sp({ t: 'style', path: [1, 2, 0], set: { color: 'red' } }))).toBe(0);
  });
  it('withAttr sets, replaces and removes an attribute of the first start tag', () => {
    expect(withAttr('<p class="a">x <b data-ol-master="q">y</b></p>', 'data-ol-master', 'm2')).toBe('<p data-ol-master="m2" class="a">x <b data-ol-master="q">y</b></p>');
    expect(withAttr('<p data-ol-master="m2" class="a">x</p>', 'data-ol-master', null)).toBe('<p class="a">x</p>');
    expect(withAttr('<img src="a.png">', 'data-ol-master', 'm1')).toBe('<img data-ol-master="m1" src="a.png">');
  });
});
