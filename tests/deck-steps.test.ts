/**
 * Steps on HTML slides (core html/steps.ts): data-step read as beamer overlay specifications (a lone
 * number from that step on), written back, and the slide's sequence the Animate tools edit —
 * objects added in the order clicked, appearing and disappearing, moved a notch at a time, removed.
 */
import { describe, it, expect } from 'vitest';
import { parseSteps, formatSteps, stepVisible, stepOf, sequence, lastStep, appendSteps, moveStep, removeStep, clearSteps, type Interval } from '../packages/core/src/html/steps.ts';

const P = (s: string | null) => parseSteps(s);
const F = (objs: Interval[][]) => objs.map(formatSteps);

describe('data-step', () => {
  it('a lone number is "from that step on"; ranges and lists as beamer reads them', () => {
    expect(P(null)).toEqual([[1, null]]);
    expect(P('3')).toEqual([[3, null]]);
    expect(P('-3')).toEqual([[1, 3]]);
    expect(P('2-4')).toEqual([[2, 4]]);
    expect(P('<2->')).toEqual([[2, null]]);
    expect(P('1,3-')).toEqual([[1, 1], [3, null]]);
    expect(P('2,3,5-6')).toEqual([[2, 3], [5, 6]]);
    expect(P('alert@2-')).toEqual([[2, null]]);
    expect(P('x')).toEqual([[1, null]]);
    expect(P('4-2')).toEqual([[1, null]]);
    expect(stepOf('-3')).toBe(1);
    expect(stepOf('3')).toBe(3);
  });

  it('written back in the shortest form; a lone step range stays a range', () => {
    expect(formatSteps([[1, null]])).toBeNull();
    expect(formatSteps([[3, null]])).toBe('3');
    expect(formatSteps([[1, 3]])).toBe('-3');
    expect(formatSteps([[2, 4]])).toBe('2-4');
    expect(formatSteps([[3, 3]])).toBe('3-3');
    expect(formatSteps([[1, 1], [3, null]])).toBe('1,3-');
    for (const s of ['3', '-3', '2-4', '3-3', '1,3-', '-2,4-5,7-']) expect(formatSteps(P(s))).toBe(s);
  });

  it('visible on the steps named', () => {
    const iv = P('2-3,5-');
    expect([1, 2, 3, 4, 5, 9].map(n => stepVisible(iv, n))).toEqual([false, true, true, false, true, true]);
  });
});

describe('a slide\'s sequence', () => {
  it('appearances and disappearances by step; the slide\'s number of steps', () => {
    const objs = [P(null), P('3'), P('2-3')];
    expect(sequence(objs)).toEqual([
      { obj: 2, kind: 'appear', step: 2 },
      { obj: 1, kind: 'appear', step: 3 },
      { obj: 2, kind: 'disappear', step: 4 },
    ]);
    expect(lastStep(objs)).toBe(4);
    expect(lastStep([P(null)])).toBe(1);
  });

  it('objects added in the order clicked, one click each or together', () => {
    const none = [P(null), P(null), P(null)];
    expect(F(appendSteps(none, [{ obj: 2, kind: 'appear' }, { obj: 0, kind: 'appear' }, { obj: 1, kind: 'appear' }]))).toEqual(['3', '4', '2']);
    expect(F(appendSteps(none, [{ obj: 0, kind: 'appear' }, { obj: 1, kind: 'appear', together: true }, { obj: 2, kind: 'appear' }]))).toEqual(['2', '2', '3']);
    // disappearing: gone from the next click on
    expect(F(appendSteps([P('2'), P(null)], [{ obj: 1, kind: 'disappear' }]))).toEqual(['2', '-2']);
    expect(F(appendSteps([P('2'), P(null)], [{ obj: 0, kind: 'disappear' }]))).toEqual(['2-2', null]);
  });

  it('clicking a slide\'s objects again puts them in the new order; gaps close', () => {
    let objs = [P('2'), P('3'), P('4')];
    for (const obj of [2, 1, 0]) objs = appendSteps(objs, [{ obj, kind: 'appear' }]);
    expect(F(objs)).toEqual(['4', '3', '2']);
    expect(F(appendSteps([P('5'), P(null)], [{ obj: 1, kind: 'appear' }]))).toEqual(['2', '3']);
    // gone and back again
    expect(F(appendSteps([P('-2'), P('2')], [{ obj: 0, kind: 'appear' }]))).toEqual(['-2,4-', '2']);
    // (a click where nothing happens closes up: "-2" alone disappears on the first click)
    expect(F(appendSteps([P('-2')], [{ obj: 0, kind: 'appear' }]))).toEqual(['1,3-']);
  });

  it('↑ and ↓ move an event a notch: together with the step beside, then on its own click past it', () => {
    let objs: Interval[][] | null = [P('2'), P('3'), P('4')];
    objs = moveStep(objs, { obj: 2, step: 4 }, -1);
    expect(F(objs!)).toEqual(['2', '3', '3']);
    objs = moveStep(objs!, { obj: 2, step: 3 }, -1);
    expect(F(objs!)).toEqual(['2', '4', '3']);
    objs = moveStep(objs!, { obj: 2, step: 3 }, -1);
    expect(F(objs!)).toEqual(['2', '3', '2']);
    objs = moveStep(objs!, { obj: 2, step: 2 }, -1);
    expect(F(objs!)).toEqual(['3', '4', '2']);
    expect(moveStep(objs!, { obj: 2, step: 2 }, -1)).toBeNull();
    expect(moveStep(objs!, { obj: 1, step: 4 }, 1)).toBeNull();
    expect(F(moveStep(objs!, { obj: 2, step: 2 }, 1)!)).toEqual(['2', '3', '2']);
  });

  it('an object\'s appearance cannot pass its own disappearance', () => {
    const objs = [P('2-2'), P('3')];
    // its disappearance (with the other's appearance at step 3) gets a click of its own, then can go no earlier
    const own = moveStep(objs, { obj: 0, step: 3 }, -1)!;
    expect(F(own)).toEqual(['2-2', '4']);
    expect(moveStep(own, { obj: 0, step: 3 }, -1)).toBeNull();
    expect(F(moveStep(objs, { obj: 0, step: 3 }, 1)!)).toEqual(['2-3', '3']);
    expect(moveStep(objs, { obj: 0, step: 2 }, 1)).toBeNull();
    expect(F(moveStep(objs, { obj: 1, step: 3 }, -1)!)).toEqual(['2-3', '3']);   // out of the step it shared: its own click before
  });

  it('removing an event: the object shows throughout where nothing else says otherwise', () => {
    expect(F(removeStep([P('2-3'), P('4')], { obj: 0, step: 2 }))).toEqual(['-1', '2']);
    expect(F(removeStep([P('2-3'), P('4')], { obj: 0, step: 4 }))).toEqual(['2', '3']);
    // gone and back: removing the disappearance removes the coming back too
    expect(F(removeStep([P('-2,4-')], { obj: 0, step: 3 }))).toEqual([null]);
    expect(F(removeStep([P('2-2,4-')], { obj: 0, step: 4 }))).toEqual(['2-2']);
    expect(F(clearSteps([P('2'), P('3'), P('4')], [1]))).toEqual(['2', null, '3']);
  });
});
