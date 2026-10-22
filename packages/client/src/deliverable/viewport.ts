/**
 * The canvas of a deck or a poster (DeliverableEditor): one slide (runtime solo.ts), fitted into the
 * canvas and centred. Zoomed in, it pans as far as its edges and a margin, no further; past that — and
 * whenever the whole slide fits — a scroll, a finger or a pinch still pulls it, against a resistance
 * that grows the further it goes, and once let go it springs back into place, as iOS and macOS scroll
 * views do (pull to refresh). While pulled past an edge the slide stretches a little towards the pull
 * and a ring fills in the gap behind it: pulled `BREAK` px past the edge the ring pops and the slide
 * comes loose. Free, it goes wherever it is scrolled or dragged (some of it always on the canvas) and
 * stays where it is let go; let go near its place it snaps back into it (as do Fit, the "Centre
 * slide" button and another slide). Only a scroll begun at the edge sets the
 * slide free — one that reached the edge on its way (momentum) just bounces, as with Safari's swipe
 * between pages; a finger always can.
 *
 * The frame (the iframe showing the page) is moved by a CSS transform set here, outside Preact's
 * renders: a scroll or a spring moves it every frame without rendering the editor. So is a zoom while
 * it lasts (a pinch, a trackpad's): the view holds the scale it shows (`live`) until the editor's
 * catches up with it.
 */

import { CATCH, type Detent } from '../app/zoomdetent';

export interface Size { w: number; h: number }
export interface Box { x: number; y: number; w: number; h: number }
type Range = [number, number];
interface Ranges { x: Range; y: Range }
interface Pt { x: number; y: number }

/** Apple's rubber band: `over` px pulled past an edge show as this many px (never as many as `dim`) */
export function rubber(over: number, dim: number, c = 0.55): number {
  if (!over || dim <= 0) return 0;
  return Math.sign(over) * (1 - 1 / ((Math.abs(over) * c) / dim + 1)) * dim;
}

/**
 * The offsets (screen px from the centred place) the slide pans to freely: none when it fits; zoomed
 * in, as far as its edges and a margin — the margin coming in as it grows past the canvas (fitted edge
 * to edge, the slide does not wobble by its margin).
 */
export function panRange(content: number, box: number, margin: number): Range {
  const over = content - box;
  if (over <= 0) return [0, 0];
  const spare = over + Math.min(2 * margin, over);
  return [-spare / 2, spare / 2];
}

/** the offsets a slide pulled loose goes to: a fifth of it (at least 48 px) stays on the canvas */
export function freeRange(content: number, box: number, margin: number): Range {
  const keep = Math.max(48, 0.2 * Math.min(content, box));
  const d = Math.max(0, (box + content) / 2 - keep);
  const [lo, hi] = panRange(content, box, margin);
  return [Math.min(lo, -d), Math.max(hi, d)];
}

/** where a pulled offset shows: itself inside the range, on the rubber band past it */
export function banded(raw: number, [lo, hi]: Range, dim: number): number {
  if (raw < lo) return lo + rubber(raw - lo, dim);
  if (raw > hi) return hi + rubber(raw - hi, dim);
  return raw;
}

export const clampTo = (v: number, [lo, hi]: Range): number => Math.min(hi, Math.max(lo, v));

/** how far a place lies outside the ranges (px, both ways together) */
export const pastRanges = (p: Pt, r: Ranges): number => Math.hypot(p.x - clampTo(p.x, r.x), p.y - clampTo(p.y, r.y));

/** a damped spring let go `x0` from its rest, after `t` s: a slight overshoot, settled in about 0.45 s */
export function spring(x0: number, t: number, w = 14, z = 0.72): number {
  const wd = w * Math.sqrt(1 - z * z);
  return x0 * Math.exp(-z * w * t) * (Math.cos(wd * t) + ((z * w) / wd) * Math.sin(wd * t));
}

/** how much the slide stretches when shown `over` px past an edge of a `dim` px canvas */
export const STRETCH = 0.22;

/** px pulled past an edge (scrolled or dragged — before the rubber band) that set the slide free: about 80 px shown */
export const BREAK = 160;

