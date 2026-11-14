import { describe, expect, it } from 'vitest';
import { bgCss, parseBg, bgOfStyle, gradientCss, picturesIn, svgGradient, isGradient } from '../packages/client/src/deliverable/background';

describe('slide backgrounds (background.ts)', () => {
  it('writes gradients and reads them back', () => {
    const lin = bgCss({ kind: 'gradient', shape: 'linear', angle: 135, stops: [{ color: '#9334e6', at: 100 }, { color: '#1a73e8', at: 0 }] })!;
    expect(lin).toBe('linear-gradient(135deg, #1a73e8 0%, #9334e6 100%)');
    expect(parseBg(lin)).toEqual({ kind: 'gradient', shape: 'linear', angle: 135, stops: [{ color: '#1a73e8', at: 0 }, { color: '#9334e6', at: 100 }] });
    const rad = gradientCss('radial', 0, [{ color: '#fff', at: 0 }, { color: 'rgb(1, 2, 3)', at: 40 }, { color: '#000', at: 100 }]);
    expect(rad).toBe('radial-gradient(circle, #fff 0%, rgb(1, 2, 3) 40%, #000 100%)');
    expect(parseBg(rad)).toMatchObject({ kind: 'gradient', shape: 'radial', stops: [{ color: '#fff', at: 0 }, { color: 'rgb(1, 2, 3)', at: 40 }, { color: '#000', at: 100 }] });
    // hand-written ones: keywords, stops without positions
    expect(parseBg('linear-gradient(to right, red, blue)')).toEqual({ kind: 'gradient', shape: 'linear', angle: 90, stops: [{ color: 'red', at: 0 }, { color: 'blue', at: 100 }] });
  });
  it('writes pictures with their fit and dimming, readable by hand, and reads them back', () => {
    const fill = bgCss({ kind: 'picture', src: 'images/hall.jpg', fit: 'fill', dim: 0.4, dimTo: 'black' })!;
    expect(fill).toBe("linear-gradient(rgba(0, 0, 0, 0.4), rgba(0, 0, 0, 0.4)), url('images/hall.jpg') center / cover no-repeat");
    expect(parseBg(fill)).toEqual({ kind: 'picture', src: 'images/hall.jpg', fit: 'fill', dim: 0.4, dimTo: 'black' });
    const fit = bgCss({ kind: 'picture', src: "images/it's.png", fit: 'fit', dim: 0, dimTo: 'white' })!;
    expect(fit).toBe("url('images/it\\'s.png') center / contain no-repeat #ffffff");
    expect(parseBg(fit)).toEqual({ kind: 'picture', src: "images/it's.png", fit: 'fit', dim: 0, dimTo: 'white' });
    const tile = bgCss({ kind: 'picture', src: 'p.png', fit: 'tile', dim: 0.2, dimTo: 'white' })!;
    expect(tile).toBe("linear-gradient(rgba(255, 255, 255, 0.2), rgba(255, 255, 255, 0.2)), url('p.png') top left / auto repeat");
    expect(parseBg(tile)).toMatchObject({ kind: 'picture', fit: 'tile', dim: 0.2, dimTo: 'white' });
  });
  it('tells colours, nothing and hand-written backgrounds apart', () => {
    expect(parseBg(null)).toEqual({ kind: 'none' });
    expect(parseBg('#123456')).toEqual({ kind: 'color', color: '#123456' });
    expect(parseBg('url(a.png), url(b.png), red')).toEqual({ kind: 'custom', css: 'url(a.png), url(b.png), red' });
    expect(bgCss({ kind: 'none' })).toBeNull();
  });
  it('finds a slide’s own background in its style', () => {
    expect(bgOfStyle('position: relative; background: linear-gradient(90deg, #fff 0%, #000 100%); color: red')).toBe('linear-gradient(90deg, #fff 0%, #000 100%)');
    expect(bgOfStyle('background-color: #eee')).toBe('#eee');
    expect(bgOfStyle('color: red')).toBeNull();
  });
  it('offers the pictures the deck already uses', () => {
    const src = `<img src="images/a.png"><img src="https://x.org/b.png"><section style="background: url('images/c.jpg') center / cover no-repeat"></section><div style="background: url(&quot;d.webp&quot;)"></div>`;
    expect(picturesIn(src)).toEqual(['images/a.png', 'images/c.jpg', 'd.webp']);
  });
  it('turns a gradient into an SVG paint server for drawings', () => {
    expect(isGradient('linear-gradient(90deg, red, blue)')).toBe(true);
    expect(isGradient('#fff')).toBe(false);
    expect(svgGradient('linear-gradient(180deg, #ffffff 0%, #000000 100%)', 'g1')).toBe('<linearGradient id="g1" gradientTransform="rotate(90 0.5 0.5)"><stop offset="0%" stop-color="#ffffff"/><stop offset="100%" stop-color="#000000"/></linearGradient>');
    expect(svgGradient('radial-gradient(circle, #fff 0%, #000 100%)', 'g2')).toMatch(/^<radialGradient id="g2" cx="0.5" cy="0.5" r="0.5">/);
    expect(svgGradient('#fff', 'g3')).toBeNull();
  });
});
