/**
 * The zoom levels a pinch stops at outside the PDF viewer (pdfzoom.test.ts): a slide's or a poster's
 * (packages/client/src/deliverable/viewport.ts — Fit, Fit width, Fit content, Trim margins) and a
 * document's text (packages/client/src/app/shellutil.tsx — 100 %).
 */
import { describe, it, expect } from 'vitest';
import { viewLevels, viewDetents, levelAt, levelAnchor, CONTENT_SIDE } from '../packages/client/src/deliverable/viewport.ts';
import { stepOnto, DetentPinch } from '../packages/client/src/app/zoomdetent.ts';
import { stepTextZoom } from '../packages/client/src/app/shellutil.tsx';

describe("a slide's zoom levels", () => {
  const box = { w: 1000, h: 600 };
  it('a portrait poster: the whole of it, its width, what is on it, as wide as the canvas — all apart', () => {
    const l = viewLevels(box, { w: 800, h: 1200 }, { w: 400, h: 300 }, 8);
    expect(l.fit).toBeCloseTo(0.5, 9);
    expect(l.width).toBeCloseTo(1.25, 9);
    expect(l.content).toBeCloseTo((600 - 2 * CONTENT_SIDE) / 300, 9);
    expect(l.margins).toBeCloseTo((1000 - 2 * CONTENT_SIDE) / 400, 9);
    expect(viewDetents(l).map(d => d.key)).toEqual(['fit', 'width', 'content', 'margins']);
    expect(levelAt(l, l.content!)).toBe('content');
    expect(levelAt(l, l.content! * 1.02)).toBeNull();
  });
  it('a wide slide with its content all over it: one level, Fit (the others as near as a pinch catches)', () => {
    const l = viewLevels({ w: 1000, h: 700 }, { w: 1280, h: 720 }, { w: 1270, h: 700 }, 8);
    expect(viewDetents(l).map(d => d.key)).toEqual(['fit']);
    expect(levelAt(l, l.width!)).toBe('fit');
  });
  it('nothing on the slide: Fit and Fit width only; never past the zoom allowed', () => {
    expect(viewLevels(box, { w: 1280, h: 720 }, null, 8).content).toBeUndefined();
    expect(viewLevels(box, { w: 1280, h: 720 }, { w: 2, h: 2 }, 8).content).toBe(8);
  });
  it('Fit content puts what is on the slide in the middle; the widths keep where the view is up and down', () => {
    const slide = { x: 48, y: 48, w: 800, h: 1200 }, content = { x: 248, y: 498, w: 400, h: 300 };
    expect(levelAnchor('fit', slide, content)).toEqual({ x: 448, y: 648 });
    expect(levelAnchor('content', slide, content)).toEqual({ x: 448, y: 648 });
    expect(levelAnchor('width', slide, content)).toEqual({ x: 448, y: null });
    expect(levelAnchor('margins', slide, { ...content, x: 100 })).toEqual({ x: 300, y: null });
  });
  it('a pinch from the whole poster stops at Fit width and holds there; a step stops at Fit content', () => {
    const ds = viewDetents(viewLevels(box, { w: 800, h: 1200 }, { w: 400, h: 300 }, 8));
    const p = new DetentPinch<string>('fit', 0.5, [0.25, 8]);
    let sh = p.by(Math.log(1.5), ds);           // let go of Fit (its hold: ×1.35)
    for (let i = 0; i < 20 && typeof sh.zoom !== 'string'; i++) sh = p.by(0.05, ds);
    expect(sh.zoom).toBe('width');
    expect(p.end(ds)?.zoom).toBe('width');
    expect(stepOnto(1.25, 1.25, ds).zoom).toBe(1.5625);
    expect(stepOnto(1.6, 1.25, ds).zoom).toBe('content');
  });
});

describe("a document's text zoom", () => {
  it('steps 10 % at a time, not past 100 %, within 50 % … 250 %', () => {
    expect(stepTextZoom(1, 1)).toBe(1.1);
    expect(stepTextZoom(1.1, -1)).toBe(1);
    expect(stepTextZoom(1.04, -1)).toBe(1);
    expect(stepTextZoom(0.97, 1)).toBe(1);
    expect(stepTextZoom(1.37, 1)).toBe(1.47);
    expect(stepTextZoom(2.45, 1)).toBe(2.5);
    expect(stepTextZoom(0.55, -1)).toBe(0.5);
    expect(stepTextZoom(1.7, 0)).toBe(1);
  });
});
