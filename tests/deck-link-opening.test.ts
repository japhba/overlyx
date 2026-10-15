import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createLinkOpener, type LinkState } from '../packages/client/src/deliverable/link-opening';

type Link = { base: string; expires?: number };
const flush = async () => { await Promise.resolve(); await Promise.resolve(); await Promise.resolve(); };
function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

describe('deliverable link opening', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); });

  it('opens immediately and retries a transient failure on bounded backoff', async () => {
    const states: LinkState[] = [], ready: Link[] = [];
    let calls = 0;
    const opener = createLinkOpener<Link>({
      host: { link: vi.fn(async () => {
        calls++;
        if (calls === 1) throw { status: 503 };
        return { base: '/fresh/', expires: Date.now() + 600_000 };
      }) },
      onReady: link => ready.push(link), onState: state => states.push(state),
    });

    opener.start();
    expect(calls).toBe(1);
    expect(states).toEqual(['opening']);
    await flush();
    expect(states).toEqual(['opening', 'failed']);
    await vi.advanceTimersByTimeAsync(1_000);
    expect(calls).toBe(2);
    expect(ready).toEqual([{ base: '/fresh/', expires: Date.now() + 600_000 }]);
    expect(states.at(-1)).toBe('open');
    opener.stop();
  });

  it('exhausts automatic retries, then permits a fresh manual retry', async () => {
    const states: LinkState[] = [];
    let calls = 0;
    const opener = createLinkOpener<Link>({
      host: { link: vi.fn(async () => {
        calls++;
        if (calls <= 4) throw { status: 503 };
        return { base: '/manual/', expires: Date.now() + 300_000 };
      }) },
      onReady: () => {}, onState: state => states.push(state),
    });
    opener.start(); await flush();
    await vi.advanceTimersByTimeAsync(1_000); await flush();
    await vi.advanceTimersByTimeAsync(4_000); await flush();
    await vi.advanceTimersByTimeAsync(10_000); await flush();
    expect(calls).toBe(4);
    expect(states.at(-1)).toBe('failed');
    expect(vi.getTimerCount()).toBe(0);

    opener.retry(); await flush();
    expect(calls).toBe(5);
    expect(states.at(-1)).toBe('open');
    opener.stop();
  });

  it.each([401, 403, 404])('does not auto-resume denied HTTP %i; manual retry is allowed', async status => {
    let calls = 0;
    const states: LinkState[] = [];
    const opener = createLinkOpener<Link>({
      host: { link: vi.fn(async () => {
        calls++;
        if (calls === 1) throw { status };
        return { base: '/manual/', expires: Date.now() + 300_000 };
      }) },
      onReady: () => {}, onState: state => states.push(state),
    });
    opener.start(); await flush();
    expect(states.at(-1)).toBe('denied');
    await vi.advanceTimersByTimeAsync(30_000);
    opener.resume(); await flush();
    expect(calls).toBe(1);
    opener.retry(); await flush();
    expect(calls).toBe(2);
    expect(states.at(-1)).toBe('open');
    opener.stop();
  });

  it('deduplicates starts and coalesces concurrent manual retries into one queued request', async () => {
    const first = deferred<Link>();
    let calls = 0;
    const ready: Link[] = [];
    const opener = createLinkOpener<Link>({
      host: { link: vi.fn(() => {
        calls++;
        return calls === 1 ? first.promise : Promise.resolve({ base: '/second/', expires: Date.now() + 300_000 });
      }) },
      onReady: link => ready.push(link), onState: () => {},
    });
    opener.start(); opener.start();
    opener.retry(); opener.retry(); opener.retry();
    expect(calls).toBe(1);
    first.resolve({ base: '/first/', expires: Date.now() + 300_000 });
    await flush();
    expect(calls).toBe(2);
    await flush();
    expect(ready.map(link => link.base)).toEqual(['/first/', '/second/']);
    opener.stop();
  });

  it('queues one recovery resume that arrives while a retry request is pending', async () => {
    const retryRequest = deferred<Link>();
    let calls = 0;
    const opener = createLinkOpener<Link>({
      host: { link: vi.fn(() => {
        calls++;
        if (calls === 1) return Promise.reject({ status: 503 });
        if (calls === 2) return retryRequest.promise;
        return Promise.resolve({ base: '/after-resume/', expires: Date.now() + 300_000 });
      }) },
      onReady: () => {}, onState: () => {},
      retryDelays: [1_000], maxAutoRetries: 1,
    });
    opener.start(); await flush();
    await vi.advanceTimersByTimeAsync(1_000);
    expect(calls).toBe(2);
    opener.resume(); opener.resume();
    retryRequest.reject({ status: 503 }); await flush();
    expect(calls).toBe(3);
    await flush();
    opener.stop();
  });

  it('ignores a late success after timeout when a manual attempt takes ownership', async () => {
    const late = deferred<Link>(), current = deferred<Link>();
    let calls = 0;
    const ready: Link[] = [], states: LinkState[] = [];
    const opener = createLinkOpener<Link>({
      host: { link: vi.fn(() => ++calls === 1 ? late.promise : current.promise) },
      onReady: link => ready.push(link), onState: state => states.push(state),
      timeoutMs: 100, maxAutoRetries: 0,
    });
    opener.start();
    await vi.advanceTimersByTimeAsync(100);
    expect(states.at(-1)).toBe('failed');
    opener.retry();
    late.resolve({ base: '/late/', expires: Date.now() + 300_000 });
    await flush();
    expect(ready).toEqual([]);
    current.resolve({ base: '/current/', expires: Date.now() + 300_000 });
    await flush();
    expect(ready.map(link => link.base)).toEqual(['/current/']);
    await flush();
    expect(states.at(-1)).toBe('open');
    opener.stop();
  });

  it('ignores a late rejection from an expired request after the new owner opens', async () => {
    const late = deferred<Link>();
    let calls = 0;
    const states: LinkState[] = [], ready: Link[] = [];
    const opener = createLinkOpener<Link>({
      host: { link: vi.fn(() => ++calls === 1 ? late.promise : Promise.resolve({ base: '/current/', expires: Date.now() + 300_000 })) },
      onReady: link => ready.push(link), onState: state => states.push(state),
      timeoutMs: 100, maxAutoRetries: 0,
    });
    opener.start();
    await vi.advanceTimersByTimeAsync(100);
    opener.retry(); await flush();
    expect(states.at(-1)).toBe('open');
    late.reject({ status: 503 });
    await flush();
    expect(states.at(-1)).toBe('open');
    expect(ready.map(link => link.base)).toEqual(['/current/']);
    opener.stop();
  });

  it('stop cancels retry timers and ignores late results', async () => {
    const pending = deferred<Link>();
    let calls = 0;
    const ready: Link[] = [], states: LinkState[] = [];
    const opener = createLinkOpener<Link>({
      host: { link: vi.fn(() => { calls++; return pending.promise; }) },
      onReady: link => ready.push(link), onState: state => states.push(state),
    });
    opener.start();
    opener.stop();
    expect(vi.getTimerCount()).toBe(0);
    pending.resolve({ base: '/late/', expires: Date.now() + 300_000 });
    await flush();
    opener.retry(); opener.resume();
    await vi.advanceTimersByTimeAsync(30_000);
    expect(calls).toBe(1);
    expect(ready).toEqual([]);
    expect(states).toEqual(['opening']);
  });

  it('renews a link whose remaining lifetime is under one minute', async () => {
    const ready: Link[] = [];
    let calls = 0;
    const opener = createLinkOpener<Link>({
      host: { link: vi.fn(async () => {
        calls++;
        return calls === 1
          ? { base: '/too-short/', expires: Date.now() + 59_999 }
          : { base: '/renewed/', expires: Date.now() + 60_000 };
      }) },
      onReady: link => ready.push(link), onState: () => {},
    });
    opener.start(); await flush();
    expect(calls).toBe(2);
    expect(ready.map(link => link.base)).toEqual(['/renewed/']);
    opener.stop();
  });

  it('treats a zero expiry sentinel as non-expiring', async () => {
    let calls = 0;
    const ready: Link[] = [];
    const opener = createLinkOpener<Link>({
      host: { link: vi.fn(async () => { calls++; return { base: '/no-expiry/', expires: 0 }; }) },
      onReady: link => ready.push(link), onState: () => {},
    });
    opener.start(); await flush();
    expect(calls).toBe(1);
    expect(ready.map(link => link.base)).toEqual(['/no-expiry/']);
    opener.stop();
  });

  it('bounds repeated near-expiry renewals', async () => {
    let calls = 0;
    const states: LinkState[] = [], ready: Link[] = [];
    const opener = createLinkOpener<Link>({
      host: { link: vi.fn(async () => { calls++; return { base: '/too-short/', expires: Date.now() + 1 }; }) },
      onReady: link => ready.push(link), onState: state => states.push(state),
      maxExpiryRenewals: 2, maxAutoRetries: 0,
    });
    opener.start(); await flush();
    expect(calls).toBe(3);
    expect(states.at(-1)).toBe('failed');
    expect(ready).toEqual([]);
    expect(vi.getTimerCount()).toBe(0);
    opener.stop();
  });

  it('bounds retries when the ready callback throws', async () => {
    let calls = 0;
    const states: LinkState[] = [];
    const opener = createLinkOpener<Link>({
      host: { link: vi.fn(async () => { calls++; return { base: '/callback-fails/', expires: Date.now() + 300_000 }; }) },
      onReady: () => { throw new Error('private callback failure'); }, onState: state => states.push(state),
      retryDelays: [10, 20], maxAutoRetries: 2,
    });
    opener.start(); await flush();
    expect(states.at(-1)).toBe('failed');
    await vi.advanceTimersByTimeAsync(10); await flush();
    await vi.advanceTimersByTimeAsync(20); await flush();
    expect(calls).toBe(3);
    expect(states.at(-1)).toBe('failed');
    expect(vi.getTimerCount()).toBe(0);
    opener.stop();
  });
});
