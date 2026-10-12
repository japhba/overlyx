/**
 * The guides on the slide shown (../guides.ts), in the editor's frame only: drawn over the slide in
 * the overlay (edit.ts `draw`) — the master's dashed orange, the slide's own solid teal —, snapped to
 * by objects that are moved or resized (edit.ts `snap`), dragged (Alt / Ctrl: a copy; the guide snaps
 * to the slide's middle and edges and the objects' edges and middles), taken away when dragged off the
 * slide. A guide is taken before the object under it when the pointer is right on it (4 px; a finger
 * 10), so that one over a picture that fills the slide can be moved too.
 */
import { GUIDES_ATTR, parseGuides, masterGuides, formatGuides, movedGuide, withoutGuide, guideLabel, type Guide } from '../guides';
import type { HtmlOp } from '../protocol';
import { docRect, pathOf, srcPath, srcOf, state, slides, slideOf, isForeign } from './env';
import { isSolo, soloIndex } from './solo';

export interface SlideGuide extends Guide { own: boolean }

let shown = false;
let hooks: { scale: () => number; commit: (ops: HtmlOp[]) => void; draw: () => void } | null = null;
const scale = () => hooks?.scale() ?? 1;

export function initGuides(h: NonNullable<typeof hooks>): void { hooks = h; }
export function setGuidesShown(on: boolean): void {
  if (shown === on) return;
  shown = on;
  hooks?.draw();
}

/** the slide a point is on, or the one shown */
export function guideSlide(t: Element | null): HTMLElement | null {
  return slideOf(t) ?? (isSolo() ? slides()[soloIndex()] ?? null : null);
}

/** the slide on the page (doc px), its own size (px), and doc px per slide px */
function frameOf(slide: HTMLElement) {
  const r = docRect(slide);
  const w = slide.offsetWidth || r.w, h = slide.offsetHeight || r.h;
  return { r, w, h, kx: r.w / (w || 1), ky: r.h / (h || 1) };
}

/**
 * The guides written in the source (the editor's text as the page shows it): <body>'s — the master's —,
 * and the slide's own. (Read there, not off the live page: its <body> is the page's own, and its
 * attributes do not follow the text.)
 */
const masterAttr = (): string | null => state.src?.body?.getAttribute(GUIDES_ATTR) ?? null;
const ownAttr = (slide: Element): string | null => (srcOf.get(slide) ?? slide).getAttribute(GUIDES_ATTR);

/** the master's guides and the slide's own (one of each place) */
export function guidesOf(slide: HTMLElement): SlideGuide[] {
  const { w, h } = frameOf(slide);
  const master = masterGuides(masterAttr(), w, h).map(g => ({ ...g, own: false }));
  const own = parseGuides(ownAttr(slide)).map(g => ({ ...g, own: true }));
  return [...master, ...own.filter(o => !master.some(m => m.axis === o.axis && Math.abs(m.at - o.at) < 0.5))];
}

/** where moved and resized objects snap besides the slide and the other objects (doc px): the guides shown */
export function guideSnaps(slide: HTMLElement | null): { xs: number[]; ys: number[] } {
  const xs: number[] = [], ys: number[] = [];
  if (!shown || !slide) return { xs, ys };
  const f = frameOf(slide);
  for (const g of guidesOf(slide)) {
    if (g.axis === 'x') xs.push(f.r.x + g.at * f.kx); else ys.push(f.r.y + g.at * f.ky);
  }
  return { xs, ys };
}

/** the guide right under a point of the page (doc px), within `tol` screen px */
export function guideAt(slide: HTMLElement | null, x: number, y: number, tol: number): { slide: HTMLElement; g: SlideGuide } | null {
  if (!shown || !slide) return null;
  const f = frameOf(slide), t = tol / scale();
  if (x < f.r.x - t || x > f.r.x + f.r.w + t || y < f.r.y - t || y > f.r.y + f.r.h + t) return null;
  let best: SlideGuide | null = null, bd = t;
  for (const g of guidesOf(slide)) {
    const d = g.axis === 'x' ? Math.abs(f.r.x + g.at * f.kx - x) : Math.abs(f.r.y + g.at * f.ky - y);
    if (d <= bd) { bd = d; best = g; }
  }
  return best && { slide, g: best };
}

/** the guide being dragged: where it is now (slide px), a copy or not, off the slide (it goes) */
let moving: { slide: HTMLElement; g: SlideGuide; at: number; copy: boolean; off: boolean; px: number; py: number } | null = null;
export const guideDragging = (): boolean => !!moving;

export function startGuideDrag(slide: HTMLElement, g: SlideGuide, copy: boolean, x: number, y: number): void {
  moving = { slide, g, at: g.at, copy, off: false, px: x, py: y };
  hooks?.draw();
}

