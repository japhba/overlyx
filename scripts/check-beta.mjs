#!/usr/bin/env node
/** Build and exercise an isolated release candidate, retaining only reviewable reports. */
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import net from 'node:net';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { assertServerHealthy } from './release-guards.mjs';
import { createAssetSnapshot, getReleaseAppEntry, verifyReleaseAssets } from './verify-release-assets.mjs';

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const work = fs.mkdtempSync(path.join(os.tmpdir(), 'overlyx-beta-check-'));
const report = path.resolve(process.env.OVERLYX_BETA_REPORT_DIR ?? path.join(repo, 'test-results', `beta-${Date.now()}`));
const dist = path.resolve(process.env.OVERLYX_BETA_BUILD_DIR ?? path.join(work, 'dist'));
fs.mkdirSync(report, { recursive: true, mode: 0o700 });
fs.mkdirSync(path.join(work, 'data'), { recursive: true, mode: 0o700 });
fs.mkdirSync(path.join(work, 'projects'), { recursive: true });
let server;
let serverSpawnError;
let stopped = false;
const serverLog = path.join(report, 'server.log');
const env = {
  ...process.env,
  OVERLYX_DATA_DIR: path.join(work, 'data'),
  OVERLYX_PROJECTS_DIR: path.join(work, 'projects'),
  OVERLYX_CLIENT_DIST: dist,
  OVERLYX_E2E_CREDENTIALS: path.join(work, 'data', 'credentials.txt'),
  OVERLYX_BETA_REPORT_DIR: report,
  OVERLYX_DOC_WORKERS: '1', OVERLYX_AGENT: 'off', OVERLYX_ERROR_REPORTS: 'off', OVERLYX_USAGE_STATS: 'off',
  GOOGLE_CLIENT_ID: '', GOOGLE_CLIENT_SECRET: '', OVERLYX_OWNER_EMAIL: '', OVERLYX_PUBLIC_URL: '', OVERLYX_SIGNUP: 'open',
  GITHUB_TOKEN: '', GITHUB_PUBLISH_TOKEN: '', GITHUB_MIRROR_TOKEN: '', GITHUB_MIRROR_ORG: '', OVERLYX_MIRROR_URL: '',
  OVERLYX_SMTP_URL: '', HOST: '127.0.0.1',
};

function serverHealth() {
  assertServerHealthy(server && { exitCode: server.exitCode, signalCode: server.signalCode, spawnError: serverSpawnError }, fs.existsSync(serverLog) ? fs.readFileSync(serverLog, 'utf8') : '');
}
async function run(name, command, args, cwd = repo, extraEnv = {}) {
  console.log(`Beta check: ${name}`);
  const log = name === 'seed' ? path.join(work, 'seed.log') : path.join(report, `${name}.log`);
  const fd = fs.openSync(log, 'w', 0o600);
  const child = spawn(command, args, { cwd, env: { ...env, ...extraEnv }, stdio: ['ignore', fd, fd] });
  fs.closeSync(fd);
  const status = await new Promise((resolve, reject) => { child.once('error', reject); child.once('exit', (code, signal) => resolve({ code, signal })); });
  if (status.code !== 0) {
    throw new Error(`${name} failed (${status.signal ?? status.code}). Reports: ${report}`);
  }
}

async function freePort() {
  const socket = net.createServer();
  await new Promise((resolve, reject) => { socket.once('error', reject); socket.listen(0, '127.0.0.1', resolve); });
  const port = socket.address().port;
  await new Promise(resolve => socket.close(resolve));
  return port;
}

async function cleanup() {
  if (stopped) return;
  stopped = true;
  if (server && server.exitCode === null) {
    server.kill('SIGTERM');
    await Promise.race([new Promise(resolve => server.once('exit', resolve)), delay(5000)]);
    if (server.exitCode === null) server.kill('SIGKILL');
  }
  fs.rmSync(work, { recursive: true, force: true });
}
for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, async () => { await cleanup(); process.exit(signal === 'SIGINT' ? 130 : 143); });