/** how far a scroll sideways goes (px) before it turns the page; a finger: this much of the canvas, or a flick */
export const PAGE_SCROLL = 90;
const PAGE_FINGER = 0.15;

/**
 * The zoom levels of a slide on the canvas, as the PDF viewer's fits (app/pdfzoom.ts): the whole slide
 * (`fit`), its width the canvas' (`width`), the inside of its layout's margins as big as the canvas
 * takes it (`margins` — the user, 22 Oct 2026: "a fit margins zoom … to the margins, which are
 * reasonably set by the layout template in use": decklayouts.ts deckMargins) and what is on it — its
 * margins left out — as big as the canvas takes it (`content`). A pinch stops at them and holds there
 * (app/zoomdetent.ts); a step (− / +, a mouse wheel's notch) does not pass them; the zoom menu lists them.
 */
export type ViewFit = 'fit' | 'width' | 'margins' | 'content';
export type ViewLevels = { fit: number } & Partial<Record<Exclude<ViewFit, 'fit'>, number>>;
export const VIEW_FIT_NAMES: Record<ViewFit, string> = { fit: 'Fit', width: 'Fit width', margins: 'Fit margins', content: 'Fit content' };
/** how far (log of the factor) a pinch goes on past a level before it lets go */
export const VIEW_HOLD: Record<ViewFit, number> = { fit: Math.log(1.35), width: Math.log(1.2), margins: Math.log(1.3), content: Math.log(1.45) };
/** the room (screen px) Fit content keeps between what is on the slide and the canvas' sides */
export const CONTENT_SIDE = 16;

/**
 * The canvas round a fitted slide (screen px each side): a strip of it shows on all four sides, so the
 * slide reads as a page with edges — fitted edge to edge, its sides were the canvas' own and it looked
 * like a whiteboard without end.
 */
export const fitGap = (box: Size): number => (box.w < 600 ? 8 : 12);

/** the scale (frame px → screen px) that shows the whole slide, the canvas' gap round it, at most 2 (Fit width keeps the gap at the sides too) */
export function fitScale(box: Size, slide: Size): number {
  const g = 2 * fitGap(box);
  return Math.max(0.05, Math.min(2, (box.w - g) / slide.w, (box.h - g) / slide.h));
}

/**
 * The levels' scales (frame px → screen px) for a `slide`-sized slide whose content is `content` (none:
 * nothing on it) and whose margins leave `margins` inside them, on a `box`-sized canvas, none past
 * `max`. Fit is the editor's (fitScale); Fit margins keeps the gap Fit keeps round the slide.
 */
export function viewLevels(box: Size, slide: Size, content: Size | null, max: number, margins: Size | null = null): ViewLevels {
  const fit = fitScale(box, slide);
  const cap = (z: number) => Math.max(0.05, Math.min(max, z));
  const out: ViewLevels = { fit, width: cap((box.w - 2 * fitGap(box)) / slide.w) };
  if (margins && margins.w >= 1 && margins.h >= 1) {
    const g = 2 * fitGap(box);
    out.margins = cap(Math.min((box.w - g) / margins.w, (box.h - g) / margins.h));
  }
  if (content && content.w >= 1 && content.h >= 1) {
    const w = Math.max(1, box.w - 2 * CONTENT_SIDE), h = Math.max(1, box.h - 2 * CONTENT_SIDE);
    out.content = cap(Math.min(w / content.w, h / content.h));
  }
  return out;
}

/** the levels a pinch stops at: one of any that come as near together as a pinch catches (the first named: Fit before Fit width before Fit margins before Fit content) */
export function viewDetents(l: ViewLevels): Detent<ViewFit>[] {
  const out: Detent<ViewFit>[] = [];
  for (const key of ['fit', 'width', 'margins', 'content'] as const) {
    const z = l[key];
    if (z === undefined || out.some(d => Math.abs(Math.log(z / d.z)) < CATCH)) continue;
    out.push({ key, z, hold: VIEW_HOLD[key] });
  }
  return out;
}

/** the level the scale `s` is at (a hair off counts), if any */
export function levelAt(l: ViewLevels, s: number): ViewFit | null {
  return viewDetents(l).find(d => Math.abs(s / d.z - 1) < 0.005)?.key ?? null;
}

