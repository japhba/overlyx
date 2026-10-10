/**
 * Cropping pictures of HTML deliverables (client deliverable/runtime/crop.ts): the geometry of
 * moving the picture under the frame, scaling it about a corner, moving the frame's sides, aspect
 * presets — and the markup: a picture wrapped in its crop frame the first time, both styles changed
 * after that, Reset crop back to a plain picture; its other styles, id and classes kept.
 */
import { describe, it, expect } from 'vitest';
import { panPicture, scalePicture, resizeFrame, presetFrame, cropOps, uncropOps, parseStyle, MIN_FRAME, type Box, type CropSource } from '../packages/client/src/deliverable/runtime/crop.ts';
import { applyOp, parseSource, elementAt, elementChildren, attr } from '../packages/core/src/html/source.ts';
import type { HtmlOp } from '../packages/core/src/html/source.ts';

const page = (inner: string) => `<!doctype html>\n<html>\n<head><title>t</title></head>\n<body>\n  <section class="slide">\n    <h1>Title</h1>\n    ${inner}\n  </section>\n</body>\n</html>\n`;
const apply = (text: string, ops: HtmlOp[]) => ops.reduce((t, op) => applyOp(t, op), text);
/** the slide's second element (after the h1) */
const OBJ = [1, 0, 1];
const objOf = (text: string) => elementAt(parseSource(text).doc, OBJ)!;
const styleMap = (s: string | null) => Object.fromEntries(parseStyle(s));
const attrsOf = (text: string, path: number[]) => { const el = elementAt(parseSource(text).doc, path)!; return el.attrs.map(a => [a.name, a.value] as [string, string]); };

const IMG = '<img src="images/photo.jpg" alt="A photo" id="p1" class="hero shadowed" data-x="1" style="position: absolute; left: 100px; top: 50px; width: 400px; opacity: 0.8; transform: rotate(10deg); border-radius: 8px; object-fit: cover; filter: grayscale(1)">';
const bare = (text: string): CropSource => ({ path: OBJ, wrapped: false, attrs: attrsOf(text, OBJ), position: 'absolute', ratio: 0.75 });

describe('crop geometry', () => {
  const F: Box = { x: 150, y: 100, w: 200, h: 100 };
  const P: Box = { x: 100, y: 50, w: 400, h: 300 };

  it('moves the picture under the frame, never uncovering it', () => {
    expect(panPicture(F, P, 20, 10)).toEqual({ x: 120, y: 60, w: 400, h: 300 });
    // as far as the frame's left edge, no further
    expect(panPicture(F, P, 500, 0).x).toBe(150);
    // as far as the picture's right edge reaching the frame's right edge
    expect(panPicture(F, P, -500, 0).x).toBe(F.x + F.w - P.w);
    expect(panPicture(F, P, 0, -999).y).toBe(F.y + F.h - P.h);
  });

  it('scales the picture about the opposite corner, keeping its aspect and covering the frame', () => {
    const big = scalePicture(F, P, 'se', 40, 30);
    expect(big.x).toBe(100); expect(big.y).toBe(50);
    expect(big.w).toBeCloseTo(440); expect(big.h).toBeCloseTo(330);
    const nw = scalePicture(F, P, 'nw', -40, -30);
    expect(nw.x + nw.w).toBeCloseTo(500); expect(nw.y + nw.h).toBeCloseTo(350);
    expect(nw.w / nw.h).toBeCloseTo(4 / 3);
    // shrinking stops where the picture would no longer cover the frame
    const small = scalePicture(F, P, 'se', -1000, -1000);
    expect(small.x + small.w).toBeGreaterThanOrEqual(F.x + F.w - 1e-9);
    expect(small.y + small.h).toBeGreaterThanOrEqual(F.y + F.h - 1e-9);
    expect(small.w / small.h).toBeCloseTo(4 / 3);
  });

  it('moves the frame\'s sides, kept on the picture and at least MIN_FRAME', () => {
    expect(resizeFrame(F, P, 'e', 30, 0)).toEqual({ x: 150, y: 100, w: 230, h: 100 });
    expect(resizeFrame(F, P, 'w', -999, 0).x).toBe(P.x);
    expect(resizeFrame(F, P, 's', 0, 999).h).toBe(P.y + P.h - F.y);
    expect(resizeFrame(F, P, 'n', 0, 999).h).toBe(MIN_FRAME);
    const c = resizeFrame(F, P, 'se', 50, 0, true);
    expect(c.w / c.h).toBeCloseTo(2);
    expect(c.x).toBe(150); expect(c.y).toBe(100);
    // keeping the shape stops at the picture's edge
    const huge = resizeFrame(F, P, 'se', 999, 999, true);
    expect(huge.x + huge.w).toBeLessThanOrEqual(P.x + P.w + 1e-9);
    expect(huge.y + huge.h).toBeLessThanOrEqual(P.y + P.h + 1e-9);
    expect(huge.w / huge.h).toBeCloseTo(2);
    const edge = resizeFrame(F, P, 'e', 100, 0, true);
    expect(edge.w / edge.h).toBeCloseTo(2);
    expect(edge.y + edge.h / 2).toBeCloseTo(150);
  });

  it('aspect presets: the largest frame of that shape on the picture, about the frame\'s middle', () => {
    const sq = presetFrame(F, P, 1);
    expect(sq.w).toBe(300); expect(sq.h).toBe(300);
    expect(sq.x).toBe(100); expect(sq.y).toBe(50);   // clamped onto the picture
    const wide = presetFrame(F, P, 16 / 9);
    expect(wide.w).toBe(400); expect(wide.h).toBeCloseTo(225);
    expect(presetFrame(F, P, null)).toBe(F);
  });
});

