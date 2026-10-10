/**
 * Removing a picture's background (client deliverable/bgremove.ts): the background found on the
 * border and flooded away, holes inside the subject kept, gradients, the keep / remove marks,
 * pictures that are transparent already, a 1×1 picture, and the soft edge only along the boundary.
 */
import { describe, it, expect } from 'vitest';
import { removeBackground, analyse, backgroundMask, composite, downscale, rgbToLab, type RGBAImage } from '../packages/client/src/deliverable/bgremove.ts';

function image(w: number, h: number, px: (x: number, y: number) => [number, number, number, number?]): RGBAImage {
  const data = new Uint8ClampedArray(w * h * 4);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const [r, g, b, a] = px(x, y);
    const i = (y * w + x) * 4;
    data[i] = r; data[i + 1] = g; data[i + 2] = b; data[i + 3] = a ?? 255;
  }
  return { data, width: w, height: h };
}
const alpha = (im: RGBAImage, x: number, y: number) => im.data[(y * im.width + x) * 4 + 3];

/** a red disc (radius 60) on white with a white square hole in its middle */
const logo = () => image(200, 160, (x, y) => {
  const inDisc = (x - 100) ** 2 + (y - 80) ** 2 <= 60 * 60;
  const inHole = Math.abs(x - 100) <= 15 && Math.abs(y - 80) <= 15;
  return inDisc && !inHole ? [220, 40, 60] : [255, 255, 255];
});

