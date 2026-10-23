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
 * the pen is the line that stays. A Pencil's line (NibOpts.lift) is inked only where it pressed: it
 * thins out as the pen lands and lifts, and breaks off where the pen only grazed the glass. While it is
 * drawn, only its end is worked out again (InkCache), however long it gets. Pure: the runtime draws
 * it, the tests measure it.
 */

/** [x, y, pressure 0..1] — 0.5 where there is none (a mouse, a finger); 0 from a pen: not known (its first and last events) */
export type FreePt = [number, number, number];

/** a stretch of the stroke at one width: its points (slide px); `k`: the chunk it is in (FreeOpts.chunk) */
export interface InkRun { w: number; pts: [number, number][]; k?: number }

/**
 * GoodNotes' pen settings (0..1 each; protocol.ts Nib): a ball pen's line is even and round, whatever
 * the rest. `rounding`: how the line joins the points the pen reported — 0 straight from one to the
 * next (every corner where the pen turned, whole-px steps shown), 1 a curve through them (corners only
 * where it turned by more than 100°, whole-px steps smoothed away); strokes from before it had 1.
 * `usual`: the pressure the hand writes with (measured by the pen calibration), drawn at the nominal
 * width — 0.25 (the Pencil's usual) when not measured.
 */
export interface NibOpts {
  ball?: boolean; sharpness?: number; sensitivity?: number; flatness?: number; stabilization?: number; rounding?: number; usual?: number;
  /**
   * The points are a pen's (the Pencil's): ink only where it pressed — the line thins out as it lands
   * and lifts as the pressure does, and there is none where it hardly touched (grazing the glass on
   * the way to the next letter), nor the little hook its tip makes as it lands or leaves. Strokes from
   * before it: without.
   */
  lift?: boolean;
}

export interface FreeOpts {
  /** the nominal width (px) */
  width: number;
  highlighter?: boolean;
  /** the points carry a pen's pressure (else the width is even) */
  pressure?: boolean;
  /** screen px per px of the slide (the stabilization is in screen px) */
  zoom?: number;
  /** the points came in whole px (older Safari): smoothed as far as the rounding says, or their steps show — a number: the size of such a px in the stroke's px */
  coarse?: boolean | number;
  nib?: NibOpts;
  /** the pen has lifted: the end tapers too (a sharp tip's) */
  final?: boolean;
  /**
   * The runs cut every this many samples too (their widths as without), each marked with its chunk
   * (`k`): while the stroke is drawn only its last chunks change — the smoothing reaches back a few
   * dozen samples —, so the line drawn so far is left alone and only its end is painted again (a long
   * stroke repainted whole every frame was what made the line lag behind the pen).
   */
  chunk?: number;
  /** the same object at every call for a stroke being drawn (InkCache): only its end is worked out again */
  cache?: InkCache;
}

/**
 * Whether a point the pen reported (at time `t`; the last taken at `lastT`) is a new one: Safari's
 * coalesced events on the iPad repeat the last move's (A B A C D C …: the line went back and forth
 * over itself), so only those after the last one taken count, and none where one of the last few was.
 * The last point again is the pen pressing harder or less where it is (Safari reports a change of
 * pressure alone as a move — a Pencil lifting where it stands): its pressure is taken, the strongest
 * while the stroke is a dot.
 */
export function freshPoint(pts: FreePt[], lastT: number, t: number, p: FreePt): boolean {
  if (t < lastT) return false;
  const last = pts[pts.length - 1];
  if (last && last[0] === p[0] && last[1] === p[1]) {
    if (p[2] > 0) last[2] = pts.length === 1 ? Math.max(last[2], p[2]) : p[2];
    return false;
  }
  for (let i = Math.max(0, pts.length - 4); i < pts.length; i++) if (pts[i][0] === p[0] && pts[i][1] === p[1]) return false;
  return true;
}

/**
 * The width at a pressure, as a part of the nominal one, at a pressure sensitivity (0..1): the
 * Pencil's usual writing (~0.25) the nominal width whatever the sensitivity; at full sensitivity a
 * light touch two fifths of it and pressed hard twice it, at a quarter (the default) 0.79–1.19.
 */
export function pressureWidth(p: number, sensitivity = 1, usual = 0.25): number {
  const r = (q: number) => 1 - (1 - Math.max(0, Math.min(1, q))) ** 3;
  return Math.exp(sensitivity * (r(p) - r(usual)) * 1.643);
}

