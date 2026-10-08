// @vitest-environment happy-dom
/**
 * SVG → editable layout objects (client editor/layout/svgimport.ts): geometry of every basic shape
 * in page millimetres, transforms composed through groups / use / nested viewports, the CSS cascade
 * and inheritance, opacity, dashes and arrow tips, text as text boxes, merging of the thousands of
 * small paths plotting libraries write, fitting onto the page, real-world Inkscape and matplotlib
 * files, malformed input — and every result valid in the schema and written as a stable beamer file.
 */
import { describe, it, expect } from 'vitest';
import type { Node as PMNode } from 'prosemirror-model';
import { schema, layoutTemplate, lyxToPmNode, pmToLyxBody, normalizePath } from '@overlyx/core';
import { parseTex, writeTex } from '../packages/core/src/tex/index.ts';
import { svgToLayoutObjects, type SvgImportOptions } from '../packages/client/src/editor/layout/svgimport.ts';
import { LYX_LAYOUTS } from './lyxlib';

const texOpts = { layoutDir: LYX_LAYOUTS, localDirs: [] };
const PAGE = { w: 160, h: 90 };
const BIG = { w: 2000, h: 2000 };

const svg = (attrs: string, body: string) =>
  `<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" ${attrs}>${body}</svg>`;
/** a drawing of w × h mm with 1 user unit = 1 mm, converted at its natural size and place */
const mm = (w: number, h: number, body: string, extra: Partial<SvgImportOptions> = {}) =>
  svgToLayoutObjects(svg(`width="${w}mm" height="${h}mm" viewBox="0 0 ${w} ${h}"`, body), { page: BIG, into: { x: 0, y: 0, w, h }, ...extra });

/** the leaf objects, groups flattened */
function objects(nodes: PMNode[]): PMNode[] {
  const out: PMNode[] = [];
  const walk = (n: PMNode) => { if (n.type.name === 'ol_group') n.forEach(walk); else out.push(n); };
  nodes.forEach(walk);
  return out;
}
/** a shape's points in page mm (its path is in its own box, vb "0 0 w h") */
function points(n: PMNode): [number, number][] {
  const out: [number, number][] = [];
  for (const s of normalizePath(String(n.attrs.d))) if (s.c !== 'Z') for (let i = 0; i < s.p.length; i += 2) out.push([s.p[i] + n.attrs.x, s.p[i + 1] + n.attrs.y]);
  return out;
}
const box = (n: PMNode) => [n.attrs.x, n.attrs.y, n.attrs.w, n.attrs.h].map((v: number) => Math.round(v * 1000) / 1000);
const subpaths = (n: PMNode) => (String(n.attrs.d).match(/M/g) ?? []).length;

function write(nodes: PMNode[]): string {
  const lyx = parseTex(layoutTemplate('slides169', { title: 'T' }).text, texOpts).doc;
  const doc = schema.nodes.doc.create(null, [schema.nodes.ol_page.create({}, nodes)]);
  return writeTex({ ...lyx, body: pmToLyxBody(doc) }, texOpts).text;
}
function countObjects(tex: string): number {
  const pm = lyxToPmNode(parseTex(tex, texOpts).doc);
  let n = 0;
  pm.descendants(c => { if (c.type.spec.group === 'ol_object' && c.type.name !== 'ol_group') n++; return c.type.name === 'ol_page' || c.type.name === 'ol_group' || c.type.name === 'doc'; });
  return n;
}
/** valid in the schema, written with \olshape / olbox, read back to as many objects */
function roundTrips(nodes: PMNode[]): void {
  for (const n of nodes) expect(() => n.check()).not.toThrow();
  const tex = write(nodes);
  if (objects(nodes).some(n => n.type.name === 'ol_shape')) expect(tex).toContain('\\olshape{');
  expect(countObjects(tex)).toBe(objects(nodes).length);
}

