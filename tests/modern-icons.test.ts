import { describe, expect, it } from 'vitest';
import { MODERN_ICONS } from '../packages/client/src/app/modernicons';
import { LYX_ICONS } from '../packages/client/src/app/lyxicons';
import { objectHtml } from '../packages/client/src/deliverable/sourceops';

describe('the Modern interface never shows LyX’s icons', () => {
  it('has a line icon for every LyX icon a button or palette may name', () => {
    expect(Object.keys(LYX_ICONS).filter(k => !MODERN_ICONS[k])).toEqual([]);
  });
});

it('draws a formula object as wide as its formula, centred on the click or on the box drawn', () => {
  const clicked = objectHtml('formula', { x: 400, y: 300, w: 0, h: 0 }, 'deck');
  expect(clicked).toContain('data-ol-text-anchor="center"');
  expect(clicked).toContain('left: 400px');
  expect(clicked).toContain('width: max-content');
  expect(clicked).toContain('translate: -50% 0');
  expect(clicked).not.toMatch(/width: \d/);
  expect(objectHtml('formula', { x: 100, y: 50, w: 300, h: 80 }, 'deck')).toContain('left: 250px; top: 50px');
  expect(objectHtml('formula', { x: 400, y: 300, w: 0, h: 0 }, 'page')).toBe('<p>\\[ \\]</p>');
});
