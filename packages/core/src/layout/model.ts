/**
 * Layout documents (OverLyX's *Layout* mode, like Pages' page layout or a Keynote / beamer deck):
 * fixed-size pages holding freely positioned objects — text boxes with LyX content, vector
 * shapes (SVG path data), images with cropping, groups and raw LaTeX. The file stays an ordinary
 * beamer `.tex` document: a page is `\begin{frame}[plain] … \end{frame}`, an object a line of the
 * small macro package in latex.ts (`\begin{olbox}{x=…,y=…}`, `\olshape{…}{M 0 0 …}`, …), so it
 * compiles anywhere and animations are beamer overlays (`step=2-`).
 *
 * In the document model a page is a paragraph of layout `OLPage` whose items are object insets —
 * the way LyX keeps a box inside a paragraph — so everything that works on paragraphs and insets
 * (diffs, merges, tracked edits, the source map) works on pages too. The editor converts them to
 * typed ProseMirror nodes (ol_page, ol_box, …; see convert.ts).
 *
 * Geometry is in millimetres from the page's top left corner (y downwards, as on screen);
 * `rotate` is TikZ's, counter-clockwise in degrees, about the object's centre.
 */

export const PAGE_LAYOUT = 'OLPage';
export const GROUP_LAYOUT = 'OLGroup';
export const OBJECT_INSETS = new Set(['OLBox', 'OLShape', 'OLImage', 'OLGroup', 'OLRaw']);
export const PAGE_PROPS_INSET = 'OLPageProps';
export const NOTES_INSET = 'OLNotes';

/* ------------------------------------------------------------------ lengths */

const MM_PER: Record<string, number> = {
  mm: 1, cm: 10, in: 25.4, pt: 25.4 / 72.27, bp: 25.4 / 72, pc: 12 * 25.4 / 72.27,
  dd: (1238 / 1157) * 25.4 / 72.27, cc: 12 * (1238 / 1157) * 25.4 / 72.27, sp: 25.4 / 72.27 / 65536, px: 25.4 / 96,
};
export const PT_PER_MM = 72.27 / 25.4;

/** A TeX length ("12.5mm", "3 cm", "10pt") in millimetres; a bare number is taken as `unit`. */
export function toMm(v: string | number | null | undefined, unit = 'mm'): number | null {
  if (v === null || v === undefined) return null;
  if (typeof v === 'number') return Number.isFinite(v) ? v * (MM_PER[unit] ?? 1) : null;
  const m = /^\s*(-?(?:\d+\.?\d*|\.\d+))\s*([a-z]{2})?\s*$/i.exec(v);
  if (!m) return null;
  const f = MM_PER[(m[2] ?? unit).toLowerCase()];
  return f === undefined ? null : Number(m[1]) * f;
}

/** A TeX length in points (TeX's pt). */
export function toPt(v: string | number | null | undefined, unit = 'pt'): number | null {
  const mm = toMm(v, unit);
  return mm === null ? null : mm * PT_PER_MM;
}

/** A number as written into the file: at most `digits` decimals, no trailing zeros, no "-0". */
export function fmtNum(n: number, digits = 2): string {
  if (!Number.isFinite(n)) return '0';
  const f = 10 ** digits;
  let s = String(Math.round(n * f) / f);
  if (s === '-0') s = '0';
  return s;
}

/* ------------------------------------------------------------------ keys */

export type KeyList = [string, string | null][];

/** Split at top-level `sep` (outside braces / brackets). */
export function splitTop(s: string, sep: string): string[] {
  const out: string[] = [];
  let depth = 0, cur = '';
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (c === '\\' && i + 1 < s.length) { cur += c + s[i + 1]; i++; continue; }
    if (c === '{' || c === '[') depth++;
    else if ((c === '}' || c === ']') && depth > 0) depth--;
    if (c === sep && depth === 0) { out.push(cur); cur = ''; continue; }
    cur += c;
  }
  out.push(cur);
  return out;
}

