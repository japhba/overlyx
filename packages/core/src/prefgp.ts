/**
 * Learning what someone likes from their choices between two (the pen lab, client PenLab.tsx): a
 * Gaussian process over settings scaled to [0, 1] each, whose value at a setting is how much they like
 * it — learnt from "A is better", "much better", "about the same" and "horrible", and asked next where
 * it may well beat the best so far.
 *
 * - The model (Chu & Ghahramani, "Preference learning with Gaussian processes", ICML 2005; Brochu, de
 *   Freitas & Ghosh, "Active preference learning with discrete choice data", NIPS 2007, who tuned
 *   materials with it in a few dozen choices; Li et al.'s ROIAL, 2021, for answers on a scale and the
 *   region to avoid): an answer says the difference of the two values lies in an interval, through
 *   noise (ordinal probit) — "better": above SAME, "much better": above MUCH, "about the same": within
 *   ±SAME, "horrible": the value itself below HORRIBLE. The side a setting was shown on may sway the
 *   choice a little (a latent bias, shared by all answers). Each answer is log-concave, so the most
 *   likely values are found by Newton's method, and the uncertainty about them is the Laplace
 *   approximation's — worked out in the space of the answers (I + S·A·K·Aᵀ·S, Cholesky), which stays
 *   small and symmetric (Rasmussen & Williams' Algorithm 3.1 with the preference kernel).
 * - How far a liking reaches (the kernel's length, one for all settings, each setting's own scale
 *   times it): the one under which the answers are most likely (Laplace evidence), from a few.
 * - What to ask (`nextPair`): the best setting shown so far (the incumbent) against the one whose
 *   better-of-the-two is likeliest best (expected utility of the best option, EUBO — Lin et al. 2022,
 *   Astudillo et al. 2023 — which against the incumbent is Nielsen et al.'s bivariate expected
 *   improvement for hearing aids) — or, every few rounds, the best of one draw from the model (Thompson
 *   sampling; Sui et al.'s Self-Sparring): a draw puts its best anywhere the model allows, so a second
 *   region liked as much is found, not only the neighbourhood of the first — or the best of a region
 *   liked less, against what may beat it there, so each region is polished before they are compared.
 * - What came out (`favourites`): the best settings shown, one for each hill of the liking (two are on
 *   one hill if the liking does not dip between them — Ursem's hill–valley test) that is liked about as
 *   much — someone may like a crisp even line and a pressed fountain pen alike.
 * - A prior (`prior`): what others' answers taught (a curator's), as the value expected before any
 *   answer — and what they found horrible kept out of the questions altogether (the caller's veto).
 *
 * Pure, without the DOM: the tests run it against made-up tastes.
 */

/** a setting: each of its numbers in [0, 1] */
export type Setting = number[];

/**
 * An answer: `grade` > 0 — A (`a`) better (2: much), < 0 B better, 0 about the same; `badA`, `badB`:
 * horrible; `top`: which was shown first (0: A) — the side may sway a choice.
 */
export interface Answer { a: Setting; b: Setting; grade: -2 | -1 | 0 | 1 | 2; badA?: boolean; badB?: boolean; top?: 0 | 1 }

export interface PrefOpts {
  /** each setting's length scale, relative (a larger one: liking changes more slowly along it) */
  scale?: number[];
  /** the kernel lengths tried (the likeliest kept) */
  lengths?: number[];
  /** the value expected before any answer (another's taste, scaled) */
  prior?: (x: Setting) => number;
}

/** thresholds of the answers, in the units of the values (whose spread before any answer is 1) */
export const SAME = 0.3, MUCH = 1, HORRIBLE = -1.2;
/** the noise of an answer (a person is not always consistent), of a "horrible", the spread of the bias for a side */
const NOISE = 0.4, NOISE_BAD = 0.5, SIDE = 0.2;

/** one thing an answer says: f[i] − f[j] (or f[i] alone, j < 0), plus `side` times the side's bias, between lo and hi, through noise s */
interface Obs { i: number; j: number; side: number; lo: number; hi: number; s: number }