/** the pressure a hand writes with, from its strokes' (pen) pressures: their median, the first and last few of each (touching down, lifting) left out */
export function usualPressure(strokes: FreePt[][]): number | null {
  const ps: number[] = [];
  for (const s of strokes) for (let i = 3; i < s.length - 3; i++) if (s[i][2] > 0) ps.push(s[i][2]);
  if (ps.length < 30) return null;
  ps.sort((a, b) => a - b);
  return Math.round(Math.max(0.05, Math.min(0.95, ps[ps.length >> 1])) * 100) / 100;
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
  const zoom = o.zoom && o.zoom > 0 ? o.zoom : 1;
  const lift = !!nib.lift && !!o.pressure && !o.highlighter;
  let pts = clean(input, !!o.pressure && pen);
  if (!pts.length) return [];
  // (the Pencil's hook as it landed — and, lifted, as it left)
  if (lift) pts = dehooked(pts, HOOK_PX / zoom, !!o.final);
  // a dot (a tap, a full stop): as hard as it was pressed at its hardest, not thinning out
  const dot = lift && arcLength(pts) < 1.5 * w;
  if (dot) { const top = Math.max(...pts.map(q => q[2])); pts = pts.map(q => [q[0], q[1], top]); }
  const sens = pen && o.pressure ? clamp01(nib.sensitivity ?? 0.25) : 0;
  const sharp = pen ? clamp01(nib.sharpness ?? 0) : 0, flat = pen ? clamp01(nib.flatness ?? 0) : 0;
  const usual = nib.usual !== undefined && Number.isFinite(nib.usual) ? Math.max(0.05, Math.min(0.95, nib.usual)) : 0.25;
  const pw = (q: number) => pressureWidth(q, sens, usual);
  if (pts.length === 1) return [{ w: round2(w * (sens ? pw(pts[0][2]) : 1)), pts: [[pts[0][0], pts[0][1]]] }];
  // samples every h px along the line through the points: straight from one to the next, curved as far
  // as the rounding says — each piece between the pen's corners on its own (the corners kept exactly)
  const round = clamp01(nib.rounding ?? 1);
  const h = Math.max(0.3, Math.min(1, w / 6));
  const s = o.cache ? liveSamples(pts, h, round, o.cache) : joinSamples(cornered(pts, Math.cos(((40 + 60 * round) * Math.PI) / 180)).map(piece => resample(spline(piece, h, round), h)));
  // smoothed only where asked (the stabilization, in screen px) or needed (whole px, rounded), without pulling curves in
  const unit = typeof o.coarse === 'number' && o.coarse > 0 ? o.coarse : 1;
  const coarse = !!o.coarse && round > 0;
  const sq = coarse ? COARSE_SIGMA * unit : 0, ss = (clamp01(nib.stabilization ?? 0) * STAB_PX) / zoom;
  const sigma = Math.hypot(sq, ss);
  const sp = Math.max(1.2, 2.5 * sigma) / h;
  const chunk = o.chunk && o.chunk > 1 ? Math.floor(o.chunk) : 0;
  const n = s.x.length;
  // a stroke being drawn (`cache`): what the last call made of the samples is kept as far as they are the
  // same and far enough from the end not to feel the new ones (the smoothing's reach) — the same result
  // as worked out afresh, in a time that does not grow with the stroke
  const inked = lift && !dot;
  const key = [w, sens, sharp, flat, usual, round, h, sigma, coarse && !ss ? unit : 0, chunk, o.final ? 1 : 0, inked ? zoom : 0].join(' ');
  const kept = o.cache?.kept && o.cache.kept.key === key ? o.cache.kept : null;
  let m = 0;
  if (kept) {
    const on = kept.s.x.length, lim = Math.min(n, on);
    let d = 0;
    while (d < lim && s.x[d] === kept.s.x[d] && s.y[d] === kept.s.y[d] && s.p[d] === kept.s.p[d]) d++;
    // (the reach of the smoothing of the line, of the pressure, of the flat nib's direction, of a sharp tip's taper at a lifted end)
    const kx = sigma / h >= 0.3 ? Math.ceil(2.5 * (sigma / h)) : 0, kp = sens ? Math.ceil(2.5 * sp) : 0, kd = flat ? Math.ceil(2.5 * (2 / h)) : 0;
    const kt = o.final && sharp ? Math.ceil((w * (1 + 5 * sharp)) / h) + 1 : 0;
    const kl = inked ? Math.ceil((2.5 * LIFT_SIGMA) / zoom / h) + 1 : 0;
    m = Math.max(0, Math.min(d, on) - Math.max(2 * kx + 2 + kd, kp, kt, kl) - 1);
  }
  const x = twice(s.x, sigma / h, m, kept?.x), y = twice(s.y, sigma / h, m, kept?.y);
  // whole px, unstabilized: smoothed only as far as the rounding could have put the pen (its steps go, its shape stays) — less, rounding less
  if (coarse && !ss) { within(x, s.x, COARSE_WITHIN * unit * round, m); within(y, s.y, COARSE_WITHIN * unit * round, m); }
  const p = sens ? gauss(s.p, sp, true, m, kept?.p) : s.p;
  // how much ink (lift): the pressure smoothed a little, against the strongest of the stroke so far (or
  // a part of the usual, if that is less) — eased in from an eighth of it to two fifths; none below that
  let ink: number[] | null = null, top: number[] | null = null, lq: number[] | null = null;
  if (inked) {
    lq = gauss(s.p, LIFT_SIGMA / zoom / h, true, m, kept?.lq ?? undefined);
    top = kept?.top ?? new Array<number>(n);
    top.length = n;
    ink = kept?.ink ?? new Array<number>(n);
    ink.length = n;
    const floor = LIFT_FLOOR * usual;
    for (let i = m; i < n; i++) {
      top[i] = Math.max(i ? top[i - 1] : floor, lq[i]);
      const r = Math.max(0, Math.min(1, (lq[i] / top[i] - LIFT_LO) / (LIFT_HI - LIFT_LO)));
      // (a ball pen's line stays even: there or not)
      ink[i] = nib.ball ? (r > 0.15 ? 1 : 0) : r * r * (3 - 2 * r);
    }
  }
  // the width along it: pressure, the flat tip's direction, the sharp tip's taper at the start (and the end, once lifted)
  const across = flat ? flatWidth(flat) : null;
  let dir: number[] | null = null;
  if (across) {
    const from = Math.max(0, m - Math.ceil(2.5 * (2 / h)));
    const raw = new Array<number>(n);
    for (let i = from; i < n; i++) { const a = Math.max(0, i - 2), b = Math.min(n - 1, i + 2); raw[i] = across(Math.atan2(y[b] - y[a], x[b] - x[a])); }
    dir = gauss(raw, 2 / h, true, m, kept?.dir ?? undefined);
  }
  const taper = sharp ? w * (1 + 5 * sharp) : 0, tip = 1 - 0.85 * sharp;
  const ease = (d: number) => { const u = Math.min(1, d / taper); return tip + (1 - tip) * u * (2 - u); };
  const widthAt = (i: number) => {
    let f = sens ? pw(p[i]) : 1;
    if (ink) f *= ink[i];
    if (dir) f *= dir[i];
    if (taper) { f *= ease(i * h); if (o.final) f *= ease((n - 1 - i) * h); }
    return w * f;
  };
  // runs: a new one where the width has moved a step on (each starts where the last ended)
  // (steps of 2½ %: a little over 0.05 px each side for the usual pen, not seen even zoomed in)
  const even = !sens && !dir && !taper && !ink;
  const q = Math.max(0.03, w * 0.025);
  // (thinning out where the pen lands and lifts: in steps of 0.7 each below 0.8 of the width — a run, a
  // path in the page, for each 2½ % made a stroke's text twice as long)
  const low = 0.8 * w, TAPER = Math.log(1 / 0.7);
  const level = (v: number) => (v >= low ? round2(Math.max(q, Math.round(v / q) * q)) : round2(Math.max(q, low * 0.7 ** Math.round(Math.log(low / v) / TAPER))));
  const moved = (v: number, from: number) => (v >= low && from >= low ? Math.abs(v - from) > q : Math.abs(Math.log(v / from)) > TAPER * 0.75);
  // (kept: the runs as they were up to sample m, the one it was in cut back there and gone on with)
  const of = kept ? kept.of : new Array<number>(n);
  of.length = n;
  let runs: KeptRun[] = [];
  let cur: KeptRun | null = null;
  let redo = 0;
  if (kept && m > 0) {
    // (sample m - 1 in a gap: the runs before it as they were, a new one after it)
    let j = m - 1;
    while (j >= 0 && kept.of[j] < 0) j--;
    const r = j >= 0 ? kept.of[j] : -1;
    runs = kept.runs.slice(0, r + 1);
    redo = Math.max(0, r);
    if (r >= 0 && j === m - 1) {
      const last = runs[r];
      cur = { w: last.w, k: last.k, i0: last.i0, joined: last.joined, pts: last.pts.slice(0, (last.joined ? 1 : 0) + m - last.i0) };
      runs[r] = cur;
    }
  }
  for (let i = m; i < n; i++) {
    // (where the pen hardly touched: none — the run before ends, the next starts afresh)
    if (ink && ink[i] < LIFT_CUT) { cur = null; of[i] = -1; continue; }
    const wi = even ? w : widthAt(i);
    const k = chunk ? Math.floor(i / chunk) : 0;
    const step = !cur || moved(wi, cur.w);
    if (step || (chunk && k !== cur!.k)) {
      // (a new chunk alone: the width goes on as it was)
      const lw = !step ? cur!.w : even ? w : level(wi);
      cur = { w: lw, k: chunk ? k : undefined, i0: i, joined: !!cur, pts: cur ? [cur.pts[cur.pts.length - 1]] : [] };
      runs.push(cur);
    }
    cur!.pts.push([x[i], y[i]]);
    of[i] = runs.length - 1;
  }
  const tol = Math.min(0.05, w * 0.015);
  // (each run simplified once it is done: the last ones again)
  for (let i = redo; i < runs.length; i++) runs[i].simple = simplify(runs[i].pts, tol);
  if (o.cache) o.cache.kept = { key, s, x, y, p, dir, runs, of, lq, top, ink };
  return runs.map(r => (r.k === undefined ? { w: r.w, pts: r.simple! } : { w: r.w, pts: r.simple!, k: r.k }));
}

