/**
 * The server's one rate limiter: `allow(key, max, windowMs)` says whether `key` may act once more —
 * at most `max` times within any `windowMs` (a sliding window, kept in memory; a restart forgets it).
 * A key names what is limited and for whom: `search:<user id>`, `vscode-error:<address>`,
 * `oauth-register` (everybody together).
 *
 * A key whose window has passed is forgotten. Keys made from an address are the requester's to choose
 * (every address of an IPv6 network is another key), so a table that only grew was a slow way to
 * fill the server's memory.
 */
const buckets = new Map<string, { times: number[]; windowMs: number }>();
/** past this many keys the table is swept of the ones whose window has passed (not more often than SWEEP_GAP_MS) */
const SWEEP_AT = 5000, SWEEP_GAP_MS = 10_000;
let sweptAt = 0;

function sweep(now: number): void {
  sweptAt = now;
  for (const [key, b] of buckets) if (!b.times.length || now - b.times[b.times.length - 1] >= b.windowMs) buckets.delete(key);
}

export function allow(key: string, max: number, windowMs: number, now = Date.now()): boolean {
  if (buckets.size >= SWEEP_AT && now - sweptAt >= SWEEP_GAP_MS) sweep(now);
  const b = buckets.get(key);
  const times = b ? b.times.filter(t => now - t < windowMs) : [];
  const ok = times.length < max;
  if (ok) times.push(now);
  if (times.length) buckets.set(key, { times, windowMs }); else buckets.delete(key);
  return ok;
}

/** (tests) how many keys are remembered */
export function rateLimitKeys(): number { return buckets.size; }