try {
  await run('build', process.platform === 'win32' ? 'npx.cmd' : 'npx', ['vite', 'build', '--outDir', dist, '--emptyOutDir'], path.join(repo, 'packages/client'));
  await run('runtime', process.platform === 'win32' ? 'npx.cmd' : 'npx', ['vite', 'build', '-c', 'runtime.vite.config.ts'], path.join(repo, 'packages/client'), { OVERLYX_RUNTIME_OUT: path.join(dist, '_ol') });
  const snapshot = createAssetSnapshot(dist);
  const app = getReleaseAppEntry(dist, snapshot);
  const runtime = snapshot.files.find(file => file.path === '/_ol/runtime.js');
  if (!app || !runtime) throw new Error('The candidate is missing its expected browser entry hashes.');
  env.OVERLYX_EXPECTED_APP_SHA256 = app.sha256;
  env.OVERLYX_EXPECTED_RUNTIME_SHA256 = runtime.sha256;
  env.OVERLYX_PRESENT_RETURN_EXPECTED_APP_SHA256 = app.sha256;
  env.OVERLYX_PRESENT_RETURN_EXPECTED_RUNTIME_SHA256 = runtime.sha256;
  for (const proof of new Set([path.join(report, 'candidate-assets.json'), path.resolve(process.env.OVERLYX_BETA_ASSET_PROOF ?? path.join(report, 'candidate-assets.json'))])) {
    fs.mkdirSync(path.dirname(proof), { recursive: true, mode: 0o700 });
    fs.writeFileSync(proof, JSON.stringify(snapshot) + '\n', { mode: 0o600 });
  }
  const users = ['admin', 'Admin', 'bob', 'Bob', 'carol', 'Carol', ...Array.from({ length: 6 }, (_, i) => [`u${i + 1}`, `User ${i + 1}`]).flat(),
    ...Array.from({ length: 6 }, (_, i) => [`luna${i + 1}`, `Reviewer ${i + 1}`]).flat(), 'betadeck', 'Morgan', 'betaposter', 'Riley', 'betareviewer', 'Casey', 'betanew', 'Avery'];
  await run('seed', process.execPath, ['--import', 'tsx', 'packages/server/src/seed.ts', ...users]);
  env.PORT = String(await freePort());
  env.OVERLYX_E2E_BASE = `http://127.0.0.1:${env.PORT}`;
  const fd = fs.openSync(serverLog, 'w', 0o600);
  server = spawn(process.execPath, ['--import', 'tsx', 'packages/server/src/index.ts'], { cwd: repo, env, stdio: ['ignore', fd, fd] });
  server.once('error', error => { serverSpawnError = error.code ?? 'spawn failure'; });
  fs.closeSync(fd);
  let ready = false;
  for (let attempt = 0; attempt < 120; attempt++) {
    serverHealth();
    try { const response = await fetch(env.OVERLYX_E2E_BASE + '/api/version', { signal: AbortSignal.timeout(1500) }); if (response.ok) { ready = true; break; } } catch {}
    await delay(250);
  }
  if (!ready) throw new Error(`Isolated server did not become ready. Reports: ${report}`);
  await verifyReleaseAssets(dist, env.OVERLYX_E2E_BASE, { snapshot });
  await run('browser', process.platform === 'win32' ? 'npx.cmd' : 'npx', ['playwright', 'test', '-c', 'playwright.release.config.ts']);
  serverHealth();
  let result;
  try { result = JSON.parse(fs.readFileSync(path.join(report, 'browser-results.json'), 'utf8')); }
  catch { throw new Error(`Browser report could not be read. Reports: ${report}`); }
  if (!Number.isSafeInteger(result.stats?.expected) || result.stats.expected < 1 || result.stats.unexpected || result.stats.flaky || result.errors?.length) throw new Error(`Browser gate did not report a clean completed suite. Reports: ${report}`);
  await verifyReleaseAssets(dist, env.OVERLYX_E2E_BASE, { snapshot });
  serverHealth();
  console.log(`Beta browser checks passed: ${result.stats.expected} passed, ${result.stats.skipped} skipped. Reports: ${report}`);
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
} finally { await cleanup(); }