describe('basic shapes', () => {
  // 200 × 100 mm drawn in 400 × 200 user units: 1 unit = 0.5 mm
  const draw = (body: string) => svgToLayoutObjects(svg('width="200mm" height="100mm" viewBox="0 0 400 200"', body), { page: BIG, into: { x: 0, y: 0, w: 200, h: 100 } });

  it('rect, rounded rect, circle, ellipse: boxes in mm, closed paths, filled black by default', () => {
    const { nodes, warnings } = draw('<rect x="20" y="10" width="40" height="20"/><rect x="100" y="10" width="80" height="40" rx="10" fill="#ffcc00"/>'
      + '<circle cx="250" cy="50" r="20" fill="red"/><ellipse cx="300" cy="150" rx="60" ry="20" fill="blue"/>');
    expect(warnings).toEqual([]);
    expect(nodes.length).toBe(1);
    expect(nodes[0].type.name).toBe('ol_group');
    const [rect, round, circle, ellipse] = objects(nodes);
    expect(objects(nodes).map(n => n.type.name)).toEqual(['ol_shape', 'ol_shape', 'ol_shape', 'ol_shape']);
    expect(box(rect)).toEqual([10, 5, 20, 10]);
    expect(rect.attrs).toMatchObject({ fill: 'black', stroke: null, rot: 0, vb: '0 0 20 10' });
    expect(String(rect.attrs.d)).toMatch(/^M 0 0 L 20 0 L 20 10 L 0 10 Z$/);
    expect(box(round)).toEqual([50, 5, 40, 20]);
    expect(round.attrs.fill).toBe('[HTML]FFCC00');
    expect((String(round.attrs.d).match(/C/g) ?? []).length).toBe(4);
    expect(points(round)[0]).toEqual([55, 5]);   // the corner radius: 10 units = 5 mm
    expect(box(circle)).toEqual([115, 15, 20, 20]);
    expect(circle.attrs.fill).toBe('red');
    expect(box(ellipse)).toEqual([120, 65, 60, 20]);
    expect(ellipse.attrs.fill).toBe('blue');
    roundTrips(nodes);
  });

  it('line, polyline, polygon: open and closed paths, a line is never filled', () => {
    const { nodes } = draw('<line x1="0" y1="0" x2="200" y2="100" stroke="black" stroke-width="2"/>'
      + '<polyline points="0,200 100,100 200,200" fill="none" stroke="#00ff00"/><polygon points="300,0 400,0 350,100" fill="#ccc"/>');
    const [line, poly, gon] = objects(nodes);
    expect(box(line)).toEqual([0, 0, 100, 50]);
    expect(points(line)).toEqual([[0, 0], [100, 50]]);
    expect(line.attrs).toMatchObject({ fill: null, stroke: 'black' });
    expect(line.attrs.lw).toBeCloseTo(2 * 0.5 * 72.27 / 25.4, 2);   // 2 units = 1 mm = 2.85 pt
    expect(points(poly)).toEqual([[0, 100], [50, 50], [100, 100]]);
    expect(String(poly.attrs.d)).not.toContain('Z');
    expect(poly.attrs).toMatchObject({ fill: null, stroke: 'green' });
    expect(points(gon)).toEqual([[150, 0], [200, 0], [175, 50]]);
    expect(String(gon.attrs.d)).toMatch(/Z$/);
    expect(gon.attrs).toMatchObject({ fill: '[HTML]CCCCCC', stroke: null });
    roundTrips(nodes);
  });

  it('a single object is returned on its own; degenerate geometry is dropped', () => {
    const one = draw('<rect width="0" height="10"/><circle r="0"/><path d="M 10 10"/><path d="L 5 5 L 10 10"/><polygon points="1"/><rect x="2" y="2" width="4" height="4" fill="none"/>'
      + '<line x1="3" y1="3" x2="3" y2="3" stroke="black"/><path d="M 0 5 L 10 5 L 20 5 Z" fill="red"/><rect x="10" y="10" width="20" height="20"/>');
    expect(one.nodes.length).toBe(1);
    expect(one.nodes[0].type.name).toBe('ol_shape');
    expect(box(one.nodes[0])).toEqual([5, 5, 10, 10]);
  });

  it('path data: relative commands, H / V, arcs, compact arc flags and exponents', () => {
    const { nodes } = draw('<path d="m10 10 h 100 v 50 H 10 z" fill="red"/><path d="M200 100a50 50 0 1010 0" fill="none" stroke="blue"/><path d="M1E2,1.5e2 L+300 150" stroke="#000"/>');
    const [rel, arc, exp] = objects(nodes);
    expect(box(rel)).toEqual([5, 5, 50, 25]);
    expect(arc.attrs.stroke).toBe('blue');
    expect(String(arc.attrs.d)).toContain('C');
    expect(arc.attrs.h).toBeGreaterThan(20);   // the large arc: about a whole circle below and above
    expect(points(exp)).toEqual([[50, 75], [150, 75]]);
  });
});

describe('transforms', () => {
  it('nested groups (translate · rotate · scale) are applied to the points; stroke widths scale', () => {
    const { nodes } = mm(400, 200, '<g transform="translate(100 50)"><g transform="rotate(90)"><g transform="scale(2)"><line x1="0" y1="0" x2="10" y2="0" stroke="black" stroke-width="1"/></g></g></g>');
    const [line] = objects(nodes);
    expect(line.attrs.rot).toBe(0);
    const [a, b] = points(line);
    expect(a[0]).toBeCloseTo(100, 3); expect(a[1]).toBeCloseTo(50, 3);
    expect(b[0]).toBeCloseTo(100, 3); expect(b[1]).toBeCloseTo(70, 3);
    expect(line.attrs.lw).toBeCloseTo(2 * 72.27 / 25.4, 2);   // 1 unit × scale 2 = 2 mm
  });

  it('matrix, rotate about a centre, skewX, transform lists; an invalid transform is ignored', () => {
    const { nodes } = mm(400, 200, '<rect x="0" y="0" width="10" height="10" transform="matrix(1 0 0 1 300 100)"/>'
      + '<line x1="60" y1="50" x2="70" y2="50" transform="rotate(90 50 50)" stroke="red"/>'
      + '<line x1="0" y1="10" x2="0" y2="20" transform="translate(150 0) skewX(45)" stroke="blue"/>'
      + '<line x1="0" y1="0" x2="10" y2="0" transform="translate(10,10),scale(3 1)" stroke="green"/>'
      + '<line x1="200" y1="150" x2="250" y2="150" transform="rotate(oops)" stroke="#ff8800"/>');
    const [rect, rot, skew, list, bad] = objects(nodes);
    expect(box(rect)).toEqual([300, 100, 10, 10]);
    const close = (p: [number, number][], q: [number, number][]) => p.forEach((v, i) => { expect(v[0]).toBeCloseTo(q[i][0], 3); expect(v[1]).toBeCloseTo(q[i][1], 3); });
    close(points(rot), [[50, 60], [50, 70]]);
    close(points(skew), [[160, 10], [170, 20]]);
    close(points(list), [[10, 10], [40, 10]]);
    close(points(bad), [[200, 150], [250, 150]]);
  });

  it('use of a defs path with its x / y offset (href and xlink:href), symbols and nested viewports', () => {
    const { nodes } = mm(400, 200, '<defs><path id="tri" d="M0 0 L10 0 L5 10Z"/><symbol id="sq" viewBox="0 0 10 10"><rect width="10" height="10"/></symbol></defs>'
      + '<use href="#tri" x="20" y="30" fill="red"/><use xlink:href="#tri" x="50" y="30" transform="scale(2)" fill="blue" id="big"/>'
      + '<use href="#sq" x="100" y="150" width="20" height="20" fill="green"/>'
      + '<svg x="200" y="0" width="100" height="100" viewBox="0 0 10 10"><circle cx="5" cy="5" r="5" fill="#123456"/></svg>');
    const [a, b, sym, nested] = objects(nodes);
    expect(box(a)).toEqual([20, 30, 10, 10]);
    expect(a.attrs).toMatchObject({ fill: 'red', name: null });
    expect(box(b)).toEqual([100, 60, 20, 20]);
    expect(b.attrs).toMatchObject({ fill: 'blue', name: 'big' });
    expect(box(sym)).toEqual([100, 150, 20, 20]);
    expect(sym.attrs.fill).toBe('[HTML]008000');   // CSS's green, not xcolor's
    expect(box(nested)).toEqual([200, 0, 100, 100]);
    roundTrips(nodes);
  });

  it('a use that references itself ends', () => {
    const { nodes } = mm(100, 100, '<g id="loop"><rect width="10" height="10"/><use href="#loop" x="20"/></g>');
    expect(objects(nodes).length).toBeLessThan(5);
  });

  it('units: width / height in in, cm, pt, px; one side from the viewBox; no size at all', () => {
    const r1 = svgToLayoutObjects(svg('width="2in" height="1in"', '<rect width="96" height="48"/>'), { page: BIG, into: { x: 0, y: 0, w: 50.8, h: 25.4 } });
    expect(box(r1.nodes[0])).toEqual([0, 0, 25.4, 12.7]);
    const r2 = svgToLayoutObjects(svg('width="10cm" viewBox="0 0 50 25"', '<rect width="50" height="25"/>'), { page: BIG });
    expect(box(r2.nodes[0]).slice(2)).toEqual([100, 50]);
    const r3 = svgToLayoutObjects(svg('width="72pt" height="72pt"', '<rect width="96" height="96"/>'), { page: BIG });
    expect(box(r3.nodes[0]).slice(2)).toEqual([25.4, 25.4]);
    const r4 = svgToLayoutObjects(svg('', '<rect x="10" y="10" width="96" height="96"/>'), { page: BIG });
    expect(box(r4.nodes[0]).slice(2)).toEqual([25.4, 25.4]);
  });
});

