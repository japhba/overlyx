/**
 * Presenting: how a slide comes in (`data-ol-transition` — none, fade, push, wipe — the slide's own,
 * else the `<body>`'s) and a slide that goes on by itself (`data-ol-advance`: its steps, then the next
 * slide, that many seconds apart). Core html/transitions.ts reads the attributes; present.ts calls
 * `slideIn` as it changes slides and `armAdvance` whenever a slide or a step is shown.
 *
 * The slide before stays shown under the new one while it comes in (`data-ol-leaving`, placed as the
 * current one is), both moved by the Web Animations API through the separate `translate` / `opacity` /
 * `clip-path` properties, so the placement's `transform` (the fit, the zoom) stays theirs. With
 * reduced motion asked for, every transition is a short fade.
 */
import { transitionOf, advanceOf, TRANSITION_ATTR, ADVANCE_ATTR } from '@overlyx/core/html/transitions.ts';
import { srcOf, state } from './env';

export const LEAVING = 'data-ol-leaving';

/** the leaving slide placed as the current one is, under it */
export const TRANSITION_CSS = `
  .slide[${LEAVING}] { display: block !important; position: absolute !important; left: var(--ol-cx, 50%) !important; top: var(--ol-cy, 50%) !important; margin: 0 !important;
    transform: translate(var(--ol-ztx, 0px), var(--ol-zty, 0px)) scale(var(--ol-zs, 1)) scale(var(--ol-fit, 1)) translate(-50%, -50%) !important;
    transform-origin: 0 0 !important; box-shadow: none !important; z-index: 0 !important; pointer-events: none !important; }
  .slide[data-ol-current] { z-index: 1; }`;

const attrOf = (el: Element | null | undefined, name: string): string | null => (el ? (srcOf.get(el) ?? el).getAttribute(name) : null);
const bodyAttr = (name: string): string | null => state.src?.body?.getAttribute(name) ?? document.body.getAttribute(name);

let running: { from: Element; anims: Animation[] } | null = null;

function finish(): void {
  const r = running;
  running = null;
  if (!r) return;
  for (const a of r.anims) { try { a.cancel(); } catch { /* gone */ } }
  r.from.removeAttribute(LEAVING);
}

const reduced = (): boolean => { try { return matchMedia('(prefers-reduced-motion: reduce)').matches; } catch { return false; } };

/**
 * `to` comes in after `from` (`dir` 1: on, −1: back; 0: a jump — no transition), as `to` says or the deck
 * does. Another change meanwhile ends the one running at once.
 */
export function slideIn(from: HTMLElement | null, to: HTMLElement, dir: 1 | -1 | 0): void {
  finish();
  if (!from || from === to || !dir || typeof to.animate !== 'function') return;
  const t = transitionOf(attrOf(to, TRANSITION_ATTR), bodyAttr(TRANSITION_ATTR));
  if (!t) return;
  const kind = reduced() ? 'fade' : t.kind, ms = Math.round((reduced() ? Math.min(t.secs, 0.25) : t.secs) * 1000);
  from.setAttribute(LEAVING, '');
  const opts: KeyframeAnimationOptions = { duration: ms, easing: kind === 'fade' ? 'linear' : 'cubic-bezier(.3, .7, .2, 1)', fill: 'both' };
  const anims: Animation[] = [];
  if (kind === 'fade') anims.push(to.animate([{ opacity: 0 }, { opacity: 1 }], opts));
  else if (kind === 'push') {
    // (the slides' width on the screen: the fit and the zoom are the placement's)
    const r = to.getBoundingClientRect(), w = (r.width || to.offsetWidth) * dir;
    anims.push(to.animate([{ translate: `${w}px 0` }, { translate: '0 0' }], opts));
    anims.push(from.animate([{ translate: '0 0' }, { translate: `${-w}px 0` }], opts));
  } else {
    // wipe: revealed from the right going on, from the left going back
    anims.push(to.animate([{ clipPath: dir > 0 ? 'inset(0 0 0 100%)' : 'inset(0 100% 0 0)' }, { clipPath: 'inset(0 0 0 0)' }], opts));
  }
  const run = { from, anims };
  running = run;
  void Promise.all(anims.map(a => a.finished)).then(() => { if (running === run) finish(); }, () => { /* cancelled */ });
}

let timer: ReturnType<typeof setTimeout> | null = null;

/**
 * The slide shown (or its step) goes on by itself after its `data-ol-advance` seconds (`go`: the
 * presentation's next click), unless something else goes on first — every call starts the count again.
 * `paused()`: a black or white screen, a zoom, the overview — no going on now (tried again later).
 */
export function armAdvance(slide: HTMLElement | null | undefined, go: () => void, paused: () => boolean): void {
  if (timer) { clearTimeout(timer); timer = null; }
  const secs = slide ? advanceOf(attrOf(slide, ADVANCE_ATTR), bodyAttr(ADVANCE_ATTR)) : null;
  if (secs === null) return;
  const tick = () => {
    timer = null;
    if (paused()) { timer = setTimeout(tick, 1000); return; }
    go();
  };
  timer = setTimeout(tick, secs * 1000);
}

/** the slide list's mark for a slide that comes in with a transition or goes on by itself (index.ts drawRail): what it says, and which glyph; null: neither */
export function railFx(slide: Element): { say: string; timed: boolean; moves: boolean } | null {
  const t = transitionOf(attrOf(slide, TRANSITION_ATTR), bodyAttr(TRANSITION_ATTR));
  const a = advanceOf(attrOf(slide, ADVANCE_ATTR), bodyAttr(ADVANCE_ATTR));
  if (!t && a === null) return null;
  const kind = t ? t.kind[0].toUpperCase() + t.kind.slice(1) : '';
  return { say: [t ? `Comes in: ${kind}` : '', a !== null ? `goes on by itself after ${Math.round(a * 10) / 10} s` : ''].filter(Boolean).join(', '), timed: a !== null, moves: !!t };
}

