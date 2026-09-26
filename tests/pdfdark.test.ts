// @vitest-environment happy-dom
/**
 * Dark PDF pages (client/src/app/pdfdark.ts): the colour map of the SVG filter (paper → the editor's
 * page colour, ink → its text tone), reading the theme's colours, and where pdf.js drew the raster
 * images (the photographs that keep their colours).
 */
import { describe, it, expect } from 'vitest';
import { parseColor, toneMap, imageRects, ensureDarkFilter, darkenPixels, DARK_FILTER_ID } from '../packages/client/src/app/pdfdark.ts';

describe('dark pages', () => {
  it('reads the theme colours', () => {
    expect(parseColor('#fff')).toEqual([1, 1, 1]);
    expect(parseColor(' #121216')!.map(v => Math.round(v * 255))).toEqual([18, 18, 22]);
    expect(parseColor('rgb(232, 217, 189)')!.map(v => Math.round(v * 255))).toEqual([232, 217, 189]);
    expect(parseColor('var(--x)')).toBeNull();
  });

  it('maps paper to the page colour and ink to the text tone, linearly per channel', () => {
    const bg = parseColor('#121216')!, fg = parseColor('#e8d9bd')!;
    const map = toneMap(bg, fg);
    for (let i = 0; i < 3; i++) {
      const at = (v: number) => map[i].slope * v + map[i].intercept;
      expect(at(1)).toBeCloseTo(bg[i], 10);   // white paper (after the hue rotation, still 1)
      expect(at(0)).toBeCloseTo(fg[i], 10);   // black ink
    }
  });

  it('the pixel fallback (a canvas without filter) maps paper, ink, greys and colours like the filter', () => {
    const colours = { bg: parseColor('#121216')!, fg: parseColor('#ffffff')! };
    //            white paper       black ink      mid grey          red              blue
    const px = [255, 255, 255, 255, 0, 0, 0, 255, 128, 128, 128, 255, 220, 30, 30, 255, 30, 60, 220, 255];
    const data = Uint8ClampedArray.from(px);
    darkenPixels(data, colours);
    expect([...data.slice(0, 3)]).toEqual([18, 18, 22]);
    expect([...data.slice(4, 7)]).toEqual([255, 255, 255]);
    const [gr, gg, gb] = data.slice(8, 11);
    expect(Math.max(gr, gg, gb) - Math.min(gr, gg, gb)).toBeLessThanOrEqual(5);   // a grey stays grey
    expect(data[12]).toBeGreaterThan(data[13] + 60);   // red stays red (lightness inverted)
    expect(data[18]).toBeGreaterThan(data[16] + 60);   // blue stays blue
    expect([...data].filter((_, i) => i % 4 === 3)).toEqual([255, 255, 255, 255, 255]);   // alpha untouched
  });

  it('the SVG filter is made once and follows the tone', () => {
    ensureDarkFilter([0, 0, 0], [1, 1, 1]);
    ensureDarkFilter(parseColor('#121216')!, parseColor('#c9cbd3')!);
    expect(document.querySelectorAll(`#${DARK_FILTER_ID}`)).toHaveLength(1);
    const f = document.getElementById(DARK_FILTER_ID)!;
    expect(f.getAttribute('color-interpolation-filters')).toBe('sRGB');
    expect(f.querySelector('feColorMatrix')!.getAttribute('values')).toBe('180');
    const r = f.querySelector('feComponentTransfer')!.children[0];
    expect(Number(r.getAttribute('intercept'))).toBeCloseTo(0xc9 / 255, 3);
    expect(Number(r.getAttribute('slope'))).toBeCloseTo((0x12 - 0xc9) / 255, 3);
  });

  it("turns pdf.js's image corners into pixel rectangles, inside the image, leaving out tiny ones", () => {
    // an upright image from (0.2, 0.1) to (0.6, 0.4) of a 1000×2000 canvas: corners p0 = bottom-left, p1 = top-left, p2 = bottom-right
    const coords = [0.2, 0.4, 0.2, 0.1, 0.6, 0.4, /* an icon */ 0.5, 0.51, 0.5, 0.5, 0.51, 0.51];
    expect(imageRects(coords, 1000, 2000)).toEqual([{ x: 201, y: 201, w: 398, h: 598 }]);
    // clipped to the canvas
    expect(imageRects([-0.1, 0.5, -0.1, 0, 0.5, 0.5], 100, 100)).toEqual([{ x: 0, y: 1, w: 49, h: 48 }]);
    expect(imageRects(null, 100, 100)).toEqual([]);
  });
});
