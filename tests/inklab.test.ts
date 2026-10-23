import { describe, it, expect } from 'vitest';
import { LAB_DIMS, LAB_KINDS, labNib, labSetting, describe as words, curatedPrior, LAB_VERSION } from '../packages/core/src/inklab.ts';
import { inkRuns, type FreePt } from '../packages/core/src/freehand.ts';

describe('the pen lab settings', () => {
  it('a pen\'s settings and back', () => {
    const nib = { sensitivity: 0.4, pressSmooth: 3, liftLo: 0.1, liftHi: 0.5, sharpness: 0.2, flatness: 0.1, stabilization: 0.1, rounding: 0.6 };
    const back = labNib(labSetting(nib));
    for (const k of Object.keys(nib) as (keyof typeof nib)[]) expect(back[k]).toBeCloseTo(nib[k], 1);
    expect(back.lift).toBe(true);
    // (the settings as they were before the lab: the engine's own thresholds, the pressure smoothed as for whole px)
    const old = labNib(labSetting({ sensitivity: 0.25, rounding: 0.3 }));
    expect(old.liftLo).toBeCloseTo(0.12, 2);
    expect(old.liftHi).toBeCloseTo(0.42, 1);
    expect(old.pressSmooth).toBeCloseTo(7.5, 0);
  });

  it('every setting of the lab draws (each kind, the corners)', () => {
    const pts: FreePt[] = Array.from({ length: 80 }, (_, i) => [i * 1.5, 20 + 8 * Math.sin(i / 5), 0.05 + 0.3 * Math.sin((i / 79) * Math.PI)]);
    const corners = [LAB_DIMS.map(() => 0), LAB_DIMS.map(() => 1), LAB_DIMS.map((_, i) => i % 2)];
    for (const x of [...LAB_KINDS.map(k => k.x), ...corners]) {
      const runs = inkRuns(pts, { width: 3, pressure: true, nib: labNib(x), final: true });
      expect(runs.length).toBeGreaterThan(0);
      expect(runs.every(r => r.w > 0 && r.pts.every(p => Number.isFinite(p[0]) && Number.isFinite(p[1])))).toBe(true);
      expect(words(x).length).toBeGreaterThan(2);
    }
  });

  it("a curator's horrible settings kept out, what they liked expected a little", () => {
    expect(curatedPrior([])).toBeNull();
    const good = LAB_KINDS[0].x, bad = LAB_DIMS.map(() => 1);
    const c = curatedPrior([{ version: LAB_VERSION, answers: [{ a: good, b: bad, grade: 2, badB: true }, { a: good, b: LAB_KINDS[3].x, grade: 1 }] }])!;
    expect(c.veto(bad)).toBe(true);
    expect(c.veto(good)).toBe(false);
    expect(c.prior(good)).toBeGreaterThan(c.prior(bad));
    // (another version's answers: not mixed in)
    expect(curatedPrior([{ version: LAB_VERSION + 1, answers: [{ a: good, b: bad, grade: 2 }] }])).toBeNull();
  });
});

describe("the pen lab's answers as the server keeps them", () => {
  const answer = { a: [0.1, 0.2], b: [0.3, 0.4], grade: 1, top: 1, kind: 'Brush pen', ms: 812, badB: true };
  it('numbers and fixed words only', async () => {
    const { inkLabReport } = await import('../packages/core/src/inklab.ts');
    const r = inkLabReport({ version: 1, dims: ['sensitivity', 'rounding'], start: [0.2, 0.3], answers: [{ ...answer, extra: 'x' }], favourites: [[0.1, 0.2]], device: { type: 'pen', whole: true, pressure: true, width: 4, dpr: 2, screen: [834, 1194], name: 'someone' },
      sample: [{ pts: [[1, 2, 0.25], [3, 4, 0.3]], t: [0, 8], tilt: [10, 20, 11, 21], whole: true, pressure: true }] })!;
    const kept = JSON.parse(r.body);
    expect(kept.answers[0]).toEqual({ a: [0.1, 0.2], b: [0.3, 0.4], grade: 1, badB: true, top: 1, kind: 'Brush pen', ms: 812 });
    expect(kept.device.name).toBeUndefined();
    expect(kept.sample[0].pts).toEqual([[1, 2, 0.25], [3, 4, 0.3]]);
    expect(r.title).toContain('1 answers');
    // (not answers at all, a word that is not one, too much)
    expect(inkLabReport({ version: 1, dims: [], answers: [{ ...answer, a: ['x'] }] })).toBeNull();
    expect(inkLabReport({ version: 1, dims: [], answers: [{ ...answer, grade: 3 }] })).toBeNull();
    expect(JSON.parse(inkLabReport({ version: 1, dims: [], answers: [{ ...answer, kind: '<script>' }] })!.body).answers[0].kind).toBeUndefined();
    expect(inkLabReport({ version: 1, dims: [], answers: [], sample: [{ pts: Array.from({ length: 5001 }, () => [0, 0, 0]) }] })).toBeNull();
  });
});
