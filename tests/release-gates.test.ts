import { afterEach, beforeEach, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { createServer, type Server } from 'node:http';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createAssetSnapshot, getReleaseAppEntry, verifyReleaseAssets } from '../scripts/verify-release-assets.mjs';
import { assertCleanCheckout, assertServerHealthy } from '../scripts/release-guards.mjs';
import { finalizeOfflineRuntime } from '../packages/client/offline-manifest';
import { OFFLINE_FRAME_CSP } from '../packages/core/src/html/serve';

let root: string, server: Server | undefined;
beforeEach(() => { root = fs.mkdtempSync(path.join(tmpdir(), 'overlyx-release-gate-')); });
afterEach(async () => {
  if (server) { server.closeAllConnections(); await new Promise<void>(resolve => server!.close(() => resolve())); server = undefined; }
  fs.rmSync(root, { recursive: true, force: true });
});
function write(file: string, content: string) { const target = path.join(root, file); fs.mkdirSync(path.dirname(target), { recursive: true }); fs.writeFileSync(target, content); }
function candidate(runtimeFiles = 83, bootstrap = false) {
  write('index.html', '<html><head><script data-src="/assets/unused.js" src="/assets/main-abc.js" type="module"></script><link rel="modulepreload" href="/assets/lazy-def.js"><link href="/assets/main-ghi.css" rel="stylesheet"></head></html>');
  write('assets/main-abc.js', 'main();'); write('assets/lazy-def.js', 'lazy();'); write('assets/main-ghi.css', 'body{color:blue}');
  write('_ol/runtime.js', 'runtime();'); write('_ol/mathjax/tex-svg.js', 'mathjax();');
  for (let i = 0; i < runtimeFiles - 2; i++) write(`_ol/mathjax/fonts/dynamic/part-${String(i).padStart(3, '0')}.js`, `glyph(${i});`);
  if (bootstrap) write('_ol/offline-frame.html', '<!doctype html><script>bootstrap(1)</script>');
  write('sw.js', "const VERSION = 'abc123';\nconst PRECACHE = [\"/index.html\",\"/assets/main-abc.js\",\"/assets/main-ghi.css\"];\nself.addEventListener('install',e=>e.waitUntil(caches.open(VERSION).then(c=>c.addAll(PRECACHE))));\n");
  finalizeOfflineRuntime(root);
  return createAssetSnapshot(root);
}
async function localServer(overrides = new Map<string, string>(), headerOverrides = new Map<string, string | null>(), statusOverrides = new Map<string, number>()) {
  const requests: { path: string; nonce: string | null; control: string | undefined }[] = [];
  server = createServer((request, response) => {
    const url = new URL(request.url!, 'http://fixture.invalid');
    requests.push({ path: url.pathname, nonce: url.searchParams.get('__ol_release_check'), control: request.headers['cache-control'] });
    const file = url.pathname === '/' ? 'index.html' : url.pathname.slice(1);
    if (url.pathname === '/_ol/offline-frame.html') {
      const csp = headerOverrides.has(url.pathname) ? headerOverrides.get(url.pathname) : OFFLINE_FRAME_CSP;
      if (csp !== null && csp !== undefined) response.setHeader('Content-Security-Policy', csp);
    }
    response.statusCode = statusOverrides.get(url.pathname) ?? 200;
    try { response.end(overrides.get(url.pathname) ?? fs.readFileSync(path.join(root, file))); }
    catch { response.statusCode = 404; response.end('Missing fixture'); }
  });
  await new Promise<void>(resolve => server!.listen(0, '127.0.0.1', resolve));
  const port = (server.address() as { port: number }).port;
  return { origin: `http://127.0.0.1:${port}`, requests };
}