/** a run as inkRuns works it out (FreeOpts.cache): from sample `i0` on (`joined`: starting where the one before ended, at its last sample), its points before simplification and after */
interface KeptRun { w: number; k?: number; i0: number; joined?: boolean; pts: [number, number][]; simple?: [number, number][] }

/** what inkRuns keeps from one call to the next for a stroke being drawn (FreeOpts.cache): its samples, what was made of them, the run each sample went into */
export interface InkCache {
  /** (`lq`, `top`, `ink`: a pen's pressure smoothed a little, the strongest so far, the ink — NibOpts.lift) */
  kept?: { key: string; s: { x: number[]; y: number[]; p: number[] }; x: number[]; y: number[]; p: number[]; dir: number[] | null; runs: KeptRun[]; of: number[]; lq: number[] | null; top: number[] | null; ink: number[] | null };
  /** what liveSamples keeps: the points of the last call, their turns (and the last point each looked at; from `cosOk` on to be looked at again), the pieces' curves sampled as far as settled, the first point anything kept came from */
  front?: { h: number; round: number; pts: FreePt[]; cos: number[]; reach: number[]; cosOk: number; cosDep: number; used: number; pieces: { start: number; end: number; segs: number; r: Resampling; done: Samples | null }[] };
}

const clamp01 = (v: number) => (Number.isFinite(v) ? Math.max(0, Math.min(1, v)) : 0);
const round2 = (n: number) => Math.round(n * 100) / 100;
/** the smoothing (px) of whole-px points, never moving the line further than their rounding (half a px, and a little) */
const COARSE_SIGMA = 3;
const COARSE_WITHIN = 0.6;
const within = (v: number[], raw: number[], d: number, from = 0) => { for (let i = from; i < v.length; i++) v[i] = Math.max(raw[i] - d, Math.min(raw[i] + d, v[i])); };
/** the smoothing (screen px) at full stroke stabilization: at half, a 6 px loop moves less than 0.1 px and a shaky hand's line is calm */
const STAB_PX = 6;
/**
 * A pen's ink (NibOpts.lift): the pressure smoothed over this much (screen px) — enough for the
 * Pencil's steps, not for its lifting (a few px) —, against the strongest of the stroke so far, at
 * least LIFT_FLOOR of the usual: full from LIFT_HI of that, none below LIFT_LO, nothing drawn where
 * less than LIFT_CUT of the width would be. The broad smoothing of the width (beads) had made a lift
 * a blob, and a graze a line.
 */
