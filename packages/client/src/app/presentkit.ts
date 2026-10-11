/**
 * Presenting tools shared by the two presenters — HTML decks (deliverable/runtime/present.ts, in the
 * sandboxed frame) and layout / beamer documents (editor/layout/present.ts):
 *
 * - the laser pointer, with the whiteboard's look (a wide soft glow under a bright core, a dot with a
 *   white centre at the head; app/BoardEditor.tsx): moved, it leaves a short tail that fades; pressed
 *   and dragged (or drawn with a finger or pen), its trace stays while held and fades once lifted.
 *   While it is on, clicks don't advance (the keys still do);
 * - pinch to zoom and pan: a trackpad pinch (Ctrl + wheel, as Chromium and Firefox report it; Safari's
 *   gesture events), two fingers on a touch screen, `+` / `-`; zoomed, a drag or a two-finger scroll
 *   pans, a click does not advance, `0`, a double click / tap or Escape go back to the whole slide;
 * - drawing on the slides (Keynote's and PowerPoint's presenting ink): a pen, a highlighter, an
 *   eraser (Ctrl+P, Ctrl+I, Ctrl+E; Ctrl+A or Escape put the tool away; E clears the slide), in a few
 *   colours. The drawings belong to their slide (kept while presenting, never saved) and zoom with
 *   it. Once an Apple Pencil (a pen) has drawn, fingers no longer draw: they swipe, tap and pinch;
 * - a small control bar (bottom left: ◀, n / N, ▶, the drawing tools, laser, back to the whole
 *   slide, end). The audience sees the screen (AirPlay mirroring, a shared screen), so it stays out
 *   of sight until asked for: a tap on a touch screen (a tap no longer goes on — a swipe does) or the
 *   mouse near the bottom edge brings it, and it fades out again a few seconds later, or as soon as
 *   a stroke begins.
 *
 * DOM only — no framework — so the runtime bundle stays small. Everything is drawn in screen space
 * (CSS px of the window, not scaled with the slide) inside a shadow root, out of the page's styles.
 * The zoom itself is the presenter's to draw (`apply`): screen point q → s·q + (x, y) on top of the
 * slide's fit.
 */
import { laserPathD } from '@overlyx/core/ink.ts';

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

export type PresentTool = 'laser' | 'pen' | 'marker' | 'eraser';
/** a stroke drawn on a slide: points in slide units (SLIDE_UNITS), width too */
export interface InkStroke { marker: boolean; color: string; w: number; pts: [number, number][] }

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
}

