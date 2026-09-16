/**
 * Geometry of a rendered formula — the mathed part of LyX's coordinate cache and the algorithms
 * that read it (MathRow::metrics for the boxes, MathData::pos2x / x2pos / dist,
 * InsetMathNest::editXY, Cursor::moveToClosestEdge, the `realAnchor().hasPart()` rule of
 * InsetMathNest::lfunMouseMotion), measured from KaTeX's output.
 *
 * The renderer wraps every cell in a `.lm-c<id>` span and every atom of a cell in an `.lm-a` span
 * (core/math/katex.ts), so a cell's children, in order, are its atoms — the MathRow LyX lays out
 * for a MathData. Horizontal extents are the boxes the browser laid out. Vertical extents come
 * from KaTeX's own height/depth of each wrapper (`data-h` / `data-d`, in em of the wrapper's font
 * size; the field copies them out of KaTeX's build tree), placed around the cell's baseline: an
 * inline span's client rect is always its font's line box, whatever it contains, and a fraction or
 * a big operator is far taller than that. As in LyX, a cell (and an inset) is never shorter than
 * the font's line box (MathData::metrics: "set a minimal ascent/descent for the cell").
 */
import { atomCells, nargs, isHull, type Atom, type CellRef, type Owner, type Slice, type Hull } from '@overlyx/core';

export interface Box { left: number; right: number; top: number; bottom: number }

/** an atom of a cell: its wrapper box (with the spacing KaTeX puts after it, as LyX's inset widths include their spacing) and the visible content */
export interface AtomGeom extends Box {
  atom: Atom;
  el: HTMLElement;
  /** the visible content, without the trailing inter-atom glue (a fraction: its bar and cells, not KaTeX's null delimiters) */
  glyphLeft: number;
  glyphRight: number;
  /** the atom has cells the cursor can enter */
  nest: boolean;
}

export interface CellGeom extends Box {
  ref: CellRef;
  el: HTMLElement;
  /** the empty-cell box (`lm-empty`) */
  empty: boolean;
  baseline: number;
  fontSize: number;
  /** the font's line box (the caret's extent, like LyX's caret at the current font) */
  lineTop: number;
  lineBottom: number;
  atoms: AtomGeom[];
}

/** what the algorithms need: the box of any cell (measured on demand) */
export interface GeomLookup {
  cell(owner: Owner, idx: number): CellGeom | null;
}

/* ------------------------------------------------------------------ LyX algorithms (pure) */

/**
 * MathData::pos2x: the x of the boundary before position `pos`. LyX splits the spacing between
 * two atoms evenly, so the boundary lies in the middle of the gap; KaTeX puts the glue after the
 * first atom, so the middle between its glyphs and the next atom is taken.
 */
export function boundaryX(cg: CellGeom, pos: number): number {
  const n = cg.atoms.length;
  if (!n) return cg.empty ? cg.left + 1 : cg.left;
  if (pos <= 0) return cg.atoms[0].left;
  if (pos >= n) return cg.atoms[n - 1].glyphRight;
  return (cg.atoms[pos - 1].glyphRight + cg.atoms[pos].left) / 2;
}

/**
 * MathData::x2pos: the position in the cell closest to x — with LyX's rule that the boundary before
 * an inset with cells wins when the x lies inside that inset (the cursor slices above an inset are
 * kept in front of it; editXY then descends, or moveToClosestEdge steps over it).
 */
export function x2pos(cg: CellGeom, x: number): number {
  const n = cg.atoms.length;
  if (!n) return 0;
  let k = 0;
  while (k < n && boundaryX(cg, k) < x) k++;
  // k is the first boundary at or after x (or n if x is past the last atom's right edge)
  if (k > 0 && k <= n && boundaryX(cg, k) >= x) {
    const crossed = cg.atoms[k - 1];
    if (crossed.nest || Math.abs(boundaryX(cg, k - 1) - x) < Math.abs(boundaryX(cg, k) - x)) k--;
  }
  return k;
}

/** CoordCache::squareDistance: 0 inside the box */
export function squareDistance(b: Box, x: number, y: number): number {
  const xx = x < b.left ? b.left - x : x > b.right ? x - b.right : 0;
  const yy = y < b.top ? b.top - y : y > b.bottom ? y - b.bottom : 0;
  return xx * xx + yy * yy;
}

export function covers(b: Box, x: number, y: number): boolean {
  return x >= b.left && x <= b.right && y >= b.top && y <= b.bottom;
}

/**
 * Inset::covers for the i-th atom of a cell: horizontally the atom's span between the cell's
 * boundaries (the same boundaries x2pos uses — LyX's inset boxes are contiguous, so a point is
 * inside an inset exactly when x2pos puts the position at it), vertically its own box.
 */