it('verifies the exact served index, entry dependencies, SW and all83 runtime scripts with cache-busted local HTTP', async () => {
  const snapshot = candidate(), fixture = await localServer();
  const result = await verifyReleaseAssets(root, fixture.origin, { snapshot });
  expect(result.runtimeFiles).toBe(83);
  expect(result.files).toBe(snapshot.files.length + 1);
  expect(result.publicFiles).toBe(snapshot.publicFiles.length);
  expect(fixture.requests.map(request => request.path).sort()).toEqual([...snapshot.files.map(file => file.path), '/'].sort());
  for (const request of fixture.requests) { expect(request.nonce).toEqual(expect.any(String)); expect(request.nonce).not.toBe(''); expect(request.control).toBe('no-cache'); }
  expect(snapshot.files.map(file => file.path)).not.toContain('/assets/unused.js');
});

it('uses the HTML main module even when an index preload sorts first, and rejects ambiguous or stale entries', () => {
  candidate();
  write('assets/index-A-preload.js', 'preload();');
  write('assets/index-Z-main.js', 'application();');
  const html = '<script type="module" src="/assets/index-Z-main.js"></script><link rel="modulepreload" href="/assets/index-A-preload.js"><link rel="stylesheet" href="/assets/main-ghi.css">';
  write('index.html', html);
  const snapshot = createAssetSnapshot(root);
  expect(snapshot.files.find(file => /^\/assets\/index-/.test(file.path))?.path).toBe('/assets/index-A-preload.js');
  expect(getReleaseAppEntry(root, snapshot)).toEqual(snapshot.files.find(file => file.path === '/assets/index-Z-main.js'));
  write('index.html', html + '<script type="module" src="/assets/index-A-preload.js"></script>');
  expect(() => getReleaseAppEntry(root, snapshot)).toThrow('exactly one HTML main module');
  write('index.html', '<link rel="modulepreload" href="/assets/index-A-preload.js">');
  expect(() => getReleaseAppEntry(root, snapshot)).toThrow('exactly one HTML main module');
  write('index.html', html);
  write('assets/index-Z-main.js', 'changedApplication();');
  expect(() => getReleaseAppEntry(root, snapshot)).toThrow('does not match the candidate snapshot');
});

it('verifies bootstrap bytes in the runtime digest and requires its exact opaque CSP over local HTTP', async () => {
  const bootstrap = '/_ol/offline-frame.html';
  const snapshot = candidate(20, true), bodies = new Map<string, string>(), headers = new Map<string, string | null>(), statuses = new Map<string, number>();
  const fixture = await localServer(bodies, headers, statuses);
  expect(JSON.parse(fs.readFileSync(path.join(root, '_ol/offline.json'), 'utf8')).files).toHaveLength(20);
  expect(snapshot.files.map(file => file.path)).toContain(bootstrap);
  const result = await verifyReleaseAssets(root, fixture.origin, { snapshot });
  expect(result.runtimeFiles).toBe(20);
  expect(fixture.requests.map(request => request.path)).toContain(bootstrap);
  for (const csp of [null, `${OFFLINE_FRAME_CSP} allow-same-origin`]) {
    headers.set(bootstrap, csp);
    await expect(verifyReleaseAssets(root, fixture.origin, { snapshot })).rejects.toThrow(`invalid opaque Content-Security-Policy for ${bootstrap}`);
  }
  headers.delete(bootstrap);
  bodies.set(bootstrap, '<!doctype html><script>bootstrap(2)</script>');
  await expect(verifyReleaseAssets(root, fixture.origin, { snapshot })).rejects.toThrow(`served bytes differ for ${bootstrap}`);
  bodies.delete(bootstrap);
  statuses.set(bootstrap, 404);
  await expect(verifyReleaseAssets(root, fixture.origin, { snapshot })).rejects.toThrow(`${bootstrap} returned HTTP 404`);
  statuses.delete(bootstrap);
  write('_ol/offline-frame.html', '<!doctype html><script>bootstrap(2)</script>');
  expect(() => createAssetSnapshot(root)).toThrow('runtime manifest content hash does not match the candidate');
  finalizeOfflineRuntime(root);
  const changed = createAssetSnapshot(root);
  expect(changed.runtimeVersion).not.toBe(snapshot.runtimeVersion);
  await expect(verifyReleaseAssets(root, fixture.origin, { snapshot })).rejects.toThrow('candidate bytes changed after validation');
  await expect(verifyReleaseAssets(root, fixture.origin, { snapshot: changed })).resolves.toMatchObject({ runtimeFiles: 20 });
});

