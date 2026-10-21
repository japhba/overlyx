/**
 * Presenting tools shared by the two presenters — HTML decks (deliverable/runtime/present.ts, in the
 * sandboxed frame) and layout / beamer documents (editor/layout/present.ts):
 *
 * - the laser pointer, with the whiteboard's look (a wide soft glow under a bright core, a dot with a
 *   white centre at the head; app/BoardEditor.tsx): moved, it leaves a short tail that fades; pressed
 *   and dragged (or drawn with a finger or pen), its trace stays while held and fades once lifted.
 *   While it is on, clicks don't advance (the keys still do);
 * - pinch to zoom and pan: a trackpad pinch (Ctrl + wheel, as Chromium and Firefox report it; Safari's
 *   gesture events), two fingers on a touch screen (once they spread or close by an eighth: two
 *   fingers moving together, or a resting hand, do not zoom), `+` / `-`; zoomed, a drag or a two-finger scroll
 *   pans, a click does not advance, `0`, a double click / tap or Escape go back to the whole slide;
 * - drawing on the slides (Keynote's and PowerPoint's presenting ink): a pen, a highlighter, an
 *   eraser (Ctrl+P, Ctrl+I, Ctrl+E; Ctrl+A or Escape put the tool away; E clears the slide), in a few
 *   colours. The drawings belong to their slide (kept while presenting, never saved) and zoom with
 *   it. The Apple Pencil (a pen) draws — with the pen when no tool is in hand, as in PowerPoint and
 *   GoodNotes — and fingers swipe, tap and pinch; they draw too only with the bar's "Fingers draw"
 *   on (kept in this browser). The hand resting on the glass while the Pencil writes is ignored;
 * - a small control bar (bottom left: ◀, n / N, ▶, the drawing tools, laser, back to the whole
 *   slide, end). The audience sees the screen (AirPlay mirroring, a shared screen), so it stays out
 *   of sight until asked for: a tap on a touch screen (a tap no longer goes on — a swipe does) or the
 *   mouse near the bottom edge brings it, and it fades out again a few seconds later, or as soon as
 *   a stroke begins;
 * - the screen kept on while presenting (app/wakelock.ts), where the presenter is the top-level page
 *   (a sandboxed frame may not: the editor presenting it asks for it);
 * - several screens presenting the same document at once (an iPad and a Mac): the drawings, the laser
 *   and, while the bar's "Linked" is on, the slide shown go from each to the others, live, through the
 *   document's awareness (app/presentshare.ts; the presenter hands the states over: `share`, `setPeers`).
 *
 * DOM only — no framework — so the runtime bundle stays small. Everything is drawn in screen space
 * (CSS px of the window, not scaled with the slide) inside a shadow root, out of the page's styles.
 * The zoom itself is the presenter's to draw (`apply`): screen point q → s·q + (x, y) on top of the
 * slide's fit.
 */
import { laserPathD } from '@overlyx/core/ink.ts';
import { keepAwake } from './wakelock';
import { strokeWatch, strokeEnded } from '../glitches';
import type { StrokeWatch } from '@overlyx/core/glitch.ts';
import { pinchFactor, pinchLock, type PinchLock } from '../deliverable/gestures';
import { PresentShare, slideKey, encodeStroke, encodePts, simplifyPts, TRAIL_PTS, HELD_PTS, type PresentState, type PresenterState, type Follow, type Pt } from './presentshare';

/** the whiteboard's laser colour and fade time (editor/plugins/ink.ts LASER_COLOR / LASER_FADE_MS — a test checks they agree) */
export const LASER_COLOR = '#ff2d55';
export const LASER_FADE_MS = 700;
/** how long the tail behind a moving (not pressed) laser dot lasts */
export const LASER_TAIL_MS = 500;
export const ZOOM_MIN = 1;
export const ZOOM_MAX = 8;
/** the control bar and the cursor hide after this long without the pointer moving */
export const IDLE_MS = 2500;
/** a bar brought by a tap stays a little longer (a finger needs the time to reach it) */
export const TAP_IDLE_MS = 4000;
/** the mouse brings the bar within this far of the window's bottom edge (CSS px) */
export const BAR_ZONE = 120;
/** the drawings' coordinates: slide units, the slide's width being this many (its height in proportion) */
export const SLIDE_UNITS = 1000;
/** the pen's and the highlighter's widths as drawn (screen px at the zoom they are drawn at) */
export const PEN_PX = 3;
export const MARKER_PX = 18;
/** how near the eraser must come to a stroke (screen px) */
export const ERASER_PX = 12;
export const INK_COLORS = ['#ff3b30', '#ffd60a', '#30d158', '#0a84ff', '#ffffff', '#111111'] as const;
/** a touch this soon after the Pencil lifts is the hand's (ms; deliverable/runtime/edit.ts PALM_AFTER) */
export const PALM_AFTER_MS = 400;
/** fingers draw with the tool in hand ('1'), or only the Pencil does (localStorage; the HTML deck's presenting frame has none: its editor keeps it) */
export const PRESENT_FINGERS_KEY = 'ol.presentFingers';

/** the bar's "Fingers draw" as kept in this browser */
export function presentFingersDraw(): boolean {
  try { return localStorage.getItem(PRESENT_FINGERS_KEY) === '1'; } catch { return false; }
}
export function savePresentFingersDraw(on: boolean): void {
  try { localStorage.setItem(PRESENT_FINGERS_KEY, on ? '1' : '0'); } catch { /* a sandboxed frame: its editor keeps it */ }
}
/** the bar's "Linked" (on unless switched off: '0'), kept like "Fingers draw" */
export const PRESENT_LINKED_KEY = 'ol.presentLinked';
export function presentLinked(): boolean {
  try { return localStorage.getItem(PRESENT_LINKED_KEY) !== '0'; } catch { return true; }
}
export function savePresentLinked(on: boolean): void {
  try { localStorage.setItem(PRESENT_LINKED_KEY, on ? '1' : '0'); } catch { /* a sandboxed frame: its editor keeps it */ }
}
/** how often a presenter's state goes to the other screens at most, while a stroke or the laser moves (ms) */
export const SHARE_MS = 50;

export type PresentTool = 'laser' | 'pen' | 'marker' | 'eraser';
type InkTool = Exclude<PresentTool, 'laser'>;
/** a stroke drawn on a slide: points in slide units (SLIDE_UNITS), width too; `id`: who drew it and its number there (presentshare.ts) */
export interface InkStroke { marker: boolean; color: string; w: number; pts: [number, number][]; id?: string }

export interface Rect { x: number; y: number; w: number; h: number }
/** a zoom on top of the fitted slide: screen point q → s·q + (x, y) */
export interface ZoomView { s: number; x: number; y: number }
export const IDENTITY: ZoomView = { s: 1, x: 0, y: 0 };
export interface TrailPoint { x: number; y: number; t: number }

/* ------------------------------------------------------------------ the zoom's arithmetic */

export const isZoomed = (v: ZoomView) => v.s > ZOOM_MIN + 1e-3;

/**
 * The view kept within bounds: the scale in [ZOOM_MIN, ZOOM_MAX]; along each axis the zoomed slide
 * (`base`: its rect on screen without the zoom) stays wholly on screen while it is smaller than the
 * window, and leaves no gap at its edges once it is larger. Back at 1×, exactly the identity.
 */
export function clampView(v: ZoomView, base: Rect | null, vw: number, vh: number): ZoomView {
  const s = Math.min(ZOOM_MAX, Math.max(ZOOM_MIN, v.s));
  if (!base || !isZoomed({ s, x: 0, y: 0 })) return { ...IDENTITY };
  const axis = (pos0: number, size0: number, off: number, view: number) => {
    const size = size0 * s, pos = pos0 * s + off;
    const lo = size <= view ? 0 : view - size, hi = size <= view ? view - size : 0;
    return Math.min(hi, Math.max(lo, pos)) - pos0 * s;
  };
  return { s, x: axis(base.x, base.w, v.x, vw), y: axis(base.y, base.h, v.y, vh) };
}

