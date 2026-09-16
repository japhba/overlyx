/**
 * The LyX coordinate algorithms of the math editor (client/editor/lyxmath/geometry.ts) on
 * synthetic boxes: MathData::x2pos / pos2x, InsetMathNest::editXY, Cursor::moveToClosestEdge,
 * the realAnchor().hasPart() rule of lfunMouseMotion, and the inset under the pointer.
 */
import { describe, it, expect } from 'vitest';
import { parseFormula, atomCells, type Owner, type Atom, type Slice } from '../packages/core/src/math';
import { boundaryX, x2pos, editXY, moveToClosestEdge, partOfAnchor, insetAt, squareDistance, type CellGeom, type AtomGeom, type GeomLookup } from '../packages/client/src/editor/lyxmath/geometry';

const el = {} as HTMLElement;

/** a cell laid out left to right: every atom `w` wide with a `gap` of glue after it (glue belongs to the atom's wrapper, as in KaTeX) */
function cellGeom(owner: Owner, idx: number, left: number, baseline: number, opts: { w?: number; gap?: number; asc?: number; des?: number } = {}): CellGeom {
  const cell = atomCells(owner)[idx];
  const w = opts.w ?? 10, gap = opts.gap ?? 4, asc = opts.asc ?? 8, des = opts.des ?? 3;
  const atoms: AtomGeom[] = [];
  let x = left;
  for (const atom of cell) {
    const nest = 'body' in atom || atom.t === 'frac' || atom.t === 'script' || atom.t === 'grid';
    const ww = nest ? 3 * w : w;
    atoms.push({ atom, el, nest, left: x, right: x + ww + gap, glyphLeft: x, glyphRight: x + ww, top: baseline - (nest ? 2 * asc : asc), bottom: baseline + (nest ? 2 * des : des) });
    x += ww + gap;
  }
  const right = atoms.length ? atoms[atoms.length - 1].glyphRight : left + 6;
  // a cell is as tall as its tallest atom, never shorter than the font's line box (MathData::metrics)
  const top = Math.min(baseline - asc, ...atoms.map(a => a.top)), bottom = Math.max(baseline + des, ...atoms.map(a => a.bottom));
  return { ref: { id: 0, owner, idx }, el, empty: !cell.length, baseline, fontSize: 10, left, right, top, bottom, lineTop: baseline - asc, lineBottom: baseline + des, atoms };
}

/** a lookup over a formula: hull cells side by side on one baseline, an inset's cells stacked inside its box */
function lookup(hull: ReturnType<typeof parseFormula>, place: Map<Owner, (idx: number) => CellGeom>): GeomLookup {
  return { cell: (owner, idx) => place.get(owner)?.(idx) ?? null };
}

describe('x2pos / pos2x on one cell', () => {
  const h = parseFormula('$ab+c$', {});
  const g = cellGeom(h, 0, 100, 50);   // a: 100-110 (+4 glue), b: 114-124, +: 128-138, c: 142-152
  it('boundaries lie at the start, in the middle of the gaps, and at the end', () => {
    expect(boundaryX(g, 0)).toBe(100);
    expect(boundaryX(g, 1)).toBe(112);
    expect(boundaryX(g, 2)).toBe(126);
    expect(boundaryX(g, 4)).toBe(152);
  });
  it('the closest boundary wins', () => {
    expect(x2pos(g, 90)).toBe(0);
    expect(x2pos(g, 104)).toBe(0);
    expect(x2pos(g, 107)).toBe(1);
    expect(x2pos(g, 112)).toBe(1);
    expect(x2pos(g, 118)).toBe(1);
    expect(x2pos(g, 120)).toBe(2);
    expect(x2pos(g, 150)).toBe(4);
    expect(x2pos(g, 999)).toBe(4);
  });
  it('an empty cell has one position', () => {
    const e = cellGeom(parseFormula('$$', {}), 0, 10, 20);
    expect(x2pos(e, 15)).toBe(0);
    expect(boundaryX(e, 0)).toBe(11);
  });
});

describe('x2pos before an inset', () => {
  const h = parseFormula('$a\\frac{u}{v}b$', {});
  const g = cellGeom(h, 0, 0, 50);     // a: 0-10 (+4), frac: 14-44 (+4), b: 48-58
  it('inside the inset the position before it is kept (its cells decide, or moveToClosestEdge)', () => {
    expect(x2pos(g, 40)).toBe(1);   // right part of the fraction: still before it
    expect(x2pos(g, 20)).toBe(1);
  });
  it('past the inset the position after it', () => {
    expect(x2pos(g, 47)).toBe(2);
  });
});

