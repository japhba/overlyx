/**
 * The precise eraser (GoodNotes' "Precise eraser", Notability's partial eraser): it rubs out only the
 * part of a stroke under it, and what is left either side stays — a stroke crossed in the middle
 * becomes two. Shared by documents' margins, whiteboards and the slide editor's Draw: their strokes
 * are polylines of points (x, y and whatever else a point carries, a pressure: interpolated where a
 * piece is cut), the slides' as the runs of one width they are painted with.
 *
 * The eraser is a disc; dragged, a row of discs half its radius apart along the way it went (callers
 * pass the stroke's half width on top of the eraser's radius, so it takes what it visibly touches).
 */

export type CutPt = number[];

const near = (p: CutPt, cx: number, cy: number, r: number) => (p[0] - cx) ** 2 + (p[1] - cy) ** 2 < r * r;
const lerp = (a: CutPt, b: CutPt, t: number): CutPt => a.map((v, i) => v + ((b[i] ?? v) - v) * t);

/** where along a → b (0..1) the segment crosses the circle: the entry and the exit, of the line through them */
function crossings(a: CutPt, b: CutPt, cx: number, cy: number, r: number): [number, number] | null {
  const dx = b[0] - a[0], dy = b[1] - a[1], fx = a[0] - cx, fy = a[1] - cy;
  const A = dx * dx + dy * dy;
  if (!A) return null;
  const B = 2 * (fx * dx + fy * dy), C = fx * fx + fy * fy - r * r;
  const disc = B * B - 4 * A * C;
  if (disc <= 0) return null;
  const s = Math.sqrt(disc);
  return [(-B - s) / (2 * A), (-B + s) / (2 * A)];
}

/**
 * The pieces of the polyline `pts` outside the disc (cx, cy, r), each two points or more; null when
 * the disc misses it (nothing to change), [] when it rubs out all of it. A closed one (its last point
 * its first) cut once stays one piece, opened where it was cut.
 */
export function cutPolyline<P extends CutPt>(pts: readonly P[], cx: number, cy: number, r: number): P[][] | null {
  if (!pts.length) return null;
  if (pts.length === 1) return near(pts[0], cx, cy, r) ? [] : null;
  const pieces: P[][] = [];
  let cur: P[] | null = near(pts[0], cx, cy, r) ? null : [pts[0]];
  let hit = !cur;
  for (let i = 1; i < pts.length; i++) {
    const a = pts[i - 1], b = pts[i];
    const inA = near(a, cx, cy, r), inB = near(b, cx, cy, r);
    if (!inA && !inB) {
      // both outside: the segment may still pass through the disc
      const c = crossings(a, b, cx, cy, r);
      if (c && c[0] > 0 && c[1] < 1) {
        hit = true;
        cur!.push(lerp(a, b, c[0]) as P);
        pieces.push(cur!);
        cur = [lerp(a, b, c[1]) as P, b];
      } else cur!.push(b);
    } else if (!inA && inB) {
      hit = true;
      const c = crossings(a, b, cx, cy, r);
      cur!.push(lerp(a, b, c ? Math.max(0, Math.min(1, c[0])) : 1) as P);
      pieces.push(cur!);
      cur = null;
    } else if (inA && !inB) {
      hit = true;
      const c = crossings(a, b, cx, cy, r);
      cur = [lerp(a, b, c ? Math.max(0, Math.min(1, c[1])) : 0) as P, b];
    }
  }
  if (!hit) return null;
  if (cur) pieces.push(cur);
  const last = pts[pts.length - 1];
  const closed = pts.length > 2 && last[0] === pts[0][0] && last[1] === pts[0][1];
  // a loop's first and last pieces meet where it began: one piece
  if (closed && pieces.length > 1 && !near(pts[0], cx, cy, r)) {
    const tail = pieces.pop()!;
    pieces[0] = [...tail, ...pieces[0].slice(1)];
  }
  return pieces.filter(p => p.length > 1 && length(p) > r * 0.15);
}

function length(p: readonly CutPt[]): number {
  let l = 0;
  for (let i = 1; i < p.length; i++) l += Math.hypot(p[i][0] - p[i - 1][0], p[i][1] - p[i - 1][1]);
  return l;
}

/**
 * `lines` after the eraser went from a to b with radius r (`r` per line: the eraser's own and each
 * line's half width): what is left of each, by its index — only the lines it touched.
 */
export function eraseAlong<P extends CutPt>(lines: readonly (readonly P[])[], a: readonly [number, number], b: readonly [number, number], r: number | ((i: number) => number)): Map<number, P[][]> {
  const out = new Map<number, P[][]>();
  const rad = (i: number) => (typeof r === 'number' ? r : r(i));
  const span = Math.hypot(b[0] - a[0], b[1] - a[1]);
  lines.forEach((line, i) => {
    const R = rad(i);
    const steps = Math.max(1, Math.ceil(span / (R / 2)));
    // (a line far from the whole way is left alone at once)
    if (!line.some(p => segNear(p, a, b, R + span))) return;
    let pieces: P[][] = [line.slice()];
    let touched = false;
    for (let k = 0; k <= steps; k++) {
      const t = k / steps, cx = a[0] + (b[0] - a[0]) * t, cy = a[1] + (b[1] - a[1]) * t;
      const next: P[][] = [];
      for (const piece of pieces) {
        const cut = cutPolyline(piece, cx, cy, R);
        if (cut === null) next.push(piece);
        else { touched = true; next.push(...cut); }
      }
      pieces = next;
      if (!pieces.length) break;
    }
    if (touched) out.set(i, pieces);
  });
  return out;
}

function segNear(p: CutPt, a: readonly [number, number], b: readonly [number, number], r: number): boolean {
  const dx = b[0] - a[0], dy = b[1] - a[1], l2 = dx * dx + dy * dy;
  const t = l2 ? Math.max(0, Math.min(1, ((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / l2)) : 0;
  return (p[0] - a[0] - t * dx) ** 2 + (p[1] - a[1] - t * dy) ** 2 < r * r;
}