describe('styles', () => {
  it('specificity: style attribute > CSS rules (id > class > element) > presentation attributes; !important wins', () => {
    const { nodes } = mm(400, 100, '<style><![CDATA[ .c{fill:#ff0000} rect{fill:#00ff00} #r3{fill:#0000ff} g.k > rect{stroke:#ff00ff;stroke-width:2} .d{fill:yellow !important} @media print{rect{fill:black}} ]]></style>'
      + '<rect id="r1" class="c" fill="#123456" x="0" width="40" height="40"/><rect id="r2" class="c" style="fill:#abcdef" x="50" width="40" height="40"/>'
      + '<rect id="r4" fill="#123456" x="100" width="40" height="40"/><rect id="r3" class="c" x="150" width="40" height="40"/>'
      + '<g class="k"><rect id="r5" x="200" width="40" height="40"/></g><circle id="c1" fill="#123456" cx="270" cy="20" r="20"/>'
      + '<rect id="r6" class="c d" style="fill:#abcdef" x="300" width="40" height="40"/>');
    const byName = Object.fromEntries(objects(nodes).map(n => [n.attrs.name, n.attrs]));
    expect(byName.r1.fill).toBe('red');
    expect(byName.r2.fill).toBe('[HTML]ABCDEF');
    expect(byName.r4.fill).toBe('green');
    expect(byName.r3.fill).toBe('blue');
    expect(byName.r5).toMatchObject({ fill: 'green', stroke: 'magenta' });
    expect(byName.c1.fill).toBe('[HTML]123456');
    expect(byName.r6.fill).toBe('yellow');
  });

  it('inheritance: fill and stroke from groups, currentColor from color, colour syntaxes', () => {
    const { nodes } = mm(400, 100, '<g fill="#336699" stroke="black" stroke-width="2"><rect id="a" width="40" height="40"/><circle id="b" fill="white" cx="70" cy="20" r="20"/></g>'
      + '<g color="#ff8800"><rect id="c" x="100" width="40" height="40" fill="currentColor"/><g color="rgb(0, 128, 255)"><rect id="d" x="150" width="40" height="40" fill="currentColor"/></g></g>'
      + '<g style="fill:hsl(120, 100%, 25%)"><rect id="e" x="200" width="40" height="40"/></g><rect id="f" x="250" width="40" height="40" fill="#f80"/>'
      + '<rect id="g" x="300" width="40" height="40" fill="orange"/><rect id="h" x="350" width="40" height="40" fill="LightGrey"/>');
    const byName = Object.fromEntries(objects(nodes).map(n => [n.attrs.name, n.attrs]));
    expect(byName.a).toMatchObject({ fill: '[HTML]336699', stroke: 'black' });
    expect(byName.a.lw).toBeCloseTo(2 * 72.27 / 25.4, 2);
    expect(byName.b).toMatchObject({ fill: 'white', stroke: 'black' });
    expect(byName.c.fill).toBe('[HTML]FF8800');
    expect(byName.d.fill).toBe('[HTML]0080FF');
    expect(byName.e.fill).toBe('[HTML]008000');
    expect(byName.f.fill).toBe('[HTML]FF8800');
    expect(byName.g.fill).toBe('[HTML]FFA500');
    expect(byName.h.fill).toBe('[HTML]D3D3D3');
  });

  it('opacity multiplies down the tree; fill-opacity / stroke-opacity / rgba alpha count by what is painted', () => {
    const { nodes } = mm(400, 100, '<g opacity="0.5"><rect id="a" opacity="0.5" fill-opacity="0.8" width="40" height="40"/></g>'
      + '<line id="b" x1="50" y1="0" x2="90" y2="40" stroke="black" stroke-opacity="0.4" opacity="0.5"/>'
      + '<rect id="c" x="100" width="40" height="40" fill="red" fill-opacity="0.3" stroke="blue" stroke-opacity="0.6"/>'
      + '<rect id="d" x="150" width="40" height="40" fill="rgba(255,0,0,0.5)"/><rect id="e" x="200" width="40" height="40" style="opacity:50%"/>'
      + '<rect id="f" x="250" width="40" height="40" fill="#ff000080"/><rect id="g" x="300" width="40" height="40" opacity="0"/>');
    const byName = Object.fromEntries(objects(nodes).map(n => [n.attrs.name, n.attrs]));
    expect(byName.a.opacity).toBeCloseTo(0.2, 3);
    expect(byName.b.opacity).toBeCloseTo(0.2, 3);
    expect(byName.c.opacity).toBeCloseTo(0.6, 3);
    expect(byName.d).toMatchObject({ fill: 'red', opacity: 0.5 });
    expect(byName.e.opacity).toBeCloseTo(0.5, 3);
    expect(byName.f.opacity).toBeCloseTo(0.502, 3);
    expect(byName.g).toBeUndefined();
    expect(objects(nodes).find(n => n.attrs.name === null)).toBeUndefined();
  });

  it('display:none and visibility:hidden are not drawn (a visible child of a hidden group is)', () => {
    const { nodes } = mm(400, 100, '<rect display="none" width="10" height="10"/><g style="display:none"><rect width="10" height="10"/></g><rect visibility="hidden" width="10" height="10"/>'
      + '<g visibility="hidden"><rect id="shown" visibility="visible" x="50" width="10" height="10"/><rect x="80" width="10" height="10"/></g>');
    expect(nodes.length).toBe(1);
    expect(nodes[0].attrs.name).toBe('shown');
  });

  it('stroke-dasharray → the nearest TikZ dash pattern', () => {
    // 1 user unit = 1 px = 0.75 pt, lines 1 px wide
    const arrays = ['4,4', '4 2', '4,8', '1,3', '1,1', '1,6', '8,3,1,3', 'none', '0'];
    const body = arrays.map((a, i) => `<line id="l${i}" x1="0" y1="${i * 20}" x2="300" y2="${i * 20}" stroke="black" stroke-dasharray="${a}"/>`).join('');
    const { nodes } = svgToLayoutObjects(svg('width="400" height="200"', body), { page: BIG });
    expect(objects(nodes).map(n => n.attrs.dash)).toEqual(['dashed', 'densely dashed', 'loosely dashed', 'dotted', 'densely dotted', 'loosely dotted', 'dashdotted', null, null]);
    roundTrips(nodes);
  });

  it('markers → arrow tips (marker-start, marker-end, both, the marker shorthand); none for missing markers or closed paths', () => {
    const { nodes } = mm(400, 200, '<defs><marker id="a" markerWidth="10" markerHeight="10" refX="5" refY="5" orient="auto"><path d="M0,0 L10,5 L0,10 z"/></marker></defs>'
      + '<style>.both{marker:url(#a)}</style>'
      + '<line id="e" x1="10" y1="10" x2="200" y2="10" stroke="black" marker-end="url(#a)"/><line id="s" x1="10" y1="40" x2="200" y2="40" stroke="black" marker-start="url(#a)"/>'
      + '<path id="b" d="M10 70 L 200 70" stroke="black" style="marker-start:url(#a);marker-end:url( \'#a\' )"/><path id="c" class="both" d="M10 100 L 200 100" stroke="black"/>'
      + '<line id="m" x1="10" y1="130" x2="200" y2="130" stroke="black" marker-end="url(#missing)"/><polygon id="z" points="10,150 200,150 100,190" fill="none" stroke="black" marker-end="url(#a)"/>');
    const byName = Object.fromEntries(objects(nodes).map(n => [n.attrs.name, n.attrs.arrows]));
    expect(byName).toEqual({ e: '-Stealth', s: 'Stealth-', b: 'Stealth-Stealth', c: 'Stealth-Stealth', m: null, z: null });
    roundTrips(nodes);
  });

  it('gradients → their first stop with a warning; patterns, images, HTML, masks and filters are reported', () => {
    const r = mm(400, 100, '<defs><linearGradient id="g1"><stop offset="0" stop-color="#3366cc"/><stop offset="1" stop-color="white"/></linearGradient><linearGradient id="g2" xlink:href="#g1"/>'
      + '<pattern id="p" width="4" height="4"><rect width="2" height="2"/></pattern><filter id="blur"><feGaussianBlur stdDeviation="2"/></filter><mask id="mk"><rect width="10" height="10" fill="white"/></mask></defs>'
      + '<rect id="a" width="40" height="40" fill="url(#g2)"/><rect id="b" x="50" width="40" height="40" fill="url(#p)" stroke="black"/><rect id="c" x="100" width="40" height="40" fill="url(#gone) #00ff00"/>'
      + '<rect id="d" x="150" width="40" height="40" filter="url(#blur)"/><rect id="e" x="200" width="40" height="40" mask="url(#mk)"/>'
      + '<image href="data:image/png;base64,iVBORw0KGgo=" x="250" width="40" height="40"/><foreignObject x="300" width="40" height="40"><div xmlns="http://www.w3.org/1999/xhtml">HTML</div></foreignObject>');
    const byName = Object.fromEntries(objects(r.nodes).map(n => [n.attrs.name, n.attrs]));
    expect(byName.a.fill).toBe('[HTML]3366CC');
    expect(byName.b).toMatchObject({ fill: null, stroke: 'black' });
    expect(byName.c.fill).toBe('green');
    expect(byName.d.fill).toBe('black');
    expect(byName.e.fill).toBe('black');
    expect(objects(r.nodes).length).toBe(5);
    for (const re of [/[Gg]radient/, /[Pp]attern/, /<image>/, /<foreignObject>/, /[Mm]ask/, /[Ff]ilter/]) expect(r.warnings.some(w => re.test(w))).toBe(true);
  });
});