const LIFT_SIGMA = 1.2, LIFT_FLOOR = 0.6, LIFT_LO = 0.12, LIFT_HI = 0.42, LIFT_CUT = 0.06;
/** the longest hook (screen px, ~0.8 mm on an iPad) the Pencil's tip makes as it lands or lifts, turning back on the line */
const HOOK_PX = 4;

const arcLength = (pts: FreePt[]) => { let l = 0; for (let i = 1; i < pts.length; i++) l += Math.hypot(pts[i][0] - pts[i - 1][0], pts[i][1] - pts[i - 1][1]); return l; };

/**
 * Without the hook at the start (and, `end`, at the end): a stretch of at most `len` before a turn
 * back by more than 120° — the Pencil's tip skidding as it touched (or left) the glass, the line
 * then going the other way. Only on strokes at least four times as long.
 */
function dehooked(pts: FreePt[], len: number, end: boolean): FreePt[] {
  if (pts.length < 6 || arcLength(pts) < 4 * len) return pts;
  const hook = (q: FreePt[]): number => {
    let best = 0, worst = -0.5, along = 0;
    for (let i = 1; i < q.length - 2 && along <= len; i++) {
      along += Math.hypot(q[i][0] - q[i - 1][0], q[i][1] - q[i - 1][1]);
      if (along > len) break;
      let j = i + 1;
      while (j < q.length - 1 && Math.hypot(q[j][0] - q[i][0], q[j][1] - q[i][1]) < len) j++;
      const ax = q[i][0] - q[0][0], ay = q[i][1] - q[0][1], bx = q[j][0] - q[i][0], by = q[j][1] - q[i][1];
      const la = Math.hypot(ax, ay), lb = Math.hypot(bx, by);
      if (la < 0.5 || lb < 0.8 * len) continue;
      const c = (ax * bx + ay * by) / (la * lb);
      if (c < worst) { worst = c; best = i; }
    }
    return best;
  };
  let out = pts;
  const a = hook(out);
  if (a) out = out.slice(a);
  if (end) { const b = hook([...out].reverse()); if (b) out = out.slice(0, out.length - b); }
  return out;
}

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
 * The points in pieces at the pen's sharp turns (by more than 100° at full rounding, 40° at none —
 * `cosLimit` the cosine of that —, measured over 2 px either side: a v's point, an m's foot, a
 * scribble's turn): a curve through a turn rounds it, which read as the line being stabilized; each
 * piece is a curve of its own, the turn stays sharp.
 */
