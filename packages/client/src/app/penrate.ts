/**
 * How often the pen reports and how often the page is shown while it draws (a stroke's moves and
 * frames a second): Safari on a 120 Hz iPad (ProMotion: every iPad Pro) shows pages only 60 times a
 * second unless the person turns a feature flag off — a page cannot do it for them (promotion.ts tells
 * them how). Without dependencies: the slides' runtime measures with it too, inside its frame.
 */

/** the screen's frames counted while a stroke is drawn, and its moves; `end` gives both a second (null: too short to tell) */
export function penRateMeter(t0: number): { move(): void; end(t: number): { moves: number; frames: number } | null } {
  let moves = 0, frames = 0, on = true;
  const tick = () => { if (!on) return; frames++; requestAnimationFrame(tick); };
  requestAnimationFrame(tick);
  return {
    move() { moves++; },
    end(t) {
      on = false;
      const s = (t - t0) / 1000;
      // (a quarter of a second at least: a tap or a dot says nothing)
      return s >= 0.25 && moves >= 15 ? { moves: Math.round(moves / s), frames: Math.round(frames / s) } : null;
    },
  };
}

/** an iPad (which says it is a Mac) or an iPhone, in Safari's engine */
export const appleTablet = (): boolean => typeof navigator !== 'undefined' && navigator.maxTouchPoints > 1 && /iPad|iPhone|Macintosh/.test(navigator.userAgent) && !/Chrome|CriOS|Firefox|FxiOS/.test(navigator.userAgent);
