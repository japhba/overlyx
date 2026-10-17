// @vitest-environment jsdom
import { afterEach, expect, it } from 'vitest';
import { svgCanvasSource, svgFileFromCanvas } from '../packages/client/src/deliverable/svgSource';
import { exportPageSvg } from '../packages/client/src/deliverable/runtime/svgexport';
import { strokeRuns, inkSvg } from '../packages/core/src/ink';
import { inkPaths, inkRuns } from '../packages/core/src/freehand';

afterEach(() => { document.body.innerHTML = ''; });

it('opens SVG artwork at its original size with root styles, gradients and an editable vector tree', () => {
  const html = svgCanvasSource('<svg xmlns="http://www.w3.org/2000/svg" width="1200" height="400" viewBox="20 30 600 200" class="art" style="fill:#123456" onload="alert(1)"><defs><linearGradient id="gradient"/></defs><path d="M20 30L80 80" stroke="url(#gradient)"/><script>alert(1)</script></svg>');
  const doc = new DOMParser().parseFromString(html, 'text/html');
  expect(doc.querySelector<HTMLElement>('.slide')?.style.width).toBe('1200px');
  expect(doc.querySelector<HTMLElement>('.slide')?.style.height).toBe('400px');
  expect(doc.querySelector('svg')?.getAttribute('class')).toBe('art');
  expect(doc.querySelector('svg')?.style.fill).toBe('rgb(18, 52, 86)');
  expect(doc.querySelector('svg')?.getAttribute('viewBox')).toBe('20 30 600 200');
  expect(doc.querySelector('path')?.getAttribute('stroke')).toBe('url(#gradient)');
  expect(html).not.toMatch(/<script|onload=/);
});

it('saves the page as SVG vectors with filters, paths and newly drawn shapes, excluding editor UI', () => {
  document.body.innerHTML = '<section class="slide" style="position:relative;width:800px;height:600px"><svg style="position:absolute;left:10px;top:20px;width:200px;height:100px" viewBox="0 0 200 100"><defs><filter id="shadow"><feGaussianBlur stdDeviation="2"/></filter></defs><path d="M0 0L100 100" filter="url(#shadow)" fill="red"/></svg><div style="position:absolute;left:40px;top:80px;width:100px;height:60px;background:blue;border-radius:4px"></div><ol-overlay data-ol-runtime>handles</ol-overlay></section>';
  const svg = exportPageSvg(document.querySelector('.slide'));
  const doc = new DOMParser().parseFromString(svg, 'image/svg+xml');
  expect(doc.querySelector('parsererror')).toBeNull();
  expect(doc.documentElement.getAttribute('width')).toBe('800');
  expect(doc.querySelector('path')?.getAttribute('d')).toBe('M0 0L100 100');
  expect(doc.querySelector('path')?.getAttribute('filter')).toBe('url(#shadow)');
  expect(doc.querySelector('filter')).not.toBeNull();
  expect(doc.querySelector('rect')?.getAttribute('fill')).toBe('rgb(0, 0, 255)');
  expect(svg).not.toContain('handles');
  expect(svg).not.toContain('ol-overlay');
});

it('document strokes and saved sidecars use exactly the layout pen geometry and nib settings', () => {
  const stroke = { color: '#123456', w: 4, nib: { ball: false, sharpness: 0.8, sensitivity: 0.6 }, pressure: true, pts: [[0, 0, 0.2], [20, 10, 0.8], [40, 5, 0.4]] as [number, number, number][] };
  const expected = inkPaths(inkRuns(stroke.pts, { width: stroke.w, pressure: true, nib: stroke.nib, final: true }));
  expect(strokeRuns(stroke)).toEqual(expected);
  const svg = inkSvg(JSON.stringify({ v: 1, strokes: [stroke] }));
  for (const run of expected) expect(svg).toContain(`d="${run.d}" stroke-width="${run.w}"`);
  expect(svg).toContain('stroke-linecap="round"');
});

const INKSCAPE_FILE = `<?xml version="1.0" encoding="UTF-8" standalone="no"?>
<!-- Created with Inkscape (http://www.inkscape.org/) -->
<svg width="540pt" height="300pt" viewBox="0 0 540 300" version="1.1" id="svg1" data-generated="abc" xmlns:inkscape="http://www.inkscape.org/namespaces/inkscape" xmlns:sodipodi="http://sodipodi.sourceforge.net/DTD/sodipodi-0.dtd" xmlns:textext="http://www.iki.fi/pav/software/textext/" xmlns:xlink="http://www.w3.org/1999/xlink" xmlns="http://www.w3.org/2000/svg" xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#" xmlns:cc="http://creativecommons.org/ns#" xmlns:dc="http://purl.org/dc/elements/1.1/">
  <sodipodi:namedview id="nv" pagecolor="#ffffff" inkscape:zoom="1.5" inkscape:current-layer="panel-A"/>
  <metadata id="m"><rdf:RDF><cc:Work rdf:about=""><dc:format>image/svg+xml</dc:format></cc:Work></rdf:RDF></metadata>
  <defs id="d"><clipPath id="clip" clipPathUnits="userSpaceOnUse"><rect width="10" height="10"/></clipPath><path id="glyph" d="M0 0h5v5z"/><inkscape:perspective sodipodi:type="inkscape:persp3d" id="p3"/></defs>
  <style>*{stroke-linejoin: round} g > text{font-weight: bold}</style>
  <g inkscape:groupmode="layer" inkscape:label="A: shared weights" id="panel-A" transform="translate(20,16)">
    <title>Panel A</title>
    <path d="M0 0L50 50" sodipodi:nodetypes="cc" clip-path="url(#clip)" id="arrow" style="fill:none;stroke:#000"/>
    <g textext:text="\\lambda &lt; 1" textext:scale="1.0" id="tex"><use xlink:href="#glyph" x="3" y="4"/></g>
    <text xml:space="preserve" x="5" y="9" id="label"><tspan id="ts">A  B</tspan></text>
  </g>
</svg>
`;

