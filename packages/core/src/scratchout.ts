/**
 * Scratch-out: a scribble over ink erases it (GoodNotes' "scribble to erase", OneNote's, Apple Notes'
 * "scratch and hold"). Shared by documents' margins, whiteboards and the slide editor's Draw.
 *
 * A gesture drawn with the pen that also writes is ambiguous, so the recognizer is built on what the
 * literature found to separate them — and leans to ink when in doubt (a stray mark is easier to undo
 * than an erased word):
 *
 * - The shape (Zeleznik & Miller, "Fluid Inking", GI 2006; Microsoft's scratch-out: ≥ 3 back-and-forth
 *   strokes): cusps — turns of 110° or more, measured over a window that grows with the scribble's
 *   size, so a big quick scribble's wobble is no turn — at least three inside it, and *tight*: three
 *   in four of them farther from each neighbour than 1.5 × the neighbours are from each other (its legs
 *   ~3 × as long as it advances with each). Writing turns back too (an m's feet, a w, a v), but its
 *   arches are about as wide as high; a scribble's legs are long for how far it advances.
 * - What it covers is measured from the ink's side (Microsoft's sample: a stroke whose points lie
 *   inside the scratch-out): the scribble's region is the triangles of each three consecutive cusps,
 *   widened by half its pen and a few screen px, and a stroke goes when half its length or more is in
 *   it. (From the scribble's side — each stroke under a fifth of the scribble's own length, as before —
 *   a scribble over a word mostly crosses the paper between its letters and missed.)
 * - Context (Fluid Inking): two in three of the triangles must have ink in them; otherwise it is not
 *   over something, and stays as ink — as does a scribble whose pen lifted well away from what it
 *   would erase (dragging off cancels, Apple's Scribble).
 * - Scratch and hold (Apple Notes): the pen resting at the end (`hold`) asks for it, and the bars are
 *   lower: two cusps, half of them tight (legs longer than their ends are apart), a third of the
 *   triangles over ink, a third of a stroke covered.
 *
 * Callers run it while the pen moves to show what would go (faded), at the lift to erase it, and make
 * the first undo bring the strokes back with the scribble as ink (OneNote).
 */

export type Pt = [number, number];

export interface ScratchOpts {
  /** screen px per unit of the points (the distances that are the hand's are in screen px) */
  zoom?: number;
  /** the scribble's pen width (units) */
  width?: number;
  /** the pen rested at the end of the scribble ("scratch and hold"): looser */
  hold?: boolean;
}

const COS_CUSP = Math.cos((110 * Math.PI) / 180);

/** the points every `step` units along the line (its first and last kept) */
function resample(pts: Pt[], step: number): Pt[] {
  if (pts.length < 2) return pts.slice();
  const out: Pt[] = [pts[0]];
  let carry = 0;
  for (let i = 1; i < pts.length; i++) {
    const [ax, ay] = pts[i - 1], [bx, by] = pts[i], l = Math.hypot(bx - ax, by - ay);
    if (!l) continue;
    let t = step - carry;
    for (; t <= l; t += step) out.push([ax + ((bx - ax) * t) / l, ay + ((by - ay) * t) / l]);
    carry = l - (t - step);
  }
  const last = pts[pts.length - 1], end = out[out.length - 1];
  if (end[0] !== last[0] || end[1] !== last[1]) out.push(last);
  return out;
}

/**
 * The sharpest point of each stretch where the line turns back by `COS_CUSP` or more — over `w` points
 * either side, or twice that (a quick hand turns round, over a few px, not on a point).
 */
function cuspsOf(q: Pt[], w: number): number[] {
  const n = q.length, W = 2 * w;
  const dir = (a: number, b: number) => { const dx = q[b][0] - q[a][0], dy = q[b][1] - q[a][1], l = Math.hypot(dx, dy) || 1; return [dx / l, dy / l]; };
  const at = (i: number, k: number) => { const a = dir(Math.max(0, i - k), i), b = dir(i, Math.min(n - 1, i + k)); return a[0] * b[0] + a[1] * b[1]; };
  const turn = (i: number) => Math.min(at(i, w), at(i, W));
  const out: number[] = [];
  for (let i = w; i < n - w; i++) {
    if (turn(i) >= COS_CUSP) continue;
    let best = i, bestCos = turn(i);
    while (i + 1 < n - w && turn(i + 1) < COS_CUSP) { i++; const c = turn(i); if (c < bestCos) { best = i; bestCos = c; } }
    out.push(best);
  }
  return out;
}

const dist = (a: Pt, b: Pt) => Math.hypot(a[0] - b[0], a[1] - b[1]);

/**
 * The scribble's cusps (its ends included) when its shape is a scratch-out's, else null.
 * Exported for the tests.
 */
