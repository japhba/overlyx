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
 * a click does not go on, Escape first goes back to the whole slide. Presented on other screens at the
 * same time, the drawings, the laser and (Linked) the slide go between them: the kit's state goes to
 * the editor (`presentShare`), which shares it in the document's awareness and brings the others'
 * (`presentPeers`; app/presentshare.ts).
 *
 * The presenter view (S, the bar's button: presenter.ts) puts the slide in a part of the window, the
 * stage, with the notes, what comes next, a timer and every slide around it. The editor sends each
 * new version of the text as it is made (as it does to the canvas: reconcile.ts), so the slides shown
 * are always the document's — an edit made on another screen or a synced clone mid-talk included.
 */
import { slides, post, srcOf, state } from './env';
import { PresentKit, type ZoomView } from '../../app/presentkit';
import { textHash } from '../../app/presentshare';
import { slideStepCount as lastStep, showSlideStep, STEP_VISIBILITY_CSS } from './steps';
import { PresenterView, type StageRect } from './presenter';
import { pairAll } from './reconcile';

let current = 0;
/** the step of the slide shown (beamer's overlays: objects with data-step show on the steps it names, core html/steps.ts) */
let step = 1;
let typed = '';
let kit: PresentKit | null = null;
let pv: PresenterView | null = null;
/** where the slide is drawn (window px): the presenter view's stage, else (null) the whole window */
let stage: StageRect | null = null;

/** the stage's middle and size */
function stageBox(): { cx: number; cy: number; w: number; h: number } {
  return stage ? { cx: stage.x + stage.w / 2, cy: stage.y + stage.h / 2, w: stage.w, h: stage.h } : { cx: innerWidth / 2, cy: innerHeight / 2, w: innerWidth, h: innerHeight };
}

/**
 * A slide's mark for the other screens (presentshare.ts PresentAt.sid): its id, else a hash of its
 * words as the source has them (its notes left out) — the same on every screen showing that slide,
 * whatever else of the deck changed, typeset or not.
 */
export function slideSid(el: Element | undefined): string | undefined {
  if (!el) return undefined;
  const src = srcOf.get(el) ?? el;
  const id = src.getAttribute('id');
  if (id) return textHash('#' + id);
  let text = '';
  const walk = (n: Node) => {
    for (const c of Array.from(n.childNodes)) {
      if (c.nodeType === 3) text += c.nodeValue;
      else if (c.nodeType === 1) {
        const e = c as Element;
        if ((e.localName === 'aside' && e.classList.contains('notes')) || e.localName === 'mjx-container' || e.hasAttribute('data-ol-runtime')) continue;
        walk(e);
      }
      if (text.length > 4000) return;
    }
  };
  walk(src);
  return textHash(text.replace(/\s+/g, ' ').trim());
}

/** the slide with the mark `sid` nearest to `near` (two slides may say the same), else -1 */
function slideWithSid(sid: string, near: number): number {
  let best = -1;
  slides().forEach((s, i) => { if (slideSid(s) === sid && (best < 0 || Math.abs(i - near) < Math.abs(best - near))) best = i; });
  return best;
}

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
    .slide:not([data-ol-current]):not([data-ol-copy]) { display: none !important; }
    .slide[data-ol-current] { position: absolute !important; left: var(--ol-cx, 50%) !important; top: var(--ol-cy, 50%) !important; margin: 0 !important;
      transform: translate(var(--ol-ztx, 0px), var(--ol-zty, 0px)) scale(var(--ol-zs, 1)) scale(var(--ol-fit, 1)) translate(-50%, -50%) !important;
      transform-origin: 0 0 !important; box-shadow: none !important; }
    html.ol-present-blank, html.ol-present-blank body { background: #000 !important; }
    html.ol-present-white, html.ol-present-white body { background: #fff !important; }
    html.ol-present-blank .slide { opacity: 0 !important; visibility: hidden !important; }
    html.ol-present-blank ol-present-ui { display: none !important; }
    html.ol-hide-cursor, html.ol-hide-cursor * { cursor: none !important; }
    ${STEP_VISIBILITY_CSS}`;
  // <meta name="overlyx-steps" content="dim">: what comes later shows faintly (beamer's \setbeamercovered{transparent})
  if (/^dim/i.test(document.querySelector('meta[name="overlyx-steps"]')?.getAttribute('content') ?? '')) document.documentElement.classList.add('ol-steps-dim');
  document.head.appendChild(css);
  // the page as it was served, paired with its source (reconcile.ts): the editor's versions are taken as changes of it
  if (!state.src && typeof window.__OL?.source === 'string') {
    try { state.src = new DOMParser().parseFromString(window.__OL.source, 'text/html'); pairAll(state.src); } catch { state.src = null; }
  }
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
      const w = s.offsetWidth * fit, h = s.offsetHeight * fit, b = stageBox();
      return { x: b.cx - w / 2, y: b.cy - h / 2, w, h };
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
    // the other screens presenting the document: through the editor, which has its awareness
    at: () => ({ slide: current, step, sid: slideSid(slides()[current]) }),
    goTo: (slide, at, sid) => {
      const i = sid ? slideWithSid(sid, slide) : -1;
      const to = i >= 0 ? i : slide;
      if (to !== current || at !== step) go(to, false, at);
    },
    share: st => post({ ol: 'presentShare', state: st }),
    onLinked: on => post({ ol: 'presentLinked', on }),
    outside: t => !!pv?.contains(t),
    presenterView: { on: () => !!pv?.on, toggle: () => pv?.set(!pv.on, true) },
  });
  pv = new PresenterView({
    at: () => ({ slide: current, step }),
    go: i => go(i),
    next: forward,
    prev: back,
    began: () => kit?.beganAt ?? Date.now(),
    setStage: r => { stage = r; placeStage(); fit(); kit?.layoutChanged(); },
    pinBar: p => kit?.pin(p),
    barHeight: () => kit?.barHeight ?? 42,
    changed: (on, notes) => { kit?.refresh(); post({ ol: 'presenterPrefs', on, notes }); },
    ...(window.parent !== window ? { audience: () => post({ ol: 'presentAudience' }) } : {}),
  });
  const h = /^#(\d+)$/.exec(location.hash);
  go(h ? Number(h[1]) - 1 : 0);
  addEventListener('resize', fit);
  addEventListener('keydown', onKey, true);
  addEventListener('click', e => { if (pv?.contains(e.target) || (e.target as Element).closest('a, button, input, select, textarea, video, [onclick]')) return; forward(); });
  addEventListener('hashchange', () => { const m = /^#(\d+)$/.exec(location.hash); if (m) go(Number(m[1]) - 1); });
  let idle: ReturnType<typeof setTimeout>;
  addEventListener('mousemove', () => { document.documentElement.classList.remove('ol-hide-cursor'); clearTimeout(idle); idle = setTimeout(() => document.documentElement.classList.add('ol-hide-cursor'), 2500); });
  addEventListener('message', e => {
    if (e.source !== window.parent || !e.data) return;
    if (e.data.ol === 'go') go(Number(e.data.slide));
    else if (e.data.ol === 'unzoom') kit?.resetZoom();
    else if (e.data.ol === 'presentFingers') kit?.setFingersDraw(e.data.on === true, false);
    else if (e.data.ol === 'presentLinked') kit?.setLinked(e.data.on !== false, false);
    else if (e.data.ol === 'presentPeers' && Array.isArray(e.data.peers)) kit?.setPeers(e.data.peers);
    else if (e.data.ol === 'presenter') { if (typeof e.data.notes === 'number') pv?.setNotes(e.data.notes); pv?.set(e.data.on === true); kit?.refresh(); }
  });
  // (the editor sends its settings, the other screens and the text then: the frame keeps nothing)
  post({ ol: 'presentReady' });
}

function placeStage(): void {
  const st = document.documentElement.style;
  if (stage) { const b = stageBox(); st.setProperty('--ol-cx', `${b.cx}px`); st.setProperty('--ol-cy', `${b.cy}px`); }
  else { st.removeProperty('--ol-cx'); st.removeProperty('--ol-cy'); }
}

/**
 * A new version of the text was taken (an edit while presenting, here or on another screen): the
 * slide shown stays — where it is now, should slides have come or gone before it; else the one at
 * its place —, its step within the steps it has now; the other screens are told where it is.
 */
export function sourceChanged(): void {
  const ss = slides();
  if (!ss.length) return;
  const shown = document.querySelector('.slide[data-ol-current]');
  const i = shown ? ss.indexOf(shown as HTMLElement) : -1;
  current = i >= 0 ? i : Math.max(0, Math.min(ss.length - 1, current));
  step = Math.max(1, Math.min(lastStep(ss[current]), step));
  showStep();
  ss.forEach((s, k) => { if (k === current) s.setAttribute('data-ol-current', ''); else s.removeAttribute('data-ol-current'); });
  for (const s of Array.from(document.querySelectorAll('.slide[data-ol-current]'))) if (!ss.includes(s as HTMLElement)) s.removeAttribute('data-ol-current');
  fit();
  kit?.reindexed();
  kit?.refresh();
  pv?.sourceChanged();
  try { history.replaceState(null, '', `#${current + 1}`); } catch { /* sandboxed: no history */ }
  post({ ol: 'visible', slide: current });
}

/** formulas, fonts and pictures settled: the presenter view's copies made again (they were taken before) */
export function presentSettled(): void { pv?.sourceChanged(); }

/** the zoom drawn: the translation of the slide's corner (its transform origin) included */
function zoom(v: ZoomView): void {
  const st = document.documentElement.style;
  if (v.s === 1 && !v.x && !v.y) { st.removeProperty('--ol-zs'); st.removeProperty('--ol-ztx'); st.removeProperty('--ol-zty'); return; }
  // (the slide's corner sits at the stage's middle: screen = s · (middle + fit · p) + (x, y))
  const b = stageBox();
  st.setProperty('--ol-zs', String(v.s));
  st.setProperty('--ol-ztx', `${(v.s - 1) * b.cx + v.x}px`);
  st.setProperty('--ol-zty', `${(v.s - 1) * b.cy + v.y}px`);
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

function showStep(): void {
  const s = slides()[current];
  if (s) showSlideStep(s, step);
}

/** on: the next step of the slide, or the next slide */
function forward(): void {
  if (resumeScreen()) return;
  if (step < lastStep(slides()[current])) { step++; showStep(); kit?.moved(); pv?.update(); return; }
  go(current + 1);
}
/** back: the step before, or the slide before as it ends */
function back(): void {
  if (resumeScreen()) return;
  if (step > 1) { step--; showStep(); kit?.moved(); pv?.update(); return; }
  if (current > 0) go(current - 1, true);
}

/** to slide `i`: at its first step, its last (`atEnd`), or the step `at` (another screen's, Linked) */
export function go(i: number, atEnd = false, at?: number): void {
  const ss = slides();
  if (!ss.length) return;
  resumeScreen();
  current = Math.max(0, Math.min(ss.length - 1, i));
  step = at !== undefined ? Math.max(1, Math.min(lastStep(ss[current]), at)) : atEnd ? lastStep(ss[current]) : 1;
  showStep();
  ss.forEach((s, k) => { if (k === current) s.setAttribute('data-ol-current', ''); else s.removeAttribute('data-ol-current'); });
  fit();
  kit?.slideChanged();
  pv?.update();
  try { history.replaceState(null, '', `#${current + 1}`); } catch { /* sandboxed: no history */ }
  post({ ol: 'visible', slide: current });
}

function fit(): void {
  const s = slides()[current];
  if (!s) return;
  const w = s.offsetWidth, h = s.offsetHeight;
  if (!w || !h) return;
  const b = stageBox();
  document.documentElement.style.setProperty('--ol-fit', String(Math.min(b.w / w, b.h / h)));
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