describe('text', () => {
  it('text → a text box: the text, a pt font size, the colour, the anchor as alignment, bold runs', () => {
    const { nodes } = mm(200, 100, '<text x="100" y="50" font-size="20" text-anchor="middle" fill="#ff0000">Hello <tspan font-weight="bold">world</tspan> &amp; 50%</text>');
    expect(nodes.length).toBe(1);
    const b = nodes[0];
    expect(b.type.name).toBe('ol_box');
    expect(b.textContent).toBe('Hello world & 50%');
    expect(b.childCount).toBe(1);
    expect(b.attrs).toMatchObject({ color: 'red', align: 'center', rot: 0, grow: true });
    expect(b.attrs.font).toBeCloseTo(20 * 72.27 / 25.4, 1);   // 20 units = 20 mm
    expect(b.attrs.x + b.attrs.w / 2).toBeCloseTo(100, 2);
    expect(b.attrs.y).toBeCloseTo(50 - 0.8 * 20, 2);   // the top about 0.8 font sizes above the baseline
    const bold: string[] = [];
    b.descendants(n => { if (n.isText && n.marks.some(m => m.type.name === 'series' && m.attrs.value === 'bold')) bold.push(n.text!); return true; });
    expect(bold).toEqual(['world']);
    roundTrips(nodes);
  });

  it('anchors start / end, font sizes in px / pt / em through the scale, rotated text, multi-line tspans', () => {
    const { nodes } = svgToLayoutObjects(svg('width="400" height="300"', '<g font-size="12px"><text x="10" y="20">start</text><text x="300" y="20" text-anchor="end" font-size="2em">end</text>'
      + '<text x="50" y="250" transform="rotate(-90 50 250)" style="font-size:9pt;font-style:italic">Up</text>'
      + '<text x="200" y="100"><tspan x="200" y="100">one</tspan><tspan x="200" dy="1.5em">two</tspan></text></g>'), { page: BIG });
    const [start, end, up, multi] = objects(nodes);
    const PX = 72.27 / 96;   // TeX points per px
    expect(start.attrs.font).toBeCloseTo(12 * PX, 2);   // 12 px = 9 bp = 9.03 pt
    expect(start.attrs.align).toBe('left');
    expect(end.attrs.font).toBeCloseTo(24 * PX, 2);
    expect(end.attrs.align).toBe('right');
    expect(end.attrs.x + end.attrs.w).toBeCloseTo(start.attrs.x + 290 * 25.4 / 96, 2);
    expect(up.attrs.rot).toBe(90);
    expect(up.attrs.font).toBeCloseTo(9 * 72.27 / 72, 2);   // CSS's pt is TeX's bp
    let italic = false;
    up.descendants(n => { if (n.marks.some(m => m.type.name === 'shape' && m.attrs.value === 'italic')) italic = true; return true; });
    expect(italic).toBe(true);
    expect(multi.childCount).toBe(2);
    expect([multi.child(0).textContent, multi.child(1).textContent]).toEqual(['one', 'two']);
    expect(multi.attrs.leading).toBe(1.5);
    roundTrips(nodes);
    expect(write(nodes)).toMatch(/\none\n\ntwo\n/);   // two paragraphs in the file too
  });

  it('draw.io labels: the plain-text alternative of a switch, not its HTML', () => {
    const { nodes, warnings } = mm(200, 100, '<g><rect x="10" y="10" width="80" height="40" fill="#dae8fc" stroke="#6c8ebf"/><g transform="translate(-0.5 -0.5)"><switch>'
      + '<foreignObject pointer-events="none" width="100%" height="100%" requiredFeatures="http://www.w3.org/TR/SVG11/feature#Extensibility" style="overflow: visible; text-align: left;"><div xmlns="http://www.w3.org/1999/xhtml">Label</div></foreignObject>'
      + '<text x="50" y="34" fill="rgb(0, 0, 0)" font-family="Helvetica" font-size="12px" text-anchor="middle">Label</text></switch></g></g>');
    const [shape, label] = objects(nodes);
    expect(shape.attrs).toMatchObject({ fill: '[HTML]DAE8FC', stroke: '[HTML]6C8EBF' });
    expect(label.type.name).toBe('ol_box');
    expect(label.textContent).toBe('Label');
    expect(warnings).toEqual([]);
  });
});

