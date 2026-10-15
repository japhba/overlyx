/**
 * Guides on a deck's slides (client deliverable/guides.ts, sourceops.ts guidesIn): their attribute
 * read and written, the master's (on <body>: the slide's middle lines when none are written), a
 * slide's own, one added, moved, copied, taken away.
 */
import { describe, it, expect } from 'vitest';
import { parseGuides, formatGuides, masterGuides, layoutMarginGuides, LAYOUT_MARGINS_ATTR, withGuide, withoutGuide, movedGuide, guideLabel } from '../packages/client/src/deliverable/guides.ts';
import { guidesIn } from '../packages/client/src/deliverable/sourceops.ts';
import { starterDeck, starterPoster } from '../packages/core/src/html/deliverable.ts';

describe('guides', () => {
  it('are read from and written to `data-ol-guides`: vertical first, each axis in order, on half px, one of each place', () => {
    expect(parseGuides('x640 y360 x96.5')).toEqual([{ axis: 'x', at: 640 }, { axis: 'y', at: 360 }, { axis: 'x', at: 96.5 }]);
    expect(parseGuides('')).toEqual([]);
    expect(parseGuides(null)).toEqual([]);
    expect(formatGuides([{ axis: 'y', at: 360 }, { axis: 'x', at: 640.3 }, { axis: 'x', at: 96.74 }, { axis: 'x', at: 640.1 }])).toBe('x96.5 x640.5 y360');
    expect(formatGuides([])).toBe('');
  });

  it('the master\'s: the slide\'s middle lines when none are written, none when written empty', () => {
    expect(masterGuides(null, 1280, 720)).toEqual([{ axis: 'x', at: 640 }, { axis: 'y', at: 360 }]);
    expect(masterGuides('', 1280, 720)).toEqual([]);
    expect(masterGuides('x100', 1280, 720)).toEqual([{ axis: 'x', at: 100 }]);
  });

  it('parses fixed template margins independently of draggable guide attributes', () => {
    expect(LAYOUT_MARGINS_ATTR).toBe('data-ol-layout-margins');
    expect(layoutMarginGuides('72px 96px', 1280, 720)).toEqual([
      { axis: 'x', at: 96 }, { axis: 'x', at: 1184 }, { axis: 'y', at: 72 }, { axis: 'y', at: 648 },
    ]);
    expect(layoutMarginGuides('40mm', 841 * 96 / 25.4, 1189 * 96 / 25.4)[0].at).toBeCloseTo(40 * 96 / 25.4, 4);
    expect(layoutMarginGuides('10% 5%', 1280, 720)).toEqual([
      { axis: 'x', at: 64 }, { axis: 'x', at: 1216 }, { axis: 'y', at: 72 }, { axis: 'y', at: 648 },
    ]);
    expect(layoutMarginGuides('10%', 1280, 720)).toEqual([
      { axis: 'x', at: 128 }, { axis: 'x', at: 1152 }, { axis: 'y', at: 72 }, { axis: 'y', at: 648 },
    ]);
    expect(layoutMarginGuides('10% 5% 20%', 1280, 720)).toEqual([
      { axis: 'x', at: 64 }, { axis: 'x', at: 1216 }, { axis: 'y', at: 72 }, { axis: 'y', at: 576 },
    ]);
    expect(layoutMarginGuides('640px', 1280, 720)).toEqual([]);
    expect(layoutMarginGuides('auto', 1280, 720)).toEqual([]);
    expect(layoutMarginGuides('100px 100px 100px 100px 1px', 1280, 720)).toEqual([]);
  });

  it('defines source-template safe areas separately from draggable guide data', () => {
    const deck = starterDeck('A deck');
    const poster = starterPoster('A poster');
    expect(deck).toContain('<body data-ol-layout-margins="84px 80px 48px">');
    expect(poster).toContain('<body data-ol-layout-margins="0.5in">');
    expect(deck + poster).not.toContain('data-ol-guides');
  });

  it('one added (not twice), moved, copied, taken away', () => {
    const gs = parseGuides('x640 y360');
    expect(formatGuides(withGuide(gs, { axis: 'x', at: 100 }))).toBe('x100 x640 y360');
    expect(withGuide(gs, { axis: 'x', at: 640.2 })).toHaveLength(2);
    expect(formatGuides(movedGuide(gs, { axis: 'x', at: 640 }, 320))).toBe('x320 y360');
    expect(formatGuides(movedGuide(gs, { axis: 'x', at: 640 }, 320, true))).toBe('x320 x640 y360');
    expect(formatGuides(withoutGuide(gs, { axis: 'y', at: 360 }))).toBe('x640');
    expect(guideLabel({ axis: 'x', at: 640 })).toBe('480 pt');
  });

  it('are found in the deck\'s text: <body>\'s path and its guides, each slide\'s own', () => {
    const text = '<!doctype html>\n<html>\n<head><title>t</title></head>\n<body data-ol-guides="x100">\n<section class="slide" data-ol-guides="y200"></section>\n<section class="slide"></section>\n</body>\n</html>\n';
    const g = guidesIn(text);
    expect(g.body).toEqual([1]);
    expect(g.master).toBe('x100');
    expect(g.slides.map(s => s.own)).toEqual(['y200', null]);
    expect(g.slides[1].path).toEqual([1, 1]);
    expect(guidesIn(text.replace(' data-ol-guides="x100"', '')).master).toBeNull();
  });
});
