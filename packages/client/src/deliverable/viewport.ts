/**
 * The canvas of a deck or a poster (DeliverableEditor): one slide (runtime solo.ts), fitted into the
 * canvas and centred. Zoomed in, it pans as far as its edges and a margin, no further; past that — and
 * whenever the whole slide fits — a scroll, a finger or a pinch still pulls it, against a resistance
 * that grows the further it goes, and once let go it springs back into place, as iOS and macOS scroll
 * views do (pull to refresh). While pulled past an edge the slide stretches a little towards the pull.
 *
 * The frame (the iframe showing the page) is moved by a CSS transform set here, outside Preact's
 * renders: a scroll or a spring moves it every frame without rendering the editor.
 */

export interface Size { w: number; h: number }
export interface Box { x: number; y: number; w: number; h: number }

/** Apple's rubber band: `over` px pulled past an edge show as this many px (never as many as `dim`) */
export function rubber(over: number, dim: number, c = 0.55): number {
  if (!over || dim <= 0) return 0;
  return Math.sign(over) * (1 - 1 / ((Math.abs(over) * c) / dim + 1)) * dim;
}

/** the offsets (screen px from the centred place) the slide pans to freely: none when it fits with its margins */
export function panRange(content: number, box: number, margin: number): [number, number] {
  const spare = content + 2 * margin - box;
  return spare <= 0 ? [0, 0] : [-spare / 2, spare / 2];
}

/** where a pulled offset shows: itself inside the range, on the rubber band past it */
export function banded(raw: number, [lo, hi]: [number, number], dim: number): number {
  if (raw < lo) return lo + rubber(raw - lo, dim);
  if (raw > hi) return hi + rubber(raw - hi, dim);
  return raw;
}

export const clampTo = (v: number, [lo, hi]: [number, number]): number => Math.min(hi, Math.max(lo, v));

/** a damped spring let go `x0` from its rest, after `t` s: a slight overshoot, settled in about 0.45 s */
export function spring(x0: number, t: number, w = 14, z = 0.72): number {
  const wd = w * Math.sqrt(1 - z * z);
  return x0 * Math.exp(-z * w * t) * (Math.cos(wd * t) + ((z * w) / wd) * Math.sin(wd * t));
}

/** how much the slide stretches when shown `over` px past an edge of a `dim` px canvas */
export const STRETCH = 0.22;

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

/**
 * The slide's place on the canvas: an offset from the centred place, kept unbounded while it is
 * pulled (`raw`) and shown on the rubber band past the pan range.
 */
export class SlideView {
  private raw = { x: 0, y: 0 };
  private shown = { x: 0, y: 0 };
  private anim = 0;
  private idle: ReturnType<typeof setTimeout> | null = null;
  /** a spring is bringing the slide back: a scroll's momentum pushing further out is ignored meanwhile */
  private settling = false;

  constructor(private frame: () => HTMLElement | null, private input: () => ViewInput | null) {}

  private reduced(): boolean {
    try { return matchMedia('(prefers-reduced-motion: reduce)').matches; } catch { return false; }
  }

