/**
 * Inkscape on the canvas: the node editor (a path's points and their handles dragged, nodes added,
 * removed, made corners or smooth, segments made straight or curved, a path broken, joined, closed),
 * the Path menu (Union, Difference, Intersection, Exclusion, Combine, Break apart, Object to path,
 * Reverse, Simplify) and the Bézier pen (click for corners, drag for curves; Enter, a double-click
 * or the first node again ends it). Geometry in pathops.ts; every edit is one change of the text.
 *
 * Coordinates: a shape's own (its user space), mapped to the frame's screen by its CTM; the overlay
 * (in the runtime's shadow root) is drawn in document px.
 */
import type { HtmlOp, Path, NodeCmd, Tool } from '../protocol';
import { srcOf, pathOf, liveAt, slideOf, state, post } from './env';
import { selection, setSelection, commit, containerOf, slidePoint, cs, isSvgPart, kindOf, angleOf, isLocked, draw } from './edit';
import * as P from './pathops';
import type { PNode, Pt, SubPath, Mat } from './pathops';

const SVGNS = 'http://www.w3.org/2000/svg';
const GEOM_ATTRS = new Set(['d', 'points', 'x', 'y', 'width', 'height', 'rx', 'ry', 'cx', 'cy', 'r', 'x1', 'y1', 'x2', 'y2', 'pathLength']);
const SHAPE_TAGS = new Set(['path', 'polygon', 'polyline', 'line', 'rect', 'circle', 'ellipse']);
const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;');
const r2 = (n: number) => Math.round(n * 100) / 100;

export interface PathCtx { root: ShadowRoot; scale(): number }
let ctx: PathCtx | null = null;
export function initPaths(c: PathCtx): void { ctx = c; }

/* ------------------------------------------------------------------ geometry of elements */

const ctm = (el: Element): Mat | null => {
  const m = (el as SVGGraphicsElement).getScreenCTM?.();
  return m ? [m.a, m.b, m.c, m.d, m.e, m.f] : null;
};

/** the outline of an SVG shape in its own coordinates */
function svgSubs(el: Element): SubPath[] | null {
  const n = (a: string) => parseFloat(el.getAttribute(a) ?? '0') || 0;
  switch (el.localName) {
    case 'path': return P.parseD(el.getAttribute('d') ?? '');
    case 'polygon': return P.parsePoints(el.getAttribute('points') ?? '', true);
    case 'polyline': return P.parsePoints(el.getAttribute('points') ?? '', false);
    case 'line': return [{ closed: false, nodes: [{ p: [n('x1'), n('y1')], i: null, o: null }, { p: [n('x2'), n('y2')], i: null, o: null }] }];
    case 'rect': { const rx = el.hasAttribute('rx') ? n('rx') : n('ry'), ry = el.hasAttribute('ry') ? n('ry') : rx; return P.rectSubs(n('x'), n('y'), n('width'), n('height'), rx, ry); }
    case 'circle': return P.ellipseSubs(n('cx'), n('cy'), n('r'), n('r'));
    case 'ellipse': return P.ellipseSubs(n('cx'), n('cy'), n('rx'), n('ry'));
  }
  return null;
}

/** an HTML box shape (a div with a fill: rectangle, rounded, ellipse) as a path in client px, its rotation and flips baked in */
function boxSubs(el: HTMLElement): SubPath[] | null {
  const c = cs(el);
  const w = el.offsetWidth, h = el.offsetHeight;
  if (!w || !h) return null;
  const r = el.getBoundingClientRect();
  const k = Math.max(1e-6, (containerOf(el).getBoundingClientRect().width / (containerOf(el).offsetWidth || 1)) || 1);
  const rad = (v: string, ref: number) => (v.endsWith('%') ? parseFloat(v) / 100 * ref : parseFloat(v) || 0);
  const [rxs, rys] = (c.borderTopLeftRadius || '0').split(' ');
  const rx = rad(rxs, w), ry = rad(rys ?? rxs, h);
  const local = rx >= w / 2 - 0.5 && ry >= h / 2 - 0.5 ? P.ellipseSubs(w / 2, h / 2, w / 2, h / 2) : P.rectSubs(0, 0, w, h, rx, ry);
  const a = angleOf(el) * Math.PI / 180;
  const sc = (c as CSSStyleDeclaration & { scale?: string }).scale ?? 'none';
  const sv = sc && sc !== 'none' ? sc.trim().split(/\s+/).map(Number) : [1];
  const sx = sv[0] || 1, sy = (sv.length > 1 ? sv[1] : sv[0]) || 1;
  const cx = r.left + r.width / 2, cy = r.top + r.height / 2;
  const cos = Math.cos(a), sin = Math.sin(a);
  // centre · rotate · flip · scale(k) · (−w/2, −h/2)
  const m: Mat = P.mul([cos, sin, -sin, cos, cx, cy], P.mul([sx * k, 0, 0, sy * k, 0, 0], [1, 0, 0, 1, -w / 2, -h / 2]));
  return P.mapSubs(local, m);
}

/** a shape's outline in client px, or null when it has none (text, a picture) */
function clientSubs(el: Element): SubPath[] | null {
  if (el instanceof SVGElement) {
    if (el.localName === 'svg') {
      const parts = drawables(el);
      const all: SubPath[] = [];
      for (const s of parts) { const g = clientSubs(s); if (g) all.push(...g); }
      return all.length ? all : null;
    }
    if (el.localName === 'g') { const all: SubPath[] = []; for (const s of drawables(el)) { const g = clientSubs(s); if (g) all.push(...g); } return all.length ? all : null; }
    const subs = svgSubs(el);
    const m = ctm(el);
    return subs && m ? P.mapSubs(subs, m) : null;
  }
  if (el instanceof HTMLElement && (kindOf(el) === 'shape' || kindOf(el) === 'group')) {
    if (kindOf(el) === 'group') { const all: SubPath[] = []; for (const k of Array.from(el.children)) { const g = clientSubs(k); if (g) all.push(...g); } return all.length ? all : null; }
    return boxSubs(el);
  }
  return null;
}

