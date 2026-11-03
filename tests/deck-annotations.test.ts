// @vitest-environment jsdom
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { refreshAnnotations } from '../packages/client/src/deliverable/runtime/annotations';
import { applySource, whenTypeset } from '../packages/client/src/deliverable/runtime/reconcile';
import { state } from '../packages/client/src/deliverable/runtime/env';

vi.mock('../packages/client/src/deliverable/runtime/math', () => ({ typeset: async () => {}, untypeset: () => {} }));

const jobs = new Map<number, FrameRequestCallback>();
let next = 0;
beforeEach(() => {
  vi.spyOn(window, 'requestAnimationFrame').mockImplementation(cb => { jobs.set(++next, cb); return next; });
  vi.spyOn(window, 'cancelAnimationFrame').mockImplementation(id => { jobs.delete(id); });
});
afterEach(() => {
  document.body.replaceChildren(); refreshAnnotations();
  document.head.replaceChildren(); state.src = null; state.version = null;
  jobs.clear(); vi.restoreAllMocks();
});

function rect(el: Element, x: number, y: number, w: number, h: number): void {
  vi.spyOn(el, 'getBoundingClientRect').mockReturnValue(new DOMRect(x, y, w, h));
}
function slide(html: string, x = 0, y = 0, scale = 1): HTMLElement {
  const el = document.createElement('section'); el.className = 'slide'; el.innerHTML = html;
  document.body.append(el); rect(el, x, y, 600 * scale, 400 * scale);
  Object.defineProperties(el, { offsetWidth: { value: 600 }, offsetHeight: { value: 400 } });
  return el;
}
function annotation(scope: Element, kind: 'connector' | 'frame', config: unknown): SVGSVGElement {
  const el = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  el.setAttribute(`data-ol-${kind}`, JSON.stringify(config)); scope.append(el); return el;
}
async function flush(): Promise<void> {
  // Deliver native mutation records and coalesced frames, including any mutations from drawing.
  for (let i = 0; i < 4; i++) {
    await Promise.resolve(); const callbacks = [...jobs.values()]; jobs.clear();
    callbacks.forEach(cb => cb(0));
  }
  await Promise.resolve(); expect(jobs.size).toBe(0);
}

it('joins object sides and offsets without changing the target or source configuration', () => {
  const s = slide('<div id="a"></div><p id="b">Label</p>');
  rect(s.children[0], 20, 30, 80, 40); rect(s.children[1], 300, 30, 120, 40);
  const arrow = annotation(s, 'connector', { from: { id: 'a', side: 'right', offset: [4, 0] }, to: { id: 'b', side: 'left' } });
  const original = arrow.getAttribute('data-ol-connector');
  refreshAnnotations();
  expect(arrow.style.left).toBe('104px'); expect(arrow.style.top).toBe('45.65px');
  expect(arrow.querySelector('path')!.getAttribute('d')).toBe('M0 4.35 L196 4.35');
  expect(arrow.querySelectorAll('path')).toHaveLength(2);
  expect(arrow.style.pointerEvents).toBe('none');
  expect(arrow.getAttribute('data-ol-connector')).toBe(original); expect(s.children[1].textContent).toBe('Label');
});

it('frames the union of named formula terms in slide pixels under presentation scaling', () => {
  const s = slide('<p id="eq:one"><mjx-container><svg><g data-mml-node="mi" class="term:one"></g><g data-mml-node="mi" class="term:one"></g></svg></mjx-container></p>', 100, 200, 2);
  const terms = s.querySelectorAll('g'); rect(terms[0], 300, 360, 40, 60); rect(terms[1], 350, 360, 30, 60);
  const frame = annotation(s, 'frame', { target: { id: 'eq:one', class: 'term:one' }, padding: 6, radius: 4 });
  refreshAnnotations();
  expect(frame.style.left).toBe('94px'); expect(frame.style.top).toBe('74px');
  expect(frame.getAttribute('viewBox')).toBe('0 0 52 42');
  expect(frame.querySelector('rect')!.getAttribute('rx')).toBe('4');
});