export function atomCovers(cg: CellGeom, i: number, x: number, y: number): boolean {
  const a = cg.atoms[i];
  return !!a && x >= boundaryX(cg, i) && x <= boundaryX(cg, i + 1) && y >= a.top && y <= a.bottom;
}

/** the inset with cells at or right before position `pos` of a cell that covers the point: its index, or -1 */
function nestAt(cg: CellGeom, pos: number, x: number, y: number): number {
  if (cg.atoms[pos]?.nest && atomCovers(cg, pos, x, y)) return pos;
  if (pos > 0 && cg.atoms[pos - 1]?.nest && atomCovers(cg, pos - 1, x, y)) return pos - 1;
  return -1;
}

/**
 * InsetMathNest::editXY: the cursor for a point, from `owner` (the hull, or an inset the cursor is
 * being placed in) downwards. The cell closest to the point wins (the first one on ties); when the
 * point lies inside that cell and over an inset with cells, the search goes on inside it.
 */
export function editXY(g: GeomLookup, owner: Owner, x: number, y: number): Slice[] {
  const out: Slice[] = [];
  for (let guard = 0; guard < 64; guard++) {
    const cells = atomCells(owner);
    let idxMin = -1, distMin = Infinity, best: CellGeom | null = null;
    for (let i = 0; i < cells.length; i++) {
      const cg = g.cell(owner, i);
      if (!cg) continue;
      const d = squareDistance(cg, x, y);
      if (d < distMin) { distMin = d; idxMin = i; best = cg; }
    }
    if (idxMin < 0 || !best) { if (!out.length) out.push({ owner, idx: 0, pos: 0 }); return out; }
    const pos = x2pos(best, x);
    out.push({ owner, idx: idxMin, pos });
    if (distMin !== 0) return out;
    // hit inside the cell: down into the inset under the pointer — the slice above it points at it
    const i = nestAt(best, pos, x, y);
    if (i < 0) return out;
    out[out.length - 1].pos = i;
    owner = best.atoms[i].atom;
  }
  return out;
}

/**
 * Cursor::moveToClosestEdge: with the cursor in front of an atom, step behind it when x is nearer
 * to its right edge (bug 9748 in LyX: clicking the right half of a fraction from above used to put
 * the cursor before it).
 */
export function moveToClosestEdge(g: GeomLookup, slices: Slice[], x: number): void {
  const top = slices[slices.length - 1];
  const cg = g.cell(top.owner, top.idx);
  if (!cg || !cg.atoms[top.pos]) return;
  if (x > (boundaryX(cg, top.pos) + boundaryX(cg, top.pos + 1)) / 2) top.pos++;
}

/**
 * The part of a cursor a drag may move to (InsetMathNest::lfunMouseMotion: a motion nested deeper
 * than the anchor, or into an inset off the anchor's chain, is left undispatched and handled by the
 * enclosing inset with the cursor popped out of the inset — DocIterator::hasPart). The popped-out
 * inset is then taken whole at its closest edge.
 */
export function partOfAnchor(anchor: Slice[], slices: Slice[]): Slice[] {
  let t = slices;
  while (t.length > 1 && !(anchor.length >= t.length && anchor[t.length - 1].owner === t[t.length - 1].owner)) t = t.slice(0, -1);
  return t.map(s => ({ ...s }));
}

/** the innermost inset with cells whose box covers the point (LyX: the inset under the mouse), or null */
export function insetAt(g: GeomLookup, hull: Hull, x: number, y: number): Atom | null {
  let owner: Owner = hull;
  let found: Atom | null = null;
  for (let guard = 0; guard < 64; guard++) {
    const cells = atomCells(owner);
    let hit: AtomGeom | undefined;
    for (let i = 0; i < cells.length && !hit; i++) {
      const cg = g.cell(owner, i);
      if (!cg || squareDistance(cg, x, y) !== 0) continue;
      const k = nestAt(cg, x2pos(cg, x), x, y);
      if (k >= 0) hit = cg.atoms[k];
    }
    if (!hit) return found;
    found = hit.atom;
    owner = hit.atom;
  }
  return found;
}

/* ------------------------------------------------------------------ measuring KaTeX's output */

const CELL_RE = /(?:^|\s)lm-c(\d+)(?:\s|$)/;

/**
 * The boxes of a rendered formula, measured lazily per cell and cached. Client coordinates of the
 * moment of measuring: build a new one when the content is re-rendered or has moved (the field
 * compares its content box).
 */
export class MathGeometry implements GeomLookup {
  private byId = new Map<number, HTMLElement>();
  private cache = new Map<Owner, (CellGeom | null)[]>();
  /** baseline offset of a wrapper span in units of its font size (measured once with a probe) */
  private k: number | null = null;

