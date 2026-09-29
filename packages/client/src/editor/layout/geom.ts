/**
 * Geometry of layout pages on screen. Everything on a page is sized in CSS through two custom
 * properties the layout plugin sets on the editor (`--ol-pt`: pixels per TeX point at the current
 * zoom, `--ol-mm` = 2.845 × that), so zooming changes one number and never uses CSS zoom or
 * transforms on the editor (both desynchronise ProseMirror's and the formula editor's hit testing).
 */
import type { Node as PMNode } from 'prosemirror-model';
import { normalizePath, parseViewBox, PT_PER_MM, cssColor, type RGB } from '@overlyx/core';

export const MM = (v: number) => `calc(var(--ol-mm) * ${round(v)})`;
export const PT = (v: number) => `calc(var(--ol-pt) * ${round(v)})`;
const round = (v: number) => Math.round(v * 1000) / 1000;

export interface Box { x: number; y: number; w: number; h: number; rot: number }

export function boxOf(node: PMNode): Box {
  const a = node.attrs;
  return { x: Number(a.x) || 0, y: Number(a.y) || 0, w: Math.max(0.1, Number(a.w) || 0), h: Math.max(0.1, Number(a.h) || 0), rot: Number(a.rot) || 0 };
}

/** Position an object's element (rotation: TikZ's is counter-clockwise, CSS's clockwise). */
export function placeElement(el: HTMLElement, b: Box): void {
  el.style.left = MM(b.x);
  el.style.top = MM(b.y);
  el.style.width = MM(b.w);
  el.style.height = MM(b.h);
  el.style.transform = b.rot ? `rotate(${-b.rot}deg)` : '';
}

/** Colours of the document (\definecolor in its preamble), set by the layout plugin. */
export const docColors: { map: Record<string, RGB> } = { map: {} };
export const color = (expr: string | null | undefined): string | null => cssColor(expr, docColors.map);

/** An object's path in the coordinates of its box (mm), for an SVG sized w × h. */
export function shapePathInBox(d: string, vb: string, w: number, h: number): string {
  const v = parseViewBox(vb);
  const sx = w / v.w, sy = h / v.h;
  const f = (n: number) => String(Math.round(n * 1000) / 1000);
  return normalizePath(d).map(s => {
    if (s.c === 'Z') return 'Z';
    const p = s.p.map((n, i) => (i % 2 === 0 ? (n - v.x) * sx : (n - v.y) * sy));
    return s.c + ' ' + p.map(f).join(' ');
  }).join(' ');
}

/** TikZ dash patterns (in pt) for the dash option names. */
export const DASHES: Record<string, number[]> = {
  dashed: [3, 3], 'densely dashed': [3, 2], 'loosely dashed': [3, 6],
  dotted: [0.4, 2], 'densely dotted': [0.4, 1], 'loosely dotted': [0.4, 4],
  dashdotted: [3, 2, 0.4, 2], 'dash dot': [3, 2, 0.4, 2],
};

export const ptToMm = (pt: number) => pt / PT_PER_MM;

/** Rotate (x, y) by `deg` (TikZ sense, counter-clockwise on paper = clockwise-negative on screen) about (cx, cy). */
export function rotatePoint(x: number, y: number, cx: number, cy: number, deg: number): [number, number] {
  if (!deg) return [x, y];
  const r = -deg * Math.PI / 180;   // screen y points down
  const c = Math.cos(r), s = Math.sin(r);
  const dx = x - cx, dy = y - cy;
  return [cx + dx * c - dy * s, cy + dx * s + dy * c];
}

/** The axis-aligned bounds of a (rotated) box. */
export function boundsOf(b: Box): { x: number; y: number; w: number; h: number } {
  if (!b.rot) return { x: b.x, y: b.y, w: b.w, h: b.h };
  const cx = b.x + b.w / 2, cy = b.y + b.h / 2;
  const pts = [[b.x, b.y], [b.x + b.w, b.y], [b.x + b.w, b.y + b.h], [b.x, b.y + b.h]].map(([x, y]) => rotatePoint(x, y, cx, cy, b.rot));
  const xs = pts.map(p => p[0]), ys = pts.map(p => p[1]);
  const x0 = Math.min(...xs), y0 = Math.min(...ys);
  return { x: x0, y: y0, w: Math.max(...xs) - x0, h: Math.max(...ys) - y0 };
}

export function unionBounds(list: { x: number; y: number; w: number; h: number }[]): { x: number; y: number; w: number; h: number } | null {
  if (!list.length) return null;
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (const b of list) { x0 = Math.min(x0, b.x); y0 = Math.min(y0, b.y); x1 = Math.max(x1, b.x + b.w); y1 = Math.max(y1, b.y + b.h); }
  return { x: x0, y: y0, w: x1 - x0, h: y1 - y0 };
}

/** Objects of a page node (groups are one object) with their document positions. */
export function pageObjects(page: PMNode, pagePos: number): { node: PMNode; pos: number }[] {
  const out: { node: PMNode; pos: number }[] = [];
  page.forEach((child, off) => { if (child.type.name !== 'ol_notes') out.push({ node: child, pos: pagePos + 1 + off }); });
  return out;
}

/** The union of a group's children's bounds (mm). */
export function objectBounds(node: PMNode): { x: number; y: number; w: number; h: number } {
  if (node.type.name === 'ol_group') {
    const list: { x: number; y: number; w: number; h: number }[] = [];
    node.forEach(c => list.push(objectBounds(c)));
    return unionBounds(list) ?? { x: 0, y: 0, w: 0, h: 0 };
  }
  return boundsOf(boxOf(node));
}

export const isLayoutObject = (n: PMNode | null | undefined): boolean => !!n && n.type.spec.group === 'ol_object';

/** the variables of TeX's lines and lists in text boxes (styles.css; set by the controller), also copied into a presentation */
export const TEX_LINE_VARS = ['--ol-fhalf', '--ol-asc', '--ol-tex-lines', '--ol-dskip', '--ol-dskip-short', '--ol-leftmargin', '--ol-bullet', '--ol-bullet-k', '--ol-item-color'];
