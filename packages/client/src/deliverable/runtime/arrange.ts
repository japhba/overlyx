/**
 * PowerPoint's and Inkscape's arrangement commands on the canvas's selection, asked for by the
 * editor's toolbar, menus and shortcuts (`arrange`), and the paint tools (`paint`): fill, outline,
 * its width and dash, corner radius, opacity, shadow and arrow tips. Each is one change of the text
 * (one undo step), written in the element's own terms — CSS for a box (`rotate` / `scale` for
 * rotation and flips, so a `transform` the page set stays), attributes for the shapes of an SVG.
 *
 * Order: front / back / one step, among the element's siblings. Align: to the slide for one object,
 * to the selection's bounds for several; distribute: equal gaps between the first and the last.
 * Group: a positioned box around the objects, their positions made relative to it (left / top in
 * px); ungroup puts them back on its parent. Lock: PowerPoint's — selectable, not moved or resized.
 */
import type { ArrangeHow, Paint, HtmlOp, Path } from '../protocol';
import { selection, setSelection, start, placeLive, styleOp, commit, isLocked, movable, angleOf, isSvgPart, cs, containerOf, union, report, draw, kindOf, slidePoint } from './edit';
import { srcOf, pathOf, slideOf, docRect } from './env';
import { pathCommand } from './pathedit';

export function arrange(how: ArrangeHow): void {
  const sel = selection();
  if (!sel.length) return;
  switch (how) {
    case 'front': case 'back': case 'forward': case 'backward': order(sel, how); break;
    case 'align-left': case 'align-center': case 'align-right': case 'align-top': case 'align-middle': case 'align-bottom': align(sel, how); break;
    case 'center-h': case 'center-v': centerOnSlide(sel, how === 'center-h'); break;
    case 'distribute-h': case 'distribute-v': distribute(sel, how === 'distribute-h'); break;
    case 'rotate-cw': case 'rotate-ccw': case 'rotate-reset': rotateBy(sel, how); break;
    case 'flip-h': case 'flip-v': flip(sel, how === 'flip-h'); break;
    case 'union': case 'difference': case 'intersection': case 'exclusion': case 'combine': case 'break-apart': case 'to-path': case 'reverse': case 'simplify': case 'edit-nodes': pathCommand(how); break;
    case 'group': group(sel); break;
    case 'ungroup': ungroup(sel); break;
    case 'lock': case 'unlock': {
      const ops: HtmlOp[] = [];
      for (const el of sel) { const p = pathOf(el); if (p) ops.push({ t: 'attr', path: p, name: 'data-ol-locked', value: how === 'lock' ? '' : null }); }
      commit(ops);
      break;
    }
  }
}

/* ------------------------------------------------------------------ order */

function order(sel: Element[], how: 'front' | 'back' | 'forward' | 'backward'): void {
  const ops: HtmlOp[] = [];
  const select: Path[] = [];
  const byParent = new Map<Element, Element[]>();
  for (const el of sel) {
    const p = el.parentElement ?? (el.parentNode as Element | null);
    if (!p) continue;
    byParent.set(p, [...(byParent.get(p) ?? []), el]);
  }
  for (const [parent, els] of byParent) {
    const psrc = srcOf.get(parent);
    const ppath = pathOf(parent);
    if (!psrc || !ppath) continue;
    const kids = Array.from(psrc.children);
    const chosen = new Set(els.map(e => srcOf.get(e)).filter((s): s is Element => !!s).map(s => kids.indexOf(s)).filter(i => i >= 0));
    if (!chosen.size) continue;
    const idx = kids.map((_, i) => i);
    let next: number[];
    if (how === 'front') next = [...idx.filter(i => !chosen.has(i)), ...idx.filter(i => chosen.has(i))];
    else if (how === 'back') next = [...idx.filter(i => chosen.has(i)), ...idx.filter(i => !chosen.has(i))];
    else {
      // one step: each chosen child swaps with the next (previous) unchosen one
      next = [...idx];
      if (how === 'forward') { for (let k = next.length - 2; k >= 0; k--) if (chosen.has(next[k]) && !chosen.has(next[k + 1])) [next[k], next[k + 1]] = [next[k + 1], next[k]]; }
      else { for (let k = 1; k < next.length; k++) if (chosen.has(next[k]) && !chosen.has(next[k - 1])) [next[k], next[k - 1]] = [next[k - 1], next[k]]; }
    }
    if (next.every((v, k) => v === k)) continue;
    ops.push({ t: 'reorder', parent: ppath, order: next });
    for (const i of chosen) select.push([...ppath, next.indexOf(i)]);
  }
  commit(ops, { select });
}

