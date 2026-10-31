/**
 * A pinch magnifies the page in the pane beside its article (client app/ArticlePage.tsx), as the
 * editor's text magnifies (app/documentviewport.ts): a trackpad pinch (Ctrl/⌘ + wheel, Safari's
 * gesture events) or two fingers scale the page about the point between them. The page's layout
 * stays as it is — its root keeps its size and is transformed — and the frame scrolls over the
 * magnified page. The pinch lands in this frame, not in the editor around it, so the page magnifies
 * itself; the editor hears the scale with the scroll position (embed.ts `viewScroll`) and gives both
 * back to the page loaded again after a save (`viewScrollTo`). Ctrl/⌘ + and − pressed in the page,
 * and the pane's − / + (`viewZoomStep`), step through the scales. Only in the editor's pane: a page
 * opened on its own is zoomed by the browser.
 */
const MIN = 1, MAX = 4;
const clamp = (z: number) => Math.max(MIN, Math.min(MAX, z));

let scale = 1;
/** the inline styles the magnifier overrides, as the page had them */
let saved: { el: HTMLElement; css: Map<string, string> }[] = [];
let changed = () => {};

/** the scale the page is shown at (1: as it is) */
export const viewZoom = (): number => scale;

function remember(el: HTMLElement, props: string[]): void {
  saved.push({ el, css: new Map(props.map(p => [p, el.style.getPropertyValue(p)])) });
}
function restore(): void {
  for (const { el, css } of saved) for (const [p, v] of css) { if (v) el.style.setProperty(p, v); else el.style.removeProperty(p); }
  saved = [];
}

/**
 * The root keeps its size (a scroll bar that appears must not reflow the page) and is scaled from its
 * corner: the whole frame's width, margins too, so that there is room to scroll any point of the page
 * under the fingers, as in a browser's own pinch. The frame scrolls both ways meanwhile.
 */
function freeze(html: HTMLElement, body: HTMLElement): void {
  const own = getComputedStyle(html);
  const width = own.width;
  remember(html, ['width', 'min-width', 'max-width', 'min-height', 'transform', 'transform-origin', 'will-change', 'overflow']);
  remember(body, ['overflow']);
  for (const p of ['width', 'min-width', 'max-width']) html.style.setProperty(p, width, 'important');
  html.style.setProperty('min-height', `${html.clientHeight}px`, 'important');
  html.style.setProperty('transform-origin', '0 0', 'important');
  // the viewport's overflow is the root's, or the body's when the root leaves it visible
  if (own.overflowX === 'visible' && own.overflowY === 'visible') body.style.setProperty('overflow', 'visible', 'important');
  else html.style.setProperty('overflow', 'auto', 'important');
}

let settle = 0;
function zoomAt(z: number, x: number, y: number, toX = x, toY = y): void {
  const html = document.documentElement, body = document.body;
  if (!body) return;
  z = clamp(z);
  if (Math.abs(z - 1) < 0.005) z = 1;
  if (z === scale && x === toX && y === toY) return;
  // the point under (x, y), in the page's own (unscaled) pixels
  const before = html.getBoundingClientRect();
  const px = (x - before.left) / scale, py = (y - before.top) / scale;
  if (scale === 1 && z !== 1) freeze(html, body);
  scale = z;
  clearTimeout(settle);
  if (z === 1) restore();
  else {
    html.style.setProperty('transform', `scale(${z})`, 'important');
    // a layer while the fingers move; drawn sharp at the scale once they rest
    html.style.setProperty('will-change', 'transform', 'important');
    settle = window.setTimeout(() => { if (scale !== 1) html.style.removeProperty('will-change'); }, 180);
  }
  const after = html.getBoundingClientRect();
  scrollBy({ left: after.left + px * z - toX, top: after.top + py * z - toY, behavior: 'instant' });
  changed();
}

/** the scale the editor kept for the page, before it is scrolled where the reader was */
export function setViewZoom(z: number): void {
  if (Number.isFinite(z)) zoomAt(z, 0, 0);
}

/** the scales Ctrl/⌘ + and − and the pane's − / + step through */
const STEPS = [1, 1.25, 1.5, 1.75, 2, 2.5, 3, 4];
/**
 * A step in (1) or out (−1), or back to the page as it is (0) — about the middle of the pane's top,
 * as a browser's own zoom keeps the top of the page where it is.
 */
