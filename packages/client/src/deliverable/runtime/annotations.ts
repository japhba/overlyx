/** Data-defined arrows and frames. Only their rendered geometry changes; the source keeps targets. */
const NS = 'http://www.w3.org/2000/svg';
const SELECTOR = 'svg[data-ol-connector], svg[data-ol-frame]';
const GENERATED = 'g[data-ol-annotation-shape]';
type Side = 'auto' | 'center' | 'top' | 'right' | 'bottom' | 'left';
type Anchor = { id?: string; class?: string; side?: Side; offset?: [number, number] };
type Box = { x: number; y: number; w: number; h: number };
type Point = { x: number; y: number };
const active = new Set<SVGSVGElement>();
const geometry = new WeakMap<Element, string>();
let watching = false, pending = 0;
let resize: ResizeObserver | undefined;
let stopWatching: (() => void) | undefined;
const observed = new Set<Element>();

const num = (v: unknown, fallback: number) => typeof v === 'number' && Number.isFinite(v) ? v : fallback;
const fmt = (n: number) => String(Math.round(n * 1000) / 1000);
function attr(el: Element, name: string, value: string): void {
  if (el.getAttribute(name) !== value) el.setAttribute(name, value);
}
function style(el: SVGSVGElement, name: string, value: string): void {
  if (el.style.getPropertyValue(name) !== value) el.style.setProperty(name, value);
}
function anchor(value: unknown): Anchor | null {
  if (typeof value === 'string' && value) return { id: value };
  if (!value || typeof value !== 'object') return null;
  const a = value as Anchor;
  return typeof a.id === 'string' && a.id || typeof a.class === 'string' && a.class ? a : null;
}

/** Match names as values, never as CSS selectors. Resolve repeated ids within the owning slide. */
function targets(scope: Element, a: Anchor): Element[] {
  let root = scope;
  if (a.id) {
    const match = Array.from(scope.querySelectorAll('[id]')).find(el => el.id === a.id && !el.closest(SELECTOR));
    if (!match) return [];
    root = match;
  }
  if (!a.class) return a.id ? [root] : [];
  return Array.from(root.querySelectorAll('[data-mml-node][class]')).filter(el =>
    Array.from(el.classList).includes(a.class!) && !!el.closest('mjx-container'));
}

function bounds(els: Element[], scope: HTMLElement): Box | null {
  const page = scope.getBoundingClientRect();
  if (!page.width || !page.height || !scope.offsetWidth || !scope.offsetHeight) return null;
  const sx = page.width / scope.offsetWidth, sy = page.height / scope.offsetHeight;
  const rects = els.map(el => el.getBoundingClientRect()).filter(r => r.width || r.height);
  if (!rects.length) return null;
  const x = Math.min(...rects.map(r => r.left)), y = Math.min(...rects.map(r => r.top));
  return { x: (x - page.left) / sx - scope.clientLeft, y: (y - page.top) / sy - scope.clientTop,
    w: (Math.max(...rects.map(r => r.right)) - x) / sx, h: (Math.max(...rects.map(r => r.bottom)) - y) / sy };
}

function point(b: Box, a: Anchor, toward: Box): Point {
  const dx = toward.x + toward.w / 2 - b.x - b.w / 2, dy = toward.y + toward.h / 2 - b.y - b.h / 2;
  const side = !a.side || a.side === 'auto' ? (Math.abs(dx) >= Math.abs(dy) ? dx >= 0 ? 'right' : 'left' : dy >= 0 ? 'bottom' : 'top') : a.side;
  return { x: b.x + (side === 'left' ? 0 : side === 'right' ? b.w : b.w / 2) + num(a.offset?.[0], 0),
    y: b.y + (side === 'top' ? 0 : side === 'bottom' ? b.h : b.h / 2) + num(a.offset?.[1], 0) };
}

