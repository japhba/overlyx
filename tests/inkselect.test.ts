/** The lasso's filter and its clipboard (client deliverable/inkselect.ts), shared by documents' margins and whiteboards. */
import { describe, it, expect } from 'vitest';
import { lassoAllows, usedColors, makeInkClip, inkClipText, parseInkClip, rotatePts, rotationAngle, thickened } from '../packages/client/src/deliverable/inkselect';

describe('the lasso filter', () => {
  it('takes the kinds it is set to take, of the colours picked (none picked: any colour)', () => {
    const all = ['ink', 'shapes', 'pictures', 'text'] as const;
    expect(lassoAllows('ink', ['#1A73E8'], [...all], [])).toBe(true);
    expect(lassoAllows('ink', ['#1a73e8'], ['shapes'], [])).toBe(false);
    expect(lassoAllows('ink', ['#1A73E8'], [...all], ['#1a73e8'])).toBe(true);
    expect(lassoAllows('ink', ['rgb(26, 115, 232)'], [...all], ['#1a73e8'])).toBe(true);
    expect(lassoAllows('ink', ['#ea4335'], [...all], ['#1a73e8'])).toBe(false);
    // a picture has no colour: a colour filter leaves it out
    expect(lassoAllows('pictures', [], [...all], ['#1a73e8'])).toBe(false);
    expect(lassoAllows('pictures', [], [...all], [])).toBe(true);
  });

  it('offers the colours used, the most used first, each once', () => {
    expect(usedColors(['#EA4335', '#1a73e8', '#1A73E8', null, 'transparent', '#1a73e8', '#fff'])).toEqual(['#1a73e8', '#ea4335', '#ffffff']);
  });
});

describe('the ink clipboard', () => {
  const clip = makeInkClip({
    strokes: [{ color: '#1a73e8', w: 2, nib: { ball: true }, pressure: true, pts: [[110, 220, 0.5], [130, 240, 0.6]] }, { color: '#ea4335', w: 4, poly: true, pts: [[100, 200, 0], [150, 200, 0]] }],
    imgs: [{ project: 'jan/notes', path: 'figures/a.png', x: 140, y: 230, w: 40, h: 30 }],
    notes: [{ text: 'hello', color: '#fff3bf', x: 90, y: 250, w: 60, h: 20 }],
  })!;

  it('places everything relative to the box of what was copied', () => {
    // the box: strokes with half their width round them, pictures and notes as they are
    expect([clip.w, clip.h]).toEqual([90, 72]);
    expect(clip.strokes[0].pts[0]).toEqual([20, 22, 0.5]);
    expect(clip.strokes[1].pts[1]).toEqual([60, 2, 0]);
    expect(clip.imgs[0]).toMatchObject({ x: 50, y: 32 });
    expect(clip.notes[0]).toMatchObject({ x: 0, y: 52, text: 'hello' });
  });

  it('round-trips through the clipboard text; other text is not a clip', () => {
    const back = parseInkClip(inkClipText(clip))!;
    expect(back).toEqual(clip);
    expect(back.strokes[1].poly).toBe(true);
    expect(back.strokes[0].nib).toEqual({ ball: true });
    expect(parseInkClip('hello')).toBeNull();
    expect(parseInkClip('{"overlyxInk": 2, "strokes": []}')).toBeNull();
    expect(parseInkClip('{"overlyxInk": 1, "strokes": [{"color": "#000", "w": -1, "pts": [[0, 0]]}]}')).toBeNull();
    // broken parts are left out, the rest kept; a point's missing pressure is 0
    const part = parseInkClip('{"overlyxInk": 1, "strokes": [{"color": "#000000", "w": 2, "pts": [[0, 0], [1, 1]]}, {"color": 3}], "imgs": [{"project": "p", "path": "x.png", "x": 0, "y": 0, "w": 0, "h": 5}]}')!;
    expect(part.strokes).toEqual([{ color: '#000000', w: 2, pts: [[0, 0, 0], [1, 1, 0]] }]);
    expect(part.imgs).toEqual([]);
  });
});

describe('turning and thickening', () => {
  it('turns points about a centre, Shift in steps of 15°', () => {
    const [p] = rotatePts([[2, 0, 0.7]], 1, 0, Math.PI / 2);
    expect(p[0]).toBeCloseTo(1);
    expect(p[1]).toBeCloseTo(1);
    expect(p[2]).toBe(0.7);
    expect(rotationAngle(0.3, true)).toBeCloseTo(Math.PI / 12);
    expect(rotationAngle(0.3, false)).toBe(0.3);
  });
  it('keeps widths within reason', () => {
    expect(thickened(2, 1.4)).toBe(2.8);
    expect(thickened(0.3, 0.5)).toBe(0.3);
    expect(thickened(70, 2)).toBe(80);
  });
});
