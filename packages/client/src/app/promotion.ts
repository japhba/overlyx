/**
 * 120 Hz where the iPad has it. Safari shows pages at most 60 times a second on ProMotion iPads unless
 * "Prefer Page Rendering Updates near 60fps" is turned off in its feature flags — a setting of the
 * device that no page can change. So the line drawn trails the pen by a frame more than it need. When
 * the pen's strokes show that (the pen reporting ~120 moves a second while the page is shown 60 times,
 * or an iPad Pro's screen at 60), the person is told once how to turn it on (`ol.hz120Told`).
 */
import { uiAlert } from './Dialogs';
import { penRateMeter, appleTablet } from './penrate';

const TOLD = 'ol.hz120Told';
/** the last strokes' rates */
const seen: { moves: number; frames: number }[] = [];

/** the screens of the iPad Pro (CSS px, either way round: 12.9", 11", 10.5"), all 120 Hz — an iPad Air of one of these sizes is not, the advice says "if" */
const PRO_SCREENS = [[1024, 1366], [834, 1194], [834, 1112]];
const proSized = () => typeof screen !== 'undefined' && PRO_SCREENS.some(([a, b]) => Math.min(screen.width, screen.height) === a && Math.max(screen.width, screen.height) === b);

export const HZ120_STEPS = 'In Settings ▸ Safari ▸ Advanced ▸ Feature Flags (iPadOS 18 and later: Settings ▸ Apps ▸ Safari ▸ Advanced ▸ Feature Flags) turn off "Prefer Page Rendering Updates near 60fps", then close OverLyX and open it again.';

/** a stroke was drawn with the pen: its moves and the page's frames a second (penRateMeter) */
export function notePenStroke(r: { moves: number; frames: number } | null): void {
  if (!r || !appleTablet()) return;
  seen.push(r);
  if (seen.length > 5) seen.shift();
  if (seen.length < 3) return;
  // (to the nearest ten: "61 times a second" reads as more precise than it is)
  const med = (k: 'moves' | 'frames') => Math.round(seen.map(x => x[k]).sort((a, b) => a - b)[seen.length >> 1] / 10) * 10;
  const frames = med('frames'), moves = med('moves');
  if (frames > 75) return;   // (shown at 120 already)
  const sure = moves >= 100;
  if (!sure && !proSized()) return;
  try { if (localStorage.getItem(TOLD)) return; localStorage.setItem(TOLD, '1'); } catch { return; }
  void uiAlert('Smoother drawing at 120 Hz',
    (sure ? `Your pen reports about ${moves} positions a second, but Safari shows the page only about ${frames} times a second, so the line trails behind the pen.`
      : `Safari shows the page only about ${frames} times a second here. If this iPad has a 120 Hz screen (every iPad Pro has), the line can follow the pen twice as often.`)
    + ` Safari can draw at 120 Hz, but only you can switch it on — a web page can't. ${HZ120_STEPS} (The pen's calibration page shows the rate.)`);
}

let watching = false;
/** pen strokes on this page (whiteboards, the margins: the slides' frame measures its own and says so) */
export function watchPenStrokes(): void {
  if (watching || typeof window === 'undefined' || !appleTablet()) return;
  watching = true;
  let meter: ReturnType<typeof penRateMeter> | null = null, id = -1;
  window.addEventListener('pointerdown', (e: PointerEvent) => { if (e.pointerType === 'pen' && !meter) { meter = penRateMeter(e.timeStamp); id = e.pointerId; } }, { capture: true, passive: true });
  window.addEventListener('pointermove', (e: PointerEvent) => { if (meter && e.pointerId === id) meter.move(); }, { capture: true, passive: true });
  const end = (e: PointerEvent) => { if (!meter || e.pointerId !== id) return; const r = meter.end(e.timeStamp); meter = null; notePenStroke(r); };
  window.addEventListener('pointerup', end, { capture: true, passive: true });
  window.addEventListener('pointercancel', end, { capture: true, passive: true });
}