/* ------------------------------------------------------------------ position */

/** each element moved by its own (dx, dy) — document px — in one change */
function moveEach(moves: { el: Element; dx: number; dy: number }[]): void {
  const ops: HtmlOp[] = [];
  for (const m of moves) {
    if ((!m.dx && !m.dy) || isLocked(m.el) || !movable(m.el)) continue;
    const d = start(m.el as HTMLElement);
    placeLive(d, m.dx, m.dy);
    const op = styleOp(d);
    if (op) ops.push(op);
  }
  commit(ops, { select: 'keep' });
  draw();
}

function align(sel: Element[], how: string): void {
  const rects = sel.map(el => ({ el, r: docRect(el) }));
  const slide = slideOf(sel[0]);
  const ref = sel.length === 1 ? (slide ? docRect(slide) : null) : union(rects.map(x => x.r));
  if (!ref) return;
  moveEach(rects.map(({ el, r }) => {
    switch (how) {
      case 'align-left': return { el, dx: ref.x - r.x, dy: 0 };
      case 'align-center': return { el, dx: ref.x + ref.w / 2 - (r.x + r.w / 2), dy: 0 };
      case 'align-right': return { el, dx: ref.x + ref.w - (r.x + r.w), dy: 0 };
      case 'align-top': return { el, dx: 0, dy: ref.y - r.y };
      case 'align-middle': return { el, dx: 0, dy: ref.y + ref.h / 2 - (r.y + r.h / 2) };
      default: return { el, dx: 0, dy: ref.y + ref.h - (r.y + r.h) };
    }
  }));
}

function centerOnSlide(sel: Element[], horizontal: boolean): void {
  const slide = slideOf(sel[0]);
  if (!slide) return;
  const s = docRect(slide);
  // the selection moved as a whole
  const u = union(sel.map(el => docRect(el)));
  const dx = horizontal ? s.x + s.w / 2 - (u.x + u.w / 2) : 0, dy = horizontal ? 0 : s.y + s.h / 2 - (u.y + u.h / 2);
  moveEach(sel.map(el => ({ el, dx, dy })));
}

function distribute(sel: Element[], horizontal: boolean): void {
  if (sel.length < 3) return;
  const items = sel.map(el => ({ el, r: docRect(el) })).sort((a, b) => horizontal ? a.r.x - b.r.x : a.r.y - b.r.y);
  const first = items[0].r, last = items[items.length - 1].r;
  const span = horizontal ? last.x + last.w - first.x : last.y + last.h - first.y;
  const total = items.reduce((n, it) => n + (horizontal ? it.r.w : it.r.h), 0);
  const gap = (span - total) / (items.length - 1);
  let at = horizontal ? first.x : first.y;
  moveEach(items.map(it => {
    const cur = horizontal ? it.r.x : it.r.y;
    const d = at - cur;
    at += (horizontal ? it.r.w : it.r.h) + gap;
    return { el: it.el, dx: horizontal ? d : 0, dy: horizontal ? 0 : d };
  }));
}

/* ------------------------------------------------------------------ rotation and flips */

const deg = (a: number) => { a = ((a % 360) + 540) % 360 - 180; return Math.abs(a) === 180 ? 180 : Math.round(a * 10) / 10; };

function rotateBy(sel: Element[], how: 'rotate-cw' | 'rotate-ccw' | 'rotate-reset'): void {
  const ops: HtmlOp[] = [];
  for (const el of sel) {
    const p = pathOf(el);
    if (!p || isLocked(el) || isSvgPart(el)) continue;
    const a = how === 'rotate-reset' ? 0 : deg(angleOf(el) + (how === 'rotate-cw' ? 90 : -90));
    ops.push({ t: 'style', path: p, set: { rotate: a ? `${a}deg` : null } });
  }
  commit(ops, { select: 'keep' });
}

