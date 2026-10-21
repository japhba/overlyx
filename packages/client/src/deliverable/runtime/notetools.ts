/**
 * Draw's note-taking tools on the page, beside the pen (edit.ts), as GoodNotes has them:
 *
 * - the lasso's choice of what a loop takes: handwriting and its shapes when the loop touches their
 *   line, pictures, texts and shapes when most of their box is inside it — of the kinds and colours
 *   its settings let it take (InkStyle.lasso);
 * - the precise eraser: only the part of a stroke under it goes (core/inkerase.ts), the rest of the
 *   stroke staying one object;
 * - Convert: strokes straightened into the shapes they were meant to be (core/shapesnap.ts), and the
 *   handwriting's lines for the reader (Convert to text / formula, read in the editor), replaced by
 *   what it typed;
 * - the colours used on a slide, which the lasso's colour filter offers.
 *
 * Draw's strokes are `<svg class="ol-ink">` with a path for each width (sourceops.ts objectHtml), the
 * runs of the line one after the other in it, each starting with an M; a straightened one has one path
 * and says what it is (`data-ol-shape`).
 */
import type { InkStyle, HtmlOp, Path } from '../protocol';
import { srcOf, pathOf, docRect } from './env';
import { kindOf, objectsOn, isStrokeArt } from './edit';
import { polylineHitsPolygon, rectMostlyInPolygon, type Polygon } from '@overlyx/core/ink.ts';
import { snapShape } from '@overlyx/core/shapesnap.ts';
import { cutPolyline } from '@overlyx/core/inkerase.ts';
import { hexColor } from '../deckink';

export type LassoKind = 'ink' | 'shapes' | 'pictures' | 'text';
type Pt = [number, number];

/** what the lasso counts an object as */
export function lassoKind(el: Element): LassoKind {
  const k = kindOf(el);
  if (k === 'ink') return el.hasAttribute('data-ol-shape') ? 'shapes' : 'ink';
  if (k === 'image' || k === 'other') return 'pictures';
  if (k === 'text' || k === 'formula') return 'text';
  return 'shapes';
}

/** a line or a stroke: what the lasso takes when it touches its line (the rest: when it holds most of its box) */
const linear = (el: Element) => el.localName === 'svg' && (el.classList.contains('ol-ink') || isStrokeArt(el));

const PAINTED = 'path, polyline, polygon, rect, circle, ellipse, line, text';

/** the colours an object shows (lower-case #rrggbb): a stroke's ink, a shape's fill and outline, a text's colour */
export function colorsOf(el: Element): string[] {
  const out: string[] = [];
  const add = (c: string | null | undefined) => { const h = hexColor(c); if (h && !out.includes(h)) out.push(h); };
  if (el instanceof SVGElement) {
    const parts = el.localName === 'svg' ? Array.from(el.querySelectorAll(PAINTED)).filter(s => !s.closest('defs, marker, symbol, clipPath, mask')).slice(0, 12) : [el];
    for (const s of parts) { const c = getComputedStyle(s); if (c.fill !== 'none') add(c.fill); if (c.stroke !== 'none') add(c.stroke); }
    return out;
  }
  if (el.localName === 'img' || el.querySelector('img')) return out;
  const c = getComputedStyle(el);
  if (c.backgroundColor) add(c.backgroundColor);
  if (c.borderTopStyle !== 'none' && parseFloat(c.borderTopWidth) > 0) add(c.borderTopColor);
  if ((el.textContent ?? '').trim()) add(c.color);
  return out;
}

/** the colours used on a slide (the page's objects), most used first */
export function colorsUsed(scope: Element): string[] {
  const n = new Map<string, number>();
  for (const el of objectsOn(scope)) for (const c of colorsOf(el)) n.set(c, (n.get(c) ?? 0) + 1);
  return [...n].sort((a, b) => b[1] - a[1]).map(([c]) => c).slice(0, 16);
}