describe('crop markup', () => {
  it('wraps a picture in its frame the first time, moving placement to the frame and the look to the picture', () => {
    const text = page(IMG);
    const out = apply(text, cropOps(bare(text), { x: 150, y: 80, w: 200, h: 150 }, { x: 100, y: 50, w: 400, h: 300 }));
    const frame = objOf(out);
    expect(frame.tagName).toBe('div');
    expect(attr(frame, 'class')).toBe('ol-crop hero shadowed');
    expect(attr(frame, 'id')).toBe('p1');
    const fs = styleMap(attr(frame, 'style'));
    expect(fs).toMatchObject({ position: 'absolute', left: '150px', top: '80px', width: '200px', height: '150px', overflow: 'hidden', opacity: '0.8', transform: 'rotate(10deg)', 'border-radius': '8px' });
    expect(fs['object-fit']).toBeUndefined();
    const img = elementChildren(frame)[0];
    expect(img.tagName).toBe('img');
    expect(attr(img, 'src')).toBe('images/photo.jpg');
    expect(attr(img, 'alt')).toBe('A photo');
    expect(attr(img, 'data-x')).toBe('1');
    expect(attr(img, 'id')).toBeNull();
    const is = styleMap(attr(img, 'style'));
    expect(is).toMatchObject({ position: 'absolute', left: '-50px', top: '-30px', width: '400px', height: 'auto', 'max-width': 'none', 'object-fit': 'cover', filter: 'grayscale(1)' });
    expect(is.opacity).toBeUndefined();
    // the rest of the page untouched
    expect(out.startsWith(text.slice(0, text.indexOf('<img')))).toBe(true);
    expect(out.endsWith(text.slice(text.indexOf('>', text.indexOf('<img')) + 1))).toBe(true);
  });

  it('crops a cropped picture again by changing the two styles (its transform stays)', () => {
    const text = page(IMG);
    const once = apply(text, cropOps(bare(text), { x: 150, y: 80, w: 200, h: 150 }, { x: 100, y: 50, w: 400, h: 300 }));
    const src: CropSource = { path: OBJ, wrapped: true, attrs: attrsOf(once, OBJ), imgPath: [...OBJ, 0], imgAttrs: attrsOf(once, [...OBJ, 0]), position: 'absolute', ratio: 0.75 };
    const ops = cropOps(src, { x: 160, y: 90, w: 120.333, h: 90 }, { x: 60, y: 20, w: 480, h: 360 });
    expect(ops.map(o => o.t)).toEqual(['style', 'style']);
    const twice = apply(once, ops);
    const frame = objOf(twice);
    const fs = styleMap(attr(frame, 'style'));
    expect(fs).toMatchObject({ left: '160px', top: '90px', width: '120.33px', height: '90px', transform: 'rotate(10deg)', opacity: '0.8' });
    expect(styleMap(attr(elementChildren(frame)[0], 'style'))).toMatchObject({ left: '-100px', top: '-70px', width: '480px', height: 'auto' });
  });

  it('a distorted picture keeps its height; a circle frame and back', () => {
    const text = page('<img src="a.png" style="position: absolute; left: 0px; top: 0px; width: 300px; height: 300px">');
    const src = { ...bare(text), ratio: 0.5 };
    const out = apply(text, cropOps(src, { x: 0, y: 0, w: 200, h: 200 }, { x: 0, y: 0, w: 300, h: 300 }, 'circle'));
    const frame = objOf(out);
    expect(styleMap(attr(frame, 'style'))['border-radius']).toBe('50%');
    expect(styleMap(attr(elementChildren(frame)[0], 'style')).height).toBe('300px');
    const w: CropSource = { path: OBJ, wrapped: true, attrs: attrsOf(out, OBJ), imgPath: [...OBJ, 0], imgAttrs: attrsOf(out, [...OBJ, 0]), position: 'absolute', ratio: 0.5 };
    const back = apply(out, cropOps(w, { x: 0, y: 0, w: 200, h: 200 }, { x: 0, y: 0, w: 300, h: 300 }, 'rect'));
    expect(styleMap(attr(objOf(back), 'style'))['border-radius']).toBeUndefined();
  });

  it('Reset crop: the whole picture as a plain <img> at the frame\'s top-left, at its current scale', () => {
    const text = page(IMG);
    const once = apply(text, cropOps(bare(text), { x: 150, y: 80, w: 200, h: 150 }, { x: 100, y: 50, w: 400, h: 300 }));
    const src: CropSource = { path: OBJ, wrapped: true, attrs: attrsOf(once, OBJ), imgPath: [...OBJ, 0], imgAttrs: attrsOf(once, [...OBJ, 0]), position: 'absolute', ratio: 0.75 };
    const reset = apply(once, uncropOps(src, { x: 150, y: 80, w: 200, h: 150 }, { x: 100, y: 50, w: 400, h: 300 }));
    const img = objOf(reset);
    expect(img.tagName).toBe('img');
    expect(attr(img, 'id')).toBe('p1');
    expect(attr(img, 'class')).toBe('hero shadowed');
    expect(attr(img, 'src')).toBe('images/photo.jpg');
    const s = styleMap(attr(img, 'style'));
    expect(s).toMatchObject({ position: 'absolute', left: '150px', top: '80px', width: '400px', opacity: '0.8', transform: 'rotate(10deg)', 'border-radius': '8px', 'object-fit': 'cover', filter: 'grayscale(1)' });
    expect(s.height).toBeUndefined();
    expect(s.overflow).toBeUndefined();
    expect(uncropOps(bare(text), { x: 0, y: 0, w: 1, h: 1 }, { x: 0, y: 0, w: 1, h: 1 })).toEqual([]);
  });

  it('a picture in the flow of a web page: an inline-block frame without left / top, and back', () => {
    const text = page('<img src="b.png" alt="" style="max-width: 100%">');
    const src: CropSource = { path: OBJ, wrapped: false, attrs: attrsOf(text, OBJ), position: 'static', ratio: 0.5 };
    const out = apply(text, cropOps(src, { x: 0, y: 0, w: 300, h: 100 }, { x: -20, y: -10, w: 400, h: 200 }));
    const frame = objOf(out);
    const fs = styleMap(attr(frame, 'style'));
    expect(fs).toMatchObject({ position: 'relative', width: '300px', height: '100px', overflow: 'hidden', display: 'inline-block' });
    expect(fs.left).toBeUndefined();
    expect(fs['max-width']).toBeUndefined();
    expect(styleMap(attr(elementChildren(frame)[0], 'style'))).toMatchObject({ left: '-20px', top: '-10px', width: '400px' });
    const w: CropSource = { path: OBJ, wrapped: true, attrs: attrsOf(out, OBJ), imgPath: [...OBJ, 0], imgAttrs: attrsOf(out, [...OBJ, 0]), position: 'relative', ratio: 0.5 };
    const back = objOf(apply(out, uncropOps(w, { x: 0, y: 0, w: 300, h: 100 }, { x: -20, y: -10, w: 400, h: 200 })));
    const bs = styleMap(attr(back, 'style'));
    expect(bs.position).toBeUndefined();
    expect(bs.display).toBeUndefined();
    expect(bs.width).toBe('400px');
  });

  it('writes px rounded to hundredths, and escapes attribute values', () => {
    const text = page('<img src="x.png?a=1&amp;b=&quot;2&quot;" alt="say &quot;hi&quot;" style="position: absolute; left: 1px; top: 1px; width: 100px">');
    const ops = cropOps(bare(text), { x: 10.123456, y: 20.987654, w: 33.333333, h: 44.444444 }, { x: 1, y: 1, w: 100, h: 75 });
    const html = (ops[0] as { html: string }).html;
    expect(html).toContain('left: 10.12px'); expect(html).toContain('top: 20.99px');
    expect(html).toContain('width: 33.33px'); expect(html).toContain('height: 44.44px');
    const out = apply(text, ops);
    const img = elementChildren(objOf(out))[0];
    expect(attr(img, 'src')).toBe('x.png?a=1&b="2"');
    expect(attr(img, 'alt')).toBe('say "hi"');
  });
});
