/**
 * Scratch-out: a scribble over ink erases it (GoodNotes' "scribble to erase", OneNote's, Apple Notes'
 * "scratch and hold"). Shared by documents' margins, whiteboards and the slide editor's Draw.
 *
 * A gesture drawn with the pen that also writes is ambiguous, so the recognizer is built on what the
 * literature found to separate them — and leans to ink when in doubt (a stray mark is easier to undo
 * than an erased word):
 *
 * - The shape (Zeleznik & Miller, "Fluid Inking", GI 2006; Microsoft's scratch-out: ≥ 3 back-and-forth
 *   strokes): the pen goes back and forth along one axis (the main direction of its steps). Where it
 *   turns back along it by a good part of its usual swing (35 %: a hook or a wobble at a turn is no
 *   turn) it has a cusp if it really turns round there: 110° or more over two fifths of its legs, so a
 *   quick hand's rounded turns count, an arch's or a circle's do not. A zig-zag's cusps turn left and
 *   right in turn and are *tight*: its legs are long for how far it advances with each. Four cusps or
 *   more, three in five of them with legs (on average) 1.1 × as long as their neighbours are apart —
 *   legs at ~63° or steeper to the way it advances —; three cusps, the middle one 1.5 ×; two (a flat Z
 *   through a word) 2.5 × — a written z or N is ~1.2 ×. Writing turns back too (an m's feet, a w, a v),
 *   but its arches are about as wide as high, its v's legs flatter. A quick hand back and forth also
 *   draws thin loops, turning the same way each time; so does a circle drawn round a word, so loops
 *   must cross the ink, twice a leg or more. (Before, three in four cusps 1.5 × as long as the shorter
 *   leg, and three in five quick scribbles simulated over real handwriting stayed as ink.)
 * - What it covers is measured from the ink's side (Microsoft's sample: a stroke whose points lie
 *   inside the scratch-out): the scribble's region is the triangles of each three consecutive cusps,
 *   widened by half its pen and a few screen px, and a stroke goes when half its length or more is in
 *   it. A scribble kept to the middle of a word left its tall letters, tails and dots sticking out, so
 *   these go too: a stroke a sixth of which is in the region, its middle in the scribble's box (along
 *   and across its legs, widened by half its thinner side), sticking out of the box by less than the
 *   box is wide that way — not a long underline or a drawing's line it crosses —; and what is attached
 *   to what goes (an i's dot, a t's bar, a tail, an accent): no bigger than one of its letters, inside
 *   its box widened by half a letter, and nearer to it than to anything that stays.
 * - Context (Fluid Inking): two in three of the triangles must have ink in them; otherwise it is not
 *   over something, and stays as ink — as does a scribble whose pen lifted well away (~1 cm, or more
 *   than half a leg) from what it would erase (dragging off cancels, Apple's Scribble).
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

const dist = (a: Pt, b: Pt) => Math.hypot(a[0] - b[0], a[1] - b[1]);

/** where `u` turns back by `h` or more: the indices of its highs and lows, in turn */
function reversals(u: number[], h: number): number[] {
  const out: number[] = [];
  let hi = 0, lo = 0, dir = 0;
  for (let i = 1; i < u.length; i++) {
    if (dir >= 0 && u[i] > u[hi]) hi = i;
    if (dir <= 0 && u[i] < u[lo]) lo = i;
    if (dir === 0) { if (u[hi] - u[lo] >= h) dir = hi > lo ? 1 : -1; }
    else if (dir === 1 && u[hi] - u[i] >= h) { out.push(hi); dir = -1; lo = i; }
    else if (dir === -1 && u[i] - u[lo] >= h) { out.push(lo); dir = 1; hi = i; }
  }
  return out;
}

/** a scribble's cusps (its ends included) and the axis its legs go along */
interface Scribble { c: Pt[]; ax: Pt; loops: boolean }

