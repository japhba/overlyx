/**
 * The canvas of a deck or a poster (DeliverableEditor): one slide (runtime solo.ts), fitted into the
 * canvas and centred. Zoomed in, it pans as far as its edges and a margin, no further; past that — and
 * whenever the whole slide fits — a scroll, a finger or a pinch still pulls it, against a resistance
 * that grows the further it goes, and once let go it springs back into place, as iOS and macOS scroll
 * views do (pull to refresh). While pulled past an edge the slide stretches a little towards the pull
 * and a ring fills in the gap behind it: pulled `BREAK` px past the edge the ring pops and the slide
 * comes loose. Free, it goes wherever it is scrolled or dragged (some of it always on the canvas) and
 * stays where it is let go; an outline marks its place, and let go near that it snaps back into it
 * (as do Fit, the "Centre slide" button and another slide). Only a scroll begun at the edge sets the
 * slide free — one that reached the edge on its way (momentum) just bounces, as with Safari's swipe
 * between pages; a finger always can.
 *
 * The frame (the iframe showing the page) is moved by a CSS transform set here, outside Preact's
 * renders: a scroll or a spring moves it every frame without rendering the editor.
 */

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

/** the offsets (screen px from the centred place) the slide pans to freely: none when it fits with its margins */
export function panRange(content: number, box: number, margin: number): Range {
  const spare = content + 2 * margin - box;
  return spare <= 0 ? [0, 0] : [-spare / 2, spare / 2];
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
  /** the outline of the slide's place while it is free (`data-on`; `data-near`: let go now, it snaps back in) */
  dock?: () => HTMLElement | null;
  /** the slide came loose (true) or is back in its place (false) */
  onFree?: (free: boolean) => void;
}

/** (an attribute set only when it changes: every frame sets them) */
function setData(el: HTMLElement, key: string, value: string): void {
  if (el.dataset[key] !== value) el.dataset[key] = value;
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
  /** this pull may set the slide free: a finger's, or a scroll begun at the edge it pulls past */
  private armed = true;
  /** the ring shows how far the pull has come (not while a zoom or a snap back in springs) */
  private ringOn = false;
  /** coming loose: the slide catches up with the pull the band held back, on a quick spring */
  private pop: { x: number; y: number; t0: number } | null = null;
  private popAnim = 0;
  /** the ring's pop plays until then (performance.now()) */
  private popping = 0;

  constructor(private frame: () => HTMLElement | null, private input: () => ViewInput | null, private marks: ViewMarks = {}) {}

  isFree(): boolean { return this.free; }

  private reduced(): boolean {
    try { return matchMedia('(prefers-reduced-motion: reduce)').matches; } catch { return false; }
  }

  /** the pan range: the slide's place */
  private ranges(v: ViewInput): Ranges {
    return {
      x: panRange(v.rect.w * v.scale, v.box.w, v.margin),
      y: panRange(v.rect.h * v.scale, v.box.h, v.margin),
    };
  }

  /** where the slide goes freely now: its place, or loose, wherever some of it stays on the canvas */
  private active(v: ViewInput): Ranges {
    if (!this.free) return this.ranges(v);
    return {
      x: freeRange(v.rect.w * v.scale, v.box.w, v.margin),
      y: freeRange(v.rect.h * v.scale, v.box.h, v.margin),
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
    const s = v.scale;
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

  /** the transform for the offsets shown (with the stretch of a pull past an edge), and the ring and the outline */
  render(): void {
    const el = this.frame(), v = this.input();
    if (!el || !v) return;
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
    el.style.transform = `translate(${tx}px, ${ty}px) scale(${p.s * kx}, ${p.s * ky})`;
    this.drawMarks(v);
  }

  /** the ring behind a slide pulled past an edge, filled as far as the pull has come; the outline of a free slide's place */
  private drawMarks(v: ViewInput): void {
    const ring = this.marks.pull?.(), dock = this.marks.dock?.();
    if (!ring && !dock) return;
    const home = this.ranges(v);
    const w = v.rect.w * v.scale, h = v.rect.h * v.scale;
    const left = (v.box.w - w) / 2 + this.shown.x, top = (v.box.h - h) / 2 + this.shown.y;
    if (ring && performance.now() >= this.popping) {
      if (ring.classList.contains('pop')) ring.classList.remove('pop');
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
    if (dock) {
      setData(dock, 'on', this.free ? '1' : '');
      if (!this.free) { setData(dock, 'near', ''); return; }
      // the nearest place the slide would take back in it (the middle, or zoomed in, where it pans to)
      const hx = clampTo(this.shown.x, home.x), hy = clampTo(this.shown.y, home.y);
      dock.style.transform = `translate(${(v.box.w - w) / 2 + hx}px, ${(v.box.h - h) / 2 + hy}px)`;
      dock.style.width = `${w}px`;
      dock.style.height = `${h}px`;
      setData(dock, 'near', pastRanges(this.shown, home) <= snapDistance(v.box) ? '1' : '');
    }
  }

  private stop(): void {
    if (this.anim) cancelAnimationFrame(this.anim);
    this.anim = 0;
    this.settling = 0;
  }

  /** pulled by (screen px): past the range on the rubber band; `catchUp`: how much of the pull the band held back the slide catches up with if it comes loose */
  private pull(dx: number, dy: number, catchUp: number): void {
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
    const home = this.ranges(v);
    const before = pastRanges(this.raw, home);
    this.raw.x += dx;
    this.raw.y += dy;
    if (!this.free) {
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
    this.armed = true;
    this.pull(dx, dy, 1);
  }

  /** a scroll (wheel, trackpad): pulled, and let go once the scrolling stops */
  scroll(dx: number, dy: number): void {
    if (!this.idle) this.armed = this.atEdge(dx, dy);
    this.pull(dx, dy, 0.4);
    if (this.idle) clearTimeout(this.idle);
    this.idle = setTimeout(() => { this.idle = null; this.release(); }, 140);
  }

  /** zoomed from scale `s0` to `s1` about a canvas point: that point of the slide stays under it */
  zoomed(s0: number, s1: number, px: number, py: number): void {
    const v = this.input();
    if (!v || !s0) return;
    if (this.anim) this.stop();
    this.pop = null;
    this.ringOn = false;
    const cx = px - v.box.w / 2, cy = py - v.box.h / 2;
    this.raw.x = cx - (cx - this.shown.x) * (s1 / s0);
    this.raw.y = cy - (cy - this.shown.y) * (s1 / s0);
    this.shown = { ...this.raw };
    if (this.idle) clearTimeout(this.idle);
    this.idle = setTimeout(() => { this.idle = null; this.release(); }, 160);
  }

  /** let go: back into the pan range (the middle when the slide fits), on a spring — or, loose, where it is (snapped back in near its place) */
  release(): void {
    const v = this.input();
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
    if (this.popAnim) cancelAnimationFrame(this.popAnim);
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
