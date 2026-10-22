// @vitest-environment happy-dom
/**
 * The deck canvas's new objects and edits as text (deliverable/sourceops.ts, core html/source.ts):
 * the shapes the toolbar draws, a line keeping the direction it was drawn in, the pen's stroke (in
 * Draw's ink: deckink.ts), an SVG file made a safe inline drawing (inlineSvgHtml), and the `reorder` operation behind
 * Arrange ▸ order (the text between the elements stays put, nothing else of the file changes).
 */
import { describe, it, expect } from 'vitest';
import { objectHtml, inlineSvgHtml, penPathD } from '../packages/client/src/deliverable/sourceops.ts';
import { loadDeckInk, saveDeckInk, patchDeckInk, deckInkStyle, defaultDeckInk, DEFAULT_NIB, hexColor, colorsPass, setLassoColors } from '../packages/client/src/deliverable/deckink.ts';
import { inkRuns, runPathD, runsBox, inkPaths, chunkPaths, freshPoint, pressureWidth, usualPressure, type FreePt, type InkRun } from '../packages/client/src/deliverable/runtime/freehand.ts';
import { pointPressure, pressed } from '../packages/client/src/deliverable/runtime/pressure.ts';
import { applyOp, opSplices, parseSource, rebaseOp } from '../packages/core/src/html/source.ts';

