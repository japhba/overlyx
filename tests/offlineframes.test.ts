// @vitest-environment happy-dom
// @vitest-environment-options {"settings":{"disableCSSFileLoading":true,"disableJavaScriptFileLoading":true,"handleDisabledFileLoadingAsSuccess":true}}
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { runtimeTags, injectRuntime, SANDBOX_CSP } from '../packages/core/src/html/serve';

const storage = globalThis.localStorage;
const BASE = '/d/FAKE_FRAME_TOKEN/slides/';
const abs = (value: string) => new URL(value, location.origin).href;
const asset = (name: string) => abs(BASE + name);
const ENTRY = () => asset('index.html') + '?ol=edit';
const MANIFEST = { version: 'fake-runtime-v1', files: ['/_ol/runtime.js', '/_ol/mathjax/tex-svg.js'] };
const served = (source: string) => injectRuntime(source, runtimeTags('edit', { source, project: 'fictional/study', refs: {} }));
const page = (body: string, head = '') => `<!doctype html><html><head>${head}</head><body>${body}</body></html>`;
const response = (body: string, type = 'text/html', status = 200) => new Response(body, { status, headers: { 'content-type': type } });
const json = (value: unknown) => response(JSON.stringify(value), 'application/json');
const offline = () => new TypeError('Offline transport');
function deferred<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>(yes => { resolve = yes; }); return { promise, resolve }; }
function fakeStorage() {
  const buckets = new Map<string, { values: Map<string, Response>; put: ReturnType<typeof vi.fn>; match: ReturnType<typeof vi.fn> }>();
  const open = vi.fn(async (name: string) => {
    let cache = buckets.get(name);
    if (!cache) {
      const values = new Map<string, Response>();
      cache = { values, put: vi.fn(async (url: string, value: Response) => { values.set(String(url), value.clone()); }), match: vi.fn(async (url: string) => values.get(String(url))?.clone()) };
      buckets.set(name, cache);
    }
    return cache as unknown as Cache;
  });
  return { buckets, open };
}
let cache: ReturnType<typeof fakeStorage>;
let fetcher: ReturnType<typeof vi.fn>;
let routes: Map<string, Response | (() => Promise<Response>)>;
const frames: { destroy(): void }[] = [];
beforeEach(() => {
  vi.unstubAllGlobals(); vi.resetModules(); storage.clear();
  storage.setItem('ol.user', JSON.stringify({ id: 101 }));
  cache = fakeStorage(); routes = new Map();
  vi.stubGlobal('caches', cache as unknown as CacheStorage);
  fetcher = vi.fn(async (input: RequestInfo | URL) => {
    const url = abs(String(input)), value = routes.get(url);
    if (!value) throw offline();
    return typeof value === 'function' ? value() : value.clone();
  });
  vi.stubGlobal('fetch', fetcher);
});
afterEach(() => { frames.splice(0).forEach(frame => frame.destroy()); vi.restoreAllMocks(); vi.unstubAllGlobals(); storage.clear(); });
async function cachedRuntime() {
  await (await cache.open('overlyx-runtime-manifest')).put(abs('/_ol/offline.json'), json(MANIFEST));
  const runtime = await cache.open('overlyx-runtime-' + MANIFEST.version);
  await runtime.put(abs('/_ol/runtime.js'), response('window.FAKE_RUNTIME=true;', 'text/javascript'));
  await runtime.put(abs('/_ol/mathjax/tex-svg.js'), response('window.FAKE_MATH=true;', 'text/javascript'));
}
async function cachedPage(source = page('<p>Older served text</p>')) {
  await (await cache.open('overlyx-api-user-101')).put(ENTRY(), json(served(source)));
}
async function factory(source: () => string, link = { base: BASE, entry: 'index.html' }) {
  const { offlineFrames } = await import('../packages/client/src/deliverable/offlineframes');
  const getLink = vi.fn(async () => link);
  const frame = offlineFrames(101, source, getLink); frames.push(frame);
  return { frame, getLink };
}
function parsed(html: string) { return new DOMParser().parseFromString(html, 'text/html'); }
function config(doc: Document) { return JSON.parse(doc.querySelector('script[data-ol-runtime]:not([src])')!.textContent!.replace(/^window\.__OL=/, '')); }
const cssText = (data: string) => decodeURIComponent(data.slice(data.indexOf(',') + 1));

