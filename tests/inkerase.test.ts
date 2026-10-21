/** The precise eraser (core/inkerase.ts): what is left of a stroke either side of where it rubbed. */
import { describe, it, expect } from 'vitest';
import { cutPolyline, eraseAlong } from '../packages/core/src/inkerase.ts';

const line = (n = 11): [number, number, number][] => Array.from({ length: n }, (_, i) => [i * 10, 0, 0.5]);

describe('precise eraser', () => {
  it('a disc on the middle of a stroke leaves two pieces, cut where the disc began and ended', () => {
    const cut = cutPolyline(line(), 50, 0, 12)!;
    expect(cut).toHaveLength(2);
    expect(cut[0][0]).toEqual([0, 0, 0.5]);
    expect(cut[0][cut[0].length - 1][0]).toBeCloseTo(38);
    expect(cut[1][0][0]).toBeCloseTo(62);
    expect(cut[1][cut[1].length - 1]).toEqual([100, 0, 0.5]);
    // the pressure goes with the point
    expect(cut[1][0][2]).toBeCloseTo(0.5);
  });

  it('a disc that misses changes nothing; one over a whole stroke rubs it out; one at an end shortens it', () => {
    expect(cutPolyline(line(), 50, 30, 12)).toBeNull();
    expect(cutPolyline(line(3), 10, 0, 40)).toEqual([]);
    const end = cutPolyline(line(), 100, 0, 15)!;
    expect(end).toHaveLength(1);
    expect(end[0][end[0].length - 1][0]).toBeCloseTo(85);
  });

  it('a segment that passes through the disc with both ends outside is cut too', () => {
    const cut = cutPolyline([[0, 0], [100, 0]], 50, 2, 5)!;
    expect(cut).toHaveLength(2);
    expect(cut[0][1][0]).toBeCloseTo(50 - Math.sqrt(21));
  });

  it('a closed outline cut once stays one piece, opened there', () => {
    const square: [number, number][] = [[0, 0], [100, 0], [100, 100], [0, 100], [0, 0]];
    const cut = cutPolyline(square, 50, 100, 10)!;
    expect(cut).toHaveLength(1);
    expect(cut[0][0][0]).toBeCloseTo(40);
    expect(cut[0][cut[0].length - 1][0]).toBeCloseTo(60);
  });

  it('dragged across several strokes, only those it touched change', () => {
    const lines = [line(), line().map(([x]) => [x, 50, 0.5] as [number, number, number]), line().map(([x]) => [x, 200, 0.5] as [number, number, number])];
    const left = eraseAlong(lines, [50, -20], [50, 70], 6);
    expect([...left.keys()]).toEqual([0, 1]);
    expect(left.get(0)).toHaveLength(2);
    expect(left.get(1)).toHaveLength(2);
    // along a stroke: it goes
    const along = eraseAlong([line()], [-10, 0], [110, 0], 5);
    expect(along.get(0)).toEqual([]);
  });
});