const LOG_SQRT_2PI = 0.5 * Math.log(2 * Math.PI);
const logPdf = (u: number) => -0.5 * u * u - LOG_SQRT_2PI;

/** erfc, to a relative 1.2e-7 everywhere (Numerical Recipes' erfcc) */
function erfc(x: number): number {
  const z = Math.abs(x), t = 1 / (1 + 0.5 * z);
  const r = t * Math.exp(-z * z - 1.26551223 + t * (1.00002368 + t * (0.37409196 + t * (0.09678418 + t * (-0.18628806 + t * (0.27886807 + t * (-1.13520398 + t * (1.48851587 + t * (-0.82215223 + t * 0.17087277)))))))));
  return x >= 0 ? r : 2 - r;
}
/** log Φ(u), also far in the lower tail */
export function logCdf(u: number): number {
  if (u > -6) return Math.log(0.5 * erfc(-u / Math.SQRT2));
  const u2 = u * u;
  return logPdf(u) - Math.log(-u) + Math.log(1 - 1 / u2 + 3 / (u2 * u2) - 15 / (u2 * u2 * u2));
}
export const cdf = (u: number) => 0.5 * erfc(-u / Math.SQRT2);
const pdf = (u: number) => Math.exp(logPdf(u));

/** log P(lo < d + noise < hi), and its first and second derivatives in d */
function interval(d: number, o: Obs): { l: number; g: number; h: number } {
  const u1 = o.lo === -Infinity ? Infinity : (d - o.lo) / o.s, u2 = o.hi === Infinity ? -Infinity : (d - o.hi) / o.s;
  let l: number;
  if (u2 === -Infinity) l = logCdf(u1);
  else if (u1 === Infinity) l = logCdf(-u2);
  else if (u2 >= 0) { const a = logCdf(-u2), b = logCdf(-u1); l = a + Math.log1p(-Math.exp(b - a)); }
  else { const a = logCdf(u1), b = logCdf(u2); l = a + Math.log1p(-Math.exp(b - a)); }
  const r1 = u1 === Infinity ? 0 : Math.exp(logPdf(u1) - l), r2 = u2 === -Infinity ? 0 : Math.exp(logPdf(u2) - l);
  const g = (r1 - r2) / o.s;
  const h = ((u1 === Infinity ? 0 : -u1 * r1) + (u2 === -Infinity ? 0 : u2 * r2)) / (o.s * o.s) - g * g;
  return { l, g, h: Math.min(0, h) };
}

/** the lower triangle L of a symmetric positive definite matrix (L·Lᵀ) */
function cholesky(a: Float64Array, n: number): Float64Array {
  const L = new Float64Array(n * n);
  for (let i = 0; i < n; i++) {
    for (let j = 0; j <= i; j++) {
      let s = a[i * n + j];
      for (let k = 0; k < j; k++) s -= L[i * n + k] * L[j * n + k];
      if (i === j) L[i * n + i] = Math.sqrt(Math.max(s, 1e-12));
      else L[i * n + j] = s / L[j * n + j];
    }
  }
  return L;
}
/** L⁻¹·b (forward) */
function lower(L: Float64Array, n: number, b: Float64Array): Float64Array {
  const x = new Float64Array(n);
  for (let i = 0; i < n; i++) { let s = b[i]; for (let k = 0; k < i; k++) s -= L[i * n + k] * x[k]; x[i] = s / L[i * n + i]; }
  return x;
}
/** L⁻ᵀ·b (backward) */
function upper(L: Float64Array, n: number, b: Float64Array): Float64Array {
  const x = new Float64Array(n);
  for (let i = n - 1; i >= 0; i--) { let s = b[i]; for (let k = i + 1; k < n; k++) s -= L[k * n + i] * x[k]; x[i] = s / L[i * n + i]; }
  return x;
}

const key = (x: Setting) => x.map(v => v.toFixed(5)).join(',');

