/**
 * The server's rate limiter (packages/server/src/ratelimit.ts): at most `max` in any window, per key —
 * and a key whose window has passed is forgotten (keys made from addresses are the requester's to
 * choose; the table used to grow for as long as the server ran).
 */
import { describe, it, expect } from 'vitest';
import { allow, rateLimitKeys } from '../packages/server/src/ratelimit.ts';

describe('rate limiter', () => {
  it('lets `max` through in a window, and again as the window slides on', () => {
    const t0 = 1_800_000_000_000;
    for (let i = 0; i < 3; i++) expect(allow('a', 3, 1000, t0 + i * 100)).toBe(true);
    expect(allow('a', 3, 1000, t0 + 300)).toBe(false);
    expect(allow('b', 3, 1000, t0 + 300)).toBe(true);     // another key is another count
    expect(allow('a', 3, 1000, t0 + 999)).toBe(false);
    expect(allow('a', 3, 1000, t0 + 1001)).toBe(true);    // the first one is older than the window now
    expect(allow('a', 3, 1000, t0 + 1002)).toBe(false);   // (a refusal does not count against the key)
    expect(allow('a', 3, 1000, t0 + 1101)).toBe(true);
  });

  it('forgets keys whose window has passed', () => {
    const t0 = 1_900_000_000_000;
    for (let i = 0; i < 6000; i++) allow(`address:${i}`, 30, 60_000, t0);
    expect(rateLimitKeys()).toBeGreaterThanOrEqual(6000);   // (the keys of the test above, long past their window, may be gone already)
    allow('address:0', 30, 60_000, t0 + 30_000);            // inside their window: all still counted
    expect(rateLimitKeys()).toBeGreaterThanOrEqual(6000);
    allow('late', 30, 60_000, t0 + 61_000);                 // past it: swept
    expect(rateLimitKeys()).toBeLessThanOrEqual(2);
    expect(allow('address:0', 1, 60_000, t0 + 30_500)).toBe(false);   // …but not the one used since
  });
});
