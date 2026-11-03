// @vitest-environment happy-dom
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { layout, wrapWarning } from '../packages/client/src/deliverable/runtime/layout';
import { report } from '../packages/client/src/deliverable/runtime/report';
import { state } from '../packages/client/src/deliverable/runtime/env';

const box = (el: Element, x: number, y: number, w: number, h: number) =>
  vi.spyOn(el, 'getBoundingClientRect').mockReturnValue(new DOMRect(x, y, w, h));

beforeEach(() => {
  state.kind = 'deck';
  document.body.innerHTML = '<section class="slide"></section><section class="slide"></section>';
  box(document.body.children[0], 20, 30, 600, 400);
  box(document.body.children[1], 20, 460, 600, 400);
  vi.spyOn(Range.prototype, 'getClientRects').mockImplementation(function (this: Range) {
    const p = this.startContainer.parentElement!;
    const r = p.getBoundingClientRect();
    const rows = p.hasAttribute('data-wrap') && getComputedStyle(p).whiteSpace !== 'nowrap' ? 2 : 1;
    return Array.from({ length: rows }, (_, i) => new DOMRect(r.x, r.y + i * 20, 60, 18)) as unknown as DOMRectList;
  });
});
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); document.body.replaceChildren(); });

it('reports requested slides in CSS pixels, including group children and unambiguous selectors', () => {
  const slide = document.body.children[1];
  slide.innerHTML = '<div id="card" class="ol-group"><p id="a:b">Label</p></div><aside class="notes">Notes</aside><div data-ol-runtime></div><p hidden>Hidden</p><img id="picture">';
  box(slide.children[0], 60, 500, 300, 200);
  box(slide.querySelector('p')!, 70, 520, 120, 30);
  box(slide.querySelector('img')!, 380, 500, 100, 80);
  const r = layout([1, 1, 99]);
  expect(r.units).toBe('css-px');
  expect(r.pages).toHaveLength(1);
  expect(r.pages[0]).toMatchObject({ index: 1, width: 600, height: 400 });
  const objects = r.pages[0].objects;
  expect(objects.map(o => o.id)).toEqual(['card', 'a:b', 'picture']);
  expect(objects[0].text).toBeUndefined();
  expect(objects[1].box).toEqual({ x: 50, y: 60, w: 120, h: 30 });
  expect(document.querySelector(objects[1].selector)?.id).toBe('a:b');
});

it('distinguishes soft wrapping from explicit lines, counts inline spans once and restores styles', () => {
  const slide = document.body.children[0];
  slide.innerHTML = '<p data-wrap style="color: red; white-space: normal !important">Wrapped</p><p><span>First</span><b> bold</b><br><span>Second</span></p>';
  const wrapped = slide.children[0];
  const explicit = slide.children[1];
  box(wrapped, 40, 50, 60, 20); box(explicit, 40, 100, 180, 40);
  box(explicit.children[0], 40, 100, 60, 18);
  box(explicit.children[1], 100, 98, 60, 22);
  box(explicit.children[3], 40, 120, 60, 18);
  Object.defineProperties(wrapped, { clientWidth: { value: 60 }, scrollWidth: { value: 60 }, clientHeight: { value: 20 }, scrollHeight: { value: 40 } });
  const before = slide.innerHTML;
  const objects = layout([0]).pages[0].objects;
  expect(objects[0].text).toMatchObject({ lineCount: 2, wraps: true, overflow: { x: false, y: true }, fonts: null });
  expect(objects[1].text).toMatchObject({ lineCount: 2, wraps: false });
  expect(slide.innerHTML).toBe(before);
});

it('measures MathJax chunks and named classes/ids in the slide coordinate system', () => {
  const slide = document.body.children[0];
  slide.innerHTML = '<p id="equation"><mjx-container><svg><g data-mml-node="mrow" class="kernel MJX-TEX"><g data-mml-node="mi" id="term"></g></g><g data-mml-node="mi" class="MJX-TEX" id="MJX-1-TEX"></g></svg><svg></svg></mjx-container></p>';
  const p = slide.firstElementChild!, math = p.firstElementChild!;
  box(p, 70, 80, 200, 60); box(math, 70, 80, 160, 60);
  box(math.children[0], 70, 80, 100, 25); box(math.children[1], 70, 115, 100, 25);
  box(math.querySelector('.kernel')!, 90, 85, 30, 18);
  box(math.querySelector('#term')!, 100, 90, 10, 10);
  const o = layout([0]).pages[0].objects[0];
  expect(o.text?.lineCount).toBe(2);
  expect(o.formulas).toEqual([{ box: { x: 50, y: 50, w: 160, h: 60 }, marks: [
    { classes: ['kernel'], box: { x: 70, y: 55, w: 30, h: 18 } },
    { classes: [], id: 'term', box: { x: 80, y: 60, w: 10, h: 10 } },
  ] }]);
});

it('warns about extra soft wrapping since a resize, in both the canvas measurement and render report', () => {
  const slide = document.body.children[0];
  slide.innerHTML = '<p data-wrap data-ol-wrap-lines="1">Label grows longer</p>';
  const p = slide.firstElementChild!;
  box(p, 40, 50, 60, 40);
  Object.defineProperty(document, 'elementsFromPoint', { configurable: true, value: () => [] });
  expect(wrapWarning(p)).toBe(2);
  expect(report().pages[0].issues.filter(i => i.kind === 'wrap')).toEqual([
    expect.objectContaining({ text: '"Label grows longer" wraps to 2 lines (was 1 when resized)' }),
  ]);
  p.setAttribute('data-ol-wrap-lines', '2');
  expect(wrapWarning(p)).toBeNull();
  expect(report().pages[0].issues.some(i => i.kind === 'wrap')).toBe(false);
  p.removeAttribute('data-ol-wrap-lines');
  expect(wrapWarning(p)).toBeNull();
});

it('does not warn for intentional line breaks or accept invalid wrap baselines', () => {
  const slide = document.body.children[0];
  slide.innerHTML = '<p data-ol-wrap-lines="1"><span>First</span><br><span>Second</span></p>';
  const p = slide.firstElementChild!;
  box(p, 40, 50, 180, 40); box(p.children[0], 40, 50, 60, 18); box(p.children[2], 40, 70, 60, 18);
  expect(wrapWarning(p)).toBeNull();
  p.setAttribute('data-wrap', '');
  for (const value of ['0', '-1', 'NaN', 'Infinity', '1.5']) {
    p.setAttribute('data-ol-wrap-lines', value);
    expect(wrapWarning(p)).toBeNull();
  }
});

it('uses document coordinates for web pages even after scrolling', () => {
  state.kind = 'page';
  document.body.innerHTML = '<p>Page text</p>';
  vi.stubGlobal('scrollX', 5); vi.stubGlobal('scrollY', 200);
  box(document.body.firstElementChild!, 30, -150, 180, 20);
  expect(layout([0]).pages[0].objects[0].box).toEqual({ x: 35, y: 50, w: 180, h: 20 });
});