function render(svg: SVGSVGElement, used: Set<Element>): void {
  const scope = svg.parentElement;
  // Annotations are slide objects, with the slide's padding box as their coordinate system.
  if (!(scope instanceof HTMLElement) || !scope.classList.contains('slide')) { attr(svg, 'data-ol-annotation-hidden', ''); return; }
  used.add(scope);
  let config: any;
  const frame = svg.hasAttribute('data-ol-frame');
  try { config = JSON.parse(svg.getAttribute(frame ? 'data-ol-frame' : 'data-ol-connector')!); } catch { config = null; }
  const a = anchor(frame ? config?.target : config?.from), b = frame ? a : anchor(config?.to);
  const first = a ? targets(scope, a) : [], second = b ? targets(scope, b) : [];
  for (const el of [...first, ...second]) used.add(el);
  const ab = bounds(first, scope), bb = bounds(second, scope);
  if (!a || !b || !ab || !bb) { attr(svg, 'data-ol-annotation-hidden', ''); return; }
  svg.removeAttribute('data-ol-annotation-hidden');
  let box: Box, markup: string;
  if (frame) {
    const pad = Math.max(0, num(config.padding, 8)), radius = Math.max(0, num(config.radius, 8));
    box = { x: ab.x - pad, y: ab.y - pad, w: Math.max(1, ab.w + 2 * pad), h: Math.max(1, ab.h + 2 * pad) };
    markup = `<rect width="${fmt(box.w)}" height="${fmt(box.h)}" rx="${fmt(radius)}"/>`;
  } else {
    const start = point(ab, a, bb), end = point(bb, b, ab);
    const dx = end.x - start.x, dy = end.y - start.y, len = Math.hypot(dx, dy) || 1;
    const curve = num(config.curve, 0);
    const control = { x: (start.x + end.x) / 2 - dy / len * curve, y: (start.y + end.y) / 2 + dx / len * curve };
    const head = Math.max(0, num(config.head, 10));
    const tail = curve ? control : start, angle = Math.atan2(end.y - tail.y, end.x - tail.x);
    const tips = [-.45, .45].map(turn => ({ x: end.x - head * Math.cos(angle + turn), y: end.y - head * Math.sin(angle + turn) }));
    const points = [start, end, control, ...tips];
    const x = Math.min(...points.map(p => p.x)), y = Math.min(...points.map(p => p.y));
    box = { x, y, w: Math.max(1, Math.max(...points.map(p => p.x)) - x), h: Math.max(1, Math.max(...points.map(p => p.y)) - y) };
    const xy = (p: Point) => `${fmt(p.x - x)} ${fmt(p.y - y)}`;
    markup = `<path fill="none" d="M${xy(start)}${curve ? ` Q${xy(control)} ` : ' L'}${xy(end)}"/>`;
    if (head) markup += `<path fill="none" d="M${xy(tips[0])} L${xy(end)} L${xy(tips[1])}"/>`;
  }
  for (const [name, value] of Object.entries({ position: 'absolute', left: `${fmt(box.x)}px`, top: `${fmt(box.y)}px`,
    width: `${fmt(box.w)}px`, height: `${fmt(box.h)}px`, overflow: 'visible', 'pointer-events': 'none' })) style(svg, name, value);
  attr(svg, 'viewBox', `0 0 ${fmt(box.w)} ${fmt(box.h)}`);
  if (!svg.hasAttribute('stroke')) attr(svg, 'stroke', 'currentColor');
  if (!svg.hasAttribute('stroke-width')) attr(svg, 'stroke-width', '2');
  if (!svg.hasAttribute('fill')) attr(svg, 'fill', 'none');
  let shape = svg.querySelector(GENERATED);
  if (!shape) { shape = document.createElementNS(NS, 'g'); shape.setAttribute('data-ol-runtime', ''); shape.setAttribute('data-ol-annotation-shape', ''); svg.append(shape); }
  if (geometry.get(shape) !== markup) { shape.innerHTML = markup; geometry.set(shape, markup); }
}

/** Synchronous for the renderer's ready/print/export boundary; source updates also discover new annotations. */
export function refreshAnnotations(): void {
  const list = Array.from(document.querySelectorAll<SVGSVGElement>(SELECTOR));
  for (const svg of active) if (!list.includes(svg)) { svg.querySelector(GENERATED)?.remove(); svg.removeAttribute('data-ol-annotation-hidden'); active.delete(svg); }
  if (!list.length) { stopWatching?.(); return; }
  watch();
  const used = new Set<Element>();
  for (const svg of list) { active.add(svg); render(svg, used); }
  for (const el of observed) if (!used.has(el)) { resize?.unobserve(el); observed.delete(el); }
  for (const el of used) if (!observed.has(el)) { resize?.observe(el); observed.add(el); }
}

function schedule(): void {
  if (!pending) pending = requestAnimationFrame(() => { pending = 0; refreshAnnotations(); });
}
function watch(): void {
  if (watching) return;
  watching = true;
  const css = document.createElement('style');
  css.setAttribute('data-ol-runtime', '');
  css.textContent = '[data-ol-annotation-hidden] { visibility: hidden !important; }';
  document.head.append(css);
  if (typeof ResizeObserver !== 'undefined') resize = new ResizeObserver(schedule);
  const mutations = new MutationObserver(records => {
    if (records.some(r => {
      const el = r.target.nodeType === Node.ELEMENT_NODE ? r.target as Element : r.target.parentElement;
      return el && !el.closest('[data-ol-runtime], ol-overlay') && r.attributeName !== 'data-ol-annotation-hidden';
    })) schedule();
  });
  mutations.observe(document.documentElement, { subtree: true, attributes: true, childList: true, characterData: true });
  addEventListener('resize', schedule);
  document.addEventListener('load', schedule, true);
  document.fonts?.addEventListener('loadingdone', schedule);
  stopWatching = () => {
    mutations.disconnect(); resize?.disconnect(); observed.clear(); css.remove();
    removeEventListener('resize', schedule); document.removeEventListener('load', schedule, true);
    document.fonts?.removeEventListener('loadingdone', schedule);
    if (pending) cancelAnimationFrame(pending);
    pending = 0; watching = false; stopWatching = undefined;
  };
}
