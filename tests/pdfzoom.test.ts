/**
 * The PDF viewer's zoom (packages/client/src/app/pdfzoom.ts): what is painted on a page, Fit content's
 * crops and scale (past the margins, one text size, wider content smaller), the steps with the fits
 * among them, and a pinch that snaps onto a fit, holds there (Fit content hardest), gives a little and
 * springs back.
 */
import { describe, it, expect } from 'vitest';
import { stepOnto } from '../packages/client/src/app/zoomdetent.ts';
import { inkBox, cropOf, contentLayout, fitLevels, stepZoom, zoomValue, Pinch, HOLD, CATCH, GIVE, CONTENT_PAD, SIDE, PAD, type Box } from '../packages/client/src/app/pdfzoom.ts';

/** a white RGBA image with grey pixels at `ink` */
function image(w: number, h: number, ink: [number, number][]): Uint8ClampedArray {
  const d = new Uint8ClampedArray(w * h * 4).fill(255);
  for (const [x, y] of ink) d.set([120, 120, 120, 255], (y * w + x) * 4);
  return d;
}

const LETTER = { width: 612, height: 792 };
/** an article's text block (with its page number) */
const TEXT: Box = { x: 133, y: 120, w: 345, h: 580 };

describe('what is painted on a page', () => {
  it('is the box of the pixels that are not (nearly) white; none on a blank page', () => {
    expect(inkBox(image(10, 8, [[2, 3], [7, 5], [4, 1]]), 10, 8)).toEqual({ x: 2, y: 1, w: 6, h: 5 });
    expect(inkBox(image(10, 8, []), 10, 8)).toBeNull();
    // light grey stays paper; a pale colour in one channel is ink (a yellow highlight)
    const d = image(4, 4, []);
    d.set([240, 240, 240, 255], 0);
    d.set([255, 255, 100, 255], (2 * 4 + 3) * 4);
    expect(inkBox(d, 4, 4)).toEqual({ x: 3, y: 2, w: 1, h: 1 });
  });

  it('is cropped with some room around it, within the page', () => {
    expect(cropOf(TEXT, LETTER)).toEqual({ x: 133 - CONTENT_PAD, y: 120 - CONTENT_PAD, w: 345 + 2 * CONTENT_PAD, h: 580 + 2 * CONTENT_PAD });
    expect(cropOf({ x: 2, y: 0, w: 609, h: 792 }, LETTER)).toEqual({ x: 0, y: 0, w: 612, h: 792 });
  });
});

describe('Fit content', () => {
  const pane = { width: 500, height: 900 };
  const aw = pane.width - 2 * SIDE, ah = pane.height - 2 * PAD;

  it('zooms past the margins: the typical page\'s content as big as the pane takes it, all of it', () => {
    const { geo, scale } = contentLayout([LETTER, LETTER, LETTER], [TEXT, TEXT, TEXT], pane);
    const crop = cropOf(TEXT, LETTER);
    expect(scale).toBeCloseTo(Math.min(aw / crop.w, ah / crop.h));
    expect(geo[1].crop).toEqual(crop);
    // a narrow pane: as wide as it; Fit width would have left the margins
    expect(crop.w * scale!).toBeCloseTo(aw);
    expect(scale!).toBeGreaterThan((pane.width - 28) / LETTER.width * 1.5);
    // a wide pane: as tall as it
    const wide = contentLayout([LETTER], [TEXT], { width: 1400, height: 800 });
    expect(crop.h * wide.scale!).toBeCloseTo(800 - 2 * PAD);
  });

  it('one text size: the typical page sets it; wider content is smaller (all of it shown), less content not blown up', () => {
    const table: Box = { x: 60, y: 120, w: 492, h: 580 };      // a broad table into the margins
    const figure: Box = { x: 230, y: 300, w: 150, h: 120 };     // a small figure alone
    const { geo, scale } = contentLayout([LETTER, LETTER, LETTER, LETTER, LETTER], [TEXT, table, TEXT, figure, TEXT], pane);
    expect(geo[0].scale).toBeCloseTo(scale!);
    expect(geo[2].scale).toBeCloseTo(scale!);
    expect(geo[1].scale).toBeLessThan(scale!);
    expect(geo[1].crop.w * geo[1].scale).toBeCloseTo(aw);
    expect(geo[3].scale).toBeCloseTo(scale!);
    // the page with less on it is as wide as the others, about its own middle
    expect(geo[3].crop.w).toBeCloseTo(geo[0].crop.w);
    expect(geo[3].crop.x + geo[3].crop.w / 2).toBeCloseTo(figure.x + figure.w / 2);
  });

  it('pages not measured yet take the typical crop; with none measured every page is fitted whole', () => {
    const { geo } = contentLayout([LETTER, LETTER], [TEXT, undefined], pane);
    expect(geo[1]).toEqual(geo[0]);
    const none = contentLayout([LETTER], [undefined], pane);
    expect(none.scale).toBeNull();
    expect(none.geo[0].crop).toEqual({ x: 0, y: 0, w: 612, h: 792 });
    expect(none.geo[0].scale).toBeCloseTo(Math.min(aw / 612, ah / 792));
  });

  it('twoside pages, their text block left and right by turns: each cropped to its own', () => {
    const odd: Box = { ...TEXT, x: 160 }, even: Box = { ...TEXT, x: 100 };
    const { geo } = contentLayout([LETTER, LETTER, LETTER], [odd, even, odd], pane);
    expect(geo[0].crop.x).toBe(160 - CONTENT_PAD);
    expect(geo[1].crop.x).toBe(100 - CONTENT_PAD);
    expect(geo[1].crop.w).toBe(geo[0].crop.w);
  });
});

