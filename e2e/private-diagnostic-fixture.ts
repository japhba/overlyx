/** Private audit guards only: no shipping code, credentials or network operations. */
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

type Env = Record<string, string | undefined>;
export type FinalDiagnosticCandidateProof = {
  schema: 1;
  purpose: 'overlyx-final-beta-diagnostics';
  freshBuild: true;
  dist: string;
  appAsset: string;
  appSha256: string;
  runtimeAsset: '/_ol/runtime.js';
  runtimeSha256: string;
  keyboardAsset: string;
  keyboardSha256: string;
  sourceManifestSha256: string;
  publicAssetManifestSha256: string;
};
const LEGACY_ROOT = '/root/lyx/overlyx-slide-audit/scratch/slide-audit';
const SHA = /^[a-f0-9]{64}$/;
const FINAL_ROOT = /^\/tmp\/overlyx-(?:beta-check|final-diag)-[A-Za-z0-9_-]{4,64}$/;

function fail(): never { throw new Error('Private final diagnostic fixture or candidate proof failed validation.'); }
function ownedPath(value: string, directory: boolean, privateMode = false): void {
  if (!value || !path.isAbsolute(value) || path.resolve(value) !== value) fail();
  let stat: fs.Stats;
  try {
    stat = fs.lstatSync(value);
    if (fs.realpathSync(value) !== value) fail();
  } catch { fail(); }
  if (stat.isSymbolicLink() || (directory ? !stat.isDirectory() : !stat.isFile()) ||
    (typeof process.getuid === 'function' && stat.uid !== process.getuid()) ||
    (stat.mode & (privateMode ? 0o077 : 0o022)) !== 0) fail();
}

export function readFinalDiagnosticCandidateProof(env: Env = process.env): FinalDiagnosticCandidateProof {
  if (env.OVERLYX_FINAL_DIAGNOSTICS_APPROVED !== '1') fail();
  const proofFile = env.OVERLYX_FINAL_CANDIDATE_PROOF ?? '';
  ownedPath(proofFile, false);
  let proof: FinalDiagnosticCandidateProof;
  try { proof = JSON.parse(fs.readFileSync(proofFile, 'utf8')); } catch { fail(); }
  if (!proof || typeof proof !== 'object' || Array.isArray(proof) || proof.schema !== 1 ||
    proof.purpose !== 'overlyx-final-beta-diagnostics' || proof.freshBuild !== true ||
    typeof proof.dist !== 'string' || !/^\/tmp\/overlyx-[A-Za-z0-9_-]+\/dist$/.test(proof.dist) ||
    !/^\/assets\/index-[A-Za-z0-9_-]+\.js$/.test(proof.appAsset) ||
    proof.runtimeAsset !== '/_ol/runtime.js' ||
    !/^\/assets\/keyboard-[A-Za-z0-9_-]+\.js$/.test(proof.keyboardAsset)) fail();
  for (const key of ['appSha256', 'runtimeSha256', 'keyboardSha256', 'sourceManifestSha256', 'publicAssetManifestSha256'] as const) {
    if (typeof proof[key] !== 'string' || !SHA.test(proof[key])) fail();
  }
  ownedPath(proof.dist, true);
  const entry = path.join(proof.dist, 'index.html');
  ownedPath(entry, false);
  const mainEntries = [...fs.readFileSync(entry, 'utf8').matchAll(/<script\b[^>]*\bsrc=["'](\/assets\/index-[A-Za-z0-9_-]+\.js)["'][^>]*>/g)]
    .map(match => match[1]);
  if (mainEntries.length !== 1 || mainEntries[0] !== proof.appAsset) fail();
  for (const [asset, hash] of [[proof.appAsset, proof.appSha256], [proof.runtimeAsset, proof.runtimeSha256],
    [proof.keyboardAsset, proof.keyboardSha256]]) {
    const file = path.join(proof.dist, asset.slice(1));
    ownedPath(file, false);
    if (createHash('sha256').update(fs.readFileSync(file)).digest('hex') !== hash) fail();
  }
  if (env.OVERLYX_EXPECTED_APP_SHA256 !== proof.appSha256 ||
    env.OVERLYX_EXPECTED_RUNTIME_SHA256 !== proof.runtimeSha256 ||
    env.OVERLYX_EXPECTED_KEYBOARD_SHA256 !== proof.keyboardSha256) fail();
  return proof;
}

export function assertPrivateDiagnosticFixture(
  inputs: { baseURL: string; projectsDir: string }, env: Env = process.env,
): void {
  if (inputs.baseURL !== env.OVERLYX_E2E_BASE || inputs.projectsDir !== env.OVERLYX_PROJECTS_DIR) fail();
  if (env.OVERLYX_FINAL_DIAGNOSTICS_APPROVED !== '1') {
    if (inputs.baseURL !== 'http://127.0.0.1:3017' || inputs.projectsDir !== `${LEGACY_ROOT}/projects` ||
      env.OVERLYX_E2E_CREDENTIALS !== `${LEGACY_ROOT}/data/credentials.txt`) fail();
    return;
  }
  const root = env.OVERLYX_FINAL_DIAGNOSTIC_FIXTURE_ROOT ?? '';
  if (!FINAL_ROOT.test(root) || inputs.projectsDir !== path.join(root, 'projects') ||
    env.OVERLYX_E2E_CREDENTIALS !== path.join(root, 'data', 'credentials.txt')) fail();
  let base: URL;
  try { base = new URL(inputs.baseURL); } catch { fail(); }
  if (base.protocol !== 'http:' || base.hostname !== '127.0.0.1' || base.username || base.password ||
    base.pathname !== '/' || base.search || base.hash || !/^\d+$/.test(base.port) ||
    Number(base.port) < 1024 || Number(base.port) > 65535) fail();
  ownedPath(root, true, true);
  ownedPath(inputs.projectsDir, true);
  ownedPath(path.join(root, 'data'), true, true);
  ownedPath(env.OVERLYX_E2E_CREDENTIALS!, false, true);
  readFinalDiagnosticCandidateProof(env);
}
