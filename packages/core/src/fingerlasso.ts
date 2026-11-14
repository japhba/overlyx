/**
 * One finger resting on the screen + the Pencil = the lasso (the owner, 14 Nov 2026: "one-finger touch
 * + pencil to lasso select"). While a finger of the other hand rests on a slide, a board or a margin,
 * the pen draws a lasso instead of ink; lifting the finger gives the pen back. Shared by the slides'
 * runtime, the document margins and the boards.
 *
 * It must not fight what touches already do: the palm resting while the Pencil writes (broad contacts,
 * contacts that come down with or after the pen — those never count), two-finger pinch and the
 * three-finger undo (two fingers are no hold), a finger tap toggling the bars (the finger that held
 * for a lasso is no tap), a finger that moves (panning: no hold).
 */

/** how long the finger rests before the pen lands (a finger coming down with the pen is the hand's) */
export const FINGER_HOLD_MS = 120;
/** how far the resting finger may wander (screen px) and still be a hold, not a pan */
export const FINGER_HOLD_SLOP = 12;

/** a touch contact on the screen: where it came down and is now, when it came down */
export interface HoldContact { x0: number; y0: number; x: number; y: number; t0: number }

/** whether the pen landing at `t` draws a lasso: exactly one finger on the screen, resting there since well before */
export function fingerHoldsLasso(contacts: readonly HoldContact[], t: number): boolean {
  if (contacts.length !== 1) return false;
  const c = contacts[0];
  return t - c.t0 >= FINGER_HOLD_MS && Math.hypot(c.x - c.x0, c.y - c.y0) <= FINGER_HOLD_SLOP;
}

/**
 * The fingers on a surface, for the hold (docs and boards; the slides' runtime keeps its own list):
 * `down` / `move` / `up` with each touch pointer event, `penLands` when the pen comes down — true
 * when that pen stroke is a lasso — and `holding` while the finger that made it is still down.
 */
export class FingerHold {
  private contacts = new Map<number, HoldContact>();
  /** the finger the lasso came from (still down) */
  private held: number | null = null;
  down(id: number, x: number, y: number, t: number): void { this.contacts.set(id, { x0: x, y0: y, x, y, t0: t }); }
  move(id: number, x: number, y: number): void { const c = this.contacts.get(id); if (c) { c.x = x; c.y = y; } }
  up(id: number): void { this.contacts.delete(id); if (this.held === id) this.held = null; }
  /** the pen came down at `t`: whether it draws a lasso (a finger rests, or still rests from the last lasso) */
  penLands(t: number): boolean {
    if (this.held !== null && this.contacts.has(this.held)) return true;
    const list = [...this.contacts.entries()];
    if (!fingerHoldsLasso(list.map(([, c]) => c), t)) return false;
    this.held = list[0][0];
    return true;
  }
  /** whether the touch is the finger holding for the lasso (its moves pan nothing, its lift is no tap) */
  isHolding(id: number): boolean { return this.held === id; }
  get holding(): boolean { return this.held !== null; }
}