export function stepViewZoom(d: number): void {
  const z = d === 0 ? 1 : d > 0 ? STEPS.find(s => s > scale * 1.01) ?? MAX : [...STEPS].reverse().find(s => s < scale / 1.01) ?? MIN;
  zoomAt(z, innerWidth / 2, 0);
}

let pending: { z: number; x: number; y: number; toX: number; toY: number } | null = null;
let raf = 0;
/** a pinch's step (log of the factor), coalesced to one transform a frame */
function by(log: number, x: number, y: number, toX = x, toY = y): void {
  pending = { z: clamp((pending?.z ?? scale) * Math.exp(log)), x: pending?.x ?? x, y: pending?.y ?? y, toX, toY };
  if (!raf) raf = requestAnimationFrame(() => {
    raf = 0;
    const p = pending;
    pending = null;
    if (p) zoomAt(p.z, p.x, p.y, p.toX, p.toY);
  });
}

export function startViewZoom(onChange: () => void): void {
  if (new URLSearchParams(location.search).get('ol') !== 'view') return;
  changed = onChange;
  const opts = { passive: false };
  addEventListener('wheel', e => {
    if (!(e.ctrlKey || e.metaKey) || e.defaultPrevented) return;
    e.preventDefault();   // (the browser would zoom the editor around the page)
    const dy = e.deltaY * (e.deltaMode === 1 ? 16 : e.deltaMode === 2 ? innerHeight : 1);
    by(Math.max(-0.3, Math.min(0.3, -dy * 0.01)), e.clientX, e.clientY);
  }, opts);
  let touch: { d: number; x: number; y: number } | null = null;
  const two = (t: TouchList) => ({ d: Math.hypot(t[0].clientX - t[1].clientX, t[0].clientY - t[1].clientY), x: (t[0].clientX + t[1].clientX) / 2, y: (t[0].clientY + t[1].clientY) / 2 });
  const onTouch = (e: TouchEvent) => {
    if (e.type === 'touchstart') {
      if (e.defaultPrevented || e.touches.length !== 2) return;
      e.preventDefault();
      touch = two(e.touches);
      return;
    }
    if (!touch) return;
    if (e.type === 'touchmove' && e.touches.length === 2) {
      e.preventDefault();
      const now = two(e.touches);
      if (touch.d > 0 && now.d > 0) by(Math.log(now.d / touch.d), touch.x, touch.y, now.x, now.y);
      touch = now;
    } else if (e.touches.length < 2) touch = null;
  };
  for (const t of ['touchstart', 'touchmove', 'touchend', 'touchcancel'] as const) document.addEventListener(t, onTouch, opts);
  // Safari's trackpad pinch
  let last = 1;
  const gesture = (e: Event & { scale?: number; clientX?: number; clientY?: number }) => {
    if (e.defaultPrevented) return;
    e.preventDefault();
    if (touch) return;
    if (e.type === 'gesturestart') { last = 1; return; }
    const z = e.scale ?? 1;
    if (e.type === 'gesturechange' && z > 0) {
      by(Math.log(z / last), e.clientX ?? innerWidth / 2, e.clientY ?? innerHeight / 2);
      last = z;
    }
  };
  for (const t of ['gesturestart', 'gesturechange', 'gestureend']) addEventListener(t, gesture, opts);
  // Ctrl/⌘ + − 0 in the page: its zoom, not the browser's (nor, in VS Code, the whole window's — the
  // keys pressed in this frame never reach the editor around it, client app/zoomkeys.ts)
  addEventListener('keydown', e => {
    const mod = /Mac|iPhone|iPad/.test(navigator.platform) ? e.metaKey : e.ctrlKey;
    if (!mod || e.altKey || e.defaultPrevented) return;
    const d = e.key === '+' || (!e.shiftKey && (e.code === 'Equal' || e.code === 'NumpadAdd')) ? 1
      : e.shiftKey ? null : e.key === '-' || e.code === 'Minus' || e.code === 'NumpadSubtract' ? -1 : e.key === '0' || e.code === 'Numpad0' ? 0 : null;
    if (d === null) return;
    e.preventDefault();
    stepViewZoom(d);
  }, true);
  // a resized pane: the body takes the new width, magnified as before
  addEventListener('resize', () => {
    if (scale === 1) return;
    const keep = scale;
    zoomAt(1, 0, 0);
    zoomAt(keep, 0, 0);
  });
}
