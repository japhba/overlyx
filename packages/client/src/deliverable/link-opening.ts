/** Opens the short-lived URL used by an editable deliverable's host frame.
 *
 * This controller deliberately keeps failures private: the UI receives only a small state enum,
 * never an exception, URL, token, or response body. A timed-out request may still settle later;
 * its result is ignored once a newer attempt owns the controller.
 */
export type LinkState = 'opening' | 'open' | 'failed' | 'denied';
export type LinkWithExpiry = { expires?: number };

export type LinkOpeningOptions<L extends LinkWithExpiry> = {
  host: { link: () => Promise<L> };
  onReady: (link: L) => void;
  onState: (state: LinkState) => void;
  timeoutMs?: number;
  minValidityMs?: number;
  maxAutoRetries?: number;
  retryDelays?: readonly number[];
  maxExpiryRenewals?: number;
  now?: () => number;
};

export type LinkOpener = {
  /** Start once, immediately; repeated calls do not create another request. */
  start: () => void;
  /** User initiated; also permitted after a denied response. */
  retry: () => void;
  /** Network/status recovery; ignored unless a previous transient failure exists. */
  resume: () => void;
  /** Cancel timers and relinquish ownership of every outstanding response. */
  stop: () => void;
};

type Action = 'initial' | 'manual' | 'resume' | 'auto';
type QueuedAction = 'manual' | 'resume' | null;

const DEFAULT_RETRY_DELAYS = [1_000, 4_000, 10_000] as const;
const DEFAULT_TIMEOUT_MS = 15_000;
const DEFAULT_MIN_VALIDITY_MS = 60_000;

function isDenied(error: unknown): boolean {
  if (!error || typeof error !== 'object') return false;
  const status = (error as { status?: unknown }).status;
  return status === 401 || status === 403 || status === 404;
}

/** Exponential/backoff link acquisition with a bounded retry policy and stale-result ownership. */
export function createLinkOpener<L extends LinkWithExpiry>(options: LinkOpeningOptions<L>): LinkOpener {
  const timeoutMs = Math.max(1, options.timeoutMs ?? DEFAULT_TIMEOUT_MS);
  const minValidityMs = Math.max(0, options.minValidityMs ?? DEFAULT_MIN_VALIDITY_MS);
  const retryDelays = options.retryDelays ?? DEFAULT_RETRY_DELAYS;
  const maxAutoRetries = Math.max(0, options.maxAutoRetries ?? retryDelays.length);
  const maxExpiryRenewals = Math.max(0, options.maxExpiryRenewals ?? 2);
  const now = options.now ?? Date.now;

  let started = false;
  let stopped = false;
  let hasFailure = false;
  let denied = false;
  let attemptSequence = 0;
  let activeAttempt: number | null = null;
  let timeoutTimer: ReturnType<typeof setTimeout> | undefined;
  let retryTimer: ReturnType<typeof setTimeout> | undefined;
  let autoRetries = 0;
  let queuedAction: QueuedAction = null;

  const clearTimeoutTimer = () => {
    if (timeoutTimer !== undefined) clearTimeout(timeoutTimer);
    timeoutTimer = undefined;
  };
  const clearRetryTimer = () => {
    if (retryTimer !== undefined) clearTimeout(retryTimer);
    retryTimer = undefined;
  };
  const notifyState = (state: LinkState) => {
    try { options.onState(state); } catch { /* a view callback cannot strand this controller */ }
  };
  const takeQueued = (): QueuedAction => {
    const action = queuedAction;
    queuedAction = null;
    return action;
  };
  const begin = (action: Action) => {
    if (stopped) return;
    clearRetryTimer();
    if (activeAttempt !== null) {
      if (action === 'manual') queuedAction = 'manual';
      else if (action === 'resume' && hasFailure && queuedAction === null) queuedAction = 'resume';
      return;
    }
    if (action === 'manual' || action === 'resume') {
      autoRetries = 0;
      denied = false;
    }
    const id = ++attemptSequence;
    activeAttempt = id;
    notifyState('opening');
    timeoutTimer = setTimeout(() => finishFailure(id, false), timeoutMs);
    requestLink(id, 0);
  };

  const finishSuccess = (id: number, link: L) => {
    if (stopped || activeAttempt !== id) return;
    clearTimeoutTimer();
    activeAttempt = null;
    hasFailure = false;
    denied = false;
    let ready = true;
    try { options.onReady(link); } catch { ready = false; }
    if (ready) {
      autoRetries = 0;
      notifyState('open');
    }
    else {
      hasFailure = true;
      notifyState('failed');
    }
    const queued = takeQueued();
    if (queued) begin(queued);
    else if (!ready) scheduleRetry();
  };

  const finishFailure = (id: number, accessDenied: boolean) => {
    if (stopped || activeAttempt !== id) return;
    clearTimeoutTimer();
    activeAttempt = null;
    hasFailure = true;
    denied = accessDenied;
    notifyState(accessDenied ? 'denied' : 'failed');
    const queued = takeQueued();
    if (queued === 'manual') begin('manual');
    else if (queued === 'resume' && !accessDenied) begin('resume');
    else if (!accessDenied) scheduleRetry();
  };

  const scheduleRetry = () => {
    if (stopped || denied || retryTimer !== undefined || autoRetries >= maxAutoRetries) return;
    const delay = retryDelays[Math.min(autoRetries, retryDelays.length - 1)];
    if (delay === undefined) return;
    autoRetries++;
    retryTimer = setTimeout(() => {
      retryTimer = undefined;
      begin('auto');
    }, Math.max(0, delay));
  };

  function requestLink(id: number, renewals: number): void {
    if (stopped || activeAttempt !== id) return;
    let promise: Promise<L>;
    try { promise = options.host.link(); }
    catch (error) { finishFailure(id, isDenied(error)); return; }
    Promise.resolve(promise).then(link => {
      if (stopped || activeAttempt !== id) return;
      const expires = link?.expires;
      if (typeof expires === 'number' && Number.isFinite(expires) && expires > 0 && expires < now() + minValidityMs) {
        if (renewals < maxExpiryRenewals) requestLink(id, renewals + 1);
        else finishFailure(id, false);
        return;
      }
      finishSuccess(id, link);
    }, error => {
      if (stopped || activeAttempt !== id) return;
      finishFailure(id, isDenied(error));
    });
  }

  return {
    start() {
      if (stopped || started) return;
      started = true;
      begin('initial');
    },
    retry() {
      if (stopped) return;
      begin('manual');
    },
    resume() {
      if (stopped || denied || !hasFailure) return;
      begin('resume');
    },
    stop() {
      if (stopped) return;
      stopped = true;
      clearRetryTimer();
      clearTimeoutTimer();
      activeAttempt = null;
      queuedAction = null;
    },
  };
}
