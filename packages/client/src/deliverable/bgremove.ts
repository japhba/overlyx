/**
 * Removing a picture's background (PowerPoint's Picture Format ▸ Remove Background), without a
 * model: pure pixel work on RGBA arrays, so it runs in a worker (bgremove.worker.ts), on the main
 * thread as a fallback, and in tests.
 *
 * 1. analyse(): the picture scaled down to at most 1600 px for the analysis, in CIE Lab; the
 *    background's colours guessed from the border — k-means (k ≤ 3) over the border's opaque pixels,
 *    every cluster holding at least 15 % of them (else the largest).
 * 2. backgroundMask(): a flood fill from the border pixels close to those colours (ΔE ≤ the
 *    tolerance): only the region connected to the border goes, so a hole of the same colour inside
 *    the subject stays. "Close to the background" means close to one of its colours or to the
 *    backdrop's smooth surface (a quadratic fitted to the border), so a gradient or a vignette goes
 *    too; a neighbour a little beyond the tolerance is taken when it is very close to the pixel the
 *    fill comes from (JPEG noise), but the fill never walks across a halo into the subject. Marks: "remove"
 *    strokes are removed and seed the fill (their colours join the background's); "keep" strokes
 *    are never removed and the fill does not pass them.
 * 3. composite(): the mask brought to the picture's full size (bilinear, so edges are smooth), a
 *    feathered band of 1–2 px along its edge whose alpha follows the colour (an anti-aliased edge
 *    pixel half background is half transparent), the background's colour taken out of the band's
 *    pixels (decontamination), marks applied at full resolution, existing transparency kept.
 */

export interface RGBAImage { data: Uint8ClampedArray; width: number; height: number }

/** a brush stroke in the picture's own pixels (full resolution) */
export interface Stroke { points: [number, number][]; radius: number }

export interface BgOptions {
  /** 0–100: how far (ΔE) a colour may be from the background's and still go (default 30) */
  tolerance?: number;
  /** the soft edge's half width in pixels (default 1.5) */
  feather?: number;
  keep?: Stroke[];
  remove?: Stroke[];
}

export const DEFAULT_TOLERANCE = 30;
export const MAX_ANALYSIS = 1600;

/** the picture as analysed: scaled down, in Lab */
export interface BgAnalysis {
  width: number;
  height: number;
  /** analysis size / full size */
  scale: number;
  full: { width: number; height: number };
  /** the analysis image itself (for previews) */
  image: RGBAImage;
  L: Float32Array; A: Float32Array; B: Float32Array;
  /** opaque enough to have a colour */
  opaque: Uint8Array;
  /** the background colours found on the border (Lab) */
  border: [number, number, number][];
}

export interface BgResult { image: RGBAImage; /** the fill took everything: nothing was removed (no subject found) */ allBackground: boolean; removed: number }

/* ------------------------------------------------------------------ colour */

const LIN = new Float32Array(256);
for (let i = 0; i < 256; i++) { const c = i / 255; LIN[i] = c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4); }
const fLab = (t: number) => (t > 0.008856 ? Math.cbrt(t) : 7.787 * t + 16 / 116);

/** sRGB (0–255) → CIE Lab (D65) */
export function rgbToLab(r: number, g: number, b: number): [number, number, number] {
  const R = LIN[r & 255], G = LIN[g & 255], Bl = LIN[b & 255];
  const x = (R * 0.4124 + G * 0.3576 + Bl * 0.1805) / 0.95047;
  const y = R * 0.2126 + G * 0.7152 + Bl * 0.0722;
  const z = (R * 0.0193 + G * 0.1192 + Bl * 0.9505) / 1.08883;
  const fx = fLab(x), fy = fLab(y), fz = fLab(z);
  return [116 * fy - 16, 500 * (fx - fy), 200 * (fy - fz)];
}

const OPAQUE = 16;

/* ------------------------------------------------------------------ analysis */

