/**
 * The presenting tools' arithmetic (packages/client/src/app/presentkit.ts): zooming about a point,
 * the clamps that keep the slide on screen, pinches, panning, wheel factors, the laser's tail ageing,
 * and that the laser looks like the whiteboard's.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { clampView, zoomAt, pinchView, panBy, wheelZoomFactor, liveTail, tailSegments, traceSvg, tailSvg, isZoomed, IDENTITY, LASER_COLOR, LASER_FADE_MS, ZOOM_MAX, type ZoomView } from '../packages/client/src/app/presentkit';

const W = 1600, H = 900;
// a 16:10 slide fitted into a 16:9 window: full height, letterboxed left and right
const base = { x: 80, y: 0, w: 1440, h: 900 };
const screenOf = (v: ZoomView, x: number, y: number) => ({ x: v.s * x + v.x, y: v.s * y + v.y });

describe('zoom about a point', () => {
  it('keeps the point under the pointer where it is', () => {
    const v = zoomAt(IDENTITY, 2, 800, 450, base, W, H);
    expect(v.s).toBe(2);
    const p = screenOf(v, 800, 450);
    expect(p.x).toBeCloseTo(800);
    expect(p.y).toBeCloseTo(450);
  });
  it('composes: zooming in twice about the same point equals one zoom by the product', () => {
    const a = zoomAt(zoomAt(IDENTITY, 1.5, 700, 400, base, W, H), 2, 700, 400, base, W, H);
    const b = zoomAt(IDENTITY, 3, 700, 400, base, W, H);
    expect(a.s).toBeCloseTo(b.s);
    expect(a.x).toBeCloseTo(b.x);
    expect(a.y).toBeCloseTo(b.y);
  });
  it('is clamped to 1×–8×, and back at 1× it is exactly the identity', () => {
    expect(zoomAt(IDENTITY, 100, 10, 10, base, W, H).s).toBe(ZOOM_MAX);
    expect(zoomAt(IDENTITY, 0.2, 10, 10, base, W, H)).toEqual(IDENTITY);
    const z = zoomAt(IDENTITY, 2, 300, 200, base, W, H);
    expect(zoomAt(z, 0.5, 900, 700, base, W, H)).toEqual(IDENTITY);
    expect(isZoomed(z)).toBe(true);
    expect(isZoomed(IDENTITY)).toBe(false);
  });
  it('a zoom about a corner of the screen leaves no gap at the slide\'s edges', () => {
    const v = zoomAt(IDENTITY, 2, 0, 0, base, W, H);
    // the slide (2880 × 1800 now) covers the window: its left edge at or left of 0, its right edge at or right of W
    const tl = screenOf(v, base.x, base.y), br = screenOf(v, base.x + base.w, base.y + base.h);
    expect(tl.x).toBeLessThanOrEqual(0.001);
    expect(tl.y).toBeLessThanOrEqual(0.001);
    expect(br.x).toBeGreaterThanOrEqual(W - 0.001);
    expect(br.y).toBeGreaterThanOrEqual(H - 0.001);
  });
});

describe('clamping and panning', () => {
  it('while smaller than the window along an axis, the slide stays wholly on screen', () => {
    // a tall poster: narrow, letterboxed; zoomed 1.2× it is still narrower than the window
    const poster = { x: 600, y: 0, w: 400, h: 900 };
    const v = panBy({ s: 1.2, x: 0, y: 0 }, -5000, 0, poster, W, H);
    const left = screenOf(v, poster.x, 0).x, right = screenOf(v, poster.x + poster.w, 0).x;
    expect(left).toBeGreaterThanOrEqual(-0.001);
    expect(right).toBeLessThanOrEqual(W + 0.001);
    const v2 = panBy({ s: 1.2, x: 0, y: 0 }, 5000, 0, poster, W, H);
    expect(screenOf(v2, poster.x + poster.w, 0).x).toBeCloseTo(W);
  });
  it('once larger, panning stops where an edge of the slide reaches the window\'s', () => {
    const v = zoomAt(IDENTITY, 3, 800, 450, base, W, H);
    const far = panBy(v, 1e6, 1e6, base, W, H);
    expect(screenOf(far, base.x, base.y).x).toBeCloseTo(0);
    expect(screenOf(far, base.x, base.y).y).toBeCloseTo(0);
    const other = panBy(v, -1e6, -1e6, base, W, H);
    expect(screenOf(other, base.x + base.w, base.y + base.h).x).toBeCloseTo(W);
    expect(screenOf(other, base.x + base.w, base.y + base.h).y).toBeCloseTo(H);
  });
  it('nothing to zoom (no slide): the identity', () => {
    expect(clampView({ s: 3, x: 10, y: 10 }, null, W, H)).toEqual(IDENTITY);
  });
});

describe('pinch', () => {
  it('spreading the fingers to twice their distance doubles the zoom about where they began', () => {
    const c = { x: 500, y: 300 };
    const v = pinchView(IDENTITY, 100, 200, c, c, base, W, H);
    expect(v.s).toBeCloseTo(2);
    const p = screenOf(v, 500, 300);
    expect(p.x).toBeCloseTo(500);
    expect(p.y).toBeCloseTo(300);
  });
  it('moving both fingers together pans by as much (when zoomed)', () => {
    const v0 = zoomAt(IDENTITY, 2, 800, 450, base, W, H);
    const v = pinchView(v0, 100, 100, { x: 800, y: 450 }, { x: 830, y: 420 }, base, W, H);
    expect(v.s).toBeCloseTo(2);
    expect(v.x - v0.x).toBeCloseTo(30);
    expect(v.y - v0.y).toBeCloseTo(-30);
  });
});

describe('wheel', () => {
  it('a pinch out (negative deltaY) zooms in, a pinch in zooms out, bounded per event', () => {
    expect(wheelZoomFactor(-10)).toBeGreaterThan(1);
    expect(wheelZoomFactor(10)).toBeLessThan(1);
    expect(wheelZoomFactor(-100000)).toBe(1.6);
    expect(wheelZoomFactor(100000)).toBe(0.6);
    // lines are 16 px
    expect(wheelZoomFactor(-1, 1)).toBeCloseTo(wheelZoomFactor(-16, 0));
  });
});

describe('the laser', () => {
  it('the tail keeps only the points younger than its age, fading towards the oldest', () => {
    const pts = [{ x: 0, y: 0, t: 0 }, { x: 10, y: 0, t: 200 }, { x: 20, y: 0, t: 400 }, { x: 30, y: 0, t: 600 }];
    expect(liveTail(pts, 650, 500).map(p => p.x)).toEqual([10, 20, 30]);
    const segs = tailSegments(pts, 650, 500);
    expect(segs).toHaveLength(2);
    expect(segs[0].a).toBeLessThan(segs[1].a);
    expect(segs[1].a).toBeCloseTo(0.9);
    expect(tailSegments(pts, 5000, 500)).toEqual([]);
    expect(tailSvg(pts, 5000)).toBe('');
    expect(tailSvg(pts, 650)).toContain('<line');
  });
  it('draws a held trace as the board does: a wide soft glow, a bright core, a dot with a white centre', () => {
    const svg = traceSvg([{ x: 0, y: 0 }, { x: 10, y: 5 }, { x: 20, y: 0 }]);
    expect(svg).toContain('class="glow"');
    expect(svg).toContain('stroke-width="11"');
    expect(svg).toContain('stroke-width="3.2"');
    expect(svg).toContain('fill="#fff"');
    expect(svg).toContain(LASER_COLOR);
    // a single point: the dot only
    expect(traceSvg([{ x: 3, y: 4 }])).not.toContain('<path');
  });
  it('has the whiteboard\'s colour and fade time', () => {
    const ink = readFileSync(new URL('../packages/client/src/editor/plugins/ink.ts', import.meta.url), 'utf8');
    expect(ink).toContain(`export const LASER_COLOR = '${LASER_COLOR}'`);
    expect(ink).toContain(`export const LASER_FADE_MS = ${LASER_FADE_MS}`);
  });
});
