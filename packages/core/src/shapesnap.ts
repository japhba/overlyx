/**
 * Draw and hold: a stroke drawn roughly, the pen kept still at its end, becomes the shape it was
 * meant to be (Apple Notes' and GoodNotes' "hold to snap", Notability's shape recognition). Shared by
 * documents' margins, whiteboards and the slide editor's Draw, and by the lasso's "Straighten".
 *
 * What it recognises, in this order:
 * - a line: the stroke never strays far from the line between its ends (a near-level or upright one is
 *   made exactly so — underlining, a margin rule);
 * - an arrow: a long shaft and, at its tip, a barb drawn out and back and the other one (→ in one go);
 * - a closed shape (its ends meet, an overshoot past the start cut off): an ellipse — a circle when its
 *   axes are nearly equal — or a polygon of 3 to 6 corners, whichever follows the stroke more closely; a
 *   four-cornered one with right angles a rectangle (a square when nearly so), level when nearly level;
 * - an open polyline of up to five straight pieces (an L, a V, a zig-zag).
 * A curve that is none of these (an arc, an S, writing) is not snapped: `null`, and the stroke stays.
 *
 * Distances that are the hand's (how small a stroke may be) are in screen px through `zoom`; the rest
 * are fractions of the stroke's size, so a shape snaps the same at any zoom.
 */

export type Pt = [number, number];
export type SnapKind = 'line' | 'arrow' | 'polyline' | 'triangle' | 'rect' | 'square' | 'quad' | 'polygon' | 'ellipse' | 'circle';
export interface Snapped {
  kind: SnapKind;
  /** the clean outline, in the stroke's units; a closed shape ends where it began */
  pts: Pt[];
  closed: boolean;
}

/** how long the pen rests at the end of a stroke before it snaps (scratch-and-hold's 400 ms, and a little more: a scribble's hold is judged first) */
export const SNAP_HOLD_MS = 500;
/** the pen moving on this far (screen px) from where it rested takes a snapped stroke back as drawn: it only paused, at a corner say */
export const SNAP_LEAVE_PX = 12;

const dist = (a: Pt, b: Pt) => Math.hypot(a[0] - b[0], a[1] - b[1]);
const DEG = Math.PI / 180;