function drawables(root: Element): Element[] {
  return Array.from(root.querySelectorAll('path, polygon, polyline, line, rect, circle, ellipse')).filter(s => !s.closest('defs, marker, symbol, clipPath, mask, pattern'));
}

/** the paint of the bottom object, for a path made from it */
function paintOf(el: Element): { fill: string; stroke: string; strokeWidth: string; opacity: string } {
  const shape = el.localName === 'svg' ? drawables(el)[0] ?? el : el;
  const c = cs(shape);
  if (el instanceof HTMLElement) {
    const bw = parseFloat(c.borderTopWidth) || 0;
    return { fill: c.backgroundColor === 'rgba(0, 0, 0, 0)' ? 'none' : c.backgroundColor, stroke: bw && c.borderTopStyle !== 'none' ? c.borderTopColor : 'none', strokeWidth: bw ? String(bw) : '0', opacity: c.opacity };
  }
  return { fill: c.fill || '#000', stroke: c.stroke || 'none', strokeWidth: String(parseFloat(c.strokeWidth) || 0), opacity: cs(el).opacity };
}

const isFill = (v: string) => v && v !== 'none' && !/rgba\(\s*0,\s*0,\s*0,\s*0\s*\)/.test(v);

/* ------------------------------------------------------------------ writing paths back */

/** the source element's attributes but its geometry (an SVG shape becoming a path) */
function attrsBut(src: Element, drop: Set<string>): string {
  return Array.from(src.attributes).filter(a => !drop.has(a.name)).map(a => ` ${a.name}="${esc(a.value)}"`).join('');
}

/** a top-level drawing fitted around a path given in slide px */
function fittedSvg(subs: SubPath[], paint: { fill: string; stroke: string; strokeWidth: string; opacity: string }, fillRule = 'evenodd'): string | null {
  const b = P.boundsOf(subs);
  if (!(b.w > 0 || b.h > 0)) return null;
  const pad = Math.max(0, Number(paint.strokeWidth) || 0) / 2;
  const x = Math.floor(b.x - pad), y = Math.floor(b.y - pad), w = Math.ceil(b.w + 2 * pad + (b.x - pad - x)) + 1, h = Math.ceil(b.h + 2 * pad + (b.y - pad - y)) + 1;
  const d = P.toD(P.mapSubs(subs, [1, 0, 0, 1, -x, -y]));
  const fill = isFill(paint.fill) ? paint.fill : 'none';
  const stroke = isFill(paint.stroke) && Number(paint.strokeWidth) > 0 ? ` stroke="${esc(paint.stroke)}" stroke-width="${r2(Number(paint.strokeWidth))}"` : '';
  const op = paint.opacity && paint.opacity !== '1' ? `; opacity: ${paint.opacity}` : '';
  return `<svg style="position: absolute; left: ${x}px; top: ${y}px; width: ${w}px; height: ${h}px; overflow: visible${op}" viewBox="0 0 ${w} ${h}"><path d="${d}" fill="${esc(fill)}"${fill !== 'none' ? ` fill-rule="${fillRule}"` : ''}${stroke}/></svg>`;
}

const clientToSlide = (slide: HTMLElement) => (p: Pt): Pt => slidePoint(slide, p[0] + scrollX, p[1] + scrollY);
const mapFn = (subs: SubPath[], f: (p: Pt) => Pt): SubPath[] => subs.map(sp => ({ closed: sp.closed, nodes: sp.nodes.map(n => ({ p: f(n.p), i: n.i && f(n.i), o: n.o && f(n.o), smooth: n.smooth })) }));

/** z-order across the page: document order */
const docOrder = (a: Element, b: Element) => (a.compareDocumentPosition(b) & Node.DOCUMENT_POSITION_FOLLOWING ? -1 : 1);

/* ------------------------------------------------------------------ the Path menu */

export function pathCommand(how: string): void {
  const sel = selection().filter(e => !isLocked(e)).sort(docOrder);
  if (!sel.length) return;
  switch (how) {
    case 'union': case 'difference': case 'intersection': case 'exclusion': return booleans(sel, how);
    case 'combine': return combine(sel);
    case 'break-apart': return breakApart(sel);
    case 'to-path': return toPath(sel);
    case 'reverse': case 'simplify': return rewrite(sel, how);
    case 'edit-nodes': return editNodesOf(sel[0]);
  }
}

/** the objects' frame for a result: one drawing's own space when all are parts of it, else the slide */
function frameFor(sel: Element[]): { svg: SVGSVGElement; toFrame: (p: Pt) => Pt } | { slide: HTMLElement; toFrame: (p: Pt) => Pt } | null {
  const roots = new Set(sel.map(e => (isSvgPart(e) ? e.ownerSVGElement : null)));
  if (roots.size === 1 && !roots.has(null)) {
    const svg = [...roots][0]!;
    const m = ctm(svg);
    if (!m) return null;
    const inv = P.invert(m);
    return { svg, toFrame: p => P.apply(inv, p) };
  }
  const slide = containerOf(sel[0].localName === 'svg' || sel[0] instanceof HTMLElement ? sel[0] : (sel[0] as SVGElement).ownerSVGElement ?? sel[0]);
  return { slide, toFrame: clientToSlide(slide) };
}

/** a result path put where the bottom object was, the other objects removed */
function replaceWith(sel: Element[], subsClient: SubPath[], fillRule = 'evenodd'): void {
  const fr = frameFor(sel);
  if (!fr) return;
  const subs = mapFn(subsClient, fr.toFrame);
  const bottom = sel[0];
  const paint = paintOf(bottom);
  const paths = sel.map(pathOf);
  if (paths.some(p => !p)) return;
  const bp = paths[0]!;
  const rest = paths.slice(1) as Path[];
  if ('svg' in fr) {
    // inside the drawing: the bottom part becomes the result, its own paint kept
    const src = srcOf.get(bottom)!;
    const html = `<path${attrsBut(src, new Set([...GEOM_ATTRS, 'transform', 'fill-rule']))} d="${P.toD(subs)}" fill-rule="${fillRule}"/>`;
    commit([{ t: 'outer', path: bp, html }, ...(rest.length ? [{ t: 'remove', paths: rest } as HtmlOp] : [])], { select: [bp] });
    return;
  }
  const html = fittedSvg(subs, paint, fillRule);
  if (!html) { commit([{ t: 'remove', paths: paths as Path[] }]); return; }
  if (isSvgPart(bottom)) {
    // the bottom object is part of a drawing (the others are not): the result goes after that drawing
    const root = bottom.ownerSVGElement!;
    const rp = pathOf(root);
    if (!rp) return;
    commit([{ t: 'insert', parent: rp.slice(0, -1), index: rp[rp.length - 1] + 1, html }, { t: 'remove', paths: paths as Path[] }], { select: 'inserted' });
    return;
  }
  commit([{ t: 'outer', path: bp, html }, ...(rest.length ? [{ t: 'remove', paths: rest } as HtmlOp] : [])], { select: [bp] });
}

