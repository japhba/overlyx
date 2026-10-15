import { describe, expect, it } from 'vitest';
import {
  CONTEXTS, DURATION_BUCKETS, POINTERS, RELIABILITY_EVENTS,
  isReliabilityContext, isReliabilityDurationBucket,
  makeReliabilityDetail, parseReliabilityDetail, reliabilityDurationBucket,
} from '../packages/core/src/reliability.ts';

describe('content-free reliability schema', () => {
  it('round-trips every finite event with each permitted pointer kind', () => {
    expect(RELIABILITY_EVENTS).toEqual([
      'diagnostics.enabled', 'screen.orientation',
      'keyboard.load-start', 'keyboard.ready', 'keyboard.fallback-error', 'keyboard.fallback-timeout', 'keyboard.late-ready', 'keyboard.owner-disposed',
      'gesture.cancelled', 'gesture.capture-lost', 'gesture.interrupted', 'gesture.palm-ignored',
      'canvas.ready', 'canvas.timeout', 'canvas.retry', 'canvas.recovered', 'canvas.denied',
      'save.pending', 'save.saved', 'save.offline-local', 'save.storage-warning', 'save.failed',
      'app.hidden', 'app.resumed',
    ]);
    for (const event of RELIABILITY_EVENTS) for (const pointer of POINTERS) {
      const detail = makeReliabilityDetail(event, pointer);
      expect(detail).toBe(`${event} ${pointer}`);
      expect(parseReliabilityDetail(detail)).toEqual({ event, pointer });
    }
    expect(makeReliabilityDetail('app.hidden')).toBe('app.hidden none');
  });

  it('rejects unknown, malformed, hostile and structured payloads without reflecting content', () => {
    const hostile = [
      'private text app.hidden none', 'app.hidden none https://example.invalid/?token=x',
      'app.hidden  none', ' app.hidden none', 'app.hidden none ', 'app.hidden mouse extra',
      'unlisted.event pen', 'save.failed password=secret', '',
      { event: 'app.hidden', pointer: 'none', text: 'private' },
      Object.assign(Object.create({ event: 'app.hidden' }), { pointer: 'none' }),
      new Uint8Array([97, 112, 112]), new String('app.hidden none'),
    ];
    for (const value of hostile) {
      expect(parseReliabilityDetail(value)).toBeNull();
      expect(makeReliabilityDetail(value)).toBeNull();
    }
    expect(makeReliabilityDetail('app.hidden', 'keyboard')).toBeNull();
    expect(makeReliabilityDetail('save.failed', 'touch\nsecret')).toBeNull();
  });

  it('accepts only the finite context vocabulary', () => {
    expect(CONTEXTS).toEqual(['ui', 'math', 'document', 'deck', 'poster', 'page', 'portrait', 'landscape']);
    for (const context of CONTEXTS) expect(isReliabilityContext(context)).toBe(true);
    for (const invalid of [null, 1, {}, 'canvas', 'document text', 'portrait?secret']) expect(isReliabilityContext(invalid)).toBe(false);
  });

  it('ceil-buckets finite durations and clamps both ends', () => {
    expect(DURATION_BUCKETS).toEqual([0, 250, 500, 1000, 3000, 10000, 30000, 60000]);
    const boundaries: [number, number][] = [
      [-10, 0], [0, 0], [0.1, 250], [250, 250], [250.1, 500], [500, 500],
      [1000, 1000], [3000, 3000], [10000, 10000], [30000, 30000], [59999, 60000], [60000, 60000], [90000, 60000],
    ];
    for (const [input, expected] of boundaries) expect(reliabilityDurationBucket(input)).toBe(expected);
    for (const invalid of [undefined, null, '250', NaN, Infinity, -Infinity, {}, new Number(250)]) {
      expect(reliabilityDurationBucket(invalid)).toBeNull();
    }
    for (const bucket of DURATION_BUCKETS) expect(isReliabilityDurationBucket(bucket)).toBe(true);
    for (const invalid of [1, 249, 60001, NaN, '250', null]) expect(isReliabilityDurationBucket(invalid)).toBe(false);
  });
});
