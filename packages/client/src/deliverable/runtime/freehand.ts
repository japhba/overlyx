/**
 * Draw's strokes as GoodNotes draws them: the line goes where the pen went — through every point it
 * reported, on a curve (centripetal Catmull-Rom), however few the points (a browser without coalesced
 * events, a fast hand) — smoothed a little along its length, which takes out the jitter of whole-px
 * coordinates (Safari) and of the hand but not the small loops of handwriting. Its width follows the
 * Pencil's pressure, smoothed too (raw pressure makes beads); a mouse's or a finger's is even, as is the
 * highlighter's.
 *
 * The stroke is drawn by the browser's own stroker: runs of the line at one width each, round caps and
 * joins, one after the other (each run starts where the last ended, so their caps meet seamlessly).
 * Width steps of 2½ % are not seen; sharp turns, loops and dots come out clean, which an outline
 * of the stroke (perfect-freehand, before) did not: it straightened the first px of each stroke, made
 * its outline of chords as long as the pen is wide, and blobbed small loops. What the page keeps is
 * these runs (sourceops.ts objectHtml), and what is shown while the stroke is drawn, so the line under
 * the pen is the line that stays. Pure: the runtime draws it, the tests measure it.
 */

/** [x, y, pressure 0..1] — 0.5 where there is none (a mouse, a finger); 0 from a pen: not known (its first and last events) */
export type FreePt = [number, number, number];

/** a stretch of the stroke at one width: its points (slide px) */
export interface InkRun { w: number; pts: [number, number][] }

/** GoodNotes' pen settings (0..1 each; protocol.ts Nib): a ball pen's line is even and round, whatever the rest */
export interface NibOpts { ball?: boolean; sharpness?: number; sensitivity?: number; flatness?: number; stabilization?: number }

export interface FreeOpts {
  /** the nominal width (px) */
  width: number;
  highlighter?: boolean;
  /** the points carry a pen's pressure (else the width is even) */
  pressure?: boolean;
  /** screen px per px of the slide (the stabilization is in screen px) */
  zoom?: number;
  /** the points came in whole px (older Safari): smoothed, or their steps show */
  coarse?: boolean;
  nib?: NibOpts;
  /** the pen has lifted: the end tapers too (a sharp tip's) */
  final?: boolean;
}

/**
 * Whether a point the pen reported (at time `t`; the last taken at `lastT`) is a new one: Safari's
 * coalesced events on the iPad repeat the last move's (A B A C D C …: the line went back and forth
 * over itself), so only those after the last one taken count, and none where one of the last few was.
 */
export function freshPoint(pts: FreePt[], lastT: number, t: number, p: FreePt): boolean {
  if (t < lastT) return false;
  for (let i = Math.max(0, pts.length - 4); i < pts.length; i++) if (pts[i][0] === p[0] && pts[i][1] === p[1]) return false;
  return true;
}

/**
 * Whether a stroke is a scribble (GoodNotes' scribble to erase): back and forth — four legs or more,
 * each going back the way the last came, the whole half as long again as its box is across. Turns are
 * measured over ~5 screen px either side (a quick hand turns round, not on a point). Writing turns
 * back too (a w, an m's foot), but an m's arches all go on and loops go round; what tells the rest
 * from a scribble is that a scribble is over strokes — the runtime's `scribbledOut`. `zoom`: screen px
 * per px of the points.
 */