function booleans(sel: Element[], op: P.BoolOp): void {
  if (sel.length < 2) return;
  const areas = sel.map(el => { const s = clientSubs(el); return s ? P.areaOf(P.flatten(s.filter(sp => sp.closed || sp.nodes.length > 2).map(sp => ({ ...sp, closed: true })), 0.1)) : []; });
  if (areas.some(a => !a.length)) return;
  const result = P.booleanOp(op, areas);
  replaceWith(sel, P.multiPolygonToSubs(result, 0.3));
}

function combine(sel: Element[]): void {
  if (sel.length < 2) return;
  const all: SubPath[] = [];
  for (const el of sel) { const s = clientSubs(el); if (s) all.push(...s); }
  if (all.length) replaceWith(sel, all);
}

function breakApart(sel: Element[]): void {
  const ops: HtmlOp[] = [];
  for (const el of sel) {
    const shape = el.localName === 'svg' ? (drawables(el).length === 1 ? drawables(el)[0] : null) : el;
    if (!shape || shape.localName !== 'path') continue;
    const subs = P.parseD(shape.getAttribute('d') ?? '');
    if (subs.length < 2) continue;
    const src = srcOf.get(shape);
    const path = pathOf(shape);
    if (!src || !path) continue;
    if (el.localName === 'svg' && !isSvgPart(el)) {
      // a drawing of one path: each piece its own drawing, fitted to it
      const m = ctm(shape);
      const slide = containerOf(el);
      const ep = pathOf(el);
      if (!m || !ep) continue;
      const paint = paintOf(el);
      const pieces = subs.map(sp => fittedSvg(mapFn(P.mapSubs([sp], m), clientToSlide(slide)), paint)).filter((h): h is string => !!h);
      ops.push({ t: 'outer', path: ep, html: pieces.join('\n') });
    } else {
      ops.push({ t: 'outer', path, html: subs.map(sp => `<path${attrsBut(src, new Set(['d', 'id']))} d="${P.toD([sp])}"/>`).join('') });
    }
  }
  if (ops.length) commit(ops);
}

/** Object to path: shapes and boxes become paths (a box with text in it stays a box) */
function toPath(sel: Element[], then?: (paths: Path[]) => void): void {
  const ops: HtmlOp[] = [];
  const out: Path[] = [];
  for (const el of sel) {
    const r = toPathOp(el);
    if (r) { ops.push(r.op); out.push(r.edit); }
  }
  if (ops.length) { commit(ops, { select: out.map(p => p) }); then?.(out); }
}

function toPathOp(el: Element): { op: HtmlOp; edit: Path } | null {
  const path = pathOf(el);
  const src = srcOf.get(el);
  if (!path || !src) return null;
  if (el instanceof SVGElement && el.localName !== 'svg' && SHAPE_TAGS.has(el.localName) && el.localName !== 'path') {
    const subs = svgSubs(el);
    if (!subs) return null;
    return { op: { t: 'outer', path, html: `<path${attrsBut(src, GEOM_ATTRS)} d="${P.toD(subs)}"/>` }, edit: path };
  }
  if (el.localName === 'svg') {
    const ds = drawables(el);
    if (ds.length === 1 && ds[0].localName !== 'path') {
      const r = toPathOp(ds[0]);
      return r ? { op: r.op, edit: r.edit } : null;
    }
    return ds.length === 1 ? { op: { t: 'attr', path: pathOf(ds[0])!, name: 'd', value: ds[0].getAttribute('d') }, edit: pathOf(ds[0])! } : null;
  }
  if (el instanceof HTMLElement && kindOf(el) === 'shape' && !(el.textContent ?? '').trim()) {
    const subs = boxSubs(el);
    const slide = containerOf(el);
    if (!subs) return null;
    const html = fittedSvg(mapFn(subs, clientToSlide(slide)), paintOf(el), 'nonzero');
    return html ? { op: { t: 'outer', path, html }, edit: [...path, 0] } : null;
  }
  return null;
}

function rewrite(sel: Element[], how: 'reverse' | 'simplify'): void {
  const ops: HtmlOp[] = [];
  for (const el of sel) {
    const shape = el.localName === 'svg' ? (drawables(el).length === 1 ? drawables(el)[0] : null) : el;
    if (!shape || shape.localName !== 'path') continue;
    const path = pathOf(shape);
    if (!path) continue;
    let subs = P.parseD(shape.getAttribute('d') ?? '');
    if (how === 'reverse') subs = P.reverseSubs(subs);
    else {
      // ~1.5 screen px, in the path's own units
      const m = ctm(shape);
      const k = m ? Math.sqrt(Math.abs(m[0] * m[3] - m[1] * m[2])) || 1 : 1;
      subs = P.simplifySubs(subs, 1.5 / k / (ctx?.scale() ?? 1));
    }
    ops.push({ t: 'attr', path, name: 'd', value: P.toD(subs) });
  }
  if (ops.length) commit(ops);
}

/* ------------------------------------------------------------------ the node editor */