function flip(sel: Element[], horizontal: boolean): void {
  const ops: HtmlOp[] = [];
  for (const el of sel) {
    const p = pathOf(el);
    if (!p || isLocked(el)) continue;
    if (isSvgPart(el)) {
      // a shape in a drawing: mirrored about its own centre
      const b = (el as SVGGraphicsElement).getBBox?.();
      if (!b) continue;
      const cx = b.x + b.width / 2, cy = b.y + b.height / 2;
      const t = horizontal ? `translate(${r2(2 * cx)} 0) scale(-1 1)` : `translate(0 ${r2(2 * cy)}) scale(1 -1)`;
      const cur = el.getAttribute('transform');
      ops.push({ t: 'attr', path: p, name: 'transform', value: cur ? `${cur} ${t}` : t });
      continue;
    }
    const v = cs(el).scale;
    let [sx, sy] = !v || v === 'none' ? [1, 1] : v.split(/\s+/).map(Number);
    if (sy === undefined || Number.isNaN(sy)) sy = sx;
    if (horizontal) sx = -sx; else sy = -sy;
    ops.push({ t: 'style', path: p, set: { scale: sx === 1 && sy === 1 ? null : `${sx} ${sy}` } });
  }
  commit(ops, { select: 'keep' });
}

const r2 = (n: number) => Math.round(n * 100) / 100;

/* ------------------------------------------------------------------ groups */

/** a CSS declaration list with some properties set (null: removed) */
function withStyle(style: string, set: Record<string, string | null>): string {
  const decls = style.split(';').map(d => d.trim()).filter(Boolean);
  const out: string[] = [];
  const done = new Set<string>();
  for (const d of decls) {
    const i = d.indexOf(':');
    const k = d.slice(0, i).trim().toLowerCase();
    if (k in set) { if (!done.has(k) && set[k] !== null) out.push(`${k}: ${set[k]}`); done.add(k); }
    else out.push(d);
  }
  for (const [k, v] of Object.entries(set)) if (!done.has(k) && v !== null) out.push(`${k}: ${v}`);
  return out.join('; ');
}

const px = (n: number) => `${Math.round(n)}px`;

function group(sel: Element[]): void {
  const els = sel.filter(el => !isSvgPart(el) && !isLocked(el));
  if (els.length < 2) return;
  const parent = els[0].parentElement;
  if (!parent || els.some(el => el.parentElement !== parent)) return;
  const psrc = srcOf.get(parent);
  if (!psrc) return;
  const kids = Array.from(psrc.children);
  const ordered = els.map(el => ({ el, src: srcOf.get(el)!, path: pathOf(el) })).filter(x => x.src && x.path).sort((a, b) => kids.indexOf(a.src) - kids.indexOf(b.src));
  if (ordered.length < 2) return;
  const box = containerOf(els[0]);
  // the group's box: the objects' bounds, in the coordinates their left / top are in
  const rs = ordered.map(x => docRect(x.el));
  const u = union(rs);
  const [gx, gy] = slidePoint(box, u.x, u.y);
  const [gx2, gy2] = slidePoint(box, u.x + u.w, u.y + u.h);
  const inner = ordered.map(x => {
    const c = cs(x.el);
    const left = parseFloat(c.left), top = parseFloat(c.top);
    const copy = x.src.cloneNode(true) as Element;
    const pos = c.position === 'static' || c.position === 'relative' ? 'absolute' : c.position;
    // a box in the flow: where it is now, made absolute in the group
    let l = left, t = top;
    if (!Number.isFinite(l) || c.position === 'static' || c.position === 'relative') { const [ex, ey] = slidePoint(box, docRect(x.el).x, docRect(x.el).y); l = ex; t = ey; }
    copy.setAttribute('style', withStyle(copy.getAttribute('style') ?? '', { position: pos, left: px(l - gx), top: px(t - gy), margin: c.position === 'static' ? '0' : null }));
    return copy.outerHTML;
  });
  const html = `<div class="ol-group" style="position: absolute; left: ${px(gx)}; top: ${px(gy)}; width: ${px(gx2 - gx)}; height: ${px(gy2 - gy)}">\n  ${inner.join('\n  ')}\n</div>`;
  const first = ordered[0];
  commit([{ t: 'outer', path: first.path!, html }, ...(ordered.length > 1 ? [{ t: 'remove', paths: ordered.slice(1).map(x => x.path!) } as HtmlOp] : [])], { select: [first.path!] });
}