export function isScribble(pts: [number, number][], zoom = 1): boolean {
  const step = 1.5 / zoom, minLeg = 8 / zoom;
  // the path, a point every `step` px or so
  const q: [number, number][] = [];
  let total = 0, x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (const p of pts) {
    x0 = Math.min(x0, p[0]); y0 = Math.min(y0, p[1]); x1 = Math.max(x1, p[0]); y1 = Math.max(y1, p[1]);
    const l = q[q.length - 1];
    if (!l) { q.push(p); continue; }
    const d = Math.hypot(p[0] - l[0], p[1] - l[1]);
    if (d >= step) { q.push(p); total += d; }
  }
  const n = q.length, W = Math.max(2, Math.ceil(5 / zoom / step)), W2 = Math.max(W + 1, Math.ceil(8 / zoom / step));
  if (n < 2 * W + 4 || total < 1.5 * Math.hypot(x1 - x0, y1 - y0)) return false;
  const unit = (a: number, b: number) => { const dx = q[b][0] - q[a][0], dy = q[b][1] - q[a][1], l = Math.hypot(dx, dy) || 1; return [dx / l, dy / l]; };
  const cosAt = (i: number, w: number) => { const a = unit(Math.max(0, i - w), i), b = unit(i, Math.min(n - 1, i + w)); return a[0] * b[0] + a[1] * b[1]; };
  // the way in and the way out, over ~5 screen px and over ~8 (a quick turn round a radius of a few px; an m's arch is wider)
  const back = (i: number) => Math.min(cosAt(i, W), cosAt(i, W2));
  // the turns: the sharpest point of each stretch where they differ by more than 100°
  const TURN = -0.17;
  const marks = [0];
  for (let i = W; i < n - W; i++) {
    if (back(i) >= TURN) continue;
    let best = i;
    while (i + 1 < n - W && back(i + 1) < TURN) { i++; if (back(i) < back(best)) best = i; }
    marks.push(best);
  }
  marks.push(n - 1);
  const legs = marks.slice(1).map((m, i) => [q[m][0] - q[marks[i]][0], q[m][1] - q[marks[i]][1]]).filter(([a, b]) => Math.hypot(a, b) >= minLeg);
  if (legs.length < 4) return false;
  let goesBack = 0;
  for (let i = 1; i < legs.length; i++) if (legs[i][0] * legs[i - 1][0] + legs[i][1] * legs[i - 1][1] < 0) goesBack++;
  return goesBack >= 0.75 * (legs.length - 1);
}

/**
 * The width at a pressure, as a part of the nominal one, at a pressure sensitivity (0..1): the
 * Pencil's usual writing (~0.25) the nominal width whatever the sensitivity; at full sensitivity a
 * light touch two fifths of it and pressed hard twice it, at a quarter (the default) 0.79–1.19.
 */
export function pressureWidth(p: number, sensitivity = 1): number {
  const r = (q: number) => 1 - (1 - Math.max(0, Math.min(1, q))) ** 3;
  return Math.exp(sensitivity * (r(p) - r(0.25)) * 1.643);
}

/** the nib's edge (a flat tip): rising to the right at 30°, as a pen is held — up-strokes hairlines, down-strokes full (screen y runs down) */
const NIB_ANGLE = -Math.PI / 6;

/** a flat tip's width across a stroke going at angle `a`, its average over all directions 1 */
function flatWidth(flatness: number): (a: number) => number {
  const b = 1 - 0.85 * flatness;
  const raw = (a: number) => Math.sqrt(Math.sin(a - NIB_ANGLE) ** 2 + b * b * Math.cos(a - NIB_ANGLE) ** 2);
  let mean = 0;
  for (let i = 0; i < 64; i++) mean += raw((i * Math.PI) / 64) / 64;
  return a => raw(a) / mean;
}