describe('many small paths', () => {
  it('consecutive small shapes of one style merge into one compound path; other styles and text break the run', () => {
    const dots = Array.from({ length: 200 }, (_, i) => `<circle cx="${10 + (i % 20) * 19}" cy="${10 + Math.floor(i / 20) * 19}" r="2" fill="#1f77b4"/>`).join('');
    const squares = Array.from({ length: 100 }, (_, i) => `<rect x="${i * 4}" y="380" width="2" height="2" fill="#ff7f0e"/>`).join('');
    const { nodes } = svgToLayoutObjects(svg('width="400" height="400"', dots + squares + '<text x="0" y="398" font-size="8">n = 300</text>' + squares), { page: PAGE });
    const objs = objects(nodes);
    expect(objs.map(n => n.type.name)).toEqual(['ol_shape', 'ol_shape', 'ol_box', 'ol_shape']);
    expect(subpaths(objs[0])).toBe(200);
    expect(subpaths(objs[1])).toBe(100);
    expect(objs[0].attrs.name).toBeNull();
    roundTrips(nodes);
  });

  it('large shapes of one style stay separate objects (a diagram\'s boxes)', () => {
    const { nodes } = mm(200, 100, '<rect x="10" y="10" width="50" height="30"/><rect x="80" y="10" width="50" height="30"/>');
    expect(objects(nodes).length).toBe(2);
  });

  it('at most 1500 objects, with a warning', () => {
    const body = Array.from({ length: 2000 }, (_, i) => `<rect x="${(i % 50) * 8}" y="${Math.floor(i / 50) * 8}" width="4" height="4" fill="${i % 2 ? 'red' : 'blue'}"/>`).join('');
    const { nodes, warnings } = svgToLayoutObjects(svg('width="400" height="400"', body), { page: PAGE });
    expect(objects(nodes).length).toBe(1500);
    expect(warnings.some(w => /1500/.test(w))).toBe(true);
  });
});