it('cold offline startup renders the latest canonical text and embeds runtime data without changing raw source', async () => {
  await cachedPage(); await cachedRuntime();
  await (await cache.open('overlyx-api-user-101')).put(asset('photo.png'), response('FAKE_IMAGE', 'image/png'));
  let canonical = page('<p>Latest locally edited text</p><img src="photo.png">');
  const { frame } = await factory(() => canonical);
  const output = await frame.frame('edit');
  expect(output).toEqual(expect.any(String));
  const doc = parsed(output!), cfg = config(doc);
  expect(doc.body.textContent).toContain('Latest locally edited text');
  expect(doc.body.textContent).not.toContain('Older served text');
  expect(doc.querySelector('img')!.getAttribute('src')).toMatch(/^data:image\/png;base64,/);
  expect(doc.querySelector('script[data-ol-runtime][src]')!.getAttribute('src')).toMatch(/^data:text\/javascript/);
  expect(cfg.source).toBe(canonical); expect(cfg.mode).toBe('edit');
  expect(cfg.runtimeBase).toBe(abs('/_ol/'));
  expect(cfg.assetUrls[abs('/_ol/mathjax/tex-svg.js')]).toMatch(/^data:text\/javascript/);
  expect(SANDBOX_CSP).not.toContain('allow-same-origin');
  canonical = page('<p>Another local edit</p><img src="photo.png">');
  const thumb = config(parsed((await frame.frame('thumb'))!));
  expect(thumb.source).toBe(canonical);
  expect(thumb.mode).toBe('thumb');
  expect(config(parsed((await frame.frame('present'))!)).mode).toBe('present');
  expect(canonical).not.toContain('data:');
});

it('does not acquire links through background synchronization before a successful opening, including after an authoritative denial', async () => {
  const { offlineFrames } = await import('../packages/client/src/deliverable/offlineframes');
  const getLink = vi.fn(async () => { throw Object.assign(new Error('Denied'), { status: 403 }); });
  const frame = offlineFrames(101, () => page('<p>Locally synchronized text</p>'), getLink);
  frames.push(frame);
  frame.changed();
  await new Promise(resolve => setTimeout(resolve, 650));
  expect(getLink).not.toHaveBeenCalled();
  await expect(frame.frame('edit')).rejects.toMatchObject({ status: 403 });
  frame.changed(true);
  await new Promise(resolve => setTimeout(resolve, 650));
  expect(getLink).toHaveBeenCalledTimes(1);
});

it('preserves an authored relative HTML base and caches its resources inside the same signed project', async () => {
  await cachedRuntime();
  const link = { base: '/ol-d/FAKE_PROJECT_TOKEN/', entry: 'slides/index.html' };
  const canonical = page('<img src="photo.png">', '<base href="../common/">');
  const privateCache = await cache.open('overlyx-api-user-101');
  await privateCache.put(abs(link.base + link.entry + '?ol=edit'), json(served(canonical)));
  const photo = abs(link.base + 'common/photo.png');
  await privateCache.put(photo, response('CACHED_PHOTO', 'image/png'));
  const { frame } = await factory(() => canonical, link);
  const doc = parsed((await frame.frame('edit'))!);
  expect(doc.querySelectorAll('base')).toHaveLength(1);
  expect(doc.querySelector('base')!.getAttribute('href')).toBe(abs(link.base + 'common/'));
  expect(doc.querySelector('img')!.getAttribute('src')).toMatch(/^data:image\/png;base64,/);
  expect(config(doc).source).toBe(canonical);
  expect(fetcher.mock.calls.some(call => abs(String(call[0])) === photo)).toBe(true);
});