interface Ed {
  el: SVGGraphicsElement;
  path: Path;
  subs: SubPath[];
  /** selected nodes, as "subpath:node" */
  sel: Set<string>;
  wrap: HTMLElement;
  svg: SVGSVGElement;
  drag: null | { kind: 'nodes'; last: Pt; moved: boolean } | { kind: 'handle'; s: number; k: number; which: 'i' | 'o'; moved: boolean } | { kind: 'marquee'; from: Pt; to: Pt; add: boolean; moved: boolean };
  off: () => void;
}
let ed: Ed | null = null;
/** a path to edit once the next version shows it (a shape was made a path first) */
let pendingEdit: Path | null = null;

export function isNodeEditing(): boolean { return !!ed; }

/** "Edit points": a path at once, other shapes made paths first */
function editNodesOf(el: Element): void {
  const shape = el.localName === 'svg' ? (drawables(el).length === 1 ? drawables(el)[0] : null) : el;
  if (shape && shape.localName === 'path') { startNodes(shape as SVGGraphicsElement); return; }
  const r = toPathOp(shape ?? el);
  if (!r) return;
  pendingEdit = r.edit;
  commit([r.op], { select: [r.edit] });
}

/** after a new version of the text: a pending node edit starts, the one going on finds its path again */
export function nodesAfterSource(): void {
  if (pendingEdit) {
    const el = liveAt(pendingEdit);
    pendingEdit = null;
    if (el && el.localName === 'path') { setSelection([el]); startNodes(el as SVGGraphicsElement); }
    return;
  }
  if (!ed) return;
  if (!ed.el.isConnected) {
    const el = liveAt(ed.path);
    if (el && el.localName === 'path') ed.el = el as SVGGraphicsElement;
    else { endNodes(); return; }
  }
  // someone else changed it: their version
  const d = ed.el.getAttribute('d') ?? '';
  if (d !== P.toD(ed.subs)) ed.subs = P.parseD(d);
  render();
}

/** a double-click on a path (or a drawing that is one shape): its nodes */
export function nodesTargetOf(t: Element, selected: Element | null): SVGGraphicsElement | null {
  const shape = t instanceof SVGElement && SHAPE_TAGS.has(t.localName) ? t : null;
  if (!shape || shape.localName === 'line' || !srcOf.has(shape)) return null;
  // a part of the selected drawing (or the selected part itself), or the only shape of a drawing
  const root = (shape as SVGGraphicsElement).ownerSVGElement;
  if (selected === shape) return shape as SVGGraphicsElement;
  if (root && selected === root && drawables(root).length === 1) return shape as SVGGraphicsElement;
  return null;
}

export function startNodesOrConvert(shape: SVGGraphicsElement): void {
  if (shape.localName === 'path') startNodes(shape);
  else editNodesOf(shape);
}

const NODE_CSS = `.nodes svg { position: absolute; left: 0; top: 0; overflow: visible; pointer-events: none; }
  .nodes .out { fill: none; stroke: #2f6fde; }
  .nodes .hl { stroke: #6b7280; }
  .nodes .h { fill: #fff; stroke: #2f6fde; }
  .nodes .n { fill: #fff; stroke: #2f6fde; }
  .nodes .n.on { fill: #2f6fde; }
  .nodes .mq { fill: rgba(47,111,222,.08); stroke: #2f6fde; stroke-dasharray: 4 3; }`;

function startNodes(el: SVGGraphicsElement): void {
  if (!ctx) return;
  endNodes();
  const path = pathOf(el);
  if (!path) return;
  const wrap = document.createElement('div');
  wrap.className = 'nodes';
  const style = document.createElement('style');
  style.textContent = NODE_CSS;
  const svg = document.createElementNS(SVGNS, 'svg') as SVGSVGElement;
  svg.setAttribute('width', '1'); svg.setAttribute('height', '1');
  wrap.append(style, svg);
  ctx.root.appendChild(wrap);
  const e: Ed = { el, path, subs: P.parseD(el.getAttribute('d') ?? ''), sel: new Set(), wrap, svg, drag: null, off: () => undefined };
  ed = e;
  const opts = { capture: true, passive: false } as AddEventListenerOptions;
  const onScroll = () => render();
  addEventListener('pointerdown', onDown, opts);
  addEventListener('pointermove', onMove, opts);
  addEventListener('pointerup', onUp, opts);
  addEventListener('dblclick', onDbl, opts);
  addEventListener('keydown', onKey, opts);
  addEventListener('scroll', onScroll, { passive: true });
  e.off = () => {
    removeEventListener('pointerdown', onDown, opts); removeEventListener('pointermove', onMove, opts); removeEventListener('pointerup', onUp, opts);
    removeEventListener('dblclick', onDbl, opts); removeEventListener('keydown', onKey, opts); removeEventListener('scroll', onScroll);
  };
  draw();
  render();
}

export function endNodes(): void {
  if (!ed) return;
  const e = ed;
  ed = null;
  e.off();
  e.wrap.remove();
  refit(e.el);
  post({ ol: 'nodeEditing', path: null, selected: 0, total: 0 });
  draw();
}

export function redrawNodes(): void { if (ed) render(); }

/**
 * A drawing of one path, its points edited: its box fitted to the path again (the viewBox moved
 * and resized in the drawing's own units, the box on the slide with it) — so the selection, the
 * snapping and the thumbnails see the shape where it is. Not for a rotated drawing (its centre would move).
 */