describe('placing the drawing', () => {
  const wide = svg('width="400mm" height="200mm" viewBox="0 0 400 200"', '<rect width="400" height="200" fill="#ddd"/>');

  it('scaled down into 80 % of the page and centred; stroke widths scale with it', () => {
    const { nodes } = svgToLayoutObjects(svg('width="400mm" height="200mm" viewBox="0 0 400 200"', '<rect width="400" height="200" fill="#ddd" stroke="black" stroke-width="2"/>'), { page: PAGE });
    expect(box(nodes[0])).toEqual([16, 13, 128, 64]);
    expect(nodes[0].attrs.lw).toBeCloseTo(2 * 0.32 * 72.27 / 25.4, 2);
  });

  it('at a given top-left corner', () => {
    expect(box(svgToLayoutObjects(wide, { page: PAGE, at: [5, 5] }).nodes[0])).toEqual([5, 5, 128, 64]);
  });

  it('never scaled up: a small drawing keeps its size, centred', () => {
    const { nodes } = svgToLayoutObjects(svg('width="20mm" height="10mm" viewBox="0 0 20 10"', '<rect width="20" height="10"/>'), { page: PAGE });
    expect(box(nodes[0])).toEqual([70, 40, 20, 10]);
  });

  it('into a box: the whole viewport fills it, keeping the aspect ratio, centred', () => {
    expect(box(svgToLayoutObjects(wide, { page: PAGE, into: { x: 10, y: 10, w: 50, h: 50 } }).nodes[0])).toEqual([10, 22.5, 50, 25]);
    // content in a corner of the viewport stays in that corner of the box
    const corner = svgToLayoutObjects(svg('width="100mm" height="100mm" viewBox="0 0 100 100"', '<rect x="50" y="50" width="50" height="50"/>'), { page: PAGE, into: { x: 0, y: 0, w: 10, h: 10 } });
    expect(box(corner.nodes[0])).toEqual([5, 5, 5, 5]);
  });

  it('preserveAspectRatio of the root viewBox', () => {
    const r = (par: string) => box(svgToLayoutObjects(svg(`width="200mm" height="100mm" viewBox="0 0 100 100" preserveAspectRatio="${par}"`, '<rect width="100" height="100"/>'), { page: BIG, into: { x: 0, y: 0, w: 200, h: 100 } }).nodes[0]);
    expect(r('xMidYMid meet')).toEqual([50, 0, 100, 100]);
    expect(r('xMinYMin meet')).toEqual([0, 0, 100, 100]);
    expect(r('none')).toEqual([0, 0, 200, 100]);
  });
});

const INKSCAPE = `<?xml version="1.0" encoding="UTF-8" standalone="no"?>
<!-- Created with Inkscape (http://www.inkscape.org/) -->
<svg
   width="120mm"
   height="80mm"
   viewBox="0 0 120 80"
   version="1.1"
   id="svg5"
   inkscape:version="1.2.2 (b0a8486541, 2022-12-01)"
   sodipodi:docname="diagram.svg"
   xmlns:inkscape="http://www.inkscape.org/namespaces/inkscape"
   xmlns:sodipodi="http://sodipodi.sourceforge.net/DTD/sodipodi-0.dtd"
   xmlns:xlink="http://www.w3.org/1999/xlink"
   xmlns="http://www.w3.org/2000/svg"
   xmlns:svg="http://www.w3.org/2000/svg"
   xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#"
   xmlns:cc="http://creativecommons.org/ns#"
   xmlns:dc="http://purl.org/dc/elements/1.1/">
  <sodipodi:namedview
     id="namedview7"
     pagecolor="#ffffff"
     bordercolor="#666666"
     borderopacity="1.0"
     inkscape:showpageshadow="2"
     inkscape:pageopacity="0.0"
     inkscape:document-units="mm"
     showgrid="false"
     inkscape:zoom="1.2"
     inkscape:cx="226"
     inkscape:cy="151"
     inkscape:current-layer="layer1" />
  <defs
     id="defs2">
    <linearGradient
       inkscape:collect="always"
       id="linearGradient1">
      <stop
         style="stop-color:#ffcc00;stop-opacity:1"
         offset="0"
         id="stop1" />
      <stop
         style="stop-color:#ff6600;stop-opacity:1"
         offset="1"
         id="stop2" />
    </linearGradient>
    <linearGradient
       inkscape:collect="always"
       xlink:href="#linearGradient1"
       id="linearGradient2"
       x1="80"
       y1="30"
       x2="110"
       y2="30"
       gradientUnits="userSpaceOnUse" />
    <marker
       style="overflow:visible"
       id="Arrow2"
       refX="0"
       refY="0"
       orient="auto-start-reverse"
       inkscape:stockid="Arrow2"
       markerWidth="7.7"
       markerHeight="5.6"
       viewBox="0 0 7.7 5.6"
       inkscape:isstock="true"
       inkscape:collect="always"
       preserveAspectRatio="xMidYMid">
      <path
         transform="scale(0.7)"
         d="M -2,-4 9,0 -2,4 c 2,-2.33 2,-5.66 0,-8 z"
         style="fill:context-stroke;fill-rule:evenodd;stroke:none"
         id="arrow2L" />
    </marker>
  </defs>
  <metadata
     id="metadata5">
    <rdf:RDF>
      <cc:Work
         rdf:about="">
        <dc:format>image/svg+xml</dc:format>
        <dc:type
           rdf:resource="http://purl.org/dc/dcmitype/StillImage" />
      </cc:Work>
    </rdf:RDF>
  </metadata>
  <g
     inkscape:label="Layer 1"
     inkscape:groupmode="layer"
     id="layer1"
     transform="translate(-5,-10)">
    <rect
       style="fill:#dce9f7;fill-opacity:1;stroke:#1f4e79;stroke-width:0.5;stroke-dasharray:none;stroke-opacity:1"
       id="rect1"
       width="40"
       height="25"
       x="15"
       y="20"
       ry="3"
       inkscape:label="Input box" />
    <ellipse
       style="fill:url(#linearGradient2);fill-opacity:1;stroke:none"
       id="path2"
       cx="95"
       cy="32.5"
       rx="15"
       ry="12.5" />
    <path
       style="fill:none;stroke:#000000;stroke-width:0.6;stroke-dasharray:1.8, 0.6;stroke-dashoffset:0;marker-end:url(#Arrow2)"
       d="m 55,32.5 h 22"
       id="path3"
       sodipodi:nodetypes="cc" />
    <path
       style="fill:#e6e6e6;stroke:#333333;stroke-width:0.4"
       d="m 20,60 a 10,10 0 0 1 10,-10 h 60 a 10,10 0 0 1 10,10 v 5 H 20 Z"
       id="path4" />
    <text
       xml:space="preserve"
       style="font-size:5.64444px;line-height:1.25;font-family:sans-serif;text-align:center;text-anchor:middle;fill:#1f4e79;stroke:none;stroke-width:0.264583"
       x="35"
       y="34.5"
       id="text1"><tspan
         sodipodi:role="line"
         id="tspan1"
         style="font-weight:bold;stroke-width:0.264583"
         x="35"
         y="34.5">Input</tspan><tspan
         sodipodi:role="line"
         style="stroke-width:0.264583"
         x="35"
         y="41.555"
         id="tspan2">data</tspan></text>
  </g>
</svg>
`;