function shapeOf(pts: Pt[], o: ScratchOpts): Scribble | null {
  const z = o.zoom ?? 1;
  const step = 2 / z;
  const q = resample(pts, step), n = q.length;
  if (n < 12) return null;
  // the axis it goes back and forth along: the main direction of its steps
  let sxx = 0, sxy = 0, syy = 0;
  for (let i = 1; i < n; i++) {
    const dx = q[i][0] - q[i - 1][0], dy = q[i][1] - q[i - 1][1], l2 = dx * dx + dy * dy || 1;
    sxx += (dx * dx) / l2; sxy += (dx * dy) / l2; syy += (dy * dy) / l2;
  }
  const th = Math.atan2(2 * sxy, sxx - syy) / 2, ax: Pt = [Math.cos(th), Math.sin(th)];
  const u = q.map(p => p[0] * ax[0] + p[1] * ax[1]);
  // where it turns back along it: by ~6 screen px first, then by 35 % of the swings found
  const h0 = 6 / z;
  let r = reversals(u, h0);
  if (r.length >= 2) {
    const e = [0, ...r, n - 1];
    const sw = e.slice(1).map((x, i) => Math.abs(u[x] - u[e[i]])).sort((a, b) => a - b);
    const h = Math.max(h0, 0.35 * sw[sw.length >> 1]);
    if (h > h0) r = reversals(u, h);
  }
  // a cusp where it turns round there, over two fifths of the shorter leg or a fifth — to the left (1)
  // or the right (-1)
  const e = [0, ...r, n - 1];
  const dir = (a: number, b: number) => { const dx = q[b][0] - q[a][0], dy = q[b][1] - q[a][1], l = Math.hypot(dx, dy) || 1; return [dx / l, dy / l]; };
  // (how far it has turned at each point, to the left)
  const wound = [0, 0];
  for (let i = 1; i < n - 1; i++) {
    const ax0 = q[i][0] - q[i - 1][0], ay0 = q[i][1] - q[i - 1][1], ax1 = q[i + 1][0] - q[i][0], ay1 = q[i + 1][1] - q[i][1];
    wound.push(wound[i] + Math.atan2(ax0 * ay1 - ay0 * ax1, ax0 * ax1 + ay0 * ay1));
  }
  const turns = r.map((i, j) => {
    const k = Math.max(2, Math.round(0.4 * Math.min(i - e[j], e[j + 2] - i)));
    const at = (k: number) => { const a = dir(Math.max(0, i - k), i), b = dir(i, Math.min(n - 1, i + k)); return a[0] * b[0] + a[1] * b[1]; };
    if (Math.min(at(k), at(Math.max(1, k >> 1))) >= COS_CUSP) return 0;
    return wound[Math.min(n - 1, i + k)] - wound[Math.max(0, i - k)] >= 0 ? 1 : -1;
  });
  // (a turn within ~6 screen px of an end is the end)
  const minLeg = 6 / z;
  const c: Pt[] = [q[0], ...r.map(i => q[i]), q[n - 1]], turn = [0, ...turns, 0];
  if (c.length > 2 && dist(c[0], c[1]) < minLeg) { c.splice(1, 1); turn.splice(1, 1); }
  if (c.length > 2 && dist(c[c.length - 1], c[c.length - 2]) < minLeg) { c.splice(c.length - 2, 1); turn.splice(turn.length - 2, 1); }
  const inner = c.length - 2, turned = turn.filter(Boolean).length;
  if (inner < 2 || turned < 2 || turned < (2 / 3) * inner) return null;
  // a zig-zag turns left and right in turn; a quick hand's thin loops always the same way — as does a
  // circle drawn round a word, so these must cross the ink (scratchOut)
  const pairs = turn.slice(1).map((t, i) => t * turn[i]).filter(Boolean);
  const loops = pairs.filter(x => x < 0).length < (2 / 3) * pairs.length;
  // how tight each is: how long its legs are for how far apart its neighbours are (none where it does not turn round)
  const tightness = (i: number) => (turn[i] ? (dist(c[i], c[i - 1]) + dist(c[i], c[i + 1])) / 2 / Math.max(1e-9, dist(c[i - 1], c[i + 1])) : 0);
  const shape = { c, ax, loops };
  // (judged where both neighbours are turns too: a scribble starts and ends anywhere along a leg)
  if (o.hold) {
    const judged = inner >= 4 ? c.slice(2, -2).map((_, j) => j + 2) : [1, 2];
    return judged.filter(i => tightness(i) > 1).length >= 0.5 * judged.length ? shape : null;
  }
  if (inner === 2) return turn[1] * turn[2] < 0 && tightness(1) > 2.5 && tightness(2) > 2.5 ? shape : null;
  if (inner === 3) return turn[1] && turn[3] && tightness(2) > 1.5 ? shape : null;
  const judged = c.slice(2, -2).map((_, j) => j + 2);
  return judged.filter(i => tightness(i) > 1.1).length >= 0.6 * judged.length ? shape : null;
}

