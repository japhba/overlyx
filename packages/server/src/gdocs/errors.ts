/** An error answered by the Google APIs (no imports: the tests' API simulation uses it too). */
export class GoogleApiError extends Error {
  constructor(message: string, public status: number, public reason?: string) { super(message); }
}

/**
 * Google refused a write because the Google Doc is no longer at the revision it was planned for
 * (writeControl.requiredRevisionId — "The required revision ID '…' does not match the latest
 * revision."): somebody typed there between the sync's reading and its writing. Not a failure.
 */
export const changedMeanwhile = (e: unknown): boolean => e instanceof GoogleApiError && e.status === 400 && /\brequired revision id\b/i.test(e.message);

/** how often a request Google did not take is tried again */
export const RETRIES = 3;
/** the longest wait Google may ask for (Retry-After) that a sync waits out; a longer one fails it, and the automatic sync's back-off takes over */
const RETRY_AFTER_MAX_MS = 30_000;

/**
 * After how long a request Google did not take is tried again — null: not at all. Worth repeating
 * are a rate limit — the Docs API's 429 (its quota per minute) and the Drive API's 403 with the
 * reason userRateLimitExceeded / rateLimitExceeded ("User rate limit exceeded") — Google's own
 * failures (5xx) and no answer at all (status 0, which the caller repeats only for a read): with
 * exponential back-off and jitter, as Google asks, or after the Retry-After it sent. Any other 4xx
 * is the request's own (no access, no such file, a revision that moved on, a daily limit), and
 * repeating it changes nothing.
 */
export function retryDelay(status: number, reason: string | undefined, attempt: number, retryAfter?: string | null, random = Math.random, now = Date.now()): number | null {
  // (userRateLimitExceeded, rateLimitExceeded; an ErrorInfo's RATE_LIMIT_EXCEEDED)
  const limited = status === 429 || (status === 403 && /^(user_?)?rate_?limit_?exceeded$/i.test(reason ?? ''));
  if (!(limited || status === 0 || status >= 500) || attempt >= RETRIES) return null;
  if (retryAfter) {
    // (seconds, or an HTTP date)
    const asked = /^\d+$/.test(retryAfter.trim()) ? Number(retryAfter) * 1000 : Date.parse(retryAfter) - now;
    if (Number.isFinite(asked)) return asked > RETRY_AFTER_MAX_MS ? null : Math.max(0, asked);
  }
  return 1000 * 2 ** attempt + Math.floor(random() * 1000);
}
