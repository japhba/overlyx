/**
 * Geometry of a rendered formula — the mathed part of LyX's coordinate cache and the algorithms
 * that read it (MathRow::metrics for the boxes, MathData::pos2x / x2pos / dist,
 * InsetMathNest::editXY, Cursor::moveToClosestEdge, the `realAnchor().hasPart()` rule of
 * InsetMathNest::lfunMouseMotion), measured from MathJax's output.
 *
 * The renderer wraps every cell in a `.lm-c<id>` box and every atom of a cell in an `.lm-a` box
 * (core/math/mathjax.ts; MathJax mrows), so a cell's children, in order, are its atoms — the
 * MathRow LyX lays out for a MathData. The boxes are MathJax's: inline blocks exactly as tall and
 * deep as their content; the glue between two atoms is a margin before the second one. The
 * baseline is measured with a probe; the font size of a cell is the formula's, scaled by its
 * script level (`data-sl`: MathJax scales the characters inside, not the box). As in LyX, a cell
 * (and an inset) is never shorter than the font's line box (MathData::metrics: "set a minimal
 * ascent/descent for the cell"). A display formula MathJax broke into lines has one box per line
 * for its top cell (`mjx-linebox`): the cell's atoms are those of all of them in order, each on its
 * line, and a position is found on the line nearest the pointer.
 */
import { atomCells, nargs, isHull, type Atom, type CellRef, type Owner, type Slice, type Hull } from '@overlyx/core';

export interface Box { left: number; right: number; top: number; bottom: number }

/** an atom of a cell: its box and the visible content (the same box: MathJax puts the glue before the next atom) */
export interface AtomGeom extends Box {
  atom: Atom;
  el: HTMLElement;
  /** the visible content */
  glyphLeft: number;
  glyphRight: number;
  /** the atom has cells the cursor can enter */
  nest: boolean;
  /** the visual line it is on (CellGeom.lines) */
  line: number;
}

/** a visual line of a cell: the one line of an ordinary cell, or one of a broken display formula's */
export interface LineGeom extends Box {
  baseline: number;
  /** the font's line box around the baseline (the caret's extent) */
  lineTop: number;
  lineBottom: number;
  /** its atoms: indices `from` to `to` (exclusive) of CellGeom.atoms */
  from: number;
  to: number;
}

export interface CellGeom extends Box {
  ref: CellRef;
  el: HTMLElement;
  /** the empty-cell box (`lm-empty`) */
  empty: boolean;
  baseline: number;
  fontSize: number;
  /** the font's line box (the caret's extent, like LyX's caret at the current font) — of the first line */
  lineTop: number;
  lineBottom: number;
  atoms: AtomGeom[];
  lines: LineGeom[];
}

/** what the algorithms need: the box of any cell (measured on demand) */
export interface GeomLookup {
  cell(owner: Owner, idx: number): CellGeom | null;
}

/* ------------------------------------------------------------------ LyX algorithms (pure) */

/**
 * MathData::pos2x: the x of the boundary before position `pos`. LyX splits the spacing between
 * two atoms evenly, so the boundary lies in the middle of the gap between the first atom's glyphs
 * and the next atom.
 */
export function boundaryX(cg: CellGeom, pos: number): number {
  const n = cg.atoms.length;
  if (!n) return cg.empty ? cg.left + 1 : cg.left;
  if (pos <= 0) return cg.atoms[0].left;
  if (pos >= n) return cg.atoms[n - 1].glyphRight;
  // where a broken formula continues on the next line, the position is at that line's start
  if (cg.atoms[pos - 1].line !== cg.atoms[pos].line) return cg.atoms[pos].left;
  return (cg.atoms[pos - 1].glyphRight + cg.atoms[pos].left) / 2;
}

/** the visual line a position of the cell is shown on (the caret's line) */
export function lineOf(cg: CellGeom, pos: number): number {
  const n = cg.atoms.length;
  if (!n) return 0;
  return cg.atoms[Math.max(0, Math.min(pos, n - 1))].line;
}

