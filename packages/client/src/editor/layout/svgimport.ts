/**
 * SVG drawings as editable layout objects: pasting an SVG (Inkscape, Illustrator, matplotlib,
 * draw.io …) onto a slide gives vector shapes and text boxes that can be moved and restyled, not a
 * picture. Every drawable element becomes an `ol_shape` whose path is in absolute page millimetres —
 * transforms are applied to the points (affine maps take cubic Béziers to cubic Béziers exactly),
 * so nothing is left rotated or skewed — and every `<text>` an `ol_box`.
 *
 * Styles are computed here rather than with getComputedStyle: the paste handler may read a
 * detached document, and the tests run without layout. The cascade is the part of CSS drawings
 * use: presentation attributes, simple `<style>` sheets (Illustrator's `.cls-1{…}`), the style
 * attribute, inheritance. What layout objects cannot express (gradients, patterns, clipping,
 * masks, filters, embedded images and HTML) is approximated or left out with a warning.
 */
import type { Mark, Node as PMNode } from 'prosemirror-model';
import { schema, normalizePath, hexToTex, PT_PER_MM, type PathSeg } from '@overlyx/core';
import COLOUR_NAMES from '@overlyx/core/layout/xcolornames.json';
import { makeBox, normDeg, r3, shapeFromPath } from './commands';
import { DASHES, boundsOf } from './geom';

export interface SvgImportOptions {
  /** the page size in mm: the drawing is scaled down to fit inside 80 % of it (never scaled up beyond its natural size), centred unless `at` is given */
  page: { w: number; h: number };
  /** the drawing's top-left corner on the page, mm */
  at?: [number, number];
  /** the box the drawing should fill exactly (keeping its aspect ratio, centred in it) — used to convert an existing SVG image object in place; overrides page fitting and `at` */
  into?: { x: number; y: number; w: number; h: number };
}

export interface SvgImportResult {
  nodes: PMNode[];
  /** objects that could not be converted (e.g. <image>, <foreignObject>, filters, gradients approximated) */
  warnings: string[];
}

/**
 * SVG markup → layout objects: one ol_group of the objects when there are several, else the single
 * object; [] when nothing drawable. Never throws: unreadable input gives no nodes and a warning.
 */
export function svgToLayoutObjects(svg: string, opts: SvgImportOptions): SvgImportResult {
  const imp = new Importer();
  try {
    return imp.run(svg, opts);
  } catch (e) {
    imp.warn(`The SVG could not be converted (${e instanceof Error ? e.message : String(e)}).`);
    return { nodes: [], warnings: imp.messages() };
  }
}

/* ------------------------------------------------------------------ constants */

const SVG_NS = 'http://www.w3.org/2000/svg';
const XLINK_NS = 'http://www.w3.org/1999/xlink';
const XHTML_NS = 'http://www.w3.org/1999/xhtml';
const INKSCAPE_NS = 'http://www.inkscape.org/namespaces/inkscape';
const MM_PER_PX = 25.4 / 96;
/** at most this many objects are made (the rest is left out with a warning) */
const MAX_OBJECTS = 1500;
/** above this many objects every run of shapes of one style merges, not only small ones */
const MERGE_ALL_ABOVE = 300;
/** a shape whose larger side is at most this fraction of the drawing's is "small" (a marker, a glyph, a tick) */
const SMALL = 0.04;
/** elements visited, `use` instances included: a document that nests references exponentially stops here */
const MAX_VISITS = 200000;
/** cubic Bézier control distance for a quarter circle of radius 1 */
const KAPPA = 0.5522847498;
/** where the first baseline of a text box lies below its top, in font sizes */
const BASELINE = 0.8;
/** a generous average glyph width in font sizes: a box too narrow would wrap the text */
const CHAR_W = 0.6;

/** the elements drawn (or descended into) when met in the tree; everything else is skipped */
const DRAWN = new Set(['g', 'a', 'switch', 'svg', 'use', 'text', 'path', 'rect', 'circle', 'ellipse', 'line', 'polyline', 'polygon', 'image', 'foreignobject', 'flowroot']);
const SHAPES = new Set(['path', 'rect', 'circle', 'ellipse', 'line', 'polyline', 'polygon']);
const TEXT_CHILDREN = new Set(['tspan', 'textpath', 'a']);
/** CSS properties SVG also takes as attributes */
const PRESENTATION = ['fill', 'fill-opacity', 'stroke', 'stroke-width', 'stroke-opacity', 'stroke-dasharray', 'opacity', 'display', 'visibility', 'color',
  'font-size', 'font-family', 'font-weight', 'font-style', 'text-anchor', 'marker-start', 'marker-end', 'filter', 'mask', 'clip-path', 'stop-color', 'stop-opacity'];
const ALIGN: Record<string, string> = { start: 'left', middle: 'center', end: 'right' };

/* ------------------------------------------------------------------ geometry */

/** An affine map [a b c d e f]: (x, y) → (a x + c y + e, b x + d y + f), as SVG's matrix(). */
type Mat = [number, number, number, number, number, number];
interface Rect { x: number; y: number; w: number; h: number }
interface Size { w: number; h: number }

const IDENTITY: Mat = [1, 0, 0, 1, 0, 0];
/** m ∘ n: n is applied first (a transform list's later entries are the inner ones) */
const mul = (m: Mat, n: Mat): Mat => [
  m[0] * n[0] + m[2] * n[1], m[1] * n[0] + m[3] * n[1],
  m[0] * n[2] + m[2] * n[3], m[1] * n[2] + m[3] * n[3],
  m[0] * n[4] + m[2] * n[5] + m[4], m[1] * n[4] + m[3] * n[5] + m[5],
];
const translate = (x: number, y: number): Mat => [1, 0, 0, 1, x, y];
const apply = (m: Mat, x: number, y: number): [number, number] => [m[0] * x + m[2] * y + m[4], m[1] * x + m[3] * y + m[5]];
/** the map's mean scale: what a stroke width or a font size is multiplied by */
const meanScale = (m: Mat) => Math.sqrt(Math.abs(m[0] * m[3] - m[1] * m[2]));

const NUM = /[-+]?(?:\d+\.?\d*|\.\d+)(?:[eE][-+]?\d+)?/g;
const numbers = (s: string | null): number[] => (s ? Array.from(s.matchAll(NUM), m => Number(m[0])) : []);

/**
 * The transform attribute's grammar: matrix, translate, scale, rotate (about the origin or a
 * centre), skewX and skewY, in a list. Anything malformed makes the whole attribute identity, as
 * browsers treat an invalid transform.
 */
function parseTransform(s: string | null): Mat {
  if (!s || !s.trim()) return IDENTITY;
  let m = IDENTITY;
  const re = /(matrix|translate|scale|rotate|skewX|skewY)\s*\(([^)]*)\)/g;
  let rest = s, x: RegExpExecArray | null;
  while ((x = re.exec(s))) {
    rest = rest.replace(x[0], '');
    const a = numbers(x[2]);
    const rad = (a[0] ?? 0) * Math.PI / 180;
    let t: Mat | null = null;
    switch (x[1]) {
      case 'matrix': t = a.length === 6 ? [a[0], a[1], a[2], a[3], a[4], a[5]] : null; break;
      case 'translate': t = a.length === 1 || a.length === 2 ? translate(a[0], a[1] ?? 0) : null; break;
      case 'scale': t = a.length === 1 || a.length === 2 ? [a[0], 0, 0, a[1] ?? a[0], 0, 0] : null; break;
      case 'rotate': {
        const r: Mat = [Math.cos(rad), Math.sin(rad), -Math.sin(rad), Math.cos(rad), 0, 0];
        t = a.length === 1 ? r : a.length === 3 ? mul(mul(translate(a[1], a[2]), r), translate(-a[1], -a[2])) : null;
        break;
      }
      case 'skewX': t = a.length === 1 ? [1, 0, Math.tan(rad), 1, 0, 0] : null; break;
      case 'skewY': t = a.length === 1 ? [1, Math.tan(rad), 0, 1, 0, 0] : null; break;
    }
    if (!t || !t.every(Number.isFinite)) return IDENTITY;
    m = mul(m, t);
  }
  return /^[\s,]*$/.test(rest) ? m : IDENTITY;
}

