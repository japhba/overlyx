/**
 * Display glitches on a touch screen (core glitch.ts says which), caught as they happen and reported
 * as errors are (POST /api/client-glitch → the reports, kind `client-glitch`; `sudo overlyx-telemetry
 * reports` lists them). Each report has the screen's measurements and the last kinds of input before
 * it — a pointer down on a toolbar, the focus going to a formula below the keyboard, the keyboard
 * coming up — never text, coordinates of what was drawn, or names.
 *
 * The window never scrolls while the editor is shown (every pane scrolls itself): when it has, with
 * no keyboard up, it scrolls back, and the report says so. A stroke's points are checked by the ink
 * engines (strokeWatch here; the deck canvas's runtime sends its own, DeliverableEditor forwards it).
 */
import { api, API_BASE } from './api';
import { viewKind, interactionTarget } from './usage';
import { StrokeWatch, TRAIL_MAX, cleanGlitch, type GlitchFields, type GlitchKind, type InkEngine } from '@overlyx/core/glitch.ts';

/** a shift lasting this long is one (iOS's own scrolling to a field settles sooner) */
const SETTLE_MS = 800;
/** a zoom lasting this long is one (a pinch passing) */
const ZOOM_MS = 2000;
const REPORTS_MAX = 8;

let watching = false;
let reports = 0;
const lastSent = new Map<string, number>();
const trail: { t: number; what: string }[] = [];

const touchScreen = () => typeof navigator !== 'undefined' && navigator.maxTouchPoints > 0;

function note(what: string): void {
  trail.push({ t: performance.now(), what });
  if (trail.length > TRAIL_MAX) trail.shift();
}

/** the screen, for every report */
function screenFields(): GlitchFields {
  const standalone = (navigator as { standalone?: boolean }).standalone === true || matchMedia('(display-mode: standalone)').matches;
  return {
    app: standalone ? 'home-screen' : 'browser', orientation: innerHeight > innerWidth ? 'portrait' : 'landscape',
    width: innerWidth, height: innerHeight, view: viewKind(location.hash), ui: document.documentElement.dataset.ui === 'modern' ? 'modern' : 'classic',
  };
}

function send(kind: GlitchKind, fields: GlitchFields): void {
  if (reports >= REPORTS_MAX) return;
  const now = performance.now();
  const g = cleanGlitch(kind, { ...screenFields(), ...fields }, trail.map(e => `${Math.round(now - e.t)} ${e.what}`));
  if (!g) return;
  // the same glitch once in two minutes: the server counts the rest
  const key = `${kind} ${g.fields.engine ?? ''} ${g.fields.scroller ?? ''} ${g.fields.keyboard ?? ''} ${g.fields.focus ?? ''}`;
  if (now - (lastSent.get(key) ?? -Infinity) < 120000) return;
  lastSent.set(key, now);
  reports++;
  api.clientGlitch(g).catch(() => {});
}

/** a stroke's points, checked when it ends (core glitch.ts StrokeWatch) — null where nothing is reported */
export function strokeWatch(engine: InkEngine, e: PointerEvent, at: { win?: Window; ox?: number; oy?: number } = {}): StrokeWatch | null {
  if (!watching) return null;
  const win = at.win ?? window;
  const w = new StrokeWatch(engine, e.pointerType, { w: win.innerWidth, h: win.innerHeight });
  w.add(e.clientX, e.clientY, e.timeStamp, 'down', at.ox, at.oy);
  return w;
}

/** the stroke ended: a jump in it is reported */
export function strokeEnded(w: StrokeWatch | null): void {
  const f = w?.end();
  if (f) reportJump(f);
}

/** a jump found elsewhere (the deck canvas's frame) */
export function reportJump(fields: GlitchFields): void {
  if (watching) send('jump', fields);
}

/* ------------------------------------------------------------------ what had the focus */

function focusKind(el: Element | null): string {
  if (!el || el === document.body || el === document.documentElement) return 'none';
  if (el.localName === 'iframe') return 'frame';
  if (el.closest('.lm-field, .lm-input')) return 'math';
  if (el.closest('.ProseMirror')) return 'text';
  if (el.localName === 'input') return 'input';
  if (el.localName === 'textarea') return 'textarea';
  if ((el as HTMLElement).isContentEditable) return 'editable';
  if (el.localName === 'button') return 'button';
  return 'other';
}

function focusAt(el: Element | null, viewportHeight: number): string {
  if (!el || el === document.body) return 'none';
  const r = el.getBoundingClientRect();
  if (r.width * r.height < 4) return 'hidden';
  if (r.top >= viewportHeight) return 'below';
  if (r.bottom <= 0) return 'above';
  return 'on-screen';
}