function unbrace(v: string): string {
  const t = v.trim();
  if (t.startsWith('{') && t.endsWith('}')) {
    // only when the braces enclose the whole value
    let depth = 0;
    for (let i = 0; i < t.length; i++) {
      if (t[i] === '\\') { i++; continue; }
      if (t[i] === '{') depth++;
      else if (t[i] === '}') { depth--; if (depth === 0 && i < t.length - 1) return t; }
    }
    return t.slice(1, -1);
  }
  return t;
}

/** `x=10mm, name={A, B}, lock` → [['x','10mm'], ['name','A, B'], ['lock', null]] */
export function parseKeys(s: string): KeyList {
  const out: KeyList = [];
  for (const part of splitTop(s, ',')) {
    const p = part.trim();
    if (!p) continue;
    const eq = splitTop(p, '=');
    if (eq.length === 1) out.push([p, null]);
    else out.push([eq[0].trim(), unbrace(eq.slice(1).join('='))]);
  }
  return out;
}

/** A value that needs braces in a key list (commas, equals signs, leading/trailing blanks). */
function keyValue(v: string): string {
  return /[,=]|^\s|\s$|^$/.test(v) && !(v.startsWith('{') && v.endsWith('}')) ? `{${v}}` : v;
}

export function writeKeys(keys: KeyList): string {
  return keys.map(([k, v]) => (v === null ? k : `${k}=${keyValue(v)}`)).join(',');
}

/* ------------------------------------------------------------------ objects */

/** Properties every positioned object has. */
export interface Placement {
  x: number; y: number; w: number; h: number;
  /** degrees, counter-clockwise (TikZ) */
  rot: number;
}

export interface CommonProps {
  /** beamer overlay specification: the steps on which the object is shown (`2-`, `2-4`, `3`) */
  step: string | null;
  /** how the object enters in OverLyX's presentation mode: fade, fly-left, fly-right, fly-up, fly-down, zoom, wipe */
  effect: string | null;
  /** its name in the layers list */
  name: string | null;
  lock: boolean;
  opacity: number | null;
  /** keys this version does not know, kept as written */
  extra: string;
}

export interface BoxProps extends Placement, CommonProps {
  fill: string | null; stroke: string | null; lw: number | null; radius: number | null; pad: number | null;
  valign: 't' | 'c' | 'b';
  shape: 'rect' | 'ellipse';
  /** base font size of the text, pt */
  font: number | null;
  /** line spacing as a factor of the font size (TeX: baselineskip) */
  leading: number | null;
  /** default text colour */
  color: string | null;
  /** the height follows the text (the editor measures it) */
  grow: boolean;
}

export interface ShapeProps extends Placement, CommonProps {
  fill: string | null; stroke: string | null; lw: number | null;
  /** TikZ dash pattern name: dashed, dotted, densely dashed, … */
  dash: string | null;
  /** TikZ arrow tips: ->, <-, <->, -Stealth, … */
  arrows: string | null;
  /** the path's own coordinate box: "minx miny width height" (like SVG's viewBox) */
  vb: string;
}

export interface ImageProps extends Placement, CommonProps {
  /** cropped fractions of the image: left top right bottom */
  crop: [number, number, number, number];
}

export interface RawProps extends Placement, CommonProps {
  /** false: LaTeX of the page that is no object (kept verbatim where it was, not positioned) */
  placed: boolean;
}

export interface GroupProps extends CommonProps {}

export interface PageProps {
  /** background colour */
  fill: string | null;
  /** beamer slide transition: fade, dissolve, wipe, push, cover, … */
  transition: string | null;
  name: string | null;
  /** the frame's options as written (`plain`, `plain,t`) */
  frame: string;
  extra: string;
}

const num = (v: string | null | undefined): number | null => {
  if (v === null || v === undefined || v.trim() === '') return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
};

/** Split known keys off; the rest is returned in written form. */
function takeKeys(keys: KeyList, known: Set<string>): { get(k: string): string | null | undefined; has(k: string): boolean; extra: string } {
  const map = new Map<string, string | null>();
  const rest: KeyList = [];
  for (const [k, v] of keys) {
    if (known.has(k)) map.set(k, v);
    else rest.push([k, v]);
  }
  return { get: k => map.get(k), has: k => map.has(k), extra: writeKeys(rest) };
}