function parseViewBox(v: string | null): Rect | null {
  const n = numbers(v);
  return n.length === 4 && n.every(Number.isFinite) && n[2] > 0 && n[3] > 0 ? { x: n[0], y: n[1], w: n[2], h: n[3] } : null;
}

/** The map of a viewBox onto the viewport (x, y, w, h) as preserveAspectRatio says (default xMidYMid meet). */
function viewBoxMatrix(vb: Rect, x: number, y: number, w: number, h: number, par: string | null): Mat {
  const p = (par ?? '').trim().split(/\s+/).filter(t => t !== 'defer');
  const align = p[0] || 'xMidYMid', slice = p[1] === 'slice';
  let sx = w / vb.w, sy = h / vb.h;
  let tx = x, ty = y;
  if (align !== 'none') {
    sx = sy = slice ? Math.max(sx, sy) : Math.min(sx, sy);
    const ax = /xMid/.test(align) ? 0.5 : /xMax/.test(align) ? 1 : 0, ay = /YMid/.test(align) ? 0.5 : /YMax/.test(align) ? 1 : 0;
    tx += (w - vb.w * sx) * ax;
    ty += (h - vb.h * sy) * ay;
  }
  return [sx, 0, 0, sy, tx - vb.x * sx, ty - vb.y * sy];
}

const PX_PER: Record<string, number> = { px: 1, pt: 96 / 72, pc: 16, mm: 96 / 25.4, cm: 96 / 2.54, in: 96, q: 96 / 101.6 };

/** A length in user units (CSS px): `ref` is what 100 % is, `em` the font size. Null when it is no length. */
function length(v: string | null | undefined, ref: number, em = 16): number | null {
  if (v === null || v === undefined) return null;
  const m = /^\s*([-+]?(?:\d+\.?\d*|\.\d+)(?:[eE][-+]?\d+)?)\s*(px|pt|pc|mm|cm|in|q|em|rem|ex|%)?\s*$/i.exec(v);
  if (!m) return null;
  const n = Number(m[1]), u = (m[2] ?? 'px').toLowerCase();
  const r = u === '%' ? n / 100 * ref : u === 'em' || u === 'rem' ? n * em : u === 'ex' ? n * em / 2 : n * PX_PER[u];
  return Number.isFinite(r) ? r : null;
}

/** A positive absolute length (the root's width / height; percentages say nothing about the size). */
const absLength = (v: string | null): number | null => {
  const n = v && !v.trim().endsWith('%') ? length(v, 0) : null;
  return n !== null && n > 0 ? n : null;
};

/** what a percentage of a length that is neither horizontal nor vertical refers to */
const diagonal = (vp: Size) => Math.sqrt((vp.w * vp.w + vp.h * vp.h) / 2);

const FONT_SIZES: Record<string, number> = { 'xx-small': 9, 'x-small': 10, small: 13, medium: 16, large: 18, 'x-large': 24, 'xx-large': 32, 'xxx-large': 48 };
function fontSize(v: string, parent: number): number | null {
  const k = v.trim().toLowerCase();
  if (FONT_SIZES[k]) return FONT_SIZES[k];
  if (k === 'larger') return parent * 1.2;
  if (k === 'smaller') return parent / 1.2;
  const n = length(k, parent, parent);
  return n !== null && n > 0 ? n : null;
}

function rectPath(x: number, y: number, w: number, h: number, rx: number, ry: number): PathSeg[] {
  if (rx <= 0 || ry <= 0) return [{ c: 'M', p: [x, y] }, { c: 'L', p: [x + w, y] }, { c: 'L', p: [x + w, y + h] }, { c: 'L', p: [x, y + h] }, { c: 'Z' }];
  const kx = KAPPA * rx, ky = KAPPA * ry, r = x + w, b = y + h;
  return [
    { c: 'M', p: [x + rx, y] }, { c: 'L', p: [r - rx, y] }, { c: 'C', p: [r - rx + kx, y, r, y + ry - ky, r, y + ry] },
    { c: 'L', p: [r, b - ry] }, { c: 'C', p: [r, b - ry + ky, r - rx + kx, b, r - rx, b] },
    { c: 'L', p: [x + rx, b] }, { c: 'C', p: [x + rx - kx, b, x, b - ry + ky, x, b - ry] },
    { c: 'L', p: [x, y + ry] }, { c: 'C', p: [x, y + ry - ky, x + rx - kx, y, x + rx, y] }, { c: 'Z' },
  ];
}

function ellipsePath(cx: number, cy: number, rx: number, ry: number): PathSeg[] {
  const kx = KAPPA * rx, ky = KAPPA * ry;
  return [
    { c: 'M', p: [cx + rx, cy] },
    { c: 'C', p: [cx + rx, cy + ky, cx + kx, cy + ry, cx, cy + ry] },
    { c: 'C', p: [cx - kx, cy + ry, cx - rx, cy + ky, cx - rx, cy] },
    { c: 'C', p: [cx - rx, cy - ky, cx - kx, cy - ry, cx, cy - ry] },
    { c: 'C', p: [cx + kx, cy - ry, cx + rx, cy - ky, cx + rx, cy] },
    { c: 'Z' },
  ];
}

/**
 * Path data re-spelt for normalizePath, which reads the common spelling only: arc flags written
 * without separators (`a5 5 0 1010 0`, what minifiers emit), `+` signs and capital exponents.
 * Everything up to the first error is kept, as SVG renders a path up to its first error.
 */
function cleanPathData(d: string): string {
  const out: string[] = [];
  const num = /[-+]?(?:\d+\.?\d*|\.\d+)(?:[eE][-+]?\d+)?/y;
  let i = 0, arc = false, k = 0;
  while (i < d.length) {
    const ch = d[i];
    if (ch === ' ' || ch === ',' || ch === '\t' || ch === '\n' || ch === '\r' || ch === '\f') { i++; continue; }
    if (/[MmLlHhVvCcSsQqTtAaZz]/.test(ch)) { out.push(ch); arc = ch === 'A' || ch === 'a'; k = 0; i++; continue; }
    if (arc && (k % 7 === 3 || k % 7 === 4) && (ch === '0' || ch === '1')) { out.push(ch); k++; i++; continue; }
    num.lastIndex = i;
    const m = num.exec(d);
    if (!m) break;
    out.push(String(Number(m[0])));
    k++;
    i += m[0].length;
  }
  return out.join(' ');
}

const mapSegs = (segs: PathSeg[], m: Mat): PathSeg[] => segs.map(s => (s.c === 'Z' ? s : {
  c: s.c, p: s.p.map((v, i) => (i % 2 === 0 ? m[0] * v + m[2] * s.p[i + 1] + m[4] : m[1] * s.p[i - 1] + m[3] * v + m[5])),
}) as PathSeg);

/** The bounds of the points (control points included, as shapeFromPath measures), not clamped. */
function extent(segs: PathSeg[]): Rect {
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (const s of segs) {
    if (s.c === 'Z') continue;
    for (let i = 0; i < s.p.length; i += 2) {
      x0 = Math.min(x0, s.p[i]); x1 = Math.max(x1, s.p[i]);
      y0 = Math.min(y0, s.p[i + 1]); y1 = Math.max(y1, s.p[i + 1]);
    }
  }
  return { x: x0, y: y0, w: x1 - x0, h: y1 - y0 };
}