it('resolves cssId marks within each slide and draws curved arrows with inherited paint', () => {
  for (const offset of [0, 800]) {
    const s = slide('<div id="a"></div><p><mjx-container><svg><g data-mml-node="mi" id="term"></g></svg></mjx-container></p>', offset);
    rect(s.children[0], offset + 20, 20, 80, 40); rect(s.querySelector('g')!, offset + 300, 20, 50, 40);
    const arrow = annotation(s, 'connector', { from: 'a', to: 'term', curve: 40, head: 0 });
    arrow.setAttribute('stroke', '#557799'); arrow.setAttribute('stroke-width', '3');
    refreshAnnotations();
    expect(arrow.style.left).toBe('100px'); expect(arrow.style.top).toBe('40px');
    expect(arrow.querySelector('path')!.getAttribute('d')).toBe('M0 0 Q100 40 200 0');
    expect(arrow.querySelectorAll('path')).toHaveLength(1);
    expect(arrow.getAttribute('stroke')).toBe('#557799'); expect(arrow.getAttribute('stroke-width')).toBe('3');
  }
});

it('follows moves, resizing and retypesetting through native DOM mutations without a render loop', async () => {
  const s = slide('<p id="formula"><mjx-container><svg><g data-mml-node="mi" class="part"></g></svg></mjx-container></p>');
  rect(s.querySelector('g')!, 80, 60, 30, 20);
  const frame = annotation(s, 'frame', { target: { id: 'formula', class: 'part' }, padding: 4 });
  refreshAnnotations(); await flush();
  const rendered = frame.firstElementChild;
  const formula = s.firstElementChild!;
  formula.innerHTML = '<mjx-container><svg><g data-mml-node="mi" class="part"></g></svg></mjx-container>';
  rect(formula.querySelector('g')!, 140, 90, 70, 30);
  await flush();
  expect(frame.style.left).toBe('136px'); expect(frame.style.top).toBe('86px');
  expect(frame.getAttribute('viewBox')).toBe('0 0 78 38');
  expect(frame.firstElementChild).toBe(rendered);
  const shape = rendered!.firstElementChild;
  window.dispatchEvent(new Event('resize')); await flush();
  expect(rendered!.firstElementChild).toBe(shape); // unchanged geometry is kept
});

it('hides absent or malformed targets, restores a returned target, and never anchors to another annotation', async () => {
  const s = slide('<div id="a"></div>'); rect(s.firstElementChild!, 20, 30, 60, 40);
  const frame = annotation(s, 'frame', { target: 'a' }); frame.id = 'frame';
  const invalid = annotation(s, 'connector', { from: 'frame', to: 'a' });
  refreshAnnotations();
  expect(invalid.hasAttribute('data-ol-annotation-hidden')).toBe(true);
  s.firstElementChild!.remove(); await flush();
  expect(frame.hasAttribute('data-ol-annotation-hidden')).toBe(true);
  const target = document.createElement('div'); target.id = 'a'; rect(target, 30, 40, 70, 50); s.prepend(target); await flush();
  expect(frame.hasAttribute('data-ol-annotation-hidden')).toBe(false); expect(frame.style.left).toBe('22px');
  frame.setAttribute('data-ol-frame', '{'); await flush();
  expect(frame.hasAttribute('data-ol-annotation-hidden')).toBe(true);
});

it('syncs annotation configuration edits in place and removes generated shapes when detached', async () => {
  const html = '<html><head></head><body><section class="slide"><p id="a">A</p><p id="b">B</p><svg data-ol-frame=\'{"target":"a"}\'></svg></section></body></html>';
  document.body.innerHTML = '<section class="slide"><p id="a">A</p><p id="b">B</p><svg data-ol-frame=\'{"target":"a"}\'></svg></section>';
  const s = document.querySelector('.slide')!; rect(s, 0, 0, 600, 400);
  Object.defineProperties(s, { offsetWidth: { value: 600 }, offsetHeight: { value: 400 } });
  rect(s.children[0], 20, 30, 60, 40); rect(s.children[1], 200, 100, 80, 50);
  applySource(html, 1); refreshAnnotations();
  const frame = s.querySelector('svg')!;
  applySource(html.replace('"target":"a"', '"target":"b"'), 2); await whenTypeset(); refreshAnnotations();
  expect(s.querySelector('svg')).toBe(frame); expect(frame.style.left).toBe('192px');
  applySource(html.replace(' data-ol-frame=\'{"target":"a"}\'', ''), 3); refreshAnnotations();
  expect(frame.hasAttribute('data-ol-frame')).toBe(false); expect(frame.querySelector('[data-ol-annotation-shape]')).toBeNull();
});
