/**
 * The PDF viewer's zoom (PdfViewer.tsx): its two fits, the steps between them, and how a pinch stops
 * at a fit.
 *
 * Fit content zooms past the margins: every page is cropped to what is painted on it (found by drawing
 * it small, `inkBox`) and shown as big as the pane takes it, so the content is as near the pane's edges
 * as it goes and all of it shows. In a narrow pane it spans the pane's width, in a wide one its height.
 * The typical page (the median of the pages' fits) sets the zoom, so the text is one size on every
 * page. A page with wider content (a broad table) is shown smaller so that all of it shows; a page with
 * less content is not blown up.
 *
 * Both fits are levels of the zoom, in order with the steps (−, +, a mouse wheel's notches). A pinch
 * (a trackpad's, Ctrl + wheel) stops at them. Near one it snaps onto it, and it stays there until
 * pinched well past it, Fit content most of all. Meanwhile the pages give a little and spring back
 * when let go. A pinch let go near a fit settles on it.
 */

/** a rectangle of a page (pt from its top-left), or of a canvas (px) */
export interface Box { x: number; y: number; w: number; h: number }
export interface PageSize { width: number; height: number }
export type Fit = 'width' | 'content';
/** a fit, or a factor on 96 dpi */
export type Zoom = Fit | number;

/** the steps of −, + and a mouse wheel (factors on 96 dpi) */
export const ZOOMS = [0.5, 0.67, 0.8, 0.9, 1, 1.1, 1.25, 1.5, 1.75, 2, 2.5, 3];
/** the zoom range a pinch can reach */
export const MIN_ZOOM = 0.25, MAX_ZOOM = 8;
/** px per pt at zoom 1 */
export const PT = 96 / 72;
/** vertical gap below every page, padding above the first (px, styles.css .pdf-page-box and .pdf-pages) */
export const GAP = 12, PAD = 12;
/** Fit width: px of the pane's width the page leaves free */
export const WIDTH_SPARE = 28;
/** Fit content: the room kept around a page's content (pt), and the px the pages keep from the pane's sides */
export const CONTENT_PAD = 6, SIDE = 8;

/** what is painted on a page: the box (px) of the pixels of an RGBA image that are not (nearly) white; null when there are none */
export function inkBox(data: ArrayLike<number>, w: number, h: number, light = 235): Box | null {
  let x0 = w, x1 = -1, y0 = h, y1 = -1;
  for (let y = 0, i = 0; y < h; y++) {
    for (let x = 0; x < w; x++, i += 4) {
      if (data[i + 3] > 16 && (data[i] < light || data[i + 1] < light || data[i + 2] < light)) {
        if (x < x0) x0 = x;
        if (x > x1) x1 = x;
        if (y < y0) y0 = y;
        y1 = y;
      }
    }
  }
  return x1 < 0 ? null : { x: x0, y: y0, w: x1 + 1 - x0, h: y1 + 1 - y0 };
}

/** a page's content and some room around it, within the page */
export function cropOf(content: Box, page: PageSize, pad = CONTENT_PAD): Box {
  const x = Math.max(0, content.x - pad), y = Math.max(0, content.y - pad);
  return { x, y, w: Math.min(page.width, content.x + content.w + pad) - x, h: Math.min(page.height, content.y + content.h + pad) - y };
}

const median = (v: number[]): number => {
  const s = [...v].sort((a, b) => a - b);
  return s.length % 2 ? s[(s.length - 1) / 2] : (s[s.length / 2 - 1] + s[s.length / 2]) / 2;
};

/** where a page is shown: px per pt, and the part of it shown (pt) */
export interface Geo { scale: number; crop: Box }

/**
 * Fit content: per page its scale and crop, in a pane of `pane` px (inside its padding: as wide as it
 * is, `PAD` above and below). `boxes[i]`: what is painted on page i (pt), unknown till measured. A page
 * not measured yet takes the typical crop. `scale` is the typical page's (px per pt). It is null with
 * nothing measured; then every page is fitted whole.
 */
export function contentLayout(pages: PageSize[], boxes: (Box | null | undefined)[], pane: { width: number; height: number }): { geo: Geo[]; scale: number | null } {
  const aw = Math.max(40, pane.width - 2 * SIDE), ah = Math.max(40, pane.height - 2 * PAD);
  const fit = (b: Box) => Math.min(aw / b.w, ah / b.h);
  const crops = pages.map((p, i) => { const b = boxes[i]; return b ? cropOf(b, p) : null; });
  const known = crops.filter((c): c is Box => !!c);
  if (!known.length) return { geo: pages.map(p => { const crop = { x: 0, y: 0, w: p.width, h: p.height }; return { scale: fit(crop), crop }; }), scale: null };
  const typ = { x: median(known.map(c => c.x)), y: median(known.map(c => c.y)), w: median(known.map(c => c.w)), h: median(known.map(c => c.h)) };
  const full = pages.map((p, i) => {
    let c = crops[i];
    if (!c) {
      // not measured yet (or blank): the typical crop, within the page
      const w = Math.min(typ.w, p.width), h = Math.min(typ.h, p.height);
      c = { x: Math.min(Math.max(0, typ.x), p.width - w), y: Math.min(Math.max(0, typ.y), p.height - h), w, h };
    } else if (c.w < typ.w) {
      // less content than the typical page (a figure, a short last page): as wide as the others, about its middle
      const w = Math.min(typ.w, p.width);
      c = { ...c, x: Math.min(Math.max(0, c.x + c.w / 2 - w / 2), p.width - w), w };
    }
    return c;
  });
  const scale = median(known.map(fit));
  return { geo: full.map(crop => ({ scale: Math.min(scale, fit(crop)), crop })), scale };
}