/** the points every `step` units along the line (its ends kept) */
function resample(pts: Pt[], step: number): Pt[] {
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

function lengthOf(pts: Pt[]): number {
  let l = 0;
  for (let i = 1; i < pts.length; i++) l += dist(pts[i - 1], pts[i]);
  return l;
}

/** distance from p to the segment a–b */
function segDist(p: Pt, a: Pt, b: Pt): number {
  const dx = b[0] - a[0], dy = b[1] - a[1], l2 = dx * dx + dy * dy;
  const t = l2 ? Math.max(0, Math.min(1, ((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / l2)) : 0;
  return Math.hypot(p[0] - a[0] - t * dx, p[1] - a[1] - t * dy);
}

/** Douglas–Peucker: the indices of the points kept (the ends included) */
function simplify(q: Pt[], eps: number): number[] {
  const keep = new Uint8Array(q.length);
  keep[0] = keep[q.length - 1] = 1;
  const stack: [number, number][] = [[0, q.length - 1]];
  while (stack.length) {
    const [a, b] = stack.pop()!;
    let far = -1, fd = eps;
    for (let i = a + 1; i < b; i++) { const d = segDist(q[i], q[a], q[b]); if (d > fd) { fd = d; far = i; } }
    if (far >= 0) { keep[far] = 1; stack.push([a, far], [far, b]); }
  }
  const out: number[] = [];
  keep.forEach((k, i) => { if (k) out.push(i); });
  return out;
}

/** how far the stroke's points are from the outline `poly` (its pieces, closed or not): their mean and their largest */
function fitError(q: Pt[], poly: Pt[]): { mean: number; max: number } {
  let sum = 0, max = 0;
  for (const p of q) {
    let d = Infinity;
    for (let i = 1; i < poly.length; i++) d = Math.min(d, segDist(p, poly[i - 1], poly[i]));
    sum += d; if (d > max) max = d;
  }
  return { mean: sum / q.length, max };
}

/** the angle of a–b in (-90°, 90°], as a line's (its direction not counted) */
const lineAngle = (a: Pt, b: Pt) => { let t = Math.atan2(b[1] - a[1], b[0] - a[0]); if (t <= -Math.PI / 2) t += Math.PI; if (t > Math.PI / 2) t -= Math.PI; return t; };

/** the turn at b on the way a → b → c, 0 straight on to π back */
function turnAt(a: Pt, b: Pt, c: Pt): number {
  const ux = b[0] - a[0], uy = b[1] - a[1], vx = c[0] - b[0], vy = c[1] - b[1];
  const lu = Math.hypot(ux, uy) || 1, lv = Math.hypot(vx, vy) || 1;
  return Math.acos(Math.max(-1, Math.min(1, (ux * vx + uy * vy) / (lu * lv))));
}

/** a line from a to b, made level or upright when it is within `tol` of being so */
function levelled(a: Pt, b: Pt, tol: number): [Pt, Pt] {
  const t = lineAngle(a, b);
  if (Math.abs(t) < tol) { const y = (a[1] + b[1]) / 2; return [[a[0], y], [b[0], y]]; }
  if (Math.abs(Math.abs(t) - Math.PI / 2) < tol) { const x = (a[0] + b[0]) / 2; return [[x, a[1]], [x, b[1]]]; }
  return [a, b];
}

/**
 * The shape the stroke `raw` was meant to be, or null when it is none (see the top of the file).
 * `zoom`: screen px per unit of the points.
 */
export function snapShape(raw: readonly (readonly [number, number, ...unknown[]])[], o: { zoom?: number } = {}): Snapped | null {
  const zoom = o.zoom ?? 1;
  const pts: Pt[] = [];
  for (const p of raw) { const q: Pt = [p[0], p[1]]; if (!pts.length || dist(pts[pts.length - 1], q) > 1e-6) pts.push(q); }
  if (pts.length < 2) return null;
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (const [x, y] of pts) { x0 = Math.min(x0, x); y0 = Math.min(y0, y); x1 = Math.max(x1, x); y1 = Math.max(y1, y); }
  const D = Math.hypot(x1 - x0, y1 - y0);
  // too small to be a shape the hand meant (a dot, a tick)
  if (D * zoom < 14) return null;
  const L = lengthOf(pts);
  let q = resample(pts, Math.max(L / 240, D / 400));
  const chord = dist(q[0], q[q.length - 1]);

  // a line: no point far from the chord
  if (chord > 0.6 * D) {
    let dev = 0;
    for (const p of q) dev = Math.max(dev, segDist(p, q[0], q[q.length - 1]));
    // (its length measured coarsely: a hand's tremor makes any line long)
    if (dev < 0.06 * chord + 1.5 / zoom && lengthOf(resample(pts, D / 40)) < 1.25 * chord) {
      const [a, b] = levelled(q[0], q[q.length - 1], 3 * DEG);
      return { kind: 'line', pts: [a, b], closed: false };
    }
  }

  const closed = L > 1.7 * D && closeGap(q, D);
  if (closed) {
    q = trimOvershoot(q, D);
    return closedShape(q, D);
  }
  return openShape(q, D, zoom);
}

/** the stroke's ends meet: within a fifth of its size of each other, or its end comes back past its start */
function closeGap(q: Pt[], D: number): boolean {
  if (dist(q[0], q[q.length - 1]) < 0.2 * D) return true;
  // the end overshot the start: it passes close to it in its last third
  for (let i = Math.floor(q.length * 0.67); i < q.length; i++) if (dist(q[i], q[0]) < 0.12 * D) return true;
  return false;
}

/** the stroke cut where it came back closest to its start (a loop drawn on past its beginning) */
function trimOvershoot(q: Pt[], D: number): Pt[] {
  let best = q.length - 1, bd = dist(q[q.length - 1], q[0]);
  for (let i = Math.floor(q.length * 0.67); i < q.length; i++) { const d = dist(q[i], q[0]); if (d < bd - 1e-9) { bd = d; best = i; } }
  return bd < 0.2 * D ? q.slice(0, best + 1) : q;
}

function closedShape(q: Pt[], D: number): Snapped | null {
  const ell = fitEllipse(q);
  const poly = fitPolygon(q, D);
  const ellErr = ell ? fitError(q, ell.pts) : null;
  const polyErr = poly ? fitError(q, poly.pts) : null;
  const ok = (e: { mean: number; max: number } | null, mean: number, max: number) => !!e && e.mean < mean * D && e.max < max * D;
  // a polygon when it follows the stroke clearly better than an ellipse does (its corners are real), and
  // the fewer its corners the less it must win by: a hand-drawn square's rounded corners still are corners
  const polyWins = !!poly && !!polyErr && (!ellErr || polyErr.mean < ellErr.mean * (poly.n <= 4 ? 0.9 : 0.65));
  if (polyWins && ok(polyErr, 0.04, 0.13)) return poly!.shape;
  if (ell && ok(ellErr, 0.045, 0.14)) return ell.shape;
  if (poly && ok(polyErr, 0.04, 0.13)) return poly.shape;
  return null;
}

/**
 * The ellipse along the stroke's principal axes (from its points' spread), as wide and high as it
 * reaches along each; a circle when the two are within a seventh of each other; level when nearly so.
 */
function fitEllipse(q: Pt[]): { pts: Pt[]; shape: Snapped } | null {
  const n = q.length;
  let mx = 0, my = 0;
  for (const [x, y] of q) { mx += x; my += y; }
  mx /= n; my /= n;
  let sxx = 0, syy = 0, sxy = 0;
  for (const [x, y] of q) { sxx += (x - mx) ** 2; syy += (y - my) ** 2; sxy += (x - mx) * (y - my); }
  let th = 0.5 * Math.atan2(2 * sxy, sxx - syy);
  let ux = Math.cos(th), uy = Math.sin(th);
  let a0 = Infinity, a1 = -Infinity, b0 = Infinity, b1 = -Infinity;
  for (const [x, y] of q) {
    const u = (x - mx) * ux + (y - my) * uy, v = -(x - mx) * uy + (y - my) * ux;
    a0 = Math.min(a0, u); a1 = Math.max(a1, u); b0 = Math.min(b0, v); b1 = Math.max(b1, v);
  }
  let a = (a1 - a0) / 2, b = (b1 - b0) / 2;
  if (a <= 0 || b <= 0) return null;
  // the middle of its reach, not of its points (a stroke dwelling on one side pulls their mean there)
  let cx = mx + ((a0 + a1) / 2) * ux - ((b0 + b1) / 2) * uy, cy = my + ((a0 + a1) / 2) * uy + ((b0 + b1) / 2) * ux;
  let kind: SnapKind = 'ellipse';
  if (Math.min(a, b) / Math.max(a, b) > 0.86) { a = b = (a + b) / 2; kind = 'circle'; th = 0; }
  else {
    // level or upright when it is within 8° of being so
    const t = ((th % (Math.PI / 2)) + Math.PI / 2) % (Math.PI / 2);
    if (t < 8 * DEG) th -= t; else if (Math.PI / 2 - t < 8 * DEG) th += Math.PI / 2 - t;
  }
  ux = Math.cos(th); uy = Math.sin(th);
  const pts: Pt[] = [];
  // starting where the stroke did, and going round the way it went
  const sa = Math.atan2(-(q[0][0] - cx) * uy + (q[0][1] - cy) * ux, (q[0][0] - cx) * ux + (q[0][1] - cy) * uy);
  const dir = signedArea(q) >= 0 ? 1 : -1;
  for (let i = 0; i <= 72; i++) {
    const t = sa + dir * (i / 72) * 2 * Math.PI, u = a * Math.cos(t), v = b * Math.sin(t);
    pts.push([cx + u * ux - v * uy, cy + u * uy + v * ux]);
  }
  return { pts, shape: { kind, pts, closed: true } };
}

/** twice the signed area of the closed outline (positive: clockwise on the screen, y down) */
function signedArea(q: Pt[]): number {
  let s = 0;
  for (let i = 0; i < q.length; i++) { const [ax, ay] = q[i], [bx, by] = q[(i + 1) % q.length]; s += ax * by - bx * ay; }
  return s;
}

/**
 * The polygon of the stroke's corners (3–6): Douglas–Peucker round the loop from the point farthest
 * from its middle (a corner, if it has any), corners that hardly turn merged away, then squared up —
 * four right angles a rectangle, sides nearly level made level.
 */
function fitPolygon(q: Pt[], D: number): { pts: Pt[]; n: number; shape: Snapped } | null {
  const n = q.length;
  let mx = 0, my = 0;
  for (const [x, y] of q) { mx += x; my += y; }
  mx /= n; my /= n;
  let far = 0, fd = -1;
  for (let i = 0; i < n; i++) { const d = Math.hypot(q[i][0] - mx, q[i][1] - my); if (d > fd) { fd = d; far = i; } }
  const loop = [...q.slice(far), ...q.slice(1, far + 1)];
  const idx = simplify(loop, 0.055 * D);
  let v = idx.slice(0, -1).map(i => loop[i]);
  // corners that hardly turn (a side drawn in two goes) merged, until none is left
  for (let changed = true; changed && v.length > 3;) {
    changed = false;
    let worst = -1, wt = 28 * DEG;
    for (let i = 0; i < v.length; i++) { const t = turnAt(v[(i + v.length - 1) % v.length], v[i], v[(i + 1) % v.length]); if (t < wt) { wt = t; worst = i; } }
    if (worst >= 0) { v.splice(worst, 1); changed = true; }
  }
  // two corners close together are one (a corner drawn with a little loop or a hook)
  for (let i = 0; i < v.length && v.length > 3;) {
    const j = (i + 1) % v.length;
    if (dist(v[i], v[j]) < 0.08 * D) { v[i] = [(v[i][0] + v[j][0]) / 2, (v[i][1] + v[j][1]) / 2]; v.splice(j, 1); } else i++;
  }
  if (v.length < 3 || v.length > 6) return null;
  let kind: SnapKind = v.length === 3 ? 'triangle' : v.length === 4 ? 'quad' : 'polygon';
  if (v.length === 4) {
    const r = squaredUp(v);
    if (r) { v = r.pts; kind = r.square ? 'square' : 'rect'; }
  }
  if (kind !== 'rect' && kind !== 'square') v = levelSides(v);
  const pts = [...v, v[0]];
  return { pts, n: v.length, shape: { kind, pts, closed: true } };
}

/** four corners with right angles (within 18°) as a rectangle along their sides' mean direction — level within 6°; a square when within 8% */
function squaredUp(v: Pt[]): { pts: Pt[]; square: boolean } | null {
  for (let i = 0; i < 4; i++) if (Math.abs(turnAt(v[(i + 3) % 4], v[i], v[(i + 1) % 4]) - Math.PI / 2) > 18 * DEG) return null;
  // the sides' direction, each folded into [0°, 90°) and averaged as doubled... quadrupled angles (a rectangle's sides are 90° apart)
  let c = 0, s = 0;
  for (let i = 0; i < 4; i++) { const a = v[i], b = v[(i + 1) % 4], t = Math.atan2(b[1] - a[1], b[0] - a[0]), l = dist(a, b); c += l * Math.cos(4 * t); s += l * Math.sin(4 * t); }
  let th = Math.atan2(s, c) / 4;
  if (Math.abs(th) < 6 * DEG) th = 0;
  const ux = Math.cos(th), uy = Math.sin(th);
  // the box of the corners in those axes, each side where its two corners are on average
  const uv = v.map(([x, y]) => [x * ux + y * uy, -x * uy + y * ux] as Pt);
  const us = uv.map(p => p[0]).sort((a, b) => a - b), vs = uv.map(p => p[1]).sort((a, b) => a - b);
  let u0 = (us[0] + us[1]) / 2, u1 = (us[2] + us[3]) / 2, v0 = (vs[0] + vs[1]) / 2, v1 = (vs[2] + vs[3]) / 2;
  const w = u1 - u0, h = v1 - v0;
  const square = Math.abs(w - h) / Math.max(w, h) < 0.08;
  if (square) { const m = (w + h) / 2, cu = (u0 + u1) / 2, cv = (v0 + v1) / 2; u0 = cu - m / 2; u1 = cu + m / 2; v0 = cv - m / 2; v1 = cv + m / 2; }
  const back = (u: number, vv: number): Pt => [u * ux - vv * uy, u * uy + vv * ux];
  // from the corner nearest where the stroke began, the way it went round
  let box = [back(u0, v0), back(u1, v0), back(u1, v1), back(u0, v1)];
  if (signedArea(v) < 0) box = [box[0], box[3], box[2], box[1]];
  let k = 0, kd = Infinity;
  box.forEach((p, i) => { const d = dist(p, v[0]); if (d < kd) { kd = d; k = i; } });
  return { pts: [...box.slice(k), ...box.slice(0, k)], square };
}

/** the sides within 5° of level or upright made so (each corner moved by the sides it ends) */
function levelSides(v: Pt[]): Pt[] {
  const out = v.map(p => [...p] as Pt);
  for (let i = 0; i < out.length; i++) {
    const j = (i + 1) % out.length, t = lineAngle(out[i], out[j]);
    if (Math.abs(t) < 5 * DEG) { const y = (out[i][1] + out[j][1]) / 2; out[i][1] = out[j][1] = y; }
    else if (Math.abs(Math.abs(t) - Math.PI / 2) < 5 * DEG) { const x = (out[i][0] + out[j][0]) / 2; out[i][0] = out[j][0] = x; }
  }
  return out;
}

function openShape(q: Pt[], D: number, zoom: number): Snapped | null {
  const idx = simplify(q, 0.05 * D + 1 / zoom);
  // nearly straight corners merged
  for (let i = 1; i < idx.length - 1;) { if (turnAt(q[idx[i - 1]], q[idx[i]], q[idx[i + 1]]) < 20 * DEG) idx.splice(i, 1); else i++; }
  if (idx.length < 3 || idx.length > 6) return null;
  let v = idx.map(i => q[i]);
  const err = fitError(q, v);
  if (err.mean > 0.03 * D || err.max > 0.1 * D) return null;
  // each corner turns where it is, not along the way (an arc's turn is spread over its length)
  const win = 0.05 * D;
  for (let k = 1; k < idx.length - 1; k++) {
    const i = idx[k];
    let a = i, b = i;
    while (a > 0 && dist(q[a], q[i]) < win) a--;
    while (b < q.length - 1 && dist(q[b], q[i]) < win) b++;
    if (turnAt(q[a], q[i], q[b]) < 0.6 * turnAt(v[k - 1], v[k], v[k + 1])) return null;
  }
  const arrow = arrowOf(v);
  if (arrow) return { kind: 'arrow', pts: arrow, closed: false };
  // pieces too short to be meant (a hook at an end) are not a polyline's
  const lens = v.slice(1).map((p, i) => dist(v[i], p));
  if (Math.min(...lens) < 0.12 * Math.max(...lens)) return null;
  v = levelSides(v);
  return { kind: 'polyline', pts: v, closed: false };
}

/**
 * An arrow drawn in one go: shaft, out along one barb and back to the tip, then the other barb
 * (v0 → v1 tip → v2 → v3 ≈ v1 → v4). Made symmetric: both barbs as long as the two were on average,
 * at the angle they made on average; the shaft levelled within 3°.
 */
function arrowOf(v: Pt[]): Pt[] | null {
  if (v.length !== 5) return null;
  const [s, tip, w1, back, w2] = v;
  const shaft = dist(s, tip), b1 = dist(tip, w1), b2 = dist(back, w2);
  if (b1 > 0.6 * shaft || b2 > 0.6 * shaft || b1 < 0.08 * shaft || b2 < 0.08 * shaft) return null;
  if (dist(back, tip) > 0.4 * Math.max(b1, b2)) return null;
  const [a, t] = levelled(s, tip, 3 * DEG);
  const ux = (a[0] - t[0]) / shaft, uy = (a[1] - t[1]) / shaft;
  // the barbs' angles to the shaft (from the tip, back along it), each on its own side
  const ang = (w: Pt) => Math.atan2((w[0] - tip[0]) * -uy + (w[1] - tip[1]) * ux, (w[0] - tip[0]) * ux + (w[1] - tip[1]) * uy);
  const g1 = ang(w1), g2 = ang(w2);
  if (Math.sign(g1) === Math.sign(g2)) return null;
  const spread = (Math.abs(g1) + Math.abs(g2)) / 2;
  if (spread < 12 * DEG || spread > 75 * DEG) return null;
  const len = (b1 + b2) / 2;
  const barb = (g: number): Pt => [t[0] + len * (ux * Math.cos(g) + uy * Math.sin(g)), t[1] + len * (uy * Math.cos(g) - ux * Math.sin(g))];
  return [a, t, barb(spread), t, barb(-spread)];
}