/** zoomed by `factor` about the screen point (cx, cy) — that point stays where it is (until clamped) */
export function zoomAt(v: ZoomView, factor: number, cx: number, cy: number, base: Rect | null, vw: number, vh: number): ZoomView {
  const s = Math.min(ZOOM_MAX, Math.max(ZOOM_MIN, v.s * factor));
  const k = s / v.s;
  return clampView({ s, x: cx - (cx - v.x) * k, y: cy - (cy - v.y) * k }, base, vw, vh);
}

/** a pinch: the view at its start (`v0`), zoomed by the fingers' spread `d / d0` about where they began (`c0`), carried along to where their middle is now (`c`) */
export function pinchView(v0: ZoomView, d0: number, d: number, c0: { x: number; y: number }, c: { x: number; y: number }, base: Rect | null, vw: number, vh: number): ZoomView {
  const s = Math.min(ZOOM_MAX, Math.max(ZOOM_MIN, v0.s * (d0 > 0 ? d / d0 : 1)));
  const k = s / v0.s;
  return clampView({ s, x: c.x - (c0.x - v0.x) * k, y: c.y - (c0.y - v0.y) * k }, base, vw, vh);
}

export function panBy(v: ZoomView, dx: number, dy: number, base: Rect | null, vw: number, vh: number): ZoomView {
  return clampView({ s: v.s, x: v.x + dx, y: v.y + dy }, base, vw, vh);
}

/** a wheel event's zoom factor (Ctrl + wheel: a trackpad pinch, or Ctrl and a mouse wheel), per event bounded */
export function wheelZoomFactor(deltaY: number, deltaMode = 0, pageH = 800): number {
  const dy = deltaMode === 1 ? deltaY * 16 : deltaMode === 2 ? deltaY * pageH : deltaY;
  return Math.min(1.6, Math.max(0.6, Math.exp(-dy * 0.0075)));
}

/* ------------------------------------------------------------------ the laser's trail */

/** the tail's points younger than `maxAge` */
export function liveTail(pts: readonly TrailPoint[], now: number, maxAge = LASER_TAIL_MS): TrailPoint[] {
  return pts.filter(p => now - p.t < maxAge);
}

/** the tail as segments, each as opaque as it is young (1 at the head, 0 at `maxAge`) */
export function tailSegments(pts: readonly TrailPoint[], now: number, maxAge = LASER_TAIL_MS): { x1: number; y1: number; x2: number; y2: number; a: number }[] {
  const live = liveTail(pts, now, maxAge);
  const out: { x1: number; y1: number; x2: number; y2: number; a: number }[] = [];
  for (let i = 1; i < live.length; i++) {
    const a = Math.max(0, Math.min(1, 1 - (now - live[i].t) / maxAge));
    out.push({ x1: live[i - 1].x, y1: live[i - 1].y, x2: live[i].x, y2: live[i].y, a });
  }
  return out;
}

const r1 = (n: number) => Math.round(n * 10) / 10;

/** a held trace (or a dot alone) as SVG markup: the board's glow, core and head, in screen px */
export function traceSvg(pts: readonly { x: number; y: number }[], color = LASER_COLOR, head = true): string {
  if (!pts.length) return '';
  const last = pts[pts.length - 1];
  let out = '';
  if (pts.length > 1) {
    const d = laserPathD(pts.map(p => [p.x, p.y] as [number, number]));
    out += `<path class="glow" d="${d}" fill="none" stroke="${color}" stroke-opacity="0.3" stroke-width="11" stroke-linecap="round" stroke-linejoin="round"/>`
      + `<path class="core" d="${d}" fill="none" stroke="${color}" stroke-opacity="0.95" stroke-width="3.2" stroke-linecap="round" stroke-linejoin="round"/>`;
  }
  if (head) out += dotSvg(last.x, last.y, color);
  return out;
}

export function dotSvg(x: number, y: number, color = LASER_COLOR): string {
  return `<circle class="head" cx="${r1(x)}" cy="${r1(y)}" r="8" fill="${color}" fill-opacity="0.5"/><circle cx="${r1(x)}" cy="${r1(y)}" r="2.2" fill="#fff" fill-opacity="0.9"/>`;
}

/** the moving dot's tail: segments fading along their length */
export function tailSvg(pts: readonly TrailPoint[], now: number, color = LASER_COLOR): string {
  let glow = '', core = '';
  for (const s of tailSegments(pts, now)) {
    const xy = `x1="${r1(s.x1)}" y1="${r1(s.y1)}" x2="${r1(s.x2)}" y2="${r1(s.y2)}"`;
    glow += `<line ${xy} stroke-opacity="${(0.3 * s.a).toFixed(3)}" stroke-width="${(11 * (0.45 + 0.55 * s.a)).toFixed(2)}"/>`;
    core += `<line ${xy} stroke-opacity="${(0.95 * s.a).toFixed(3)}" stroke-width="${(3.2 * (0.45 + 0.55 * s.a)).toFixed(2)}"/>`;
  }
  return glow || core ? `<g class="tail" stroke="${color}" stroke-linecap="round">${glow}${core}</g>` : '';
}

/* ------------------------------------------------------------------ drawings on the slide */

/** where slide units land on screen, screen = (ox, oy) + k·u: the slide's rect without the zoom (`base`), then the zoom */
export function inkFrame(v: ZoomView, base: Rect | null): { k: number; ox: number; oy: number } | null {
  if (!base || !(base.w > 0)) return null;
  return { k: v.s * base.w / SLIDE_UNITS, ox: v.s * base.x + v.x, oy: v.s * base.y + v.y };
}

/** a screen point in slide units */
export function toSlide(q: { x: number; y: number }, f: { k: number; ox: number; oy: number }): [number, number] {
  return [(q.x - f.ox) / f.k, (q.y - f.oy) / f.k];
}