const DOC_CSS = `.olpk-surface, .olpk-surface * { touch-action: none !important; }
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
  fit: '<svg width="16" height="16" viewBox="0 0 16 16"><path d="M2.5 6V2.5H6M10 2.5h3.5V6M13.5 10v3.5H10M6 13.5H2.5V10" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"/></svg>',
};

type Gesture =
  | { kind: 'pinch'; ids: [number, number]; d0: number; c0: { x: number; y: number }; v0: ZoomView }
  | { kind: 'pan'; id: number; x: number; y: number; moved: boolean }
  | { kind: 'laser'; id: number }
  /** a drawing tool's stroke (or the eraser's sweep); `moved`: past a tap */
  | { kind: 'draw'; id: number; x0: number; y0: number; moved: boolean; pen: boolean; erased: boolean; stroke: InkStroke | null; f: { k: number; ox: number; oy: number } | null }
  | { kind: 'swipe'; id: number; x0: number; y0: number; t0: number; moved: boolean };

/**
 * The laser, the drawing tools, the zoom and the bar on a presenting surface. The presenter keeps its
 * own keys and clicks; it asks `key()` first, calls `slideChanged()` when it shows another slide (the
 * zoom goes back to the whole slide, that slide's drawings show) and `refresh()` when its position
 * text changes. The drawings are kept by that text ("3 / 12": one set per slide, whatever its step).
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
  private zoomBtn: HTMLElement;
  private clearBtn: HTMLElement;
  private colorsEl: HTMLElement;
  private style: HTMLStyleElement;
  private tool: PresentTool | null = null;
  private penColor: string = INK_COLORS[0];
  private markerColor: string = INK_COLORS[1];
  /** the drawings, per slide (by its position text) */
  private ink = new Map<string, InkStroke[]>();
  /** an Apple Pencil (a pen) has drawn: fingers no longer draw */
  private penSeen = false;
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
    sr.innerHTML = `<style>${UI_CSS}</style><svg class="laser" xmlns="http://www.w3.org/2000/svg"><g class="ink"><g class="strokes"></g><g class="drawing"></g></g><g class="live"></g></svg>
      <div class="bar" role="toolbar" aria-label="Presentation">
        <button data-k="prev" title="Previous (←)" aria-label="Previous">${ICON.prev}</button>
        <span class="pos"></span>
        <button data-k="next" title="Next (→)" aria-label="Next">${ICON.next}</button>
        <span class="sep"></span>
        <button data-k="pen" title="Pen (Ctrl+P)" aria-label="Pen" aria-pressed="false">${ICON.pen}</button>
        <button data-k="marker" title="Highlighter (Ctrl+I)" aria-label="Highlighter" aria-pressed="false">${ICON.marker}</button>
        <button data-k="eraser" title="Eraser (Ctrl+E)" aria-label="Eraser" aria-pressed="false">${ICON.eraser}</button>
        <button data-k="laser" title="Laser pointer (L)" aria-label="Laser pointer" aria-pressed="false"><span class="dot"></span></button>
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
    this.bar = sr.querySelector('.bar') as HTMLElement;
    this.posEl = sr.querySelector('.pos') as HTMLElement;
    this.laserBtn = sr.querySelector('[data-k="laser"]') as HTMLElement;
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
    this.refresh();
  }

  get zoomed(): boolean { return isZoomed(this.view); }
  get laserOn(): boolean { return this.tool === 'laser'; }
  /** the drawing tool (or the laser) in hand, null: none */
  get toolOn(): PresentTool | null { return this.tool; }
  /** the drawings on the slide shown */
  get strokes(): readonly InkStroke[] { return this.ink.get(this.host.position()) ?? []; }
  get zoom(): ZoomView { return { ...this.view }; }

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
  slideChanged(): void { this.cancelDraw(); this.resetZoom(); this.refresh(); this.renderInk(); }

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
    for (const b of Array.from(this.bar.querySelectorAll<HTMLElement>('button[aria-pressed]'))) {
      const on = b.dataset.k === t;
      b.classList.toggle('on', on);
      b.setAttribute('aria-pressed', String(on));
    }
    this.colorsEl.hidden = t !== 'pen' && t !== 'marker';
    this.markColor();
    if (was === 'laser' && t !== 'laser') { this.endHeld(); this.tail = []; this.head = null; }
    this.render();
  }

  /** the slide's drawings cleared */
  clearInk(): void {
    this.cancelDraw();
    this.ink.delete(this.host.position());
    this.renderInk();
  }

  resetZoom(): void { if (this.zoomed || this.view.x || this.view.y) this.setView({ ...IDENTITY }); }

  zoomBy(f: number, cx = this.win.innerWidth / 2, cy = this.win.innerHeight / 2): void {
    this.setView(zoomAt(this.view, f, cx, cy, this.host.base(), this.win.innerWidth, this.win.innerHeight));
  }

  destroy(): void {
    for (const off of this.offs) off();
    this.offs = [];
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

  /** this pointer draws with the tool in hand (once a pen has drawn, a finger does not) */
  private drawsWith(e: PointerEvent): boolean {
    const t = this.tool;
    return (t === 'pen' || t === 'marker' || t === 'eraser') && (e.pointerType !== 'touch' || !this.penSeen);
  }

  private down(e: PointerEvent): void {
    this.lastType = e.pointerType;
    if (this.fromUi(e)) return;
    // a palm on the glass while the pencil writes: nothing
    if (e.pointerType === 'touch' && this.gesture?.kind === 'draw' && this.gesture.pen) return;
    if (e.pointerType === 'pen' && this.drawsWith(e)) this.penSeen = true;
    this.pointers.set(e.pointerId, { x: e.clientX, y: e.clientY, type: e.pointerType });
    this.suppressClick = false;
    if (e.pointerType === 'touch' && this.pointers.size >= 2) {
      const ids = [...this.pointers.keys()].slice(-2) as [number, number];
      const [a, b] = ids.map(id => this.pointers.get(id)!);
      this.endHeld();
      this.cancelDraw();
      this.gesture = { kind: 'pinch', ids, d0: Math.hypot(a.x - b.x, a.y - b.y), c0: { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 }, v0: { ...this.view } };
      this.suppressClick = true;
      e.preventDefault();
      return;
    }
    if (this.pointers.size > 1) return;
    if (e.pointerType === 'mouse' && e.button !== 0) return;
    const pt = { x: e.clientX, y: e.clientY, t: performance.now() };
    if (this.tool === 'laser') {
      this.held = [pt];
      this.head = pt;
      this.tail = [];
      this.gesture = { kind: 'laser', id: e.pointerId };
      this.suppressClick = true;
      e.preventDefault();
      this.capture(e);
      this.render();
    } else if (this.drawsWith(e)) {
      const g: Gesture = { kind: 'draw', id: e.pointerId, x0: e.clientX, y0: e.clientY, moved: false, pen: e.pointerType === 'pen', erased: false, stroke: null, f: inkFrame(this.view, this.host.base()) };
      this.gesture = g;
      this.suppressClick = true;
      e.preventDefault();
      this.capture(e);
      if (this.tool === 'eraser') this.eraseAt(e.clientX, e.clientY, g);
    } else if (this.zoomed) {
      this.gesture = { kind: 'pan', id: e.pointerId, x: e.clientX, y: e.clientY, moved: false };
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
      this.setView(pinchView(g.v0, g.d0, Math.hypot(a.x - b.x, a.y - b.y), g.c0, { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 }, this.host.base(), W, H));
      return;
    }
    if (g?.kind === 'draw' && g.id === e.pointerId) {
      e.preventDefault();
      if (!g.moved) {
        if (Math.hypot(e.clientX - g.x0, e.clientY - g.y0) < 4) return;
        g.moved = true;
        // the audience sees the stroke, not the bar
        this.hideBar();
        if (this.tool !== 'eraser' && g.f) {
          const marker = this.tool === 'marker';
          g.stroke = { marker, color: marker ? this.markerColor : this.penColor, w: (marker ? MARKER_PX : PEN_PX) / g.f.k, pts: [toSlide({ x: g.x0, y: g.y0 }, g.f)] };
        }
      }
      const evs = e.getCoalescedEvents?.() ?? [];
      for (const c of evs.length ? evs : [e]) {
        if (this.tool === 'eraser') this.eraseAt(c.clientX, c.clientY, g);
        else if (g.stroke && g.f) {
          const q = toSlide({ x: c.clientX, y: c.clientY }, g.f);
          const last = g.stroke.pts[g.stroke.pts.length - 1];
          if (Math.hypot(q[0] - last[0], q[1] - last[1]) > 0.05) g.stroke.pts.push(q);
        }
      }
      if (g.stroke) this.drawG.innerHTML = strokeSvg(g.stroke);
      return;
    }
    if (g?.kind === 'laser' && g.id === e.pointerId && this.held) {
      const pt = { x: e.clientX, y: e.clientY, t: performance.now() };
      this.held.push(pt);
      this.head = pt;
      this.schedule();
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
      this.schedule();
    }
  }

  private up(e: PointerEvent, cancelled = false): void {
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
    } else if (g.kind === 'draw') {
      this.drawG.replaceChildren();
      if (g.stroke) {
        const key = this.host.position();
        this.ink.set(key, [...(this.ink.get(key) ?? []), g.stroke]);
        this.renderInk();
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

  /** the eraser at (x, y) on screen: the strokes it touches go */
  private eraseAt(x: number, y: number, g: Extract<Gesture, { kind: 'draw' }>): void {
    if (!g.f) return;
    const key = this.host.position();
    const list = this.ink.get(key);
    if (!list?.length) return;
    const hit = strokesHit(list, toSlide({ x, y }, g.f), ERASER_PX / g.f.k);
    if (!hit.length) return;
    g.erased = true;
    this.ink.set(key, list.filter((_, i) => !hit.includes(i)));
    this.renderInk();
  }

  /** a stroke being drawn given up (another slide, a second finger, another tool) */
  private cancelDraw(): void {
    if (this.gesture?.kind === 'draw') this.gesture = null;
    this.drawG?.replaceChildren();
  }

  /** the slide's drawings drawn again */
  private renderInk(): void {
    const list = this.ink.get(this.host.position()) ?? [];
    this.strokesG.innerHTML = list.map(strokeSvg).join('');
    this.clearBtn.hidden = !list.length;
    this.placeInk();
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
    this.live.innerHTML = html;
    if (this.tool === 'laser' && !this.held && this.tail.length > 1) this.schedule();
  }
}
