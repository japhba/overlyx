/**
 * Fingers on the canvas of a deck or a poster, wherever they come down (on the slide: runtime/edit.ts;
 * beside it: DeliverableEditor.tsx). Two fingers that move together never stay exactly as far apart,
 * so a two-finger pan zoomed a little with every move: they pan until they have come ~12 % closer or
 * gone ~12 % further apart, and once their middle has gone `PAN_LOCK` px first, the gesture is a pan
 * and the scale holds, unless they then close or spread by a third. The zoom starts from the scale
 * of that moment, so nothing jumps.
 */

/** how much closer or further apart (log of the ratio) two fingers come before they zoom */
export const PINCH_START = 0.12;
/** screen px their middle goes before they have zoomed: a pan */
export const PAN_LOCK = 24;
/** how much closer or further apart a pan's fingers come before it zooms after all */
export const PAN_BREAK = 0.3;

export interface PinchLock { mode: 'wait' | 'pan' | 'zoom'; off: number }
export const pinchLock = (): PinchLock => ({ mode: 'wait', off: 0 });

/**
 * The zoom since two fingers came down `d0` apart, now `d` apart, their middle `travel` screen px
 * from where it was (1 while it is a pan, or not yet anything). Updates `lock`.
 */
export function pinchFactor(lock: PinchLock, d0: number, d: number, travel: number): number {
  const l = Math.log(Math.max(1, d) / Math.max(1, d0));
  if (lock.mode === 'wait') {
    if (Math.abs(l) > PINCH_START) { lock.mode = 'zoom'; lock.off = Math.sign(l) * PINCH_START; }
    else if (travel > PAN_LOCK) lock.mode = 'pan';
  }
  if (lock.mode === 'pan' && Math.abs(l) > PAN_BREAK) { lock.mode = 'zoom'; lock.off = Math.sign(l) * PAN_BREAK; }
  return lock.mode === 'zoom' ? Math.exp(l - lock.off) : 1;
}

/** three fingers let go, their middle (dx, dy) screen px from where it came down, `ms` later: a swipe left undoes, right redoes (iPadOS), a tap undoes (GoodNotes) */
export function triGesture(dx: number, dy: number, ms: number): 'undo' | 'redo' | null {
  if (Math.abs(dx) >= 60 && Math.abs(dx) > 1.5 * Math.abs(dy)) return dx > 0 ? 'redo' : 'undo';
  return ms < 500 && Math.hypot(dx, dy) < 30 ? 'undo' : null;
}