const PLACE_KEYS = ['x', 'y', 'w', 'h', 'rotate'];
const COMMON_KEYS = ['step', 'effect', 'name', 'lock', 'opacity'];
const BOX_KEYS = new Set([...PLACE_KEYS, ...COMMON_KEYS, 'fill', 'draw', 'line', 'radius', 'pad', 'valign', 'shape', 'font', 'leading', 'color', 'grow']);
const SHAPE_KEYS = new Set([...PLACE_KEYS, ...COMMON_KEYS, 'fill', 'draw', 'line', 'dash', 'arrows', 'vb']);
const IMAGE_KEYS = new Set([...PLACE_KEYS, ...COMMON_KEYS, 'crop']);
const RAW_KEYS = new Set([...PLACE_KEYS, ...COMMON_KEYS]);
const GROUP_KEYS = new Set(COMMON_KEYS);
const PAGE_KEYS = new Set(['fill', 'transition', 'name']);

function placement(k: ReturnType<typeof takeKeys>): Placement {
  return {
    x: toMm(k.get('x') ?? null) ?? 0, y: toMm(k.get('y') ?? null) ?? 0,
    w: toMm(k.get('w') ?? null) ?? 10, h: toMm(k.get('h') ?? null) ?? 10,
    rot: num(k.get('rotate')) ?? 0,
  };
}

function common(k: ReturnType<typeof takeKeys>): CommonProps {
  return {
    step: k.get('step') || null, effect: k.get('effect') || null, name: k.get('name') ?? null,
    lock: k.has('lock') && k.get('lock') !== 'false', opacity: num(k.get('opacity')), extra: k.extra,
  };
}

export function parseBoxKeys(s: string): BoxProps {
  const k = takeKeys(parseKeys(s), BOX_KEYS);
  const valign = k.get('valign');
  return {
    ...placement(k), ...common(k),
    fill: k.get('fill') || null, stroke: k.get('draw') || null,
    lw: toPt(k.get('line') ?? null), radius: toMm(k.get('radius') ?? null), pad: toMm(k.get('pad') ?? null),
    valign: valign === 'c' || valign === 'b' ? valign : 't',
    shape: k.get('shape') === 'ellipse' ? 'ellipse' : 'rect',
    font: toPt(k.get('font') ?? null), leading: num(k.get('leading')), color: k.get('color') || null,
    grow: k.has('grow') && k.get('grow') !== 'false',
  };
}

export function parseShapeKeys(s: string): ShapeProps {
  const k = takeKeys(parseKeys(s), SHAPE_KEYS);
  return {
    ...placement(k), ...common(k),
    fill: k.get('fill') || null, stroke: k.get('draw') || null, lw: toPt(k.get('line') ?? null),
    dash: k.get('dash') || null, arrows: k.get('arrows') || null, vb: k.get('vb') || '0 0 1 1',
  };
}

export function parseImageKeys(s: string): ImageProps {
  const k = takeKeys(parseKeys(s), IMAGE_KEYS);
  const c = (k.get('crop') ?? '').trim().split(/\s+/).map(Number);
  const crop: [number, number, number, number] = c.length === 4 && c.every(Number.isFinite) ? [c[0], c[1], c[2], c[3]] : [0, 0, 0, 0];
  return { ...placement(k), ...common(k), crop };
}

export function parseRawKeys(s: string, placed = true): RawProps {
  const k = takeKeys(parseKeys(s), RAW_KEYS);
  return { ...placement(k), ...common(k), placed };
}

export function parseGroupKeys(s: string): GroupProps {
  return common(takeKeys(parseKeys(s), GROUP_KEYS));
}

export function parsePageKeys(s: string, frame = 'plain'): PageProps {
  const k = takeKeys(parseKeys(s), PAGE_KEYS);
  return { fill: k.get('fill') || null, transition: k.get('transition') || null, name: k.get('name') ?? null, frame, extra: k.extra };
}

