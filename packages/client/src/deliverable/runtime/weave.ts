/**
 * Weaving (Inkscape's Knot): two shapes that cross — a letter and a ring — pass over and under each
 * other, as if one were turned a little out of the slide's plane. A right-click on a crossing offers
 * "<the shape below> over <the shape above> here": the patch where both are painted around the
 * pointer gets a copy of the lower shape drawn right after the upper one, clipped to a circle around
 * that patch. The copy is a <use> of the original, so it follows it when that is moved or recoloured:
 *
 *   <g data-ol-weave pointer-events="none" clip-path="url(#weave-1)">
 *     <clipPath id="weave-1"><circle cx="…" cy="…" r="…"/></clipPath><use href="#ring" transform="…"/>
 *   </g>
 *
 * (in the upper shape's parent, its units: the transform takes the lower one's units to these). The
 * patch lets clicks through; a right-click on it offers to undo it. Plain SVG: any viewer shows it.
 */
import type { HtmlOp } from '../protocol';
import { srcOf, pathOf, slideOf } from './env';
import { commit } from './edit';

/** what a right-click found: a crossing to weave, or a weave to undo */
let pending: { upper: SVGGeometryElement; lower: SVGGeometryElement; x: number; y: number } | { undo: Element } | null = null;

const n4 = (v: number) => String(Math.round(v * 1e4) / 1e4 || 0);
const sig = (v: number) => String(Number(v.toPrecision(6)) || 0);

/** a shape's name for the menu: its name, its id, or what it is */
function nameOf(el: Element): string {
  return el.getAttribute('data-ol-name') || el.id || ({ path: 'path', circle: 'circle', ellipse: 'ellipse', rect: 'rectangle', polygon: 'polygon', polyline: 'polyline', line: 'line' } as Record<string, string>)[el.localName] || el.localName;
}

/** the shapes of drawings painted at a point of the frame (client px), the topmost first */
function shapesAt(x: number, y: number): SVGGeometryElement[] {
  return document.elementsFromPoint(x, y).filter((e): e is SVGGeometryElement =>
    e instanceof SVGGeometryElement && srcOf.has(e) && !e.closest('[data-ol-weave], defs, clipPath, mask, marker, symbol, pattern'));
}

/** a weave whose patch is at a point (client px) */
function weaveAt(x: number, y: number, slide: Element | null): Element | null {
  for (const g of Array.from(document.querySelectorAll('g[data-ol-weave]'))) {
    if (slide && slideOf(g) !== slide) continue;
    const c = g.querySelector('clipPath > circle') as SVGCircleElement | null;
    const m = (g as SVGGraphicsElement).getScreenCTM();
    if (!c || !m) continue;
    const at = new DOMPoint(c.cx.baseVal.value, c.cy.baseVal.value).matrixTransform(m);
    if (Math.hypot(at.x - x, at.y - y) <= c.r.baseVal.value * Math.sqrt(Math.abs(m.a * m.d - m.b * m.c))) return g;
  }
  return null;
}

/** the menu's line for a right-click at (x, y) (client px), or null: nothing to weave there */
export function weaveMenu(x: number, y: number, target: Element | null): { label: string; undo: boolean } | null {
  pending = null;
  const slide = target ? slideOf(target) : null;
  const done = weaveAt(x, y, slide);
  if (done) {
    pending = { undo: done };
    return { label: 'Undo the weave here', undo: true };
  }
  const [upper, lower] = shapesAt(x, y);
  if (!upper || !lower) return null;
  pending = { upper, lower, x, y };
  return { label: `Weave: ${nameOf(lower)} over ${nameOf(upper)} here`, undo: false };
}

/** whether a shape is painted at a point (client px) */
function painted(el: SVGGeometryElement, inv: DOMMatrix, c: CSSStyleDeclaration, x: number, y: number): boolean {
  const p = new DOMPoint(x, y).matrixTransform(inv);
  return (c.fill !== 'none' && el.isPointInFill(p)) || (c.stroke !== 'none' && el.isPointInStroke(p));
}