/**
 * Where a level shows the slide: the point of the frame's page (CSS px) it puts at the canvas' middle —
 * the slide's middle (Fit), the inside of its margins in the middle (Fit margins), what is on it in the
 * middle (Fit content); across only for Fit width (the other way, null: where it is).
 */
export function levelAnchor(k: ViewFit, slide: Box, content: Box | null, margins: Box | null = null): { x: number; y: number | null } {
  const c = k === 'content' && content ? content : k === 'margins' && margins ? margins : slide;
  return { x: c.x + c.w / 2, y: k === 'width' ? null : c.y + c.h / 2 };
}

/** how near its place (screen px) a free slide let go snaps back into it */
export const snapDistance = (box: Size): number => Math.min(60, Math.max(28, 0.08 * Math.min(box.w, box.h)));

export interface ViewInput {
  /** the canvas */
  box: Size;
  /** the slide in the frame's page (CSS px) */
  rect: Box;
  /** frame px → screen px */
  scale: number;
  /** room kept around the slide when it pans (screen px) */
  margin: number;
}

/** what the view draws on the canvas besides the frame, and whom it tells that the slide came loose */
export interface ViewMarks {
  /** the ring in the gap behind a slide pulled past an edge (`--k` its fill, 0–1); it pops (class `pop`) as the slide comes loose */
  pull?: () => HTMLElement | null;
  /** the slide came loose (true) or is back in its place (false) */
  onFree?: (free: boolean) => void;
  /** there are slides to swipe between (a deck): a swipe sideways goes to the next (1) or the one before (-1) */
  pages?: () => boolean;
  onPage?: (dir: 1 | -1) => void;
  /** a zoom going on shows the slide at this scale (once a frame at most), ahead of the editor's */
  onLive?: (scale: number) => void;
}

/**
 * The slide's place on the canvas: an offset from the centred place, kept unbounded while it is
 * pulled (`raw`) and shown on the rubber band past the pan range — or, once pulled loose, past the
 * range a free slide goes to.
 */
export class SlideView {
  private raw = { x: 0, y: 0 };
  private shown = { x: 0, y: 0 };
  private anim = 0;
  private idle: ReturnType<typeof setTimeout> | null = null;
  /** a spring began bringing the slide back then (performance.now()): a scroll's momentum pushing further out right after is ignored */
  private settling = 0;
  /** pulled loose: it stays where it is let go */
  private free = false;
  /**
   * A scroll's or a finger's way so far (px), for a swipe sideways to turn the page (Safari's swipe
   * between pages): its `axis` once it is clear, whether it `pages` (sideways, the slide in place and
   * at that side's edge when it began — `x0`), and once it has (the rest of it, momentum, does nothing).
   */
  private swipe: { x: number; y: number; x0: number; t0: number; finger: boolean; axis: 'x' | 'y' | null; pages: boolean; paged: boolean } | null = null;
  /** this pull may set the slide free: a finger's, or a scroll begun at the edge it pulls past */
  private armed = true;
  /** the ring shows how far the pull has come (not while a zoom or a snap back in springs) */
  private ringOn = false;
  /** coming loose: the slide catches up with the pull the band held back, on a quick spring */
  private pop: { x: number; y: number; t0: number } | null = null;
  private popAnim = 0;
  /** the ring's pop plays until then (performance.now()) */
  private popping = 0;
  /** the scale shown while a zoom goes on (frame px → screen px), ahead of the editor's (`input().scale`) */
  private live: number | null = null;
  /** the live scale last passed on (`onLive`; null: none since the editor's caught up), and the frame that passes on the next */
  private told: number | null = null;
  private liveFrame = 0;
  /** it moves (a scroll, a finger, a zoom, a spring): a layer of its own until it rests */
  private moving = false;
  private stillTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(private frame: () => HTMLElement | null, private input: () => ViewInput | null, private marks: ViewMarks = {}) {}

  isFree(): boolean { return this.free; }

