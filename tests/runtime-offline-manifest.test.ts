import { afterEach, beforeEach, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { finalizeOfflineRuntime } from '../packages/client/offline-manifest';

let root: string;
beforeEach(() => { root = fs.mkdtempSync(path.join(tmpdir(), 'overlyx-offline-manifest-')); });
afterEach(() => { fs.rmSync(root, { recursive: true, force: true }); });
function write(file: string, bytes: string) {
  const target = path.join(root, file);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, bytes);
}
const read = (file: string) => fs.readFileSync(path.join(root, file), 'utf8');
const manifest = () => JSON.parse(read('_ol/offline.json')) as { version: string; files: string[] };
const worker = (precache: string[]) => `/* Keep service-worker behavior byte-for-byte. */\nconst VERSION = '0123456789ab';\nconst PRECACHE = ${JSON.stringify(precache)};\nconst FONTS = {"other":["/assets/font.js"]};\nself.addEventListener('install', e => e.waitUntil(caches.open(VERSION).then(c => c.addAll(PRECACHE))));\n`;
const workerVersion = () => /^const VERSION = '([^']+)';$/m.exec(read('sw.js'))![1];
const precache = () => JSON.parse(/^const PRECACHE = (\[[^\n]*\]);$/m.exec(read('sw.js'))![1]) as string[];
const withoutConstants = (source: string) => source.replace(/^const VERSION = [^\n]*$/m, 'VERSION').replace(/^const PRECACHE = [^\n]*$/m, 'PRECACHE');

it('precaches the opaque frame bootstrap and invalidates its content without treating HTML as a runtime script', () => {
  write('_ol/runtime.js', 'runtime();');
  write('_ol/offline-frame.html', '<script>bootstrap(1)</script>');
  write('sw.js', worker(['/index.html']));
  finalizeOfflineRuntime(root);
  expect(manifest().files).toEqual(['/_ol/runtime.js']);
  expect(precache()).toContain('/_ol/offline-frame.html');
  const original = manifest().version, originalWorker = workerVersion();
  write('_ol/offline-frame.html', '<script>bootstrap(2)</script>');
  finalizeOfflineRuntime(root);
  expect(manifest().version).not.toBe(original);
  expect(workerVersion()).not.toBe(originalWorker);
  fs.rmSync(path.join(root, '_ol/offline-frame.html'));
  finalizeOfflineRuntime(root);
  expect(precache()).not.toContain('/_ol/offline-frame.html');
});

it('lists nested runtime and dynamic MathJax JavaScript deterministically without maps or other assets', () => {
  write('_ol/runtime.js', 'runtime();');
  write('_ol/mathjax/fonts/dynamic/greek.js', 'greek();');
  write('_ol/mathjax/tex-svg.js', 'mathjax();');
  write('_ol/runtime.js.map', 'source map');
  write('_ol/mathjax/README.txt', 'documentation');
  write('_ol/offline.json', '{"old":"manifest is not a runtime script"}');
  finalizeOfflineRuntime(root);
  expect(manifest().files).toEqual(['/_ol/mathjax/fonts/dynamic/greek.js', '/_ol/mathjax/tex-svg.js', '/_ol/runtime.js']);
  expect(manifest().version).toMatch(/^[a-f0-9]{64}$/);
  expect(fs.existsSync(path.join(root, 'sw.js'))).toBe(false);
  const before = read('_ol/offline.json');
  finalizeOfflineRuntime(root);
  expect(read('_ol/offline.json')).toBe(before);
  // Directory insertion order and modification timestamps do not affect bytes.
  fs.rmSync(path.join(root, '_ol'), { recursive: true });
  write('_ol/mathjax/tex-svg.js', 'mathjax();');
  write('_ol/mathjax/fonts/dynamic/greek.js', 'greek();');
  write('_ol/runtime.js', 'runtime();');
  finalizeOfflineRuntime(root);
  expect(read('_ol/offline.json')).toBe(before);
});