describe('background removal', () => {
  it('removes the white around a logo and keeps the logo and the hole inside it', () => {
    const { image: out, allBackground } = removeBackground(logo());
    expect(allBackground).toBe(false);
    expect(alpha(out, 2, 2)).toBe(0);             // corner: background
    expect(alpha(out, 100, 10)).toBe(0);          // above the disc
    expect(alpha(out, 100, 40)).toBe(255);        // the disc
    expect(alpha(out, 100, 80)).toBe(255);        // the enclosed white hole stays
    expect(alpha(out, 160, 80) === 0 || alpha(out, 160, 80) === 255).toBe(true);
  });

  it('finds the background colour from the border', () => {
    const an = analyse(logo());
    expect(an.border.length).toBe(1);
    const white = rgbToLab(255, 255, 255);
    expect(Math.abs(an.border[0][0] - white[0])).toBeLessThan(1);
  });

  it('removes a gradient background but not the subject', () => {
    // like the red-team photo: a 2D gradient, a skin-coloured disc, a dark body touching the bottom
    const im = image(240, 180, (x, y) => {
      if ((x - 120) ** 2 + (y - 60) ** 2 <= 30 * 30) return [230, 190, 160];
      if (x >= 90 && x <= 150 && y >= 95) return [60, 60, 70];
      return [40 + Math.floor(x / 2.4), 120 + Math.floor(y / 3), 200];
    });
    const { image: out } = removeBackground(im);
    expect(alpha(out, 5, 5)).toBe(0);
    expect(alpha(out, 230, 10)).toBe(0);
    expect(alpha(out, 60, 120)).toBe(0);          // the middle of the gradient, far from the border colours
    expect(alpha(out, 120, 60)).toBe(255);        // face
    expect(alpha(out, 120, 150)).toBe(255);       // body (touches the border, but is not background-coloured)
  });

  it('a "remove" mark takes the enclosed hole as well; a "keep" mark protects what the fill would take', () => {
    const removed = removeBackground(logo(), { remove: [{ points: [[100, 80]], radius: 4 }] }).image;
    expect(alpha(removed, 100, 80)).toBe(0);
    expect(alpha(removed, 90, 72)).toBe(0);       // the whole hole, not just the mark
    expect(alpha(removed, 100, 40)).toBe(255);    // the disc stays
    // a white patch touching the border (a white collar) would go — kept by a mark
    const im = image(200, 160, (x, y) => (x >= 80 && x <= 120 && y >= 100 ? [255, 255, 255] : (x - 100) ** 2 + (y - 70) ** 2 <= 50 * 50 ? [30, 30, 200] : [255, 255, 255]));
    expect(alpha(removeBackground(im).image, 100, 150)).toBe(0);
    const kept = removeBackground(im, { keep: [{ points: [[100, 120], [100, 155]], radius: 30 }] }).image;
    expect(alpha(kept, 100, 150)).toBe(255);
    expect(alpha(kept, 5, 5)).toBe(0);
  });

  it('keeps the transparency a picture already has and removes nothing more when the border is transparent', () => {
    const im = image(120, 120, (x, y) => (y > 10 && Math.abs(x - 60) < (y - 10) / 2 ? [30, 144, 255, 255] : [0, 0, 0, 0]));
    const { image: out } = removeBackground(im);
    for (let i = 3; i < out.data.length; i += 4) expect(out.data[i]).toBe(im.data[i]);
  });

  it('removes a white background around a picture that is partly transparent already', () => {
    const im = image(100, 100, (x, y) => (x < 10 ? [0, 0, 0, 0] : (x - 55) ** 2 + (y - 50) ** 2 < 400 ? [0, 120, 0] : [255, 255, 255]));
    const { image: out } = removeBackground(im);
    expect(alpha(out, 3, 50)).toBe(0);
    expect(alpha(out, 30, 10)).toBe(0);
    expect(alpha(out, 55, 50)).toBe(255);
  });

  it('a 1×1 picture (or one colour only) stays as it is', () => {
    const one = image(1, 1, () => [10, 20, 30]);
    const r = removeBackground(one);
    expect(r.image.width).toBe(1);
    expect(Array.from(r.image.data)).toEqual([10, 20, 30, 255]);
    expect(r.allBackground).toBe(true);
    const flat = removeBackground(image(30, 20, () => [200, 200, 200]));
    expect(flat.allBackground).toBe(true);
    expect(alpha(flat.image, 15, 10)).toBe(255);
  });

  it('the soft edge: partial alpha only along the boundary, decontaminated colours', () => {
    // a blue square on white, its left edge anti-aliased (one column half blue, half white)
    const im = image(120, 100, (x, y) => {
      if (y < 30 || y > 70) return [255, 255, 255];
      if (x === 39) return [128, 128, 255];
      return x >= 40 && x <= 80 ? [0, 0, 255] : [255, 255, 255];
    });
    const { image: out } = removeBackground(im);
    let partial = 0;
    for (let y = 0; y < 100; y++) for (let x = 0; x < 120; x++) {
      const a = alpha(out, x, y);
      if (a > 0 && a < 255) {
        partial++;
        // within 3 px of the square's outline
        const dx = x < 40 ? 40 - x : x > 80 ? x - 80 : 0, dy = y < 30 ? 30 - y : y > 70 ? y - 70 : 0;
        const inside = x >= 40 && x <= 80 && y >= 30 && y <= 70;
        const toEdge = inside ? Math.min(x - 40, 80 - x, y - 30, 70 - y) : Math.max(dx, dy);
        expect(toEdge).toBeLessThanOrEqual(3);
      }
    }
    expect(partial).toBeGreaterThan(0);
    // the half-blue column: about half transparent, its colour pure blue again
    const a = alpha(out, 39, 50);
    expect(a).toBeGreaterThan(60);
    expect(a).toBeLessThan(200);
    const i = (50 * 120 + 39) * 4;
    expect(out.data[i]).toBeLessThan(80);
    expect(out.data[i + 2]).toBeGreaterThan(200);
    expect(alpha(out, 60, 50)).toBe(255);
    expect(alpha(out, 10, 50)).toBe(0);
  });

  it('analyses a large picture at most 1600 px wide and brings the mask back to full size', () => {
    const big = image(3200, 400, (x, y) => ((x - 1600) ** 2 / 4 + (y - 200) ** 2 <= 150 ** 2 ? [200, 30, 30] : [250, 250, 250]));
    const an = analyse(big);
    expect(an.width).toBe(1600);
    expect(an.height).toBe(200);
    const m = backgroundMask(an);
    const { image: out } = composite(big, an, m);
    expect(out.width).toBe(3200);
    expect(alpha(out, 10, 10)).toBe(0);
    expect(alpha(out, 1600, 200)).toBe(255);
    // a preview at the analysis size works on the same mask
    expect(composite(an.image, an, m).image.width).toBe(1600);
  });

  it('the tolerance decides how close to the background a colour must be', () => {
    // a light grey halo around the disc: removed with a high tolerance, kept with a low one
    const im = image(160, 160, (x, y) => {
      const d = Math.hypot(x - 80, y - 80);
      return d <= 40 ? [20, 20, 20] : d <= 55 ? [215, 215, 215] : [255, 255, 255];
    });
    expect(alpha(removeBackground(im, { tolerance: 5 }).image, 80, 30)).toBe(255);
    expect(alpha(removeBackground(im, { tolerance: 40 }).image, 80, 30)).toBe(0);
    expect(alpha(removeBackground(im, { tolerance: 40 }).image, 80, 80)).toBe(255);
  });

  it('downscale averages with alpha weights', () => {
    const im = image(4, 2, (x) => (x % 2 ? [255, 0, 0, 255] : [0, 0, 255, 0]));
    const d = downscale(im, 2);
    expect(d.width).toBe(2);
    expect(d.data[0]).toBe(255);   // the transparent blue does not tint it
    expect(d.data[3]).toBeGreaterThan(100);
  });
});