function cornered(pts: FreePt[], cosLimit: number): FreePt[][] {
  const n = pts.length;
  if (n < 5) return [pts];
  const cos = pts.map((_, i) => (i && i < n - 1 ? turnAt(pts, i).c : 1));
  const pieces: FreePt[][] = [];
  let from = 0;
  for (const i of cornersOf(cos, cosLimit)) { pieces.push(pts.slice(from, i + 1)); from = i; }
  pieces.push(pts.slice(from));
  return pieces;
}

/** how far (px) either side of a point its turn is measured */
const TURN_REACH = 2;
/** the cosine of the pen's turn at point i (1: straight on), and the last point looked at after it */
function turnAt(pts: FreePt[], i: number): { c: number; k: number } {
  const n = pts.length, reach = TURN_REACH;
  let j = i - 1, k = i + 1;
  while (j > 0 && Math.hypot(pts[i][0] - pts[j][0], pts[i][1] - pts[j][1]) < reach) j--;
  while (k < n - 1 && Math.hypot(pts[k][0] - pts[i][0], pts[k][1] - pts[i][1]) < reach) k++;
  const ax = pts[i][0] - pts[j][0], ay = pts[i][1] - pts[j][1], bx = pts[k][0] - pts[i][0], by = pts[k][1] - pts[i][1];
  const la = Math.hypot(ax, ay), lb = Math.hypot(bx, by);
  return { c: la < reach * 0.5 || lb < reach * 0.5 ? 1 : (ax * bx + ay * by) / (la * lb), k };
}

/** where the pieces meet: the sharpest point of each turn sharper than `cosLimit` (its neighbours turn less), each piece at least three points long */
function cornersOf(cos: number[], cosLimit: number): number[] {
  const n = cos.length, out: number[] = [];
  let from = 0;
  for (let i = 2; i < n - 2; i++) if (cos[i] < cosLimit && cos[i] <= cos[i - 1] && cos[i] < cos[i + 1] && i - from >= 2) { out.push(i); from = i; }
  return out;
}

/**
 * The centripetal Catmull-Rom curve through the points, as a polyline with pieces of at most `step` px
 * (pressure along it linearly) — `curve` (0..1) of the way from the straight line between each two
 * points to that curve.
 */
function spline(pts: FreePt[], step: number, curve = 1): FreePt[] {
  const n = pts.length;
  const head = beyond(pts[0], pts[1], pts[2]), tail = beyond(pts[n - 1], pts[n - 2], pts[n - 3]);
  const out: FreePt[] = [pts[0]];
  for (let i = 0; i < n - 1; i++) splineSegment(pts, i, head, tail, step, curve, out);
  return out;
}

