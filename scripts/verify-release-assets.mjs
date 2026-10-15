#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';

const sha = bytes => createHash('sha256').update(bytes).digest('hex');
const failure = message => new Error(`Release asset verification: ${message}`);
const bootstrap = '/_ol/offline-frame.html';
// Keep the production bootstrap opaque even when served outside the editor.
// The fixture serves the core's OFFLINE_FRAME_CSP, so divergence fails the gate.
const bootstrapCsp = 'sandbox allow-scripts allow-modals allow-popups allow-forms';
function localPath(value) {
  if (typeof value !== 'string' || !value.startsWith('/') || value.startsWith('//') || value.includes('\\') || value.includes('\0')) throw failure('invalid candidate asset path');
  const normalized = new URL(value, 'http://candidate.invalid');
  if (normalized.pathname !== value || normalized.search || normalized.hash || value.split('/').includes('..')) throw failure('invalid candidate asset path');
  return value;
}
const fileBytes = (root, file) => {
  try { return fs.readFileSync(path.join(root, localPath(file).slice(1))); }
  catch { throw failure(`missing candidate file ${file}`); }
};
const attribute = (tag, name) => new RegExp(`\\s${name}\\s*=\\s*(["'])(.*?)\\1`, 'i').exec(tag)?.[2];

/** Read the HTML module entry and verify its candidate hash. */
export function getReleaseAppEntry(distRoot, snapshot) {
  const entry = fileBytes(distRoot, '/index.html').toString('utf8');
  const modules = [...entry.matchAll(/<script\b[^>]*>/gi)]
    .map(match => match[0])
    .filter(tag => attribute(tag, 'type')?.toLowerCase() === 'module')
    .map(tag => attribute(tag, 'src'));
  if (modules.length !== 1 || typeof modules[0] !== 'string'
    || !modules[0].startsWith('/assets/') || !modules[0].endsWith('.js')) throw failure('expected exactly one HTML main module entry');
  const main = localPath(modules[0]);
  const app = snapshot?.files?.find(file => file.path === main);
  if (!app || app.sha256 !== sha(fileBytes(distRoot, main))) throw failure('HTML main module does not match the candidate snapshot');
  return app;
}

/** Capture every public build file, including lazily imported chunks and font/image assets. */
function publicFileSnapshot(distRoot) {
  const publicFiles = [];
  const walk = directory => {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      const absolute = path.join(directory, entry.name);
      if (entry.isSymbolicLink()) throw failure('candidate public tree contains a symbolic link');
      if (entry.isDirectory()) walk(absolute);
      else if (entry.isFile()) {
        const file = '/' + path.relative(distRoot, absolute).split(path.sep).join('/');
        publicFiles.push({ path: file, sha256: sha(fs.readFileSync(absolute)) });
      } else throw failure('candidate public tree contains a non-regular file');
    }
  };
  walk(distRoot);
  return publicFiles.sort((left, right) => left.path < right.path ? -1 : left.path > right.path ? 1 : 0);
}

/** Capture targeted HTTP proofs plus a local hash manifest for the entire public build tree. */
export function createAssetSnapshot(distRoot) {
  const manifestBytes = fileBytes(distRoot, '/_ol/offline.json');
  let manifest;
  try { manifest = JSON.parse(manifestBytes.toString('utf8')); } catch { throw failure('invalid runtime manifest'); }
  if (!manifest || !Array.isArray(manifest.files) || !/^[a-f0-9]{64}$/.test(manifest.version)
    || manifest.files.some(file => typeof file !== 'string' || !file.startsWith('/_ol/') || !file.endsWith('.js'))
    || !manifest.files.includes('/_ol/runtime.js')) throw failure('invalid runtime manifest');
  const files = [...new Set(manifest.files.map(localPath))].sort();
  if (JSON.stringify(files) !== JSON.stringify(manifest.files)) throw failure('runtime manifest must contain unique sorted files');
  const actual = [];
  const walk = dir => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const absolute = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(absolute);
      else if (entry.isFile() && entry.name.endsWith('.js')) actual.push('/' + path.relative(distRoot, absolute).split(path.sep).join('/'));
    }
  };
  walk(path.join(distRoot, '_ol'));
  if (JSON.stringify(actual.sort()) !== JSON.stringify(files)) throw failure('runtime manifest omits candidate JavaScript');
  const cachedFiles = [...files, ...(fs.existsSync(path.join(distRoot, bootstrap.slice(1))) ? [bootstrap] : [])].sort();
  const digest = createHash('sha256');
  for (const file of cachedFiles) {
    const bytes = fileBytes(distRoot, file);
    digest.update(JSON.stringify([file, bytes.length])).update('\0').update(bytes).update('\0');
  }
  if (digest.digest('hex') !== manifest.version) throw failure('runtime manifest content hash does not match the candidate');
  const worker = fileBytes(distRoot, '/sw.js').toString('utf8');
  const constants = worker.match(/^const PRECACHE = (\[[^\r\n]*\]);\r?$/gm) ?? [];
  if (constants.length !== 1) throw failure('invalid service-worker precache');
  let precache;
  try { precache = JSON.parse(/^const PRECACHE = (\[[^\r\n]*\]);\r?$/.exec(constants[0])[1]); } catch { throw failure('invalid service-worker precache'); }
  if (!Array.isArray(precache) || precache.some(file => typeof file !== 'string')) throw failure('invalid service-worker precache');
  precache.forEach(localPath);
  if (JSON.stringify([...new Set(precache)].sort()) !== JSON.stringify(precache)) throw failure('service-worker precache must contain unique sorted paths');
  for (const file of [...cachedFiles, '/_ol/offline.json']) if (!precache.includes(file)) throw failure('service worker omits offline runtime resources');
  const workerVersion = createHash('sha256').update(JSON.stringify(precache)).update('\0').update(manifest.version).digest('hex').slice(0, 12);
  const versions = worker.match(/^const VERSION = '[a-f0-9]+';\r?$/gm) ?? [];
  if (versions.length !== 1 || !versions[0].includes(`'${workerVersion}'`)) throw failure('service-worker version does not match runtime contents');
  const entry = fileBytes(distRoot, '/index.html').toString('utf8');
  const targets = new Set(['/index.html', '/sw.js', '/_ol/offline.json', ...cachedFiles]);
  for (const match of entry.matchAll(/<(?:script|link)\b[^>]*>/gi)) {
    const tag = match[0];
    const value = /^<script\b/i.test(tag) ? attribute(tag, 'src')
      : /\b(?:stylesheet|modulepreload)\b/i.test(attribute(tag, 'rel') ?? '') ? attribute(tag, 'href') : undefined;
    if (value) targets.add(localPath(value));
  }
  if (![...targets].some(file => file.startsWith('/assets/') && /\.js$/.test(file))) throw failure('built main JavaScript entry is missing');
  if (![...targets].some(file => file.startsWith('/assets/') && /\.css$/.test(file))) throw failure('built main stylesheet entry is missing');
  return {
    version: 1,
    runtimeVersion: manifest.version,
    files: [...targets].sort().map(file => ({ path: file, sha256: sha(fileBytes(distRoot, file)) })),
    publicFiles: publicFileSnapshot(distRoot),
  };
}

