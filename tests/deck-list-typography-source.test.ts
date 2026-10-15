import { expect, it } from 'vitest';
import { applyTo, rebasedSplices } from '../packages/client/src/deliverable/sourceops';

const source = '<html><head><title>Heading</title></head><body><section class="slide"><h1 id="title" style="left:100px;width:1000px">Primary heading</h1><p>Other object</p></section></body></html>';
const path = [1, 0, 0];
const typography = { 'font-size': '48px', 'font-family': 'Georgia, serif', 'font-weight': '600', color: 'rgb(0, 31, 63)', 'line-height': '57.6px' };

it('persists all carried heading typography with the same list/tag conversion', () => {
  const splices = rebasedSplices(source, source, [
    { t: 'inner', path, before: 'Primary heading', html: '<ul><li>Primary heading</li><li>Second item</li></ul>', as: 'div' },
    { t: 'style', path, set: typography },
  ]);
  expect(splices).not.toBeNull();
  const saved = applyTo(source, splices!);
  expect(saved).toContain('<div id="title"'); expect(saved).toContain('</ul></div>');
  for (const [property, value] of Object.entries(typography)) expect(saved).toContain(`${property}: ${value}`);
  expect(saved).toContain('left: 100px'); expect(saved).toContain('width: 1000px');
  expect(saved).toContain('<p>Other object</p>');
});

it('retains a coauthor’s unrelated positioning while saving the list typography', () => {
  const current = source.replace('left:100px', 'left:240px');
  const splices = rebasedSplices(source, current, [
    { t: 'inner', path, before: 'Primary heading', html: '<ul><li>Primary heading</li><li>Second item</li></ul>', as: 'div' },
    { t: 'style', path, set: typography },
  ]);
  expect(splices).not.toBeNull(); const saved = applyTo(current, splices!);
  expect(saved).toContain('left: 240px'); expect(saved).toContain('font-size: 48px');
  expect(saved).toContain('Primary heading</li><li>Second item');
});
