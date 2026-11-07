/**
 * Where the deck editor's toolbars go on a touch screen or a small one (the user, 22 Oct 2026: "for
 * mobile screens including tablets make the toolbars move to the sides of the screen where they fit
 * best given slide and display sizes"): a row along the top, as on a desktop, or a column at each
 * side — the tools at the left; what fits the selection, the zoom and Present at the right —,
 * whichever leaves the slide bigger. A phone held sideways shows a 16:9 slide as high as the screen
 * and has room beside it; a tablet upright has room above and below it; a 4:3 slide on a landscape
 * tablet is as high as the screen too.
 */
import { fitScale, fitGap, type Size } from './viewport';
import type { BarsPlace } from '../app/ActivityBar';

export type DeckDock = 'top' | 'sides';

/** a row of the toolbar (screen px), and a side column at its narrowest (a button and its padding) and widest (two buttons a row) */
export const DOCK_ROW = 48;
export const DOCK_COL_MIN = 48;
export const DOCK_COL_MAX = 92;

export interface DockInput {
  /** the room the editor has for the toolbars and the canvas (screen px) */
  area: Size;
  /** the slide (its own px; only its shape matters) */
  slide: Size;
  /** how long the tools' row is, and the rest of the toolbar's (the view's, Present, the status) */
  tools: number;
  rest: number;
  /** where they are now (a little in its favour: no flipping as the window changes by a hair) */
  current: DeckDock;
  /** the canvas round a fitted slide (screen px; none on a touch screen: edge to edge) */
  gap?: number;
}

/**
 * The dock that shows the slide bigger, and the side columns' width: as wide as the room the slide
 * leaves beside it (more of the tools in view, two to a row), at least a button's.
 */
export function chooseDock(i: DockInput): { dock: DeckDock; col: number; fit: number } {
  const { area, slide } = i;
  if (!(area.w > 0 && area.h > 0 && slide.w > 0 && slide.h > 0)) return { dock: i.current, col: DOCK_COL_MIN, fit: 0 };
  // the top: one row, or two when the tools and the rest do not fit side by side (the tools scroll sideways)
  const rows = i.tools + i.rest <= area.w ? 1 : 2;
  const gap = i.gap ?? fitGap(area);
  const top = fitScale({ w: area.w, h: area.h - rows * DOCK_ROW }, slide, gap);
  // the room beside the slide fitted to the whole height
  const shown = (area.h - 2 * gap) * slide.w / slide.h;
  const col = Math.round(Math.min(DOCK_COL_MAX, Math.max(DOCK_COL_MIN, (area.w - shown) / 2)));
  const sides = fitScale({ w: area.w - 2 * col, h: area.h }, slide, gap);
  const k = i.current === 'sides' ? 0.98 : 1.02;
  return sides > top * k ? { dock: 'sides', col, fit: sides } : { dock: 'top', col, fit: top };
}

/**
 * A screen of about 13 inches or less (the user, 7 Nov 2026: "small ish screens (say below 13 inch)"),
 * by the CSS px across its diagonal — a screen's inches are not to be had in a page: a 13-inch MacBook
 * Air (1470 × 956) or iPad Pro (1376 × 1032) is under it, a 14-inch MacBook Pro (1512 × 982) past it.
 */
export const SMALL_DISPLAY = 1780;
export function smallDisplay(): boolean {
  try { const d = Math.hypot(screen.width, screen.height); return d > 0 && d < SMALL_DISPLAY; } catch { return false; }
}

/** how much bigger the slide must get for the bars to float over it — and, floating, how little keeps them so */
export const FLOAT_GAIN = 1.02, FLOAT_STAY = 1.005;

export interface BarsInput {
  /** the slide's room with none of the bars: the canvas and what they take of it (screen px) */
  room: Size;
  /** the app's menu bar's height, its status bar's, and the width of the panels' bar (ActivityBar.tsx) */
  menu: number;
  status: number;
  activity: number;
  /** the slide's scale in `area` with the editor's own toolbar in it (a row along the top, or columns at the sides) */
  docked: (area: Size) => number;
  /** the slide's scale in the whole room */
  whole: number;
  /** a small screen (smallDisplay): the bars may float over the slide */
  small: boolean;
  /** the user keeps them where they are (the toolbar's lock) */
  locked: boolean;
  /** as they are now (a little in its favour: no flipping as the window changes by a hair) */
  current: { place: BarsPlace; wanted: boolean };
}

/**
 * Where the bars go round a slide (the user, 7 Nov 2026: "id like to have the slide go edge to edge on
 * any screen. perhaps we can move it to the bottom only when beneficial, and have a hover-over when
 * there is no way to fit the bars at all … but only if that helps maximize slide real estate on small
 * ish screens"): the panels' bar at the left where it costs the slide nothing — the slide is as high as
 * the room and there is canvas beside it —, else its buttons in the status bar; and on a small screen,
 * where the bars make the slide smaller at all, all of them away, floating in over the slide when
 * asked for (`wanted`; `float` unless they are locked).
 */
export function chooseBars(i: BarsInput): { place: BarsPlace; wanted: boolean; float: boolean } {
  const h = i.room.h - i.menu - i.status;
  const left = i.docked({ w: i.room.w - i.activity, h }), bottom = i.docked({ w: i.room.w, h });
  const place: BarsPlace = left >= bottom * (i.current.place === 'left' ? 0.99 : 0.999) ? 'left' : 'bottom';
  const docked = place === 'left' ? left : bottom;
  const wanted = i.small && docked > 0 && i.whole > docked * (i.current.wanted ? FLOAT_STAY : FLOAT_GAIN);
  return { place, wanted, float: wanted && !i.locked };
}

/** a screen touched with fingers or a pen (a phone, a tablet, a touch laptop) */
export function touchScreen(): boolean {
  try { return matchMedia('(any-pointer: coarse)').matches || (navigator.maxTouchPoints ?? 0) > 0; } catch { return false; }
}

/** a phone-sized window, whatever points at it */
export function smallScreen(): boolean {
  return typeof innerWidth === 'number' && Math.min(innerWidth, innerHeight) < 600;
}

/** the dock chosen here, or the one asked for (`ol.deckDock`: top / sides — for trying it on a desktop; anything else: automatic) */
export function dockAsked(): DeckDock | null {
  try { const v = localStorage.getItem('ol.deckDock'); return v === 'top' || v === 'sides' ? v : null; } catch { return null; }
}