it('preserves an authored API or external HTML base without fetching those private resources through the parent', async () => {
  await cachedRuntime(); await cachedPage();
  for (const base of ['/api/', 'https://external.invalid/images/']) {
    const canonical = page('<img src="auth/me">', `<base href="${base}">`);
    const { frame } = await factory(() => canonical);
    const doc = parsed((await frame.frame('edit'))!);
    expect(doc.querySelector('base')!.getAttribute('href')).toBe(abs(base));
    expect(doc.querySelector('img')!.getAttribute('src')).toBe('auth/me');
    expect(config(doc).source).toBe(canonical);
  }
  expect(fetcher.mock.calls.some(call => /\/api\/|external\.invalid/.test(String(call[0])))).toBe(false);
});

it('loads shared image dependencies once, maps srcset and quoted CSS imports, and terminates CSS cycles', async () => {
  await cachedPage(); await cachedRuntime();
  routes.set(asset('a.css'), response('@import "b.css" screen;.a{background:url(shared.png)}', 'text/css'));
  routes.set(asset('b.css'), response('@import url("a.css");.b{background:url(shared.png)}', 'text/css'));
  for (const name of ['shared.png', 'large.png']) routes.set(asset(name), response('FAKE_IMAGE_' + name, 'image/png'));
  const canonical = page('<picture><source srcset="shared.png 1x, large.png 2x"><img src="shared.png"></picture>', '<link rel="stylesheet" href="a.css"><link rel="stylesheet" href="b.css">');
  const { frame, getLink } = await factory(() => canonical);
  const [first, second] = await Promise.all([frame.resources(), frame.resources()]);
  expect(first).toBe(second); expect(getLink).toHaveBeenCalledTimes(1);
  expect(cssText(first[asset('a.css')])).toContain(first[asset('b.css')]);
  expect(cssText(first[asset('a.css')])).toContain(first[asset('shared.png')]);
  expect(cssText(first[asset('b.css')])).toContain('data:text/css,');
  expect(cssText(first[asset('b.css')])).not.toContain('a.css');
  for (const name of ['a.css', 'b.css', 'shared.png', 'large.png']) expect(fetcher.mock.calls.filter(call => abs(String(call[0])) === asset(name))).toHaveLength(1);
  const doc = parsed((await frame.frame('edit'))!);
  expect(doc.querySelector('source')!.getAttribute('srcset')).toBe(`${first[asset('shared.png')]} 1x, ${first[asset('large.png')]} 2x`);
});

it('opens an editable offline page despite one missing optional image and preserves other cached resources', async () => {
  await cachedPage(); await cachedRuntime();
  routes.set(asset('missing.png'), response('Missing', 'text/plain', 404));
  routes.set(asset('good.png'), response('GOOD_IMAGE', 'image/png'));
  const { frame } = await factory(() => page('<p>Still editable</p><img src="missing.png"><img src="good.png">'));
  const doc = parsed((await frame.frame('edit'))!);
  expect(config(doc).mode).toBe('edit');
  expect(doc.body.textContent).toContain('Still editable');
  expect([...doc.querySelectorAll('img')].map(img => img.getAttribute('src'))).toEqual(['missing.png', expect.stringMatching(/^data:image\/png;base64,/)]);
});

it.each([401, 403])('propagates private asset HTTP %i without returning an older cached protected image', async status => {
  await cachedRuntime();
  const source = page('<img src="protected.png">');
  routes.set(ENTRY(), response(served(source)));
  routes.set(asset('protected.png'), response('Denied', 'text/plain', status));
  await (await cache.open('overlyx-api-user-101')).put(asset('protected.png'), response('OLD_PROTECTED', 'image/png'));
  const { frame } = await factory(() => source);
  await expect(frame.frame('edit')).rejects.toMatchObject({ status });
  expect(cache.buckets.get('overlyx-api-user-101')!.match.mock.calls.filter(call => call[0] === asset('protected.png'))).toHaveLength(0);
});