function ungroup(sel: Element[]): void {
  const ops: HtmlOp[] = [];
  const select: Path[] = [];
  let shift = 0;
  const gs = sel.filter(el => kindOf(el) === 'group' && !isLocked(el)).map(el => ({ el, path: pathOf(el)!, src: srcOf.get(el)! })).filter(g => g.path && g.src)
    .sort((a, b) => a.path[a.path.length - 1] - b.path[b.path.length - 1]);
  for (const g of gs) {
    const c = cs(g.el);
    const gl = parseFloat(c.left) || 0, gt = parseFloat(c.top) || 0;
    const children = Array.from(g.src.children);
    const live = Array.from(g.el.children).filter(k => srcOf.has(k));
    const out = children.map((k, i) => {
      const copy = k.cloneNode(true) as Element;
      const lk = live.find(x => srcOf.get(x) === k);
      const kc = lk ? cs(lk) : null;
      const l = kc ? parseFloat(kc.left) : NaN, t = kc ? parseFloat(kc.top) : NaN;
      if (kc && kc.position !== 'static' && Number.isFinite(l) && Number.isFinite(t)) copy.setAttribute('style', withStyle(copy.getAttribute('style') ?? '', { left: px(l + gl), top: px(t + gt), right: null, bottom: null }));
      void i;
      return copy.outerHTML;
    });
    ops.push({ t: 'outer', path: g.path, html: out.join('\n') });
    const base = g.path[g.path.length - 1] + shift;
    for (let i = 0; i < out.length; i++) select.push([...g.path.slice(0, -1), base + i]);
    shift += out.length - 1;
  }
  if (ops.length) commit(ops, { select });
}

/* ------------------------------------------------------------------ paint */

const SHAPES = 'rect, circle, ellipse, polygon, path, polyline, line, text';

/** the shapes of a drawing the paint goes to (not its markers, clip paths, definitions) */
function shapesOf(el: Element): Element[] {
  if (el.localName !== 'svg') return [el];
  return Array.from(el.querySelectorAll(SHAPES)).filter(s => !s.closest('defs, marker, symbol, clipPath, mask, pattern'));
}

const dashArray = (dash: Paint['dash'], w: number) => dash === 'dashed' ? `${r2(w * 3)} ${r2(w * 2)}` : dash === 'dotted' ? `${r2(Math.max(0.1, w * 0.01))} ${r2(w * 2)}` : null;

export function paint(p: Paint): void {
  const sel = selection().filter(el => !isLocked(el));
  const ops: HtmlOp[] = [];
  for (const el of sel) {
    const path = pathOf(el);
    if (!path) continue;
    if (el.localName === 'svg' || isSvgPart(el)) svgPaint(el, path, p, ops);
    else boxPaint(el, path, p, ops);
  }
  commit(ops, { select: 'keep' });
}

function boxPaint(el: Element, path: Path, p: Paint, ops: HtmlOp[]): void {
  const set: Record<string, string | null> = {};
  const c = cs(el);
  if (p.fill !== undefined) { set.background = p.fill; if (p.fill === null) set['background-color'] = null; }
  if (p.stroke !== undefined || p.strokeWidth !== undefined || p.dash !== undefined) {
    const hasBorder = c.borderTopStyle !== 'none' && parseFloat(c.borderTopWidth) > 0;
    const color = p.stroke !== undefined ? p.stroke : hasBorder ? c.borderTopColor : '#1d2433';
    const width = p.strokeWidth !== undefined ? p.strokeWidth : hasBorder ? parseFloat(c.borderTopWidth) : 2;
    const style = p.dash !== undefined ? (p.dash ?? 'solid') : hasBorder ? c.borderTopStyle : 'solid';
    set.border = color === null || width === null || width === 0 ? null : `${r2(width)}px ${style} ${color}`;
    for (const k of ['border-width', 'border-style', 'border-color']) set[k] = null;
    // a box with a border keeps its size (the border drawn inside)
    if (set.border && c.boxSizing !== 'border-box') set['box-sizing'] = 'border-box';
  }
  if (p.radius !== undefined) set['border-radius'] = p.radius === null ? null : `${r2(p.radius)}px`;
  if (p.opacity !== undefined) set.opacity = p.opacity === null || p.opacity >= 1 ? null : String(r2(p.opacity));
  if (p.shadow !== undefined) set['box-shadow'] = p.shadow ? '0 6px 18px rgba(0, 0, 0, 0.22)' : null;
  if (Object.keys(set).length) ops.push({ t: 'style', path, set });
}

