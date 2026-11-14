/**
 * Connectors drawn from object to object (PowerPoint's, Keynote's): with the line or arrow tool held,
 * the object under the pointer shows its five connection points (its sides' middles and its centre);
 * a line drawn from one object to another becomes a connector — `<svg data-ol-connector='…'>`
 * (annotations.ts draws it and keeps it attached however either object moves or is resized; the
 * editor writes it: connectors.ts). Deleting an object deletes its connectors with it.
 */
import { docRect, slideOf, pathOf } from './env';
import type { Path } from '../protocol';

export type ConnSide = 'top' | 'right' | 'bottom' | 'left' | 'center' | 'auto';

const CONNECTOR = 'svg[data-ol-connector]';

/** what a connector may attach to: an object directly on a slide, not a connector itself */
export function connectable(el: Element | null): Element | null {
  if (!el || el.matches(CONNECTOR) || el.classList.contains('slide') || el.classList.contains('notes')) return null;
  const s = slideOf(el);
  return s && el.parentElement === s ? el : null;
}

/** the object under a point of the page (client coordinates), the runtime's own layer looked through */
export function objectUnder(cx: number, cy: number, objectFor: (t: Element) => Element | null): Element | null {
  for (const t of document.elementsFromPoint(cx, cy)) {
    if (t.closest('ol-overlay, [data-ol-runtime]') && !t.closest(CONNECTOR)) continue;
    const o = connectable(objectFor(t));
    if (o || t.classList.contains('slide')) return o;
  }
  return null;
}

const ANCHORS: [ConnSide, number, number][] = [['top', 0.5, 0], ['right', 1, 0.5], ['bottom', 0.5, 1], ['left', 0, 0.5], ['center', 0.5, 0.5]];

/** the connection point nearest a point of the page (document px): a side within reach of it, else `auto` (the side towards the other end) */
export function sideAt(el: Element, x: number, y: number): ConnSide {
  const r = docRect(el);
  let best: ConnSide = 'auto', dist = Infinity;
  for (const [side, fx, fy] of ANCHORS) {
    const d = Math.hypot(r.x + r.w * fx - x, r.y + r.h * fy - y);
    if (d < dist) { dist = d; best = side; }
  }
  return dist <= Math.max(14, Math.min(r.w, r.h) * 0.22) ? best : 'auto';
}

/** an object's connection points, drawn over it (the runtime's overlay; `near`: the one a line would take) */
export function anchorDots(el: Element, scale: number, near: ConnSide | null): string {
  const r = docRect(el), d = 9 / scale;
  return `<div class="frame hover" style="left:${r.x}px;top:${r.y}px;width:${r.w}px;height:${r.h}px;outline:${1 / scale}px dashed #2f6fde"></div>` + ANCHORS.map(([side, fx, fy]) =>
    `<div style="position:absolute;left:${r.x + r.w * fx - d / 2}px;top:${r.y + r.h * fy - d / 2}px;width:${d}px;height:${d}px;border-radius:50%;box-sizing:border-box;border:${1.5 / scale}px solid #2f6fde;background:${side === near ? '#2f6fde' : '#fff'}"></div>`).join('');
}

/** the connectors attached to any of these objects (or what is in them): deleted with them */
export function connectorsOf(els: Element[]): Path[] {
  const ids = new Set<string>();
  for (const el of els) for (const e of [el, ...Array.from(el.querySelectorAll('[id]'))]) if (e.id) ids.add(e.id);
  if (!ids.size) return [];
  const out: Path[] = [];
  const slides = new Set(els.map(e => slideOf(e)).filter((s): s is HTMLElement => !!s));
  for (const s of slides) for (const c of Array.from(s.querySelectorAll(CONNECTOR))) {
    if (els.includes(c)) continue;
    let cfg: { from?: unknown; to?: unknown } | null = null;
    try { cfg = JSON.parse(c.getAttribute('data-ol-connector') ?? ''); } catch { cfg = null; }
    const id = (a: unknown) => (typeof a === 'string' ? a : a && typeof a === 'object' ? (a as { id?: string }).id : undefined);
    if (cfg && [id(cfg.from), id(cfg.to)].some(x => x && ids.has(x))) { const p = pathOf(c); if (p) out.push(p); }
  }
  return out;
}

/** a connector's route and arrowhead, for the editor's menus (SelItem.connector) */
export function connectorInfo(el: Element): { route: 'straight' | 'elbow' | 'curved'; head: boolean } {
  let cfg: { route?: string; head?: number; curve?: number } = {};
  try { cfg = JSON.parse(el.getAttribute('data-ol-connector') ?? '{}') ?? {}; } catch { /* hand-written, broken */ }
  return { route: cfg.route === 'elbow' || cfg.route === 'curved' ? cfg.route : cfg.curve ? 'curved' : 'straight', head: cfg.head !== 0 };
}
