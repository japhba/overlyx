import { describe, it, expect } from 'vitest';
import { parseSource, elementAt, applyOp, attr, type HtmlOp } from '../packages/core/src/html/source.ts';
import {
  trackInner, reviewOps, resolveOps, resolveAll, publishedText, cleanFragment, parseThreads, threadsOp, threadsValue,
  isSuggesting, suggestingOp, reviewOf, reviewCounts, parseWas, stampOf, parseStamp, COMMENTS, INS, DEL, CHG, WAS,
} from '../packages/core/src/html/review.ts';

const ST = 'Kim Lee|2026-10-11 14:03';
const ST2 = 'Jan Bauer|2026-10-11 15:00';

const DECK = `<!doctype html>
<html>
<head>
<meta name="overlyx" content="deck">
<title>Talk</title>
</head>
<body>

<section class="slide">
  <h1 style="position: absolute; left: 100px; top: 80px">Hello world</h1>
  <p style="position: absolute; left: 100px; top: 300px">The quick brown fox \\(x^2 + y\\) jumps.</p>
  <img src="a.png" style="position: absolute; left: 10px; top: 10px; width: 200px">
  <aside class="notes">Say hello</aside>
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

/** the operations made while suggesting, applied */
function suggest(text: string, ops: HtmlOp[], st: string | null = ST): string {
  let t = text;
  const out = reviewOps(parseSource(t), ops, st);
  // (each op on the text as the previous left it would be wrong: they are all on `text`)
  const src = parseSource(t);
  const { opSplices, applySplices } = { opSplices: (o: HtmlOp) => opSplicesOf(src, o), applySplices: applyAll };
  t = applySplices(t, out.flatMap(opSplices));
  return t;
}
import { opSplices as opSplicesOf, applySplices as applyAll } from '../packages/core/src/html/source.ts';

const el = (text: string, path: number[]) => elementAt(parseSource(text).doc, path)!;
const inner = (text: string, path: number[]) => { const e = el(text, path); const l = e.sourceCodeLocation!; return text.slice(l.startTag!.endOffset, l.endTag!.startOffset); };
const resolve = (text: string, path: number[], accept: boolean) => resolveOps(text, path, accept).reduce((t, op) => applyOp(t, op), text);

describe('deck review: words typed and deleted', () => {
  it('marks typed and deleted words, and accepting / rejecting gives the new / old text', () => {
    const old = 'The quick brown fox';
    const out = trackInner(old, 'The slow brown dog', ST);
    expect(out).toBe(`The <del data-ol-by="${ST}">quick</del><ins data-ol-by="${ST}">slow</ins> brown <del data-ol-by="${ST}">fox</del><ins data-ol-by="${ST}">dog</ins>`);
    const doc = `<html><body><p>${out}</p></body></html>`;
    expect(inner(resolve(doc, [1, 0], true), [1, 0])).toBe('The slow brown dog');
    expect(inner(resolve(doc, [1, 0], false), [1, 0])).toBe(old);
  });

  it('keeps earlier suggestions with their authors, and old deletions where they were', () => {
    const first = trackInner('one two three', 'one 2 three', ST);
    // another person retypes: the browser's text has the deletion (shown, not editable) and the insertion
    const typed = first.replace('three', 'three four');
    const second = trackInner(first, typed, ST2);
    expect(second).toContain(`<del data-ol-by="${ST}">two</del>`);
    expect(second).toContain(`<ins data-ol-by="${ST}">2</ins>`);
    expect(second).toContain(`<ins data-ol-by="${ST2}"> four</ins>`);
    // a deletion the browser lost (Backspace over it) comes back: deletions go only by accepting or rejecting
    const lost = trackInner(first, 'one <ins data-ol-by="' + ST + '">2</ins> three', ST2);
    expect(lost).toContain('two</del>');
  });

  it('deleting words someone suggested adding takes them out', () => {
    const first = trackInner('a b', 'a new b', ST);
    expect(first).toContain('<ins');
    const second = trackInner(first, 'a b', ST2);
    expect(second).toBe('a b');
  });

  it('never puts a mark inside a formula or a command', () => {
    const out = trackInner('see \\(x^2 + y\\) and \\cite{knuth}', 'see \\(x^2 - y\\) and \\cite{lamport}', ST);
    expect(out).toContain(`<del data-ol-by="${ST}">\\(x^2 + y\\)</del><ins data-ol-by="${ST}">\\(x^2 - y\\)</ins>`);
    expect(out).toContain(`<del data-ol-by="${ST}">\\cite{knuth}</del><ins data-ol-by="${ST}">\\cite{lamport}</ins>`);
  });

  it('keeps formatting tags as typed, marking only the words', () => {
    const out = trackInner('make <b>this</b> bold', 'make <b>this one</b> bold', ST);
    expect(out).toBe(`make <b>this<ins data-ol-by="${ST}"> one</ins></b> bold`);
  });

  it('marks list items added and deleted as a whole, and edits inside an item by words', () => {
    const old = '\n    <li>One</li>\n    <li>Two</li>\n  ';
    const out = trackInner(old, '\n    <li>One more</li>\n    <li>Three</li>\n  ', ST);
    expect(out).toContain(`<li>One<ins data-ol-by="${ST}"> more</ins></li>`);
    const doc = `<html><body><ul>${out}</ul></body></html>`;
    const acc = inner(resolve(doc, [1, 0], true), [1, 0]);
    const rej = inner(resolve(doc, [1, 0], false), [1, 0]);
    expect(acc.replace(/\s+/g, '')).toBe('<li>Onemore</li><li>Three</li>');
    expect(rej.replace(/\s+/g, '')).toBe('<li>One</li><li>Two</li>');
    const del = trackInner(old, '\n    <li>One</li>\n  ', ST);
    expect(del).toContain(`<li data-ol-del="${ST}">Two</li>`);
    const add = trackInner(old, old + '<li>New</li>', ST);
    expect(add).toContain(`<li data-ol-ins="${ST}">New</li>`);
  });
});

describe('deck review: the canvas while suggesting', () => {
  it('a move records where the object was; moving it back leaves nothing to review', () => {
    const t1 = suggest(DECK, [{ t: 'style', path: [1, 0, 0], set: { left: '200px' } }]);
    const h1 = el(t1, [1, 0, 0]);
    expect(attr(h1, 'style')).toContain('left: 200px');
    expect(attr(h1, CHG)).toBe(ST);
    expect(parseWas(attr(h1, WAS))).toEqual({ style: 'position: absolute; left: 100px; top: 80px' });
    // a second move keeps what it was first
    const t2 = suggest(t1, [{ t: 'style', path: [1, 0, 0], set: { top: '90px' } }]);
    expect(parseWas(attr(el(t2, [1, 0, 0]), WAS))).toEqual({ style: 'position: absolute; left: 100px; top: 80px' });
    const back = suggest(t2, [{ t: 'style', path: [1, 0, 0], set: { left: '100px', top: '80px' } }]);
    expect(attr(el(back, [1, 0, 0]), CHG)).toBeNull();
    expect(attr(el(back, [1, 0, 0]), WAS)).toBeNull();
    // rejecting puts it back, accepting keeps the move
    expect(attr(el(resolve(t2, [1, 0, 0], false), [1, 0, 0]), 'style')).toBe('position: absolute; left: 100px; top: 80px');
    const acc = el(resolve(t2, [1, 0, 0], true), [1, 0, 0]);
    expect(attr(acc, 'style')).toContain('left: 200px');
    expect(attr(acc, CHG)).toBeNull();
  });

  it('deleting marks (the object stays until accepted); deleting a suggested addition removes it', () => {
    const t1 = suggest(DECK, [{ t: 'remove', paths: [[1, 0, 2]] }]);
    expect(attr(el(t1, [1, 0, 2]), DEL)).toBe(ST);
    expect(el(t1, [1, 0, 2]).tagName).toBe('img');
    expect(suggest(t1, [{ t: 'remove', paths: [[1, 0, 2]] }])).toBe(t1);
    expect(resolve(t1, [1, 0, 2], true)).not.toContain('a.png');
    expect(resolve(t1, [1, 0, 2], false)).toBe(DECK);

    const t2 = suggest(DECK, [{ t: 'insert', parent: [1, 0], index: 3, html: '<p style="left: 5px">New</p>' }]);
    expect(attr(el(t2, [1, 0, 3]), INS)).toBe(ST);
    const t3 = suggest(t2, [{ t: 'remove', paths: [[1, 0, 3]] }]);
    expect(t3).toBe(DECK);
  });

  it('changes inside a suggested addition, in speaker notes and in the head are direct', () => {
    const t1 = suggest(DECK, [{ t: 'insert', parent: [1, 0], index: 3, html: '<p>New</p>' }]);
    const t2 = suggest(t1, [{ t: 'inner', path: [1, 0, 3], html: 'Newer' }, { t: 'style', path: [1, 0, 3], set: { color: 'red' } }]);
    expect(inner(t2, [1, 0, 3])).toBe('Newer');
    expect(attr(el(t2, [1, 0, 3]), CHG)).toBeNull();
    const t3 = suggest(DECK, [{ t: 'inner', path: [1, 0, 3], html: 'Say goodbye' }]);
    expect(inner(t3, [1, 0, 3])).toBe('Say goodbye');
    const t4 = suggest(DECK, [{ t: 'insert', parent: [0], index: 9, html: '<link rel="stylesheet" href="f.css">' }]);
    expect(t4).toContain('<link rel="stylesheet" href="f.css">');
    expect(t4).not.toContain(INS);
  });

  it('retyping a text tracks its words', () => {
    const t1 = suggest(DECK, [{ t: 'inner', path: [1, 0, 0], html: 'Hello there world' }]);
    expect(inner(t1, [1, 0, 0])).toBe(`Hello <ins data-ol-by="${ST}">there </ins>world`);
    expect(resolve(t1, [1, 0, 0], false)).toBe(DECK);
  });

  it('a crop (one element for another) keeps the original; several for one delete it and add them', () => {
    const t1 = suggest(DECK, [{ t: 'outer', path: [1, 0, 2], html: '<div class="ol-crop" style="left: 10px"><img src="a.png"></div>' }]);
    const c = el(t1, [1, 0, 2]);
    expect(c.tagName).toBe('div');
    expect(attr(c, CHG)).toBe(ST);
    expect(parseWas(attr(c, WAS))['@outer']).toBe('<img src="a.png" style="position: absolute; left: 10px; top: 10px; width: 200px">');
    expect(resolve(t1, [1, 0, 2], false)).toBe(DECK);
    // cropped again: still the first original
    const t2 = suggest(t1, [{ t: 'outer', path: [1, 0, 2], html: '<div class="ol-crop" style="left: 20px"><img src="a.png"></div>' }]);
    expect(resolve(t2, [1, 0, 2], false)).toBe(DECK);

    const t3 = suggest(DECK, [{ t: 'outer', path: [1, 1, 0], html: '<p>One</p><p>Two</p>' }]);
    expect(attr(el(t3, [1, 1, 0]), DEL)).toBe(ST);
    expect(attr(el(t3, [1, 1, 1]), INS)).toBe(ST);
    expect(attr(el(t3, [1, 1, 2]), INS)).toBe(ST);
  });

  it('reordering records the old place of what moved; rejecting puts it back', () => {
    // the heading brought to the front (after the picture): only it moved
    const t1 = suggest(DECK, [{ t: 'reorder', parent: [1, 0], order: [1, 2, 0, 3] }]);
    expect(el(t1, [1, 0, 2]).tagName).toBe('h1');
    expect(parseWas(attr(el(t1, [1, 0, 2]), WAS))).toEqual({ '@i': 0 });
    expect(attr(el(t1, [1, 0, 0]), CHG)).toBeNull();
    expect(resolve(t1, [1, 0, 2], false)).toBe(DECK);
    // a slide moved after the next one
    const t2 = suggest(DECK, [{ t: 'move', path: [1, 0], parent: [1], index: 1 }]);
    expect(el(t2, [1, 1]).childNodes.length).toBeGreaterThan(3);
    expect(parseWas(attr(el(t2, [1, 1]), WAS))).toEqual({ '@i': 0 });
    // (the blank lines between slides may move: the source moves whole elements)
    expect(resolve(t2, [1, 1], false).replace(/\n\s*\n/g, '\n')).toBe(DECK.replace(/\n\s*\n/g, '\n'));
  });

  it('copies carry no comments or marks, while suggesting the copy is an addition', () => {
    const withComment = applyOp(DECK, threadsOp([1, 0, 2], [{ id: 'c1', by: 'Kim', at: '2026-10-11 10:00', text: "It's blurry" }]));
    const dupe = suggest(withComment, [{ t: 'duplicate', paths: [[1, 0, 2]] }], null);
    expect(attr(el(dupe, [1, 0, 2]), COMMENTS)).not.toBeNull();
    expect(attr(el(dupe, [1, 0, 3]), COMMENTS)).toBeNull();
    const dupe2 = suggest(DECK, [{ t: 'duplicate', paths: [[1, 0, 2]] }]);
    expect(attr(el(dupe2, [1, 0, 3]), INS)).toBe(ST);
    // a crop in Editing mode keeps the comments
    const crop = suggest(withComment, [{ t: 'outer', path: [1, 0, 2], html: '<div class="ol-crop"><img src="a.png"></div>' }], null);
    expect(parseThreads(attr(el(crop, [1, 0, 2]), COMMENTS))[0].text).toBe("It's blurry");
  });
});

describe('deck review: comments', () => {
  it('threads round-trip through the attribute, apostrophes and quotes included', () => {
    const threads = [{ id: 'c1', by: 'Kim', at: '2026-10-11 10:00', text: 'It\'s "blurry" & <small>', re: [{ by: 'Jan', at: '2026-10-11 11:00', text: 'Fixed' }] }];
    const t = applyOp(DECK, threadsOp([1, 0, 2], threads));
    expect(t).toContain(`data-ol-comments='[{"id":"c1"`);
    expect(parseThreads(attr(el(t, [1, 0, 2]), COMMENTS))).toEqual(threads);
    // a thread updated in place, then all removed
    const t2 = applyOp(t, threadsOp([1, 0, 2], [{ ...threads[0], done: true }]));
    expect(parseThreads(attr(el(t2, [1, 0, 2]), COMMENTS))[0].done).toBe(true);
    expect(applyOp(t2, threadsOp([1, 0, 2], []))).toBe(DECK);
    expect(threadsValue([])).toBeNull();
  });

  it('plain text an agent wrote is a thread', () => {
    expect(parseThreads('Please check the numbers')).toEqual([{ id: 'c0', by: '', at: '', text: 'Please check the numbers' }]);
  });
});