/** Whether any subpath encloses an area (a single segment does not: a filled line paints nothing). */
function hasArea(segs: PathSeg[]): boolean {
  let n = 0;
  for (const s of segs) {
    if (s.c === 'M') n = 0;
    else if (s.c === 'C' || (s.c === 'L' && ++n >= 2)) return true;
  }
  return false;
}

function union(a: Rect | null, b: Rect | null): Rect | null {
  if (!a) return b;
  if (!b) return a;
  const x = Math.min(a.x, b.x), y = Math.min(a.y, b.y);
  return { x, y, w: Math.max(a.x + a.w, b.x + b.w) - x, h: Math.max(a.y + a.h, b.y + b.h) - y };
}

function intersect(a: Rect | null, b: Rect | null): Rect | null {
  if (!a) return b;
  if (!b) return a;
  const x = Math.max(a.x, b.x), y = Math.max(a.y, b.y);
  return { x, y, w: Math.max(0, Math.min(a.x + a.w, b.x + b.w) - x), h: Math.max(0, Math.min(a.y + a.h, b.y + b.h) - y) };
}

/* ------------------------------------------------------------------ colours */

let cssNames: Map<string, string> | null = null;
/** CSS's named colours (SVG's 147 keywords: the svgnames table xcolor has too), lower case → #rrggbb */
function namedColour(name: string): string | null {
  if (!cssNames) {
    cssNames = new Map(Object.entries(COLOUR_NAMES.svg as Record<string, string>).map(([k, v]) => [k.toLowerCase(), v.toLowerCase()]));
    cssNames.set('rebeccapurple', '#663399');
  }
  return cssNames.get(name) ?? null;
}

/** colours xcolor knows by the same name and value: written by name, the rest as [HTML]… */
const XCOLOR_NAMES: Record<string, string> = {
  '#000000': 'black', '#ffffff': 'white', '#ff0000': 'red', '#00ff00': 'green', '#0000ff': 'blue',
  '#00ffff': 'cyan', '#ff00ff': 'magenta', '#ffff00': 'yellow', '#808080': 'gray',
};
const texColour = (hex: string) => XCOLOR_NAMES[hex] ?? hexToTex(hex);

const clamp01 = (v: number) => Math.min(1, Math.max(0, v));
const hex2 = (v: number) => Math.round(Math.min(255, Math.max(0, v))).toString(16).padStart(2, '0');

function hslToRgb(h: number, s: number, l: number): number[] {
  const f = (n: number) => { const k = (n + h / 30) % 12; return l - s * Math.min(l, 1 - l) * Math.max(-1, Math.min(k - 3, 9 - k, 1)); };
  return [f(0) * 255, f(8) * 255, f(4) * 255];
}

/** A CSS colour as #rrggbb and its alpha: hex (3, 4, 6, 8 digits), rgb[a](), hsl[a](), names, transparent. */
function parseColour(v: string): { hex: string; a: number } | null {
  const s = v.trim().toLowerCase();
  if (s === 'transparent') return { hex: '#000000', a: 0 };
  let m = /^#([0-9a-f]{3,4}|[0-9a-f]{6}|[0-9a-f]{8})$/.exec(s);
  if (m) {
    const h = m[1].length <= 4 ? [...m[1]].map(c => c + c).join('') : m[1];
    return { hex: '#' + h.slice(0, 6), a: h.length === 8 ? parseInt(h.slice(6), 16) / 255 : 1 };
  }
  m = /^(rgba?|hsla?)\(([^)]*)\)$/.exec(s);
  if (m) {
    const parts = m[2].split(/[\s,/]+/).filter(Boolean);
    if (parts.length < 3) return null;
    const val = (p: string, scale: number) => (p.endsWith('%') ? parseFloat(p) / 100 * scale : parseFloat(p));
    const a = parts.length > 3 ? clamp01(val(parts[3], 1)) : 1;
    const frac = (p: string) => (p.endsWith('%') ? parseFloat(p) / 100 : parseFloat(p) > 1 ? parseFloat(p) / 100 : parseFloat(p));
    const rgb = m[1].startsWith('rgb') ? parts.slice(0, 3).map(p => val(p, 255)) : hslToRgb(((parseFloat(parts[0]) % 360) + 360) % 360, clamp01(frac(parts[1])), clamp01(frac(parts[2])));
    if (!rgb.every(Number.isFinite) || !Number.isFinite(a)) return null;
    return { hex: '#' + rgb.map(hex2).join(''), a };
  }
  const named = namedColour(s);
  return named ? { hex: named, a: 1 } : null;
}

function opacityOf(v: string | undefined): number | null {
  if (v === undefined) return null;
  const n = v.trim().endsWith('%') ? parseFloat(v) / 100 : parseFloat(v);
  return Number.isFinite(n) ? clamp01(n) : null;
}

/**
 * An SVG dash array (pt) as the nearest TikZ dash pattern (geom's DASHES), or null for a solid line.
 * Dashes compare by proportion — TikZ's are all 3 pt long, the drawing's may be any length — and
 * dots (a dash about as long as the line is wide) by their gaps.
 */
function dashName(arr: number[], lw: number): string | null {
  let a = arr.map(Math.abs).filter(Number.isFinite);
  if (!a.length || a.every(v => v < 1e-6)) return null;
  if (a.length % 2) a = [...a, ...a];
  const isDot = (v: number) => v <= Math.max(1.5 * lw, 1);
  const kinds = a.filter((_, i) => i % 2 === 0).map(isDot);
  const mixed = kinds.includes(true) && kinds.includes(false);
  let best: string | null = null, bestScore = Infinity;
  for (const [name, pat] of Object.entries(DASHES)) {
    if (name === 'dash dot' || (pat.length > 2) !== mixed || (!mixed && (pat[0] === 0.4) !== kinds[0])) continue;
    const f = pat[0] === 0.4 ? 1 : a[0] / pat[0];
    let score = 0;
    for (let i = 1; i < pat.length; i++) if (pat[i] !== 0.4) score += Math.abs(Math.log((a[i % a.length] + 0.3) / (pat[i] * f + 0.3)));
    if (score < bestScore) { bestScore = score; best = name; }
  }
  return best;
}

/* ------------------------------------------------------------------ CSS */

interface Decl { prop: string; value: string; important: boolean }
interface Compound { tag: string | null; ids: string[]; classes: string[] }
interface Rule { sel: Compound[]; spec: number; order: number; decls: Decl[] }

/** Split a declaration block at semicolons outside parentheses and quotes (`url(data:…;base64,…)`). */
function splitDecls(s: string): string[] {
  const out: string[] = [];
  let depth = 0, q = '', cur = '';
  for (const ch of s) {
    if (q) { if (ch === q) q = ''; } else if (ch === '"' || ch === "'") q = ch;
    else if (ch === '(') depth++;
    else if (ch === ')') depth = Math.max(0, depth - 1);
    else if (ch === ';' && !depth) { out.push(cur); cur = ''; continue; }
    cur += ch;
  }
  out.push(cur);
  return out;
}

/**
 * The `font` shorthand — matplotlib writes `font: 700 10px 'DejaVu Sans'` — as its parts; the
 * parts it leaves out are reset, as in CSS.
 */