it('does not make authenticated parent fetches for imported API, foreign-folder, or external URLs', async () => {
  await cachedPage(); await cachedRuntime();
  routes.set(asset('allowed.png'), response('ALLOWED', 'image/png'));
  const forbidden = ['/api/auth/me', '/d/OTHER_FRAME_TOKEN/slides/foreign.png', 'https://outside.invalid/image.png'];
  const source = page('<img src="../../../api/auth/me"><img src="/d/OTHER_FRAME_TOKEN/slides/foreign.png"><img src="https://outside.invalid/image.png"><img src="allowed.png">', '<style>@import "https://outside.invalid/style.css";body{background:url(/api/private)}</style>');
  const { frame } = await factory(() => source);
  await frame.frame('edit');
  const requests = fetcher.mock.calls.map(call => abs(String(call[0])));
  for (const url of [...forbidden, '/api/private', 'https://outside.invalid/style.css']) expect(requests).not.toContain(abs(url));
  expect(requests).toContain(asset('allowed.png'));
});

it.each(['switch', 'logout'])('rejects a pending private image response after account %s and does not cache it', async change => {
  await cachedPage(); await cachedRuntime();
  const pending = deferred<Response>(), requested = deferred<void>();
  routes.set(asset('slow.png'), async () => { requested.resolve(); return pending.promise; });
  const { frame } = await factory(() => page('<img src="slow.png">'));
  const request = frame.frame('edit'); await requested.promise;
  if (change === 'switch') storage.setItem('ol.user', JSON.stringify({ id: 202 })); else storage.removeItem('ol.user');
  pending.resolve(response('PRIVATE_LATE', 'image/png'));
  await expect(request).rejects.toMatchObject({ status: 401 });
  expect(cache.buckets.get('overlyx-api-user-101')!.values.has(asset('slow.png'))).toBe(false);
  expect(cache.buckets.has('overlyx-api-user-202')).toBe(false);
});

it('rejects earlier account content when logout occurs during a pending private cached read', async () => {
  await cachedPage(); await cachedRuntime();
  const cacheHit = deferred<Response>(), reading = deferred<void>();
  const bucket = cache.buckets.get('overlyx-api-user-101')!;
  const match = bucket.match.getMockImplementation()!;
  bucket.match.mockImplementation(async (url: string) => { if (url === asset('slow.png')) { reading.resolve(); return cacheHit.promise; } return match(url); });
  const { frame } = await factory(() => page('<img src="slow.png">'));
  const request = frame.frame('edit'); await reading.promise;
  storage.removeItem('ol.user'); cacheHit.resolve(response('PRIVATE_CACHED', 'image/png'));
  await expect(request).rejects.toMatchObject({ status: 401 });
});

it('directly warms the runtime manifest before worker control and uses it during a later cold offline reopen', async () => {
  vi.stubGlobal('navigator', { serviceWorker: { controller: null } });
  const source = page('<p>Original online text</p>');
  routes.set(ENTRY(), response(served(source)));
  routes.set(abs('/_ol/offline.json'), json(MANIFEST));
  routes.set(abs('/_ol/runtime.js'), response('window.FAKE_RUNTIME=true;', 'text/javascript'));
  routes.set(abs('/_ol/mathjax/tex-svg.js'), response('window.FAKE_MATH=true;', 'text/javascript'));
  const online = await factory(() => source);
  expect(await online.frame.frame('edit')).toBeNull();
  expect(cache.buckets.get('overlyx-runtime-manifest')!.values.has(abs('/_ol/offline.json'))).toBe(true);
  online.frame.destroy(); routes.clear(); vi.resetModules();
  const local = page('<p>Cached local draft</p>'), reopened = await factory(() => local);
  const doc = parsed((await reopened.frame.frame('edit'))!);
  expect(doc.body.textContent).toBe('Cached local draft');
  expect(config(doc).source).toBe(local);
  expect(doc.querySelector('script[data-ol-runtime][src]')!.getAttribute('src')).toMatch(/^data:text\/javascript/);
});

