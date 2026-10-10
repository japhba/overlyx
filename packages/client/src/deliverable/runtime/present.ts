/**
 * Presenting a deck: one slide at a time, scaled to fill the window, on black; →, Space, PageDown,
 * a click go on; ←, PageUp, Backspace go back; Home / End; a number and Enter jumps; Escape asks
 * the editor to end the presentation. The slide shown is in the URL's hash (#3), so a reload or a
 * shared link keeps it. A poster is shown whole, a web page as it is.
 *
 * The laser pointer (L), pinch to zoom and pan, and the control bar are app/presentkit.ts's: zoomed,
 * a click does not go on, Escape first goes back to the whole slide.
 */
import { slides, post } from './env';
import { PresentKit, type ZoomView } from '../../app/presentkit';

let current = 0;
let typed = '';
let kit: PresentKit | null = null;

export function startPresenting(): void {
  const css = document.createElement('style');
  css.setAttribute('data-ol-runtime', '');
  // the zoom (presentkit: screen point q → s·q + (x, y)) on top of the fit; with the origin at the
  // slide's corner (left / top 50 %), so the fit alone is the old translate(-50%, -50%) scale(fit)
  css.textContent = `html, body { overflow: hidden !important; background: #000 !important; }
    body { margin: 0 !important; }
    .slide:not([data-ol-current]) { display: none !important; }
    .slide[data-ol-current] { position: fixed !important; left: 50% !important; top: 50% !important; margin: 0 !important;
      transform: translate(var(--ol-ztx, 0px), var(--ol-zty, 0px)) scale(var(--ol-zs, 1)) scale(var(--ol-fit, 1)) translate(-50%, -50%) !important;
      transform-origin: 0 0 !important; box-shadow: none !important; }
    html.ol-hide-cursor, html.ol-hide-cursor * { cursor: none !important; }`;
  document.head.appendChild(css);
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
    next: () => go(current + 1),
    prev: () => go(current - 1),
    exit: () => post({ ol: 'exit' }),
    position: () => { const n = slides().length; return n ? `${current + 1} / ${n}` : ''; },
    // (for the editor: leaving full screen — Escape in a real browser — first goes back to the whole slide)
    onZoom: zoomed => post({ ol: 'presentZoom', zoomed }),
  });
  const h = /^#(\d+)$/.exec(location.hash);
  go(h ? Number(h[1]) - 1 : 0);
  addEventListener('resize', fit);
  addEventListener('keydown', onKey, true);
  addEventListener('click', e => { if ((e.target as Element).closest('a, button, input, select, textarea, video, [onclick]')) return; go(current + 1); });
  addEventListener('hashchange', () => { const m = /^#(\d+)$/.exec(location.hash); if (m) go(Number(m[1]) - 1); });
  let idle: ReturnType<typeof setTimeout>;
  addEventListener('mousemove', () => { document.documentElement.classList.remove('ol-hide-cursor'); clearTimeout(idle); idle = setTimeout(() => document.documentElement.classList.add('ol-hide-cursor'), 2500); });
  addEventListener('message', e => {
    if (e.source !== window.parent || !e.data) return;
    if (e.data.ol === 'go') go(Number(e.data.slide));
    else if (e.data.ol === 'unzoom') kit?.resetZoom();
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

export function go(i: number): void {
  const ss = slides();
  if (!ss.length) return;
  current = Math.max(0, Math.min(ss.length - 1, i));
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
  if (kit?.key(e, typed !== '')) { e.preventDefault(); e.stopPropagation(); return; }
  const k = e.key;
  let handled = true;
  if (k === 'ArrowRight' || k === 'ArrowDown' || k === ' ' || k === 'PageDown' || k === 'n') go(current + 1);
  else if (k === 'ArrowLeft' || k === 'ArrowUp' || k === 'PageUp' || k === 'Backspace' || k === 'p') go(current - 1);
  else if (k === 'Home') go(0);
  else if (k === 'End') go(slides().length - 1);
  else if (/^\d$/.test(k)) { typed += k; }
  else if (k === 'Enter' && typed) { go(Number(typed) - 1); typed = ''; }
  else if (k === 'Escape') post({ ol: 'exit' });
  else if (k === 'f' && document.fullscreenEnabled) { void document.documentElement.requestFullscreen?.().catch(() => undefined); }
  else handled = false;
  if (handled) { e.preventDefault(); e.stopPropagation(); }
}
