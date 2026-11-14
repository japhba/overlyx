/**
 * One finger resting on the screen + the Pencil = the lasso (core/fingerlasso.ts; the slides' runtime,
 * document margins and boards use it). The finger must rest — since before the pen, still — and be
 * alone: a palm coming down with the pen, a moving (panning) finger, two fingers (a pinch) are no hold.
 */
import { describe, it, expect } from 'vitest';
import { FingerHold, fingerHoldsLasso, FINGER_HOLD_MS, FINGER_HOLD_SLOP } from '../packages/core/src/fingerlasso.ts';

describe('one finger held + the pen draws a lasso', () => {
  it('a finger resting since before the pen: lasso, stroke after stroke until it lifts', () => {
    const h = new FingerHold();
    h.down(7, 100, 500, 1000);
    h.move(7, 103, 502);                 // a resting finger trembles a little
    expect(h.penLands(1000 + FINGER_HOLD_MS + 50)).toBe(true);
    expect(h.isHolding(7)).toBe(true);
    expect(h.holding).toBe(true);
    // the finger may move now (its moves pan nothing); the next stroke is a lasso too
    h.move(7, 160, 540);
    expect(h.penLands(3000)).toBe(true);
    h.up(7);                             // lifted: the pen inks again
    expect(h.holding).toBe(false);
    expect(h.penLands(4000)).toBe(false);
  });

  it('a finger that comes down with the pen, or just before it, is the hand’s', () => {
    const h = new FingerHold();
    h.down(1, 0, 0, 1000);
    expect(h.penLands(1000 + FINGER_HOLD_MS - 30)).toBe(false);
  });

  it('a finger that moved (a pan) is no hold', () => {
    const h = new FingerHold();
    h.down(1, 0, 0, 0);
    h.move(1, FINGER_HOLD_SLOP + 5, 0);
    expect(h.penLands(1000)).toBe(false);
  });

  it('two fingers (a pinch) or three (undo) are no hold; with one lifted, the other one is', () => {
    const h = new FingerHold();
    h.down(1, 0, 0, 0);
    h.down(2, 300, 0, 10);
    expect(h.penLands(1000)).toBe(false);
    h.down(3, 600, 0, 20);
    expect(h.penLands(1000)).toBe(false);
    h.up(2); h.up(3);
    expect(h.penLands(1000)).toBe(true);
  });

  it('the rule on its own: exactly one contact, resting long enough', () => {
    expect(fingerHoldsLasso([], 1000)).toBe(false);
    expect(fingerHoldsLasso([{ x0: 0, y0: 0, x: 0, y: 0, t0: 0 }], FINGER_HOLD_MS)).toBe(true);
    expect(fingerHoldsLasso([{ x0: 0, y0: 0, x: 0, y: 0, t0: 0 }, { x0: 9, y0: 9, x: 9, y: 9, t0: 0 }], 1000)).toBe(false);
  });
});