/** the model of someone's taste, from their answers */
export class PrefModel {
  readonly dim: number;
  /** the settings answered about (each once) */
  readonly pts: Setting[] = [];
  /** the settings called horrible (indices into pts) */
  readonly bad = new Set<number>();
  private obs: Obs[] = [];
  private scale: number[];
  private lengths: number[];
  private prior: (x: Setting) => number;
  private m: Float64Array = new Float64Array(0);
  // the fit: the length; α — K⁻¹·(f − m) at the most likely values, the side's bias last —; √D; the Cholesky factor of I + S·A·K·Aᵀ·S
  length = 0;
  private alpha: Float64Array = new Float64Array(0);
  private S: Float64Array = new Float64Array(0);
  private L: Float64Array = new Float64Array(0);
  /** the most likely values at pts */
  values: number[] = [];
  /** the side's bias (the top one's, in favour of it) */
  bias = 0;
  /** the evidence of the length kept (log) */
  evidence = 0;

  constructor(dim: number, opts: PrefOpts = {}) {
    this.dim = dim;
    this.scale = opts.scale ?? new Array(dim).fill(1);
    this.lengths = opts.lengths ?? [0.25, 0.35, 0.5, 0.7];
    this.prior = opts.prior ?? (() => 0);
  }

  /** the index of a setting among those answered about (added if new) */
  index(x: Setting): number {
    const k = key(x);
    const at = this.pts.findIndex(p => key(p) === k);
    if (at >= 0) return at;
    this.pts.push(x.slice());
    return this.pts.length - 1;
  }

  /** an answer, taken in (fit() then) — "both horrible" says nothing of which is better */
  add(ans: Answer): void {
    const a = this.index(ans.a), b = this.index(ans.b);
    const g = ans.grade, s = NOISE, side = ans.top === undefined ? 0 : ans.top === 0 ? 1 : -1;
    if (a !== b && !(g === 0 && ans.badA && ans.badB)) {
      const [lo, hi] = g === 2 ? [MUCH, Infinity] : g === 1 ? [SAME, Infinity] : g === 0 ? [-SAME, SAME] : g === -1 ? [-Infinity, -SAME] : [-Infinity, -MUCH];
      this.obs.push({ i: a, j: b, side, lo, hi, s });
    }
    if (ans.badA && !this.bad.has(a)) { this.bad.add(a); this.obs.push({ i: a, j: -1, side: 0, lo: -Infinity, hi: HORRIBLE, s: NOISE_BAD }); }
    if (ans.badB && !this.bad.has(b)) { this.bad.add(b); this.obs.push({ i: b, j: -1, side: 0, lo: -Infinity, hi: HORRIBLE, s: NOISE_BAD }); }
  }

  get answers(): number { return this.obs.length; }

  kernel(x: Setting, y: Setting, length = this.length): number {
    let s = 0;
    for (let d = 0; d < this.dim; d++) { const u = (x[d] - y[d]) / (length * this.scale[d]); s += u * u; }
    return Math.exp(-0.5 * s);
  }

  /**
   * The most likely values — at the length under which the answers are likeliest (`choose`, or no
   * length yet; else the one kept), from where the last fit left them.
   */
  fit(choose = false): void {
    const n = this.pts.length;
    this.m = Float64Array.from(this.pts, p => this.prior(p));
    if (!this.obs.length) { this.alpha = new Float64Array(n + 1); this.values = Array.from(this.m); this.S = new Float64Array(0); this.L = new Float64Array(0); if (!this.length) this.length = this.lengths[1] ?? this.lengths[0]; return; }
    const tried = choose || !this.length ? this.lengths : [this.length];
    let best: ReturnType<PrefModel['laplace']> | null = null;
    for (const len of tried) {
      const r = this.laplace(len, len === this.length ? this.alpha : null);
      if (!best || r.evidence > best.evidence) best = r;
    }
    this.length = best!.length; this.alpha = best!.alpha; this.S = best!.S; this.L = best!.L; this.evidence = best!.evidence;
    this.values = best!.f.slice(0, n); this.bias = best!.f[n];
  }

