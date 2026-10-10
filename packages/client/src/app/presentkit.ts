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
 * - a small control bar (bottom left: ◀, n / N, ▶, laser, back to the whole slide, end), shown while
 *   the pointer moves.
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
  .olpk-zoomed:not(.olpk-laser-on), .olpk-zoomed:not(.olpk-laser-on) * { cursor: grab !important; }
  .olpk-panning, .olpk-panning * { cursor: grabbing !important; }`;

const UI_CSS = `:host { all: initial; }
  svg.laser { position: fixed; left: 0; top: 0; width: 100vw; height: 100vh; overflow: visible; pointer-events: none; }
  svg.laser .fade { animation: olpk-fade ${LASER_FADE_MS}ms ease-out forwards; }
  @keyframes olpk-fade { from { opacity: 1; } to { opacity: 0; } }
  .bar { position: fixed; left: 16px; bottom: 16px; display: flex; align-items: center; gap: 2px; padding: 4px; border-radius: 22px;
    background: rgba(32, 33, 36, 0.84); color: #fff; font: 13px/1 system-ui, -apple-system, 'Segoe UI', sans-serif; box-shadow: 0 2px 12px rgba(0,0,0,0.35);
    opacity: 0; transition: opacity 0.3s; pointer-events: none; user-select: none; -webkit-user-select: none; }
  .bar.show { opacity: 1; pointer-events: auto; }
  button { all: unset; box-sizing: border-box; min-width: 32px; height: 32px; padding: 0 9px; border-radius: 16px; display: inline-flex; align-items: center;
    justify-content: center; gap: 5px; cursor: pointer !important; color: #fff; font: inherit; white-space: nowrap; }
  button:hover { background: rgba(255, 255, 255, 0.14); }
  button:focus-visible { outline: 2px solid #8ab4f8; }
  button.on { background: rgba(255, 45, 85, 0.32); }
  button[hidden] { display: none; }
  .pos { padding: 0 8px; font-variant-numeric: tabular-nums; color: rgba(255, 255, 255, 0.86); white-space: nowrap; }
  .dot { width: 12px; height: 12px; border-radius: 50%; background: radial-gradient(circle, #fff 0 18%, ${LASER_COLOR} 24% 55%, rgba(255,45,85,0.35) 62%, transparent 72%); }`;

const ICON = {
  prev: '<svg width="16" height="16" viewBox="0 0 16 16"><path d="M10.5 3 5.5 8l5 5" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/></svg>',
  next: '<svg width="16" height="16" viewBox="0 0 16 16"><path d="M5.5 3l5 5-5 5" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/></svg>',
  exit: '<svg width="14" height="14" viewBox="0 0 14 14"><path d="M3 3l8 8M11 3l-8 8" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/></svg>',
  fit: '<svg width="16" height="16" viewBox="0 0 16 16"><path d="M2.5 6V2.5H6M10 2.5h3.5V6M13.5 10v3.5H10M6 13.5H2.5V10" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"/></svg>',
};

type Gesture =
  | { kind: 'pinch'; ids: [number, number]; d0: number; c0: { x: number; y: number }; v0: ZoomView }
  | { kind: 'pan'; id: number; x: number; y: number; moved: boolean }
  | { kind: 'laser'; id: number }
  | { kind: 'swipe'; id: number; x0: number; y0: number; t0: number; moved: boolean };

/**
 * The laser, the zoom and the bar on a presenting surface. The presenter keeps its own keys and
 * clicks; it asks `key()` first, calls `slideChanged()` when it shows another slide (the zoom goes
 * back to the whole slide) and `refresh()` when its position text changes.
 */
export class PresentKit {
  readonly host: PresentKitHost;
  private win: Window;
  private doc: Document;
  private ui: HTMLElement;
  private svg: SVGSVGElement;
  private live: SVGGElement;
  private bar: HTMLElement;
  private posEl: HTMLElement;
  private laserBtn: HTMLElement;
  private zoomBtn: HTMLElement;
  private style: HTMLStyleElement;
  private laser = false;
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
    sr.innerHTML = `<style>${UI_CSS}</style><svg class="laser" xmlns="http://www.w3.org/2000/svg"><g class="live"></g></svg>
      <div class="bar" role="toolbar" aria-label="Presentation">
        <button data-k="prev" title="Previous (←)" aria-label="Previous">${ICON.prev}</button>
        <span class="pos"></span>
        <button data-k="next" title="Next (→)" aria-label="Next">${ICON.next}</button>
        <button data-k="laser" title="Laser pointer (L)" aria-label="Laser pointer" aria-pressed="false"><span class="dot"></span></button>
        <button data-k="zoom" title="Back to the whole slide (0)" hidden>${ICON.fit}<span class="z"></span></button>
        <button data-k="exit" title="End the presentation (Esc)" aria-label="End the presentation">${ICON.exit}</button>
      </div>`;
    this.svg = sr.querySelector('svg.laser') as SVGSVGElement;
    this.live = sr.querySelector('g.live') as SVGGElement;
    this.bar = sr.querySelector('.bar') as HTMLElement;
    this.posEl = sr.querySelector('.pos') as HTMLElement;
    this.laserBtn = sr.querySelector('[data-k="laser"]') as HTMLElement;
    this.zoomBtn = sr.querySelector('[data-k="zoom"]') as HTMLElement;
    for (const b of Array.from(sr.querySelectorAll<HTMLElement>('button'))) {
      // the bar's own clicks: never a click on the slide (that would advance)
      b.addEventListener('click', e => { e.stopPropagation(); e.preventDefault(); this.button(b.dataset.k!); });
      b.addEventListener('pointerdown', e => e.stopPropagation());
    }
    this.bar.addEventListener('pointerenter', () => this.showBar());
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
    on('resize', () => this.resetZoom());
    this.refresh();
  }

  get zoomed(): boolean { return isZoomed(this.view); }
  get laserOn(): boolean { return this.laser; }
  get zoom(): ZoomView { return { ...this.view }; }

  /** the presenter's keys first: L, 0, +, -, Escape (back to the whole slide). True: taken. */
  key(e: KeyboardEvent, typing = false): boolean {
    if (e.ctrlKey || e.metaKey || e.altKey) return false;
    const k = e.key;
    if (k === 'l' || k === 'L') { this.setLaser(!this.laser); return true; }
    if (k === '0' && !typing && this.zoomed) { this.resetZoom(); return true; }
    if (k === '+' || k === '=') { this.zoomBy(1.25); return true; }
    if (k === '-' || k === '_') { if (this.zoomed) this.zoomBy(0.8); return true; }
    if (k === 'Escape' && this.zoomed) { this.resetZoom(); return true; }
    return false;
  }

  /** another slide shown: the whole of it */
  slideChanged(): void { this.resetZoom(); this.refresh(); }

  refresh(): void { this.posEl.textContent = this.host.position(); }

  setLaser(on: boolean): void {
    this.laser = on;
    this.host.root.classList.toggle('olpk-laser-on', on);
    this.laserBtn.classList.toggle('on', on);
    this.laserBtn.setAttribute('aria-pressed', String(on));
    if (!on) { this.endHeld(); this.tail = []; this.head = null; }
    this.render();
  }

  resetZoom(): void { if (this.zoomed || this.view.x || this.view.y) this.setView({ ...IDENTITY }); }

  zoomBy(f: number, cx = this.win.innerWidth / 2, cy = this.win.innerHeight / 2): void {
    this.setView(zoomAt(this.view, f, cx, cy, this.host.base(), this.win.innerWidth, this.win.innerHeight));
  }

  destroy(): void {
    for (const off of this.offs) off();
    this.offs = [];
    cancelAnimationFrame(this.raf);
    clearTimeout(this.idle);
    this.ui.remove();
    this.style.remove();
    this.host.root.classList.remove('olpk-surface', 'olpk-laser-on', 'olpk-zoomed', 'olpk-panning');
  }

  /* -------------------------------------------------------------- the bar */

  private button(k: string): void {
    this.showBar();
    if (k === 'prev') this.host.prev();
    else if (k === 'next') this.host.next();
    else if (k === 'laser') this.setLaser(!this.laser);
    else if (k === 'zoom') this.resetZoom();
    else if (k === 'exit') this.host.exit();
  }

  showBar(): void {
    this.refresh();
    this.bar.classList.add('show');
    clearTimeout(this.idle);
    this.idle = setTimeout(() => {
      if (this.bar.matches(':hover')) { this.showBar(); return; }
      this.bar.classList.remove('show');
    }, IDLE_MS);
  }

  private fromUi(e: Event): boolean { return e.composedPath().includes(this.ui); }

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

  private down(e: PointerEvent): void {
    if (this.fromUi(e)) return;
    if (e.pointerType !== 'mouse') this.showBar();
    this.pointers.set(e.pointerId, { x: e.clientX, y: e.clientY, type: e.pointerType });
    this.suppressClick = false;
    if (e.pointerType === 'touch' && this.pointers.size >= 2) {
      const ids = [...this.pointers.keys()].slice(-2) as [number, number];
      const [a, b] = ids.map(id => this.pointers.get(id)!);
      this.endHeld();
      this.gesture = { kind: 'pinch', ids, d0: Math.hypot(a.x - b.x, a.y - b.y), c0: { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 }, v0: { ...this.view } };
      this.suppressClick = true;
      e.preventDefault();
      return;
    }
    if (this.pointers.size > 1) return;
    if (e.pointerType === 'mouse' && e.button !== 0) return;
    const pt = { x: e.clientX, y: e.clientY, t: performance.now() };
    if (this.laser) {
      this.held = [pt];
      this.head = pt;
      this.tail = [];
      this.gesture = { kind: 'laser', id: e.pointerId };
      this.suppressClick = true;
      e.preventDefault();
      this.capture(e);
      this.render();
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
    if (e.pointerType === 'mouse') this.showBar();
    const g = this.gesture;
    const W = this.win.innerWidth, H = this.win.innerHeight;
    if (g?.kind === 'pinch') {
      const a = this.pointers.get(g.ids[0]), b = this.pointers.get(g.ids[1]);
      if (!a || !b) return;
      e.preventDefault();
      this.setView(pinchView(g.v0, g.d0, Math.hypot(a.x - b.x, a.y - b.y), g.c0, { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 }, this.host.base(), W, H));
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
    if (this.laser && e.pointerType === 'mouse' && !e.buttons) {
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
    if ((g.kind === 'laser' || g.kind === 'pan' || g.kind === 'swipe') && g.id !== e.pointerId) return;
    this.gesture = null;
    if (g.kind === 'laser') {
      this.endHeld();
      if (e.pointerType !== 'mouse') this.head = null;
      this.render();
    } else if (g.kind === 'pan') {
      this.host.root.classList.remove('olpk-panning');
      if (!g.moved) this.tap(e);
    } else if (g.kind === 'swipe' && !cancelled) {
      const dx = e.clientX - g.x0, dy = e.clientY - g.y0;
      if (g.moved && Math.abs(dx) > 60 && Math.abs(dx) > 1.5 * Math.abs(dy) && performance.now() - g.t0 < 900) {
        this.suppressClick = true;
        if (dx < 0) this.host.next(); else this.host.prev();
      }
    }
  }

  /** a tap (or click) without moving while zoomed: two in a row go back to the whole slide */
  private tap(e: PointerEvent): void {
    const now = performance.now();
    const l = this.lastTap;
    if (l && now - l.t < 320 && Math.hypot(e.clientX - l.x, e.clientY - l.y) < 30) { this.lastTap = null; this.resetZoom(); return; }
    this.lastTap = { t: now, x: e.clientX, y: e.clientY };
  }

  private click(e: MouseEvent): void {
    if (this.fromUi(e)) return;
    if (this.laser || this.zoomed || this.suppressClick) { e.preventDefault(); e.stopPropagation(); }
    this.suppressClick = false;
  }

  private dblclick(e: MouseEvent): void {
    if (this.fromUi(e)) return;
    if (this.zoomed) { e.preventDefault(); e.stopPropagation(); this.resetZoom(); }
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
    if (this.laser) {
      if (this.held) html = `<g class="trace held">${traceSvg(this.held)}</g>`;
      else {
        this.tail = liveTail(this.tail, now);
        html = tailSvg(this.tail, now);
        if (this.head) html += dotSvg(this.head.x, this.head.y);
      }
    }
    this.live.innerHTML = html;
    if (this.laser && !this.held && this.tail.length > 1) this.schedule();
  }
}