/** the stroke through `pts`, as runs of one width each (one run: a dot, or an even line) */
export function inkRuns(input: FreePt[], o: FreeOpts): InkRun[] {
  const w = Math.max(0.5, o.width);
  const nib = o.nib ?? {};
  const pen = !o.highlighter && !nib.ball;
  const pts = clean(input, !!o.pressure && pen);
  if (!pts.length) return [];
  const sens = pen && o.pressure ? clamp01(nib.sensitivity ?? 0.25) : 0;
  const sharp = pen ? clamp01(nib.sharpness ?? 0) : 0, flat = pen ? clamp01(nib.flatness ?? 0) : 0;
  if (pts.length === 1) return [{ w: round2(w * (sens ? pressureWidth(pts[0][2], sens) : 1)), pts: [[pts[0][0], pts[0][1]]] }];
  // samples every h px along the curve through the points
  const h = Math.max(0.3, Math.min(1, w / 6));
  const s = resample(cornered(pts).flatMap((piece, i) => (i ? spline(piece, h).slice(1) : spline(piece, h))), h);
  // smoothed only where asked (the stabilization, in screen px) or needed (whole px), without pulling curves in
  const zoom = o.zoom && o.zoom > 0 ? o.zoom : 1;
  const sq = o.coarse ? COARSE_SIGMA : 0, ss = (clamp01(nib.stabilization ?? 0) * STAB_PX) / zoom;
  const sigma = Math.hypot(sq, ss);
  let x = twice(s.x, sigma / h), y = twice(s.y, sigma / h);
  // whole px, unstabilized: smoothed only as far as the rounding could have put the pen (its steps go, its shape stays)
  if (o.coarse && !ss) { x = within(x, s.x, COARSE_WITHIN); y = within(y, s.y, COARSE_WITHIN); }
  const p = sens ? gauss(s.p, Math.max(1.2, 2.5 * sigma) / h, true) : s.p;
  // the width along it: pressure, the flat tip's direction, the sharp tip's taper at the start (and the end, once lifted)
  const n = x.length;
  const across = flat ? flatWidth(flat) : null;
  let dir: number[] | null = null;
  if (across) {
    const raw = x.map((_, i) => { const a = Math.max(0, i - 2), b = Math.min(n - 1, i + 2); return across(Math.atan2(y[b] - y[a], x[b] - x[a])); });
    dir = gauss(raw, 2 / h, true);
  }
  const taper = sharp ? w * (1 + 5 * sharp) : 0, tip = 1 - 0.85 * sharp;
  const ease = (d: number) => { const u = Math.min(1, d / taper); return tip + (1 - tip) * u * (2 - u); };
  const widthAt = (i: number) => {
    let f = sens ? pressureWidth(p[i], sens) : 1;
    if (dir) f *= dir[i];
    if (taper) { f *= ease(i * h); if (o.final) f *= ease((n - 1 - i) * h); }
    return w * f;
  };
  // runs: a new one where the width has moved a step on (each starts where the last ended)
  // (steps of 2½ %: a little over 0.05 px each side for the usual pen, not seen even zoomed in)
  const even = !sens && !dir && !taper;
  const q = Math.max(0.03, w * 0.025);
  const runs: InkRun[] = [];
  let cur: InkRun | null = null;
  for (let i = 0; i < n; i++) {
    const wi = even ? w : widthAt(i);
    if (!cur || Math.abs(wi - cur.w) > q) {
      const lw = even ? w : round2(Math.max(q, Math.round(wi / q) * q));
      cur = { w: lw, pts: cur ? [cur.pts[cur.pts.length - 1]] : [] };
      runs.push(cur);
    }
    cur.pts.push([x[i], y[i]]);
  }
  const tol = Math.min(0.05, w * 0.015);
  return runs.map(r => ({ w: r.w, pts: simplify(r.pts, tol) }));
}

const clamp01 = (v: number) => (Number.isFinite(v) ? Math.max(0, Math.min(1, v)) : 0);
const round2 = (n: number) => Math.round(n * 100) / 100;
/** the smoothing (px) of whole-px points, never moving the line further than their rounding (half a px, and a little) */
const COARSE_SIGMA = 3;
const COARSE_WITHIN = 0.6;
const within = (v: number[], raw: number[], d: number) => v.map((a, i) => Math.max(raw[i] - d, Math.min(raw[i] + d, a)));
/** the smoothing (screen px) at full stroke stabilization: at half, a 6 px loop moves less than 0.1 px and a shaky hand's line is calm */
const STAB_PX = 6;

