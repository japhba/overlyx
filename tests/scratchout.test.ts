/** Scratch-out (core/scratchout.ts): the shape of a scribble, and what of the ink under it goes. */
import { describe, it, expect } from 'vitest';
import { scratchOut, scribbleCusps, type Pt } from '../packages/core/src/scratchout.ts';

const pts = (f: (t: number) => Pt, n = 400) => Array.from({ length: n + 1 }, (_, i) => f(i / n));
/** a zig-zag over x0..x1 between y0 and y1, `legs` legs */
const zigzag = (x0: number, x1: number, y0: number, y1: number, legs: number) => pts(t => [x0 + (x1 - x0) * t, y0 + (y1 - y0) * Math.abs(((t * legs) % 2) - 1)]);
/** a handwritten word in x 0..100, y 0..24: letters as small strokes (c, l, o, an i and its dot, a t and its bar) */
const word: Pt[][] = [
  pts(t => [10 - 8 * Math.cos(Math.PI * (0.25 + 1.5 * t)), 16 - 8 * Math.sin(Math.PI * (0.25 + 1.5 * t))], 40),   // c
  pts(t => [26, 2 + 22 * t], 30),                                                                              // l
  pts(t => [42 + 8 * Math.cos(2 * Math.PI * t), 16 + 8 * Math.sin(2 * Math.PI * t)], 40),                      // o
  pts(t => [60, 10 + 14 * t], 20), [[60, 4], [60.5, 4.5]],                                                     // i and its dot
  pts(t => [80, 2 + 22 * t], 30), pts(t => [74 + 12 * t, 9], 20),                                             // t and its bar
];

describe('scratch-out', () => {
  it('a scribble across a word erases every letter of it, the dots and bars too', () => {
    expect(scratchOut(zigzag(-4, 104, -6, 28, 16), word)?.sort((a, b) => a - b)).toEqual([0, 1, 2, 3, 4, 5, 6]);
    // a looser one (twelve legs over the whole word) — "quite insensitive" before, when the scribble had to run along the strokes
    expect(scratchOut(zigzag(-4, 104, -2, 26, 12), word)?.length).toBe(7);
    // a slanted one over half of it: that half
    expect(scratchOut(zigzag(-4, 46, -4, 26, 10), word)?.sort()).toEqual([0, 1, 2]);
  });

  it('over nothing, or written beside ink, it stays as ink', () => {
    expect(scratchOut(zigzag(200, 300, 0, 30, 12), word)).toBeNull();
    // an m written on the next line, the l's foot reaching into it: the m is no tight zig-zag, and it is not over ink
    const m = pts(t => { const u = t * 6, k = Math.min(5, Math.floor(u)), a = Math.PI * (u - k); return [k * 20 + 10 - 10 * Math.cos(a), 44 - 20 * Math.sin(a)]; });
    expect(scratchOut(m, [...word, pts(t => [26, 24 + 6 * t], 5)])).toBeNull();
    // writing that crosses one line of a drawing (a long underline under the word): the line stays
    const underline = pts(t => [-20 + 300 * t, 30], 100);
    expect(scratchOut(zigzag(20, 60, 18, 40, 12), [underline])).toBeNull();
  });

  it('a long stroke it only partly covers stays; lifting the pen far away cancels it', () => {
    const underline = pts(t => [-20 + 300 * t, 30], 100);
    expect(scratchOut(zigzag(-4, 104, -6, 34, 16), [...word, underline])).not.toContain(7);
    const tail = [...zigzag(-4, 104, -6, 28, 16), ...pts(t => [104 + 80 * t, 28 + 40 * t], 20)];
    expect(scratchOut(tail, word)).toBeNull();
  });

  it('scratch and hold: three legs over a word do it when the pen rests at the end', () => {
    const three = zigzag(-4, 30, -6, 28, 3);
    expect(scratchOut(three, word)).toBeNull();
    expect(scratchOut(three, word, { hold: true })?.length).toBeGreaterThan(0);
  });

  it('the units are the screen: at twice the zoom the same scribble on the screen is half as big', () => {
    const half = (s: Pt[]) => s.map(([x, y]) => [x / 2, y / 2] as Pt);
    expect(scratchOut(half(zigzag(-4, 104, -6, 28, 16)), word.map(half), { zoom: 2 })?.length).toBe(7);
  });

  it('tells a scribble from writing by its shape', () => {
    // zig-zags: along one axis, slanted, struck through, back and forth along a line, a quick hand's round turns
    expect(scribbleCusps(pts(t => [100 + 60 * Math.abs(((t * 7) % 2) - 1), 50 + t * 20]))).not.toBeNull();
    expect(scribbleCusps(pts(t => { const a = 40 * Math.abs(((t * 9) % 2) - 1); return [a + t * 30, a * 0.6 + 100]; }))).not.toBeNull();
    expect(scribbleCusps(pts(t => [t * 60, 30 * Math.abs(((t * 8) % 2) - 1)]))).not.toBeNull();
    expect(scribbleCusps(pts(t => [80 * Math.abs(((t * 4) % 2) - 1), 50 + t * 6]))).not.toBeNull();
    expect(scribbleCusps(pts(t => { const a = t * Math.PI * 6; return [40 + 40 * Math.tanh(4 * Math.sin(a)) / Math.tanh(4), 50 + 4 * Math.cos(a) + t * 10]; }))).not.toBeNull();
    // writing: an m (its arches as wide as high), a v v v (legs at ±55°), loops (e e e), a straight line, three legs, a circle round and round, an s
    expect(scribbleCusps(pts(t => { const u = t * 6, k = Math.min(5, Math.floor(u)), a = Math.PI * (u - k); return [k * 30 + 15 - 15 * Math.cos(a), 40 - 30 * Math.sin(a)]; }))).toBeNull();
    expect(scribbleCusps(pts(t => [t * 90, 30 * Math.abs(((t * 5) % 2) - 1)]))).toBeNull();
    expect(scribbleCusps(pts(t => [t * 120 + 10 * Math.cos(t * 30), 50 + 10 * Math.sin(t * 30)]))).toBeNull();
    expect(scribbleCusps(pts(t => [t * 200, 30]))).toBeNull();
    expect(scribbleCusps(pts(t => [60 * Math.abs(((t * 3) % 2) - 1), t * 20]))).toBeNull();
    expect(scribbleCusps(pts(t => [50 + 20 * Math.cos(t * 12), 50 + 20 * Math.sin(t * 12)]))).toBeNull();
    expect(scribbleCusps(pts(t => [30 * Math.sin(t * Math.PI * 2), t * 60]))).toBeNull();
  });
});
