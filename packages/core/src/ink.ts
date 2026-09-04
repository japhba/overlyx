/**
 * Freehand ink: pressure-sensitive strokes and their rendering as SVG paths.
 *
 * A stroke is a polyline of [x, y, pressure] points plus a colour and a nominal width; rendering
 * turns it into a closed variable-width outline (the Goodnotes look) that both the editor canvas
 * (via Path2D) and the saved .svg file (via <path d>) draw from — one geometry, two backends.
 * `inkSvg`/`extractInkData` write and read the sidecar files: a normal SVG anyone can open, with
 * the editable stroke data embedded verbatim in a <metadata> element.
 */

/** [x, y, pressure 0..1]; pressure 0 means "unknown" (a mouse) and draws at half width. */
export type InkPts = [number, number, number][];

export interface InkStroke {
  /** margin ink: which column edge the x offsets are relative to */
  side?: 'left' | 'right';
  color: string;
  /** nominal stroke width in px */
  w: number;
  /** opacity (highlighter), 1 when absent */
  o?: number;
  pts: InkPts;
}

/** An image placed on the ink layer (pasted into the margin): document-relative file, offsets like a stroke's. */
export interface InkImage {
  /** margin ink: which column edge dx is relative to */
  side?: 'left' | 'right';
  /** file path relative to the document (figures/…) */
  src: string;
  dx: number; dy: number; w: number; h: number;
}

export interface InkData { v: 1; strokes: InkStroke[]; imgs?: InkImage[] }

const r2 = (n: number) => Math.round(n * 100) / 100;

/** Radius of the stroke at a point: pressure maps to 40%..100% of the nominal width. */
function radius(w: number, p: number): number {
  const pr = p > 0 ? Math.min(p, 1) : 0.5;
  return Math.max(0.35, (w / 2) * (0.4 + 0.6 * pr));
}

/** Drop consecutive points closer than ~0.7px (pen events oversample heavily). */
function decimate(pts: InkPts): InkPts {
  const out: InkPts = [];
  for (const pt of pts) {
    const last = out[out.length - 1];
    if (last && (last[0] - pt[0]) ** 2 + (last[1] - pt[1]) ** 2 < 0.5) {
      // keep the strongest pressure of the collapsed run so fast dots do not vanish
      if (pt[2] > last[2]) last[2] = pt[2];
      continue;
    }
    out.push([pt[0], pt[1], pt[2]]);
  }
  return out;
}

/**
 * The closed outline of a variable-width stroke as an SVG path (`d` attribute). The outline runs
 * down one side and back up the other through quadratic curves between segment midpoints, with
 * round caps; a single point becomes a dot.
 */
export function strokePathD(stroke: InkStroke): string {
  const pts = decimate(stroke.pts);
  const w = stroke.w;
  if (pts.length === 0) return '';
  if (pts.length === 1) {
    const [x, y, p] = pts[0];
    const r = radius(w, p);
    return `M${r2(x - r)} ${r2(y)}A${r2(r)} ${r2(r)} 0 1 0 ${r2(x + r)} ${r2(y)}A${r2(r)} ${r2(r)} 0 1 0 ${r2(x - r)} ${r2(y)}Z`;
  }
  // per-point normals, averaged between neighbouring segments
  const n = pts.length;
  const left: [number, number][] = [], right: [number, number][] = [];
  for (let i = 0; i < n; i++) {
    const a = pts[Math.max(0, i - 1)], b = pts[Math.min(n - 1, i + 1)];
    let dx = b[0] - a[0], dy = b[1] - a[1];
    const len = Math.hypot(dx, dy) || 1;
    dx /= len; dy /= len;
    const r = radius(w, pts[i][2]);
    left.push([pts[i][0] - dy * r, pts[i][1] + dx * r]);
    right.push([pts[i][0] + dy * r, pts[i][1] - dx * r]);
  }
  const mid = (a: [number, number], b: [number, number]): [number, number] => [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2];
  const walk = (side: [number, number][]): string => {
    let d = '';
    for (let i = 1; i < side.length - 1; i++) {
      const m = mid(side[i], side[i + 1]);
      d += `Q${r2(side[i][0])} ${r2(side[i][1])} ${r2(m[0])} ${r2(m[1])}`;
    }
    const last = side[side.length - 1];
    d += `L${r2(last[0])} ${r2(last[1])}`;
    return d;
  };
  const rEnd = radius(w, pts[n - 1][2]), rStart = radius(w, pts[0][2]);
  let d = `M${r2(left[0][0])} ${r2(left[0][1])}`;
  d += walk(left);
  d += `A${r2(rEnd)} ${r2(rEnd)} 0 0 1 ${r2(right[n - 1][0])} ${r2(right[n - 1][1])}`;
  d += walk(right.slice().reverse());
  d += `A${r2(rStart)} ${r2(rStart)} 0 0 1 ${r2(left[0][0])} ${r2(left[0][1])}Z`;
  return d;
}

