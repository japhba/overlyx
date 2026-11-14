import { describe, it, expect } from 'vitest';
import { blankDeck, blankPoster, starterDeck } from '../packages/core/src/html/deliverable.ts';
import { applySplices } from '../packages/core/src/html/source.ts';
import { deckPageSize, pageSetupSplices, pageSetupFactor } from '../packages/core/src/html/pagesetup.ts';

const setup = (text: string, to: Parameters<typeof pageSetupSplices>[1], mode?: 'scale' | 'keep') => {
  const r = pageSetupSplices(text, to, mode);
  if (!r) throw new Error('no page size found');
  return applySplices(text, r.splices);
};

const deck = (body: string, head = '') => `<!doctype html><html><head><meta name="overlyx" content="deck"><style>
  :root { --pad: 24px; --ink: #1d2433; }
  .slide { width: 1280px; height: 720px; position: relative; overflow: hidden; font-size: 26px; line-height: 1.35; }
  h1 { font-size: 64px; margin: 0 0 12pt; }
  .logo { position: absolute; right: 40px; bottom: 30px; width: 100px; height: 100px; border-radius: 50%; }
  @media print { @page { size: 1280px 720px; margin: 0; } .slide { margin: 0; } }
${head}</style></head><body data-ol-layout-margins="72px 96px" data-ol-guides="x640 y360">
${body}
</body></html>`;

