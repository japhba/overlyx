/**
 * The geometry behind the deck canvas's Inkscape tools (deliverable/runtime/pathops.ts): paths as
 * nodes with handles and back, a node put into a curve without changing it, Path ▸ Union /
 * Difference / Intersection / Exclusion, curves fitted again after a boolean, Simplify, Reverse.
 */
import { describe, it, expect } from 'vitest';
import {
  parseD, toD, parsePoints, flatten, splitAt, reverseSubs, nearestOnPath, ellipseSubs, rectSubs, mapSubs,
  areaOf, booleanOp, multiPolygonToSubs, simplifySubs, boundsOf, bezierAt, type SubPath,
} from '../packages/client/src/deliverable/runtime/pathops.ts';

const area = (subs: SubPath[]) => flatten(subs, 0.05).reduce((s, r) => {
  let a = 0;
  for (let k = 0; k < r.length; k++) { const p = r[k], q = r[(k + 1) % r.length]; a += p[0] * q[1] - q[0] * p[1]; }
  return s + Math.abs(a) / 2;
}, 0);

describe('paths as nodes', () => {
  it('reads every command and writes absolute M / L / C / Z, a closed path not repeating its first node', () => {
    const subs = parseD('m10 10 h80 v80 h-80 z M 200 200 c 0 -50 100 -50 100 0 s -100 50 -100 0 Z');
    expect(subs).toHaveLength(2);
    expect(subs[0]).toMatchObject({ closed: true });
    expect(subs[0].nodes.map(n => n.p)).toEqual([[10, 10], [90, 10], [90, 90], [10, 90]]);
    expect(toD(subs.slice(0, 1))).toBe('M10 10L90 10L90 90L10 90Z');
    expect(subs[1].nodes).toHaveLength(2);
    expect(toD(parseD(toD(subs)))).toBe(toD(subs));
  });

  it('a polygon’s points, a drawing going on after Z from where its subpath started', () => {
    expect(parsePoints('0,0 10,0 10,10', true)[0].nodes).toHaveLength(3);
    const subs = parseD('M0 0L10 0L10 10ZL0 10');
    expect(subs[1].nodes[0].p).toEqual([0, 0]);
  });

  it('a node put into a curve keeps the curve as it was', () => {
    const [sp] = parseD('M0 0C0 -50 100 -50 100 0');
    const before = bezierAt([0, 0], [0, -50], [100, -50], [100, 0], 0.3);
    const k = splitAt(sp, 0, 0.3);
    expect(k).toBe(1);
    expect(sp.nodes[1].p[0]).toBeCloseTo(before[0], 6);
    expect(sp.nodes[1].p[1]).toBeCloseTo(before[1], 6);
    const mid = bezierAt(sp.nodes[0].p, sp.nodes[0].o!, sp.nodes[1].i!, sp.nodes[1].p, 0.5);
    const orig = bezierAt([0, 0], [0, -50], [100, -50], [100, 0], 0.15);
    expect(mid[0]).toBeCloseTo(orig[0], 6);
    expect(mid[1]).toBeCloseTo(orig[1], 6);
  });

  it('finds the nearest point of the outline, reverses a path', () => {
    const subs = parseD('M0 0L100 0L100 100Z');
    const hit = nearestOnPath(subs, [50, 3])!;
    expect(hit).toMatchObject({ s: 0, k: 0 });
    expect(hit.t).toBeCloseTo(0.5);
    // the closing segment counts too
    expect(nearestOnPath(subs, [48, 52])!.k).toBe(2);
    expect(toD(reverseSubs(parseD('M0 0L10 0L20 5')))).toBe('M20 5L10 0L0 0');
  });
});

describe('Path ▸ Union, Difference, Intersection, Exclusion', () => {
  const sq = (x: number, y: number, s: number) => areaOf(flatten(rectSubs(x, y, s, s)));

  it('union and intersection of two overlapping squares', () => {
    const u = multiPolygonToSubs(booleanOp('union', [sq(0, 0, 100), sq(50, 50, 100)]));
    expect(u).toHaveLength(1);
    expect(area(u)).toBeCloseTo(17500, 0);
    expect(u[0].nodes).toHaveLength(8);
    expect(u[0].nodes.every(n => !n.i && !n.o)).toBe(true);
    const i = multiPolygonToSubs(booleanOp('intersection', [sq(0, 0, 100), sq(50, 50, 100)]));
    expect(area(i)).toBeCloseTo(2500, 0);
  });

  it('difference is the bottom object minus the others; exclusion leaves a hole', () => {
    const d = multiPolygonToSubs(booleanOp('difference', [sq(0, 0, 100), sq(25, 25, 50)]));
    expect(d).toHaveLength(2);   // outer ring and the hole (fill-rule evenodd)
    expect(area(d)).toBeCloseTo(10000 + 2500, 0);   // (both rings' areas: the hole is cut by evenodd)
    const x = multiPolygonToSubs(booleanOp('exclusion', [sq(0, 0, 100), sq(50, 50, 100)]));
    expect(x.length).toBeGreaterThanOrEqual(2);
  });

  it('curves come back as curves: a circle unioned with a square has few nodes, the arc within a fraction of a pixel', () => {
    const circle = areaOf(flatten(ellipseSubs(100, 100, 80, 80), 0.1));
    const u = multiPolygonToSubs(booleanOp('union', [circle, sq(100, 100, 120)]));
    expect(u).toHaveLength(1);
    expect(u[0].nodes.length).toBeLessThan(16);
    expect(u[0].nodes.some(n => n.o)).toBe(true);
    // a point on the circle's arc far from the square
    const ring = flatten(u, 0.05)[0];
    const d = Math.min(...ring.map(p => Math.abs(Math.hypot(p[0] - 100, p[1] - 100) - 80)));
    expect(d).toBeLessThan(0.5);
    const b = boundsOf(u);
    expect(b.x).toBeCloseTo(20, 0);
    expect(b.w).toBeCloseTo(200, 0);
  });

  it('an object with an inner ring has a hole (even-odd)', () => {
    const ring = areaOf(flatten(parseD('M0 0H100V100H0Z M25 25H75V75H25Z')));
    expect(ring).toHaveLength(1);
    expect(ring[0]).toHaveLength(2);
  });
});

describe('Path ▸ Simplify', () => {
  it('a wobbly hand-drawn circle becomes a few smooth nodes', () => {
    const pts: string[] = [];
    for (let k = 0; k < 120; k++) { const a = k / 120 * Math.PI * 2, r = 50 + Math.sin(k * 7) * 0.4; pts.push(`${100 + r * Math.cos(a)} ${100 + r * Math.sin(a)}`); }
    const subs = parseD(`M${pts.join('L')}Z`);
    expect(subs[0].nodes).toHaveLength(120);
    const s = simplifySubs(subs, 2);
    expect(s[0].nodes.length).toBeLessThan(12);
    expect(area(s)).toBeCloseTo(Math.PI * 2500, -2);
  });

  it('maps a path through a matrix', () => {
    const m = mapSubs(parseD('M0 0L10 0'), [2, 0, 0, 2, 5, 5]);
    expect(toD(m)).toBe('M5 5L25 5');
  });
});