  /**
   * The slide moves: a compositor layer of its own while it does (will-change: moved without being
   * drawn again), given up ~200 ms after the last move — then drawn again, on whole device px. A layer
   * kept at rest stays as blurry as the scale it was first drawn at (Chrome freezes its raster scale,
   * WebKit keeps the iframe composited: soft slides on the iPad), and a fractional offset resamples it.
   */
  private motion(): void {
    const el = this.frame();
    if (!this.moving && el) el.style.willChange = 'transform';
    this.moving = true;
    if (this.stillTimer) clearTimeout(this.stillTimer);
    this.stillTimer = setTimeout(() => {
      this.stillTimer = null;
      this.moving = false;
      const f = this.frame();
      if (f) f.style.willChange = '';
      this.render();
    }, 200);
  }

  /** the scale shown: a zoom's as it goes on, else the editor's */
  private sc(v: ViewInput): number { return this.live ?? v.scale; }

  /** the scale shown now (frame px → screen px) */
  scaleNow(): number | null {
    const v = this.input();
    return v ? this.sc(v) : null;
  }

  private reduced(): boolean {
    try { return matchMedia('(prefers-reduced-motion: reduce)').matches; } catch { return false; }
  }

  /** the pan range: the slide's place */
  private ranges(v: ViewInput): Ranges {
    return {
      x: panRange(v.rect.w * this.sc(v), v.box.w, v.margin),
      y: panRange(v.rect.h * this.sc(v), v.box.h, v.margin),
    };
  }

  /** where the slide goes freely now: its place, or loose, wherever some of it stays on the canvas */
  private active(v: ViewInput): Ranges {
    if (!this.free) return this.ranges(v);
    return {
      x: freeRange(v.rect.w * this.sc(v), v.box.w, v.margin),
      y: freeRange(v.rect.h * this.sc(v), v.box.h, v.margin),
    };
  }

  /** how far the slide still is behind the pull it came loose from */
  private lag(): Pt {
    if (!this.pop) return { x: 0, y: 0 };
    const t = (performance.now() - this.pop.t0) / 1000;
    return { x: spring(this.pop.x, t, 26, 0.55), y: spring(this.pop.y, t, 26, 0.55) };
  }

  /** the frame's translation and scale as shown now (screen px from the canvas' corner) */
  place(): { tx: number; ty: number; s: number } | null {
    const v = this.input();
    if (!v) return null;
    const s = this.sc(v);
    return {
      tx: v.box.w / 2 - (v.rect.x + v.rect.w / 2) * s + this.shown.x,
      ty: v.box.h / 2 - (v.rect.y + v.rect.h / 2) * s + this.shown.y,
      s,
    };
  }

  /** a point of the frame's page (CSS px) on the canvas */
  toCanvas(fx: number, fy: number): { x: number; y: number } | null {
    const p = this.place();
    return p ? { x: p.tx + fx * p.s, y: p.ty + fy * p.s } : null;
  }

  /** a canvas point on the frame's page (CSS px) */
  toFrame(cx: number, cy: number): { x: number; y: number } | null {
    const p = this.place();
    return p && p.s ? { x: (cx - p.tx) / p.s, y: (cy - p.ty) / p.s } : null;
  }