describe('objects drawn on a slide', () => {
  it('polygon shapes are SVG stretched to their box, with an outline of constant width', () => {
    const star = objectHtml('star', { x: 10, y: 20, w: 200, h: 100 }, 'deck');
    expect(star).toMatch(/^<svg style="position: absolute; left: 10px; top: 20px; width: 200px; height: 100px; overflow: visible" viewBox="0 0 100 100" preserveAspectRatio="none"><polygon points="50,4 /);
    expect(star).toContain('vector-effect="non-scaling-stroke"');
    for (const t of ['triangle', 'diamond', 'hexagon'] as const) expect(objectHtml(t, { x: 0, y: 0, w: 50, h: 50 }, 'deck')).toContain('<polygon');
    expect(objectHtml('roundrect', { x: 0, y: 0, w: 50, h: 50 }, 'deck')).toContain('border-radius: 28px');
  });

  it('a line goes from where the drag started to where it ended', () => {
    // drawn from the lower right to the upper left
    const html = objectHtml('arrow', { x: 500, y: 550, w: 200, h: 100 }, 'deck', 1, [[700, 650], [500, 550]]);
    expect(html).toContain('left: 500px; top: 550px; width: 200px; height: 100px');
    expect(html).toContain('<line x1="200" y1="100" x2="0" y2="0"');
    expect(html).toContain('marker-end="url(#ah)"');
    // a click (no drag): a horizontal line of the default length
    expect(objectHtml('line', { x: 5, y: 6, w: 0, h: 0 }, 'deck')).toContain('<line x1="0" y1="0" x2="240" y2="0"');
  });

  it("the pen's stroke is a smooth path through its points, in its own box", () => {
    expect(penPathD([[0, 0], [10, 10], [20, 0]])).toBe('M0 0Q10 10 15 5L20 0');
    const html = objectHtml('pen', { x: 100, y: 50, w: 20, h: 10 }, 'deck', 1, [[100, 50], [110, 60], [120, 50]]);
    expect(html).toContain('left: 100px; top: 50px; width: 20px; height: 10px');
    expect(html).toContain('<path d="M0 0Q10 10 15 5L20 0" fill="none"');
    expect(objectHtml('pen', { x: 0, y: 0, w: 0, h: 0 }, 'deck', 1, [[1, 1]])).toBe('');
  });

  it("Draw's strokes are in the pen's ink; the highlighter's translucent and multiplied over what is under it", () => {
    const pts: [number, number][] = [[0, 0], [10, 10], [20, 0]];
    const pen = objectHtml('pen', { x: 0, y: 0, w: 20, h: 10 }, 'deck', 1, pts, undefined, { color: '#d93025', width: 8, opacity: 1 });
    expect(pen).toContain('stroke="#d93025" stroke-width="8" stroke-linecap');
    expect(pen).not.toContain('mix-blend-mode');
    const hl = objectHtml('pen', { x: 0, y: 0, w: 20, h: 10 }, 'deck', 1, pts, undefined, { color: '#fbbc04', width: 24, opacity: 0.35 });
    expect(hl).toContain('overflow: visible; mix-blend-mode: multiply"');
    expect(hl).toContain('stroke="#fbbc04" stroke-width="24" stroke-opacity="0.35"');
    // a colour that is no colour does not reach the page
    expect(objectHtml('pen', { x: 0, y: 0, w: 20, h: 10 }, 'deck', 1, pts, undefined, { color: '"><script>', width: 4, opacity: 1 })).toContain('stroke="#1d2433"');
  });
});

describe("Draw's strokes as GoodNotes draws them (runtime/freehand.ts)", () => {
  const all = (runs: InkRun[]) => runs.flatMap(r => r.pts);
  /** the points the drawn line passes: its points, and the middles of the straight bits between them */
  const drawn = (runs: InkRun[]) => runs.flatMap(r => r.pts.flatMap((p, i) => i ? [[(p[0] + r.pts[i - 1][0]) / 2, (p[1] + r.pts[i - 1][1]) / 2], p] : [p]));
  /** how far the stroke's points stray from a line through (x0, y0) at slope k */
  const offLine = (runs: InkRun[], x0: number, y0: number, k: number) => Math.max(...all(runs).map(([x, y]) => Math.abs(y - y0 - k * (x - x0)) / Math.hypot(1, k)));

  it('goes round where the pen went round, however few its points (no chords)', () => {
    // twelve points on a circle (r = 20): a polygon's sides pass 0.68 px inside it
    const pts: FreePt[] = Array.from({ length: 13 }, (_, i) => [100 + 20 * Math.cos(i * Math.PI / 6), 100 + 20 * Math.sin(i * Math.PI / 6), 0.5]);
    const off = (runs: InkRun[]) => Math.max(...drawn(runs).map(([x, y]) => Math.abs(Math.hypot(x - 100, y - 100) - 20)));
    expect(off([{ w: 4, pts: pts.map(([x, y]) => [x, y]) }])).toBeGreaterThan(0.6);
    const runs = inkRuns(pts, { width: 4 });
    expect(runs).toHaveLength(1);
    expect(off(runs)).toBeLessThan(0.35);
    // its first px too (perfect-freehand straightened them)
    const start = drawn(runs).filter(([x, y]) => Math.hypot(x - 120, y - 100) < 5);
    expect(start.length).toBeGreaterThan(2);
    for (const [x, y] of start) expect(Math.abs(Math.hypot(x - 100, y - 100) - 20)).toBeLessThan(0.35);
  });

  it('drawn in chunks, the line drawn so far stays as it was frame after frame: only its end is painted again', () => {
    // handwriting-like loops from a Pencil at 120 Hz in whole px (Safari 17), pressure varying
    const pen = (n: number): FreePt[] => Array.from({ length: n }, (_, i) => [Math.round(40 + i * 1.6 + 9 * Math.sin(i / 5)), Math.round(80 + 14 * Math.sin(i / 3.2)), 0.25 + 0.15 * Math.sin(i / 11)]);
    const opts = { width: 2.4, pressure: true, coarse: true, zoom: 1.5, nib: { sensitivity: 0.25 } };
    let before = chunkPaths(inkRuns(pen(200), { ...opts, chunk: 96 }));
    for (let n = 201; n < 400; n += 3) {
      const now = chunkPaths(inkRuns(pen(n), { ...opts, chunk: 96 }));
      const same = now.findIndex((p, i) => !before[i] || before[i].d !== p.d || before[i].w !== p.w);
      // (the paths that changed: those of the last chunk or two, a small part of the whole)
      expect(same < 0 ? now.length : same).toBeGreaterThan(now.length - 12);
      expect(now.length - (same < 0 ? now.length : same)).toBeLessThan(0.35 * now.length);
      before = now;
    }
    // the chunks only cut the runs: the same widths along the line, the same points (to the simplification's hair)
    const whole = inkRuns(pen(399), opts), cut = inkRuns(pen(399), { ...opts, chunk: 96 });
    expect([...new Set(cut.map(r => r.w))].sort()).toEqual([...new Set(whole.map(r => r.w))].sort());
    const seg = ([x, y]: [number, number], [ax, ay]: [number, number], [bx, by]: [number, number]) => {
      const l2 = (bx - ax) ** 2 + (by - ay) ** 2, t = l2 ? Math.max(0, Math.min(1, ((x - ax) * (bx - ax) + (y - ay) * (by - ay)) / l2)) : 0;
      return Math.hypot(x - ax - t * (bx - ax), y - ay - t * (by - ay));
    };
    const off = (p: [number, number]) => Math.min(...whole.flatMap(r => r.pts.slice(1).map((q, i) => seg(p, r.pts[i], q))));
    expect(Math.max(...all(cut).map(off))).toBeLessThan(0.11);
  });

  it('worked out frame after frame from what the last frame made of it: the same line as worked out afresh', () => {
    const pen = (n: number, whole: boolean): FreePt[] => Array.from({ length: n }, (_, i) => {
      const x = 40 + i * 1.3 + 9 * Math.sin(i / 5) + (i > 150 && i < 160 ? 25 : 0), y = 80 + 14 * Math.sin(i / 3.2);
      return [whole ? Math.round(x) : x, whole ? Math.round(y) : y, i < 2 ? 0 : 0.25 + 0.15 * Math.sin(i / 11)];
    });
    const nibs = [{}, { sensitivity: 0.8 }, { sharpness: 0.6, flatness: 0.5 }, { stabilization: 0.5, rounding: 0.3 }, { ball: true }, { rounding: 0 }];
    for (const whole of [true, false]) for (const nib of nibs) for (const chunk of [0, 64]) {
      const opts = { width: 2.4, pressure: true, coarse: whole ? 0.8 : false, zoom: 1.5, nib, chunk };
      const cache = {};
      for (let n = 1; n < 260; n += n < 20 ? 1 : 7) expect(inkRuns(pen(n, whole), { ...opts, cache })).toEqual(inkRuns(pen(n, whole), opts));
      // the highlighter, and the pen lifted (its end tapered)
      expect(inkRuns(pen(260, whole), { ...opts, highlighter: true, cache })).toEqual(inkRuns(pen(260, whole), { ...opts, highlighter: true }));
      expect(inkRuns(pen(260, whole), { ...opts, final: true, cache })).toEqual(inkRuns(pen(260, whole), { ...opts, final: true }));
      // (whiteboards and margins draw the live stroke as lifted: its end tapered at every frame)
      const lifted = {};
      for (let n = 1; n < 200; n += 5) expect(inkRuns(pen(n, whole), { ...opts, final: true, cache: lifted })).toEqual(inkRuns(pen(n, whole), { ...opts, final: true }));
    }
  });

  it("keeps the pen's sharp turns sharp (a v's point): a curve through them rounded them", () => {
    // a V from sparse points (6 px apart, as at 60 Hz): on its two arms, not bulging past the point (0.36 px before)
    const arm = (ax: number, ay: number, bx: number, by: number, n: number): FreePt[] => Array.from({ length: n }, (_, i) => [ax + (bx - ax) * i / n, ay + (by - ay) * i / n, 0.5]);
    const v: FreePt[] = [...arm(0, 0, 30, 60, 11), ...arm(30, 60, 60, 0, 11), [60, 0, 0.5]];
    const toArms = ([x, y]: number[]) => { const seg = (ax: number, ay: number, bx: number, by: number) => { const t = Math.max(0, Math.min(1, ((x - ax) * (bx - ax) + (y - ay) * (by - ay)) / ((bx - ax) ** 2 + (by - ay) ** 2))); return Math.hypot(x - ax - t * (bx - ax), y - ay - t * (by - ay)); }; return Math.min(seg(0, 0, 30, 60), seg(30, 60, 60, 0)); };
    expect(Math.max(...drawn(inkRuns(v, { width: 4 })).map(toArms))).toBeLessThan(0.2);
  });

  it("whole-px points (an older Safari's) come out a straight line, not stairs", () => {
    const pts: FreePt[] = Array.from({ length: 160 }, (_, i) => [Math.round(10 + i * 1.3), Math.round(20 + i * 1.3 * 0.3), 0.5]);
    expect(offLine([{ w: 4, pts: pts.map(([x, y]) => [x, y]) }], 10, 20, 0.3)).toBeGreaterThan(0.45);
    const runs = inkRuns(pts, { width: 4, coarse: true });
    // (the ends stay where the pen was: measured between them)
    const mid = all(runs).filter(([x]) => x > 40 && x < 200);
    expect(offLine([{ w: 4, pts: mid }], 10, 20, 0.3)).toBeLessThan(0.2);
  });

  it("the Pencil's pressure sets the width, smoothed (no beads); a mouse's and the highlighter's are even", () => {
    const line = (press: (i: number) => number): FreePt[] => Array.from({ length: 201 }, (_, i) => [i * 2, 50, press(i)]);
    const widths = (runs: InkRun[]) => runs.map(r => r.w);
    const full = { sensitivity: 1 };
    const hard = inkRuns(line(() => 0.8), { width: 4, pressure: true, nib: full }), light = inkRuns(line(() => 0.1), { width: 4, pressure: true, nib: full });
    expect(Math.max(...widths(hard))).toBeGreaterThan(Math.max(...widths(light)) * 1.6);
    // the usual writing pressure (~0.25): the width asked for, whatever the sensitivity; at a quarter (the default) a little thinner or wider
    for (const k of [0.25, 0.5, 1]) expect(pressureWidth(0.25, k)).toBeCloseTo(1, 6);
    expect(pressureWidth(0, 0.25)).toBeCloseTo(0.79, 2);
    expect(pressureWidth(1, 0.25)).toBeCloseTo(1.19, 2);
    const soft = inkRuns(line(() => 0.8), { width: 4, pressure: true });
    expect(Math.max(...widths(soft))).toBeLessThan(Math.max(...widths(hard)));
    expect(Math.max(...widths(soft))).toBeGreaterThan(4.3);
    // a noisy hand: the pressure jumps between 0.2 and 0.3 from one point to the next; the width hardly moves
    const noisy = inkRuns(line(i => (i % 2 ? 0.3 : 0.2)), { width: 4, pressure: true, nib: full });
    const mid = widths(noisy).slice(1, -1);
    expect(Math.max(...mid) - Math.min(...mid)).toBeLessThan(0.25);
    expect(noisy.length).toBeLessThan(6);
    // a pen's first event without pressure (0) takes the next one's: no blob, no hairline
    const first = inkRuns([[0, 0, 0], ...line(() => 0.6).slice(1)], { width: 4, pressure: true, nib: full });
    expect(first[0].w).toBeCloseTo(4 * pressureWidth(0.6), 0);
    for (const o of [{ width: 4 }, { width: 20, highlighter: true, pressure: true }]) {
      const runs = inkRuns(line(i => i / 200), o);
      expect(runs).toHaveLength(1);
      expect(runs[0].w).toBe(o.width);
    }
  });

  it('a tap is a dot; the runs meet end to end; the box takes in half the width', () => {
    const dot = inkRuns([[50, 50, 0.5]], { width: 6 });
    expect(dot).toEqual([{ w: 6, pts: [[50, 50]] }]);
    expect(runPathD(dot[0])).toBe('M50 50L50.01 50');
    expect(runsBox(dot)).toEqual({ x: 47, y: 47, w: 6, h: 6 });
    const runs = inkRuns(Array.from({ length: 101 }, (_, i) => [i * 3, 0, i / 100]), { width: 4, pressure: true, nib: { sensitivity: 1 } });
    expect(runs.length).toBeGreaterThan(3);
    for (let i = 1; i < runs.length; i++) expect(runs[i].pts[0]).toEqual(runs[i - 1].pts[runs[i - 1].pts.length - 1]);
  });

  it("small loops keep their size (the ink contracted: a Gaussian pulls curves in), smoothed or not", () => {
    const loop = (r: number, whole: boolean): FreePt[] => Array.from({ length: Math.ceil(4 * Math.PI * r / 1.6) }, (_, i) => {
      const a = i * 1.6 / r; const x = 100 + r * Math.cos(a), y = 100 + r * Math.sin(a);
      return [whole ? Math.round(x) : x, whole ? Math.round(y) : y, 0.25];
    });
    const radius = (runs: InkRun[]) => { const ps = all(runs).slice(10, -10); return ps.reduce((a, [x, y]) => a + Math.hypot(x - 100, y - 100), 0) / ps.length; };
    expect(Math.abs(radius(inkRuns(loop(5, false), { width: 4, pressure: true, zoom: 0.6 })) - 5)).toBeLessThan(0.05);
    expect(Math.abs(radius(inkRuns(loop(6, true), { width: 4, pressure: true, zoom: 0.6, coarse: true })) - 6)).toBeLessThan(0.1);
    expect(Math.abs(radius(inkRuns(loop(6, false), { width: 4, pressure: true, zoom: 1, nib: { stabilization: 0.5 } })) - 6)).toBeLessThan(0.15);
  });

  it("the pen's settings: a ball pen even, the tip sharp or round, a flat nib's down-strokes full, stabilization smooths", () => {
    const line = (n: number, f: (i: number) => [number, number], press: (i: number) => number = () => 0.25): FreePt[] => Array.from({ length: n + 1 }, (_, i) => [...f(i), press(i)] as FreePt);
    const flat = line(150, i => [i * 2, 50], i => 0.05 + i / 150);
    // a ball pen: one width, whatever the pressure and the rest
    const ball = inkRuns(flat, { width: 4, pressure: true, nib: { ball: true, sensitivity: 1, sharpness: 1, flatness: 1 } });
    expect(ball).toHaveLength(1);
    expect(ball[0].w).toBe(4);
    // no pressure sensitivity: even too
    expect(inkRuns(flat, { width: 4, pressure: true, nib: { sensitivity: 0 } })).toHaveLength(1);
    // a sharp tip: pointed at the start, and at the end once the pen has lifted (while drawing the end is the pen's)
    const even = line(100, i => [i * 2, 50]);
    const sharp = inkRuns(even, { width: 4, pressure: true, nib: { sensitivity: 0, sharpness: 1 }, final: true });
    expect(sharp[0].w).toBeLessThan(1);
    expect(sharp[sharp.length - 1].w).toBeLessThan(1);
    expect(Math.max(...sharp.map(r => r.w))).toBe(4);
    const live = inkRuns(even, { width: 4, pressure: true, nib: { sensitivity: 0, sharpness: 1 } });
    expect(live[0].w).toBeLessThan(1);
    expect(live[live.length - 1].w).toBe(4);
    // a flat nib: a down-stroke wider than an up-stroke rising to the right (its edge's way: a hairline)
    const down = inkRuns(line(60, i => [50, i * 2]), { width: 4, nib: { flatness: 1 } });
    const up = inkRuns(line(60, i => [i * 2 * Math.cos(Math.PI / 6), 200 - i * 2 * Math.sin(Math.PI / 6)]), { width: 4, nib: { flatness: 1 } });
    const mid = (runs: InkRun[]) => runs[Math.floor(runs.length / 2)].w;
    expect(mid(down)).toBeGreaterThan(mid(up) * 4);
    // stabilization: a shaky straight line comes out straight
    let seed = 3; const rnd = () => { seed = (seed * 16807) % 2147483647; return seed / 2147483647 - 0.5; };
    const shaky = line(200, i => [i * 1.5, 50 + rnd() * 1.6]);
    const dev = (runs: InkRun[]) => { const ys = all(runs).filter(([x]) => x > 30 && x < 270).map(([, y]) => Math.abs(y - 50)); return ys.reduce((a, b) => a + b, 0) / ys.length; };
    const as = dev(inkRuns(shaky, { width: 4, zoom: 1 }));
    const half = dev(inkRuns(shaky, { width: 4, zoom: 1, nib: { stabilization: 0.5 } })), full = dev(inkRuns(shaky, { width: 4, zoom: 1, nib: { stabilization: 1 } }));
    expect(half).toBeLessThan(as * 0.7);
    expect(full).toBeLessThan(half);
    expect(full).toBeLessThan(as * 0.45);
  });

  it("rounding: 0 joins the pen's points straight (whole-px steps and all), more rounds corners; strokes from before round fully", () => {
    // a square drawn at 240 Hz in whole px, slowing into each corner
    const square: FreePt[] = [];
    const sides: [number, number][] = [[0, 0], [30, 0], [30, 30], [0, 30], [0, 0]];
    for (let s = 0; s < 4; s++) for (let i = s ? 1 : 0; i <= 36; i++) {
      const u = i / 36, f = 10 * u ** 3 - 15 * u ** 4 + 6 * u ** 5, [ax, ay] = sides[s], [bx, by] = sides[s + 1];
      square.push([Math.round(100 + ax + (bx - ax) * f), Math.round(100 + ay + (by - ay) * f), 0.3]);
    }
    const cut = (runs: InkRun[]) => Math.min(...all(runs).map(([x, y]) => Math.hypot(x - 130, y - 100)));
    const at = (rounding?: number) => inkRuns(square, { width: 4, pressure: true, coarse: true, nib: { sensitivity: 0.25, ...(rounding === undefined ? {} : { rounding }) }, final: true });
    expect(cut(at(0))).toBeLessThan(0.01);
    expect(cut(at(0.3))).toBeLessThan(0.3);
    expect(cut(at(1))).toBeGreaterThan(0.6);
    expect(cut(at())).toBeCloseTo(cut(at(1)), 5);
    // straight from point to point: a sparse zig-zag's legs are straight lines
    const zig: FreePt[] = [[0, 0, 0.3], [10, 10, 0.3], [20, 0, 0.3], [30, 12, 0.3], [40, 0, 0.3], [50, 8, 0.3]];
    const leg = all(inkRuns(zig, { width: 2, nib: { rounding: 0 } })).filter(([x]) => x > 20 && x < 30);
    for (const [x, y] of leg) expect(Math.abs(y - (x - 20) * 1.2)).toBeLessThan(0.01);
    const curved = all(inkRuns(zig, { width: 2, nib: { rounding: 1 } })).filter(([x]) => x > 20 && x < 30);
    expect(Math.max(...curved.map(([x, y]) => Math.abs(y - (x - 20) * 1.2)))).toBeGreaterThan(0.2);
  });

  it("the usual pressure: drawn at the nominal width; measured as the median of a hand's strokes", () => {
    expect(pressureWidth(0.25, 1)).toBeCloseTo(1, 6);
    expect(pressureWidth(0.4, 1, 0.4)).toBeCloseTo(1, 6);
    expect(pressureWidth(0.4, 1)).toBeGreaterThan(1.1);
    const press = (p: number) => inkRuns(Array.from({ length: 80 }, (_, i) => [i * 2, 0, p] as FreePt), { width: 4, pressure: true, nib: { sensitivity: 1, usual: 0.5 } });
    expect(press(0.5)[0].w).toBe(4);
    expect(usualPressure([[]])).toBeNull();
    const stroke = (p: number): FreePt[] => Array.from({ length: 40 }, (_, i) => [i, 0, i < 3 ? 0.02 : p]);
    expect(usualPressure([stroke(0.3), stroke(0.4), stroke(0.42)])).toBe(0.4);
  });

  it("pressure: a pen's, a Force Touch trackpad's (Safari's webkitForce, Chrome's pressure), never a plain button's", () => {
    const ev = (pointerType: string, pressure: number, webkitForce?: number) => ({ pointerType, pressure, ...(webkitForce !== undefined ? { webkitForce } : {}) }) as unknown as PointerEvent;
    expect(pointPressure(ev('pen', 0.42))).toBe(0.42);
    expect(pointPressure(ev('pen', -1))).toBe(0);
    expect(pointPressure(ev('mouse', 0.5))).toBe(0.5);
    expect(pointPressure(ev('mouse', 0.5, 1.5))).toBeCloseTo(0.5, 6);
    expect(pointPressure(ev('mouse', 0.5, 3))).toBe(1);
    expect(pointPressure(ev('mouse', 0.31))).toBe(0.31);
    expect(pointPressure(ev('touch', 0.9))).toBe(0.5);
    // a mouse's stroke takes its pressure once it changes; a pen's always; a finger's never
    expect(pressed('pen', 0.3, 0.3)).toBe(true);
    expect(pressed('mouse', 0.5, 0.5)).toBe(false);
    expect(pressed('mouse', 0.33, 0.4)).toBe(true);
    expect(pressed('touch', 0.5, 0.9)).toBe(false);
  });

  it("takes each of the pen's points once, in order: Safari's coalesced events repeat the last move's (A B A C D C)", () => {
    const pts: FreePt[] = [];
    let t = -1;
    const sent: [number, FreePt][] = [[1, [0, 0, 0.3]], [2, [1, 0, 0.3]], [1, [0, 0, 0.3]], [3, [2, 0, 0.3]], [4, [3, 0, 0.3]], [3, [2, 0, 0.3]], [5, [3, 0, 0.3]], [6, [4, 0, 0.3]]];
    for (const [ts, p] of sent) if (freshPoint(pts, t, ts, p)) { pts.push(p); t = ts; }
    expect(pts.map(p => p[0])).toEqual([0, 1, 2, 3, 4]);
    // (the same time for all of a move's points, as some browsers give them: still taken)
    const same: FreePt[] = [[0, 0, 0.3]];
    expect(freshPoint(same, 7, 7, [1, 0, 0.3])).toBe(true);
  });

  it('is written as stroked runs in its own box, nothing else let through', () => {
    const runs = inkRuns(Array.from({ length: 41 }, (_, i) => [10 + i * 2, 20 + Math.sin(i / 5) * 8, 0.2 + i / 80]), { width: 4, pressure: true });
    const b = runsBox(runs), x = Math.floor(b.x), y = Math.floor(b.y);
    const rd = runs.map(r => ({ w: r.w, d: runPathD(r, -x, -y) }));
    // one path for each width, its runs in it one after the other
    const grouped = inkPaths(runs, -x, -y);
    expect(new Set(grouped.map(g => g.w)).size).toBe(grouped.length);
    expect(grouped.reduce((n, g) => n + (g.d.match(/M/g) ?? []).length, 0)).toBe(runs.length);
    for (const r of rd) expect(r.d).not.toMatch(/-\d/);   // (nothing left of or above its box)
    const html = objectHtml('pen', { x, y, w: b.w, h: b.h }, 'deck', 1, undefined, { d: '', closed: false, runs: rd }, { color: '#d93025', width: 4, opacity: 1 });
    expect(html).toMatch(new RegExp(`^<svg class="ol-ink" style="position: absolute; left: ${x}px; top: ${y}px; `));
    expect(html).toContain('<g fill="none" stroke="#d93025" stroke-linecap="round" stroke-linejoin="round"><path fill="none" stroke-width="');
    expect((html.match(/<path /g) ?? []).length).toBe(rd.length);
    const hl = objectHtml('pen', { x: 0, y: 0, w: 9, h: 9 }, 'deck', 1, undefined, { d: '', closed: false, runs: [{ w: 24, d: 'M0 0L9 9" onload="x' }, { w: 1e9, d: 'M0 0L1 1' }] }, { color: '#fbbc04', width: 24, opacity: 0.35 });
    expect(hl).toContain('mix-blend-mode: multiply');
    expect(hl).toContain('stroke="#fbbc04" stroke-opacity="0.35"');
    expect(hl).not.toContain('onload');
    expect(hl).not.toContain('1000000000');
  });
});

describe("Draw's pens (deckink.ts)", () => {
  it('a preset clicked again and changed replaces that preset and is drawn with; the other pen keeps its own', () => {
    const ink = defaultDeckInk();
    const a = patchDeckInk(ink, { slotColor: { idx: 1, color: '#123456' } });
    expect(a.pens.pen.colors[1]).toBe('#123456');
    expect(a.pens.pen.color).toBe('#123456');
    expect(ink.pens.pen.colors[1]).not.toBe('#123456');   // (a new object)
    const b = patchDeckInk(a, { pen: 'highlighter', width: 40 });
    expect(b.pen).toBe('highlighter');
    expect(b.pens.highlighter.width).toBe(40);
    expect(b.pens.pen.color).toBe('#123456');
    expect(patchDeckInk(b, { slotWidth: { idx: 9, width: 3 } })).toEqual(b);   // no such preset
  });

  it('the eraser, the lasso and draw-and-hold are kept with the pens; the lasso takes something of every kind, and a colour filter only for this visit', () => {
    const ink = defaultDeckInk();
    const p = patchDeckInk(ink, { eraser: { precise: true, size: 2 }, lasso: ['ink'], snap: false });
    expect(p.eraser).toEqual({ precise: true, size: 2, hlOnly: false, back: false });
    expect(p.lasso).toEqual(['ink']);
    expect(p.snap).toBe(false);
    // nothing is not a choice: the lasso keeps what it took
    expect(patchDeckInk(p, { lasso: [] }).lasso).toEqual(['ink']);
    saveDeckInk(p);
    expect(loadDeckInk().eraser.size).toBe(2);
    setLassoColors(['#FF0000']);
    expect(deckInkStyle(loadDeckInk()).lasso).toEqual({ kinds: ['ink'], colors: ['#ff0000'] });
    setLassoColors([]);
    saveDeckInk(defaultDeckInk());
    expect(hexColor('rgb(255, 0, 16)')).toBe('#ff0010');
    expect(hexColor('rgba(0, 0, 0, 0)')).toBeNull();
    expect(hexColor('#abc')).toBe('#aabbcc');
    expect(colorsPass([], [])).toBe(true);
    expect(colorsPass(['#ff0010'], ['rgb(255, 0, 16)'])).toBe(true);
    expect(colorsPass(['#ff0010'], ['#000000', null])).toBe(false);
  });

  it("the stroke's ink: the highlighter translucent, widths scaled to the page (a poster's as thick, seen whole, as a slide's)", () => {
    const ink = defaultDeckInk();
    expect(deckInkStyle(ink)).toEqual({
      color: ink.pens.pen.color, width: 4, opacity: 1, nib: DEFAULT_NIB, scribble: true, penInks: true,
      snap: true, eraser: { precise: false, size: 1, hlOnly: false, back: false }, lasso: { kinds: ['ink', 'shapes', 'pictures', 'text'], colors: [] },
    });
    // a Pencil has drawn in this browser: fingers move the slide — unless they are to draw too
    expect(deckInkStyle(patchDeckInk(ink, { pencil: true })).fingers).toBe('pan');
    expect(deckInkStyle(patchDeckInk(ink, { pencil: true, fingersDraw: true })).fingers).toBe('draw');
    expect(deckInkStyle(ink, 2560).width).toBe(8);
    expect(deckInkStyle(patchDeckInk(ink, { pen: 'highlighter' })).opacity).toBeLessThan(1);
    // the pen draws right away unless its settings say otherwise
    expect(deckInkStyle(patchDeckInk(ink, { penInks: false })).penInks).toBe(false);
    // the pen's settings go with the pen, not the highlighter
    expect(deckInkStyle(patchDeckInk(ink, { pen: 'highlighter' })).nib).toBeUndefined();
  });

  it("the pen's settings (GoodNotes'): 0, 25 %, 0, 0 to start with, a little rounding; changed one at a time, each between 0 and 1", () => {
    expect(defaultDeckInk().nib).toEqual({ ball: false, sharpness: 0, sensitivity: 0.25, flatness: 0, stabilization: 0, rounding: 0.3, usual: 0.25 });
    const a = patchDeckInk(defaultDeckInk(), { nib: { ball: true } });
    expect(a.nib.ball).toBe(true);
    const b = patchDeckInk(a, { nib: { sharpness: 0.5, flatness: 7, stabilization: -1 } });
    expect(b.nib).toEqual({ ball: true, sharpness: 0.5, sensitivity: 0.25, flatness: 0, stabilization: 0, rounding: 0.3, usual: 0.25 });
    // (the usual pressure measured: never 0 or 1, where every width would be off)
    expect(patchDeckInk(b, { nib: { usual: 0, rounding: 0 } }).nib).toMatchObject({ usual: 0.05, rounding: 0 });
    // (another change leaves them as they are)
    expect(patchDeckInk(b, { color: '#123456' }).nib).toEqual(b.nib);
    saveDeckInk(b);
    expect(loadDeckInk().nib).toEqual(b.nib);
    localStorage.setItem('ol.deckInk', JSON.stringify({ nib: { ball: 'yes', sharpness: 'x', sensitivity: 2 } }));
    expect(loadDeckInk().nib).toEqual(DEFAULT_NIB);
    localStorage.removeItem('ol.deckInk');
  });

  it("is kept in this browser; what is broken in storage is the default's", () => {
    saveDeckInk(patchDeckInk(defaultDeckInk(), { pen: 'highlighter', color: '#4285f4' }));
    const back = loadDeckInk();
    expect(back.pen).toBe('highlighter');
    expect(back.pens.highlighter.color).toBe('#4285f4');
    localStorage.setItem('ol.deckInk', JSON.stringify({ pen: 'brush', pens: { pen: { color: 'red', width: -1, colors: [1, 2], widths: 'x' } } }));
    expect(loadDeckInk()).toEqual(defaultDeckInk());
    localStorage.setItem('ol.deckInk', '{');
    expect(loadDeckInk()).toEqual(defaultDeckInk());
    localStorage.removeItem('ol.deckInk');
  });
});

describe('an SVG file as a drawing on the page', () => {
  const SVG = `<?xml version="1.0"?>
<!DOCTYPE svg PUBLIC "-//W3C//DTD SVG 1.1//EN" "http://www.w3.org/Graphics/SVG/1.1/DTD/svg11.dtd">
<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" xmlns:sodipodi="http://sodipodi.sourceforge.net/DTD/sodipodi-0.dtd" width="200" height="100" viewBox="0 0 200 100" onload="alert(0)">
  <sodipodi:namedview id="nv" pagecolor="#fff"/>
  <script>alert(1)</script>
  <foreignObject><div xmlns="http://www.w3.org/1999/xhtml">x</div></foreignObject>
  <defs><linearGradient id="g"><stop offset="0" stop-color="#f00"/></linearGradient><symbol id="s" viewBox="0 0 10 10"><rect width="10" height="10"/></symbol></defs>
  <style>@import url(https://evil.example/x.css); #r1 { stroke: red; } .k { fill: url(#g); }</style>
  <rect id="r1" x="10" y="10" width="80" height="80" fill="url(#g)" onclick="alert(2)" sodipodi:nodetypes="cccc"/>
  <image href="https://tracker.example/p.png" width="10" height="10"/>
  <image xlink:href="data:image/png;base64,iVBORw0KGgo=" width="10" height="10"/>
  <use xlink:href="#s" x="100" y="10" width="40" height="40"/>
  <a href="javascript:alert(3)"><circle cx="150" cy="70" r="20" style="fill: url(https://evil.example/p.svg#x)"/></a>
</svg>`;
  const html = inlineSvgHtml(SVG, { x: 640, y: 360, maxW: 768 }, 'sX')!;

  it('keeps the drawing, removes what could run or reach out', () => {
    expect(html).toBeTruthy();
    expect(html).not.toMatch(/<script|onload|onclick|foreignObject|sodipodi|javascript:|evil\.example|tracker\.example|<!DOCTYPE|<\?xml/i);
    expect(html).toContain('<rect id="sX-r1"');
    expect(html).toContain('data:image/png;base64');
  });

  it('gives its ids a prefix and follows them in references and styles', () => {
    expect(html).toContain('<linearGradient id="sX-g">');
    expect(html).toContain('fill="url(#sX-g)"');
    expect(html).toMatch(/xlink:href="#sX-s"|href="#sX-s"/);
    expect(html).toContain('#sX-r1 { stroke: red; }');
    expect(html).toContain('fill: url(#sX-g)');
  });

  it('is placed centred on the drop point, its size from width / height or the viewBox, at most maxW wide', () => {
    expect(html).toMatch(/^<svg xmlns="http:\/\/www\.w3\.org\/2000\/svg"[^>]*style="position: absolute; left: 540px; top: 310px; width: 200px; height: 100px; overflow: visible"/);
    const wide = inlineSvgHtml('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 2000 1000"><rect width="10" height="10"/></svg>', { x: 640, y: 360, maxW: 768 }, 'w')!;
    expect(wide).toContain('width: 768px; height: 384px');
    const page = inlineSvgHtml('<svg xmlns="http://www.w3.org/2000/svg" width="50mm" height="20mm"><rect width="10" height="10"/></svg>', null, 'p')!;
    expect(page).toContain('width: 189px; max-width: 100%; height: auto');
    expect(page).toContain('viewBox="0 0 188.98 75.59"');
  });

  it('is not made of what is no SVG (then the file goes in as a picture or is refused)', () => {
    expect(inlineSvgHtml('not really an svg', null, 'x')).toBeNull();
    expect(inlineSvgHtml('<html><body>hi</body></html>', null, 'x')).toBeNull();
    expect(inlineSvgHtml('<svg xmlns="http://www.w3.org/2000/svg">' + 'x'.repeat(500_000) + '</svg>', null, 'x')).toBeNull();
  });
});

describe('the reorder operation (Arrange ▸ order)', () => {
  const T = `<body>\n<section class="slide">\n  <div id="a"></div>\n  <div id="b"></div>\n  <!-- c -->\n  <div id="c"></div>\n</section>\n</body>`;

  it('puts the children in the new order, the text between them in its place', () => {
    const out = applyOp(T, { t: 'reorder', parent: [1, 0], order: [1, 2, 0] });
    expect(out).toBe(`<body>\n<section class="slide">\n  <div id="b"></div>\n  <div id="c"></div>\n  <!-- c -->\n  <div id="a"></div>\n</section>\n</body>`);
  });

  it('changes nothing for the same order and refuses an order that does not fit the children', () => {
    expect(opSplices(parseSource(T), { t: 'reorder', parent: [1, 0], order: [0, 1, 2] })).toEqual([]);
    expect(() => applyOp(T, { t: 'reorder', parent: [1, 0], order: [0, 1] })).toThrow();
    expect(() => applyOp(T, { t: 'reorder', parent: [1, 0], order: [0, 0, 1] })).toThrow();
  });

  it("an SVG's camel-case attribute is replaced, not written a second time (the parser keys locations in lower case)", () => {
    const svg = '<body>\n<svg viewBox="0 0 10 10" preserveAspectRatio="none"><path d="M0 0"/></svg>\n</body>';
    const out = applyOp(svg, { t: 'attr', path: [1, 0], name: 'viewBox', value: '-1 -1 12 12' });
    expect(out).toBe('<body>\n<svg viewBox="-1 -1 12 12" preserveAspectRatio="none"><path d="M0 0"/></svg>\n</body>');
    expect(applyOp(svg, { t: 'attr', path: [1, 0], name: 'preserveAspectRatio', value: null })).toBe('<body>\n<svg viewBox="0 0 10 10"><path d="M0 0"/></svg>\n</body>');
  });

  it('is rebased like the other operations (by its parent)', () => {
    const newer = T.replace('<body>', '<body class="x">');
    expect(rebaseOp(T, newer, { t: 'reorder', parent: [1, 0], order: [2, 1, 0] })).toEqual({ t: 'reorder', parent: [1, 0], order: [2, 1, 0] });
  });
});
