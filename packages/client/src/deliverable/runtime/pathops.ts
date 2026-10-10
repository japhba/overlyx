/**
 * Path geometry for the canvas's Inkscape tools (no DOM): paths as nodes with handles (what the
 * node editor drags), parsed from and written to SVG path data, flattened to polygons, combined
 * with Inkscape's Path ▸ Union / Difference / Intersection / Exclusion (polygon-clipping; curves
 * are flattened, the result fitted with Béziers again — Schneider's algorithm), simplified,
 * reversed, a segment split at a point.
 */
import polygonClipping, { type MultiPolygon, type Polygon, type Ring } from 'polygon-clipping';
import { normalizePath } from '@overlyx/core/layout/model.ts';

export type Pt = [number, number];
/** a node: its point, the handle before it (`i`) and after it (`o`), null when the segment is straight */
export interface PNode { p: Pt; i: Pt | null; o: Pt | null; smooth?: boolean }
export interface SubPath { nodes: PNode[]; closed: boolean }
/** an affine matrix [a b c d e f] (SVG's) */
export type Mat = [number, number, number, number, number, number];

export const apply = (m: Mat, [x, y]: Pt): Pt => [m[0] * x + m[2] * y + m[4], m[1] * x + m[3] * y + m[5]];
export const mul = (m: Mat, n: Mat): Mat => [m[0] * n[0] + m[2] * n[1], m[1] * n[0] + m[3] * n[1], m[0] * n[2] + m[2] * n[3], m[1] * n[2] + m[3] * n[3], m[0] * n[4] + m[2] * n[5] + m[4], m[1] * n[4] + m[3] * n[5] + m[5]];
export function invert(m: Mat): Mat {
  const det = m[0] * m[3] - m[1] * m[2] || 1e-12;
  return [m[3] / det, -m[1] / det, -m[2] / det, m[0] / det, (m[2] * m[5] - m[3] * m[4]) / det, (m[1] * m[4] - m[0] * m[5]) / det];
}

const near = (a: Pt, b: Pt, eps = 1e-6) => Math.abs(a[0] - b[0]) < eps && Math.abs(a[1] - b[1]) < eps;

/* ------------------------------------------------------------------ parse / write */

export function parseD(d: string): SubPath[] {
  const out: SubPath[] = [];
  let cur: SubPath | null = null;
  let start: Pt = [0, 0];
  for (const s of normalizePath(d)) {
    if (s.c === 'M') { start = [s.p[0], s.p[1]]; cur = { nodes: [{ p: start, i: null, o: null }], closed: false }; out.push(cur); continue; }
    if (s.c === 'Z') {
      if (!cur) continue;
      cur.closed = true;
      // a closing segment that ends on the first node: that node, not a second one
      const n = cur.nodes;
      if (n.length > 1 && near(n[n.length - 1].p, n[0].p, 1e-3)) { n[0].i = n[n.length - 1].i; n.pop(); }
      cur = null;
      continue;
    }
    // drawing on after a Z without a move: from where that subpath started
    if (!cur) { cur = { nodes: [{ p: [start[0], start[1]], i: null, o: null }], closed: false }; out.push(cur); }
    const last = cur.nodes[cur.nodes.length - 1];
    if (s.c === 'L') cur.nodes.push({ p: [s.p[0], s.p[1]], i: null, o: null });
    else { const c = s.p as number[]; last.o = [c[0], c[1]]; cur.nodes.push({ p: [c[4], c[5]], i: [c[2], c[3]], o: null }); }
  }
  for (const sp of out) for (const n of sp.nodes) n.smooth = isSmooth(n);
  return out.filter(sp => sp.nodes.length > 0);
}