/** the zoom each fit shows now (a factor on 96 dpi) */
export type Levels = Partial<Record<Fit, number>>;

/** the fits as levels, lowest first; of two that nearly coincide only Fit content */
export function fitLevels(l: Levels): { fit: Fit; z: number }[] {
  const out: { fit: Fit; z: number }[] = [];
  if (l.content) out.push({ fit: 'content', z: l.content });
  if (l.width && !(l.content && Math.abs(Math.log(l.width / l.content)) < CATCH)) out.push({ fit: 'width', z: l.width });
  return out.sort((a, b) => a.z - b.z);
}

/** the zoom a zoom shows (a fit: its level) */
export const zoomValue = (z: Zoom, l: Levels): number => (typeof z === 'number' ? z : l[z] ?? l.width ?? 1);

/** the next step in or out from `cur`: the steps and the fits in one order (no step right beside a fit) */
export function stepZoom(cur: number, dir: 1 | -1, l: Levels): Zoom {
  const fits = fitLevels(l);
  const all: { z: number; zoom: Zoom }[] = [
    ...ZOOMS.filter(z => fits.every(f => Math.abs(Math.log(z / f.z)) > Math.log(1.05))).map(z => ({ z, zoom: z })),
    ...fits.map(f => ({ z: f.z, zoom: f.fit })),
  ].sort((a, b) => a.z - b.z);
  const next = dir > 0 ? all.find(s => s.z > cur * 1.01) : [...all].reverse().find(s => s.z < cur / 1.01);
  return (next ?? (dir > 0 ? all[all.length - 1] : all[0])).zoom;
}

/** how far (log of the factor) a pinch must go on past a fit to leave it: Fit content holds on hardest */
export const HOLD: Record<Fit, number> = { width: Math.log(1.2), content: Math.log(1.45) };
/** a pinch coming this near a fit (log) snaps onto it; let go this near one, the zoom settles on it */
export const CATCH = Math.log(1.07);
/** the share of a pinch held at a fit that shows: the pages give a little */
export const GIVE = 0.25;

/** what a pinch shows: a zoom, and a fit's pages stretched by `stretch` (the give) */
export interface Shown { zoom: Zoom; stretch: number; caught?: Fit }

const clampLog = (l: number) => Math.max(Math.log(MIN_ZOOM), Math.min(Math.log(MAX_ZOOM), l));

/**
 * One pinch: its steps (`by`, log of the factor) through the zoom levels, stopping at the fits. It
 * begins at the zoom shown, held at it if that is a fit.
 */
export class Pinch {
  /** the fit it is held at, and how far it has pulled at it since (log) */
  held: Fit | null = null;
  strain = 0;
  /** the zoom shown (log), the give left out */
  at: number;
  /** the fit it left, not caught again till the pinch has gone a little further away */
  private away: Fit | null = null;

  constructor(start: Zoom, l: Levels) {
    this.at = Math.log(zoomValue(start, l));
    if (typeof start === 'string') this.held = start;
  }

  by(d: number, l: Levels): Shown {
    if (this.held) {
      const lv = l[this.held];
      if (lv === undefined) { this.held = null; return this.by(d, l); }
      this.strain += d;
      const hold = HOLD[this.held];
      if (Math.abs(this.strain) < hold) return { zoom: this.held, stretch: Math.exp(GIVE * this.strain) };
      // pulled loose: on from where the give had taken it, so nothing jumps
      this.at = clampLog(Math.log(lv) + Math.sign(this.strain) * (GIVE * hold + Math.abs(this.strain) - hold));
      this.away = this.held;
      this.held = null;
      this.strain = 0;
      return { zoom: Math.exp(this.at), stretch: 1 };
    }
    const from = this.at, to = clampLog(from + d);
    // a fit passed on the way, or close ahead: caught (the way past it pulls at it)
    let best: { fit: Fit; l: number } | null = null;
    for (const f of fitLevels(l)) {
      if (f.fit === this.away) continue;
      const lf = Math.log(f.z);
      const passed = from !== lf && (from - lf) * (to - lf) <= 0;
      const near = Math.abs(to - lf) < CATCH && Math.abs(to - lf) < Math.abs(from - lf);
      if ((passed || near) && (!best || Math.abs(lf - from) < Math.abs(best.l - from))) best = { fit: f.fit, l: lf };
    }
    if (best) {
      this.held = best.fit;
      this.at = best.l;
      this.strain = (to - best.l) * Math.sign(to - from) > 0 ? to - best.l : 0;
      const shown = this.by(0, l);
      return this.held ? { ...shown, caught: best.fit } : shown;
    }
    if (this.away && Math.abs(to - Math.log(l[this.away] ?? Math.exp(to))) > 2 * CATCH) this.away = null;
    this.at = to;
    return { zoom: Math.exp(to), stretch: 1 };
  }

  /** let go: the fit it settles on and the stretch it springs back from (to 1); null: it stays as it is */
  end(l: Levels): { zoom: Fit; from: number } | null {
    if (this.held) return { zoom: this.held, from: Math.exp(GIVE * this.strain) };
    let best: { fit: Fit; d: number } | null = null;
    for (const f of fitLevels(l)) {
      const d = this.at - Math.log(f.z);
      if (Math.abs(d) < CATCH && (!best || Math.abs(d) < Math.abs(best.d))) best = { fit: f.fit, d };
    }
    return best && { zoom: best.fit, from: Math.exp(best.d) };
  }
}
