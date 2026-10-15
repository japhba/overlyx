// @vitest-environment happy-dom
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { offlineGet } from '../packages/client/src/offline-api';

const storage = globalThis.localStorage;
const META_URL = '/api/docs/example%2Fstudy%2Fslides%2Findex.html/meta';
const LINK_URL = '/api/projects/example%2Fstudy/deliverable-link?path=slides%2Findex.html';
const viewer = { id: 'example/study/slides/index.html', project: 'example/study', path: 'slides/index.html', role: 'view', textclass: 'article', modules: [], language: 'english' };
const protectedLink = { base: '/d/FAKE_OFFLINE_VIEW_TOKEN/slides/', entry: 'index.html', expires: 1900000000 };

/** Only the CacheStorage methods this boundary uses; stored bodies are real
 * Responses and every read is cloned, just as browser Cache.match behaves. */
function cacheStorage() {
  const buckets = new Map<string, { responses: Map<string, Response>; put: ReturnType<typeof vi.fn>; match: ReturnType<typeof vi.fn> }>();
  const open = vi.fn(async (name: string) => {
    let cache = buckets.get(name);
    if (!cache) {
      const responses = new Map<string, Response>();
      cache = {
        responses,
        put: vi.fn(async (url: string, response: Response) => { responses.set(url, response.clone()); }),
        match: vi.fn(async (url: string) => responses.get(url)?.clone()),
      };
      buckets.set(name, cache);
    }
    return cache as unknown as Cache;
  });
  return { open, buckets };
}

let cache: ReturnType<typeof cacheStorage>;
const signIn = (id: number) => storage.setItem('ol.user', JSON.stringify({ id, username: `fictional-${id}` }));
const failedLoad = (error: unknown) => vi.fn(async () => { throw error; });

beforeEach(() => {
  vi.unstubAllGlobals(); storage.clear();
  cache = cacheStorage();
  vi.stubGlobal('caches', cache as unknown as CacheStorage);
  signIn(101);
});
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); storage.clear(); });

it('persists successful metadata and protected links before service-worker control and reopens their exact viewer values on transport failure', async () => {
  vi.stubGlobal('navigator', { serviceWorker: { controller: null } });
  expect(navigator.serviceWorker.controller).toBeNull();
  expect(await offlineGet(META_URL, async () => viewer)).toBe(viewer);
  expect(await offlineGet(LINK_URL, async () => protectedLink)).toBe(protectedLink);
  expect([...cache.buckets.keys()]).toEqual(['overlyx-api-user-101']);
  const bucket = cache.buckets.get('overlyx-api-user-101')!;
  const stored = bucket.responses.get(META_URL)!;
  expect(stored).toBeInstanceOf(Response);
  expect(stored.headers.get('content-type')).toBe('application/json');
  expect(await stored.clone().json()).toEqual(viewer);
  const networkError = new TypeError('Offline transport');
  expect(await offlineGet(META_URL, failedLoad(networkError))).toEqual(viewer);
  expect(await offlineGet(LINK_URL, failedLoad(networkError))).toEqual(protectedLink);
  // Cache bodies remain reusable after earlier reads.
  expect(await offlineGet(META_URL, failedLoad(networkError))).toEqual(viewer);
});

it('replaces older editor metadata with the latest known viewer role before offline reopen', async () => {
  await offlineGet(META_URL, async () => ({ ...viewer, role: 'edit' }));
  await offlineGet(META_URL, async () => viewer);
  const reopened = await offlineGet(META_URL, failedLoad(new TypeError('Offline transport')));
  expect(reopened).toEqual(viewer);
  expect((reopened as typeof viewer).role).toBe('view');
});

it.each([401, 403, 404, 500, 502, 503])('preserves HTTP %i errors despite a cached protected response', async status => {
  await offlineGet(META_URL, async () => viewer);
  await offlineGet(LINK_URL, async () => protectedLink);
  const error = Object.assign(new Error(`HTTP ${status}`), { status });
  await expect(offlineGet(META_URL, failedLoad(error))).rejects.toBe(error);
  await expect(offlineGet(LINK_URL, failedLoad(error))).rejects.toBe(error);
  expect(cache.buckets.get('overlyx-api-user-101')!.match).not.toHaveBeenCalled();
});