describe('deck review: the page', () => {
  it('Suggesting is a setting of the page', () => {
    expect(isSuggesting(DECK)).toBe(false);
    const on = applyOp(DECK, suggestingOp(DECK, true)!);
    expect(isSuggesting(on)).toBe(true);
    expect(suggestingOp(on, true)).toBeNull();
    expect(applyOp(on, suggestingOp(on, false)!)).toBe(DECK);
  });

  it('lists what there is to review, and accepting or rejecting everything clears it', () => {
    let t = suggest(DECK, [{ t: 'style', path: [1, 0, 0], set: { left: '300px', width: '500px' } }, { t: 'remove', paths: [[1, 0, 2]] }]);
    t = suggest(t, [{ t: 'inner', path: [1, 0, 1], html: 'The quick red fox \\(x^2 + y\\) jumps.' }], ST2);
    t = applyOp(t, threadsOp([1, 1, 0], [{ id: 'c1', by: 'Kim', at: '2026-10-11 10:00', text: 'Too long' }]));
    const r = reviewOf(t);
    expect(r.threads).toHaveLength(1);
    expect(r.threads[0].slide).toBe(1);
    const sums = r.changes.map(c => `${c.what} ${c.by}: ${c.summary}`);
    expect(sums).toEqual([
      '“Hello world” Kim Lee: Moved · Resized',
      '“The quick red fox \\(x^2 + y\\) jumps.” Jan Bauer: Typed “red” · Deleted “brown”',
      'Picture Kim Lee: Deleted',
    ]);
    expect(reviewCounts(t)).toEqual({ comments: 1, changes: 3 });
    const rej = resolveAll(t, false);
    expect(reviewOf(rej).changes).toHaveLength(0);
    expect(rej.replace(/ data-ol-comments='[^']*'/, '')).toBe(DECK);
    const pub = publishedText(t);
    expect(pub).not.toMatch(/data-ol-/);
    expect(pub).not.toContain('a.png');
    expect(pub).toContain('The quick red fox');
    // only one person's
    const onlyJan = resolveAll(t, true, { by: 'Jan Bauer' });
    expect(reviewOf(onlyJan).changes.map(c => c.by)).toEqual(['Kim Lee', 'Kim Lee']);
  });

  it('stamps', () => {
    const s = stampOf('A|B', new Date(2026, 9, 11, 9, 5));
    expect(s).toBe('A/B|2026-10-11 09:05');
    expect(parseStamp(s)).toEqual({ by: 'A/B', at: '2026-10-11 09:05' });
    expect(cleanFragment(`<p data-ol-ins="${ST}">a <del data-ol-by="${ST}">b</del><ins data-ol-by="${ST}">c</ins></p>`)).toBe('<p>a c</p>');
  });
});

describe('deck review: spaces', () => {
  it('a space between two deletions goes with them', () => {
    const out = trackInner('U3 · an OverLyX example deck', 'U3 ·  a deck', ST);
    expect(out).toBe(`U3 · <del data-ol-by="${ST}">an OverLyX example</del><ins data-ol-by="${ST}">a</ins> deck`);
  });
});