function refit(shape: Element): void {
  const svg = (shape as SVGGraphicsElement).ownerSVGElement;
  if (!svg || isSvgPart(svg as Element) || drawables(svg).length !== 1 || angleOf(svg) || !shape.isConnected) return;
  const vb = svg.viewBox?.baseVal;
  const sp = pathOf(svg);
  if (!vb || !vb.width || !vb.height || !sp) return;
  const c = cs(svg);
  if (c.position !== 'absolute') return;
  const left = parseFloat(c.left), top = parseFloat(c.top), w = parseFloat(c.width), h = parseFloat(c.height);
  if (![left, top, w, h].every(Number.isFinite)) return;
  const subs = P.parseD(shape.getAttribute('d') ?? '');
  const b = P.boundsOf(shape.getAttribute('transform') ? P.mapSubs(subs, (() => { const t = (shape as SVGGraphicsElement).transform.baseVal.consolidate()?.matrix; return t ? [t.a, t.b, t.c, t.d, t.e, t.f] as Mat : [1, 0, 0, 1, 0, 0] as Mat; })()) : subs);
  const sx = w / vb.width, sy = h / vb.height;
  const sc = cs(shape);
  const pad = (sc.stroke && sc.stroke !== 'none' ? parseFloat(sc.strokeWidth) || 0 : 0) / 2 / Math.min(sx, sy) + 0.5;
  const nx = b.x - pad, ny = b.y - pad, nw = b.w + 2 * pad, nh = b.h + 2 * pad;
  if (Math.abs(nx - vb.x) < 0.5 && Math.abs(ny - vb.y) < 0.5 && Math.abs(nw - vb.width) < 0.5 && Math.abs(nh - vb.height) < 0.5) return;
  const px = (v: number) => `${r2(v)}px`;
  commit([
    { t: 'style', path: sp, set: { left: px(left + (nx - vb.x) * sx), top: px(top + (ny - vb.y) * sy), width: px(nw * sx), height: px(nh * sy) } },
    { t: 'attr', path: sp, name: 'viewBox', value: `${r2(nx)} ${r2(ny)} ${r2(nw)} ${r2(nh)}` },
  ]);
}

const key = (s: number, k: number) => `${s}:${k}`;
const pageOf = (m: Mat, p: Pt): Pt => { const c = P.apply(m, p); return [c[0] + scrollX, c[1] + scrollY]; };

function render(): void {
  const e = ed;
  if (!e || !ctx) return;
  const m = ctm(e.el);
  if (!m) return;
  const sc = ctx.scale();
  const hs = 4.5 / sc, rh = 3.5 / sc, lw = 1 / sc;
  const toPage = (p: Pt) => pageOf(m, p);
  const parts: string[] = [`<path class="out" stroke-width="${lw}" d="${P.toD(P.mapSubs(e.subs, [m[0], m[1], m[2], m[3], m[4] + scrollX, m[5] + scrollY]))}"/>`];
  e.subs.forEach((sp, s) => sp.nodes.forEach((n, k) => {
    // handles: of the selected nodes, and the ones next to them that shape their segments
    const show = e.sel.has(key(s, k)) || e.sel.has(key(s, (k + 1) % sp.nodes.length)) || e.sel.has(key(s, (k - 1 + sp.nodes.length) % sp.nodes.length));
    if (!show) return;
    const P0 = toPage(n.p);
    for (const h of [n.i, n.o]) if (h) { const H = toPage(h); parts.push(`<line class="hl" stroke-width="${lw}" x1="${P0[0]}" y1="${P0[1]}" x2="${H[0]}" y2="${H[1]}"/><circle class="h" stroke-width="${lw}" cx="${H[0]}" cy="${H[1]}" r="${rh}"/>`); }
  }));
  e.subs.forEach((sp, s) => sp.nodes.forEach((n, k) => {
    const [x, y] = toPage(n.p);
    const on = e.sel.has(key(s, k)) ? ' on' : '';
    // Inkscape's marks: a diamond for a corner, a square for a smooth node
    parts.push(n.smooth
      ? `<rect class="n${on}" stroke-width="${lw}" x="${x - hs}" y="${y - hs}" width="${2 * hs}" height="${2 * hs}"/>`
      : `<path class="n${on}" stroke-width="${lw}" d="M${x} ${y - hs * 1.3}L${x + hs * 1.3} ${y}L${x} ${y + hs * 1.3}L${x - hs * 1.3} ${y}Z"/>`);
  }));
  if (e.drag?.kind === 'marquee' && e.drag.moved) {
    const [a, b] = [e.drag.from, e.drag.to];
    parts.push(`<rect class="mq" stroke-width="${lw}" x="${Math.min(a[0], b[0])}" y="${Math.min(a[1], b[1])}" width="${Math.abs(a[0] - b[0])}" height="${Math.abs(a[1] - b[1])}"/>`);
  }
  e.svg.innerHTML = parts.join('');
  post({ ol: 'nodeEditing', path: e.path, selected: e.sel.size, total: e.subs.reduce((t, sp) => t + sp.nodes.length, 0) });
}

/** the live path shows the nodes as they are (the text changes when the gesture ends) */
function live(): void { if (ed) ed.el.setAttribute('d', P.toD(ed.subs)); render(); }

function save(): void {
  if (!ed) return;
  const d = P.toD(ed.subs);
  ed.el.setAttribute('d', d);
  if (!ed.subs.some(sp => sp.nodes.length > (sp.closed ? 2 : 1))) { const p = ed.path; endNodes(); commit([{ t: 'remove', paths: [p] }]); return; }
  commit([{ t: 'attr', path: ed.path, name: 'd', value: d }]);
  render();
}

/** what is under a document point: a handle, a node, the outline */
function hit(q: Pt): { kind: 'handle'; s: number; k: number; which: 'i' | 'o' } | { kind: 'node'; s: number; k: number } | { kind: 'outline'; s: number; k: number; t: number } | null {
  const e = ed!;
  const m = ctm(e.el);
  if (!m) return null;
  const sc = ctx!.scale();
  const R = 7 / sc;
  const d = (p: Pt) => { const pp = pageOf(m, p); return Math.hypot(pp[0] - q[0], pp[1] - q[1]); };
  for (let s = 0; s < e.subs.length; s++) for (let k = 0; k < e.subs[s].nodes.length; k++) {
    const sp = e.subs[s], n = sp.nodes[k];
    const near = e.sel.has(key(s, k)) || e.sel.has(key(s, (k + 1) % sp.nodes.length)) || e.sel.has(key(s, (k - 1 + sp.nodes.length) % sp.nodes.length));
    if (!near) continue;
    if (n.o && d(n.o) < R) return { kind: 'handle', s, k, which: 'o' };
    if (n.i && d(n.i) < R) return { kind: 'handle', s, k, which: 'i' };
  }
  for (let s = 0; s < e.subs.length; s++) for (let k = 0; k < e.subs[s].nodes.length; k++) if (d(e.subs[s].nodes[k].p) < R) return { kind: 'node', s, k };
  const local = P.apply(P.invert(m), [q[0] - scrollX, q[1] - scrollY]);
  const nh = P.nearestOnPath(e.subs, local);
  if (nh) {
    const pp = pageOf(m, nh.p);
    if (Math.hypot(pp[0] - q[0], pp[1] - q[1]) < 6 / sc) return { kind: 'outline', s: nh.s, k: nh.k, t: nh.t };
  }
  return null;
}