  /** the transform for the offsets shown (with the stretch of a pull past an edge), and the ring */
  render(): void {
    const el = this.frame(), v = this.input();
    if (!el || !v) return;
    // the editor's scale caught up with the zoom shown
    if (this.live !== null && Math.abs(v.scale - this.live) < 1e-6 * Math.max(1, this.live)) this.live = null;
    // (and once it caught up, the editor's again: a pinch back to where it began changes nothing in the editor)
    if (this.live !== null ? this.live !== this.told : this.told !== null) this.tellLive();
    const r = this.active(v);
    const lag = this.lag();
    if (!this.anim) {
      this.shown.x = banded(this.raw.x, r.x, v.box.w) - lag.x;
      this.shown.y = banded(this.raw.y, r.y, v.box.h) - lag.y;
    }
    const p = this.place()!;
    let { tx, ty } = p;
    let kx = 1, ky = 1;
    if (!this.reduced()) {
      // past an edge, or catching up with the pull it came loose from: stretched towards the pull
      const ox = this.shown.x - clampTo(this.shown.x, r.x) + lag.x, oy = this.shown.y - clampTo(this.shown.y, r.y) + lag.y;
      kx = 1 + (STRETCH * Math.abs(ox)) / Math.max(1, v.box.w);
      ky = 1 + (STRETCH * Math.abs(oy)) / Math.max(1, v.box.h);
      // about the slide's edge away from the pull: it stretches towards it
      const left = tx + v.rect.x * p.s, top = ty + v.rect.y * p.s;
      const ax = ox > 0 ? left : left + v.rect.w * p.s, ay = oy > 0 ? top : top + v.rect.h * p.s;
      tx = ax + (tx - ax) * kx;
      ty = ay + (ty - ay) * ky;
    }
    // at rest, on whole device px (iPad blur)
    if (!this.moving) { const d = (typeof devicePixelRatio === 'number' && devicePixelRatio) || 1; tx = Math.round(tx * d) / d; ty = Math.round(ty * d) / d; }
    el.style.transform = `translate(${tx}px, ${ty}px) scale(${p.s * kx}, ${p.s * ky})`;
    this.drawRing(v);
  }

  /**
   * The scale a zoom shows, passed on as it goes (the page draws its handles and frames for it: at
   * the editor's scale they grew with a pinch and shrank back once the fingers lifted). One a frame.
   */
  private tellLive(): void {
    if (this.liveFrame || !this.marks.onLive) return;
    this.liveFrame = requestAnimationFrame(() => {
      this.liveFrame = 0;
      const s = this.live ?? this.input()?.scale ?? null;
      if (s !== null && s !== this.told) this.marks.onLive?.(s);
      this.told = this.live === null ? null : s;
    });
  }

  /** the ring behind a slide pulled past an edge, filled as far as the pull has come */
  private drawRing(v: ViewInput): void {
    const ring = this.marks.pull?.();
    if (!ring || performance.now() < this.popping) return;
    if (ring.classList.contains('pop')) ring.classList.remove('pop');
    const home = this.ranges(v);
    const w = v.rect.w * this.sc(v), h = v.rect.h * this.sc(v);
    const left = (v.box.w - w) / 2 + this.shown.x, top = (v.box.h - h) / 2 + this.shown.y;
    // the pull the shown place stands for (springing back too), past the range
    const ux = unband(this.shown.x, home.x, v.box.w) - clampTo(this.shown.x, home.x);
    const uy = unband(this.shown.y, home.y, v.box.h) - clampTo(this.shown.y, home.y);
    const k = this.ringOn && !this.free ? Math.min(1, Math.hypot(ux, uy) / BREAK) : 0;
    const opacity = Math.max(0, Math.min(1, (k - 0.08) / 0.25));
    ring.style.opacity = opacity.toFixed(3);
    if (opacity > 0) {
      // in the gap the pull opens behind the slide, at most 40 px from its edge
      let x: number, y: number;
      if (Math.abs(ux) >= Math.abs(uy)) {
        x = ux > 0 ? left - Math.min(40, left / 2) : left + w + Math.min(40, (v.box.w - left - w) / 2);
        y = top + h / 2;
      } else {
        x = left + w / 2;
        y = uy > 0 ? top - Math.min(40, top / 2) : top + h + Math.min(40, (v.box.h - top - h) / 2);
      }
      ring.style.transform = `translate(${clampTo(x, [22, v.box.w - 22])}px, ${clampTo(y, [22, v.box.h - 22])}px)`;
      ring.style.setProperty('--k', k.toFixed(3));
    }
  }

  private stop(): void {
    if (this.anim) cancelAnimationFrame(this.anim);
    this.anim = 0;
    this.settling = 0;
  }

