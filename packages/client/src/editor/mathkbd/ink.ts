/**
 * The pen's ink, without the DOM (inkpad.ts draws and sends it): how strokes are laid out in the
 * picture the recognizer reads, and the scratch-out gesture that erases them.
 *
 * The picture is drawn as scripts/ink-bench.py draws Google's MathWriting inks for the benchmark
 * that chose the model: scaled so that the median height of the strokes that make up letters is
 * 40 px, 3 px round black strokes on white, 20 px around, at most 1400 × 700.
 */

export interface InkPoint { x: number; y: number; t: number; p: number }
export interface Stroke { pts: InkPoint[]; /** written with a pen (its pressure varies the width) */ pen?: boolean }

export interface InkLayout {
  /** page px → picture px */
  k: number;
  /** the picture's origin in page px (the strokes' corner minus the margin) */
  x0: number;
  y0: number;
  w: number;
  h: number;
  /** stroke width in picture px */
  line: number;
}

export const INK_LETTER = 40;
export const INK_PAD = 20;
export const INK_LINE = 3;
export const INK_MAX_W = 1400;
export const INK_MAX_H = 700;

function median(xs: number[]): number {
  const s = [...xs].sort((a, b) => a - b), n = s.length;
  return n ? (n % 2 ? s[(n - 1) / 2] : (s[n / 2 - 1] + s[n / 2]) / 2) : 0;
}

export function bbox(strokes: Stroke[]): { x0: number; y0: number; x1: number; y1: number } | null {
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (const s of strokes) for (const p of s.pts) { x0 = Math.min(x0, p.x); y0 = Math.min(y0, p.y); x1 = Math.max(x1, p.x); y1 = Math.max(y1, p.y); }
  return x0 === Infinity ? null : { x0, y0, x1, y1 };
}

/** where the strokes go in the picture sent to the recognizer (null: no ink) */
export function inkLayout(strokes: Stroke[]): InkLayout | null {
  const b = bbox(strokes);
  if (!b) return null;
  const hs = strokes.map(s => { let lo = Infinity, hi = -Infinity; for (const p of s.pts) { lo = Math.min(lo, p.y); hi = Math.max(hi, p.y); } return hi - lo; });
  const top = Math.max(...hs, 1e-6);
  // dots, dashes and the bars of = or a fraction are not letter-high: the strokes at least 15 % of the tallest
  const letters = hs.filter(h => h > 0.15 * top);
  let k = INK_LETTER / Math.max(1e-6, median(letters.length ? letters : hs), 4);
  let w = (b.x1 - b.x0) * k + 2 * INK_PAD, h = (b.y1 - b.y0) * k + 2 * INK_PAD;
  const c = Math.min(1, INK_MAX_W / w, INK_MAX_H / h);
  k *= c; w *= c; h *= c;
  return { k, x0: b.x0 - (INK_PAD * c) / k, y0: b.y0 - (INK_PAD * c) / k, w: Math.max(1, Math.round(w)), h: Math.max(1, Math.round(h)), line: Math.max(2, INK_LINE * c) };
}

/** a stroke's length along its points */
export function pathLength(s: Stroke): number {
  let n = 0;
  for (let i = 1; i < s.pts.length; i++) n += Math.hypot(s.pts[i].x - s.pts[i - 1].x, s.pts[i].y - s.pts[i - 1].y);
  return n;
}

/** how often a stroke turns back horizontally (a zigzag), ignoring wobbles under `tol` px */
export function reversals(s: Stroke, tol: number): number {
  let n = 0, dir = 0, anchor = s.pts[0]?.x ?? 0;
  for (const p of s.pts) {
    const d = p.x - anchor;
    if (Math.abs(d) < tol) continue;
    const sd = Math.sign(d);
    if (dir && sd !== dir) n++;
    dir = sd;
    anchor = p.x;
  }
  return n;
}

/**
 * A scratch-out: a quick zigzag back and forth (at least three turns, long for its width) across
 * other strokes — the indices of the strokes it crosses out (their boxes mostly under it), or null
 * when the stroke is writing (a W, an M, a sum sign are no zigzags: too few turns or too tall).
 */
export function scratchedOut(stroke: Stroke, others: Stroke[], letter = INK_LETTER): number[] | null {
  if (stroke.pts.length < 6 || !others.length) return null;
  const b = bbox([stroke])!;
  const w = b.x1 - b.x0, h = b.y1 - b.y0;
  if (w < 8) return null;
  const turns = reversals(stroke, Math.max(4, w * 0.15));
  if (turns < 3 || pathLength(stroke) < 2.5 * w || h > Math.max(1.6 * w, letter * 3)) return null;
  const hit: number[] = [];
  others.forEach((s, i) => {
    // (as wide as it is drawn: a straight vertical or horizontal stroke has a box of no width)
    const r = bbox([s])!, o = { x0: r.x0 - 2, y0: r.y0 - 2, x1: r.x1 + 2, y1: r.y1 + 2 };
    const ix = Math.max(0, Math.min(o.x1, b.x1) - Math.max(o.x0, b.x0));
    const iy = Math.max(0, Math.min(o.y1, b.y1) - Math.max(o.y0, b.y0));
    const ow = Math.max(1, o.x1 - o.x0), oh = Math.max(1, o.y1 - o.y0);
    // most of its width lies under the zigzag, which crosses it (half of it, or half the zigzag's height —
    // a scribble through the middle of tall letters) — not merely beside it, above or below
    if (ix / ow >= 0.5 && iy >= Math.min(0.5 * oh, 0.5 * Math.max(1, h))) hit.push(i);
  });
  return hit.length ? hit : null;
}

/** the width a pen stroke is drawn with at a pressure (0–1; mice and fingers report 0.5) */
export function widthAt(base: number, p: number, pen: boolean): number {
  return pen ? base * (0.55 + 0.9 * Math.min(1, Math.max(0, p))) : base;
}
