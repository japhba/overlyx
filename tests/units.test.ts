/**
 * Lengths as the deck tools show them (deliverable/units.ts): points for type, lines and corners
 * (1 CSS px = ¾ pt), quarter points written as PowerPoint does, the font size ladder of − / +,
 * millimetres or inches for sizes.
 */
import { describe, it, expect } from 'vitest';
import { fmtPt, fmtSize, fmtLength, ptToPx, pxToPt, sizePt, stepPt } from '../packages/client/src/deliverable/units.ts';

describe('physical units', () => {
  it('converts CSS px and points', () => {
    expect(pxToPt(64)).toBe(48);
    expect(ptToPx(12)).toBe(16);
    expect(sizePt(22)).toBe(16.5);
    expect(sizePt(1.3333)).toBe(1);
  });
  it('writes quarter points as fractions', () => {
    expect(fmtPt(0.75)).toBe('¾');
    expect(fmtPt(2.25)).toBe('2¼');
    expect(fmtPt(1.5)).toBe('1½');
    expect(fmtPt(3)).toBe('3');
    expect(fmtPt(pxToPt(ptToPx(1)))).toBe('1');
    expect(fmtPt(10.4)).toBe('10.4');
  });
  it('steps font sizes along the ladder, and past its ends', () => {
    expect(stepPt(12, 1)).toBe(14);
    expect(stepPt(13, 1)).toBe(14);
    expect(stepPt(14, -1)).toBe(12);
    expect(stepPt(10.5, -1)).toBe(10);
    expect(stepPt(288, 1)).toBe(331);
    expect(stepPt(6, -1)).toBe(5);
  });
  it('shows sizes in millimetres or inches', () => {
    expect(fmtSize(1280, 720, 'in')).toBe('13.33 × 7.5 in');
    expect(fmtSize(320, 180, 'mm')).toBe('84.7 × 47.6 mm');
    expect(fmtLength(1280, 'mm')).toBe('339 mm');
  });
});