  /** pulled by (screen px): past the range on the rubber band; `catchUp`: how much of the pull the band held back the slide catches up with if it comes loose */
  private pull(dx: number, dy: number, catchUp: number, paging = false): void {
    const v = this.input();
    if (!v) return;
    if (this.anim) {
      const r = this.active(v);
      // momentum still pushing outwards as the slide springs back: let it spring (later, a pull catches it)
      const out = (d: number, s: number, [lo, hi]: Range) => (d > 0 && s >= hi) || (d < 0 && s <= lo);
      if (performance.now() - this.settling < 50 && (out(dx, this.shown.x, r.x) || !dx) && (out(dy, this.shown.y, r.y) || !dy)) return;
      // caught mid-spring: on from where it shows (within the range the shown offset is the pulled one)
      this.raw = { x: unband(this.shown.x, r.x, v.box.w), y: unband(this.shown.y, r.y, v.box.h) };
      this.stop();
    }
    this.motion();
    const home = this.ranges(v);
    const before = pastRanges(this.raw, home);
    this.raw.x += dx;
    this.raw.y += dy;
    if (!this.free && !paging) {
      this.ringOn = true;
      // pulled further out, as far as it takes: loose
      const past = pastRanges(this.raw, home);
      if (this.armed && past >= BREAK && past > before) this.loosen(v, catchUp);
    }
    this.render();
  }

  /** the pull came far enough: the slide comes loose where it shows, then catches up with some of the pull */
  private loosen(v: ViewInput, catchUp: number): void {
    const home = this.ranges(v);
    this.free = true;
    this.ringOn = false;
    const fr = this.active(v);
    const at = { x: banded(this.raw.x, home.x, v.box.w), y: banded(this.raw.y, home.y, v.box.h) };
    const to = {
      x: clampTo(at.x + (this.raw.x - at.x) * catchUp, fr.x),
      y: clampTo(at.y + (this.raw.y - at.y) * catchUp, fr.y),
    };
    this.raw = to;
    if (!this.reduced()) {
      this.pop = { x: to.x - at.x, y: to.y - at.y, t0: performance.now() };
      const step = () => {
        this.popAnim = 0;
        if (!this.pop) return;
        this.motion();
        if (performance.now() - this.pop.t0 > 600) this.pop = null;
        this.render();
        if (this.pop) this.popAnim = requestAnimationFrame(step);
      };
      if (this.popAnim) cancelAnimationFrame(this.popAnim);
      this.popAnim = requestAnimationFrame(step);
    }
    const ring = this.marks.pull?.();
    if (ring) {
      this.popping = performance.now() + 420;
      ring.style.setProperty('--k', '1');
      ring.style.opacity = '1';
      ring.classList.remove('pop');
      void ring.offsetWidth;   // (the pop plays again)
      ring.classList.add('pop');
    }
    this.marks.onFree?.(true);
  }

  /** at (or past) the edge of its place that a scroll by (dx, dy) — along its main direction — pulls past */
  private atEdge(dx: number, dy: number): boolean {
    const v = this.input();
    if (!v) return false;
    const r = this.ranges(v);
    const edge = (d: number, p: number, [lo, hi]: Range) => (d > 0 && p >= hi - 0.5) || (d < 0 && p <= lo + 0.5);
    return Math.abs(dx) >= Math.abs(dy) ? edge(dx, this.raw.x, r.x) : edge(dy, this.raw.y, r.y);
  }

  /** pulled by a finger (screen px); past the range on the rubber band, and loose when pulled far enough */
  panBy(dx: number, dy: number): void {
    // A finger owns its release. An older zoom/wheel timer must not settle it
    // halfway through, discard its motion, or retain the wheel's swipe identity.
    if (this.idle) { clearTimeout(this.idle); this.idle = null; this.swipe = null; }
    if (!this.swipe) this.swipe = { x: 0, y: 0, x0: this.raw.x, t0: performance.now(), finger: true, axis: null, pages: false, paged: false };
    this.armed = true;
    if (this.steer(dx, dy)) return;
    this.pull(dx, dy, 1);
  }