const mm = (n: number) => fmtNum(n) + 'mm';
const pt = (n: number) => fmtNum(n) + 'pt';

function placementKeys(p: Placement): KeyList {
  const out: KeyList = [['x', mm(p.x)], ['y', mm(p.y)], ['w', mm(p.w)], ['h', mm(p.h)]];
  if (p.rot) out.push(['rotate', fmtNum(p.rot)]);
  return out;
}

function commonKeys(p: CommonProps, out: KeyList): string {
  if (p.opacity !== null && p.opacity !== 1) out.push(['opacity', fmtNum(p.opacity)]);
  if (p.step) out.push(['step', p.step]);
  if (p.effect) out.push(['effect', p.effect]);
  if (p.name) out.push(['name', p.name]);
  if (p.lock) out.push(['lock', null]);
  const s = writeKeys(out);
  return p.extra ? (s ? s + ',' + p.extra : p.extra) : s;
}

export function writeBoxKeys(p: BoxProps): string {
  const out = placementKeys(p);
  if (p.fill) out.push(['fill', p.fill]);
  if (p.stroke) out.push(['draw', p.stroke]);
  if (p.stroke && p.lw !== null) out.push(['line', pt(p.lw)]);
  if (p.radius) out.push(['radius', mm(p.radius)]);
  if (p.pad) out.push(['pad', mm(p.pad)]);
  if (p.valign !== 't') out.push(['valign', p.valign]);
  if (p.shape !== 'rect') out.push(['shape', p.shape]);
  if (p.font) out.push(['font', pt(p.font)]);
  if (p.leading) out.push(['leading', fmtNum(p.leading, 3)]);
  if (p.color) out.push(['color', p.color]);
  if (p.grow) out.push(['grow', null]);
  return commonKeys(p, out);
}

export function writeShapeKeys(p: ShapeProps): string {
  const out = placementKeys(p);
  out.push(['vb', p.vb]);
  if (p.fill) out.push(['fill', p.fill]);
  if (p.stroke) out.push(['draw', p.stroke]);
  if (p.stroke && p.lw !== null) out.push(['line', pt(p.lw)]);
  if (p.dash) out.push(['dash', p.dash]);
  if (p.arrows) out.push(['arrows', p.arrows]);
  return commonKeys(p, out);
}

export function writeImageKeys(p: ImageProps): string {
  const out = placementKeys(p);
  if (p.crop.some(c => c !== 0)) out.push(['crop', p.crop.map(c => fmtNum(c, 4)).join(' ')]);
  return commonKeys(p, out);
}

export function writeRawKeys(p: RawProps): string {
  return commonKeys(p, placementKeys(p));
}

export function writeGroupKeys(p: GroupProps): string {
  return commonKeys(p, []);
}

export function writePageKeys(p: PageProps): string {
  const out: KeyList = [];
  if (p.fill) out.push(['fill', p.fill]);
  if (p.transition) out.push(['transition', p.transition]);
  if (p.name) out.push(['name', p.name]);
  const s = writeKeys(out);
  return p.extra ? (s ? s + ',' + p.extra : p.extra) : s;
}

/* ------------------------------------------------------------------ pages */

export interface PagePreset { id: string; label: string; w: number; h: number; kind: 'slides' | 'poster' | 'page'; /** beamer's \documentclass[aspectratio=…] */ aspect?: string }