function toLocal(q: Pt): Pt { const m = ctm(ed!.el)!; return P.apply(P.invert(m), [q[0] - scrollX, q[1] - scrollY]); }

function onDown(ev: PointerEvent): void {
  const e = ed;
  if (!e || ev.button !== 0) return;
  ev.preventDefault(); ev.stopPropagation();
  const q: Pt = [ev.pageX, ev.pageY];
  const h = hit(q);
  try { (ev.target as Element).setPointerCapture?.(ev.pointerId); } catch { /* fine */ }
  if (h?.kind === 'handle') { e.drag = { kind: 'handle', s: h.s, k: h.k, which: h.which, moved: false }; return; }
  if (h?.kind === 'node') {
    const id = key(h.s, h.k);
    if (ev.shiftKey) { if (e.sel.has(id)) e.sel.delete(id); else e.sel.add(id); }
    else if (!e.sel.has(id)) e.sel = new Set([id]);
    e.drag = { kind: 'nodes', last: toLocal(q), moved: false };
    render();
    return;
  }
  if (h?.kind === 'outline') {
    // the segment's two nodes
    const sp = e.subs[h.s];
    const ids = [key(h.s, h.k), key(h.s, (h.k + 1) % sp.nodes.length)];
    e.sel = ev.shiftKey ? new Set([...e.sel, ...ids]) : new Set(ids);
    e.drag = { kind: 'nodes', last: toLocal(q), moved: false };
    render();
    return;
  }
  e.drag = { kind: 'marquee', from: q, to: q, add: ev.shiftKey, moved: false };
}

function onMove(ev: PointerEvent): void {
  const e = ed;
  if (!e || !e.drag) return;
  ev.preventDefault(); ev.stopPropagation();
  const q: Pt = [ev.pageX, ev.pageY];
  const d = e.drag;
  if (d.kind === 'marquee') { d.to = q; d.moved = d.moved || Math.hypot(q[0] - d.from[0], q[1] - d.from[1]) > 3; render(); return; }
  const lq = toLocal(q);
  if (d.kind === 'nodes') {
    const dx = lq[0] - d.last[0], dy = lq[1] - d.last[1];
    d.last = lq; d.moved = true;
    for (const id of e.sel) {
      const [s, k] = id.split(':').map(Number);
      const n = e.subs[s]?.nodes[k];
      if (!n) continue;
      n.p = [n.p[0] + dx, n.p[1] + dy];
      if (n.i) n.i = [n.i[0] + dx, n.i[1] + dy];
      if (n.o) n.o = [n.o[0] + dx, n.o[1] + dy];
    }
    live();
    return;
  }
  // a handle; a smooth node turns its other handle with it (keeping that one's length)
  const n = e.subs[d.s].nodes[d.k];
  d.moved = true;
  n[d.which] = lq;
  const other = d.which === 'i' ? 'o' : 'i';
  if (n.smooth && n[other] && !ev.altKey) {
    const L = Math.hypot(n[other]![0] - n.p[0], n[other]![1] - n.p[1]);
    const vx = n.p[0] - lq[0], vy = n.p[1] - lq[1], l = Math.hypot(vx, vy) || 1;
    n[other] = [n.p[0] + vx / l * L, n.p[1] + vy / l * L];
  }
  live();
}

function onUp(ev: PointerEvent): void {
  const e = ed;
  if (!e || !e.drag) return;
  ev.preventDefault(); ev.stopPropagation();
  const d = e.drag;
  e.drag = null;
  if (d.kind === 'marquee') {
    if (!d.moved) { endNodes(); return; }   // a click beside the path: done
    const m = ctm(e.el)!;
    const x0 = Math.min(d.from[0], d.to[0]), x1 = Math.max(d.from[0], d.to[0]), y0 = Math.min(d.from[1], d.to[1]), y1 = Math.max(d.from[1], d.to[1]);
    const next = d.add ? new Set(e.sel) : new Set<string>();
    e.subs.forEach((sp, s) => sp.nodes.forEach((n, k) => { const [x, y] = pageOf(m, n.p); if (x >= x0 && x <= x1 && y >= y0 && y <= y1) next.add(key(s, k)); }));
    e.sel = next;
    render();
    return;
  }
  if (d.moved) save();
}

function onDbl(ev: MouseEvent): void {
  const e = ed;
  if (!e) return;
  ev.preventDefault(); ev.stopPropagation();
  const h = hit([ev.pageX, ev.pageY]);
  if (h?.kind === 'outline') {
    const at = P.splitAt(e.subs[h.s], h.k, h.t);
    if (at >= 0) { e.sel = new Set([key(h.s, at)]); save(); }
  } else if (h?.kind === 'node') nodeCommand(e.subs[h.s].nodes[h.k].smooth ? 'corner' : 'smooth');
}

function onKey(ev: KeyboardEvent): void {
  const e = ed;
  if (!e) return;
  const mod = ev.ctrlKey || ev.metaKey;
  if (ev.key === 'Escape' || ev.key === 'Enter') { ev.preventDefault(); ev.stopPropagation(); endNodes(); return; }
  if (ev.key === 'Delete' || ev.key === 'Backspace') { ev.preventDefault(); ev.stopPropagation(); nodeCommand('delete'); return; }
  if (mod && ev.key.toLowerCase() === 'a') { ev.preventDefault(); ev.stopPropagation(); nodeCommand('all'); return; }
  if (ev.key.startsWith('Arrow') && e.sel.size) {
    ev.preventDefault(); ev.stopPropagation();
    const st = (ev.shiftKey ? 10 : 1) / (ctx?.scale() ?? 1);
    const m = ctm(e.el)!;
    const a = toLocal([scrollX, scrollY]), b = toLocal([scrollX + (ev.key === 'ArrowLeft' ? -st : ev.key === 'ArrowRight' ? st : 0), scrollY + (ev.key === 'ArrowUp' ? -st : ev.key === 'ArrowDown' ? st : 0)]);
    void m;
    const dx = b[0] - a[0], dy = b[1] - a[1];
    for (const id of e.sel) { const [s, k] = id.split(':').map(Number); const n = e.subs[s]?.nodes[k]; if (!n) continue; n.p = [n.p[0] + dx, n.p[1] + dy]; if (n.i) n.i = [n.i[0] + dx, n.i[1] + dy]; if (n.o) n.o = [n.o[0] + dx, n.o[1] + dy]; }
    save();
    return;
  }
  if (!mod) { ev.stopPropagation(); }
}