  /** Newton's method for the most likely values (and the side's bias, last) at one length, and the Laplace evidence */
  private laplace(length: number, warm: Float64Array | null) {
    const n = this.pts.length, N = n + 1, M = this.obs.length, obs = this.obs;
    const m = new Float64Array(N);
    m.set(this.m);
    const K = new Float64Array(N * N);
    for (let i = 0; i < n; i++) for (let j = 0; j <= i; j++) { const k = this.kernel(this.pts[i], this.pts[j], length) + (i === j ? 1e-6 : 0); K[i * N + j] = K[j * N + i] = k; }
    K[n * N + n] = SIDE * SIDE;
    const Kv = (v: Float64Array) => { const out = new Float64Array(N); for (let i = 0; i < N; i++) { let s = 0; for (let j = 0; j < N; j++) s += K[i * N + j] * v[j]; out[i] = s; } return out; };
    const Av = (v: Float64Array) => Float64Array.from(obs, o => v[o.i] - (o.j >= 0 ? v[o.j] : 0) + o.side * v[n]);
    const AtV = (w: Float64Array) => { const out = new Float64Array(N); obs.forEach((o, k) => { out[o.i] += w[k]; if (o.j >= 0) out[o.j] -= w[k]; out[n] += o.side * w[k]; }); return out; };
    // the values: f = m + K·α
    const at = (alpha: Float64Array) => { const g = Kv(alpha); for (let i = 0; i < N; i++) g[i] += m[i]; return g; };
    const objective = (alpha: Float64Array, f: Float64Array) => {
      let s = 0;
      const d = Av(f);
      obs.forEach((o, k) => { s += interval(d[k], o).l; });
      let q = 0;
      for (let i = 0; i < N; i++) q += alpha[i] * (f[i] - m[i]);
      return s - 0.5 * q;
    };
    // (from the last fit's α, the side's bias moved to the end; new settings at 0)
    let alpha = new Float64Array(N);
    if (warm && warm.length >= 2) { alpha.set(warm.subarray(0, Math.min(warm.length - 1, n))); alpha[n] = warm[warm.length - 1]; }
    let f = at(alpha), psi = objective(alpha, f);
    if (warm && !Number.isFinite(psi)) { alpha = new Float64Array(N); f = at(alpha); psi = objective(alpha, f); }
    const factor = (fNow: Float64Array) => {
      const d = Av(fNow), g = new Float64Array(M), D = new Float64Array(M);
      obs.forEach((o, k) => { const r = interval(d[k], o); g[k] = r.g; D[k] = -r.h; });
      const s = Float64Array.from(D, v => Math.sqrt(v));
      // C = I + S·A·K·Aᵀ·S
      const AK = obs.map(o => { const row = new Float64Array(N); for (let j = 0; j < N; j++) row[j] = K[o.i * N + j] - (o.j >= 0 ? K[o.j * N + j] : 0) + o.side * K[n * N + j]; return row; });
      const C = new Float64Array(M * M);
      for (let a = 0; a < M; a++) for (let b = 0; b <= a; b++) {
        const ob = obs[b], v = AK[a][ob.i] - (ob.j >= 0 ? AK[a][ob.j] : 0) + ob.side * AK[a][n];
        C[a * M + b] = C[b * M + a] = s[a] * s[b] * v + (a === b ? 1 : 0);
      }
      return { g, D, s, L: cholesky(C, M) };
    };
    for (let it = 0; it < 40; it++) {
      const fc = factor(f);
      // b = W·(f − m) + ∇;  α_new = b − Aᵀ·S·C⁻¹·S·A·K·b
      const Afm = Av(Float64Array.from(f, (v, i) => v - m[i]));
      const b = AtV(Float64Array.from(Afm, (v, k) => fc.D[k] * v + fc.g[k]));
      const t = Float64Array.from(Av(Kv(b)), (v, k) => fc.s[k] * v);
      const z = upper(fc.L, M, lower(fc.L, M, t));
      const corr = AtV(Float64Array.from(z, (v, k) => fc.s[k] * v));
      const full = Float64Array.from(b, (v, i) => v - corr[i]);
      // (a step back along the way if the whole one overshoots)
      let eta = 1, next = full, fn = at(next), pn = objective(next, fn);
      while (pn < psi - 1e-9 && eta > 1 / 64) {
        eta /= 2;
        next = Float64Array.from(alpha, (v, i) => v + eta * (full[i] - v));
        fn = at(next); pn = objective(next, fn);
      }
      const done = Math.abs(pn - psi) < 1e-7;
      alpha = next; f = fn; psi = pn;
      if (done) break;
    }
    const fc = factor(f);
    let logdet = 0;
    for (let k = 0; k < M; k++) logdet += Math.log(fc.L[k * M + k]);
    return { length, alpha, S: fc.s, L: fc.L, f: Array.from(f), evidence: psi - logdet };
  }