/** Page sizes offered for new layout documents (mm). Slides are beamer's own sizes. */
export const PAGE_PRESETS: PagePreset[] = [
  { id: 'slides169', label: 'Slides 16:9', w: 160, h: 90, kind: 'slides', aspect: '169' },
  { id: 'slides1610', label: 'Slides 16:10', w: 160, h: 100, kind: 'slides', aspect: '1610' },
  { id: 'slides43', label: 'Slides 4:3', w: 128, h: 96, kind: 'slides', aspect: '43' },
  { id: 'a0p', label: 'Poster A0 portrait', w: 841, h: 1189, kind: 'poster' },
  { id: 'a0l', label: 'Poster A0 landscape', w: 1189, h: 841, kind: 'poster' },
  { id: 'a1p', label: 'Poster A1 portrait', w: 594, h: 841, kind: 'poster' },
  { id: 'a4p', label: 'A4 page', w: 210, h: 297, kind: 'page' },
  { id: 'a4l', label: 'A4 landscape', w: 297, h: 210, kind: 'page' },
  { id: 'letter', label: 'US Letter page', w: 215.9, h: 279.4, kind: 'page' },
];

/** beamer's page size for an aspectratio class option (mm). */
export const BEAMER_ASPECT: Record<string, [number, number]> = {
  '169': [160, 90], '1610': [160, 100], '149': [140, 90], '141': [148.5, 105], '54': [125, 100], '43': [128, 96], '32': [135, 90], '2013': [200, 130],
};

/**
 * The page size of a document from its header lines: a custom paper size (Document settings, what
 * layout documents use), else beamer's aspect ratio option, else beamer's default 128 × 96 mm.
 */
export function pageSizeOf(headerLines: string[]): { w: number; h: number } {
  const val = (key: string) => { const l = headerLines.find(x => x.startsWith('\\' + key + ' ')); return l ? l.slice(key.length + 2).trim() : undefined; };
  if (val('papersize') === 'custom') {
    const w = toMm(val('paperwidth') ?? null), h = toMm(val('paperheight') ?? null);
    if (w && h) return { w, h };
  }
  const opts = val('options') ?? '';
  const ar = /aspectratio=(\d+)/.exec(opts);
  if (ar && BEAMER_ASPECT[ar[1]]) { const [w, h] = BEAMER_ASPECT[ar[1]]; return { w, h }; }
  return { w: 128, h: 96 };
}

/* ------------------------------------------------------------------ paths */

/** Tokens of SVG path data: commands and numbers. */
function pathTokens(d: string): (string | number)[] {
  const out: (string | number)[] = [];
  const re = /([MmLlHhVvCcSsQqTtAaZz])|(-?(?:\d+\.?\d*|\.\d+)(?:e[-+]?\d+)?)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(d))) out.push(m[1] ?? Number(m[2]));
  return out;
}

export type PathSeg = { c: 'M' | 'L'; p: [number, number] } | { c: 'C'; p: [number, number, number, number, number, number] } | { c: 'Z' };

/** Elliptical arc (SVG endpoint parametrisation) as cubic Béziers. */
function arcToCubics(x1: number, y1: number, rx: number, ry: number, phi: number, fa: number, fs: number, x2: number, y2: number): PathSeg[] {
  if (rx === 0 || ry === 0) return [{ c: 'L', p: [x2, y2] }];
  const sin = Math.sin(phi * Math.PI / 180), cos = Math.cos(phi * Math.PI / 180);
  const dx = (x1 - x2) / 2, dy = (y1 - y2) / 2;
  const x1p = cos * dx + sin * dy, y1p = -sin * dx + cos * dy;
  rx = Math.abs(rx); ry = Math.abs(ry);
  const lam = (x1p * x1p) / (rx * rx) + (y1p * y1p) / (ry * ry);
  if (lam > 1) { rx *= Math.sqrt(lam); ry *= Math.sqrt(lam); }
  const sign = fa === fs ? -1 : 1;
  const num = rx * rx * ry * ry - rx * rx * y1p * y1p - ry * ry * x1p * x1p;
  const co = sign * Math.sqrt(Math.max(0, num / (rx * rx * y1p * y1p + ry * ry * x1p * x1p)));
  const cxp = co * rx * y1p / ry, cyp = -co * ry * x1p / rx;
  const cx = cos * cxp - sin * cyp + (x1 + x2) / 2, cy = sin * cxp + cos * cyp + (y1 + y2) / 2;
  const ang = (ux: number, uy: number, vx: number, vy: number) => { const a = Math.atan2(ux * vy - uy * vx, ux * vx + uy * vy); return a; };
  const t1 = ang(1, 0, (x1p - cxp) / rx, (y1p - cyp) / ry);
  let dt = ang((x1p - cxp) / rx, (y1p - cyp) / ry, (-x1p - cxp) / rx, (-y1p - cyp) / ry);
  if (!fs && dt > 0) dt -= 2 * Math.PI; else if (fs && dt < 0) dt += 2 * Math.PI;
  const n = Math.max(1, Math.ceil(Math.abs(dt) / (Math.PI / 2)));
  const out: PathSeg[] = [];
  const d = dt / n, k = (4 / 3) * Math.tan(d / 4);
  const pt = (t: number): [number, number] => [cx + rx * Math.cos(t) * cos - ry * Math.sin(t) * sin, cy + rx * Math.cos(t) * sin + ry * Math.sin(t) * cos];
  const der = (t: number): [number, number] => [-rx * Math.sin(t) * cos - ry * Math.cos(t) * sin, -rx * Math.sin(t) * sin + ry * Math.cos(t) * cos];
  for (let i = 0; i < n; i++) {
    const a = t1 + i * d, b = a + d;
    const [ax, ay] = pt(a), [bx, by] = pt(b), [dax, day] = der(a), [dbx, dby] = der(b);
    out.push({ c: 'C', p: [ax + k * dax, ay + k * day, bx - k * dbx, by - k * dby, bx, by] });
  }
  return out;
}