/** without repeats; a pen's unknown pressures (0) from the nearest known */
function clean(input: FreePt[], pen: boolean): FreePt[] {
  const out: FreePt[] = [];
  for (const [x, y, p] of input) {
    if (!Number.isFinite(x) || !Number.isFinite(y)) continue;
    const last = out[out.length - 1];
    if (last && Math.abs(last[0] - x) < 1e-6 && Math.abs(last[1] - y) < 1e-6) { last[2] = Math.max(last[2], p); continue; }
    out.push([x, y, p]);
  }
  if (pen) {
    const known = out.findIndex(q => q[2] > 0);
    if (known < 0) for (const q of out) q[2] = 0.5;
    else {
      for (let i = 0; i < known; i++) out[i][2] = out[known][2];
      for (let i = known + 1; i < out.length; i++) if (!(out[i][2] > 0)) out[i][2] = out[i - 1][2];
    }
  }
  return out;
}

/**
 * The points in pieces at the pen's sharp turns (by more than 100°, measured over 2 px either side —
 * a v's point, an m's foot, a scribble's turn): a curve through a turn rounds it, which read as the
 * line being stabilized; each piece is a curve of its own, the turn stays sharp.
 */
function cornered(pts: FreePt[]): FreePt[][] {
  const n = pts.length;
  if (n < 5) return [pts];
  const reach = 2;
  const turn = (i: number) => {
    let j = i - 1, k = i + 1;
    while (j > 0 && Math.hypot(pts[i][0] - pts[j][0], pts[i][1] - pts[j][1]) < reach) j--;
    while (k < n - 1 && Math.hypot(pts[k][0] - pts[i][0], pts[k][1] - pts[i][1]) < reach) k++;
    const ax = pts[i][0] - pts[j][0], ay = pts[i][1] - pts[j][1], bx = pts[k][0] - pts[i][0], by = pts[k][1] - pts[i][1];
    const la = Math.hypot(ax, ay), lb = Math.hypot(bx, by);
    return la < reach * 0.5 || lb < reach * 0.5 ? 1 : (ax * bx + ay * by) / (la * lb);
  };
  const cos = pts.map((_, i) => (i && i < n - 1 ? turn(i) : 1));
  const pieces: FreePt[][] = [];
  let from = 0;
  for (let i = 2; i < n - 2; i++) {
    // the sharpest point of a turn (its neighbours turn less), a piece at least three points long
    if (cos[i] < -0.17 && cos[i] <= cos[i - 1] && cos[i] < cos[i + 1] && i - from >= 2) { pieces.push(pts.slice(from, i + 1)); from = i; }
  }
  pieces.push(pts.slice(from));
  return pieces;
}

