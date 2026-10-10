import { describe, it, expect } from 'vitest';
import { parseSource, elementAt, pathOf, applyOp, editStyle, parseStyle, rebasePath, rebaseOp, mapOffset, opSplices } from '../packages/core/src/html/source.ts';
import { deliverableInfo, starterDeck, starterPoster, starterPage, slideElements } from '../packages/core/src/html/deliverable.ts';

const DECK = `<!doctype html>
<html>
<head>
<meta name="overlyx" content="deck">
<title>Talk</title>
<style>.slide { width: 1280px; height: 720px }</style>
</head>
<body>

<section class="slide">
  <h1 style="position: absolute; left: 100px; top: 80px">Hello &amp; welcome</h1>
  <p class="sub" style='color: red'>Sub</p>
</section>

<section class="slide">
  <ul style="position:absolute;left:10px">
    <li>One</li>
    <li>Two</li>
  </ul>
</section>

</body>
</html>
`;

describe('html deliverable source edits', () => {
  it('addresses elements by path from <html>, like the DOM', () => {
    const { doc } = parseSource(DECK);
    expect(elementAt(doc, [0])!.tagName).toBe('head');
    const h1 = elementAt(doc, [1, 0, 0])!;
    expect(h1.tagName).toBe('h1');
    expect(pathOf(h1)).toEqual([1, 0, 0]);
    expect(elementAt(doc, [1, 1, 0, 1])!.tagName).toBe('li');
  });

  it('knows the kind, the title and the slides', () => {
    const info = deliverableInfo(DECK);
    expect(info).toEqual({ kind: 'deck', title: 'Talk', slides: [[1, 0], [1, 1]] });
    expect(deliverableInfo('<p>x</p>').kind).toBe('page');
    expect(deliverableInfo('<div class="slide"></div>').kind).toBe('poster');
  });

  it('edits inline styles: changed properties keep their place, the rest stays verbatim', () => {
    expect(editStyle('position: absolute; left: 100px; top: 80px', { left: '120px', width: '300px' })).toBe('position: absolute; left: 120px; top: 80px; width: 300px');
    expect(editStyle('color: red !important; top: 1px', { color: 'blue', top: null })).toBe('color: blue !important');
    expect(parseStyle('background: url("a;b.png"); font-family: "X; Y", serif')).toEqual([
      { prop: 'background', value: 'url("a;b.png")' }, { prop: 'font-family', value: '"X; Y", serif' },
    ]);
    const out = applyOp(DECK, { t: 'style', path: [1, 0, 0], set: { left: '120px', top: '90px' } });
    expect(out).toContain('<h1 style="position: absolute; left: 120px; top: 90px">Hello &amp; welcome</h1>');
    expect(out.replace('left: 120px; top: 90px', 'left: 100px; top: 80px')).toBe(DECK);
    // single quotes kept; a style added to an element without one
    expect(applyOp(DECK, { t: 'style', path: [1, 0, 1], set: { color: 'blue' } })).toContain(`<p class="sub" style='color: blue'>Sub</p>`);
    expect(applyOp(DECK, { t: 'style', path: [1, 1, 0, 0], set: { color: 'blue' } })).toContain('<li style="color: blue">One</li>');
    // removing the last property removes the attribute
    expect(applyOp(DECK, { t: 'style', path: [1, 0, 1], set: { color: null } })).toContain('<p class="sub">Sub</p>');
  });

  it('replaces content, removes and duplicates elements with their lines', () => {
    expect(applyOp(DECK, { t: 'inner', path: [1, 0, 0], html: 'Bye \\(x^2\\)' })).toContain('top: 80px">Bye \\(x^2\\)</h1>');
    const removed = applyOp(DECK, { t: 'remove', paths: [[1, 0, 1]] });
    expect(removed).toContain('welcome</h1>\n</section>');
    const dup = applyOp(DECK, { t: 'duplicate', paths: [[1, 1, 0, 0]] });
    expect(dup).toContain('    <li>One</li>\n    <li>One</li>\n    <li>Two</li>');
    // an element inside another removed with it: one splice
    expect(opSplices(parseSource(DECK), { t: 'remove', paths: [[1, 1], [1, 1, 0]] })).toHaveLength(1);
  });

  it('inserts lined up with the siblings, and moves', () => {
    const ins = applyOp(DECK, { t: 'insert', parent: [1, 0], index: 1, html: '<div>\n  <p>New</p>\n</div>' });
    expect(ins).toContain('</h1>\n  <div>\n    <p>New</p>\n  </div>\n  <p class="sub"');
    const end = applyOp(DECK, { t: 'insert', parent: [1, 1, 0], index: 99, html: '<li>Three</li>' });
    expect(end).toContain('<li>Two</li>\n    <li>Three</li>\n  </ul>');
    // slide 2 before slide 1
    const moved = applyOp(DECK, { t: 'move', path: [1, 1], parent: [1], index: 0 });
    const { doc } = parseSource(moved);
    expect(slideElements(doc).map(s => elementAt(doc, pathOf(s))!.childNodes.length)).toHaveLength(2);
    expect(moved.indexOf('<li>One</li>')).toBeLessThan(moved.indexOf('Hello'));
    // a li to the end of its list
    const li = applyOp(DECK, { t: 'move', path: [1, 1, 0, 0], parent: [1, 1, 0], index: 1 });
    expect(li).toContain('<li>Two</li>\n    <li>One</li>\n  </ul>');
    // to where it is: nothing
    expect(applyOp(DECK, { t: 'move', path: [1, 1, 0, 0], parent: [1, 1, 0], index: 0 })).toBe(DECK);
  });

  it('rebases a path over an edit made elsewhere, refuses one made to the element', () => {
    const other = DECK.replace('<title>Talk</title>', '<title>Talk</title>\n<link rel="stylesheet" href="x.css">');
    expect(rebasePath(DECK, other, [1, 0, 1])).toEqual([1, 0, 1]);
    const inserted = applyOp(DECK, { t: 'insert', parent: [1], index: 0, html: '<section class="slide"></section>' });
    expect(rebasePath(DECK, inserted, [1, 1, 0, 1])).toEqual([1, 2, 0, 1]);
    expect(rebaseOp(DECK, inserted, { t: 'style', path: [1, 0, 0], set: { left: '0' } })).toEqual({ t: 'style', path: [1, 1, 0], set: { left: '0' } });
    const retyped = DECK.replace('<h1 style', '<h2 style').replace('</h1>', '</h2>');
    expect(rebasePath(DECK, retyped, [1, 0, 0])).toBeNull();
    expect(mapOffset('abcdef', 'abXYdef', 5)).toBe(6);
    expect(mapOffset('abcdef', 'abXYdef', 2)).toBe(2);
    expect(mapOffset('abcdef', 'abXYdef', 3)).toBe(4);
    expect(mapOffset('abcdef', 'aXf', 3)).toBeNull();
  });

  it('the starting points parse as their kind', () => {
    expect(deliverableInfo(starterDeck('A & B'))).toMatchObject({ kind: 'deck', title: 'A & B' });
    expect(deliverableInfo(starterDeck('x')).slides).toHaveLength(2);
    expect(deliverableInfo(starterPoster('x'))).toMatchObject({ kind: 'poster' });
    expect(deliverableInfo(starterPoster('x')).slides).toHaveLength(1);
    expect(deliverableInfo(starterPage('x'))).toMatchObject({ kind: 'page', slides: [] });
  });
});