/** the right edge of atom i on its line: the boundary after it, or its glyphs where its line ends */
function rightOf(cg: CellGeom, i: number): number {
  const a = cg.atoms[i], b = cg.atoms[i + 1];
  return !b || b.line !== a.line ? a.glyphRight : boundaryX(cg, i + 1);
}

/** the line nearest to a y */
function lineAt(cg: CellGeom, y: number): LineGeom {
  let best = cg.lines[0], d = Infinity;
  for (const l of cg.lines) { const dd = y < l.top ? l.top - y : y > l.bottom ? y - l.bottom : 0; if (dd < d) { d = dd; best = l; } }
  return best;
}

/**
 * MathData::x2pos: the position in the cell closest to x — with LyX's rule that the boundary before
 * an inset with cells wins when the x lies inside that inset (the cursor slices above an inset are
 * kept in front of it; editXY then descends, or moveToClosestEdge steps over it). In a cell broken
 * into lines, on the line nearest to y (or `line`).
 */
export function x2pos(cg: CellGeom, x: number, y?: number, line?: number): number {
  const n = cg.atoms.length;
  if (!n) return 0;
  const l = line !== undefined ? cg.lines[line] ?? cg.lines[0] : y !== undefined && cg.lines.length > 1 ? lineAt(cg, y) : null;
  const lo = l ? l.from : 0, hi = l ? l.to : n;
  // the boundary before position p, drawn on this line (its last one is after its last atom)
  const bx = (p: number) => (p === hi && p > lo ? rightOf(cg, p - 1) : boundaryX(cg, p));
  let k = lo;
  while (k < hi && bx(k) < x) k++;
  // k is the first boundary at or after x (or hi if x is past the line's last atom)
  if (k > lo && bx(k) >= x) {
    const crossed = cg.atoms[k - 1];
    if (crossed.nest || Math.abs(bx(k - 1) - x) < Math.abs(bx(k) - x)) k--;
  }
  return k;
}

/** the boxes a selection from position `from` to `to` of one cell covers: a piece per line */
export function selectionBoxes(cg: CellGeom, from: number, to: number): Box[] {
  if (cg.lines.length < 2) return [{ left: boundaryX(cg, from), right: boundaryX(cg, to), top: cg.top, bottom: cg.bottom }];
  const out: Box[] = [];
  for (const l of cg.lines) {
    const a = Math.max(from, l.from), b = Math.min(to, l.to);
    if (a >= b) continue;
    out.push({ left: a === l.from ? cg.atoms[a].left : boundaryX(cg, a), right: b === l.to ? cg.atoms[b - 1].glyphRight : boundaryX(cg, b), top: l.top, bottom: l.bottom });
  }
  return out;
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
  if (!a) return false;
  const left = i > 0 && cg.atoms[i - 1].line === a.line ? boundaryX(cg, i) : a.left;
  return x >= left && x <= rightOf(cg, i) && y >= a.top && y <= a.bottom;
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
    const pos = x2pos(best, x, y);
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
  const a = cg.atoms[top.pos];
  const left = top.pos > 0 && cg.atoms[top.pos - 1].line === a.line ? boundaryX(cg, top.pos) : a.left;
  if (x > (left + rightOf(cg, top.pos)) / 2) top.pos++;
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
      const k = nestAt(cg, x2pos(cg, x, y), x, y);
      if (k >= 0) hit = cg.atoms[k];
    }
    if (!hit) return found;
    found = hit.atom;
    owner = hit.atom;
  }
  return found;
}

/* ------------------------------------------------------------------ measuring MathJax's output */

/** an empty box on the baseline */
function probe(): HTMLElement {
  const p = document.createElement('span');
  p.className = 'lm-probe';
  p.style.cssText = 'display:inline-block;width:0;height:0;vertical-align:baseline;padding:0;margin:0;border:0';
  return p;
}

const CELL_RE = /(?:^|\s)lm-c(\d+)(?:\s|$)/;

/**
 * The boxes of a rendered formula, measured lazily per cell and cached. Client coordinates of the
 * moment of measuring: build a new one when the content is re-rendered or has moved (the field
 * compares its content box).
 */
