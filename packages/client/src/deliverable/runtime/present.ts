/**
 * Presenting a deck: one slide at a time, scaled to fill the window, on black; →, Space, PageDown,
 * a click go on — through a slide's steps first (data-step, data-steps: beamer's overlays; objects
 * appear and disappear) —;
 * ←, PageUp, Backspace go back (to the slide before as it ends); Home / End; a number and Enter jumps; Escape asks
 * the editor to end the presentation. The slide shown is in the URL's hash (#3), so a reload or a
 * shared link keeps it. B / . and W / , pause on a black or white screen; the next navigation
 * resumes the same slide and step. A poster is shown whole, a web page as it is.
 *
 * The laser pointer (L), pinch to zoom and pan, and the control bar are app/presentkit.ts's: zoomed,
 * a click does not go on, Escape first goes back to the whole slide.
 */
import { slides, post } from './env';
import { PresentKit, type ZoomView } from '../../app/presentkit';
import { parseSteps, stepOf, stepVisible, lastStep as stepsOf, type Interval } from '@overlyx/core/html/steps.ts';

let current = 0;
/** the step of the slide shown (beamer's overlays: objects with data-step show on the steps it names, core html/steps.ts) */
let step = 1;
let typed = '';
let kit: PresentKit | null = null;

export function startPresenting(): void {
  const css = document.createElement('style');
  css.setAttribute('data-ol-runtime', '');
  // the zoom (presentkit: screen point q → s·q + (x, y)) on top of the fit; with the origin at the
  // slide's corner (left / top 50 %), so the fit alone is the old translate(-50%, -50%) scale(fit).
  // Placed absolutely in the (unscrolled) window, not `fixed`: Safari may give a fixed element in a
  // frame a layer of its own, rasterised before the scale — on an iPad the slide, scaled up to the
  // screen, came out soft. (Its containers are not positioned meanwhile, so the window is its frame.)
  css.textContent = `html, body { overflow: hidden !important; background: #000 !important; }
    body { margin: 0 !important; }
    :is(body, :has(.slide[data-ol-current])):not(html) { position: static !important; }
    .slide:not([data-ol-current]) { display: none !important; }
    .slide[data-ol-current] { position: absolute !important; left: 50% !important; top: 50% !important; margin: 0 !important;
      transform: translate(var(--ol-ztx, 0px), var(--ol-zty, 0px)) scale(var(--ol-zs, 1)) scale(var(--ol-fit, 1)) translate(-50%, -50%) !important;
      transform-origin: 0 0 !important; box-shadow: none !important; }
    html.ol-present-blank, html.ol-present-blank body { background: #000 !important; }
    html.ol-present-white, html.ol-present-white body { background: #fff !important; }
    html.ol-present-blank .slide { opacity: 0 !important; visibility: hidden !important; }
    html.ol-present-blank ol-present-ui { display: none !important; }
    html.ol-hide-cursor, html.ol-hide-cursor * { cursor: none !important; }
    [data-ol-unshown] { visibility: hidden !important; }
    html.ol-steps-dim [data-ol-unshown] { visibility: visible !important; opacity: .18 !important; }`;
  // <meta name="overlyx-steps" content="dim">: what comes later shows faintly (beamer's \setbeamercovered{transparent})
  if (/^dim/i.test(document.querySelector('meta[name="overlyx-steps"]')?.getAttribute('content') ?? '')) document.documentElement.classList.add('ol-steps-dim');
  document.head.appendChild(css);
  // A paused screen's click resumes before the zoom / ink tools can consume it or advance a step.
  addEventListener('click', e => {
    if (!resumeScreen()) return;
    e.preventDefault(); e.stopImmediatePropagation();
  }, true);
  kit = new PresentKit({
    root: document.documentElement,
    base: () => {
      const s = slides()[current];
      const fit = parseFloat(document.documentElement.style.getPropertyValue('--ol-fit')) || 1;
      if (!s || !s.offsetWidth || !s.offsetHeight) return null;
      const w = s.offsetWidth * fit, h = s.offsetHeight * fit;
      return { x: (innerWidth - w) / 2, y: (innerHeight - h) / 2, w, h };
    },
    apply: zoom,
    next: forward,
    prev: back,
    exit: () => post({ ol: 'exit' }),
    position: () => { const n = slides().length; return n ? `${current + 1} / ${n}` : ''; },
    // (for the editor: leaving full screen — Escape in a real browser — first goes back to the whole slide)
    onZoom: zoomed => post({ ol: 'presentZoom', zoomed }),
    // (the frame has no storage: the editor keeps it, and hands it over as the presentation starts)
    onFingersDraw: on => post({ ol: 'presentFingers', on }),
  });
  const h = /^#(\d+)$/.exec(location.hash);
  go(h ? Number(h[1]) - 1 : 0);
  addEventListener('resize', fit);
  addEventListener('keydown', onKey, true);
  addEventListener('click', e => { if ((e.target as Element).closest('a, button, input, select, textarea, video, [onclick]')) return; forward(); });
  addEventListener('hashchange', () => { const m = /^#(\d+)$/.exec(location.hash); if (m) go(Number(m[1]) - 1); });
  let idle: ReturnType<typeof setTimeout>;
  addEventListener('mousemove', () => { document.documentElement.classList.remove('ol-hide-cursor'); clearTimeout(idle); idle = setTimeout(() => document.documentElement.classList.add('ol-hide-cursor'), 2500); });
  addEventListener('message', e => {
    if (e.source !== window.parent || !e.data) return;
    if (e.data.ol === 'go') go(Number(e.data.slide));
    else if (e.data.ol === 'unzoom') kit?.resetZoom();
    else if (e.data.ol === 'presentFingers') kit?.setFingersDraw(e.data.on === true, false);
  });
}

/** the zoom drawn: the translation of the slide's corner (its transform origin) included */
function zoom(v: ZoomView): void {
  const st = document.documentElement.style;
  if (v.s === 1 && !v.x && !v.y) { st.removeProperty('--ol-zs'); st.removeProperty('--ol-ztx'); st.removeProperty('--ol-zty'); return; }
  st.setProperty('--ol-zs', String(v.s));
  st.setProperty('--ol-ztx', `${(v.s - 1) * innerWidth / 2 + v.x}px`);
  st.setProperty('--ol-zty', `${(v.s - 1) * innerHeight / 2 + v.y}px`);
}

/* ------------------------------------------------------------------ steps */

/** A pause changes only the presenting view: the slide, its step and its saved source stay put. */
function resumeScreen(): boolean {
  if (!document.documentElement.classList.contains('ol-present-blank')) return false;
  document.documentElement.classList.remove('ol-present-blank', 'ol-present-white');
  return true;
}

function blankScreen(white: boolean): void {
  if (resumeScreen()) return;
  kit?.setTool(null);
  document.documentElement.classList.add('ol-present-blank');
  document.documentElement.classList.toggle('ol-present-white', white);
}

/**
 * The objects of a slide that show on some steps only (any element, an SVG's paths too): those with
 * `data-step` (a beamer overlay specification: "3" from step 3 on, "-3" until step 3, "2-4"…), and
 * the items of a list with `data-steps` one after the other (beamer's `[<+->]`; its value is the
 * step of the first item, 1 when empty) — an item's own data-step wins.
 */
function steps(slide: Element): [Element, Interval[]][] {
  const out: [Element, Interval[]][] = [];
  for (const el of Array.from(slide.querySelectorAll('[data-step]'))) out.push([el, parseSteps(el.getAttribute('data-step'))]);
  for (const list of Array.from(slide.querySelectorAll(':is(ul, ol)[data-steps]'))) {
    const first = stepOf(list.getAttribute('data-steps'));
    const items = Array.from(list.children).filter(c => c.localName === 'li');
    items.forEach((li, i) => { if (!li.hasAttribute('data-step') && first + i > 1) out.push([li, [[first + i, null]]]); });
  }
  return out;
}
const lastStep = (slide: Element | undefined) => (slide ? stepsOf(steps(slide).map(([, iv]) => iv)) : 1);

function showStep(): void {
  const s = slides()[current];
  if (!s) return;
  for (const el of Array.from(s.querySelectorAll('[data-ol-unshown]'))) el.removeAttribute('data-ol-unshown');
  for (const [el, iv] of steps(s)) if (!stepVisible(iv, step)) el.setAttribute('data-ol-unshown', '');
}

/** on: the next step of the slide, or the next slide */
function forward(): void {
  if (resumeScreen()) return;
  if (step < lastStep(slides()[current])) { step++; showStep(); return; }
  go(current + 1);
}
/** back: the step before, or the slide before as it ends */
function back(): void {
  if (resumeScreen()) return;
  if (step > 1) { step--; showStep(); return; }
  if (current > 0) go(current - 1, true);
}

export function go(i: number, atEnd = false): void {
  const ss = slides();
  if (!ss.length) return;
  resumeScreen();
  current = Math.max(0, Math.min(ss.length - 1, i));
  step = atEnd ? lastStep(ss[current]) : 1;
  showStep();
  ss.forEach((s, k) => { if (k === current) s.setAttribute('data-ol-current', ''); else s.removeAttribute('data-ol-current'); });
  fit();
  kit?.slideChanged();
  try { history.replaceState(null, '', `#${current + 1}`); } catch { /* sandboxed: no history */ }
  post({ ol: 'visible', slide: current });
}

function fit(): void {
  const s = slides()[current];
  if (!s) return;
  const w = s.offsetWidth, h = s.offsetHeight;
  if (!w || !h) return;
  document.documentElement.style.setProperty('--ol-fit', String(Math.min(innerWidth / w, innerHeight / h)));
}

function onKey(e: KeyboardEvent): void {
  const t = e.target as Element | null;
  if (t && /^(input|textarea|select)$/i.test(t.localName)) return;
  if (!e.ctrlKey && !e.metaKey && !e.altKey && /^[bw.,]$/i.test(e.key)) {
    typed = '';
    blankScreen(/^[w,]$/i.test(e.key));
    e.preventDefault(); e.stopPropagation(); return;
  }
  if (kit?.key(e, typed !== '')) { e.preventDefault(); e.stopPropagation(); return; }
  const k = e.key;
  let handled = true;
  if (k === 'ArrowRight' || k === 'ArrowDown' || k === ' ' || k === 'PageDown' || k === 'n') forward();
  else if (k === 'ArrowLeft' || k === 'ArrowUp' || k === 'PageUp' || k === 'Backspace' || k === 'p') back();
  else if (k === 'Home') go(0);
  else if (k === 'End') go(slides().length - 1);
  else if (/^\d$/.test(k)) { typed += k; }
  else if (k === 'Enter' && typed) { go(Number(typed) - 1); typed = ''; }
  else if (k === 'Escape') post({ ol: 'exit' });
  else if (k === 'f' && document.fullscreenEnabled) { void document.documentElement.requestFullscreen?.().catch(() => undefined); }
  else handled = false;
  if (handled) { e.preventDefault(); e.stopPropagation(); }
}