  constructor(private content: HTMLElement, private cells: CellRef[], private parents: Map<Owner, { owner: Owner; idx: number; pos: number }>) {
    for (const el of Array.from(content.querySelectorAll<HTMLElement>('.enclosing'))) {
      const m = CELL_RE.exec(el.className);
      if (m) this.byId.set(Number(m[1]), el);
    }
  }

  cell(owner: Owner, idx: number): CellGeom | null {
    let arr = this.cache.get(owner);
    if (!arr) { arr = []; this.cache.set(owner, arr); }
    if (idx in arr) return arr[idx];
    const ref = this.cells.find(c => c.owner === owner && c.idx === idx);
    const el = ref ? this.byId.get(ref.id) : undefined;
    const cg = ref && el ? this.measure(ref, el) : null;
    arr[idx] = cg;
    return cg;
  }

  /** the box of an inset atom (through its parent cell), or null */
  atom(atom: Atom): AtomGeom | null {
    const p = this.parents.get(atom);
    if (!p) return null;
    const cg = this.cell(p.owner, p.idx);
    const a = cg?.atoms[p.pos];
    return a && a.atom === atom ? a : cg?.atoms.find(x => x.atom === atom) ?? null;
  }

  /** the distance of the baseline from the top of a wrapper's line box, in em (KaTeX's fonts; measured, not assumed) */
  private baselineRatio(el: HTMLElement, rect: DOMRect, fs: number): number {
    if (this.k !== null) return this.k;
    const probe = document.createElement('span');
    probe.style.cssText = 'display:inline-block;width:0;height:0;vertical-align:baseline;padding:0;margin:0;border:0';
    el.appendChild(probe);
    const y = probe.getBoundingClientRect().top;
    probe.remove();
    const k = (y - rect.top) / fs;
    this.k = isFinite(k) && k > 0 && k < 2 ? k : 0.91;
    return this.k;
  }

  private measure(ref: CellRef, el: HTMLElement): CellGeom {
    const rect = el.getBoundingClientRect();
    const fs = parseFloat(getComputedStyle(el).fontSize) || 16;
    const empty = el.classList.contains('lm-empty');
    if (empty) {
      return { ref, el, empty, baseline: rect.bottom - 0.1 * fs, fontSize: fs, left: rect.left, right: rect.right, top: rect.top, bottom: rect.bottom, lineTop: rect.top, lineBottom: rect.bottom, atoms: [] };
    }
    const baseline = rect.top + this.baselineRatio(el, rect, fs) * fs;
    const cell = atomCells(ref.owner)[ref.idx] ?? [];
    const metric = (e: HTMLElement): [number, number] | null => {
      const h = parseFloat(e.getAttribute('data-h') ?? ''), d = parseFloat(e.getAttribute('data-d') ?? '');
      return isFinite(h) && isFinite(d) ? [baseline - h * fs, baseline + d * fs] : null;
    };
    // the cell: KaTeX's height/depth of its content, never less than the font's line box
    const m = metric(el);
    const top = Math.min(rect.top, m ? m[0] : rect.top), bottom = Math.max(rect.bottom, m ? m[1] : rect.bottom);
    const atoms: AtomGeom[] = [];
    let i = 0;
    for (const child of Array.from(el.children) as HTMLElement[]) {
      if (!child.classList.contains('lm-a') || child.classList.contains('lm-ghost')) continue;
      const atom = cell[i];
      if (!atom) break;
      const r = child.getBoundingClientRect();
      // KaTeX inserts the glue between two atoms as a trailing .mspace inside the first one's wrapper
      const kids = Array.from(child.children) as HTMLElement[];
      const last = kids.length > 1 && kids[kids.length - 1].classList.contains('mspace') ? kids[kids.length - 2] : kids[kids.length - 1];
      let glyphLeft = r.left, glyphRight = last ? Math.max(r.left, last.getBoundingClientRect().right) : r.right;
      if (atom.t === 'frac') {
        const bar = child.querySelector<HTMLElement>('.mfrac');
        if (bar) { const br = bar.getBoundingClientRect(); if (br.width) { glyphLeft = br.left; glyphRight = br.right; } }
      }
      const am = metric(child);
      atoms.push({
        atom, el: child, nest: nargs(atom) > 0,
        left: r.left, right: Math.max(r.right, glyphRight), glyphLeft, glyphRight,
        top: Math.min(rect.top, am ? am[0] : rect.top), bottom: Math.max(rect.bottom, am ? am[1] : rect.bottom),
      });
      i++;
    }
    return { ref, el, empty, baseline, fontSize: fs, left: rect.left, right: rect.right, top, bottom, lineTop: rect.top, lineBottom: rect.bottom, atoms };
  }
}

export { isHull };
