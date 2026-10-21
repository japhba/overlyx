/** Draw and hold (core/shapesnap.ts): what a rough stroke snaps to, and what stays a stroke. */
import { describe, it, expect } from 'vitest';
import { snapShape, type Pt } from '../packages/core/src/shapesnap.ts';

/** a deterministic jitter: a hand's tremor (±`a`) and a slow wobble (±`b`) */
function hand(f: (t: number) => Pt, n = 300, a = 0.6, b = 2, seed = 1): Pt[] {
  let s = seed;
  const rnd = () => { s = (s * 16807) % 2147483647; return s / 2147483647 - 0.5; };
  return Array.from({ length: n + 1 }, (_, i) => {
    const t = i / n, [x, y] = f(t);
    return [x + a * rnd() + b * Math.sin(t * 7 + seed), y + a * rnd() + b * Math.cos(t * 5 + seed)];
  });
}
/** along the corners (closed when the last is the first), at an even pace, with rounded corners as a hand draws them */
function through(corners: Pt[], round = 4): (t: number) => Pt {
  const segs = corners.slice(1).map((p, i) => [corners[i], p] as [Pt, Pt]);
  const lens = segs.map(([a, b]) => Math.hypot(b[0] - a[0], b[1] - a[1])), total = lens.reduce((x, y) => x + y, 0);
  return t => {
    let d = t * total;
    for (let i = 0; i < segs.length; i++) {
      if (d <= lens[i] || i === segs.length - 1) {
        const [a, b] = segs[i], u = Math.min(1, d / lens[i]);
        // the corner cut a little: the last `round` units of a side lean towards the next
        const next = segs[i + 1]?.[1], left = lens[i] - d;
        if (next && left < round) { const k = (1 - left / round) * 0.5; return [b[0] + (next[0] - b[0]) * k * round / 40, b[1] + (next[1] - b[1]) * k * round / 40]; }
        return [a[0] + (b[0] - a[0]) * u, a[1] + (b[1] - a[1]) * u];
      }
      d -= lens[i];
    }
    return corners[corners.length - 1];
  };
}
const kind = (pts: Pt[], zoom = 1) => snapShape(pts, { zoom })?.kind ?? null;