/** Check cache-busted served bytes against the immutable pre-browser proof. */
export async function verifyReleaseAssets(distRoot, baseURL, { snapshot, fetcher = fetch, timeoutMs = 10000, concurrency = 4 } = {}) {
  if (!Number.isSafeInteger(concurrency) || concurrency < 1 || !Number.isSafeInteger(timeoutMs) || timeoutMs < 1) throw failure('invalid verification limits');
  const current = createAssetSnapshot(distRoot);
  if (!snapshot || JSON.stringify(snapshot) !== JSON.stringify(current)) throw failure('candidate bytes changed after validation');
  const base = new URL(baseURL);
  if (!['http:', 'https:'].includes(base.protocol) || base.username || base.password || base.search || base.hash) throw failure('invalid verification origin');
  const nonce = randomUUID();
  const targets = [...snapshot.files, { path: '/', sha256: snapshot.files.find(file => file.path === '/index.html').sha256 }];
  let next = 0;
  let firstFailure;
  const aborted = new AbortController();
  const check = async () => {
    while (next < targets.length && !aborted.signal.aborted) {
      const target = targets[next++], url = new URL(target.path, base);
      url.searchParams.set('__ol_release_check', nonce);
      try {
        const response = await fetcher(url, { headers: { 'cache-control': 'no-cache', pragma: 'no-cache' }, signal: AbortSignal.any([aborted.signal, AbortSignal.timeout(timeoutMs)]) });
        if (!response.ok) throw failure(`${target.path} returned HTTP ${response.status}`);
        if (target.path === bootstrap && response.headers.get('content-security-policy') !== bootstrapCsp) throw failure(`invalid opaque Content-Security-Policy for ${bootstrap}`);
        if (sha(Buffer.from(await response.arrayBuffer())) !== target.sha256) throw failure(`served bytes differ for ${target.path}`);
      } catch (error) {
        firstFailure ??= error?.message?.startsWith('Release asset verification:') ? error : failure(`could not fetch ${target.path}`);
        aborted.abort();
        throw firstFailure;
      }
    }
  };
  const outcomes = await Promise.allSettled(Array.from({ length: Math.min(8, concurrency) }, check));
  if (firstFailure) throw firstFailure;
  if (outcomes.some(outcome => outcome.status === 'rejected')) throw failure('verification did not complete');
  return {
    files: targets.length,
    runtimeFiles: snapshot.files.filter(file => file.path.startsWith('/_ol/') && file.path.endsWith('.js')).length,
    publicFiles: snapshot.publicFiles.length,
  };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const [, , dist, origin, proof] = process.argv;
    if (!dist || !origin || !proof) throw failure('usage: node scripts/verify-release-assets.mjs <dist> <origin> <proof.json>');
    const result = await verifyReleaseAssets(dist, origin, { snapshot: JSON.parse(fs.readFileSync(proof, 'utf8')) });
    console.log(`Verified ${result.files} served files, including ${result.runtimeFiles} offline runtime scripts, and ${result.publicFiles} unchanged local public files.`);
  } catch (error) { console.error(error.message); process.exitCode = 1; }
}