describe('editXY', () => {
  const h = parseFormula('$a\\frac{u}{v}b$', {});
  const frac = atomCells(h)[0][1] as Atom;
  const hullCell = cellGeom(h, 0, 0, 50);
  const fr = hullCell.atoms[1];   // 14-44 wide, 34-56 tall
  const num = cellGeom(frac, 0, 20, 40, { w: 6, asc: 5, des: 1 });
  const den = cellGeom(frac, 1, 20, 54, { w: 6, asc: 5, des: 1 });
  const g = lookup(h, new Map<Owner, (idx: number) => CellGeom>([[h, () => hullCell], [frac, i => (i === 0 ? num : den)]]));
  it('a point over the fraction lands in the numerator or denominator', () => {
    const s = editXY(g, h, 22, 38);
    expect(s.length).toBe(2);
    expect(s[0]).toEqual({ owner: h, idx: 0, pos: 1 });
    expect(s[1].owner).toBe(frac); expect(s[1].idx).toBe(0);
    expect(editXY(g, h, 22, 55)[1].idx).toBe(1);
  });
  it('a point outside every cell goes to the nearest one, and does not enter insets', () => {
    const s = editXY(g, h, fr.left + 20, 10);   // far above the fraction
    expect(s.length).toBe(1);
    expect(s[0].pos).toBe(1);
    const t = editXY(g, h, 55, 80);
    expect(t).toEqual([{ owner: h, idx: 0, pos: 3 }]);
  });
  it('moveToClosestEdge steps behind the inset when the pointer is right of its middle', () => {
    const s = editXY(g, h, fr.left + 20, 10);
    moveToClosestEdge(g, s, fr.left + 20);
    expect(s[0].pos).toBe(2);
    const t = editXY(g, h, fr.left + 5, 10);
    moveToClosestEdge(g, t, fr.left + 5);
    expect(t[0].pos).toBe(1);
  });
  it('the nearest cell wins on distance, the first on ties', () => {
    const grid = parseFormula('$\\begin{pmatrix}a&b\\end{pmatrix}$', {});
    const m = atomCells(grid)[0][0] as Atom;
    const c0 = cellGeom(m, 0, 0, 50), c1 = cellGeom(m, 1, 30, 50);
    const gl = lookup(grid, new Map<Owner, (idx: number) => CellGeom>([[grid, () => cellGeom(grid, 0, 0, 50)], [m, i => (i === 0 ? c0 : c1)]]));
    expect(editXY(gl, m, 35, 50)[0].idx).toBe(1);
    expect(editXY(gl, m, 20, 50)[0].idx).toBe(0);   // 10 from cell 0's right edge, 10 from cell 1's left edge: the first
    expect(squareDistance(c0, 20, 50)).toBe(100);
  });
});

describe('partOfAnchor (lfunMouseMotion: motions deeper than the anchor pop out)', () => {
  const h = parseFormula('$a\\frac{u}{v}b$', {});
  const frac = atomCells(h)[0][1] as Atom;
  const inFrac: Slice[] = [{ owner: h, idx: 0, pos: 1 }, { owner: frac, idx: 0, pos: 1 }];
  it('a shallow anchor keeps the cursor at its level', () => {
    expect(partOfAnchor([{ owner: h, idx: 0, pos: 0 }], inFrac)).toEqual([{ owner: h, idx: 0, pos: 1 }]);
  });
  it('an anchor in the inset lets the cursor move inside it', () => {
    expect(partOfAnchor(inFrac, [{ owner: h, idx: 0, pos: 1 }, { owner: frac, idx: 1, pos: 0 }]).length).toBe(2);
  });
  it('the cursor may be shallower than the anchor', () => {
    expect(partOfAnchor(inFrac, [{ owner: h, idx: 0, pos: 3 }])).toEqual([{ owner: h, idx: 0, pos: 3 }]);
  });
});

describe('insetAt', () => {
  const h = parseFormula('$a\\frac{u}{v}b$', {});
  const frac = atomCells(h)[0][1] as Atom;
  const hullCell = cellGeom(h, 0, 0, 50);
  const g = lookup(h, new Map<Owner, (idx: number) => CellGeom>([[h, () => hullCell], [frac, i => cellGeom(frac, i, 20, i ? 54 : 40, { w: 6, asc: 5, des: 1 })]]));
  it('finds the inset under the pointer, none over a character', () => {
    expect(insetAt(g, h, 30, 50)).toBe(frac);
    expect(insetAt(g, h, 5, 50)).toBeNull();
    expect(insetAt(g, h, 30, 5)).toBeNull();
  });
});
