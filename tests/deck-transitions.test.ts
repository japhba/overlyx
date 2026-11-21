import { describe, it, expect } from 'vitest';
import { parseTransition, formatTransition, transitionOf, advanceOf, parseSecs } from '../packages/core/src/html/transitions.ts';

describe('slide transitions and timed advance (core html/transitions.ts)', () => {
  it('reads and writes data-ol-transition', () => {
    expect(parseTransition('fade')).toEqual({ kind: 'fade', secs: 0.5 });
    expect(parseTransition('push 0.8s')).toEqual({ kind: 'push', secs: 0.8 });
    expect(parseTransition('wipe 300ms')).toEqual({ kind: 'wipe', secs: 0.3 });
    expect(parseTransition('dissolve')?.kind).toBe('fade');
    expect(parseTransition('')).toBeNull();
    expect(formatTransition({ kind: 'push', secs: 0.5 })).toBe('push');
    expect(formatTransition({ kind: 'wipe', secs: 1 })).toBe('wipe 1s');
    expect(formatTransition({ kind: 'none', secs: 2 })).toBe('none');
  });
  it('a slide’s own wins over the deck’s; none cuts', () => {
    expect(transitionOf(null, 'fade')?.kind).toBe('fade');
    expect(transitionOf('push', 'fade')?.kind).toBe('push');
    expect(transitionOf('none', 'fade')).toBeNull();
    expect(transitionOf(null, null)).toBeNull();
  });
  it('timed advance: seconds, the deck’s unless the slide says click', () => {
    expect(parseSecs('5s')).toBe(5);
    expect(advanceOf('5s', null)).toBe(5);
    expect(advanceOf(null, '10s')).toBe(10);
    expect(advanceOf('click', '10s')).toBeNull();
    expect(advanceOf(null, null)).toBeNull();
    expect(advanceOf('0.1s', null)).toBe(0.5);
  });
});