function svgPaint(el: Element, path: Path, p: Paint, ops: HtmlOp[]): void {
  const root = el.localName === 'svg' ? el : null;
  // the drawing as a whole: opacity, shadow on the <svg>
  if (p.opacity !== undefined || p.shadow !== undefined) {
    const set: Record<string, string | null> = {};
    if (p.opacity !== undefined) set.opacity = p.opacity === null || p.opacity >= 1 ? null : String(r2(p.opacity));
    if (p.shadow !== undefined) set.filter = p.shadow ? 'drop-shadow(0 4px 8px rgba(0, 0, 0, 0.3))' : null;
    ops.push({ t: 'style', path, set });
  }
  const shapes = shapesOf(el);
  for (const s of shapes) {
    const sp = s === el ? path : pathOf(s);
    if (!sp) continue;
    const attr = (name: string, value: string | null) => ops.push({ t: 'attr', path: sp, name, value });
    const usesCurrent = (s.getAttribute('stroke') ?? '') === 'currentColor';
    if (p.fill !== undefined && !(s.localName === 'line' || s.localName === 'polyline' || (s.getAttribute('fill') === 'none' && s.localName === 'path' && p.fill !== null && isOpenPath(s)))) attr('fill', p.fill ?? 'none');
    if (p.stroke !== undefined) {
      if (usesCurrent && root && p.stroke !== null) { /* the drawing's colour, below */ }
      else attr('stroke', p.stroke ?? 'none');
    }
    if (p.strokeWidth !== undefined) attr('stroke-width', p.strokeWidth === null ? null : String(r2(p.strokeWidth)));
    if (p.dash !== undefined) {
      const w = p.strokeWidth ?? (parseFloat(cs(s).strokeWidth) || 2);
      attr('stroke-dasharray', dashArray(p.dash, w));
      if (p.dash === 'dotted') attr('stroke-linecap', 'round');
    }
    if (p.arrowStart !== undefined || p.arrowEnd !== undefined) {
      if (s.localName === 'line' || s.localName === 'path' || s.localName === 'polyline') {
        if (p.arrowStart !== undefined) attr('marker-start', p.arrowStart ? `url(#${markerId(el, root)})` : null);
        if (p.arrowEnd !== undefined) attr('marker-end', p.arrowEnd ? `url(#${markerId(el, root)})` : null);
      }
    }
  }
  if (p.stroke !== undefined && p.stroke !== null && root && shapes.some(s => s.getAttribute('stroke') === 'currentColor')) ops.push({ t: 'style', path, set: { color: p.stroke } });
  // an arrow tip asked for where the drawing has none defined: a marker added to it
  if ((p.arrowStart || p.arrowEnd) && root && !root.querySelector('marker')) {
    const id = markerId(el, root);
    const m = `<defs><marker id="${id}" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="5" markerHeight="5" orient="auto-start-reverse"><path d="M0 0L10 5L0 10z" fill="context-stroke"/></marker></defs>`;
    ops.push({ t: 'insert', parent: path, index: 0, html: m });
  }
}

const isOpenPath = (s: Element) => !/z\s*$/i.test((s.getAttribute('d') ?? '').trim());

/** the id of the drawing's arrow tip (its own marker, or one made for it) */
function markerId(el: Element, root: Element | null): string {
  const svg = root ?? (el as SVGGraphicsElement).ownerSVGElement;
  const m = svg?.querySelector('marker[id]');
  if (m) return m.getAttribute('id')!;
  const p = svg ? pathOf(svg) : null;
  return `ah${p ? p.join('-') : Math.floor(Math.random() * 1e6)}`;
}

void report; void setSelection;