function expandFont(v: string): [string, string][] {
  const toks = v.trim().split(/\s+/);
  let style = 'normal', weight = 'normal', i = 0;
  for (; i < toks.length; i++) {
    const t = toks[i].toLowerCase();
    if (t === 'italic' || t === 'oblique') style = t;
    else if (t === 'bold' || t === 'bolder' || t === 'lighter' || /^[1-9]00$/.test(t)) weight = t;
    else if (t !== 'normal' && t !== 'small-caps' && !/condensed|expanded/.test(t)) break;
  }
  const size = toks[i]?.split('/')[0];
  if (!size) return [];
  const family = toks.slice(i + 1).join(' ');
  return [['font-style', style], ['font-weight', weight], ['font-size', size], ...(family ? [['font-family', family] as [string, string]] : [])];
}

function parseDecls(text: string): Decl[] {
  const out: Decl[] = [];
  for (const part of splitDecls(text)) {
    const c = part.indexOf(':');
    if (c < 0) continue;
    const prop = part.slice(0, c).trim().toLowerCase();
    let value = part.slice(c + 1).trim();
    const important = /!\s*important\s*$/i.test(value);
    if (important) value = value.replace(/!\s*important\s*$/i, '').trim();
    if (!prop || !value) continue;
    if (prop === 'font') for (const [p, v] of expandFont(value)) out.push({ prop: p, value: v, important });
    else if (prop === 'marker') for (const p of ['marker-start', 'marker-end']) out.push({ prop: p, value, important });
    else out.push({ prop, value, important });
  }
  return out;
}