/**
 * The smoothed centre line through a trail of points as an SVG path — the laser pointer's trace
 * (stroked, never filled: a uniform glowing line, not a pressure outline). One point becomes a
 * zero-length segment, which round caps draw as a dot.
 */
export function laserPathD(pts: readonly (readonly [number, number, ...unknown[]])[]): string {
  if (pts.length === 0) return '';
  let d = `M${r2(pts[0][0])} ${r2(pts[0][1])}`;
  if (pts.length === 1) return d + `L${r2(pts[0][0])} ${r2(pts[0][1])}`;
  for (let i = 1; i < pts.length - 1; i++) {
    const mx = (pts[i][0] + pts[i + 1][0]) / 2, my = (pts[i][1] + pts[i + 1][1]) / 2;
    d += `Q${r2(pts[i][0])} ${r2(pts[i][1])} ${r2(mx)} ${r2(my)}`;
  }
  const last = pts[pts.length - 1];
  return d + `L${r2(last[0])} ${r2(last[1])}`;
}

/** Bounding box of the strokes and images, padded by the stroke widths. */
export function inkBounds(strokes: InkStroke[], imgs: InkImage[] = []): { x: number; y: number; w: number; h: number } {
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const s of strokes) for (const [x, y] of s.pts) {
    if (x - s.w < minX) minX = x - s.w;
    if (y - s.w < minY) minY = y - s.w;
    if (x + s.w > maxX) maxX = x + s.w;
    if (y + s.w > maxY) maxY = y + s.w;
  }
  for (const im of imgs) {
    if (im.dx < minX) minX = im.dx;
    if (im.dy < minY) minY = im.dy;
    if (im.dx + im.w > maxX) maxX = im.dx + im.w;
    if (im.dy + im.h > maxY) maxY = im.dy + im.h;
  }
  if (minX > maxX) return { x: 0, y: 0, w: 1, h: 1 };
  return { x: r2(minX), y: r2(minY), w: r2(maxX - minX), h: r2(maxY - minY) };
}

/** `target` relative to the directory `fromPath` sits in (both document-relative POSIX paths). */
function relHref(fromPath: string, target: string): string {
  const dir = fromPath.split('/').slice(0, -1);
  const to = target.split('/');
  while (dir.length && to.length > 1 && dir[0] === to[0]) { dir.shift(); to.shift(); }
  return '../'.repeat(dir.length) + to.join('/');
}

const xmlEscape = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const xmlUnescape = (s: string) => s.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&');

const META_OPEN = '<metadata id="overlyx-ink">', META_CLOSE = '</metadata>';

/**
 * The saved sidecar SVG of a sketch: images (under the ink) and the strokes as filled paths, plus
 * the data (`dataJson` verbatim) in a metadata element. Deterministic — the same data always
 * produces the same bytes, so re-saving an unchanged document does not touch the file. `svgPath`
 * (the sketch file's own document-relative path) makes the image hrefs resolve from the SVG.
 */
export function inkSvg(dataJson: string, svgPath = ''): string {
  let data: InkData;
  try { data = JSON.parse(dataJson) as InkData; } catch { data = { v: 1, strokes: [] }; }
  const strokes = Array.isArray(data.strokes) ? data.strokes.filter(s => Array.isArray(s.pts) && s.pts.length) : [];
  const imgs = Array.isArray(data.imgs) ? data.imgs.filter(i => i && typeof i.src === 'string') : [];
  const b = inkBounds(strokes, imgs);
  let s = `<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" viewBox="${b.x} ${b.y} ${b.w} ${b.h}" width="${b.w}" height="${b.h}">\n`;
  s += `${META_OPEN}${xmlEscape(dataJson)}${META_CLOSE}\n`;
  for (const im of imgs) {
    s += `<image href="${xmlEscape(relHref(svgPath, im.src))}" x="${r2(im.dx)}" y="${r2(im.dy)}" width="${r2(im.w)}" height="${r2(im.h)}" preserveAspectRatio="none"/>\n`;
  }
  for (const st of strokes) {
    const d = strokePathD(st);
    if (!d) continue;
    s += `<path d="${d}" fill="${xmlEscape(st.color)}"${st.o !== undefined && st.o < 1 ? ` fill-opacity="${st.o}"` : ''}/>\n`;
  }
  return s + '</svg>\n';
}

