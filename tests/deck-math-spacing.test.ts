// @vitest-environment happy-dom
import { expect, it } from 'vitest';
import { inlineBreakFontSize } from '../packages/client/src/deliverable/runtime/math.ts';

it('sizes inline SVG break glue in the glyph math em, not the surrounding text em', () => {
  const xHeight = 0.442;
  const size = inlineBreakFontSize(xHeight)!;
  expect(size).toBe('2.262443ex');
  const textEx = 15.28, textEm = 28;
  const mathEm = textEx / xHeight;
  const breakEm = parseFloat(size) * textEx;
  expect(breakEm).toBeCloseTo(mathEm, 4);
  expect(breakEm * 0.222).toBeCloseTo(mathEm * 0.222, 4);
  expect(Math.abs(textEm * 0.222 - mathEm * 0.222)).toBeGreaterThan(1);
});

it('adapts to the actual math font and refuses invalid metrics', () => {
  expect(inlineBreakFontSize(0.5)).toBe('2ex');
  for (const value of [0, -1, NaN, Infinity]) expect(inlineBreakFontSize(value)).toBeNull();
});
