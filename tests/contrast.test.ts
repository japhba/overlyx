import { describe, it, expect } from 'vitest';
import { inkOn } from '../packages/client/src/app/contrast';

describe('inkOn: the text colour on a person\'s colour', () => {
  it('dark on the light ones, white on the dark ones, white when unknown', () => {
    for (const light of ['#e0a40c', '#64b5cd', '#da8bc3', '#ccb974', '#ffffff']) expect(inkOn(light)).toBe('#1c1b19');
    for (const dark of ['#2152a3', '#d6402b', '#55a868', '#8172b3', '#937860', '#12711c', '#a23582', '#006374', '#000000']) expect(inkOn(dark)).toBe('#fff');
    expect(inkOn(null)).toBe('#fff');
    expect(inkOn('hsl(10 50% 50%)')).toBe('#fff');
  });
});
