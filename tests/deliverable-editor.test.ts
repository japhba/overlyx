// @vitest-environment happy-dom
/**
 * The deliverable editor's side of HTML deliverables: canvas operations rebased onto a text that
 * changed meanwhile, new objects and slides, speaker notes (client deliverable/sourceops.ts), and
 * the runtime bringing the live page up to date with a new text without touching what did not
 * change (deliverable/runtime/reconcile.ts).
 */
import { describe, it, expect, beforeAll } from 'vitest';
import { rebasedSplices, applyTo, objectHtml, insertPlace, newSlideHtml, slidePaths, slideNotes, notesOp } from '../packages/client/src/deliverable/sourceops.ts';
import { applyOp, parseSource, elementAt } from '../packages/core/src/html/source.ts';
import { starterDeck } from '../packages/core/src/html/deliverable.ts';

const DECK = starterDeck('Waves');

describe('the editor changes the text', () => {
  it('rebases an operation made on an older version', () => {
    const titlePath = [1, 0, 1];
    expect(elementAt(parseSource(DECK).doc, titlePath)!.tagName).toBe('h1');
    // meanwhile somebody retitled the page (a change elsewhere)
    const cur = DECK.replace('<title>Waves</title>', '<title>Waves and more</title>');
    const sp = rebasedSplices(DECK, cur, [{ t: 'style', path: titlePath, set: { top: '200px' } }])!;
    const out = applyTo(cur, sp);
    expect(out).toContain('<title>Waves and more</title>');
    expect(out).toContain('<h1 style="position: absolute; left: 120px; top: 200px; width: 1040px">Waves</h1>');
    // retyped meanwhile and retyped here: the later retyping wins
    const retyped = DECK.replace('>Waves</h1>', '>Particles</h1>');
    expect(applyTo(retyped, rebasedSplices(DECK, retyped, [{ t: 'inner', path: titlePath, html: 'Light' }])!)).toContain('>Light</h1>');
    // …but an element somebody deleted meanwhile is not edited
    const gone = DECK.replace(/\n  <h1[^\n]*<\/h1>/, '');
    expect(gone).not.toContain('<h1');
    expect(rebasedSplices(DECK, gone, [{ t: 'style', path: titlePath, set: { top: '0' } }])).toBeNull();
  });

  it('several objects moved at once are one change', () => {
    const sp = rebasedSplices(DECK, DECK, [
      { t: 'style', path: [1, 0, 1], set: { left: '100px' } },
      { t: 'style', path: [1, 0, 2], set: { left: '100px' } },
    ])!;
    expect(sp).toHaveLength(2);
    const out = applyTo(DECK, sp);
    expect(out.match(/left: 100px/g)).toHaveLength(2);
  });

  it('new objects go at the end of their slide, before the notes', () => {
    const place = insertPlace(DECK, [1, 1], null, 'deck')!;
    const out = applyOp(DECK, { t: 'insert', parent: place.parent, index: place.index, html: objectHtml('rect', { x: 10, y: 20, w: 100, h: 50 }, 'deck') });
    const el = elementAt(parseSource(out).doc, place.path)!;
    expect(el.tagName).toBe('div');
    // a shape centres the text typed into it (Google Slides')
    expect(out).toMatch(/<div style="position: absolute; left: 10px; top: 20px; width: 100px; height: 50px; display: flex; align-items: center; justify-content: center; text-align: center; color: #fff; background: #2f6fde; border-radius: 8px"><\/div>\n  <aside class="notes">/);
    expect(objectHtml('text', { x: 5, y: 6, w: 0, h: 0 }, 'deck')).toBe('<p style="position: absolute; left: 5px; top: 6px; width: 520px; margin: 0">Text</p>');
    expect(objectHtml('text', { x: 5, y: 6, w: 0, h: 0 }, 'page')).toBe('<p>Text</p>');
  });

  it('a new slide keeps the design of the one it follows, without its text', () => {
    const html = newSlideHtml(DECK, 1)!;
    expect(html).toMatch(/^<section class="slide">/);
    expect(html).toContain('>Title</h2>');
    expect(html).not.toContain('One message per slide');
    expect(html).toContain('border-radius: 24px');   // the shape stays
    expect(html).not.toContain('notes');
    const ps = slidePaths(DECK);
    expect(ps).toEqual([[1, 0], [1, 1]]);
    const out = applyOp(DECK, { t: 'insert', parent: [1], index: 2, html });
    expect(slidePaths(out)).toHaveLength(3);
  });

  it('speaker notes: read, changed, added, removed', () => {
    expect(slideNotes(DECK, [1, 1]).text).toBe('Speaker notes go here.');
    const changed = applyOp(DECK, notesOp(DECK, [1, 1], 'Say <this> & that')!);
    expect(changed).toContain('<aside class="notes">Say &lt;this&gt; &amp; that</aside>');
    const added = applyOp(DECK, notesOp(DECK, [1, 0], 'First')!);
    expect(slideNotes(added, [1, 0]).text).toBe('First');
    const removed = applyOp(DECK, notesOp(DECK, [1, 1], '  ')!);
    expect(removed).not.toContain('aside');
    expect(notesOp(DECK, [1, 1], 'Speaker notes go here.')).toBeNull();
  });
});