/** the picture scaled to fit `max` px (box filter; alpha-weighted colours), or itself when it fits */
export function downscale(img: RGBAImage, max: number): RGBAImage {
  const { width: W, height: H, data } = img;
  const s = Math.min(1, max / Math.max(W, H));
  if (s >= 1) return img;
  const w = Math.max(1, Math.round(W * s)), h = Math.max(1, Math.round(H * s));
  const out = new Uint8ClampedArray(w * h * 4);
  const fx = W / w, fy = H / h;
  for (let y = 0; y < h; y++) {
    const y0 = Math.floor(y * fy), y1 = Math.max(y0 + 1, Math.floor((y + 1) * fy));
    for (let x = 0; x < w; x++) {
      const x0 = Math.floor(x * fx), x1 = Math.max(x0 + 1, Math.floor((x + 1) * fx));
      let r = 0, g = 0, b = 0, a = 0, n = 0;
      for (let yy = y0; yy < y1; yy++) for (let xx = x0; xx < x1; xx++) {
        const i = (yy * W + xx) * 4, al = data[i + 3];
        r += data[i] * al; g += data[i + 1] * al; b += data[i + 2] * al; a += al; n++;
      }
      const o = (y * w + x) * 4;
      if (a > 0) { out[o] = r / a; out[o + 1] = g / a; out[o + 2] = b / a; }
      out[o + 3] = a / n;
    }
  }
  return { data: out, width: w, height: h };
}

/** k-means on Lab points (deterministic: farthest-point start); [centroid, share] for each cluster */
export function kmeans(pts: Float32Array, n: number, kMax: number): { c: [number, number, number]; share: number }[] {
  if (!n) return [];
  const cs: [number, number, number][] = [];
  let mx = 0, my = 0, mz = 0;
  for (let i = 0; i < n; i++) { mx += pts[i * 3]; my += pts[i * 3 + 1]; mz += pts[i * 3 + 2]; }
  // start: the point nearest the mean, then each time the point farthest from the centroids so far
  let best = 0, bd = Infinity;
  for (let i = 0; i < n; i++) { const d = (pts[i * 3] - mx / n) ** 2 + (pts[i * 3 + 1] - my / n) ** 2 + (pts[i * 3 + 2] - mz / n) ** 2; if (d < bd) { bd = d; best = i; } }
  cs.push([pts[best * 3], pts[best * 3 + 1], pts[best * 3 + 2]]);
  while (cs.length < kMax) {
    let far = -1, fd = 4;   // a cluster only for points more than ΔE 2 away
    for (let i = 0; i < n; i++) {
      let m = Infinity;
      for (const c of cs) { const d = (pts[i * 3] - c[0]) ** 2 + (pts[i * 3 + 1] - c[1]) ** 2 + (pts[i * 3 + 2] - c[2]) ** 2; if (d < m) m = d; }
      if (m > fd) { fd = m; far = i; }
    }
    if (far < 0) break;
    cs.push([pts[far * 3], pts[far * 3 + 1], pts[far * 3 + 2]]);
  }
  const k = cs.length;
  const label = new Uint8Array(n);
  const count = new Float64Array(k);
  for (let it = 0; it < 12; it++) {
    const sum = new Float64Array(k * 3);
    count.fill(0);
    for (let i = 0; i < n; i++) {
      let m = Infinity, l = 0;
      for (let j = 0; j < k; j++) { const c = cs[j]; const d = (pts[i * 3] - c[0]) ** 2 + (pts[i * 3 + 1] - c[1]) ** 2 + (pts[i * 3 + 2] - c[2]) ** 2; if (d < m) { m = d; l = j; } }
      label[i] = l; count[l]++; sum[l * 3] += pts[i * 3]; sum[l * 3 + 1] += pts[i * 3 + 1]; sum[l * 3 + 2] += pts[i * 3 + 2];
    }
    for (let j = 0; j < k; j++) if (count[j]) cs[j] = [sum[j * 3] / count[j], sum[j * 3 + 1] / count[j], sum[j * 3 + 2] / count[j]];
  }
  return cs.map((c, j) => ({ c, share: count[j] / n })).filter(x => x.share > 0);
}