/** handles on a line through the node, on both sides */
function isSmooth(n: PNode): boolean {
  if (!n.i || !n.o) return false;
  const ax = n.p[0] - n.i[0], ay = n.p[1] - n.i[1], bx = n.o[0] - n.p[0], by = n.o[1] - n.p[1];
  const la = Math.hypot(ax, ay), lb = Math.hypot(bx, by);
  if (la < 1e-9 || lb < 1e-9) return false;
  return Math.abs(ax * by - ay * bx) / (la * lb) < 0.02 && ax * bx + ay * by > 0;
}

const fmt = (v: number, digits: number) => { const k = 10 ** digits; const r = Math.round(v * k) / k; return Object.is(r, -0) ? '0' : String(r); };

export function toD(subs: SubPath[], digits = 2): string {
  const f = (p: Pt) => `${fmt(p[0], digits)} ${fmt(p[1], digits)}`;
  const parts: string[] = [];
  for (const sp of subs) {
    const n = sp.nodes;
    if (!n.length) continue;
    parts.push(`M${f(n[0].p)}`);
    const seg = (a: PNode, b: PNode) => (a.o || b.i ? `C${f(a.o ?? a.p)} ${f(b.i ?? b.p)} ${f(b.p)}` : `L${f(b.p)}`);
    for (let k = 1; k < n.length; k++) parts.push(seg(n[k - 1], n[k]));
    if (sp.closed) {
      const a = n[n.length - 1], b = n[0];
      if (n.length > 1 && (a.o || b.i)) parts.push(seg(a, b));
      parts.push('Z');
    }
  }
  return parts.join('');
}

/** polygon / polyline `points` */
export function parsePoints(points: string, closed: boolean): SubPath[] {
  const v = Array.from(points.matchAll(/-?(?:\d+\.?\d*|\.\d+)(?:e[-+]?\d+)?/gi), m => Number(m[0]));
  const nodes: PNode[] = [];
  for (let k = 0; k + 1 < v.length; k += 2) nodes.push({ p: [v[k], v[k + 1]], i: null, o: null });
  return nodes.length ? [{ nodes, closed }] : [];
}

/** all straight: written back as `points` (a polygon stays a polygon) */
export function straightOnly(subs: SubPath[]): boolean { return subs.every(sp => sp.nodes.every(n => !n.i && !n.o)); }
export function toPoints(sp: SubPath, digits = 2): string { return sp.nodes.map(n => `${fmt(n.p[0], digits)},${fmt(n.p[1], digits)}`).join(' '); }

export function rectSubs(x: number, y: number, w: number, h: number, rx = 0, ry = rx): SubPath[] {
  rx = Math.min(Math.max(0, rx), w / 2); ry = Math.min(Math.max(0, ry), h / 2);
  if (!rx || !ry) return [{ closed: true, nodes: [[x, y], [x + w, y], [x + w, y + h], [x, y + h]].map(p => ({ p: p as Pt, i: null, o: null })) }];
  const k = 0.5523;
  const n = (p: Pt, i: Pt | null, o: Pt | null): PNode => ({ p, i, o, smooth: false });
  return [{ closed: true, nodes: [
    n([x + rx, y], [x + rx - rx * k, y], null), n([x + w - rx, y], null, [x + w - rx + rx * k, y]),
    n([x + w, y + ry], [x + w, y + ry - ry * k], null), n([x + w, y + h - ry], null, [x + w, y + h - ry + ry * k]),
    n([x + w - rx, y + h], [x + w - rx + rx * k, y + h], null), n([x + rx, y + h], null, [x + rx - rx * k, y + h]),
    n([x, y + h - ry], [x, y + h - ry + ry * k], null), n([x, y + ry], null, [x, y + ry - ry * k]),
  ] }];
}

export function ellipseSubs(cx: number, cy: number, rx: number, ry: number): SubPath[] {
  const k = 0.5523;
  const n = (p: Pt, i: Pt, o: Pt): PNode => ({ p, i, o, smooth: true });
  return [{ closed: true, nodes: [
    n([cx + rx, cy], [cx + rx, cy - ry * k], [cx + rx, cy + ry * k]),
    n([cx, cy + ry], [cx + rx * k, cy + ry], [cx - rx * k, cy + ry]),
    n([cx - rx, cy], [cx - rx, cy + ry * k], [cx - rx, cy - ry * k]),
    n([cx, cy - ry], [cx - rx * k, cy - ry], [cx + rx * k, cy - ry]),
  ] }];
}

