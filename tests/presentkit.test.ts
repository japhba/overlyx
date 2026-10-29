/**
 * The presenting tools' arithmetic (packages/client/src/app/presentkit.ts): zooming about a point,
 * the clamps that keep the slide on screen, pinches, panning, wheel factors, the laser's tail ageing,
 * and the laser's traces (app/laser.ts, the same in the margins and on the whiteboard): drawn as the
 * pen draws at one opacity, fading together once lifted, back when the pen comes down again in time.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { clampView, zoomAt, pinchView, panBy, wheelZoomFactor, liveTail, tailSvg, isZoomed, IDENTITY, LASER_COLOR, LASER_FADE_MS, ZOOM_MAX, type ZoomView } from '../packages/client/src/app/presentkit';
import { LaserSession, tracesSvg, LASER_W } from '../packages/client/src/app/laser';

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
  it('the tail keeps only the points younger than its age, drawn at one opacity', () => {
    const pts = [{ x: 0, y: 0, t: 0 }, { x: 10, y: 0, t: 200 }, { x: 20, y: 0, t: 400 }, { x: 30, y: 0, t: 600 }];
    expect(liveTail(pts, 650, 500).map(p => p.x)).toEqual([10, 20, 30]);
    expect(tailSvg(pts, 5000)).toBe('');
    const svg = tailSvg(pts, 650);
    expect(svg).toContain('class="glow"');
    expect(svg).not.toMatch(/stroke-opacity="(?!0\.3")/);
    expect(svg).not.toContain('<line');
  });
  it('draws traces as the pen does, over one glow, in its colour', () => {
    const s = new LaserSession();
    s.begin([[0, 0, 0.5]], false, 0);
    for (let x = 1; x <= 40; x++) s.add([x * 2, Math.sin(x / 5) * 10, 0.5], 0);
    const svg = tracesSvg(s.traces, LASER_COLOR, {});
    expect(svg).toContain(LASER_COLOR);
    expect(svg.match(/class="glow"/g)).toHaveLength(1);
    expect(svg).toContain('stroke-width="11"');
    expect(svg).toContain(`stroke-width="${LASER_W}"`);
    // a Pencil's pressure makes the width vary, as the pen's
    const p = new LaserSession();
    p.begin([[0, 0, 0.1]], true, 0);
    for (let x = 1; x <= 60; x++) p.add([x * 2, 0, x < 30 ? 0.1 + x / 40 : 0.9], 0);
    p.end(0);
    expect(new Set([...tracesSvg(p.traces, LASER_COLOR, {}).matchAll(/stroke-width="([\d.]+)"/g)].map(m => m[1])).size).toBeGreaterThan(3);
  });
  it('lifted, the traces fade out together; down again in time, they come back and the new one joins them', () => {
    const s = new LaserSession();
    s.begin([[0, 0, 0.5]], false, 0);
    s.add([10, 0, 0.5], 10);
    expect(s.alpha(500)).toBe(1);
    s.end(1000);
    expect(s.alpha(1000 + LASER_FADE_MS / 2)).toBeCloseTo(0.5);
    s.begin([[50, 50, 0.5]], false, 1000 + LASER_FADE_MS / 2);
    expect(s.traces).toHaveLength(2);
    expect(s.alpha(1000 + LASER_FADE_MS * 2)).toBe(1);
    s.end(5000);
    expect(s.gone(5000 + LASER_FADE_MS)).toBe(true);
    // too late: a session of its own
    s.begin([[0, 0, 0.5]], false, 5000 + LASER_FADE_MS + 1);
    expect(s.traces).toHaveLength(1);
  });
  it('gathers another\'s held traces by their numbers', () => {
    const s = new LaserSession();
    s.hold([[0, 0, 0.5]], false, 0, 7);
    s.hold([[0, 0, 0.5], [5, 5, 0.5]], false, 10, 7);
    expect(s.traces).toHaveLength(1);
    s.hold([[9, 9, 0.5]], false, 20, 8);
    expect(s.traces).toHaveLength(2);
    // (a sender that numbers none: one trace until it lets go)
    const o = new LaserSession();
    o.hold([[0, 0, 0.5]], false, 0);
    o.hold([[0, 0, 0.5], [1, 1, 0.5]], false, 5);
    expect(o.traces).toHaveLength(1);
    o.end(10);
    o.hold([[3, 3, 0.5]], false, 20);
    expect(o.traces).toHaveLength(2);
  });
  it('the margins\' and the whiteboard\'s laser is this one', () => {
    const ink = readFileSync(new URL('../packages/client/src/editor/plugins/ink.ts', import.meta.url), 'utf8');
    const board = readFileSync(new URL('../packages/client/src/app/BoardEditor.tsx', import.meta.url), 'utf8');
    expect(ink).toContain("from '../../app/laser'");
    expect(board).toContain("from './laser'");
    expect(LASER_FADE_MS).toBe(3000);
  });
});