/** before the first point and after the last: where the curve was heading, bending as it bent (else its ends come out flat) */
function beyond(a: FreePt, b: FreePt, c: FreePt | undefined): FreePt {
  const lin: FreePt = [2 * a[0] - b[0], 2 * a[1] - b[1], a[2]];
  if (!c) return lin;
  const q: FreePt = [3 * a[0] - 3 * b[0] + c[0], 3 * a[1] - 3 * b[1] + c[1], a[2]];
  // (unevenly spaced points: a bend that is not there — straight on instead)
  return Math.hypot(q[0] - a[0], q[1] - a[1]) > 1.5 * Math.hypot(b[0] - a[0], b[1] - a[1]) ? lin : q;
}
/** knot intervals: the square root of each chord (centripetal: no cusps, no loops of its own) */
const knot = (a: FreePt, b: FreePt) => Math.max(1e-4, Math.sqrt(Math.hypot(b[0] - a[0], b[1] - a[1])));

/** the curve from pts[i] to pts[i + 1] (that point last) into `out` — `head`, `tail`: before the first point, after the last */
function splineSegment(pts: FreePt[], i: number, head: FreePt, tail: FreePt, step: number, curve: number, out: FreePt[]): void {
  const n = pts.length;
  {
    const p0 = i ? pts[i - 1] : head, p1 = pts[i], p2 = pts[i + 1], p3 = i + 2 < n ? pts[i + 2] : tail;
    const m = Math.max(1, Math.min(64, Math.ceil(Math.hypot(p2[0] - p1[0], p2[1] - p1[1]) / step)));
    if (curve <= 0) {
      for (let j = 1; j < m; j++) out.push([p1[0] + ((p2[0] - p1[0]) * j) / m, p1[1] + ((p2[1] - p1[1]) * j) / m, p1[2] + ((p2[2] - p1[2]) * j) / m]);
      out.push(p2);
      return;
    }
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
      const lx = p1[0] + ((p2[0] - p1[0]) * j) / m, ly = p1[1] + ((p2[1] - p1[1]) * j) / m;
      out.push([lx + curve * (v1 * dx + v2 * gx - lx), ly + curve * (v1 * dy + v2 * gy - ly), p1[2] + ((p2[2] - p1[2]) * j) / m]);
    }
    out.push(p2);
  }
}

type Samples = { x: number[]; y: number[]; p: number[] };
/** samples being taken along a polyline: those so far, how far on the next is, the point reached */
interface Resampling extends Samples { need: number; at: FreePt }

/** samples every `h` px along a polyline (its last point always) */
function resample(line: FreePt[], h: number): Samples {
  const r: Resampling = { x: [line[0][0]], y: [line[0][1]], p: [line[0][2]], need: h, at: line[0] };
  for (let i = 1; i < line.length; i++) feed(r, line[i], h);
  return finish(r, h);
}
/** the polyline on to `b` */
function feed(r: Resampling, b: FreePt, h: number): void {
  const a = r.at, { x, y, p } = r;
  const seg = Math.hypot(b[0] - a[0], b[1] - a[1]);
  let used = 0, need = r.need;
  while (seg - used >= need) {
    used += need;
    const f = used / seg;
    x.push(a[0] + (b[0] - a[0]) * f); y.push(a[1] + (b[1] - a[1]) * f); p.push(a[2] + (b[2] - a[2]) * f);
    need = h;
  }
  r.need = need - (seg - used);
  r.at = b;
}
/** the samples once the polyline ends where it is (`r` left as it was: `copy`) */
function finish(r: Resampling, h: number, copy = false): Samples {
  const x = copy ? r.x.slice() : r.x, y = copy ? r.y.slice() : r.y, p = copy ? r.p.slice() : r.p, end = r.at;
  // (the end itself: in place of a sample a few hundredths of a step before it)
  if (h - r.need < 0.3 * h && x.length > 1) { x.pop(); y.pop(); p.pop(); }
  x.push(end[0]); y.push(end[1]); p.push(end[2]);
  return { x, y, p };
}
const copied = (r: Resampling): Resampling => ({ x: r.x.slice(), y: r.y.slice(), p: r.p.slice(), need: r.need, at: r.at });