export function mapSubs(subs: SubPath[], m: Mat): SubPath[] {
  return subs.map(sp => ({ closed: sp.closed, nodes: sp.nodes.map(n => ({ p: apply(m, n.p), i: n.i && apply(m, n.i), o: n.o && apply(m, n.o), smooth: n.smooth })) }));
}

export function boundsOf(subs: SubPath[]): { x: number; y: number; w: number; h: number } {
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (const ring of flatten(subs, 0.5)) for (const [x, y] of ring) { x0 = Math.min(x0, x); y0 = Math.min(y0, y); x1 = Math.max(x1, x); y1 = Math.max(y1, y); }
  return Number.isFinite(x0) ? { x: x0, y: y0, w: x1 - x0, h: y1 - y0 } : { x: 0, y: 0, w: 0, h: 0 };
}

/* ------------------------------------------------------------------ segments */

export function bezierAt(a: Pt, b: Pt, c: Pt, d: Pt, t: number): Pt {
  const u = 1 - t;
  return [u * u * u * a[0] + 3 * u * u * t * b[0] + 3 * u * t * t * c[0] + t * t * t * d[0], u * u * u * a[1] + 3 * u * u * t * b[1] + 3 * u * t * t * c[1] + t * t * t * d[1]];
}

/** the segment from node k to the next (the closing one of a closed path for the last k) */
export function segment(sp: SubPath, k: number): [Pt, Pt, Pt, Pt, boolean] | null {
  const a = sp.nodes[k], b = sp.nodes[(k + 1) % sp.nodes.length];
  if (!a || !b || (k === sp.nodes.length - 1 && !sp.closed)) return null;
  const curve = !!(a.o || b.i);
  return [a.p, a.o ?? a.p, b.i ?? b.p, b.p, curve];
}

/** the point of the path nearest to `q`: which segment, where on it, how far */
export function nearestOnPath(subs: SubPath[], q: Pt): { s: number; k: number; t: number; d: number; p: Pt } | null {
  let best: { s: number; k: number; t: number; d: number; p: Pt } | null = null;
  subs.forEach((sp, s) => {
    for (let k = 0; k < sp.nodes.length; k++) {
      const g = segment(sp, k);
      if (!g) continue;
      const N = g[4] ? 48 : 1;
      if (!g[4]) {
        const [a, , , d] = g;
        const dx = d[0] - a[0], dy = d[1] - a[1], L = dx * dx + dy * dy || 1;
        const t = Math.max(0, Math.min(1, ((q[0] - a[0]) * dx + (q[1] - a[1]) * dy) / L));
        const p: Pt = [a[0] + dx * t, a[1] + dy * t];
        const dd = Math.hypot(p[0] - q[0], p[1] - q[1]);
        if (!best || dd < best.d) best = { s, k, t, d: dd, p };
        continue;
      }
      for (let j = 0; j <= N; j++) {
        const t = j / N, p = bezierAt(g[0], g[1], g[2], g[3], t);
        const dd = Math.hypot(p[0] - q[0], p[1] - q[1]);
        if (!best || dd < best.d) best = { s, k, t, d: dd, p };
      }
    }
  });
  return best;
}

