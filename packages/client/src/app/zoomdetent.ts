/**
 * Zoom levels a pinch stops at (the PDF viewer's fits — pdfzoom.ts —, a slide's Fit): near one it
 * snaps onto it, and it stays there until pinched well past it (`hold`). Meanwhile what is shown gives
 * a little (`GIVE` of the pull) and springs back when let go. A pinch let go near a level settles on it.
 * Pure: the views feed it the pinch's steps and show what it says.
 */

/** a level: its name, its zoom (any unit, the same as the pinch's), and how far (log of the factor) a pinch must go on past it to leave it */
export interface Detent<K extends string = string> { key: K; z: number; hold: number }

/** a pinch coming this near a level (log) snaps onto it; let go this near one, the zoom settles on it */
export const CATCH = Math.log(1.07);
/** the share of a pinch held at a level that shows: what is shown gives a little */
export const GIVE = 0.25;

/** what a pinch shows: a zoom, or a level's zoom stretched by `stretch` (the give); `caught`: it has just snapped onto it */
export interface Shown<K extends string = string> { zoom: K | number; stretch: number; caught?: K }

/**
 * One pinch: its steps (`by`, log of the factor) through the zoom, stopping at the levels. It begins at
 * zoom `z0`, held at the level `start` if it is one. `range`: the zoom it can reach.
 */
export class DetentPinch<K extends string = string> {
  /** the level it is held at, and how far it has pulled at it since (log) */
  held: K | null = null;
  strain = 0;
  /** the zoom shown (log), the give left out */
  at: number;
  /** the level it left, not caught again till the pinch has gone a little further away */
  private away: K | null = null;
  private lo: number;
  private hi: number;

  constructor(start: K | number, z0: number, range: [number, number]) {
    this.at = Math.log(z0);
    if (typeof start === 'string') this.held = start;
    this.lo = Math.log(range[0]);
    this.hi = Math.log(range[1]);
  }

  private clamp(l: number): number { return Math.max(this.lo, Math.min(this.hi, l)); }

  by(d: number, ds: Detent<K>[]): Shown<K> {
    if (this.held) {
      const lv = ds.find(x => x.key === this.held);
      if (!lv) { this.held = null; return this.by(d, ds); }
      this.strain += d;
      if (Math.abs(this.strain) < lv.hold) return { zoom: lv.key, stretch: Math.exp(GIVE * this.strain) };
      // pulled loose: on from where the give had taken it, so nothing jumps
      this.at = this.clamp(Math.log(lv.z) + Math.sign(this.strain) * (GIVE * lv.hold + Math.abs(this.strain) - lv.hold));
      this.away = this.held;
      this.held = null;
      this.strain = 0;
      return { zoom: Math.exp(this.at), stretch: 1 };
    }
    const from = this.at, to = this.clamp(from + d);
    // a level passed on the way, or close ahead: caught (the way past it pulls at it)
    let best: { key: K; l: number } | null = null;
    for (const x of ds) {
      if (x.key === this.away) continue;
      const lx = Math.log(x.z);
      const passed = from !== lx && (from - lx) * (to - lx) <= 0;
      const near = Math.abs(to - lx) < CATCH && Math.abs(to - lx) < Math.abs(from - lx);
      if ((passed || near) && (!best || Math.abs(lx - from) < Math.abs(best.l - from))) best = { key: x.key, l: lx };
    }
    if (best) {
      this.held = best.key;
      this.at = best.l;
      this.strain = (to - best.l) * Math.sign(to - from) > 0 ? to - best.l : 0;
      const shown = this.by(0, ds);
      return this.held ? { ...shown, caught: best.key } : shown;
    }
    const left = this.away && ds.find(x => x.key === this.away);
    if (this.away && (!left || Math.abs(to - Math.log(left.z)) > 2 * CATCH)) this.away = null;
    this.at = to;
    return { zoom: Math.exp(to), stretch: 1 };
  }

  /** let go: the level it settles on and the stretch it springs back from (to 1); null: it stays as it is */
  end(ds: Detent<K>[]): { zoom: K; from: number } | null {
    if (this.held) return { zoom: this.held, from: Math.exp(GIVE * this.strain) };
    let best: { key: K; d: number } | null = null;
    for (const x of ds) {
      const d = this.at - Math.log(x.z);
      if (Math.abs(d) < CATCH && (!best || Math.abs(d) < Math.abs(best.d))) best = { key: x.key, d };
    }
    return best && { zoom: best.key, from: Math.exp(best.d) };
  }
}

/**
 * A step in or out (a mouse wheel's notch, − / +) from `z` by `factor` that does not step over a
 * level: it stops at it (and a step ending just beside one lands on it).
 */
export function stepOnto<K extends string>(z: number, factor: number, ds: Detent<K>[]): { zoom: K | number; z: number } {
  const to = z * factor;
  let best: Detent<K> | null = null;
  for (const x of ds) {
    const beyond = factor > 1 ? x.z > z * 1.01 && x.z <= to * 1.05 : x.z < z / 1.01 && x.z >= to / 1.05;
    if (beyond && (!best || Math.abs(Math.log(x.z / z)) < Math.abs(Math.log(best.z / z)))) best = x;
  }
  return best ? { zoom: best.key, z: best.z } : { zoom: to, z: to };
}