  private ranges(v: ViewInput): { x: [number, number]; y: [number, number] } {
    return {
      x: panRange(v.rect.w * v.scale, v.box.w, v.margin),
      y: panRange(v.rect.h * v.scale, v.box.h, v.margin),
    };
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

  /** the transform for the offsets shown (with the stretch of a pull past an edge) */
  render(): void {
    const el = this.frame(), v = this.input();
    if (!el || !v) return;
    const r = this.ranges(v);
    if (!this.anim) {
      this.shown.x = banded(this.raw.x, r.x, v.box.w);
      this.shown.y = banded(this.raw.y, r.y, v.box.h);
    }
    const p = this.place()!;
    let { tx, ty } = p;
    let kx = 1, ky = 1;
    if (!this.reduced()) {
      const ox = this.shown.x - clampTo(this.shown.x, r.x), oy = this.shown.y - clampTo(this.shown.y, r.y);
      kx = 1 + (STRETCH * Math.abs(ox)) / Math.max(1, v.box.w);
      ky = 1 + (STRETCH * Math.abs(oy)) / Math.max(1, v.box.h);
      // about the slide's edge away from the pull: it stretches towards it
      const left = tx + v.rect.x * p.s, top = ty + v.rect.y * p.s;
      const ax = ox > 0 ? left : left + v.rect.w * p.s, ay = oy > 0 ? top : top + v.rect.h * p.s;
      tx = ax + (tx - ax) * kx;
      ty = ay + (ty - ay) * ky;
    }
    el.style.transform = `translate(${tx}px, ${ty}px) scale(${p.s * kx}, ${p.s * ky})`;
  }

  private stop(): void {
    if (this.anim) cancelAnimationFrame(this.anim);
    this.anim = 0;
    this.settling = false;
  }

  /** pulled by (screen px): a finger, a scroll; past the range on the rubber band */
  panBy(dx: number, dy: number): void {
    const v = this.input();
    if (!v) return;
    if (this.anim) {
      const r = this.ranges(v);
      // momentum still pushing outwards while the slide springs back: let it spring
      const out = (d: number, s: number, [lo, hi]: [number, number]) => (d > 0 && s >= hi) || (d < 0 && s <= lo);
      if (this.settling && (out(dx, this.shown.x, r.x) || !dx) && (out(dy, this.shown.y, r.y) || !dy)) return;
      // caught mid-spring: on from where it shows (within the range the shown offset is the pulled one)
      this.raw = { x: unband(this.shown.x, r.x, v.box.w), y: unband(this.shown.y, r.y, v.box.h) };
      this.stop();
    }
    this.raw.x += dx;
    this.raw.y += dy;
    this.render();
  }

  /** a scroll (wheel, trackpad): pulled, and let go once the scrolling stops */
  scroll(dx: number, dy: number): void {
    this.panBy(dx, dy);
    if (this.idle) clearTimeout(this.idle);
    this.idle = setTimeout(() => { this.idle = null; this.release(); }, 140);
  }

  /** zoomed from scale `s0` to `s1` about a canvas point: that point of the slide stays under it */
  zoomed(s0: number, s1: number, px: number, py: number): void {
    const v = this.input();
    if (!v || !s0) return;
    if (this.anim) this.stop();
    const cx = px - v.box.w / 2, cy = py - v.box.h / 2;
    this.raw.x = cx - (cx - this.shown.x) * (s1 / s0);
    this.raw.y = cy - (cy - this.shown.y) * (s1 / s0);
    this.shown = { ...this.raw };
    if (this.idle) clearTimeout(this.idle);
    this.idle = setTimeout(() => { this.idle = null; this.release(); }, 160);
  }

  /** let go: back into the pan range (the middle when the slide fits), on a spring */
  release(): void {
    const v = this.input();
    if (!v) return;
    const r = this.ranges(v);
    const target = { x: clampTo(this.raw.x, r.x), y: clampTo(this.raw.y, r.y) };
    // (pulled within the range, shown as pulled: nothing to bring back)
    const from = { x: banded(this.raw.x, r.x, v.box.w), y: banded(this.raw.y, r.y, v.box.h) };
    this.raw = target;
    this.animateFrom(from, target);
  }

  /** back to the middle (Fit, another slide): `animated` on the spring, else at once */
  recentre(animated: boolean): void {
    if (this.idle) { clearTimeout(this.idle); this.idle = null; }
    const from = { ...this.shown };
    this.stop();
    this.raw = { x: 0, y: 0 };
    if (animated) this.animateFrom(from, this.raw);
    else this.render();
  }

  /** the canvas or the slide changed size: still inside the pan range */
  refit(): void {
    const v = this.input();
    if (!v || this.anim || this.idle) { this.render(); return; }
    const r = this.ranges(v);
    this.raw = { x: clampTo(this.raw.x, r.x), y: clampTo(this.raw.y, r.y) };
    this.render();
  }

  private animateFrom(from: { x: number; y: number }, to: { x: number; y: number }): void {
    this.stop();
    const d0 = { x: from.x - to.x, y: from.y - to.y };
    if (this.reduced() || (Math.abs(d0.x) < 0.5 && Math.abs(d0.y) < 0.5)) { this.shown = { ...to }; this.render(); return; }
    const t0 = performance.now();
    this.settling = true;
    const step = (now: number) => {
      const t = (now - t0) / 1000;
      const x = spring(d0.x, t), y = spring(d0.y, t);
      this.shown = { x: to.x + x, y: to.y + y };
      if (t > 1.2 || (Math.abs(x) < 0.25 && Math.abs(y) < 0.25 && t > 0.15)) {
        this.anim = 0;
        this.settling = false;
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
    if (this.idle) clearTimeout(this.idle);
  }
}

/** the pulled offset a shown one stands for (the rubber band's inverse) */
export function unband(shown: number, [lo, hi]: [number, number], dim: number, c = 0.55): number {
  const inv = (o: number) => {
    const a = Math.min(Math.abs(o), dim * 0.999);
    return (Math.sign(o) * (dim * dim / (dim - a) - dim)) / c;
  };
  if (shown < lo) return lo + inv(shown - lo);
  if (shown > hi) return hi + inv(shown - hi);
  return shown;
}