/** a node put into segment k at t (de Casteljau: the curve keeps its shape) */
export function splitAt(sp: SubPath, k: number, t: number): number {
  const g = segment(sp, k);
  if (!g) return -1;
  const a = sp.nodes[k], b = sp.nodes[(k + 1) % sp.nodes.length];
  const at = k + 1;
  if (!g[4]) {
    sp.nodes.splice(at, 0, { p: [g[0][0] + (g[3][0] - g[0][0]) * t, g[0][1] + (g[3][1] - g[0][1]) * t], i: null, o: null });
    return at;
  }
  const lerp = (p: Pt, q: Pt): Pt => [p[0] + (q[0] - p[0]) * t, p[1] + (q[1] - p[1]) * t];
  const [p0, p1, p2, p3] = g;
  const q0 = lerp(p0, p1), q1 = lerp(p1, p2), q2 = lerp(p2, p3), r0 = lerp(q0, q1), r1 = lerp(q1, q2), s = lerp(r0, r1);
  a.o = q0; b.i = q2;
  sp.nodes.splice(at, 0, { p: s, i: r0, o: r1, smooth: true });
  return at;
}

export function reverseSubs(subs: SubPath[]): SubPath[] {
  return subs.map(sp => {
    const nodes = sp.nodes.slice().reverse().map(n => ({ p: n.p, i: n.o, o: n.i, smooth: n.smooth }));
    // a closed path keeps its first node first
    if (sp.closed && nodes.length > 1) nodes.unshift(nodes.pop()!);
    return { closed: sp.closed, nodes };
  });
}

/* ------------------------------------------------------------------ polygons */

/** the path as polylines (curves subdivided until flat within `tol`); closed rings do not repeat their first point */
export function flatten(subs: SubPath[], tol = 0.25): Pt[][] {
  const out: Pt[][] = [];
  const rec = (a: Pt, b: Pt, c: Pt, d: Pt, pts: Pt[], depth: number) => {
    const dx = d[0] - a[0], dy = d[1] - a[1], L = Math.hypot(dx, dy) || 1;
    const d1 = Math.abs((b[0] - d[0]) * dy - (b[1] - d[1]) * dx) / L, d2 = Math.abs((c[0] - d[0]) * dy - (c[1] - d[1]) * dx) / L;
    if (depth > 12 || d1 + d2 <= tol) { pts.push(d); return; }
    const m = (p: Pt, q: Pt): Pt => [(p[0] + q[0]) / 2, (p[1] + q[1]) / 2];
    const ab = m(a, b), bc = m(b, c), cd = m(c, d), abc = m(ab, bc), bcd = m(bc, cd), s = m(abc, bcd);
    rec(a, ab, abc, s, pts, depth + 1); rec(s, bcd, cd, d, pts, depth + 1);
  };
  for (const sp of subs) {
    if (!sp.nodes.length) continue;
    const pts: Pt[] = [sp.nodes[0].p];
    const n = sp.nodes.length;
    for (let k = 0; k < (sp.closed ? n : n - 1); k++) {
      const g = segment(sp, k);
      if (!g) continue;
      if (g[4]) rec(g[0], g[1], g[2], g[3], pts, 0); else pts.push(g[3]);
    }
    if (sp.closed && pts.length > 1 && near(pts[0], pts[pts.length - 1], 1e-6)) pts.pop();
    out.push(pts);
  }
  return out;
}

/** Ramer–Douglas–Peucker on a closed ring */
export function simplifyRing(pts: Pt[], tol: number): Pt[] {
  if (pts.length < 4) return pts;
  // split at the two points farthest apart so that the closed ring is two open runs
  let a = 0, b = 0, best = -1;
  for (let k = 0; k < pts.length; k++) { const d = Math.hypot(pts[k][0] - pts[0][0], pts[k][1] - pts[0][1]); if (d > best) { best = d; b = k; } }
  const run = (from: number, to: number): Pt[] => { const r: Pt[] = []; for (let k = from; ; k = (k + 1) % pts.length) { r.push(pts[k]); if (k === to) break; } return r; };
  const s1 = rdp(run(a, b), tol), s2 = rdp(run(b, a), tol);
  return [...s1.slice(0, -1), ...s2.slice(0, -1)];
}