  /** what the model says of settings: the expected value, its variance, and what their covariances are worked out from */
  predict(xs: Setting[]): { mu: number[]; v: number[]; w: Float64Array[] } {
    const n = this.pts.length, M = this.obs.length;
    const mu: number[] = [], v: number[] = [], w: Float64Array[] = [];
    for (const x of xs) {
      const k = Float64Array.from(this.pts, p => this.kernel(x, p));
      let s = this.prior(x);
      for (let i = 0; i < n; i++) s += k[i] * this.alpha[i];
      mu.push(s);
      if (!M) { v.push(1); w.push(new Float64Array(0)); continue; }
      // (a setting's value and the side's bias are independent: its row of A·K has no bias part)
      const sa = Float64Array.from(this.obs, (o, j) => this.S[j] * (k[o.i] - (o.j >= 0 ? k[o.j] : 0)));
      const q = lower(this.L, M, sa);
      let qq = 0;
      for (let j = 0; j < M; j++) qq += q[j] * q[j];
      v.push(Math.max(1e-9, 1 - qq));
      w.push(q);
    }
    return { mu, v, w };
  }

  /** the covariance of two settings' values, from what predict() gave for each */
  cov(x: Setting, y: Setting, wx: Float64Array, wy: Float64Array): number {
    let s = this.kernel(x, y);
    for (let j = 0; j < wx.length; j++) s -= wx[j] * wy[j];
    return s;
  }

  /** the expected values alone (quicker than predict) */
  means(xs: Setting[]): number[] {
    return xs.map(x => { let s = this.prior(x); for (let i = 0; i < this.pts.length; i++) s += this.kernel(x, this.pts[i]) * this.alpha[i]; return s; });
  }

  /** how likely `x` is liked better than `y` */
  better(x: Setting, y: Setting): number {
    const p = this.predict([x, y]);
    const sd = Math.sqrt(Math.max(1e-9, p.v[0] + p.v[1] - 2 * this.cov(x, y, p.w[0], p.w[1])));
    return cdf((p.mu[0] - p.mu[1]) / sd);
  }

  /** the best of the settings shown so far (none called horrible, if any is not) */
  incumbent(): number {
    let best = -1;
    for (let i = 0; i < this.pts.length; i++) {
      if (this.bad.has(i) && this.bad.size < this.pts.length) continue;
      if (best < 0 || this.values[i] > this.values[best]) best = i;
    }
    return best;
  }

  /** the distance of two settings, each number by its scale */
  distance(x: Setting, y: Setting): number {
    let s = 0;
    for (let d = 0; d < this.dim; d++) { const u = (x[d] - y[d]) / this.scale[d]; s += u * u; }
    return Math.sqrt(s);
  }