  /**
   * A swipe sideways turns the page — the slide in its place (not loose), all of it across the canvas
   * or at that side's edge when the swipe began; it shows the pull on the rubber band, and never comes
   * loose that way (up and down it still does). Up and down, or zoomed in mid-slide, it pans as ever.
   * True: the swipe took the move.
   */
  private steer(dx: number, dy: number): boolean {
    const s = this.swipe, v = this.input();
    if (!s || !v) return false;
    s.x += dx; s.y += dy;
    if (!s.axis && Math.hypot(s.x, s.y) > 6) {
      s.axis = Math.abs(s.x) > 1.3 * Math.abs(s.y) ? 'x' : 'y';
      const [lo, hi] = this.ranges(v).x;
      // (a swipe left goes on — the next slide — from the right edge; right, back from the left one)
      const edge = s.x < 0 ? s.x0 <= lo + 0.5 : s.x0 >= hi - 0.5;
      s.pages = s.axis === 'x' && !this.free && !!this.marks.pages?.() && edge;
    }
    if (!s.pages) return false;
    if (s.paged) return true;
    this.pull(dx, 0, 0, true);
    if (!s.finger && Math.abs(s.x) >= PAGE_SCROLL) this.turn(s);
    return true;
  }

  private turn(s: NonNullable<SlideView['swipe']>): void {
    s.paged = true;
    this.marks.onPage?.(s.x < 0 ? 1 : -1);
  }

  /** another slide, by a swipe: in from the side it was swiped from (`dir` 1: the next, from the right) */
  enter(dir: 1 | -1): void {
    const v = this.input();
    this.recentre(false);
    if (!v || this.reduced()) return;
    const from = { x: dir * Math.min(240, v.box.w * 0.3), y: 0 };
    this.animateFrom(from, { x: 0, y: 0 });
    // (at the side from its first frame, not in the middle till the spring's first step)
    this.shown = from;
    this.render();
  }

  /** a scroll (wheel, trackpad): pulled, and let go once the scrolling stops */
  scroll(dx: number, dy: number): void {
    if (!this.idle) {
      this.armed = this.atEdge(dx, dy);
      this.swipe = { x: 0, y: 0, x0: this.raw.x, t0: performance.now(), finger: false, axis: null, pages: false, paged: false };
    }
    if (!this.steer(dx, dy)) this.pull(dx, dy, 0.4);
    if (this.idle) clearTimeout(this.idle);
    this.idle = setTimeout(() => { this.idle = null; this.release(); }, 140);
  }

  /**
   * Zoomed to scale `s` about a canvas point (that point of the slide stays under it), shown at once:
   * the editor takes the scale over when it can (a wheel, a trackpad: many steps a second).
   */
  zoomTo(s: number, px: number, py: number): void {
    const v = this.input();
    if (!v) return;
    this.zoomed(this.sc(v), s, px, py);
    this.live = s;
    this.render();
  }

  /**
   * A pinch: scale `s`, the frame's point (ax, ay) — what was under the fingers' middle when they
   * came down — under the canvas point (cx, cy) where their middle is now. Absolute (from where the
   * pinch began), so no step takes back the one before. Let go: `release`.
   */
  placeAt(s: number, ax: number, ay: number, cx: number, cy: number): void {
    const v = this.input();
    if (!v) return;
    if (this.anim) this.stop();
    if (this.idle) { clearTimeout(this.idle); this.idle = null; }
    // (two fingers: the swipe a finger began is no swipe)
    this.swipe = null;
    this.motion();
    this.pop = null;
    this.ringOn = false;
    this.live = s;
    this.raw = { x: cx - ax * s - v.box.w / 2 + (v.rect.x + v.rect.w / 2) * s, y: cy - ay * s - v.box.h / 2 + (v.rect.y + v.rect.h / 2) * s };
    this.shown = { ...this.raw };
    this.render();
  }

  /** zoomed from scale `s0` to `s1` about a canvas point: that point of the slide stays under it */
  zoomed(s0: number, s1: number, px: number, py: number): void {
    const v = this.input();
    if (!v || !s0) return;
    if (this.anim) this.stop();
    this.motion();
    this.pop = null;
    this.ringOn = false;
    const cx = px - v.box.w / 2, cy = py - v.box.h / 2;
    this.raw.x = cx - (cx - this.shown.x) * (s1 / s0);
    this.raw.y = cy - (cy - this.shown.y) * (s1 / s0);
    this.shown = { ...this.raw };
    if (this.idle) clearTimeout(this.idle);
    this.idle = setTimeout(() => { this.idle = null; this.release(); }, 160);
  }

