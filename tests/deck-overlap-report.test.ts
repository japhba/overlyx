// @vitest-environment happy-dom
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
vi.mock('../packages/client/src/deliverable/runtime/math', () => ({ mathTypeset: () => false }));
import { report } from '../packages/client/src/deliverable/runtime/report';
import { state } from '../packages/client/src/deliverable/runtime/env';

let slide: HTMLElement;
const box = (el: Element, x: number, y: number, w: number, h: number) =>
  vi.spyOn(el, 'getBoundingClientRect').mockReturnValue(new DOMRect(x, y, w, h));
const overlaps = () => report().pages[0].issues.filter(i => i.kind === 'overlap');

beforeEach(() => {
  document.head.innerHTML = '<style>* { visibility: visible; opacity: 1; fill: black; fill-opacity: 1; stroke: none; stroke-opacity: 1 }</style>';
  document.body.innerHTML = '<section class="slide"></section>';
  slide = document.querySelector('.slide')!;
  box(slide, 0, 0, 600, 400);
  state.kind = 'deck';
  Object.defineProperty(document, 'elementsFromPoint', { configurable: true, value: () => [] });
  // Synthetic glyph advances keep these tests independent of a browser's layout engine.
  vi.spyOn(Range.prototype, 'getClientRects').mockImplementation(function (this: Range) {
    const p = this.startContainer.parentElement?.closest('[data-x]') as HTMLElement | null;
    if (!p) return [] as unknown as DOMRectList;
    return [new DOMRect(Number(p.dataset.x) + this.startOffset * 10, Number(p.dataset.y),
      (this.endOffset - this.startOffset) * 10, 20)] as unknown as DOMRectList;
  });
});
afterEach(() => { vi.restoreAllMocks(); document.body.replaceChildren(); document.head.replaceChildren(); });

function text(value: string, x: number, y: number): HTMLElement {
  const p = document.createElement('p'); p.textContent = value;
  p.dataset.x = String(x); p.dataset.y = String(y);
  p.style.position = 'absolute';
  box(p, x, y, value.length * 10, 20); slide.append(p);
  return p;
}

function arrow(): SVGSVGElement {
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  const path = document.createElementNS(svg.namespaceURI, 'path') as SVGGeometryElement;
  path.setAttribute('d', 'M0 100L100 0');
  path.setAttribute('style', 'fill:none;stroke:black;stroke-width:4px');
  // Native SVG paint queries are unavailable in happy-dom. Model this diagonal stroke exactly.
  Object.assign(path, {
    getScreenCTM: () => new DOMMatrix(),
    isPointInFill: () => false,
    isPointInStroke: (p: DOMPoint) => Math.abs(p.x + p.y - 100) < 2,
  });
  box(svg, 0, 0, 300, 200); box(path, 0, 0, 100, 100);
  svg.append(path); slide.append(svg);
  return svg;
}

it('does not flag the empty part of an SVG viewport or a diagonal stroke box', () => {
  text('A', 200, 150); text('B', 70, 70); arrow();
  expect(overlaps()).toEqual([]);
});

it('still reports a painted stroke crossing a glyph, with SVG transforms applied', () => {
  text('A', 140, 90);
  const svg = arrow(), path = svg.firstElementChild as SVGGeometryElement;
  Object.assign(path, { getScreenCTM: () => new DOMMatrix().translate(100, 50) });
  box(path, 100, 50, 100, 100);
  expect(overlaps()).toHaveLength(1);
  expect(overlaps()[0].text).toContain('covers part of the text');
});

it('measures glyphs rather than whitespace, and leaves real text collisions visible', () => {
  text('A     B', 0, 0); const p = text('C', 30, 0);
  expect(overlaps()).toEqual([]);
  p.dataset.x = '0';
  expect(overlaps()).toHaveLength(1);
});

it('ignores hidden inline text in deliberately stacked labels', () => {
  const p = text('', 0, 0);
  p.innerHTML = '<span style="visibility:hidden">A</span>';
  text('B', 0, 0);
  expect(overlaps()).toEqual([]);
});

it('uses font ink metrics rather than the full character advance and font height', () => {
  vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue({
    measureText: () => ({ width: 10, fontBoundingBoxAscent: 15, fontBoundingBoxDescent: 5,
      actualBoundingBoxLeft: 0, actualBoundingBoxRight: 8, actualBoundingBoxAscent: 8, actualBoundingBoxDescent: 0 }),
  } as unknown as CanvasRenderingContext2D);
  text('A', 0, 0); const p = text('B', 0, 15);
  expect(overlaps()).toEqual([]);
  p.dataset.y = '0';
  expect(overlaps()).toHaveLength(1);
});

it('uses individual formula glyphs rather than the whole formula box', () => {
  const p = text('', 0, 0);
  p.innerHTML = '<mjx-container><svg><defs><path></path></defs><use></use></svg></mjx-container>';
  box(p, 0, 0, 100, 20);
  box(p.querySelector('mjx-container')!, 0, 0, 100, 20);
  box(p.querySelector('path')!, 0, 0, 100, 20);
  box(p.querySelector('use')!, 0, 0, 10, 20);
  const q = text('A', 50, 0);
  expect(overlaps()).toEqual([]);
  q.dataset.x = '0';
  expect(overlaps()).toHaveLength(1);
});

it('does not call a background picture a cover, and respects its z-index', () => {
  const svg = arrow(); text('A', 40, 40);
  expect(overlaps()).toEqual([]);
  svg.style.zIndex = '2';
  expect(overlaps()).toHaveLength(1);
});

it('allows either object to opt out without disabling off-page warnings', () => {
  const a = text('A', 0, 0), b = text('B', 0, 0);
  expect(overlaps()).toHaveLength(1);
  b.setAttribute('data-ol-lint', 'no-overlap');
  expect(overlaps()).toEqual([]);
  b.removeAttribute('data-ol-lint');
  a.setAttribute('data-ol-lint', 'other no-overlap');
  expect(overlaps()).toEqual([]);
  a.dataset.x = '650';
  expect(report().pages[0].issues.some(i => i.kind === 'offpage')).toBe(true);
});

it('honours the opt-out on an SVG object or an individual shape', () => {
  text('A', 40, 40); const svg = arrow();
  expect(overlaps()).toHaveLength(1);
  svg.setAttribute('data-ol-lint', 'no-overlap');
  expect(overlaps()).toEqual([]);
  svg.removeAttribute('data-ol-lint');
  svg.firstElementChild!.setAttribute('data-ol-lint', 'no-overlap');
  expect(overlaps()).toEqual([]);
});
