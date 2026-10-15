/** Exercise the actual worker across deployments with real cached Responses. */
import { expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';

const origin = 'https://fictional-app.invalid';
const absolute = (value: string | { url: string }) => new URL(typeof value === 'string' ? value : value.url, origin).href;
const response = (body: string, type = 'text/javascript', status = 200) => new Response(body, { status, headers: { 'content-type': type } });

function storage() {
  const buckets = new Map<string, ReturnType<typeof bucket>>();
  function bucket() {
    const data = new Map<string, Response>();
    return {
      data,
      match: vi.fn(async (req: string | Request, options?: { ignoreSearch?: boolean }) => {
        const key = absolute(req);
        if (!options?.ignoreSearch) return data.get(key)?.clone();
        return [...data].find(([stored]) => new URL(stored).pathname === new URL(key).pathname)?.[1].clone();
      }),
      put: vi.fn(async (req: string | Request, res: Response) => { data.set(absolute(req), res.clone()); }),
      keys: vi.fn(async () => [...data.keys()].map(url => new Request(url))),
    };
  }
  const open = vi.fn(async (name: string) => {
    if (!buckets.has(name)) buckets.set(name, bucket());
    return buckets.get(name)!;
  });
  return { buckets, open, keys: async () => [...buckets.keys()], delete: vi.fn(async (name: string) => buckets.delete(name)) };
}

function worker(caches: ReturnType<typeof storage>, version: string) {
  const handlers = new Map<string, (event: any) => void>();
  const fetch = vi.fn(async (_req: Request): Promise<Response> => { throw new TypeError('Offline transport'); });
  const claim = vi.fn(async () => {});
  const source = readFileSync(new URL('../packages/client/src/sw.js', import.meta.url), 'utf8')
    .replace("'__VERSION__'", JSON.stringify(version)).replace('__PRECACHE__', '[]').replace('__FONTS__', '{}');
  runInNewContext(source, {
    caches, fetch, URL,
    self: { location: { origin }, clients: { claim }, addEventListener: (name: string, handler: (event: any) => void) => handlers.set(name, handler) },
  });
  return {
    fetch, claim,
    activate: async () => {
      const tasks: Promise<unknown>[] = [];
      handlers.get('activate')!({ waitUntil: (task: Promise<unknown>) => tasks.push(task) });
      await Promise.all(tasks);
    },
    request: async (path: string, mode = 'cors') => {
      let result: Promise<Response> | undefined;
      handlers.get('fetch')!({ request: { url: absolute(path), method: 'GET', mode }, respondWith: (task: Promise<Response>) => { result = task; } });
      return result ? await result : undefined;
    },
  };
}

const keyboard = '/assets/keyboard-OLD12345.js';
const font = '/assets/font-FONT1234.woff2';
const image = '/assets/orbit-IMAGE123.png';

it('keeps an old lazy keyboard, stylesheet, font and picture after deleting the old shell, without network access', async () => {
  const caches = storage(), old = await caches.open('overlyx-shell-old');
  for (const [path, body, type] of [
    [keyboard, 'oldKeyboard()', 'text/javascript'], ['/assets/keyboard-STYLE123.css', '.keyboard{}', 'text/css'],
    [font, 'old font bytes', 'font/woff2'], [image, 'old picture bytes', 'image/png'],
    ['/_ol/runtime.js', 'old runtime', 'text/javascript'], ['/api/docs/fictional/meta', 'private metadata', 'application/json'],
  ]) await old.put(path, response(body, type));
  const app = worker(caches, 'new');
  await app.activate();
  expect(caches.buckets.has('overlyx-shell-old')).toBe(false);
  expect(await (await app.request(keyboard))!.text()).toBe('oldKeyboard()');
  expect(await (await app.request(font))!.text()).toBe('old font bytes');
  expect(await (await app.request(image))!.text()).toBe('old picture bytes');
  expect([...caches.buckets.get('overlyx-public-assets')!.data.keys()].map(url => new URL(url).pathname).sort())
    .toEqual([keyboard, '/assets/keyboard-STYLE123.css', font, image].sort());
  expect(app.fetch).not.toHaveBeenCalled();
  expect(app.claim).toHaveBeenCalledOnce();
});

it('keeps old hashed modules through later updates and cached-old-index navigations for a restored page', async () => {
  const caches = storage(), old = await caches.open('overlyx-shell-first');
  await old.put(keyboard, response('first keyboard'));
  await worker(caches, 'second').activate();
  const second = await caches.open('overlyx-shell-second');
  await second.put('/assets/keyboard-NEW12345.js', response('second keyboard'));
  const third = worker(caches, 'third');
  await third.activate();
  // A successful fetch may itself be old HTTP-cached HTML; it does not release
  // the old page's hashed dependencies or enumerate frozen back/forward pages.
  third.fetch.mockResolvedValueOnce(response('<html>old app entry</html>', 'text/html'));
  expect(await (await third.request('/index.html', 'navigate'))!.text()).toContain('old app entry');
  expect(await (await third.request(keyboard))!.text()).toBe('first keyboard');
  expect(await (await third.request('/assets/keyboard-NEW12345.js'))!.text()).toBe('second keyboard');
  expect(third.fetch).toHaveBeenCalledOnce();
});

it('does not delete the durable old shell before an asynchronous asset copy finishes', async () => {
  const caches = storage(), old = await caches.open('overlyx-shell-old');
  await old.put(keyboard, response('old keyboard'));
  const assets = await caches.open('overlyx-public-assets');
  let finish!: () => void;
  const pending = new Promise<void>(resolve => { finish = resolve; });
  const put = assets.put.getMockImplementation()!;
  assets.put.mockImplementationOnce(async (...args) => { await pending; await put(...args); });
  const app = worker(caches, 'new'), activating = app.activate();
  await vi.waitFor(() => expect(assets.put).toHaveBeenCalledOnce());
  expect(caches.buckets.has('overlyx-shell-old')).toBe(true);
  expect(app.claim).not.toHaveBeenCalled();
  finish(); await activating;
  expect(caches.buckets.has('overlyx-shell-old')).toBe(false);
  expect(await (await app.request(keyboard))!.text()).toBe('old keyboard');
});

it('retains and reads the old shell if quota prevents its public asset copy', async () => {
  const caches = storage(), old = await caches.open('overlyx-shell-old');
  await old.put(keyboard, response('old keyboard'));
  const assets = await caches.open('overlyx-public-assets');
  assets.put.mockRejectedValue(new DOMException('Cache full', 'QuotaExceededError'));
  const app = worker(caches, 'new');
  await app.activate();
  expect(caches.buckets.has('overlyx-shell-old')).toBe(true);
  expect(app.claim).toHaveBeenCalledOnce();
  expect(await (await app.request(keyboard))!.text()).toBe('old keyboard');
  expect(app.fetch).not.toHaveBeenCalled();
});

it('still reads the old shell if opening the shared public cache itself is denied', async () => {
  const caches = storage(), old = await caches.open('overlyx-shell-old');
  await old.put(keyboard, response('old keyboard'));
  const open = caches.open.getMockImplementation()!;
  caches.open.mockImplementation(async name => {
    if (name === 'overlyx-public-assets') throw new DOMException('Cache denied', 'QuotaExceededError');
    return open(name);
  });
  const app = worker(caches, 'new');
  await app.activate();
  expect(caches.buckets.has('overlyx-shell-old')).toBe(true);
  expect(await (await app.request(keyboard))!.text()).toBe('old keyboard');
  expect(app.fetch).not.toHaveBeenCalled();
});

it('bypasses HTML-poisoned shell and shared hits while retaining the valid original module', async () => {
  const caches = storage(), old = await caches.open('overlyx-shell-old');
  await old.put(keyboard, response('correct original'));
  const current = await caches.open('overlyx-shell-new');
  await current.put(keyboard, response('<html>app fallback</html>', 'text/html'));
  const assets = await caches.open('overlyx-public-assets');
  await assets.put(keyboard, response('<html>bad shared hit</html>', 'text/html'));
  const app = worker(caches, 'new');
  await app.activate();
  expect(await (await app.request(keyboard))!.text()).toBe('correct original');
  expect(await (await assets.match(keyboard))!.text()).toBe('correct original');
  expect(app.fetch).not.toHaveBeenCalled();
});

it('never caches a successful HTML app fallback or an HTTP error as a JavaScript module', async () => {
  const caches = storage(), app = worker(caches, 'new');
  for (const res of [response('<html>app fallback</html>', 'text/html'), response('missing', 'text/javascript', 503)]) {
    const expected = await res.clone().text();
    app.fetch.mockResolvedValueOnce(res);
    expect(await (await app.request(keyboard))!.text()).toBe(expected);
    expect(await (await caches.open('overlyx-shell-new')).match(keyboard)).toBeUndefined();
  }
  app.fetch.mockResolvedValueOnce(response('valid module', 'application/javascript; charset=utf-8'));
  expect(await (await app.request(keyboard))!.text()).toBe('valid module');
  expect(await (await (await caches.open('overlyx-shell-new')).match(keyboard))!.text()).toBe('valid module');
});
