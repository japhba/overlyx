/** Data-defined arrows and frames. Only their rendered geometry changes; the source keeps targets. */
import { MODE } from './env';

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

function sideOf(b: Box, a: Anchor, toward: Box): Side {
  const dx = toward.x + toward.w / 2 - b.x - b.w / 2, dy = toward.y + toward.h / 2 - b.y - b.h / 2;
  return !a.side || a.side === 'auto' ? (Math.abs(dx) >= Math.abs(dy) ? dx >= 0 ? 'right' : 'left' : dy >= 0 ? 'bottom' : 'top') : a.side;
}
function point(b: Box, a: Anchor, toward: Box): Point {
  const side = sideOf(b, a, toward);
  return { x: b.x + (side === 'left' ? 0 : side === 'right' ? b.w : b.w / 2) + num(a.offset?.[0], 0),
    y: b.y + (side === 'top' ? 0 : side === 'bottom' ? b.h : b.h / 2) + num(a.offset?.[1], 0) };
}
/** the way out of a side (a unit vector; the centre: towards the other end) */
const NORMAL: Record<Side, Point> = { top: { x: 0, y: -1 }, bottom: { x: 0, y: 1 }, left: { x: -1, y: 0 }, right: { x: 1, y: 0 }, center: { x: 0, y: 0 }, auto: { x: 0, y: 0 } };

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
    // `route`: "elbow" (horizontal and vertical runs, PowerPoint's elbow connector) or "curved" (out of
    // each side and into the other, a cubic curve); else straight, or bent by `curve`
    const route = config.route === 'elbow' || config.route === 'curved' ? config.route as string : '';
    const sa = sideOf(ab, a, bb), sb = sideOf(bb, b, ab);
    const na = NORMAL[sa].x || NORMAL[sa].y ? NORMAL[sa] : Math.abs(dx) >= Math.abs(dy) ? { x: Math.sign(dx) || 1, y: 0 } : { x: 0, y: Math.sign(dy) || 1 };
    const nb = NORMAL[sb].x || NORMAL[sb].y ? NORMAL[sb] : { x: -na.x, y: -na.y };
    let via: Point[] = [];
    if (route === 'elbow') {
      // out of the first side; a horizontal start meets a horizontal end halfway across, a vertical one at its height
      if (na.x) via = nb.x ? [{ x: (start.x + end.x) / 2, y: start.y }, { x: (start.x + end.x) / 2, y: end.y }] : [{ x: end.x, y: start.y }];
      else via = nb.y ? [{ x: start.x, y: (start.y + end.y) / 2 }, { x: end.x, y: (start.y + end.y) / 2 }] : [{ x: start.x, y: end.y }];
    } else if (route === 'curved') {
      const k = Math.max(24, len / 3);
      via = [{ x: start.x + na.x * k, y: start.y + na.y * k }, { x: end.x + nb.x * k, y: end.y + nb.y * k }];
    }
    const last = via.length ? via[via.length - 1] : curve ? control : start;
    const tail = last.x === end.x && last.y === end.y ? start : last, angle = Math.atan2(end.y - tail.y, end.x - tail.x);
    const tips = [-.45, .45].map(turn => ({ x: end.x - head * Math.cos(angle + turn), y: end.y - head * Math.sin(angle + turn) }));
    const points = [start, end, control, ...via, ...tips];
    const x = Math.min(...points.map(p => p.x)), y = Math.min(...points.map(p => p.y));
    box = { x, y, w: Math.max(1, Math.max(...points.map(p => p.x)) - x), h: Math.max(1, Math.max(...points.map(p => p.y)) - y) };
    const xy = (p: Point) => `${fmt(p.x - x)} ${fmt(p.y - y)}`;
    const d = route === 'elbow' ? `M${xy(start)}${via.map(p => ` L${xy(p)}`).join('')} L${xy(end)}`
      : route === 'curved' ? `M${xy(start)} C${xy(via[0])} ${xy(via[1])} ${xy(end)}`
      : `M${xy(start)}${curve ? ` Q${xy(control)} ` : ' L'}${xy(end)}`;
    markup = `<path fill="none" d="${d}"/>`;
    if (head) markup += `<path fill="none" d="M${xy(tips[0])} L${xy(end)} L${xy(tips[1])}"/>`;
    // (while it is edited: a wide invisible line to click it by — the drawn one lets the pointer through)
    if (MODE === 'edit') markup += `<path fill="none" stroke="transparent" stroke-width="14" pointer-events="stroke" d="${d}"/>`;
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