  /** whether x and y are on one hill of the liking: it does not dip between them by more than `dip` below the lower of the two */
  sameHill(x: Setting, y: Setting, dip = 0.3): boolean {
    const between = [1, 2, 3, 4, 5].map(k => x.map((v, d) => v + ((y[d] - v) * k) / 6));
    const mu = this.means([x, y, ...between]);
    const floor = Math.min(mu[0], mu[1]) - dip;
    return mu.slice(2).every(v => v >= floor);
  }
}

/** a random number generator from a seed (mulberry32) */
export function seeded(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const gaussian = (rand: () => number) => Math.sqrt(-2 * Math.log(1 - rand())) * Math.cos(2 * Math.PI * rand());

/**
 * The hills of the liking among the settings shown (none horrible), the best first: each with its best
 * setting (its head) and the settings on it — each, the best first, on the hill of the first head it
 * shares one with (sameHill), else a head of its own.
 */
export function modes(model: PrefModel): { head: number; members: number[] }[] {
  const order = model.pts.map((_, i) => i).filter(i => !model.bad.has(i)).sort((a, b) => model.values[b] - model.values[a]);
  const out: { head: number; members: number[] }[] = [];
  for (const i of order) {
    const hill = out.find(h => model.sameHill(model.pts[h.head], model.pts[i]));
    if (hill) hill.members.push(i);
    else out.push({ head: i, members: [i] });
  }
  return out;
}

/** EUBO of a pair against the incumbent: E[max(f(x), f(x⁺))] − f̄(x⁺) — how much better than it the better of the two is expected to be */
function eubo(mu: number, mu0: number, sd: number): number {
  const u = (mu - mu0) / sd;
  return sd * pdf(u) + (mu - mu0) * cdf(u);
}

/** how far apart (distance) the settings of two regions are at least (`regions`) */
export const APART = 0.45;

/**
 * The regions of the settings shown (none horrible), the best first, each with its best setting: those
 * within `apart` of one another (and so on) together. Unlike the hills (modes), a region needs no dip
 * between it and the others — a setting far from the best one is a place worth polishing before it is
 * known to be a hill of its own.
 */
export function regions(model: PrefModel, apart = APART): { best: number; members: number[] }[] {
  const ids = model.pts.map((_, i) => i).filter(i => !model.bad.has(i));
  const of = new Map<number, number>();
  let next = 0;
  for (const i of ids) {
    if (of.has(i)) continue;
    const stack = [i];
    of.set(i, next);
    while (stack.length) {
      const k = stack.pop()!;
      for (const j of ids) if (!of.has(j) && model.distance(model.pts[k], model.pts[j]) < apart) { of.set(j, next); stack.push(j); }
    }
    next++;
  }
  const out: { best: number; members: number[] }[] = [];
  for (let r = 0; r < next; r++) {
    const members = ids.filter(i => of.get(i) === r);
    out.push({ best: members.reduce((a, b) => (model.values[b] > model.values[a] ? b : a)), members });
  }
  return out.sort((a, b) => model.values[b.best] - model.values[a.best]);
}

/**
 * The settings to choose among next: the incumbent (the best shown so far) and its challenger from
 * `pool` — the one whose better-of-the-two is expected best (EUBO; its covariance with the incumbent
 * counted), or, `draw`, the best of one draw from the model over part of the pool (Thompson sampling:
 * a liked region elsewhere is tried too) — or, `region` k (> 0), the best of the k-th best region
 * against what may beat it there (the settings nearer to it than to the other regions' best). Settings
 * closer than `near` (distance) to the incumbent are left out. `score`: the challenger's EUBO (small:
 * little left to find near the incumbent).
 */
export function nextPair(model: PrefModel, pool: Setting[], opts: { draw?: boolean; region?: number; rand?: () => number; near?: number } = {}): { a: Setting; b: Setting; score: number } {
  const rand = opts.rand ?? Math.random, near = opts.near ?? 0.05;
  let inc = model.incumbent();
  let within: (x: Setting) => boolean = () => true;
  if (opts.region) {
    const rs = regions(model);
    const r = rs[opts.region];
    if (r) {
      inc = r.best;
      const bests = rs.map(o => model.pts[o.best]), mine = model.pts[r.best];
      within = x => { const d = model.distance(x, mine); return d < APART && bests.every(o => o === mine || model.distance(x, o) > d); };
    }
  }
  const x0 = inc >= 0 ? model.pts[inc] : pool[Math.floor(rand() * pool.length)];
  let cands = pool.filter(x => model.distance(x, x0) >= near && within(x));
  if (!cands.length) cands = pool.filter(x => model.distance(x, x0) >= near);
  if (!cands.length) return { a: x0, b: pool[0], score: 0 };
  if (opts.draw) {
    // (a draw over a few hundred of them, and the incumbent: their joint distribution, sampled once)
    const part: Setting[] = [];
    const take = Math.min(cands.length, 240);
    const idx = cands.map((_, i) => i);
    for (let i = 0; i < take; i++) { const j = i + Math.floor(rand() * (idx.length - i)); [idx[i], idx[j]] = [idx[j], idx[i]]; part.push(cands[idx[i]]); }
    const xs = [x0, ...part], n = xs.length;
    const p = model.predict(xs);
    const C = new Float64Array(n * n);
    for (let i = 0; i < n; i++) for (let j = 0; j <= i; j++) { const c = model.cov(xs[i], xs[j], p.w[i], p.w[j]) + (i === j ? 1e-6 : 0); C[i * n + j] = C[j * n + i] = c; }
    const L = cholesky(C, n);
    const z = Float64Array.from({ length: n }, () => gaussian(rand));
    let best = 1, bestV = -Infinity;
    for (let i = 0; i < n; i++) {
      let s = p.mu[i];
      for (let k = 0; k <= i; k++) s += L[i * n + k] * z[k];
      if (i && s > bestV) { bestV = s; best = i; }
    }
    return { a: x0, b: xs[best], score: bestV };
  }
  const p = model.predict([x0, ...cands]);
  let best = 0, bestE = -Infinity;
  for (let i = 0; i < cands.length; i++) {
    const sd = Math.sqrt(Math.max(1e-9, p.v[i + 1] + p.v[0] - 2 * model.cov(cands[i], x0, p.w[i + 1], p.w[0])));
    const e = eubo(p.mu[i + 1], p.mu[0], sd);
    if (e > bestE) { bestE = e; best = i; }
  }
  return { a: x0, b: cands[best], score: bestE };
}

/**
 * The settings liked best, one for each hill (modes) — as many as `max` that are liked about as much
 * (no more than `within` below the best) —, of those shown, so each was seen.
 */
export function favourites(model: PrefModel, max = 3, within = 1): { x: Setting; value: number }[] {
  const out: { x: Setting; value: number }[] = [];
  for (const h of modes(model)) {
    if (out.length >= max) break;
    const v = model.values[h.head];
    if (out.length && v < out[0].value - within) break;
    out.push({ x: model.pts[h.head], value: v });
  }
  return out;
}

/** settings spread evenly over [lo, 1 − lo]^dim (Halton's sequence, from `skip` on) */
export function spread(dim: number, count: number, skip = 20, lo = 0): Setting[] {
  const primes = [2, 3, 5, 7, 11, 13, 17, 19, 23, 29, 31, 37, 41, 43, 47];
  const radical = (i: number, b: number) => { let f = 1, r = 0; while (i > 0) { f /= b; r += f * (i % b); i = Math.floor(i / b); } return r; };
  return Array.from({ length: count }, (_, k) => Array.from({ length: dim }, (_, d) => lo + (1 - 2 * lo) * radical(k + skip, primes[d % primes.length])));
}

/** settings around `x` (each number moved by about `sigma`, kept in [0, 1]) */
export function around(x: Setting, count: number, sigma: number, rand: () => number): Setting[] {
  return Array.from({ length: count }, () => x.map(v => Math.max(0, Math.min(1, v + sigma * gaussian(rand)))));
}