it('rejects runtime/SW served mismatches and candidate mutation instead of accepting a matching backend or main entry alone', async () => {
  const snapshot = candidate(), overrides = new Map<string, string>(), fixture = await localServer(overrides);
  for (const file of ['/sw.js', '/_ol/mathjax/fonts/dynamic/part-080.js', '/assets/main-ghi.css', '/']) {
    overrides.set(file, 'WRONG_CANDIDATE');
    await expect(verifyReleaseAssets(root, fixture.origin, { snapshot })).rejects.toThrow(`served bytes differ for ${file}`);
    overrides.delete(file);
  }
  const count = fixture.requests.length;
  write('assets/main-ghi.css', 'body{color:red}');
  await expect(verifyReleaseAssets(root, fixture.origin, { snapshot })).rejects.toThrow('candidate bytes changed after validation');
  expect(fixture.requests).toHaveLength(count);
  write('assets/main-ghi.css', 'body{color:blue}');
  write('_ol/unlisted.js', 'unlisted();');
  expect(() => createAssetSnapshot(root)).toThrow('runtime manifest omits candidate JavaScript');
  fs.rmSync(path.join(root, '_ol/unlisted.js'));
  await expect(verifyReleaseAssets(root, fixture.origin, { snapshot, concurrency: NaN })).rejects.toThrow('invalid verification limits');
});