/**
 * The samples of the line through a stroke being drawn (inkRuns with a cache), the same as worked out
 * afresh (cornered, spline, resample, joinSamples) — without going through all of it again at every
 * frame: the pen's turns, and the pieces' curves and samples, are kept as far as the points they
 * come from cannot change any more (the last points can: a corner, the pressure of the last), and the
 * rest worked out on from there. A long stroke took longer a frame the longer it got.
 */
function liveSamples(pts: FreePt[], h: number, round: number, cache: InkCache): Samples {
  const n = pts.length, lim = Math.cos(((40 + 60 * round) * Math.PI) / 180);
  let f = cache.front;
  // (the first point unlike last time's: anything kept that came from it or after, and everything is worked out afresh)
  let pc = 0;
  if (f && f.h === h && f.round === round) { const m = Math.min(n, f.pts.length); while (pc < m && pts[pc][0] === f.pts[pc][0] && pts[pc][1] === f.pts[pc][1] && pts[pc][2] === f.pts[pc][2]) pc++; }
  if (!f || f.h !== h || f.round !== round || pc < f.used || n < 8) {
    f = cache.front = { h, round, pts: [], cos: [], reach: [], cosOk: 1, cosDep: 0, pieces: [], used: 0 };
    if (n < 8) { f.pts = pts.map(q => [q[0], q[1], q[2]]); f.used = n; return joinSamples(cornered(pts, lim).map(piece => resample(spline(piece, h, round), h))); }
  }
  // the turns: those that looked at the last points (they may turn otherwise now), and the new points'
  const { cos, reach } = f;
  cos.length = reach.length = n;
  cos[0] = 1;
  let ok = n - 1;
  for (let i = Math.max(1, f.cosOk); i < n - 1; i++) {
    const t = turnAt(pts, i);
    cos[i] = t.c; reach[i] = t.k;
    if (t.k >= n - 1 && i < ok) ok = i;
  }
  cos[n - 1] = 1;
  for (let i = f.cosOk; i < ok; i++) f.cosDep = Math.max(f.cosDep, reach[i]);
  f.cosOk = ok;
  const cuts = cornersOf(cos, lim);
  // what can no longer change: the points before the last two, before any corner yet to come
  const stable = Math.min(n - 3, ok - 1);
  const starts = [0, ...cuts], ends = [...cuts, n - 1];
  const parts: Samples[] = [];
  let used = f.cosDep + 1;
  for (let k = 0; k < starts.length; k++) {
    const s0 = starts[k], e = ends[k], len = e - s0 + 1;
    let piece = f.pieces[k];
    if (piece?.start !== s0 || (piece.done && piece.end !== e)) {
      piece = f.pieces[k] = { start: s0, end: e, segs: 0, r: { x: [pts[s0][0]], y: [pts[s0][1]], p: [pts[s0][2]], need: h, at: pts[s0] }, done: null };
      f.pieces.length = k + 1;
    }
    piece.end = e;
    used = Math.max(used, s0 + 1);
    if (piece.done) { parts.push(piece.done); used = Math.max(used, e + 1); continue; }
    const local = pts.slice(s0, e + 1);
    const head = beyond(local[0], local[1], local[2]), tail = beyond(local[len - 1], local[len - 2], local[len - 3]);
    const line: FreePt[] = [];
    // (its curve and samples kept as far as no point they came from can change)
    while (piece.segs < len - 1 && s0 + piece.segs + 2 <= Math.min(stable, e) && s0 + 2 <= stable) {
      line.length = 0;
      splineSegment(local, piece.segs, head, tail, h, round, line);
      for (const q of line) feed(piece.r, q, h);
      piece.segs++;
    }
    if (piece.segs) used = Math.max(used, s0 + piece.segs + 2);
    const r = copied(piece.r);
    for (let j = piece.segs; j < len - 1; j++) { line.length = 0; splineSegment(local, j, head, tail, h, round, line); for (const q of line) feed(r, q, h); }
    const out = finish(r, h);
    // (a piece ended at a corner that cannot change, its points all settled: done)
    if (k < starts.length - 1 && e + 1 <= stable) { piece.done = out; used = Math.max(used, e + 1); }
    parts.push(out);
  }
  f.pts = pts.map(q => [q[0], q[1], q[2]]);
  f.used = used;
  return joinSamples(parts);
}

