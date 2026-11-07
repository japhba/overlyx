/** Ink used by the overlap lint only; layout/overflow checks still measure the full boxes. */
export const noOverlap = (el: Element): boolean => !!el.closest('[data-ol-lint~="no-overlap"]');

export function visibleInk(el: Element): boolean {
  if (getComputedStyle(el).visibility !== 'visible') return false;
  for (let p: Element | null = el; p; p = p.parentElement) {
    const c = getComputedStyle(p);
    if (c.display === 'none' || Number(c.opacity) === 0) return false;
  }
  return true;
}

let canvas: HTMLCanvasElement | undefined;
/** Tighten character advances to the font's glyph ink, keeping the browser's layout/line breaks. */
export function glyphInk(el: Element): (ch: string, rect: DOMRect) => DOMRect {
  const unchanged = (_ch: string, rect: DOMRect) => rect;
  const c = getComputedStyle(el);
  if (c.writingMode && c.writingMode !== 'horizontal-tb') return unchanged;
  // A rotated range is already an axis-aligned envelope; font-axis metrics cannot tighten it.
  for (let p: Element | null = el; p; p = p.parentElement) {
    const st = getComputedStyle(p);
    if (st.rotate && st.rotate !== 'none') return unchanged;
    if (st.transform && st.transform !== 'none') {
      const m = new DOMMatrix(st.transform);
      if (!m.is2D || m.b || m.c) return unchanged;
    }
  }
  const ctx = (canvas ??= document.createElement('canvas')).getContext('2d');
  if (!ctx) return unchanged;
  ctx.font = c.font || `${c.fontStyle} ${c.fontWeight} ${c.fontSize} ${c.fontFamily}`;
  ctx.textAlign = 'left'; ctx.textBaseline = 'alphabetic'; ctx.direction = c.direction === 'rtl' ? 'rtl' : 'ltr';
  const measured = new Map<string, TextMetrics>();
  return (ch, r) => {
    let m = measured.get(ch);
    if (!m) { m = ctx.measureText(ch); measured.set(ch, m); }
    const height = m.fontBoundingBoxAscent + m.fontBoundingBoxDescent;
    if (!(m.width > 0 && height > 0 && m.actualBoundingBoxAscent + m.actualBoundingBoxDescent > 0)) return r;
    const sx = r.width / m.width, sy = r.height / height;
    return new DOMRect(r.left - m.actualBoundingBoxLeft * sx,
      r.top + (m.fontBoundingBoxAscent - m.actualBoundingBoxAscent) * sy,
      (m.actualBoundingBoxLeft + m.actualBoundingBoxRight) * sx,
      (m.actualBoundingBoxAscent + m.actualBoundingBoxDescent) * sy);
  };
}

const SVG_PARTS = 'path, rect, circle, ellipse, line, polygon, polyline, use, text, image, foreignObject';
const DEFINITION = 'defs, clipPath, mask, marker, symbol, pattern';

/** Individual formula glyphs and rules, without the SVG viewport or its unpainted definitions. */
export function formulaInk(el: Element): DOMRect[] {
  return Array.from(el.querySelectorAll(SVG_PARTS))
    .filter(p => !p.closest(DEFINITION) && !noOverlap(p) && visibleInk(p))
    .filter(p => {
      const c = getComputedStyle(p);
      return p.matches('image, foreignObject') || (paint(c.fill) && Number(c.fillOpacity) > 0) ||
        (paint(c.stroke) && Number(c.strokeOpacity) > 0 && parseFloat(c.strokeWidth) > 0);
    })
    .map(p => p.getBoundingClientRect()).filter(r => r.width > 0 && r.height > 0);
}

/** A picture must be above the text to cover it. Slide objects are siblings in one stacking context. */
export function aboveText(picture: Element, text: Element): boolean {
  const z = (e: Element) => Number.parseInt(getComputedStyle(e).zIndex) || 0;
  return z(picture) > z(text) || (z(picture) === z(text) && !!(text.compareDocumentPosition(picture) & Node.DOCUMENT_POSITION_FOLLOWING));
}

interface Ink { box: DOMRect; at?: (x: number, y: number) => boolean }
const paint = (c: string) => c !== 'none' && c !== 'transparent' && !/rgba\([^)]*,\s*0\s*\)$/.test(c);

/**
 * Inline SVGs are tested against their fills/strokes in local coordinates, never their viewport.
 * Opaque media and SVG image/text/use leaves retain their own bounds (not their enclosing group).
 */
export function pictureInk(el: Element): (rect: DOMRect) => boolean {
  const parts = el.matches('svg') ? Array.from(el.querySelectorAll(SVG_PARTS)) :
    Array.from(el.querySelectorAll(`svg :is(${SVG_PARTS}), img, canvas, video`));
  if (el.matches('img, canvas, video')) parts.push(el);
  const ink: Ink[] = [];
  for (const p of parts) {
    if (p.closest(DEFINITION) || noOverlap(p) || !visibleInk(p)) continue;
    const box = p.getBoundingClientRect();
    if (typeof (p as SVGGeometryElement).isPointInFill !== 'function') {
      if (box.width > 0 && box.height > 0) ink.push({ box });
      continue;
    }
    const g = p as SVGGeometryElement, m = g.getScreenCTM();
    if (!m || !Number.isFinite(m.inverse().a)) continue;
    const inv = m.inverse(), c = getComputedStyle(g);
    const fill = paint(c.fill) && Number(c.fillOpacity) > 0;
    const stroke = paint(c.stroke) && Number(c.strokeOpacity) > 0 && parseFloat(c.strokeWidth) > 0;
    if (!fill && !stroke) continue;
    // getBoundingClientRect excludes stroke, including on horizontal/vertical lines.
    const sw = stroke ? parseFloat(c.strokeWidth) / 2 : 0;
    const dx = sw * Math.hypot(m.a, m.c), dy = sw * Math.hypot(m.b, m.d);
    ink.push({ box: new DOMRect(box.left - dx, box.top - dy, box.width + 2 * dx, box.height + 2 * dy), at: (x, y) => {
      const q = new DOMPoint(x, y).matrixTransform(inv);
      return (fill && g.isPointInFill(q)) || (stroke && g.isPointInStroke(q));
    } });
  }
  return rect => ink.some(({ box, at }) => {
    // Ignore contact at glyph edges, just as the text/text overlap check does.
    const l = Math.max(rect.left + 1, box.left), r = Math.min(rect.right - 1, box.right);
    const t = Math.max(rect.top + 1, box.top), b = Math.min(rect.bottom - 1, box.bottom);
    if (r <= l || b <= t) return false;
    if (!at) return true;
    // Subpixel sampling, bounded even for unusually large glyphs on a poster.
    const step = Math.max(0.75, Math.sqrt((r - l) * (b - t) / 4096));
    const nx = Math.min(64, Math.max(1, Math.ceil((r - l) / step))), ny = Math.min(64, Math.max(1, Math.ceil((b - t) / step)));
    for (let y = 0; y < ny; y++) for (let x = 0; x < nx; x++) {
      if (at(l + (x + 0.5) * (r - l) / nx, t + (y + 0.5) * (b - t) / ny)) return true;
    }
    return false;
  });
}