export class MathGeometry implements GeomLookup {
  /** a cell's boxes: one, or one per line of a broken display formula (in order) */
  private byId = new Map<number, HTMLElement[]>();
  private cache = new Map<Owner, (CellGeom | null)[]>();
  /** the formula's font size (px) */
  private fs0 = 0;

  constructor(private content: HTMLElement, private cells: CellRef[], private parents: Map<Owner, { owner: Owner; idx: number; pos: number }>) {
    for (const el of Array.from(content.querySelectorAll<HTMLElement>('[class*="lm-c"]'))) {
      const m = CELL_RE.exec(el.className);
      if (!m) continue;
      const id = Number(m[1]);
      const parts = this.byId.get(id);
      if (parts) parts.push(el); else this.byId.set(id, [el]);
      // a probe standing on the box's baseline, in every box at once: reading them costs one layout
      if (!(el.lastElementChild as HTMLElement | null)?.classList.contains('lm-probe')) el.appendChild(probe());
    }
  }

  cell(owner: Owner, idx: number): CellGeom | null {
    let arr = this.cache.get(owner);
    if (!arr) { arr = []; this.cache.set(owner, arr); }
    if (idx in arr) return arr[idx];
    const ref = this.cells.find(c => c.owner === owner && c.idx === idx);
    const parts = ref ? this.byId.get(ref.id) : undefined;
    const cg = ref && parts ? this.measure(ref, parts) : null;
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

  /** the y of the baseline of a cell box (its probe) */
  private baselineOf(el: HTMLElement): number {
    const p = el.lastElementChild as HTMLElement | null;
    return (p?.classList.contains('lm-probe') ? p : el.appendChild(probe())).getBoundingClientRect().top;
  }

  /** the font size (px) of a cell or atom box: the formula's, scaled for its script level (TeX's 0.7 / 0.5) */
  private fontSize(el: HTMLElement): number {
    if (!this.fs0) this.fs0 = parseFloat(getComputedStyle(this.content.querySelector('mjx-math') ?? this.content).fontSize) || 16;
    const sl = Math.min(2, Math.max(0, Number(el.getAttribute('data-sl')) || 0));
    return this.fs0 * [1, 0.707, 0.5][sl];
  }

  private measure(ref: CellRef, parts: HTMLElement[]): CellGeom {
    const el = parts[0];
    const fs = this.fontSize(el);
    const empty = el.classList.contains('lm-empty');
    const cell = atomCells(ref.owner)[ref.idx] ?? [];
    const atoms: AtomGeom[] = [];
    const lines: LineGeom[] = [];
    for (const part of parts) {
      const rect = part.getBoundingClientRect();
      const baseline = this.baselineOf(part);
      // the font's line box around the baseline: the caret's extent, the least a line is tall
      const lineTop = baseline - 0.8 * fs, lineBottom = baseline + 0.25 * fs;
      const from = atoms.length, line = lines.length;
      if (!empty) {
        for (const child of Array.from(part.children) as HTMLElement[]) {
          if (!child.classList.contains('lm-a') || child.classList.contains('lm-ghost')) continue;
          const atom = cell[atoms.length];
          if (!atom) break;
          const r = child.getBoundingClientRect();
          atoms.push({
            atom, el: child, nest: nargs(atom) > 0, line,
            left: r.left, right: r.right, glyphLeft: r.left, glyphRight: r.right,
            top: Math.min(lineTop, r.top), bottom: Math.max(lineBottom, r.bottom),
          });
        }
      }
      lines.push({ left: rect.left, right: rect.right, top: Math.min(rect.top, lineTop), bottom: Math.max(rect.bottom, lineBottom), baseline, lineTop, lineBottom, from, to: atoms.length });
    }
    const first = lines[0];
    return {
      ref, el, empty, baseline: first.baseline, fontSize: fs, lineTop: first.lineTop, lineBottom: first.lineBottom, atoms, lines,
      left: Math.min(...lines.map(l => l.left)), right: Math.max(...lines.map(l => l.right)),
      top: Math.min(...lines.map(l => l.top)), bottom: Math.max(...lines.map(l => l.bottom)),
    };
  }
}

export { isHull };