describe('real-world files', () => {
  it('an Inkscape drawing: layers, labels, gradients, markers, arcs, multi-line text', () => {
    const r = svgToLayoutObjects(INKSCAPE, { page: PAGE, into: { x: 0, y: 0, w: 120, h: 80 } });
    const objs = objects(r.nodes);
    expect(objs.map(n => n.type.name)).toEqual(['ol_shape', 'ol_shape', 'ol_shape', 'ol_shape', 'ol_box']);
    const [rect, ellipse, arrow, pill, text] = objs;
    expect(rect.attrs).toMatchObject({ name: 'Input box', fill: '[HTML]DCE9F7', stroke: '[HTML]1F4E79', dash: null });
    expect(box(rect)).toEqual([10, 10, 40, 25]);
    expect(rect.attrs.lw).toBeCloseTo(0.5 * 72.27 / 25.4, 2);
    expect(ellipse.attrs).toMatchObject({ name: 'path2', fill: '[HTML]FFCC00' });
    expect(box(ellipse)).toEqual([75, 10, 30, 25]);
    expect(arrow.attrs).toMatchObject({ arrows: '-Stealth', dash: 'densely dashed', fill: null, stroke: 'black' });
    expect(points(arrow).map(p => p.map(v => Math.round(v * 1000) / 1000))).toEqual([[50, 22.5], [72, 22.5]]);
    expect(box(pill)).toEqual([15, 40, 80, 15]);
    expect(text.attrs).toMatchObject({ name: 'text1', color: '[HTML]1F4E79', align: 'center', leading: 1.25 });
    expect([text.child(0).textContent, text.child(1).textContent]).toEqual(['Input', 'data']);
    expect(text.attrs.x + text.attrs.w / 2).toBeCloseTo(30, 2);
    expect(r.warnings).toEqual(['Gradients were replaced by the colour of their first stop.']);
    roundTrips(r.nodes);
  });

  it('a matplotlib figure: glyphs and markers drawn with use, clip paths, the font shorthand; markers merge', () => {
    const marker = 'M 0 3 C 0.795609 3 1.55874 2.683901 2.12132 2.12132 C 2.683901 1.55874 3 0.795609 3 0 C 3 -0.795609 2.683901 -1.55874 2.12132 -2.12132 C 1.55874 -2.683901 0.795609 -3 0 -3 C -0.795609 -3 -1.55874 -2.683901 -2.12132 -2.12132 C -2.683901 -1.55874 -3 -0.795609 -3 0 C -3 0.795609 -2.683901 1.55874 -2.12132 2.12132 C -1.55874 2.683901 -0.795609 3 0 3 z';
    const uses = Array.from({ length: 50 }, (_, i) => `     <use xlink:href="#m0a1b2c3d4e" x="${(80 + i * 6.5).toFixed(6)}" y="${(290 - i * 4.7).toFixed(6)}" style="fill: #1f77b4; stroke: #1f77b4"/>`).join('\n');
    const tick = (n: number, x: number, glyph: string, d: string) => `    <g id="xtick_${n}">
     <g id="line2d_${n}">${n === 1 ? `
      <defs>
       <path id="m5f8c2e1b9a" d="M 0 0 L 0 3.5" style="stroke: #000000; stroke-width: 0.8"/>
      </defs>` : ''}
      <g>
       <use xlink:href="#m5f8c2e1b9a" x="${x}" y="307.584" style="stroke: #000000; stroke-width: 0.8"/>
      </g>
     </g>
     <g id="text_${n}">
      <!-- ${n - 1} -->
      <g transform="translate(${x - 3.18125} 322.182437) scale(0.1 -0.1)">
       <defs>
        <path id="${glyph}" d="${d}" transform="scale(0.015625)"/>
       </defs>
       <use xlink:href="#${glyph}"/>
      </g>
     </g>
    </g>`;
    const MPL = `<?xml version="1.0" encoding="utf-8" standalone="no"?>
<!DOCTYPE svg PUBLIC "-//W3C//DTD SVG 1.1//EN"
  "http://www.w3.org/Graphics/SVG/1.1/DTD/svg11.dtd">
<svg xmlns:xlink="http://www.w3.org/1999/xlink" width="460.8pt" height="345.6pt" viewBox="0 0 460.8 345.6" xmlns="http://www.w3.org/2000/svg" version="1.1">
 <metadata>
  <rdf:RDF xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:cc="http://creativecommons.org/ns#" xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#">
   <cc:Work>
    <dc:type rdf:resource="http://purl.org/dc/dcmitype/StillImage"/>
    <dc:date>2024-05-01T12:00:00.000000</dc:date>
    <dc:format>image/svg+xml</dc:format>
    <dc:creator>
     <cc:Agent>
      <dc:title>Matplotlib v3.8.4, https://matplotlib.org/</dc:title>
     </cc:Agent>
    </dc:creator>
   </cc:Work>
  </rdf:RDF>
 </metadata>
 <defs>
  <style type="text/css">*{stroke-linejoin: round; stroke-linecap: butt}</style>
 </defs>
 <g id="figure_1">
  <g id="patch_1">
   <path d="M 0 345.6 L 460.8 345.6 L 460.8 0 L 0 0 z" style="fill: #ffffff"/>
  </g>
  <g id="axes_1">
   <g id="patch_2">
    <path d="M 57.6 307.584 L 414.72 307.584 L 414.72 41.472 L 57.6 41.472 z" style="fill: #ffffff"/>
   </g>
   <g id="PathCollection_1">
    <defs>
     <path id="m0a1b2c3d4e" d="${marker}" style="stroke: #1f77b4"/>
    </defs>
    <g clip-path="url(#p1234567890)">
${uses}
    </g>
   </g>
   <g id="matplotlib.axis_1">
${tick(1, 73.832727, 'DejaVuSans-30', 'M 2034 4250 Q 1547 4250 1301 3770 Q 1056 3291 1056 2328 Q 1056 1369 1301 889 Q 1547 409 2034 409 Q 2525 409 2770 889 Q 3016 1369 3016 2328 Q 3016 3291 2770 3770 Q 2525 4250 2034 4250 z M 2034 4750 Q 2819 4750 3233 4129 Q 3647 3509 3647 2328 Q 3647 1150 3233 529 Q 2819 -91 2034 -91 Q 1250 -91 836 529 Q 422 1150 422 2328 Q 422 3509 836 4129 Q 1250 4750 2034 4750 z')}
${tick(2, 236.16, 'DejaVuSans-31', 'M 794 531 L 1825 531 L 1825 4091 L 703 3866 L 703 4441 L 1819 4666 L 2450 4666 L 2450 531 L 3481 531 L 3481 0 L 794 0 L 794 531 z')}
   </g>
   <g id="line2d_3">
    <path d="M 73.832727 295.488 L 150 200 L 250 150 L 398.487273 53.568" clip-path="url(#p1234567890)" style="fill: none; stroke: #ff7f0e; stroke-width: 1.5; stroke-linecap: square"/>
   </g>
   <g id="patch_3">
    <path d="M 57.6 307.584 L 57.6 41.472" style="fill: none; stroke: #000000; stroke-width: 0.8; stroke-linejoin: miter; stroke-linecap: square"/>
   </g>
   <g id="text_3">
    <text style="font: 700 12px 'DejaVu Sans'; text-anchor: middle" x="236.16" y="35.472" transform="rotate(-0 236.16 35.472)">Measurements</text>
   </g>
  </g>
 </g>
 <defs>
  <clipPath id="p1234567890">
   <rect x="57.6" y="41.472" width="357.12" height="266.112"/>
  </clipPath>
 </defs>
</svg>
`;
    const r = svgToLayoutObjects(MPL, { page: PAGE });
    expect(r.warnings).toEqual([]);
    const objs = objects(r.nodes);
    expect(objs.length).toBeLessThan(15);
    const markers = objs.find(n => n.attrs.fill === '[HTML]1F77B4')!;
    expect(subpaths(markers)).toBe(50);
    expect(markers.attrs.stroke).toBe('[HTML]1F77B4');
    const line = objs.find(n => n.attrs.stroke === '[HTML]FF7F0E')!;
    expect(line.attrs.fill).toBeNull();
    const glyphs = objs.filter(n => n.type.name === 'ol_shape' && n.attrs.fill === 'black');
    expect(glyphs.length).toBe(2);   // "0" and "1"
    const ticks = objs.filter(n => n.attrs.stroke === 'black' && n.attrs.fill === null);
    expect(ticks.length).toBe(3);   // two ticks and the spine
    const title = objs.find(n => n.type.name === 'ol_box')!;
    expect(title.textContent).toBe('Measurements');
    // 460.8 × 345.6 bp = 162.56 × 121.92 mm, fitted into 80 % of the page's height: everything scales by 72 / 121.92
    const s = 72 / 121.92;
    expect(title.attrs.font).toBeCloseTo(12 * 72.27 / 72 * s, 1);
    expect(title.attrs.align).toBe('center');
    // the white figure background fills the fitted size, centred
    expect(box(objs[0])).toEqual([32, 9, 96, 72]);
    roundTrips(r.nodes);
  });

  it('warns when something sticks out of a clipping path', () => {
    const r = mm(100, 100, '<defs><clipPath id="c"><rect width="50" height="50"/></clipPath></defs><g clip-path="url(#c)"><rect x="10" y="10" width="20" height="20"/><rect x="40" y="40" width="20" height="20" fill="red"/></g>');
    expect(r.warnings.some(w => /[Cc]lipping/.test(w))).toBe(true);
  });
});