/** the line an SVG paints, sampled every few screen px, in document px (`scale`: screen px per document px) */
function linePoints(el: Element, scale: number): Pt[][] {
  const out: Pt[][] = [];
  for (const g of Array.from(el.querySelectorAll('path, polyline, line')).filter(s => !s.closest('defs, marker, symbol'))) {
    const geo = g as SVGGeometryElement, m = geo.getScreenCTM();
    if (!m) continue;
    let len = 0;
    try { len = geo.getTotalLength(); } catch { continue; }
    const n = Math.min(600, Math.max(2, Math.ceil((len * Math.hypot(m.a, m.b) * scale) / 4)));
    const pts: Pt[] = [];
    for (let i = 0; i <= n; i++) { const q = geo.getPointAtLength((len * i) / n).matrixTransform(m); pts.push([q.x + scrollX, q.y + scrollY]); }
    out.push(pts);
  }
  return out;
}

/** whether the lasso `poly` (document px) takes `el`, of the kinds and colours `lasso` lets it */
export function lassoTakes(el: Element, poly: Polygon, lasso: InkStyle['lasso'], scale: number): boolean {
  const kinds = lasso?.kinds?.length ? lasso.kinds : ['ink', 'shapes', 'pictures', 'text'];
  if (!kinds.includes(lassoKind(el))) return false;
  const colors = lasso?.colors ?? [];
  if (colors.length && !colorsOf(el).some(c => colors.includes(c))) return false;
  if (linear(el)) return linePoints(el, scale).some(l => polylineHitsPolygon(l, poly));
  const r = docRect(el);
  return r.w > 0 && r.h > 0 && rectMostlyInPolygon(r.x, r.y, r.w, r.h, poly);
}

/* ------------------------------------------------------------------ a stroke's runs */

interface Run { path: SVGPathElement; w: number; lines: Pt[][] }

/** a path's runs (M … L … each), in its own units */
function runsOf(path: SVGPathElement): Pt[][] {
  const d = path.getAttribute('d') ?? '';
  const out: Pt[][] = [];
  for (const part of d.split(/(?=M)/)) {
    const nums = part.replace(/[ML]/g, ' ').trim().split(/[\s,]+/).map(Number);
    if (nums.length < 2 || nums.some(n => !Number.isFinite(n))) continue;
    const pts: Pt[] = [];
    for (let i = 0; i + 1 < nums.length; i += 2) pts.push([nums[i], nums[i + 1]]);
    out.push(pts);
  }
  return out;
}

const f2 = (n: number) => String(Math.round(n * 100) / 100);
/** runs as path data again */
function runsD(lines: Pt[][]): string {
  return lines.map(l => `M${f2(l[0][0])} ${f2(l[0][1])}` + (l.length === 1 ? `L${f2(l[0][0] + 0.01)} ${f2(l[0][1])}` : l.slice(1).map(([x, y]) => `L${f2(x)} ${f2(y)}`).join(''))).join('');
}

/** Draw's stroke as its paths' runs: only a stroke of ours (straight lines between points, no curves) */
function strokeRuns(svg: Element): Run[] | null {
  if (!(svg instanceof SVGSVGElement) || !svg.classList.contains('ol-ink')) return null;
  const out: Run[] = [];
  for (const p of Array.from(svg.querySelectorAll('path')) as SVGPathElement[]) {
    const d = p.getAttribute('d') ?? '';
    if (/[^ML0-9 .,eE-]/.test(d)) return null;   // an older stroke: a filled outline
    out.push({ path: p, w: parseFloat(p.getAttribute('stroke-width') ?? '') || 1, lines: runsOf(p) });
  }
  return out.length ? out : null;
}

/** what the precise eraser is doing to a stroke: its paths' data as they were, to put back (a cancelled rub) */
export type Cut = Map<SVGPathElement, string>;

/**
 * The precise eraser at (x, y) (client px), `r` screen px round it: the part of the stroke under it
 * cut away, live (its paths' data before, the first time, kept in `was`). False: not a stroke of ours
 * (the eraser takes it whole).
 */