/* ------------------------------------------------------------------ the interface out of place */

interface Viewport { layoutHeight: number; viewportHeight: number; viewportTop: number; zoom: number; keyboard: 'up' | 'bar' | 'down' }

function viewport(): Viewport {
  const vv = window.visualViewport;
  const layoutHeight = document.documentElement.clientHeight;
  const viewportHeight = vv ? vv.height : innerHeight, zoom = vv ? vv.scale : 1;
  // Both heights are in CSS pixels. Scaling just the visual height invents a keyboard at zoom < 1.
  // iOS shrinks the visual viewport, not the layout, for the keyboard: a hardware keyboard's bar of shortcuts is the small one
  const gap = layoutHeight - viewportHeight;
  return { layoutHeight, viewportHeight, viewportTop: vv ? vv.offsetTop : 0, zoom, keyboard: zoom > 1.05 ? 'down' : gap > 150 ? 'up' : gap > 24 ? 'bar' : 'down' };
}

/** a shift seen, until it is gone: when it began, and whether it has been reported */
let shift: { since: number; key: string; done: boolean } | null = null;
let zoomed: { since: number; done: boolean } | null = null;
/** a container that cannot be scrolled and was: checked again after SETTLE_MS */
const scrolledBoxes = new Set<HTMLElement>();

function check(): void {
  const app = document.querySelector('.app');
  const now = performance.now();
  if (!app || document.visibilityState !== 'visible') { shift = null; zoomed = null; return; }
  const v = viewport();
  const sy = Math.round(scrollY), sx = Math.round(scrollX);
  const el = document.activeElement;
  // A small viewport gap can remain after focus has gone. Nothing then needs the window moved
  // for the shortcut bar, but a focused field or a zoomed-in page may still need its current pan.
  const canRestore = v.zoom < 1.02 && (v.keyboard === 'down' || v.keyboard === 'bar' && focusKind(el) === 'none');
  // the window moved, or (with no keyboard to make room for) the visible part of the page did
  const out = sy > 1 || sx > 1 || (canRestore && v.viewportTop > 1);
  if (!out) shift = null;
  else {
    const key = `${v.keyboard} ${canRestore}`;
    if (!shift || shift.key !== key) shift = { since: now, key, done: false };
    else if (!shift.done && now - shift.since >= SETTLE_MS) {
      shift.done = true;
      // nothing to make room for: back where it belongs
      const restore = canRestore && (sy > 1 || sx > 1);
      const fields: GlitchFields = {
        scroller: 'window', scrollY: sy, scrollX: sx, appTop: Math.round(app.getBoundingClientRect().top),
        viewportTop: Math.round(v.viewportTop), viewportHeight: Math.round(v.viewportHeight), layoutHeight: v.layoutHeight, zoom: Math.round(v.zoom * 100) / 100,
        keyboard: v.keyboard, focus: focusKind(el), focusAt: focusAt(el, v.viewportHeight), lasted: Math.round(now - shift.since), restored: restore ? 'yes' : 'no',
      };
      send('shift', fields);
      if (restore) { scrollTo(0, 0); note('restored'); }
    }
  }
  if (v.zoom <= 1.05) zoomed = null;
  else if (!zoomed) zoomed = { since: now, done: false };
  else if (!zoomed.done && now - zoomed.since >= ZOOM_MS) {
    zoomed.done = true;
    send('zoom', { zoom: Math.round(v.zoom * 100) / 100, viewportTop: Math.round(v.viewportTop), viewportHeight: Math.round(v.viewportHeight), layoutHeight: v.layoutHeight, keyboard: v.keyboard, focus: focusKind(document.activeElement) });
  }
  for (const box of [...scrolledBoxes]) {
    if (!box.isConnected || box.scrollTop < 1 && box.scrollLeft < 1) { scrolledBoxes.delete(box); continue; }
    if (now - Number(box.dataset.olScrolledAt ?? now) < SETTLE_MS) continue;
    scrolledBoxes.delete(box);
    const el = document.activeElement;
    send('shift', {
      scroller: 'container', container: [...box.classList].find(c => /^[a-z][a-z0-9-]{0,39}$/.test(c)) ?? box.localName,
      scrollY: Math.round(box.scrollTop), scrollX: Math.round(box.scrollLeft), appTop: Math.round(app.getBoundingClientRect().top),
      viewportTop: Math.round(v.viewportTop), viewportHeight: Math.round(v.viewportHeight), layoutHeight: v.layoutHeight, zoom: Math.round(v.zoom * 100) / 100,
      keyboard: v.keyboard, focus: focusKind(el), focusAt: focusAt(el, v.viewportHeight), lasted: Math.round(now - Number(box.dataset.olScrolledAt)), restored: 'no',
    });
  }
}