/** the selected nodes, in path order */
function selectedNodes(): { s: number; k: number }[] {
  if (!ed) return [];
  return [...ed.sel].map(id => id.split(':').map(Number)).map(([s, k]) => ({ s, k })).filter(x => ed!.subs[x.s]?.nodes[x.k]).sort((a, b) => a.s - b.s || a.k - b.k);
}

/** a segment both of whose ends are selected (k → k+1) */
function selectedSegments(): { s: number; k: number }[] {
  const e = ed!;
  const out: { s: number; k: number }[] = [];
  e.subs.forEach((sp, s) => { for (let k = 0; k < sp.nodes.length; k++) { const nk = (k + 1) % sp.nodes.length; if ((k < sp.nodes.length - 1 || sp.closed) && e.sel.has(key(s, k)) && e.sel.has(key(s, nk))) out.push({ s, k }); } });
  return out;
}

export function nodeCommand(cmd: NodeCmd): void {
  const e = ed;
  if (!e) return;
  const sel = selectedNodes();
  switch (cmd) {
    case 'done': endNodes(); return;
    case 'all': e.sel = new Set(e.subs.flatMap((sp, s) => sp.nodes.map((_, k) => key(s, k)))); render(); return;
    case 'insert': {
      // a node in the middle of each segment between selected nodes (or after a lone selected node)
      const segs = selectedSegments();
      const todo = segs.length ? segs : sel.filter(x => P.segment(e.subs[x.s], x.k));
      const next = new Set<string>();
      for (const g of todo.sort((a, b) => b.s - a.s || b.k - a.k)) { const at = P.splitAt(e.subs[g.s], g.k, 0.5); if (at >= 0) next.add(key(g.s, at)); }
      e.sel = next;
      save();
      return;
    }
    case 'delete': {
      for (const x of sel.sort((a, b) => b.s - a.s || b.k - a.k)) e.subs[x.s].nodes.splice(x.k, 1);
      e.subs = e.subs.filter(sp => sp.nodes.length >= 2);
      e.sel = new Set();
      save();
      return;
    }
    case 'corner': case 'smooth': {
      for (const { s, k } of sel) {
        const sp = e.subs[s], n = sp.nodes[k];
        if (cmd === 'corner') { n.smooth = false; continue; }
        n.smooth = true;
        // handles on one line, a third of each neighbouring segment long (Inkscape's "make smooth")
        const prev = sp.nodes[(k - 1 + sp.nodes.length) % sp.nodes.length], next = sp.nodes[(k + 1) % sp.nodes.length];
        const hasPrev = k > 0 || sp.closed, hasNext = k < sp.nodes.length - 1 || sp.closed;
        const a = hasPrev ? prev.p : n.p, b = hasNext ? next.p : n.p;
        let tx = b[0] - a[0], ty = b[1] - a[1];
        const tl = Math.hypot(tx, ty) || 1; tx /= tl; ty /= tl;
        if (hasPrev) { const l = Math.hypot(n.p[0] - prev.p[0], n.p[1] - prev.p[1]) / 3; n.i = [n.p[0] - tx * l, n.p[1] - ty * l]; }
        if (hasNext) { const l = Math.hypot(next.p[0] - n.p[0], next.p[1] - n.p[1]) / 3; n.o = [n.p[0] + tx * l, n.p[1] + ty * l]; }
      }
      save();
      return;
    }
    case 'straight': case 'curve': {
      const segs = selectedSegments();
      for (const { s, k } of segs) {
        const sp = e.subs[s], a = sp.nodes[k], b = sp.nodes[(k + 1) % sp.nodes.length];
        if (cmd === 'straight') { a.o = null; b.i = null; a.smooth = false; b.smooth = false; }
        else { a.o = [a.p[0] + (b.p[0] - a.p[0]) / 3, a.p[1] + (b.p[1] - a.p[1]) / 3]; b.i = [a.p[0] + (b.p[0] - a.p[0]) * 2 / 3, a.p[1] + (b.p[1] - a.p[1]) * 2 / 3]; }
      }
      save();
      return;
    }
    case 'break': {
      // the path opened at each selected node (a closed path becomes open there, an open one two)
      for (const { s, k } of sel.sort((a, b) => b.s - a.s || b.k - a.k)) {
        const sp = e.subs[s];
        const n = sp.nodes[k];
        if (sp.closed) { sp.nodes = [...sp.nodes.slice(k), ...sp.nodes.slice(0, k), { p: [n.p[0], n.p[1]], i: n.i, o: null }]; sp.nodes[0].i = null; sp.closed = false; }
        else if (k > 0 && k < sp.nodes.length - 1) {
          const tail: SubPath = { closed: false, nodes: [{ p: [n.p[0], n.p[1]], i: null, o: n.o }, ...sp.nodes.slice(k + 1)] };
          sp.nodes = [...sp.nodes.slice(0, k), { ...n, o: null }];
          e.subs.splice(s + 1, 0, tail);
        }
      }
      e.sel = new Set();
      save();
      return;
    }
    case 'join': {
      // two end nodes selected: one path (the same subpath: closed)
      const ends = sel.filter(x => !e.subs[x.s].closed && (x.k === 0 || x.k === e.subs[x.s].nodes.length - 1));
      if (ends.length !== 2) return;
      const [a, b] = ends;
      if (a.s === b.s) { e.subs[a.s].closed = true; save(); return; }
      let A = e.subs[a.s], B = e.subs[b.s];
      if (a.k === 0) A = P.reverseSubs([A])[0];
      if (b.k !== 0) B = P.reverseSubs([B])[0];
      const joined: SubPath = { closed: false, nodes: [...A.nodes, ...B.nodes] };
      e.subs = e.subs.filter((_, i) => i !== a.s && i !== b.s);
      e.subs.splice(Math.min(a.s, b.s), 0, joined);
      e.sel = new Set();
      save();
      return;
    }
    case 'close': {
      const ss = new Set(sel.map(x => x.s));
      for (const s of ss.size ? ss : new Set(e.subs.map((_, i) => i))) e.subs[s].closed = !e.subs[s].closed;
      save();
      return;
    }
  }
}