/** the patch around (x, y) where both shapes are painted, as a circle in client px */
function crossing(a: SVGGeometryElement, b: SVGGeometryElement, x: number, y: number): { x: number; y: number; r: number } | null {
  const ma = a.getScreenCTM(), mb = b.getScreenCTM();
  const svg = a.ownerSVGElement?.getBoundingClientRect();
  if (!ma || !mb || !svg) return null;
  const ia = ma.inverse(), ib = mb.inverse(), ca = getComputedStyle(a), cb = getComputedStyle(b);
  // a flood of a grid from the pointer over the points both paint (within a third of the drawing)
  const reach = Math.max(8, Math.min(svg.width, svg.height) / 3);
  const step = Math.max(0.5, reach / 150);
  const seen = new Set<string>(), todo: [number, number][] = [[0, 0]];
  let x0 = 0, y0 = 0, x1 = 0, y1 = 0, n = 0;
  while (todo.length && n < 40000) {
    const [i, j] = todo.pop()!;
    const key = `${i},${j}`;
    if (seen.has(key)) continue;
    seen.add(key);
    const px = x + i * step, py = y + j * step;
    if (Math.hypot(i * step, j * step) > reach || !painted(a, ia, ca, px, py) || !painted(b, ib, cb, px, py)) continue;
    n++;
    x0 = Math.min(x0, i); x1 = Math.max(x1, i); y0 = Math.min(y0, j); y1 = Math.max(y1, j);
    todo.push([i + 1, j], [i - 1, j], [i, j + 1], [i, j - 1]);
  }
  if (!n) return null;
  const cx = x + (x0 + x1) / 2 * step, cy = y + (y0 + y1) / 2 * step;
  // (a little beyond the patch: no seam where the copy's edge would meet the original)
  const r = Math.hypot((x1 - x0) / 2, (y1 - y0) / 2) * step + 2 * step + 1;
  return { x: cx, y: cy, r };
}

/** a free id in the page: `base`, else base-2, base-3… */
function freeId(base: string): string {
  if (!document.getElementById(base)) return base;
  let k = 2;
  while (document.getElementById(`${base}-${k}`)) k++;
  return `${base}-${k}`;
}

/** the menu's line chosen: the weave made (or undone) */
export function weave(): void {
  const p = pending;
  pending = null;
  if (!p) return;
  if ('undo' in p) {
    const path = pathOf(p.undo);
    if (path) commit([{ t: 'remove', paths: [path] }], { select: 'keep' });
    return;
  }
  const { upper, lower } = p;
  const parent = upper.parentNode as SVGGraphicsElement | null;
  const parentPath = parent && pathOf(parent), upperSrc = srcOf.get(upper), lowerPath = pathOf(lower);
  const P = parent?.getScreenCTM?.(), L = (lower.parentNode as SVGGraphicsElement | null)?.getScreenCTM?.();
  const patch = crossing(upper, lower, p.x, p.y);
  if (!parent || !parentPath || !upperSrc || !lowerPath || !P || !L || !patch) return;
  const ops: HtmlOp[] = [];
  // the lower shape needs an id for the copy to point at
  let id = lower.id;
  if (!id) {
    id = freeId(nameOf(lower).replace(/[^\w-]+/g, '-').replace(/^-+|-+$/g, '') || 'shape');
    ops.push({ t: 'attr', path: lowerPath, name: 'id', value: id });
  }
  // the patch in the upper shape's parent's units, the copy taken there from the lower one's
  const Pi = DOMMatrix.fromMatrix(P).inverse();
  const c = new DOMPoint(patch.x, patch.y).matrixTransform(Pi);
  const r = patch.r / Math.sqrt(Math.abs(P.a * P.d - P.b * P.c));
  const M = Pi.multiply(DOMMatrix.fromMatrix(L));
  const plain = Math.abs(M.a - 1) < 1e-6 && Math.abs(M.d - 1) < 1e-6 && Math.abs(M.b) < 1e-6 && Math.abs(M.c) < 1e-6;
  const t = plain ? (Math.abs(M.e) < 1e-4 && Math.abs(M.f) < 1e-4 ? '' : `translate(${n4(M.e)} ${n4(M.f)})`) : `matrix(${[M.a, M.b, M.c, M.d, M.e, M.f].map(sig).join(' ')})`;
  let k = 1;
  while (document.getElementById(`weave-${k}`)) k++;
  const cid = `weave-${k}`;
  const html = `<g data-ol-weave data-ol-name="${nameOf(lower).replace(/"/g, '')} over ${nameOf(upper).replace(/"/g, '')}" pointer-events="none" clip-path="url(#${cid})">`
    + `<clipPath id="${cid}"><circle cx="${n4(c.x)}" cy="${n4(c.y)}" r="${n4(r)}"/></clipPath>`
    + `<use href="#${id}"${t ? ` transform="${t}"` : ''}/></g>`;
  const index = Array.from(srcOf.get(parent)?.children ?? []).indexOf(upperSrc) + 1;
  ops.push({ t: 'insert', parent: parentPath, index, html });
  commit(ops, { select: 'keep' });
}