export function analyse(img: RGBAImage, max = MAX_ANALYSIS): BgAnalysis {
  const small = downscale(img, max);
  const { width: w, height: h, data } = small;
  const n = w * h;
  const L = new Float32Array(n), A = new Float32Array(n), B = new Float32Array(n), opaque = new Uint8Array(n);
  for (let i = 0; i < n; i++) {
    const [l, a, b] = rgbToLab(data[i * 4], data[i * 4 + 1], data[i * 4 + 2]);
    L[i] = l; A[i] = a; B[i] = b; opaque[i] = data[i * 4 + 3] >= OPAQUE ? 1 : 0;
  }
  // the border's opaque pixels (every one, or a regular sample of at most 8000)
  const idx: number[] = [];
  for (let x = 0; x < w; x++) { idx.push(x); if (h > 1) idx.push((h - 1) * w + x); }
  for (let y = 1; y < h - 1; y++) { idx.push(y * w); if (w > 1) idx.push(y * w + w - 1); }
  const op = idx.filter(i => opaque[i]);
  const step = Math.max(1, Math.floor(op.length / 8000));
  const pts = new Float32Array(Math.ceil(op.length / step) * 3);
  let m = 0;
  for (let j = 0; j < op.length; j += step) { const i = op[j]; pts[m * 3] = L[i]; pts[m * 3 + 1] = A[i]; pts[m * 3 + 2] = B[i]; m++; }
  const clusters = kmeans(pts, m, 3);
  let border = clusters.filter(c => c.share >= 0.15).map(c => c.c);
  if (!border.length && clusters.length) border = [clusters.reduce((a, b) => (b.share > a.share ? b : a)).c];
  return { width: w, height: h, scale: w / img.width, full: { width: img.width, height: img.height }, image: small, L, A, B, opaque, border };
}

/* ------------------------------------------------------------------ marks */

/** strokes rasterised onto a w×h grid; `s` = grid px per stroke px */
export function rasterStrokes(strokes: Stroke[] | undefined, w: number, h: number, s: number): Uint8Array | null {
  if (!strokes?.length) return null;
  const out = new Uint8Array(w * h);
  const disc = (cx: number, cy: number, r: number) => {
    const x0 = Math.max(0, Math.floor(cx - r)), x1 = Math.min(w - 1, Math.ceil(cx + r));
    const y0 = Math.max(0, Math.floor(cy - r)), y1 = Math.min(h - 1, Math.ceil(cy + r));
    for (let y = y0; y <= y1; y++) for (let x = x0; x <= x1; x++) if ((x + 0.5 - cx) ** 2 + (y + 0.5 - cy) ** 2 <= r * r) out[y * w + x] = 1;
  };
  for (const st of strokes) {
    const r = Math.max(0.75, st.radius * s);
    const p = st.points;
    for (let i = 0; i < p.length; i++) {
      const [x, y] = [p[i][0] * s, p[i][1] * s];
      disc(x, y, r);
      if (i > 0) {
        // fill between points so a fast stroke has no gaps
        const [px, py] = [p[i - 1][0] * s, p[i - 1][1] * s];
        const d = Math.hypot(x - px, y - py), k = Math.ceil(d / Math.max(0.5, r * 0.5));
        for (let j = 1; j < k; j++) disc(px + (x - px) * j / k, py + (y - py) * j / k, r);
      }
    }
  }
  return out;
}

/* ------------------------------------------------------------------ the mask */

/** the background colours: the border's, and those under the "remove" marks */
function backgroundColours(an: BgAnalysis, remove: Uint8Array | null): [number, number, number][] {
  const cols = [...an.border];
  if (remove) {
    const idx: number[] = [];
    for (let i = 0; i < remove.length; i++) if (remove[i] && an.opaque[i]) idx.push(i);
    const step = Math.max(1, Math.floor(idx.length / 4000));
    const pts = new Float32Array(Math.ceil(idx.length / step) * 3);
    let m = 0;
    for (let j = 0; j < idx.length; j += step) { const i = idx[j]; pts[m * 3] = an.L[i]; pts[m * 3 + 1] = an.A[i]; pts[m * 3 + 2] = an.B[i]; m++; }
    for (const c of kmeans(pts, m, 3)) if (c.share >= 0.1) cols.push(c.c);
  }
  return cols;
}