/** the centripetal Catmull-Rom curve through the points, as a polyline with pieces of at most `step` px (pressure along it linearly) */
function spline(pts: FreePt[], step: number): FreePt[] {
  const n = pts.length;
  // before the first point and after the last: where the curve was heading, bending as it bent (else its ends come out flat)
  const beyond = (a: FreePt, b: FreePt, c: FreePt | undefined): FreePt => {
    const lin: FreePt = [2 * a[0] - b[0], 2 * a[1] - b[1], a[2]];
    if (!c) return lin;
    const q: FreePt = [3 * a[0] - 3 * b[0] + c[0], 3 * a[1] - 3 * b[1] + c[1], a[2]];
    // (unevenly spaced points: a bend that is not there — straight on instead)
    return Math.hypot(q[0] - a[0], q[1] - a[1]) > 1.5 * Math.hypot(b[0] - a[0], b[1] - a[1]) ? lin : q;
  };
  const head = beyond(pts[0], pts[1], pts[2]), tail = beyond(pts[n - 1], pts[n - 2], pts[n - 3]);
  const out: FreePt[] = [pts[0]];
  // knot intervals: the square root of each chord (centripetal: no cusps, no loops of its own)
  const knot = (a: FreePt, b: FreePt) => Math.max(1e-4, Math.sqrt(Math.hypot(b[0] - a[0], b[1] - a[1])));
  for (let i = 0; i < n - 1; i++) {
    const p0 = i ? pts[i - 1] : head, p1 = pts[i], p2 = pts[i + 1], p3 = i + 2 < n ? pts[i + 2] : tail;
    const m = Math.max(1, Math.min(64, Math.ceil(Math.hypot(p2[0] - p1[0], p2[1] - p1[1]) / step)));
    const t1 = knot(p0, p1), t2 = t1 + knot(p1, p2), t3 = t2 + knot(p2, p3);
    for (let j = 1; j < m; j++) {
      // (Barry and Goldman's pyramid, x and y at once)
      const t = t1 + ((t2 - t1) * j) / m;
      const u0 = (t1 - t) / t1, u1 = t / t1, v1 = (t2 - t) / (t2 - t1), v2 = (t - t1) / (t2 - t1), w2 = (t3 - t) / (t3 - t2), w3 = (t - t2) / (t3 - t2);
      const ax = u0 * p0[0] + u1 * p1[0], ay = u0 * p0[1] + u1 * p1[1];
      const bx = v1 * p1[0] + v2 * p2[0], by = v1 * p1[1] + v2 * p2[1];
      const cx = w2 * p2[0] + w3 * p3[0], cy = w2 * p2[1] + w3 * p3[1];
      const e1 = (t2 - t) / t2, e2 = t / t2, f1 = (t3 - t) / (t3 - t1), f2 = (t - t1) / (t3 - t1);
      const dx = e1 * ax + e2 * bx, dy = e1 * ay + e2 * by, gx = f1 * bx + f2 * cx, gy = f1 * by + f2 * cy;
      out.push([v1 * dx + v2 * gx, v1 * dy + v2 * gy, p1[2] + ((p2[2] - p1[2]) * j) / m]);
    }
    out.push(p2);
  }
  return out;
}

/** samples every `h` px along a polyline (its last point always) */
function resample(line: FreePt[], h: number): { x: number[]; y: number[]; p: number[] } {
  const x = [line[0][0]], y = [line[0][1]], p = [line[0][2]];
  let need = h;
  for (let i = 1; i < line.length; i++) {
    const a = line[i - 1], b = line[i];
    const seg = Math.hypot(b[0] - a[0], b[1] - a[1]);
    let used = 0;
    while (seg - used >= need) {
      used += need;
      const f = used / seg;
      x.push(a[0] + (b[0] - a[0]) * f); y.push(a[1] + (b[1] - a[1]) * f); p.push(a[2] + (b[2] - a[2]) * f);
      need = h;
    }
    need -= seg - used;
  }
  const end = line[line.length - 1];
  // (the end itself: in place of a sample a few hundredths of a step before it)
  if (h - need < 0.3 * h && x.length > 1) { x.pop(); y.pop(); p.pop(); }
  x.push(end[0]); y.push(end[1]); p.push(end[2]);
  return { x, y, p };
}

/**
 * A Gaussian (σ in samples) along the samples. Towards either end over as many on each side as
 * there are, so the ends stay where the pen was — or, `oneSided` (the pressure), over what there is
 * on either side, so the ends are smoothed too.
 */
function gauss(v: number[], sigma: number, oneSided = false): number[] {
  const n = v.length, K = Math.ceil(2.5 * sigma);
  if (sigma < 0.3 || n < 3) return v.slice();
  const wt = Array.from({ length: K + 1 }, (_, k) => Math.exp(-(k * k) / (2 * sigma * sigma)));
  const out = new Array<number>(n);
  for (let i = 0; i < n; i++) {
    const lo = oneSided ? Math.min(K, i) : Math.min(K, i, n - 1 - i), hi = oneSided ? Math.min(K, n - 1 - i) : lo;
    let s = wt[0] * v[i], ws = wt[0];
    for (let j = 1; j <= lo; j++) { s += wt[j] * v[i - j]; ws += wt[j]; }
    for (let j = 1; j <= hi; j++) { s += wt[j] * v[i + j]; ws += wt[j]; }
    out[i] = s / ws;
  }
  return out;
}