  /** let go: settle in the pan range; an interrupted gesture must not become a page-turning flick */
  release(cancelled = false): void {
    const v = this.input();
    const s = this.swipe;
    this.swipe = null;
    if (!cancelled && v && s?.finger && s.pages && !s.paged) {
      const fast = performance.now() - s.t0 < 250 && Math.abs(s.x) > 30;
      if (fast || Math.abs(s.x) >= PAGE_FINGER * v.box.w) this.turn(s);
    }
    if (!v) return;
    const r = this.active(v);
    // (pulled within the range, shown as pulled: nothing to bring back)
    const from = { x: banded(this.raw.x, r.x, v.box.w), y: banded(this.raw.y, r.y, v.box.h) };
    if (this.free) {
      const home = this.ranges(v);
      if (pastRanges(from, home) <= snapDistance(v.box)) {
        const shown = { ...this.shown };
        this.free = false;
        this.pop = null;
        this.raw = { x: clampTo(from.x, home.x), y: clampTo(from.y, home.y) };
        this.marks.onFree?.(false);
        this.animateFrom(shown, this.raw);
        return;
      }
      if (this.pop) return;   // (it is catching up; inside the range it stays)
    }
    const target = { x: clampTo(this.raw.x, r.x), y: clampTo(this.raw.y, r.y) };
    this.raw = target;
    this.animateFrom(from, target);
  }

  /** back to the middle (Fit, another slide): `animated` on the spring, else at once */
  recentre(animated: boolean): void {
    if (this.idle) { clearTimeout(this.idle); this.idle = null; }
    const from = { ...this.shown };
    this.stop();
    this.pop = null;
    this.ringOn = false;
    this.raw = { x: 0, y: 0 };
    this.live = null;
    if (this.free) { this.free = false; this.marks.onFree?.(false); }
    if (animated) this.animateFrom(from, this.raw);
    else this.render();
  }

  /** the canvas or the slide changed size: still inside the pan range (loose: still partly on the canvas) */
  refit(): void {
    const v = this.input();
    if (!v || this.anim || this.idle || this.pop) { this.render(); return; }
    const r = this.active(v);
    this.raw = { x: clampTo(this.raw.x, r.x), y: clampTo(this.raw.y, r.y) };
    this.render();
  }

  private animateFrom(from: Pt, to: Pt): void {
    this.stop();
    const d0 = { x: from.x - to.x, y: from.y - to.y };
    if (this.reduced() || (Math.abs(d0.x) < 0.5 && Math.abs(d0.y) < 0.5)) { this.shown = { ...to }; this.ringOn = false; this.render(); return; }
    const t0 = performance.now();
    this.settling = t0;
    const step = (now: number) => {
      this.motion();
      const t = (now - t0) / 1000;
      const x = spring(d0.x, t), y = spring(d0.y, t);
      this.shown = { x: to.x + x, y: to.y + y };
      if (t > 1.2 || (Math.abs(x) < 0.25 && Math.abs(y) < 0.25 && t > 0.15)) {
        this.anim = 0;
        this.settling = 0;
        this.ringOn = false;
        this.shown = { ...to };
        this.render();
        return;
      }
      this.anim = requestAnimationFrame(step);
      this.render();
    };
    this.anim = requestAnimationFrame(step);
  }

  destroy(): void {
    this.stop();
    if (this.stillTimer) clearTimeout(this.stillTimer);
    if (this.popAnim) cancelAnimationFrame(this.popAnim);
    if (this.liveFrame) cancelAnimationFrame(this.liveFrame);
    if (this.idle) clearTimeout(this.idle);
  }
}

/** the pulled offset a shown one stands for (the rubber band's inverse) */
export function unband(shown: number, [lo, hi]: Range, dim: number, c = 0.55): number {
  const inv = (o: number) => {
    const a = Math.min(Math.abs(o), dim * 0.999);
    return (Math.sign(o) * (dim * dim / (dim - a) - dim)) / c;
  };
  if (shown < lo) return lo + inv(shown - lo);
  if (shown > hi) return hi + inv(shown - hi);
  return shown;
}
