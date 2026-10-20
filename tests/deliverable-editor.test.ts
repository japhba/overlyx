// @vitest-environment happy-dom
/**
 * The deliverable editor's side of HTML deliverables: canvas operations rebased onto a text that
 * changed meanwhile, new objects and slides, speaker notes (client deliverable/sourceops.ts), and
 * the runtime bringing the live page up to date with a new text without touching what did not
 * change (deliverable/runtime/reconcile.ts).
 */
import { describe, it, expect, beforeAll } from 'vitest';
import { rebasedSplices, rebaseObjectPaths, applyTo, objectHtml, insertPlace, newSlideHtml, slideDesigns, slidePaths, slideNotes, notesOp } from '../packages/client/src/deliverable/sourceops.ts';
import { applyOp, parseSource, elementAt } from '../packages/core/src/html/source.ts';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

// A stable editing fixture: tests of source paths must not depend on the current visual defaults.
const DECK = readFileSync(join(import.meta.dirname, 'fixtures/editable-deck.html'), 'utf8');

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

  it('rapid nudges based on the same frame version retain every step and another author’s colour change', () => {
    const path = [1, 0, 1];
    let current = applyOp(DECK, { t: 'style', path, set: { color: 'teal' } });
    for (let step = 1; step <= 10; step++) {
      const splices = rebasedSplices(DECK, current, [{ t: 'style', path, set: { left: `${120 + step * 10}px` } }]);
      expect(splices, `nudge ${step} applies after the preceding style edit`).not.toBeNull();
      current = applyTo(current, splices!);
    }
    const style = elementAt(parseSource(current).doc, path)!.attrs.find(a => a.name === 'style')!.value;
    expect(style).toContain('left: 220px');
    expect(style).toContain('color: teal');
  });

  it.each(['one.png', 'two.png'])('a stale picture move cannot change the next picture after the original %s is deleted', image => {
    const original = `<img src="${image}" style="left: 10px">`;
    const source = `<html><head></head><body><section class="slide">${original}<img src="two.png" style="left: 20px"></section></body></html>`;
    const current = source.replace(original, '');
    expect(rebasedSplices(source, current, [{ t: 'style', path: [1, 0, 0], set: { left: '30px' } }])).toBeNull();
  });

  it('successive toolbar styles follow a selected box after an earlier sibling is deleted', () => {
    const first = '<p style="font-size: 18pt">FIRST</p>';
    const source = `<html><head></head><body><section class="slide">${first}<p style="font-size: 18pt">SECOND</p><p style="font-size: 18pt">THIRD</p></section></body></html>`;
    const originalPath = [1, 0, 1];
    let current = source.replace(first, '');
    expect(rebaseObjectPaths(source, current, [originalPath])).toEqual([[1, 0, 0]]);
    current = applyOp(current, { t: 'style', path: [1, 0, 0], set: { 'font-size': '26pt' } });
    expect(rebaseObjectPaths(source, current, [originalPath])).toEqual([[1, 0, 0]]);
    const next = rebasedSplices(source, current, [{ t: 'style', path: originalPath, set: { color: '#cc0000' } }]);
    expect(next).not.toBeNull();
    const saved = parseSource(applyTo(current, next!)).doc;
    expect(elementAt(saved, [1, 0, 0])!.attrs.find(a => a.name === 'style')!.value).toContain('font-size: 26pt');
    expect(elementAt(saved, [1, 0, 0])!.attrs.find(a => a.name === 'style')!.value).toContain('color: #cc0000');
    expect(elementAt(saved, [1, 0, 1])!.attrs.find(a => a.name === 'style')!.value).toBe('font-size: 18pt');
  });

  it('does not follow a deleted selected box into its restyled neighbour or an ambiguous repeated box', () => {
    for (const neighbour of ['THIRD', 'SECOND']) {
      const selected = '<p style="font-size: 18pt">SECOND</p>';
      const source = `<html><head></head><body><section class="slide">${selected}<p style="font-size: 18pt">${neighbour}</p></section></body></html>`;
      const current = source.replace(selected, '').replace('font-size: 18pt', 'font-size: 26pt');
      expect(rebaseObjectPaths(source, current, [[1, 0, 0]])).toBeNull();
      expect(rebasedSplices(source, current, [{ t: 'style', path: [1, 0, 0], set: { color: '#cc0000' } }])).toBeNull();
    }
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

  it('a new slide keeps the design of the one it follows, without its text or its own pictures and shapes', () => {
    const html = newSlideHtml(DECK, 1)!;
    expect(html).toMatch(/^<section class="slide">/);
    expect(html).toContain('>Title</h2>');
    expect(html).not.toContain('One message per slide');
    // that slide's own shape is content (usability test: "New slide" copied every picture and drawing)
    expect(html).not.toContain('border-radius: 24px');
    expect(html).not.toContain('notes');
    // what recurs on another slide (a logo) or is marked as decoration is the design: it stays
    const logo = '<img class="corner" src="logo.png" style="position: absolute; right: 20px; top: 20px; width: 60px">';
    const branded = DECK.replace(/<\/section>/g, `  ${logo}\n  <div class="accent" style="position: absolute; left: 0; top: 0; width: 8px; height: 720px; background: red"></div>\n</section>`);
    const nb = newSlideHtml(branded, 1)!;
    expect(nb).toContain(logo);
    expect(nb).toContain('class="accent"');
    expect(nb).not.toContain('border-radius: 24px');
    const ps = slidePaths(DECK);
    expect(ps).toEqual([[1, 0], [1, 1]]);
    const out = applyOp(DECK, { t: 'insert', parent: [1], index: 2, html });
    expect(slidePaths(out)).toHaveLength(3);
  });

  it('the layouts of a new slide: one per design among the slides, words aside, the current one first', () => {
    const slide = (body: string) => `<section class="slide">\n  ${body}\n</section>`;
    const bar = '<div class="decoration" style="position: absolute; left: 0; top: 84px; width: 1280px; height: 4px"></div>';
    const deck = `<!doctype html><html><body>\n${[
      slide(`<h1>Tea tasting</h1>\n  ${bar}`),
      slide('<h2>Milk first</h2>\n  <p>Four cups of each.</p>'),
      slide('<h2>Tea first</h2>\n  <svg class="ol-ink"><path d="M0 0L9 9"/></svg>'),
      slide(`<h1>Results</h1>\n  ${bar}`),
    ].join('\n')}\n</body></html>`;
    // the title slide and the closing slide look alike, and so do the two content slides
    expect(slideDesigns(deck)).toEqual([0, 1]);
    expect(slideDesigns(deck, 2)).toEqual([2, 0]);
    expect(newSlideHtml(deck, 3)).toContain('class="decoration"');
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