/** element and attribute names with their namespaces, attributes sorted: what the file means */
function canonical(xml: string): string {
  const doc = new DOMParser().parseFromString(xml, 'image/svg+xml');
  expect(doc.getElementsByTagName('parsererror').length).toBe(0);
  const walk = (n: Node): string => {
    if (n.nodeType === 3) return (n.nodeValue ?? '');
    if (n.nodeType !== 1) return '';
    const el = n as Element;
    const attrs = Array.from(el.attributes).filter(a => a.namespaceURI !== 'http://www.w3.org/2000/xmlns/').map(a => `{${a.namespaceURI ?? ''}}${a.localName}=${a.value}`).sort();
    return `<{${el.namespaceURI}}${el.localName} ${attrs.join(' ')}>${Array.from(el.childNodes).map(walk).join('')}</>`;
  };
  return walk(doc.documentElement);
}

it('saves an Inkscape SVG back as it was: layers, labels, TextExt, metadata, ids, units, prolog', () => {
  const html = svgCanvasSource(INKSCAPE_FILE);
  expect(html).toContain('inkscape:label="A: shared weights"');
  expect(html).toContain('id="arrow"');
  const saved = svgFileFromCanvas(INKSCAPE_FILE, html, null)!;
  expect(saved.startsWith('<?xml version="1.0" encoding="UTF-8" standalone="no"?>\n<!-- Created with Inkscape (http://www.inkscape.org/) -->\n<svg')).toBe(true);
  expect(canonical(saved)).toBe(canonical(INKSCAPE_FILE));
  expect(saved).toContain('<rdf:RDF>');
  expect(saved).toContain('width="540pt"');
});

it('saves the edits made on the canvas, names as Inkscape labels and objects drawn on top in user units', () => {
  const html = svgCanvasSource(INKSCAPE_FILE)
    .replace('d="M0 0L50 50"', 'd="M0 0L60 40" transform="translate(5 0)"')
    .replace('id="label"', 'id="label" data-ol-name="Caption" data-ol-locked=""');
  // a rectangle drawn at page px (10,20)–(110,60): the page is 720 × 400 px for 540 × 300 user units
  const added = '<svg xmlns="http://www.w3.org/2000/svg" width="720" height="400" viewBox="0 0 720 400"><g transform="translate(10 20)"><rect width="100" height="40" fill="red"/></g></svg>';
  const saved = svgFileFromCanvas(INKSCAPE_FILE, html, added)!;
  const doc = new DOMParser().parseFromString(saved, 'image/svg+xml');
  const arrow = doc.getElementById('arrow')!;
  expect(arrow.getAttribute('d')).toBe('M0 0L60 40');
  expect(arrow.getAttribute('transform')).toBe('translate(5 0)');
  expect(arrow.getAttributeNS('http://sodipodi.sourceforge.net/DTD/sodipodi-0.dtd', 'nodetypes')).toBe('cc');
  const label = doc.getElementById('label')!;
  expect(label.getAttributeNS('http://www.inkscape.org/namespaces/inkscape', 'label')).toBe('Caption');
  expect(label.getAttributeNS('http://sodipodi.sourceforge.net/DTD/sodipodi-0.dtd', 'insensitive')).toBe('true');
  expect(saved).not.toContain('data-ol-');
  const layer = doc.documentElement.lastElementChild!;
  expect(layer.getAttributeNS('http://www.inkscape.org/namespaces/inkscape', 'groupmode')).toBe('layer');
  expect(layer.getAttribute('transform')).toBe('matrix(0.75 0 0 0.75 0 0)');
  expect(layer.querySelector('rect')?.getAttribute('fill')).toBe('red');
});

it('opens big SVG files (figures with embedded pictures) up to 20 MB', () => {
  const picture = 'data:image/png;base64,' + 'A'.repeat(3_000_000);
  const big = `<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" viewBox="0 0 100 100"><image xlink:href="${picture}" width="10" height="10"/></svg>`;
  const html = svgCanvasSource(big);
  expect(html.length).toBeGreaterThan(3_000_000);
  expect(canonical(svgFileFromCanvas(big, html, null)!)).toBe(canonical(big));
  expect(() => svgCanvasSource(`<svg xmlns="http://www.w3.org/2000/svg">${' '.repeat(20_000_001)}</svg>`)).toThrow(/20 MB/);
});