describe('draw and hold', () => {
  it('a wobbly line is a line; a nearly level one is level', () => {
    const s = snapShape(hand(t => [20 + 300 * t, 100 + 8 * t], 200, 0.6, 1.5))!;
    expect(s.kind).toBe('line');
    expect(s.pts).toHaveLength(2);
    const level = snapShape(hand(t => [20 + 300 * t, 100 + 4 * t], 200, 0.4, 0.8))!;
    expect(level.pts[0][1]).toBe(level.pts[1][1]);
    // a steep one keeps its slope
    const steep = snapShape(hand(t => [20 + 200 * t, 100 + 150 * t], 200))!;
    expect(steep.kind).toBe('line');
    expect(Math.abs(steep.pts[1][1] - steep.pts[0][1])).toBeGreaterThan(140);
  });

  it('a circle, an ellipse, and a loop drawn on past its start', () => {
    expect(kind(hand(t => [200 + 80 * Math.cos(2 * Math.PI * t), 200 + 78 * Math.sin(2 * Math.PI * t)]))).toBe('circle');
    const e = snapShape(hand(t => [200 + 140 * Math.cos(2 * Math.PI * t), 200 + 60 * Math.sin(2 * Math.PI * t)]))!;
    expect(e.kind).toBe('ellipse');
    // level: its widest points on one height
    const ys = e.pts.map(p => p[1]), xs = e.pts.map(p => p[0]);
    expect(Math.max(...xs) - Math.min(...xs)).toBeGreaterThan(260);
    expect(Math.max(...ys) - Math.min(...ys)).toBeLessThan(140);
    // overshooting the start by a fifth of the way round
    expect(kind(hand(t => [200 + 80 * Math.cos(2.4 * Math.PI * t), 200 + 80 * Math.sin(2.4 * Math.PI * t)]))).toBe('circle');
    // a gap left at the end
    expect(kind(hand(t => [200 + 80 * Math.cos(1.9 * Math.PI * t), 200 + 80 * Math.sin(1.9 * Math.PI * t)]))).toBe('circle');
  });

  it('a rectangle, a square, a triangle, a diamond, a kite, a pentagon', () => {
    const r = snapShape(hand(through([[50, 50], [350, 54], [348, 200], [52, 198], [50, 50]])))!;
    expect(r.kind).toBe('rect');
    expect(r.pts).toHaveLength(5);
    // squared up and level: two heights, two x's
    expect(new Set(r.pts.map(p => Math.round(p[1]))).size).toBe(2);
    expect(new Set(r.pts.map(p => Math.round(p[0]))).size).toBe(2);
    expect(kind(hand(through([[50, 50], [250, 52], [252, 248], [48, 250], [50, 50]])))).toBe('square');
    expect(kind(hand(through([[200, 40], [330, 260], [70, 262], [200, 40]])))).toBe('triangle');
    // a diamond with right angles is a square turned by 45°; a lopsided one stays as drawn
    const dia = snapShape(hand(through([[200, 40], [320, 160], [200, 280], [80, 160], [200, 40]])))!;
    expect(dia.kind).toBe('square');
    expect(new Set(dia.pts.map(p => Math.round(p[0]))).size).toBeGreaterThan(2);
    expect(kind(hand(through([[200, 40], [380, 160], [200, 200], [80, 160], [200, 40]])))).toBe('quad');
    const pent = Array.from({ length: 6 }, (_, i) => [200 + 120 * Math.cos(-Math.PI / 2 + (i * 2 * Math.PI) / 5), 200 + 120 * Math.sin(-Math.PI / 2 + (i * 2 * Math.PI) / 5)] as Pt);
    expect(kind(hand(through(pent), 400))).toBe('polygon');
  });

  it('an arrow in one go, an L and a V', () => {
    const a = snapShape(hand(through([[40, 200], [340, 196], [300, 170], [340, 197], [300, 226]], 2), 300, 0.5, 1))!;
    expect(a.kind).toBe('arrow');
    expect(a.pts).toHaveLength(5);
    expect(a.pts[1]).toEqual(a.pts[3]);
    expect(kind(hand(through([[50, 50], [52, 250], [250, 252]], 2), 300, 0.5, 1))).toBe('polyline');
    expect(kind(hand(through([[50, 50], [150, 250], [250, 52]], 2), 300, 0.5, 1))).toBe('polyline');
  });

  it('writing, an arc, a spiral and a dot stay strokes', () => {
    // a word's worth of loops (an "ellele")
    expect(kind(hand(t => [40 + 260 * t + 18 * Math.cos(t * 30), 100 - 30 * Math.abs(Math.sin(t * 15))], 400, 0.4, 0.5))).toBeNull();
    // a half circle
    expect(kind(hand(t => [200 + 100 * Math.cos(Math.PI * t), 200 - 100 * Math.sin(Math.PI * t)]))).toBeNull();
    // an S
    expect(kind(hand(t => [200 + 60 * Math.sin(2 * Math.PI * t), 80 + 240 * t]))).toBeNull();
    // a spiral
    expect(kind(hand(t => [200 + (30 + 60 * t) * Math.cos(5 * Math.PI * t), 200 + (30 + 60 * t) * Math.sin(5 * Math.PI * t)], 500))).toBeNull();
    // too small on the screen to be a shape: a dot, or a circle seen at a twentieth of its size
    expect(kind([[10, 10], [11, 10], [10, 11]])).toBeNull();
    expect(kind(hand(t => [200 + 60 * Math.cos(2 * Math.PI * t), 200 + 60 * Math.sin(2 * Math.PI * t)]), 0.05)).toBeNull();
  });

  it('snaps the same at any scale', () => {
    const big = hand(t => [2000 + 800 * Math.cos(2 * Math.PI * t), 2000 + 400 * Math.sin(2 * Math.PI * t)], 300, 6, 20);
    expect(kind(big, 0.1)).toBe('ellipse');
    const small = big.map(([x, y]) => [x / 10, y / 10] as Pt);
    expect(kind(small, 1)).toBe('ellipse');
  });
});