export function moveGuideDrag(x: number, y: number, free: boolean): void {
  const m = moving;
  if (!m) return;
  const f = frameOf(m.slide);
  const vertical = m.g.axis === 'x';
  const lo = vertical ? f.r.x : f.r.y, len = vertical ? f.r.w : f.r.h, k = vertical ? f.kx : f.ky;
  let pos = vertical ? x : y;
  m.px = x; m.py = y;
  m.off = pos < lo - 2 / scale() || pos > lo + len + 2 / scale();
  if (!m.off && !free) {
    // onto the slide's edges and middle, and the objects' edges and middles, nearby
    const targets = [lo, lo + len / 2, lo + len];
    for (const c of Array.from(m.slide.children)) {
      if (isForeign(c)) continue;
      const q = docRect(c);
      if (!q.w || !q.h) continue;
      if (vertical) targets.push(q.x, q.x + q.w / 2, q.x + q.w); else targets.push(q.y, q.y + q.h / 2, q.y + q.h);
    }
    let best = 6 / scale();
    for (const t of targets) if (Math.abs(t - pos) < best) { best = Math.abs(t - pos); pos = t; }
  }
  m.at = Math.max(0, Math.min(len, pos - lo)) / k;
  hooks?.draw();
}

/** let go: the guide where it is now, or gone (dragged off the slide); written to its owner — the slide, or <body> (the master's) */
export function endGuideDrag(cancel: boolean): void {
  const m = moving;
  moving = null;
  if (!m) return;
  const moved = m.off || Math.abs(m.at - m.g.at) >= 0.25;
  if (cancel || !moved) { hooks?.draw(); return; }
  const owner = m.g.own ? m.slide : document.body;
  const f = frameOf(m.slide);
  const cur = m.g.own ? parseGuides(ownAttr(m.slide)) : masterGuides(masterAttr(), f.w, f.h);
  const next = m.off ? (m.copy ? cur : withoutGuide(cur, m.g)) : movedGuide(cur, m.g, m.at, m.copy);
  // (<body> is the page's own, not made from the source: its path is the source's body's)
  const path = owner === document.body ? (state.src?.body ? srcPath(state.src.body) : null) : pathOf(owner);
  if (path && hooks) hooks.commit([{ t: 'attr', path, name: GUIDES_ATTR, value: m.g.own && !next.length ? null : formatGuides(next) }]);
  hooks?.draw();
}

/** the overlay's guide lines for the slide, and the one being dragged with its place in points */
export function guideParts(slide: HTMLElement | null): string {
  if (!shown || !slide || !slide.isConnected) return '';
  const f = frameOf(slide);
  const line = (g: SlideGuide, at: number, cls: string) => g.axis === 'x'
    ? `<div class="uguide x ${cls}" style="left:${f.r.x + at * f.kx}px;top:${f.r.y}px;height:${f.r.h}px"></div>`
    : `<div class="uguide y ${cls}" style="left:${f.r.x}px;top:${f.r.y + at * f.ky}px;width:${f.r.w}px"></div>`;
  const parts: string[] = [];
  const m = moving && moving.slide === slide ? moving : null;
  for (const g of guidesOf(slide)) {
    if (m && !m.copy && g.axis === m.g.axis && g.own === m.g.own && Math.abs(g.at - m.g.at) < 0.5) continue;
    parts.push(line(g, g.at, g.own ? 'own' : 'master'));
  }
  if (m) {
    parts.push(line(m.g, m.at, `${m.g.own ? 'own' : 'master'} moving${m.off ? ' off' : ''}`));
    const words = m.off ? 'Remove guide' : `${guideLabel({ axis: m.g.axis, at: m.at })} · ${m.g.own ? 'this slide' : 'every slide'}`;
    parts.push(`<div class="ulabel" style="left:${m.px}px;top:${m.py}px">${words}</div>`);
  }
  return parts.join('');
}

/** (the overlay's styles: edit.ts) */
export const GUIDES_CSS = `
  .uguide { position: absolute; pointer-events: none; box-sizing: border-box; }
  .uguide.x { width: 0; border-left: calc(1px * var(--s)) solid; }
  .uguide.y { height: 0; border-top: calc(1px * var(--s)) solid; }
  .uguide.master { border-color: #e8833a; border-style: dashed; }
  .uguide.own { border-color: #14a3b8; }
  .uguide.moving { border-style: solid; }
  .uguide.off { opacity: .35; }
  .ulabel { position: absolute; transform: translate(calc(12px * var(--s)), calc(12px * var(--s))); background: #333; color: #fff; padding: calc(2px * var(--s)) calc(6px * var(--s)); border-radius: calc(3px * var(--s)); white-space: nowrap; pointer-events: none; font: 500 calc(11px * var(--s)) / 1.3 system-ui, -apple-system, sans-serif; }
`;