/** border pixels within this ΔE of a background colour shape the backdrop's surface */
const SURFACE_NEAR = 40;

/**
 * The backdrop as a smooth surface: each Lab channel a quadratic in x and y, least-squares fitted
 * to the border pixels that have a background colour — a gradient or a vignette is then close to
 * its own model everywhere, however far its middle is from the border's colours.
 */
function surface(an: BgAnalysis, cols: [number, number, number][]): Float64Array[] | null {
  const { width: w, height: h, L, A, B, opaque } = an;
  if (w < 4 || h < 4 || !cols.length) return null;
  const terms = (u: number, v: number) => [1, u, v, u * u, u * v, v * v];
  const M = new Float64Array(36), rhs = [new Float64Array(6), new Float64Array(6), new Float64Array(6)];
  let count = 0;
  const add = (i: number) => {
    if (!opaque[i]) return;
    let near = false;
    for (const c of cols) if ((L[i] - c[0]) ** 2 + (A[i] - c[1]) ** 2 + (B[i] - c[2]) ** 2 <= SURFACE_NEAR * SURFACE_NEAR) { near = true; break; }
    if (!near) return;
    const x = i % w, y = (i - x) / w;
    const t = terms(x / (w - 1) - 0.5, y / (h - 1) - 0.5);
    for (let a = 0; a < 6; a++) { for (let b = 0; b < 6; b++) M[a * 6 + b] += t[a] * t[b]; rhs[0][a] += t[a] * L[i]; rhs[1][a] += t[a] * A[i]; rhs[2][a] += t[a] * B[i]; }
    count++;
  };
  const step = Math.max(1, Math.floor((w + h) / 2000));
  for (let x = 0; x < w; x += step) { add(x); add((h - 1) * w + x); }
  for (let y = 0; y < h; y += step) { add(y * w); add(y * w + w - 1); }
  if (count < 24) return null;
  for (let a = 0; a < 6; a++) M[a * 6 + a] += 1e-6 * count;   // a little ridge: the border alone hardly fixes the curvature
  // Gaussian elimination, three right-hand sides
  const m = Array.from(M), r = rhs.map(x => Array.from(x));
  for (let c = 0; c < 6; c++) {
    let piv = c;
    for (let k = c + 1; k < 6; k++) if (Math.abs(m[k * 6 + c]) > Math.abs(m[piv * 6 + c])) piv = k;
    if (Math.abs(m[piv * 6 + c]) < 1e-12) return null;
    if (piv !== c) { for (let k = 0; k < 6; k++) [m[c * 6 + k], m[piv * 6 + k]] = [m[piv * 6 + k], m[c * 6 + k]]; for (const x of r) [x[c], x[piv]] = [x[piv], x[c]]; }
    for (let k = 0; k < 6; k++) {
      if (k === c) continue;
      const f = m[k * 6 + c] / m[c * 6 + c];
      if (!f) continue;
      for (let j = c; j < 6; j++) m[k * 6 + j] -= f * m[c * 6 + j];
      for (const x of r) x[k] -= f * x[c];
    }
  }
  return r.map(x => Float64Array.from(x.map((v, c) => v / m[c * 6 + c])));
}