describe('the runtime updates the page in place', () => {
  let reconcile: typeof import('../packages/client/src/deliverable/runtime/reconcile.ts');
  let env: typeof import('../packages/client/src/deliverable/runtime/env.ts');
  const PAGE = `<!doctype html><html><head><style>.slide{width:100px}</style></head><body>
<section class="slide"><h1>One</h1><p>Text \\(x\\)</p><div id="chart"></div></section>
<section class="slide"><h2>Two</h2></section>
</body></html>`;

  beforeAll(async () => {
    // (MathJax is not loaded here: the runtime would fetch it for the page's formula)
    (window as unknown as { happyDOM: { settings: { disableJavaScriptFileLoading: boolean } } }).happyDOM.settings.disableJavaScriptFileLoading = true;
    reconcile = await import('../packages/client/src/deliverable/runtime/reconcile.ts');
    env = await import('../packages/client/src/deliverable/runtime/env.ts');
    document.documentElement.innerHTML = new DOMParser().parseFromString(PAGE, 'text/html').documentElement.innerHTML;
    // what a script of the page drew, and what MathJax would have done
    document.getElementById('chart')!.innerHTML = '<svg data-drawn="1"></svg>';
    reconcile.applySource(PAGE, 1);
  });

  it('pairs the live page with its source', () => {
    const h1 = document.querySelector('h1')!;
    expect(env.pathOf(h1)).toEqual([1, 0, 0]);
    expect(env.liveAt([1, 1, 0])).toBe(document.querySelector('h2'));
  });

  it('keeps the elements that did not change, replaces the one that did', () => {
    const h1 = document.querySelector('h1')!, chart = document.getElementById('chart')!, p = document.querySelector('p')!;
    const next = PAGE.replace('<h2>Two</h2>', '<h2>Two, retitled</h2>');
    expect(reconcile.applySource(next, 2)).toBe(true);
    expect(document.querySelector('h1')).toBe(h1);
    expect(document.querySelector('p')).toBe(p);
    expect(document.getElementById('chart')).toBe(chart);
    expect(chart.innerHTML).toContain('data-drawn');
    expect(document.querySelector('h2')!.textContent).toBe('Two, retitled');
    expect(env.pathOf(document.querySelector('h2')!)).toEqual([1, 1, 0]);
  });

  it('an attribute changed keeps the element and its children; an object inserted shifts paths', () => {
    const h1 = document.querySelector('h1')!;
    const moved = PAGE.replace('<h2>Two</h2>', '<h2>Two, retitled</h2>').replace('<h1>One</h1>', '<h1 style="left: 5px">One</h1>');
    reconcile.applySource(moved, 3);
    expect(document.querySelector('h1')).toBe(h1);
    expect(h1.getAttribute('style')).toBe('left: 5px');
    const inserted = moved.replace('<section class="slide"><h1', '<section class="slide"><span>new</span><h1');
    reconcile.applySource(inserted, 4);
    expect(document.querySelector('h1')).toBe(h1);
    expect(env.pathOf(h1)).toEqual([1, 0, 1]);
    expect(document.querySelector('section span')!.textContent).toBe('new');
    expect(document.querySelector('section')!.firstElementChild!.localName).toBe('span');
  });

  it('a slide moved is moved, not made anew', () => {
    const s2 = document.querySelectorAll('section')[1];
    const cur = env.state.html;
    const swapped = cur.replace(/(<section class="slide"><span>[\s\S]*?<\/section>)\n(<section class="slide"><h2>[\s\S]*?<\/section>)/, '$2\n$1');
    expect(swapped).not.toBe(cur);
    reconcile.applySource(swapped, 5);
    const ss = document.querySelectorAll('section');
    expect(ss[0]).toBe(s2);
    expect(ss[1].querySelector('h1')).toBeTruthy();
  });
});