function segDist(p: readonly number[], a: readonly number[], b: readonly number[]): number {
  const dx = b[0] - a[0], dy = b[1] - a[1];
  const l2 = dx * dx + dy * dy;
  const t = l2 ? Math.max(0, Math.min(1, ((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / l2)) : 0;
  return Math.hypot(p[0] - a[0] - t * dx, p[1] - a[1] - t * dy);
}

/** the strokes (their indices) that the eraser at `p` with radius `r` touches — all in slide units */
export function strokesHit(strokes: readonly InkStroke[], p: readonly [number, number], r: number): number[] {
  const out: number[] = [];
  strokes.forEach((s, i) => {
    const reach = r + s.w / 2;
    const pts = s.pts;
    if (pts.length === 1 ? segDist(p, pts[0], pts[0]) <= reach : pts.some((a, j) => j > 0 && segDist(p, pts[j - 1], a) <= reach)) out.push(i);
  });
  return out;
}

/** a stroke as SVG markup, in slide units; the highlighter's translucent */
export function strokeSvg(s: InkStroke): string {
  const color = (INK_COLORS as readonly string[]).includes(s.color) ? s.color : INK_COLORS[0];
  return `<path d="${laserPathD(s.pts)}" fill="none" stroke="${color}" stroke-width="${Math.round(s.w * 100) / 100}" stroke-linecap="round" stroke-linejoin="round"${s.marker ? ' stroke-opacity="0.38"' : ''}/>`;
}

/* ------------------------------------------------------------------ the tools on a presenting surface */

export interface PresentKitHost {
  /** the presenting surface: the tools listen there, and their layer goes into it */
  root: HTMLElement;
  /** the zoomed element's rect on screen without the zoom (null: nothing to zoom) */
  base(): Rect | null;
  /** draw the zoom (the presenter's transform of the slide) */
  apply(v: ZoomView): void;
  next(): void;
  prev(): void;
  exit(): void;
  /** where the presentation is, for the bar ("3 / 12") */
  position(): string;
  /** the zoom began or ended */
  onZoom?(zoomed: boolean): void;
  /** the bar's "Fingers draw" switched (kept in this browser by the kit where it can; a sandboxed frame hands it to its editor) */
  onFingersDraw?(on: boolean): void;
  /**
   * Where the presentation is: the slide's index and its step. With it the drawings are kept by the
   * slide's index (else by the position text), and the same slide on every screen has the same ones.
   */
  at?(): { slide: number; step: number };
  /** show the slide and step another screen moved to (the bar's "Linked") */
  goTo?(slide: number, step: number): void;
  /**
   * This presenter's state for the other screens presenting the document (presentshare.ts), null
   * once it ends. Absent: nothing is shared. The others' come in through `setPeers`.
   */
  share?(state: PresentState | null): void;
  /** the bar's "Linked" switched (kept as `onFingersDraw` is) */
  onLinked?(on: boolean): void;
}

// (nothing on the slide is selected either: on an iPad a long press or a Pencil drag brought the
// selection loupe and the Copy / Look Up menu over the slide's text and drawings, mid-talk)
const DOC_CSS = `.olpk-surface, .olpk-surface * { touch-action: none !important; -webkit-user-select: none !important; user-select: none !important; -webkit-touch-callout: none !important; }
  .olpk-surface :is(input, textarea, select), .olpk-surface :is(input, textarea, select) * { -webkit-user-select: text !important; user-select: text !important; }
  .olpk-laser-on, .olpk-laser-on * { cursor: none !important; }
  .olpk-drawing, .olpk-drawing * { cursor: crosshair !important; }
  .olpk-zoomed:not(.olpk-laser-on):not(.olpk-drawing), .olpk-zoomed:not(.olpk-laser-on):not(.olpk-drawing) * { cursor: grab !important; }
  .olpk-panning, .olpk-panning * { cursor: grabbing !important; }`;

const UI_CSS = `:host { all: initial; }
  svg.laser { position: fixed; left: 0; top: 0; width: 100vw; height: 100vh; overflow: visible; pointer-events: none; }
  svg.laser .fade { animation: olpk-fade ${LASER_FADE_MS}ms ease-out forwards; }
  @keyframes olpk-fade { from { opacity: 1; } to { opacity: 0; } }
  .bar { position: fixed; left: 16px; bottom: 16px; display: flex; align-items: center; gap: 2px; padding: 4px; border-radius: 22px;
    background: rgba(32, 33, 36, 0.84); color: #fff; font: 13px/1 system-ui, -apple-system, 'Segoe UI', sans-serif; box-shadow: 0 2px 12px rgba(0,0,0,0.35);
    opacity: 0; transition: opacity 0.45s; pointer-events: none; user-select: none; -webkit-user-select: none; -webkit-touch-callout: none; }
  .bar.show { opacity: 1; pointer-events: auto; }
  button { all: unset; box-sizing: border-box; min-width: 32px; height: 32px; padding: 0 9px; border-radius: 16px; display: inline-flex; align-items: center;
    justify-content: center; gap: 5px; cursor: pointer !important; color: #fff; font: inherit; white-space: nowrap; }
  button:hover { background: rgba(255, 255, 255, 0.14); }
  button:focus-visible { outline: 2px solid #8ab4f8; }
  button.on { background: rgba(255, 255, 255, 0.24); }
  button[data-k="laser"].on { background: rgba(255, 45, 85, 0.32); }
  button[hidden], .colors[hidden] { display: none; }
  .sep { width: 1px; height: 18px; margin: 0 4px; background: rgba(255, 255, 255, 0.22); }
  .colors { display: inline-flex; align-items: center; gap: 4px; padding: 0 4px; }
  button.sw { min-width: 0; width: 20px; height: 20px; padding: 0; border-radius: 50%; background: var(--c); box-shadow: inset 0 0 0 1.5px rgba(255, 255, 255, 0.45); }
  button.sw:hover { background: var(--c); filter: brightness(1.15); }
  button.sw.on { box-shadow: 0 0 0 2px rgba(32, 33, 36, 0.84), 0 0 0 4px #fff; }
  @media (pointer: coarse) {
    .bar { padding: 5px; border-radius: 26px; }
    button { min-width: 42px; height: 42px; border-radius: 21px; }
    button.sw { min-width: 0; width: 26px; height: 26px; }
    .colors { gap: 8px; padding: 0 8px; }
  }
  .pos { padding: 0 8px; font-variant-numeric: tabular-nums; color: rgba(255, 255, 255, 0.86); white-space: nowrap; }
  .dot { width: 12px; height: 12px; border-radius: 50%; background: radial-gradient(circle, #fff 0 18%, ${LASER_COLOR} 24% 55%, rgba(255,45,85,0.35) 62%, transparent 72%); }`;

const ICON = {
  prev: '<svg width="16" height="16" viewBox="0 0 16 16"><path d="M10.5 3 5.5 8l5 5" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/></svg>',
  next: '<svg width="16" height="16" viewBox="0 0 16 16"><path d="M5.5 3l5 5-5 5" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/></svg>',
  exit: '<svg width="14" height="14" viewBox="0 0 14 14"><path d="M3 3l8 8M11 3l-8 8" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/></svg>',
  pen: '<svg width="16" height="16" viewBox="0 0 16 16"><path d="M3 13l.9-3.4 7-7a1.2 1.2 0 0 1 1.7 0l.8.8a1.2 1.2 0 0 1 0 1.7l-7 7zM9.6 3.9l2.5 2.5" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linejoin="round" stroke-linecap="round"/></svg>',
  marker: '<svg width="16" height="16" viewBox="0 0 16 16"><path d="M4.6 10.4 3 12l1 1 1.6-1.6M5.2 7.6l3.2 3.2 5-5a1.2 1.2 0 0 0 0-1.7l-1.5-1.5a1.2 1.2 0 0 0-1.7 0zM4 9l3 3" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linejoin="round" stroke-linecap="round"/><path d="M2 14.5h12" stroke="#ffd60a" stroke-width="1.6" stroke-linecap="round"/></svg>',
  eraser: '<svg width="16" height="16" viewBox="0 0 16 16"><path d="M7 13.5h6.5M2.9 9.6l5.6-5.6a1.2 1.2 0 0 1 1.7 0l2.5 2.5a1.2 1.2 0 0 1 0 1.7l-5.3 5.3H5.6L2.9 11.3a1.2 1.2 0 0 1 0-1.7zM5.7 6.8l4.2 4.2" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linejoin="round" stroke-linecap="round"/></svg>',
  clear: '<svg width="16" height="16" viewBox="0 0 16 16"><path d="M3 4.5h10M6.3 4.5V3h3.4v1.5M4.5 4.5l.6 8.5h5.8l.6-8.5" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linejoin="round" stroke-linecap="round"/></svg>',
  fingers: '<svg width="16" height="16" viewBox="0 0 16 16"><path d="M6.5 9.2V3a1.1 1.1 0 0 1 2.2 0v4.6M8.7 7.2a1.1 1.1 0 0 1 2.2 0v.6M10.9 7.7a1.1 1.1 0 0 1 2.2 0v2.2c0 2.6-1.6 4.6-4.4 4.6h-.6c-1.5 0-2.5-.6-3.4-1.8L3 10.2a1.1 1.1 0 0 1 1.8-1.3l1.7 1.8" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linejoin="round" stroke-linecap="round"/></svg>',
  fit: '<svg width="16" height="16" viewBox="0 0 16 16"><path d="M2.5 6V2.5H6M10 2.5h3.5V6M13.5 10v3.5H10M6 13.5H2.5V10" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"/></svg>',
  link: '<svg width="16" height="16" viewBox="0 0 16 16"><path d="M6.8 9.2a2.6 2.6 0 0 0 3.7 0l2.3-2.3a2.6 2.6 0 0 0-3.7-3.7l-.9.9M9.2 6.8a2.6 2.6 0 0 0-3.7 0L3.2 9.1a2.6 2.6 0 0 0 3.7 3.7l.9-.9" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"/></svg>',
};

type Gesture =
  /** `lock`: a zoom only once the fingers' spread has changed enough, else a pan (deliverable/gestures.ts, as on the canvas) */
  | { kind: 'pinch'; ids: [number, number]; d0: number; c0: { x: number; y: number }; v0: ZoomView; lock: PinchLock }
  /** `v0`: the view it began from (put back should the touch turn out to be the hand's) */
  | { kind: 'pan'; id: number; x: number; y: number; moved: boolean; v0: ZoomView }
  | { kind: 'laser'; id: number }
  /** a drawing tool's stroke (or the eraser's sweep), with the tool it draws with; `moved`: past a tap */
  | { kind: 'draw'; id: number; tool: InkTool; x0: number; y0: number; moved: boolean; erased: boolean; stroke: InkStroke | null; f: { k: number; ox: number; oy: number } | null; watch: StrokeWatch | null }
  | { kind: 'swipe'; id: number; x0: number; y0: number; t0: number; moved: boolean };

/**
 * The laser, the drawing tools, the zoom and the bar on a presenting surface. The presenter keeps its
 * own keys and clicks; it asks `key()` first, calls `slideChanged()` when it shows another slide (the
 * zoom goes back to the whole slide, that slide's drawings show), `moved()` when it shows another
 * step, and `refresh()` when its position text changes. The drawings are kept per slide, whatever its
 * step: by its index where the presenter tells it (`at`), else by that text ("3 / 12"). Sharing with
 * the other screens presenting the document (`share`, `setPeers`): presentshare.ts.
 */
export class PresentKit {
  readonly host: PresentKitHost;
  private win: Window;
  private doc: Document;
  private ui: HTMLElement;
  private svg: SVGSVGElement;
  private live: SVGGElement;
  /** the drawings' layer (in slide units, placed by a transform), its finished strokes and the one being drawn */
  private inkG: SVGGElement;
  private strokesG: SVGGElement;
  private drawG: SVGGElement;
  private bar: HTMLElement;
  private posEl: HTMLElement;
  private laserBtn: HTMLElement;
  private fingersBtn: HTMLElement;
  private zoomBtn: HTMLElement;
  private clearBtn: HTMLElement;
  private colorsEl: HTMLElement;
  private style: HTMLStyleElement;
  private tool: PresentTool | null = null;
  private penColor: string = INK_COLORS[0];
  private markerColor: string = INK_COLORS[1];
  /** this screen's drawings, per slide (slideKey) */
  private ink = new Map<string, InkStroke[]>();
  /** what is shared with the other screens presenting the document, and what they share */
  private share = new PresentShare();
  /** the presenter's state goes out at most every SHARE_MS: when it is due */
  private shareTimer: ReturnType<typeof setTimeout> | undefined;
  private sharedAt = -1e9;
  /** the move of another screen being followed (moved() takes its clock over) */
  private following: Follow | null = null;
  /** the presenter has shown its first slide (where it starts: no move) */
  private placed = false;
  /** the laser's points so far (its trail's numbers for the others) */
  private laserN = 0;
  /** the others' lasers on this screen, in slide units: the moving one's trail by when it came, the held trace */
  private peerLasers = new Map<number, { k: string; last: number; trail: { x: number; y: number; t: number }[]; held: Pt[] | null; head: Pt | null }>();
  private remoteG: SVGGElement;
  private linkBtn: HTMLElement;
  /** fingers draw (and point the laser) with the tool in hand; off: only the Pencil does, fingers swipe, tap and pinch */
  private fingersDraw = false;
  /** the Pencil on the glass (its pointer), and when it last lifted */
  private penOn: number | null = null;
  private penOffAt = -1e9;
  /** the hand's touches: they count for nothing until they lift */
  private palms = new Set<number>();
  private inkRaf = 0;
  /** what the bar was last asked for with lasts this long */
  private barMs = IDLE_MS;
  /** the kind of pointer that touched last (mouse, touch, pen) */
  private lastType = 'mouse';
  private view: ZoomView = { ...IDENTITY };
  private held: TrailPoint[] | null = null;
  private tail: TrailPoint[] = [];
  private head: { x: number; y: number } | null = null;
  private raf = 0;
  private pointers = new Map<number, { x: number; y: number; type: string }>();
  private gesture: Gesture | null = null;
  private suppressClick = false;
  private lastTap: { t: number; x: number; y: number } | null = null;
  private safari: ZoomView | null = null;
  private idle: ReturnType<typeof setTimeout> | undefined;
  private offs: (() => void)[] = [];

  constructor(host: PresentKitHost) {
    this.host = host;
    this.doc = host.root.ownerDocument;
    this.win = this.doc.defaultView ?? window;
    this.style = this.doc.createElement('style');
    this.style.setAttribute('data-ol-runtime', '');
    this.style.textContent = DOC_CSS;
    (this.doc.head ?? this.doc.documentElement).appendChild(this.style);
    host.root.classList.add('olpk-surface');

    this.ui = this.doc.createElement('ol-present-ui');
    this.ui.setAttribute('data-ol-runtime', '');
    this.ui.style.cssText = 'all:initial;position:fixed;left:0;top:0;width:0;height:0;z-index:2147483647;pointer-events:none;display:block;';
    const sr = this.ui.attachShadow({ mode: 'open' });
    sr.innerHTML = `<style>${UI_CSS}</style><svg class="laser" xmlns="http://www.w3.org/2000/svg"><g class="ink"><g class="strokes"></g><g class="remote"></g><g class="drawing"></g></g><g class="live"></g></svg>
      <div class="bar" role="toolbar" aria-label="Presentation">
        <button data-k="prev" title="Previous (←)" aria-label="Previous">${ICON.prev}</button>
        <span class="pos"></span>
        <button data-k="next" title="Next (→)" aria-label="Next">${ICON.next}</button>
        <span class="sep"></span>
        <button data-k="pen" title="Pen (Ctrl+P)" aria-label="Pen" aria-pressed="false">${ICON.pen}</button>
        <button data-k="marker" title="Highlighter (Ctrl+I)" aria-label="Highlighter" aria-pressed="false">${ICON.marker}</button>
        <button data-k="eraser" title="Eraser (Ctrl+E)" aria-label="Eraser" aria-pressed="false">${ICON.eraser}</button>
        <button data-k="laser" title="Laser pointer (L)" aria-label="Laser pointer" aria-pressed="false"><span class="dot"></span></button>
        <button data-k="fingers" title="Fingers draw too (off: only the Apple Pencil draws; fingers swipe, tap and pinch)" aria-label="Fingers draw" aria-pressed="false" hidden>${ICON.fingers}</button>
        <button data-k="link" title="Linked — this document is presented on another of your screens too: each goes along to the slide the other shows. Off: this screen goes its own way (the drawings and the laser still show where both show the same slide)" aria-label="Linked with the other screens" aria-pressed="true" hidden>${ICON.link}<span class="n"></span></button>
        <span class="colors" hidden>${INK_COLORS.map(c => `<button class="sw" data-k="color" data-c="${c}" style="--c:${c}" title="Colour" aria-label="Colour ${c}"></button>`).join('')}</span>
        <button data-k="clear" title="Clear the drawings on this slide (E)" aria-label="Clear the drawings on this slide" hidden>${ICON.clear}</button>
        <button data-k="zoom" title="Back to the whole slide (0)" hidden>${ICON.fit}<span class="z"></span></button>
        <button data-k="exit" title="End the presentation (Esc)" aria-label="End the presentation">${ICON.exit}</button>
      </div>`;
    this.svg = sr.querySelector('svg.laser') as SVGSVGElement;
    this.live = sr.querySelector('g.live') as SVGGElement;
    this.inkG = sr.querySelector('g.ink') as SVGGElement;
    this.strokesG = sr.querySelector('g.strokes') as SVGGElement;
    this.drawG = sr.querySelector('g.drawing') as SVGGElement;
    this.remoteG = sr.querySelector('g.remote') as SVGGElement;
    this.bar = sr.querySelector('.bar') as HTMLElement;
    this.posEl = sr.querySelector('.pos') as HTMLElement;
    this.laserBtn = sr.querySelector('[data-k="laser"]') as HTMLElement;
    this.fingersBtn = sr.querySelector('[data-k="fingers"]') as HTMLElement;
    // (only where there are fingers to draw with)
    this.fingersBtn.hidden = !(this.win.navigator.maxTouchPoints > 0);
    this.linkBtn = sr.querySelector('[data-k="link"]') as HTMLElement;
    this.zoomBtn = sr.querySelector('[data-k="zoom"]') as HTMLElement;
    this.clearBtn = sr.querySelector('[data-k="clear"]') as HTMLElement;
    this.colorsEl = sr.querySelector('.colors') as HTMLElement;
    for (const b of Array.from(sr.querySelectorAll<HTMLElement>('button'))) {
      // the bar's own clicks: never a click on the slide (that would advance)
      b.addEventListener('click', e => { e.stopPropagation(); e.preventDefault(); this.button(b.dataset.k!, b.dataset.c); });
      b.addEventListener('pointerdown', e => e.stopPropagation());
    }
    this.bar.addEventListener('pointerenter', () => { if (this.bar.classList.contains('show')) this.showBar(); });
    host.root.appendChild(this.ui);

    const on = <K extends keyof WindowEventMap>(type: K, fn: (e: WindowEventMap[K]) => void, opts: AddEventListenerOptions = { capture: true }) => {
      this.win.addEventListener(type, fn as EventListener, opts);
      this.offs.push(() => this.win.removeEventListener(type, fn as EventListener, opts));
    };
    on('pointerdown', e => this.down(e));
    on('pointermove', e => this.move(e));
    on('pointerup', e => this.up(e));
    on('pointercancel', e => this.up(e, true));
    on('click', e => this.click(e));
    on('dblclick', e => this.dblclick(e));
    // no selecting the slide (DOC_CSS; Safari may start one anyway): only a form control's text
    on('selectstart', e => { if (!(e.target as Element | null)?.closest?.('input, textarea, select')) e.preventDefault(); });
    on('wheel', e => this.wheel(e), { capture: true, passive: false });
    // Safari's trackpad pinch
    on('gesturestart' as keyof WindowEventMap, (e: Event) => { if (this.fromUi(e)) return; e.preventDefault(); this.safari = { ...this.view }; });
    on('gesturechange' as keyof WindowEventMap, (e: Event) => {
      if (!this.safari) return;
      e.preventDefault();
      const g = e as Event & { scale: number; clientX: number; clientY: number };
      const s0 = this.safari;
      this.setView(zoomAt(s0, g.scale || 1, g.clientX ?? this.win.innerWidth / 2, g.clientY ?? this.win.innerHeight / 2, this.host.base(), this.win.innerWidth, this.win.innerHeight));
    });
    on('gestureend' as keyof WindowEventMap, (e: Event) => { if (this.safari) { e.preventDefault(); this.safari = null; this.suppressClick = true; } });
    on('resize', () => { this.resetZoom(); this.scheduleInk(); });
    if (this.win === this.win.top) this.offs.push(keepAwake(this.win));
    this.setFingersDraw(presentFingersDraw(), false);
    this.setLinked(presentLinked(), false);
    this.refresh();
  }

  get zoomed(): boolean { return isZoomed(this.view); }
  get laserOn(): boolean { return this.tool === 'laser'; }
  /** the drawing tool (or the laser) in hand, null: none */
  get toolOn(): PresentTool | null { return this.tool; }
  /** the drawings on the slide shown: this screen's and the other presenters' */
  get strokes(): readonly InkStroke[] { return this.share.merged(this.slideNow(), this.ink.get(this.slideNow()) ?? []); }
  get linked(): boolean { return this.share.at.linked; }
  /** the other screens presenting the document (anyone's), and those of this account (Linked goes along with them) */
  get presenters(): number { return this.share.presenters; }
  get screens(): number { return this.share.screens; }

  /** the slide shown, as the drawings are kept: by its index where the presenter tells it, else by its position text */
  private slideNow(): string {
    const a = this.host.at?.();
    return a ? slideKey(a.slide) : this.host.position();
  }
  get zoom(): ZoomView { return { ...this.view }; }
  get fingersDrawOn(): boolean { return this.fingersDraw; }

  /**
   * The presenter's keys first: L (laser), Ctrl+P / Ctrl+I / Ctrl+E (pen, highlighter, eraser —
   * PowerPoint's), Ctrl+A (the tool put away), E (the slide's drawings cleared), 0, +, -, Escape
   * (back to the whole slide, else the tool put away). True: taken.
   */
  key(e: KeyboardEvent, typing = false): boolean {
    if (e.altKey) return false;
    const k = e.key;
    if (e.ctrlKey || e.metaKey) {
      if (e.shiftKey) return false;
      const t = ({ p: 'pen', i: 'marker', e: 'eraser', a: null } as Record<string, PresentTool | null>)[k.toLowerCase()];
      if (t === undefined) return false;
      this.setTool(t && this.tool !== t ? t : null);
      return true;
    }
    if (k === 'l' || k === 'L') { this.setLaser(this.tool !== 'laser'); return true; }
    if ((k === 'e' || k === 'E') && !typing) { this.clearInk(); return true; }
    if (k === '0' && !typing && this.zoomed) { this.resetZoom(); return true; }
    if (k === '+' || k === '=') { this.zoomBy(1.25); return true; }
    if (k === '-' || k === '_') { if (this.zoomed) this.zoomBy(0.8); return true; }
    if (k === 'Escape' && this.zoomed) { this.resetZoom(); return true; }
    if (k === 'Escape' && this.tool) { this.setTool(null); return true; }
    return false;
  }

  /** another slide shown: the whole of it, with its drawings */
  slideChanged(): void { this.cancelDraw(); this.resetZoom(); this.refresh(); this.renderInk(); this.render(); this.moved(); }

  /**
   * The presenter showed another slide or step: the other screens are told (linked, they go along). A
   * move of this screen's own, unless it follows another's; the first is where it starts, no move.
   */
  moved(): void {
    const a = this.host.at?.();
    if (!a) return;
    const was = this.share.at;
    if (!this.placed) { this.placed = true; this.share.place(a.slide, a.step); this.publish(true); return; }
    const f = this.following;
    if (a.slide === was.slide && a.step === was.step && (!f || f.n === was.n)) return;
    this.share.moved(a.slide, a.step, f);
    this.publish(true);
  }

  /**
   * The other presenters' states, as the document's awareness has them (`state`: a client's `present`
   * field, anyone's — checked in presentshare.ts; `mine`: a screen of this account). Their drawings,
   * strokes being drawn and lasers show here; linked, this screen goes to where the one of this
   * account's screens that moved last is.
   */
  setPeers(list: readonly PresenterState[]): void {
    if (this.share.setPeers(list)) this.publish(true);
    this.takeLasers();
    const f = this.share.leader();
    if (f) this.follow(f);
    const mine = this.share.screens;
    this.linkBtn.hidden = !(this.host.share && this.host.goTo && mine > 0);
    const n = this.linkBtn.querySelector('.n');
    if (n) n.textContent = mine > 1 ? String(mine + 1) : '';
    this.renderInk();
    this.render();
  }

  /** "Linked": this screen goes along with the others' moves and takes them along with its own; `tell`: kept (and the host told) */
  setLinked(on: boolean, tell = true): void {
    this.share.setLinked(on);
    this.linkBtn.classList.toggle('on', on);
    this.linkBtn.setAttribute('aria-pressed', String(on));
    if (tell) { savePresentLinked(on); this.host.onLinked?.(on); }
    // linked again: to where the others are
    const f = on ? this.share.leader(true) : null;
    if (f) this.follow(f);
    this.publish(true);
  }

  /** to where another screen moved (its clock taken over: following is no move of this one's) */
  private follow(f: Follow): void {
    const a = this.host.at?.();
    if (!a || !this.host.goTo || !this.placed) return;
    this.following = f;
    try {
      if (a.slide !== f.slide || a.step !== f.step) this.host.goTo(f.slide, f.step);
      this.moved();
    } finally { this.following = null; }
  }

  refresh(): void { this.posEl.textContent = this.host.position(); }

  setLaser(on: boolean): void {
    if (on) this.setTool('laser');
    else if (this.tool === 'laser') this.setTool(null);
  }

  /** a tool in hand (the laser, the pen, the highlighter, the eraser), or none */
  setTool(t: PresentTool | null): void {
    const was = this.tool;
    this.tool = t;
    this.cancelDraw();
    const root = this.host.root.classList;
    root.toggle('olpk-laser-on', t === 'laser');
    root.toggle('olpk-drawing', t === 'pen' || t === 'marker' || t === 'eraser');
    for (const b of Array.from(this.bar.querySelectorAll<HTMLElement>('button[aria-pressed]:not([data-k="fingers"]):not([data-k="link"])'))) {
      const on = b.dataset.k === t;
      b.classList.toggle('on', on);
      b.setAttribute('aria-pressed', String(on));
    }
    this.colorsEl.hidden = t !== 'pen' && t !== 'marker';
    this.markColor();
    if (was === 'laser' && t !== 'laser') { this.endHeld(); this.tail = []; this.head = null; this.publish(true); }
    this.render();
  }

  /** fingers draw with the tool in hand too, or only the Pencil does; `tell`: kept (and the host told), else only shown (the host's own setting arriving) */
  setFingersDraw(on: boolean, tell = true): void {
    this.fingersDraw = on;
    this.fingersBtn.classList.toggle('on', on);
    this.fingersBtn.setAttribute('aria-pressed', String(on));
    if (!tell) return;
    savePresentFingersDraw(on);
    this.host.onFingersDraw?.(on);
  }

  /** the slide's drawings cleared (the other presenters' too: on every screen) */
  clearInk(): void {
    this.cancelDraw();
    const key = this.slideNow();
    this.share.erase(this.strokes.map(s => s.id).filter((id): id is string => !!id));
    this.ink.delete(key);
    this.share.inkChanged();
    this.renderInk();
    this.publish(true);
  }

  resetZoom(): void { if (this.zoomed || this.view.x || this.view.y) this.setView({ ...IDENTITY }); }

  zoomBy(f: number, cx = this.win.innerWidth / 2, cy = this.win.innerHeight / 2): void {
    this.setView(zoomAt(this.view, f, cx, cy, this.host.base(), this.win.innerWidth, this.win.innerHeight));
  }

  destroy(): void {
    for (const off of this.offs) off();
    this.offs = [];
    clearTimeout(this.shareTimer);
    this.host.share?.(null);
    cancelAnimationFrame(this.raf);
    cancelAnimationFrame(this.inkRaf);
    clearTimeout(this.idle);
    this.ui.remove();
    this.style.remove();
    this.host.root.classList.remove('olpk-surface', 'olpk-laser-on', 'olpk-drawing', 'olpk-zoomed', 'olpk-panning');
  }

  /* -------------------------------------------------------------- the bar */

  private button(k: string, c?: string): void {
    this.showBar();
    if (k === 'prev') this.host.prev();
    else if (k === 'next') this.host.next();
    else if (k === 'laser') this.setLaser(this.tool !== 'laser');
    else if (k === 'fingers') this.setFingersDraw(!this.fingersDraw);
    else if (k === 'link') this.setLinked(!this.linked);
    else if (k === 'pen' || k === 'marker' || k === 'eraser') this.setTool(this.tool === k ? null : k);
    else if (k === 'color' && c) {
      if (this.tool === 'marker') this.markerColor = c;
      else { this.penColor = c; if (this.tool !== 'pen') this.setTool('pen'); }
      this.markColor();
    } else if (k === 'clear') this.clearInk();
    else if (k === 'zoom') this.resetZoom();
    else if (k === 'exit') this.host.exit();
  }

  /** the bar shown, fading out `ms` after (the last time it was asked for: the mouse, a tap, a button) */
  showBar(ms = this.barMs): void {
    this.barMs = ms;
    this.refresh();
    this.bar.classList.add('show');
    clearTimeout(this.idle);
    this.idle = setTimeout(() => {
      // (a touch screen keeps :hover on what was tapped last: only a mouse resting on the bar keeps it)
      if (this.lastType === 'mouse' && this.bar.matches(':hover')) { this.showBar(); return; }
      this.hideBar();
    }, ms);
  }

  hideBar(): void {
    clearTimeout(this.idle);
    this.bar.classList.remove('show');
  }

  get barShown(): boolean { return this.bar.classList.contains('show'); }

  private toggleBar(): void { if (this.barShown) this.hideBar(); else this.showBar(TAP_IDLE_MS); }

  private markColor(): void {
    const cur = this.tool === 'marker' ? this.markerColor : this.penColor;
    for (const b of Array.from(this.colorsEl.querySelectorAll<HTMLElement>('button'))) b.classList.toggle('on', b.dataset.c === cur);
  }

  private fromUi(e: Event): boolean { return e.composedPath().includes(this.ui); }

  /** on a link, a video, a form control of the slide: the page's own (a tap there is not the bar's) */
  private onControl(e: Event): boolean {
    const t = e.target as Element | null;
    return !!t?.closest?.('a, button, input, select, textarea, video, audio, label, [onclick], [contenteditable]');
  }

  /* -------------------------------------------------------------- the zoom */

  private setView(v: ZoomView): void {
    const was = this.zoomed;
    this.view = v;
    this.host.apply(v);
    const z = this.zoomed;
    if (z !== was) this.host.onZoom?.(z);
    this.host.root.classList.toggle('olpk-zoomed', z);
    this.zoomBtn.hidden = !z;
    const zt = this.zoomBtn.querySelector('.z');
    if (zt) zt.textContent = z ? `${Math.round(v.s * 100)}%` : '';
    this.placeInk();
  }

  private wheel(e: WheelEvent): void {
    if (this.fromUi(e)) return;
    const W = this.win.innerWidth, H = this.win.innerHeight;
    if (e.ctrlKey) {
      e.preventDefault(); e.stopPropagation();
      this.setView(zoomAt(this.view, wheelZoomFactor(e.deltaY, e.deltaMode, H), e.clientX, e.clientY, this.host.base(), W, H));
      this.suppressClick = true;
    } else if (this.zoomed) {
      e.preventDefault(); e.stopPropagation();
      const k = e.deltaMode === 1 ? 16 : e.deltaMode === 2 ? H : 1;
      this.setView(panBy(this.view, -e.deltaX * k, -e.deltaY * k, this.host.base(), W, H));
    }
  }

  /* -------------------------------------------------------------- pointers */

  /**
   * What this pointer does with the tool in hand: the Pencil always draws (the pen when nothing is
   * in hand); a finger only with "Fingers draw" on (else it swipes, taps, pinches and pans); the
   * mouse with the tool in hand. Null: no tool — it goes on, swipes or pans.
   */
  private toolFor(e: PointerEvent): PresentTool | null {
    if (e.pointerType === 'pen') return this.tool ?? 'pen';
    if (e.pointerType === 'touch' && !this.fingersDraw) return null;
    return this.tool;
  }

  /**
   * A touch that is the hand resting on the glass: it comes while the Pencil writes or just after it
   * lifts. (Not told by its breadth, as the canvas does once fingers move the slide: the iPad's contact
   * sizes come in coarse steps, and a thumb pressed flat would no longer swipe or pinch.)
   */
  private isPalm(): boolean {
    return this.penOn !== null || performance.now() - this.penOffAt < PALM_AFTER_MS;
  }

  /**
   * The Pencil lands: the touches already down are the hand's (GoodNotes' palm rejection, as on the
   * canvas: deliverable/runtime/edit.ts penLands). What they began is undone — a pinch or a pan put
   * back, a swipe, a laser trace or a finger's stroke let go — and they count for nothing until they lift.
   */
  private penLands(e: PointerEvent): void {
    this.penOn = e.pointerId;
    const touches = [...this.pointers].filter(([, p]) => p.type === 'touch').map(([id]) => id);
    if (!touches.length) return;
    for (const id of touches) { this.palms.add(id); this.pointers.delete(id); }
    const g = this.gesture;
    if (!g || (g.kind !== 'pinch' && !touches.includes(g.id))) return;
    this.gesture = null;
    if (g.kind === 'pinch' || g.kind === 'pan') this.setView(g.v0);
    if (g.kind === 'pan') this.host.root.classList.remove('olpk-panning');
    if (g.kind === 'draw') this.cancelDraw();
    if (g.kind === 'laser') { this.held = null; this.head = null; this.render(); }
  }

  private down(e: PointerEvent): void {
    this.lastType = e.pointerType;
    if (this.fromUi(e)) return;
    // the hand on the glass while the Pencil writes: nothing
    if (e.pointerType === 'touch' && this.isPalm()) { this.palms.add(e.pointerId); e.preventDefault(); return; }
    if (e.pointerType === 'pen') this.penLands(e);
    this.pointers.set(e.pointerId, { x: e.clientX, y: e.clientY, type: e.pointerType });
    this.suppressClick = false;
    if (e.pointerType === 'touch' && this.pointers.size >= 2) {
      const ids = [...this.pointers.keys()].slice(-2) as [number, number];
      const [a, b] = ids.map(id => this.pointers.get(id)!);
      this.endHeld();
      this.cancelDraw();
      this.gesture = { kind: 'pinch', ids, d0: Math.hypot(a.x - b.x, a.y - b.y), c0: { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 }, v0: { ...this.view }, lock: pinchLock() };
      this.suppressClick = true;
      e.preventDefault();
      return;
    }
    if (this.pointers.size > 1) return;
    if (e.pointerType === 'mouse' && e.button !== 0) return;
    const pt = { x: e.clientX, y: e.clientY, t: performance.now() };
    const tool = this.toolFor(e);
    if (tool === 'laser') {
      this.held = [pt];
      this.head = pt;
      this.tail = [];
      this.laserN++;
      this.publish();
      this.gesture = { kind: 'laser', id: e.pointerId };
      this.suppressClick = true;
      e.preventDefault();
      this.capture(e);
      this.render();
    } else if (tool) {
      const g: Gesture = { kind: 'draw', id: e.pointerId, tool, x0: e.clientX, y0: e.clientY, moved: false, erased: false, stroke: null, f: inkFrame(this.view, this.host.base()), watch: tool === 'eraser' ? null : strokeWatch('present', e, { win: this.win }) };
      this.gesture = g;
      this.suppressClick = true;
      e.preventDefault();
      this.capture(e);
      if (tool === 'eraser') this.eraseAt(e.clientX, e.clientY, g);
    } else if (this.zoomed) {
      this.gesture = { kind: 'pan', id: e.pointerId, x: e.clientX, y: e.clientY, moved: false, v0: { ...this.view } };
      this.host.root.classList.add('olpk-panning');
      e.preventDefault();
      this.capture(e);
    } else if (e.pointerType !== 'mouse') {
      this.gesture = { kind: 'swipe', id: e.pointerId, x0: e.clientX, y0: e.clientY, t0: performance.now(), moved: false };
    }
  }

  private capture(e: PointerEvent): void {
    try { this.host.root.setPointerCapture(e.pointerId); } catch { /* not capturable here */ }
  }

  private move(e: PointerEvent): void {
    const p = this.pointers.get(e.pointerId);
    if (p) { p.x = e.clientX; p.y = e.clientY; }
    const g = this.gesture;
    const W = this.win.innerWidth, H = this.win.innerHeight;
    // the mouse brings the bar only near the bottom edge: pointing at the slide does not
    if (e.pointerType === 'mouse' && !g && e.clientY >= H - BAR_ZONE && !this.fromUi(e)) this.showBar(IDLE_MS);
    if (g?.kind === 'pinch') {
      const a = this.pointers.get(g.ids[0]), b = this.pointers.get(g.ids[1]);
      if (!a || !b) return;
      e.preventDefault();
      const c = { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
      const f = pinchFactor(g.lock, g.d0, Math.hypot(a.x - b.x, a.y - b.y), Math.hypot(c.x - g.c0.x, c.y - g.c0.y));
      this.setView(pinchView(g.v0, 1, f, g.c0, c, this.host.base(), W, H));
      return;
    }
    if (g?.kind === 'draw' && g.id === e.pointerId) {
      e.preventDefault();
      if (!g.moved) {
        if (Math.hypot(e.clientX - g.x0, e.clientY - g.y0) < 4) return;
        g.moved = true;
        // the audience sees the stroke, not the bar
        this.hideBar();
        if (g.tool !== 'eraser' && g.f) {
          const marker = g.tool === 'marker';
          g.stroke = { marker, color: marker ? this.markerColor : this.penColor, w: (marker ? MARKER_PX : PEN_PX) / g.f.k, pts: [toSlide({ x: g.x0, y: g.y0 }, g.f)], id: this.share.newId() };
        }
      }
      const evs = e.getCoalescedEvents?.() ?? [];
      for (const c of evs.length ? evs : [e]) {
        if (g.tool === 'eraser') this.eraseAt(c.clientX, c.clientY, g);
        else if (g.stroke && g.f) {
          const q = toSlide({ x: c.clientX, y: c.clientY }, g.f);
          const last = g.stroke.pts[g.stroke.pts.length - 1];
          if (Math.hypot(q[0] - last[0], q[1] - last[1]) > 0.05) { g.stroke.pts.push(q); g.watch?.add(c.clientX, c.clientY, c.timeStamp, evs.length ? 'coalesced' : 'move'); }
        }
      }
      if (g.stroke) { this.drawG.innerHTML = strokeSvg(g.stroke); this.publish(); }
      return;
    }
    if (g?.kind === 'laser' && g.id === e.pointerId && this.held) {
      const pt = { x: e.clientX, y: e.clientY, t: performance.now() };
      this.held.push(pt);
      this.head = pt;
      this.laserN++;
      this.schedule();
      this.publish();
      return;
    }
    if (g?.kind === 'pan' && g.id === e.pointerId) {
      const dx = e.clientX - g.x, dy = e.clientY - g.y;
      g.x = e.clientX; g.y = e.clientY;
      if (Math.abs(dx) + Math.abs(dy) > 0) { g.moved = true; this.suppressClick = true; }
      this.setView(panBy(this.view, dx, dy, this.host.base(), W, H));
      return;
    }
    if (g?.kind === 'swipe' && g.id === e.pointerId) {
      if (Math.hypot(e.clientX - g.x0, e.clientY - g.y0) > 10) g.moved = true;
      return;
    }
    if (this.tool === 'laser' && e.pointerType === 'mouse' && !e.buttons) {
      const pt = { x: e.clientX, y: e.clientY, t: performance.now() };
      this.tail.push(pt);
      if (this.tail.length > 120) this.tail.splice(0, this.tail.length - 120);
      this.head = pt;
      this.laserN++;
      this.schedule();
      this.publish();
    }
  }

  private up(e: PointerEvent, cancelled = false): void {
    // the hand lifted: nothing (not a tap either — its click must not go on)
    if (this.palms.delete(e.pointerId)) { this.suppressClick = true; return; }
    if (e.pointerId === this.penOn) { this.penOn = null; this.penOffAt = performance.now(); }
    this.pointers.delete(e.pointerId);
    const g = this.gesture;
    if (!g) return;
    if (g.kind === 'pinch') {
      if (this.pointers.size < 2) { this.gesture = null; this.suppressClick = true; }
      return;
    }
    if ((g.kind === 'laser' || g.kind === 'pan' || g.kind === 'swipe' || g.kind === 'draw') && g.id !== e.pointerId) return;
    this.gesture = null;
    if (g.kind === 'laser') {
      this.endHeld();
      if (e.pointerType !== 'mouse') this.head = null;
      this.render();
      this.publish(true);
    } else if (g.kind === 'draw') {
      this.drawG.replaceChildren();
      if (g.stroke) {
        strokeEnded(g.watch);
        const key = this.slideNow();
        this.ink.set(key, [...(this.ink.get(key) ?? []), g.stroke]);
        this.share.inkChanged();
        this.renderInk();
        this.publish(true);
      } else if (!g.moved && !g.erased && !cancelled && e.pointerType !== 'mouse') this.toggleBar();
    } else if (g.kind === 'pan') {
      this.host.root.classList.remove('olpk-panning');
      if (!g.moved) this.tap(e);
    } else if (g.kind === 'swipe' && !cancelled) {
      const dx = e.clientX - g.x0, dy = e.clientY - g.y0;
      if (g.moved && Math.abs(dx) > 60 && Math.abs(dx) > 1.5 * Math.abs(dy) && performance.now() - g.t0 < 900) {
        this.suppressClick = true;
        if (dx < 0) this.host.next(); else this.host.prev();
      } else if (!g.moved && performance.now() - g.t0 < 600 && !this.onControl(e)) {
        // a tap brings the bar (or sends it away) and does not go on: the audience sees no bar unasked
        this.suppressClick = true;
        this.toggleBar();
      }
    }
  }

  /** a tap (or click) without moving while zoomed: two in a row go back to the whole slide; a finger's brings the bar */
  private tap(e: PointerEvent): void {
    const now = performance.now();
    const l = this.lastTap;
    if (l && now - l.t < 320 && Math.hypot(e.clientX - l.x, e.clientY - l.y) < 30) { this.lastTap = null; this.resetZoom(); return; }
    this.lastTap = { t: now, x: e.clientX, y: e.clientY };
    if (e.pointerType !== 'mouse' && !this.onControl(e)) this.toggleBar();
  }

  private click(e: MouseEvent): void {
    if (this.fromUi(e)) return;
    if (this.tool || this.zoomed || this.suppressClick) { e.preventDefault(); e.stopPropagation(); }
    this.suppressClick = false;
  }

  private dblclick(e: MouseEvent): void {
    if (this.fromUi(e)) return;
    if (this.zoomed) { e.preventDefault(); e.stopPropagation(); this.resetZoom(); }
  }

  /* -------------------------------------------------------------- drawing on the slide */

  /** the eraser at (x, y) on screen: the strokes it touches go — anyone's, on every screen */
  private eraseAt(x: number, y: number, g: Extract<Gesture, { kind: 'draw' }>): void {
    if (!g.f) return;
    const key = this.slideNow();
    const list = this.strokes;
    if (!list.length) return;
    const hit = new Set(strokesHit(list, toSlide({ x, y }, g.f), ERASER_PX / g.f.k).map(i => list[i]));
    if (!hit.size) return;
    g.erased = true;
    this.share.erase([...hit].map(s => s.id).filter((id): id is string => !!id));
    const own = this.ink.get(key);
    if (own) this.ink.set(key, own.filter(s => !hit.has(s)));
    this.share.inkChanged();
    this.renderInk();
    this.publish(true);
  }

  /** a stroke being drawn given up (another slide, a second finger, another tool) */
  private cancelDraw(): void {
    const drawing = this.gesture?.kind === 'draw' && !!this.gesture.stroke;
    if (this.gesture?.kind === 'draw') this.gesture = null;
    this.drawG?.replaceChildren();
    if (drawing) this.publish(true);
  }

  /** the slide's drawings drawn again, and those the others are drawing on it */
  private renderInk(): void {
    const key = this.slideNow();
    const list = this.strokes;
    this.strokesG.innerHTML = list.map(strokeSvg).join('');
    this.remoteG.innerHTML = this.share.liveOn(key).map(strokeSvg).join('');
    this.clearBtn.hidden = !list.length;
    this.placeInk();
  }

  /* -------------------------------------------------------------- the other screens */

  /**
   * This presenter's state to the other screens: at once (`now`: a stroke ended, a move), else at most
   * every SHARE_MS while a stroke or the laser moves. Its strokes in slide units; the stroke being drawn;
   * the laser's trail (its newest points) or held trace, in slide units too.
   */
  private publish(now = false): void {
    if (!this.host.share || !this.placed) return;
    const due = this.sharedAt + SHARE_MS - performance.now();
    if (!now && due > 0) {
      if (this.shareTimer === undefined) this.shareTimer = setTimeout(() => { this.shareTimer = undefined; this.publish(true); }, due);
      return;
    }
    clearTimeout(this.shareTimer);
    this.shareTimer = undefined;
    this.sharedAt = performance.now();
    const key = this.slideNow();
    const g = this.gesture;
    const live = g?.kind === 'draw' && g.stroke?.id && g.stroke.pts.length ? { k: key, s: encodeStroke(g.stroke as InkStroke & { id: string }) } : null;
    this.host.share(this.share.state(this.ink, key, live, this.laserShare(key)));
  }

  /** the laser for the others: its newest points (held: the whole trace), in slide units */
  private laserShare(key: string): PresentState['laser'] {
    if (this.tool !== 'laser') return null;
    const f = inkFrame(this.view, this.host.base());
    if (!f) return null;
    let pts = (this.held ?? this.tail).slice(this.held ? -HELD_PTS : -TRAIL_PTS);
    if (!pts.length && this.head) pts = [{ ...this.head, t: 0 }];
    if (!pts.length) return null;
    const units = pts.map(p => toSlide(p, f));
    return { k: key, n: Math.max(0, this.laserN - pts.length), pts: encodePts(this.held ? simplifyPts(units, 0.5) : units), held: !!this.held };
  }

  /**
   * The others' lasers as they are now: a moving one's new points join its trail (with the time they
   * came, so it fades here as there), a held trace is taken whole; one let go fades out.
   */
  private takeLasers(): void {
    const now = performance.now();
    const lasers = this.share.lasers();
    for (const [client, l] of this.peerLasers) {
      const n = lasers.get(client);
      if (!n || n.k !== l.k || !n.held) { if (l.held) this.fadeTrace(l.held, l.k); l.held = null; }
      if (!n) this.peerLasers.delete(client);
    }
    for (const [client, n] of lasers) {
      let l = this.peerLasers.get(client);
      if (!l || l.k !== n.k) { l = { k: n.k, last: -1, trail: [], held: null, head: null }; this.peerLasers.set(client, l); }
      const cur = l;
      if (n.held) cur.held = n.pts;
      else n.pts.forEach((p, i) => { if (n.n + i > cur.last) cur.trail.push({ x: p[0], y: p[1], t: now }); });
      cur.last = Math.max(cur.last, n.n + n.pts.length - 1);
      if (cur.trail.length > 120) cur.trail.splice(0, cur.trail.length - 120);
      cur.head = n.pts[n.pts.length - 1];
    }
  }

  /** another's held trace let go: it lingers and fades, as this screen's own does */
  private fadeTrace(pts: readonly Pt[], key: string): void {
    const f = inkFrame(this.view, this.host.base());
    if (!f || key !== this.slideNow() || !pts.length) return;
    const g = this.doc.createElementNS('http://www.w3.org/2000/svg', 'g');
    g.setAttribute('class', 'trace fade');
    g.innerHTML = traceSvg(pts.map(([x, y]) => ({ x: f.ox + f.k * x, y: f.oy + f.k * y })), LASER_COLOR, false);
    this.svg.insertBefore(g, this.live);
    setTimeout(() => g.remove(), LASER_FADE_MS + 60);
  }

  /** the others' lasers on the slide shown, as SVG in screen px; `fading`: a trail still fades */
  private peerLaserSvg(now: number): { html: string; fading: boolean } {
    const f = inkFrame(this.view, this.host.base());
    if (!f || !this.peerLasers.size) return { html: '', fading: false };
    const key = this.slideNow();
    const on = (p: readonly [number, number]) => ({ x: f.ox + f.k * p[0], y: f.oy + f.k * p[1] });
    let html = '', fading = false;
    for (const l of this.peerLasers.values()) {
      if (l.k !== key) continue;
      if (l.held) { html += `<g class="trace held">${traceSvg(l.held.map(on))}</g>`; continue; }
      l.trail = liveTail(l.trail, now);
      html += tailSvg(l.trail.map(p => ({ ...on([p.x, p.y]), t: p.t })), now);
      if (l.head) { const h = on(l.head); html += dotSvg(h.x, h.y); }
      if (l.trail.length > 1) fading = true;
    }
    return { html, fading };
  }

  /** the drawings put where the slide is now (its fit, the zoom) */
  private placeInk(): void {
    const f = inkFrame(this.view, this.host.base());
    if (f) this.inkG.setAttribute('transform', `matrix(${f.k} 0 0 ${f.k} ${f.ox} ${f.oy})`);
    this.inkG.style.display = f ? '' : 'none';
  }

  private scheduleInk(): void {
    if (this.inkRaf) return;
    this.inkRaf = requestAnimationFrame(() => { this.inkRaf = 0; this.placeInk(); });
  }

  /* -------------------------------------------------------------- drawing the laser */

  /** the held trace lingers and fades (CSS), then goes */
  private endHeld(): void {
    const pts = this.held;
    this.held = null;
    if (!pts || !pts.length) return;
    const g = this.doc.createElementNS('http://www.w3.org/2000/svg', 'g');
    g.setAttribute('class', 'trace fade');
    g.innerHTML = traceSvg(pts, LASER_COLOR, false);
    this.svg.insertBefore(g, this.live);
    setTimeout(() => g.remove(), LASER_FADE_MS + 60);
  }

  private schedule(): void {
    if (this.raf) return;
    this.raf = requestAnimationFrame(() => { this.raf = 0; this.render(); });
  }

  private render(): void {
    const now = performance.now();
    let html = '';
    if (this.tool === 'laser') {
      if (this.held) html = `<g class="trace held">${traceSvg(this.held)}</g>`;
      else {
        this.tail = liveTail(this.tail, now);
        html = tailSvg(this.tail, now);
        if (this.head) html += dotSvg(this.head.x, this.head.y);
      }
    }
    // the other screens' lasers, under this one's
    const peers = this.peerLaserSvg(now);
    this.live.innerHTML = peers.html + html;
    if ((this.tool === 'laser' && !this.held && this.tail.length > 1) || peers.fading) this.schedule();
  }
}