/** for each analysis pixel: ΔE to the nearest background colour or to the backdrop's surface (Infinity without either) */
function distances(an: BgAnalysis, cols: [number, number, number][]): Float32Array {
  const { width: w, height: h } = an;
  const n = w * h;
  const d = new Float32Array(n).fill(Infinity);
  for (const c of cols) for (let i = 0; i < n; i++) {
    const e = Math.sqrt((an.L[i] - c[0]) ** 2 + (an.A[i] - c[1]) ** 2 + (an.B[i] - c[2]) ** 2);
    if (e < d[i]) d[i] = e;
  }
  const s = surface(an, cols);
  if (s) {
    const [cl, ca, cb] = s;
    for (let y = 0; y < h; y++) {
      const v = y / (h - 1) - 0.5;
      for (let x = 0; x < w; x++) {
        const u = x / (w - 1) - 0.5, i = y * w + x;
        const pl = cl[0] + cl[1] * u + cl[2] * v + cl[3] * u * u + cl[4] * u * v + cl[5] * v * v;
        const pa = ca[0] + ca[1] * u + ca[2] * v + ca[3] * u * u + ca[4] * u * v + ca[5] * v * v;
        const pb = cb[0] + cb[1] * u + cb[2] * v + cb[3] * u * u + cb[4] * u * v + cb[5] * v * v;
        const e = Math.sqrt((an.L[i] - pl) ** 2 + (an.A[i] - pa) ** 2 + (an.B[i] - pb) ** 2);
        if (e < d[i]) d[i] = e;
      }
    }
  }
  return d;
}

export interface MaskResult { mask: Uint8Array; cols: [number, number, number][]; dist: Float32Array }

/** the distances of the last call, for a new tolerance with the same "remove" marks (the slider) */
export interface MaskCache { key?: string; cols?: [number, number, number][]; dist?: Float32Array }

/** 1 = background (removed), at the analysis size */
export function backgroundMask(an: BgAnalysis, opts: BgOptions = {}, cache?: MaskCache): MaskResult {
  const tol = Math.max(0, Math.min(100, opts.tolerance ?? DEFAULT_TOLERANCE));
  const { width: w, height: h, L, A, B, opaque } = an;
  const n = w * h;
  const keep = rasterStrokes(opts.keep, w, h, an.scale);
  const remove = rasterStrokes(opts.remove, w, h, an.scale);
  const key = JSON.stringify(opts.remove ?? []);
  let cols: [number, number, number][], dist: Float32Array;
  if (cache && cache.key === key && cache.cols && cache.dist) ({ cols, dist } = cache as Required<MaskCache>);
  else {
    cols = backgroundColours(an, remove);
    dist = distances(an, cols);
    if (cache) Object.assign(cache, { key, cols, dist });
  }
  const mask = new Uint8Array(n);
  const queue = new Int32Array(n);
  let qh = 0, qt = 0;
  const local = Math.max(1.5, tol * 0.25), cap = tol * 1.25;
  const seed = (i: number) => { if (!mask[i] && !(keep && keep[i])) { mask[i] = 1; queue[qt++] = i; } };
  // seeds: the border close to a background colour, what is transparent already, the "remove" marks
  for (let x = 0; x < w; x++) for (const y of h > 1 ? [0, h - 1] : [0]) { const i = y * w + x; if (!opaque[i] || dist[i] <= tol) seed(i); }
  for (let y = 0; y < h; y++) for (const x of w > 1 ? [0, w - 1] : [0]) { const i = y * w + x; if (!opaque[i] || dist[i] <= tol) seed(i); }
  for (let i = 0; i < n; i++) if (!opaque[i] || (remove && remove[i])) seed(i);
  while (qh < qt) {
    const p = queue[qh++];
    const px = p % w;
    const nb = [px > 0 ? p - 1 : -1, px < w - 1 ? p + 1 : -1, p >= w ? p - w : -1, p < n - w ? p + w : -1];
    for (const q of nb) {
      if (q < 0 || mask[q] || (keep && keep[q])) continue;
      let ok = !opaque[q] || dist[q] <= tol;
      if (!ok && opaque[p] && dist[q] <= cap) ok = Math.sqrt((L[q] - L[p]) ** 2 + (A[q] - A[p]) ** 2 + (B[q] - B[p]) ** 2) <= local;
      if (ok) { mask[q] = 1; queue[qt++] = q; }
    }
  }
  return { mask, cols, dist };
}

