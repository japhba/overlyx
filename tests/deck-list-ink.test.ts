import { describe, it, expect } from 'vitest';
import { expandInlineBox } from '../packages/client/src/deliverable/runtime/listmarkers';

describe('list selection ink stays in the object axes', () => {
  it('leaves the CSS box unchanged when its padding already contains the marker', () => {
    const box = { cx:100, cy:200, w:780, h:120, a:0 };
    expect(expandInlineBox(box, 0, 0)).toBe(box);
  });
  it('expands LTR and RTL sides without changing the far edge or height', () => {
    const box = { cx:100, cy:200, w:780, h:120, a:0 };
    expect(expandInlineBox(box, 32, 0)).toEqual({ ...box, cx:84, w:812 });
    expect(expandInlineBox(box, 0, 32)).toEqual({ ...box, cx:116, w:812 });
  });
  it('rotates the shifted centre, not an already rotated bounding rectangle', () => {
    const box = { cx:100, cy:200, w:780, h:120, a:90 };
    const ink = expandInlineBox(box, 32, 0);
    expect(ink.cx).toBeCloseTo(100);
    expect(ink.cy).toBeCloseTo(184);
    expect(ink.w).toBe(812);
    expect(ink.h).toBe(120);
    expect(box.w).toBe(780);
  });
});
