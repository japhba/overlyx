// @vitest-environment jsdom
import { afterEach, expect, it } from 'vitest';
import { svgCanvasSource } from '../packages/client/src/deliverable/svgSource';
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
  expect(doc.querySelector('path')?.getAttribute('stroke')).toBe('url(#drawing-gradient)');
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