it('separates account metadata and protected tokens and exposes no prior account cache after sign-out', async () => {
  await offlineGet(META_URL, async () => viewer);
  await offlineGet(LINK_URL, async () => protectedLink);
  signIn(202);
  const offline = new TypeError('Offline transport');
  await expect(offlineGet(META_URL, failedLoad(offline))).rejects.toBe(offline);
  await expect(offlineGet(LINK_URL, failedLoad(offline))).rejects.toBe(offline);
  const otherMeta = { ...viewer, role: 'owner' };
  const otherLink = { ...protectedLink, base: '/d/FAKE_OFFLINE_OTHER_TOKEN/slides/' };
  await offlineGet(META_URL, async () => otherMeta);
  await offlineGet(LINK_URL, async () => otherLink);
  expect(await offlineGet(META_URL, failedLoad(offline))).toEqual(otherMeta);
  expect(await offlineGet(LINK_URL, failedLoad(offline))).toEqual(otherLink);
  signIn(101);
  expect(await offlineGet(META_URL, failedLoad(offline))).toEqual(viewer);
  expect(await offlineGet(LINK_URL, failedLoad(offline))).toEqual(protectedLink);
  expect([...cache.buckets.keys()]).toEqual(['overlyx-api-user-101', 'overlyx-api-user-202']);
  storage.removeItem('ol.user');
  await expect(offlineGet(META_URL, failedLoad(offline))).rejects.toBe(offline);
  await expect(offlineGet(LINK_URL, failedLoad(offline))).rejects.toBe(offline);
  expect(cache.buckets.size).toBe(2);
});

it('keeps online requests working when local storage is unavailable and preserves a subsequent transport failure', async () => {
  vi.stubGlobal('localStorage', { getItem: () => { throw new DOMException('Storage unavailable', 'SecurityError'); } });
  const load = vi.fn(async () => viewer);
  expect(await offlineGet(META_URL, load)).toBe(viewer);
  expect(load).toHaveBeenCalledTimes(1);
  expect(cache.open).not.toHaveBeenCalled();
  const offline = new TypeError('Offline transport');
  await expect(offlineGet(META_URL, failedLoad(offline))).rejects.toBe(offline);
});

it('keeps online requests working without CacheStorage', async () => {
  vi.stubGlobal('caches', undefined);
  expect(await offlineGet(META_URL, async () => viewer)).toBe(viewer);
  const offline = new TypeError('Offline transport');
  await expect(offlineGet(META_URL, failedLoad(offline))).rejects.toBe(offline);
});

it('does not reject a successful request when the optional cache write fails', async () => {
  const bucket = await cache.open('overlyx-api-user-101');
  vi.mocked(bucket.put).mockRejectedValue(new DOMException('Quota exhausted', 'QuotaExceededError'));
  const load = vi.fn(async () => protectedLink);
  expect(await offlineGet(LINK_URL, load)).toBe(protectedLink);
  expect(load).toHaveBeenCalledTimes(1);
  expect(cache.buckets.get('overlyx-api-user-101')!.responses.size).toBe(0);
});

it('preserves the original transport error when the optional cached read fails', async () => {
  await offlineGet(META_URL, async () => viewer);
  cache.buckets.get('overlyx-api-user-101')!.match.mockRejectedValue(new Error('Cache unavailable'));
  const offline = new TypeError('Offline transport');
  await expect(offlineGet(META_URL, failedLoad(offline))).rejects.toBe(offline);
});


function deferred<T>() {
  let resolve!: (value: T) => void, reject!: (error: unknown) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

for (const change of ['switch', 'logout'] as const) {
  const changeAccount = () => change === 'switch' ? signIn(202) : storage.removeItem('ol.user');
  it(`does not cache an earlier account response after ${change} during a pending request`, async () => {
    await offlineGet(LINK_URL, async () => protectedLink);
    const pending = deferred<typeof protectedLink>(), started = deferred<void>();
    const request = offlineGet(LINK_URL, async () => { started.resolve(); return pending.promise; });
    await started.promise;
    changeAccount();
    const later = { ...protectedLink, base: '/d/FAKE_LATE_RESPONSE_TOKEN/slides/' };
    pending.resolve(later);
    expect(await request).toBe(later);
    expect(await cache.buckets.get('overlyx-api-user-101')!.responses.get(LINK_URL)!.clone().json()).toEqual(protectedLink);
    expect(cache.buckets.has('overlyx-api-user-202')).toBe(false);
  });
  it(`does not recover an earlier account cache after ${change} during a pending transport request`, async () => {
    await offlineGet(META_URL, async () => viewer);
    const pending = deferred<typeof viewer>(), started = deferred<void>();
    const request = offlineGet(META_URL, async () => { started.resolve(); return pending.promise; });
    await started.promise;
    changeAccount();
    const offline = new TypeError('Offline transport');
    pending.reject(offline);
    await expect(request).rejects.toBe(offline);
    expect(cache.buckets.get('overlyx-api-user-101')!.match).not.toHaveBeenCalled();
  });
}

it('does not return earlier account data when identity changes during an awaited cached read', async () => {
  await offlineGet(META_URL, async () => viewer);
  const hit = deferred<Response>(), reading = deferred<void>();
  cache.buckets.get('overlyx-api-user-101')!.match.mockImplementation(async () => { reading.resolve(); return hit.promise; });
  const offline = new TypeError('Offline transport');
  const request = offlineGet(META_URL, failedLoad(offline));
  await reading.promise;
  signIn(202);
  hit.resolve(new Response(JSON.stringify(viewer), { headers: { 'content-type': 'application/json' } }));
  await expect(request).rejects.toBe(offline);
});
