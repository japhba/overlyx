// @vitest-environment happy-dom
/**
 * Dark PDF pages (client/src/app/pdfdark.ts): the colour map of the SVG filter (paper → the editor's
 * page colour, ink → its text tone), reading the theme's colours, and where pdf.js drew the raster
 * images (the photographs that keep their colours).
 */
import { describe, it, expect } from 'vitest';
import { parseColor, toneMap, imageRects, formRects, texture, PHOTO_TEXTURE, ensureDarkFilter, darkenPixels, DARK_FILTER_ID } from '../packages/client/src/app/pdfdark.ts';

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

  // pdf.js operator codes: save 10, restore 11, transform 12, form begin/end 74/75, group begin/end 76/77
  const ops = (list: [number, unknown[] | null][]) => ({ fnArray: list.map(o => o[0]), argsArray: list.map(o => o[1]) });
  /** a 600×800 pt page at scale 1, y downwards (the viewport's transform) */
  const BASE = [1, 0, 0, -1, 0, 800];

  it('finds the included figures: a form placed by the page, through the transforms around it', () => {
    const figure = ops([
      [10, null], [12, [0.5, 0, 0, 0.5, 100, 200]],   // \includegraphics scales and places
      [74, [null, [0, 0, 400, 300]]], [10, null], [11, null], [75, []],
      [11, null],
    ]);
    // box (100,200)–(300,350) in pt → y flipped: 450..600 px
    expect(formRects(figure, BASE, 600, 800)).toEqual([{ x: 101, y: 451, w: 198, h: 148 }]);
  });

  it('a figure with a transparency group: the group has the box, the form inside none; nested forms do not count again', () => {
    const grouped = ops([
      [76, [{ bbox: [0, 0, 400, 200], matrix: [1, 0, 0, 1, 50, 100] }]],
      [74, [[1, 0, 0, 1, 50, 100], null]],
      [74, [null, [0, 0, 400, 200]]], [75, []],   // an inner form with the same box
      [75, []],
      [77, [{}]],
    ]);
    const r = formRects(grouped, BASE, 600, 800);
    expect(r).toHaveLength(1);
    expect(r[0]).toEqual({ x: 51, y: 501, w: 398, h: 198 });
  });

  it('leaves out forms that cover the page (a template, an included page) and tiny ones (a logo)', () => {
    const page = ops([[74, [null, [0, 0, 600, 800]]], [75, []], [74, [[1, 0, 0, 1, 10, 10], [0, 0, 20, 20]]], [75, []]]);
    expect(formRects(page, BASE, 600, 800)).toEqual([]);
    expect(formRects(null, BASE, 600, 800)).toEqual([]);
  });

  it('texture: a photograph is grainy, a heat map or a chart flat between its edges', () => {
    const img = (w: number, h: number, px: (x: number, y: number) => number) => {
      const d = new Uint8ClampedArray(w * h * 4);
      for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) { const v = px(x, y), i = (y * w + x) * 4; d[i] = d[i + 1] = d[i + 2] = v; d[i + 3] = 255; }
      return d;
    };
    const noise = img(64, 64, (x, y) => (Math.sin(x * 12.9898 + y * 78.233) * 43758.5453 % 1 + 1) % 1 * 255);
    const blocks = img(64, 64, (x, y) => ((x >> 4) + (y >> 4)) % 2 ? 40 : 220);
    const smooth = img(64, 64, (x, y) => x * 4);
    expect(texture(noise, 64)).toBeGreaterThan(PHOTO_TEXTURE);
    expect(texture(blocks, 64)).toBeLessThan(PHOTO_TEXTURE);
    expect(texture(smooth, 64)).toBeLessThan(PHOTO_TEXTURE);
  });
});