export function scribbleCusps(pts: Pt[], o: ScratchOpts = {}): Pt[] | null {
  const z = o.zoom ?? 1;
  const step = 2 / z;
  const q = resample(pts, step);
  if (q.length < 12) return null;
  // first over ~5 screen px either side; then over a fifth of the legs found (the hand's wobble on a big scribble is no turn)
  const minLeg = 6 / z;
  const keep = (idx: number[]) => {
    const c: Pt[] = [q[0]];
    for (const i of idx) if (dist(q[i], c[c.length - 1]) >= minLeg) c.push(q[i]);
    if (dist(q[q.length - 1], c[c.length - 1]) >= minLeg) c.push(q[q.length - 1]); else c[c.length - 1] = q[q.length - 1];
    return c;
  };
  const w0 = Math.max(2, Math.round(5 / z / step));
  let c = keep(cuspsOf(q, w0));
  if (c.length >= 4) {
    const legs = c.slice(1).map((p, i) => dist(p, c[i])).sort((a, b) => a - b);
    const w1 = Math.max(w0, Math.round((0.2 * legs[legs.length >> 1]) / step));
    if (w1 > w0) c = keep(cuspsOf(q, w1));
  }
  const inner = c.length - 2;
  if (inner < (o.hold ? 2 : 3)) return null;
  // (judged where both neighbours are turns too: a scribble starts and ends anywhere along a leg)
  const k = o.hold ? 1 : 1.5;
  const judged = inner >= 3 ? c.slice(2, -2).map((_, j) => j + 2) : [1, 2];
  const tight = judged.filter(i => Math.min(dist(c[i], c[i - 1]), dist(c[i], c[i + 1])) > k * dist(c[i - 1], c[i + 1])).length;
  return tight >= (o.hold ? 0.5 : 0.75) * judged.length ? c : null;
}

/** distance from p to the segment ab */
function segDist(p: Pt, a: Pt, b: Pt): number {
  const dx = b[0] - a[0], dy = b[1] - a[1], l2 = dx * dx + dy * dy;
  const t = l2 ? Math.max(0, Math.min(1, ((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / l2)) : 0;
  return Math.hypot(p[0] - a[0] - t * dx, p[1] - a[1] - t * dy);
}

/** a triangle of the region, widened by `r`, and its box */
interface Tri { a: Pt; b: Pt; c: Pt; r: number; x0: number; y0: number; x1: number; y1: number }
function tri(a: Pt, b: Pt, c: Pt, r: number): Tri {
  return { a, b, c, r, x0: Math.min(a[0], b[0], c[0]) - r, y0: Math.min(a[1], b[1], c[1]) - r, x1: Math.max(a[0], b[0], c[0]) + r, y1: Math.max(a[1], b[1], c[1]) + r };
}
function inTri(p: Pt, t: Tri): boolean {
  if (p[0] < t.x0 || p[0] > t.x1 || p[1] < t.y0 || p[1] > t.y1) return false;
  const s = (u: Pt, v: Pt) => (v[0] - u[0]) * (p[1] - u[1]) - (v[1] - u[1]) * (p[0] - u[0]);
  const d1 = s(t.a, t.b), d2 = s(t.b, t.c), d3 = s(t.c, t.a);
  if ((d1 >= 0 && d2 >= 0 && d3 >= 0) || (d1 <= 0 && d2 <= 0 && d3 <= 0)) return true;
  return Math.min(segDist(p, t.a, t.b), segDist(p, t.b, t.c), segDist(p, t.c, t.a)) <= t.r;
}

/**
 * The strokes (`inks`: their centre lines, in the scribble's units) a scribble erases — their indices —,
 * or null when it is no scratch-out and stays as ink. See the top of the file.
 */
export function scratchOut(scribble: Pt[], inks: Pt[][], o: ScratchOpts = {}): number[] | null {
  const cusps = scribbleCusps(scribble, o);
  if (!cusps) return null;
  const z = o.zoom ?? 1;
  const r = (o.width ?? 0) / 2 + 4 / z;
  const tris: Tri[] = [];
  for (let i = 1; i < cusps.length - 1; i++) tris.push(tri(cusps[i - 1], cusps[i], cusps[i + 1], r));
  const box = { x0: Math.min(...tris.map(t => t.x0)), y0: Math.min(...tris.map(t => t.y0)), x1: Math.max(...tris.map(t => t.x1)), y1: Math.max(...tris.map(t => t.y1)) };
  const inside = (p: Pt) => p[0] >= box.x0 && p[0] <= box.x1 && p[1] >= box.y0 && p[1] <= box.y1 && tris.some(t => inTri(p, t));
  const inked = new Set<number>();
  const hits: number[] = [];
  const hitPts: Pt[] = [];
  const cover = o.hold ? 1 / 3 : 0.5;
  inks.forEach((pts, k) => {
    if (!pts.length) return;
    // (only what reaches the region's box is looked at)
    let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
    for (const [x, y] of pts) { if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y; }
    if (x1 < box.x0 || x0 > box.x1 || y1 < box.y0 || y0 > box.y1) return;
    // its length, evenly (a slowly drawn part is not worth more)
    const s = resample(pts, 2 / z);
    let n = 0;
    for (const p of s) {
      let any = false;
      tris.forEach((t, i) => { if (inTri(p, t)) { inked.add(i); any = true; } });
      if (any) n++;
    }
    if (n && n >= cover * s.length) { hits.push(k); hitPts.push(...s); }
  });
  if (!hits.length || inked.size < (o.hold ? 1 / 3 : 2 / 3) * tris.length) return null;
  // lifted well away (~1 cm) from what it would erase: it was not meant (Apple's Scribble: drag off to cancel)
  const end = scribble[scribble.length - 1];
  const away = 40 / z;
  if (!hitPts.some(p => Math.abs(p[0] - end[0]) <= away && Math.abs(p[1] - end[1]) <= away)) return null;
  return hits;
}

/** the pen has rested at the end of the scribble long enough to ask for it (ms, and how far it may wander in screen px) */
export const SCRATCH_HOLD_MS = 400;
export const SCRATCH_HOLD_PX = 5;