/**
 * The scribble's cusps (its ends included) when its shape is a scratch-out's, else null.
 * Exported for the tests, and for callers that look at the strokes under it only once it is one.
 */
export function scribbleCusps(pts: Pt[], o: ScratchOpts = {}): Pt[] | null {
  return shapeOf(pts, o)?.c ?? null;
}

/** distance from p to the segment ab */
function segDist(p: Pt, a: Pt, b: Pt): number {
  const dx = b[0] - a[0], dy = b[1] - a[1], l2 = dx * dx + dy * dy;
  const t = l2 ? Math.max(0, Math.min(1, ((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / l2)) : 0;
  return Math.hypot(p[0] - a[0] - t * dx, p[1] - a[1] - t * dy);
}

/** whether the segments ab and cd cross */
function crosses(a: Pt, b: Pt, c: Pt, d: Pt): boolean {
  const side = (p: Pt, q: Pt, r: Pt) => (q[0] - p[0]) * (r[1] - p[1]) - (q[1] - p[1]) * (r[0] - p[0]);
  return side(a, b, c) * side(a, b, d) < 0 && side(c, d, a) * side(c, d, b) < 0;
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

/** a stroke near the scribble: its points along its length, how many are in the region, its middle and extent in the scribble's frame */
interface Near { k: number; s: Pt[]; n: number; mu: number; mv: number; u0: number; u1: number; v0: number; v1: number; x0: number; y0: number; x1: number; y1: number }

/**
 * The strokes (`inks`: their centre lines, in the scribble's units) a scribble erases — their indices —,
 * or null when it is no scratch-out and stays as ink. See the top of the file.
 */
export function scratchOut(scribble: Pt[], inks: Pt[][], o: ScratchOpts = {}): number[] | null {
  const shape = shapeOf(scribble, o);
  if (!shape) return null;
  const { c: cusps, ax } = shape;
  const z = o.zoom ?? 1;
  const r = (o.width ?? 0) / 2 + 4 / z;
  const tris: Tri[] = [];
  for (let i = 1; i < cusps.length - 1; i++) tris.push(tri(cusps[i - 1], cusps[i], cusps[i + 1], r));
  // the scribble's box along its legs (u) and across them (v), widened like the region
  const U = (p: Pt) => p[0] * ax[0] + p[1] * ax[1], V = (p: Pt) => p[1] * ax[0] - p[0] * ax[1];
  const bu0 = Math.min(...cusps.map(U)) - r, bu1 = Math.max(...cusps.map(U)) + r;
  const bv0 = Math.min(...cusps.map(V)) - r, bv1 = Math.max(...cusps.map(V)) + r;
  // the region's box, and what is looked at: that and a letter's height or so around it (a dot above a word)
  const rb = { x0: Math.min(...tris.map(t => t.x0)), y0: Math.min(...tris.map(t => t.y0)), x1: Math.max(...tris.map(t => t.x1)), y1: Math.max(...tris.map(t => t.y1)) };
  const reach = Math.min(bu1 - bu0, bv1 - bv0) / 2 + 20 / z;
  const box = { x0: rb.x0 - reach, y0: rb.y0 - reach, x1: rb.x1 + reach, y1: rb.y1 + reach };
  const inked = new Set<number>();
  const near: Near[] = [];
  inks.forEach((pts, k) => {
    if (!pts.length) return;
    // (only what reaches the box is looked at)
    let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
    for (const [x, y] of pts) { if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y; }
    if (x1 < box.x0 || x0 > box.x1 || y1 < box.y0 || y0 > box.y1) return;
    // its length, evenly (a slowly drawn part is not worth more)
    const s = resample(pts, 2 / z);
    let n = 0, su = 0, sv = 0, u0 = Infinity, u1 = -Infinity, v0 = Infinity, v1 = -Infinity;
    for (const p of s) {
      if (p[0] >= rb.x0 && p[0] <= rb.x1 && p[1] >= rb.y0 && p[1] <= rb.y1) {
        let any = false;
        tris.forEach((t, i) => { if (inTri(p, t)) { inked.add(i); any = true; } });
        if (any) n++;
      }
      const u = U(p), v = V(p);
      su += u; sv += v;
      if (u < u0) u0 = u; if (u > u1) u1 = u; if (v < v0) v0 = v; if (v > v1) v1 = v;
    }
    near.push({ k, s, n, mu: su / s.length, mv: sv / s.length, u0, u1, v0, v1, x0, y0, x1, y1 });
  });
  if (inked.size < (o.hold ? 1 / 3 : 2 / 3) * tris.length) return null;
  // thin loops: across the ink twice a leg or more (a circle drawn round a word goes round it)
  if (shape.loops) {
    let n = 0;
    for (const m of near) {
      for (let i = 1; i < scribble.length; i++) {
        const a = scribble[i - 1], b = scribble[i];
        if (Math.max(a[0], b[0]) < m.x0 || Math.min(a[0], b[0]) > m.x1 || Math.max(a[1], b[1]) < m.y0 || Math.min(a[1], b[1]) > m.y1) continue;
        for (let j = 1; j < m.s.length; j++) if (crosses(a, b, m.s[j - 1], m.s[j])) n++;
      }
    }
    if (n < 2 * (cusps.length - 1)) return null;
  }
  // half of it in the region (a third: held)
  const gone = new Set(near.filter(m => m.n && m.n >= (o.hold ? 1 / 3 : 0.5) * m.s.length));
  if (!gone.size) return null;
  // crossed: a sixth of it in the region, its middle in the box (widened by half its thinner side),
  // sticking out of it by less than the box is wide that way
  const bu = bu1 - bu0, bv = bv1 - bv0, pad = Math.min(bu, bv) / 2;
  for (const m of near.filter(m => !gone.has(m) && m.n >= (1 / 6) * m.s.length)) {
    if (m.mu < bu0 - pad || m.mu > bu1 + pad || m.mv < bv0 - pad || m.mv > bv1 + pad) continue;
    if (Math.max(bu0 - m.u0, m.u1 - bu1) < bu && Math.max(bv0 - m.v0, m.v1 - bv1) < bv) gone.add(m);
  }
  // attached to what goes (a dot, a bar, a tail, an accent): about as big as a letter of it or smaller, in its box
  // (widened by half a letter), nearer to it than to anything that stays
  const size = (m: Near) => Math.max(m.u1 - m.u0, m.v1 - m.v0);
  const sizes = [...gone].map(size).sort((a, b) => a - b), usual = sizes[sizes.length >> 1];
  const g = { u0: Math.min(...[...gone].map(m => m.u0)) - usual / 2, u1: Math.max(...[...gone].map(m => m.u1)) + usual / 2, v0: Math.min(...[...gone].map(m => m.v0)) - usual / 2, v1: Math.max(...[...gone].map(m => m.v1)) + usual / 2 };
  const gap = (a: Near, b: Near) => { let d = Infinity; for (const p of a.s) for (const q of b.s) { const e = Math.abs(p[0] - q[0]) + Math.abs(p[1] - q[1]); if (e < d) d = e; } return d; };
  const attached: Near[] = [];
  for (const m of near) {
    if (gone.has(m) || size(m) > 1.5 * usual || m.u0 > g.u1 || m.u1 < g.u0 || m.v0 > g.v1 || m.v1 < g.v0) continue;
    if (m.s.filter(p => { const u = U(p), v = V(p); return u >= g.u0 && u <= g.u1 && v >= g.v0 && v <= g.v1; }).length < 0.8 * m.s.length) continue;
    // (the nearest within reach: what lies farther by its box is not looked at)
    let best: Near | null = null, bd = 0.6 * usual;
    for (const other of near) {
      if (other === m || Math.max(other.x0 - m.x1, m.x0 - other.x1, 0) + Math.max(other.y0 - m.y1, m.y0 - other.y1, 0) > bd) continue;
      const d = gap(m, other);
      if (d <= bd) { bd = d; best = other; }
    }
    if (best && gone.has(best)) attached.push(m);
  }
  for (const m of attached) gone.add(m);
  // lifted well away (~1 cm, or more than half a leg) from what it would erase: it was not meant (Apple's Scribble: drag off to cancel)
  const end = scribble[scribble.length - 1];
  const legs = cusps.slice(1).map((p, i) => dist(p, cusps[i])).sort((a, b) => a - b);
  const away = Math.max(40 / z, 0.6 * legs[legs.length >> 1]);
  if (![...gone].some(m => m.s.some(p => Math.abs(p[0] - end[0]) <= away && Math.abs(p[1] - end[1]) <= away))) return null;
  return [...gone].map(m => m.k);
}

/** the pen has rested at the end of the scribble long enough to ask for it (ms, and how far it may wander in screen px) */
export const SCRATCH_HOLD_MS = 400;
export const SCRATCH_HOLD_PX = 5;
