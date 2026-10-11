/**
 * The one-slide canvas's place (packages/client/src/deliverable/viewport.ts): Apple's rubber band
 * past the pan range, its inverse (a pull caught mid-spring goes on from where it shows), the range
 * itself, and the spring that brings the slide back.
 */
import { describe, it, expect } from 'vitest';
import { rubber, banded, unband, panRange, spring, clampTo } from '../packages/client/src/deliverable/viewport.ts';

describe('the slide canvas', () => {
  it('pulls past an edge against a growing resistance, never as far as the canvas', () => {
    expect(rubber(0, 800)).toBe(0);
    const a = rubber(100, 800), b = rubber(200, 800), c = rubber(5000, 800);
    expect(a).toBeGreaterThan(0); expect(a).toBeLessThan(100);
    expect(b - a).toBeLessThan(a);           // each further px shows less
    expect(c).toBeLessThan(800);
    expect(rubber(-100, 800)).toBeCloseTo(-a, 9);
  });
  it('pans freely inside its range, on the band outside it, and the band can be undone', () => {
    const r: [number, number] = [-150, 150];
    expect(banded(80, r, 800)).toBe(80);
    expect(banded(250, r, 800)).toBeCloseTo(150 + rubber(100, 800), 9);
    for (const raw of [-900, -300, -151, 0, 149, 260, 1200]) expect(unband(banded(raw, r, 800), r, 800)).toBeCloseTo(raw, 6);
  });
  it('has no range when the slide fits (it stays in the middle), else as much as overflows', () => {
    expect(panRange(700, 1000, 32)).toEqual([0, 0]);
    expect(panRange(1200, 1000, 32)).toEqual([-132, 132]);
    expect(clampTo(500, panRange(1200, 1000, 32))).toBe(132);
  });
  it('springs back with a small overshoot and settles within half a second', () => {
    const xs = [0, 0.05, 0.1, 0.2, 0.3, 0.45, 0.6].map(t => spring(100, t));
    expect(xs[0]).toBe(100);
    expect(Math.min(...xs)).toBeLessThan(0);   // overshoots the middle a little
    expect(Math.min(...xs)).toBeGreaterThan(-15);
    expect(Math.abs(spring(100, 0.6))).toBeLessThan(2);
  });
});