/**
 * Smoothed without shrinking (Tukey's twicing: 2·G(v) − G(G(v))): a Gaussian alone pulls every curve
 * in towards its centre (by σ²/2r — the small loops of handwriting most), which showed as the ink
 * contracting; this takes out the jitter as the Gaussian does but keeps curves where they were.
 */
function twice(v: number[], sigma: number): number[] {
  if (sigma < 0.3) return v.slice();
  const g = gauss(v, sigma), gg = gauss(g, sigma);
  return g.map((a, i) => 2 * a - gg[i]);
}

/** Ramer–Douglas–Peucker: the points no further than `tol` from the line kept without them dropped (the ends kept) */
function simplify(pts: [number, number][], tol: number): [number, number][] {
  if (pts.length < 3) return pts;
  const keep = new Uint8Array(pts.length);
  keep[0] = keep[pts.length - 1] = 1;
  const stack: [number, number][] = [[0, pts.length - 1]];
  while (stack.length) {
    const [a, b] = stack.pop()!;
    const [ax, ay] = pts[a], [bx, by] = pts[b];
    const dx = bx - ax, dy = by - ay, L = Math.hypot(dx, dy);
    let far = -1, fd = tol;
    for (let i = a + 1; i < b; i++) {
      const d = L < 1e-9 ? Math.hypot(pts[i][0] - ax, pts[i][1] - ay) : Math.abs(dy * (pts[i][0] - ax) - dx * (pts[i][1] - ay)) / L;
      if (d > fd) { fd = d; far = i; }
    }
    if (far >= 0) { keep[far] = 1; stack.push([a, far], [far, b]); }
  }
  return pts.filter((_, i) => keep[i]);
}

const f2 = (n: number) => String(Math.round(n * 100) / 100);

/** a run as SVG path data, moved by (dx, dy) (a dot: a line too short to see, which a round cap makes round) */
export function runPathD(run: InkRun, dx = 0, dy = 0): string {
  const [a, ...rest] = run.pts;
  if (!a) return '';
  let d = `M${f2(a[0] + dx)} ${f2(a[1] + dy)}`;
  if (!rest.length) return d + `L${f2(a[0] + dx + 0.01)} ${f2(a[1] + dy)}`;
  for (const [x, y] of rest) d += `L${f2(x + dx)} ${f2(y + dy)}`;
  return d;
}

/**
 * The stroke as the page has it: one path for each width, its runs one after the other in it (each
 * run starts with an M) — fewer elements and less text than a path a run. Moved by (dx, dy).
 */
export function inkPaths(runs: InkRun[], dx = 0, dy = 0): { w: number; d: string }[] {
  const by = new Map<number, string>();
  for (const r of runs) by.set(r.w, (by.get(r.w) ?? '') + runPathD(r, dx, dy));
  return [...by].map(([w, d]) => ({ w, d }));
}

/** the box the stroke paints (its points, and half its width round them) */
export function runsBox(runs: InkRun[]): { x: number; y: number; w: number; h: number } {
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (const r of runs) for (const [x, y] of r.pts) {
    const h = r.w / 2;
    if (x - h < x0) x0 = x - h; if (y - h < y0) y0 = y - h; if (x + h > x1) x1 = x + h; if (y + h > y1) y1 = y + h;
  }
  return x0 === Infinity ? { x: 0, y: 0, w: 0, h: 0 } : { x: x0, y: y0, w: x1 - x0, h: y1 - y0 };
}
