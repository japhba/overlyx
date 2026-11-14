/**
 * Exact position and size (the editor's Position and size popover, ../PositionSize.tsx). The
 * selection's box in slide px: for one object its own box as it stands before any turn (PowerPoint's
 * X / Y are its top left corner unturned), for several the box round them. A box typed there places
 * the selection — one object resized with its top left corner where it was, then moved; several moved
 * and spread as one, each scaled about the box's top left corner (their text keeps its size, as when
 * a group is resized) — as one commit of style edits, the edits a drag makes (styleOp).
 */
import type { HtmlOp, Rect } from '../protocol';
import { docRect, slideOf, pathOf } from './env';
import { start, placeLive, resizeLive, styleOp, commit, refitGroups, selection, movable, isLocked, angleOf, fixedHeight, draw, report } from './edit';

/** an object's own box on its slide (slide px), as it is before it is turned; null off a slide */
export function boxInSlide(el: Element): Rect | null {
  const s = slideOf(el);
  if (!s || el === s) return null;
  const sr = docRect(s), k = sr.w / (s.offsetWidth || sr.w) || 1;
  const r = docRect(el), he = el as HTMLElement;
  const turned = angleOf(el) !== 0 && he.offsetWidth > 0;
  const w = turned ? he.offsetWidth : r.w / k, h = turned ? he.offsetHeight : r.h / k;
  const cx = (r.x + r.w / 2 - sr.x) / k, cy = (r.y + r.h / 2 - sr.y) / k;
  return { x: cx - w / 2, y: cy - h / 2, w, h };
}

export interface PlaceTo { x?: number; y?: number; w?: number; h?: number; rotate?: number }

const differs = (a: number | undefined, b: number) => a !== undefined && Number.isFinite(a) && Math.abs(a - b) > 0.01;

/** one object to the box `to` (slide px): resized (its top left corner stays), then moved */
function placeOne(el: HTMLElement, b: Rect, to: { x: number; y: number; w: number; h: number }): HtmlOp | null {
  const d = start(el);
  const dw = to.w - b.w, dh = to.h - b.h;
  if (Math.abs(dw) > 0.01 || Math.abs(dh) > 0.01) {
    // in its own axes, as if it were not turned: its left and top stay (a turned box turns about its new middle)
    const a = d.angle;
    d.angle = 0;
    resizeLive(d, Math.abs(dw) <= 0.01 ? 's' : Math.abs(dh) <= 0.01 ? 'e' : 'se', dw, dh, false, true);
    d.angle = a;
    if (Math.abs(dh) > 0.01 && !fixedHeight(el)) el.style.setProperty('height', `${Math.max(4, d.h0 + dh)}px`);
  }
  const dx = to.x - b.x, dy = to.y - b.y;
  if (Math.abs(dx) > 0.01 || Math.abs(dy) > 0.01) placeLive(start(el), dx, dy);
  return styleOp(d);
}

/** the selection placed at the box typed (slide px; what is not given stays) */
export function placeSelection(to: PlaceTo): void {
  const els = selection().filter(e => e.isConnected && movable(e) && !isLocked(e)) as HTMLElement[];
  const boxes = els.map(boxInSlide);
  if (!els.length || boxes.some(b => !b)) return;
  const ops: HtmlOp[] = [];
  if (els.length === 1) {
    const b = boxes[0]!;
    const op = placeOne(els[0], b, { x: to.x ?? b.x, y: to.y ?? b.y, w: Math.max(1, to.w ?? b.w), h: Math.max(1, to.h ?? b.h) });
    if (op) ops.push(op);
  } else {
    const u = union(boxes as Rect[]);
    const kx = differs(to.w, u.w) && u.w > 0 ? Math.max(1, to.w!) / u.w : 1, ky = differs(to.h, u.h) && u.h > 0 ? Math.max(1, to.h!) / u.h : 1;
    const ux = to.x ?? u.x, uy = to.y ?? u.y;
    els.forEach((el, i) => {
      const b = boxes[i]!;
      const op = placeOne(el, b, { x: ux + (b.x - u.x) * kx, y: uy + (b.y - u.y) * ky, w: b.w * kx, h: fixedHeight(el) ? b.h * ky : b.h });
      if (op) ops.push(op);
    });
  }
  if (to.rotate !== undefined && Number.isFinite(to.rotate)) {
    const a = Math.round((((to.rotate % 360) + 540) % 360 - 180) * 10) / 10;
    for (const el of els) {
      const path = pathOf(el);
      if (!path || el instanceof SVGElement || Math.abs(angleOf(el) - a) < 0.05) continue;
      el.style.setProperty('rotate', `${a}deg`);
      ops.push({ t: 'style', path, set: { rotate: a ? `${a}deg` : null } });
    }
  }
  if (!ops.length) return;
  commit([...ops, ...refitGroups(els)]);
  draw();
  report();
}

function union(rs: Rect[]): Rect {
  const x = Math.min(...rs.map(r => r.x)), y = Math.min(...rs.map(r => r.y));
  return { x, y, w: Math.max(...rs.map(r => r.x + r.w)) - x, h: Math.max(...rs.map(r => r.y + r.h)) - y };
}