it('captures a deterministic sorted hash inventory of all public dist files', () => {
  candidate(); // Finalize the runtime before adding representative non-runtime assets.
  write('assets/lazy-chunk-new.js', 'lazy chunk bytes');
  write('assets/fonts/body.woff2', 'font bytes');
  write('assets/images/figure.png', 'image bytes');

  const snapshot = createAssetSnapshot(root);
  expect(snapshot.publicFiles).toEqual([...snapshot.publicFiles].sort((a, b) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  expect(snapshot.publicFiles.map(file => file.path)).toEqual(expect.arrayContaining([
    '/assets/lazy-chunk-new.js', '/assets/fonts/body.woff2', '/assets/images/figure.png',
  ]));
  for (const file of snapshot.publicFiles) {
    expect(Object.keys(file).sort()).toEqual(['path', 'sha256']);
    expect(file.sha256).toMatch(/^[a-f0-9]{64}$/);
    expect(file.sha256).toBe(createHash('sha256').update(fs.readFileSync(path.join(root, file.path.slice(1)))).digest('hex'));
  }
  expect(createAssetSnapshot(root).publicFiles).toEqual(snapshot.publicFiles);
  // The expanded public inventory must not change the legacy online-check set.
  expect(snapshot.files.map(file => file.path)).not.toContain('/assets/images/figure.png');
  expect(snapshot.runtimeVersion).toMatch(/^[a-f0-9]{64}$/);
});

it('rejects tampered or missing lazy JS, font and image files, and newly added files before any HTTP request', async () => {
  const assets = [
    ['assets/lazy-chunk-new.js', 'lazy chunk original', 'lazy chunk changed'],
    ['assets/fonts/body.woff2', 'font original', 'font changed'],
    ['assets/images/figure.png', 'image original', 'image changed'],
  ] as const;
  const fixture = await localServer();
  const resetCandidate = () => {
    fs.rmSync(root, { recursive: true, force: true });
    fs.mkdirSync(root, { recursive: true });
    candidate();
    for (const [asset, original] of assets) write(asset, original);
  };

  for (const [asset, , changed] of assets) {
    resetCandidate();
    const baseline = createAssetSnapshot(root);
    write(asset, changed);
    await expect(verifyReleaseAssets(root, fixture.origin, { snapshot: baseline })).rejects.toThrow('candidate bytes changed after validation');
    expect(fixture.requests).toHaveLength(0);

    resetCandidate();
    const missingBaseline = createAssetSnapshot(root);
    fs.rmSync(path.join(root, asset));
    await expect(verifyReleaseAssets(root, fixture.origin, { snapshot: missingBaseline })).rejects.toThrow('candidate bytes changed after validation');
    expect(fixture.requests).toHaveLength(0);
  }

  resetCandidate();
  const baseline = createAssetSnapshot(root);
  write('assets/added-after-proof.js', 'new public file');
  await expect(verifyReleaseAssets(root, fixture.origin, { snapshot: baseline })).rejects.toThrow('candidate bytes changed after validation');
  expect(fixture.requests).toHaveLength(0);
});

it('rejects a symlink in the public dist tree while constructing the asset snapshot', () => {
  candidate();
  fs.symlinkSync(path.join(root, 'assets/main-abc.js'), path.join(root, 'assets/alias.js'));
  expect(() => createAssetSnapshot(root)).toThrow('candidate public tree contains a symbolic link');
});

it('rejects dead servers and worker, move, unhandled and Node errors using safe category-only summaries', () => {
  const alive = { exitCode: null, signalCode: null, spawnError: undefined };
  expect(() => assertServerHealthy(alive, 'Server listening; a fixture expected HTTP404.')).not.toThrow();
  for (const state of [{ ...alive, exitCode: 0 }, { ...alive, exitCode: 1 }, { ...alive, signalCode: 'SIGKILL' }, { ...alive, spawnError: 'EAGAIN' }]) expect(() => assertServerHealthy(state, '')).toThrow('not running');
  for (const log of [
    '[docs] document worker 0 failed: Error FAKE_PRIVATE_TOKEN',
    '[docs] document worker 0 exited (code 1) — replaced on the next request',
    '[docs] document workers keep dying — doing the document work on the main thread from now on',
    '[moves] fictional/main.tex: [moves] repair failed FAKE_PRIVATE_TOKEN',
    '[moves] fictional/main.tex: [moves] could not place 1:0 FAKE_PRIVATE_TOKEN',
    '[server] unhandled rejection: FAKE_PRIVATE_TOKEN',
    '[server] uncaught exception — saving open documents and exiting: FAKE_PRIVATE_TOKEN',
    'Error [ERR_WORKER_OUT_OF_MEMORY]: FAKE_PRIVATE_TOKEN',
    'Assertion `(0) == (uv_thread_create(...))` failed. FAKE_PRIVATE_TOKEN',
  ]) {
    let failure: Error | undefined;
    try { assertServerHealthy(alive, log); } catch (error) { failure = error as Error; }
    expect(failure).toBeInstanceOf(Error);
    expect(failure!.message).not.toContain('FAKE_PRIVATE_TOKEN');
    expect(failure!.message).not.toContain('fictional/main.tex');
  }
});

it('rejects untracked or staged source while permitting ignored build output in an actual local checkout without committing', () => {
  execFileSync('git', ['init', '--quiet'], { cwd: root });
  expect(() => assertCleanCheckout(root)).not.toThrow();
  write('new-helper.mjs', 'export const helper=true;');
  expect(() => assertCleanCheckout(root)).toThrow('tracked and untracked source');
  execFileSync('git', ['add', 'new-helper.mjs'], { cwd: root });
  expect(() => assertCleanCheckout(root)).toThrow('tracked and untracked source');
  execFileSync('git', ['rm', '--cached', '--quiet', 'new-helper.mjs'], { cwd: root });
  fs.rmSync(path.join(root, 'new-helper.mjs'));
  fs.appendFileSync(path.join(root, '.git/info/exclude'), '\ndist/\n');
  write('dist/runtime.js', 'ignored();');
  expect(() => assertCleanCheckout(root)).not.toThrow();
});