export function rdp(pts: Pt[], tol: number): Pt[] {
  if (pts.length < 3) return pts.slice();
  const [a, b] = [pts[0], pts[pts.length - 1]];
  const dx = b[0] - a[0], dy = b[1] - a[1], L = Math.hypot(dx, dy);
  let idx = -1, max = -1;
  for (let k = 1; k < pts.length - 1; k++) {
    const p = pts[k];
    const d = L < 1e-9 ? Math.hypot(p[0] - a[0], p[1] - a[1]) : Math.abs(dx * (a[1] - p[1]) - dy * (a[0] - p[0])) / L;
    if (d > max) { max = d; idx = k; }
  }
  if (max <= tol) return [a, b];
  return [...rdp(pts.slice(0, idx + 1), tol).slice(0, -1), ...rdp(pts.slice(idx), tol)];
}

/* ------------------------------------------------------------------ curve fitting (Schneider, Graphics Gems I) */

type V = Pt;
const sub = (a: V, b: V): V => [a[0] - b[0], a[1] - b[1]];
const add = (a: V, b: V): V => [a[0] + b[0], a[1] + b[1]];
const scl = (a: V, s: number): V => [a[0] * s, a[1] * s];
const dot = (a: V, b: V) => a[0] * b[0] + a[1] * b[1];
const len = (a: V) => Math.hypot(a[0], a[1]);
const unit = (a: V): V => { const l = len(a) || 1; return [a[0] / l, a[1] / l]; };

/** a run of points as cubic Béziers within `err`: [p0, c1, c2, p3] each */
export function fitCubics(pts: Pt[], err: number): [Pt, Pt, Pt, Pt][] {
  const clean = pts.filter((p, k) => k === 0 || !near(p, pts[k - 1], 1e-6));
  if (clean.length < 2) return [];
  if (clean.length === 2) { const d = len(sub(clean[1], clean[0])) / 3; const t = unit(sub(clean[1], clean[0])); return [[clean[0], add(clean[0], scl(t, d)), sub(clean[1], scl(t, d)), clean[1]]]; }
  const t1 = unit(sub(clean[1], clean[0])), t2 = unit(sub(clean[clean.length - 2], clean[clean.length - 1]));
  return fitRange(clean, 0, clean.length - 1, t1, t2, err, 0);
}

function fitRange(d: Pt[], first: number, last: number, t1: V, t2: V, err: number, depth: number): [Pt, Pt, Pt, Pt][] {
  if (last - first === 1) { const dist = len(sub(d[last], d[first])) / 3; return [[d[first], add(d[first], scl(t1, dist)), add(d[last], scl(t2, dist)), d[last]]]; }
  let u = chordParams(d, first, last);
  let bez = generate(d, first, last, u, t1, t2);
  let [maxErr, split] = maxError(d, first, last, bez, u);
  if (maxErr < err) return [bez];
  if (maxErr < err * 4) {
    for (let k = 0; k < 4; k++) {
      u = reparam(d, first, last, u, bez);
      bez = generate(d, first, last, u, t1, t2);
      [maxErr, split] = maxError(d, first, last, bez, u);
      if (maxErr < err) return [bez];
    }
  }
  if (depth > 24) return [bez];
  const tc = unit(sub(d[split - 1], d[split + 1]));
  return [...fitRange(d, first, split, t1, tc, err, depth + 1), ...fitRange(d, split, last, scl(tc, -1), t2, err, depth + 1)];
}

function chordParams(d: Pt[], first: number, last: number): number[] {
  const u = [0];
  for (let k = first + 1; k <= last; k++) u.push(u[u.length - 1] + len(sub(d[k], d[k - 1])));
  const tot = u[u.length - 1] || 1;
  return u.map(x => x / tot);
}