/** the samples of the pieces one after the other (each piece starts where the last ended: that sample once) */
function joinSamples(parts: Samples[]): Samples {
  if (parts.length === 1) return parts[0];
  const out = { x: [] as number[], y: [] as number[], p: [] as number[] };
  for (let i = 0; i < parts.length; i++) {
    const q = parts[i];
    for (let j = i ? 1 : 0; j < q.x.length; j++) { out.x.push(q.x[j]); out.y.push(q.y[j]); out.p.push(q.p[j]); }
  }
  return out;
}

/**
 * A Gaussian (σ in samples) along the samples. Towards either end over as many on each side as
 * there are, so the ends stay where the pen was — or, `oneSided` (the pressure), over what there is
 * on either side, so the ends are smoothed too. From `from` on only, into `out` (what it has before
 * kept: inkRuns' cache).
 */
function gauss(v: number[], sigma: number, oneSided = false, from = 0, out?: number[]): number[] {
  const n = v.length, K = Math.ceil(2.5 * sigma);
  const res = out ?? new Array<number>(n);
  res.length = n;
  if (sigma < 0.3 || n < 3) { for (let i = from; i < n; i++) res[i] = v[i]; return res; }
  const wt = Array.from({ length: K + 1 }, (_, k) => Math.exp(-(k * k) / (2 * sigma * sigma)));
  for (let i = from; i < n; i++) {
    const lo = oneSided ? Math.min(K, i) : Math.min(K, i, n - 1 - i), hi = oneSided ? Math.min(K, n - 1 - i) : lo;
    let s = wt[0] * v[i], ws = wt[0];
    for (let j = 1; j <= lo; j++) { s += wt[j] * v[i - j]; ws += wt[j]; }
    for (let j = 1; j <= hi; j++) { s += wt[j] * v[i + j]; ws += wt[j]; }
    res[i] = s / ws;
  }
  return res;
}

/**
 * Smoothed without shrinking (Tukey's twicing: 2·G(v) − G(G(v))): a Gaussian alone pulls every curve
 * in towards its centre (by σ²/2r — the small loops of handwriting most), which showed as the ink
 * contracting; this takes out the jitter as the Gaussian does but keeps curves where they were.
 * From `from` on only, into `out` (gauss).
 */
function twice(v: number[], sigma: number, from = 0, out?: number[]): number[] {
  const n = v.length;
  const res = out ?? new Array<number>(n);
  res.length = n;
  if (sigma < 0.3) { for (let i = from; i < n; i++) res[i] = v[i]; return res; }
  const g = gauss(v, sigma, false, Math.max(0, from - Math.ceil(2.5 * sigma))), gg = gauss(g, sigma, false, from);
  for (let i = from; i < n; i++) res[i] = 2 * g[i] - gg[i];
  return res;
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
  // (in place: once for each run's points — a stroke being drawn keeps those of its runs drawn already)
  const known = !dx && !dy ? pathOfRun.get(run.pts) : undefined;
  if (known !== undefined) return known;
  const [a, ...rest] = run.pts;
  if (!a) return '';
  let d = `M${f2(a[0] + dx)} ${f2(a[1] + dy)}`;
  if (!rest.length) d += `L${f2(a[0] + dx + 0.01)} ${f2(a[1] + dy)}`;
  else for (const [x, y] of rest) d += `L${f2(x + dx)} ${f2(y + dy)}`;
  if (!dx && !dy) pathOfRun.set(run.pts, d);
  return d;
}
const pathOfRun = new WeakMap<object, string>();

/**
 * The stroke as the page has it: one path for each width, its runs one after the other in it (each
 * run starts with an M) — fewer elements and less text than a path a run. Moved by (dx, dy).
 */
export function inkPaths(runs: InkRun[], dx = 0, dy = 0): { w: number; d: string }[] {
  const by = new Map<number, string>();
  for (const r of runs) by.set(r.w, (by.get(r.w) ?? '') + runPathD(r, dx, dy));
  return [...by].map(([w, d]) => ({ w, d }));
}

/** samples in a chunk of a stroke being drawn (FreeOpts.chunk): a little more than the smoothing reaches back */
export const LIVE_CHUNK = 96;

/**
 * The stroke being drawn as paths: those of each chunk (FreeOpts.chunk) one after the other, one for
 * each width in it — the paths of the chunks drawn already come out the same frame after frame.
 */
export function chunkPaths(runs: InkRun[]): { w: number; d: string }[] {
  const out: { w: number; d: string }[] = [];
  let from = 0;
  for (let i = 1; i <= runs.length; i++) {
    if (i < runs.length && runs[i].k === runs[from].k) continue;
    out.push(...inkPaths(runs.slice(from, i)));
    from = i;
  }
  return out;
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