/** The stroke data embedded in a sketch SVG (the verbatim JSON string), or null. */
export function extractInkData(svg: string): string | null {
  const i = svg.indexOf(META_OPEN);
  if (i < 0) return null;
  const j = svg.indexOf(META_CLOSE, i);
  if (j < 0) return null;
  const json = xmlUnescape(svg.slice(i + META_OPEN.length, j));
  try { JSON.parse(json); } catch { return null; }
  return json;
}

/* ------------------------------------------------------------------ lasso geometry */

/** A closed polygon as its vertices (the last one connects back to the first). */
export type Polygon = [number, number][];

/** Is the point inside the (implicitly closed) polygon? Even-odd ray cast. */
export function pointInPolygon(x: number, y: number, poly: Polygon): boolean {
  let inside = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const [xi, yi] = poly[i], [xj, yj] = poly[j];
    if (yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

/** Do the segments a–b and c–d intersect (touching counts)? */
export function segmentsIntersect(ax: number, ay: number, bx: number, by: number, cx: number, cy: number, dx: number, dy: number): boolean {
  const o = (px: number, py: number, qx: number, qy: number, rx: number, ry: number) => Math.sign((qx - px) * (ry - py) - (qy - py) * (rx - px));
  const o1 = o(ax, ay, bx, by, cx, cy), o2 = o(ax, ay, bx, by, dx, dy);
  const o3 = o(cx, cy, dx, dy, ax, ay), o4 = o(cx, cy, dx, dy, bx, by);
  if (o1 !== o2 && o3 !== o4) return true;
  // collinear cases: an endpoint lies on the other segment
  const on = (px: number, py: number, qx: number, qy: number, rx: number, ry: number) =>
    Math.min(px, qx) <= rx && rx <= Math.max(px, qx) && Math.min(py, qy) <= ry && ry <= Math.max(py, qy);
  return (o1 === 0 && on(ax, ay, bx, by, cx, cy)) || (o2 === 0 && on(ax, ay, bx, by, dx, dy))
    || (o3 === 0 && on(cx, cy, dx, dy, ax, ay)) || (o4 === 0 && on(cx, cy, dx, dy, bx, by));
}

function polygonBounds(poly: Polygon): { minX: number; minY: number; maxX: number; maxY: number } {
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const [x, y] of poly) { if (x < minX) minX = x; if (y < minY) minY = y; if (x > maxX) maxX = x; if (y > maxY) maxY = y; }
  return { minX, minY, maxX, maxY };
}

/**
 * Does a lasso catch this polyline? Goodnotes semantics: the lasso does not have to swallow the
 * whole stroke — any part of it inside the (auto-closed) polygon, or any crossing of the lasso
 * line, selects it. A single point counts as inside/outside.
 */
export function polylineHitsPolygon(pts: readonly (readonly [number, number, ...unknown[]])[] | readonly [number, number][], poly: Polygon): boolean {
  if (pts.length === 0 || poly.length < 3) return false;
  const pb = polygonBounds(poly);
  // quick reject: the stroke's box misses the lasso's box entirely
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const p of pts) { if (p[0] < minX) minX = p[0]; if (p[1] < minY) minY = p[1]; if (p[0] > maxX) maxX = p[0]; if (p[1] > maxY) maxY = p[1]; }
  if (maxX < pb.minX || minX > pb.maxX || maxY < pb.minY || minY > pb.maxY) return false;
  for (const p of pts) if (pointInPolygon(p[0], p[1], poly)) return true;
  if (pts.length === 1) return false;
  // no vertex inside: the stroke may still cut through the lasso (a long straight line)
  for (let i = 1; i < pts.length; i++) {
    const [ax, ay] = pts[i - 1], [bx, by] = pts[i];
    for (let j = 0, k = poly.length - 1; j < poly.length; k = j++) {
      const [cx, cy] = poly[j], [dx, dy] = poly[k];
      if (segmentsIntersect(ax, ay, bx, by, cx, cy, dx, dy)) return true;
    }
  }
  return false;
}

/** Does a lasso touch this axis-aligned rectangle (an image, a sticky note)? Overlap of any kind counts. */
export function rectHitsPolygon(x: number, y: number, w: number, h: number, poly: Polygon): boolean {
  if (poly.length < 3) return false;
  const corners: [number, number][] = [[x, y], [x + w, y], [x + w, y + h], [x, y + h]];
  // a lasso vertex inside the rectangle (the lasso is drawn within it, or crosses it)
  for (const [px, py] of poly) if (px >= x && px <= x + w && py >= y && py <= y + h) return true;
  // the rectangle inside the lasso, or its edges crossing the lasso line
  return polylineHitsPolygon([...corners, corners[0]], poly);
}