describe('malformed input', () => {
  it('never throws: no nodes and a warning', () => {
    for (const bad of ['', 'hello world', '<foo><bar/></foo>', '<svg xmlns="http://www.w3.org/2000/svg"><g><rect width="0" height="5"/></svg>',
      '<svg xmlns="http://www.w3.org/2000/svg"><path d="M 0 0 L"/><path d="Q 1 2 3"/><circle r="-3"/></svg>', '<svg><<<>>>', '<svg xmlns="http://www.w3.org/2000/svg"></svg>',
      '<svg xmlns="http://www.w3.org/2000/svg" width="-5" height="abc" viewBox="0 0 0 0"><style>{{{ .a{fill: rgb(}</style><rect class="a" width="NaN" height="1e999"/></svg>']) {
      let r: ReturnType<typeof svgToLayoutObjects> | undefined;
      expect(() => { r = svgToLayoutObjects(bad, { page: PAGE }); }, bad).not.toThrow();
      expect(r!.nodes, bad).toEqual([]);
      expect(r!.warnings.length, bad).toBeGreaterThan(0);
    }
  });

  it('markup that is not well-formed XML is read leniently, as browsers read SVG in web pages, with a warning', () => {
    const r = svgToLayoutObjects('<svg viewBox="0 0 10 10" width="10mm" height="10mm"><rect width="10" height="10" fill="red"></svg>', { page: PAGE });
    expect(r.nodes.length).toBe(1);
    expect(r.nodes[0].attrs.fill).toBe('red');
    expect(r.warnings.some(w => /well-formed/.test(w))).toBe(true);
  });
});