/* ------------------------------------------------------------------ the result */

/** box blur of a 0–255 grid, radius r (separable running sums) */
function boxBlur(src: Uint8Array, w: number, h: number, r: number): Uint8Array {
  if (r < 1) return src;
  const tmp = new Uint8Array(w * h), out = new Uint8Array(w * h);
  const win = 2 * r + 1;
  for (let y = 0; y < h; y++) {
    const row = y * w;
    let s = 0;
    for (let x = -r; x <= r; x++) s += src[row + Math.min(w - 1, Math.max(0, x))];
    for (let x = 0; x < w; x++) {
      tmp[row + x] = Math.round(s / win);
      s += src[row + Math.min(w - 1, x + r + 1)] - src[row + Math.max(0, x - r)];
    }
  }
  for (let x = 0; x < w; x++) {
    let s = 0;
    for (let y = -r; y <= r; y++) s += tmp[Math.min(h - 1, Math.max(0, y)) * w + x];
    for (let y = 0; y < h; y++) {
      out[y * w + x] = Math.round(s / win);
      s += tmp[Math.min(h - 1, y + r + 1) * w + x] - tmp[Math.max(0, y - r) * w + x];
    }
  }
  return out;
}

/**
 * The picture with its background made transparent: `img` at any size (the full picture, or
 * an.image for a preview), the mask from backgroundMask at the analysis size.
 */
