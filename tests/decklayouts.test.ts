/**
 * Slide layouts with placeholders (packages/client/src/deliverable/decklayouts.ts) and where the deck
 * editor's toolbars go on touch screens (deckdock.ts): the deck's margins, the layouts made of its
 * design, the deck's own layouts in <template>s, Apply layout, the layouts drawn small.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { deckMargins, deckDesign, builtInLayouts, savedLayouts, layoutFromSlide, saveLayoutOp, applyLayoutOp, placeholderObject, layoutThumb, deckColors } from '../packages/client/src/deliverable/decklayouts.ts';
import { newSlideHtml, nextPageHtml } from '../packages/client/src/deliverable/sourceops.ts';
import { chooseDock } from '../packages/client/src/deliverable/deckdock.ts';
import { nearestDock, palPlace } from '../packages/client/src/deliverable/drawpalette.tsx';
import { applyOp, parseSource } from '../packages/core/src/html/source.ts';
import { slideElements } from '../packages/core/src/html/deliverable.ts';

const DECK = readFileSync(join(import.meta.dirname, 'fixtures/editable-deck.html'), 'utf8');
const SIZE = { w: 1280, h: 720 };
const deck = (body: string, attrs = '') => `<!doctype html><html><head><meta name="overlyx" content="deck"><style>.slide{width:1280px;height:720px}</style></head><body${attrs}>\n${body}\n</body></html>`;
const slide = (inner: string, cls = 'slide') => `<section class="${cls}">\n  ${inner}\n</section>`;
const at = (x: number, y: number, w: number, extra = '') => `position: absolute; left: ${x}px; top: ${y}px; width: ${w}px${extra ? '; ' + extra : ''}`;

describe("a deck's margins", () => {
  it("the template's, a slide's own over it", () => {
    expect(deckMargins(DECK, SIZE).sides).toEqual({ top: 72, right: 96, bottom: 72, left: 96 });
    expect(deckMargins(DECK, SIZE).from).toBe('template');
    const own = DECK.replace('<section class="slide">\n  <h2', '<section class="slide" data-ol-layout-margins="40px">\n  <h2');
    expect(deckMargins(own, SIZE, 1)).toEqual({ sides: { top: 40, right: 40, bottom: 40, left: 40 }, from: 'slide' });
  });
  it('none written: where the slides\' text and pictures sit (decoration, full-width boxes left out), the foot no further in than the head', () => {
    const text = deck([
      slide(`<h1 style="${at(96, 230, 1088)}">Cover</h1>`),
      slide(`<div class="bar" style="${at(0, 0, 1280, 'height: 40px')}"></div>\n  <h2 style="${at(72, 48, 1136)}">One</h2>\n  <p style="${at(72, 135, 1136)}">Text</p>`),
      slide(`<h2 style="${at(72, 48, 1136)}">Two</h2>\n  <img src="a.png" style="${at(700, 200, 400, 'height: 300px')}">`),
      slide(`<h2 style="${at(80, 50, 1120)}">Three</h2>`),
    ].join('\n'));
    const m = deckMargins(text, SIZE);
    expect(m.from).toBe('deck');
    expect(m.sides.left).toBe(72);
    expect(m.sides.right).toBe(72);
    expect(m.sides.top).toBe(48);
    expect(m.sides.bottom).toBe(48);
  });
  it('nothing to go by: a little in from the edges', () => {
    const m = deckMargins(deck(slide('<h2>Free text</h2>')), SIZE);
    expect(m.from).toBe('default');
    expect(m.sides.left).toBeCloseTo(0.06 * 1280);
    expect(m.sides.top).toBeCloseTo(0.07 * 720);
  });
});

describe('the layouts made of the deck', () => {
  const html = (id: string) => builtInLayouts(deckDesign(DECK, SIZE)).find(l => l.id === id)!.html;
  it('Title and body: an empty title where the deck has its titles, an empty list where its text starts, its look', () => {
    const h = html('body');
    expect(h).toMatch(/^<section class="slide">/);
    expect(h).toContain(`<h2 data-ol-ph="title" style="position: absolute; left: 96px; top: 72px; width: 1088px; min-height: `);
    expect(h).toMatch(/<ul data-ol-ph="body" style="position: absolute; left: 96px; top: 190px; width: 1088px; min-height: \d+px"><\/ul>/);
    // (their content gone: nothing of the slide's own words)
    expect(h).not.toContain('One message per slide');
    expect(h).not.toContain('notes');
  });
  it('Title slide: the first slide\'s title and the text under it, its decoration', () => {
    const h = html('title');
    expect(h).toContain('<div class="bar"');
    expect(h).toMatch(/<h1 data-ol-ph="title" style="position: absolute; left: 120px; top: 250px; width: 1040px; min-height: \d+px"><\/h1>/);
    expect(h).toMatch(/<p class="muted" data-ol-ph="subtitle" style="position: absolute; left: 120px; top: 420px; width: 1040px; min-height: \d+px"><\/p>/);
  });
  it('every layout a slide of the deck, its placeholders empty; two columns side by side; a picture box', () => {
    const ls = builtInLayouts(deckDesign(DECK, SIZE));
    expect(ls.map(l => l.name)).toEqual(['Title slide', 'Section header', 'Title and body', 'Title and two columns', 'Title only', 'Title and picture', 'Blank']);
    for (const l of ls) {
      const out = applyOp(DECK, { t: 'insert', parent: [1], index: 2, html: l.html });
      expect(slideElements(parseSource(out).doc)).toHaveLength(3);
    }
    const cols = [...html('columns').matchAll(/<ul data-ol-ph="body" style="position: absolute; left: (\d+)px; top: (\d+)px; width: (\d+)px/g)].map(m => m.slice(1).map(Number));
    expect(cols).toHaveLength(2);
    expect(cols[1][0]).toBeGreaterThan(cols[0][0] + cols[0][2]);
    expect(cols[0][1]).toBe(cols[1][1]);
    expect(html('picture')).toMatch(/<div data-ol-ph="picture" style="[^"]*height: \d+px"><\/div>/);
  });
  it('a deck without lists: the list placeholder looks like its text (measured where the canvas shows it)', () => {
    const text = deck([
      slide(`<h1 style="${at(96, 200, 1088)}">Cover</h1>`),
      slide(`<h2 style="${at(96, 60, 1088)}">One</h2>\n  <p class="body" style="${at(96, 160, 1088)}">Text</p>`),
    ].join('\n'));
    const d = deckDesign(text, SIZE);
    expect(d.body?.path).toEqual([1, 1, 1]);
    const l = builtInLayouts(d, { body: { fontSize: '28px', lineHeight: '40.6px', fontFamily: 'Inter', fontWeight: '400', color: 'rgb(0, 0, 0)' } }).find(x => x.id === 'body')!;
    expect(l.html).toMatch(/<ul class="body" data-ol-ph="body" style="[^"]*margin: 0; padding-left: 1\.1em; font-size: 28px; line-height: 40\.6px"><\/ul>/);
  });
  it('a placeholder of a role on its own, where the layouts have it', () => {
    const d = deckDesign(DECK, SIZE);
    expect(placeholderObject('title', d)).toMatch(/^<h2 data-ol-ph="title" style="position: absolute; left: 96px; top: 72px/);
    expect(placeholderObject('text', d)).toMatch(/^<p data-ol-ph="text" style="position: absolute; left: 96px; top: 190px/);
    expect(placeholderObject('picture', d)).toMatch(/^<div data-ol-ph="picture"/);
  });
});

describe("the deck's own layouts", () => {
  it('a slide saved as a layout: in a <template> at the end of the body — no slide, its placeholders and notes gone, the rest kept', () => {
    const withPh = DECK.replace('<h2 style="position: absolute; left: 96px; top: 72px; width: 1088px">The idea</h2>', '<h2 data-ol-ph="title" style="position: absolute; left: 96px; top: 72px; width: 1088px">The idea</h2>');
    const l = layoutFromSlide(withPh, 1)!;
    expect(l).toContain('<h2 data-ol-ph="title" style="position: absolute; left: 96px; top: 72px; width: 1088px"></h2>');
    expect(l).toContain('One message per slide');
    expect(l).toContain('border-radius: 24px');
    expect(l).not.toContain('notes');
    const out = applyOp(withPh, saveLayoutOp(withPh, l, 'Idea "slide"')!);
    expect(out).toMatch(/<template data-ol-layout="Idea &quot;slide&quot;">\n<section class="slide">/);
    expect(slideElements(parseSource(out).doc)).toHaveLength(2);
    const saved = savedLayouts(out);
    expect(saved).toHaveLength(1);
    expect(saved[0].name).toBe('Idea "slide"');
    expect(saved[0].html).toBe(l);
    // (removed by its path)
    expect(savedLayouts(applyOp(out, { t: 'remove', paths: [saved[0].saved!] }))).toEqual([]);
  });
  it('Ctrl+M: the slide\'s design with an empty title placeholder (not the word "Title")', () => {
    const h = newSlideHtml(DECK, 1)!;
    expect(h).toContain('<h2 data-ol-ph="title" style="position: absolute; left: 96px; top: 72px; width: 1088px"></h2>');
    expect(newSlideHtml(deck(slide('<p>No heading</p>')), 0)).toMatch(/<h2 data-ol-ph="title" style="[^"]+"><\/h2>/);
  });
  it('a swipe on past the last slide: its design — a slide written on by hand gets no title either (GoodNotes\' next page)', () => {
    expect(nextPageHtml(DECK, 1)).toBe(newSlideHtml(DECK, 1));
    const page = nextPageHtml(deck(slide('<svg class="ink" style="position: absolute"><path d="M0 0L9 9"/></svg>')), 0)!;
    expect(page).not.toContain('data-ol-ph');
    expect(page).not.toContain('<svg');
  });
});

describe('Apply layout', () => {
  it('the title into the title, the list into the first column, what else is on the slide where it is, its notes', () => {
    const lay = builtInLayouts(deckDesign(DECK, SIZE)).find(l => l.id === 'columns')!.html;
    const op = applyLayoutOp(DECK, 1, lay)!;
    expect(op.t).toBe('outer');
    const out = applyOp(DECK, op);
    const s = slideElements(parseSource(out).doc)[1];
    const src = out.slice(s.sourceCodeLocation!.startOffset, s.sourceCodeLocation!.endOffset);
    expect(src).toMatch(/<h2 data-ol-ph="title" [^>]*>The idea<\/h2>/);
    expect(src).not.toMatch(/<h2 style=/);
    // (the old list went into the first column; the second stays empty)
    expect(src).toMatch(/<ul data-ol-ph="body" [^>]*>\s*<li>One message per slide<\/li>/);
    expect(src.match(/data-ol-ph="body"/g)).toHaveLength(2);
    expect(src).toContain('border-radius: 24px');
    expect(src).toContain('<aside class="notes">Speaker notes go here.</aside>');
  });
  it("a slide with a copy of it (duplicated, or made of a layout saved from it): its objects are its own, not decoration; a kicker above its title stays", () => {
    const content = `<p class="kicker" style="${at(100, 70, 600)}">1 · The light</p>\n  <h2 style="${at(100, 110, 1080)}">Sunlight</h2>\n  <ul style="${at(100, 240, 520)}"><li>White light</li></ul>`;
    const two = deck([slide(`<h1 style="${at(100, 275, 900)}">Cover</h1>`), slide(content), slide(content)].join('\n'));
    const lay = builtInLayouts(deckDesign(two, SIZE, 1)).find(l => l.id === 'body')!.html;
    expect(lay).not.toContain('White light');
    const out = applyOp(two, applyLayoutOp(two, 1, lay)!);
    const s = slideElements(parseSource(out).doc)[1];
    const src = out.slice(s.sourceCodeLocation!.startOffset, s.sourceCodeLocation!.endOffset);
    expect(src).toMatch(/<ul data-ol-ph="body"[^>]*><li>White light<\/li><\/ul>/);
    expect(src.match(/White light/g)).toHaveLength(1);
    expect(src).toContain('<p class="kicker" style="position: absolute; left: 100px; top: 70px; width: 600px">1 · The light</p>');
  });
  it('words into a list become its items; a list into a heading its lines', () => {
    const one = deck(slide(`<h2 data-ol-ph="title" style="${at(96, 72, 1088)}">T</h2>\n  <p data-ol-ph="body" style="${at(96, 190, 1088)}">a<br>b</p>`));
    const lay = slide(`<h2 data-ol-ph="title" style="${at(96, 72, 1088)}"></h2>\n  <ul data-ol-ph="body" style="${at(96, 190, 1088)}"></ul>`);
    const out = applyOp(one, applyLayoutOp(one, 0, lay)!);
    expect(out).toContain('<ul data-ol-ph="body" style="position: absolute; left: 96px; top: 190px; width: 1088px"><li>a</li><li>b</li></ul>');
  });
});

describe('layouts drawn small', () => {
  it('the deck\'s colours (its classes, custom properties, gradients), a bar for a title, bullets for a list', () => {
    const text = `<style>:root { --accent: #eb811b } .dark { background: linear-gradient(160deg, #0b1d4a 0%, #1d3f8f 55%, #3a86ff 100%); color: #fff; }</style>`;
    const c = deckColors(text);
    expect(c.vars.accent).toBe('#eb811b');
    expect(c.classes.dark.color).toBe('#fff');
    const svg = layoutThumb(slide(`<div style="${at(0, 0, 1280, 'height: 84px; background: var(--accent)')}"></div>\n  <h2 data-ol-ph="title" style="${at(96, 200, 1088, 'min-height: 60px')}"></h2>\n  <ul data-ol-ph="body" style="${at(96, 300, 1088, 'min-height: 300px')}"></ul>`, 'slide dark'), SIZE, c);
    expect(svg).toMatch(/^<svg viewBox="0 0 1280 720"/);
    expect(svg).toContain('fill="#1d3f8f"');
    expect(svg).toContain('fill="#eb811b"');
    expect(svg).toContain('<circle');
    expect(svg).toContain('fill="#fff" opacity="0.7"');
  });
});

describe('where the toolbars go on a touch screen', () => {
  const pick = (w: number, h: number, slide = SIZE) => chooseDock({ area: { w, h }, slide, tools: 420, rest: 560, current: 'top' });
  it('a phone held sideways: a column at each side, as wide as the room beside the slide', () => {
    const p = pick(844, 314);
    expect(p.dock).toBe('sides');
    expect(p.col).toBeGreaterThanOrEqual(48);
    expect(p.col).toBeLessThanOrEqual(92);
  });
  it('a tablet, landscape or upright, a 16:9 slide: the row along the top; a 4:3 slide on a landscape tablet: the sides', () => {
    expect(pick(1366, 948).dock).toBe('top');
    expect(pick(1024, 1290).dock).toBe('top');
    expect(pick(390, 768).dock).toBe('top');
    expect(pick(1366, 948, { w: 1200, h: 900 }).dock).toBe('sides');
  });
  it('a hair either way does not flip it', () => {
    const near = { area: { w: 1180, h: 900 }, slide: { w: 1200, h: 900 }, tools: 420, rest: 560 };
    const a = chooseDock({ ...near, current: 'top' }).dock, b = chooseDock({ ...near, current: 'sides' }).dock;
    expect([a, b]).toContain(b);
    expect(chooseDock({ ...near, current: a }).dock).toBe(a);
  });
});

describe('the Draw palette on a touch screen (drawpalette.tsx)', () => {
  const canvas = { w: 1112, h: 834 };
  it('let go, it goes to the nearest edge, where along it it was let go — upright at the sides', () => {
    expect(nearestDock(500, 800, canvas)).toEqual({ edge: 'bottom', at: 500 / 1112 });
    expect(nearestDock(30, 400, canvas).edge).toBe('left');
    expect(nearestDock(1100, 100, canvas).edge).toBe('right');
    expect(nearestDock(400, 20, canvas).edge).toBe('top');
  });
  it('sits inside the canvas, its room kept from the edges, wherever along the edge it was put', () => {
    expect(palPlace({ edge: 'bottom', at: 0.5 }, { w: 574, h: 42 }, canvas)).toEqual({ x: 269, y: 782 });
    expect(palPlace({ edge: 'bottom', at: 0.99 }, { w: 574, h: 42 }, canvas).x).toBe(1112 - 574 - 10);
    expect(palPlace({ edge: 'left', at: 0 }, { w: 51, h: 574 }, canvas)).toEqual({ x: 10, y: 10 });
    expect(palPlace({ edge: 'right', at: 0.5 }, { w: 51, h: 574 }, canvas)).toEqual({ x: 1112 - 51 - 10, y: 130 });
    // (longer than the canvas: from its start, scrolling)
    expect(palPlace({ edge: 'top', at: 0.5 }, { w: 1300, h: 42 }, canvas)).toEqual({ x: 10, y: 10 });
  });
});