it('keeps an online frame available when optional cache writes exceed quota', async () => {
  const source = page('<img src="photo.png">');
  routes.set(ENTRY(), response(served(source)));
  routes.set(abs('/_ol/offline.json'), json(MANIFEST));
  routes.set(abs('/_ol/runtime.js'), response('runtime();', 'text/javascript'));
  routes.set(abs('/_ol/mathjax/tex-svg.js'), response('math();', 'text/javascript'));
  routes.set(asset('photo.png'), response('NEW_IMAGE', 'image/png'));
  for (const name of ['overlyx-api-user-101', 'overlyx-runtime-manifest', 'overlyx-runtime-' + MANIFEST.version]) {
    const bucket = await cache.open(name); vi.mocked(bucket.put).mockRejectedValue(new DOMException('Quota exceeded', 'QuotaExceededError'));
  }
  const { frame } = await factory(() => source);
  expect(await frame.frame('edit')).toBeNull();
  expect((await frame.resources())[asset('photo.png')]).toMatch(/^data:image\/png;base64,/);
});

it('refreshes a same-URL private image online instead of always returning an older cached body', async () => {
  await cachedRuntime();
  const source = page('<img src="photo.png">');
  routes.set(ENTRY(), response(served(source)));
  routes.set(asset('photo.png'), response('NEW_IMAGE', 'image/png'));
  await (await cache.open('overlyx-api-user-101')).put(asset('photo.png'), response('OLD_IMAGE', 'image/png'));
  const { frame } = await factory(() => source);
  expect(await frame.frame('edit')).toBeNull();
  expect(await cache.buckets.get('overlyx-api-user-101')!.values.get(asset('photo.png'))!.clone().text()).toBe('NEW_IMAGE');
  const mapped = (await frame.resources())[asset('photo.png')];
  expect(atob(mapped.slice(mapped.indexOf(',') + 1))).toBe('NEW_IMAGE');
});

it.each([200, 404])('retains a fresh capability when an older prepared request completes later with HTTP %i', async status => {
  await cachedRuntime();
  const source = page('<img src="photo.png">'), old = deferred<Response>(), started = deferred<void>();
  routes.set(ENTRY(), async () => { started.resolve(); return old.promise; });
  routes.set(asset('photo.png'), response('OLD_CAPABILITY_IMAGE', 'image/png'));
  const freshBase = '/d/FAKE_FRESH_FRAME_TOKEN/slides/', freshImage = abs(freshBase + 'photo.png');
  routes.set(abs(freshBase + 'index.html') + '?ol=edit', response(served(source)));
  routes.set(freshImage, response('FRESH_CAPABILITY_IMAGE', 'image/png'));
  const { frame, getLink } = await factory(() => source);
  const stale = frame.frame('edit', { base: BASE, entry: 'index.html' }).then(value => ({ value }), error => ({ error }));
  await started.promise;
  expect(await frame.frame('edit', { base: freshBase, entry: 'index.html' })).toBeNull();
  const current = await frame.resources();
  expect(current[freshImage]).toMatch(/^data:image\/png;base64,/);
  old.resolve(response(status === 200 ? served(source) : 'Old capability gone', 'text/html', status));
  const outcome = await stale;
  if (status === 200) expect(outcome).toEqual({ value: null });
  else expect(outcome).toMatchObject({ error: { status } });
  expect(await frame.resources()).toBe(current);
  expect((await frame.resources())[asset('photo.png')]).toBeUndefined();
  expect(getLink).not.toHaveBeenCalled();
});