export function composite(img: RGBAImage, an: BgAnalysis, m: MaskResult, opts: BgOptions = {}): BgResult {
  const tol = Math.max(1, Math.min(100, opts.tolerance ?? DEFAULT_TOLERANCE));
  const { width: W, height: H, data } = img;
  const N = W * H;
  const out = new Uint8ClampedArray(data);
  // nothing left: no subject found — the picture stays as it is
  let removedSmall = 0, opaqueSmall = 0;
  for (let i = 0; i < m.mask.length; i++) if (an.opaque[i]) { opaqueSmall++; if (m.mask[i]) removedSmall++; }
  if (opaqueSmall === 0 || removedSmall === 0 || removedSmall >= opaqueSmall) return { image: { data: out, width: W, height: H }, allBackground: opaqueSmall > 0 && removedSmall >= opaqueSmall, removed: 0 };

  // the mask at this size: bilinear (0–255 = background share)
  const aw = an.width, ah = an.height;
  const sx = aw / W, sy = ah / H;
  const bg = new Uint8Array(N);
  for (let y = 0; y < H; y++) {
    const v = Math.min(ah - 1, Math.max(0, (y + 0.5) * sy - 0.5));
    const v0 = Math.floor(v), v1 = Math.min(ah - 1, v0 + 1), fv = v - v0;
    for (let x = 0; x < W; x++) {
      const u = Math.min(aw - 1, Math.max(0, (x + 0.5) * sx - 0.5));
      const u0 = Math.floor(u), u1 = Math.min(aw - 1, u0 + 1), fu = u - u0;
      const a = m.mask[v0 * aw + u0], b = m.mask[v0 * aw + u1], c = m.mask[v1 * aw + u0], d = m.mask[v1 * aw + u1];
      bg[y * W + x] = Math.round(255 * ((a * (1 - fu) + b * fu) * (1 - fv) + (c * (1 - fu) + d * fu) * fv));
    }
  }
  const r = Math.max(1, Math.round(opts.feather ?? 1.5));
  const soft = boxBlur(bg, W, H, r);
  const keep = rasterStrokes(opts.keep, W, H, 1);
  const remove = rasterStrokes(opts.remove, W, H, 1);
  const lo = tol * 0.35, span = Math.max(4, tol);
  let removed = 0;
  for (let i = 0; i < N; i++) {
    const a0 = data[i * 4 + 3];
    if (keep && keep[i]) continue;
    if (remove && remove[i]) { if (a0) removed++; out[i * 4 + 3] = 0; continue; }
    const sb = soft[i];
    if (sb === 0 && bg[i] === 0) continue;                 // the subject
    if (sb === 255 && bg[i] === 255) { if (a0) removed++; out[i * 4 + 3] = 0; continue; }   // the background
    // the band along the edge: alpha from the colour — between the sure background and the sure
    // subject nearby (an observed colour is α·subject + (1−α)·background), else a ramp on its
    // distance from the background, else the blurred mask
    const base = 1 - sb / 255;
    let alpha = base;
    const R = data[i * 4], G = data[i * 4 + 1], Bc = data[i * 4 + 2];
    const x = i % W, y = (i - x) / W;
    let br = 0, bgc = 0, bb = 0, nb = 0, fr = 0, fg = 0, fb = 0, nf = 0;
    for (let yy = Math.max(0, y - 2); yy <= Math.min(H - 1, y + 2); yy++) for (let xx = Math.max(0, x - 2); xx <= Math.min(W - 1, x + 2); xx++) {
      const j = yy * W + xx;
      if (j === i || data[j * 4 + 3] < OPAQUE) continue;
      if (bg[j] === 255) { br += data[j * 4]; bgc += data[j * 4 + 1]; bb += data[j * 4 + 2]; nb++; }
      else if (bg[j] === 0 && !(remove && remove[j])) { fr += data[j * 4]; fg += data[j * 4 + 1]; fb += data[j * 4 + 2]; nf++; }
    }
    if (nb) { br /= nb; bgc /= nb; bb /= nb; }
    if (nf) { fr /= nf; fg /= nf; fb /= nf; }
    if (a0 >= OPAQUE) {
      const span2 = (fr - br) ** 2 + (fg - bgc) ** 2 + (fb - bb) ** 2;
      if (nb && nf && span2 > 30 * 30) {
        alpha = ((R - br) * (fr - br) + (G - bgc) * (fg - bgc) + (Bc - bb) * (fb - bb)) / span2;
      } else {
        const lab = rgbToLab(R, G, Bc);
        let d = Infinity;
        if (nb) { const ref = rgbToLab(Math.round(br), Math.round(bgc), Math.round(bb)); d = Math.sqrt((lab[0] - ref[0]) ** 2 + (lab[1] - ref[1]) ** 2 + (lab[2] - ref[2]) ** 2); }
        else for (const c of m.cols) d = Math.min(d, Math.sqrt((lab[0] - c[0]) ** 2 + (lab[1] - c[1]) ** 2 + (lab[2] - c[2]) ** 2));
        if (Number.isFinite(d)) alpha = Math.max(base - 0.5, Math.min(base + 0.5, (d - lo) / span));
      }
    }
    alpha = Math.max(0, Math.min(1, alpha));
    if (alpha < 1 && alpha > 0 && nb) {
      // take the background's colour out: observed = α·subject + (1−α)·background
      const k = Math.max(alpha, 0.15);
      out[i * 4] = (R - (1 - k) * br) / k;
      out[i * 4 + 1] = (G - (1 - k) * bgc) / k;
      out[i * 4 + 2] = (Bc - (1 - k) * bb) / k;
    }
    if (alpha < 0.5 && a0) removed++;
    out[i * 4 + 3] = Math.round(alpha * a0);
  }
  return { image: { data: out, width: W, height: H }, allBackground: false, removed };
}

/** everything in one go (tests, the main-thread fallback) */
export function removeBackground(img: RGBAImage, opts: BgOptions = {}, max = MAX_ANALYSIS): BgResult {
  const an = analyse(img, max);
  return composite(img, an, backgroundMask(an, opts), opts);
}

/** the options for a copy of the picture at `s` times its size (the marks scaled with it) */
export function scaleOptions(opts: BgOptions, s: number): BgOptions {
  const sc = (st?: Stroke[]) => st?.map(x => ({ radius: x.radius * s, points: x.points.map(([a, b]) => [a * s, b * s] as [number, number]) }));
  return { ...opts, keep: sc(opts.keep), remove: sc(opts.remove) };
}
