// @vitest-environment happy-dom
import { afterEach, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { URL as FileURL } from 'node:url';
import { createContext, runInContext } from 'node:vm';
import * as ts from 'typescript';
import { objectHtml } from '../packages/client/src/deliverable/sourceops';
import { anchorFraction, textBoxStyle, TEXT_ANCHOR } from '../packages/client/src/deliverable/textboxes';
import { inlineMathBreaks } from '../packages/client/src/deliverable/runtime/mathconfig';
import { laidOutGroup, DEFAULT_GROUP_LAYOUT } from '../packages/client/src/deliverable/grouplayout';

afterEach(() => { document.body.replaceChildren(); document.head.replaceChildren(); });

it('clicks create intrinsic labels while drags and prose pages retain wrapping boxes', () => {
  const rect = { x: 100, y: 80, w: 0, h: 0 };
  const clicked = objectHtml('text', rect, 'deck');
  expect(clicked).toContain('width: max-content');
  expect(clicked).toContain('left: 100px; top: 80px');
  expect(clicked).toContain('data-ol-text-anchor="left"');
  const dragged = objectHtml('text', { ...rect, w: 340, h: 90 }, 'deck');
  expect(dragged).toContain('width: 340px');
  expect(dragged).toContain('data-ol-wrap-lines="1"');
  expect(objectHtml('text', rect, 'page')).toBe('<p>Text</p>');
});

it('changes anchors without moving the chosen point of a label and can freeze its current width', () => {
  document.body.innerHTML = '<p style="position:absolute;left:100px;top:80px;width:200px">A <b>label</b></p>';
  const el = document.querySelector('p')!;
  expect(textBoxStyle(el, 'left')).toMatchObject({ left: '100px', width: 'max-content', translate: 'none' });
  expect(textBoxStyle(el, 'center')).toMatchObject({ left: '200px', width: 'max-content', translate: '-50% 0' });
  expect(textBoxStyle(el, 'right')).toMatchObject({ left: '300px', width: 'max-content', translate: '-100% 0' });
  // The centred label has grown, keeping its centre at 200.
  el.style.left = '200px'; el.style.width = '320px'; el.style.translate = '-50% 0';
  el.setAttribute(TEXT_ANCHOR, 'center');
  expect(anchorFraction(el)).toBe(0.5);
  expect(textBoxStyle(el, 'right')).toMatchObject({ left: '360px', translate: '-100% 0' });
  expect(textBoxStyle(el, 'fixed')).toMatchObject({ left: '40px', width: '320px', translate: 'none' });
  expect(el.innerHTML).toBe('A <b>label</b>');
});

it('hands positioning to a group layout without applying an anchor translation twice', () => {
  document.body.innerHTML = '<div class="ol-group"><p data-ol-text-anchor="center" style="left:200px;width:max-content;translate:-50% 0">Label</p></div>';
  const group = document.body.firstElementChild!;
  const out = laidOutGroup(group, [{ src: group.children[0], x: 100, y: 0, width: '200px', height: '30px' }],
    { width: '200px', height: '30px' }, DEFAULT_GROUP_LAYOUT);
  const child = out.firstElementChild as HTMLElement;
  expect(child.style.left).toBe('100px');
  expect(child.style.translate).toBe('none');
  expect(child.hasAttribute(TEXT_ANCHOR)).toBe(false);
});

it('keeps the opposite edge still when resizing anchored labels into fixed-width boxes', () => {
  // Run the real resize handler with only browser geometry/snapping controlled.
  const source = readFileSync(new FileURL('../packages/client/src/deliverable/runtime/edit.ts', import.meta.url), 'utf8');
  const code = ts.transpileModule(source.slice(source.indexOf('function resizeLive('), source.indexOf('\nfunction onDragEnd(')),
    { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText;
  const context = createContext({ anchorFraction, cs: getComputedStyle, fixedHeight: () => false, inGroupLayout: () => false });
  runInContext(code, context);
  for (const anchor of ['left', 'center', 'right']) for (const handle of ['e', 'w']) {
    const el = document.createElement('p'); document.body.append(el);
    el.setAttribute(TEXT_ANCHOR, anchor);
    const fraction = anchorFraction(el), left = 100 + fraction * 160;
    el.style.cssText = `position:absolute;left:${left}px;top:80px;width:max-content`;
    const d = { el, angle: 0, left0: left, top0: 80, w0: 160, h0: 30, r0: { x: 100, y: 80, w: 160, h: 30 } };
    context.resizeLive(d, handle, handle === 'e' ? 60 : -60, 0, false, true);
    expect(el.style.width).toBe('220px');
    const visualLeft = parseFloat(el.style.left) - fraction * 220;
    expect(handle === 'e' ? visualLeft : visualLeft + 220).toBe(handle === 'e' ? 100 : 260);
  }
});

it('keeps deck formulas intact by default, with an explicit override and prose defaults', () => {
  const parse = (html: string) => new DOMParser().parseFromString(html, 'text/html');
  expect(inlineMathBreaks(parse('<meta name="overlyx" content="deck">'))).toBe(false);
  expect(inlineMathBreaks(parse('<section class="slide"></section><section class="slide"></section>'))).toBe(false);
  expect(inlineMathBreaks(parse('<meta name="overlyx" content="deck"><meta name="overlyx-math-inline-breaks" content="on">'))).toBe(true);
  expect(inlineMathBreaks(parse('<meta name="overlyx" content="page">'))).toBe(true);
  expect(inlineMathBreaks(parse('<meta name="overlyx" content="poster"><meta name="overlyx-math-inline-breaks" content="off">'))).toBe(false);
});