describe('page setup', () => {
  it('reads the page size of the starters', () => {
    expect(deckPageSize(blankDeck('T'))).toEqual({ width: 1280, height: 720, unit: 'px' });
    expect(deckPageSize(blankDeck('T', { width: 297, height: 210, unit: 'mm' }))).toEqual({ width: 297, height: 210, unit: 'mm' });
    expect(deckPageSize(blankPoster('P'))).toEqual({ width: 841, height: 1189, unit: 'mm' });
    expect(deckPageSize(starterDeck('S'))).toEqual({ width: 1280, height: 720, unit: 'px' });
    expect(deckPageSize('<html><body><p>a page</p></body></html>')).toBeNull();
  });

  it('the same shape, larger: everything by one factor', () => {
    const t = deck('<section class="slide"><h1 style="position: absolute; left: 80px; top: 60px; width: 1120px; font-size: 48px">T</h1></section>');
    const out = setup(t, { width: 1920, height: 1080, unit: 'px' });
    expect(deckPageSize(out)).toEqual({ width: 1920, height: 1080, unit: 'px' });
    expect(out).toContain('@page { size: 1920px 1080px; margin: 0; }');
    expect(out).toContain('left: 120px; top: 90px; width: 1680px; font-size: 72px');
    expect(out).toContain('--pad: 36px; --ink: #1d2433;');
    expect(out).toContain('font-size: 39px; line-height: 1.35;');
    expect(out).toContain('h1 { font-size: 96px; margin: 0 0 18pt; }');
    expect(out).toContain('data-ol-layout-margins="108px 144px"');
    expect(out).toContain('data-ol-guides="x960 y540"');
  });

  it('another shape: places follow the page, type and pictures the smaller factor', () => {
    const t = deck(`<section class="slide">
  <div style="position: absolute; left: 0px; top: 0px; width: 1280px; height: 84px; background: #23373b"></div>
  <p style="position: absolute; left: 96px; top: 168px; width: 500px; font-size: 28px">text</p>
  <img src="a.png" style="position: absolute; left: 640px; top: 360px; width: 320px; height: 180px">
  <svg style="position: absolute; left: 100px; top: 500px; width: 200px; height: 100px"><path d="M0 0L200 100"/></svg>
  <div class="ol-group" style="position: absolute; left: 100px; top: 100px; width: 200px; height: 100px"><span style="position: absolute; left: 10px; top: 10px; width: 50px">in</span></div>
</section>`);
    // 16:9 → 4:3 (1024 × 768): 0.8 across, 1.0667 down, things 0.8
    const out = setup(t, { width: 1024, height: 768, unit: 'px' });
    // the bar still reaches both edges
    expect(out).toContain('left: 0px; top: 0px; width: 1024px; height: 89.6px; background: #23373b');
    expect(out).toContain('left: 76.8px; top: 179.2px; width: 400px; font-size: 22.4px');
    // the picture keeps its shape (256 × 144), in the middle of where it would have been
    expect(out).toContain('left: 512px; top: 408px; width: 256px; height: 144px');
    // a drawing without a viewBox gets its old box as one
    expect(out).toMatch(/<svg style="position: absolute; left: 80px; top: 546\.7px; width: 160px; height: 80px" viewBox="0 0 200 100">/);
    // a group and what is in it: by 0.8
    expect(out).toContain('<span style="position: absolute; left: 8px; top: 8px; width: 40px">in</span>');
    // the stylesheet's placed rule: its place from the page's edges, its round shape kept
    expect(out).toContain('.logo { position: absolute; right: 32px; bottom: 45.3px; width: 80px; height: 80px; border-radius: 50%; }');
    expect(out).toContain('data-ol-layout-margins="76.8px"');
    expect(out).toContain('data-ol-guides="x512 y384"');
  });

  it('keep: only the page', () => {
    const t = deck('<section class="slide"><h1 style="position: absolute; left: 80px; top: 60px; width: 1120px">T</h1></section>');
    const r = pageSetupSplices(t, { width: 297, height: 210, unit: 'mm' }, 'keep')!;
    const out = applySplices(t, r.splices);
    expect(r.factor).toBe(1);
    expect(r.splices.length).toBe(3);
    expect(deckPageSize(out)).toEqual({ width: 297, height: 210, unit: 'mm' });
    expect(out).toContain('@page { size: 297mm 210mm; margin: 0; }');
    expect(out).toContain('left: 80px; top: 60px; width: 1120px');
  });

  it('linked copies stay identical; layouts in templates are scaled too', () => {
    const copy = '<div data-ol-master="frame" style="position: absolute; left: 0px; top: 690px; width: 1280px; height: 30px; font-family: &quot;Fira Sans&quot;, sans-serif; background: url(a-12px.png)"></div>';
    const t = deck(`<section class="slide">${copy}</section>\n<section class="slide">${copy}</section>\n<template data-ol-layout="Title only"><section class="slide"><h1 data-ol-ph="title" style="position: absolute; left: 80px; top: 60px; width: 1120px"></h1></section></template>`);
    const out = setup(t, { width: 640, height: 360, unit: 'px' });
    const copies = out.match(/<div data-ol-master="frame"[^>]*>/g)!;
    expect(copies.length).toBe(2);
    expect(copies[0]).toBe(copies[1]);
    expect(copies[0]).toContain('left: 0px; top: 345px; width: 640px; height: 15px; font-family: &quot;Fira Sans&quot;, sans-serif; background: url(a-12px.png)');
    expect(out).toContain('<h1 data-ol-ph="title" style="position: absolute; left: 40px; top: 30px; width: 560px"></h1>');
  });

  it('a size kept as custom properties is changed there; a poster in mm', () => {
    const t = '<html><head><style>:root { --w: 1280px; --h: 720px; }\n.slide { width: var(--w); height: var(--h); }</style></head><body><section class="slide"></section></body></html>';
    expect(deckPageSize(t)).toEqual({ width: 1280, height: 720, unit: 'px' });
    expect(setup(t, { width: 1024, height: 768, unit: 'px' })).toContain(':root { --w: 1024px; --h: 768px; }');
    const p = blankPoster('P', { width: 841, height: 1189, unit: 'mm' }).replace('<section class="slide"></section>', '<section class="slide"><p style="position: absolute; left: 100mm; top: 200mm; width: 300mm; font-size: 36pt">x</p></section>');
    const a1 = setup(p, { width: 594, height: 841, unit: 'mm' });
    expect(deckPageSize(a1)).toEqual({ width: 594, height: 841, unit: 'mm' });
    expect(a1).toContain('left: 70.63mm; top: 141.46mm; width: 211.89mm; font-size: 25.43pt');
    expect(pageSetupFactor({ width: 841, height: 1189, unit: 'mm' }, { width: 594, height: 841, unit: 'mm' }).sameShape).toBe(true);
  });

  it('undoing by the opposite change brings a starter deck back to its sizes', () => {
    const t = starterDeck('S');
    const there = setup(t, { width: 2560, height: 1440, unit: 'px' });
    expect(there).not.toBe(t);
    expect(setup(there, { width: 1280, height: 720, unit: 'px' })).toBe(t);
  });
});