it('adds runtime URLs and the manifest once, preserves app-shell paths, and rewrites only the generated constants', () => {
  write('_ol/runtime.js', 'runtime();');
  write('_ol/mathjax/tex-svg.js', 'mathjax();');
  const original = worker(['/index.html', '/assets/app-hash.js', '/index.html', '/_ol/runtime.js', '/_ol/deleted-module.js']);
  write('sw.js', original);
  finalizeOfflineRuntime(root);
  expect(precache()).toEqual(['/_ol/mathjax/tex-svg.js', '/_ol/offline.json', '/_ol/runtime.js', '/assets/app-hash.js', '/index.html']);
  expect(workerVersion()).not.toBe('0123456789ab');
  expect(withoutConstants(read('sw.js'))).toBe(withoutConstants(original));
  const after = read('sw.js');
  finalizeOfflineRuntime(root);
  expect(read('sw.js')).toBe(after);
});

it('invalidates both offline versions for a runtime-only byte change at the same URL', () => {
  write('_ol/runtime.js', 'runtime(1);');
  write('_ol/mathjax/fonts/dynamic/greek.js', 'greek(1);');
  write('sw.js', worker(['/index.html']));
  finalizeOfflineRuntime(root);
  const before = manifest(), beforeWorker = workerVersion(), beforePaths = precache();
  write('_ol/mathjax/fonts/dynamic/greek.js', 'greek(2);');
  finalizeOfflineRuntime(root);
  expect(manifest().files).toEqual(before.files);
  expect(manifest().version).not.toBe(before.version);
  expect(workerVersion()).not.toBe(beforeWorker);
  expect(precache()).toEqual(beforePaths);
  const after = read('_ol/offline.json'), afterWorker = read('sw.js');
  write('_ol/runtime.js.map', 'changed ignored map');
  finalizeOfflineRuntime(root);
  expect(read('_ol/offline.json')).toBe(after);
  expect(read('sw.js')).toBe(afterWorker);
});

it('invalidates versions and removes obsolete runtime URLs when a module path changes', () => {
  write('_ol/runtime.js', 'runtime();');
  write('_ol/mathjax/old.js', 'same();');
  write('sw.js', worker(['/index.html']));
  finalizeOfflineRuntime(root);
  const before = manifest().version, beforeWorker = workerVersion();
  fs.renameSync(path.join(root, '_ol/mathjax/old.js'), path.join(root, '_ol/mathjax/new.js'));
  finalizeOfflineRuntime(root);
  expect(manifest().files).toEqual(['/_ol/mathjax/new.js', '/_ol/runtime.js']);
  expect(precache()).toEqual(['/_ol/mathjax/new.js', '/_ol/offline.json', '/_ol/runtime.js', '/index.html']);
  expect(manifest().version).not.toBe(before);
  expect(workerVersion()).not.toBe(beforeWorker);
});

it('preserves service-worker line endings and logic when generated with CRLF', () => {
  write('_ol/runtime.js', 'runtime();');
  const original = worker(['/index.html']).replaceAll('\n', '\r\n');
  write('sw.js', original);
  finalizeOfflineRuntime(root);
  expect(read('sw.js').replaceAll('\r\n', '')).not.toContain('\n');
  expect(withoutConstants(read('sw.js'))).toBe(withoutConstants(original));
});

it('preserves literal dollar sequences in generated precache paths', () => {
  write('_ol/runtime-$&.js', 'runtime();');
  write('sw.js', worker(['/assets/app-$&.js', '/index.html']));
  finalizeOfflineRuntime(root);
  expect(manifest().files).toEqual(['/_ol/runtime-$&.js']);
  expect(precache()).toEqual(['/_ol/offline.json', '/_ol/runtime-$&.js', '/assets/app-$&.js', '/index.html']);
});

it.each([
  ['missing version', "const PRECACHE = [];\n"],
  ['duplicate precache', "const VERSION = 'abc123';\nconst PRECACHE = [];\nconst PRECACHE = [];\n"],
  ['unbuilt placeholders', "const VERSION = '__VERSION__';\nconst PRECACHE = __PRECACHE__;\n"],
  ['invalid JSON', "const VERSION = 'abc123';\nconst PRECACHE = ['/index.html'];\n"],
  ['invalid paths', "const VERSION = 'abc123';\nconst PRECACHE = [42];\n"],
])('fails a malformed known service worker (%s) before writing either output', (_reason, source) => {
  write('_ol/runtime.js', 'runtime();');
  write('sw.js', source);
  expect(() => finalizeOfflineRuntime(root)).toThrow(/Invalid generated/);
  expect(read('sw.js')).toBe(source);
  expect(fs.existsSync(path.join(root, '_ol/offline.json'))).toBe(false);
});