/**
 * SVG path data in the absolute M / L / C / Z subset both renderers draw identically (TikZ's
 * svg.path library reads it too): relative commands, H / V, S, Q / T and arcs are converted.
 */
export function normalizePath(d: string): PathSeg[] {
  const t = pathTokens(d);
  const out: PathSeg[] = [];
  let i = 0, cmd = '', x = 0, y = 0, sx = 0, sy = 0;
  let lastC: [number, number] | null = null, lastQ: [number, number] | null = null;
  const n = () => { const v = t[i++]; return typeof v === 'number' ? v : NaN; };
  while (i < t.length) {
    if (typeof t[i] === 'string') cmd = t[i++] as string;
    else if (!cmd) { i++; continue; }
    const rel = cmd === cmd.toLowerCase();
    const C = cmd.toUpperCase();
    const ox = rel ? x : 0, oy = rel ? y : 0;
    if (C === 'Z') { out.push({ c: 'Z' }); x = sx; y = sy; lastC = lastQ = null; if (typeof t[i] === 'number') cmd = rel ? 'l' : 'L'; continue; }
    if (C === 'M') { x = ox + n(); y = oy + n(); sx = x; sy = y; out.push({ c: 'M', p: [x, y] }); cmd = rel ? 'l' : 'L'; lastC = lastQ = null; }
    else if (C === 'L') { x = ox + n(); y = oy + n(); out.push({ c: 'L', p: [x, y] }); lastC = lastQ = null; }
    else if (C === 'H') { x = ox + n(); out.push({ c: 'L', p: [x, y] }); lastC = lastQ = null; }
    else if (C === 'V') { y = oy + n(); out.push({ c: 'L', p: [x, y] }); lastC = lastQ = null; }
    else if (C === 'C') {
      const a = [ox + n(), oy + n(), ox + n(), oy + n(), ox + n(), oy + n()] as [number, number, number, number, number, number];
      out.push({ c: 'C', p: a }); lastC = [a[2], a[3]]; lastQ = null; x = a[4]; y = a[5];
    } else if (C === 'S') {
      const c1: [number, number] = lastC ? [2 * x - lastC[0], 2 * y - lastC[1]] : [x, y];
      const a = [c1[0], c1[1], ox + n(), oy + n(), ox + n(), oy + n()] as [number, number, number, number, number, number];
      out.push({ c: 'C', p: a }); lastC = [a[2], a[3]]; lastQ = null; x = a[4]; y = a[5];
    } else if (C === 'Q' || C === 'T') {
      const q: [number, number] = C === 'Q' ? [ox + n(), oy + n()] : lastQ ? [2 * x - lastQ[0], 2 * y - lastQ[1]] : [x, y];
      const ex = ox + n(), ey = oy + n();
      out.push({ c: 'C', p: [x + 2 / 3 * (q[0] - x), y + 2 / 3 * (q[1] - y), ex + 2 / 3 * (q[0] - ex), ey + 2 / 3 * (q[1] - ey), ex, ey] });
      lastQ = q; lastC = null; x = ex; y = ey;
    } else if (C === 'A') {
      const rx = n(), ry = n(), phi = n(), fa = n(), fs = n(), ex = ox + n(), ey = oy + n();
      out.push(...arcToCubics(x, y, rx, ry, phi, fa, fs, ex, ey));
      x = ex; y = ey; lastC = lastQ = null;
    } else { i++; }
    if (out.length && out[out.length - 1].c !== 'Z' && (out[out.length - 1] as { p: number[] }).p.some(v => !Number.isFinite(v))) out.pop();
  }
  return out;
}

