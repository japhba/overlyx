/**
 * Margin ink: the stroke geometry / SVG sidecars (packages/core/src/ink.ts) and the `\olsketch`
 * round trip through the .tex parser and writer, plus the ProseMirror conversion.
 *   npx vitest run tests/ink.test.ts
 */
import { describe, it, expect } from 'vitest';
import { parseTex, writeTex } from '../packages/core/src/tex/index.ts';
import { inkSvg, extractInkData, strokePathD, laserPathD, inkBounds, insetToPm, pmToLyxBody, lyxToPmNode, pointInPolygon, segmentsIntersect, polylineHitsPolygon, rectHitsPolygon, type InkStroke, type LyxDocument } from '../packages/core/src/index.ts';

const DATA = JSON.stringify({
  v: 1,
  strokes: [
    { side: 'right', color: '#1a73e8', w: 2, pts: [[4, 0, 0.5], [10, 6, 0.8], [18, 4, 0.6]] },
    { side: 'right', color: '#fbbc04', w: 8, o: 0.4, pts: [[0, 20, 0], [30, 20, 0]] },
  ],
});

const doc = (body: string) => `\\documentclass{article}\n\n\\begin{document}\n${body}\n\\end{document}\n`;

describe('ink geometry and SVG sidecars', () => {
  it('renders strokes to deterministic outline paths', () => {
    const s: InkStroke = { color: '#000', w: 2, pts: [[0, 0, 0.5], [10, 0, 0.5], [20, 5, 1]] };
    const d1 = strokePathD(s), d2 = strokePathD(s);
    expect(d1).toBe(d2);
    expect(d1.startsWith('M')).toBe(true);
    expect(d1.endsWith('Z')).toBe(true);
    // a single point becomes a dot
    expect(strokePathD({ color: '#000', w: 4, pts: [[5, 5, 1]] })).toContain('A');
    expect(strokePathD({ color: '#000', w: 4, pts: [] })).toBe('');
  });

  it('bounds cover all strokes padded by their width', () => {
    const b = inkBounds([{ color: '#000', w: 2, pts: [[0, 0, 1], [10, 20, 1]] }]);
    expect(b.x).toBeLessThanOrEqual(-2);
    expect(b.w).toBeGreaterThanOrEqual(14);
  });

  it('renders margin images under the ink, hrefs relative to the SVG', () => {
    const data = JSON.stringify({
      v: 1,
      strokes: [{ side: 'right', color: '#000', w: 2, pts: [[0, 0, 0.5], [10, 5, 0.5]] }],
      imgs: [
        { side: 'right', src: 'figures/shot.png', dx: 4, dy: 30, w: 120, h: 80 },
        { side: 'right', src: 'plots/curve.svg', dx: 4, dy: 130, w: 100, h: 60 },
      ],
    });
    const svg = inkSvg(data, 'figures/ink-a.svg');
    expect(svg).toContain('<image href="shot.png" x="4" y="30" width="120" height="80"');
    expect(svg).toContain('<image href="../plots/curve.svg"');
    expect(svg.indexOf('<image')).toBeLessThan(svg.indexOf('<path'));   // ink draws over images
    expect(extractInkData(svg)).toBe(data);
    const b = inkBounds(JSON.parse(data).strokes, JSON.parse(data).imgs);
    expect(b.h).toBeGreaterThanOrEqual(190);   // image extents count
  });

  it('embeds the stroke data verbatim in the SVG and reads it back', () => {
    const svg = inkSvg(DATA);
    expect(svg).toContain('<svg xmlns');
    expect(svg).toContain('fill-opacity="0.4"');
    expect(extractInkData(svg)).toBe(DATA);
    // deterministic: same data, same bytes
    expect(inkSvg(DATA)).toBe(svg);
    expect(extractInkData('<svg></svg>')).toBeNull();
  });
});

describe('\\olsketch round trip', () => {
  const readFile = (name: string) => (name === 'figures/sketch-1.svg' ? inkSvg(DATA) : undefined);

  it('parses to a Sketch inset with the stroke data from the SVG, and writes the same file back', () => {
    const src = doc('\\olsketch{figures/sketch-1.svg}Hello margin.');
    const d = parseTex(src, { readFile }).doc;
    const found: { arg: string; params: string[] }[] = [];
    for (const p of d.body) for (const it of p.items) if (it.kind === 'inset' && it.inset.type === 'Leaf' && it.inset.name === 'Sketch') found.push({ arg: it.inset.arg, params: it.inset.params });
    expect(found).toHaveLength(1);
    expect(found[0].arg).toBe('figures/sketch-1.svg');
    expect(found[0].params[0]).toBe(DATA);
    const out = writeTex(d);
    expect(out.text).toContain('\\olsketch{figures/sketch-1.svg}');
    expect(out.text).toContain('\\newcommand{\\olsketch}[1]{}');
    expect(out.files['figures/sketch-1.svg']).toBe(inkSvg(DATA));
    // stable: writing the parse of the written text reproduces it byte for byte
    const again = writeTex(parseTex(out.text, { readFile }).doc);
    expect(again.text).toBe(out.text);
  });

  it('an unreadable SVG keeps the anchor and touches no file', () => {
    const src = doc('\\olsketch{figures/gone.svg}Text.');
    const d = parseTex(src).doc;
    const out = writeTex(d);
    expect(out.text).toContain('\\olsketch{figures/gone.svg}');
    expect(Object.keys(out.files)).toHaveLength(0);
  });

  it('converts to a ProseMirror sketch node and back losslessly', () => {
    const src = doc('\\olsketch{figures/sketch-1.svg}Anchored.');
    const d = parseTex(src, { readFile }).doc;
    const pm = lyxToPmNode(d as LyxDocument);
    let node: { attrs: { src: string; data: string | null } } | null = null;
    pm.descendants(n => { if (n.type.name === 'sketch') node = n as never; return true; });
    expect(node).not.toBeNull();
    expect(node!.attrs.src).toBe('figures/sketch-1.svg');
    expect(node!.attrs.data).toBe(DATA);
    const body = pmToLyxBody(pm);
    const out = writeTex({ ...d, body });
    expect(out.text).toBe(writeTex(d).text);
    expect(insetToPm({ type: 'Leaf', name: 'Sketch', arg: 'x.svg', params: [] })).toEqual({ type: 'sketch', attrs: { src: 'x.svg', data: null } });
  });
});