let checkTimer: ReturnType<typeof setTimeout> | null = null;
/** look again once a shift could have settled */
function checkSoon(): void {
  check();
  if (checkTimer) clearTimeout(checkTimer);
  checkTimer = setTimeout(() => { checkTimer = null; check(); }, SETTLE_MS + 50);
}

/** whether an element cannot be scrolled (overflow hidden or clip) — asked once per element: panes scroll all the time */
const unscrollable = new WeakMap<Element, boolean>();

/** an element that cannot be scrolled and fills much of the screen, scrolled (a focus does that) */
function boxScrolled(ev: Event): void {
  const box = ev.target;
  if (!(box instanceof HTMLElement) || scrolledBoxes.has(box)) return;
  let fixed = unscrollable.get(box);
  if (fixed === undefined) { const cs = getComputedStyle(box); fixed = /hidden|clip/.test(cs.overflowY + cs.overflowX); unscrollable.set(box, fixed); }
  if (!fixed || !document.querySelector('.app')) return;
  const r = box.getBoundingClientRect();
  if (r.width * r.height < 0.5 * innerWidth * innerHeight) return;
  box.dataset.olScrolledAt = String(performance.now());
  scrolledBoxes.add(box);
  note(`scroll container ${Math.round(box.scrollTop)}`);
  checkSoon();
}

/** on a touch screen, in the web app: watch from now on */
export function initGlitchWatch(): void {
  if (watching || typeof window === 'undefined' || API_BASE !== '' || !touchScreen()) return;
  watching = true;
  const opts = { capture: true, passive: true };
  window.addEventListener('pointerdown', e => note(`down ${['pen', 'touch', 'mouse'].includes(e.pointerType) ? e.pointerType : 'touch'} ${interactionTarget(e.target)}`), opts);
  window.addEventListener('pointercancel', e => note(`cancel ${['pen', 'touch', 'mouse'].includes(e.pointerType) ? e.pointerType : 'touch'}`), opts);
  window.addEventListener('focusin', e => { const el = e.target instanceof Element ? e.target : null; note(`focus ${focusKind(el)} ${focusAt(el, viewport().viewportHeight)}`); checkSoon(); }, opts);
  window.addEventListener('focusout', e => { if (!e.relatedTarget) { note('blur'); checkSoon(); } }, opts);
  let keyAt = 0;
  window.addEventListener('keydown', e => { if (performance.now() - keyAt > 1000) { keyAt = performance.now(); note(e.metaKey || e.ctrlKey || e.altKey ? 'key mod' : 'key'); } }, opts);
  window.addEventListener('gesturestart', () => note('pinch'), opts);
  window.addEventListener('orientationchange', () => { note(`orientation ${innerHeight > innerWidth ? 'portrait' : 'landscape'}`); checkSoon(); });
  window.addEventListener('hashchange', () => note(`view ${viewKind(location.hash)}`));
  document.addEventListener('visibilitychange', () => { note(document.visibilityState === 'visible' ? 'visible' : 'hidden'); checkSoon(); });
  let scrollNoted = 0;
  window.addEventListener('scroll', () => { if (performance.now() - scrollNoted > 250) { scrollNoted = performance.now(); note(`scroll ${Math.round(scrollY)}`); } checkSoon(); }, { passive: true });
  document.addEventListener('scroll', boxScrolled, opts);
  const vv = window.visualViewport;
  if (vv) {
    let keyboard = viewport().keyboard, zoom = 1, vvNoted = 0;
    vv.addEventListener('resize', () => {
      const v = viewport();
      if (v.keyboard !== keyboard) { keyboard = v.keyboard; note(`keyboard ${keyboard}`); }
      if (Math.abs(v.zoom - zoom) > 0.05) { zoom = v.zoom; note(`zoom ${Math.round(zoom * 100)}`); }
      checkSoon();
    });
    vv.addEventListener('scroll', () => { if (performance.now() - vvNoted > 250) { vvNoted = performance.now(); note(`viewport ${Math.round(vv.offsetTop)}`); } checkSoon(); });
  }
  // what no event announces (a shift that began while nothing was watched)
  setInterval(() => { if (document.visibilityState === 'visible') check(); }, 3000);
}
