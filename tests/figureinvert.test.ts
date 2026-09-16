/**
 * Smart invert for figures in the dark theme (client/editor/figureinvert.ts): line art — dark
 * strokes on a light or transparent ground — is recognised from its pixels, photographs are not.
 * And the graphics reload (client/projectevents.ts): which file-change event concerns which inset.
 */
import { describe, it, expect } from 'vitest';
import { classifyPixels } from '../packages/client/src/editor/figureinvert.ts';
import { sameGraphicsFile } from '../packages/client/src/projectevents.ts';

/** an RGBA buffer painted by `px(x, y) → [r, g, b, a]` */
function image(w: number, h: number, px: (x: number, y: number) => [number, number, number, number]): Uint8ClampedArray {
  const d = new Uint8ClampedArray(w * h * 4);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) { const [r, g, b, a] = px(x, y); const i = (y * w + x) * 4; d[i] = r; d[i + 1] = g; d[i + 2] = b; d[i + 3] = a; }
  return d;
}
const white: [number, number, number, number] = [255, 255, 255, 255];
const black: [number, number, number, number] = [0, 0, 0, 255];

describe('classifyPixels', () => {
  it('black lines on white are line art; so are coloured plot lines on white', () => {
    expect(classifyPixels(image(64, 64, (x, y) => (x === 10 || y === 50 ? black : white)))).toBe('lineart');
    expect(classifyPixels(image(64, 64, (x, y) => (y === Math.round(x / 2) ? [31, 119, 180, 255] : x === 5 ? black : white)))).toBe('lineart');
  });
  it('black strokes on a transparent ground are line art (the page shows through)', () => {
    expect(classifyPixels(image(64, 64, (x) => (x % 16 === 0 ? black : [0, 0, 0, 0])))).toBe('lineart');
  });
  it('a photograph — greys and colours everywhere, hardly any white — is left alone', () => {
    expect(classifyPixels(image(64, 64, (x, y) => [(x * 4) % 256, (y * 4) % 256, ((x + y) * 2) % 256, 255]))).toBe('photo');
    expect(classifyPixels(image(64, 64, (x, y) => { const v = 60 + ((x * 7 + y * 3) % 120); return [v, v, v, 255]; }))).toBe('photo');
  });
  it('a blank white image has nothing to invert', () => {
    expect(classifyPixels(image(16, 16, () => white))).toBe('photo');
  });
  it('a mostly coloured picture on white (a heat map) is not line art', () => {
    expect(classifyPixels(image(64, 64, (x, y) => (y < 8 ? white : [255, (x * 4) % 256, 40, 255])))).toBe('photo');
  });
});

describe('sameGraphicsFile', () => {
  it('matches the same path, with or without ./ and the extension the document left out', () => {
    expect(sameGraphicsFile('figs/plot.png', 'figs/plot.png')).toBe(true);
    expect(sameGraphicsFile('figs/plot.png', './figs/plot.png')).toBe(true);
    expect(sameGraphicsFile('figs/plot.pdf', 'figs/plot')).toBe(true);
    expect(sameGraphicsFile('figs/plot.pdf', 'figs/plot.png')).toBe(false);
    expect(sameGraphicsFile('figs/plot2.png', 'figs/plot')).toBe(false);
    expect(sameGraphicsFile('other/plot.png', 'figs/plot.png')).toBe(false);
  });
});