export function cutStroke(svg: Element, x: number, y: number, r: number, was: Cut): boolean {
  const runs = strokeRuns(svg);
  if (!runs) return false;
  for (const run of runs) {
    const m = run.path.getScreenCTM();
    if (!m) continue;
    const k = Math.sqrt(Math.abs(m.a * m.d - m.b * m.c)) || 1;
    const c = m.inverse().transformPoint(new DOMPoint(x, y));
    let changed = false;
    const next: Pt[][] = [];
    for (const line of run.lines) {
      const cut = cutPolyline(line, c.x, c.y, r / k + run.w / 2);
      if (cut === null) next.push(line); else { changed = true; next.push(...cut); }
    }
    if (!changed) continue;
    if (!was.has(run.path)) was.set(run.path, run.path.getAttribute('d') ?? '');
    run.path.setAttribute('d', next.length ? runsD(next) : '');
  }
  return true;
}

/** the precise eraser's rub as edits: each path's new data, a path left empty removed, a stroke left empty removed whole */
export function cutOps(was: Cut): HtmlOp[] {
  const ops: HtmlOp[] = [];
  const gone: Path[] = [];
  const bySvg = new Map<Element, SVGPathElement[]>();
  for (const p of was.keys()) { const s = p.ownerSVGElement; if (s) bySvg.set(s, [...(bySvg.get(s) ?? []), p]); }
  for (const [svg, paths] of bySvg) {
    const all = Array.from(svg.querySelectorAll('path'));
    if (all.every(p => !(p.getAttribute('d') ?? '').trim())) { const sp = pathOf(svg); if (sp) gone.push(sp); continue; }
    for (const p of paths) {
      const pp = pathOf(p);
      if (!pp) continue;
      const d = p.getAttribute('d') ?? '';
      if (d.trim()) ops.push({ t: 'attr', path: pp, name: 'd', value: d }); else gone.push(pp);
    }
  }
  if (gone.length) ops.push({ t: 'remove', paths: gone });
  return ops;
}

/** a rub given up: the strokes as they were */
export function uncut(was: Cut): void {
  for (const [p, d] of was) p.setAttribute('d', d);
  was.clear();
}

/* ------------------------------------------------------------------ Convert */

/** a stroke's line as one polyline (its runs follow each other), in its own units, with its mean width */
function strokeLine(runs: Run[]): { pts: Pt[]; w: number } {
  const pts: Pt[] = [];
  let wl = 0, l = 0;
  // the runs of the paths in the order they were drawn: each starts where one ended
  const all = runs.flatMap(r => r.lines.map(line => ({ line, w: r.w })));
  const left = [...all];
  let cur = left.shift();
  while (cur) {
    for (const p of cur.line) { const q = pts[pts.length - 1]; if (q) { const d = Math.hypot(p[0] - q[0], p[1] - q[1]); l += d; wl += d * cur.w; } if (!q || q[0] !== p[0] || q[1] !== p[1]) pts.push(p); }
    const end = pts[pts.length - 1];
    let best = 0, bd = Infinity;
    left.forEach((x, i) => { const d = Math.hypot(x.line[0][0] - end[0], x.line[0][1] - end[1]); if (d < bd) { bd = d; best = i; } });
    cur = left.length ? left.splice(best, 1)[0] : undefined;
  }
  return { pts, w: l ? wl / l : runs[0]?.w ?? 1 };
}

/**
 * The stroke straightened: its source with one path, the outline of the shape it was meant to be in
 * its mean width (and what shape it is); null when it is none, or not a stroke of ours.
 */