describe('the zoom levels', () => {
  const l = { width: 1.1, content: 1.95 };

  it('the steps and the fits are one order, no step right beside a fit', () => {
    expect(stepZoom(1, 1, l)).toBe('width');
    expect(stepZoom(1.1, 1, l)).toBe(1.25);
    expect(stepZoom(1.75, 1, l)).toBe('content');
    expect(stepZoom(1.95, 1, l)).toBe(2.5);   // (2 lies beside Fit content)
    expect(stepZoom(1.95, -1, l)).toBe(1.75);
    expect(stepZoom(zoomValue('width', l), -1, l)).toBe(1);
    expect(stepZoom(3, 1, l)).toBe(3);
  });

  it('two fits that nearly coincide are one: Fit content', () => {
    expect(fitLevels({ width: 1.2, content: 1.22 })).toEqual([{ fit: 'content', z: 1.22 }]);
    // a wide pane: Fit content is the whole page's content (by its height), below Fit width
    expect(fitLevels({ width: 1.1, content: 0.9 }).map(f => f.fit)).toEqual(['content', 'width']);
  });

  it('a step (a wheel\'s notch, − / +) stops at a level on its way', () => {
    const ds = [{ key: 'fit', z: 0.6, hold: 0.3 }];
    expect(stepOnto(0.5, 1.25, ds)).toEqual({ zoom: 'fit', z: 0.6 });   // (0.625 would have passed it)
    expect(stepOnto(0.6, 1.25, ds).zoom).toBeCloseTo(0.75);
    expect(stepOnto(0.75, 0.8, ds)).toEqual({ zoom: 'fit', z: 0.6 });
    expect(stepOnto(0.3, 1.25, ds).zoom).toBeCloseTo(0.375);
  });
});

describe('a pinch through the levels', () => {
  const l = { width: 1, content: 2 };
  /** a pinch by `total` (log) in steps of `d` */
  const pinch = (p: Pinch, total: number, d = 0.02) => { let s; for (let k = 0; k < Math.round(Math.abs(total) / d); k++) s = p.by(Math.sign(total) * d, l); return s!; };

  it('snaps onto a fit it comes near, and says so', () => {
    const p = new Pinch(1.5, l);
    const s = pinch(p, Math.log(2 / 1.5) - CATCH + 0.03);
    expect(s.zoom).toBe('content');
    expect(p.held).toBe('content');
    // the next step caught: no longer news
    expect(p.by(0.01, l).caught).toBeUndefined();
  });

  it('a step past a fit is caught there too, the way past it pulling at it', () => {
    const p = new Pinch(1.8, l);
    const s = p.by(Math.log(2.2 / 1.8), l);
    expect(s).toMatchObject({ zoom: 'content', caught: 'content' });
    expect(s.stretch).toBeCloseTo(Math.exp(GIVE * Math.log(2.2 / 2)));
  });

  it('holds at Fit content until pinched well past it, giving a little meanwhile; then on from where it gave, without a jump', () => {
    const p = new Pinch('content', l);
    let s = pinch(p, HOLD.content - 0.03);
    expect(s.zoom).toBe('content');
    expect(s.stretch).toBeGreaterThan(1.05);
    expect(s.stretch).toBeLessThan(1.1);
    const before = 2 * s.stretch;
    s = pinch(p, 0.06);
    expect(typeof s.zoom).toBe('number');
    expect(s.zoom as number).toBeGreaterThan(before);
    expect(s.zoom as number).toBeLessThan(before * 1.06);
    // Fit width lets go sooner
    expect(HOLD.width).toBeLessThan(HOLD.content);
  });

  it('just left, it is not caught again by the same fit right away; further off, it is', () => {
    const p = new Pinch('content', l);
    pinch(p, HOLD.content + 0.02);
    expect(p.held).toBeNull();
    expect(p.by(-0.03, l).zoom).not.toBe('content');
    pinch(p, 3 * CATCH);
    expect(pinch(p, -4 * CATCH).zoom).toBe('content');
  });

  it('let go held: springs back onto the fit; let go near one: settles on it; elsewhere it stays', () => {
    const held = new Pinch('width', l);
    pinch(held, 0.1);
    expect(held.end(l)).toEqual({ zoom: 'width', from: Math.exp(GIVE * 0.1) });
    const near = new Pinch(1.3, l);
    near.at = Math.log(2.05);
    expect(near.end(l)).toMatchObject({ zoom: 'content' });
    expect(near.end(l)!.from).toBeCloseTo(2.05 / 2);
    expect(new Pinch(1.5, l).end(l)).toBeNull();
  });
});