/* ------------------------------------------------------------------ the Bézier pen */

interface Pen { nodes: PNode[]; slide: HTMLElement | null; drag: number | null; hover: Pt | null; wrap: HTMLElement; svg: SVGSVGElement }
let pen: Pen | null = null;

export function isPenDrawing(): boolean { return !!pen; }

/** a press with the Bézier tool: a node (dragging pulls its handles), the first node again closes the path */
export function penDown(ev: PointerEvent, slideAt: (t: Element) => HTMLElement | null): void {
  if (!ctx) return;
  const q: Pt = [ev.pageX, ev.pageY];
  if (!pen) {
    const wrap = document.createElement('div');
    wrap.className = 'nodes';
    const style = document.createElement('style');
    style.textContent = NODE_CSS;
    const svg = document.createElementNS(SVGNS, 'svg') as SVGSVGElement;
    svg.setAttribute('width', '1'); svg.setAttribute('height', '1');
    wrap.append(style, svg);
    ctx.root.appendChild(wrap);
    pen = { nodes: [], slide: slideAt(ev.target as Element), drag: null, hover: null, wrap, svg };
  }
  const sc = ctx.scale();
  if (pen.nodes.length > 2 && Math.hypot(pen.nodes[0].p[0] - q[0], pen.nodes[0].p[1] - q[1]) < 8 / sc) { penFinish(true); return; }
  pen.nodes.push({ p: q, i: null, o: null });
  pen.drag = pen.nodes.length - 1;
  penRender();
}

export function penMove(ev: PointerEvent): void {
  if (!pen) return;
  const q: Pt = [ev.pageX, ev.pageY];
  if (pen.drag !== null) {
    const n = pen.nodes[pen.drag];
    if (Math.hypot(q[0] - n.p[0], q[1] - n.p[1]) * (ctx?.scale() ?? 1) > 3) {
      n.o = q; n.i = [2 * n.p[0] - q[0], 2 * n.p[1] - q[1]]; n.smooth = true;
    }
  } else pen.hover = q;
  penRender();
}

export function penUp(): void { if (pen) { pen.drag = null; penRender(); } }

export function penKey(ev: KeyboardEvent): boolean {
  if (!pen) return false;
  if (ev.key === 'Enter') { penFinish(false); return true; }
  if (ev.key === 'Escape') { penCancel(); return true; }
  if (ev.key === 'Backspace' || ev.key === 'Delete') { pen.nodes.pop(); if (!pen.nodes.length) penCancel(); else penRender(); return true; }
  return false;
}

/** a double-click ends the path (its two presses added nodes at the same place: one is kept) */
export function penDouble(): void {
  if (!pen) return;
  const n = pen.nodes;
  while (n.length > 1 && Math.hypot(n[n.length - 1].p[0] - n[n.length - 2].p[0], n[n.length - 1].p[1] - n[n.length - 2].p[1]) < 4 / (ctx?.scale() ?? 1)) n.pop();
  penFinish(false);
}

export function penCancel(): void { if (pen) { pen.wrap.remove(); pen = null; } }

function penRender(): void {
  if (!pen || !ctx) return;
  const sc = ctx.scale(), lw = 1.5 / sc, hs = 4 / sc;
  const sp: SubPath = { closed: false, nodes: pen.nodes };
  const parts = [`<path class="out" stroke-width="${lw}" d="${P.toD([sp])}"/>`];
  const last = pen.nodes[pen.nodes.length - 1];
  if (last && pen.hover && pen.drag === null) parts.push(`<path class="out" stroke-dasharray="${4 / sc} ${3 / sc}" stroke-width="${lw}" d="M${last.p[0]} ${last.p[1]}${last.o ? `Q${last.o[0]} ${last.o[1]} ` : 'L'}${pen.hover[0]} ${pen.hover[1]}"/>`);
  for (const n of pen.nodes) {
    for (const h of n === last ? [n.i, n.o] : []) if (h) parts.push(`<line class="hl" stroke-width="${lw / 1.5}" x1="${n.p[0]}" y1="${n.p[1]}" x2="${h[0]}" y2="${h[1]}"/><circle class="h" stroke-width="${lw / 1.5}" cx="${h[0]}" cy="${h[1]}" r="${hs * 0.8}"/>`);
    parts.push(`<rect class="n" stroke-width="${lw / 1.5}" x="${n.p[0] - hs}" y="${n.p[1] - hs}" width="${2 * hs}" height="${2 * hs}"/>`);
  }
  pen.svg.innerHTML = parts.join('');
}

function penFinish(closed: boolean): void {
  const p = pen;
  if (!p) return;
  penCancel();
  if (p.nodes.length < 2) return;
  const slide = p.slide ?? slideOf(document.elementFromPoint(p.nodes[0].p[0] - scrollX, p.nodes[0].p[1] - scrollY));
  const toSlide = (q: Pt): Pt => (slide ? slidePoint(slide, q[0], q[1]) : q);
  const subs = mapFn([{ closed, nodes: p.nodes }], toSlide);
  const b = P.boundsOf(subs);
  const d = P.toD(P.mapSubs(subs, [1, 0, 0, 1, -b.x, -b.y]));
  if (state.version === null) return;
  post({ ol: 'draw', version: state.version, tool: 'bezier' as Tool, slide: slide ? pathOf(slide) : null, rect: { x: b.x, y: b.y, w: b.w, h: b.h }, d, closed });
}