export function straightened(svg: Element, scale: number): HtmlOp | null {
  const runs = strokeRuns(svg);
  const path = pathOf(svg), src = srcOf.get(svg);
  if (!runs || !path || !src) return null;
  const m = runs[0].path.getScreenCTM();
  const k = m ? Math.sqrt(Math.abs(m.a * m.d - m.b * m.c)) : 1;
  const { pts, w } = strokeLine(runs);
  const s = snapShape(pts, { zoom: k * scale });
  if (!s) return null;
  const copy = src.cloneNode(true) as Element;
  const g = copy.querySelector('g') ?? copy;
  for (const p of Array.from(g.querySelectorAll('path'))) p.remove();
  const p = copy.ownerDocument.createElementNS('http://www.w3.org/2000/svg', 'path');
  p.setAttribute('fill', 'none');
  p.setAttribute('stroke-width', f2(w));
  p.setAttribute('d', runsD([s.pts]));
  g.append(p);
  copy.setAttribute('data-ol-shape', s.kind);
  return { t: 'outer', path, html: copy.outerHTML };
}

/** the handwriting's lines (document px) — what the reader is shown — and their box */
export function handwriting(els: Element[]): { lines: Pt[][]; box: { x: number; y: number; w: number; h: number }; color: string | null } | null {
  const lines: Pt[][] = [];
  let color: string | null = null, mixed = false;
  for (const el of els) {
    const runs = strokeRuns(el);
    if (!runs) continue;
    const m = runs[0].path.getScreenCTM();
    if (!m) continue;
    const at = (p: Pt): Pt => { const q = new DOMPoint(p[0], p[1]).matrixTransform(m); return [q.x + scrollX, q.y + scrollY]; };
    lines.push(strokeLine(runs).pts.map(at));
    const c = colorsOf(el)[0] ?? null;
    if (color === null) color = c; else if (c !== color) mixed = true;
  }
  if (!lines.length) return null;
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (const l of lines) for (const [x, y] of l) { x0 = Math.min(x0, x); y0 = Math.min(y0, y); x1 = Math.max(x1, x); y1 = Math.max(y1, y); }
  return { lines, box: { x: x0, y: y0, w: x1 - x0, h: y1 - y0 }, color: mixed ? null : color };
}

/** the letters' height of handwriting (the median of its strokes taller than a seventh of the tallest) */
export function letterHeight(lines: Pt[][]): number {
  const hs = lines.map(l => { let lo = Infinity, hi = -Infinity; for (const p of l) { lo = Math.min(lo, p[1]); hi = Math.max(hi, p[1]); } return hi - lo; });
  const top = Math.max(...hs, 0), tall = hs.filter(h => h > top / 7).sort((a, b) => a - b);
  return tall.length ? tall[Math.floor(tall.length / 2)] : top;
}

/** a colour as dark as ink usually is (the text's own colour then, as the design has it) */
const nearBlack = (hex: string) => { const n = parseInt(hex.slice(1), 16); return ((n >> 16) * 299 + ((n >> 8) & 255) * 587 + (n & 255) * 114) / 1000 < 60; };
const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

/**
 * What the handwriting becomes on the slide (in the slide's CSS px: `box`, the letters `letter` high): a text box
 * with the text — its lines kept, its $…$ math typeset — or a displayed formula, in the ink's colour
 * unless that was black.
 */
export function typedHtml(text: string, as: 'notes' | 'formula', box: { x: number; y: number; w: number; h: number }, letter: number, color: string | null): string {
  const r = (n: number) => Math.round(n);
  const size = Math.max(12, Math.min(160, letter / 0.72));
  const col = color && !nearBlack(color) ? `; color: ${color}` : '';
  if (as === 'formula') {
    const w = Math.max(box.w * 1.15, size * 3);
    return `<div style="position: absolute; left: ${r(box.x - (w - box.w) / 2)}px; top: ${r(box.y)}px; width: ${r(w)}px; font-size: ${r(size)}px; text-align: center${col}">\\[ ${esc(text)} \\]</div>`;
  }
  const w = Math.max(box.w * 1.1, size * 4);
  return `<p style="position: absolute; left: ${r(box.x)}px; top: ${r(box.y)}px; width: ${r(w)}px; margin: 0; font-size: ${r(size)}px${col}">${text.split('\n').map(esc).join('<br>')}</p>`;
}