it('resolves cached images and CSS relative to a nested document entry within a project-root capability', async () => {
  await cachedRuntime();
  const projectBase = '/ol-d/FAKE_PROJECT_TOKEN/', entry = 'slides/index.html';
  const documentFolder = abs(projectBase + 'slides/'), imageUrl = abs(projectBase + 'slides/images/foo.png');
  const canonical = page('<p>Nested local draft</p><img src="images/foo.png">', '<style>.hero{background:url(images/foo.png)}</style>');
  const bucket = await cache.open('overlyx-api-user-101');
  await bucket.put(abs(projectBase + entry) + '?ol=edit', json(served(page('<p>Older nested page</p>'))));
  await bucket.put(imageUrl, response('NESTED_CACHED_IMAGE', 'image/png'));
  const { frame, getLink } = await factory(() => canonical, { base: projectBase, entry });
  const output = await frame.frame('edit');
  expect(getLink).toHaveBeenCalledTimes(1);
  const requests = fetcher.mock.calls.map(call => abs(String(call[0])));
  expect(requests, JSON.stringify(requests)).toContain(imageUrl);
  expect(requests).not.toContain(abs(projectBase + 'images/foo.png'));
  const doc = parsed(output!);
  expect(doc.querySelector('base[data-ol-runtime]')!.getAttribute('href')).toBe(documentFolder);
  const mapped = doc.querySelector('img')!.getAttribute('src')!;
  expect(mapped).toMatch(/^data:image\/png;base64,/);
  expect(atob(mapped.slice(mapped.indexOf(',') + 1))).toBe('NESTED_CACHED_IMAGE');
  expect(doc.querySelector('style')!.textContent).toContain(mapped);
  expect(config(doc).source).toBe(canonical);
  expect(canonical).toContain('src="images/foo.png"');
});

it('allows nested-entry sibling assets within the same project while refusing API and other capability paths', async () => {
  await cachedRuntime();
  const projectBase = '/ol-d/FAKE_PROJECT_TOKEN/', entry = 'slides/index.html';
  const siblingUrl = abs(projectBase + 'figures/chart.svg');
  const canonical = page('<img src="../figures/chart.svg"><img src="../../../api/private"><img src="/ol-d/FOREIGN_PROJECT_TOKEN/figures/private.svg"><img src="https://outside.invalid/private.svg">');
  const bucket = await cache.open('overlyx-api-user-101');
  await bucket.put(abs(projectBase + entry) + '?ol=edit', json(served(canonical)));
  await bucket.put(siblingUrl, response('<svg>FAKE_SIBLING_CHART</svg>', 'image/svg+xml'));
  const { frame, getLink } = await factory(() => canonical, { base: projectBase, entry });
  const doc = parsed((await frame.frame('edit'))!);
  expect(getLink).toHaveBeenCalledTimes(1);
  const requests = fetcher.mock.calls.map(call => abs(String(call[0])));
  expect(requests, JSON.stringify(requests)).toContain(siblingUrl);
  for (const url of ['/api/private', '/ol-d/FOREIGN_PROJECT_TOKEN/figures/private.svg', 'https://outside.invalid/private.svg']) expect(requests).not.toContain(abs(url));
  expect(doc.querySelector('img')!.getAttribute('src')).toMatch(/^data:image\/svg\+xml;base64,/);
  expect([...doc.querySelectorAll('img')].slice(1).map(img => img.getAttribute('src'))).toEqual(['../../../api/private', '/ol-d/FOREIGN_PROJECT_TOKEN/figures/private.svg', 'https://outside.invalid/private.svg']);
  expect(config(doc).source).toBe(canonical);
});

it('keeps an uploaded image after an immediate network cut before any warm debounce runs', async () => {
  await cachedRuntime();
  const projectBase = '/ol-d/FAKE_UPLOAD_PROJECT/', entry = 'slides/index.html';
  let canonical = page('<p>Before upload</p>');
  routes.set(abs(projectBase + entry) + '?ol=edit', response(served(canonical)));
  const { frame } = await factory(() => canonical, { base: projectBase, entry });
  expect(await frame.frame('edit')).toBeNull();
  const notify = vi.fn(); frame.onResources(notify);
  const blob = new Blob(['UPLOADED_IMAGE'], { type: 'image/png' });
  await frame.uploaded('slides/images/new image.png', blob);
  expect(canonical).toBe(page('<p>Before upload</p>'));
  const uploadedUrl = abs(projectBase + 'slides/images/new%20image.png');
  expect(await cache.buckets.get('overlyx-api-user-101')!.values.get(uploadedUrl)!.clone().text()).toBe('UPLOADED_IMAGE');
  expect(notify).toHaveBeenCalledTimes(1);
  expect(notify.mock.calls[0][0][uploadedUrl]).toMatch(/^data:image\/png;base64,/);
  canonical = page('<p>After upload</p><img src="images/new image.png">');
  routes.clear(); frame.disconnected();
  const doc = parsed((await frame.frame('edit'))!);
  const mapped = doc.querySelector('img')!.getAttribute('src')!;
  expect(atob(mapped.slice(mapped.indexOf(',') + 1))).toBe('UPLOADED_IMAGE');
  expect(config(doc).source).toBe(canonical);
});

