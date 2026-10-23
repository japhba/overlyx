import { describe, it, expect } from 'vitest';
import { PrefModel, nextPair, favourites, modes, spread, around, seeded, cdf, logCdf, type Setting, type Answer } from '../packages/core/src/prefgp.ts';

/** a made-up taste over [0,1]^d: two liked regions (the second hardly less), horrible far up along the first setting */
function taste(d: number, rand: () => number) {
  const m1 = Array.from({ length: d }, () => 0.15 + 0.3 * rand()), m2 = Array.from({ length: d }, () => 0.55 + 0.3 * rand());
  const bump = (x: Setting, m: number[], w: number) => Math.exp(-x.reduce((s, v, i) => s + (v - m[i]) ** 2, 0) / (2 * w * w));
  const u = (x: Setting) => (x[0] > 0.9 ? -3 : 2 * Math.max(bump(x, m1, 0.3), 0.95 * bump(x, m2, 0.3)) - 1);
  return { u, m1, m2 };
}

/** a person answering with that taste, through noise */
function answer(u: (x: Setting) => number, a: Setting, b: Setting, rand: () => number): Answer {
  const d = u(a) - u(b) + 0.15 * (rand() + rand() + rand() - 1.5);
  const grade = d > 0.6 ? 2 : d > 0.15 ? 1 : d < -0.6 ? -2 : d < -0.15 ? -1 : 0;
  return { a, b, grade, badA: u(a) < -2, badB: u(b) < -2, top: rand() < 0.5 ? 0 : 1 };
}

describe('preference learning', () => {
  it('the normal distribution, also far in its tail', () => {
    expect(cdf(0)).toBeCloseTo(0.5, 6);
    expect(cdf(1.96)).toBeCloseTo(0.975, 4);
    expect(Math.exp(logCdf(-3))).toBeCloseTo(cdf(-3), 6);
    expect(logCdf(-30)).toBeCloseTo(-454.321, 2);
  });

  it('a few answers: what was chosen is liked better, what was horrible worst', () => {
    const m = new PrefModel(2);
    const a = [0.2, 0.2], b = [0.8, 0.8], c = [0.5, 0.9];
    m.add({ a, b, grade: 1 });
    m.add({ a, b: c, grade: 2, badB: true });
    m.fit();
    expect(m.better(a, b)).toBeGreaterThan(0.6);
    expect(m.better(b, c)).toBeGreaterThan(0.6);
    expect(m.values[m.index(c)]).toBeLessThan(-1);
    expect(m.incumbent()).toBe(m.index(a));
  });

  it('about the same: alike values', () => {
    const m = new PrefModel(1);
    for (let i = 0; i < 4; i++) m.add({ a: [0.2], b: [0.8], grade: 0 });
    m.fit();
    expect(Math.abs(m.values[0] - m.values[1])).toBeLessThan(0.2);
  });

  it('finds what a made-up person likes in 35 choices', () => {
    const d = 8;
    let found = 0, runs = 0, worst = 1;
    for (const seed of [1, 2, 3, 4, 5, 6]) {
      const rand = seeded(seed);
      const { u, m1, m2 } = taste(d, rand);
      const base = spread(d, 600);
      const model = new PrefModel(d);
      // (the first questions: kinds of pen spread out — among them one somewhat like each liked region — each against the best so far)
      const kinds = [base[37], around(m1, 1, 0.1, rand)[0], base[74], base[111], around(m2, 1, 0.1, rand)[0], base[148]];
      let inc = base[0];
      for (const k of kinds) { const ans = answer(u, inc, k, rand); model.add(ans); model.fit(true); inc = model.pts[model.incumbent()]; }
      for (let q = 0; q < 29; q++) {
        const top = model.pts.map((x, i) => ({ x, v: model.values[i] })).sort((a, b) => b.v - a.v).slice(0, 4);
        const pool = [...base, ...top.flatMap(t => around(t.x, 40, 0.08, rand))];
        const pair = nextPair(model, pool, { draw: q % 4 === 3, region: q % 4 === 1 ? (q % 8 === 5 ? 2 : 1) : 0, rand });
        model.add(answer(u, pair.a, pair.b, rand));
        model.fit(q % 5 === 0);
      }
      const best = model.pts[model.incumbent()];
      const top = u(m1);
      const got = (u(best) + 1) / (top + 1);
      worst = Math.min(worst, got);
      runs++;
      if (got > 0.8) found++;
    }
    expect(found).toBeGreaterThanOrEqual(runs - 1);
    expect(worst).toBeGreaterThan(0.5);
  });

  it('two liked settings with a disliked one between them: two favourites, one hill each', () => {
    const m = new PrefModel(2);
    const a = [0.15, 0.15], b = [0.85, 0.85], mid = [0.5, 0.5], far = [0.15, 0.85];
    for (const [x, y] of [[a, mid], [b, mid], [a, far], [b, far]]) m.add({ a: x, b: y, grade: 2 });
    m.add({ a, b, grade: 0 });
    m.fit(true);
    expect(modes(m).length).toBeGreaterThanOrEqual(2);
    const favs = favourites(m, 3, 1);
    expect(favs.map(f => f.x.join())).toEqual(expect.arrayContaining([a.join(), b.join()]));
    // (alike settings on one hill: one favourite)
    const one = new PrefModel(2);
    one.add({ a, b: [0.2, 0.2], grade: 0 });
    one.add({ a, b: far, grade: 2 });
    one.add({ a: [0.2, 0.2], b: far, grade: 2 });
    one.fit(true);
    expect(favourites(one, 3, 1).length).toBe(1);
  });

  it('a step is quick: 120 answers, a pool of 1500', () => {
    const d = 9, rand = seeded(7), { u } = taste(d, rand);
    const model = new PrefModel(d);
    const pool = spread(d, 1500);
    for (let i = 0; i < 120; i++) model.add(answer(u, pool[(i * 7) % 1500], pool[(i * 13 + 5) % 1500], rand));
    const t0 = performance.now();
    model.fit(true);
    nextPair(model, pool, { rand });
    nextPair(model, pool, { rand, draw: true });
    expect(performance.now() - t0).toBeLessThan(3000);
  });
});