describe('lasso geometry (Goodnotes semantics: touching the lasso is enough)', () => {
  // a square lasso from (0,0) to (100,100), listed as the pointer drew it (not closed explicitly)
  const square: [number, number][] = [[0, 0], [100, 0], [100, 100], [0, 100]];

  it('pointInPolygon treats the polygon as closed', () => {
    expect(pointInPolygon(50, 50, square)).toBe(true);
    expect(pointInPolygon(150, 50, square)).toBe(false);
    expect(pointInPolygon(50, -1, square)).toBe(false);
  });

  it('segmentsIntersect: crossing, touching, parallel', () => {
    expect(segmentsIntersect(0, 0, 10, 10, 0, 10, 10, 0)).toBe(true);
    expect(segmentsIntersect(0, 0, 10, 0, 5, 0, 5, 10)).toBe(true);     // T-touch
    expect(segmentsIntersect(0, 0, 10, 0, 0, 1, 10, 1)).toBe(false);    // parallel
    expect(segmentsIntersect(0, 0, 10, 0, 11, 0, 20, 0)).toBe(false);   // collinear, apart
    expect(segmentsIntersect(0, 0, 10, 0, 5, 0, 20, 0)).toBe(true);     // collinear, overlapping
  });

  it('a stroke partly inside the lasso is caught, one entirely outside is not', () => {
    const halfIn: [number, number, number][] = [[50, 50, 0.5], [150, 50, 0.5], [250, 50, 0.5], [350, 50, 0.5]];   // 1 of 4 points inside
    expect(polylineHitsPolygon(halfIn, square)).toBe(true);
    const outside: [number, number, number][] = [[150, 50, 0.5], [250, 50, 0.5]];
    expect(polylineHitsPolygon(outside, square)).toBe(false);
    expect(polylineHitsPolygon([], square)).toBe(false);
  });

  it('a straight line cutting through the lasso with no vertex inside is still caught', () => {
    const through: [number, number, number][] = [[-50, 50, 0], [150, 50, 0]];
    expect(polylineHitsPolygon(through, square)).toBe(true);
    // …but one passing beside it is not, even when its bounding box overlaps the lasso's
    const beside: [number, number, number][] = [[-50, 120, 0], [150, 120, 0]];
    expect(polylineHitsPolygon(beside, square)).toBe(false);
  });

  it('the lasso closes itself: a U-shaped path selects what lies between its open ends', () => {
    // drawn down the left, along the bottom and up the right — never back along the top
    const u: [number, number][] = [[0, 0], [0, 100], [100, 100], [100, 0]];
    expect(polylineHitsPolygon([[50, 10, 0]], u)).toBe(true);
    expect(pointInPolygon(50, 10, u)).toBe(true);
  });

  it('images and notes: any overlap with the lasso selects the rectangle', () => {
    expect(rectHitsPolygon(80, 80, 100, 100, square)).toBe(true);    // corner overlap
    expect(rectHitsPolygon(20, 20, 10, 10, square)).toBe(true);      // fully inside
    expect(rectHitsPolygon(-50, -50, 300, 300, square)).toBe(true);  // lasso inside the rectangle
    expect(rectHitsPolygon(120, 120, 10, 10, square)).toBe(false);
    // a narrow lasso crossing the rectangle without a vertex inside it
    const tall: [number, number][] = [[40, -50], [60, -50], [60, 150], [40, 150]];
    expect(rectHitsPolygon(0, 0, 100, 100, tall)).toBe(true);
  });
});

describe('laser pointer trace', () => {
  it('laserPathD is a smoothed open centre line; a single point is a zero-length segment (a dot with round caps)', () => {
    expect(laserPathD([])).toBe('');
    expect(laserPathD([[3, 4]])).toBe('M3 4L3 4');
    expect(laserPathD([[0, 0], [10, 0]])).toBe('M0 0L10 0');
    const d = laserPathD([[0, 0], [10, 0], [10, 10], [20, 10]]);
    expect(d).toBe('M0 0Q10 0 10 5Q10 10 15 10L20 10');
    expect(d).not.toContain('Z');   // never closed: it is stroked, not filled
    // extra tuple members (pressure) are ignored
    expect(laserPathD([[0, 0, 0.5], [4, 4, 1]])).toBe('M0 0L4 4');
  });
});