it('retains an uploaded image in the active asset map when optional cache storage is full', async () => {
  await cachedPage(); await cachedRuntime();
  const { frame } = await factory(() => page('<p>Upload available</p>'));
  await frame.frame('edit');
  cache.buckets.get('overlyx-api-user-101')!.put.mockRejectedValue(new DOMException('Quota exceeded', 'QuotaExceededError'));
  const notify = vi.fn(); frame.onResources(notify);
  await expect(frame.uploaded('photo.png', new Blob(['UPLOADED_IMAGE'], { type: 'image/png' }))).resolves.toBeUndefined();
  expect((await frame.resources())[asset('photo.png')]).toMatch(/^data:image\/png;base64,/);
  expect(notify).toHaveBeenCalledTimes(1);
  expect(cache.buckets.get('overlyx-api-user-101')!.values.has(asset('photo.png'))).toBe(false);
});

it('does not write or publish an uploaded image if the account switches during cache opening', async () => {
  await cachedPage(); await cachedRuntime();
  const { frame } = await factory(() => page('<p>Pending upload</p>'));
  await frame.frame('edit');
  const bucket = await cache.open('overlyx-api-user-101'), waiting = deferred<Cache>(), opening = deferred<void>();
  const originalOpen = cache.open.getMockImplementation()!;
  cache.open.mockImplementation(async name => { if (name === 'overlyx-api-user-101') { opening.resolve(); return waiting.promise; } return originalOpen(name); });
  const notify = vi.fn(); frame.onResources(notify);
  const upload = frame.uploaded('photo.png', new Blob(['PRIVATE_UPLOAD'], { type: 'image/png' }));
  await opening.promise; storage.setItem('ol.user', JSON.stringify({ id: 202 })); waiting.resolve(bucket);
  await expect(upload).rejects.toMatchObject({ status: 401 });
  expect(cache.buckets.get('overlyx-api-user-101')!.values.has(asset('photo.png'))).toBe(false);
  expect(notify).not.toHaveBeenCalled();
});

it('does not let a late uploaded-image task overwrite assets for a newer capability generation', async () => {
  await cachedRuntime();
  const source = page('<img src="photo.png">');
  routes.set(ENTRY(), response(served(source))); routes.set(asset('photo.png'), response('OLDER_IMAGE', 'image/png'));
  const { frame } = await factory(() => source); await frame.frame('edit');
  const bucket = await cache.open('overlyx-api-user-101'), waiting = deferred<Cache>(), opening = deferred<void>();
  const originalOpen = cache.open.getMockImplementation()!;
  let delayFirst = true;
  cache.open.mockImplementation(async name => { if (name === 'overlyx-api-user-101' && delayFirst) { delayFirst = false; opening.resolve(); return waiting.promise; } return originalOpen(name); });
  const notify = vi.fn(); frame.onResources(notify);
  const upload = frame.uploaded('late.png', new Blob(['OLD_CAP_UPLOAD'], { type: 'image/png' }));
  await opening.promise;
  const freshBase = '/d/FAKE_UPLOAD_NEW_CAP/slides/', freshImage = abs(freshBase + 'photo.png');
  routes.set(abs(freshBase + 'index.html') + '?ol=edit', response(served(source)));
  routes.set(freshImage, response('FRESH_IMAGE', 'image/png'));
  expect(await frame.frame('edit', { base: freshBase, entry: 'index.html' })).toBeNull();
  const current = await frame.resources();
  waiting.resolve(bucket); await upload;
  expect(await frame.resources()).toBe(current);
  expect(current[asset('late.png')]).toBeUndefined();
  expect(current[freshImage]).toMatch(/^data:image\/png;base64,/);
  expect(notify).not.toHaveBeenCalled();
});