function generate(d: Pt[], first: number, last: number, u: number[], t1: V, t2: V): [Pt, Pt, Pt, Pt] {
  const p0 = d[first], p3 = d[last];
  const C = [[0, 0], [0, 0]], X = [0, 0];
  for (let k = 0; k < u.length; k++) {
    const t = u[k], b = 1 - t;
    const a1 = scl(t1, 3 * t * b * b), a2 = scl(t2, 3 * t * t * b);
    C[0][0] += dot(a1, a1); C[0][1] += dot(a1, a2); C[1][0] += dot(a1, a2); C[1][1] += dot(a2, a2);
    const tmp = sub(d[first + k], add(scl(p0, b * b * b + 3 * t * b * b), scl(p3, 3 * t * t * b + t * t * t)));
    X[0] += dot(a1, tmp); X[1] += dot(a2, tmp);
  }
  const det = C[0][0] * C[1][1] - C[1][0] * C[0][1];
  let al = det === 0 ? 0 : (X[0] * C[1][1] - X[1] * C[0][1]) / det;
  let ar = det === 0 ? 0 : (C[0][0] * X[1] - C[1][0] * X[0]) / det;
  const seg = len(sub(p3, p0)), eps = 1e-6 * seg;
  if (al < eps || ar < eps) { al = ar = seg / 3; }
  return [p0, add(p0, scl(t1, al)), add(p3, scl(t2, ar)), p3];
}

function maxError(d: Pt[], first: number, last: number, bez: [Pt, Pt, Pt, Pt], u: number[]): [number, number] {
  let max = 0, split = Math.floor((last - first + 1) / 2) + first;
  for (let k = first + 1; k < last; k++) {
    const p = bezierAt(bez[0], bez[1], bez[2], bez[3], u[k - first]);
    const e = len(sub(p, d[k]));
    if (e > max) { max = e; split = k; }
  }
  return [max, split];
}

function reparam(d: Pt[], first: number, last: number, u: number[], bez: [Pt, Pt, Pt, Pt]): number[] {
  return u.map((t, k) => {
    const p = d[first + k];
    const q = bezierAt(bez[0], bez[1], bez[2], bez[3], t);
    const b = 1 - t;
    const q1: V = add(add(scl(sub(bez[1], bez[0]), 3 * b * b), scl(sub(bez[2], bez[1]), 6 * b * t)), scl(sub(bez[3], bez[2]), 3 * t * t));
    const q2: V = add(scl(add(sub(bez[2], scl(bez[1], 2)), bez[0]), 6 * b), scl(add(sub(bez[3], scl(bez[2], 2)), bez[1]), 6 * t));
    const num = dot(sub(q, p), q1), den = dot(q1, q1) + dot(sub(q, p), q2);
    return den === 0 ? t : Math.min(1, Math.max(0, t - num / den));
  });
}

/** where a fitted curve must break: sharp turns, and both ends of long straight edges */
function breaks(ring: Pt[], long: number, deg = 35): boolean[] {
  const n = ring.length, cos = Math.cos(deg * Math.PI / 180);
  return ring.map((b, k) => {
    const a = ring[(k - 1 + n) % n], c = ring[(k + 1) % n];
    if (len(sub(b, a)) > long || len(sub(c, b)) > long) return true;
    return dot(unit(sub(b, a)), unit(sub(c, b))) < cos;
  });
}

/**
 * A closed ring as a path: straight where it is straight (long edges, corners kept), cubic Béziers
 * fitted where many short edges follow a curve (a flattened arc). `tol`: how far it may stray (px).
 */
export function ringToSubPath(ring: Pt[], tol = 0.35, long = 30): SubPath {
  const pts = simplifyRing(ring, tol / 3);
  const n = pts.length;
  if (n < 3) return { closed: true, nodes: pts.map(p => ({ p, i: null, o: null })) };
  const brk = breaks(pts, long);
  const starts = brk.map((b, k) => (b ? k : -1)).filter(k => k >= 0);
  if (!starts.length) starts.push(0);
  type Seg = { a: Pt; c1: Pt | null; c2: Pt | null; b: Pt };
  const segs: Seg[] = [];
  for (let s = 0; s < starts.length; s++) {
    const from = starts[s], to = starts.length === 1 ? from : starts[(s + 1) % starts.length];
    const run: Pt[] = [pts[from]];
    for (let k = (from + 1) % n; ; k = (k + 1) % n) { run.push(pts[k]); if (k === to) break; }
    if (run.length <= 3) { for (let k = 0; k < run.length - 1; k++) segs.push({ a: run[k], c1: null, c2: null, b: run[k + 1] }); continue; }
    for (const c of fitCubics(run, tol)) segs.push(lineLike(c) ? { a: c[0], c1: null, c2: null, b: c[3] } : { a: c[0], c1: c[1], c2: c[2], b: c[3] });
  }
  const nodes: PNode[] = segs.map((g, k) => ({ p: g.a, o: g.c1, i: segs[(k - 1 + segs.length) % segs.length].c2 }));
  for (const nd of nodes) nd.smooth = isSmooth(nd);
  return { closed: true, nodes };
}