/** A selector of compounds (`tag.class#id`) joined by descendant or child combinators (both read as descendant); null for anything else. */
function parseSelector(s: string): { sel: Compound[]; spec: number } | null {
  const parts = s.trim().replace(/\s*>\s*/g, ' ').split(/\s+/);
  const sel: Compound[] = [];
  let spec = 0;
  for (const p of parts) {
    const m = /^([A-Za-z][\w-]*|\*)?((?:[.#][\w-]+)*)$/.exec(p);
    if (!m || !p) return null;
    const ids = [...m[2].matchAll(/#([\w-]+)/g)].map(x => x[1]), classes = [...m[2].matchAll(/\.([\w-]+)/g)].map(x => x[1]);
    const tag = m[1] && m[1] !== '*' ? m[1].toLowerCase() : null;
    sel.push({ tag, ids, classes });
    spec += ids.length * 10000 + classes.length * 100 + (tag ? 1 : 0);
  }
  return sel.length ? { sel, spec } : null;
}

/** The rules of a style sheet; at-rules (@media, @font-face, @import) are skipped. */
function parseSheet(text: string, rules: Rule[]): void {
  const css = text.replace(/\/\*[\s\S]*?\*\//g, '');
  let i = 0;
  while (i < css.length) {
    const open = css.indexOf('{', i);
    if (open < 0) break;
    const head = css.slice(i, open).split(';').pop()!.trim();
    let depth = 1, j = open + 1;
    while (j < css.length && depth) { if (css[j] === '{') depth++; else if (css[j] === '}') depth--; j++; }
    const body = css.slice(open + 1, depth ? j : j - 1);
    i = j;
    if (head.startsWith('@')) continue;
    const decls = parseDecls(body);
    if (!decls.length) continue;
    for (const s of head.split(',')) {
      const p = parseSelector(s);
      if (p) rules.push({ ...p, order: rules.length, decls });
    }
  }
}

function matchCompound(c: Compound, el: Element): boolean {
  if (c.tag && tag(el) !== c.tag) return false;
  if (c.ids.length && !c.ids.every(id => el.getAttribute('id') === id)) return false;
  if (c.classes.length) {
    const cl = (el.getAttribute('class') ?? '').split(/\s+/);
    if (!c.classes.every(x => cl.includes(x))) return false;
  }
  return true;
}

function matches(sel: Compound[], el: Element): boolean {
  if (!matchCompound(sel[sel.length - 1], el)) return false;
  let i = sel.length - 2;
  for (let a = el.parentElement; a && i >= 0; a = a.parentElement) if (matchCompound(sel[i], a)) i--;
  return i < 0;
}

/* ------------------------------------------------------------------ the document */

/** an element's name without prefix, lower case (the HTML parser and XML spell clipPath differently) */
const tag = (el: Element) => { const n = el.localName; const i = n.indexOf(':'); return (i < 0 ? n : n.slice(i + 1)).toLowerCase(); };
/** an attribute, also as the HTML parser may have lower-cased it (viewbox) */
const attr = (el: Element, name: string): string | null => el.getAttribute(name) ?? (name !== name.toLowerCase() ? el.getAttribute(name.toLowerCase()) : null);
/** SVG elements; Inkscape's and Illustrator's own (sodipodi:namedview, i:pgf) are not drawn */
const isSvg = (el: Element) => !el.namespaceURI || el.namespaceURI === SVG_NS || el.namespaceURI === XHTML_NS;
const href = (el: Element): string | null => el.getAttribute('href') ?? el.getAttributeNS(XLINK_NS, 'href') ?? el.getAttribute('xlink:href');
/** the object's name: Inkscape's label (what the user called it), else the id */
const nameOf = (el: Element): string | null => el.getAttribute('inkscape:label') ?? el.getAttributeNS(INKSCAPE_NS, 'label') ?? el.getAttribute('id') ?? null;
const urlId = (v: string): string | null => /^url\(\s*['"]?#([^'")\s]+)['"]?\s*\)/i.exec(v.trim())?.[1] ?? null;

/** The inherited properties, as computed for an element (paints stay as written: currentColor is resolved where it is used). */
interface Computed {
  fill: string; fillOpacity: number; stroke: string; strokeOpacity: number;
  /** user units */
  strokeWidth: number;
  dash: string; color: string;
  /** user units */
  fontSize: number;
  fontWeight: string; fontStyle: string; fontFamily: string; anchor: string; visibility: string;
  markerStart: string; markerEnd: string;
}
/** Properties that do not inherit. */
interface Own { display: string; opacity: number; filter: string | null; mask: string | null; clip: string | null }

const ROOT_STYLE: Computed = {
  fill: 'black', fillOpacity: 1, stroke: 'none', strokeOpacity: 1, strokeWidth: 1, dash: 'none', color: 'black', fontSize: 16,
  fontWeight: 'normal', fontStyle: 'normal', fontFamily: '', anchor: 'start', visibility: 'visible', markerStart: 'none', markerEnd: 'none',
};

interface Ctx {
  /** user units → page millimetres, before the drawing is fitted onto the page */
  m: Mat;
  /** the viewport's size in user units: what percentages refer to */
  vp: Size;
  st: Computed;
  /** the product of the ancestors' opacities */
  opacity: number;
  /** the bounds of the clipping paths in effect (mm), only to warn when something sticks out */
  clip: Rect | null;
  /** the elements drawn through `use` on the way here (a reference back to one of them would never end) */
  chain: Element[];
  /** inside a `use`: the definitions' ids are no names of the instance */
  anon: boolean;
  /** the name the next element takes (a `use`'s own for the shape it shows) */
  name?: string | null;
}

interface ShapeItem {
  kind: 'shape'; segs: PathSeg[]; bounds: Rect; key: string; small: boolean; name: string | null;
  fill: string | null; stroke: string | null;
  /** pt, before fitting */
  lw: number | null;
  /** pt, before fitting */
  dash: number[] | null;
  opacity: number | null; arrows: string | null;
}
interface TextItem {
  kind: 'text';
  /** the first baseline's start / middle / end point, mm before fitting */
  at: [number, number];
  /** the direction of the baseline on screen (radians, clockwise) */
  angle: number;
  /** font size, mm before fitting */
  size: number;
  paras: PMNode[]; chars: number; anchor: string; color: string; opacity: number | null; name: string | null; leading: number | null;
}
type Item = ShapeItem | TextItem;

/** Where a text box goes: its first baseline through `at`, the box turned with the text. */
function textBox(it: TextItem, s: number, tx: number, ty: number): { x: number; y: number; w: number; h: number; rot: number } {
  const fs = it.size * s;
  const w = Math.max(2, (it.chars + 1) * CHAR_W * fs), h = Math.max(1, it.paras.length * (it.leading ?? 1.2) * fs);
  const k = it.anchor === 'middle' ? 0.5 : it.anchor === 'end' ? 1 : 0;
  // the box's centre relative to the anchor point, in the text's own axes (x along the baseline, y down)
  const lx = -k * w + w / 2, ly = -BASELINE * fs + h / 2;
  const c = Math.cos(it.angle), sn = Math.sin(it.angle);
  const cx = it.at[0] * s + tx + lx * c - ly * sn, cy = it.at[1] * s + ty + lx * sn + ly * c;
  return { x: cx - w / 2, y: cy - h / 2, w, h, rot: normDeg(-it.angle * 180 / Math.PI) };
}

const itemBounds = (it: Item): Rect => (it.kind === 'shape' ? it.bounds : boundsOf(textBox(it, 1, 0, 0)));

/**
 * Consecutive shapes of one style as one compound path: matplotlib draws every marker, glyph and
 * tick as an element of its own, and a scatter plot would otherwise be thousands of objects. Only
 * small shapes merge (markers, glyphs, ticks), so that a diagram's boxes stay objects of their
 * own — unless there are so many objects that the drawing would be unusable anyway (`all`).
 * Shapes with arrow tips never merge: the tips would be on the compound's ends only.
 */
function mergeRuns(items: Item[], all: boolean): Item[] {
  const out: Item[] = [];
  for (const it of items) {
    const prev = out[out.length - 1];
    if (prev?.kind === 'shape' && it.kind === 'shape' && !prev.arrows && !it.arrows && prev.key === it.key && (all || (prev.small && it.small))) {
      for (const s of it.segs) prev.segs.push(s);
      prev.bounds = union(prev.bounds, it.bounds)!;
      prev.name = null;
      continue;
    }
    out.push(it.kind === 'shape' ? { ...it, segs: it.segs.slice() } : it);
  }
  return out;
}

class Importer {
  private ids = new Map<string, Element>();
  private rules: Rule[] = [];
  private decls = new WeakMap<Element, Map<string, string>>();
  private paths = new WeakMap<Element, PathSeg[]>();
  private items: Item[] = [];
  private warnings = new Map<string, number>();
  private visits = 0;
  private stopped = false;

  warn(msg: string): void { this.warnings.set(msg, (this.warnings.get(msg) ?? 0) + 1); }
  messages(): string[] { return [...this.warnings].map(([m, n]) => (n > 1 ? `${m} (${n} times)` : m)); }

  run(svg: string, opts: SvgImportOptions): SvgImportResult {
    const root = this.parse(svg);
    if (!root) return { nodes: [], warnings: this.messages() };
    for (const el of [root, ...Array.from(root.getElementsByTagName('*'))]) {
      const id = el.getAttribute('id');
      if (id && !this.ids.has(id)) this.ids.set(id, el);
      if (tag(el) === 'style') parseSheet(el.textContent ?? '', this.rules);
    }

    // the root viewport: its size from width / height, else the viewBox (1 user unit = 1 px)
    const vb = parseViewBox(attr(root, 'viewBox'));
    let W = absLength(attr(root, 'width')), H = absLength(attr(root, 'height'));
    if (vb) {
      if (W === null && H === null) { W = vb.w; H = vb.h; }
      else if (W === null) W = H! * vb.w / vb.h;
      else if (H === null) H = W * vb.h / vb.w;
    }
    const toMm: Mat = [MM_PER_PX, 0, 0, MM_PER_PX, 0, 0];
    const m0 = vb && W !== null && H !== null ? mul(toMm, viewBoxMatrix(vb, 0, 0, W, H, attr(root, 'preserveAspectRatio'))) : toMm;
    const view: Rect | null = W !== null && H !== null ? { x: 0, y: 0, w: W * MM_PER_PX, h: H * MM_PER_PX } : null;
    const vp: Size = vb ? { w: vb.w, h: vb.h } : { w: W ?? 300, h: H ?? 150 };
    const { st, own } = this.computeStyle(root, ROOT_STYLE, vp);
    if (own.display !== 'none') this.children(root, { m: m0, vp, st, opacity: own.opacity, clip: null, chain: [], anon: false });

    let items = this.items;
    if (!items.length) { this.warn('The SVG has nothing that could be converted.'); return { nodes: [], warnings: this.messages() }; }
    const all = items.map(itemBounds).reduce<Rect | null>(union, null)!;
    const ref = Math.max((view ?? all).w, (view ?? all).h);
    for (const it of items) if (it.kind === 'shape') it.small = Math.max(it.bounds.w, it.bounds.h) <= SMALL * ref;
    items = mergeRuns(items, false);
    if (items.length > MERGE_ALL_ABOVE) items = mergeRuns(items, true);
    if (items.length > MAX_OBJECTS) {
      this.warn(`The drawing has ${items.length} objects: only the first ${MAX_OBJECTS} were converted.`);
      items = items.slice(0, MAX_OBJECTS);
    }

    // fitting: the viewport into `into` (where the picture was), else the content onto the page
    let s: number, tx: number, ty: number;
    if (opts.into) {
      const v = view ?? all, to = opts.into;
      s = Math.min(to.w / Math.max(v.w, 1e-9), to.h / Math.max(v.h, 1e-9));
      tx = to.x + (to.w - v.w * s) / 2 - v.x * s;
      ty = to.y + (to.h - v.h * s) / 2 - v.y * s;
    } else {
      const b = items.map(itemBounds).reduce<Rect | null>(union, null)!;
      s = Math.min(1, 0.8 * opts.page.w / Math.max(b.w, 1e-9), 0.8 * opts.page.h / Math.max(b.h, 1e-9));
      const [ax, ay] = opts.at ?? [(opts.page.w - b.w * s) / 2, (opts.page.h - b.h * s) / 2];
      tx = ax - b.x * s;
      ty = ay - b.y * s;
    }
    if (!(s > 0 && Number.isFinite(s + tx + ty))) { s = 1; tx = ty = 0; }

    const nodes: PMNode[] = [];
    for (const it of items) nodes.push(it.kind === 'shape' ? shapeNode(it, s, tx, ty) : boxNode(it, s, tx, ty));
    if (nodes.length <= 1) return { nodes, warnings: this.messages() };
    const title = Array.from(root.children).find(c => tag(c) === 'title')?.textContent?.trim() || null;
    return { nodes: [schema.nodes.ol_group.create({ name: title }, nodes)], warnings: this.messages() };
  }

  /**
   * The root `<svg>`. Markup that is no well-formed XML is read the way browsers read SVG inside
   * web pages — what copying an inline SVG from a page gives often lacks namespace declarations.
   */
  private parse(svg: string): Element | null {
    if (typeof DOMParser === 'undefined') { this.warn('SVG cannot be read here.'); return null; }
    // CDATA sections (style sheets) as escaped text: the same document, and no parser stumbles over them (happy-dom's do)
    const text = svg.trim().replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, (_, s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;'));
    if (!/<(?:\w+:)?svg[\s>/]/i.test(text)) { this.warn('This is no SVG drawing.'); return null; }
    const xml = new DOMParser().parseFromString(text, 'image/svg+xml');
    const broken = xml.getElementsByTagName('parsererror').length > 0;
    if (!broken) {
      const r = xml.documentElement;
      if (r && tag(r) === 'svg') return r;
      const inner = xml.getElementsByTagNameNS(SVG_NS, 'svg')[0];
      if (inner) return inner;
    }
    const r = new DOMParser().parseFromString(text, 'text/html').querySelector('svg');
    if (!r) { this.warn('This is no SVG drawing.'); return null; }
    if (broken) this.warn('The SVG is not well-formed XML: it was read the way browsers read SVG in web pages.');
    return r;
  }

  /* -------------------------------------------------------------- styles */

  /** An element's own declarations: presentation attributes < style sheet rules (by specificity, then order) < style attribute, !important on top. */
  private declared(el: Element): Map<string, string> {
    let d = this.decls.get(el);
    if (d) return d;
    d = new Map();
    for (const p of PRESENTATION) { const v = el.getAttribute(p); if (v !== null) d.set(p, v.trim()); }
    const important: Decl[] = [];
    if (this.rules.length) {
      const matched = this.rules.filter(r => matches(r.sel, el)).sort((a, b) => a.spec - b.spec || a.order - b.order);
      for (const r of matched) for (const x of r.decls) { if (x.important) important.push(x); else d.set(x.prop, x.value); }
    }
    const inline = parseDecls(el.getAttribute('style') ?? '');
    for (const x of inline) if (!x.important) d.set(x.prop, x.value);
    for (const x of important) d.set(x.prop, x.value);
    for (const x of inline) if (x.important) d.set(x.prop, x.value);
    this.decls.set(el, d);
    return d;
  }

  private computeStyle(el: Element, parent: Computed, vp: Size): { st: Computed; own: Own } {
    const d = this.declared(el);
    const get = (p: string) => { const v = d.get(p); return v === undefined || v === '' || v === 'inherit' ? undefined : v; };
    const st: Computed = { ...parent };
    let v: string | undefined;
    if ((v = get('font-size')) !== undefined) st.fontSize = fontSize(v, parent.fontSize) ?? parent.fontSize;
    if ((v = get('color')) !== undefined && !/^currentcolor$/i.test(v)) st.color = v;
    if ((v = get('fill')) !== undefined) st.fill = v;
    if ((v = get('stroke')) !== undefined) st.stroke = v;
    if ((v = get('fill-opacity')) !== undefined) st.fillOpacity = opacityOf(v) ?? st.fillOpacity;
    if ((v = get('stroke-opacity')) !== undefined) st.strokeOpacity = opacityOf(v) ?? st.strokeOpacity;
    if ((v = get('stroke-width')) !== undefined) { const w = length(v, diagonal(vp), st.fontSize); if (w !== null && w >= 0) st.strokeWidth = w; }
    if ((v = get('stroke-dasharray')) !== undefined) st.dash = v;
    if ((v = get('font-weight')) !== undefined) st.fontWeight = v.toLowerCase();
    if ((v = get('font-style')) !== undefined) st.fontStyle = v.toLowerCase();
    if ((v = get('font-family')) !== undefined) st.fontFamily = v;
    if ((v = get('text-anchor')) !== undefined) st.anchor = v.toLowerCase();
    if ((v = get('visibility')) !== undefined) st.visibility = v.toLowerCase();
    if ((v = get('marker-start')) !== undefined) st.markerStart = v;
    if ((v = get('marker-end')) !== undefined) st.markerEnd = v;
    const set = (p: string) => { const x = get(p)?.trim(); return x && x !== 'none' ? x : null; };
    return { st, own: { display: (get('display') ?? 'inline').trim(), opacity: opacityOf(get('opacity')) ?? 1, filter: set('filter'), mask: set('mask'), clip: set('clip-path') } };
  }

  /** A fill or stroke as an xcolor expression and its alpha (null: nothing painted). Gradients: their first stop's colour. */
  private paint(raw: string, colour: string): { tex: string | null; a: number } {
    const v = raw.trim();
    if (!v || v === 'none') return { tex: null, a: 0 };
    if (/^currentcolor$/i.test(v)) return this.colour(colour);
    if (/^url\(/i.test(v)) {
      const id = urlId(v), ref = id ? this.ids.get(id) : undefined, t = ref ? tag(ref) : '';
      if (ref && (t === 'lineargradient' || t === 'radialgradient')) {
        this.warn('Gradients were replaced by the colour of their first stop.');
        return this.firstStop(ref);
      }
      if (t === 'pattern') this.warn('Pattern fills were left out.');
      const fallback = v.replace(/^url\([^)]*\)/i, '').trim();
      return fallback ? this.paint(/^url\(/i.test(fallback) ? 'none' : fallback, colour) : { tex: null, a: 0 };
    }
    return this.colour(v);
  }

  private colour(v: string): { tex: string | null; a: number } {
    const c = parseColour(v);
    return c && c.a > 0 ? { tex: texColour(c.hex), a: c.a } : { tex: null, a: 0 };
  }

  /** A gradient's first stop (Inkscape keeps the stops in a gradient that others reference with href). */
  private firstStop(grad: Element): { tex: string | null; a: number } {
    for (let g: Element | undefined = grad, n = 0; g && n < 10; n++) {
      const stop = Array.from(g.children).find(c => tag(c) === 'stop');
      if (stop) {
        const d = this.declared(stop);
        const c = this.colour(d.get('stop-color') ?? 'black');
        return { tex: c.tex, a: c.a * (opacityOf(d.get('stop-opacity')) ?? 1) };
      }
      const h = href(g);
      g = h?.startsWith('#') ? this.ids.get(h.slice(1)) : undefined;
    }
    return { tex: null, a: 0 };
  }

  /** Whether a marker property names a marker of the document (one that does not draws nothing). */
  private isMarker(v: string): boolean {
    const id = urlId(v), el = id ? this.ids.get(id) : undefined;
    return !!el && tag(el) === 'marker';
  }

  /** The bounds (mm) of a clipping path in user space; null when unknown (objectBoundingBox units). */
  private clipBounds(v: string, m: Mat, vp: Size): Rect | null {
    const id = urlId(v), cp = id ? this.ids.get(id) : undefined;
    if (!cp || tag(cp) !== 'clippath' || attr(cp, 'clipPathUnits') === 'objectBoundingBox') return null;
    const cm = mul(m, parseTransform(attr(cp, 'transform')));
    let r: Rect | null = null;
    for (const c of Array.from(cp.children)) {
      let el: Element | undefined = c, cmm = mul(cm, parseTransform(attr(c, 'transform')));
      if (tag(c) === 'use') {
        const h = href(c);
        el = h?.startsWith('#') ? this.ids.get(h.slice(1)) : undefined;
        if (!el) continue;
        cmm = mul(mul(cmm, translate(length(attr(c, 'x'), vp.w) ?? 0, length(attr(c, 'y'), vp.h) ?? 0)), parseTransform(attr(el, 'transform')));
      }
      const g = SHAPES.has(tag(el)) ? this.geometry(el, vp, 16) : null;
      if (g?.length) r = union(r, extent(mapSegs(g, cmm)));
    }
    return r;
  }

  /* -------------------------------------------------------------- the tree */

  private children(el: Element, ctx: Ctx): void {
    for (const c of Array.from(el.children)) {
      if (this.stopped) return;
      this.walk(c, ctx);
    }
  }

  private walk(el: Element, ctx: Ctx): void {
    if (this.stopped || !isSvg(el)) return;
    if (++this.visits > MAX_VISITS) { this.stopped = true; this.warn('The drawing is too complex: only part of it was converted.'); return; }
    const t = tag(el);
    if (!DRAWN.has(t)) return;
    const { st, own } = this.computeStyle(el, ctx.st, ctx.vp);
    if (own.display === 'none') return;
    if (t === 'image') { this.warn('Embedded images (<image>) were left out.'); return; }
    if (t === 'foreignobject') { this.warn('HTML content (<foreignObject>) was left out.'); return; }
    if (t === 'flowroot') { this.warn('Flowed text (<flowRoot>) was left out.'); return; }
    if (own.mask) this.warn('Masks were ignored.');
    if (own.filter) this.warn('Filter effects (blur, shadows) were left out.');
    const name = ctx.name !== undefined ? ctx.name : ctx.anon ? null : nameOf(el);
    const m = t === 'svg' ? ctx.m : mul(ctx.m, parseTransform(attr(el, 'transform')));
    const clip = own.clip ? intersect(ctx.clip, this.clipBounds(own.clip, m, ctx.vp)) : ctx.clip;
    const sub: Ctx = { ...ctx, m, st, opacity: ctx.opacity * own.opacity, clip, name: undefined };
    switch (t) {
      case 'g': case 'a': this.children(el, sub); break;
      case 'switch': {
        // the first child without required extensions (we have none); draw.io writes its labels as
        // HTML with a plain-text alternative, and the HTML could not be converted
        const cands = Array.from(el.children).filter(c => isSvg(c) && !attr(c, 'requiredExtensions'));
        const c = cands.find(x => tag(x) !== 'foreignobject') ?? cands[0];
        if (c) this.walk(c, sub);
        break;
      }
      case 'svg': this.viewport(el, sub, null, null); break;
      case 'use': this.use(el, sub, name); break;
      case 'text': this.text(el, sub, name); break;
      default: this.shape(el, sub, name);
    }
  }

  /** A nested viewport (`svg`, or a `symbol` shown by `use`): its position, size and viewBox. */
  private viewport(el: Element, ctx: Ctx, w0: number | null, h0: number | null): void {
    const sym = tag(el) === 'symbol';
    const x = sym ? 0 : length(attr(el, 'x'), ctx.vp.w) ?? 0, y = sym ? 0 : length(attr(el, 'y'), ctx.vp.h) ?? 0;
    const w = w0 ?? length(attr(el, 'width'), ctx.vp.w) ?? ctx.vp.w, h = h0 ?? length(attr(el, 'height'), ctx.vp.h) ?? ctx.vp.h;
    if (!(w > 0 && h > 0)) return;
    const vb = parseViewBox(attr(el, 'viewBox'));
    const m = mul(ctx.m, vb ? viewBoxMatrix(vb, x, y, w, h, attr(el, 'preserveAspectRatio')) : translate(x, y));
    this.children(el, { ...ctx, m, vp: vb ? { w: vb.w, h: vb.h } : { w, h } });
  }

  /** `use`: the referenced element drawn at the use's x / y, inheriting the use's style. */
  private use(el: Element, ctx: Ctx, name: string | null): void {
    const h = href(el);
    const ref = h?.startsWith('#') ? this.ids.get(h.slice(1)) : undefined;
    if (!ref) { if (h && !h.startsWith('#')) this.warn('References to other files were left out.'); return; }
    if (ctx.chain.includes(ref) || ctx.chain.length > 50) return;
    const x = length(attr(el, 'x'), ctx.vp.w, ctx.st.fontSize) ?? 0, y = length(attr(el, 'y'), ctx.vp.h, ctx.st.fontSize) ?? 0;
    const sub: Ctx = { ...ctx, m: mul(ctx.m, translate(x, y)), chain: [...ctx.chain, ref], anon: true };
    const t = tag(ref);
    if (t === 'symbol' || t === 'svg') {
      const { st, own } = this.computeStyle(ref, ctx.st, ctx.vp);
      if (own.display === 'none') return;
      const w = length(attr(el, 'width'), ctx.vp.w), hh = length(attr(el, 'height'), ctx.vp.h);
      this.viewport(ref, { ...sub, st, opacity: sub.opacity * own.opacity }, w, hh);
    } else this.walk(ref, { ...sub, name: SHAPES.has(t) || t === 'text' ? name : undefined });
  }

  /** A basic shape or path in its user units (null: nothing to draw). */
  private geometry(el: Element, vp: Size, em: number): PathSeg[] | null {
    const t = tag(el);
    if (t === 'path') {
      let g = this.paths.get(el);
      if (!g) { g = normalizePath(cleanPathData(attr(el, 'd') ?? '')); this.paths.set(el, g); }
      return g;
    }
    const L = (a: string, ref: number) => length(attr(el, a), ref, em);
    switch (t) {
      case 'rect': {
        const x = L('x', vp.w) ?? 0, y = L('y', vp.h) ?? 0, w = L('width', vp.w) ?? 0, h = L('height', vp.h) ?? 0;
        if (!(w > 0 && h > 0)) return null;
        let rx = L('rx', vp.w), ry = L('ry', vp.h);
        if (rx !== null && rx < 0) rx = null;
        if (ry !== null && ry < 0) ry = null;
        rx ??= ry ?? 0;
        ry ??= rx;
        return rectPath(x, y, w, h, Math.min(rx, w / 2), Math.min(ry, h / 2));
      }
      case 'circle': {
        const r = L('r', diagonal(vp)) ?? 0;
        return r > 0 ? ellipsePath(L('cx', vp.w) ?? 0, L('cy', vp.h) ?? 0, r, r) : null;
      }
      case 'ellipse': {
        let rx = L('rx', vp.w), ry = L('ry', vp.h);
        rx ??= ry; ry ??= rx;
        return rx && ry && rx > 0 && ry > 0 ? ellipsePath(L('cx', vp.w) ?? 0, L('cy', vp.h) ?? 0, rx, ry) : null;
      }
      case 'line':
        return [{ c: 'M', p: [L('x1', vp.w) ?? 0, L('y1', vp.h) ?? 0] }, { c: 'L', p: [L('x2', vp.w) ?? 0, L('y2', vp.h) ?? 0] }];
      case 'polyline': case 'polygon': {
        const n = numbers(attr(el, 'points'));
        if (n.length < 4) return null;
        const segs: PathSeg[] = [];
        for (let i = 0; i + 1 < n.length; i += 2) segs.push({ c: i ? 'L' : 'M', p: [n[i], n[i + 1]] });
        if (t === 'polygon') segs.push({ c: 'Z' });
        return segs;
      }
    }
    return null;
  }

  private shape(el: Element, ctx: Ctx, name: string | null): void {
    const st = ctx.st;
    if (st.visibility === 'hidden' || st.visibility === 'collapse') return;
    const raw = this.geometry(el, ctx.vp, st.fontSize);
    if (!raw?.length || raw[0].c !== 'M') return;
    const segs = mapSegs(raw, ctx.m);
    if (segs.some(s => s.c !== 'Z' && !s.p.every(Number.isFinite))) return;
    const b = extent(segs);
    if (b.w < 1e-6 && b.h < 1e-6) return;
    const fillP = tag(el) !== 'line' && hasArea(segs) ? this.paint(st.fill, st.color) : { tex: null, a: 0 };
    const strokeP = st.strokeWidth > 0 ? this.paint(st.stroke, st.color) : { tex: null, a: 0 };
    const fa = fillP.a * st.fillOpacity, sa = strokeP.a * st.strokeOpacity;
    const fill = fillP.tex && fa > 0.005 ? fillP.tex : null, stroke = strokeP.tex && sa > 0.005 ? strokeP.tex : null;
    if ((!fill && !stroke) || (!stroke && (b.w < 1e-6 || b.h < 1e-6))) return;
    const op = ctx.opacity * (fill && stroke ? Math.max(fa, sa) : fill ? fa : sa);
    if (op < 0.005) return;
    const k = meanScale(ctx.m);
    let dash: number[] | null = null;
    if (stroke && st.dash !== 'none') {
      const d = st.dash.trim().split(/[\s,]+/).map(x => length(x, diagonal(ctx.vp), st.fontSize));
      if (d.every((x): x is number => x !== null && x >= 0) && d.some(x => x > 0)) dash = d.map(x => x * k * PT_PER_MM);
    }
    const closed = segs[segs.length - 1].c === 'Z';
    const ms = !!stroke && !closed && this.isMarker(st.markerStart), me = !!stroke && !closed && this.isMarker(st.markerEnd);
    const arrows = ms && me ? 'Stealth-Stealth' : me ? '-Stealth' : ms ? 'Stealth-' : null;
    const lw = stroke ? st.strokeWidth * k * PT_PER_MM : null;
    const opacity = op >= 0.995 ? null : Math.round(op * 1000) / 1000;
    if (ctx.clip) {
      const c = ctx.clip, tol = 0.01 + 0.005 * Math.max(c.w, c.h);
      if (b.x < c.x - tol || b.y < c.y - tol || b.x + b.w > c.x + c.w + tol || b.y + b.h > c.y + c.h + tol) this.warn('Clipping paths were ignored: what lies outside them is kept.');
    }
    const key = [fill, stroke, lw?.toFixed(4), dash?.map(x => x.toFixed(3)).join(' '), opacity].join('|');
    this.items.push({ kind: 'shape', segs, bounds: b, key, small: false, name, fill, stroke, lw, dash, opacity, arrows });
  }

  /**
   * `<text>` as a text box: a paragraph per line (a tspan with its own y, or an x with a dy, starts
   * one — how Inkscape and d3 write multi-line text), bold / italic / monospaced runs as marks,
   * the box's size, colour, alignment and rotation from the text's.
   */
  private text(el: Element, ctx: Ctx, name: string | null): void {
    if (ctx.st.visibility === 'hidden' || ctx.st.visibility === 'collapse') return;
    const first = (e: Element, a: string, ref: number, em: number): number | null => {
      const v = attr(e, a)?.trim().split(/[\s,]+/)[0];
      return v ? length(v, ref, em) : null;
    };
    const fs0 = ctx.st.fontSize;
    type Run = { text: string; st: Computed };
    type Line = { x: number; y: number; runs: Run[] };
    const lines: Line[] = [{
      x: (first(el, 'x', ctx.vp.w, fs0) ?? 0) + (first(el, 'dx', ctx.vp.w, fs0) ?? 0),
      y: (first(el, 'y', ctx.vp.h, fs0) ?? 0) + (first(el, 'dy', ctx.vp.h, fs0) ?? 0),
      runs: [],
    }];
    const collect = (node: Element, st: Computed) => {
      for (const n of Array.from(node.childNodes)) {
        if (n.nodeType === 3 || n.nodeType === 4) { if (n.nodeValue) lines[lines.length - 1].runs.push({ text: n.nodeValue, st }); continue; }
        if (n.nodeType !== 1) continue;
        const c = n as Element;
        if (!isSvg(c) || !TEXT_CHILDREN.has(tag(c))) continue;
        const cs = this.computeStyle(c, st, ctx.vp);
        if (cs.own.display === 'none') continue;
        const fs = cs.st.fontSize, cur = lines[lines.length - 1];
        const x = first(c, 'x', ctx.vp.w, fs), y = first(c, 'y', ctx.vp.h, fs), dy = first(c, 'dy', ctx.vp.h, fs);
        const ny = y !== null ? y + (dy ?? 0) : dy !== null && x !== null ? cur.y + dy : null;
        const hasText = cur.runs.some(r => r.text.trim());
        if (ny !== null && Math.abs(ny - cur.y) > 0.5 * fs && hasText) lines.push({ x: x ?? cur.x, y: ny, runs: [] });
        else if (!hasText) { if (x !== null) cur.x = x; if (ny !== null) cur.y = ny; }
        collect(c, cs.st);
      }
    };
    collect(el, ctx.st);
    // white space as CSS collapses it: runs of blanks are one space, none at a line's ends
    for (const l of lines) {
      let space = true;
      for (const r of l.runs) {
        r.text = r.text.replace(/\s+/g, ' ');
        if (space) r.text = r.text.replace(/^ /, '');
        if (r.text) space = r.text.endsWith(' ');
      }
      for (let i = l.runs.length - 1; i >= 0; i--) {
        l.runs[i].text = l.runs[i].text.replace(/ $/, '');
        if (l.runs[i].text) break;
      }
    }
    const kept = lines.filter(l => l.runs.some(r => r.text));
    if (!kept.length) return;
    const rs = kept[0].runs.find(r => r.text)!.st;
    const fillP = this.paint(rs.fill, rs.color), strokeP = this.paint(rs.stroke, rs.color);
    const p = fillP.tex ? { ...fillP, a: fillP.a * rs.fillOpacity } : strokeP.tex ? { ...strokeP, a: strokeP.a * rs.strokeOpacity } : null;
    if (!p?.tex) return;
    const op = ctx.opacity * p.a;
    if (op < 0.005) return;
    const marks = (st: Computed): Mark[] => {
      const out: Mark[] = [];
      if (/^(bold|bolder|[6-9]00)$/.test(st.fontWeight)) out.push(schema.marks.series.create({ value: 'bold' }));
      if (/^(italic|oblique)/.test(st.fontStyle)) out.push(schema.marks.shape.create({ value: 'italic' }));
      if (/mono|courier|consol|menlo|typewriter/i.test(st.fontFamily)) out.push(schema.marks.family.create({ value: 'typewriter' }));
      return out;
    };
    const paras = kept.map(l => schema.nodes.paragraph.create({ layout: 'Plain Layout', depth: 0 }, l.runs.filter(r => r.text).map(r => schema.text(r.text, marks(r.st)))));
    const spacing = kept.length > 1 ? (kept[1].y - kept[0].y) / rs.fontSize : 1.2;
    this.items.push({
      kind: 'text', at: apply(ctx.m, kept[0].x, kept[0].y), angle: Math.atan2(ctx.m[1], ctx.m[0]), size: rs.fontSize * meanScale(ctx.m),
      paras, chars: Math.max(...kept.map(l => l.runs.reduce((n, r) => n + r.text.length, 0))), anchor: rs.anchor, color: p.tex,
      opacity: op >= 0.995 ? null : Math.round(op * 1000) / 1000, name,
      leading: spacing > 0.5 && spacing < 4 && Math.abs(spacing - 1.2) > 0.02 ? Math.round(spacing * 100) / 100 : null,
    });
  }
}

/* ------------------------------------------------------------------ nodes */

function shapeNode(it: ShapeItem, s: number, tx: number, ty: number): PMNode {
  const segs = it.segs.map(sg => (sg.c === 'Z' ? sg : { c: sg.c, p: sg.p.map((v, i) => r3(i % 2 === 0 ? v * s + tx : v * s + ty)) }) as PathSeg);
  const lw = it.lw !== null ? Math.max(0.05, Math.round(it.lw * s * 1000) / 1000) : null;
  const dash = it.dash && lw !== null ? dashName(it.dash.map(v => v * s), lw) : null;
  const n = shapeFromPath(segs, { fill: it.fill, stroke: it.stroke, lw, dash, arrows: it.arrows, opacity: it.opacity, name: it.name });
  const a = n.attrs;
  return n.type.create({ ...a, x: r3(Number(a.x)), y: r3(Number(a.y)), w: r3(Number(a.w)), h: r3(Number(a.h)) });
}

function boxNode(it: TextItem, s: number, tx: number, ty: number): PMNode {
  const b = textBox(it, s, tx, ty);
  return makeBox({
    x: r3(b.x), y: r3(b.y), w: r3(b.w), h: r3(b.h), rot: b.rot, font: Math.round(it.size * s * PT_PER_MM * 100) / 100,
    color: it.color, align: ALIGN[it.anchor] ?? 'left', opacity: it.opacity, name: it.name, leading: it.leading,
  }, it.paras);
}