export function pathToString(segs: PathSeg[], digits = 2): string {
  return segs.map(s => (s.c === 'Z' ? 'Z' : s.c + ' ' + s.p.map(v => fmtNum(v, digits)).join(' '))).join(' ');
}

export function pathBounds(segs: PathSeg[]): { x: number; y: number; w: number; h: number } {
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (const s of segs) {
    if (s.c === 'Z') continue;
    for (let i = 0; i < s.p.length; i += 2) { x0 = Math.min(x0, s.p[i]); x1 = Math.max(x1, s.p[i]); y0 = Math.min(y0, s.p[i + 1]); y1 = Math.max(y1, s.p[i + 1]); }
  }
  if (!Number.isFinite(x0)) return { x: 0, y: 0, w: 1, h: 1 };
  return { x: x0, y: y0, w: Math.max(x1 - x0, 1e-3), h: Math.max(y1 - y0, 1e-3) };
}

/** Parse "minx miny w h". */
export function parseViewBox(vb: string): { x: number; y: number; w: number; h: number } {
  const v = vb.trim().split(/[\s,]+/).map(Number);
  if (v.length === 4 && v.every(Number.isFinite) && v[2] > 0 && v[3] > 0) return { x: v[0], y: v[1], w: v[2], h: v[3] };
  return { x: 0, y: 0, w: 1, h: 1 };
}

/** Standard shapes as (normalised) path data in a 100 × 100 box. */
export const SHAPE_PRESETS: Record<string, { label: string; d: string; vb?: string }> = {
  rect: { label: 'Rectangle', d: 'M 0 0 L 100 0 L 100 100 L 0 100 Z' },
  ellipse: { label: 'Ellipse', d: 'M 100 50 C 100 77.61 77.61 100 50 100 C 22.39 100 0 77.61 0 50 C 0 22.39 22.39 0 50 0 C 77.61 0 100 22.39 100 50 Z' },
  triangle: { label: 'Triangle', d: 'M 50 0 L 100 100 L 0 100 Z' },
  diamond: { label: 'Diamond', d: 'M 50 0 L 100 50 L 50 100 L 0 50 Z' },
  line: { label: 'Line', d: 'M 0 0 L 100 100' },
  arrow: { label: 'Block arrow', d: 'M 0 30 L 60 30 L 60 0 L 100 50 L 60 100 L 60 70 L 0 70 Z' },
  star: { label: 'Star', d: 'M 50 0 L 61.8 35.4 L 100 38.2 L 69.1 61.8 L 80.9 100 L 50 76.4 L 19.1 100 L 30.9 61.8 L 0 38.2 L 38.2 35.4 Z' },
  roundrect: { label: 'Rounded rectangle', d: 'M 15 0 L 85 0 C 93.28 0 100 6.72 100 15 L 100 85 C 100 93.28 93.28 100 85 100 L 15 100 C 6.72 100 0 93.28 0 85 L 0 15 C 0 6.72 6.72 0 15 0 Z' },
};