function lineLike(c: [Pt, Pt, Pt, Pt]): boolean {
  const [a, b, d, e] = c;
  const dx = e[0] - a[0], dy = e[1] - a[1], L = Math.hypot(dx, dy) || 1;
  return Math.abs((b[0] - a[0]) * dy - (b[1] - a[1]) * dx) / L < 0.05 && Math.abs((d[0] - a[0]) * dy - (d[1] - a[1]) * dx) / L < 0.05;
}

/* ------------------------------------------------------------------ booleans */

export type BoolOp = 'union' | 'difference' | 'intersection' | 'exclusion';

/** the area of one object: its closed rings, holes by even-odd (an inner ring cuts a hole, as in most drawings) */
export function areaOf(rings: Pt[][]): MultiPolygon {
  const closed = rings.filter(r => r.length >= 3).map(r => [r.map(p => [p[0], p[1]] as [number, number]) as Ring] as Polygon);
  if (!closed.length) return [];
  if (closed.length === 1) return [closed[0]];
  return polygonClipping.xor(closed[0], ...closed.slice(1));
}

/** Inkscape's path operations on objects in z-order (bottom first): Difference = bottom minus the rest */
export function booleanOp(op: BoolOp, areas: MultiPolygon[]): MultiPolygon {
  const a = areas.filter(x => x.length);
  if (!a.length) return [];
  if (a.length === 1) return a[0];
  switch (op) {
    case 'union': return polygonClipping.union(a[0], ...a.slice(1));
    case 'intersection': return polygonClipping.intersection(a[0], ...a.slice(1));
    case 'exclusion': return polygonClipping.xor(a[0], ...a.slice(1));
    case 'difference': return polygonClipping.difference(a[0], ...a.slice(1));
  }
}

/** a boolean result as a path (outer rings and holes as subpaths: fill-rule evenodd) */
export function multiPolygonToSubs(mp: MultiPolygon, tol = 0.35): SubPath[] {
  const out: SubPath[] = [];
  for (const poly of mp) for (const ring of poly) {
    const pts = ring.slice(0, near(ring[0] as Pt, ring[ring.length - 1] as Pt) ? -1 : undefined) as Pt[];
    if (pts.length >= 3) out.push(ringToSubPath(pts, tol));
  }
  return out;
}

/** Path ▸ Simplify: the path refitted with fewer nodes (`tol` px, larger = simpler) */
export function simplifySubs(subs: SubPath[], tol: number): SubPath[] {
  return subs.map(sp => {
    const ring = flatten([sp], tol / 4)[0] ?? [];
    if (sp.closed) return ringToSubPath(ring, tol);
    const pts = rdp(ring, tol / 3);
    const cubics = fitCubics(pts, tol);
    if (!cubics.length) return sp;
    const nodes: PNode[] = [{ p: cubics[0][0], i: null, o: cubics[0][1] }];
    for (const c of cubics) { nodes[nodes.length - 1].o = lineLike(c) ? null : c[1]; nodes.push({ p: c[3], i: lineLike(c) ? null : c[2], o: null }); }
    for (const n of nodes) n.smooth = isSmooth(n);
    return { closed: false, nodes };
  });
}
